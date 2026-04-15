import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Normaliza número de teléfono argentino para WhatsApp Cloud API.
 * Formato requerido: 549XXXXXXXXXX (54 = país, 9 = móvil, 10 dígitos locales)
 */
function normalizeArgentinePhone(phone: string): string {
  // Solo dígitos
  let digits = phone.replace(/\D/g, '')

  // Quitar 0 inicial (ej: 011 → 11)
  if (digits.startsWith('0')) digits = digits.slice(1)

  // Quitar 15 después del código de área (ej: 11 15 XXXX → 11 XXXX)
  if (digits.length === 11 && digits.startsWith('11')) {
    // Buenos Aires con 15: 11 15 XXXXXXXX → 11 XXXXXXXX
    if (digits.slice(2, 4) === '15') {
      digits = '11' + digits.slice(4)
    }
  }

  // Si tiene 10 dígitos (sin código de país), agregar 54
  if (digits.length === 10) digits = '54' + digits

  // Si ya tiene 54 pero sin el 9 de móvil (12 dígitos), agregar 9
  if (digits.startsWith('54') && digits.length === 12) {
    digits = '549' + digits.slice(2)
  }

  // Si ya tiene 549 y 13 dígitos → correcto
  return digits
}

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const {
      phone,
      message,
      phone_number_id,
      access_token,
      business_id,
      order_id,
      customer_id,
      status_key,
      send_mode = 'api',
    } = body

    // Validaciones
    if (!phone) {
      return new Response(
        JSON.stringify({ success: false, error: 'Falta el campo phone' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    if (!message) {
      return new Response(
        JSON.stringify({ success: false, error: 'Falta el campo message' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    if (!phone_number_id || !access_token) {
      return new Response(
        JSON.stringify({ success: false, error: 'Faltan credenciales de WhatsApp API (phone_number_id y access_token)' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const normalizedPhone = normalizeArgentinePhone(phone)

    // Llamar a WhatsApp Cloud API
    const waRes = await fetch(
      `https://graph.facebook.com/v19.0/${phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: normalizedPhone,
          type: 'text',
          text: {
            preview_url: false,
            body: message,
          },
        }),
      }
    )

    const waResult = await waRes.json()
    const success = waRes.ok && !!waResult.messages?.[0]?.id

    // Guardar log en Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    if (business_id) {
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
    }

    if (!success) {
      const errMsg = waResult?.error?.message || `HTTP ${waRes.status}`
      return new Response(
        JSON.stringify({ success: false, error: errMsg, details: waResult }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        message_id: waResult.messages[0].id,
        phone: normalizedPhone,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: any) {
    console.error('whatsapp-send error:', err)
    return new Response(
      JSON.stringify({ success: false, error: err?.message || 'Error interno' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
