/**
 * AFIP-S4A — pruebas CRIPTOGRÁFICAS reales de la preparación de rotación, en el
 * MISMO runtime que producción (Deno + npm:node-forge@1.3.1, sin devDependency npm
 * ni cambios en package-lock: Deno resuelve el paquete con --node-modules-dir=auto).
 *
 * Cubre el contrato que el Edge `arca-rotate-prepare` produce y que el parser SQL
 * `private.arca_rsa_pubkey_from_csr` debe reproducir byte a byte:
 *   1. generación de clave + CSR;
 *   2. parseo del CSR;
 *   3. verificación de la firma del CSR;
 *   4. verificación del subject (CN/CUIT);
 *   5. fp(SPKI del CSR) == fp(SPKI de la clave)  ← la invariante que valida la DB;
 *   6. el SPKI del CSR es byte-idéntico al SPKI de la clave (lo que extrae el SQL);
 *   7. la clave firma un challenge y una clave cruzada NO;
 *   8. el CSR PEM no contiene la clave privada.
 *
 * Fixtures SINTÉTICOS generados en memoria (RSA 1024 por velocidad). Nunca material
 * productivo.
 *
 * RUN: deno test -A --node-modules-dir=auto tests/deno/
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import forge from 'npm:node-forge@1.3.1'

// ── Réplica del Edge: generar par + CSR ─────────────────────────────────────
function makeKeyAndCsr(cn: string, cuit: string) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 })
  const csr = forge.pki.createCertificationRequest()
  csr.publicKey = keys.publicKey
  csr.setSubject([
    { name: 'countryName', value: 'AR' },
    { name: 'stateOrProvinceName', value: 'Buenos Aires' },
    { name: 'organizationName', value: cn },
    { name: 'serialNumber', value: `CUIT ${cuit}` },
    { name: 'commonName', value: cn },
  ])
  csr.sign(keys.privateKey, forge.md.sha256.create())
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey).trim(),
    csrPem: forge.pki.certificationRequestToPem(csr).trim(),
    priv: keys.privateKey,
    pub: keys.publicKey,
  }
}

/** SPKI SHA-256 canónico (n+e), igual que el Edge y que la DB. */
async function spkiFp(pub: any): Promise<string> {
  const der = forge.asn1.toDer(forge.pki.publicKeyToAsn1(pub)).getBytes()
  const bytes = Uint8Array.from(der, (c: string) => c.charCodeAt(0))
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** SPKI que extraería el parser SQL desde el CSR: subjectPKInfo del CSR, en hex. */
function csrSpkiDerHex(csrPem: string): string {
  const csr = forge.pki.certificationRequestFromPem(csrPem)
  const der = forge.asn1.toDer(forge.pki.publicKeyToAsn1(csr.publicKey)).getBytes()
  return Array.from(der, (c: string) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
}

const A = makeKeyAndCsr('Taller A SA', '20111111112')
const B = makeKeyAndCsr('Taller B SA', '20222222223')

// ─────────────────────────────────────────────────────────────────────────
Deno.test('el CSR sintético parsea y su firma es válida (self-signed PKCS#10)', () => {
  const csr = forge.pki.certificationRequestFromPem(A.csrPem)
  assert(csr.publicKey, 'el CSR debe tener clave pública')
  assertEquals(csr.verify(), true, 'la firma del CSR debe validar contra su propia clave')
})

Deno.test('el subject del CSR contiene CN y CUIT esperados', () => {
  const csr = forge.pki.certificationRequestFromPem(A.csrPem)
  const get = (name: string) =>
    csr.subject.attributes.find((a: any) => a.name === name || a.shortName === name)?.value
  assertEquals(get('commonName'), 'Taller A SA')
  assertEquals(get('serialNumber'), 'CUIT 20111111112')
})

Deno.test('fp(SPKI del CSR) == fp(SPKI de la clave) — la invariante que valida la DB', async () => {
  const csr = forge.pki.certificationRequestFromPem(A.csrPem)
  const fpKey = await spkiFp(A.pub)
  const fpCsr = await spkiFp(csr.publicKey)
  assertEquals(fpCsr, fpKey, 'el CSR debe portar exactamente la clave pública del par')
  assertEquals(fpKey.length, 64)
})

Deno.test('el SPKI del CSR es byte-idéntico al SPKI de la clave (lo que extrae el parser SQL)', () => {
  const csr = forge.pki.certificationRequestFromPem(A.csrPem)
  const spkiFromCsr = csrSpkiDerHex(A.csrPem)
  const derKey = forge.asn1.toDer(forge.pki.publicKeyToAsn1(A.pub)).getBytes()
  const spkiFromKey = Array.from(derKey, (c: string) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  assertEquals(spkiFromCsr, spkiFromKey)
  // OID rsaEncryption presente
  assert(spkiFromCsr.includes('06092a864886f70d010101'))
  assert(csr.publicKey.n.bitLength() >= 1024)
})

Deno.test('claves distintas → CSRs con fingerprints distintos', async () => {
  const fpA = await spkiFp(forge.pki.certificationRequestFromPem(A.csrPem).publicKey)
  const fpB = await spkiFp(forge.pki.certificationRequestFromPem(B.csrPem).publicKey)
  assertNotEquals(fpA, fpB)
})

Deno.test('la clave firma un challenge y una clave cruzada NO valida', () => {
  const md = forge.md.sha256.create(); md.update('challenge-afip-s4a', 'utf8')
  const sig = A.priv.sign(md)
  const digest = md.digest().bytes()
  assertEquals(A.pub.verify(digest, sig), true, 'la clave A verifica su propia firma')
  // forge lanza "Encryption block is invalid" ante padding cruzado → tratar como no-válido.
  let bOk = false
  try { bOk = B.pub.verify(digest, sig) } catch { bOk = false }
  assertEquals(bOk, false, 'la clave B NO debe verificar la firma de A')
})

Deno.test('el CSR PEM NO contiene la clave privada', () => {
  assert(A.csrPem.includes('-----BEGIN CERTIFICATE REQUEST-----'))
  assert(!/-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(A.csrPem), 'el CSR jamás debe llevar la clave privada')
  assert(!A.csrPem.includes('PRIVATE'))
})

Deno.test('el fingerprint es estable ante CRLF/espacios en el CSR PEM', async () => {
  const base = await spkiFp(forge.pki.certificationRequestFromPem(A.csrPem).publicKey)
  const crlf = await spkiFp(forge.pki.certificationRequestFromPem(A.csrPem.replace(/\n/g, '\r\n')).publicKey)
  const padded = await spkiFp(forge.pki.certificationRequestFromPem('\n  ' + A.csrPem + '\n\n').publicKey)
  assertEquals(crlf, base)
  assertEquals(padded, base)
})
