/**
 * Edge Function: whatsapp-send-message
 *
 * Envía mensajes de WhatsApp a través de la Cloud API de Meta usando templates
 * aprobados en el Meta Business Manager.
 *
 * Acciones disponibles:
 *   - "test"     → Envía el template "hello_world" a un número de prueba para
 *                  verificar que la conexión con la API funciona correctamente.
 *   - "template" → Envía un template específico al teléfono de un cliente.
 *
 * En ambas acciones se:
 *   1. Carga la conexión WhatsApp activa del negocio (whatsapp_connections).
 *   2. Llama a la Graph API de Meta para enviar el mensaje.
 *   3. Registra el intento en whatsapp_message_logs.
 *
 * Variables de entorno (provistas automáticamente por el runtime de Supabase):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_ANON_KEY
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ──────────────────────────────────────────────
// Cabeceras CORS
// ──────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ──────────────────────────────────────────────
// Tipos auxiliares
// ──────────────────────────────────────────────

/** Parámetro de un componente de template (header, body, button) */
interface TemplateParameter {
  type: 'text' | 'image' | 'document' | 'video' | 'currency' | 'date_time'
  text?: string
  image?: { link: string }
  document?: { link: string }
  currency?: { fallback_value: string; code: string; amount_1000: number }
  date_time?: { fallback_value: string }
}

/** Componente de template tal como lo espera la Graph API */
interface TemplateComponent {
  type: 'header' | 'body' | 'button'
  sub_type?: 'quick_reply' | 'url'
  index?: number
  parameters: TemplateParameter[]
}

/** Payload de la acción "test" */
interface TestPayload {
  action: 'test'
  business_id: string
  test_phone: string  // Número de teléfono destino en formato E.164, e.g. "+5491112345678"
}

/** Payload de la acción "template" */
interface TemplatePayload {
  action: 'template'
  business_id: string
  customer_phone: string        // Destino en formato E.164
  template_name: string         // Nombre del template en Meta Business Manager
  template_language?: string    // Código de idioma, por defecto "es_AR"
  components?: TemplateComponent[] // Variables del template (pueden estar vacías)
}

type RequestPayload = TestPayload | TemplatePayload

/** Registro de conexión WhatsApp desde la DB */
interface WhatsAppConnection {
  id: string
  phone_number_id: string
  access_token: string
  business_phone_number: string
  connected_account_name: string
  status: string
}

// ──────────────────────────────────────────────
// Helper: respuesta JSON estandarizada
// ──────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ──────────────────────────────────────────────
// Helper: cargar la conexión activa del negocio
// ──────────────────────────────────────────────

/**
 * Busca la conexión WhatsApp activa (status='connected') para un negocio.
 * Valida que tenga access_token y phone_number_id configurados.
 */
async function loadActiveConnection(
  supabase: ReturnType<typeof createClient>,
  businessId: string,
): Promise<WhatsAppConnection> {
  const { data, error } = await supabase
    .from('whatsapp_connections')
    .select('id, phone_number_id, access_token, business_phone_number, connected_account_name, status')
    .eq('business_id', businessId)
    .eq('status', 'connected')
    .not('access_token', 'is', null)
    .not('phone_number_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !data) {
    throw new Error(
      'No se encontró una conexión WhatsApp activa para este negocio. ' +
      'Verificá que hayas completado el proceso de conexión en Configuración > WhatsApp.',
    )
  }

  return data as WhatsAppConnection
}

// ──────────────────────────────────────────────
// Helper: construir el body de la Graph API
// ──────────────────────────────────────────────

/**
 * Construye el payload JSON para enviar un mensaje de template
 * a través de la Cloud API de Meta.
 *
 * Documentación:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates
 */
function buildTemplateMessageBody(
  toPhone: string,
  templateName: string,
  language: string,
  components: TemplateComponent[] = [],
): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      // Solo incluir components si hay parámetros definidos
      ...(components.length > 0 && { components }),
    },
  }
}

// ──────────────────────────────────────────────
// Helper: llamar a la Graph API de Meta
// ──────────────────────────────────────────────

