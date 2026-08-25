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
import { financeErrorMessage } from '../lib/financeErrors'

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

  // P0-CC · CC-E — `addMovement` fue ELIMINADA.
  //
  // Era el último INSERT directo del cliente sobre `account_movements`. Sus dos
  // únicos consumidores restantes, `registerSale` y `registerPurchase`, nunca
  // llegaron a tener llamadores: la deuda de una venta a cuenta corriente la
  // crea `create_comprobante_checkout_atomic` dentro de la misma transacción
  // del checkout, no el cliente después del hecho.
  //
  // El ledger ya no se escribe desde el navegador. Toda escritura pasa por una
  // RPC atómica, auditada e idempotente:
  //   cobro    -> record_customer_account_payment_atomic
  //   deuda    -> record_customer_account_adjustment_atomic  (direction='debit')
  //   ajuste   -> record_customer_account_adjustment_atomic  (direction='credit')
  //   reversa  -> reverse_customer_account_payment_atomic
  //   venta CC -> create_comprobante_checkout_atomic
  //   anulación-> annul_comprobante_atomic
  //
  // La migración CC-E revoca el INSERT a `authenticated`, así que reintroducir
  // un `.insert()` acá no fallaría en el code review: fallaría en producción
  // con 42501.

  /**
   * P0-CC · CC-D — Movimiento manual (deuda o ajuste) por RPC auditada.
   *
   * Reemplaza a `registerDebt` y `addAdjustment`, que hacían INSERT directo: sin
   * capacidad server-side, sin idempotencia, sin guard de período y sin
   * auditoría explícita.
   *
   * `direction` es el hecho contable, no una etiqueta: `debit` sube la deuda,
   * `credit` la baja. No se inventó un `type` nuevo en el ledger — una deuda
   * cargada a mano no es una `venta` y llamarla así contaminaría el devengado.
   *
   * Un ajuste NO mueve caja. Si moviera caja sería un cobro, y para eso está
   * `registrarPagoCC`.
   */
  async registrarAjusteCC(
    businessId: string,
    accountId: string,
    amount: number,
    direction: 'debit' | 'credit',
    reason: string,
    idempotencyKey?: string,
  ): Promise<{ ok: boolean; replay?: boolean; account_movement_id?: string; balance?: number }> {
    const { data, error } = await supabase.rpc('record_customer_account_adjustment_atomic', {
      p_business_id:     businessId,
      p_account_id:      accountId,
      p_amount:          amount,
      p_direction:       direction,
      p_reason:          reason,
      p_idempotency_key: idempotencyKey || null,
    })
    if (error) throw new Error(error.message)
    if (!data?.ok) {
      const code = (data?.error_code || data?.error) as string | undefined
      const err = new Error(financeErrorMessage(code, data?.message || data?.error, 'FINANCE'))
      ;(err as Error & { code?: string }).code = code
      throw err
    }
    return data
  },

  /**
   * P0-CC · CC-D — Reversa canónica de un cobro de cuenta corriente.
   *
   * NO borra ni edita: escribe contra-movimientos auditables en las TRES patas
   * (ledger, caja y asiento financiero), fechados HOY, enlazados al cobro
   * original. El cobro queda en el historial.
   *
   * Dos reversas del mismo cobro nunca producen dos contra-movimientos: con la
   * misma clave es un replay; con otra clave devuelve `ALREADY_REVERSED`, y eso
   * lo garantiza un UNIQUE en la base, no el hash.
   */
  async revertirCobroCC(
    businessId: string,
    movementId: string,
    reason: string,
    idempotencyKey?: string,
  ): Promise<{ ok: boolean; replay?: boolean; reversal_movement_id?: string; balance?: number }> {
    const { data, error } = await supabase.rpc('reverse_customer_account_payment_atomic', {
      p_business_id:     businessId,
      p_movement_id:     movementId,
      p_reason:          reason,
      p_idempotency_key: idempotencyKey || null,
    })
    if (error) throw new Error(error.message)
    if (!data?.ok) {
      const code = (data?.error_code || data?.error) as string | undefined
      const err = new Error(financeErrorMessage(code, data?.message || data?.error, 'FINANCE'))
      ;(err as Error & { code?: string }).code = code
      throw err
    }
    return data
  },

  /**
   * Cobros de esta cuenta que TODAVÍA se pueden revertir.
   *
   * Un cobro ya reversado se detecta por su fila en `account_payment_reversals`,
   * no por una columna mutable en el ledger: `account_movements` es append-only
   * y no se le agregó estado.
   */
  async getCobrosReversibles(accountId: string, limit = 20): Promise<AccountMovement[]> {
    const { data } = await supabase
      .from('account_movements')
      .select('*')
      .eq('account_id', accountId)
      .eq('type', 'pago')
      .gt('credit', 0)
      .order('created_at', { ascending: false })
      .limit(limit)
    const cobros = (data || []) as AccountMovement[]
    if (cobros.length === 0) return []

    const { data: revs } = await supabase
      .from('account_payment_reversals')
      .select('original_movement_id')
      .in('original_movement_id', cobros.map(c => c.id))
    const reversados = new Set((revs || []).map((r: { original_movement_id: string }) => r.original_movement_id))
    return cobros.filter(c => !reversados.has(c.id))
  },

  // `registerSale` y `registerPurchase` se eliminaron con CC-E. Estaban
  // documentadas como «para integración futura» y nunca tuvieron llamadores: la
  // deuda de una venta a cuenta corriente ya la crea el checkout atómico, y la
  // de una compra vive en el ledger de proveedores (`supplier_account_movements`),
  // que es otro libro. Mantenerlas habría dejado abierto el último INSERT
  // directo al ledger justo cuando CC-E lo revoca.

  /**
   * Registra el cobro de una deuda de cuenta corriente vía RPC atómica.
   * En UNA transacción: acredita el ledger (baja la deuda), crea el
   * financial_movement income (SUBE la caja) y el BFE espejo
   * (revenue_collection_mirror, EXCLUIDO del P&L — no reconoce venta nueva).
   * Idempotente: misma key + mismo payload → replay; payload distinto →
   * IDEMPOTENCY_CONFLICT (Error con .code). NO se escribe ledger/FM/BFE
   * client-side.
   */
  async registrarPagoCC(
    businessId: string,
    accountId: string,
    amount: number,
    description: string,
    userId: string,
    cajaId?: string | null,
    method: string = 'efectivo',
    idempotencyKey?: string,
  ): Promise<{ ok: boolean; replay?: boolean; account_movement_id?: string; financial_movement_id?: string }> {
    const { data, error } = await supabase.rpc('record_customer_account_payment_atomic', {
      p_business_id:     businessId,
      p_account_id:      accountId,
      p_amount:          amount,
      p_description:     description,
      p_user_id:         userId,
      p_payment_method:  method,
      p_date:            null,           // el server usa ar_today()
      p_caja_id:         cajaId || null,
      p_idempotency_key: idempotencyKey || null,
    })
    if (error) throw new Error(error.message)

    // La RPC devuelve {ok:false, error_code, error, message}. El código tipado
    // manda: `error` trae el texto crudo del server y `error_code` es el
    // contrato. Antes se comparaba contra `error`, así que sólo el conflicto de
    // idempotencia —el único que repite el código dentro de `error`— llegaba
    // clasificado; el resto caía al genérico y perdía el mensaje accionable.
    if (!data?.ok) {
      const code = (data?.error_code || data?.error) as string | undefined
      const err = new Error(financeErrorMessage(code, data?.message || data?.error, 'FINANCE'))
      ;(err as Error & { code?: string }).code = code
      throw err
    }
    return data
  },
}
