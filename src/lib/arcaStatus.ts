/**
 * ARCA Self-Service Phase 1 — contrato del read model canónico de estado.
 *
 * La AUTORIDAD es `public.get_arca_selfservice_status()` (server-side): configurado,
 * vencimiento (notAfter del X.509), conexión, configuración en curso, can_manage y
 * próxima acción se DERIVAN en Postgres. Este módulo sólo:
 *
 *   1. valida la forma recibida (fail-closed: un enum desconocido invalida todo el
 *      payload en vez de adivinar un estado), y
 *   2. traduce enums a textos de UI.
 *
 * No combina tablas, no calcula vencimientos ni decide permisos.
 * Módulo puro (sin React ni Supabase) para testearlo aislado.
 */

export const ARCA_STATUS_VALUES = [
  'unavailable', 'not_configured', 'setup_in_progress', 'pending_verification', 'connected', 'attention',
] as const
export const ARCA_RENEWAL_STATES = ['not_configured', 'unknown', 'healthy', 'expiring', 'urgent', 'expired'] as const
export const ARCA_CONNECTION_STATES = ['unknown', 'connected', 'error'] as const
export const ARCA_SETUP_STATES = ['not_started', 'in_progress', 'completed'] as const
export const ARCA_SETUP_KINDS = ['initial', 'renewal'] as const
/** `csr` y `activation` quedan reservados para el asistente de Phase 2. */
export const ARCA_SETUP_STEPS = ['csr', 'certificate', 'verification', 'activation'] as const
export const ARCA_NEXT_ACTIONS = ['start_setup', 'continue_setup', 'verify_connection', 'renew_certificate', 'none'] as const
export const ARCA_ATTENTION_REASONS = [
  'certificate_expired', 'certificate_unreadable', 'credential_certificate_mismatch',
  'credential_missing', 'certificate_missing', 'connection_error', 'legacy_pfx',
] as const

export type ArcaStatusValue = typeof ARCA_STATUS_VALUES[number]
export type ArcaRenewalState = typeof ARCA_RENEWAL_STATES[number]
export type ArcaConnectionState = typeof ARCA_CONNECTION_STATES[number]
export type ArcaSetupState = typeof ARCA_SETUP_STATES[number]
export type ArcaSetupKind = typeof ARCA_SETUP_KINDS[number]
export type ArcaSetupStep = typeof ARCA_SETUP_STEPS[number]
export type ArcaNextAction = typeof ARCA_NEXT_ACTIONS[number]
export type ArcaAttentionReason = typeof ARCA_ATTENTION_REASONS[number]

export interface ArcaSelfServiceStatus {
  contract_version: 1
  available: boolean
  status: ArcaStatusValue
  configured: boolean
  environment: 'homologacion' | 'produccion' | null
  cuit: string | null
  razon_social: string | null
  punto_venta: number | null
  alias: string | null
  certificate: {
    present: boolean
    expires_at: string | null
    days_remaining: number | null
    renewal_state: ArcaRenewalState
    matches_credential: boolean
  }
  credential: { active: boolean }
  connection: { state: ArcaConnectionState; last_verified_at: string | null }
  setup: {
    state: ArcaSetupState
    kind: ArcaSetupKind | null
    step: ArcaSetupStep | null
    started_at: string | null
  }
  attention: ArcaAttentionReason[]
  can_manage: boolean
  next_action: ArcaNextAction
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const oneOf = <T extends string>(allowed: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v)
const nullableOneOf = <T extends string>(allowed: readonly T[], v: unknown): v is T | null =>
  v === null || oneOf(allowed, v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const nullableString = (v: unknown, max = 200): v is string | null =>
  v === null || (typeof v === 'string' && v.length <= max)
const nullableDate = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)))
const nullableInt = (v: unknown, min: number, max: number): v is number | null =>
  v === null || (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max)

/**
 * Valida y COPIA sólo los campos del contrato. Cualquier desvío → null (la UI
 * muestra "no se pudo leer el estado" en vez de un estado inventado).
 */
