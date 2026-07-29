/**
 * Loaders del snapshot financiero del Dashboard.
 *
 * Vive separado del hook a propósito: acá no se importa React ni Supabase, así
 * que la orquestación y la agregación se pueden testear ejecutando comportamiento
 * real (no buscando strings en el código). El hook provee el adaptador contra
 * Supabase; los tests proveen uno falso.
 *
 * REGLA CENTRAL DEL MÓDULO — un error NUNCA se convierte en cero.
 *   - `null` significa "no disponible / no cargado".
 *   - `0` significa cero de verdad, informado por la base.
 * Confundirlos es lo que hacía que una consulta fallida se renderizara como un
 * saldo de $0 perfectamente creíble.
 */
// Extensión .ts explícita: este módulo lo importa `node --test` (ESM sin
// bundler), igual que hace `src/lib/analytics.ts` con su logger.
import { isPermissionDeniedError } from '../lib/permissions/rlsError.ts'

// ─── Contrato de datos crudos ─────────────────────────────────────────────────

export interface VentaRow { amount_ars: number | null }

export interface MovimientoCajaRow {
  type:        string
  amount_ars:  number | null
  metodo_pago: string | null
}

/** Forma mínima de una respuesta de PostgREST: data + error, nunca throw. */
export interface QueryOutcome<T> { data: T | null; error: unknown }

/**
 * Puerto de datos. El hook lo implementa con Supabase; los tests con un doble.
 * Cada método corresponde a UNA consulta real del Dashboard.
 */
export interface FinanceDashboardPort {
  /** Cobros (comprobante_payments) desde una fecha, excluyendo cuenta corriente. */
  ventasDesde(businessId: string, sinceISO: string): Promise<QueryOutcome<VentaRow[]>>
  /** Count de productos activos con stock bajo. */
  stockBajo(businessId: string): Promise<QueryOutcome<number>>
  /** Movimientos de la caja abierta. */
  movimientosCaja(businessId: string, cajaId: string): Promise<QueryOutcome<MovimientoCajaRow[]>>
}

// ─── Contrato de error ────────────────────────────────────────────────────────

export const FINANCE_UNAVAILABLE_MESSAGE =
  'No pudimos cargar este dato. Reintentá en unos segundos.'

export const FINANCE_PERMISSION_MESSAGE =
  'No tenés permisos para ver este dato.'

export interface FinanceLoadError {
  kind:    'permission' | 'unknown'
  /** Copy apto para UI. Nunca incluye SQLSTATE, tablas ni internals de Supabase. */
  message: string
  /**
   * Etiqueta corta para el logger: '42501', 'http_500', 'unknown'. Se captura acá
   * porque el error crudo muere en este punto — más arriba ya no está disponible.
   */
  code: string
}

/** Etiqueta corta para el logger. Nunca se le pasa el error crudo a la UI. */
export function financeErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return 'unknown'
  const e = err as { code?: unknown; status?: unknown }
  if (typeof e.code === 'string' && e.code) return e.code
  if (typeof e.status === 'number') return `http_${e.status}`
  return 'unknown'
}

/**
 * Normaliza cualquier error a algo mostrable. Reutiliza el detector canónico de
 * permisos (`isPermissionDeniedError`) en vez de abrir un contrato paralelo.
 */
