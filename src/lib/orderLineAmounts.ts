import { supabase } from './supabase'

/**
 * SEC-08A Fase B — importes de LÍNEA de una orden.
 *
 * `order_items.precio_unitario` / `costo_unitario` y
 * `order_parts.internal_cost` / `sale_price` / márgenes dejaron de estar
 * concedidos al browser: leerlos crudos reconstruía `orders.estimated_total` y
 * `orders.total_cost` exactamente (`recalculate_order_total` los define como esas
 * sumas). La única ruta autorizada es `get_order_line_amounts`, que verifica
 * pertenencia al tenant y `orders_view_financials` en ese mismo negocio.
 *
 * Sin autorización NO se devuelven ceros: los mapas quedan vacíos y
 * `authorized` es false. `undefined` significa "no autorizado", nunca "cero".
 */
export interface OrderItemAmounts {
  precio_unitario: number
  costo_unitario: number
}

export interface OrderPartAmounts {
  internal_cost: number | null
  sale_price: number | null
  margin_amount: number | null
  margin_percentage: number | null
}

export interface OrderLineAmounts {
  authorized: boolean
  /** id de `order_items` -> importes de esa línea */
  items: Map<string, OrderItemAmounts>
  /** id de `order_parts` -> importes de ese repuesto */
  parts: Map<string, OrderPartAmounts>
}

const DENIED: OrderLineAmounts = { authorized: false, items: new Map(), parts: new Map() }

interface LineAmountsResponse {
  ok?: boolean
  authorized?: boolean
  items?: Array<{ id: string } & Partial<OrderItemAmounts>>
  parts?: Array<{ id: string } & Partial<OrderPartAmounts>>
}

/**
 * Una sola llamada por lote de órdenes, nunca una por línea.
 * `orderIds` vacío evita el round-trip: no hay nada que autorizar.
 */
export async function fetchOrderLineAmounts(
  businessId: string | null | undefined,
  orderIds: string[],
): Promise<OrderLineAmounts> {
  if (!businessId || orderIds.length === 0) return DENIED

  const { data, error } = await supabase.rpc('get_order_line_amounts', {
    p_business_id: businessId,
    p_order_ids: orderIds,
  })

  const res = data as LineAmountsResponse | null
  if (error || res?.ok === false || res?.authorized !== true) return DENIED

  const items = new Map<string, OrderItemAmounts>()
  for (const row of res.items ?? []) {
    items.set(row.id, {
      precio_unitario: Number(row.precio_unitario ?? 0),
      costo_unitario: Number(row.costo_unitario ?? 0),
    })
  }

  const parts = new Map<string, OrderPartAmounts>()
  for (const row of res.parts ?? []) {
    parts.set(row.id, {
      internal_cost: row.internal_cost == null ? null : Number(row.internal_cost),
      sale_price: row.sale_price == null ? null : Number(row.sale_price),
      margin_amount: row.margin_amount == null ? null : Number(row.margin_amount),
      margin_percentage: row.margin_percentage == null ? null : Number(row.margin_percentage),
    })
  }

  return { authorized: true, items, parts }
}

/**
 * Fusiona los importes autorizados sobre filas operativas ya cargadas.
 * Si el servidor no autorizó, las filas vuelven SIN campos de importe —no con
 * ceros—, para que la UI pueda distinguir "restringido" de "cero".
 */
export function mergeItemAmounts<T extends { id: string }>(
  rows: T[],
  amounts: OrderLineAmounts,
): Array<T & Partial<OrderItemAmounts>> {
  if (!amounts.authorized) return rows
  return rows.map(row => {
    const amt = amounts.items.get(row.id)
    return amt ? { ...row, ...amt } : row
  })
}

export function mergePartAmounts<T extends { id: string }>(
  rows: T[],
  amounts: OrderLineAmounts,
): Array<T & Partial<OrderPartAmounts>> {
  if (!amounts.authorized) return rows
  return rows.map(row => {
    const amt = amounts.parts.get(row.id)
    return amt ? { ...row, ...amt } : row
  })
}

/** Columnas OPERATIVAS de `order_items` que el browser sí puede leer. */
export const ORDER_ITEM_OPERATIONAL_COLUMNS =
  'id, order_id, product_id, business_id, tipo, descripcion, cantidad, cliente_paga_repuesto, created_at, updated_at'

/** Columnas OPERATIVAS de `order_parts` que el browser sí puede leer. */
export const ORDER_PART_OPERATIONAL_COLUMNS =
  'id, order_id, business_id, name, description, part_number, quantity, status, deduct_from_inventory, notes, added_at, created_by, cliente_paga_repuesto'
