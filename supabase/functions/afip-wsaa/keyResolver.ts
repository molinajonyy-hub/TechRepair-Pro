/**
 * AFIP-S2 — Resolución de la clave privada de firma WSAA.
 *
 * Módulo PURO e inyectable (sin Deno/Supabase/node-forge) para poder testearlo
 * bajo `node --test`, igual que afip-cae/logic.ts. El Edge inyecta la lectura
 * real de Vault (public.arca_get_credential_for_signing vía service_role).
 *
 * Regla crítica (S2): fallback a la clave plaintext de arca_config SOLO cuando la
 * credencial Vault todavía NO fue provisionada. Una credencial Vault configurada
 * pero rota (secreto ausente/ilegible/inválido/no-activa) FALLA de forma visible;
 * nunca cae en silencio a legacy (eso ocultaría corrupción o una migración a
 * medias). La clave nunca se loguea, ni se audita, ni se devuelve al cliente.
 */

/** Estados de resolución (internos; se mapean a error fiscal sanitizado). */
export type KeyResolutionState =
  | 'VAULT_CREDENTIAL_ACTIVE'
  | 'VAULT_CREDENTIAL_NOT_PROVISIONED'
  | 'VAULT_SECRET_MISSING'
  | 'VAULT_SECRET_UNREADABLE'
  | 'VAULT_SECRET_INVALID'
  | 'LEGACY_PRIVATE_KEY_MISSING'
  | 'LEGACY_PRIVATE_KEY_INVALID'

export type KeySource = 'vault' | 'legacy_plaintext'

export interface ResolvedKey {
  privateKey: string
  source: KeySource
  state: 'VAULT_CREDENTIAL_ACTIVE' | 'VAULT_CREDENTIAL_NOT_PROVISIONED'
}

/** Forma que devuelve public.arca_get_credential_for_signing (jsonb). */
export interface VaultCredentialResult {
  provisioned: boolean
  ok?: boolean
  reason?: 'not_active' | 'secret_missing' | string
  pem?: string | null
}

/** Error de resolución con estado interno + mensaje externo sanitizado. */
export class WsaaKeyError extends Error {
  readonly state: KeyResolutionState
  readonly publicMessage: string
  constructor(state: KeyResolutionState, publicMessage: string) {
    super(state) // el `message` interno es el estado; NUNCA lleva PEM/secreto
    this.name = 'WsaaKeyError'
    this.state = state
    this.publicMessage = publicMessage
  }
}

/**
 * Clasifica el contenido de un supuesto PEM de clave privada.
 * Acepta 'private' solo si hay EXACTAMENTE un bloque PRIVATE KEY (RSA/EC/PKCS8)
 * bien cerrado y NINGÚN bloque de certificado o clave pública.
 */
export function classifyPrivateKeyPem(input: unknown): 'private' | 'certificate' | 'public' | 'empty' | 'invalid' {
  const s = typeof input === 'string' ? input.trim() : ''
  if (!s) return 'empty'
  if (/-----BEGIN CERTIFICATE-----/.test(s)) return 'certificate'
  if (/-----BEGIN (?:RSA |EC )?PUBLIC KEY-----/.test(s)) return 'public'
  const beginRe = /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g
  const endRe = /-----END (?:RSA |EC )?PRIVATE KEY-----/g
  const begins = (s.match(beginRe) || []).length
  const ends = (s.match(endRe) || []).length
  if (begins !== 1 || ends !== 1) return 'invalid'   // 0, o múltiples bloques ambiguos
  // Debe haber cuerpo base64 no trivial entre los delimitadores.
  const body = s.replace(beginRe, '').replace(endRe, '').replace(/\s+/g, '')
  if (body.length < 32) return 'invalid'             // truncado
  return 'private'
}

/**
 * Resuelve la clave privada de firma. `getVaultCredential` lee el contrato Vault
 * (puede lanzar si la RPC falla → VAULT_SECRET_UNREADABLE). `legacyPrivateKey` es
 * arca_config.private_key (plaintext temporal), usado SOLO si Vault no está
 * provisionado.
 */
export async function resolveArcaPrivateKey(opts: {
  getVaultCredential: () => Promise<VaultCredentialResult>
  legacyPrivateKey: string | null | undefined
}): Promise<ResolvedKey> {
  let cred: VaultCredentialResult
  try {
    cred = await opts.getVaultCredential()
  } catch {
    // La RPC/almacén no respondió: NO caemos a legacy (podría ocultar Vault roto).
    throw new WsaaKeyError('VAULT_SECRET_UNREADABLE', 'No se pudo acceder al almacén seguro de la credencial.')
  }

  if (!cred || cred.provisioned !== true) {
    // ── Fallback legacy: solo cuando la credencial Vault NO fue provisionada ──
    const legacy = (opts.legacyPrivateKey ?? '').trim()
    if (!legacy) throw new WsaaKeyError('LEGACY_PRIVATE_KEY_MISSING', 'No hay clave privada configurada para este negocio.')
    if (classifyPrivateKeyPem(legacy) !== 'private') {
      throw new WsaaKeyError('LEGACY_PRIVATE_KEY_INVALID', 'La clave privada configurada no tiene un formato válido.')
    }
    return { privateKey: legacy, source: 'legacy_plaintext', state: 'VAULT_CREDENTIAL_NOT_PROVISIONED' }
  }

  // ── Credencial Vault provisionada ──
  if (cred.ok !== true) {
    // Configurada pero rota → FALLA VISIBLE (nunca legacy).
    if (cred.reason === 'secret_missing') {
      throw new WsaaKeyError('VAULT_SECRET_MISSING', 'La credencial segura está incompleta. Revisá la configuración fiscal.')
    }
    throw new WsaaKeyError('VAULT_SECRET_UNREADABLE', 'La credencial segura no está disponible. Revisá la configuración fiscal.')
  }
  const pem = (cred.pem ?? '').trim()
  if (classifyPrivateKeyPem(pem) !== 'private') {
    throw new WsaaKeyError('VAULT_SECRET_INVALID', 'La credencial segura es inválida. Revisá la configuración fiscal.')
  }
  return { privateKey: pem, source: 'vault', state: 'VAULT_CREDENTIAL_ACTIVE' }
}
