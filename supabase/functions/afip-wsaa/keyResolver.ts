/**
 * AFIP-S2 — Resolución de la clave privada de firma WSAA.
 * AFIP-S4C — VAULT-ONLY: el fallback a la clave plaintext fue RETIRADO.
 *
 * Módulo PURO e inyectable (sin Deno/Supabase/node-forge) para poder testearlo
 * bajo `node --test`, igual que afip-cae/logic.ts. El Edge inyecta la lectura
 * real de Vault (public.arca_get_credential_for_signing vía service_role).
 *
 * Regla crítica (S4C): la clave SIEMPRE sale de Vault. No hay segunda fuente.
 * Si la credencial no está provisionada, o está provisionada pero rota (secreto
 * ausente/ilegible/inválido/no-activa), la firma FALLA de forma visible. Antes
 * existía un fallback temporal a `arca_config.private_key` para los negocios que
 * todavía no habían migrado; esa columna ya no existe y el camino se cerró.
 * La clave nunca se loguea, ni se audita, ni se devuelve al cliente.
 */

/** Estados de resolución (internos; se mapean a error fiscal sanitizado). */
export type KeyResolutionState =
  | 'VAULT_CREDENTIAL_ACTIVE'
  | 'VAULT_CREDENTIAL_NOT_PROVISIONED'
  | 'VAULT_SECRET_MISSING'
  | 'VAULT_SECRET_UNREADABLE'
  | 'VAULT_SECRET_INVALID'

/** AFIP-S4C: única fuente posible. Se mantiene el tipo por claridad en la auditoría. */
export type KeySource = 'vault'

export interface ResolvedKey {
  privateKey: string
  source: KeySource
  state: 'VAULT_CREDENTIAL_ACTIVE'
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
 * Resuelve la clave privada de firma. ÚNICA fuente: Vault. `getVaultCredential`
 * lee el contrato Vault (puede lanzar si la RPC falla → VAULT_SECRET_UNREADABLE).
 *
 * AFIP-S4C: no acepta ninguna clave alternativa. La firma nunca ocurre con
 * material que no venga del almacén seguro.
 */
export async function resolveArcaPrivateKey(opts: {
  getVaultCredential: () => Promise<VaultCredentialResult>
}): Promise<ResolvedKey> {
  let cred: VaultCredentialResult
  try {
    cred = await opts.getVaultCredential()
  } catch {
    // La RPC/almacén no respondió: falla visible, nunca una segunda fuente.
    throw new WsaaKeyError('VAULT_SECRET_UNREADABLE', 'No se pudo acceder al almacén seguro de la credencial.')
  }

  if (!cred || cred.provisioned !== true) {
    // Sin credencial en Vault no hay firma posible: fail-closed.
    throw new WsaaKeyError('VAULT_CREDENTIAL_NOT_PROVISIONED',
      'No hay una credencial fiscal segura configurada para este negocio.')
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
