/**
 * AFIP-S4A / S4B-1b — genera fixtures SINTÉTICOS para los tests SQL y la carrera.
 * Corre con Deno (mismo node-forge que el runtime). Emite JSON a stdout.
 *
 * Modelo de identidad (S4B-1b): el certificado VIGENTE define el subject
 * autorizado. Acá se emite un certificado con subject MÍNIMO
 * (CN=<alias> + serialNumber="CUIT <cuit>") y los CSR que deben aceptarse o
 * rechazarse contra él.
 *
 *   cert          : certificado vigente, subject mínimo, coherente con alias/cuit
 *   certBadCn     : certificado cuyo CN NO coincide con el alias
 *   certBadCuit   : certificado cuyo serialNumber NO coincide con el CUIT
 *   certExtra     : certificado con atributos adicionales (O, C)
 *   A, A2         : par clave+CSR con subject mínimo correcto (A2 = otra clave)
 *   extraC        : CSR con C=AR adicional  → debe rechazarse
 *   withO         : CSR con O=<alias>       → debe rechazarse
 *   dashCuit      : CSR con serialNumber "CUIT 20-...-2" (no canónico) → rechazo
 *   race[6]       : 6 pares con el subject mínimo correcto (concurrencia)
 *
 * RUN: deno run -A --node-modules-dir=auto scripts/finance/gen-s4a-fixtures.mjs
 */
import forge from 'npm:node-forge@1.3.1'

const ALIAS = 'fixture.alias'
const CUIT_DIGITS = '20111111112'
const SERIAL = `CUIT ${CUIT_DIGITS}`

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

/** Par clave + CSR con el subject indicado. */
async function makeCsr(attrs) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 })
  const csr = forge.pki.createCertificationRequest()
  csr.publicKey = keys.publicKey
  csr.setSubject(attrs)
  csr.sign(keys.privateKey, forge.md.sha256.create())
  const subject = {}
  for (const a of attrs) {
    const k = { commonName: 'cn', serialNumber: 'serialnumber', organizationName: 'o',
                organizationalUnitName: 'ou', countryName: 'c', stateOrProvinceName: 'st',
                localityName: 'l', emailAddress: 'email' }[a.name]
    if (k) subject[k] = a.value
  }
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey).trim(),
    csrPem: forge.pki.certificationRequestToPem(csr).trim(),
    fp: await spkiFp(keys.publicKey),
    subject,
  }
}

/** Certificado autofirmado con el subject indicado (representa el cert vigente). */
function makeCert(attrs) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 })
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(2020, 0, 1)
  cert.validity.notAfter = new Date(2035, 0, 1)
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return forge.pki.certificateToPem(cert).trim()
}

const out = {
  alias: ALIAS,
  cuit: CUIT_DIGITS,
  cuit_dashed: '20-11111111-2',
  serial: SERIAL,
  cert: makeCert(MINIMAL),
  certBadCn: makeCert([{ name: 'commonName', value: 'otro.alias' },
                       { name: 'serialNumber', value: SERIAL }]),
  certBadCuit: makeCert([{ name: 'commonName', value: ALIAS },
                         { name: 'serialNumber', value: 'CUIT 20999999995' }]),
  certExtra: makeCert([{ name: 'countryName', value: 'AR' },
                       { name: 'organizationName', value: 'Fixture SA' },
                       { name: 'commonName', value: ALIAS },
                       { name: 'serialNumber', value: SERIAL }]),
  A: await makeCsr(MINIMAL),
  A2: await makeCsr(MINIMAL),
  extraC: await makeCsr([...MINIMAL, { name: 'countryName', value: 'AR' }]),
  withO: await makeCsr([...MINIMAL, { name: 'organizationName', value: ALIAS }]),
  dashCuit: await makeCsr([{ name: 'commonName', value: ALIAS },
                           { name: 'serialNumber', value: 'CUIT 20-11111111-2' }]),
  race: [],
}
for (let i = 0; i < 6; i++) out.race.push(await makeCsr(MINIMAL))
console.log(JSON.stringify(out))
