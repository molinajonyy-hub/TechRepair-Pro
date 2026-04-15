import { AlertCircle, Calendar, ClipboardList, DollarSign, Download, Package, TrendingUp, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { useAuth } from '../contexts/AuthContext'
import { useDashboardStats } from '../hooks/useDashboardStats'
import { supabase } from '../lib/supabase'
import { Loader } from '../components/ui/Loader'
import { SimpleBarChart } from '../components/charts/SimpleBarChart'
import { SimplePieChart } from '../components/charts/SimplePieChart'
import { inventoryReportsService } from '../services/inventoryReportsService'
import { inventoryService } from '../services/inventoryService'
import { STATUS_CONFIG } from '../types/orderStatus'

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
  inventoryValue: number
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
  technician?: { name?: string | null } | { name?: string | null }[] | null
}

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

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())

const startOfWeek = (date: Date) => {
  const result = startOfDay(date)
  const day = result.getDay()
  const diff = day === 0 ? -6 : 1 - day
  result.setDate(result.getDate() + diff)
  return result
}

const startOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1)

const startOfQuarter = (date: Date) => new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1)

const startOfYear = (date: Date) => new Date(date.getFullYear(), 0, 1)

const addDays = (date: Date, amount: number) => {
  const result = new Date(date)
  result.setDate(result.getDate() + amount)
  return result
}

const addMonths = (date: Date, amount: number) => {
  const result = new Date(date)
  result.setMonth(result.getMonth() + amount)
  return result
}

const addYears = (date: Date, amount: number) => {
  const result = new Date(date)
  result.setFullYear(result.getFullYear() + amount)
  return result
}

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

const getSingleRelation = <T,>(relation: T | T[] | null | undefined): T | null => {
  if (Array.isArray(relation)) {
    return relation[0] || null
  }

  return relation || null
}

const getPeriodRange = (period: ReportsPeriod, now: Date) => {
  switch (period) {
    case 'today': {
      const start = startOfDay(now)
      return {
        currentStart: start,
        currentEnd: addDays(start, 1),
        previousStart: addDays(start, -1),
        previousEnd: start,
        comparisonLabel: 'vs ayer',
        periodLabel: 'hoy',
      }
    }
    case 'week': {
      const start = startOfWeek(now)
      return {
        currentStart: start,
        currentEnd: addDays(start, 7),
        previousStart: addDays(start, -7),
        previousEnd: start,
        comparisonLabel: 'vs semana anterior',
        periodLabel: 'esta semana',
      }
    }
    case 'month': {
      const start = startOfMonth(now)
      return {
        currentStart: start,
        currentEnd: addMonths(start, 1),
        previousStart: addMonths(start, -1),
        previousEnd: start,
        comparisonLabel: 'vs mes anterior',
        periodLabel: 'este mes',
      }
    }
    case 'quarter': {
      const start = startOfQuarter(now)
      return {
        currentStart: start,
        currentEnd: addMonths(start, 3),
        previousStart: addMonths(start, -3),
        previousEnd: start,
        comparisonLabel: 'vs trimestre anterior',
        periodLabel: 'este trimestre',
      }
    }
    case 'year': {
      const start = startOfYear(now)
      return {
        currentStart: start,
        currentEnd: addYears(start, 1),
        previousStart: addYears(start, -1),
        previousEnd: start,
        comparisonLabel: 'vs ano anterior',
        periodLabel: 'este ano',
      }
    }
  }
}

