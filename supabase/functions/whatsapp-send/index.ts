import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Edge Function: whatsapp-send
 *
 * Envía un mensaje de texto libre vía WhatsApp Business Cloud API (Meta).
 *
 * SEGURIDAD:
 *  - Las credenciales (phone_number_id, access_token) se cargan SERVER-SIDE
 *    desde `whatsapp_connections` usando el business_id. El cliente NUNCA
 *    transmite el access_token (se ignora si llega en el body, por compat).
 *  - Se valida que el usuario (JWT) tenga un perfil activo en ese business_id
 *    antes de usar la conexión.
 *
 * Limitación de Meta: el texto libre sólo se entrega dentro de la ventana de
 * 24 h iniciada por el cliente. Fuera de ella la API devuelve error y se
 * responde success:false (sin falso "enviado").
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/**
 * Quita el prefijo móvil "15" embebido en un número local argentino.
 * Mantener en sync con `stripArgentineMobile15` de src/services/whatsappService.ts
 */
function stripArgentineMobile15(local: string): string {
  if (local.length === 12) {
    for (const areaLen of [2, 3, 4]) {
      if (local.slice(areaLen, areaLen + 2) === '15') {
        return local.slice(0, areaLen) + local.slice(areaLen + 2)
      }
    }
  }
  if (local.length === 11 && local.startsWith('15')) return local.slice(2)
  return local
}

/**
 * Normaliza un teléfono a formato móvil AR (549 + 10 dígitos) sin romper
 * números internacionales. Mantener en sync con el normalizador del frontend.
 */
function normalizePhone(input: string): { normalized: string; valid: boolean } {
  const raw = (input ?? '').trim()
  if (!raw) return { normalized: '', valid: false }

  const hadPlus = raw.startsWith('+')
  let digits = raw.replace(/\D/g, '')
  if (!digits) return { normalized: '', valid: false }

  let explicitIntl = hadPlus
  if (!hadPlus && digits.startsWith('00')) { digits = digits.slice(2); explicitIntl = true }

  if (explicitIntl && !digits.startsWith('54')) {
    const valid = digits.length >= 8 && digits.length <= 15
    return { normalized: digits, valid }
  }

  if (!digits.startsWith('54') && digits.startsWith('0')) digits = digits.slice(1)

  let local: string
  if (digits.startsWith('54')) {
    let rest = digits.slice(2)
    if (rest.startsWith('0')) rest = rest.slice(1)
    if (rest.startsWith('9')) rest = rest.slice(1)
    local = stripArgentineMobile15(rest)
  } else {
    local = stripArgentineMobile15(digits)
  }

  const normalized = '549' + local
  return { normalized, valid: normalized.length === 13 }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ success: false, error: 'Método no permitido. Usar POST.' }, 405)
  }

  try {
    const body = await req.json()
    const {
      phone,
      message,
      business_id,
      order_id,
      customer_id,
      status_key,
      send_mode = 'api',
    } = body

    if (!phone)       return json({ success: false, error: 'Falta el campo phone' }, 400)
    if (!message)     return json({ success: false, error: 'Falta el campo message' }, 400)
    if (!business_id) return json({ success: false, error: 'Falta el campo business_id' }, 400)

    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey        = Deno.env.get('SUPABASE_ANON_KEY') || serviceRoleKey

    // ── Autorización: el JWT debe pertenecer a un perfil activo del negocio ──
    const authHeader = req.headers.get('Authorization') || ''
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: userError } = await userClient.auth.getUser()
    if (userError || !user) {
      return json({ success: false, error: 'No autorizado: token JWT inválido o expirado.' }, 401)
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey)

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .eq('business_id', business_id)
      .eq('is_active', true)
      .maybeSingle()

    if (!profile) {
      return json({ success: false, error: 'No tenés acceso a este negocio.' }, 403)
    }

    // ── Cargar la conexión activa (metadatos; SIN secreto) ──
    const { data: connection } = await supabase
      .from('whatsapp_connections')
      .select('id, phone_number_id, status')
      .eq('business_id', business_id)
      .eq('status', 'connected')
      .not('phone_number_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!connection?.id || !connection?.phone_number_id) {
      return json({
        success: false,
        error: 'No hay una conexión de WhatsApp Cloud API activa para este negocio.',
      })
    }

    // ── Resolver el token cifrado desde Vault (sólo server-side, vía RPC) ──
    const { data: accessToken, error: tokenError } = await supabase
      .rpc('whatsapp_credential_get_token', { p_connection_id: connection.id })

    if (tokenError || !accessToken) {
      return json({
        success: false,
        error: 'No se pudo resolver la credencial de la conexión de WhatsApp.',
      })
    }

    const { normalized: normalizedPhone } = normalizePhone(phone)

    const waRes = await fetch(
      `https://graph.facebook.com/v19.0/${connection.phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: normalizedPhone,
          type: 'text',
          text: { preview_url: false, body: message },
        }),
      }
    )

    const waResult = await waRes.json()
    const success = waRes.ok && !!waResult.messages?.[0]?.id

    await supabase.from('whatsapp_logs').insert({
      business_id,
      order_id: order_id || null,
      customer_id: customer_id || null,
      phone: normalizedPhone,
      status_key: status_key || null,
      message,
      send_mode,
      send_result: success ? 'sent_api' : 'failed',
      error_message: success ? null : JSON.stringify(waResult?.error || waResult),
    })

    if (!success) {
      const errMsg = waResult?.error?.message || `HTTP ${waRes.status}`
      // No filtrar tokens ni payload completo de Meta en el cuerpo de error.
      return json({ success: false, error: errMsg })
    }

    return json({
      success: true,
      message_id: waResult.messages[0].id,
      phone: normalizedPhone,
    })
  } catch (err) {
    console.error('whatsapp-send error:', err instanceof Error ? err.message : err)
    return json({ success: false, error: 'Error interno' }, 500)
  }
})
