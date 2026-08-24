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

export const businessSetupService = {
  getMyBusinessSetup,
  updateMyBusinessSetup,
}
