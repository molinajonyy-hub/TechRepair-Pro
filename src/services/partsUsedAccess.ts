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

/** Financial fields exist only when the backend projection authorizes them. */
export async function hydratePartsUsedAmounts(parts: PartUsed[]): Promise<PartUsed[]> {
  if (!parts.length) return parts
  const { data, error } = await supabase
    .from('v_parts_used_amounts')
    .select('id, unit_price, subtotal')
    .in('id', parts.map(part => part.id))
  if (error && !await isPreSec08eSchema(error)) throw error
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
