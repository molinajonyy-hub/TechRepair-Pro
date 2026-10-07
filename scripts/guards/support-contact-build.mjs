// ============================================================================
// BETA-UX-1A · política de build del canal de soporte + plugin de Vite.
//
// En producción se publicó un WhatsApp de ayuda inválido (`+594…`, una
// transposición de `+549`): la variable pasó todos los gates porque nadie la
// miraba. Este módulo es lo que `vite build` ejecuta ANTES de empaquetar.
//
// La REGLA del número no vive acá: es `validarWhatsAppSoporte` de
// `src/config/contacto.ts`, la misma que usa la app en runtime. Acá sólo está
// la POLÍTICA: en qué builds la variable es obligatoria.
//
//   valor presente e inválido → el build FALLA, en cualquier entorno
//   valor ausente             → FALLA en un deploy productivo (Vercel Production)
//                               AVISO en el resto (local, CI, Preview)
//
// Sin efectos al importarlo: lo carga `vite.config.ts`. El CLI y el self-test
// están en `support-contact.mjs`.
// ============================================================================
import { validarWhatsAppSoporte } from '../../src/config/contacto.ts'

export const VARIABLE = 'VITE_CONTACT_WHATSAPP'

const AYUDA =
  'Formato esperado: 549XXXXXXXXXX (13 dígitos: 54 + 9 + número nacional de 10).\n' +
  'Se configura en Vercel → Settings → Environment Variables. Ver docs/beta-ux-1/beta-ux-1a-support-channel.md.'

/** El único build que publica para usuarios reales es el de Vercel Production. */
export function esDeployProductivo(entorno) {
  return entorno?.VERCEL_ENV === 'production'
}

/** Deja ver el principio y el final para diagnosticar sin volcar el número entero al log. */
function enmascarar(valor) {
  const digitos = String(valor).replace(/\D/g, '')
  if (digitos.length <= 6) return `«${'•'.repeat(digitos.length)}» (${digitos.length} dígitos)`
  return `«${digitos.slice(0, 4)}…${digitos.slice(-2)}» (${digitos.length} dígitos)`
}

/**
 * Decisión del build. PURA.
 * @returns {{ nivel: 'ok' | 'aviso' | 'error', mensaje: string, numero?: string }}
 */
export function evaluarSoporteDeBuild({ valor, productivo }) {
  const ausente = typeof valor !== 'string' || valor.trim() === ''
  if (ausente) {
    return productivo
      ? { nivel: 'error', mensaje: `${VARIABLE} está vacío: el deploy productivo quedaría sin canal de ayuda.` }
      : { nivel: 'aviso', mensaje: `${VARIABLE} no está configurado: este build no ofrece canal de ayuda (sólo se permite fuera de producción).` }
  }
  const resultado = validarWhatsAppSoporte(valor)
  if (resultado.ok) return { nivel: 'ok', numero: resultado.numero, mensaje: `${VARIABLE} es un celular argentino válido.` }
  return { nivel: 'error', mensaje: `${VARIABLE} ${resultado.motivo}. Valor recibido: ${enmascarar(valor)}.` }
}

/**
 * Plugin de Vite. Corre sólo en `vite build`, en `configResolved`: lee la
 * variable tal como Vite la resolvió (entorno + archivos `.env`), que es
 * exactamente lo que quedaría inlineado en el bundle.
 */
export function supportContactGuard(entorno = process.env) {
  return {
    name: 'support-contact-guard',
    apply: 'build',
    configResolved(config) {
      const decision = evaluarSoporteDeBuild({
        valor: config.env?.[VARIABLE],
        productivo: esDeployProductivo(entorno),
      })
      if (decision.nivel === 'error') {
        throw new Error(`GUARD support-contact: ${decision.mensaje}\n${AYUDA}`)
      }
      if (decision.nivel === 'aviso') config.logger.warn(`GUARD support-contact: ${decision.mensaje}`)
    },
  }
}
