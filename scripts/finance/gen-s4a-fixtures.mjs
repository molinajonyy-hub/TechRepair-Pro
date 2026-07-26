/**
 * AFIP-S4A — genera fixtures SINTÉTICOS (clave RSA + CSR) para los tests SQL y la
 * carrera de concurrencia. Corre con Deno (mismo node-forge que el runtime). Emite
 * JSON a stdout con:
 *   A  : par (clave+CSR) subject S_A
 *   A2 : par distinto con EL MISMO subject S_A (para el test de respuesta perdida)
 *   B  : par con subject distinto S_B
 *   race: 6 pares distintos, todos con subject S_A (para la carrera de concurrencia)
 * Cada par: { keyPem, csrPem, fp, subject }  (subject = jsonb canónico del parser SQL)
 * RUN: deno run -A --node-modules-dir=auto scripts/finance/gen-s4a-fixtures.mjs
 */
import forge from 'npm:node-forge@1.3.1'

async function make(cn, cuit) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 })
  const csr = forge.pki.createCertificationRequest()
  csr.publicKey = keys.publicKey
  csr.setSubject([
    { name: 'countryName', value: 'AR' },
    { name: 'organizationName', value: cn },
    { name: 'serialNumber', value: `CUIT ${cuit}` },
    { name: 'commonName', value: cn },
  ])
  csr.sign(keys.privateKey, forge.md.sha256.create())
  const der = forge.asn1.toDer(forge.pki.publicKeyToAsn1(keys.publicKey)).getBytes()
  const bytes = Uint8Array.from(der, (c) => c.charCodeAt(0))
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey).trim(),
    csrPem: forge.pki.certificationRequestToPem(csr).trim(),
    fp: [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    // subject canónico (claves minúsculas) idéntico al que extrae private.arca_csr_subject
    subject: { c: 'AR', o: cn, serialnumber: `CUIT ${cuit}`, cn },
  }
}

const A = await make('Taller S4A Uno', '20111111112')
const A2 = await make('Taller S4A Uno', '20111111112')       // mismo subject, otra clave
const B = await make('Taller S4A Dos', '20222222223')        // subject distinto
const race = []
for (let i = 0; i < 6; i++) race.push(await make('Taller S4A Uno', '20111111112'))  // mismo subject, 6 claves
console.log(JSON.stringify({ A, A2, B, race }, null, 0))
