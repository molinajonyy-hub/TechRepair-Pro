import { supabase } from '../lib/supabase'

/**
 * P0-P2 — Único punto del frontend que crea, acepta o cancela invitaciones.
 *
 * La autoridad vive en la DB (migración 20260824120000). Acá NO se decide nada:
 *   · crear   -> el negocio destino lo deriva el servidor de `auth.uid()`.
 *                No se manda business_id.
 *   · aceptar -> el ÚNICO dato que viaja es el token. No se manda user_id (sería
 *                suplantación), ni email (sería un oráculo y anularía la
 *                validación server-side), ni business_id, ni role.
 *   · cancelar-> pasa por RPC. `authenticated` no tiene UPDATE sobre la tabla,
 *                así que el `.update()` directo que había antes no podía
 *                funcionar ni aunque el status hubiese sido válido.
 *
 * Invariante del sistema, complementaria a provisioningService:
 *   provision_my_business()      = única autoridad que CREA businesses
 *   accept_business_invitation() = incorpora a un business EXISTENTE, nunca crea
 */

/** Códigos semánticos que emite la DB. Espejo del contrato de la migración. */
export type InvitationErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'FORBIDDEN'
  | 'EMAIL_NOT_CONFIRMED'
  | 'INVALID_EMAIL'
  | 'INVALID_ROLE'
  | 'NO_BUSINESS'
  | 'INVITATION_NOT_FOUND'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_CANCELLED'
  | 'INVITATION_EMAIL_MISMATCH'
  | 'INVITATION_ALREADY_USED'
  | 'INVITATION_NOT_PENDING'
  | 'ALREADY_MEMBER_OF_ANOTHER_BUSINESS'
  | 'UNKNOWN'

/**
 * Mensajes de UI. El `message` del error YA es el texto que ve el usuario: así
 * ningún caller puede filtrar por accidente un SQLSTATE ni un
 * `function gen_random_bytes(integer) does not exist` a la pantalla.
 */
const MENSAJES: Record<InvitationErrorCode, string> = {
  NOT_AUTHENTICATED:  'Tenés que iniciar sesión para continuar.',
  FORBIDDEN:          'No tenés permisos para gestionar invitaciones.',
  EMAIL_NOT_CONFIRMED:'Confirmá tu correo antes de aceptar la invitación. Revisá tu bandeja de entrada.',
  INVALID_EMAIL:      'Revisá el correo: no parece una dirección válida.',
  INVALID_ROLE:       'El rol seleccionado no es válido.',
  NO_BUSINESS:        'Tu usuario todavía no tiene un negocio asociado.',
  INVITATION_NOT_FOUND:      'No encontramos esa invitación. Revisá el enlace o pedí uno nuevo.',
  INVITATION_EXPIRED:        'La invitación venció. Pedile al administrador que te envíe una nueva.',
  INVITATION_CANCELLED:      'Esa invitación fue cancelada. Pedile al administrador que te envíe una nueva.',
  INVITATION_EMAIL_MISMATCH: 'Esta invitación es para otra dirección de correo. Iniciá sesión con la cuenta a la que fue enviada.',
  INVITATION_ALREADY_USED:   'Esa invitación ya fue utilizada.',
  INVITATION_NOT_PENDING:    'Esa invitación ya no está pendiente.',
  ALREADY_MEMBER_OF_ANOTHER_BUSINESS:
    'Tu cuenta ya pertenece a otro negocio. Por ahora un usuario no puede estar en dos negocios a la vez.',
  UNKNOWN:            'No se pudo completar la operación. Intentá nuevamente.',
}

export class InvitationError extends Error {
  readonly code: InvitationErrorCode
  constructor(code: InvitationErrorCode) {
    super(MENSAJES[code])
    this.name = 'InvitationError'
    this.code = code
  }
}

/**
 * SQLSTATE -> código semántico.
 *
 * `42501` está compartido por tres casos distintos (no autenticado, sin
 * permisos, correo sin confirmar), así que el SQLSTATE solo NO alcanza: hay que
 * mirar también el mensaje. Y al revés, distintas versiones de PostgREST
 * propagan el `code` de forma distinta, así que tampoco alcanza el mensaje solo.
 * Se miran los dos, igual que en provisioningService.
 */
const POR_SQLSTATE: Record<string, InvitationErrorCode> = {
  TRIVE: 'INVALID_EMAIL',
  TRIVR: 'INVALID_ROLE',
  TRNOB: 'NO_BUSINESS',
  TRINF: 'INVITATION_NOT_FOUND',
  TRIEX: 'INVITATION_EXPIRED',
  TRICA: 'INVITATION_CANCELLED',
  TRIEM: 'INVITATION_EMAIL_MISMATCH',
  TRIAU: 'INVITATION_ALREADY_USED',
  TRINP: 'INVITATION_NOT_PENDING',
  TRIAM: 'ALREADY_MEMBER_OF_ANOTHER_BUSINESS',
}

/** Orden importante: los más específicos primero. */
const POR_MENSAJE: ReadonlyArray<[string, InvitationErrorCode]> = [
  ['INVITATION_EMAIL_MISMATCH', 'INVITATION_EMAIL_MISMATCH'],
  ['INVITATION_NOT_FOUND',      'INVITATION_NOT_FOUND'],
  ['INVITATION_EXPIRED',        'INVITATION_EXPIRED'],
  ['INVITATION_CANCELLED',      'INVITATION_CANCELLED'],
  ['INVITATION_ALREADY_USED',   'INVITATION_ALREADY_USED'],
  ['INVITATION_NOT_PENDING',    'INVITATION_NOT_PENDING'],
  ['ALREADY_MEMBER_OF_ANOTHER_BUSINESS', 'ALREADY_MEMBER_OF_ANOTHER_BUSINESS'],
  ['EMAIL_NOT_CONFIRMED',       'EMAIL_NOT_CONFIRMED'],
  ['NOT_AUTHENTICATED',         'NOT_AUTHENTICATED'],
  ['INVALID_EMAIL',             'INVALID_EMAIL'],
  ['INVALID_ROLE',              'INVALID_ROLE'],
  ['NO_BUSINESS',               'NO_BUSINESS'],
  ['FORBIDDEN',                 'FORBIDDEN'],
]

