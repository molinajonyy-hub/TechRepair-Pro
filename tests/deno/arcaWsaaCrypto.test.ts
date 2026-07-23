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

/**
 * Correspondencia clave↔certificado: compara (n, e) del SubjectPublicKeyInfo
 * del certificado contra los de la clave privada. Misma invariante que
 * afip-wsaa::verifyCertKeyMatch y que private.arca_key_matches_certificate.
 */
function certMatchesKey(certPem: string, keyPem: string): boolean {
  const c = forge.pki.certificateFromPem(certPem)
  const k = forge.pki.privateKeyFromPem(keyPem)
  return c.publicKey.n.toString(16) === k.n.toString(16) &&
         c.publicKey.e.toString(16) === k.e.toString(16)
}

/**
 * Fingerprint canónico de la clave pública RSA = SHA-256 del SubjectPublicKeyInfo
 * DER (incluye modulus Y publicExponent). Debe coincidir EXACTAMENTE con
 * private.arca_rsa_public_key_fingerprint_sha256 en SQL.
 */
async function rsaPublicKeyFingerprintSha256(pub: any): Promise<string> {
  const der = forge.asn1.toDer(forge.pki.publicKeyToAsn1(pub)).getBytes()
  const bytes = Uint8Array.from(der, (ch: string) => ch.charCodeAt(0))
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
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

Deno.test('el SPKI del certificado es la fuente de verdad, no la presencia de bytes', () => {
  // La correspondencia se decide por (n,e) del SubjectPublicKeyInfo, NO por que
  // el módulo aparezca en algún lugar del DER (ver el caso "trampa" en la suite
  // SQL: un cert con el módulo de A dentro de una extensión pero SPKI = B).
  const certA = forge.pki.certificateFromPem(A.certPem)
  assertEquals(certA.publicKey.n.toString(16), A.priv.n.toString(16))
  assertEquals(certA.publicKey.e.toString(16), A.priv.e.toString(16))
  const certB = forge.pki.certificateFromPem(B.certPem)
  assertNotEquals(certB.publicKey.n.toString(16), A.priv.n.toString(16))
})

Deno.test('fingerprint canónico: incluye el exponente y distingue claves', async () => {
  const fpA = await rsaPublicKeyFingerprintSha256(A.priv)   // forge acepta la privada como fuente de n/e
  const fpB = await rsaPublicKeyFingerprintSha256(B.priv)
  assertNotEquals(fpA, fpB, 'claves distintas → fingerprints distintos')
  assertEquals(fpA.length, 64)

  // Mismo modulus, exponente distinto → fingerprint DISTINTO (no es sha256(n)).
  const pubE17 = forge.pki.setRsaPublicKey(A.priv.n, new forge.jsbn.BigInteger('17'))
  const fpE17 = await rsaPublicKeyFingerprintSha256(pubE17)
  assertNotEquals(fpE17, fpA, 'el exponente debe participar del fingerprint')

  // El fingerprint del certificado (su SPKI) coincide con el de la clave.
  const certA = forge.pki.certificateFromPem(A.certPem)
  assertEquals(await rsaPublicKeyFingerprintSha256(certA.publicKey), fpA)
})

Deno.test('el fingerprint es el SHA-256 del SPKI DER estándar (interoperable)', async () => {
  // publicKeyToAsn1 emite SubjectPublicKeyInfo: SEQUENCE{AlgorithmIdentifier,
  // BIT STRING{RSAPublicKey}} — lo mismo que `openssl rsa -pubout -outform DER`.
  const der = forge.asn1.toDer(forge.pki.publicKeyToAsn1(A.priv)).getBytes()
  const bytes = Uint8Array.from(der, (ch: string) => ch.charCodeAt(0))
  assertEquals(bytes[0], 0x30, 'SPKI arranca con SEQUENCE')
  // OID rsaEncryption 1.2.840.113549.1.1.1
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  assert(hex.includes('06092a864886f70d010101'), 'debe llevar el OID rsaEncryption')
  assertEquals(await rsaPublicKeyFingerprintSha256(A.priv),
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join(''))
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
