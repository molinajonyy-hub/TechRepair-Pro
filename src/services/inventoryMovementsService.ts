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
  id: string;
  inventory_item_id: string;
  movement_type: MovementType;
  quantity: number;
  previous_stock: number;
  new_stock: number;
  reference_type?: ReferenceType;
  reference_id?: string;
  note?: string;
  business_id?: string;
  created_at: string;
  created_by?: string;
}

export const inventoryMovementsService = {
  async registerMovement(
    inventoryItemId: string,
    movementType: MovementType,
    quantity: number,
    referenceType?: ReferenceType,
    referenceId?: string,
    note?: string,
    businessId?: string,
    userId?: string
  ): Promise<InventoryMovement> {
    let itemQuery = supabase
      .from('inventory')
      .select('stock_quantity, business_id')
      .eq('id', inventoryItemId);

    if (businessId) {
      itemQuery = itemQuery.eq('business_id', businessId);
    }

    const { data: item, error: itemError } = await itemQuery.single();

    if (itemError || !item) {
      throw new Error('Error al obtener item de inventario');
    }

    const previousStock = item.stock_quantity || 0;
    const newStock = previousStock + quantity;

    if (newStock < 0) {
      throw new Error(`Stock insuficiente. Stock actual: ${previousStock}, intento: ${quantity}`);
    }

    let updateQuery = supabase
      .from('inventory')
      .update({ stock_quantity: newStock })
      .eq('id', inventoryItemId);

    if (businessId) {
      updateQuery = updateQuery.eq('business_id', businessId);
    }

    const { error: updateError } = await updateQuery;

    if (updateError) {
      throw new Error('Error al actualizar stock');
    }

    const { data: movement, error: movementError } = await supabase
      .from('inventory_movements')
      .insert({
        inventory_item_id: inventoryItemId,
        movement_type: movementType,
        quantity,
        previous_stock: previousStock,
        new_stock: newStock,
        reference_type: referenceType,
        reference_id: referenceId,
        note: note,
        business_id: businessId || item.business_id || null,
        created_by: userId,
      })
      .select()
      .single();

    if (movementError || !movement) {
      throw new Error('Error al registrar movimiento');
    }

    return movement;
  },

  async getMovementsByItem(inventoryItemId: string): Promise<InventoryMovement[]> {
    const { data, error } = await supabase
      .from('inventory_movements')
      .select('*')
      .eq('inventory_item_id', inventoryItemId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error('Error al obtener movimientos');
    }

    return data || [];
  },

  async getMovementsByReference(
    referenceType: ReferenceType,
    referenceId: string
  ): Promise<InventoryMovement[]> {
    const { data, error } = await supabase
      .from('inventory_movements')
      .select('*')
      .eq('reference_type', referenceType)
      .eq('reference_id', referenceId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error('Error al obtener movimientos por referencia');
    }

    return data || [];
  },

  async revertMovement(movementId: string): Promise<void> {
    const { data: movement, error } = await supabase
      .from('inventory_movements')
      .select('*')
      .eq('id', movementId)
      .single();

    if (error || !movement) {
      throw new Error('Movimiento no encontrado');
    }

    const inverseQuantity = -movement.quantity;
    const inverseType: MovementType = movement.movement_type === 'sale'
      ? 'return'
      : movement.movement_type === 'purchase'
      ? 'cancellation'
      : 'adjustment';

    await this.registerMovement(
      movement.inventory_item_id,
      inverseType,
      inverseQuantity,
      'manual',
      undefined,
      `Reverso de movimiento ${movementId}`,
      movement.business_id,
      movement.created_by
    );
  },
};
