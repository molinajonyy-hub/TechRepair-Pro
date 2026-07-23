/**
 * AFIP-S4A — genera fixtures SINTÉTICOS (clave RSA + CSR) para los tests SQL.
 * Corre con Deno (mismo node-forge que el runtime). Emite JSON a stdout:
 *   { A:{keyPem,csrPem,fp}, B:{keyPem,csrPem,fp} }
 * RUN: deno run -A --node-modules-dir=auto scripts/finance/gen-s4a-fixtures.mjs
 */
import forge from 'npm:node-forge@1.3.1'

function make(cn, cuit) {
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
  return crypto.subtle.digest('SHA-256', bytes).then((d) => ({
    keyPem: forge.pki.privateKeyToPem(keys.privateKey).trim(),
    csrPem: forge.pki.certificationRequestToPem(csr).trim(),
    fp: [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  }))
}

const A = await make('Taller S4A Uno', '20111111112')
const B = await make('Taller S4A Dos', '20222222223')
console.log(JSON.stringify({ A, B }, null, 0))
