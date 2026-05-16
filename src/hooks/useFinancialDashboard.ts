/**
 * useFinancialDashboard — datos financieros premium para el Dashboard.
 *
 * Carga en paralelo:
 *   1. Métodos de pago del día (comprobante_payments)
 *   2. Ventas hoy / semana / mes desde comprobante_payments
 *   3. CC proveedores (accounts type='proveedor')
 *   4. Caja del día: ingreso/egreso por método (financial_movements)
 *   5. Stock bajo: count de productos con stock ≤ min_stock
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PaymentMethodStat {
  method:    string
  label:     string
  color:     string
  amount:    number
  count:     number
  pct:       number
}

export interface CajaDayBreakdown {
  income:    number
  expense:   number
  net:       number
  byMethod: { method: string; label: string; color: string; income: number; expense: number }[]
}

export interface FinancialDashboardData {
  // Ventas desde comprobante_payments
  ventasHoy:     number
  ventasSemana:  number
  ventasMes:     number
  // Métodos de pago (hoy)
  paymentMethods: PaymentMethodStat[]
  // CC
  ccClientesDeuda:    number   // ya viene de useDashboardStats pero lo exponemos acá también
  ccProveedoresDeuda: number
  // Caja del día
  caja:           CajaDayBreakdown
  // Stock
  stockBajoCount: number
}

// ─── Config de métodos ────────────────────────────────────────────────────────

const METHOD_META: Record<string, { label: string; color: string }> = {
  efectivo:        { label: 'Efectivo',      color: '#22c55e' },
  transferencia:   { label: 'Transferencia', color: '#3b82f6' },
  tarjeta_debito:  { label: 'Débito',        color: '#f59e0b' },
  tarjeta_credito: { label: 'Crédito',       color: '#f97316' },
  qr:              { label: 'QR/MP',         color: '#8b5cf6' },
  cuenta_corriente:{ label: 'Cta. Cte.',     color: '#94a3b8' },
  mixto:           { label: 'Mixto',         color: '#64748b' },
  otro:            { label: 'Otro',          color: '#475569' },
}

function methodMeta(m: string) {
  return METHOD_META[m] ?? { label: m, color: '#475569' }
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  data:       FinancialDashboardData
  businessId: string
  timestamp:  number
}

let cache: CacheEntry | null = null
const CACHE_TTL = 90_000  // 90s — se invalida rápido para mostrar caja en tiempo real

export function invalidateFinancialDashboardCache() {
  cache = null
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useFinancialDashboard(businessId: string | null | undefined) {
  const [data,    setData]    = useState<FinancialDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  const load = useCallback(async (force = false) => {
    if (!businessId) { setLoading(false); return }

    if (!force && cache && cache.businessId === businessId && Date.now() - cache.timestamp < CACHE_TTL) {
      setData(cache.data)
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const todayISO    = new Date().toISOString().slice(0, 10)
      const weekAgoISO  = new Date(Date.now() - 7  * 86_400_000).toISOString().slice(0, 10)
      const monthAgoISO = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

      const [cpToday, cpSemana, cpMes, ccClientes, ccProveedores, fmToday, stockBajo] = await Promise.all([

        // 1. Pagos hoy (métodos + montos)
        supabase
          .from('comprobante_payments')
          .select('payment_method, amount_ars, commission_amount')
          .eq('business_id', businessId)
          .gte('date', todayISO),

        // 2. Ventas semana
        supabase
          .from('comprobante_payments')
          .select('amount_ars')
          .eq('business_id', businessId)
          .gte('date', weekAgoISO)
          .neq('payment_method', 'cuenta_corriente'),

        // 3. Ventas mes
        supabase
          .from('comprobante_payments')
          .select('amount_ars')
          .eq('business_id', businessId)
          .gte('date', monthAgoISO)
          .neq('payment_method', 'cuenta_corriente'),

        // 4. CC clientes deuda
        supabase
          .from('accounts')
          .select('balance')
          .eq('business_id', businessId)
          .eq('type', 'cliente')
          .gt('balance', 0),

        // 5. CC proveedores deuda (suma de balances de todas las cuentas proveedor)
        supabase
          .from('accounts')
          .select('balance')
          .eq('business_id', businessId)
          .eq('type', 'proveedor')
          .gt('balance', 0),

        // 6. Movimientos de caja hoy por método
        supabase
          .from('financial_movements')
          .select('type, amount_ars, metodo_pago')
          .eq('business_id', businessId)
          .gte('date', todayISO),

        // 7. Stock bajo (count)
        supabase
          .from('inventory')
          .select('*', { count: 'exact', head: true })
          .eq('business_id', businessId)
          .eq('is_active', true)
          .lte('stock_quantity', 5)
          .gt('stock_quantity', 0)
          .eq('tipo', 'product'),
      ])

      if (!mountedRef.current) return

      // ── Métodos de pago hoy ───────────────────────────────────────────
      const todayPayments = cpToday.data || []
      const methodMap = new Map<string, { amount: number; count: number }>()
      let totalHoy = 0

      for (const p of todayPayments) {
        const m = p.payment_method || 'otro'
        if (m === 'cuenta_corriente') continue  // CC no es caja real
        const cur = methodMap.get(m) ?? { amount: 0, count: 0 }
        const net = (p.amount_ars || 0) - (p.commission_amount || 0)
        cur.amount += net
        cur.count  += 1
        methodMap.set(m, cur)
        totalHoy += net
      }

      const paymentMethods: PaymentMethodStat[] = Array.from(methodMap.entries())
        .map(([method, { amount, count }]) => ({
          method,
          label: methodMeta(method).label,
          color: methodMeta(method).color,
          amount,
          count,
          pct: totalHoy > 0 ? (amount / totalHoy) * 100 : 0,
        }))
        .sort((a, b) => b.amount - a.amount)

      const ventasHoy = totalHoy

      // ── Ventas semana / mes ───────────────────────────────────────────
      const ventasSemana = (cpSemana.data || []).reduce((s, r) => s + (r.amount_ars || 0), 0)
      const ventasMes    = (cpMes.data    || []).reduce((s, r) => s + (r.amount_ars || 0), 0)

      // ── CC ────────────────────────────────────────────────────────────
      const ccClientesDeuda    = (ccClientes.data   || []).reduce((s, a) => s + Number(a.balance || 0), 0)
      const ccProveedoresDeuda = (ccProveedores.data || []).reduce((s, a) => s + Number(a.balance || 0), 0)

      // ── Caja del día ──────────────────────────────────────────────────
      const fmRows = fmToday.data || []
      const cajaMethodMap = new Map<string, { income: number; expense: number }>()

      let cajaIncome = 0; let cajaExpense = 0
      for (const f of fmRows) {
        const m   = f.metodo_pago || 'otro'
        const amt = Math.abs(f.amount_ars || 0)
        const cur = cajaMethodMap.get(m) ?? { income: 0, expense: 0 }
        if (f.type === 'income')  { cur.income  += amt; cajaIncome  += amt }
        else                      { cur.expense += amt; cajaExpense += amt }
        cajaMethodMap.set(m, cur)
      }

      const cajaByMethod = Array.from(cajaMethodMap.entries())
        .map(([method, { income, expense }]) => ({
          method,
          label:   methodMeta(method).label,
          color:   methodMeta(method).color,
          income,
          expense,
        }))
        .sort((a, b) => (b.income - b.expense) - (a.income - a.expense))

      const caja: CajaDayBreakdown = {
        income:   cajaIncome,
        expense:  cajaExpense,
        net:      cajaIncome - cajaExpense,
        byMethod: cajaByMethod,
      }

      // ── Stock bajo ────────────────────────────────────────────────────
      const stockBajoCount = stockBajo.count ?? 0

      const result: FinancialDashboardData = {
        ventasHoy,
        ventasSemana,
        ventasMes,
        paymentMethods,
        ccClientesDeuda,
        ccProveedoresDeuda,
        caja,
        stockBajoCount,
      }

      cache = { data: result, businessId, timestamp: Date.now() }
      if (mountedRef.current) { setData(result); setLoading(false) }

    } catch (e) {
      console.error('[useFinancialDashboard]', e)
      if (mountedRef.current) setLoading(false)
    }
  }, [businessId])

  useEffect(() => {
    mountedRef.current = true
    load()
    return () => { mountedRef.current = false }
  }, [load])

  return { data, loading, refresh: () => { cache = null; load(true) } }
}
