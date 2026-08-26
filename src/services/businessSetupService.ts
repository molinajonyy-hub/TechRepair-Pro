import { supabase } from '../lib/supabase'

/**
 * P0-P5 — Única fuente para leer y persistir la configuración del negocio.
 *
 * El onboarding NO crea tenants: eso lo hace `provision_my_business()` y nadie
 * más. Acá se CONFIGURA un negocio que ya existe.
 *
 * Por qué RPC y no `supabase.from('businesses').update(...)`:
 *   · `authenticated` NO tiene GRANT de UPDATE sobre `businesses` (sólo SELECT),
 *     y reponerlo dejaría al cliente tocar `owner_user_id` o `subscription_*`
 *     — la policy filtra por FILA, no por COLUMNA;
 *   · la mitad de los campos del wizard ni siquiera viven en `businesses`
 *     (`cuit` y `condicion_iva` están en `business_settings`), así que el
 *     frontend no debería tener que saber qué campo va a qué tabla.
 *
 * El negocio se deriva server-side de `auth.uid()`. Acá NO se manda business_id:
 * por eso el cross-tenant es imposible por construcción y no por chequeo.
 */

export type BusinessSetupErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'FORBIDDEN'
  | 'NO_BUSINESS'
  | 'INVALID_NAME'
  | 'INVALID_RUBRO'
  | 'INVALID_WHATSAPP'
  | 'INVALID_CUIT'
  | 'INVALID_CONDICION_FISCAL'
  | 'ONBOARDING_INCOMPLETE'
  | 'UNKNOWN'

const MENSAJES: Record<BusinessSetupErrorCode, string> = {
  NOT_AUTHENTICATED:        'Tenés que iniciar sesión para continuar.',
  FORBIDDEN:                'Sólo el dueño o un administrador pueden cambiar la configuración del negocio.',
  NO_BUSINESS:              'Todavía no tenés un negocio asociado.',
  INVALID_NAME:             'El nombre del negocio no puede quedar vacío.',
  INVALID_RUBRO:            'Elegí uno de los rubros de la lista.',
  INVALID_WHATSAPP:         'Revisá el WhatsApp: tiene demasiados dígitos.',
  INVALID_CUIT:             'El CUIT tiene que tener 11 dígitos.',
  INVALID_CONDICION_FISCAL: 'Elegí una de las condiciones fiscales de la lista.',
  ONBOARDING_INCOMPLETE:    'Faltan datos obligatorios. Volvé y completá el nombre y el rubro.',
  UNKNOWN:                  'No se pudo guardar la configuración. Intentá nuevamente.',
}

export class BusinessSetupError extends Error {
  readonly code: BusinessSetupErrorCode
  constructor(code: BusinessSetupErrorCode) {
    super(MENSAJES[code])
    this.name = 'BusinessSetupError'
    this.code = code
  }
}

/**
 * SQLSTATE -> código semántico.
 *
 * `42501` lo comparten NOT_AUTHENTICATED y FORBIDDEN, así que el SQLSTATE solo
 * no alcanza; y distintas versiones de PostgREST propagan el `code` de forma
 * distinta, así que el mensaje solo tampoco. Se miran los dos, igual que en
 * provisioningService e invitationsService.
 */
const POR_SQLSTATE: Record<string, BusinessSetupErrorCode> = {
  TRNOB: 'NO_BUSINESS',
  TRIVN: 'INVALID_NAME',
  TRIVU: 'INVALID_RUBRO',
  TRIVW: 'INVALID_WHATSAPP',
  TRIVC: 'INVALID_CUIT',
  TRIVF: 'INVALID_CONDICION_FISCAL',
  TRONB: 'ONBOARDING_INCOMPLETE',
}

const POR_MENSAJE: ReadonlyArray<[string, BusinessSetupErrorCode]> = [
  ['ONBOARDING_INCOMPLETE',    'ONBOARDING_INCOMPLETE'],
  ['INVALID_CONDICION_FISCAL', 'INVALID_CONDICION_FISCAL'],
  ['INVALID_WHATSAPP',         'INVALID_WHATSAPP'],
  ['INVALID_RUBRO',            'INVALID_RUBRO'],
  ['INVALID_NAME',             'INVALID_NAME'],
  ['INVALID_CUIT',             'INVALID_CUIT'],
  ['NOT_AUTHENTICATED',        'NOT_AUTHENTICATED'],
  ['NO_BUSINESS',              'NO_BUSINESS'],
  ['FORBIDDEN',                'FORBIDDEN'],
]

