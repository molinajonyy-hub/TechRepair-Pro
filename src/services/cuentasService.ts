/**
 * cuentasService — libro mayor de cuentas corrientes.
 *
 * Principio contable:
 *   balance = SUM(debit) - SUM(credit)
 *   debit  → genera deuda (cliente debe / negocio debe a proveedor)
 *   credit → reduce deuda (pago recibido / pago realizado)
 *
 * El balance_after de cada movimiento lo calcula el trigger
 * trig_account_movement_balance (server-side, atómico).
 */
import { supabase } from '../lib/supabase'
import { requireFeature } from '../utils/requireFeature'

// ─── Types ─────────────────────────────────────────────────────────────────

export type AccountType    = 'cliente' | 'proveedor'
export type MovementType   = 'venta' | 'compra' | 'gasto' | 'pago' | 'ajuste' | 'apertura'
export type ReferenceType  = 'comprobante' | 'purchase' | 'expense' | 'manual'

export interface Account {
  id: string
  business_id: string
  type: AccountType
  entity_id: string
  entity_name: string
  entity_phone: string | null
  balance: number
  credit_limit: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface AccountMovement {
  id: string
  business_id: string
  account_id: string
  date: string
  type: MovementType
  reference_type: string | null
  reference_id: string | null
  description: string
  debit: number
  credit: number
  balance_after: number
  created_by: string | null
  created_at: string
}

export interface AddMovementInput {
  date?: string
  type: MovementType
  description: string
  debit: number
  credit: number
  reference_type?: ReferenceType | null
  reference_id?: string | null
  created_by?: string | null
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export function getAccountStatus(balance: number): 'al_dia' | 'deuda' | 'a_favor' {
  if (Math.abs(balance) < 0.01) return 'al_dia'
  return balance > 0 ? 'deuda' : 'a_favor'
}

// ─── Service ───────────────────────────────────────────────────────────────

export const cuentasService = {

  // ── Accounts ────────────────────────────────────────────────────────────

  async getAccounts(
    businessId: string,
    type?: AccountType,
    search?: string,
    status?: 'al_dia' | 'deuda' | 'a_favor' | 'all',
  ): Promise<Account[]> {
    let q = supabase
      .from('accounts')
      .select('*')
      .eq('business_id', businessId)
      .order('entity_name')
    if (type)   q = q.eq('type', type)
    if (search) q = q.ilike('entity_name', `%${search}%`)
    const { data } = await q
    let list = (data || []) as Account[]
    if (status && status !== 'all') {
      list = list.filter(a => getAccountStatus(a.balance) === status)
    }
    return list
  },

  async getAccount(accountId: string): Promise<Account | null> {
    const { data } = await supabase
      .from('accounts').select('*').eq('id', accountId).maybeSingle()
    return data as Account | null
  },

  /** Obtiene o crea una cuenta para un cliente/proveedor. */
  async getOrCreate(
    businessId: string,
    type: AccountType,
    entityId: string,
    entityName: string,
    entityPhone?: string | null,
  ): Promise<Account> {
    await requireFeature(businessId, 'currentAccounts', 'get_or_create_account')
    const { data: existing } = await supabase
      .from('accounts').select('*')
      .eq('business_id', businessId)
      .eq('entity_id', entityId)
      .maybeSingle()
    if (existing) return existing as Account

    const { data, error } = await supabase
      .from('accounts')
      .insert({ business_id: businessId, type, entity_id: entityId, entity_name: entityName, entity_phone: entityPhone || null, balance: 0 })
      .select().single()
    if (error) throw error
    return data as Account
  },

  async updateAccount(accountId: string, patch: { credit_limit?: number | null; notes?: string | null; entity_name?: string; entity_phone?: string | null }): Promise<void> {
    await supabase.from('accounts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', accountId)
  },

  // ── Movements ───────────────────────────────────────────────────────────

  async getMovements(accountId: string, limit = 100): Promise<AccountMovement[]> {
    const { data } = await supabase
      .from('account_movements')
      .select('*')
      .eq('account_id', accountId)
      .order('date',       { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit)
    return (data || []) as AccountMovement[]
  },

  /**
   * Inserta un movimiento en el ledger.
   * balance_after se calcula server-side (trigger BEFORE INSERT con SELECT FOR UPDATE).
   */
  async addMovement(businessId: string, accountId: string, input: AddMovementInput): Promise<AccountMovement> {
    await requireFeature(businessId, 'currentAccounts', 'add_account_movement')
    const { data, error } = await supabase
      .from('account_movements')
      .insert({
        business_id:    businessId,
        account_id:     accountId,
        date:           input.date || new Date().toISOString().split('T')[0],
        type:           input.type,
        description:    input.description,
        debit:          input.debit,
        credit:         input.credit,
        balance_after:  0,  // sobreescrito por el trigger
        reference_type: input.reference_type || null,
        reference_id:   input.reference_id   || null,
        created_by:     input.created_by     || null,
      })
      .select()
      .single()
    if (error) throw error
    return data as AccountMovement
  },

  /** Registra un pago que reduce la deuda. */
  async registerPayment(
    businessId: string, accountId: string,
    amount: number, description: string, userId: string,
  ): Promise<AccountMovement> {
    return this.addMovement(businessId, accountId, {
      type: 'pago', description, debit: 0, credit: amount, created_by: userId,
    })
  },

  /** Registra una deuda manual (no vinculada a venta/compra). */
  async registerDebt(
    businessId: string, accountId: string,
    amount: number, description: string, userId: string,
  ): Promise<AccountMovement> {
    return this.addMovement(businessId, accountId, {
      type: 'ajuste', description, debit: amount, credit: 0, created_by: userId,
    })
  },

  /** Ajuste contable: acreedor (isCredit=true) o deudor (isCredit=false). */
  async addAdjustment(
    businessId: string, accountId: string,
    amount: number, isCredit: boolean, reason: string, userId: string,
  ): Promise<AccountMovement> {
    return this.addMovement(businessId, accountId, {
      type: 'ajuste',
      description: `Ajuste: ${reason}`,
      debit:  isCredit ? 0 : amount,
      credit: isCredit ? amount : 0,
      created_by: userId,
    })
  },

  /**
   * Registra el impacto de una venta en CC (para integración futura).
   * Llama solo si la venta tiene deuda pendiente.
   */
  async registerSale(
    businessId: string, accountId: string,
    total: number, paid: number,
    description: string, comprobante_id?: string, userId?: string,
  ): Promise<AccountMovement | null> {
    const deuda = total - paid
    if (deuda <= 0.01) return null  // pago completo: no impacta CC
    return this.addMovement(businessId, accountId, {
      type: 'venta', description,
      debit: deuda, credit: 0,
      reference_type: 'comprobante',
      reference_id:   comprobante_id || null,
      created_by:     userId || null,
    })
  },

  /**
   * Registra el impacto de una compra a proveedor en CC.
   */
  async registerPurchase(
    businessId: string, accountId: string,
    total: number, paid: number,
    description: string, purchase_id?: string, userId?: string,
  ): Promise<AccountMovement | null> {
    const deuda = total - paid
    if (deuda <= 0.01) return null
    return this.addMovement(businessId, accountId, {
      type: 'compra', description,
      debit: deuda, credit: 0,
      reference_type: 'purchase',
      reference_id:   purchase_id || null,
      created_by:     userId || null,
    })
  },

  /**
   * Registra el cobro de una deuda de cuenta corriente.
   * Acredita el ledger (reduce la deuda) Y crea un BFE income (impacto real en caja).
   */
  async registrarPagoCC(
    businessId: string,
    accountId: string,
    amount: number,
    description: string,
    userId: string,
    cajaId?: string | null,
  ): Promise<AccountMovement> {
    const today = new Date().toISOString().split('T')[0]
    const movement = await this.addMovement(businessId, accountId, {
      type: 'pago', description,
      debit: 0, credit: amount,
      created_by: userId,
    })
    await supabase.from('business_finance_entries').insert({
      business_id:  businessId,
      date:         today,
      type:         'income',
      category:     'cobro_cuenta_corriente',
      description,
      amount:       amount,
      currency:     'ARS',
      amount_ars:   amount,
      exchange_rate: 1,
      created_by:   userId || null,
      caja_id:      cajaId || null,
    })
    return movement
  },
}
