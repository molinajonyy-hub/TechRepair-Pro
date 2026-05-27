/**
 * useFinancialDashboard — datos financieros premium para el Dashboard.
 *
 * Carga en paralelo:
 *   1. Ventas semana / mes (comprobante_payments por rango de fecha)
 *   2. CC clientes / proveedores (accounts)
 *   3. Caja activa: ingreso/egreso (financial_movements filtrado por caja_id)
 *   4. Stock bajo: count de productos con stock ≤ min_stock
 *
 * Los cards "Cobrado en caja" y "Caja neta" usan SIEMPRE la caja abierta actual
 * (openCajaId). Sin caja abierta devuelven $0. Nunca filtran por fecha calendario.
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
  ventasHoy:     number   // suma de income de la caja abierta actual
  ventasSemana:  number
  ventasMes:     number
  // Métodos de pago (caja actual)
  paymentMethods: PaymentMethodStat[]
  // CC
  ccClientesDeuda:    number
  ccProveedoresDeuda: number
  // Caja activa (financial_movements de la caja abierta)
  caja:           CajaDayBreakdown
  cajaAbierta:    boolean
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
  openCajaId: string | null
  timestamp:  number
}

let cache: CacheEntry | null = null
const CACHE_TTL = 90_000  // 90s — se invalida rápido para mostrar caja en tiempo real

export function invalidateFinancialDashboardCache() {
  cache = null
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useFinancialDashboard(businessId: string | null | undefined, openCajaId?: string | null) {
  const [data,    setData]    = useState<FinancialDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  const cajaKey = openCajaId ?? null

  const load = useCallback(async (force = false) => {
    if (!businessId) { setLoading(false); return }

    if (
      !force && cache &&
      cache.businessId === businessId &&
      cache.openCajaId === cajaKey &&
      Date.now() - cache.timestamp < CACHE_TTL
    ) {
      setData(cache.data)
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const weekAgoISO  = new Date(Date.now() - 7  * 86_400_000).toISOString().slice(0, 10)
      const monthAgoISO = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

      // Queries que siempre se ejecutan
      const [cpSemana, cpMes, ccClientes, ccProveedores, stockBajo, fmCaja] = await Promise.all([

        // 1. Ventas semana
        supabase
          .from('comprobante_payments')
          .select('amount_ars')
          .eq('business_id', businessId)
          .gte('date', weekAgoISO)
          .neq('payment_method', 'cuenta_corriente'),

        // 2. Ventas mes
        supabase
          .from('comprobante_payments')
          .select('amount_ars')
          .eq('business_id', businessId)
          .gte('date', monthAgoISO)
          .neq('payment_method', 'cuenta_corriente'),

        // 3. CC clientes deuda
        supabase
          .from('accounts')
          .select('balance')
          .eq('business_id', businessId)
          .eq('type', 'cliente')
          .gt('balance', 0),

        // 4. CC proveedores deuda
        supabase
          .from('accounts')
          .select('balance')
          .eq('business_id', businessId)
          .eq('type', 'proveedor')
          .gt('balance', 0),

        // 5. Stock bajo (count)
        supabase
          .from('inventory')
          .select('*', { count: 'exact', head: true })
          .eq('business_id', businessId)
          .eq('is_active', true)
          .lte('stock_quantity', 5)
          .gt('stock_quantity', 0)
          .eq('tipo', 'product'),

        // 6. Movimientos de la caja activa (solo si hay caja abierta)
        cajaKey
          ? supabase
              .from('financial_movements')
              .select('type, amount_ars, metodo_pago')
              .eq('business_id', businessId)
              .eq('caja_id', cajaKey)
          : Promise.resolve({ data: [] as { type: string; amount_ars: number | null; metodo_pago: string | null }[], error: null }),
      ])

      if (!mountedRef.current) return

      // ── Ventas semana / mes ───────────────────────────────────────────
      const ventasSemana = (cpSemana.data || []).reduce((s, r) => s + (r.amount_ars || 0), 0)
      const ventasMes    = (cpMes.data    || []).reduce((s, r) => s + (r.amount_ars || 0), 0)

      // ── CC ────────────────────────────────────────────────────────────
      const ccClientesDeuda    = (ccClientes.data   || []).reduce((s, a) => s + Number(a.balance || 0), 0)
      const ccProveedoresDeuda = (ccProveedores.data || []).reduce((s, a) => s + Number(a.balance || 0), 0)

      // ── Stock bajo ────────────────────────────────────────────────────
      const stockBajoCount = stockBajo.count ?? 0

      // ── Caja activa — movimientos por caja_id ─────────────────────────
      // Si no hay caja abierta (cajaKey = null) fmCaja.data es [] y todos los totales quedan en 0.
      const fmRows = fmCaja.data || []
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

      // "Cobrado en caja" = total de ingresos de la sesión actual
      const ventasHoy = cajaIncome

      // Desglose por método de pago (solo ingresos, para el breakdown)
      const paymentMethods: PaymentMethodStat[] = Array.from(cajaMethodMap.entries())
        .filter(([, v]) => v.income > 0)
        .map(([method, { income }]) => ({
          method,
          label:  methodMeta(method).label,
          color:  methodMeta(method).color,
          amount: income,
          count:  0,
          pct:    cajaIncome > 0 ? (income / cajaIncome) * 100 : 0,
        }))
        .sort((a, b) => b.amount - a.amount)

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

      const result: FinancialDashboardData = {
        ventasHoy,
        ventasSemana,
        ventasMes,
        paymentMethods,
        ccClientesDeuda,
        ccProveedoresDeuda,
        caja,
        cajaAbierta: cajaKey !== null,
        stockBajoCount,
      }

      cache = { data: result, businessId, openCajaId: cajaKey, timestamp: Date.now() }
      if (mountedRef.current) { setData(result); setLoading(false) }

    } catch (e) {
      console.error('[useFinancialDashboard]', e)
      if (mountedRef.current) setLoading(false)
    }
  }, [businessId, cajaKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    mountedRef.current = true
    load()
    return () => { mountedRef.current = false }
  }, [load])

  return { data, loading, refresh: () => { cache = null; load(true) } }
}
