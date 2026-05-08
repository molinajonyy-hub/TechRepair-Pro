/**
 * otpService — Verificación de WhatsApp por OTP
 *
 * ESTADO ACTUAL: modo dev/manual
 *   - Genera un código de 6 dígitos
 *   - Lo almacena hasheado en wholesale_customers
 *   - Devuelve DEV_MODE=true + el código en texto para testing manual
 *   - NO envía el código por WhatsApp todavía (falta conectar Twilio/MBird)
 *
 * PARA ACTIVAR TWILIO:
 *   1. Instalar: npm i twilio
 *   2. Agregar env vars: VITE_TWILIO_ACCOUNT_SID, VITE_TWILIO_AUTH_TOKEN, VITE_TWILIO_FROM
 *   3. Descomentar el bloque TWILIO_SEND abajo
 *   4. Cambiar DEV_MODE a false
 *
 * CAMPOS EN wholesale_customers (ya en DB):
 *   - whatsapp_verified: boolean
 *   - whatsapp_code: text (código hasheado, TTL 10 min)
 *   - whatsapp_code_expires_at: timestamptz
 */

import { supabase } from '../../lib/supabase'

const DEV_MODE = true // cambiar a false al conectar proveedor

// Hash simple (SHA-256 via SubtleCrypto) — no expone el código en la DB
async function hashCode(code: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface OtpRequestResult {
  success: boolean
  devCode?: string      // solo en DEV_MODE — mostrar al user para testing
  error?: string
}

export interface OtpVerifyResult {
  success: boolean
  error?: string
}

// ─── Funciones ────────────────────────────────────────────────────────────────

/**
 * Solicita verificación de WhatsApp.
 * En producción: envía SMS/WA con el código.
 * En dev: devuelve el código para testing manual.
 */
export async function requestWhatsAppVerification(
  customerId: string,
  phone: string,
): Promise<OtpRequestResult> {
  const code    = generateCode()
  const hash    = await hashCode(code)
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 min

  // Guardar código hasheado en DB
  const { error } = await supabase
    .from('wholesale_customers')
    .update({
      whatsapp_code:             hash,
      whatsapp_code_expires_at:  expires,
    })
    .eq('id', customerId)

  if (error) return { success: false, error: error.message }

  if (DEV_MODE) {
    console.info('[OTP DEV] Código de verificación:', code, '— Phone:', phone)
    return { success: true, devCode: code }
  }

  // ── TWILIO_SEND (descomentar cuando esté configurado) ─────────────────────
  // try {
  //   const client = twilio(process.env.VITE_TWILIO_ACCOUNT_SID, process.env.VITE_TWILIO_AUTH_TOKEN)
  //   await client.messages.create({
  //     body: `Tu código de verificación para el portal mayorista es: ${code}. Válido 10 minutos.`,
  //     from: `whatsapp:${process.env.VITE_TWILIO_FROM}`,
  //     to:   `whatsapp:+${phone.replace(/\D/g, '')}`,
  //   })
  //   return { success: true }
  // } catch (e: any) {
  //   return { success: false, error: e.message }
  // }
  // ─────────────────────────────────────────────────────────────────────────────

  return { success: false, error: 'Proveedor de SMS/WhatsApp no configurado.' }
}

/**
 * Verifica el código ingresado por el usuario.
 * Si es correcto: marca whatsapp_verified = true y limpia el código.
 */
export async function verifyWhatsAppCode(
  customerId: string,
  inputCode: string,
): Promise<OtpVerifyResult> {
  const { data: customer, error: fetchErr } = await supabase
    .from('wholesale_customers')
    .select('whatsapp_code, whatsapp_code_expires_at')
    .eq('id', customerId)
    .maybeSingle()

  if (fetchErr || !customer) return { success: false, error: 'Error al verificar.' }
  if (!customer.whatsapp_code) return { success: false, error: 'No hay código activo. Solicitá uno nuevo.' }

  if (customer.whatsapp_code_expires_at && new Date(customer.whatsapp_code_expires_at) < new Date()) {
    return { success: false, error: 'El código expiró. Solicitá uno nuevo.' }
  }

  const inputHash = await hashCode(inputCode.trim())
  if (inputHash !== customer.whatsapp_code) {
    return { success: false, error: 'Código incorrecto. Revisalo e intentá de nuevo.' }
  }

  // Código correcto — actualizar estado
  const { error: updateErr } = await supabase
    .from('wholesale_customers')
    .update({
      whatsapp_verified:         true,
      whatsapp_code:             null,
      whatsapp_code_expires_at:  null,
    })
    .eq('id', customerId)

  if (updateErr) return { success: false, error: updateErr.message }
  return { success: true }
}
