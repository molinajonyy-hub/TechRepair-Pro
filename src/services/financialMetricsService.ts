/**
 * financialMetricsService — Fuente única de verdad financiera
 *
 * FÓRMULA OFICIAL:
 *   Ingresos del período                     (solo comprobantes EMITIDOS + manuales)
 *   - Costos variables                        (mercadería, repuestos, comisiones)
 *   = Margen bruto
 *
 *   Margen bruto
 *   - Costos fijos del local
 *   - Sueldos y retiros
 *   - Costos fijos personales
 *   = Resultado financiero real (netResult)
 *
 * FUENTE DE DATOS:
 *   business_finance_entries filtrando income de comprobantes DRAFT
 *   → evita inflar ingresos con borradores no cobrados
 *
 * USO: cualquier tarjeta de "ganancia" debe llamar a getFinancialSummary()
 * con los mismos parámetros para mostrar el mismo número.
 */

import { supabase } from '../lib/supabase'
import { todayAR } from '../utils/dateUtils'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FinancialSummary {
  // Ingresos
  ingresosPeriodo:       number

  // Costos
  costosVariables:       number
  margenBruto:           number
  margenBrutoPct:        number

  // Estructura de costos
  costosFijosLocal:      number
  sueldosRetiros:        number
  costosFijosPersonales: number

  // Resultado final
  resultadoNeto:         number
  resultadoNetoPct:      number  // % sobre ingresos

  // Métricas de operaciones (comprobante_items, más granular)
  opRevenue:             number
  opCogs:                number
  opCommissions:         number
  opProfit:              number   // revenue - cogs - commissions
  opMarginPct:           number
  opItemsCount:          number

  // Debug
  _debug: {
    fromDate: string
    toDate:   string
    bfeIncome:         number
    bfeIncomeDraft:    number  // cuánto venía de drafts (debería ser 0)
    bfeIncomeIssued:   number
    bfeVariableCost:   number
    bfeFixedLocal:     number
    bfeSalary:         number
    bfePersonal:       number
    comprobantesIssued: number
    compItemsCount:    number
  }
}

// ─── Query helper ─────────────────────────────────────────────────────────────

