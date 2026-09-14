/**
 * arca-selfservice-setup — handler PURO de la configuración inicial ARCA (Phase 2A).
 *
 * Todas las dependencias se inyectan (autoridad, cliente service_role, criptografía y WSAA)
 * para testearlo sin red. `index.ts` sólo cablea implementaciones reales.
 *
 * Orden de cada pedido:
 *   1. CORS (allowlist canónica de _shared/scopedCors.ts) y método.
 *   2. Autoridad canónica de gestión ARCA (authorizeArcaManager: JWT, perfil activo,
 *      owner/admin, settings_sensitive). Una credencial de servidor no es un actor.
 *   3. Body JSON acotado con allowlist ESTRICTA de campos por acción (fail-closed).
 *   4. business_id del body sólo confirma el tenant (resolveManagedBusiness).
 *   5. Plan con feature 'arca' (business_has_feature con el JWT del usuario).
 *   6. Defensa en profundidad SQL: is_business_owner_or_admin.
 *   7. La acción delega en RPC service_role que vuelven a validar TODO.
 *
 * Nunca devuelve ni loguea: clave privada, secret_id, ticket/firma WSAA, fingerprints, id de
 * intento ni texto crudo de ARCA. El material de verificación sólo vive en memoria durante el LoginCms.
 *
 * verify hace a lo sumo UN LoginCms por pedido y nunca lo reintenta. La espera ante un resultado
 * ambiguo la decide y la guarda la base (verification_hold / retry_not_before); acá sólo se
 * informa `retry_after_seconds`, que el navegador muestra pero no controla.
 */
import { ArcaAuthorizationError } from '../_shared/arcaAuthorization.ts'
import { resolveManagedBusiness, type ArcaManager } from '../_shared/arcaManagementAuthority.ts'
import type { Cors } from '../_shared/scopedCors.ts'
import {
  isAuthorizedSubject, normalizeCertificateInput, type AuthorizedSubject, type GeneratedSetupKey,
} from './crypto.ts'
import { classifyWsaaFailure, validateWsaaTicket, type WsaaFailure, type WsaaTicket } from './wsaa.ts'

export const MAX_BODY_BYTES = 128 * 1024
export const SETUP_ACTIONS = ['prepare', 'csr', 'certificate', 'verify', 'cancel'] as const
export type SetupAction = typeof SETUP_ACTIONS[number]

const FIELDS: Readonly<Record<SetupAction, readonly string[]>> = {
  prepare: ['action', 'business_id', 'idempotency_key', 'cuit', 'razon_social', 'ambiente', 'punto_venta', 'alias'],
  csr: ['action', 'business_id'],
  certificate: ['action', 'business_id', 'certificate_pem', 'certificate_der_base64'],
  verify: ['action', 'business_id', 'idempotency_key'],
  cancel: ['action', 'business_id'],
}

type RpcResult = { data: unknown; error: unknown }

