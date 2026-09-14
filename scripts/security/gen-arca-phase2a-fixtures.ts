/**
 * ARCA Self-Service Phase 2A — generador de fixtures SINTÉTICOS para la suite SQL.
 *
 *   deno run -A --node-modules-dir=auto scripts/security/gen-arca-phase2a-fixtures.ts
 *
 * Mismo runtime que producción (Deno + npm:node-forge@1.3.1). Genera una CA falsa con el
 * issuer de homologación ("CN=Computadores Test, O=AFIP, C=AR") y certificados RSA-2048 para
 * el subject exacto del flujo inicial (CN=<alias>, serialNumber=CUIT <11>). NUNCA material real:
 * las claves se generan en memoria y el archivo resultante es sólo para tests locales.
 *
 * Escribe tests/sql/fixtures/arca_phase2a_fixtures.sql (INSERT en la temp table `fx`).
 */
// @ts-ignore: node-forge en Deno via npm
import forge from 'npm:node-forge@1.3.1'

const ALIAS = 'qa-initial-setup'
const CUIT = '20111111112'          // dígito verificador válido (mod 11)
const OTHER_CUIT = '20222222223'

type Pair = { key: any; pub: any; pem: string }
const pair = (): Pair => {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
  return { key: kp.privateKey, pub: kp.publicKey, pem: forge.pki.privateKeyToPem(kp.privateKey).trim() }
}

async function spkiFp(pub: any): Promise<string> {
  const der = forge.asn1.toDer(forge.pki.publicKeyToAsn1(pub)).getBytes()
  const d = await crypto.subtle.digest('SHA-256', Uint8Array.from(der, (c: string) => c.charCodeAt(0)))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const subject = (cuit: string, alias = ALIAS) => [
  { name: 'commonName', value: alias },
  { name: 'serialNumber', value: `CUIT ${cuit}` },
]
const HOMO_ISSUER = [
  { name: 'countryName', value: 'AR' },
  { name: 'organizationName', value: 'AFIP' },
  { name: 'commonName', value: 'Computadores Test' },
]
const PROD_ISSUER = [
  { name: 'countryName', value: 'AR' },
  { name: 'organizationName', value: 'AFIP' },
  { name: 'commonName', value: 'Computadores' },
]
const ROGUE_ISSUER = [
  { name: 'countryName', value: 'AR' },
  { name: 'organizationName', value: 'Evil CA' },
  { name: 'commonName', value: 'Computadores Test' },
]

const ca = pair()
let serial = 1
function issue(pub: any, subj: any[], issuer: any[], notBefore: Date, notAfter: Date): string {
  const cert = forge.pki.createCertificate()
  cert.publicKey = pub
  cert.serialNumber = (serial++).toString(16).padStart(2, '0')
  cert.validity.notBefore = notBefore
  cert.validity.notAfter = notAfter
  cert.setSubject(subj)
  cert.setIssuer(issuer)
  cert.sign(ca.key, forge.md.sha256.create())
  return forge.pki.certificateToPem(cert).trim()
}

const pending = pair()     // clave "pendiente" del setup
const other = pair()       // otra clave (certificado que no corresponde)
const small = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 })

const csr = forge.pki.createCertificationRequest()
csr.publicKey = pending.pub
csr.setSubject(subject(CUIT))
csr.sign(pending.key, forge.md.sha256.create())
const csrPem = forge.pki.certificationRequestToPem(csr).trim()

// CSR con atributos extra (C/O) — debe rechazarse.
const csrExtra = forge.pki.createCertificationRequest()
csrExtra.publicKey = pending.pub
csrExtra.setSubject([{ name: 'countryName', value: 'AR' }, { name: 'organizationName', value: ALIAS }, ...subject(CUIT)])
csrExtra.sign(pending.key, forge.md.sha256.create())

// CSR firmado con OTRA clave para la misma pública declarada — la DB lo detecta por SPKI.
const csrOtherKey = forge.pki.createCertificationRequest()
csrOtherKey.publicKey = other.pub
csrOtherKey.setSubject(subject(CUIT))
csrOtherKey.sign(other.key, forge.md.sha256.create())

const Y = (y: number) => new Date(Date.UTC(y, 0, 1, 3, 0, 0))
const rows: Array<[string, string]> = [
  ['alias', ALIAS],
  ['cuit', CUIT],
  ['other_cuit', OTHER_CUIT],
  ['fp_pending', await spkiFp(pending.pub)],
  ['fp_other', await spkiFp(other.pub)],
  ['key_pending', pending.pem],
  ['key_other', other.pem],
  ['key_small', forge.pki.privateKeyToPem(small.privateKey).trim()],
  ['csr_pending', csrPem],
  ['csr_extra_attrs', forge.pki.certificationRequestToPem(csrExtra).trim()],
  ['csr_other_key', forge.pki.certificationRequestToPem(csrOtherKey).trim()],
  ['cert_valid_homo', issue(pending.pub, subject(CUIT), HOMO_ISSUER, Y(2020), Y(2035))],
  ['cert_valid_prod', issue(pending.pub, subject(CUIT), PROD_ISSUER, Y(2020), Y(2035))],
  ['cert_wrong_key', issue(other.pub, subject(CUIT), HOMO_ISSUER, Y(2020), Y(2035))],
  ['cert_wrong_cuit', issue(pending.pub, subject(OTHER_CUIT), HOMO_ISSUER, Y(2020), Y(2035))],
  ['cert_wrong_alias', issue(pending.pub, subject(CUIT, 'otro-alias'), HOMO_ISSUER, Y(2020), Y(2035))],
  ['cert_expired', issue(pending.pub, subject(CUIT), HOMO_ISSUER, Y(2019), Y(2021))],
  ['cert_not_yet_valid', issue(pending.pub, subject(CUIT), HOMO_ISSUER, Y(2034), Y(2036))],
  ['cert_rogue_issuer', issue(pending.pub, subject(CUIT), ROGUE_ISSUER, Y(2020), Y(2035))],
  ['cert_extra_attrs', issue(pending.pub, [{ name: 'organizationName', value: 'X' }, ...subject(CUIT)], HOMO_ISSUER, Y(2020), Y(2035))],
]

const esc = (s: string) => {
  if (s.includes('$fx$')) throw new Error('delimiter collision')
  return `$fx$${s}$fx$`
}
const out = [
  '-- AUTO-GENERATED by scripts/security/gen-arca-phase2a-fixtures.ts — SYNTHETIC ONLY.',
  '-- Fake CA "CN=Computadores Test, O=AFIP, C=AR" generated in memory. Never production material.',
  `-- Subject under test: CN=${ALIAS}, serialNumber=CUIT ${CUIT}.`,
  ...rows.map(([k, v]) => `INSERT INTO fx(name, val) VALUES ('${k}', ${esc(v)});`),
  '',
].join('\n').replace(/\r\n/g, '\n') // node-forge emite PEM con CRLF; el repo es LF

await Deno.mkdir('tests/sql/fixtures', { recursive: true })
await Deno.writeTextFile('tests/sql/fixtures/arca_phase2a_fixtures.sql', out)
console.log(`wrote ${rows.length} fixtures`)
