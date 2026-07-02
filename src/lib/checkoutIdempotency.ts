/**
 * Idempotencia server-side del checkout (comprobanteService.crear()).
 *
 * La clave de idempotencia identifica un INTENTO COMERCIAL, no una request
 * HTTP: se genera una sola vez antes de intentar crear la venta, y se
 * conserva durante doble click, timeout, retry, reconexión o refresh — hasta
 * que la creación local termina de forma definitiva (created/existing/
 * idempotency_conflict/failed_final) o el usuario descarta explícitamente el
 * checkout. Nunca se regenera automáticamente para "esquivar" un timeout o
 * un conflicto — eso duplicaría la venta.
 *
 * request_hash: hash determinista (SHA-256) del contenido COMERCIAL
 * relevante (ver CANONICAL_FIELDS más abajo) — nunca del payload completo,
 * nunca de timestamps/correlation IDs/estado de UI. Dos requests con la
 * misma key pero distinto hash indican que el carrito cambió entre el
 * primer intento y el retry: eso es un conflicto real (idempotency_conflict),
 * no algo que deba "seguir silenciosamente".
 *
 * DOS CAPAS DE HASH (auditoría pricing server-side, 2026-07-01):
 *   - client_request_hash (este módulo — antes "request_hash"): la
 *     INTENCIÓN enviada por el cliente, sirve para decidir localmente si
 *     conviene reutilizar la key persistida, y server-side para detectar que
 *     la MISMA key no se reutilice con un carrito distinto.
 *   - resolved_checkout_hash (columna en comprobante_checkout_requests,
 *     calculada DENTRO de create_comprobante_checkout_atomic): hash de los
 *     precios/costos/totales YA RESUELTOS server-side (después de aplicar
 *     resolve_product_pricing + permisos de override) — foto inmutable de lo
 *     que realmente se cobró. Nunca se usa para decidir idempotencia.
 */

export interface CheckoutHashInput {
  business_id: string
  tipo: string
  customer_id?: string | null
  condicion_fiscal?: string | null
  currency?: string
  items: {
    inventory_id?: string | null
    descripcion: string
    tipo_linea?: string
    cantidad: number
    precio_unitario: number
    descuento_linea?: number
    currency?: string
  }[]
  pagos: {
    payment_method: string
    amount: number
    currency?: string
  }[]
  subtotal: number
  tax: number
  total: number
  cc_total: number
}

/** Redondea a 2 decimales como número (no string) para evitar que -0/0.10000000001 cambien el hash. */
function normalizeNumber(n: number | undefined | null): number {
  if (n === undefined || n === null || Number.isNaN(n)) return 0
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100
  return rounded === 0 ? 0 : rounded // colapsa -0 a 0
}

/** Ordena claves de objetos recursivamente y normaliza números — hace el JSON determinista. */
function canonicalize(value: unknown): unknown {
  if (typeof value === 'number') return normalizeNumber(value)
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort()
    const out: Record<string, unknown> = {}
    for (const k of sortedKeys) out[k] = canonicalize((value as Record<string, unknown>)[k])
    return out
  }
  return value
}

/** Clave estable de ordenamiento para ítems/pagos — el ORDEN de estas listas no es semántico. */
function itemSortKey(i: CheckoutHashInput['items'][0]): string {
  return [i.inventory_id || '', i.descripcion, i.tipo_linea || 'producto', normalizeNumber(i.cantidad), normalizeNumber(i.precio_unitario), normalizeNumber(i.descuento_linea), i.currency || 'ARS'].join('|')
}
function pagoSortKey(p: CheckoutHashInput['pagos'][0]): string {
  return [p.payment_method, normalizeNumber(p.amount), p.currency || 'ARS'].join('|')
}

/**
 * Construye la estructura canónica que se hashea. Deliberadamente NO incluye:
 * created_by/user_id, timestamps, correlation_id, caja_id (elección operativa,
 * no identidad de la venta), ni ningún campo de estado de UI.
 */
