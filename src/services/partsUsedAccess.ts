import { supabase, type PartUsed } from '../lib/supabase'

export const PARTS_USED_OPERATIONAL_COLUMNS =
  'id, order_id, code, description, quantity, created_at, created_by, business_id'

/** Financial fields exist only when the backend projection authorizes them. */
export async function hydratePartsUsedAmounts(parts: PartUsed[]): Promise<PartUsed[]> {
  if (!parts.length) return parts
  const { data, error } = await supabase
    .from('v_parts_used_amounts')
    .select('id, unit_price, subtotal')
    .in('id', parts.map(part => part.id))
  if (error) throw error
  const amounts = new Map((data ?? []).map(row => [row.id as string, row]))
  return parts.map(part => {
    // Do not retain stale financial values after a permission change.
    const { unit_price: _price, subtotal: _subtotal, ...operational } = part
    const value = amounts.get(part.id)
    return value
      ? { ...operational, unit_price: value.unit_price as number, subtotal: value.subtotal as number }
      : operational
  })
}