export interface SetupDeps {
  cors: Cors
  authorize: (req: Request) => Promise<ArcaManager>
  hasArcaFeature: (req: Request) => Promise<boolean>
  rpc: (name: string, args: Record<string, unknown>) => Promise<RpcResult>
  generateKeyAndCsr: (subject: AuthorizedSubject) => Promise<GeneratedSetupKey>
  wsaaLogin: (input: { certificatePem: string; signingKeyPem: string; ambiente: 'homologacion' | 'produccion'; service: 'wsfe' }) => Promise<WsaaTicket>
  /** Nonce del intento de verificación (uuid). Lo genera el Edge para poder resolver un material perdido. */
  newAttemptId: () => string
  sleep: (ms: number) => Promise<void>
  now: () => number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Estados de validación de datos del usuario → 422; negocio → 409; autoridad → 403. */
function statusFor(state: string): number {
  if (state === 'UNAUTHORIZED') return 403
  if (state.startsWith('INVALID_') || state === 'CUIT_TENANT_MISMATCH') return 422
  return 409
}

/** Sólo campos acotados de una respuesta de RPC; nunca se hace spread del resultado. */
function stateOf(data: unknown): string | null {
  return isObj(data) && typeof data.state === 'string' && /^[A-Z_]{3,64}$/.test(data.state) ? data.state : null
}

/** Esperas de verificación que decide la base. */
export const HOLD_STATES = ['VERIFICATION_IN_PROGRESS', 'WSAA_RESULT_UNKNOWN', 'WSAA_TICKET_ALREADY_ISSUED', 'VERIFICATION_EXPIRED', 'VERIFICATION_COOLDOWN'] as const
/** Cota conservadora cuando la base no pudo confirmar la espera: ventana de ambigüedad (12 h 30 min). */
export const AMBIGUITY_RETRY_AFTER_SECONDS = 45_000
export const MAX_RETRY_AFTER_SECONDS = 90_000

/** retry_after_seconds acotado a un entero [1, 90000]; cualquier otra cosa → null. */
function retryAfterOf(data: unknown): number | null {
  if (!isObj(data)) return null
  const v = data.retry_after_seconds
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_RETRY_AFTER_SECONDS ? v : null
}

function csrFilename(subject: unknown): string {
  const cuit = isObj(subject) && typeof subject.cuit === 'string' && /^[0-9]{11}$/.test(subject.cuit) ? subject.cuit : 'arca'
  return `techrepair-arca-${cuit}.csr`
}

function subjectView(subject: unknown): { alias: string | null; cuit: string | null } {
  if (!isObj(subject)) return { alias: null, cuit: null }
  return {
    alias: typeof subject.alias === 'string' ? subject.alias : null,
    cuit: typeof subject.cuit === 'string' && /^[0-9]{11}$/.test(subject.cuit) ? subject.cuit : null,
  }
}

export async function handleSetupRequest(req: Request, deps: SetupDeps): Promise<Response> {
  const { cors } = deps
  const json = (body: unknown, status = 200) => cors.json(req, body, status)
  const fail = (status: number, error: string) => json({ ok: false, error }, status)
  const business = (state: string, retryAfter: number | null = null) =>
    json((HOLD_STATES as readonly string[]).includes(state)
      ? { ok: false, state, retry_after_seconds: retryAfter ?? AMBIGUITY_RETRY_AFTER_SECONDS }
      : { ok: false, state }, statusFor(state))

  if (req.method === 'OPTIONS') return cors.preflight(req)
  if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED')

  // ── 2. Autoridad ──
  let manager: ArcaManager
  try {
    manager = await deps.authorize(req)
  } catch (err) {
    if (err instanceof ArcaAuthorizationError) return fail(err.status, err.code)
    return fail(503, 'AUTHORIZATION_UNAVAILABLE')
  }

  // ── 3. Body acotado ──
  const declared = Number(req.headers.get('Content-Length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'TOO_LARGE')
  let raw: string
  try { raw = await req.text() } catch { return fail(400, 'BAD_REQUEST') }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return fail(413, 'TOO_LARGE')
  let body: unknown
  try { body = JSON.parse(raw) } catch { return fail(400, 'BAD_REQUEST') }
  if (!isObj(body)) return fail(400, 'BAD_REQUEST')
  const action = body.action
  if (typeof action !== 'string' || !(SETUP_ACTIONS as readonly string[]).includes(action)) return fail(400, 'UNKNOWN_ACTION')
  const allowed = FIELDS[action as SetupAction]
  if (Object.keys(body).some((field) => !allowed.includes(field))) return fail(400, 'UNEXPECTED_FIELD')

  // ── 4. Tenant por identidad ──
  let businessId: string
  try { businessId = resolveManagedBusiness(body.business_id, manager) } catch { return fail(403, 'FORBIDDEN') }

  // ── 5. Plan ──
  try {
    if (await deps.hasArcaFeature(req) !== true) return fail(403, 'ARCA_FEATURE_REQUIRED')
  } catch {
    return fail(503, 'AUTHORIZATION_UNAVAILABLE')
  }

  // ── 6. Defensa en profundidad: la autoridad canónica en SQL ──
  const authz = await deps.rpc('is_business_owner_or_admin', { p_business_id: businessId, p_user_id: manager.userId })
  if (authz.error) return fail(503, 'AUTHORIZATION_UNAVAILABLE')
  if (authz.data !== true) return fail(403, 'FORBIDDEN')

  const actor = manager.userId
  const base = { p_business_id: businessId, p_actor: actor }

  switch (action as SetupAction) {
    case 'prepare': return await prepare(body, base, deps, json, fail, business)
    case 'csr': return await getCsr(base, deps, json, fail, business)
    case 'certificate': return await attachCertificate(body, base, deps, json, fail, business)
    case 'verify': return await verify(body, base, deps, json, fail, business)
    case 'cancel': return await cancel(base, deps, json, fail, business)
  }
}

type Json = (body: unknown, status?: number) => Response
type Fail = (status: number, error: string) => Response
type Business = (state: string, retryAfter?: number | null) => Response
type Base = { p_business_id: string; p_actor: string }

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/

async function prepare(body: Obj, base: Base, deps: SetupDeps, json: Json, fail: Fail, business: Business): Promise<Response> {
  const idem = str(body.idempotency_key)
  const cuit = str(body.cuit)
  const razon = str(body.razon_social)
  const ambiente = str(body.ambiente)
  const pv = body.punto_venta
  const alias = str(body.alias)
  if (!idem || !IDEMPOTENCY_KEY.test(idem) || cuit === null || razon === null || ambiente === null || alias === null
      || typeof pv !== 'number' || !Number.isInteger(pv)) {
    return fail(400, 'BAD_REQUEST')
  }
  const args = {
    ...base, p_idempotency_key: idem, p_cuit: cuit, p_razon_social: razon, p_ambiente: ambiente,
    p_punto_venta: pv, p_alias: alias,
  }

  const prepared = (data: Obj) => json({
    ok: true,
    state: stateOf(data),
    csr: { pem: str(data.csr_pem), filename: csrFilename(data.subject) },
    subject: subjectView(data.subject),
    ambiente: str(data.ambiente),
  })

  // Probe: si es un replay, no se genera ninguna clave.
  const probe = await deps.rpc('arca_selfservice_prepare_initial', { ...args, p_key_pem: null, p_csr_pem: null, p_fingerprint: null })
  if (probe.error) return fail(503, 'SETUP_UNAVAILABLE')
  const probeState = stateOf(probe.data)
  if (probeState === 'SETUP_ALREADY_PREPARED' && isObj(probe.data)) return prepared(probe.data)
  if (probeState !== 'KEY_REQUIRED') return business(probeState ?? 'SETUP_UNAVAILABLE')
  const subject = isObj(probe.data) ? probe.data.subject : null
  if (!isAuthorizedSubject(subject)) return fail(503, 'SETUP_UNAVAILABLE')

  let generated: GeneratedSetupKey | null = null
  try {
    generated = await deps.generateKeyAndCsr(subject)
  } catch {
    return fail(503, 'KEY_GENERATION_FAILED')
  }
  try {
    const stored = await deps.rpc('arca_selfservice_prepare_initial', {
      ...args, p_key_pem: generated.keyPem, p_csr_pem: generated.csrPem, p_fingerprint: generated.fingerprint,
    })
    if (stored.error) return fail(503, 'SETUP_UNAVAILABLE')
    const st = stateOf(stored.data)
    if ((st === 'SETUP_PREPARED' || st === 'SETUP_ALREADY_PREPARED') && isObj(stored.data)) return prepared(stored.data)
    return business(st ?? 'SETUP_UNAVAILABLE')
  } finally {
    generated = null
  }
}

async function getCsr(base: Base, deps: SetupDeps, json: Json, fail: Fail, business: Business): Promise<Response> {
  const r = await deps.rpc('arca_selfservice_get_csr', base)
  if (r.error) return fail(503, 'SETUP_UNAVAILABLE')
  const st = stateOf(r.data)
  if (st !== 'CSR_AVAILABLE' || !isObj(r.data)) return business(st ?? 'SETUP_UNAVAILABLE')
  return json({
    ok: true, state: st,
    csr: { pem: str(r.data.csr_pem), filename: csrFilename(r.data.subject) },
    subject: subjectView(r.data.subject),
    ambiente: str(r.data.ambiente),
    certificate_attached: r.data.certificate_attached === true,
    verified: r.data.verified === true,
  })
}

async function attachCertificate(body: Obj, base: Base, deps: SetupDeps, json: Json, fail: Fail, business: Business): Promise<Response> {
  const pem = body.certificate_pem
  const der = body.certificate_der_base64
  if ((pem === undefined) === (der === undefined)) return fail(400, 'BAD_REQUEST')
  if ((pem !== undefined && typeof pem !== 'string') || (der !== undefined && typeof der !== 'string')) return fail(400, 'BAD_REQUEST')
  const normalized = normalizeCertificateInput(pem !== undefined ? { pem: pem as string } : { derBase64: der as string })
  if (!normalized.ok) {
    if (normalized.state === 'KEY_MATERIAL_NOT_ACCEPTED') return fail(400, 'KEY_MATERIAL_NOT_ACCEPTED')
    if (normalized.state === 'CERTIFICATE_TOO_LARGE') return fail(413, 'TOO_LARGE')
    return business('CERTIFICATE_INVALID')
  }
  const r = await deps.rpc('arca_selfservice_attach_certificate', { ...base, p_certificate_pem: normalized.pem })
  if (r.error) return fail(503, 'SETUP_UNAVAILABLE')
  const st = stateOf(r.data)
  if (!st || !isObj(r.data) || r.data.ok !== true) return business(st ?? 'SETUP_UNAVAILABLE', retryAfterOf(r.data))
  return json({ ok: true, state: st, expires_at: str(r.data.expires_at) })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Informa a la base el desenlace de un intento. La base es la autoridad de la espera: con un código
 * definitivo sólo libera un intento todavía 'in_flight' con este mismo id; con uno ambiguo o
 * `coe.alreadyAuthenticated` sólo extiende. Se reintenta ante errores de transporte.
 * Devuelve null si el reporte nunca llegó (la espera pesimista del despacho sigue vigente).
 */
async function reportAttempt(deps: SetupDeps, base: Base, attemptId: string, code: string, observedExpiresAt: string | null = null): Promise<Obj | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await deps.rpc('arca_selfservice_record_verification_failure', {
      ...base, p_attempt_id: attemptId, p_code: code, p_observed_expires: observedExpiresAt,
    }).catch(() => ({ data: null, error: { message: 'transport' } }))
    if (!r.error && isObj(r.data)) return r.data
    if (attempt < 3) await deps.sleep(250 * attempt)
  }
  return null
}

async function verify(body: Obj, base: Base, deps: SetupDeps, json: Json, fail: Fail, business: Business): Promise<Response> {
  const idem = str(body.idempotency_key)
  if (!idem || !IDEMPOTENCY_KEY.test(idem)) return fail(400, 'BAD_REQUEST')

  const attemptId = deps.newAttemptId()
  if (!UUID.test(attemptId)) return fail(503, 'SETUP_UNAVAILABLE')

  /** Sin clave en memoria: seguro liberar el intento. Si el reporte no llega, la espera pesimista queda. */
  const notDispatched = async (): Promise<Response> => {
    const report = await reportAttempt(deps, base, attemptId, 'VERIFICATION_NOT_DISPATCHED')
    if (report === null) return business('WSAA_RESULT_UNKNOWN', AMBIGUITY_RETRY_AFTER_SECONDS)
    return fail(503, 'SETUP_UNAVAILABLE')
  }

  const material = await deps.rpc('arca_selfservice_verification_material', { ...base, p_attempt_id: attemptId })
    .catch(() => ({ data: null, error: { message: 'transport' } }))
  if (material.error) return await notDispatched()
  const mState = stateOf(material.data)
  if (mState === 'SETUP_ALREADY_COMPLETED') return json({ ok: true, state: 'SETUP_ALREADY_COMPLETED' })
  if ((mState !== 'VERIFICATION_MATERIAL' && mState !== 'ALREADY_VERIFIED') || !isObj(material.data)) {
    return business(mState ?? 'SETUP_UNAVAILABLE', retryAfterOf(material.data))
  }
  const fingerprint = str(material.data.fingerprint)
  const certificateSha256 = str(material.data.certificate_sha256)
  if (!fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint) || !certificateSha256 || !/^[0-9a-f]{64}$/.test(certificateSha256)) {
    return mState === 'VERIFICATION_MATERIAL' ? await notDispatched() : fail(503, 'SETUP_UNAVAILABLE')
  }

  if (mState === 'VERIFICATION_MATERIAL') {
    const ambiente = material.data.ambiente
    let certificatePem = str(material.data.certificate_pem)
    let signingKeyPem = str(material.data.signing_key_pem)
    if ((ambiente !== 'homologacion' && ambiente !== 'produccion') || !certificatePem || !signingKeyPem) {
      certificatePem = null
      signingKeyPem = null
      return await notDispatched()
    }

    // ── Único LoginCms de este pedido. Desde acá, el pedido pudo llegar a ARCA. ──
    let ticket: WsaaTicket | null = null
    let failure: WsaaFailure | null = null
    try {
      // Defensa en profundidad: el TA se vuelve a validar en el borde del handler.
      ticket = validateWsaaTicket(await deps.wsaaLogin({ certificatePem, signingKeyPem, ambiente, service: 'wsfe' }), deps.now())
    } catch (err) {
      failure = classifyWsaaFailure(err)
    } finally {
      certificatePem = null
      signingKeyPem = null
    }

    if (failure !== null || ticket === null) {
      const f = failure ?? classifyWsaaFailure(null)
      const report = await reportAttempt(deps, base, attemptId, f.code, f.observedExpiresAt)
      if (report === null) return business('WSAA_RESULT_UNKNOWN', AMBIGUITY_RETRY_AFTER_SECONDS)
      const reported = stateOf(report)
      if (reported === 'ALREADY_VERIFIED') {
        // Otro camino ya registró la verificación: se continúa con la activación.
      } else if (f.disposition === 'definitive') {
        return json({ ok: false, state: f.code }, f.code === 'WSAA_UNAVAILABLE' ? 503 : 409)
      } else {
        const holdState = stateOf(isObj(report.hold) ? report.hold : null)
        return business(f.disposition === 'ticket_active' ? 'WSAA_TICKET_ALREADY_ISSUED' : (holdState === 'WSAA_TICKET_ALREADY_ISSUED' ? holdState : 'WSAA_RESULT_UNKNOWN'),
          retryAfterOf(isObj(report.hold) ? report.hold : null))
      }
    } else {
      // El TA existe en ARCA: registrarlo es crítico. Se reintenta ante errores de transporte.
      let recorded = false
      let rejected: string | null = null
      try {
        for (let attempt = 1; attempt <= 3 && !recorded && rejected === null; attempt++) {
          const r = await deps.rpc('arca_selfservice_record_verification', {
            ...base, p_expected_fingerprint: fingerprint, p_expected_certificate_sha256: certificateSha256,
            p_token: ticket.token, p_sign: ticket.sign, p_expires_at: ticket.expirationTime,
          }).catch(() => ({ data: null, error: { message: 'transport' } }))
          if (!r.error) {
            const st = stateOf(r.data) ?? 'SETUP_UNAVAILABLE'
            if (st === 'VERIFIED' || st === 'ALREADY_VERIFIED') recorded = true
            else rejected = st
          } else if (attempt < 3) {
            await deps.sleep(250 * attempt)
          }
        }
      } finally {
        ticket = null
      }
      if (!recorded) {
        // Un TA vigente quedó sin registrar: nunca se libera para otro LoginCms.
        const report = await reportAttempt(deps, base, attemptId, 'VERIFICATION_RECORD_FAILED', null)
        const reported = report === null ? null : stateOf(report)
        if (reported !== 'ALREADY_VERIFIED') {
          if (rejected === 'UNAUTHORIZED' || rejected === 'ARCA_ALREADY_CONFIGURED') return business(rejected)
          return business('WSAA_RESULT_UNKNOWN', report === null ? AMBIGUITY_RETRY_AFTER_SECONDS : retryAfterOf(isObj(report.hold) ? report.hold : null))
        }
      }
    }
  }

  // Activación (reintentable sin volver a ARCA).
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await deps.rpc('arca_selfservice_activate', {
      ...base, p_expected_fingerprint: fingerprint, p_expected_certificate_sha256: certificateSha256, p_idempotency_key: idem,
    }).catch(() => ({ data: null, error: { message: 'transport' } }))
    if (r.error) {
      if (attempt < 2) { await deps.sleep(250); continue }
      return json({ ok: false, state: 'ACTIVATION_PENDING' }, 503)
    }
    const st = stateOf(r.data)
    if ((st === 'ACTIVATED' || st === 'ALREADY_ACTIVATED') && isObj(r.data)) {
      return json({
        ok: true, state: st,
        connection: r.data.connection === 'connected' ? 'connected' : null,
        expires_at: str(r.data.expires_at),
      })
    }
    return business(st ?? 'SETUP_UNAVAILABLE', retryAfterOf(r.data))
  }
  return json({ ok: false, state: 'ACTIVATION_PENDING' }, 503)
}

async function cancel(base: Base, deps: SetupDeps, json: Json, fail: Fail, business: Business): Promise<Response> {
  const r = await deps.rpc('arca_selfservice_cancel', base)
  if (r.error) return fail(503, 'SETUP_UNAVAILABLE')
  const st = stateOf(r.data)
  if ((st === 'SETUP_CANCELLED' || st === 'SETUP_NOT_IN_PROGRESS') && isObj(r.data)) {
    // Cancelar no revoca nada en ARCA: sólo se informa si un TA pudo haber quedado vigente allá.
    return json({ ok: true, state: st, remote_ticket_possible: r.data.remote_ticket_possible === true })
  }
  return business(st ?? 'SETUP_UNAVAILABLE', retryAfterOf(r.data))
}