export function parseArcaSelfServiceStatus(raw: unknown): ArcaSelfServiceStatus | null {
  if (!isObj(raw) || raw.contract_version !== 1) return null
  const { certificate: c, credential: k, connection: n, setup: s } = raw
  if (!isObj(c) || !isObj(k) || !isObj(n) || !isObj(s)) return null
  if (!Array.isArray(raw.attention) || !raw.attention.every((a) => oneOf(ARCA_ATTENTION_REASONS, a))) return null

  if (
    !isBool(raw.available) || !oneOf(ARCA_STATUS_VALUES, raw.status) || !isBool(raw.configured)
    || !nullableOneOf(['homologacion', 'produccion'] as const, raw.environment)
    || !(raw.cuit === null || (typeof raw.cuit === 'string' && /^\d{11}$/.test(raw.cuit)))
    || !nullableString(raw.razon_social) || !nullableString(raw.alias, 120)
    || !nullableInt(raw.punto_venta, 1, 99998)
    || !isBool(c.present) || !nullableDate(c.expires_at) || !nullableInt(c.days_remaining, 0, 100_000)
    || !oneOf(ARCA_RENEWAL_STATES, c.renewal_state) || !isBool(c.matches_credential)
    || !isBool(k.active)
    || !oneOf(ARCA_CONNECTION_STATES, n.state) || !nullableDate(n.last_verified_at)
    || !oneOf(ARCA_SETUP_STATES, s.state) || !nullableOneOf(ARCA_SETUP_KINDS, s.kind)
    || !nullableOneOf(ARCA_SETUP_STEPS, s.step) || !nullableDate(s.started_at)
    || !isBool(raw.can_manage) || !oneOf(ARCA_NEXT_ACTIONS, raw.next_action)
  ) return null

  return {
    contract_version: 1,
    available: raw.available,
    status: raw.status,
    configured: raw.configured,
    environment: raw.environment,
    cuit: raw.cuit as string | null,
    razon_social: raw.razon_social,
    punto_venta: raw.punto_venta,
    alias: raw.alias,
    certificate: {
      present: c.present,
      expires_at: c.expires_at,
      days_remaining: c.days_remaining,
      renewal_state: c.renewal_state,
      matches_credential: c.matches_credential,
    },
    credential: { active: k.active },
    connection: { state: n.state, last_verified_at: n.last_verified_at },
    setup: { state: s.state, kind: s.kind, step: s.step, started_at: s.started_at },
    attention: [...raw.attention] as ArcaAttentionReason[],
    can_manage: raw.can_manage,
    next_action: raw.next_action,
  }
}

// ─── Presentación ──────────────────────────────────────────────────────────

export type ArcaTone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent'

export interface ArcaStatusRow { key: string; label: string; value: string; tone?: ArcaTone }
export interface ArcaStatusNotice { key: string; tone: ArcaTone; text: string }

export interface ArcaStatusView {
  tone: ArcaTone
  headline: string
  detail: string
  /** true → la tarjeta muestra el estado vacío deliberado en vez de metadata. */
  empty: boolean
  rows: ArcaStatusRow[]
  notices: ArcaStatusNotice[]
}

const AR_TZ = 'America/Argentina/Buenos_Aires'

