import { AlertCircle, Calendar, ClipboardList, DollarSign, Download, Package, TrendingUp, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useDashboardStats } from '../hooks/useDashboardStats'
import { supabase } from '../lib/supabase'
import { Loader } from '../components/ui/Loader'
import { SimpleBarChart } from '../components/charts/SimpleBarChart'
import { SimplePieChart } from '../components/charts/SimplePieChart'
import { inventoryReportsService } from '../services/inventoryReportsService'
import { inventoryService } from '../services/inventoryService'
import { STATUS_CONFIG } from '../types/orderStatus'
import { COST_RESTRICTED_LABEL } from '../services/inventoryCostAccess'
import {
  addCalendarDays, addCalendarMonths, businessDateOfInstant, businessDayStartInstant,
  businessToday, calendarWeekday, firstDayOfMonth, formatCalendarDate,
} from '../lib/businessDate'

type ReportsPeriod = 'today' | 'week' | 'month' | 'quarter' | 'year'

type ChartPoint = {
  label: string
  value: number
  color: string
}

type ReportSnapshot = {
  revenueCurrent: number
  revenuePrevious: number
  completedOrdersCurrent: number
  completedOrdersPrevious: number
  newCustomersCurrent: number
  newCustomersPrevious: number
  lowStockCount: number
  outOfStockCount: number
  /** SEC-08B: null = costo restringido para este actor. Se muestra «—», nunca 0. */
  inventoryValue: number | null
  revenueSeries: ChartPoint[]
  revenueSeriesTitle: string
  deviceTypesData: ChartPoint[]
  topTechnicians: ChartPoint[]
  comparisonLabel: string
  periodLabel: string
}

type PaymentRow = {
  amount?: number | null
  payment_date?: string | null
}

type CompletedOrderRow = {
  updated_at?: string | null
}

// PRE-BETA-1: el ranking de técnicos embebía `technician:users(name)` por
// `orders.technician_id`. `public.users` es legacy/global y salió de la API (el
// embed ahora hace fallar TODA la consulta con 42501), y `technician_id` está en
// NULL en el 100% de las órdenes: el agrupado ya caía siempre acá. Atribuir por
// `assigned_profile_id` es un lote aparte.
const UNASSIGNED_TECHNICIAN_LABEL = 'Sin asignar'

type DeviceRow = {
  type?: string | null
}

interface SupabaseQueryError {
  code?: string
  message?: string
  status?: number
}

const REPORT_COLORS = ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']

const PERIOD_OPTIONS: Array<{ value: ReportsPeriod; label: string }> = [
  { value: 'today', label: 'Hoy' },
  { value: 'week', label: 'Esta Semana' },
  { value: 'month', label: 'Este Mes' },
  { value: 'quarter', label: 'Este Trimestre' },
  { value: 'year', label: 'Este Ano' },
]

const isPermissionError = (error: SupabaseQueryError | null | undefined) => {
  if (!error) {
    return false
  }

  const message = error.message?.toLowerCase() || ''

  return (
    error.status === 401 ||
    error.status === 403 ||
    message.includes('permission denied') ||
    message.includes('row-level security') ||
    message.includes('not allowed')
  )
}

const isMissingColumnError = (error: SupabaseQueryError | null | undefined) => {
  if (!error) {
    return false
  }

  const message = error.message?.toLowerCase() || ''
  return error.code === '42703' || (message.includes('column') && message.includes('does not exist'))
}

// ─── Períodos en FECHA DE NEGOCIO argentina ──────────────────────────────────
// Todo límite es una fecha de calendario 'YYYY-MM-DD' (src/lib/businessDate.ts)
// y todo rango es semiabierto [start, end). Nada sale de la zona del browser.
//   · order_payments.payment_date es DATE: se filtra y se agrupa por fecha.
//   · orders.updated_at, customers.created_at y devices.created_at son
//     timestamptz: el límite es las 00:00 AR de la fecha
//     (businessDayStartInstant) y cada fila se lleva a su día de negocio
//     (businessDateOfInstant) antes de comparar.

