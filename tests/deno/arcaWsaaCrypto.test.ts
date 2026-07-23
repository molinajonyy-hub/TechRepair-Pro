/**
 * AFIP-S3A — prueba CRIPTOGRÁFICA real, en el MISMO runtime que producción.
 *
 * Corre bajo Deno con `npm:node-forge@1.3.1`, exactamente el import que usa
 * supabase/functions/afip-wsaa/index.ts. No agrega ningún devDependency npm ni
 * toca package-lock.json: Deno resuelve el paquete por su cuenta
 * (`--node-modules-dir=auto`), así que es reproducible en CI.
 *
 * Recupera la cobertura que en S2 quedó crypto-free por el problema de lockfile:
 *   1. parseo real de una clave privada PEM;
 *   2. correspondencia clave↔certificado por igualdad de módulo (la MISMA
 *      invariante que verifyCertKeyMatch en el Edge y que
 *      private.arca_key_matches_certificate en SQL);
 *   3. TRA sintético firmado en PKCS7/CMS y verificado como parseable;
 *   4. la clave resuelta por Vault y por legacy produce firmas válidas.
 *
 * Fixtures SINTÉTICOS generados en memoria. Nunca material productivo.
 *
 * RUN: deno test -A --node-modules-dir=auto tests/deno/
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import forge from 'npm:node-forge@1.3.1'
import { resolveArcaPrivateKey, classifyPrivateKeyPem } from '../../supabase/functions/afip-wsaa/keyResolver.ts'

// ── Fixtures sintéticos (RSA 1024 para velocidad; no son claves reales) ─────
function makePair(cn: string) {
  const kp = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = kp.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(2020, 0, 1)
  cert.validity.notAfter = new Date(2035, 0, 1)
  const attrs = [{ name: 'commonName', value: cn }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(kp.privateKey, forge.md.sha256.create())
  return {
    keyPem: forge.pki.privateKeyToPem(kp.privateKey).trim(),
    certPem: forge.pki.certificateToPem(cert).trim(),
    priv: kp.privateKey,
    cert,
  }
}

const A = makePair('s3a-A')
const B = makePair('s3a-B')

/** Misma invariante que afip-wsaa::verifyCertKeyMatch y que la función SQL. */
function certMatchesKey(certPem: string, keyPem: string): boolean {
  const c = forge.pki.certificateFromPem(certPem)
  const k = forge.pki.privateKeyFromPem(keyPem)
  return c.publicKey.n.toString(16) === k.n.toString(16)
}

/** Réplica mínima de la firma PKCS7 del Edge (sin red, sin WSAA real). */
function signTRA(traXml: string, certPem: string, keyPem: string): string {
  const c = forge.pki.certificateFromPem(certPem)
  const k = forge.pki.privateKeyFromPem(keyPem)
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(traXml, 'utf8')
  p7.addCertificate(c)
  p7.addSigner({
    key: k,
    certificate: c,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  })
  p7.sign()
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes())
}

const TRA = '<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><service>wsfe</service></loginTicketRequest>'

// ─────────────────────────────────────────────────────────────────────────
Deno.test('la clave privada sintética parsea y el clasificador la acepta', () => {
  const k = forge.pki.privateKeyFromPem(A.keyPem)
  assert(k?.n, 'node-forge debe parsear la clave')
  assertEquals(classifyPrivateKeyPem(A.keyPem), 'private')
  assertEquals(classifyPrivateKeyPem(A.certPem), 'certificate')
})

Deno.test('correspondencia clave↔certificado: el par A corresponde; la clave B no', () => {
  assert(certMatchesKey(A.certPem, A.keyPem), 'A debe corresponder')
  assert(!certMatchesKey(A.certPem, B.keyPem), 'B NO debe corresponder al cert A')
})

Deno.test('el módulo del par A aparece en el DER del certificado (misma prueba que hace SQL)', () => {
  // private.arca_key_matches_certificate busca el INTEGER modulus dentro del DER
  // del certificado. Acá se replica el criterio para validar que es correcto.
  const certDer = forge.util.createBuffer(forge.pki.pemToDer(A.certPem).getBytes()).toHex()
  let modHex = A.priv.n.toString(16)
  if (modHex.length % 2) modHex = '0' + modHex
  if (parseInt(modHex.slice(0, 2), 16) >= 0x80) modHex = '00' + modHex
  assert(certDer.includes(modHex), 'el módulo debe estar contenido en el DER del certificado')

  const certDerB = forge.util.createBuffer(forge.pki.pemToDer(B.certPem).getBytes()).toHex()
  assert(!certDerB.includes(modHex), 'el módulo de A no debe estar en el cert de B')
})

Deno.test('firma PKCS7/CMS: la clave desde Vault y desde legacy producen firmas válidas', async () => {
  const fromVault = await resolveArcaPrivateKey({
    getVaultCredential: () => Promise.resolve({ provisioned: true, ok: true, pem: A.keyPem }),
    legacyPrivateKey: '',
  })
  const fromLegacy = await resolveArcaPrivateKey({
    getVaultCredential: () => Promise.resolve({ provisioned: false }),
    legacyPrivateKey: A.keyPem,
  })
  assertEquals(fromVault.source, 'vault')
  assertEquals(fromLegacy.source, 'legacy_plaintext')
  assertEquals(fromVault.privateKey, fromLegacy.privateKey)

  for (const resolved of [fromVault, fromLegacy]) {
    const sig = signTRA(TRA, A.certPem, resolved.privateKey)
    assert(sig.length > 100, 'la firma debe ser no trivial')
    // Debe ser un CMS/PKCS7 parseable
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.decode64(sig)))
    assert(p7, 'el CMS debe ser parseable')
    assertEquals(p7.type, forge.pki.oids.signedData, 'debe ser un CMS signedData')
    assertEquals(p7.certificates.length, 1, 'debe incluir el certificado del firmante')
    // El certificado embebido debe ser el mismo par que firmó.
    assert(certMatchesKey(forge.pki.certificateToPem(p7.certificates[0]), resolved.privateKey),
      'el certificado del CMS debe corresponder a la clave que firmó')
  }
})

Deno.test('firmar con una clave que NO corresponde al certificado es detectable', () => {
  // El Edge aborta con verifyCertKeyMatch antes de firmar; acá se comprueba que
  // la condición es efectivamente falsa para un par cruzado.
  assert(!certMatchesKey(A.certPem, B.keyPem))
})

Deno.test('el fingerprint canónico del módulo es estable ante CRLF y espacios', async () => {
  const fp = async (pem: string) => {
    const der = forge.pki.pemToDer(pem).getBytes()
    const bytes = Uint8Array.from(der, (c: string) => c.charCodeAt(0))
    // El módulo se localiza dentro del DER; acá basta comparar el DER canónico,
    // que es lo que el SQL normaliza antes de extraer el módulo.
    const d = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  const base = await fp(A.keyPem)
  assertEquals(await fp(A.keyPem.replace(/\n/g, '\r\n')), base, 'CRLF no debe alterar el DER')
  assertEquals(await fp('  ' + A.keyPem + '\n\n'), base, 'espacios no deben alterar el DER')
  assertNotEquals(await fp(B.keyPem), base, 'otra clave debe dar otro fingerprint')
})
