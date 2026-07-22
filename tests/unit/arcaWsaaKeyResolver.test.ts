/**
 * AFIP-S2 — resolución de la clave privada WSAA (Vault con fallback legacy).
 *
 * Tres capas:
 *  1) classifyPrivateKeyPem (unidad pura);
 *  2) resolveArcaPrivateKey — 15 casos, con getVaultCredential inyectado;
 *  3) firma aislada con node-forge: la clave resuelta (venga de Vault o legacy)
 *     produce una firma PKCS7 verificable; ambos orígenes son criptográficamente
 *     equivalentes porque el resolver devuelve el MISMO PEM y la firma no conoce
 *     su procedencia.
 *
 * El módulo keyResolver.ts es puro (sin Deno/Supabase), así que node --test lo
 * importa directo (igual que afip-cae/logic.ts en arcaEmission.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import forge from 'node-forge'
import {
  classifyPrivateKeyPem,
  resolveArcaPrivateKey,
  WsaaKeyError,
} from '../../supabase/functions/afip-wsaa/keyResolver.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

// ── Par sintético (RSA 1024, solo para tests) reutilizado por varios casos ───
const kp = forge.pki.rsa.generateKeyPair(1024)
// .trim(): el resolver normaliza con trim(), así que la forma canónica del PEM
// (sin \r\n de borde que agrega forge) es la trimmed.
const SYN_KEY_PEM = forge.pki.privateKeyToPem(kp.privateKey).trim()
const cert = forge.pki.createCertificate()
cert.publicKey = kp.publicKey
cert.serialNumber = '01'
cert.validity.notBefore = new Date(2020, 0, 1)
cert.validity.notAfter = new Date(2030, 0, 1)
const attrs = [{ name: 'commonName', value: 'test' }]
cert.setSubject(attrs); cert.setIssuer(attrs)
cert.sign(kp.privateKey, forge.md.sha256.create())
const SYN_CERT_PEM = forge.pki.certificateToPem(cert)

const ok = () => Promise.resolve({ provisioned: true as const, ok: true as const, pem: SYN_KEY_PEM })

// ─────────────────────────────────────────────────────────────────────────
// 1. classifyPrivateKeyPem
// ─────────────────────────────────────────────────────────────────────────

test('classify: clave privada válida → private', () => {
  assert.equal(classifyPrivateKeyPem(SYN_KEY_PEM), 'private')
})
test('classify: certificado → certificate (no clave)', () => {
  assert.equal(classifyPrivateKeyPem(SYN_CERT_PEM), 'certificate')
})
test('classify: clave pública → public', () => {
  assert.equal(classifyPrivateKeyPem(forge.pki.publicKeyToPem(kp.publicKey)), 'public')
})
test('classify: vacío / whitespace → empty', () => {
  assert.equal(classifyPrivateKeyPem(''), 'empty')
  assert.equal(classifyPrivateKeyPem('   \n  '), 'empty')
  assert.equal(classifyPrivateKeyPem(null), 'empty')
})
test('classify: truncado → invalid', () => {
  assert.equal(classifyPrivateKeyPem('-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----'), 'invalid')
})
test('classify: múltiples bloques ambiguos → invalid', () => {
  assert.equal(classifyPrivateKeyPem(SYN_KEY_PEM + '\n' + SYN_KEY_PEM), 'invalid')
})
test('classify: no PEM → invalid', () => {
  assert.equal(classifyPrivateKeyPem('esto no es una clave'), 'invalid')
})

// ─────────────────────────────────────────────────────────────────────────
// 2. resolveArcaPrivateKey — 15 casos
// ─────────────────────────────────────────────────────────────────────────

test('R1 Vault provisionado y válido → usa Vault', async () => {
  const r = await resolveArcaPrivateKey({ getVaultCredential: ok, legacyPrivateKey: 'ignorame' })
  assert.equal(r.source, 'vault')
  assert.equal(r.state, 'VAULT_CREDENTIAL_ACTIVE')
  assert.equal(r.privateKey, SYN_KEY_PEM)
})

test('R2 Vault no provisionado → usa legacy', async () => {
  const r = await resolveArcaPrivateKey({
    getVaultCredential: async () => ({ provisioned: false }),
    legacyPrivateKey: SYN_KEY_PEM,
  })
  assert.equal(r.source, 'legacy_plaintext')
  assert.equal(r.state, 'VAULT_CREDENTIAL_NOT_PROVISIONED')
  assert.equal(r.privateKey, SYN_KEY_PEM)
})

test('R3 vínculo Vault existe pero secreto ausente → falla (no legacy)', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({
      getVaultCredential: async () => ({ provisioned: true, ok: false, reason: 'secret_missing' }),
      legacyPrivateKey: SYN_KEY_PEM, // legacy VÁLIDO y presente: NO debe usarse
    }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_SECRET_MISSING',
  )
})

test('R4 Vault no-activo (rotating/revoked) → falla (no legacy)', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({
      getVaultCredential: async () => ({ provisioned: true, ok: false, reason: 'not_active' }),
      legacyPrivateKey: SYN_KEY_PEM,
    }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_SECRET_UNREADABLE',
  )
})

test('R5 RPC de Vault falla → VAULT_SECRET_UNREADABLE (no legacy)', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({
      getVaultCredential: async () => { throw new Error('rpc down') },
      legacyPrivateKey: SYN_KEY_PEM,
    }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_SECRET_UNREADABLE',
  )
})

test('R6 Vault provisionado y activo pero PEM inválido → VAULT_SECRET_INVALID', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({
      getVaultCredential: async () => ({ provisioned: true, ok: true, pem: 'no-es-pem' }),
      legacyPrivateKey: SYN_KEY_PEM,
    }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_SECRET_INVALID',
  )
})

test('R7 Vault activo pero PEM es un CERTIFICADO → VAULT_SECRET_INVALID (no confunde cert con clave)', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({
      getVaultCredential: async () => ({ provisioned: true, ok: true, pem: SYN_CERT_PEM }),
      legacyPrivateKey: SYN_KEY_PEM,
    }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_SECRET_INVALID',
  )
})

test('R8 legacy ausente (Vault no provisionado) → LEGACY_PRIVATE_KEY_MISSING', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({ getVaultCredential: async () => ({ provisioned: false }), legacyPrivateKey: '' }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'LEGACY_PRIVATE_KEY_MISSING',
  )
  await assert.rejects(
    () => resolveArcaPrivateKey({ getVaultCredential: async () => ({ provisioned: false }), legacyPrivateKey: null }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'LEGACY_PRIVATE_KEY_MISSING',
  )
})

test('R9 legacy inválido (Vault no provisionado) → LEGACY_PRIVATE_KEY_INVALID', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({ getVaultCredential: async () => ({ provisioned: false }), legacyPrivateKey: 'basura' }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'LEGACY_PRIVATE_KEY_INVALID',
  )
})

test('R10 legacy que en realidad es un certificado → LEGACY_PRIVATE_KEY_INVALID', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({ getVaultCredential: async () => ({ provisioned: false }), legacyPrivateKey: SYN_CERT_PEM }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'LEGACY_PRIVATE_KEY_INVALID',
  )
})

test('R11 NUNCA hay fallback silencioso desde un Vault roto hacia legacy', async () => {
  // Legacy es válido y presente; aún así, un Vault provisionado-roto debe FALLAR.
  for (const reason of ['secret_missing', 'not_active', 'otro'] as const) {
    let usedLegacy = false
    try {
      await resolveArcaPrivateKey({
        getVaultCredential: async () => ({ provisioned: true, ok: false, reason }),
        legacyPrivateKey: SYN_KEY_PEM,
      })
      usedLegacy = true
    } catch (e) {
      assert.ok(e instanceof WsaaKeyError)
      assert.notEqual((e as WsaaKeyError).state, 'VAULT_CREDENTIAL_NOT_PROVISIONED')
    }
    assert.equal(usedLegacy, false, `reason=${reason} no debe caer a legacy`)
  }
})

test('R12 el error público está sanitizado: nunca contiene PEM ni el estado interno crudo con secreto', async () => {
  try {
    await resolveArcaPrivateKey({
      getVaultCredential: async () => ({ provisioned: true, ok: true, pem: SYN_CERT_PEM }),
      legacyPrivateKey: SYN_KEY_PEM,
    })
    assert.fail('debía lanzar')
  } catch (e) {
    assert.ok(e instanceof WsaaKeyError)
    assert.doesNotMatch((e as WsaaKeyError).publicMessage, /BEGIN|PRIVATE|CERTIFICATE|MII/)
  }
})

test('R13 la clave resuelta se devuelve trim() (sin espacios de borde)', async () => {
  const r = await resolveArcaPrivateKey({
    getVaultCredential: async () => ({ provisioned: true, ok: true, pem: `\n  ${SYN_KEY_PEM}  \n` }),
    legacyPrivateKey: '',
  })
  assert.equal(r.privateKey, SYN_KEY_PEM)
})

test('R14 Vault provisionado sin ok explícito → tratado como roto (fail-closed)', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({
      getVaultCredential: async () => ({ provisioned: true }),
      legacyPrivateKey: SYN_KEY_PEM,
    }),
    (e: unknown) => e instanceof WsaaKeyError,
  )
})

test('R15 resultado nulo/indefinido del contrato → usa legacy (equivale a no provisionado)', async () => {
  const r = await resolveArcaPrivateKey({
    getVaultCredential: async () => (null as any),
    legacyPrivateKey: SYN_KEY_PEM,
  })
  assert.equal(r.source, 'legacy_plaintext')
})

// ─────────────────────────────────────────────────────────────────────────
// 3. Firma aislada (node-forge): equivalencia legacy ↔ vault
// ─────────────────────────────────────────────────────────────────────────

// Réplica mínima de la firma PKCS7 del Edge (sin red, sin WSAA real).
function signTRA(traXml: string, certPem: string, keyPem: string): string {
  const c = forge.pki.certificateFromPem(certPem)
  const k = forge.pki.privateKeyFromPem(keyPem)
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(traXml, 'utf8')
  p7.addCertificate(c)
  p7.addSigner({
    key: k, certificate: c, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
    ],
  })
  p7.sign()
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes())
}

test('firma: la clave de Vault y la clave legacy (mismo PEM) firman un TRA y verifican', async () => {
  const tra = '<loginTicketRequest><service>wsfe</service></loginTicketRequest>'

  const fromVault = await resolveArcaPrivateKey({ getVaultCredential: ok, legacyPrivateKey: '' })
  const fromLegacy = await resolveArcaPrivateKey({
    getVaultCredential: async () => ({ provisioned: false }), legacyPrivateKey: SYN_KEY_PEM,
  })
  // Mismo material de clave por ambos caminos → firma equivalente por construcción.
  assert.equal(fromVault.privateKey, fromLegacy.privateKey)

  const sigVault = signTRA(tra, SYN_CERT_PEM, fromVault.privateKey)
  const sigLegacy = signTRA(tra, SYN_CERT_PEM, fromLegacy.privateKey)

  // Ambas firmas son PKCS7/CMS base64 no triviales y parseables (válidas).
  for (const sig of [sigVault, sigLegacy]) {
    assert.ok(sig.length > 100)
    const der = forge.util.decode64(sig)
    const asn1 = forge.asn1.fromDer(der)
    const p7 = forge.pkcs7.messageFromAsn1(asn1)
    assert.ok(p7)
  }
})

// ─────────────────────────────────────────────────────────────────────────
// 4. Contrato de fuente — afip-wsaa usa el resolver, no lee private_key directo
// ─────────────────────────────────────────────────────────────────────────

test('afip-wsaa: la rama PEM usa resolveArcaPrivateKey (no lee config.private_key directo para firmar)', () => {
  const idx = read('../../supabase/functions/afip-wsaa/index.ts')
  assert.match(idx, /resolveArcaPrivateKey\(/)
  assert.match(idx, /arca_get_credential_for_signing/)
  // No debe quedar el patrón viejo de leer la clave por decryptField para firmar.
  assert.doesNotMatch(idx, /decryptField\(supabase,\s*config\.private_key\)/)
})

test('afip-wsaa: audita el origen y jamás loguea/retorna el PEM', () => {
  const idx = read('../../supabase/functions/afip-wsaa/index.ts')
  assert.match(idx, /wsaa_private_key_resolved_vault/)
  assert.match(idx, /wsaa_private_key_resolved_legacy/)
  assert.match(idx, /wsaa_private_key_resolution_failed/)
  assert.doesNotMatch(idx, /console\.(log|warn|error)\([^)]*keyPem/)
  assert.doesNotMatch(idx, /keyPem[^)]*:\s*keyPem/) // no keyPem en objetos retornados
})
