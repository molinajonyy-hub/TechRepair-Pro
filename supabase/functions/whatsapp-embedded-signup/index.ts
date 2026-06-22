/**
 * Edge Function: whatsapp-embedded-signup  — DESHABILITADA
 *
 * El flujo OAuth legacy (Embedded Signup antiguo, sin coexistencia v4) fue
 * RETIRADO a propósito. NO implementaba `whatsapp_business_app_onboarding`,
 * subscribe-app al WABA ni sincronización, por lo que no debe quedar operativo.
 *
 * Este endpoint responde SIEMPRE 503 con el código sanitizado
 * `META_EMBEDDED_SIGNUP_NOT_CONFIGURED`. El gate `META_EMBEDDED_SIGNUP_ENABLED`
 * queda reservado para la futura implementación v4 validada
 * (`whatsapp-embedded-signup-complete`); hasta que exista y esté aprobada como
 * Tech Provider, el onboarding oficial permanece bloqueado. No se exponen
 * secretos, detalles internos ni TODOs en la respuesta pública.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve((req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // El flujo legacy permanece bloqueado SIEMPRE hasta su reemplazo por la
  // implementación v4 con coexistencia, validada y aprobada como Tech Provider.
  return jsonResponse(
    {
      success: false,
      code: 'META_EMBEDDED_SIGNUP_NOT_CONFIGURED',
      error: 'La conexión oficial de WhatsApp todavía no está habilitada.',
    },
    503,
  )
})
