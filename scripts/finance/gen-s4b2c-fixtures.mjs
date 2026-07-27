/**
 * AFIP-S4B-2C — fixtures SINTÉTICOS para los tests de finalización.
 *
 * Todo el material se genera en memoria con node-forge. NUNCA se usa el
 * certificado productivo emitido por ARCA.
 *
 * Emite el bloque SQL de fixtures (tabla temporal `fx`) y los fingerprints, para
 * pegarlo tal cual en supabase/tests/security_afip_s4b2c_finalize_rotation_test.sql.
 *
 * El par ACTIVE es el que está en uso antes de rotar; el par PENDING es el que
 * queda activo tras la activación y es el que la finalización debe confirmar.
 *
 * RUN: deno run -A --node-modules-dir=auto scripts/finance/gen-s4b2c-fixtures.mjs
 */
import forge from 'npm:node-forge@1.3.1'

const ALIAS = 'fixture.alias'
const CUIT = '20111111112'
const MINIMAL = [
  { name: 'commonName', value: ALIAS },
  { name: 'serialNumber', value: `CUIT ${CUIT}` },
]
const OTHER_CN = [
  { name: 'commonName', value: 'otro.alias' },
  { name: 'serialNumber', value: `CUIT ${CUIT}` },
]

async function spkiFp(pub) {
  const der = forge.asn1.toDer(forge.pki.publicKeyToAsn1(pub)).getBytes()
  const bytes = Uint8Array.from(der, (c) => c.charCodeAt(0))
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// RSA 2048 con e=65537: es lo que exige el contrato. No bajar "por velocidad".
const newKey = () => forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })

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

const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 3, 0, 0))

const active = newKey()
const pending = newKey()

const fx = {
  key_old: forge.pki.privateKeyToPem(active.privateKey).trim(),
  cert_old: makeCert(active.publicKey, active.privateKey, MINIMAL, D(2020, 1, 1), D(2035, 1, 1)),
  key_new: forge.pki.privateKeyToPem(pending.privateKey).trim(),
  csr_new: makeCsr(pending, MINIMAL),
  cert_new: makeCert(pending.publicKey, pending.privateKey, MINIMAL, D(2020, 1, 1), D(2035, 1, 1)),
  cert_new_badcn: makeCert(pending.publicKey, pending.privateKey, OTHER_CN, D(2020, 1, 1), D(2035, 1, 1)),
  cert_new_expired: makeCert(pending.publicKey, pending.privateKey, MINIMAL, D(2020, 1, 1), D(2021, 1, 1)),
}

const out = []
out.push(`\\set FP_OLD '${await spkiFp(active.publicKey)}'`)
out.push(`\\set FP_NEW '${await spkiFp(pending.publicKey)}'`)
out.push('')
out.push('CREATE TEMP TABLE fx (name text primary key, pem text);')
for (const [name, pem] of Object.entries(fx)) {
  out.push(`INSERT INTO fx VALUES ('${name}', $p$${pem}$p$);`)
}
console.log(out.join('\n'))
