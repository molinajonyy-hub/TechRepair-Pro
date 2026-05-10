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

export async function getFinancialSummary(
  businessId: string,
  from?: string,
  to?:   string,
): Promise<FinancialSummary> {
  const today        = todayAR()
  const firstOfMonth = today.slice(0, 7) + '-01'
  const dateFrom     = from ?? firstOfMonth
  const dateTo       = to   ?? today
  const tzSuffix     = '-03:00'

  // ── 1. INGRESOS Y COSTOS desde business_finance_entries ──────────────────
  // Usamos TODOS los BFE income del período sin filtrar por status del comprobante.
  // Un BFE income entry = dinero confirmado en caja, independientemente del
  // estado del comprobante relacionado.
  const { data: bfeData, error: bfeErr } = await supabase
    .from('business_finance_entries')
    .select('type, amount_ars')
    .eq('business_id', businessId)
    .gte('date', dateFrom)
    .lte('date', dateTo)

  if (bfeErr) {
    console.error('[financialMetricsService] BFE query error:', bfeErr)
  }

  const bfe = bfeData || []

  let bfeIncomeTotal  = 0
  let bfeVariableCost = 0
  let bfeFixedLocal   = 0
  let bfeSalary       = 0
  let bfePersonal     = 0

  for (const e of bfe) {
    const amt = Number(e.amount_ars) || 0
    switch (e.type) {
      case 'income':              bfeIncomeTotal  += amt; break
      case 'variable_cost':       bfeVariableCost += amt; break
      case 'fixed_cost_local':    bfeFixedLocal   += amt; break
      case 'salary':              bfeSalary       += amt; break
      case 'fixed_cost_personal': bfePersonal     += amt; break
    }
  }

  // ── 2. P&L COMPLETO (fórmula oficial) ────────────────────────────────────
  const ingresosPeriodo       = bfeIncomeTotal
  const costosVariables       = bfeVariableCost
  const margenBruto           = ingresosPeriodo - costosVariables
  const margenBrutoPct        = ingresosPeriodo > 0 ? (margenBruto / ingresosPeriodo) * 100 : 0
  const costosFijosLocal      = bfeFixedLocal
  const sueldosRetiros        = bfeSalary
  const costosFijosPersonales = bfePersonal
  const resultadoNeto         = margenBruto - costosFijosLocal - sueldosRetiros - costosFijosPersonales
  const resultadoNetoPct      = ingresosPeriodo > 0 ? (resultadoNeto / ingresosPeriodo) * 100 : 0

  // ── 3. MARGEN DE OPERACIONES desde comprobante_items ─────────────────────
  // Métrica complementaria: ganancia bruta a nivel de ítem vendido.
  // Solo incluye comprobantes emitidos (status = 'issued') en el período.
  const { data: issuedCompsData } = await supabase
    .from('comprobantes')
    .select('id')
    .eq('business_id', businessId)
    .eq('status', 'issued')
    .gte('created_at', dateFrom + 'T00:00:00' + tzSuffix)
    .lte('created_at', dateTo   + 'T23:59:59' + tzSuffix)

  const issuedIdsInPeriod = new Set((issuedCompsData || []).map((c: any) => c.id))

  const [itemsRes, commissionsRes] = await Promise.all([
    supabase
      .from('comprobante_items')
      .select('comprobante_id, precio_unitario, costo_unitario, cantidad, descuento_linea, applied_price_type')
      .eq('business_id', businessId)
      .in('tipo_linea', ['producto', 'repuesto', 'servicio', 'otro']),

    supabase
      .from('comprobante_payments')
      .select('comprobante_id, commission_amount')
      .eq('business_id', businessId)
      .gt('commission_amount', 0)
      .gte('date', dateFrom)
      .lte('date', dateTo),
  ])

  const items = (itemsRes.data || []).filter((ci: any) => issuedIdsInPeriod.has(ci.comprobante_id))
  const opCommissions = (commissionsRes.data || [])
    .filter((p: any) => issuedIdsInPeriod.has(p.comprobante_id))
    .reduce((s: number, p: any) => s + (Number(p.commission_amount) || 0), 0)

  let opRevenue = 0, opCogs = 0
  let opRevenueRetail = 0, opRevenueMayorista = 0
  let opCogsRetail    = 0, opCogsMayorista    = 0

  for (const ci of items) {
    const disc    = Math.min(ci.descuento_linea || 0, 100) / 100
    const rev     = (Number(ci.precio_unitario) || 0) * (Number(ci.cantidad) || 0) * (1 - disc)
    const cogs    = (Number(ci.costo_unitario)  || 0) * (Number(ci.cantidad) || 0)
    opRevenue    += rev
    opCogs       += cogs
    if (ci.applied_price_type === 'mayorista') {
      opRevenueMayorista += rev; opCogsMayorista += cogs
    } else {
      opRevenueRetail    += rev; opCogsRetail    += cogs
    }
  }
  const opProfit          = opRevenue - opCogs - opCommissions
  const opMarginPct       = opRevenue > 0 ? (opProfit / opRevenue) * 100 : 0
  const opProfitRetail    = opRevenueRetail    - opCogsRetail
  const opProfitMayorista = opRevenueMayorista - opCogsMayorista

  const result: FinancialSummary = {
    ingresosPeriodo,
    costosVariables,
    margenBruto,
    margenBrutoPct,
    costosFijosLocal,
    sueldosRetiros,
    costosFijosPersonales,
    resultadoNeto,
    resultadoNetoPct,
    opRevenue,
    opCogs,
    opCommissions,
    opRevenueRetail,
    opRevenueMayorista,
    opProfitRetail,
    opProfitMayorista,
    opProfit,
    opMarginPct,
    opItemsCount: items.length,
    _debug: {
      fromDate:           dateFrom,
      toDate:             dateTo,
      bfeIncomeTotal,
      bfeVariableCost,
      bfeFixedLocal,
      bfeSalary,
      bfePersonal,
      bfeEntries:         bfe.length,
      compIssuedInPeriod: issuedIdsInPeriod.size,
      compItemsCount:     items.length,
    },
  }

  console.log('[financialMetricsService] Resumen:', {
    periodo:     `${dateFrom} → ${dateTo}`,
    ingresos:    ingresosPeriodo,
    costsVar:    costosVariables,
    margenBruto,
    costosFijos: costosFijosLocal,
    sueldos:     sueldosRetiros,
    personal:    costosFijosPersonales,
    resultNeto:  resultadoNeto,
    opProfit,
    bfeEntries:  bfe.length,
    compIssued:  issuedIdsInPeriod.size,
  })

  return result
}
