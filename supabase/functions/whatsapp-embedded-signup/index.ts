/**
 * Edge Function: whatsapp-embedded-signup
 *
 * Maneja el flujo de Meta Embedded Signup para conectar una cuenta de
 * WhatsApp Business (WABA) a un negocio dentro de la plataforma.
 *
 * Acciones disponibles:
 *   - "start"    → Devuelve app_id y config_id para que el frontend
 *                  lance el SDK de Meta (Facebook Login for Business).
 *   - "callback" → Recibe el código de autorización y los IDs de WABA/teléfono
 *                  que entrega Meta al finalizar el flujo, intercambia el código
 *                  por un token de larga duración y guarda la conexión en la DB.
 *
 * Variables de entorno requeridas (configurar en Supabase Dashboard > Edge Functions):
 *   TODO: META_APP_ID       – ID de la aplicación de Meta (Facebook App ID)
 *   TODO: META_APP_SECRET   – Secreto de la aplicación de Meta
 *   TODO: META_CONFIG_ID    – Configuration ID del flujo de Embedded Signup
 *   TODO: META_REDIRECT_URI – URI de redirección registrada en Meta (si aplica)
 *   SUPABASE_URL            – Provista automáticamente por el runtime de Supabase
 *   SUPABASE_SERVICE_ROLE_KEY – Provista automáticamente por el runtime de Supabase
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

interface StartPayload {
  action: 'start'
}

interface CallbackPayload {
  action: 'callback'
  business_id: string
  code: string        // Código de autorización recibido del SDK de Meta
  waba_id: string     // WhatsApp Business Account ID seleccionado por el usuario
  phone_number_id: string // ID del número de teléfono seleccionado
}

type RequestPayload = StartPayload | CallbackPayload

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
// Helper: intercambiar código por token de acceso
// ──────────────────────────────────────────────

/**
 * Intercambia el código de autorización por un token de acceso de usuario.
 * Luego lo convierte a token de larga duración ("long-lived token").
 *
 * Documentación Meta:
 * https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 */
async function exchangeCodeForToken(
  code: string,
  appId: string,
  appSecret: string,
  redirectUri: string,
): Promise<{ token: string; expiresAt: Date | null }> {
  // Paso 1: intercambiar código por token de corta duración
  const shortLivedUrl = new URL('https://graph.facebook.com/v19.0/oauth/access_token')
  shortLivedUrl.searchParams.set('client_id', appId)
  shortLivedUrl.searchParams.set('client_secret', appSecret)
  shortLivedUrl.searchParams.set('redirect_uri', redirectUri)
  shortLivedUrl.searchParams.set('code', code)

  const shortRes = await fetch(shortLivedUrl.toString(), { method: 'GET' })
  const shortData = await shortRes.json()

  if (!shortRes.ok || shortData.error) {
    const msg = shortData.error?.message || `HTTP ${shortRes.status}`
    throw new Error(`Error al intercambiar código por token: ${msg}`)
  }

  const shortLivedToken: string = shortData.access_token

  // Paso 2: convertir a token de larga duración
  const longLivedUrl = new URL('https://graph.facebook.com/v19.0/oauth/access_token')
  longLivedUrl.searchParams.set('grant_type', 'fb_exchange_token')
  longLivedUrl.searchParams.set('client_id', appId)
  longLivedUrl.searchParams.set('client_secret', appSecret)
  longLivedUrl.searchParams.set('fb_exchange_token', shortLivedToken)

  const longRes = await fetch(longLivedUrl.toString(), { method: 'GET' })
  const longData = await longRes.json()

  if (!longRes.ok || longData.error) {
    const msg = longData.error?.message || `HTTP ${longRes.status}`
    throw new Error(`Error al obtener token de larga duración: ${msg}`)
  }

  // expires_in está en segundos; si no viene, asumimos ~60 días
  let expiresAt: Date | null = null
  if (longData.expires_in) {
    expiresAt = new Date(Date.now() + longData.expires_in * 1000)
  }

  return { token: longData.access_token, expiresAt }
}

// ──────────────────────────────────────────────
// Helper: obtener información de la WABA
// ──────────────────────────────────────────────

/**
 * Consulta la Graph API para obtener el nombre de la WABA.
 */
