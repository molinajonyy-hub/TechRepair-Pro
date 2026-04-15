import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export type EntryType =
  | 'income'
  | 'variable_cost'
  | 'fixed_cost_local'
  | 'fixed_cost_personal'
  | 'salary'

export type Currency = 'ARS' | 'USD'

export interface FinanceEntry {
  id: string
  business_id: string
  date: string
  type: EntryType
  category: string
  subcategory?: string
  description?: string
  amount: number
  currency: Currency
  amount_ars: number
  exchange_rate: number
  payment_method?: string
  notes?: string
  reference_order_id?: string
  reference_employee?: string
  created_by?: string
  created_at: string
  updated_at: string
}

export type NewFinanceEntry = Omit<FinanceEntry, 'id' | 'created_at' | 'updated_at'>

// ─── Category Definitions ─────────────────────────────────────────────────────

export interface CategoryDef {
  value: string
  label: string
}

export interface TypeDef {
  value: EntryType
  label: string
  color: string
  bgColor: string
  borderColor: string
  categories: CategoryDef[]
}

export const ENTRY_TYPES: TypeDef[] = [
  {
    value: 'income',
    label: 'Ingresos',
    color: '#34d399',
    bgColor: 'rgba(52,211,153,0.12)',
    borderColor: 'rgba(52,211,153,0.3)',
    categories: [
      { value: 'ventas_productos', label: 'Ventas de productos' },
      { value: 'servicios_tecnicos', label: 'Servicios técnicos' },
      { value: 'cobros', label: 'Cobros' },
      { value: 'senas', label: 'Señas' },
      { value: 'otros_ingresos', label: 'Otros ingresos' },
    ],
  },
  {
    value: 'variable_cost',
    label: 'Costos variables',
    color: '#f97316',
    bgColor: 'rgba(249,115,22,0.12)',
    borderColor: 'rgba(249,115,22,0.3)',
    categories: [
      { value: 'repuestos', label: 'Repuestos utilizados' },
      { value: 'mercaderia', label: 'Costo de mercadería vendida' },
      { value: 'insumos', label: 'Insumos' },
      { value: 'comisiones_cobro', label: 'Comisiones de cobro' },
      { value: 'envios', label: 'Envíos' },
      { value: 'reparaciones_tercerizadas', label: 'Reparaciones tercerizadas' },
      { value: 'otros_variables', label: 'Otros costos variables' },
    ],
  },
  {
    value: 'fixed_cost_local',
    label: 'Costos fijos del local',
    color: '#f87171',
    bgColor: 'rgba(248,113,113,0.12)',
    borderColor: 'rgba(248,113,113,0.3)',
    categories: [
      { value: 'alquiler', label: 'Alquiler' },
      { value: 'luz', label: 'Luz' },
      { value: 'agua', label: 'Agua' },
      { value: 'gas', label: 'Gas' },
      { value: 'internet', label: 'Internet' },
      { value: 'impuestos', label: 'Impuestos' },
      { value: 'contador', label: 'Contador' },
      { value: 'software', label: 'Software / suscripciones' },
      { value: 'publicidad', label: 'Publicidad fija' },
      { value: 'limpieza', label: 'Limpieza' },
      { value: 'seguridad', label: 'Seguridad' },
      { value: 'mantenimiento', label: 'Mantenimiento' },
      { value: 'otros_fijos_local', label: 'Otros costos fijos' },
    ],
  },
  {
    value: 'fixed_cost_personal',
    label: 'Costos fijos personales',
    color: '#c084fc',
    bgColor: 'rgba(192,132,252,0.12)',
    borderColor: 'rgba(192,132,252,0.3)',
    categories: [
      { value: 'vivienda', label: 'Vivienda' },
      { value: 'alimentacion', label: 'Alimentación' },
      { value: 'transporte', label: 'Transporte' },
      { value: 'servicios_personales', label: 'Servicios personales' },
      { value: 'salud', label: 'Salud' },
      { value: 'educacion', label: 'Educación' },
      { value: 'cuotas', label: 'Cuotas / deudas' },
      { value: 'familia', label: 'Familia' },
      { value: 'otros_fijos_personal', label: 'Otros gastos personales' },
    ],
  },
  {
    value: 'salary',
    label: 'Sueldos y retiros',
    color: '#60a5fa',
    bgColor: 'rgba(96,165,250,0.12)',
    borderColor: 'rgba(96,165,250,0.3)',
    categories: [
      { value: 'sueldo_dueno', label: 'Sueldo del dueño' },
      { value: 'sueldo_empleados', label: 'Sueldo de empleados' },
      { value: 'adelantos', label: 'Adelantos' },
      { value: 'bonos', label: 'Bonos' },
      { value: 'comisiones', label: 'Comisiones' },
      { value: 'retiros', label: 'Retiros personales' },
    ],
  },
]