const buildRevenueBuckets = (period: ReportsPeriod, now: Date) => {
  if (period === 'today') {
    const start = addDays(startOfDay(now), -6)

    return {
      title: 'Ingresos ultimos 7 dias',
      buckets: Array.from({ length: 7 }, (_, index) => {
        const bucketStart = addDays(start, index)
        const bucketEnd = addDays(bucketStart, 1)

        return {
          start: bucketStart,
          end: bucketEnd,
          label: bucketStart.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' }),
        }
      }),
    }
  }

  if (period === 'week') {
    const start = startOfWeek(now)

    return {
      title: 'Ingresos por dia',
      buckets: Array.from({ length: 7 }, (_, index) => {
        const bucketStart = addDays(start, index)
        const bucketEnd = addDays(bucketStart, 1)

        return {
          start: bucketStart,
          end: bucketEnd,
          label: bucketStart.toLocaleDateString('es-AR', { weekday: 'short' }).replace('.', ''),
        }
      }),
    }
  }

  if (period === 'month') {
    const start = startOfMonth(now)
    const end = addMonths(start, 1)
    const buckets: Array<{ start: Date; end: Date; label: string }> = []
    let cursor = start
    let bucketNumber = 1

    while (cursor < end) {
      const bucketStart = cursor
      const bucketEnd = addDays(bucketStart, 7) < end ? addDays(bucketStart, 7) : end

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
    const start = startOfQuarter(now)

    return {
      title: 'Ingresos por mes',
      buckets: Array.from({ length: 3 }, (_, index) => {
        const bucketStart = addMonths(start, index)
        const bucketEnd = addMonths(bucketStart, 1)

        return {
          start: bucketStart,
          end: bucketEnd,
          label: bucketStart.toLocaleDateString('es-AR', { month: 'short' }).replace('.', ''),
        }
      }),
    }
  }

  const start = startOfYear(now)
  return {
    title: 'Ingresos por mes',
    buckets: Array.from({ length: 12 }, (_, index) => {
      const bucketStart = addMonths(start, index)
      const bucketEnd = addMonths(bucketStart, 1)

      return {
        start: bucketStart,
        end: bucketEnd,
        label: bucketStart.toLocaleDateString('es-AR', { month: 'short' }).replace('.', ''),
      }
    }),
  }
}

const sumPaymentsBetween = (payments: PaymentRow[], start: Date, end: Date) =>
  payments.reduce((sum, payment) => {
    if (!payment.payment_date) {
      return sum
    }

    const paymentDate = new Date(payment.payment_date)
    if (paymentDate >= start && paymentDate < end) {
      return sum + (payment.amount || 0)
    }

    return sum
  }, 0)

const countDatesBetween = (dates: string[], start: Date, end: Date) =>
  dates.filter((value) => {
    const currentDate = new Date(value)
    return currentDate >= start && currentDate < end
  }).length

async function loadCustomerCountForRange(businessId: string, start: Date, end: Date) {
  const runQuery = async (scopedByBusiness: boolean) => {
    let query = supabase
      .from('customers')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())

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

        const now = new Date()
        const periodRange = getPeriodRange(selectedPeriod, now)
        const revenueConfig = buildRevenueBuckets(selectedPeriod, now)
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
            .gte('payment_date', queryStart.toISOString())
            .lt('payment_date', queryEnd.toISOString()),
          supabase
            .from('orders')
            .select('updated_at, technician:users(name)')
            .eq('business_id', businessId)
            .eq('status', 'completed')
            .gte('updated_at', periodRange.previousStart.toISOString())
            .lt('updated_at', periodRange.currentEnd.toISOString()),
          loadCustomerCountForRange(businessId, periodRange.currentStart, periodRange.currentEnd),
          loadCustomerCountForRange(businessId, periodRange.previousStart, periodRange.previousEnd),
          inventoryService.getLowStockItems(businessId),
          inventoryService.getOutOfStockItems(businessId),
          inventoryReportsService.calculateTotalValue(businessId),
          supabase
            .from('devices')
            .select('type, created_at, customers!inner(business_id)')
            .eq('customers.business_id', businessId)
            .gte('created_at', periodRange.currentStart.toISOString())
            .lt('created_at', periodRange.currentEnd.toISOString()),
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

          const updatedAt = new Date(order.updated_at)
          if (updatedAt < periodRange.currentStart || updatedAt >= periodRange.currentEnd) {
            return accumulator
          }

          const technician = getSingleRelation<{ name?: string | null }>(order.technician)
          const label = technician?.name?.trim() || 'Sin asignar'
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

          deviceTypesData = Object.entries(deviceTypeCount)
            .sort(([, left], [, right]) => right - left)
            .slice(0, 5)
            .map(([type, value], index) => ({
              label: type,
              value,
              color: REPORT_COLORS[index % REPORT_COLORS.length],
            }))
        }

        if (deviceTypesData.length === 0 && stats?.popularDeviceTypes?.length) {
          deviceTypesData = stats.popularDeviceTypes.map((device, index) => ({
            label: device.type,
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
          inventoryValue: inventoryValueResult.status === 'fulfilled' ? inventoryValueResult.value : 0,
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
        change: `${reportData.outOfStockCount} sin stock · ${formatCurrency(reportData.inventoryValue)}`,
        trend: reportData.outOfStockCount === 0 ? 'up' : 'down',
        icon: Package,
        color: '#f59e0b',
      },
    ]
  }, [reportData])

  const loading = authLoading || profileLoading || statsLoading || reportLoading
  const activeError = reportError || (!reportData && statsError ? statsError : null)

  const handleExport = () => {
    if (!reportData) {
      return
    }

    const generatedAt = new Date()
    const periodLabel = PERIOD_OPTIONS.find((option) => option.value === selectedPeriod)?.label || selectedPeriod
    const summaryRows = [
      ['Ingresos del periodo', formatCurrency(reportData.revenueCurrent), `${formatDifference(reportData.revenueCurrent, reportData.revenuePrevious, 'currency')} ${reportData.comparisonLabel}`],
      ['Ordenes completadas', reportData.completedOrdersCurrent.toString(), `${formatDifference(reportData.completedOrdersCurrent, reportData.completedOrdersPrevious, 'count')} ${reportData.comparisonLabel}`],
      ['Clientes nuevos', reportData.newCustomersCurrent.toString(), `${formatDifference(reportData.newCustomersCurrent, reportData.newCustomersPrevious, 'count')} ${reportData.comparisonLabel}`],
      ['Items con stock bajo', reportData.lowStockCount.toString(), `${reportData.outOfStockCount} sin stock`],
      ['Valor total del inventario', formatCurrency(reportData.inventoryValue), reportData.periodLabel],
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
      <div style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
        <div style={{
          width: '44px', height: '44px', borderRadius: '0.75rem',
          background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.2))',
          border: '1px solid rgba(99,102,241,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
        }}>
          <TrendingUp size={22} style={{ color: '#818cf8' }} />
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f8fafc' }}>Reportes y Análisis</h1>
          <p style={{ margin: 0, fontSize: '0.8rem', color: '#475569' }}>Visualizaciones y métricas sincronizadas con el negocio actual</p>
        </div>
      </div>

      {activeError && reportData && (
        <div style={{
          padding: '1rem',
          backgroundColor: 'rgba(245, 158, 11, 0.12)',
          border: '1px solid rgba(245, 158, 11, 0.28)',
          borderRadius: '0.75rem',
          color: '#fbbf24',
          marginBottom: '1.5rem',
        }}>
          Algunas metricas no pudieron actualizarse y se muestran con fallback. {activeError}
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
          <button className="btn btn-outline" onClick={handleExport} disabled={!reportData}>
            <Download size={16} />
            Descargar PDF
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.5rem', marginBottom: '1.5rem' }}>
        {statCards.map((stat) => (
          <div key={stat.label} className="card" style={{ backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderTop: `3px solid ${stat.color}`, borderRadius: '0.75rem' }}>
            <div className="card-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '0.75rem',
                  backgroundColor: `${stat.color}20`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <stat.icon size={24} color={stat.color} />
                </div>
                <div>
                  <p style={{ fontSize: '0.875rem', color: '#a0aec0', margin: 0 }}>{stat.label}</p>
                  <p style={{ fontSize: '1.5rem', fontWeight: 700, color: '#f8fafc', margin: '0.25rem 0' }}>
                    {stat.value}
                  </p>
                  <p style={{ fontSize: '0.75rem', color: stat.trend === 'up' ? '#10b981' : '#f59e0b', margin: 0 }}>
                    <TrendingUp size={12} style={{ display: 'inline', marginRight: '0.25rem' }} />
                    {stat.change}
                  </p>
                </div>
              </div>
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
