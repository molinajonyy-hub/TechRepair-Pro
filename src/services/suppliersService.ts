import { supabase } from '../lib/supabase';
import { financeErrorMessage } from '../lib/financeErrors';
import { logger } from '../lib/logger';

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

/**
 * SEC-08C — las stats financieras de un proveedor pueden NO estar disponibles
 * para el actor. `null` significa RESTRINGIDO, y es un estado distinto de 0.
 * Un 0 acá es una afirmación del negocio ("no debe nada"); un null es "no
 * tenés autoridad para saberlo". Colapsarlos fue el defecto original.
 */
export interface SupplierWithStats extends Supplier {
  total_purchases: number | null;
  total_paid: number | null;
  pending_amount: number | null;
  purchases_count: number | null;
  last_purchase_date: string | null;
  /** false → los importes de arriba son null por autoridad, no por ausencia. */
  finance_authorized: boolean;
}

/** Deuda con proveedores, agregada server-side. `outstanding` null = restringido. */
export interface SupplierDebtSummary {
  outstanding: number | null;
  documents: number | null;
  authorized: boolean;
}

export interface SupplierPurchase {
  id: string;
  business_id: string;
  supplier_id: string;
  purchase_date: string;
  /** M8 - fecha de pago acordada. null = sin fecha acordada (no es "vencida"). */
  due_date?: string | null;
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
  /** Fecha de pago acordada (M8). Vacio = no se acordo fecha; NO significa "vence ya". */
  due_date?: string | null;
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

// ─── Proyecciones explícitas (SEC-08C) ───────────────────────────────────────
//
// Ninguna de estas tablas es 100 % operativa: todas mezclan datos de contacto o
// de documento con verdad financiera. Un `select('*')` sobre ellas es una API
// que expone en silencio cualquier columna que se agregue después, así que la
// forma que cruza la red queda escrita y auditable.

// `as const` y en una sola línea a propósito: supabase-js infiere el tipo de la
// fila desde el LITERAL de la proyección. Partirlas con `+` las degrada a
// `string` y la respuesta vuelve sin tipar.
const PURCHASE_COLUMNS = 'id,business_id,supplier_id,purchase_date,due_date,invoice_number,total_amount,paid_amount,pending_amount,payment_status,payment_method,notes,attachment_url,created_by,created_at,updated_at' as const;

// unit_cost y subtotal siguen gateados por `inventory_view_costs` (SEC-08B):
// pedirlos no los entrega, la RLS filtra la fila. Se los nombra igual para que
// la dependencia sea visible en el código y no un efecto lateral.
const PURCHASE_ITEM_COLUMNS = 'id,business_id,purchase_id,supplier_id,inventory_id,product_name,quantity,unit_cost,subtotal,created_at' as const;

const PAYMENT_COLUMNS = 'id,business_id,supplier_id,purchase_id,payment_date,amount,payment_method,notes,created_by,created_at' as const;

const ACCOUNT_MOVEMENT_COLUMNS = 'id,business_id,supplier_id,purchase_id,payment_id,movement_date,type,description,debit,credit,balance_after,created_at' as const;

const SUPPLIER_STATS_COLUMNS = 'supplier_id,total_purchases,total_paid,pending_amount,purchases_count,last_purchase_date,is_authorized' as const;

// ─── Service ─────────────────────────────────────────────────────────────────

export const suppliersService = {

  // ── Listado con estadísticas ────────────────────────────────────────────────

  // SEC-08C — el listado ya NO trae supplier_purchases embebida ni suma en el
  // browser. Los importes los agrega `v_finance_supplier_stats` server-side y
  // llegan en null cuando el actor no tiene autoridad financiera: un proveedor
  // sin autoridad muestra "—", nunca "$0" ni "Al día".
  async getSuppliersWithStats(businessId: string): Promise<SupplierWithStats[]> {
    const [{ data, error }, { data: stats, error: statsError }] = await Promise.all([
      supabase.from('suppliers').select('*').eq('business_id', businessId).order('name'),
      supabase.from('v_finance_supplier_stats').select(SUPPLIER_STATS_COLUMNS).eq('business_id', businessId),
    ]);

    if (error) throw new Error(error.message);
    // Las stats son opcionales: si fallan, el listado operativo tiene que
    // seguir funcionando, pero NO se inventa un 0 — se marca restringido.
    if (statsError) logger.error('SUPPLIERS', 'No se pudieron leer las stats de proveedor', statsError);

    const byId = new Map((stats || []).map((r: any) => [r.supplier_id, r]));

    return (data || []).map((s: any) => {
      const st = byId.get(s.id);
      const authorized = st?.is_authorized === true;
      const num = (v: unknown) => (authorized && v !== null && v !== undefined ? Number(v) : null);
      return {
        ...s,
        total_purchases:    num(st?.total_purchases),
        total_paid:         num(st?.total_paid),
        pending_amount:     num(st?.pending_amount),
        purchases_count:    num(st?.purchases_count),
        last_purchase_date: authorized ? (st?.last_purchase_date ?? null) : null,
        finance_authorized: authorized,
      } as SupplierWithStats;
    });
  },

  // Fuente canónica de la tarjeta «Deuda proveedores». El agregado lo hace la
  // base; acá no se suma nada.
  async getSupplierDebt(businessId: string): Promise<SupplierDebtSummary> {
    const { data, error } = await supabase
      .from('v_finance_supplier_debt')
      .select('outstanding_ars,documents,is_authorized')
      .eq('business_id', businessId)
      .maybeSingle();

    // Un fallo de lectura NO puede convertirse en «no hay deuda».
    if (error) {
      logger.error('SUPPLIERS', 'No se pudo leer la deuda de proveedores', error);
      return { outstanding: null, documents: null, authorized: false };
    }
    const authorized = data?.is_authorized === true;
    return {
      outstanding: authorized && data?.outstanding_ars !== null ? Number(data?.outstanding_ars) : null,
      documents:   authorized && data?.documents !== null ? Number(data?.documents) : null,
      authorized,
    };
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
    const { data } = await supabase.from('suppliers').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
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
      .select(`${PURCHASE_COLUMNS}, items:supplier_purchase_items(${PURCHASE_ITEM_COLUMNS})`)
      .eq('supplier_id', supplierId)
      .eq('business_id', businessId)
      .order('purchase_date', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []) as SupplierPurchase[];
  },

  async getPurchaseWithItems(purchaseId: string, businessId: string): Promise<SupplierPurchase | null> {
    const { data } = await supabase
      .from('supplier_purchases')
      .select(`${PURCHASE_COLUMNS}, items:supplier_purchase_items(${PURCHASE_ITEM_COLUMNS})`)
      .eq('id', purchaseId).eq('business_id', businessId).single();
    return data as SupplierPurchase | null;
  },

  // idempotencyKey (opcional): liga la compra al payload server-side. Misma key +
  // mismo payload → replay de la compra original; misma key + payload distinto →
  // IDEMPOTENCY_CONFLICT (se lanza como Error con .code). Si se omite, la RPC crea
  // siempre (compat legacy). El flag `replay` permite al llamador NO duplicar
  // efectos client-side (p.ej. el registro documental en expenses).
  async createPurchase(input: CreatePurchaseInput, businessId: string, userId: string, supplierName: string, idempotencyKey?: string): Promise<SupplierPurchase & { replay: boolean }> {
    const { supplier_id, purchase_date, due_date, invoice_number, total_amount, paid_amount, payment_method, notes, items } = input;

    const { data, error } = await supabase.rpc('create_supplier_purchase_atomic', {
      p_business_id:    businessId,
      p_supplier_id:    supplier_id,
      p_user_id:        userId,
      p_supplier_name:  supplierName,
      p_purchase_date:  purchase_date,
      p_invoice_number: invoice_number || '',
      p_total_amount:   total_amount,
      p_paid_amount:    paid_amount || 0,
      p_payment_method: payment_method || '',
      p_notes:          notes || '',
      p_items:          items.map(i => ({
        inventory_id: i.inventory_id || null,
        product_name: i.product_name,
        quantity:     i.quantity,
        unit_cost:    i.unit_cost,
      })),
      p_idempotency_key: idempotencyKey || null,
    });

    if (error) throw new Error(error.message);
    if (data?.error === 'IDEMPOTENCY_CONFLICT') {
      const conflict = new Error(data.message || 'Esta solicitud ya fue utilizada con datos diferentes. Volvé a iniciar la operación.');
      (conflict as Error & { code?: string }).code = 'IDEMPOTENCY_CONFLICT';
      throw conflict;
    }
    if (!data?.ok) throw new Error(data?.error || 'Error al crear compra');

    // M8 - la fecha de vencimiento va por UPDATE separado a proposito: no se toca
    // la firma de la RPC atomica (idempotente, con efectos financieros) por un
    // dato opcional que no altera importes ni genera movimientos. En un replay la
    // fecha ya quedo escrita por la llamada original.
    if (due_date && data.replay !== true) {
      const { error: dueErr } = await supabase
        .from('supplier_purchases')
        .update({ due_date })
        .eq('id', data.purchase_id).eq('business_id', businessId);
      if (dueErr) {
        // La compra SI se creo con sus importes correctos. No se silencia: el
        // usuario tiene que saber que la fecha no quedo guardada.
        logger.error('SUPPLIERS', 'No se pudo guardar la fecha de vencimiento', dueErr);
        throw new Error('La compra se registro, pero no se pudo guardar la fecha de vencimiento. Editala desde el detalle de la compra.');
      }
    }

    const purchase = await supabase
      .from('supplier_purchases')
      .select(`${PURCHASE_COLUMNS}, items:supplier_purchase_items(${PURCHASE_ITEM_COLUMNS})`)
      .eq('id', data.purchase_id)
      .single();

    return { ...(purchase.data || { id: data.purchase_id }), replay: data.replay === true } as SupplierPurchase & { replay: boolean };
  },

  async updatePurchase(id: string, updates: Partial<SupplierPurchase>, businessId: string): Promise<SupplierPurchase> {
    const { data, error } = await supabase
      .from('supplier_purchases')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id).eq('business_id', businessId)
      // `.select()` a secas es RETURNING *: la misma forma cruda que este lote
      // quitó de las lecturas, sólo que por la puerta del UPDATE.
      .select(PURCHASE_COLUMNS).single();
    if (error || !data) throw new Error(error?.message || 'Error al actualizar compra');
    return data as SupplierPurchase;
  },

