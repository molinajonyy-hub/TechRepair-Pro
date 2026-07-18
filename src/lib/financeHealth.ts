// ============================================================================
// M7 7D — Health Check financiero v2.
//
// La RPC finance_health_check_v2 devuelve un SUPERSET aditivo del contrato v1:
// los 7 campos por check y los 8 del resumen que consumía la pantalla siguen
// idénticos. Acá se tipa el contrato completo y se parsea FAIL-CLOSED: un valor
// desconocido nunca se degrada a "pass" — se muestra como revisión necesaria.
//
// La autorización de los checks globales la aplica la BASE (owner del negocio).
// El flag p_include_global es sólo una petición; ocultar la UI no autoriza nada.
// ============================================================================

// ─── Contrato v1 (legacy, preservado) ───────────────────────────────────────
export type CheckStatus = 'ok' | 'low' | 'warning' | 'critical'
export type CheckSeverity = 'low' | 'warning' | 'critical'

// ─── Contrato v2 (aditivo) ──────────────────────────────────────────────────
export type CheckResult = 'pass' | 'warn' | 'fail' | 'info'
export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type OverallStatus = 'pass' | 'warn' | 'fail'

/** Marca de los valores que la RPC devolvió y no reconocemos. */
export const UNKNOWN = 'unknown' as const

export interface HealthCheck {
  // v1
  id: string
  title: string
  severity: CheckSeverity
  status: CheckStatus
  count: number
  description: string
  rows: Record<string, unknown>[]
  // v2
  check_id: string
  category: string
  result: CheckResult
  severity_level: SeverityLevel
  amount_ars: number
  message: string
  details: Record<string, unknown>
  version: string
  /** true si la RPC mandó un result/severity que no está en el contrato. */
  unrecognized: boolean
}

export interface SchemaState {
  ledger?: boolean
  audit_log?: boolean
  period_locks?: boolean
  reconciliation?: boolean
  payment_replacement?: boolean
  annulment_date?: boolean
}

export interface HealthSemantics {
  credit_note?: string
  legacy_debt?: string
}

export interface HealthResult {
  // v1
  ok: boolean
  critical_count: number
  warning_count: number
  low_count: number
  total_issues: number
  business_id: string
  checked_at: string
  checks: HealthCheck[]
  error?: string
  // v2
  version: string
  overall_status: OverallStatus
  info_count: number
  pass_count: number
  checks_total: number
  duration_ms: number
  amount_at_risk: number
  schema_state: SchemaState
  semantics: HealthSemantics
  /** 'v2' | 'legacy_v1' — de dónde salieron estos datos. */
  health_version: 'v2' | 'legacy_v1'
}

// ─── Parsing fail-closed ────────────────────────────────────────────────────

const RESULTS: readonly CheckResult[] = ['pass', 'warn', 'fail', 'info']
const SEVERITIES: readonly SeverityLevel[] = ['critical', 'high', 'medium', 'low', 'info']
const STATUSES: readonly CheckStatus[] = ['ok', 'low', 'warning', 'critical']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}
const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback)

/**
 * Un `result` desconocido NO se convierte en 'pass': se trata como 'warn' y se
 * marca `unrecognized`, para que la pantalla pida revisión en vez de dar por
 * bueno algo que no entiende.
 */
