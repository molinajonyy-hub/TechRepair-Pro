import { supabase } from '../lib/supabase';

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

/** Campos opcionales de contexto financiero/auditoría para el movimiento. */
export interface MovementExtras {
  unit_cost?:    number;
  currency?:     string;
  exchange_rate?: number | null;
  supplier_id?:  string | null;
  variant_id?:   string | null;
}

export const inventoryMovementsService = {

  async registerMovement(
    inventoryItemId: string,
    movementType:    MovementType,
    quantity:        number,
    referenceType?:  ReferenceType,
    referenceId?:    string,
    note?:           string,
    businessId?:     string,
    userId?:         string,
    extras?:         MovementExtras
  ): Promise<InventoryMovement> {

    // quantity debe ser entero distinto de cero
    const qty = Math.round(quantity)
    if (!qty) throw new Error('La cantidad del movimiento debe ser distinta de cero.')

    let itemQuery = supabase
      .from('inventory')
      .select('stock_quantity, business_id')
      .eq('id', inventoryItemId)

    if (businessId) {
      itemQuery = itemQuery.eq('business_id', businessId)
    }

    const { data: item, error: itemError } = await itemQuery.single()

    if (itemError || !item) {
      throw new Error('Producto no encontrado en inventario.')
    }

    const resolvedBusinessId = businessId || item.business_id
    if (!resolvedBusinessId) {
      throw new Error('business_id es obligatorio para registrar un movimiento de inventario.')
    }

    const previousStock = item.stock_quantity ?? 0
    const newStock = previousStock + qty

    if (newStock < 0) {
      throw new Error(
        `Stock insuficiente. Stock actual: ${previousStock}, movimiento solicitado: ${qty}.`
      )
    }

    const { error: updateError } = await supabase
      .from('inventory')
      .update({ stock_quantity: newStock })
      .eq('id', inventoryItemId)
      .eq('business_id', resolvedBusinessId)

    if (updateError) {
      throw new Error(`Error al actualizar stock: ${updateError.message}`)
    }

    const { data: movement, error: movementError } = await supabase
      .from('inventory_movements')
      .insert({
        inventory_item_id: inventoryItemId,
        movement_type:     movementType,
        quantity:          qty,
        previous_stock:    previousStock,
        new_stock:         newStock,
        reference_type:    referenceType ?? null,
        reference_id:      referenceId   ?? null,
        note:              note          ?? null,
        business_id:       resolvedBusinessId,
        created_by:        userId        ?? null,
        // Extras de contexto financiero (todos opcionales en DB)
        unit_cost:         extras?.unit_cost    ?? null,
        currency:          extras?.currency     ?? 'ARS',
        exchange_rate:     extras?.exchange_rate ?? null,
        supplier_id:       extras?.supplier_id  ?? null,
        variant_id:        extras?.variant_id   ?? null,
      })
      .select()
      .single()

    if (movementError || !movement) {
      // Stock ya fue actualizado pero el registro falló: revertir el update
      await supabase
        .from('inventory')
        .update({ stock_quantity: previousStock })
        .eq('id', inventoryItemId)
        .eq('business_id', resolvedBusinessId)

      throw new Error(`Error al registrar movimiento de inventario: ${movementError?.message ?? 'Sin datos'}`)
    }

    return movement
  },

  async getMovementsByItem(inventoryItemId: string): Promise<InventoryMovement[]> {
    const { data, error } = await supabase
      .from('inventory_movements')
      .select('*')
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
      .select('*')
      .eq('reference_type', referenceType)
      .eq('reference_id', referenceId)
      .order('created_at', { ascending: false })

    if (error) throw new Error('Error al obtener movimientos por referencia.')
    return data || []
  },

  async revertMovement(movementId: string): Promise<void> {
    const { data: movement, error } = await supabase
      .from('inventory_movements')
      .select('*')
      .eq('id', movementId)
      .single()

    if (error || !movement) throw new Error('Movimiento no encontrado.')

    const inverseQty: number = -movement.quantity
    const inverseType: MovementType =
      movement.movement_type === 'sale'     ? 'return'
      : movement.movement_type === 'purchase' ? 'cancellation'
      : 'adjustment'

    await this.registerMovement(
      movement.inventory_item_id,
      inverseType,
      inverseQty,
      'manual',
      undefined,
      `Reverso de movimiento ${movementId}`,
      movement.business_id,
      movement.created_by
    )
  },
}