  async deletePurchaseSafe(purchaseId: string, businessId: string, userId: string): Promise<{ blocked?: boolean; message?: string }> {
    const { data, error } = await supabase.rpc('delete_supplier_purchase_safe', {
      p_business_id: businessId,
      p_purchase_id: purchaseId,
      p_user_id:     userId,
    });
    if (error) throw new Error(error.message);
    if (!data?.ok) {
      if (data?.error === 'blocked_paid') {
        return { blocked: true, message: data.message };
      }
      throw new Error(data?.error || 'Error al eliminar compra');
    }
    return {};
  },

  // @deprecated — kept for compatibility; use deletePurchaseSafe
  async cancelPurchase(purchaseId: string, businessId: string, userId: string): Promise<void> {
    await this.deletePurchaseSafe(purchaseId, businessId, userId);
  },

  // ── Pagos ───────────────────────────────────────────────────────────────────

  async getPayments(supplierId: string, businessId: string): Promise<SupplierPayment[]> {
    const { data, error } = await supabase
      .from('supplier_payments')
      .select(PAYMENT_COLUMNS)
      .eq('supplier_id', supplierId).eq('business_id', businessId)
      .order('payment_date', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []) as SupplierPayment[];
  },

  // M7 7D.3 — idempotencyKey la GENERA LA UI, no este service.
  //
  // El dueño de la key tiene que ser quien conoce el límite de la intención del
  // usuario. Si la generara acá, cada llamada (incluido un reintento del mismo
  // intento) traería una key nueva y la protección no existiría: sería una key
  // por request HTTP, que es exactamente lo que NO sirve. El service sólo la
  // propaga; los reintentos internos reusan la misma.
  //
  // Devuelve `replay: true` cuando la RPC reconoció una key ya ejecutada, para
  // que el llamador no duplique efectos client-side.
  async createPayment(input: CreatePaymentInput, businessId: string, userId: string, supplierName: string, idempotencyKey?: string): Promise<SupplierPayment & { replay: boolean }> {
    const { supplier_id, purchase_id, payment_date, amount, payment_method, notes } = input;

    // Misma forma de resultado para los dos caminos (libre / contra factura):
    // el llamador no tiene por qué saber cuál se tomó.
    const fetchPayment = async (paymentId: string, replay: boolean) => {
      const { data: payment } = await supabase
        .from('supplier_payments')
        .select(PAYMENT_COLUMNS)
        .eq('id', paymentId)
        .single();
      return { ...(payment || { id: paymentId }), replay } as SupplierPayment & { replay: boolean };
    };

    const failed = (data: { error_code?: string; error?: string; message?: string } | null) => {
      const code = data?.error_code || data?.error;
      const err = new Error(financeErrorMessage(code, data?.message, 'SUPPLIERS')) as Error & { code?: string };
      err.code = code;
      return err;
    };

    if (!purchase_id) {
      // Pago libre sin factura vinculada — RPC atómica (M6 Fase 9): crea
      // supplier_payment + account_movement + BFE + FM en una sola transacción.
      const { data, error } = await supabase.rpc('pay_supplier_free_atomic', {
        p_business_id:    businessId,
        p_supplier_id:    supplier_id,
        p_user_id:        userId,
        p_supplier_name:  supplierName,
        p_payment_date:   payment_date,
        p_amount:         amount,
        p_payment_method: payment_method || '',
        p_notes:          notes || '',
        p_idempotency_key: idempotencyKey || null,
      });
      if (error) throw new Error(error.message);
      if (!data?.ok) throw failed(data);
      return fetchPayment(data.payment_id, !!data.replay);
    }

    const { data, error } = await supabase.rpc('pay_supplier_purchase_atomic', {
      p_business_id:    businessId,
      p_supplier_id:    supplier_id,
      p_user_id:        userId,
      p_supplier_name:  supplierName,
      p_purchase_id:    purchase_id,
      p_payment_date:   payment_date,
      p_amount:         amount,
      p_payment_method: payment_method || '',
      p_notes:          notes || '',
      p_idempotency_key: idempotencyKey || null,
    });

    if (error) throw new Error(error.message);
    if (!data?.ok) throw failed(data);

    return fetchPayment(data.payment_id, !!data.replay);
  },

  // ── Cuenta corriente ────────────────────────────────────────────────────────

  async getAccountMovements(supplierId: string, businessId: string): Promise<AccountMovement[]> {
    const { data, error } = await supabase
      .from('supplier_account_movements')
      .select(ACCOUNT_MOVEMENT_COLUMNS)
      .eq('supplier_id', supplierId).eq('business_id', businessId)
      .order('movement_date', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    // SEC-08C — antes se recalculaba `balance_after` en el browser y se pisaba
    // el valor canónico. `balance_after` lo calcula server-side el trigger
    // `trig_supplier_account_movement_balance` con su advisory lock: el cliente
    // no tiene por qué reconstruirlo, y de hecho ninguna superficie lo mostraba
    // (Suppliers.tsx sólo usa la cantidad de movimientos). Se devuelve el valor
    // de la base tal cual.
    return (data || []) as AccountMovement[];
  },
};

export default suppliersService;
