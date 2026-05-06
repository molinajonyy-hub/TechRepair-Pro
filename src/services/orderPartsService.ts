import { supabase } from '../lib/supabase';

export interface OrderPart {
  id: string;
  order_id: string;
  business_id: string;
  name: string;
  description?: string;
  part_number?: string;
  internal_cost: number;
  sale_price: number;
  quantity: number;
  margin_amount: number;
  margin_percentage: number;
  status: 'pending' | 'used' | 'sold' | 'returned';
  deduct_from_inventory: boolean;
  notes?: string;
  added_at: string;
  created_by?: string;
  inventory_item_id?: string;  // referencia al producto del inventario (si aplica)
}

// ─── Servicio atómico para agregar repuestos a órdenes ────────────────────────
// Flujo garantizado:
//   1. Validar stock disponible
//   2. Insertar en order_parts (tracking financiero)
//   3. Insertar en order_items (tracking de trabajo — trigger deduce stock)
//   Si falla cualquier paso: rollback del paso anterior

export const orderPartsService = {

  async addPartToOrder(params: {
    orderId:           string;
    businessId:        string;
    userId:            string;
    name:              string;
    inventoryItemId?:  string;   // null = repuesto sin vinculo inventario
    quantity:          number;
    unitCost:          number;
    salePrice:         number;
    description?:      string;
    partNumber?:       string;
    notes?:            string;
  }): Promise<OrderPart> {
    const {
      orderId, businessId, userId, name,
      inventoryItemId, quantity, unitCost, salePrice,
      description, partNumber, notes,
    } = params;

    if (quantity <= 0) throw new Error('La cantidad debe ser mayor a 0');
    if (salePrice < 0) throw new Error('El precio de venta no puede ser negativo');

    // ── 1. Validar stock disponible (si tiene vínculo inventario) ──
    if (inventoryItemId) {
      const { data: inv } = await supabase
        .from('inventory')
        .select('stock_quantity, name')
        .eq('id', inventoryItemId)
        .single();

      if (!inv) throw new Error('Producto no encontrado en inventario');
      if ((inv.stock_quantity || 0) < quantity) {
        throw new Error(
          `Stock insuficiente para "${inv.name}". Disponible: ${inv.stock_quantity}, solicitado: ${quantity}`
        );
      }
    }

    const margenAmt = (salePrice - unitCost) * quantity;
    const margenPct = unitCost > 0 ? ((salePrice - unitCost) / unitCost) * 100 : 0;

    // ── 2. Insertar en order_parts (registro financiero) ──
    const { data: part, error: partErr } = await supabase
      .from('order_parts')
      .insert({
        order_id:              orderId,
        business_id:           businessId,
        name,
        description:           description || null,
        part_number:           partNumber  || null,
        internal_cost:         unitCost,
        sale_price:            salePrice,
        quantity,
        margin_amount:         margenAmt,
        margin_percentage:     margenPct,
        status:                'used',
        deduct_from_inventory: !!inventoryItemId,
        notes:                 notes || null,
        created_by:            userId,
      })
      .select()
      .single();

    if (partErr || !part) {
      throw new Error('Error al registrar repuesto en la orden: ' + (partErr?.message ?? 'sin datos'));
    }

    // ── 3. Insertar en order_items y deducir stock via trigger ──
    // El trigger trg_adjust_stock_on_order_item se encarga de:
    //   a) Actualizar inventory.stock_quantity
    //   b) Insertar en inventory_movements
    if (inventoryItemId) {
      const { error: itemErr } = await supabase
        .from('order_items')
        .insert({
          order_id:              orderId,
          product_id:            inventoryItemId,
          business_id:           businessId,
          tipo:                  'repuesto',
          descripcion:           name,
          cantidad:              quantity,
          precio_unitario:       salePrice,
          costo_unitario:        unitCost,
          cliente_paga_repuesto: true,
          created_by:            userId,
        });

      if (itemErr) {
        // Rollback: eliminar el order_parts recién creado
        await supabase.from('order_parts').delete().eq('id', part.id);
        throw new Error('Error al registrar ítem en la orden: ' + itemErr.message);
      }
    }

    return part as OrderPart;
  },

  async removePartFromOrder(params: {
    partId:    string;
    orderId:   string;
    businessId: string;
  }): Promise<void> {
    const { partId, orderId, businessId } = params;

    // Obtener datos del part antes de eliminar
    const { data: part } = await supabase
      .from('order_parts')
      .select('*')
      .eq('id', partId)
      .eq('order_id', orderId)
      .single();

    if (!part) throw new Error('Repuesto no encontrado');

    // Eliminar de order_parts
    const { error } = await supabase
      .from('order_parts')
      .delete()
      .eq('id', partId);
    if (error) throw new Error('Error al eliminar repuesto: ' + error.message);

    // Si había un order_item asociado, eliminarlo también
    // (el trigger de order_items restaura el stock automáticamente)
    if (part.deduct_from_inventory) {
      await supabase
        .from('order_items')
        .delete()
        .eq('order_id', orderId)
        .eq('business_id', businessId)
        .eq('tipo', 'repuesto')
        .eq('descripcion', part.name);
    }
  },

  async getPartsByOrder(orderId: string): Promise<OrderPart[]> {
    const { data, error } = await supabase
      .from('order_parts')
      .select('*')
      .eq('order_id', orderId)
      .order('added_at', { ascending: true });

    if (error) throw new Error('Error al cargar repuestos: ' + error.message);
    return (data || []) as OrderPart[];
  },
};
