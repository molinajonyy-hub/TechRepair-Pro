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
 * SEGURIDAD (corregido — antes faltaba toda autorización de tenant):
 *   - El actor se toma EXCLUSIVAMENTE del JWT validado; nunca de `user_id` del body.
 *   - Se valida membresía ACTIVA del actor en `business_id` y un rol habilitado
 *     (ALLOWED_SENDER_ROLES), ANTES de cargar la conexión/credenciales o llamar a
 *     Meta. Esto impide el acceso cross-tenant (usuario de A usando business_id de B).
 *   - Las credenciales se resuelven server-side desde Vault para el negocio ya
 *     autorizado; nunca se leen credenciales de otro negocio.
 *   - CORS con allowlist de orígenes (sin '*'); ver _shared/scopedCors.ts.
 *
 * Variables de entorno (provistas automáticamente por el runtime de Supabase):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { createCors, computeAllowedOrigins } from '../_shared/scopedCors.ts'
import { authorizeWhatsAppSender } from '../_shared/whatsappAuth.ts'

// ──────────────────────────────────────────────
// CORS — allowlist de orígenes (sin comodín)
// ──────────────────────────────────────────────

const cors = createCors(
  computeAllowedOrigins([
    Deno.env.get('WHATSAPP_CORS_ORIGIN'),
    Deno.env.get('APP_URL'),
  ]),
)

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

// <any> schema generic: this function predates generated DB types; without it
// supabase-js infers table rows/RPC params as `never` under strict deno check
// (rows become never[], rpc params become undefined). Type-only — erased at runtime.
type ServiceClient = ReturnType<typeof createClient<any>>

// ──────────────────────────────────────────────
// Helper: cargar la conexión activa del negocio
// ──────────────────────────────────────────────

/**
 * Busca la conexión WhatsApp activa (status='connected') para un negocio y
 * resuelve su token cifrado desde Vault vía RPC server-side. El token NUNCA
 * se lee como columna de whatsapp_connections (no existe más).
 *
 * Sólo debe llamarse DESPUÉS de autorizar al actor para `businessId`.
 */
async function loadActiveConnection(
  supabase: ServiceClient,
  businessId: string,
): Promise<WhatsAppConnection> {
  const { data, error } = await supabase
    .from('whatsapp_connections')
    .select('id, phone_number_id, business_phone_number, connected_account_name, status')
    .eq('business_id', businessId)
    .eq('status', 'connected')
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

  const conn = data as Omit<WhatsAppConnection, 'access_token'> & { id: string }

  const { data: token, error: tokenError } = await supabase
    .rpc('whatsapp_credential_get_token', { p_connection_id: conn.id })

  if (tokenError || !token) {
    throw new Error('No se pudo resolver la credencial de la conexión de WhatsApp.')
  }

  return { ...conn, access_token: token as string } as WhatsAppConnection
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
  supabase: ServiceClient,
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
 *
 * Precondición: el actor YA fue autorizado para `business_id` en el handler raíz.
 */
async function handleTest(req: Request, supabase: ServiceClient, payload: TestPayload): Promise<Response> {
  const { business_id, test_phone } = payload

  if (!test_phone) {
    return cors.json(req, { success: false, error: 'Falta el campo requerido: test_phone' })
  }

  // 1. Cargar conexión activa del negocio (ya autorizado)
  let connection: WhatsAppConnection
  try {
    connection = await loadActiveConnection(supabase, business_id)
  } catch (err: any) {
    return cors.json(req, { success: false, error: err.message })
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
    return cors.json(req, { success: false, error: errorMessage })
  }

  return cors.json(req, {
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
 *
 * Precondición: el actor YA fue autorizado para `business_id` en el handler raíz.
 */
async function handleTemplate(req: Request, supabase: ServiceClient, payload: TemplatePayload): Promise<Response> {
  const {
    business_id,
    customer_phone,
    template_name,
    template_language = 'es_AR',
    components = [],
  } = payload

  // Validar campos requeridos
  if (!customer_phone || !template_name) {
    return cors.json(req, {
      success: false,
      error: 'Faltan campos requeridos: customer_phone, template_name',
    })
  }

  // Validar formato del teléfono (debe empezar con +)
  if (!customer_phone.startsWith('+')) {
    return cors.json(req, {
      success: false,
      error: 'El número de teléfono debe estar en formato E.164 (ej: +5491112345678)',
    })
  }

  // 1. Cargar conexión activa del negocio (ya autorizado)
  let connection: WhatsAppConnection
  try {
    connection = await loadActiveConnection(supabase, business_id)
  } catch (err: any) {
    return cors.json(req, { success: false, error: err.message })
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
    return cors.json(req, { success: false, error: errorMessage })
  }

  return cors.json(req, {
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
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return cors.preflight(req)
  }

  // Solo se acepta POST
  if (req.method !== 'POST') {
    return cors.json(req, { success: false, error: 'Método no permitido. Usar POST.' }, 405)
  }

  let payload: RequestPayload
  try {
    payload = await req.json()
  } catch {
    return cors.json(req, { success: false, error: 'El cuerpo de la solicitud debe ser JSON válido.' }, 400)
  }

  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey        = Deno.env.get('SUPABASE_ANON_KEY')

  // Fail closed: el cliente que representa al USUARIO debe usar la anon key.
  // Nunca caer al service_role como reemplazo (eso anularía la verificación del
  // JWT). No se registran ni se devuelven valores de entorno. Esta validación
  // ocurre ANTES de cargar conexiones, credenciales (Vault) o llamar a Meta.
  if (!anonKey) {
    console.error('whatsapp-send-message: SUPABASE_ANON_KEY no está configurada')
    return cors.json(req, {
      success: false,
      error: 'Configuración del servidor incompleta.',
      code: 'SERVER_MISCONFIGURED',
    }, 500)
  }

  // Cliente service-role: SÓLO para operaciones backend POSTERIORES a la autorización.
  const supabase = createClient<any>(supabaseUrl, serviceRoleKey)

  // ── Autorización OBLIGATORIA (antes de cargar conexión/credenciales o llamar a Meta) ──
  // Actor exclusivamente desde el JWT; membresía activa + rol en `business_id`.
  const authz = await authorizeWhatsAppSender({
    businessId: (payload as { business_id?: unknown })?.business_id,
    getUserId: async () => {
      const authHeader = req.headers.get('Authorization') || ''
      if (!authHeader.startsWith('Bearer ')) return null
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      })
      const { data: { user }, error } = await userClient.auth.getUser()
      if (error || !user) return null
      return user.id
    },
    getActiveMembership: async (userId, businessId) => {
      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('user_id', userId)
        .eq('business_id', businessId)
        .eq('is_active', true)
        .maybeSingle()
      return data ? { role: (data as { role: string }).role } : null
    },
  })
  if (!authz.ok) {
    return cors.json(req, { success: false, error: authz.error }, authz.status)
  }

  const action = (payload as { action?: string })?.action

  try {
    switch (action) {
      case 'test':
        return await handleTest(req, supabase, payload as TestPayload)

      case 'template':
        return await handleTemplate(req, supabase, payload as TemplatePayload)

      default:
        return cors.json(req, {
          success: false,
          error: `Acción desconocida: "${action}". Las acciones válidas son: "test", "template".`,
        })
    }
  } catch (err: any) {
    // Error inesperado: loguear en servidor y devolver respuesta amigable (con CORS)
    console.error('whatsapp-send-message [unhandled error]:', err)
    return cors.json(req, {
      success: false,
      error: err?.message || 'Error interno del servidor.',
    })
  }
})