export function parseCheck(raw: unknown): HealthCheck {
  const r = isRecord(raw) ? raw : {}

  const rawResult = str(r.result)
  const knownResult = (RESULTS as readonly string[]).includes(rawResult)
  const rawSeverity = str(r.severity_level)
  const knownSeverity = (SEVERITIES as readonly string[]).includes(rawSeverity)
  const rawStatus = str(r.status)
  const knownStatus = (STATUSES as readonly string[]).includes(rawStatus)

  // v1 sin campos v2: se deriva el result desde el status legacy.
  const derivedFromStatus: CheckResult | null =
    rawStatus === 'ok' ? 'pass'
      : rawStatus === 'critical' ? 'fail'
        : rawStatus === 'warning' ? 'warn'
          : rawStatus === 'low' ? 'info'
            : null

  const unrecognized = (rawResult !== '' && !knownResult)
    || (rawSeverity !== '' && !knownSeverity)
    || (rawStatus !== '' && !knownStatus)

  // FAIL-CLOSED. Si `result` vino pero no lo reconocemos, NO se confía en el
  // `status` legacy para derivarlo: un check con result desconocido y status
  // 'ok' se pintaría verde silenciosamente. Sólo se deriva del status cuando
  // `result` está AUSENTE (respuesta v1 legítima).
  const result: CheckResult =
    knownResult ? (rawResult as CheckResult)
      : rawResult !== '' ? 'warn'
        : derivedFromStatus ?? 'warn'

  const resultStatus: CheckStatus =
    result === 'pass' ? 'ok'
      : result === 'fail' ? 'critical'
        : result === 'warn' ? 'warning' : 'low'

  // Un check no reconocido tampoco conserva su status legacy: se muestra como
  // revisión necesaria, nunca en verde.
  const status: CheckStatus =
    unrecognized ? resultStatus
      : knownStatus ? (rawStatus as CheckStatus)
        : resultStatus

  const severity_level: SeverityLevel =
    knownSeverity ? (rawSeverity as SeverityLevel)
      : unrecognized ? 'medium'
        : result === 'fail' ? 'high' : result === 'warn' ? 'medium' : 'info'

  const id = str(r.check_id) || str(r.id) || UNKNOWN

  return {
    id: str(r.id) || id,
    title: str(r.title) || id,
    severity: (['low', 'warning', 'critical'] as readonly string[]).includes(str(r.severity))
      ? (str(r.severity) as CheckSeverity)
      : status === 'critical' ? 'critical' : status === 'warning' ? 'warning' : 'low',
    status,
    count: num(r.count),
    description: str(r.description) || str(r.message),
    rows: Array.isArray(r.rows) ? (r.rows.filter(isRecord) as Record<string, unknown>[]) : [],
    check_id: id,
    category: str(r.category) || 'otros',
    result,
    severity_level,
    amount_ars: num(r.amount_ars),
    message: str(r.message) || str(r.description),
    details: isRecord(r.details) ? r.details : {},
    version: str(r.version) || 'legacy_v1',
    unrecognized,
  }
}

export function parseHealthResult(raw: unknown, source: 'v2' | 'legacy_v1'): HealthResult {
  const r = isRecord(raw) ? raw : {}
  const checks = Array.isArray(r.checks) ? r.checks.map(parseCheck) : []

  const overallRaw = str(r.overall_status)
  const overall_status: OverallStatus =
    (['pass', 'warn', 'fail'] as readonly string[]).includes(overallRaw)
      ? (overallRaw as OverallStatus)
      // v1 o valor desconocido: se deriva de los checks, fail-closed.
      : checks.some(c => c.result === 'fail') ? 'fail'
        : checks.some(c => c.result === 'warn' || c.unrecognized) ? 'warn'
          : 'pass'

  return {
    ok: bool(r.ok, true),
    critical_count: num(r.critical_count, checks.filter(c => c.status === 'critical').length),
    warning_count: num(r.warning_count, checks.filter(c => c.status === 'warning').length),
    low_count: num(r.low_count, checks.filter(c => c.status === 'low').length),
    total_issues: num(r.total_issues),
    business_id: str(r.business_id),
    checked_at: str(r.checked_at) || new Date().toISOString(),
    checks,
    error: typeof r.error === 'string' ? r.error : undefined,
    version: str(r.version) || 'legacy_v1',
    overall_status,
    info_count: num(r.info_count, checks.filter(c => c.result === 'info').length),
    pass_count: num(r.pass_count, checks.filter(c => c.result === 'pass').length),
    checks_total: num(r.checks_total, checks.length),
    duration_ms: num(r.duration_ms),
    amount_at_risk: num(r.amount_at_risk),
    schema_state: isRecord(r.schema_state) ? (r.schema_state as SchemaState) : {},
    semantics: isRecord(r.semantics) ? (r.semantics as HealthSemantics) : {},
    health_version: source,
  }
}

// ─── Presentación ───────────────────────────────────────────────────────────