/**
 * Envía un mensaje de WhatsApp usando la Cloud API de Meta.
 * Retorna el wamid (message ID de WhatsApp) si fue exitoso.
 */
async function callMetaMessagesAPI(
  phoneNumberId: string,
  accessToken: string,
  messageBody: Record<string, unknown>,
): Promise<{ metaMessageId: string; rawResponse: unknown }> {
  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messageBody),
  })

  const responseData = await res.json()

  if (!res.ok || responseData.error) {
    const errMsg = responseData.error?.message
      || responseData.error?.error_user_msg
      || `HTTP ${res.status}`
    throw new Error(`Error de la Graph API de Meta: ${errMsg}`)
  }

  // La API devuelve { messages: [{ id: "wamid...." }] }
  const metaMessageId: string = responseData?.messages?.[0]?.id || ''

  return { metaMessageId, rawResponse: responseData }
}

// ──────────────────────────────────────────────
// Helper: registrar resultado en whatsapp_message_logs
// ──────────────────────────────────────────────

/**
 * Inserta un registro en whatsapp_message_logs con el resultado del envío.
 * No lanza excepción si el log falla (no es crítico para el flujo principal).
 */
async function logMessage(
  supabase: ReturnType<typeof createClient>,
  params: {
    businessId: string
    connectionId: string
    customerPhone: string
    templateName: string
    templateLanguage: string
    payload: Record<string, unknown>
    metaMessageId: string
    status: 'sent' | 'failed'
    errorMessage?: string
  },
): Promise<void> {
  try {
    await supabase.from('whatsapp_message_logs').insert({
      business_id:       params.businessId,
      connection_id:     params.connectionId,
      customer_phone:    params.customerPhone,
      template_name:     params.templateName,
      template_language: params.templateLanguage,
      payload:           params.payload,
      meta_message_id:   params.metaMessageId || null,
      status:            params.status,
      direction:         'outbound',
      error_message:     params.errorMessage || null,
    })
  } catch (logErr) {
    // No fallar el flujo si el log tiene un problema
    console.warn('whatsapp-send-message [log error]:', logErr)
  }
}

// ──────────────────────────────────────────────
// Handler: action = "test"
// ──────────────────────────────────────────────

/**
 * Envía el template estándar "hello_world" al número de prueba provisto.
 * Útil para verificar que las credenciales y la conexión funcionan correctamente.
 * El template "hello_world" está pre-aprobado por Meta para todas las cuentas.
 */
async function handleTest(payload: TestPayload): Promise<Response> {
  const { business_id, test_phone } = payload

  if (!business_id || !test_phone) {
    return jsonResponse({ success: false, error: 'Faltan campos requeridos: business_id, test_phone' })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // 1. Cargar conexión activa del negocio
  let connection: WhatsAppConnection
  try {
    connection = await loadActiveConnection(supabase, business_id)
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message })
  }

  // 2. Construir mensaje de prueba con el template "hello_world"
  const templateName     = 'hello_world'
  const templateLanguage = 'en_US' // hello_world solo existe en inglés
  const messageBody      = buildTemplateMessageBody(test_phone, templateName, templateLanguage)

  console.log(`whatsapp-send-message [test]: enviando hello_world a ${test_phone} via phone_number_id=${connection.phone_number_id}`)

  // 3. Llamar a la Graph API de Meta
  let metaMessageId = ''
  let sendStatus: 'sent' | 'failed' = 'sent'
  let errorMessage: string | undefined

  try {
    const result = await callMetaMessagesAPI(connection.phone_number_id, connection.access_token, messageBody)
    metaMessageId = result.metaMessageId
    console.log(`whatsapp-send-message [test]: mensaje enviado, wamid=${metaMessageId}`)
  } catch (err: any) {
    console.error('whatsapp-send-message [test] error Meta API:', err)
    sendStatus   = 'failed'
    errorMessage = err.message
  }

  // 4. Registrar en logs
  await logMessage(supabase, {
    businessId:       business_id,
    connectionId:     connection.id,
    customerPhone:    test_phone,
    templateName,
    templateLanguage,
    payload:          messageBody,
    metaMessageId,
    status:           sendStatus,
    errorMessage,
  })

  if (sendStatus === 'failed') {
    return jsonResponse({ success: false, error: errorMessage })
  }

  return jsonResponse({
    success: true,
    meta_message_id: metaMessageId,
    status: sendStatus,
    template_name: templateName,
    to: test_phone,
  })
}