async function fetchWABAInfo(wabaId: string, token: string): Promise<{ name: string }> {
  const url = `https://graph.facebook.com/v19.0/${wabaId}?fields=name&access_token=${token}`
  const res = await fetch(url)
  const data = await res.json()

  if (!res.ok || data.error) {
    const msg = data.error?.message || `HTTP ${res.status}`
    throw new Error(`Error al obtener info de la WABA (${wabaId}): ${msg}`)
  }

  return { name: data.name || '' }
}

// ──────────────────────────────────────────────
// Helper: obtener información del número de teléfono
// ──────────────────────────────────────────────

/**
 * Consulta la Graph API para obtener el número de teléfono y nombre verificado.
 */
async function fetchPhoneNumberInfo(
  phoneNumberId: string,
  token: string,
): Promise<{ displayPhoneNumber: string; verifiedName: string }> {
  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}?fields=display_phone_number,verified_name&access_token=${token}`
  const res = await fetch(url)
  const data = await res.json()

  if (!res.ok || data.error) {
    const msg = data.error?.message || `HTTP ${res.status}`
    throw new Error(`Error al obtener info del número (${phoneNumberId}): ${msg}`)
  }

  return {
    displayPhoneNumber: data.display_phone_number || '',
    verifiedName: data.verified_name || '',
  }
}

// ──────────────────────────────────────────────
// Handler: action = "start"
// ──────────────────────────────────────────────

/**
 * Devuelve la configuración necesaria para que el frontend
 * inicialice el SDK de Facebook y lance el flujo de Embedded Signup.
 */
function handleStart(): Response {
  // TODO: asegurarse de configurar META_APP_ID y META_CONFIG_ID
  // en Supabase Dashboard > Edge Functions > Secrets
  const appId    = Deno.env.get('META_APP_ID')
  const configId = Deno.env.get('META_CONFIG_ID')

  if (!appId || !configId) {
    return jsonResponse({
      success: false,
      error: 'Configuración de Meta incompleta. Falta META_APP_ID o META_CONFIG_ID en las variables de entorno.',
    })
  }

  return jsonResponse({
    success: true,
    app_id: appId,
    config_id: configId,
  })
}

// ──────────────────────────────────────────────
// Handler: action = "callback"
// ──────────────────────────────────────────────

/**
 * Procesa el callback del flujo de Meta Embedded Signup:
 * 1. Verifica que el usuario JWT tiene acceso al business_id.
 * 2. Intercambia el código por un token de larga duración.
 * 3. Obtiene nombre de la WABA y datos del número de teléfono.
 * 4. Hace upsert en whatsapp_connections.
 * 5. Crea configuración de automatizaciones por defecto si no existe.
 */
async function handleCallback(payload: CallbackPayload, req: Request): Promise<Response> {
  const { business_id, code, waba_id, phone_number_id } = payload

  // Validar campos requeridos
  if (!business_id || !code || !waba_id || !phone_number_id) {
    return jsonResponse({
      success: false,
      error: 'Faltan campos requeridos: business_id, code, waba_id, phone_number_id',
    })
  }

  const supabaseUrl     = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // TODO: configurar estas variables en Supabase Dashboard > Edge Functions > Secrets
  const appId       = Deno.env.get('META_APP_ID')
  const appSecret   = Deno.env.get('META_APP_SECRET')
  const redirectUri = Deno.env.get('META_REDIRECT_URI') || ''

  if (!appId || !appSecret) {
    return jsonResponse({
      success: false,
      error: 'Configuración de Meta incompleta. Falta META_APP_ID o META_APP_SECRET.',
    })
  }

  // ── Cliente con JWT del usuario (para verificar permisos) ──
  const authHeader = req.headers.get('Authorization') || ''
  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') || serviceRoleKey, {
    global: { headers: { Authorization: authHeader } },
  })

  // Verificar que el JWT sea válido y obtener el usuario
  const { data: { user }, error: userError } = await userClient.auth.getUser()
  if (userError || !user) {
    return jsonResponse({ success: false, error: 'No autorizado: token JWT inválido o expirado.' })
  }

  // ── Cliente con service role para operaciones de DB ──
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  // Verificar que el usuario tenga un perfil activo en el business_id indicado
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, business_id, is_active')
    .eq('user_id', user.id)
    .eq('business_id', business_id)
    .eq('is_active', true)
    .single()

  if (profileError || !profile) {
    return jsonResponse({
      success: false,
      error: 'No tenés acceso a este negocio o el perfil está inactivo.',
    })
  }

  // ── Intercambiar código por token ──
  let accessToken: string
  let tokenExpiresAt: Date | null

  try {
    const result = await exchangeCodeForToken(code, appId, appSecret, redirectUri)
    accessToken   = result.token
    tokenExpiresAt = result.expiresAt
  } catch (err: any) {
    console.error('whatsapp-embedded-signup [token exchange]:', err)
    return jsonResponse({ success: false, error: err.message })
  }

  // ── Obtener nombre de la WABA ──
  let wabaName = ''
  try {
    const wabaInfo = await fetchWABAInfo(waba_id, accessToken)
    wabaName = wabaInfo.name
  } catch (err: any) {
    // No crítico: continuar aunque falle (puede ser un error de permisos temporario)
    console.warn('whatsapp-embedded-signup [waba info]:', err.message)
  }

  // ── Obtener datos del número de teléfono ──
  let displayPhoneNumber = ''
  try {
    const phoneInfo = await fetchPhoneNumberInfo(phone_number_id, accessToken)
    displayPhoneNumber = phoneInfo.displayPhoneNumber
  } catch (err: any) {
    console.warn('whatsapp-embedded-signup [phone info]:', err.message)
  }

  // ── Upsert en whatsapp_connections ──
  // Si ya existe una conexión para este business_id, la actualiza.
  // De lo contrario, inserta un nuevo registro.
  const connectionData = {
    business_id,
    user_id:               user.id,
    waba_id,
    phone_number_id,
    business_phone_number: displayPhoneNumber,
    access_token:          accessToken,
    token_expires_at:      tokenExpiresAt?.toISOString() ?? null,
    connected_account_name: wabaName,
    status:                'connected',
    updated_at:            new Date().toISOString(),
  }

  // Primero buscamos si ya existe una conexión para este business_id
  const { data: existingConn } = await supabase
    .from('whatsapp_connections')
    .select('id')
    .eq('business_id', business_id)
    .maybeSingle()

  let connectionId: string

  if (existingConn?.id) {
    // Actualizar conexión existente
    const { data: updated, error: updateError } = await supabase
      .from('whatsapp_connections')
      .update(connectionData)
      .eq('id', existingConn.id)
      .select('id')
      .single()

    if (updateError) {
      console.error('whatsapp-embedded-signup [update connection]:', updateError)
      return jsonResponse({ success: false, error: `Error al actualizar la conexión: ${updateError.message}` })
    }

    connectionId = updated.id
    console.log(`whatsapp-embedded-signup: conexión actualizada para business_id=${business_id}, id=${connectionId}`)
  } else {
    // Insertar nueva conexión
    const { data: inserted, error: insertError } = await supabase
      .from('whatsapp_connections')
      .insert(connectionData)
      .select('id')
      .single()

    if (insertError) {
      console.error('whatsapp-embedded-signup [insert connection]:', insertError)
      return jsonResponse({ success: false, error: `Error al guardar la conexión: ${insertError.message}` })
    }

    connectionId = inserted.id
    console.log(`whatsapp-embedded-signup: nueva conexión creada para business_id=${business_id}, id=${connectionId}`)
  }

  // ── Crear configuración de automatizaciones por defecto (si no existe) ──
  // Usamos upsert con onConflict en business_id para no sobrescribir la config existente.
  await supabase
    .from('whatsapp_automation_settings')
    .upsert(
      {
        business_id,
        enabled:          true,
        send_on_received: true,
        send_on_ready:    true,
      },
      { onConflict: 'business_id', ignoreDuplicates: true }
    )

  return jsonResponse({
    success: true,
    connection_id: connectionId,
    waba_id,
    phone_number_id,
    business_phone_number: displayPhoneNumber,
    connected_account_name: wabaName,
    status: 'connected',
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
      case 'start':
        return handleStart()

      case 'callback':
        return await handleCallback(payload as CallbackPayload, req)

      default:
        return jsonResponse({
          success: false,
          error: `Acción desconocida: "${action}". Las acciones válidas son: "start", "callback".`,
        })
    }
  } catch (err: any) {
    // Error inesperado: loguear en servidor y devolver respuesta amigable
    console.error('whatsapp-embedded-signup [unhandled error]:', err)
    return jsonResponse({
      success: false,
      error: err?.message || 'Error interno del servidor.',
    })
  }
})
