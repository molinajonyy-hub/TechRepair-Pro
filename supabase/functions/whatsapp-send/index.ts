import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { createCors, computeAllowedOrigins } from '../_shared/scopedCors.ts'
import { authorizeWhatsAppSender } from '../_shared/whatsappAuth.ts'

/**
 * Edge Function: whatsapp-send
 *
 * Envía un mensaje de texto libre vía WhatsApp Business Cloud API (Meta).
 *
 * SEGURIDAD:
 *  - El actor se toma EXCLUSIVAMENTE del JWT validado; nunca de `user_id` del body.
 *  - Se valida membresía ACTIVA del actor en `business_id` y un rol habilitado
 *    para enviar (ALLOWED_SENDER_ROLES), ANTES de leer credenciales o llamar a Meta.
 *    Esto impide el acceso cross-tenant (usuario de A usando business_id de B).
 *  - Las credenciales (phone_number_id, access_token) se cargan SERVER-SIDE desde
 *    `whatsapp_connections` / Vault usando el business_id ya autorizado. El cliente
 *    NUNCA transmite el access_token.
 *  - CORS con allowlist de orígenes (sin '*'); ver _shared/scopedCors.ts.
 *
 * Limitación de Meta: el texto libre sólo se entrega dentro de la ventana de
 * 24 h iniciada por el cliente. Fuera de ella la API devuelve error y se
 * responde success:false (sin falso "enviado").
 */

const cors = createCors(
  computeAllowedOrigins([
    Deno.env.get('WHATSAPP_CORS_ORIGIN'),
    Deno.env.get('APP_URL'),
  ]),
)

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
    return cors.preflight(req)
  }
  if (req.method !== 'POST') {
    return cors.json(req, { success: false, error: 'Método no permitido. Usar POST.' }, 405)
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

    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey        = Deno.env.get('SUPABASE_ANON_KEY')

    // Fail closed: el cliente que representa al USUARIO debe usar la anon key.
    // Nunca caer al service_role como reemplazo (eso anularía la verificación del
    // JWT). No se registran ni se devuelven valores de entorno.
    if (!anonKey) {
      console.error('whatsapp-send: SUPABASE_ANON_KEY no está configurada')
      return cors.json(req, {
        success: false,
        error: 'Configuración del servidor incompleta.',
        code: 'SERVER_MISCONFIGURED',
      }, 500)
    }

    // Cliente service-role: SÓLO para operaciones backend POSTERIORES a la autorización.
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    // ── Autorización OBLIGATORIA (antes de leer credenciales o llamar a Meta) ──
    // Actor exclusivamente desde el JWT; membresía activa + rol en `business_id`.
    const authz = await authorizeWhatsAppSender({
      businessId: business_id,
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

    // ── Validación de campos del mensaje (post-autorización) ──
    if (!phone)   return cors.json(req, { success: false, error: 'Falta el campo phone' }, 400)
    if (!message) return cors.json(req, { success: false, error: 'Falta el campo message' }, 400)

    // ── Cargar la conexión activa (metadatos; SIN secreto) del negocio AUTORIZADO ──
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
      return cors.json(req, {
        success: false,
        error: 'No hay una conexión de WhatsApp Cloud API activa para este negocio.',
      })
    }

    // ── Resolver el token cifrado desde Vault (sólo server-side, vía RPC) ──
    const { data: accessToken, error: tokenError } = await supabase
      .rpc('whatsapp_credential_get_token', { p_connection_id: connection.id })

    if (tokenError || !accessToken) {
      return cors.json(req, {
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
      return cors.json(req, { success: false, error: errMsg })
    }

    return cors.json(req, {
      success: true,
      message_id: waResult.messages[0].id,
      phone: normalizedPhone,
    })
  } catch (err) {
    console.error('whatsapp-send error:', err instanceof Error ? err.message : err)
    return cors.json(req, { success: false, error: 'Error interno' }, 500)
  }
})