export function toFinanceLoadError(err: unknown): FinanceLoadError {
  const code = financeErrorCode(err)
  return isPermissionDeniedError(err)
    ? { kind: 'permission', message: FINANCE_PERMISSION_MESSAGE, code }
    : { kind: 'unknown',    message: FINANCE_UNAVAILABLE_MESSAGE, code }
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

export interface PaymentMethodStat {
  method: string
  label:  string
  color:  string
  amount: number
  count:  number
  pct:    number
}

export interface CajaDayBreakdown {
  income:  number
  expense: number
  net:     number
  byMethod: { method: string; label: string; color: string; income: number; expense: number }[]
}

export interface GeneralSnapshot {
  ventasSemana:   number
  ventasMes:      number
  stockBajoCount: number
}

export interface CajaSnapshot {
  ventasHoy:      number
  paymentMethods: PaymentMethodStat[]
  caja:           CajaDayBreakdown
  cajaAbierta:    boolean
}

/** `data` y `error` son mutuamente excluyentes: nunca hay datos parciales. */
export interface LoadResult<T> { data: T | null; error: FinanceLoadError | null }

// ─── Métodos de pago ──────────────────────────────────────────────────────────

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

export function methodMeta(m: string) {
  return METHOD_META[m] ?? { label: m, color: '#475569' }
}

// ─── Agregación pura ──────────────────────────────────────────────────────────

export function sumVentas(rows: VentaRow[]): number {
  return rows.reduce((s, r) => s + (r.amount_ars || 0), 0)
}

/** Caja vacía = cero legítimo (no hay caja abierta), no un fallo. */
export function emptyCaja(): CajaDayBreakdown {
  return { income: 0, expense: 0, net: 0, byMethod: [] }
}

export function aggregateCaja(rows: MovimientoCajaRow[]): {
  caja: CajaDayBreakdown
  paymentMethods: PaymentMethodStat[]
  ventasHoy: number
} {
  const byMethod = new Map<string, { income: number; expense: number }>()
  let income = 0
  let expense = 0

  for (const f of rows) {
    const m   = f.metodo_pago || 'otro'
    const amt = Math.abs(f.amount_ars || 0)
    const cur = byMethod.get(m) ?? { income: 0, expense: 0 }
    if (f.type === 'income') { cur.income  += amt; income  += amt }
    else                     { cur.expense += amt; expense += amt }
    byMethod.set(m, cur)
  }

  const paymentMethods: PaymentMethodStat[] = Array.from(byMethod.entries())
    .filter(([, v]) => v.income > 0)
    .map(([method, { income: mi }]) => ({
      method,
      label:  methodMeta(method).label,
      color:  methodMeta(method).color,
      amount: mi,
      count:  0,
      pct:    income > 0 ? (mi / income) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount)

  const cajaByMethod = Array.from(byMethod.entries())
    .map(([method, { income: mi, expense: me }]) => ({
      method,
      label:   methodMeta(method).label,
      color:   methodMeta(method).color,
      income:  mi,
      expense: me,
    }))
    .sort((a, b) => (b.income - b.expense) - (a.income - a.expense))

  return {
    caja: { income, expense, net: income - expense, byMethod: cajaByMethod },
    paymentMethods,
    // "Cobrado en caja" = ingresos de la sesión actual.
    ventasHoy: income,
  }
}

// ─── Carga general (depende SOLO de businessId) ───────────────────────────────

/**
 * Ventas semana/mes + stock bajo. NO toca la caja: por eso abrir o cerrar una
 * caja no tiene por qué volver a pedir nada de esto.
 */
export async function loadGeneral(
  port: FinanceDashboardPort,
  businessId: string,
  weekAgoISO: string,
  monthAgoISO: string,
): Promise<LoadResult<GeneralSnapshot>> {
  const [semana, mes, stock] = await Promise.all([
    port.ventasDesde(businessId, weekAgoISO),
    port.ventasDesde(businessId, monthAgoISO),
    port.stockBajo(businessId),
  ])

  // Si cualquiera falla, el grupo entero queda "no disponible". Devolver los
  // otros dos en cero daría un snapshot que parece válido y no lo es.
  const failed = [semana, mes, stock].find(r => r.error)
  if (failed) return { data: null, error: toFinanceLoadError(failed.error) }

  return {
    data: {
      ventasSemana:   sumVentas(semana.data ?? []),
      ventasMes:      sumVentas(mes.data ?? []),
      stockBajoCount: stock.data ?? 0,
    },
    error: null,
  }
}

// ─── Carga de caja (depende de businessId + cajaId) ───────────────────────────

/**
 * Sin caja abierta (`cajaId === null`) NO se consulta nada: se devuelven ceros
 * legítimos. Es la diferencia entre "no hay caja" y "no pudimos leer la caja".
 */
export async function loadCaja(
  port: FinanceDashboardPort,
  businessId: string,
  cajaId: string | null,
): Promise<LoadResult<CajaSnapshot>> {
  if (cajaId === null) {
    return {
      data: { ventasHoy: 0, paymentMethods: [], caja: emptyCaja(), cajaAbierta: false },
      error: null,
    }
  }

  const res = await port.movimientosCaja(businessId, cajaId)
  if (res.error) return { data: null, error: toFinanceLoadError(res.error) }

  const { caja, paymentMethods, ventasHoy } = aggregateCaja(res.data ?? [])
  return { data: { ventasHoy, paymentMethods, caja, cajaAbierta: true }, error: null }
}
