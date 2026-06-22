import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'

/**
 * Columnas seguras de whatsapp_connections para uso en el frontend.
 * NUNCA incluye `access_token`: el secreto sólo lo lee la Edge Function
 * server-side. El cliente sólo necesita saber si hay conexión activa.
 */
const CONNECTION_PUBLIC_COLUMNS =
  'id, business_id, user_id, waba_id, phone_number_id, business_phone_number, connected_account_name, status, metadata, created_at, updated_at'

// ============================================================
// TIPOS — WhatsApp Cloud API / Embedded Signup
// ============================================================

/**
 * Representa una conexión de WhatsApp Business Cloud API
 * vinculada a un negocio (business_id) en la plataforma.
 */
export interface WhatsAppConnection {
  id: string
  business_id: string
  user_id: string
  waba_id: string                   // WhatsApp Business Account ID
  phone_number_id: string           // ID del número de teléfono en Meta
  business_phone_number: string     // Número en formato legible (+54...)
  connected_account_name: string    // Nombre de la cuenta WABA en Meta
  status: 'connected' | 'disconnected' | 'error'
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

/**
 * Log individual de un mensaje enviado/recibido por la Cloud API.
 */
export interface WhatsAppMessageLog {
  id: string
  business_id: string
  connection_id: string
  customer_phone: string
  template_name: string
  template_language: string
  payload: Record<string, unknown> | null
  meta_message_id: string | null
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed'
  direction: 'outbound' | 'inbound'
  error_message: string | null
  created_at: string
}

/**
 * Configuración de automatización: qué estados de orden
 * disparan envíos automáticos por WhatsApp Cloud API.
 */
export interface WhatsAppAutomationSettings {
  id: string
  business_id: string
  enabled: boolean
  send_on_received: boolean     // Estado: nuevo / recibido
  send_on_diagnosis: boolean    // Estado: en diagnóstico
  send_on_repair: boolean       // Estado: en reparación
  send_on_ready: boolean        // Estado: listo para retirar
  send_on_delivered: boolean    // Estado: entregado
  template_map: Record<string, string> | null  // estado → nombre de template en Meta
  created_at: string
  updated_at: string
}

// ============================================================
// FUNCIONES DE SERVICIO
// ============================================================

/**
 * Obtiene la conexión activa de WhatsApp Cloud API para un negocio.
 * Retorna null si no hay conexión o está desconectada.
 */
export async function getConnection(businessId: string): Promise<WhatsAppConnection | null> {
  try {
    const { data, error } = await supabase
      .from('whatsapp_connections')
      .select(CONNECTION_PUBLIC_COLUMNS)
      .eq('business_id', businessId)
      .eq('status', 'connected')
      .maybeSingle()

    if (error) {
      logger.error('WHATSAPP', 'getConnection falló', error)
      return null
    }

    return data as unknown as WhatsAppConnection | null
  } catch (err) {
    logger.error('WHATSAPP', 'getConnection error inesperado', err)
    return null
  }
}

/**
 * Obtiene la configuración de automatización para un negocio.
 * Retorna null si no existe configuración guardada.
 */
export async function getAutomationSettings(
  businessId: string
): Promise<WhatsAppAutomationSettings | null> {
  try {
    const { data, error } = await supabase
      .from('whatsapp_automation_settings')
      .select('*')
      .eq('business_id', businessId)
      .maybeSingle()

    if (error) {
      logger.error('WHATSAPP', 'getAutomationSettings falló', error)
      return null
    }

    return data as WhatsAppAutomationSettings | null
  } catch (err) {
    logger.error('WHATSAPP', 'getAutomationSettings error inesperado', err)
    return null
  }
}

/**
 * Guarda (upsert) la configuración de automatización de un negocio.
 * Usa business_id como clave de conflicto.
 */
export async function saveAutomationSettings(
  businessId: string,
  settings: Partial<Omit<WhatsAppAutomationSettings, 'id' | 'business_id' | 'created_at' | 'updated_at'>>
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase
      .from('whatsapp_automation_settings')
      .upsert(
        {
          ...settings,
          business_id: businessId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'business_id' }
      )

    if (error) {
      logger.error('WHATSAPP', 'saveAutomationSettings falló', error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido'
    logger.error('WHATSAPP', 'saveAutomationSettings error inesperado', err)
    return { success: false, error: message }
  }
}

/**
 * Desconecta WhatsApp marcando el registro como 'disconnected'.
 * No elimina el registro para conservar historial.
 */
export async function disconnectWhatsApp(
  businessId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase
      .from('whatsapp_connections')
      .update({
        status: 'disconnected',
        updated_at: new Date().toISOString(),
      })
      .eq('business_id', businessId)

    if (error) {
      logger.error('WHATSAPP', 'disconnectWhatsApp falló', error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido'
    logger.error('WHATSAPP', 'disconnectWhatsApp error inesperado', err)
    return { success: false, error: message }
  }
}

/**
 * Guarda una conexión manual con Phone Number ID + Access Token.
 * Usa upsert: si ya existe una conexión para el negocio, la actualiza.
 */
export async function saveManualConnection(
  businessId: string,
  params: {
    phone_number_id: string
    access_token: string
    connected_account_name?: string
    business_phone_number?: string
  }
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: 'No autenticado' }

    // Verificar si ya existe una conexión
    const { data: existing } = await supabase
      .from('whatsapp_connections')
      .select('id')
      .eq('business_id', businessId)
      .maybeSingle()

    const payload = {
      business_id:            businessId,
      user_id:                user.id,
      phone_number_id:        params.phone_number_id,
      access_token:           params.access_token,
      connected_account_name: params.connected_account_name || 'Mi cuenta WhatsApp',
      business_phone_number:  params.business_phone_number || null,
      status:                 'connected',
      updated_at:             new Date().toISOString(),
    }

    let error: any
    if (existing?.id) {
      ;({ error } = await supabase
        .from('whatsapp_connections')
        .update(payload)
        .eq('id', existing.id))
    } else {
      ;({ error } = await supabase
        .from('whatsapp_connections')
        .insert(payload))
    }

    if (error) {
      logger.error('WHATSAPP', 'saveManualConnection falló', error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido'
    logger.error('WHATSAPP', 'saveManualConnection error inesperado', err)
    return { success: false, error: message }
  }
}

/**
 * Obtiene la configuración inicial para el flujo de Embedded Signup de Meta.
 * Llama a la edge function `whatsapp-embedded-signup` con action="start".
 * Retorna el app_id y config_id necesarios para inicializar el SDK de Facebook.
 */
export async function getEmbeddedSignupConfig(): Promise<{
  app_id: string
  config_id: string
}> {
  const { data, error } = await supabase.functions.invoke('whatsapp-embedded-signup', {
    body: { action: 'start' },
  })

  if (error) {
    logger.error('WHATSAPP', 'getEmbeddedSignupConfig falló', error)
    throw new Error(error.message || 'No se pudo obtener la configuración de Meta')
  }

  if (!data?.app_id || !data?.config_id) {
    throw new Error('Respuesta inválida del servidor: faltan app_id o config_id')
  }

  return { app_id: data.app_id, config_id: data.config_id }
}

/**
 * Procesa el callback del flujo Embedded Signup.
 * Llama a la edge function con action="callback" para intercambiar el código
 * de autorización por un token y guardar la conexión en la base de datos.
 */
export async function handleEmbeddedSignupCallback(
  businessId: string,
  code: string,
  wabaId: string,
  phoneNumberId: string
): Promise<{ success: boolean; connection?: WhatsAppConnection; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('whatsapp-embedded-signup', {
      body: {
        action: 'callback',
        business_id: businessId,
        code,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
      },
    })

    if (error) {
      logger.error('WHATSAPP', 'handleEmbeddedSignupCallback falló', error)
      return { success: false, error: error.message }
    }

    return { success: true, connection: data?.connection }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido'
    logger.error('WHATSAPP', 'handleEmbeddedSignupCallback error inesperado', err)
    return { success: false, error: message }
  }
}

/**
 * Envía un mensaje de prueba al número indicado para verificar
 * que la conexión con WhatsApp Cloud API está funcionando.
 */
export async function sendTestMessage(
  businessId: string,
  testPhone: string
): Promise<{ success: boolean; message_id?: string; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('whatsapp-send-message', {
      body: {
        action: 'test',
        business_id: businessId,
        test_phone: testPhone,
      },
    })

    if (error) {
      logger.error('WHATSAPP', 'sendTestMessage falló', error)
      return { success: false, error: error.message }
    }

    return {
      success: data?.success ?? false,
      message_id: data?.message_id,
      error: data?.error,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error desconocido'
    logger.error('WHATSAPP', 'sendTestMessage error inesperado', err)
    return { success: false, error: message }
  }
}

// Re-exportamos el cliente para uso interno en otros módulos si fuera necesario
export { supabase }