/** Orden y rótulo de las categorías. Las desconocidas van al final, visibles. */
export const CATEGORY_ORDER: { id: string; label: string }[] = [
  { id: 'periods', label: 'Períodos' },
  { id: 'audit', label: 'Auditoría' },
  { id: 'idempotency', label: 'Idempotencia' },
  { id: 'annulments', label: 'Comprobantes y anulaciones' },
  { id: 'credit_notes', label: 'Notas de crédito' },
  { id: 'payments', label: 'Pagos y reemplazos' },
  { id: 'cashflow', label: 'Caja y cashflow' },
  { id: 'pnl_ledger', label: 'P&L y ledger' },
  { id: 'accounting_classification', label: 'Clasificación contable' },
  { id: 'accounts_receivable', label: 'Cuenta corriente' },
  { id: 'inventory', label: 'Inventario' },
  { id: 'multi_tenant', label: 'Multi-tenant' },
  { id: 'reconciliation', label: 'Reconciliación' },
  // Va último y aparte: es diagnóstico de plataforma (ver GLOBAL_CATEGORIES),
  // no salud financiera del comercio. Sin esta entrada, categoryLabel devolvía
  // el slug crudo y la UI mostraba "security".
  { id: 'security', label: 'Seguridad' },
]

/** Categorías que son diagnóstico de plataforma, no salud del comercio. */
export const GLOBAL_CATEGORIES = new Set(['security'])

export function categoryLabel(id: string): string {
  return CATEGORY_ORDER.find(c => c.id === id)?.label ?? id
}

export interface CheckGroup {
  category: string
  label: string
  checks: HealthCheck[]
  failCount: number
  warnCount: number
  infoCount: number
  passCount: number
  amountAtRisk: number
  /** Estado agregado del grupo. */
  status: CheckResult
  hasUnrecognized: boolean
}

export function groupChecks(checks: HealthCheck[]): CheckGroup[] {
  const byCat = new Map<string, HealthCheck[]>()
  for (const c of checks) {
    const list = byCat.get(c.category) ?? []
    list.push(c)
    byCat.set(c.category, list)
  }

  const grupos: CheckGroup[] = []
  for (const [category, list] of byCat) {
    const failCount = list.filter(c => c.result === 'fail').length
    const warnCount = list.filter(c => c.result === 'warn').length
    const infoCount = list.filter(c => c.result === 'info').length
    const passCount = list.filter(c => c.result === 'pass').length
    grupos.push({
      category,
      label: categoryLabel(category),
      // dentro del grupo: primero lo que requiere acción
      checks: [...list].sort((a, b) => orden(a.result) - orden(b.result)),
      failCount, warnCount, infoCount, passCount,
      amountAtRisk: list.filter(c => c.result === 'fail').reduce((s, c) => s + c.amount_ars, 0),
      status: failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : infoCount > 0 ? 'info' : 'pass',
      hasUnrecognized: list.some(c => c.unrecognized),
    })
  }

  // orden de presentación; las categorías desconocidas al final pero visibles
  const idx = (cat: string) => {
    const i = CATEGORY_ORDER.findIndex(c => c.id === cat)
    return i === -1 ? CATEGORY_ORDER.length : i
  }
  return grupos.sort((a, b) => idx(a.category) - idx(b.category) || a.category.localeCompare(b.category))
}

function orden(r: CheckResult): number {
  return r === 'fail' ? 0 : r === 'warn' ? 1 : r === 'info' ? 2 : 3
}

/** ARS. No hay helper monetario canónico en el proyecto; se usa el mismo patrón. */
export const fmtARS = (v: number): string =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(v)

// ─── Detección del fallback a v1 ────────────────────────────────────────────

/**
 * ¿El error dice que la función v2 todavía no existe (deploy pendiente o schema
 * cache sin refrescar)? Sólo en ESE caso corresponde caer a v1. Cualquier otro
 * error —permisos, SQL, timeout— debe propagarse.
 */
export function esV2Inexistente(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false
  const msg = (err.message || '').toLowerCase()
  // PostgREST PGRST202 = función no encontrada en el schema cache.
  if (err.code === 'PGRST202') return true
  // Postgres 42883 = undefined_function.
  if (err.code === '42883') return true
  return msg.includes('finance_health_check_v2') &&
    (msg.includes('does not exist') || msg.includes('could not find') || msg.includes('schema cache'))
}
