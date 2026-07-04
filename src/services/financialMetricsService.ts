/**
 * financialMetricsService — Fuente única de verdad financiera
 *
 * FÓRMULA OFICIAL:
 *   Ingresos del período  (TODOS los ingresos BFE del período — caja base)
 *   - Costos variables
 *   = Margen bruto
 *
 *   Margen bruto
 *   - Costos fijos del local
 *   - Sueldos y retiros
 *   - Costos fijos personales
 *   = Resultado financiero real (resultadoNeto)
 *
 * DECISIÓN DE DISEÑO:
 *   Los ingresos = TODOS los BFE de tipo 'income' en el período.
 *   Un pago recibido contra un comprobante draft es IGUAL de real que
 *   uno contra un comprobante emitido. El status del comprobante no
 *   determina si el dinero entró — la BFE entry sí lo confirma.
 *
 *   También se calcula opProfit (margen de operaciones desde
 *   comprobante_items). Es una métrica complementaria, no un sustituto.
 */

import { supabase } from '../lib/supabase'
import { todayAR } from '../utils/dateUtils'
import { logger } from '../lib/logger'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FinancialSummary {
  // P&L desde business_finance_entries (caja base)
  ingresosPeriodo:       number
  costosVariables:       number
  margenBruto:           number
  margenBrutoPct:        number
  costosFijosLocal:      number
  sueldosRetiros:        number
  costosFijosPersonales: number
  resultadoNeto:         number
  resultadoNetoPct:      number

  // Margen de operaciones desde comprobante_items (métrica complementaria)
  opRevenue:    number
  opCogs:       number
  opCommissions:number
  opProfit:     number
  opMarginPct:  number
  opItemsCount: number

  // Desglose minorista / mayorista
  opRevenueRetail:    number
  opRevenueMayorista: number
  opProfitRetail:     number
  opProfitMayorista:  number

  // Debug — visible en consola [Finance] Resumen unificado:
  _debug: {
    fromDate:       string
    toDate:         string
    bfeIncomeTotal: number
    bfeVariableCost:number
    bfeFixedLocal:  number
    bfeSalary:      number
    bfePersonal:    number
    bfeEntries:     number
    compIssuedInPeriod: number
    compItemsCount: number
  }
}

// ─── Servicio principal ───────────────────────────────────────────────────────

/**
 * Etapa 1 — Fuente ÚNICA: RPC canónica finance_dashboard_summary (v2), que lee
 * las vistas v_finance_* (rentabilidad devengada por ítems; retiros/compras
 * FUERA del P&L). Ya NO se agrega en JS ni se suma BFE income/variable_cost.
 *
 * Se conserva la interfaz FinancialSummary para no romper los consumidores
 * (Finance.tsx, useDashboardStats). El mapeo:
 *   ingresosPeriodo  ← profitability.net_sales      (devengado, NO cobros)
 *   costosVariables  ← profitability.cogs           (de items, una sola vez)
 *   margenBruto      ← profitability.gross_profit
 *   costosFijosLocal ← operating_expenses           (SIN compras/proveedor)
 *   sueldosRetiros   ← employee_salaries            (SIN retiros del dueño)
 *   costosFijosPersonales ← 0                        (personal = capital, no P&L)
 *   resultadoNeto    ← operating_result
 */
export async function getFinancialSummary(
  businessId: string,
  from?: string,
  to?:   string,
): Promise<FinancialSummary> {
  const today        = todayAR()
  const firstOfMonth = today.slice(0, 7) + '-01'
  const dateFrom     = from ?? firstOfMonth
  const dateTo       = to   ?? today

  const { data, error } = await supabase.rpc('finance_dashboard_summary', {
    p_business_id: businessId,
    p_date_from:   dateFrom,
    p_date_to:     dateTo,
  })

  if (error || !data?.ok) {
    logger.error('FINANCE', 'finance_dashboard_summary v2 error', error?.message || data?.error)
    return emptyFinancialSummary(dateFrom, dateTo)
  }

  const p   = data.profitability || {}
  const num = (v: any) => Number(v) || 0

  const ingresosPeriodo       = num(p.net_sales)
  const costosVariables       = num(p.cogs)
  const margenBruto           = num(p.gross_profit)
  const margenBrutoPct        = num(p.gross_margin_pct)
  const costosFijosLocal      = num(p.operating_expenses)
  const sueldosRetiros        = num(p.employee_salaries)   // solo empleados
  const costosFijosPersonales = 0                          // capital, fuera del P&L
  const resultadoNeto         = num(p.operating_result)
  const resultadoNetoPct      = ingresosPeriodo > 0 ? (resultadoNeto / ingresosPeriodo) * 100 : 0

  // opProfit ahora ES el margen devengado canónico (mismas cifras que arriba).
  const opRevenue   = ingresosPeriodo
  const opCogs      = costosVariables
  const opCommissions = num(p.payment_fees)
  const opProfit    = margenBruto
  const opMarginPct = margenBrutoPct

  return {
    ingresosPeriodo, costosVariables, margenBruto, margenBrutoPct,
    costosFijosLocal, sueldosRetiros, costosFijosPersonales, resultadoNeto, resultadoNetoPct,
    opRevenue, opCogs, opCommissions, opProfit, opMarginPct, opItemsCount: 0,
    opRevenueRetail: opRevenue, opRevenueMayorista: 0,
    opProfitRetail: opProfit, opProfitMayorista: 0,
    _debug: {
      fromDate: dateFrom, toDate: dateTo,
      bfeIncomeTotal: ingresosPeriodo, bfeVariableCost: costosVariables,
      bfeFixedLocal: costosFijosLocal, bfeSalary: sueldosRetiros, bfePersonal: 0,
      bfeEntries: 0, compIssuedInPeriod: 0, compItemsCount: 0,
    },
  }
}

function emptyFinancialSummary(from: string, to: string): FinancialSummary {
  return {
    ingresosPeriodo: 0, costosVariables: 0, margenBruto: 0, margenBrutoPct: 0,
    costosFijosLocal: 0, sueldosRetiros: 0, costosFijosPersonales: 0, resultadoNeto: 0, resultadoNetoPct: 0,
    opRevenue: 0, opCogs: 0, opCommissions: 0, opProfit: 0, opMarginPct: 0, opItemsCount: 0,
    opRevenueRetail: 0, opRevenueMayorista: 0, opProfitRetail: 0, opProfitMayorista: 0,
    _debug: { fromDate: from, toDate: to, bfeIncomeTotal: 0, bfeVariableCost: 0, bfeFixedLocal: 0, bfeSalary: 0, bfePersonal: 0, bfeEntries: 0, compIssuedInPeriod: 0, compItemsCount: 0 },
  }
}