// ──────────────────────────────────────────────
// Handler: action = "template"
// ──────────────────────────────────────────────

/**
 * Envía un template específico al teléfono de un cliente.
 * El template debe estar previamente aprobado en Meta Business Manager.
 */
async function handleTemplate(payload: TemplatePayload): Promise<Response> {
  const {
    business_id,
    customer_phone,
    template_name,
    template_language = 'es_AR',
    components = [],
  } = payload

  // Validar campos requeridos
  if (!business_id || !customer_phone || !template_name) {
    return jsonResponse({
      success: false,
      error: 'Faltan campos requeridos: business_id, customer_phone, template_name',
    })
  }

  // Validar formato del teléfono (debe empezar con +)
  if (!customer_phone.startsWith('+')) {
    return jsonResponse({
      success: false,
      error: 'El número de teléfono debe estar en formato E.164 (ej: +5491112345678)',
    })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // 1. Cargar conexión activa del negocio
  let connection: WhatsAppConnection
  try {
    connection = await loadActiveConnection(supabase, business_id)
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message })
  }

  // 2. Construir el payload del mensaje
  const messageBody = buildTemplateMessageBody(customer_phone, template_name, template_language, components)

  console.log(
    `whatsapp-send-message [template]: enviando "${template_name}" (${template_language}) ` +
    `a ${customer_phone} via phone_number_id=${connection.phone_number_id}`,
  )

  // 3. Llamar a la Graph API de Meta
  let metaMessageId = ''
  let sendStatus: 'sent' | 'failed' = 'sent'
  let errorMessage: string | undefined

  try {
    const result = await callMetaMessagesAPI(connection.phone_number_id, connection.access_token, messageBody)
    metaMessageId = result.metaMessageId
    console.log(`whatsapp-send-message [template]: mensaje enviado, wamid=${metaMessageId}`)
  } catch (err: any) {
    console.error('whatsapp-send-message [template] error Meta API:', err)
    sendStatus   = 'failed'
    errorMessage = err.message
  }

  // 4. Registrar en logs
  await logMessage(supabase, {
    businessId:       business_id,
    connectionId:     connection.id,
    customerPhone:    customer_phone,
    templateName:     template_name,
    templateLanguage: template_language,
    payload:          messageBody,
    metaMessageId,
    status:           sendStatus,
    errorMessage,
  })

  if (sendStatus === 'failed') {
    return jsonResponse({ success: false, error: errorMessage })
  }

  return jsonResponse({
    success: true,
    meta_message_id: metaMessageId,
    status: sendStatus,
    template_name,
    template_language,
    to: customer_phone,
  })
}

// ──────────────────────────────────────────────
// Handler principal
// ──────────────────────────────────────────────

serve(async (req: Request) => {
  // Manejar preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Solo se acepta POST
  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Método no permitido. Usar POST.' }, 405)
  }

  let payload: RequestPayload

  try {
    payload = await req.json()
  } catch {
    return jsonResponse({ success: false, error: 'El cuerpo de la solicitud debe ser JSON válido.' })
  }

  const action = (payload as any)?.action

  try {
    switch (action) {
      case 'test':
        return await handleTest(payload as TestPayload)

      case 'template':
        return await handleTemplate(payload as TemplatePayload)

      default:
        return jsonResponse({
          success: false,
          error: `Acción desconocida: "${action}". Las acciones válidas son: "test", "template".`,
        })
    }
  } catch (err: any) {
    // Error inesperado: loguear en servidor y devolver respuesta amigable
    console.error('whatsapp-send-message [unhandled error]:', err)
    return jsonResponse({
      success: false,
      error: err?.message || 'Error interno del servidor.',
    })
  }
})