export function clasificarError(error: { code?: string; message?: string } | null): BusinessSetupErrorCode {
  if (!error) return 'UNKNOWN'

  const porCodigo = error.code ? POR_SQLSTATE[error.code] : undefined
  if (porCodigo) return porCodigo

  const mensaje = error.message ?? ''
  for (const [marca, codigo] of POR_MENSAJE) {
    if (mensaje.includes(marca)) return codigo
  }

  if (error.code === '42501') return 'FORBIDDEN'
  return 'UNKNOWN'
}

const fallar = (error: { code?: string; message?: string } | null): never => {
  throw new BusinessSetupError(clasificarError(error))
}

export interface BusinessSetup {
  businessId: string
  name: string
  rubro: string | null
  ciudad: string | null
  whatsapp: string | null
  logoUrl: string | null
  cuit: string | null
  condicionFiscal: string | null
  onboardingCompleted: boolean
  role: string | null
  canEdit: boolean
}

/** `null` en un campo = «no tocar». Es lo que permite guardar paso por paso. */
export interface BusinessSetupPatch {
  name?: string | null
  rubro?: string | null
  ciudad?: string | null
  whatsapp?: string | null
  condicionFiscal?: string | null
  cuit?: string | null
  logoUrl?: string | null
  complete?: boolean
}

const mapear = (fila: Record<string, unknown> | null): BusinessSetup => {
  if (!fila?.business_id) throw new BusinessSetupError('UNKNOWN')
  return {
    businessId:          String(fila.business_id),
    name:                (fila.name as string) ?? '',
    rubro:               (fila.rubro as string) ?? null,
    ciudad:              (fila.ciudad as string) ?? null,
    whatsapp:            (fila.whatsapp as string) ?? null,
    logoUrl:             (fila.logo_url as string) ?? null,
    cuit:                (fila.cuit as string) ?? null,
    condicionFiscal:     (fila.condicion_fiscal as string) ?? null,
    onboardingCompleted: !!fila.onboarding_completed,
    role:                (fila.role as string) ?? null,
    canEdit:             !!fila.can_edit,
  }
}

/**
 * Configuración actual del negocio del usuario.
 *
 * Es lo que hace posible la REANUDACIÓN: el wizard precarga desde acá en vez de
 * depender del estado de React, así que cerrar la pestaña en el paso 3 y volver
 * no pierde lo que ya se guardó.
 */