export function formatCuit(cuit: string | null): string {
  if (!cuit || !/^\d{11}$/.test(cuit)) return '—'
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`
}

export function formatArcaDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('es-AR', { timeZone: AR_TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
}

const ATTENTION_COPY: Record<ArcaAttentionReason, string> = {
  certificate_expired: 'El certificado digital venció. No se pueden emitir comprobantes electrónicos hasta renovarlo.',
  certificate_unreadable: 'No se pudo leer el certificado digital cargado.',
  credential_certificate_mismatch: 'El certificado digital no corresponde a la clave segura del negocio.',
  credential_missing: 'Hay un certificado digital cargado, pero falta la clave segura asociada.',
  certificate_missing: 'La clave segura del negocio no tiene un certificado digital asociado.',
  connection_error: 'La última conexión con ARCA falló.',
  legacy_pfx: 'La configuración usa un formato de certificado anterior que ya no se admite.',
}

const CERTIFICATE_LABEL: Record<ArcaRenewalState, { value: string; tone: ArcaTone }> = {
  not_configured: { value: 'Sin certificado', tone: 'neutral' },
  unknown: { value: 'No se pudo leer', tone: 'danger' },
  healthy: { value: 'Vigente', tone: 'success' },
  expiring: { value: 'Vence pronto', tone: 'warning' },
  urgent: { value: 'Renovación urgente', tone: 'danger' },
  expired: { value: 'Vencido', tone: 'danger' },
}

/** Traduce el estado canónico a textos. No deriva ni corrige nada del servidor. */
export function describeArcaStatus(s: ArcaSelfServiceStatus): ArcaStatusView {
  if (!s.available) {
    return {
      tone: 'neutral', headline: 'No incluido en tu plan', empty: true, rows: [], notices: [],
      detail: 'La facturación electrónica con ARCA está disponible en los planes que la incluyen.',
    }
  }

  const inProgress = s.setup.state === 'in_progress'
  const empty = s.status === 'not_configured' || s.status === 'setup_in_progress'

  let tone: ArcaTone
  let headline: string
  let detail: string
  switch (s.status) {
    case 'connected':
      tone = 'success'; headline = 'Conectado'
      detail = 'Podés emitir comprobantes electrónicos desde TechRepair Pro.'
      break
    case 'pending_verification':
      tone = 'warning'; headline = 'Configuración pendiente'
      detail = s.setup.step === 'verification'
        ? 'El certificado nuevo está activo y falta confirmar la conexión con ARCA.'
        : 'Todavía no hay una conexión confirmada con ARCA.'
      break
    case 'setup_in_progress':
      tone = 'accent'; headline = 'Configuración pendiente'
      detail = 'Hay una configuración de ARCA en curso.'
      break
    case 'attention':
      tone = 'danger'; headline = 'Requiere atención'
      detail = s.attention.length > 0 ? ATTENTION_COPY[s.attention[0]] : 'La integración con ARCA necesita revisión.'
      break
    default:
      tone = 'neutral'; headline = 'No configurado'
      detail = 'Conectá tu negocio con ARCA para emitir comprobantes electrónicos desde TechRepair Pro.'
  }

  const rows: ArcaStatusRow[] = empty ? [] : [
    { key: 'cuit', label: 'CUIT', value: formatCuit(s.cuit) },
    { key: 'ambiente', label: 'Ambiente', value: s.environment === 'produccion' ? 'Producción' : s.environment === 'homologacion' ? 'Homologación' : '—' },
    { key: 'punto-venta', label: 'Punto de venta', value: s.punto_venta === null ? '—' : String(s.punto_venta) },
    { key: 'certificado', label: 'Certificado', ...CERTIFICATE_LABEL[s.certificate.renewal_state] },
    { key: 'vence', label: 'Vence', value: formatArcaDate(s.certificate.expires_at) },
    {
      key: 'ultima-conexion', label: 'Última conexión',
      value: s.connection.last_verified_at ? formatArcaDate(s.connection.last_verified_at) : 'Sin verificar',
      tone: s.connection.state === 'error' ? 'danger' : undefined,
    },
  ]

  const notices: ArcaStatusNotice[] = []
  // El primer motivo ya es el detalle; los demás se listan.
  for (const reason of s.status === 'attention' ? s.attention.slice(1) : s.attention) {
    notices.push({ key: reason, tone: 'danger', text: ATTENTION_COPY[reason] })
  }
  const days = s.certificate.days_remaining
  if (s.certificate.renewal_state === 'expiring' || s.certificate.renewal_state === 'urgent') {
    // Decisión de producto (Phase 1): la renovación todavía no se hace desde la app.
    // El aviso es informativo y NO ofrece una acción que no existe.
    notices.push({
      key: 'renewal', tone: s.certificate.renewal_state === 'urgent' ? 'danger' : 'warning',
      text: `El certificado digital vence en ${days === 1 ? '1 día' : `${days ?? '—'} días`}. `
        + 'La renovación desde TechRepair Pro va a estar disponible con el asistente de configuración.',
    })
  }
  if (inProgress && s.status !== 'setup_in_progress') {
    notices.push({
      key: 'setup', tone: 'accent',
      text: s.setup.kind === 'renewal'
        ? 'Hay una renovación del certificado en curso. La conexión actual sigue funcionando mientras tanto.'
        : 'Hay una configuración de ARCA en curso.',
    })
  }

  return { tone, headline, detail, empty, rows, notices }
}
