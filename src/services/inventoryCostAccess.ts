// ─────────────────────────────────────────────────────────────────────────────
// SEC-08B — acceso al costo interno de inventario desde el navegador
// ─────────────────────────────────────────────────────────────────────────────
//
// Desde SEC-08B las columnas de costo ya NO están concedidas a los roles del
// navegador. Consecuencias prácticas, y el motivo de que este módulo exista:
//
//   1. `select('*')` sobre `inventory`, `inventory_movements` y
//      `comprobante_items` responde 42501 para TODOS —owner incluido—, porque
//      un GRANT de columna es estático y no depende del actor. Hay que pedir
//      columnas explícitas: usar las constantes `*_OPERATIONAL_COLUMNS`.
//
//   2. El costo se lee por las vistas autorizadas (`v_inventory_costs`,
//      `v_inventory_movement_costs`, `v_comprobante_item_costs`), que ya
//      aplican tenant y capacidad server-side. Un actor sin autoridad no
//      recibe un error: recibe CERO FILAS.
//
// De ahí la regla de presentación que acompaña a este módulo: la ausencia de
// costo es DESCONOCIDO, no cero. Nunca mostrar `$0`, «sin costo», margen 100 %
// ni ganancia = venta cuando el costo simplemente no está autorizado; para eso
// está `COST_RESTRICTED` y `formatCostOrRestricted`.
import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'

/** Marcador de «no autorizado a ver el costo». No es 0 y no es null-por-error. */
export const COST_RESTRICTED = Symbol('cost-restricted')
export type CostValue = number | null | typeof COST_RESTRICTED

/** Texto único para una celda de costo restringida. */
export const COST_RESTRICTED_LABEL = 'Costo restringido'

// Las tres constantes son literales `as const` y NO un `[].join()`. No es
// cosmética: supabase-js infiere el tipo de la fila a partir del literal que
// recibe `.select()`. Con un string armado en runtime la inferencia se cae a
// `GenericStringError` y todos los accesos a campos dejan de compilar.

/**
 * Columnas operativas de `inventory`. Es `*` menos `cost_price` y
 * `cost_price_usd`. Si se agrega una columna nueva a la tabla hay que sumarla
 * acá, o no llegará al cliente.
 */
export const INVENTORY_OPERATIONAL_COLUMNS =
  'id, code, name, category, description, stock, min_stock, sale_price, supplier_id, created_at, updated_at, stock_quantity, reserved_quantity, is_active, subcategory, max_stock, supplier_code, location, created_by, business_id, price_usd, currency, base_currency, base_price, exchange_rate_used, auto_update_price, linked_to_dolar, tipo, precio_mayorista, mayorista_enabled, variant_name, has_variants, visible_in_wholesale, portal_title, portal_description, portal_description_full, portal_compatibility, portal_tags, portal_featured, portal_is_new, portal_on_sale, portal_sort_order, portal_condition, portal_warranty, portal_notes, portal_specs, portal_min_qty, portal_main_image, portal_images, brand, model, barcode, wholesale_price_ars, wholesale_price_usd, parent_id' as const

/** Columnas operativas de `inventory_movements` (todo menos `unit_cost`). */
export const INVENTORY_MOVEMENT_OPERATIONAL_COLUMNS =
  'id, business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock, reference_type, reference_id, note, created_at, created_by, currency, exchange_rate, supplier_id, variant_id, product_id' as const

/** Columnas operativas de `comprobante_items` (todo menos el costo de línea). */
export const COMPROBANTE_ITEM_OPERATIONAL_COLUMNS =
  'id, comprobante_id, descripcion, cantidad, precio_unitario, subtotal, inventory_id, orden, created_at, business_id, created_by, currency, exchange_rate, tipo_linea, descuento_linea, applied_price_type, stock_processed, stock_processed_at, stock_movement_id, list_price_ars, price_override, applied_price_source' as const

export interface InventoryCost {
  cost_price: number | null
  cost_price_usd: number | null
}

/**
 * Costos de una lista de productos o variantes.
 *
 * Devuelve un Map sólo con lo que el servidor autorizó. Un id ausente del Map
 * significa «no autorizado o sin dato», nunca «cuesta cero»: quien consume esto
 * tiene que distinguir los dos casos al mostrar.
 *
 * `authorized` dice si el actor tiene autoridad de costo en general, y sirve
 * para elegir entre «—» (restringido) y «sin costo cargado» (autorizado pero el
 * producto no tiene costo).
 */
export async function fetchInventoryCosts(
  inventoryIds: string[]
): Promise<{ costs: Map<string, InventoryCost>; authorized: boolean }> {
  const ids = [...new Set(inventoryIds.filter(Boolean))]
  if (ids.length === 0) return { costs: new Map(), authorized: await hasInventoryCostAuthority() }

  const costs = new Map<string, InventoryCost>()
  // PostgREST arma la URL en el query string: se trocea para no pasarse de largo.
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('v_inventory_costs')
      .select('inventory_id, cost_price, cost_price_usd')
      .in('inventory_id', slice)
    if (error) {
      logger.error('INVENTORY', 'No se pudieron leer costos autorizados', error)
      return { costs: new Map(), authorized: false }
    }
    for (const row of data ?? []) {
      costs.set(row.inventory_id as string, {
        cost_price: row.cost_price as number | null,
        cost_price_usd: row.cost_price_usd as number | null,
      })
    }
  }
  // Si no volvió ni una fila para ids que existen, el actor no tiene autoridad.
  return { costs, authorized: costs.size > 0 || (await hasInventoryCostAuthority()) }
}