/** Lunes de la semana de `fecha` (Reportes cuenta la semana de lunes a domingo). */
const startOfWeek = (fecha: string) => addCalendarDays(fecha, -((calendarWeekday(fecha) + 6) % 7))

const startOfQuarter = (fecha: string) => {
  const primero = firstDayOfMonth(fecha)
  return addCalendarMonths(primero, -((Number(primero.slice(5, 7)) - 1) % 3))
}

const startOfYear = (fecha: string) => addCalendarMonths(firstDayOfMonth(fecha), -(Number(fecha.slice(5, 7)) - 1))

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0)

const formatDateTime = (value: Date) =>
  value.toLocaleString('es-AR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

const formatDifference = (current: number, previous: number, kind: 'currency' | 'count') => {
  const diff = current - previous

  if (kind === 'currency') {
    const prefix = diff > 0 ? '+' : diff < 0 ? '-' : ''
    return `${prefix}${formatCurrency(Math.abs(diff))}`
  }

  return `${diff > 0 ? '+' : ''}${diff}`
}

const hasNonZeroValues = (data: ChartPoint[]) => data.some((item) => item.value > 0)

const getExportRows = (
  data: ChartPoint[],
  formatter?: (value: number) => string
) => {
  if (data.length === 0) {
    return [['Sin datos', '-']]
  }

  return data.map((item) => [
    item.label,
    formatter ? formatter(item.value) : item.value.toString(),
  ])
}


const getPeriodRange = (period: ReportsPeriod, hoy: string) => {
  switch (period) {
    case 'today': {
      const start = hoy
      return {
        currentStart: start,
        currentEnd: addCalendarDays(start, 1),
        previousStart: addCalendarDays(start, -1),
        previousEnd: start,
        comparisonLabel: 'vs ayer',
        periodLabel: 'hoy',
      }
    }
    case 'week': {
      const start = startOfWeek(hoy)
      return {
        currentStart: start,
        currentEnd: addCalendarDays(start, 7),
        previousStart: addCalendarDays(start, -7),
        previousEnd: start,
        comparisonLabel: 'vs semana anterior',
        periodLabel: 'esta semana',
      }
    }
    case 'month': {
      const start = firstDayOfMonth(hoy)
      return {
        currentStart: start,
        currentEnd: addCalendarMonths(start, 1),
        previousStart: addCalendarMonths(start, -1),
        previousEnd: start,
        comparisonLabel: 'vs mes anterior',
        periodLabel: 'este mes',
      }
    }
    case 'quarter': {
      const start = startOfQuarter(hoy)
      return {
        currentStart: start,
        currentEnd: addCalendarMonths(start, 3),
        previousStart: addCalendarMonths(start, -3),
        previousEnd: start,
        comparisonLabel: 'vs trimestre anterior',
        periodLabel: 'este trimestre',
      }
    }
    case 'year': {
      const start = startOfYear(hoy)
      return {
        currentStart: start,
        currentEnd: addCalendarMonths(start, 12),
        previousStart: addCalendarMonths(start, -12),
        previousEnd: start,
        comparisonLabel: 'vs ano anterior',
        periodLabel: 'este ano',
      }
    }
  }
}

type RevenueBucket = { start: string; end: string; label: string }

const monthLabel = (fecha: string) => formatCalendarDate(fecha, { month: 'short' }).replace('.', '')

const buildRevenueBuckets = (period: ReportsPeriod, hoy: string): { title: string; buckets: RevenueBucket[] } => {
  if (period === 'today') {
    const start = addCalendarDays(hoy, -6)

    return {
      title: 'Ingresos ultimos 7 dias',
      buckets: Array.from({ length: 7 }, (_, index) => {
        const bucketStart = addCalendarDays(start, index)

        return {
          start: bucketStart,
          end: addCalendarDays(bucketStart, 1),
          label: formatCalendarDate(bucketStart, { day: '2-digit', month: 'short' }),
        }
      }),
    }
  }

  if (period === 'week') {
    const start = startOfWeek(hoy)

    return {
      title: 'Ingresos por dia',
      buckets: Array.from({ length: 7 }, (_, index) => {
        const bucketStart = addCalendarDays(start, index)

        return {
          start: bucketStart,
          end: addCalendarDays(bucketStart, 1),
          label: formatCalendarDate(bucketStart, { weekday: 'short' }).replace('.', ''),
        }
      }),
    }
  }

  if (period === 'month') {
    const start = firstDayOfMonth(hoy)
    const end = addCalendarMonths(start, 1)
    const buckets: RevenueBucket[] = []
    let cursor = start
    let bucketNumber = 1

    while (cursor < end) {
      const bucketStart = cursor
      const bucketEnd = addCalendarDays(bucketStart, 7) < end ? addCalendarDays(bucketStart, 7) : end

      buckets.push({
        start: bucketStart,
        end: bucketEnd,
        label: `Sem ${bucketNumber}`,
      })

      cursor = bucketEnd
      bucketNumber += 1
    }

    return {
      title: 'Ingresos por semana',
      buckets,
    }
  }

  if (period === 'quarter') {
    const start = startOfQuarter(hoy)

    return {
      title: 'Ingresos por mes',
      buckets: Array.from({ length: 3 }, (_, index) => {
        const bucketStart = addCalendarMonths(start, index)

        return {
          start: bucketStart,
          end: addCalendarMonths(bucketStart, 1),
          label: monthLabel(bucketStart),
        }
      }),
    }
  }

  const start = startOfYear(hoy)
  return {
    title: 'Ingresos por mes',
    buckets: Array.from({ length: 12 }, (_, index) => {
      const bucketStart = addCalendarMonths(start, index)

      return {
        start: bucketStart,
        end: addCalendarMonths(bucketStart, 1),
        label: monthLabel(bucketStart),
      }
    }),
  }
}

/** `payment_date` es un DATE: se compara la fecha tal cual, sin construir un Date. */
const sumPaymentsBetween = (payments: PaymentRow[], start: string, end: string) =>
  payments.reduce((sum, payment) => {
    const paymentDate = payment.payment_date?.slice(0, 10)
    if (paymentDate && paymentDate >= start && paymentDate < end) {
      return sum + (payment.amount || 0)
    }

    return sum
  }, 0)

/** Instantes (timestamptz) contados por su día de negocio argentino. */
const countDatesBetween = (dates: string[], start: string, end: string) =>
  dates.filter((value) => {
    const businessDate = businessDateOfInstant(value)
    return businessDate >= start && businessDate < end
  }).length

async function loadCustomerCountForRange(businessId: string, start: string, end: string) {
  const runQuery = async (scopedByBusiness: boolean) => {
    let query = supabase
      .from('customers')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', businessDayStartInstant(start))
      .lt('created_at', businessDayStartInstant(end))

    if (scopedByBusiness) {
      query = query.eq('business_id', businessId)
    }

    return await query
  }

  const scopedResult = await runQuery(true)

  if (!scopedResult.error) {
    return scopedResult.count || 0
  }

  if (isMissingColumnError(scopedResult.error)) {
    const fallbackResult = await runQuery(false)

    if (!fallbackResult.error) {
      return fallbackResult.count || 0
    }

    if (isPermissionError(fallbackResult.error)) {
      return 0
    }

    throw fallbackResult.error
  }

  if (isPermissionError(scopedResult.error)) {
    return 0
  }

  throw scopedResult.error
}

export function Reports() {
  const [selectedPeriod, setSelectedPeriod] = useState<ReportsPeriod>('month')
  const [reportData, setReportData] = useState<ReportSnapshot | null>(null)
  const [reportLoading, setReportLoading] = useState(true)
  const [reportError, setReportError] = useState<string | null>(null)
  const [exportLoading, setExportLoading] = useState(false)

  const { businessId, isAuthenticated, hasBusinessAccess, loading: authLoading, profileLoading } = useAuth()
  const { stats, loading: statsLoading, error: statsError } = useDashboardStats()

  useEffect(() => {
    if (authLoading || profileLoading) {
      setReportLoading(true)
      return
    }

    if (!isAuthenticated || !hasBusinessAccess || !businessId) {
      setReportData(null)
      setReportError(null)
      setReportLoading(false)
      return
    }

    const loadReports = async () => {
      try {
        setReportLoading(true)
        setReportError(null)

        const hoy = businessToday()
        const periodRange = getPeriodRange(selectedPeriod, hoy)
        const revenueConfig = buildRevenueBuckets(selectedPeriod, hoy)
        const earliestStart = revenueConfig.buckets[0]?.start || periodRange.previousStart
        const queryStart = earliestStart < periodRange.previousStart ? earliestStart : periodRange.previousStart
        const queryEnd = revenueConfig.buckets[revenueConfig.buckets.length - 1]?.end || periodRange.currentEnd

        const [
          paymentsResult,
          completedOrdersResult,
          currentCustomersResult,
          previousCustomersResult,
          lowStockResult,
          outOfStockResult,
          inventoryValueResult,
          devicesResult,
        ] = await Promise.allSettled([
          supabase
            .from('order_payments')
            .select('amount, payment_date, orders!inner(business_id)')
            .eq('orders.business_id', businessId)
            .gte('payment_date', queryStart)
            .lt('payment_date', queryEnd),
          supabase
            .from('orders')
            .select('updated_at')
            .eq('business_id', businessId)
            .eq('status', 'completed')
            .gte('updated_at', businessDayStartInstant(periodRange.previousStart))
            .lt('updated_at', businessDayStartInstant(periodRange.currentEnd)),
          loadCustomerCountForRange(businessId, periodRange.currentStart, periodRange.currentEnd),
          loadCustomerCountForRange(businessId, periodRange.previousStart, periodRange.previousEnd),
          inventoryService.getLowStockItems(businessId),
          inventoryService.getOutOfStockItems(businessId),
          inventoryReportsService.calculateTotalValue(businessId),
          supabase
            .from('devices')
            .select('type, created_at, customers!inner(business_id)')
            .eq('customers.business_id', businessId)
            .gte('created_at', businessDayStartInstant(periodRange.currentStart))
            .lt('created_at', businessDayStartInstant(periodRange.currentEnd)),
        ])

        const payments = paymentsResult.status === 'fulfilled' && !paymentsResult.value.error
          ? ((paymentsResult.value.data || []) as PaymentRow[])
          : []

        const completedOrders = completedOrdersResult.status === 'fulfilled' && !completedOrdersResult.value.error
          ? ((completedOrdersResult.value.data || []) as CompletedOrderRow[])
          : []

        const revenueCurrent = sumPaymentsBetween(payments, periodRange.currentStart, periodRange.currentEnd)
        const revenuePrevious = sumPaymentsBetween(payments, periodRange.previousStart, periodRange.previousEnd)

        const completedOrderDates = completedOrders
          .map((order) => order.updated_at)
          .filter((value): value is string => Boolean(value))

        const completedOrdersCurrent = countDatesBetween(completedOrderDates, periodRange.currentStart, periodRange.currentEnd)
        const completedOrdersPrevious = countDatesBetween(completedOrderDates, periodRange.previousStart, periodRange.previousEnd)

        const topTechniciansMap = completedOrders.reduce<Record<string, number>>((accumulator, order) => {
          if (!order.updated_at) {
            return accumulator
          }

          const updatedAt = businessDateOfInstant(order.updated_at)
          if (updatedAt < periodRange.currentStart || updatedAt >= periodRange.currentEnd) {
            return accumulator
          }

          const label = UNASSIGNED_TECHNICIAN_LABEL
          accumulator[label] = (accumulator[label] || 0) + 1
          return accumulator
        }, {})

        const topTechnicians = Object.entries(topTechniciansMap)
          .sort(([, left], [, right]) => right - left)
          .slice(0, 6)
          .map(([label, value], index) => ({
            label,
            value,
            color: REPORT_COLORS[index % REPORT_COLORS.length],
          }))

        const revenueSeries = revenueConfig.buckets.map((bucket, index) => ({
          label: bucket.label,
          value: sumPaymentsBetween(payments, bucket.start, bucket.end),
          color: REPORT_COLORS[index % REPORT_COLORS.length],
        }))

        let deviceTypesData: ChartPoint[] = []

        if (devicesResult.status === 'fulfilled' && !devicesResult.value.error) {
          const deviceTypeCount = ((devicesResult.value.data || []) as DeviceRow[]).reduce<Record<string, number>>((accumulator, device) => {
            const type = device.type || 'other'
            accumulator[type] = (accumulator[type] || 0) + 1
            return accumulator
          }, {})

          const deviceTypeLabels: Record<string, string> = {
            smartphone: 'Celular', celular: 'Celular',
            tablet: 'Tablet',
            laptop: 'Notebook',
            smartwatch: 'Smartwatch',
            other: 'Otro', otro: 'Otro',
          }
          deviceTypesData = Object.entries(deviceTypeCount)
            .sort(([, left], [, right]) => right - left)
            .slice(0, 5)
            .map(([type, value], index) => ({
              label: deviceTypeLabels[type] || type,
              value,
              color: REPORT_COLORS[index % REPORT_COLORS.length],
            }))
        }

        if (deviceTypesData.length === 0 && stats?.popularDeviceTypes?.length) {
          const deviceTypeLabels: Record<string, string> = {
            smartphone: 'Celular', celular: 'Celular',
            tablet: 'Tablet',
            laptop: 'Notebook',
            smartwatch: 'Smartwatch',
            other: 'Otro', otro: 'Otro',
          }
          deviceTypesData = stats.popularDeviceTypes.map((device, index) => ({
            label: deviceTypeLabels[device.type] || device.type,
            value: device.count,
            color: REPORT_COLORS[index % REPORT_COLORS.length],
          }))
        }

        setReportData({
          revenueCurrent,
          revenuePrevious,
          completedOrdersCurrent,
          completedOrdersPrevious,
          newCustomersCurrent: currentCustomersResult.status === 'fulfilled' ? currentCustomersResult.value : 0,
          newCustomersPrevious: previousCustomersResult.status === 'fulfilled' ? previousCustomersResult.value : 0,
          lowStockCount: lowStockResult.status === 'fulfilled' ? lowStockResult.value.length : 0,
          outOfStockCount: outOfStockResult.status === 'fulfilled' ? outOfStockResult.value.length : 0,
          inventoryValue: inventoryValueResult.status === 'fulfilled' ? inventoryValueResult.value : null,
          revenueSeries,
          revenueSeriesTitle: revenueConfig.title,
          deviceTypesData,
          topTechnicians,
          comparisonLabel: periodRange.comparisonLabel,
          periodLabel: periodRange.periodLabel,
        })

        const failedCoreQueries = [
          paymentsResult.status === 'rejected' || (paymentsResult.status === 'fulfilled' && paymentsResult.value.error),
          completedOrdersResult.status === 'rejected' || (completedOrdersResult.status === 'fulfilled' && completedOrdersResult.value.error),
        ].every(Boolean)

        if (failedCoreQueries) {
          setReportError('No se pudieron cargar las metricas principales del reporte.')
        }
      } catch (err: any) {
        console.error('Error loading reports:', err)
        setReportError(err.message || 'Error al cargar reportes')
      } finally {
        setReportLoading(false)
      }
    }

    void loadReports()
  }, [authLoading, profileLoading, isAuthenticated, hasBusinessAccess, businessId, selectedPeriod, stats])

  const orderStatusData = useMemo<ChartPoint[]>(() => {
    return Object.entries(stats?.ordersByStatus || {})
      .sort(([, left], [, right]) => right - left)
      .map(([status, value]) => ({
        label: STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]?.label || status,
        value,
        color: STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]?.color || REPORT_COLORS[0],
      }))
  }, [stats])

  const statCards = useMemo(() => {
    if (!reportData) {
      return []
    }

    return [
      {
        label: `Ingresos ${reportData.periodLabel}`,
        value: formatCurrency(reportData.revenueCurrent),
        change: `${formatDifference(reportData.revenueCurrent, reportData.revenuePrevious, 'currency')} ${reportData.comparisonLabel}`,
        trend: reportData.revenueCurrent >= reportData.revenuePrevious ? 'up' : 'down',
        icon: DollarSign,
        color: '#10b981',
      },
      {
        label: 'Ordenes completadas',
        value: reportData.completedOrdersCurrent.toString(),
        change: `${formatDifference(reportData.completedOrdersCurrent, reportData.completedOrdersPrevious, 'count')} ${reportData.comparisonLabel}`,
        trend: reportData.completedOrdersCurrent >= reportData.completedOrdersPrevious ? 'up' : 'down',
        icon: ClipboardList,
        color: '#6366f1',
      },
      {
        label: 'Clientes nuevos',
        value: reportData.newCustomersCurrent.toString(),
        change: `${formatDifference(reportData.newCustomersCurrent, reportData.newCustomersPrevious, 'count')} ${reportData.comparisonLabel}`,
        trend: reportData.newCustomersCurrent >= reportData.newCustomersPrevious ? 'up' : 'down',
        icon: Users,
        color: '#06b6d4',
      },
      {
        label: 'Stock bajo',
        value: reportData.lowStockCount.toString(),
        // SEC-08B: sin autoridad de costo el valor no se sustituye por $0 —eso
        // se leería como «inventario sin valor»—, se dice que está restringido.
        change: `${reportData.outOfStockCount} sin stock · ${reportData.inventoryValue === null ? COST_RESTRICTED_LABEL : formatCurrency(reportData.inventoryValue)}`,
        trend: reportData.outOfStockCount === 0 ? 'up' : 'down',
        icon: Package,
        color: '#f59e0b',
      },
    ]
  }, [reportData])

  const loading = authLoading || profileLoading || statsLoading || reportLoading
  const activeError = reportError || (!reportData && statsError ? statsError : null)

  const handleExport = async () => {
    if (!reportData || exportLoading) {
      return
    }

    setExportLoading(true)
    try {
    const [{ jsPDF }, { default: autoTable }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ])

    const generatedAt = new Date()
    const periodLabel = PERIOD_OPTIONS.find((option) => option.value === selectedPeriod)?.label || selectedPeriod
    const summaryRows = [
      ['Ingresos del periodo', formatCurrency(reportData.revenueCurrent), `${formatDifference(reportData.revenueCurrent, reportData.revenuePrevious, 'currency')} ${reportData.comparisonLabel}`],
      ['Ordenes completadas', reportData.completedOrdersCurrent.toString(), `${formatDifference(reportData.completedOrdersCurrent, reportData.completedOrdersPrevious, 'count')} ${reportData.comparisonLabel}`],
      ['Clientes nuevos', reportData.newCustomersCurrent.toString(), `${formatDifference(reportData.newCustomersCurrent, reportData.newCustomersPrevious, 'count')} ${reportData.comparisonLabel}`],
      ['Items con stock bajo', reportData.lowStockCount.toString(), `${reportData.outOfStockCount} sin stock`],
      ['Valor total del inventario', reportData.inventoryValue === null ? COST_RESTRICTED_LABEL : formatCurrency(reportData.inventoryValue), reportData.periodLabel],
    ]

    const doc = new jsPDF()
    doc.setFont('helvetica')

    doc.setFontSize(20)
    doc.setTextColor(79, 70, 229)
    doc.text('TechRepair', 14, 18)

    doc.setFontSize(16)
    doc.setTextColor(15, 23, 42)
    doc.text('Reporte del negocio', 14, 28)

    doc.setFontSize(10)
    doc.setTextColor(100, 116, 139)
    doc.text(`Periodo: ${periodLabel}`, 14, 36)
    doc.text(`Generado: ${formatDateTime(generatedAt)}`, 14, 42)
    doc.text('Fuente: datos sincronizados del sistema', 14, 48)

    autoTable(doc, {
      startY: 56,
      head: [['Metrica', 'Valor', 'Comparacion']],
      body: summaryRows,
      theme: 'striped',
      headStyles: {
        fillColor: [79, 70, 229],
        textColor: 255,
      },
      styles: {
        fontSize: 9,
      },
    })

    const summaryEnd = (doc as any).lastAutoTable?.finalY ?? 56
    doc.setFontSize(12)
    doc.setTextColor(15, 23, 42)
    doc.text(reportData.revenueSeriesTitle, 14, summaryEnd + 12)

    autoTable(doc, {
      startY: summaryEnd + 16,
      head: [['Tramo', 'Ingresos']],
      body: getExportRows(reportData.revenueSeries, formatCurrency),
      theme: 'grid',
      headStyles: {
        fillColor: [16, 185, 129],
        textColor: 255,
      },
      styles: {
        fontSize: 9,
      },
    })

    const revenueEnd = (doc as any).lastAutoTable?.finalY ?? summaryEnd + 16
    doc.setFontSize(12)
    doc.setTextColor(15, 23, 42)
    doc.text('Distribucion actual de ordenes', 14, revenueEnd + 12)

    autoTable(doc, {
      startY: revenueEnd + 16,
      head: [['Estado', 'Cantidad']],
      body: getExportRows(orderStatusData),
      theme: 'grid',
      headStyles: {
        fillColor: [99, 102, 241],
        textColor: 255,
      },
      styles: {
        fontSize: 9,
      },
    })

    const statusEnd = (doc as any).lastAutoTable?.finalY ?? revenueEnd + 16
    doc.setFontSize(12)
    doc.setTextColor(15, 23, 42)
    doc.text('Dispositivos del periodo', 14, statusEnd + 12)

    autoTable(doc, {
      startY: statusEnd + 16,
      head: [['Tipo', 'Cantidad']],
      body: getExportRows(reportData.deviceTypesData),
      theme: 'grid',
      headStyles: {
        fillColor: [6, 182, 212],
        textColor: 255,
      },
      styles: {
        fontSize: 9,
      },
    })

    const devicesEnd = (doc as any).lastAutoTable?.finalY ?? statusEnd + 16
    doc.setFontSize(12)
    doc.setTextColor(15, 23, 42)
    doc.text('Tecnicos con mas cierres', 14, devicesEnd + 12)

    autoTable(doc, {
      startY: devicesEnd + 16,
      head: [['Tecnico', 'Cierres']],
      body: getExportRows(reportData.topTechnicians),
      theme: 'grid',
      headStyles: {
        fillColor: [245, 158, 11],
        textColor: 255,
      },
      styles: {
        fontSize: 9,
      },
    })

    const pageCount = doc.getNumberOfPages()
    for (let page = 1; page <= pageCount; page += 1) {
      doc.setPage(page)
      doc.setFontSize(9)
      doc.setTextColor(100, 116, 139)
      doc.text(
        `Reporte generado por TechRepair · Pagina ${page} de ${pageCount}`,
        14,
        288
      )
    }

    doc.save(`reporte-${selectedPeriod}-${generatedAt.toISOString().slice(0, 10)}.pdf`)
    } catch (err) {
      console.error('Error generando PDF de reporte:', err)
    } finally {
      setExportLoading(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <Loader size="lg" text="Cargando reportes..." />
      </div>
    )
  }

  if (activeError && !reportData) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <AlertCircle size={48} style={{ color: 'var(--error)' }} />
        <h3 style={{ color: 'var(--text-primary)', marginTop: '1rem' }}>Error al cargar reportes</h3>
        <p style={{ color: 'var(--text-muted)' }}>{activeError}</p>
      </div>
    )
  }

  return (
    <div className="animate-fade-in">
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon"><TrendingUp size={22} /></div>
          <div>
            <h1 className="page-hdr-title">Reportes y Análisis</h1>
            <p className="page-hdr-subtitle">Visualizaciones y métricas sincronizadas con el negocio actual</p>
          </div>
        </div>
      </div>

      {activeError && reportData && (
        <div className="alert-inline alert-warning" style={{ marginBottom: '1.5rem' }}>
          <AlertCircle size={15} style={{ flexShrink: 0 }} />
          Algunas métricas no pudieron actualizarse y se muestran con fallback. {activeError}
        </div>
      )}

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="card-body" style={{ display: 'flex', gap: '1rem', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <Calendar size={20} color="#64748b" />
            <select
              className="form-select"
              style={{ width: 'auto' }}
              value={selectedPeriod}
              onChange={(e) => setSelectedPeriod(e.target.value as ReportsPeriod)}
            >
              {PERIOD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-outline" onClick={handleExport} disabled={!reportData || exportLoading}>
            <Download size={16} />
            {exportLoading ? 'Generando...' : 'Descargar PDF'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' }}>
        {statCards.map((stat) => (
          <div key={stat.label} className="stat-card" style={{ borderTop: `3px solid ${stat.color}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <div style={{ width: '40px', height: '40px', borderRadius: '0.625rem', backgroundColor: `${stat.color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <stat.icon size={20} color={stat.color} />
              </div>
              <span className="stat-card-label">{stat.label}</span>
            </div>
            <div className="stat-card-value" style={{ color: stat.color }}>{stat.value}</div>
            <div className="body-sm" style={{ marginTop: '0.25rem', color: stat.trend === 'up' ? '#10b981' : '#f59e0b' }}>
              {stat.change}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '1.5rem' }}>
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">{reportData?.revenueSeriesTitle || 'Ingresos'}</h3>
          </div>
          <div className="card-body">
            {reportData && hasNonZeroValues(reportData.revenueSeries) ? (
              <SimpleBarChart data={reportData.revenueSeries} height={220} />
            ) : (
              <p style={{ color: '#94a3b8', margin: 0 }}>No hay ingresos registrados para el periodo seleccionado.</p>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Distribucion actual de ordenes</h3>
          </div>
          <div className="card-body">
            {hasNonZeroValues(orderStatusData) ? (
              <SimplePieChart data={orderStatusData} size={180} />
            ) : (
              <p style={{ color: '#94a3b8', margin: 0 }}>Todavia no hay ordenes para analizar.</p>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Dispositivos del periodo</h3>
          </div>
          <div className="card-body">
            {reportData && hasNonZeroValues(reportData.deviceTypesData) ? (
              <SimplePieChart data={reportData.deviceTypesData} size={180} />
            ) : (
              <p style={{ color: '#94a3b8', margin: 0 }}>No hay dispositivos registrados en este periodo.</p>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Tecnicos con mas cierres</h3>
          </div>
          <div className="card-body">
            {reportData && hasNonZeroValues(reportData.topTechnicians) ? (
              <SimpleBarChart data={reportData.topTechnicians} height={200} />
            ) : (
              <p style={{ color: '#94a3b8', margin: 0 }}>No hay ordenes completadas con tecnico asignado en este periodo.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