export async function getMyBusinessSetup(): Promise<BusinessSetup> {
  const { data, error } = await supabase.rpc('get_my_business_onboarding')
  if (error) fallar(error)
  return mapear((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null)
}

/**
 * Persiste un subconjunto de la configuración y devuelve el estado resultante.
 *
 * Los campos ausentes (`undefined`) viajan como `null`, que el servidor
 * interpreta como «no tocar»: un paso posterior nunca pisa lo que guardó uno
 * anterior.
 */
export async function updateMyBusinessSetup(patch: BusinessSetupPatch): Promise<BusinessSetup> {
  const { data, error } = await supabase.rpc('update_my_business_onboarding', {
    p_name:             patch.name             ?? null,
    p_rubro:            patch.rubro            ?? null,
    p_ciudad:           patch.ciudad           ?? null,
    p_whatsapp:         patch.whatsapp         ?? null,
    p_condicion_fiscal: patch.condicionFiscal  ?? null,
    p_cuit:             patch.cuit             ?? null,
    p_logo_url:         patch.logoUrl          ?? null,
    p_complete:         patch.complete         ?? false,
  })
  if (error) fallar(error)
  return mapear((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null)
}

// ═════════════════════════════════════════════════════════════════════════════
// P0-ONBOARDING-1 — Perfil canónico completo
//
// `getMyBusinessSetup` / `updateMyBusinessSetup` (arriba) siguen siendo el
// contrato del WIZARD y no cambian: su firma es la que está desplegada.
//
// Lo de abajo es el contrato COMPLETO, el que usa Configuración. Vive en la
// misma capa a propósito: que existan dos writers para el mismo dato es
// exactamente el defecto que este lote cierra, así que Settings deja de hacer
// `supabase.from('business_settings').upsert(...)` y pasa por acá.
//
// Contrato del patch — TRES estados, y por eso `undefined` y `null` NO son lo
// mismo:
//   · campo AUSENTE (`undefined`) -> no se toca;
//   · campo con texto             -> se escribe;
//   · campo `null` o `''`         -> se BORRA.
// ═════════════════════════════════════════════════════════════════════════════

export interface BusinessProfile {
  businessId: string
  /** AUTORIDAD comercial. Es lo que imprimen comprobantes, órdenes y garantías. */
  nombreComercial: string | null
  razonSocial: string | null
  cuit: string | null
  /** Slug canónico. Ver `src/lib/fiscalCondition.ts`. */
  condicionIva: string | null
  domicilioFiscal: string | null
  localidad: string | null
  provincia: string | null
  codigoPostal: string | null
  telefono: string | null
  email: string | null
  observacionesComprobantes: string | null
  logoUrl: string | null
  rubro: string | null
  /** `businesses.name` — espejo técnico. Sólo para diagnóstico; NO imprimir. */
  businessNameMirror: string | null
  onboardingCompleted: boolean
  role: string | null
  canEdit: boolean
}

export interface BusinessProfilePatch {
  nombreComercial?: string | null
  razonSocial?: string | null
  cuit?: string | null
  condicionIva?: string | null
  domicilioFiscal?: string | null
  localidad?: string | null
  provincia?: string | null
  codigoPostal?: string | null
  telefono?: string | null
  email?: string | null
  observacionesComprobantes?: string | null
  logoUrl?: string | null
  rubro?: string | null
}

/** camelCase del frontend -> claves del patch jsonb que espera la RPC. */
const CLAVES_PATCH: ReadonlyArray<[keyof BusinessProfilePatch, string]> = [
  ['nombreComercial',           'nombre_comercial'],
  ['razonSocial',               'razon_social'],
  ['cuit',                      'cuit'],
  ['condicionIva',              'condicion_iva'],
  ['domicilioFiscal',           'domicilio_fiscal'],
  ['localidad',                 'localidad'],
  ['provincia',                 'provincia'],
  ['codigoPostal',              'codigo_postal'],
  ['telefono',                  'telefono'],
  ['email',                     'email'],
  ['observacionesComprobantes', 'observaciones_comprobantes'],
  ['logoUrl',                   'logo_url'],
  ['rubro',                     'rubro'],
]

const txt = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? null : s
}

const mapearPerfil = (fila: Record<string, unknown> | null): BusinessProfile => {
  if (!fila?.business_id) throw new BusinessSetupError('UNKNOWN')
  return {
    businessId:                String(fila.business_id),
    nombreComercial:           txt(fila.nombre_comercial),
    razonSocial:               txt(fila.razon_social),
    cuit:                      txt(fila.cuit),
    condicionIva:              txt(fila.condicion_iva),
    domicilioFiscal:           txt(fila.domicilio_fiscal),
    localidad:                 txt(fila.localidad),
    provincia:                 txt(fila.provincia),
    codigoPostal:              txt(fila.codigo_postal),
    telefono:                  txt(fila.telefono),
    email:                     txt(fila.email),
    observacionesComprobantes: txt(fila.observaciones_comprobantes),
    logoUrl:                   txt(fila.logo_url),
    rubro:                     txt(fila.rubro),
    businessNameMirror:        txt(fila.business_name_mirror),
    onboardingCompleted:       !!fila.onboarding_completed,
    role:                      txt(fila.role),
    canEdit:                   !!fila.can_edit,
  }
}

/** Perfil completo del negocio del usuario. El tenant se deriva server-side. */
export async function getMyBusinessProfile(): Promise<BusinessProfile> {
  const { data, error } = await supabase.rpc('get_my_business_profile')
  if (error) fallar(error)
  return mapearPerfil((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null)
}

/**
 * Persiste un subconjunto del perfil y devuelve el estado resultante.
 *
 * El patch se arma con `hasOwnProperty` y NO con un chequeo de valor:
 * `{ provincia: null }` tiene que llegar como «borrala», y un
 * `if (patch.provincia)` lo convertiría en «no la toques». Es la distinción que
 * hace que guardar un paso no pise lo que guardó otro.
 */
export async function updateMyBusinessProfile(
  patch: BusinessProfilePatch,
  complete = false,
): Promise<BusinessProfile> {
  const payload: Record<string, string> = {}
  for (const [campo, clave] of CLAVES_PATCH) {
    if (!Object.prototype.hasOwnProperty.call(patch, campo)) continue
    const valor = patch[campo]
    payload[clave] = valor == null ? '' : String(valor)
  }

  const { data, error } = await supabase.rpc('update_my_business_profile', {
    p_patch:    payload,
    p_complete: complete,
  })
  if (error) fallar(error)
  return mapearPerfil((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null)
}

export const businessSetupService = {
  getMyBusinessSetup,
  updateMyBusinessSetup,
  getMyBusinessProfile,
  updateMyBusinessProfile,
}
