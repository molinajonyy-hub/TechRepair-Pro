import { supabase } from '../lib/supabase';
import { inventoryMovementsService, MovementType } from './inventoryMovementsService';

export interface InventoryItem {
  id: string;
  code: string;
  name: string;
  description?: string;
  category: string;
  stock_quantity: number;
  reserved_quantity: number;
  min_stock: number;
  cost_price: number;
  sale_price: number;
  location?: string;
  is_active: boolean;
  business_id?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  // Multicurrency fields
  cost_price_usd?: number;
  base_currency?: string;
  base_price?: number;
  exchange_rate_used?: number;
  auto_update_price?: boolean;
}

export const inventoryService = {
  async increaseStockFromPurchase(
    inventoryItemId: string,
    quantity: number,
    purchaseId: string,
    businessId: string,
    userId: string
  ): Promise<void> {
    if (quantity <= 0) {
      throw new Error('La cantidad debe ser mayor a 0');
    }

    await inventoryMovementsService.registerMovement(
      inventoryItemId,
      'purchase',
      quantity,
      'purchase',
      purchaseId,
      'Ingreso desde compra a proveedor',
      businessId,
      userId
    );
  },

  async decreaseStockFromSale(
    inventoryItemId: string,
    quantity: number,
    comprobanteId: string,
    businessId: string,
    userId: string
  ): Promise<void> {
    if (quantity <= 0) {
      throw new Error('La cantidad debe ser mayor a 0');
    }

    await inventoryMovementsService.registerMovement(
      inventoryItemId,
      'sale',
      -quantity,
      'comprobante',
      comprobanteId,
      'Salida por venta',
      businessId,
      userId
    );
  },

  async decreaseStockFromOrder(
    inventoryItemId: string,
    quantity: number,
    orderId: string,
    businessId: string,
    userId: string
  ): Promise<void> {
    if (quantity <= 0) {
      throw new Error('La cantidad debe ser mayor a 0');
    }

    await inventoryMovementsService.registerMovement(
      inventoryItemId,
      'order_usage',
      -quantity,
      'order',
      orderId,
      'Uso en orden de servicio',
      businessId,
      userId
    );
  },

  async restoreStockFromOrderRemoval(
    inventoryItemId: string,
    quantity: number,
    orderId: string,
    businessId: string,
    userId: string
  ): Promise<void> {
    if (quantity <= 0) {
      throw new Error('La cantidad debe ser mayor a 0');
    }

    await inventoryMovementsService.registerMovement(
      inventoryItemId,
      'return',
      quantity,
      'order',
      orderId,
      'Devolución por eliminación de repuesto en orden',
      businessId,
      userId
    );
  },

  async restoreStockFromCancelledSale(
    inventoryItemId: string,
    quantity: number,
    comprobanteId: string,
    businessId: string,
    userId: string
  ): Promise<void> {
    if (quantity <= 0) {
      throw new Error('La cantidad debe ser mayor a 0');
    }

    await inventoryMovementsService.registerMovement(
      inventoryItemId,
      'cancellation',
      quantity,
      'comprobante',
      comprobanteId,
      'Devolución por anulación de venta',
      businessId,
      userId
    );
  },

  async applyCreditNoteStock(
    inventoryItemId: string,
    quantity: number,
    comprobanteId: string,
    businessId: string,
    userId: string
  ): Promise<void> {
    if (quantity <= 0) {
      throw new Error('La cantidad debe ser mayor a 0');
    }

    await inventoryMovementsService.registerMovement(
      inventoryItemId,
      'credit_note',
      quantity,
      'credit_note',
      comprobanteId,
      'Devolución por nota de crédito',
      businessId,
      userId
    );
  },

  async manualAdjustment(
    inventoryItemId: string,
    quantity: number,
    note: string,
    businessId: string,
    userId: string
  ): Promise<void> {
    const movementType: MovementType = quantity > 0 ? 'in' : 'out';

    await inventoryMovementsService.registerMovement(
      inventoryItemId,
      movementType,
      quantity,
      'manual',
      undefined,
      note || 'Ajuste manual',
      businessId,
      userId
    );
  },

  async getItemById(inventoryItemId: string, businessId?: string): Promise<InventoryItem | null> {
    let query = supabase
      .from('inventory')
      .select('*')
      .eq('id', inventoryItemId);

    if (businessId) {
      query = query.eq('business_id', businessId);
    }

    const { data, error } = await query.single();

    if (error) {
      throw new Error('Error al obtener item de inventario');
    }

    return data;
  },

  async searchItems(query: string, businessId?: string): Promise<InventoryItem[]> {
    let request = supabase
      .from('inventory')
      .select('*')
      .eq('is_active', true)
      .or(`name.ilike.%${query}%,code.ilike.%${query}%,description.ilike.%${query}%,category.ilike.%${query}%`)
      .order('name');

    if (businessId) {
      request = request.eq('business_id', businessId);
    }

    const { data, error } = await request;

    if (error) {
      throw new Error('Error al buscar items');
    }

    return data || [];
  },

  async getLowStockItems(businessId?: string): Promise<InventoryItem[]> {
    let request = supabase
      .from('inventory')
      .select('*')
      .eq('is_active', true)
      .order('stock_quantity');

    if (businessId) {
      request = request.eq('business_id', businessId);
    }

    const { data, error } = await request;

    if (error) {
      throw new Error('Error al obtener items con stock bajo');
    }

    return (data || []).filter((item) => item.stock_quantity > 0 && item.stock_quantity <= item.min_stock);
  },

  async getOutOfStockItems(businessId?: string): Promise<InventoryItem[]> {
    let request = supabase
      .from('inventory')
      .select('*')
      .eq('is_active', true)
      .eq('stock_quantity', 0)
      .order('name');

    if (businessId) {
      request = request.eq('business_id', businessId);
    }

    const { data, error } = await request;

    if (error) {
      throw new Error('Error al obtener items sin stock');
    }

    return data || [];
  },

  async checkAvailability(inventoryItemId: string, quantity: number, businessId?: string): Promise<boolean> {
    const item = await this.getItemById(inventoryItemId, businessId);
    if (!item) {
      return false;
    }

    return item.stock_quantity >= quantity;
  },
};
