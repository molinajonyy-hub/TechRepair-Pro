import { supabase } from '../lib/supabase'

/**
 * ARCA Self-Service Phase 2A — cliente del asistente de configuración INICIAL.
 *
 * Único punto del navegador que habla con la Edge Function `arca-selfservice-setup`.
 * El navegador:
 *   · nunca genera claves ni maneja material privado (la clave se crea y guarda server-side);
 *   · sólo manda datos fiscales, el certificado PÚBLICO emitido por ARCA y claves de idempotencia;
 *   · nunca decide el paso: la pantalla sale de `get_arca_selfservice_status` (Phase 1) vía
 *     `deriveArcaSetupWizard`. Estas respuestas sólo informan el resultado de una acción.
 *
 * Idempotencia: `prepare` y `verify` reciben una clave estable por intento del usuario
 * (`newArcaSetupIdempotencyKey()`). Un reintento de red reusa la MISMA clave. Después de
 * cancelar, la clave queda consumida: hay que generar una nueva.
 *
 * Esperas: `retryAfterSeconds` sólo se muestra. Después de cualquier falla de verify, la pantalla se
 * vuelve a derivar de Phase 1 (`setup.verification_hold`), que es la autoridad de la espera.
 *
 * Contrato de UI: docs/arca-selfservice-phase2a/README.md (sección W).
 */

export const ARCA_SETUP_FUNCTION = 'arca-selfservice-setup'

export interface ArcaSetupFiscalData {
  cuit: string
  razon_social: string
  ambiente: 'homologacion' | 'produccion'
  punto_venta: number
  alias: string
}

export type ArcaSetupResult =
  | { ok: true; state: string; csr?: { pem: string; filename: string }; expiresAt?: string | null; connection?: 'connected' | null; remoteTicketPossible?: boolean }
  | { ok: false; state: string; retryAfterSeconds?: number }

/** Estados que el backend puede devolver; cualquier otro se trata como error genérico. */
export const ARCA_SETUP_STATES = [
  // éxito
  'SETUP_PREPARED', 'SETUP_ALREADY_PREPARED', 'CSR_AVAILABLE', 'CERTIFICATE_ATTACHED', 'CERTIFICATE_ALREADY_ATTACHED',
  'CERTIFICATE_REPLACED', 'ACTIVATED', 'ALREADY_ACTIVATED', 'SETUP_ALREADY_COMPLETED', 'SETUP_CANCELLED', 'SETUP_NOT_IN_PROGRESS',
  // datos
  'INVALID_CUIT', 'INVALID_AMBIENTE', 'INVALID_PUNTO_VENTA', 'INVALID_ALIAS', 'INVALID_RAZON_SOCIAL', 'INVALID_IDEMPOTENCY_KEY',
  'CUIT_TENANT_MISMATCH',
  // flujo
  'ARCA_ALREADY_CONFIGURED', 'SETUP_IN_PROGRESS', 'NO_SETUP_IN_PROGRESS', 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_KEY_CONSUMED',
  'CERTIFICATE_REQUIRED', 'CERTIFICATE_LOCKED_VERIFIED', 'VERIFICATION_IN_PROGRESS', 'CERTIFICATE_CHANGED', 'NOT_VERIFIED',
  // esperas decididas por la base (llevan retryAfterSeconds)
  'WSAA_RESULT_UNKNOWN', 'VERIFICATION_EXPIRED', 'VERIFICATION_COOLDOWN',
  // certificado
  'KEY_MATERIAL_NOT_ACCEPTED', 'CERTIFICATE_INVALID', 'CERTIFICATE_KEY_MISMATCH', 'CERTIFICATE_CUIT_MISMATCH',
  'CERTIFICATE_ALIAS_MISMATCH', 'CERTIFICATE_SUBJECT_MISMATCH', 'CERTIFICATE_EXPIRED', 'CERTIFICATE_NOT_YET_VALID',
  'CERTIFICATE_ISSUER_UNEXPECTED', 'TOO_LARGE',
  // verificación ARCA
  'WSAA_TICKET_ALREADY_ISSUED', 'WSAA_SERVICE_NOT_AUTHORIZED', 'WSAA_CERTIFICATE_REJECTED', 'WSAA_REJECTED', 'WSAA_UNAVAILABLE',
  'SIGNING_FAILED', 'ACTIVATION_PENDING', 'ACTIVATION_FAILED', 'FISCAL_IDENTITY_MISMATCH',
  // borde
  'FORBIDDEN', 'UNAUTHENTICATED', 'UNAUTHORIZED', 'KEY_GENERATION_FAILED', 'ARCA_FEATURE_REQUIRED', 'AUTHORIZATION_UNAVAILABLE', 'SETUP_UNAVAILABLE', 'BAD_REQUEST',
  'UNEXPECTED_FIELD', 'UNKNOWN_ACTION',
] as const