export function clasificarError(error: { code?: string; message?: string } | null): InvitationErrorCode {
  if (!error) return 'UNKNOWN'

  const porCodigo = error.code ? POR_SQLSTATE[error.code] : undefined
  if (porCodigo) return porCodigo

  const mensaje = error.message ?? ''
  for (const [marca, codigo] of POR_MENSAJE) {
    if (mensaje.includes(marca)) return codigo
  }

  // 42501 sin ninguna marca reconocible: es un rechazo de autorización real.
  if (error.code === '42501') return 'FORBIDDEN'

  // 23505 = choque contra el índice único parcial de pending. En la práctica el
  // advisory lock lo evita, pero si dos nodos empatan igual, para el usuario es
  // "ya hay una invitación pendiente", no un error de base de datos.
  if (error.code === '23505') return 'INVITATION_NOT_PENDING'

  return 'UNKNOWN'
}

const fallar = (error: { code?: string; message?: string } | null): never => {
  throw new InvitationError(clasificarError(error))
}

export interface Invitation {
  id: string
  business_id: string
  email: string
  role: string
  token: string
  status: string
  expires_at: string
  created_at: string
}

export interface AcceptResult {
  businessId: string | null
  role: string | null
  /** `false` cuando el usuario ya era miembro: la aceptación fue un no-op. */
  created: boolean
  status: 'ACCEPTED' | 'ALREADY_MEMBER'
}

/**
 * Crea —o recupera— la invitación pendiente para ese correo.
 *
 * Idempotente por contrato del servidor: doble click, retry o reenvío devuelven
 * la MISMA invitación con el MISMO token en vez de crear filas nuevas.
 *
 * No recibe `businessId`: el servidor lo deriva del actor. La firma vieja de 3
 * argumentos fue retirada en la migración 20260824120000.
 */
export async function createInvitation(email: string, role: string): Promise<Invitation> {
  const { data, error } = await supabase.rpc('create_business_invitation', {
    p_email: email,
    p_role: role,
  })

  if (error) fallar(error)

  const fila = (Array.isArray(data) ? data[0] : data) as Invitation | null
  if (!fila?.token) {
    throw new InvitationError('UNKNOWN')
  }
  return fila
}

/**
 * Acepta la invitación. El token es el único dato que viaja.
 *
 * TOLERANCIA DE FORMA (deliberada): la RPC canónica devuelve jsonb, pero la
 * versión anterior devolvía un uuid suelto. Durante la ventana de rollout
 * —frontend nuevo, DB todavía vieja— puede llegar cualquiera de las dos. Se
 * aceptan ambas para que la pantalla no se rompa por la forma del payload; el
 * accept viejo igual falla del lado del servidor por otros motivos.
 */
export async function acceptInvitation(token: string): Promise<AcceptResult> {
  const { data, error } = await supabase.rpc('accept_business_invitation', {
    p_token: token.trim(),
  })

  if (error) fallar(error)

  if (typeof data === 'string' || data == null) {
    // Contrato viejo (uuid del profile) o vacío: se acepta como éxito, pero sin
    // datos de negocio. El caller refresca el perfil y lee la verdad de ahí.
    return { businessId: null, role: null, created: true, status: 'ACCEPTED' }
  }

  const fila = (Array.isArray(data) ? data[0] : data) as {
    business_id?: string
    role?: string
    created?: boolean
    status?: string
  }

  return {
    businessId: fila?.business_id ?? null,
    role: fila?.role ?? null,
    created: !!fila?.created,
    status: fila?.status === 'ALREADY_MEMBER' ? 'ALREADY_MEMBER' : 'ACCEPTED',
  }
}

/**
 * Cancela una invitación pendiente.
 *
 * El estado válido es `cancelled` — así lo dice el CHECK de la tabla. El código
 * anterior escribía `'revoked'` con un `.update()` directo, que estaba roto por
 * partida doble: el valor no existe en el CHECK y `authenticated` ni siquiera
 * tiene UPDATE sobre la tabla.
 */
export async function cancelInvitation(invitationId: string): Promise<Invitation> {
  const { data, error } = await supabase.rpc('cancel_business_invitation', {
    p_invitation_id: invitationId,
  })

  if (error) fallar(error)

  const fila = (Array.isArray(data) ? data[0] : data) as Invitation | null
  if (!fila?.id) throw new InvitationError('UNKNOWN')
  return fila
}

/**
 * Invitaciones pendientes del negocio.
 *
 * Se filtran también las VENCIDAS: `expire_old_invitations()` existe pero no
 * está agendada en cron, así que una invitación con `status = 'pending'` y
 * `expires_at` en el pasado seguiría apareciendo como utilizable cuando ya no lo
 * es. El filtro por fecha es la misma condición que aplica el servidor al
 * aceptar, así que la lista no promete nada que el accept vaya a rechazar.
 */
export async function listPendingInvitations(businessId: string): Promise<Invitation[]> {
  const { data, error } = await supabase
    .from('business_invitations')
    .select('*')
    .eq('business_id', businessId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error('No se pudieron cargar las invitaciones.')
  }

  return data || []
}

export const invitationsService = {
  createInvitation,
  acceptInvitation,
  cancelInvitation,
  listPendingInvitations,
}
