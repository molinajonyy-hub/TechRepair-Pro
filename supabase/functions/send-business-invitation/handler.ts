/**
 * send-business-invitation — handler PURO (PRE-BETA-2F).
 *
 * Responsabilidad ÚNICA: entregar por correo una invitación que la DB ya emitió.
 *   · autentica al actor por su JWT;
 *   · usa la autoridad DB EXISTENTE (create_business_invitation, RLS de business_invitations);
 *   · envía el correo por Resend;
 *   · permite reenviar una invitación pending.
 * NUNCA decide membresías, nunca crea businesses, nunca inserta en business_invitations y
 * nunca usa service_role: todo acceso a datos va con el JWT del actor (RLS).
 *
 * Todas las dependencias se inyectan (cliente user-scoped, clave, transporte, reloj, log) para
 * testearlo sin red. `index.ts` sólo cablea implementaciones reales.
 *
 * Orden de cada pedido:
 *   1. CORS (allowlist canónica de _shared/scopedCors.ts) y método (POST/OPTIONS).
 *   2. Bearer presente → identidad validada contra GoTrue.
 *   3. Actor: perfil ACTIVO, owner/admin, con negocio (get_my_profile con su JWT).
 *   4. Body JSON acotado con allowlist ESTRICTA de campos por acción.
 *   5. Acción:
 *        create_and_send → la RPC canónica crea o devuelve la pending (idempotente);
 *        resend          → lectura RLS de la fila; pending, vigente y del MISMO negocio.
 *   6. Entrega: destinatario, token, negocio y rol salen SIEMPRE de la fila de la DB,
 *      jamás del request.
 *
 * Crear la invitación y enviar el correo son dos resultados distintos: si la DB creó y el
 * proveedor falla, la invitación NO se toca y la respuesta lo dice (`delivery.failed`).
 *
 * Nunca devuelve ni loguea: token, correo, clave, body ni texto del proveedor, SQLSTATE crudo.
 */
import type { Cors } from '../_shared/scopedCors.ts'
import { buildInvitationUrl } from '../_shared/invitationLink.ts'
import { isInvitableRole, renderInvitationEmail, sanitizeHeaderText, type InvitableRole } from './email.ts'
import {
  createIdempotencyKey, deliverViaResend, resendIdempotencyKey, type DeliveryCode, type DeliveryOutcome,
} from './delivery.ts'

export const MAX_BODY_BYTES = 4 * 1024
export const MAX_EMAIL_LENGTH = 320
export const INVITATION_ACTIONS = ['create_and_send', 'resend'] as const
export type InvitationAction = typeof INVITATION_ACTIONS[number]

/** Allowlist ESTRICTA de campos. `resend` no acepta destinatario ni token: salen de la fila. */
export const ACTION_FIELDS: Readonly<Record<InvitationAction, readonly string[]>> = {
  create_and_send: ['action', 'email', 'role'],
  resend: ['action', 'invitation_id'],
}

export const MANAGER_ROLES: readonly string[] = ['owner', 'admin']

export interface PgError {
  code?: string
  message?: string
}

export interface ScopedResult {
  data: unknown
  error: PgError | null
}

/** Acceso a datos con el JWT del actor. Toda lectura/escritura queda bajo RLS. */
export interface UserScope {
  /** Identidad validada por GoTrue. null = JWT inválido o vencido. Lanza ante fallos de transporte. */
  userId(): Promise<string | null>
  rpc(name: string, args?: Record<string, unknown>): Promise<ScopedResult>
  /** Una invitación del negocio `businessId` (RLS: sólo owner/admin activos de ese negocio). */
  invitation(invitationId: string, businessId: string): Promise<ScopedResult>
  /** `businesses.name` del negocio (RLS: sólo el negocio propio). */
  businessName(businessId: string): Promise<ScopedResult>
}

export interface DeliveryLogEvent {
  fn: 'send-business-invitation'
  action: InvitationAction
  invitation_id: string
  delivery: 'sent' | 'failed'
  code: DeliveryCode | null
  provider_status: number | null
  business_name: 'ok' | 'fallback'
}

export interface InvitationDeps {
  cors: Cors
  /** Cliente user-scoped construido con el JWT del request. */
  userScope: (req: Request, jwt: string) => UserScope
  /** RESEND_INVITES_API_KEY, leída en cada envío. */
  resendApiKey: () => string | null | undefined
  /** Transporte hacia Resend (en tests y E2E, un stub). */
  fetchImpl: typeof fetch
  /** Override LOOPBACK del origen del enlace (dev/E2E). Cualquier otro valor se ignora. */
  appOrigin: string | null
  now: () => Date
  log: (event: DeliveryLogEvent) => void
}

