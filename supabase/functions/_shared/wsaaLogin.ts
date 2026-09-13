/**
 * ARCA Self-Service Phase 2A — helpers WSAA (LoginCms) compartidos.
 *
 * Copia VERBATIM de las funciones de `supabase/functions/afip-wsaa/index.ts`:
 *   toAfipDate · buildTRA · verifyCertKeyMatch · signTRAWithPEM · callWSAA · parseWSAAResponse
 *
 * Por qué una copia y no un import desde afip-wsaa: afip-wsaa es el camino de firma de la
 * emisión productiva y en Phase 2A NO se modifica ni se redespliega. Para que no haya dos
 * implementaciones que puedan divergir, `scripts/guards/arca-phase2a-setup-contract.mjs`
 * compara token a token cada función de este archivo con la de afip-wsaa. Cuando afip-wsaa
 * adopte este módulo (deploy aparte, con aprobación propia) la copia desaparece.
 *
 * Sin estado ni acceso a Supabase. `callWSAA` usa el `fetch` global (los tests lo reemplazan).
 * Solo LoginCms: NUNCA WSFE, FECAESolicitar ni ningún servicio fiscal.
 */
// @ts-ignore: node-forge en Deno via npm
import forge from 'npm:node-forge@1.3.1'

function toAfipDate(date: Date): string {
  // AFIP requiere offset -03:00 (Argentina Standard Time)
  // Restar 3 horas al UTC para obtener hora argentina, luego etiquetar como -03:00.
  // Sin este ajuste, se envía hora UTC con etiqueta -03:00, lo que hace que AFIP
  // lo interprete como 3 horas en el futuro y rechace el TRA.
  const arg = new Date(date.getTime() - 3 * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const yyyy = arg.getUTCFullYear()
  const MM   = pad(arg.getUTCMonth() + 1)
  const dd   = pad(arg.getUTCDate())
  const hh   = pad(arg.getUTCHours())
  const mm   = pad(arg.getUTCMinutes())
  const ss   = pad(arg.getUTCSeconds())
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}-03:00`
}

function buildTRA(service = 'wsfe'): string {
  const now        = new Date()
  const expiration = new Date(now.getTime() + 12 * 60 * 60 * 1000) // 12 horas
  const uniqueId   = Math.floor(now.getTime() / 1000)

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<loginTicketRequest version="1.0">\n` +
    `  <header>\n` +
    `    <uniqueId>${uniqueId}</uniqueId>\n` +
    `    <generationTime>${toAfipDate(now)}</generationTime>\n` +
    `    <expirationTime>${toAfipDate(expiration)}</expirationTime>\n` +
    `  </header>\n` +
    `  <service>${service}</service>\n` +
    `</loginTicketRequest>`
}

function verifyCertKeyMatch(cert: any, privateKey: any): void {
  // Comparar el módulo RSA del certificado con el de la clave privada
  const certPubMod  = cert.publicKey.n.toString(16)
  const privKeyMod  = privateKey.n.toString(16)
  if (certPubMod !== privKeyMod) {
    throw new Error(
      'El certificado y la clave privada NO coinciden. ' +
      'Asegurate de haber generado el CSR desde TechRepair (no de una fuente externa), ' +
      'subido ESE .csr a AFIP y pegado el .crt recibido. ' +
      'Si regeneraste el CSR después de recibir el certificado, debés solicitar un nuevo certificado a AFIP.'
    )
  }
}

function signTRAWithPEM(traXml: string, certPem: string, privateKeyPem: string): string {
  const cert       = forge.pki.certificateFromPem(certPem)
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem)

  // Verificar coincidencia cert ↔ clave antes de firmar
  verifyCertKeyMatch(cert, privateKey)

  // AFIP WSAA: usar SHA-256 sin authenticatedAttributes opcionales
  // para máxima compatibilidad con el servidor de homologación
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(traXml, 'utf8')
  p7.addCertificate(cert)
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  })
  p7.sign()

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes()
  return forge.util.encode64(der)
}

async function callWSAA(signedCms: string, ambiente: string): Promise<string> {
  const url = ambiente === 'produccion'
    ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
    : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms'

  const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:ser="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <ser:loginCms>
      <ser:in0>${signedCms}</ser:in0>
    </ser:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml;charset=UTF-8',
      'SOAPAction': '""',
    },
    body: soapBody,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WSAA HTTP ${res.status}: ${text.slice(0, 500)}`)
  }

  return await res.text()
}

function parseWSAAResponse(soapXml: string): { token: string; sign: string; expirationTime: string } {
  // El WSAA devuelve el TA (Ticket de Acceso) como XML dentro del SOAP
  // Extraemos el contenido de <loginCmsReturn>
  const returnMatch = soapXml.match(/<(?:[^:>]+:)?loginCmsReturn>([\s\S]*?)<\/(?:[^:>]+:)?loginCmsReturn>/i)
  if (!returnMatch) {
    // Buscar faults SOAP
    if (soapXml.includes('faultstring')) {
      const fault = soapXml.match(/<faultstring>([\s\S]*?)<\/faultstring>/i)?.[1] || 'Error SOAP desconocido'
      throw new Error(`WSAA SOAP fault: ${fault}`)
    }
    throw new Error('No se encontró loginCmsReturn en la respuesta del WSAA')
  }

  // Puede venir HTML-encoded o en CDATA
  let taXml = returnMatch[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .trim()

  // Extraer token, sign y expirationTime del TA
  const token = taXml.match(/<token>([\s\S]*?)<\/token>/i)?.[1]?.trim()
  const sign  = taXml.match(/<sign>([\s\S]*?)<\/sign>/i)?.[1]?.trim()
  const expiration = taXml.match(/<expirationTime>([\s\S]*?)<\/expirationTime>/i)?.[1]?.trim()

  if (!token || !sign) {
    throw new Error(`No se pudo extraer token/sign del TA. Respuesta: ${taXml.slice(0, 300)}`)
  }

  return { token, sign, expirationTime: expiration || '' }
}

export { toAfipDate, buildTRA, verifyCertKeyMatch, signTRAWithPEM, callWSAA, parseWSAAResponse }