export const PAYMENT_METHODS: CategoryDef[] = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'transferencia', label: 'Transferencia' },
  { value: 'tarjeta_debito', label: 'Tarjeta de débito' },
  { value: 'tarjeta_credito', label: 'Tarjeta de crédito' },
  { value: 'mercadopago', label: 'MercadoPago' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'otro', label: 'Otro' },
]

// Helpers
export const getTypeDef = (type: EntryType): TypeDef =>
  ENTRY_TYPES.find(t => t.value === type)!

export const getCategoryLabel = (type: EntryType, category: string): string => {
  const typeDef = getTypeDef(type)
  return typeDef?.categories.find(c => c.value === category)?.label ?? category
}

// ─── Period Helpers ───────────────────────────────────────────────────────────

export type PeriodType = 'today' | 'week' | 'month' | 'year' | 'custom'

export function getPeriodDates(period: PeriodType, customFrom?: string, customTo?: string) {
  const today = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  switch (period) {
    case 'today':
      return { from: fmt(today), to: fmt(today) }
    case 'week': {
      const dow = today.getDay() === 0 ? 6 : today.getDay() - 1
      const mon = new Date(today)
      mon.setDate(today.getDate() - dow)
      return { from: fmt(mon), to: fmt(today) }
    }
    case 'month':
      return {
        from: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`,
        to: fmt(today),
      }
    case 'year':
      return { from: `${today.getFullYear()}-01-01`, to: fmt(today) }
    case 'custom':
      return { from: customFrom ?? fmt(today), to: customTo ?? fmt(today) }
  }
}

// ─── Summary Calculations ─────────────────────────────────────────────────────

export interface FinanceSummary {
  totalIncome: number
  variableCosts: number
  grossMargin: number
  grossMarginPct: number
  fixedLocalCosts: number
  operatingResult: number
  salaries: number
  resultAfterSalaries: number
  personalCosts: number
  netResult: number
  breakEvenPoint: number
  status: 'positive' | 'break_even' | 'negative'
}

export function calculateSummary(entries: FinanceEntry[]): FinanceSummary {
  const sum = (type: EntryType) =>
    entries.filter(e => e.type === type).reduce((acc, e) => acc + e.amount_ars, 0)

  const totalIncome = sum('income')
  const variableCosts = sum('variable_cost')
  const grossMargin = totalIncome - variableCosts
  const grossMarginPct = totalIncome > 0 ? (grossMargin / totalIncome) * 100 : 0
  const fixedLocalCosts = sum('fixed_cost_local')
  const operatingResult = grossMargin - fixedLocalCosts
  const salaries = sum('salary')
  const resultAfterSalaries = operatingResult - salaries
  const personalCosts = sum('fixed_cost_personal')
  const netResult = resultAfterSalaries - personalCosts

  // Break-even: fixed costs + salaries + personal = needed income (assuming same variable cost %)
  const fixedTotal = fixedLocalCosts + salaries + personalCosts
  const variablePct = totalIncome > 0 ? variableCosts / totalIncome : 0.3
  const breakEvenPoint = variablePct < 1 ? fixedTotal / (1 - variablePct) : fixedTotal

  const THRESHOLD = 500 // ARS threshold for "break even"
  const status: FinanceSummary['status'] =
    netResult > THRESHOLD ? 'positive' : netResult < -THRESHOLD ? 'negative' : 'break_even'

  return {
    totalIncome,
    variableCosts,
    grossMargin,
    grossMarginPct,
    fixedLocalCosts,
    operatingResult,
    salaries,
    resultAfterSalaries,
    personalCosts,
    netResult,
    breakEvenPoint,
    status,
  }
}

// ─── Monthly evolution (last 6 months) ───────────────────────────────────────

export interface MonthPoint {
  label: string
  income: number
  expenses: number
  net: number
}

export function buildMonthlyEvolution(entries: FinanceEntry[]): MonthPoint[] {
  const months: Record<string, MonthPoint> = {}
  const monthNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']

  entries.forEach(e => {
    const d = new Date(e.date + 'T00:00:00')
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = `${monthNames[d.getMonth()]} ${d.getFullYear()}`
    if (!months[key]) months[key] = { label, income: 0, expenses: 0, net: 0 }
    if (e.type === 'income') months[key].income += e.amount_ars
    else months[key].expenses += e.amount_ars
  })

  return Object.entries(months)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => ({ ...v, net: v.income - v.expenses }))
}

// ─── Distribution by category type ───────────────────────────────────────────

export interface DistributionSlice {
  label: string
  amount: number
  color: string
  pct: number
}

export function buildExpenseDistribution(entries: FinanceEntry[]): DistributionSlice[] {
  const expenseTypes: EntryType[] = ['variable_cost', 'fixed_cost_local', 'salary', 'fixed_cost_personal']
  const total = entries
    .filter(e => expenseTypes.includes(e.type))
    .reduce((acc, e) => acc + e.amount_ars, 0)

  if (total === 0) return []

  return expenseTypes.map(type => {
    const def = getTypeDef(type)
    const amount = entries
      .filter(e => e.type === type)
      .reduce((acc, e) => acc + e.amount_ars, 0)
    return { label: def.label, amount, color: def.color, pct: (amount / total) * 100 }
  }).filter(s => s.amount > 0)
}

// ─── CRUD Service ─────────────────────────────────────────────────────────────

const TABLE = 'business_finance_entries'

export const financeService = {
  async getEntries(
    businessId: string,
    from: string,
    to: string,
  ): Promise<FinanceEntry[]> {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('business_id', businessId)
      .gte('date', from)
      .lte('date', to)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })

    if (error) throw error
    return (data ?? []) as FinanceEntry[]
  },

  async createEntry(entry: NewFinanceEntry): Promise<FinanceEntry> {
    const { data, error } = await supabase
      .from(TABLE)
      .insert(entry)
      .select()
      .single()
    if (error) throw error
    return data as FinanceEntry
  },

  async updateEntry(id: string, updates: Partial<NewFinanceEntry>): Promise<FinanceEntry> {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data as FinanceEntry
  },

  async deleteEntry(id: string): Promise<void> {
    const { error } = await supabase.from(TABLE).delete().eq('id', id)
    if (error) throw error
  },

  // For monthly evolution: load last 12 months regardless of period filter
  async getLastMonths(businessId: string, months = 6): Promise<FinanceEntry[]> {
    const from = new Date()
    from.setMonth(from.getMonth() - months)
    const fromStr = from.toISOString().split('T')[0]
    const toStr = new Date().toISOString().split('T')[0]

    const { data, error } = await supabase
      .from(TABLE)
      .select('date, type, amount_ars')
      .eq('business_id', businessId)
      .gte('date', fromStr)
      .lte('date', toStr)

    if (error) throw error
    return (data ?? []) as FinanceEntry[]
  },
}
