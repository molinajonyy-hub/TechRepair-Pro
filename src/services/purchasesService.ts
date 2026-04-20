import { supabase } from '../lib/supabase';
import { inventoryService } from './inventoryService';

export interface PurchaseItem {
  id: string;
  purchase_id: string;
  inventory_item_id?: string;
  description: string;
  quantity: number;
  unit_cost: number;
  subtotal: number;
  created_at: string;
}

export interface Purchase {
  id: string;
  supplier_id?: string;
  invoice_number?: string;
  purchase_date: string;
  subtotal: number;
  taxes: number;
  total: number;
  notes?: string;
  status: string;
  business_id: string;
  created_by?: string;
  created_at: string;
  items?: PurchaseItem[];
}

export const purchasesService = {
  /**
   * Obtener todas las compras
   */
  async getAllPurchases(businessId: string): Promise<Purchase[]> {
    const { data, error } = await supabase
      .from('purchases')
      .select(`
        *,
        items:purchase_items(*)
      `)
      .eq('business_id', businessId)
      .order('purchase_date', { ascending: false });

    if (error) {
      throw new Error('Error al obtener compras');
    }

    return data || [];
  },

  /**
   * Obtener compras por estado
   */
  async getPurchasesByStatus(status: string, businessId: string): Promise<Purchase[]> {
    const { data, error } = await supabase
      .from('purchases')
      .select(`
        *,
        items:purchase_items(*)
      `)
      .eq('business_id', businessId)
      .eq('status', status)
      .order('purchase_date', { ascending: false });

    if (error) {
      throw new Error('Error al obtener compras');
    }

    return data || [];
  },

  /**
   * Obtener compra por ID
   */
  async getPurchaseById(purchaseId: string, businessId: string): Promise<Purchase | null> {
    const { data, error } = await supabase
      .from('purchases')
      .select(`
        *,
        items:purchase_items(*),
        supplier:suppliers(*)
      `)
      .eq('id', purchaseId)
      .eq('business_id', businessId)
      .single();

    if (error) {
      throw new Error('Error al obtener compra');
    }

    return data;
  },

  /**
   * Crear nueva compra
   */
  async createPurchase(
    purchase: Omit<Purchase, 'id' | 'created_at' | 'items'>,
    items: Omit<PurchaseItem, 'id' | 'purchase_id' | 'created_at'>[],
    businessId: string,
    userId: string
  ): Promise<Purchase> {
    // Calcular totales
    const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_cost), 0);
    const taxes = subtotal * 0.21; // 21% IVA
    const total = subtotal + taxes;

    const purchaseData = {
      ...purchase,
      business_id: businessId,
      created_by: userId,
      subtotal,
      taxes,
      total,
    };

    // Crear compra
    const { data: purchaseResult, error: purchaseError } = await supabase
      .from('purchases')
      .insert(purchaseData)
      .select()
      .single();

    if (purchaseError || !purchaseResult) {
      throw new Error('Error al crear compra');
    }

    // Crear items de compra
    const purchaseItems = items.map(item => ({
      ...item,
      purchase_id: purchaseResult.id,
      subtotal: item.quantity * item.unit_cost,
    }));

    const { error: itemsError } = await supabase
      .from('purchase_items')
      .insert(purchaseItems);

    if (itemsError) {
      throw new Error('Error al crear items de compra');
    }

    return purchaseResult;
  },

  /**
   * Confirmar compra (ingresar stock)
   */
  async confirmPurchase(purchaseId: string, businessId: string, userId: string): Promise<void> {
    const purchase = await this.getPurchaseById(purchaseId, businessId);
    if (!purchase) {
      throw new Error('Compra no encontrada');
    }

    if (purchase.status === 'confirmed') {
      throw new Error('La compra ya está confirmada');
    }

    // Actualizar estado de compra
    const { error: updateError } = await supabase
      .from('purchases')
      .update({ status: 'confirmed' })
      .eq('id', purchaseId)
      .eq('business_id', businessId);

    if (updateError) {
      throw new Error('Error al confirmar compra');
    }

    // Ingresar stock para cada item
    if (purchase.items) {
      for (const item of purchase.items) {
        if (item.inventory_item_id) {
          await inventoryService.increaseStockFromPurchase(
            item.inventory_item_id,
            item.quantity,
            purchaseId,
            businessId,
            userId
          );
        }
      }
    }
  },

  /**
   * Cancelar compra
   */
  async cancelPurchase(purchaseId: string, businessId: string, userId: string): Promise<void> {
    const purchase = await this.getPurchaseById(purchaseId, businessId);
    if (!purchase) {
      throw new Error('Compra no encontrada');
    }

    if (purchase.status === 'cancelled') {
      throw new Error('La compra ya está cancelada');
    }

    if (purchase.status === 'confirmed') {
      // Si ya está confirmada, revertir stock
      if (purchase.items) {
        for (const item of purchase.items) {
          if (item.inventory_item_id) {
            await inventoryService.manualAdjustment(
              item.inventory_item_id,
              -item.quantity,
              `Cancelación de compra ${purchase.invoice_number || purchase.id}`,
              businessId,
              userId
            );
          }
        }
      }
    }

    // Actualizar estado de compra
    const { error: updateError } = await supabase
      .from('purchases')
      .update({ status: 'cancelled' })
      .eq('id', purchaseId)
      .eq('business_id', businessId);

    if (updateError) {
      throw new Error('Error al cancelar compra');
    }
  },

  /**
   * Obtener compras por proveedor
   */
  async getPurchasesBySupplier(supplierId: string, businessId: string): Promise<Purchase[]> {
    const { data, error } = await supabase
      .from('purchases')
      .select(`
        *,
        items:purchase_items(*)
      `)
      .eq('business_id', businessId)
      .eq('supplier_id', supplierId)
      .order('purchase_date', { ascending: false });

    if (error) {
      throw new Error('Error al obtener compras del proveedor');
    }

    return data || [];
  },
};
