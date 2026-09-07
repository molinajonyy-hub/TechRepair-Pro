import { supabase, type PartUsed } from '../lib/supabase'

export const PARTS_USED_OPERATIONAL_COLUMNS =
  'id, order_id, code, description, quantity, created_at, created_by, business_id'

/** Only the paired absence of SEC-08E objects is a transitional schema. */
export async function isPreSec08eSchema(error: { code?: string; message: string }): Promise<boolean> {
  if (error.code !== 'PGRST205' || error.message !==
      "Could not find the table 'public.v_parts_used_amounts' in the schema cache") return false

  // This self-only helper ships atomically with the view. Probe with NULL so
  // this checks deployment presence, never another tenant's authorization.
  const { error: markerError } = await supabase.rpc('can_view_payment_allocations', { p_business_id: null })
  if (!markerError) return false // Migrated schema: a missing view is a real fault.
  if (markerError.code === 'PGRST202' && markerError.message ===
      'Could not find the function public.can_view_payment_allocations(p_business_id) in the schema cache') return true
  throw markerError
}

/** Backend checks active membership and capability in this exact business. */
export async function canReadPartsAmounts(businessId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('current_user_can_in_business', {
    p_business_id: businessId, p_key: 'orders_view_financials',
  })
  if (error) throw error
  return data === true
}

/** Transitional read only after BOTH missing-object checks, never after denial. */
async function readPreSchemaAmounts(parts: (PartUsed & { business_id?: string })[]) {
  const groups = new Map<string, string[]>()
  for (const part of parts) {
    if (!part.business_id) throw new Error('Falta el negocio del repuesto para verificar sus importes.')
    groups.set(part.business_id, [...(groups.get(part.business_id) ?? []), part.id])
  }
  const amounts: { id: string; unit_price: number; subtotal: number }[] = []
  for (const [businessId, ids] of groups) {
    if (!await canReadPartsAmounts(businessId)) continue
    const { data, error } = await supabase.from('parts_used')
      .select('id, unit_price, subtotal').eq('business_id', businessId).in('id', ids)
    if (error) throw error
    amounts.push(...(data ?? []))
  }
  return amounts
}

/** Prefer the protected projection; preserve authorized pre-schema amounts. */
export async function hydratePartsUsedAmounts(parts: (PartUsed & { business_id?: string })[]): Promise<PartUsed[]> {
  if (!parts.length) return parts
  const { data, error } = await supabase
    .from('v_parts_used_amounts')
    .select('id, unit_price, subtotal')
    .in('id', parts.map(part => part.id))
  let rows = data ?? []
  if (error) {
    if (!await isPreSec08eSchema(error)) throw error
    rows = await readPreSchemaAmounts(parts)
  }
  const amounts = new Map(rows.map(row => [row.id as string, row]))
  return parts.map(part => {
    // Do not retain stale financial values after a permission change.
    const { unit_price: _price, subtotal: _subtotal, ...operational } = part
    const value = amounts.get(part.id)
    return value
      ? { ...operational, unit_price: value.unit_price as number, subtotal: value.subtotal as number }
      : operational
  })
}