/**
 * ¿Este actor puede ver el costo de inventario en un negocio CONCRETO?
 *
 * Pregunta a la autoridad canónica del servidor. No reproduce la matriz de
 * capacidades en el cliente —duplicarla sería una segunda fuente de verdad que
 * se desincroniza en el primer override— y, sobre todo, no la INFIERE de si
 * volvieron filas: un negocio sin productos, o un comprobante cuyas líneas no
 * están autorizadas por SEC-08A, darían «sin autoridad» siendo falso.
 */
export async function canViewInventoryCostIn(businessId: string | null | undefined): Promise<boolean> {
  if (!businessId) return false
  const { data, error } = await supabase.rpc('can_view_inventory_cost', { p_business_id: businessId })
  if (error) {
    logger.error('INVENTORY', 'No se pudo resolver la autoridad de costo de inventario', error)
    return false
  }
  return data === true
}

/**
 * Variante sin negocio explícito, para las superficies que no lo tienen a mano.
 *
 * Se apoya en la misma vista autorizada. Preferir `canViewInventoryCostIn`
 * cuando el `business_id` esté disponible: es explícita y no depende de que
 * exista al menos un producto.
 */
export async function hasInventoryCostAuthority(): Promise<boolean> {
  const { data, error } = await supabase
    .from('v_inventory_costs')
    .select('inventory_id')
    .limit(1)
  if (error) return false
  return (data?.length ?? 0) > 0
}

/**
 * Repone `cost_price` / `cost_price_usd` sobre filas de producto ya leídas.
 *
 * Es el reemplazo directo de pedir esas columnas dentro del `select`, que desde
 * SEC-08B devuelve 42501. Un actor sin autoridad recibe las filas intactas y sin
 * costo: las pantallas que muestren margen tienen que apagar ese bloque, no
 * calcularlo con cero.
 */
export type WithCost<T> = T & { cost_price: number | null; cost_price_usd: number | null }

export async function attachInventoryCosts<T extends { id?: string | null }>(
  rows: T[]
): Promise<WithCost<T>[]> {
  if (!rows || rows.length === 0) return [] as WithCost<T>[]
  const { costs } = await fetchInventoryCosts(rows.map(r => r?.id).filter(Boolean) as string[])
  // El null va DESPUÉS del spread, no antes: esta función es la AUTORIDAD del
  // costo en el cliente. Si alguna fila llegara con un `cost_price` por otra
  // vía, se normaliza a «desconocido» salvo que el servidor lo haya autorizado
  // acá. Al revés —null primero, spread después— un valor colado sobreviviría
  // y se mostraría como costo real sin que nadie lo hubiera autorizado.
  return rows.map(r => {
    const c = r?.id ? costs.get(r.id) : undefined
    return {
      ...r,
      cost_price: c ? c.cost_price : null,
      cost_price_usd: c ? c.cost_price_usd : null,
    } as WithCost<T>
  })
}

/**
 * ¿Este actor puede ver el COGS (costo de la línea de venta) del negocio?
 *
 * No es lo mismo que `hasInventoryCostAuthority`: el COGS alimenta el P&L y lo
 * consume también quien tiene `finance` —el cashier— sin tener
 * `inventory_view_costs`. Se pregunta al servidor por la MISMA función que
 * gatea las vistas, para no reimplementar la matriz en el cliente.
 *
 * Su uso es de PRESENTACIÓN: decidir entre mostrar el número que devuelve la
 * fuente canónica y mostrar «restringido». Nunca para calcular el número.
 */
export async function hasCogsAuthority(businessId: string | null | undefined): Promise<boolean> {
  if (!businessId) return false
  const { data, error } = await supabase.rpc('can_view_cogs', { p_business_id: businessId })
  if (error) {
    logger.error('FINANCE', 'No se pudo resolver la autoridad de COGS', error)
    return false
  }
  return data === true
}

/** Costo unitario de movimientos de stock, para las pantallas autorizadas. */
export async function fetchMovementCosts(movementIds: string[]): Promise<Map<string, number | null>> {
  const ids = [...new Set(movementIds.filter(Boolean))]
  const out = new Map<string, number | null>()
  if (ids.length === 0) return out
  const { data, error } = await supabase
    .from('v_inventory_movement_costs')
    .select('movement_id, unit_cost')
    .in('movement_id', ids)
  if (error) {
    logger.error('INVENTORY', 'No se pudieron leer costos de movimientos', error)
    return out
  }
  for (const row of data ?? []) out.set(row.movement_id as string, row.unit_cost as number | null)
  return out
}

/**
 * Formatea un costo para pantalla sin inventar números.
 *
 * `undefined` (id ausente del Map) con autoridad → el producto no tiene costo
 * cargado. Sin autoridad → restringido. En ningún caso se devuelve «$0».
 */
export function formatCostOrRestricted(
  value: number | null | undefined,
  authorized: boolean,
  format: (n: number) => string
): string {
  if (!authorized) return COST_RESTRICTED_LABEL
  if (value === null || value === undefined) return '—'
  return format(value)
}