export async function getFinancialSummary(
  businessId: string,
  from?: string,   // 'YYYY-MM-DD', default = primer día del mes actual
  to?:   string,   // 'YYYY-MM-DD', default = hoy
): Promise<FinancialSummary> {
  const today = todayAR()
  const firstOfMonth = today.slice(0, 7) + '-01'
  const dateFrom = from ?? firstOfMonth
  const dateTo   = to   ?? today
  const tzSuffix = '-03:00'

  // ── 1. Comprobantes emitidos del negocio (SIN filtro de fecha) ────────────
  // No filtramos por fecha aquí porque la BFE entry puede tener fecha distinta
  // al comprobante (el pago puede registrarse en un día diferente a la emisión).
  // El período ya lo controla el filtro de fecha sobre las entradas BFE.
  const { data: issuedComps } = await supabase
    .from('comprobantes')
    .select('id')
    .eq('business_id', businessId)
    .eq('status', 'issued')

  const issuedIds = new Set((issuedComps || []).map((c: any) => c.id))

  // ── 2. Todas las entradas BFE del período ─────────────────────────────────
  const { data: allBfe } = await supabase
    .from('business_finance_entries')
    .select('type, amount_ars, reference_comprobante_id')
    .eq('business_id', businessId)
    .gte('date', dateFrom)
    .lte('date', dateTo)

  const bfe = allBfe || []

  // Separar income según si el comprobante está emitido o en borrador
  let bfeIncomeIssued   = 0
  let bfeIncomeDraft    = 0
  let bfeIncomeManual   = 0  // income sin referencia a comprobante
  let bfeVariableCost   = 0
  let bfeFixedLocal     = 0
  let bfeSalary         = 0
  let bfePersonal       = 0

  for (const e of bfe) {
    const amt = e.amount_ars || 0
    switch (e.type) {
      case 'income':
        if (!e.reference_comprobante_id) {
          bfeIncomeManual += amt
        } else if (issuedIds.has(e.reference_comprobante_id)) {
          bfeIncomeIssued += amt
        } else {
          bfeIncomeDraft += amt   // draft: no cuenta como ingreso real
        }
        break
      case 'variable_cost':     bfeVariableCost += amt; break
      case 'fixed_cost_local':  bfeFixedLocal   += amt; break
      case 'salary':            bfeSalary       += amt; break
      case 'fixed_cost_personal': bfePersonal   += amt; break
    }
  }

  // Ingresos reales = emitidos + manuales (excluye drafts)
  const ingresosPeriodo = bfeIncomeIssued + bfeIncomeManual

  // ── 3. Cálculo completo (fórmula oficial) ─────────────────────────────────
  const costosVariables       = bfeVariableCost
  const margenBruto           = ingresosPeriodo - costosVariables
  const margenBrutoPct        = ingresosPeriodo > 0 ? (margenBruto / ingresosPeriodo) * 100 : 0
  const costosFijosLocal      = bfeFixedLocal
  const sueldosRetiros        = bfeSalary
  const costosFijosPersonales = bfePersonal
  const resultadoNeto         = margenBruto - costosFijosLocal - sueldosRetiros - costosFijosPersonales
  const resultadoNetoPct      = ingresosPeriodo > 0 ? (resultadoNeto / ingresosPeriodo) * 100 : 0

  // ── 4. Métricas de operaciones desde comprobante_items ────────────────────
  // Filtramos comprobante_items por el período usando la fecha del comprobante
  // (created_at del comprobante, que es cuando se emitió la venta)
  const [itemsRes, commissionsRes] = await Promise.all([
    supabase
      .from('comprobante_items')
      .select('comprobante_id, precio_unitario, costo_unitario, cantidad, descuento_linea')
      .eq('business_id', businessId)
      .in('tipo_linea', ['producto', 'repuesto', 'servicio', 'otro']),

    supabase
      .from('comprobante_payments')
      .select('comprobante_id, commission_amount, date')
      .eq('business_id', businessId)
      .gt('commission_amount', 0)
      .gte('date', dateFrom)
      .lte('date', dateTo),
  ])

  // Filtrar items: solo los de comprobantes emitidos Y dentro del período
  // (usamos created_at del comprobante, buscando en el Set de IDs dentro del rango)
  const { data: issuedCompsInPeriod } = await supabase
    .from('comprobantes')
    .select('id')
    .eq('business_id', businessId)
    .eq('status', 'issued')
    .gte('created_at', dateFrom + 'T00:00:00' + tzSuffix)
    .lte('created_at', dateTo   + 'T23:59:59' + tzSuffix)

  const issuedIdsInPeriod = new Set((issuedCompsInPeriod || []).map((c: any) => c.id))

  const items = (itemsRes.data || []).filter((ci: any) => issuedIdsInPeriod.has(ci.comprobante_id))
  const opCommissions = (commissionsRes.data || [])
    .filter((p: any) => issuedIds.has(p.comprobante_id))
    .reduce((s: number, p: any) => s + (p.commission_amount || 0), 0)

  let opRevenue = 0, opCogs = 0
  for (const ci of items) {
    const disc = Math.min(ci.descuento_linea || 0, 100) / 100
    opRevenue += (ci.precio_unitario || 0) * (ci.cantidad || 0) * (1 - disc)
    opCogs    += (ci.costo_unitario  || 0) * (ci.cantidad || 0)
  }
  const opProfit    = opRevenue - opCogs - opCommissions
  const opMarginPct = opRevenue > 0 ? (opProfit / opRevenue) * 100 : 0

  return {
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
    opProfit,
    opMarginPct,
    opItemsCount: items.length,
    _debug: {
      fromDate:          dateFrom,
      toDate:            dateTo,
      bfeIncome:         bfeIncomeIssued + bfeIncomeDraft + bfeIncomeManual,
      bfeIncomeDraft,
      bfeIncomeIssued,
      bfeVariableCost,
      bfeFixedLocal,
      bfeSalary,
      bfePersonal,
      comprobantesIssuedTotal:    issuedIds.size,
      comprobantesIssuedPeriodo:  issuedIdsInPeriod.size,
      compItemsCount:             items.length,
    },
  }
}
