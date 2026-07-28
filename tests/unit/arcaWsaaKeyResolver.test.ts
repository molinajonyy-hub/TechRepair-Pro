/**
 * AFIP-S2/S4C — resolución de la clave privada WSAA (VAULT-ONLY).
 *
 * Dos capas:
 *  1) classifyPrivateKeyPem (unidad pura);
 *  2) resolveArcaPrivateKey — con getVaultCredential inyectado.
 *
 * AFIP-S4C retiró el fallback a `arca_config.private_key`: esa columna ya no
 * existe. Vault es la única fuente posible, y CUALQUIER problema (no
 * provisionado, secreto ausente, no activo, ilegible, inválido) falla de forma
 * visible en vez de buscar una segunda fuente. Los casos que antes verificaban
 * el fallback ahora verifican que NO exista.
 *
 * NOTA: no se importa node-forge para una firma criptográfica en este test.
 * El resolver solo cambia la PROCEDENCIA de la clave (un string); el material
 * PEM real lo ejercita el flujo de producción bajo Deno (npm:node-forge).
 * Fixtures = PEM sintéticos estructuralmente válidos (el clasificador valida
 * estructura, no cripto).
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
// 2. resolveArcaPrivateKey — VAULT-ONLY
// ─────────────────────────────────────────────────────────────────────────

test('R1 Vault provisionado y válido → usa Vault', async () => {
  const r = await resolveArcaPrivateKey({ getVaultCredential: ok })
  assert.equal(r.source, 'vault')
  assert.equal(r.state, 'VAULT_CREDENTIAL_ACTIVE')
  assert.equal(r.privateKey, SYN_KEY_PEM)
})

test('R2 Vault NO provisionado → FALLA (antes caía a legacy; S4C lo cerró)', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({ getVaultCredential: async () => ({ provisioned: false }) }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_CREDENTIAL_NOT_PROVISIONED',
  )
})

test('R3 vínculo Vault existe pero secreto ausente → VAULT_SECRET_MISSING', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({
      getVaultCredential: async () => ({ provisioned: true, ok: false, reason: 'secret_missing' }),
    }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_SECRET_MISSING',
  )
})

test('R4 Vault no-activo (rotating/revoked) → VAULT_SECRET_UNREADABLE', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({
      getVaultCredential: async () => ({ provisioned: true, ok: false, reason: 'not_active' }),
    }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_SECRET_UNREADABLE',
  )
})

test('R5 RPC de Vault falla → VAULT_SECRET_UNREADABLE', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({ getVaultCredential: async () => { throw new Error('rpc down') } }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_SECRET_UNREADABLE',
  )
})

test('R6 Vault provisionado y activo pero PEM inválido → VAULT_SECRET_INVALID', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({ getVaultCredential: async () => ({ provisioned: true, ok: true, pem: 'no-es-pem' }) }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_SECRET_INVALID',
  )
})

test('R7 Vault activo pero PEM es un CERTIFICADO → VAULT_SECRET_INVALID (no confunde cert con clave)', async () => {
  await assert.rejects(
    () => resolveArcaPrivateKey({ getVaultCredential: async () => ({ provisioned: true, ok: true, pem: SYN_CERT_PEM }) }),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_SECRET_INVALID',
  )
})

test('R8 una clave alternativa inyectada NUNCA se usa (el resolver la ignora por completo)', async () => {
  // Aunque alguien vuelva a pasar el campo retirado, no existe camino que lo lea.
  const conIntruso = { getVaultCredential: async () => ({ provisioned: false }), legacyPrivateKey: SYN_KEY_PEM }
  await assert.rejects(
    () => resolveArcaPrivateKey(conIntruso as Parameters<typeof resolveArcaPrivateKey>[0]),
    (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_CREDENTIAL_NOT_PROVISIONED',
  )
})

test('R9 ningún estado roto devuelve una clave: siempre lanza', async () => {
  const rotos = [
    { provisioned: false },
    { provisioned: true, ok: false, reason: 'secret_missing' },
    { provisioned: true, ok: false, reason: 'not_active' },
    { provisioned: true, ok: false, reason: 'otro' },
    { provisioned: true },                       // sin ok explícito
    { provisioned: true, ok: true, pem: '' },
    { provisioned: true, ok: true, pem: SYN_CERT_PEM },
  ]
  for (const cred of rotos) {
    let devolvio = false
    try {
      await resolveArcaPrivateKey({ getVaultCredential: async () => (cred as any) })
      devolvio = true
    } catch (e) {
      assert.ok(e instanceof WsaaKeyError, `estado ${JSON.stringify(cred)} debe lanzar WsaaKeyError`)
    }
    assert.equal(devolvio, false, `${JSON.stringify(cred)} no debe devolver una clave`)
  }
})

test('R10 el error público está sanitizado: nunca contiene PEM ni material crudo', async () => {
  for (const cred of [{ provisioned: false }, { provisioned: true, ok: true, pem: SYN_CERT_PEM }]) {
    try {
      await resolveArcaPrivateKey({ getVaultCredential: async () => (cred as any) })
      assert.fail('debía lanzar')
    } catch (e) {
      assert.ok(e instanceof WsaaKeyError)
      assert.doesNotMatch((e as WsaaKeyError).publicMessage, /BEGIN|PRIVATE|CERTIFICATE|MII/)
    }
  }
})

test('R11 la clave resuelta se devuelve trim() (sin espacios de borde)', async () => {
  const r = await resolveArcaPrivateKey({
    getVaultCredential: async () => ({ provisioned: true, ok: true, pem: `\n  ${SYN_KEY_PEM}  \n` }),
  })
  assert.equal(r.privateKey, SYN_KEY_PEM)
})

test('R12 resultado nulo/indefinido del contrato → FALLA (no hay segunda fuente)', async () => {
  for (const nulo of [null, undefined]) {
    await assert.rejects(
      () => resolveArcaPrivateKey({ getVaultCredential: async () => (nulo as any) }),
      (e: unknown) => e instanceof WsaaKeyError && e.state === 'VAULT_CREDENTIAL_NOT_PROVISIONED',
    )
  }
})

test('R13 el único origen posible es vault', async () => {
  const r = await resolveArcaPrivateKey({ getVaultCredential: ok })
  assert.equal(r.source, 'vault')
})

// ─────────────────────────────────────────────────────────────────────────
// 3. El código desplegado no conserva rastros del camino legacy
// ─────────────────────────────────────────────────────────────────────────

test('el resolver no menciona ninguna clave alternativa', () => {
  const src = read('../../supabase/functions/afip-wsaa/keyResolver.ts')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert.doesNotMatch(src, /legacyPrivateKey/)
  assert.doesNotMatch(src, /legacy_plaintext/)
  assert.doesNotMatch(src, /LEGACY_PRIVATE_KEY/)
})

test('afip-wsaa no lee arca_config.private_key ni audita resoluciones legacy', () => {
  const idx = read('../../supabase/functions/afip-wsaa/index.ts')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert.doesNotMatch(idx, /config\.private_key/)
  assert.doesNotMatch(idx, /legacyPrivateKey/)
  assert.doesNotMatch(idx, /wsaa_private_key_resolved_legacy/)
  assert.match(idx, /wsaa_private_key_resolved_vault/)
  assert.match(idx, /wsaa_private_key_resolution_failed/)
  assert.doesNotMatch(idx, /console\.(log|warn|error)\([^)]*keyPem/)
  assert.doesNotMatch(idx, /keyPem[^)]*:\s*keyPem/) // no keyPem en objetos retornados
})
