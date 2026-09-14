/**
 * arca-selfservice-setup — criptografía de la configuración inicial (Deno + node-forge).
 *
 * - Genera la clave RSA 2048 / e=65537 y el CSR PKCS#10 (SHA-256) con EXACTAMENTE el
 *   subject autorizado que devolvió la base (CN=alias, serialNumber=CUIT n). Mismos
 *   parámetros que arca-rotate-prepare. La base vuelve a derivar todo: este módulo no es
 *   autoridad sobre fingerprint, tamaño ni subject.
 * - Normaliza el certificado que sube el usuario (PEM o DER en base64) re-emitiéndolo desde
 *   el ASN.1 parseado. Nunca acepta un bloque de clave privada.
 *
 * La clave privada existe sólo en memoria y se entrega a la RPC service_role, que la guarda
 * en Vault. No se loguea ni se devuelve.
 */
// @ts-ignore: node-forge en Deno via npm
import forge from 'npm:node-forge@1.3.1'

export const MAX_CERTIFICATE_BYTES = 64 * 1024

export interface AuthorizedSubject {
  cn: string
  serialnumber: string
}

export interface GeneratedSetupKey {
  keyPem: string
  csrPem: string
  fingerprint: string
}

/** SPKI SHA-256 canónico (n+e): igual que arca-rotate-prepare y private.arca_rsa_public_key_fingerprint_sha256. */
export async function spkiFingerprint(publicKey: unknown): Promise<string> {
  const der = forge.asn1.toDer(forge.pki.publicKeyToAsn1(publicKey)).getBytes()
  const bytes = Uint8Array.from(der, (c: string) => c.charCodeAt(0))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function isAuthorizedSubject(value: unknown): value is AuthorizedSubject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).sort().join(',') === 'cn,serialnumber'
    && typeof v.cn === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/.test(v.cn)
    && typeof v.serialnumber === 'string' && /^CUIT [0-9]{11}$/.test(v.serialnumber)
}

export async function generateSetupKeyAndCsr(subject: AuthorizedSubject): Promise<GeneratedSetupKey> {
  if (!isAuthorizedSubject(subject)) throw new Error('SUBJECT_INVALID')
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
  const csr = forge.pki.createCertificationRequest()
  csr.publicKey = keys.publicKey
  csr.setSubject([
    { name: 'commonName', value: subject.cn },
    { name: 'serialNumber', value: subject.serialnumber },
  ])
  csr.sign(keys.privateKey, forge.md.sha256.create())
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey).trim(),
    csrPem: forge.pki.certificationRequestToPem(csr).trim(),
    fingerprint: await spkiFingerprint(keys.publicKey),
  }
}

export type NormalizedCertificate =
  | { ok: true; pem: string }
  | { ok: false; state: 'KEY_MATERIAL_NOT_ACCEPTED' | 'CERTIFICATE_INVALID' | 'CERTIFICATE_TOO_LARGE' }

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----/g

/**
 * Acepta exactamente un certificado X.509 RSA, en PEM o DER (base64). Lo re-emite como PEM
 * canónico. La validación de negocio (clave, subject, vigencia, emisor) es de la base.
 */
export function normalizeCertificateInput(input: { pem?: string; derBase64?: string }): NormalizedCertificate {
  const raw = input.pem ?? input.derBase64 ?? ''
  if (new TextEncoder().encode(raw).length > MAX_CERTIFICATE_BYTES) return { ok: false, state: 'CERTIFICATE_TOO_LARGE' }
  if (PRIVATE_KEY_BLOCK.test(raw)) return { ok: false, state: 'KEY_MATERIAL_NOT_ACCEPTED' }
  try {
    let cert: any
    if (input.pem !== undefined) {
      if ((input.pem.match(CERTIFICATE_BLOCK) ?? []).length !== 1) return { ok: false, state: 'CERTIFICATE_INVALID' }
      cert = forge.pki.certificateFromPem(input.pem)
    } else {
      const compact = raw.replace(/\s+/g, '')
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return { ok: false, state: 'CERTIFICATE_INVALID' }
      const der = forge.util.decode64(compact)
      cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(der))
    }
    return { ok: true, pem: forge.pki.certificateToPem(cert).trim() }
  } catch {
    return { ok: false, state: 'CERTIFICATE_INVALID' }
  }
}
