/**
 * AFIP-S1B-A2: saneamiento de mensajes de error antes de persistir el estado de
 * conexión (set_arca_estado_conexion). Módulo PURO (sin dependencias de Vite/
 * Supabase) para poder testearlo bajo `node --test`.
 *
 * Elimina material sensible o ruidoso: bloques PEM, XML/SOAP fiscal completo,
 * token/sign, y recorta la longitud. El server además trunca a 500.
 */
export function sanitizeArcaError(raw: unknown): string {
  let msg = typeof raw === 'string' ? raw : (raw as { message?: string } | null)?.message || 'Error de conexión'
  msg = String(msg)
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[pem omitido]') // bloques PEM (cert/clave)
    .replace(/<[^>]+>/g, ' ')                                          // tags XML/SOAP
    .replace(/\b(token|sign)\s*[:=]\s*\S+/gi, '$1: [omitido]')         // token/sign
    .replace(/\s+/g, ' ')
    .trim()
  return msg.slice(0, 200)
}
