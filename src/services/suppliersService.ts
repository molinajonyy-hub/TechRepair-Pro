import { supabase } from '../lib/supabase';
import { inventoryService } from './inventoryService';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Supplier {
  id: string;
  business_id: string;
  name: string;
  business_name?: string;
  tax_id?: string;
  fiscal_condition?: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  address?: string;
  city?: string;
  province?: string;
  country?: string;
  category?: string;
  contact_name?: string;
  delivery_days?: string;
  payment_method_preferred?: string;
  bank_alias?: string;
  bank_cbu?: string;
  website?: string;
  internal_notes?: string;
  notes?: string;
  active: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface SupplierWithStats extends Supplier {
  total_purchases: number;
  total_paid: number;
  pending_amount: number;
  purchases_count: number;
  last_purchase_date: string | null;
}

export interface SupplierPurchase {
  id: string;
  business_id: string;
  supplier_id: string;
  purchase_date: string;
  invoice_number?: string;
  total_amount: number;
  paid_amount: number;
  pending_amount: number;
  payment_status: 'pending' | 'partial' | 'paid';
  payment_method?: string;
  notes?: string;
  attachment_url?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  items?: SupplierPurchaseItem[];
}

export interface SupplierPurchaseItem {
  id: string;
  business_id: string;
  purchase_id: string;
  supplier_id?: string;
  inventory_id?: string | null;
  product_name: string;
  quantity: number;
  unit_cost: number;
  subtotal: number;
  created_at: string;
}

export interface SupplierPayment {
  id: string;
  business_id: string;
  supplier_id: string;
  purchase_id?: string | null;
  payment_date: string;
  amount: number;
  payment_method: string;
  notes?: string;
  created_by?: string;
  created_at: string;
}

export interface AccountMovement {
  id: string;
  business_id: string;
  supplier_id: string;
  purchase_id?: string | null;
  payment_id?: string | null;
  movement_date: string;
  type: 'purchase' | 'payment' | 'adjustment' | 'credit_note';
  description: string;
  debit: number;
  credit: number;
  balance_after: number;
  created_at: string;
}

export interface CreatePurchaseInput {
  supplier_id: string;
  purchase_date: string;
  invoice_number?: string;
  total_amount: number;
  paid_amount: number;
  payment_method?: string;
  notes?: string;
  items: {
    inventory_id?: string | null;
    product_name: string;
    quantity: number;
    unit_cost: number;
  }[];
}

export interface CreatePaymentInput {
  supplier_id: string;
  purchase_id?: string | null;
  payment_date: string;
  amount: number;
  payment_method: string;
  notes?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcPaymentStatus(total: number, paid: number): 'pending' | 'partial' | 'paid' {
  if (paid <= 0) return 'pending';
  if (paid >= total - 0.01) return 'paid';
  return 'partial';
}

function computeRunningBalance(movements: AccountMovement[]): AccountMovement[] {
  let balance = 0;
  return movements.map(m => {
    balance = balance + m.debit - m.credit;
    return { ...m, balance_after: balance };
  });
}

// ─── Service ─────────────────────────────────────────────────────────────────

export const suppliersService = {

  // ── Listado con estadísticas ────────────────────────────────────────────────

  async getSuppliersWithStats(businessId: string): Promise<SupplierWithStats[]> {
    const { data, error } = await supabase
      .from('suppliers')
      .select(`*, supplier_purchases(total_amount, paid_amount, pending_amount, purchase_date)`)
      .eq('business_id', businessId)
      .order('name');

    if (error) throw new Error(error.message);

    return (data || []).map((s: any) => {
      const purchases: any[] = s.supplier_purchases || [];
      const total_purchases = purchases.reduce((sum: number, p: any) => sum + (p.total_amount || 0), 0);
      const total_paid = purchases.reduce((sum: number, p: any) => sum + (p.paid_amount || 0), 0);
      const pending_amount = purchases.reduce((sum: number, p: any) => sum + (p.pending_amount || 0), 0);
      const sorted = [...purchases].sort((a: any, b: any) => b.purchase_date > a.purchase_date ? 1 : -1);
      return {
        ...s,
        supplier_purchases: undefined,
        total_purchases,
        total_paid,
        pending_amount,
        purchases_count: purchases.length,
        last_purchase_date: sorted[0]?.purchase_date || null,
      };
    });
  },

  // ── CRUD proveedores ────────────────────────────────────────────────────────

  async getAllSuppliers(businessId: string): Promise<Supplier[]> {
    const { data, error } = await supabase
      .from('suppliers').select('*').eq('business_id', businessId).order('name');
    if (error) throw new Error(error.message);
    return data || [];
  },

  async getActiveSuppliers(businessId: string): Promise<Supplier[]> {
    const { data, error } = await supabase
      .from('suppliers').select('*').eq('business_id', businessId).eq('active', true).order('name');
    if (error) throw new Error(error.message);
    return data || [];
  },

  async getSupplierById(id: string, businessId: string): Promise<Supplier | null> {
    const { data } = await supabase.from('suppliers').select('*').eq('id', id).eq('business_id', businessId).single();
    return data;
  },

  async createSupplier(
    supplier: Omit<Supplier, 'id' | 'created_at' | 'updated_at'>,
    businessId: string,
    userId: string
  ): Promise<Supplier> {
    const { data, error } = await supabase
      .from('suppliers')
      .insert({ ...supplier, business_id: businessId, created_by: userId })
      .select().single();
    if (error || !data) throw new Error(error?.message || 'Error al crear proveedor');
    return data;
  },

  async updateSupplier(id: string, updates: Partial<Supplier>, businessId: string): Promise<Supplier> {
    const { data, error } = await supabase
      .from('suppliers')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id).eq('business_id', businessId)
      .select().single();
    if (error || !data) throw new Error(error?.message || 'Error al actualizar');
    return data;
  },

  async toggleActive(id: string, businessId: string, active: boolean): Promise<void> {
    const { error } = await supabase
      .from('suppliers').update({ active, updated_at: new Date().toISOString() })
      .eq('id', id).eq('business_id', businessId);
    if (error) throw new Error(error.message);
  },

  async deleteSupplier(id: string, businessId: string): Promise<void> {
    const { error } = await supabase.from('suppliers').delete().eq('id', id).eq('business_id', businessId);
    if (error) throw new Error(error.message);
  },

  // ── Compras ─────────────────────────────────────────────────────────────────

  async getPurchases(supplierId: string, businessId: string): Promise<SupplierPurchase[]> {
    const { data, error } = await supabase
      .from('supplier_purchases')
      .select('*, items:supplier_purchase_items(*)')
      .eq('supplier_id', supplierId)
      .eq('business_id', businessId)
      .order('purchase_date', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []) as SupplierPurchase[];
  },

  async getPurchaseWithItems(purchaseId: string, businessId: string): Promise<SupplierPurchase | null> {
    const { data } = await supabase
      .from('supplier_purchases')
      .select('*, items:supplier_purchase_items(*)')
      .eq('id', purchaseId).eq('business_id', businessId).single();
    return data as SupplierPurchase | null;
  },

  async createPurchase(input: CreatePurchaseInput, businessId: string, userId: string, supplierName: string): Promise<SupplierPurchase> {
    const { supplier_id, purchase_date, invoice_number, total_amount, paid_amount, payment_method, notes, items } = input;
    const pending_amount = Math.max(0, total_amount - paid_amount);
    const payment_status = calcPaymentStatus(total_amount, paid_amount);

    // 1. Crear compra
    const { data: purchase, error: purchaseErr } = await supabase
      .from('supplier_purchases')
      .insert({ business_id: businessId, supplier_id, purchase_date, invoice_number: invoice_number || null, total_amount, paid_amount, pending_amount, payment_status, payment_method: payment_method || null, notes: notes || null, created_by: userId })
      .select().single();
    if (purchaseErr || !purchase) throw new Error(purchaseErr?.message || 'Error al crear compra');

    // 2. Insertar ítems y actualizar stock
    if (items.length > 0) {
      const itemsRows = items.map(item => ({
        business_id: businessId, purchase_id: purchase.id, supplier_id,
        inventory_id: item.inventory_id || null,
        product_name: item.product_name,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
        subtotal: item.quantity * item.unit_cost,
      }));
      await supabase.from('supplier_purchase_items').insert(itemsRows);

      for (const item of items) {
        if (!item.inventory_id) continue;
        await inventoryService.increaseStockFromPurchase(
          item.inventory_id, item.quantity, purchase.id, businessId, userId
        );
        await supabase.from('inventory').update({
          cost_price: item.unit_cost,
          updated_at: new Date().toISOString(),
        }).eq('id', item.inventory_id);
      }
    }

    // 3. Movimiento cuenta corriente (débito = compra)
    await this._addAccountMovement(businessId, supplier_id, purchase.id, null, purchase_date, 'purchase', `Compra${invoice_number ? ' #' + invoice_number : ''}`, total_amount, 0);

    // 4. Si hay pago inicial
    if (paid_amount > 0) {
      await this._recordPaymentInternal(businessId, supplier_id, purchase.id, purchase_date, paid_amount, payment_method || 'efectivo', `Pago inicial compra${invoice_number ? ' #' + invoice_number : ''}`, userId, supplierName);
    }

    return purchase as SupplierPurchase;
  },

  async updatePurchase(id: string, updates: Partial<SupplierPurchase>, businessId: string): Promise<SupplierPurchase> {
    const { data, error } = await supabase
      .from('supplier_purchases')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id).eq('business_id', businessId)
      .select().single();
    if (error || !data) throw new Error(error?.message || 'Error al actualizar compra');
    return data as SupplierPurchase;
  },

  async cancelPurchase(purchaseId: string, businessId: string, _userId: string): Promise<void> {
    const purchase = await this.getPurchaseWithItems(purchaseId, businessId);
    if (!purchase) throw new Error('Compra no encontrada');

    // Revertir stock con registro de movimiento
    for (const item of purchase.items || []) {
      if (!item.inventory_id) continue;
      const { data: inv } = await supabase.from('inventory').select('stock_quantity').eq('id', item.inventory_id).single();
      if (inv) {
        const prevStock = inv.stock_quantity || 0;
        const newStock  = Math.max(0, prevStock - item.quantity);
        await supabase.from('inventory').update({
          stock_quantity: newStock,
          updated_at: new Date().toISOString(),
        }).eq('id', item.inventory_id);
        await supabase.from('inventory_movements').insert({
          inventory_item_id: item.inventory_id,
          movement_type:     'cancellation',
          quantity:          -(prevStock - newStock),
          previous_stock:    prevStock,
          new_stock:         newStock,
          reference_type:    'purchase',
          reference_id:      purchaseId,
          note:              'Reversión por cancelación de compra',
          business_id:       businessId,
          created_by:        _userId || null,
        });
      }
    }

    await supabase.from('supplier_purchases')
      .update({ payment_status: 'pending', pending_amount: purchase.total_amount, paid_amount: 0, updated_at: new Date().toISOString() })
      .eq('id', purchaseId).eq('business_id', businessId);
  },

  // ── Pagos ───────────────────────────────────────────────────────────────────

  async getPayments(supplierId: string, businessId: string): Promise<SupplierPayment[]> {
    const { data, error } = await supabase
      .from('supplier_payments')
      .select('*')
      .eq('supplier_id', supplierId).eq('business_id', businessId)
      .order('payment_date', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []) as SupplierPayment[];
  },

  async createPayment(input: CreatePaymentInput, businessId: string, userId: string, supplierName: string): Promise<SupplierPayment> {
    const { supplier_id, purchase_id, payment_date, amount, payment_method, notes } = input;

    // 1. Insertar pago
    const { data: payment, error } = await supabase
      .from('supplier_payments')
      .insert({ business_id: businessId, supplier_id, purchase_id: purchase_id || null, payment_date, amount, payment_method, notes: notes || null, created_by: userId })
      .select().single();
    if (error || !payment) throw new Error(error?.message || 'Error al registrar pago');

    // 2. Actualizar compra si está vinculada
    if (purchase_id) {
      const { data: p } = await supabase.from('supplier_purchases').select('total_amount, paid_amount').eq('id', purchase_id).single();
      if (p) {
        const newPaid = (p.paid_amount || 0) + amount;
        const newPending = Math.max(0, p.total_amount - newPaid);
        const newStatus = calcPaymentStatus(p.total_amount, newPaid);
        await supabase.from('supplier_purchases').update({ paid_amount: newPaid, pending_amount: newPending, payment_status: newStatus, updated_at: new Date().toISOString() }).eq('id', purchase_id);
      }
    }

    // 3. Movimiento cuenta corriente + finanzas
    await this._recordPaymentInternal(businessId, supplier_id, purchase_id || null, payment_date, amount, payment_method, `Pago a ${supplierName}${notes ? ' — ' + notes : ''}`, userId, supplierName, payment.id);

    return payment as SupplierPayment;
  },

  // ── Cuenta corriente ────────────────────────────────────────────────────────

  async getAccountMovements(supplierId: string, businessId: string): Promise<AccountMovement[]> {
    const { data, error } = await supabase
      .from('supplier_account_movements')
      .select('*')
      .eq('supplier_id', supplierId).eq('business_id', businessId)
      .order('movement_date', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return computeRunningBalance((data || []) as AccountMovement[]);
  },

  // ── Internos ────────────────────────────────────────────────────────────────

  async _addAccountMovement(
    businessId: string, supplierId: string,
    purchaseId: string | null, paymentId: string | null,
    date: string, type: AccountMovement['type'],
    description: string, debit: number, credit: number
  ) {
    const { data: prev } = await supabase
      .from('supplier_account_movements')
      .select('balance_after')
      .eq('supplier_id', supplierId).eq('business_id', businessId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    const lastBalance = prev?.balance_after || 0;
    const balance_after = lastBalance + debit - credit;

    await supabase.from('supplier_account_movements').insert({
      business_id: businessId, supplier_id: supplierId,
      purchase_id: purchaseId, payment_id: paymentId,
      movement_date: date, type, description, debit, credit, balance_after,
    });
  },

  async _recordPaymentInternal(
    businessId: string, supplierId: string, purchaseId: string | null,
    date: string, amount: number, method: string, description: string,
    userId: string, supplierName: string, paymentId?: string
  ) {
    await this._addAccountMovement(businessId, supplierId, purchaseId, paymentId || null, date, 'payment', description, 0, amount);

    await supabase.from('business_finance_entries').insert({
      business_id: businessId, date, type: 'expense',
      category: 'compras_proveedor',
      description: `${description} (${supplierName})`,
      amount, currency: 'ARS', amount_ars: amount, exchange_rate: 1,
      created_by: userId,
    });

    if (['efectivo', 'transferencia', 'tarjeta'].includes(method)) {
      await supabase.from('financial_movements').insert({
        business_id: businessId, date, type: 'expense',
        currency: 'ARS', amount, amount_ars: amount, exchange_rate: 1,
        source: 'pago_proveedor', description,
        created_by: userId,
      });
    }
  },
};

export default suppliersService;