function buildCanonicalPayload(input: CheckoutHashInput) {
  const items = [...input.items]
    .sort((a, b) => itemSortKey(a).localeCompare(itemSortKey(b)))
    .map(i => ({
      inventory_id: i.inventory_id || null,
      descripcion: i.descripcion,
      tipo_linea: i.tipo_linea || 'producto',
      cantidad: normalizeNumber(i.cantidad),
      precio_unitario: normalizeNumber(i.precio_unitario),
      descuento_linea: normalizeNumber(i.descuento_linea),
      currency: i.currency || 'ARS',
    }))

  const pagos = [...input.pagos]
    .sort((a, b) => pagoSortKey(a).localeCompare(pagoSortKey(b)))
    .map(p => ({
      payment_method: p.payment_method,
      amount: normalizeNumber(p.amount),
      currency: p.currency || 'ARS',
    }))

  return canonicalize({
    business_id: input.business_id,
    tipo: input.tipo,
    customer_id: input.customer_id || null,
    condicion_fiscal: input.condicion_fiscal || null,
    currency: input.currency || 'ARS',
    items,
    pagos,
    subtotal: input.subtotal,
    tax: input.tax,
    total: input.total,
    cc_total: input.cc_total,
  })
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Hash determinista del contenido comercial — mismo carrito (en cualquier orden) → mismo hash. */
export async function computeCheckoutRequestHash(input: CheckoutHashInput): Promise<string> {
  const canonical = buildCanonicalPayload(input)
  return sha256Hex(JSON.stringify(canonical))
}

// ─── Persistencia de la key en el navegador ────────────────────────────────

export interface PendingCheckout {
  idempotencyKey: string
  requestHash: string
  businessId: string
  createdAt: string
  comprobanteId?: string
}

function storageKey(businessId: string): string {
  return `techrepair:checkout-pending:${businessId}`
}

/** Persiste (o actualiza) el checkout pendiente — sobrevive refresh/navegación accidental. */
export function savePendingCheckout(pending: PendingCheckout): void {
  try {
    sessionStorage.setItem(storageKey(pending.businessId), JSON.stringify(pending))
  } catch {
    // sessionStorage puede no estar disponible (modo privado, cuota) — la key
    // sigue viva en memoria (useRef) durante la sesión de React actual.
  }
}

/** Lee el checkout pendiente de este negocio, si existe. */
export function readPendingCheckout(businessId: string): PendingCheckout | null {
  try {
    const raw = sessionStorage.getItem(storageKey(businessId))
    if (!raw) return null
    return JSON.parse(raw) as PendingCheckout
  } catch {
    return null
  }
}

/** Descarta el checkout pendiente — SOLO cuando terminó de forma definitiva o el usuario lo descarta explícitamente. */
export function clearPendingCheckout(businessId: string): void {
  try {
    sessionStorage.removeItem(storageKey(businessId))
  } catch {
    // no-op
  }
}

/**
 * Resuelve qué idempotency key usar para un nuevo intento de checkout:
 *  - Si hay uno pendiente para este negocio Y el hash coincide → reutiliza la key
 *    (mismo intento comercial, ej. reload tras un timeout).
 *  - Si no hay uno pendiente, o el hash no coincide (carrito distinto, venta
 *    nueva) → genera una key nueva y la persiste.
 * Nunca regenera la key para el MISMO hash — eso es exactamente lo que
 * duplicaría la venta ante un doble submit.
 */
export function getOrCreateIdempotencyKey(businessId: string, requestHash: string): { idempotencyKey: string; isResumed: boolean } {
  const pending = readPendingCheckout(businessId)
  if (pending && pending.requestHash === requestHash) {
    return { idempotencyKey: pending.idempotencyKey, isResumed: true }
  }
  const idempotencyKey = crypto.randomUUID()
  savePendingCheckout({ idempotencyKey, requestHash, businessId, createdAt: new Date().toISOString() })
  return { idempotencyKey, isResumed: false }
}
