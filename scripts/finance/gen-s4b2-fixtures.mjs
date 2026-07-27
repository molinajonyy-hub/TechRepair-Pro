/**
 * AFIP-S4B-2A — fixtures SINTÉTICOS para los tests de activación/rollback atómicos.
 *
 * TODO el material acá es generado en memoria con node-forge. NUNCA se usa el
 * certificado productivo emitido por ARCA (que vive fuera del repositorio y no
 * se abre, lee ni copia en este lote).
 *
 * Emite JSON a stdout:
 *   alias, cuit, serial
 *   active   : par vigente  (clave + certificado)         → el que hay que preservar
 *   pending  : par nuevo    (clave + CSR)                  → el que se va a activar
 *   certOk           : certificado con la clave PENDING, subject mínimo, vigente
 *   certOldKey       : certificado con la clave ACTIVE (el viejo) → KEY_MISMATCH
 *   certOtherKey     : certificado con una tercera clave          → KEY_MISMATCH
 *   certBadCn        : clave PENDING, CN distinto                 → SUBJECT_MISMATCH
 *   certBadSerial    : clave PENDING, serialNumber distinto       → SUBJECT_MISMATCH
 *   certExtraAttr    : clave PENDING, atributo C=AR adicional     → SUBJECT_MISMATCH
 *   certExpired      : clave PENDING, notAfter en el pasado       → EXPIRED
 *   certNotYetValid  : clave PENDING, notBefore en el futuro      → NOT_YET_VALID
 *   certGarbage      : PEM inválido                               → CERTIFICATE_INVALID
 *
 * RUN: deno run -A --node-modules-dir=auto scripts/finance/gen-s4b2-fixtures.mjs
 */
import forge from 'npm:node-forge@1.3.1'

const ALIAS = 'fixture.alias'
const CUIT = '20111111112'
const SERIAL = `CUIT ${CUIT}`

const MINIMAL = [
  { name: 'commonName', value: ALIAS },
  { name: 'serialNumber', value: SERIAL },
]

async function spkiFp(pub) {
  const der = forge.asn1.toDer(forge.pki.publicKeyToAsn1(pub)).getBytes()
  const bytes = Uint8Array.from(der, (c) => c.charCodeAt(0))
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// RSA 2048: es lo que exige el contrato de activación (§6). No bajar a 1024
// "por velocidad": el test tiene que ejercitar la validación real.
const newKey = () => forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })

/** Certificado que PORTA `pub`, firmado por `signer`, con el subject y fechas dados. */
function makeCert(pub, signer, attrs, notBefore, notAfter) {
  const cert = forge.pki.createCertificate()
  cert.publicKey = pub
  cert.serialNumber = '01'
  cert.validity.notBefore = notBefore
  cert.validity.notAfter = notAfter
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(signer, forge.md.sha256.create())
  return forge.pki.certificateToPem(cert).trim()
}

function makeCsr(keys, attrs) {
  const csr = forge.pki.createCertificationRequest()
  csr.publicKey = keys.publicKey
  csr.setSubject(attrs)
  csr.sign(keys.privateKey, forge.md.sha256.create())
  return forge.pki.certificationRequestToPem(csr).trim()
}

const PAST_A = new Date(2020, 0, 1), PAST_B = new Date(2021, 0, 1)
const OK_A = new Date(2020, 0, 1), OK_B = new Date(2035, 0, 1)
const FUT_A = new Date(2035, 0, 1), FUT_B = new Date(2040, 0, 1)

const active = newKey()
const pending = newKey()
const pending2 = newKey()   // segunda rotación: test de fallo intermedio (readback)
const other = newKey()

const subjectMinimal = { cn: ALIAS, serialnumber: SERIAL }

const out = {
  alias: ALIAS,
  cuit: CUIT,
  serial: SERIAL,
  subject_minimal: subjectMinimal,
  active: {
    keyPem: forge.pki.privateKeyToPem(active.privateKey).trim(),
    fp: await spkiFp(active.publicKey),
    certPem: makeCert(active.publicKey, active.privateKey, MINIMAL, OK_A, OK_B),
  },
  pending: {
    keyPem: forge.pki.privateKeyToPem(pending.privateKey).trim(),
    fp: await spkiFp(pending.publicKey),
    csrPem: makeCsr(pending, MINIMAL),
  },
  pending2: {
    keyPem: forge.pki.privateKeyToPem(pending2.privateKey).trim(),
    fp: await spkiFp(pending2.publicKey),
    csrPem: makeCsr(pending2, MINIMAL),
    certPem: makeCert(pending2.publicKey, pending2.privateKey, MINIMAL, OK_A, OK_B),
  },
  certOk: makeCert(pending.publicKey, pending.privateKey, MINIMAL, OK_A, OK_B),
  certOldKey: makeCert(active.publicKey, active.privateKey, MINIMAL, OK_A, OK_B),
  certOtherKey: makeCert(other.publicKey, other.privateKey, MINIMAL, OK_A, OK_B),
  certBadCn: makeCert(pending.publicKey, pending.privateKey,
    [{ name: 'commonName', value: 'otro.alias' }, { name: 'serialNumber', value: SERIAL }], OK_A, OK_B),
  certBadSerial: makeCert(pending.publicKey, pending.privateKey,
    [{ name: 'commonName', value: ALIAS }, { name: 'serialNumber', value: 'CUIT 20999999995' }], OK_A, OK_B),
  certExtraAttr: makeCert(pending.publicKey, pending.privateKey,
    [...MINIMAL, { name: 'countryName', value: 'AR' }], OK_A, OK_B),
  certExpired: makeCert(pending.publicKey, pending.privateKey, MINIMAL, PAST_A, PAST_B),
  certNotYetValid: makeCert(pending.publicKey, pending.privateKey, MINIMAL, FUT_A, FUT_B),
  certGarbage: '-----BEGIN CERTIFICATE-----\nesto-no-es-un-certificado\n-----END CERTIFICATE-----',
}
console.log(JSON.stringify(out))
