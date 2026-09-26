import { supabase } from '../lib/supabase';
import { INVENTORY_MOVEMENT_OPERATIONAL_COLUMNS } from './inventoryCostAccess'

export type MovementType =
  | 'in'
  | 'out'
  | 'adjustment'
  | 'order_usage'
  | 'sale'
  | 'purchase'
  | 'return'
  | 'credit_note'
  | 'cancellation';

export type ReferenceType =
  | 'order'
  | 'comprobante'
  | 'purchase'
  | 'manual'
  | 'adjustment'
  | 'supplier_return'
  | 'credit_note';

export interface InventoryMovement {
  id:                string;
  inventory_item_id: string;
  movement_type:     MovementType;
  quantity:          number;
  previous_stock:    number;
  new_stock:         number;
  reference_type?:   ReferenceType;
  reference_id?:     string;
  note?:             string;
  business_id?:      string;
  created_at:        string;
  created_by?:       string;
  unit_cost?:        number;
  currency?:         string;
  exchange_rate?:    number;
  supplier_id?:      string;
  variant_id?:       string;
}

/**
 * G2-C.3A2 — servicio de SÓLO LECTURA.
 *
 * `registerMovement` (SELECT → cálculo JS → UPDATE absoluto → INSERT →
 * rollback absoluto desde el navegador) y `revertMovement` se eliminaron: eran
 * un writer inseguro (lost update, rollback que pisa ventas concurrentes). El
 * libro `inventory_movements` lo escriben SÓLO los writers server-side: los
 * documentales W1-W7 y la RPC canónica apply_inventory_stock_adjustments_atomic.
 */
export const inventoryMovementsService = {

  async getMovementsByItem(inventoryItemId: string): Promise<InventoryMovement[]> {
    const { data, error } = await supabase
      .from('inventory_movements')
      .select(INVENTORY_MOVEMENT_OPERATIONAL_COLUMNS)
      .eq('inventory_item_id', inventoryItemId)
      .order('created_at', { ascending: false })

    if (error) throw new Error('Error al obtener movimientos.')
    return data || []
  },

  async getMovementsByReference(
    referenceType: ReferenceType,
    referenceId:   string
  ): Promise<InventoryMovement[]> {
    const { data, error } = await supabase
      .from('inventory_movements')
      .select(INVENTORY_MOVEMENT_OPERATIONAL_COLUMNS)
      .eq('reference_type', referenceType)
      .eq('reference_id', referenceId)
      .order('created_at', { ascending: false })

    if (error) throw new Error('Error al obtener movimientos por referencia.')
    return data || []
  },
}
