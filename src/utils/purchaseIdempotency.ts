// Lógica de idempotency key LOCAL para el flujo de compra (NewExpenseModal).
// El hash local sólo decide en la UI si renovar la key cuando el usuario cambió
// datos entre intentos. La validación autoritativa es server-side (request_hash
// en create_supplier_purchase_atomic). Se extrae acá para poder testear el
// comportamiento real (no el texto fuente).

const money2 = (n: number) => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2)
const qty4 = (n: number) => (Math.round((Number(n) + Number.EPSILON) * 10000) / 10000).toFixed(4)
const norm = (s?: string | null) => (s || '').trim() || '∅'

export interface PurchaseHashInput {
  businessId: string
  supplierId: string | null
  supplierName: string
  invoice: string
  date: string
  paymentMethod: string
  totalArs: number
  paidArs: number
  items: { inventory_id?: string | null; product_name: string; quantity: number; unit_cost: number }[]
}

/** Hash canónico determinístico del payload económico. Orden de ítems irrelevante. */
export function purchasePayloadHash(p: PurchaseHashInput): string {
  const items = p.items
    .map(it => `${it.inventory_id || '∅'}:${norm(it.product_name)}:${qty4(it.quantity)}:${money2(it.unit_cost)}`)
    .sort()
    .join('|')
  return [p.businessId, p.supplierId || '∅', norm(p.supplierName), norm(p.invoice),
    p.date, norm(p.paymentMethod), money2(p.totalArs), money2(p.paidArs), items].join('§')
}

/**
 * Decide la idempotency key a usar de forma determinística:
 * - sin key previa            → key nueva
 * - hash previo != hash nuevo → key nueva (el usuario cambió un dato económico)
 * - hash previo == hash nuevo → conserva la key (reintento / doble click)
 */
export function resolvePurchaseKey(
  prevKey: string | null,
  prevHash: string | null,
  newHash: string,
  genKey: () => string,
): { key: string; hash: string } {
  const key = (!prevKey || prevHash !== newHash) ? genKey() : prevKey
  return { key, hash: newHash }
}
