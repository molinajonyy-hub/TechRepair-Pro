import { supabase } from '../lib/supabase';
import { INVENTORY_OPERATIONAL_COLUMNS } from './inventoryCostAccess'

export interface InventoryItem {
  id: string;
  code: string;
  name: string;
  description?: string;
  category: string;
  stock_quantity: number;
  reserved_quantity: number;
  min_stock: number;
  /** SEC-08B: puede faltar. Ausente = RESTRINGIDO o sin cargar, nunca 0. */
  cost_price?: number | null;
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

/**
 * Lecturas de inventario.
 *
 * G2-C.3A2: los helpers mutadores legacy (increaseStockFromPurchase,
 * decreaseStockFromSale, decreaseStockFromOrder, restoreStockFromOrderRemoval,
 * restoreStockFromCancelledSale, applyCreditNoteStock, manualAdjustment) se
 * eliminaron: no tenían callers vivos y todos pasaban por el writer inseguro
 * del navegador. Los documentos mueven stock con sus writers server-side
 * (W1-W7); el stock no documental, con la RPC canónica
 * (inventoryStockAdjustmentService).
 */
export const inventoryService = {
  async getItemById(inventoryItemId: string, businessId?: string): Promise<InventoryItem | null> {
    let query = supabase
      .from('inventory')
      .select(INVENTORY_OPERATIONAL_COLUMNS)
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
      .select(INVENTORY_OPERATIONAL_COLUMNS)
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
      .select(INVENTORY_OPERATIONAL_COLUMNS)
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
      .select(INVENTORY_OPERATIONAL_COLUMNS)
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
