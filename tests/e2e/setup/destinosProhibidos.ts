// ============================================================================
// M7 7D.2 — Predicado puro: ¿a qué hosts no debe hablar un E2E?
//
// Vive aparte del fixture de Playwright para poder testearlo con node:test sin
// arrastrar el runtime del browser. Un guard sin tests es una ilusión de guard.
// ============================================================================

const ANALYTICS = /(^|\.)(google-analytics|googletagmanager|doubleclick|hotjar|mixpanel|segment)\.|(^|\.)sentry\.io$/

/** Devuelve el motivo por el que el destino está prohibido, o null si es aceptable. */
export function motivoDestinoProhibido(url: string): string | null {
  let h: string
  try {
    h = new URL(url).hostname
  } catch {
    return null // no es una URL absoluta: no hay host al que fugarse
  }
  if (h.endsWith('.supabase.co') || h.endsWith('.supabase.in')) {
    return 'Supabase gestionado (remoto)'
  }
  // Telemetría: no aporta a los tests y ensucia métricas reales con tráfico falso.
  if (ANALYTICS.test(h)) {
    return 'analytics/telemetría'
  }
  return null
}
