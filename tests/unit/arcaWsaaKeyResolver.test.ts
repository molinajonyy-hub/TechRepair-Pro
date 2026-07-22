/**
 * AFIP-S2 — resolución de la clave privada WSAA (Vault con fallback legacy).
 *
 * Dos capas:
 *  1) classifyPrivateKeyPem (unidad pura);
 *  2) resolveArcaPrivateKey — 15 casos, con getVaultCredential inyectado, +
 *     equivalencia de origen: el resolver devuelve el MISMO string venga de
 *     Vault o de legacy, así que la firma (signTRAWithPEM, INTACTA en S2) es
 *     agnóstica al origen — legacy y vault son equivalentes por construcción.
 *
 * NOTA: no se importa node-forge para una firma criptográfica en este test.
 * S2 no modifica la función de firma; solo cambia la PROCEDENCIA de la clave
 * (un string). El material PEM real lo ejercita el flujo de producción bajo
 * Deno (npm:node-forge). Fixtures = PEM sintéticos estructuralmente válidos
 * (el clasificador valida estructura, no cripto). Además evita un devDependency
 * npm que no instala limpio en este toolchain (rollup-linux pin) ni en CI.
 *
 * keyResolver.ts es puro (sin Deno/Supabase) → node --test lo importa directo.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  classifyPrivateKeyPem,
  resolveArcaPrivateKey,
  WsaaKeyError,
} from '../../supabase/functions/afip-wsaa/keyResolver.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

// ── PEM SINTÉTICOS estructuralmente válidos (no son claves reales) ───────────
// El clasificador chequea estructura (un bloque bien cerrado, base64 no trivial),
// no parsea criptográficamente. Base64 largo para superar el umbral de "truncado".
const B64 = 'MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEAsyntheticNOTaREALkey0123456789abcdefABCDEF+/ghijklmnopqrstuvwxyz'
const SYN_KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${B64}\n${B64}\n-----END PRIVATE KEY-----`
const SYN_CERT_PEM = `-----BEGIN CERTIFICATE-----\n${B64}\n${B64}\n-----END CERTIFICATE-----`
const SYN_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----\n${B64}\n-----END PUBLIC KEY-----`

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
  assert.equal(classifyPrivateKeyPem(SYN_PUBLIC_PEM), 'public')
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
// 3. Equivalencia de origen (la firma es agnóstica a la procedencia)
// ─────────────────────────────────────────────────────────────────────────

test('equivalencia: Vault y legacy (mismo PEM) devuelven idéntico material de firma', async () => {
  const fromVault = await resolveArcaPrivateKey({ getVaultCredential: ok, legacyPrivateKey: '' })
  const fromLegacy = await resolveArcaPrivateKey({
    getVaultCredential: async () => ({ provisioned: false }), legacyPrivateKey: SYN_KEY_PEM,
  })
  // El resolver devuelve el MISMO string por ambos caminos; signTRAWithPEM (intacto
  // en S2) recibe un string y no conoce el origen → firma equivalente por construcción.
  assert.equal(fromVault.privateKey, fromLegacy.privateKey)
  assert.equal(fromVault.source, 'vault')
  assert.equal(fromLegacy.source, 'legacy_plaintext')
  // El resolver solo entrega material que el clasificador acepta como clave privada.
  assert.equal(classifyPrivateKeyPem(fromVault.privateKey), 'private')
  assert.equal(classifyPrivateKeyPem(fromLegacy.privateKey), 'private')
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
