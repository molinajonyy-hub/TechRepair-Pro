import { supabase } from '../lib/supabase';
import { inventoryService } from './inventoryService';

export interface InventoryReport {
  lowStockItems: any[];
  outOfStockItems: any[];
  totalValue: number;
  mostUsedInOrders: any[];
  mostSoldProducts: any[];
  topSuppliers: any[];
  recentPurchases: any[];
  recentSales: any[];
}

const getSingleRelation = <T>(relation: T | T[] | null | undefined): T | null => {
  if (Array.isArray(relation)) {
    return relation[0] || null;
  }

  return relation || null;
};

export const inventoryReportsService = {
  async getFullReport(businessId?: string): Promise<InventoryReport> {
    const [
      lowStockItems,
      outOfStockItems,
      mostUsedInOrders,
      mostSoldProducts,
      topSuppliers,
      recentPurchases,
      recentSales
    ] = await Promise.all([
      inventoryService.getLowStockItems(businessId),
      inventoryService.getOutOfStockItems(businessId),
      this.getMostUsedInOrders(businessId),
      this.getMostSoldProducts(businessId),
      this.getTopSuppliers(businessId),
      this.getRecentPurchases(businessId),
      this.getRecentSales(businessId)
    ]);

    const totalValue = await this.calculateTotalValue(businessId);

    return {
      lowStockItems,
      outOfStockItems,
      totalValue,
      mostUsedInOrders,
      mostSoldProducts,
      topSuppliers,
      recentPurchases,
      recentSales
    };
  },

  async calculateTotalValue(businessId?: string): Promise<number> {
    let query = supabase
      .from('inventory')
      .select('stock_quantity, cost_price')
      .eq('is_active', true);

    if (businessId) {
      query = query.eq('business_id', businessId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error('Error al calcular valor del inventario');
    }

    return data?.reduce((sum, item) => sum + (item.stock_quantity * (item.cost_price || 0)), 0) || 0;
  },

  async getMostUsedInOrders(businessId?: string, limit: number = 10): Promise<any[]> {
    let query = supabase
      .from('inventory_movements')
      .select(`
        inventory_item_id,
        inventory:inventory(name, code),
        quantity
      `)
      .eq('movement_type', 'order_usage')
      .order('created_at', { ascending: false })
      .limit(100);

    if (businessId) {
      query = query.eq('business_id', businessId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error('Error al obtener productos más usados');
    }

    const grouped = data?.reduce((acc: any, movement) => {
      const itemId = movement.inventory_item_id;
      const inventory = getSingleRelation<{ name?: string; code?: string }>(movement.inventory);

      if (!acc[itemId]) {
        acc[itemId] = {
          inventory_item_id: itemId,
          name: inventory?.name,
          code: inventory?.code,
          total_quantity: 0
        };
      }
      acc[itemId].total_quantity += Math.abs(movement.quantity);
      return acc;
    }, {});

    return Object.values(grouped || {})
      .sort((a: any, b: any) => b.total_quantity - a.total_quantity)
      .slice(0, limit);
  },

  async getMostSoldProducts(businessId?: string, limit: number = 10): Promise<any[]> {
    let query = supabase
      .from('inventory_movements')
      .select(`
        inventory_item_id,
        inventory:inventory(name, code),
        quantity
      `)
      .eq('movement_type', 'sale')
      .order('created_at', { ascending: false })
      .limit(100);

    if (businessId) {
      query = query.eq('business_id', businessId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error('Error al obtener productos más vendidos');
    }

    const grouped = data?.reduce((acc: any, movement) => {
      const itemId = movement.inventory_item_id;
      const inventory = getSingleRelation<{ name?: string; code?: string }>(movement.inventory);

      if (!acc[itemId]) {
        acc[itemId] = {
          inventory_item_id: itemId,
          name: inventory?.name,
          code: inventory?.code,
          total_quantity: 0
        };
      }
      acc[itemId].total_quantity += Math.abs(movement.quantity);
      return acc;
    }, {});

    return Object.values(grouped || {})
      .sort((a: any, b: any) => b.total_quantity - a.total_quantity)
      .slice(0, limit);
  },

  async getTopSuppliers(businessId?: string, limit: number = 10): Promise<any[]> {
    let query = supabase
      .from('purchases')
      .select(`
        supplier_id,
        supplier:suppliers(name),
        total
      `)
      .eq('status', 'confirmed')
      .order('created_at', { ascending: false })
      .limit(100);

    if (businessId) {
      query = query.eq('business_id', businessId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error('Error al obtener proveedores más utilizados');
    }

    const grouped = data?.reduce((acc: any, purchase) => {
      const supplierId = purchase.supplier_id;
      const supplier = getSingleRelation<{ name?: string }>(purchase.supplier);

      if (!acc[supplierId]) {
        acc[supplierId] = {
          supplier_id: supplierId,
          name: supplier?.name || 'Sin proveedor',
          total_amount: 0
        };
      }
      acc[supplierId].total_amount += purchase.total;
      return acc;
    }, {});

    return Object.values(grouped || {})
      .sort((a: any, b: any) => b.total_amount - a.total_amount)
      .slice(0, limit);
  },

  async getRecentPurchases(businessId?: string, limit: number = 10): Promise<any[]> {
    let query = supabase
      .from('purchases')
      .select(`
        *,
        supplier:suppliers(name)
      `)
      .order('purchase_date', { ascending: false })
      .limit(limit);

    if (businessId) {
      query = query.eq('business_id', businessId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error('Error al obtener compras recientes');
    }

    return data || [];
  },

  async getRecentSales(businessId?: string, limit: number = 10): Promise<any[]> {
    let query = supabase
      .from('inventory_movements')
      .select(`
        *,
        inventory:inventory(name, code)
      `)
      .eq('movement_type', 'sale')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (businessId) {
      query = query.eq('business_id', businessId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error('Error al obtener ventas recientes');
    }

    return data || [];
  },

  async getItemMovementHistory(inventoryItemId: string): Promise<any[]> {
    const { data, error } = await supabase
      .from('inventory_movements')
      .select('*')
      .eq('inventory_item_id', inventoryItemId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error('Error al obtener historial de movimientos');
    }

    return data || [];
  },

  async getMovementsByReference(referenceType: string, referenceId: string): Promise<any[]> {
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
};