export interface InvitationView {
  id: string
  email: string
  role: InvitableRole
  status: 'pending'
  expires_at: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^[0-9A-Za-z]{32,256}$/
const BEARER = /^Bearer ([^\s]+)$/i

interface InvitationRow {
  id: string
  business_id: string
  email: string
  role: InvitableRole
  token: string
  status: string
  expires_at: string
}

/** Sólo campos acotados de la fila; nunca se hace spread del resultado. */
export function parseInvitationRow(data: unknown): InvitationRow | null {
  const row = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data
  if (!isObj(row)) return null
  const { id, business_id, email, role, token, status, expires_at } = row
  if (typeof id !== 'string' || !UUID.test(id)) return null
  if (typeof business_id !== 'string' || !UUID.test(business_id)) return null
  if (typeof email !== 'string' || email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null
  if (!isInvitableRole(role)) return null
  if (typeof token !== 'string' || !TOKEN.test(token)) return null
  if (typeof status !== 'string') return null
  if (typeof expires_at !== 'string' || Number.isNaN(Date.parse(expires_at))) return null
  return { id, business_id, email, role, token, status, expires_at }
}

const view = (row: InvitationRow): InvitationView => ({
  id: row.id,
  email: row.email,
  role: row.role,
  status: 'pending',
  expires_at: row.expires_at,
})

interface Actor {
  userId: string
  businessId: string
}

type ActorResult = { ok: true; actor: Actor } | { ok: false; status: 401 | 403 | 503; error: string }

async function resolveActor(scope: UserScope): Promise<ActorResult> {
  let userId: string | null
  try {
    userId = await scope.userId()
  } catch {
    return { ok: false, status: 503, error: 'AUTHORIZATION_UNAVAILABLE' }
  }
  if (!userId) return { ok: false, status: 401, error: 'NOT_AUTHENTICATED' }

  let profile: ScopedResult
  try {
    profile = await scope.rpc('get_my_profile')
  } catch {
    return { ok: false, status: 503, error: 'AUTHORIZATION_UNAVAILABLE' }
  }
  if (profile.error) return { ok: false, status: 503, error: 'AUTHORIZATION_UNAVAILABLE' }
  const rows = profile.data
  const candidate = Array.isArray(rows) ? (rows.length === 1 ? rows[0] : null) : rows
  if (!isObj(candidate)) return { ok: false, status: 403, error: 'FORBIDDEN' }
  const identity = candidate.user_id ?? candidate.id
  if (identity !== userId || candidate.is_active !== true) return { ok: false, status: 403, error: 'FORBIDDEN' }
  if (typeof candidate.business_id !== 'string' || !UUID.test(candidate.business_id)) {
    return { ok: false, status: 403, error: 'NO_BUSINESS' }
  }
  if (typeof candidate.role !== 'string' || !MANAGER_ROLES.includes(candidate.role)) {
    return { ok: false, status: 403, error: 'FORBIDDEN' }
  }
  return { ok: true, actor: { userId, businessId: candidate.business_id.toLowerCase() } }
}

/**
 * SQLSTATE/mensaje de create_business_invitation → código controlado. Mismo vocabulario que
 * `src/services/invitationsService.ts`; nunca se devuelve el texto de la DB.
 */
export function classifyCreateError(error: PgError): { status: number; error: string } {
  const code = error.code ?? ''
  const message = error.message ?? ''
  if (code === 'CLIENT_UPDATE_REQUIRED' || message.includes('CLIENT_UPDATE_REQUIRED')) {
    return { status: 409, error: 'CLIENT_UPDATE_REQUIRED' }
  }
  if (code === 'TRIVE' || message.includes('INVALID_EMAIL')) return { status: 422, error: 'INVALID_EMAIL' }
  if (code === 'TRIVR' || message.includes('INVALID_ROLE')) return { status: 422, error: 'INVALID_ROLE' }
  if (code === 'TRNOB' || message.includes('NO_BUSINESS')) return { status: 403, error: 'NO_BUSINESS' }
  if (message.includes('NOT_AUTHENTICATED')) return { status: 401, error: 'NOT_AUTHENTICATED' }
  if (code === '42501' || message.includes('FORBIDDEN')) return { status: 403, error: 'FORBIDDEN' }
  if (code === '23505') return { status: 409, error: 'INVITATION_NOT_PENDING' }
  return { status: 500, error: 'UNKNOWN' }
}

export async function handleInvitationRequest(req: Request, deps: InvitationDeps): Promise<Response> {
  const { cors } = deps
  const json = (body: unknown, status = 200) => cors.json(req, body, status)
  const fail = (status: number, error: string) => json({ ok: false, error }, status)

  // ── 1. Método ──
  if (req.method === 'OPTIONS') return cors.preflight(req)
  if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED')

  // ── 2 + 3. Identidad y actor, antes de mirar el body ──
  const jwt = req.headers.get('Authorization')?.match(BEARER)?.[1] ?? null
  if (!jwt) return fail(401, 'NOT_AUTHENTICATED')
  const scope = deps.userScope(req, jwt)
  const resolved = await resolveActor(scope)
  if (!resolved.ok) return fail(resolved.status, resolved.error)
  const actor = resolved.actor

  // ── 4. Body acotado, allowlist estricta ──
  const declared = Number(req.headers.get('Content-Length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'TOO_LARGE')
  let raw: string
  try { raw = await req.text() } catch { return fail(400, 'BAD_REQUEST') }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return fail(413, 'TOO_LARGE')
  let body: unknown
  try { body = JSON.parse(raw) } catch { return fail(400, 'BAD_REQUEST') }
  if (!isObj(body)) return fail(400, 'BAD_REQUEST')
  const action = body.action
  if (typeof action !== 'string' || !(INVITATION_ACTIONS as readonly string[]).includes(action)) {
    return fail(400, 'UNKNOWN_ACTION')
  }
  const allowed = ACTION_FIELDS[action as InvitationAction]
  if (Object.keys(body).some((field) => !allowed.includes(field))) return fail(400, 'UNEXPECTED_FIELD')

  // ── 5. Acción ──
  let row: InvitationRow
  let idempotencyKey: string
  if (action === 'create_and_send') {
    const email = body.email
    const role = body.role
    if (typeof email !== 'string' || email.trim().length === 0 || email.length > MAX_EMAIL_LENGTH) {
      return fail(422, 'INVALID_EMAIL')
    }
    if (typeof role !== 'string' || role.length === 0 || role.length > 32) return fail(422, 'INVALID_ROLE')

    // La RPC es la autoridad: deriva el negocio del JWT, valida owner/admin, normaliza el
    // correo, valida el rol, serializa y devuelve la pending (idempotente). No se inserta
    // nunca directo en business_invitations.
    let created: ScopedResult
    try {
      created = await scope.rpc('create_business_invitation', { p_email: email, p_role: role })
    } catch {
      return fail(503, 'INVITATION_UNAVAILABLE')
    }
    if (created.error) {
      const mapped = classifyCreateError(created.error)
      return fail(mapped.status, mapped.error)
    }
    const parsed = parseInvitationRow(created.data)
    if (!parsed) return fail(500, 'UNKNOWN')
    // Defensa en profundidad: la RPC deriva el negocio del mismo actor; si no coincide, no
    // se envía nada.
    if (parsed.business_id.toLowerCase() !== actor.businessId) return fail(403, 'FORBIDDEN')
    if (parsed.status !== 'pending' || Date.parse(parsed.expires_at) <= deps.now().getTime()) {
      return fail(409, 'INVITATION_NOT_PENDING')
    }
    row = parsed
    idempotencyKey = createIdempotencyKey(row.id)
  } else {
    const invitationId = body.invitation_id
    if (typeof invitationId !== 'string' || !UUID.test(invitationId)) return fail(400, 'BAD_REQUEST')

    let loaded: ScopedResult
    try {
      loaded = await scope.invitation(invitationId.toLowerCase(), actor.businessId)
    } catch {
      return fail(503, 'INVITATION_UNAVAILABLE')
    }
    if (loaded.error) return fail(503, 'INVITATION_UNAVAILABLE')
    if (loaded.data === null || loaded.data === undefined) return fail(404, 'INVITATION_NOT_FOUND')
    const parsed = parseInvitationRow(loaded.data)
    if (!parsed) return fail(409, 'INVITATION_NOT_PENDING')
    // Mismo negocio que el actor, explícito (además de la RLS). Respuesta no enumerativa.
    if (parsed.business_id.toLowerCase() !== actor.businessId) return fail(404, 'INVITATION_NOT_FOUND')
    if (parsed.status === 'cancelled') return fail(409, 'INVITATION_CANCELLED')
    if (parsed.status === 'accepted') return fail(409, 'INVITATION_ALREADY_USED')
    if (parsed.status === 'expired') return fail(409, 'INVITATION_EXPIRED')
    if (parsed.status !== 'pending') return fail(409, 'INVITATION_NOT_PENDING')
    if (Date.parse(parsed.expires_at) <= deps.now().getTime()) return fail(409, 'INVITATION_EXPIRED')
    row = parsed
    idempotencyKey = resendIdempotencyKey(row.id, deps.now())
  }

  // ── 6. Entrega: todo sale de la fila ──
  let businessName: string | null = null
  try {
    const named = await scope.businessName(row.business_id)
    const namedRow = Array.isArray(named.data) ? named.data[0] : named.data
    if (!named.error && isObj(namedRow) && sanitizeHeaderText(namedRow.name)) businessName = namedRow.name as string
  } catch {
    businessName = null
  }

  const rendered = renderInvitationEmail({
    businessName: businessName ?? '',
    role: row.role,
    acceptUrl: buildInvitationUrl(row.token, deps.appOrigin),
  })

  let outcome: DeliveryOutcome
  try {
    outcome = await deliverViaResend(deps.fetchImpl, deps.resendApiKey(), {
      to: row.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    }, idempotencyKey)
  } catch {
    outcome = { status: 'failed', code: 'provider_error', httpStatus: null }
  }

  try {
    deps.log({
      fn: 'send-business-invitation',
      action: action as InvitationAction,
      invitation_id: row.id,
      delivery: outcome.status,
      code: outcome.status === 'failed' ? outcome.code : null,
      provider_status: outcome.httpStatus,
      business_name: businessName ? 'ok' : 'fallback',
    })
  } catch { /* el log nunca cambia el resultado */ }

  return json({
    ok: true,
    invitation: view(row),
    delivery: outcome.status === 'sent' ? { status: 'sent' } : { status: 'failed', code: outcome.code },
  })
}