const KNOWN = new Set<string>(ARCA_SETUP_STATES)
/** Cota de presentación; la autoridad es la base. */
const MAX_RETRY_AFTER_SECONDS = 90_000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Parser acotado: copia sólo campos del contrato; nunca propaga texto libre del servidor. */
export function parseArcaSetupResponse(raw: unknown): ArcaSetupResult {
  if (!isObj(raw)) return { ok: false, state: 'SETUP_UNAVAILABLE' }
  const code = typeof raw.state === 'string' ? raw.state : typeof raw.error === 'string' ? raw.error : ''
  const state = KNOWN.has(code) ? code : 'SETUP_UNAVAILABLE'
  if (raw.ok !== true || !KNOWN.has(code)) {
    const retry = typeof raw.retry_after_seconds === 'number' && Number.isInteger(raw.retry_after_seconds)
      && raw.retry_after_seconds >= 1 && raw.retry_after_seconds <= MAX_RETRY_AFTER_SECONDS ? raw.retry_after_seconds : undefined
    return retry === undefined ? { ok: false, state } : { ok: false, state, retryAfterSeconds: retry }
  }
  const result: Extract<ArcaSetupResult, { ok: true }> = { ok: true, state }
  if (isObj(raw.csr) && typeof raw.csr.pem === 'string' && /^-----BEGIN CERTIFICATE REQUEST-----/.test(raw.csr.pem)
      && typeof raw.csr.filename === 'string' && /^[a-z0-9-]+\.csr$/.test(raw.csr.filename)) {
    result.csr = { pem: raw.csr.pem, filename: raw.csr.filename }
  }
  if (typeof raw.expires_at === 'string' || raw.expires_at === null) result.expiresAt = raw.expires_at as string | null
  if (raw.connection === 'connected') result.connection = raw.connection
  if (typeof raw.remote_ticket_possible === 'boolean') result.remoteTicketPossible = raw.remote_ticket_possible
  return result
}

async function invoke(body: Record<string, unknown>): Promise<ArcaSetupResult> {
  // Slug literal: el guard de CORS (G3) clasifica cada Edge Function llamada desde el navegador.
  const { data, error } = await supabase.functions.invoke('arca-selfservice-setup', { body })
  if (!error) return parseArcaSetupResponse(data)
  // supabase-js descarta el body en respuestas no-2xx: se lee del contexto si está.
  try {
    const context = (error as { context?: { json?: () => Promise<unknown> } }).context
    if (context?.json) return parseArcaSetupResponse(await context.json())
  } catch { /* sin body legible */ }
  return { ok: false, state: 'SETUP_UNAVAILABLE' }
}

export function newArcaSetupIdempotencyKey(): string {
  return `arca-setup-${crypto.randomUUID()}`
}

export const arcaSetupService = {
  /** Datos fiscales + genera la solicitud (CSR) server-side. Devuelve el archivo para ARCA. */
  prepare: (fiscal: ArcaSetupFiscalData, idempotencyKey: string) =>
    invoke({ action: 'prepare', idempotency_key: idempotencyKey, ...fiscal }),

  /** Vuelve a descargar la solicitud de la configuración en curso. */
  getRequestFile: () => invoke({ action: 'csr' }),

  /** Certificado PÚBLICO emitido por ARCA, pegado (PEM) o leído del archivo .crt. */
  attachCertificatePem: (certificatePem: string) => invoke({ action: 'certificate', certificate_pem: certificatePem }),

  /** .crt binario (DER) como base64. */
  attachCertificateDerBase64: (derBase64: string) => invoke({ action: 'certificate', certificate_der_base64: derBase64 }),

  /** Verifica con ARCA (sin emitir nada) y, si funciona, activa. Reintentable con la misma clave. */
  verifyAndActivate: (idempotencyKey: string) => invoke({ action: 'verify', idempotency_key: idempotencyKey }),

  /**
   * Abandona la configuración en curso. Idempotente. No revoca nada en ARCA: si
   * `remoteTicketPossible`, volver a configurar el mismo equipo puede requerir esperar.
   */
  cancel: () => invoke({ action: 'cancel' }),
}
