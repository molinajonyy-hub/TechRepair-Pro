/**
 * P0-ONBOARDING-1 — Condición fiscal del EMISOR: slug en la DB, etiqueta en la UI.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ALCANCE — hay TRES «condición fiscal» en el repo y esta es UNA sola
 * ─────────────────────────────────────────────────────────────────────────────
 *   (a) `business_settings.condicion_iva`  → la del EMISOR (el negocio). ESTA.
 *   (b) `comprobantes.condicion_fiscal`    → la del RECEPTOR del comprobante.
 *       La mapea `comprobanteService.CONDICION_IVA_RECEPTOR` a
 *       `CondicionIVAReceptorId` de ARCA. NO se toca acá.
 *   (c) `sales_points.condicion_fiscal`    → la del punto de venta. NO se toca.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL DEFECTO QUE CIERRA
 * ─────────────────────────────────────────────────────────────────────────────
 * El wizard escribía slugs (`monotributo`) y Configuración escribía etiquetas
 * (`Responsable Inscripto`), sobre la MISMA columna `text` sin CHECK. Medido en
 * producción: 3 vocabularios conviviendo — `monotributo` ×5,
 * `Responsable Inscripto` ×5, `Responsable Monotributo` ×2.
 *
 * Y como ninguna `<option>` del `<select>` de Configuración matcheaba un slug,
 * a los 5 negocios del wizard el campo se les renderizaba EN BLANCO: un
 * `<select>` controlado de React con un `value` que no existe entre sus
 * opciones deja `selectedIndex = -1`.
 *
 * Desde este lote: la DB guarda SLUG (con CHECK), la UI muestra ETIQUETA.
 *
 * `monotributista_social` NO se colapsa contra `monotributo`: en la taxonomía
 * de ARCA son códigos distintos (13 vs 6) y fusionarlos perdería semántica
 * fiscal.
 */

export const CONDICIONES_FISCALES = [
  { slug: 'responsable_inscripto', label: 'Responsable Inscripto'   },
  { slug: 'monotributo',           label: 'Responsable Monotributo' },
  { slug: 'monotributista_social', label: 'Monotributista Social'   },
  { slug: 'exento',                label: 'Exento'                  },
  { slug: 'consumidor_final',      label: 'Consumidor Final'        },
] as const

export type CondicionFiscalSlug = (typeof CONDICIONES_FISCALES)[number]['slug']

const POR_SLUG = new Map<string, string>(
  CONDICIONES_FISCALES.map(c => [c.slug, c.label])
)

/**
 * Etiquetas legacy -> slug canónico. Espejo EXACTO de
 * `private.normalize_condicion_iva(text)` en la migración 20260904120000.
 *
 * Existe para que la UI pueda mostrar correctamente un valor legacy que todavía
 * no pasó por el writer canónico. La autoridad sigue siendo la función de la DB:
 * si las dos divergen, manda la DB — el CHECK es quien decide qué entra.
 */
const LEGACY: Record<string, CondicionFiscalSlug> = {
  'responsable inscripto':     'responsable_inscripto',
  'iva responsable inscripto': 'responsable_inscripto',
  'monotributo':               'monotributo',
  'monotributista':            'monotributo',
  'responsable monotributo':   'monotributo',
  'monotributista social':     'monotributista_social',
  'exento':                    'exento',
  'iva exento':                'exento',
  'iva sujeto exento':         'exento',
  'consumidor final':          'consumidor_final',
}

/** Valor persistido (slug o etiqueta legacy) -> slug canónico. `null` si no se reconoce. */
export function normalizeCondicionFiscal(value?: string | null): CondicionFiscalSlug | null {
  const key = (value ?? '').trim().toLowerCase().replace(/[\s_]+/g, ' ')
  if (!key) return null
  return LEGACY[key] ?? null
}

/**
 * Etiqueta humana para un valor persistido. Devuelve `''` para lo desconocido:
 * un valor que no se reconoce NO se muestra crudo, porque «Responsable Marciano»
 * en pantalla parece un dato válido.
 */
export function labelCondicionFiscal(value?: string | null): string {
  const slug = normalizeCondicionFiscal(value)
  return slug ? POR_SLUG.get(slug) ?? '' : ''
}
