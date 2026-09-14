/**
 * ARCA Self-Service Phase 2B — lectura LOCAL del certificado que sube el usuario.
 *
 * Sólo decide qué se puede mandar al servidor y en qué forma (PEM de texto o DER en base64).
 * La validación real (X.509, clave, subject, vigencia, emisor) es de la Edge y de la base.
 *
 * Regla de seguridad: un archivo que contenga material de clave (bloque PEM de clave o un
 * contenedor DER tipo PKCS#12/PKCS#8) NUNCA sale del navegador. TechRepair Pro no lo necesita:
 * la clave del equipo se genera y se guarda server-side.
 *
 * Módulo puro (sin React ni Supabase).
 */

/** Mismo tope que `MAX_CERTIFICATE_BYTES` de la Edge (se aplica al texto enviado). */
export const ARCA_CERTIFICATE_MAX_BYTES = 64 * 1024
export const ARCA_CERTIFICATE_ACCEPT = '.crt,.cer,.pem,.der'
const ALLOWED_EXTENSIONS = ['crt', 'cer', 'pem', 'der'] as const
/** Contenedores que llevan la clave privada adentro. */
const KEY_CONTAINER_EXTENSIONS = ['pfx', 'p12', 'key'] as const

export type ArcaCertificateFileRejection =
  | 'EMPTY_FILE'
  | 'UNSUPPORTED_FILE'
  | 'TOO_LARGE'
  | 'KEY_MATERIAL_NOT_ACCEPTED'
  | 'REQUEST_FILE_NOT_CERTIFICATE'
  | 'CERTIFICATE_INVALID'

export type ArcaCertificatePayload =
  | { ok: true; kind: 'pem'; pem: string }
  | { ok: true; kind: 'der'; derBase64: string }
  | { ok: false; reason: ArcaCertificateFileRejection }

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Etiquetas `-----BEGIN <ETIQUETA>-----` presentes en un texto. */
function pemLabels(text: string): string[] {
  return [...text.matchAll(/-----BEGIN ([A-Z0-9 ]{1,40})-----/g)].map((m) => m[1])
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Longitud de un encabezado DER (tag + largo); null si no es válido. */
function derHeaderLength(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null
  const first = bytes[offset + 1]
  if (first < 0x80) return 2
  const n = first & 0x7f
  if (n === 0 || n > 4 || offset + 2 + n > bytes.length) return null
  return 2 + n
}

/**
 * Clasifica un archivo elegido por el usuario. `bytes` es el contenido completo; nunca se
 * loguea ni se guarda.
 */
export function readArcaCertificateFile(file: { name: string; size: number; bytes: Uint8Array }): ArcaCertificatePayload {
  const ext = extensionOf(file.name)
  if ((KEY_CONTAINER_EXTENSIONS as readonly string[]).includes(ext)) return { ok: false, reason: 'KEY_MATERIAL_NOT_ACCEPTED' }
  if (ext === 'csr') return { ok: false, reason: 'REQUEST_FILE_NOT_CERTIFICATE' }
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) return { ok: false, reason: 'UNSUPPORTED_FILE' }
  if (file.size === 0 || file.bytes.length === 0) return { ok: false, reason: 'EMPTY_FILE' }
  if (file.size > ARCA_CERTIFICATE_MAX_BYTES || file.bytes.length > ARCA_CERTIFICATE_MAX_BYTES) return { ok: false, reason: 'TOO_LARGE' }

  // ¿Texto PEM? (ASCII con encabezados BEGIN)
  const text = new TextDecoder('utf-8', { fatal: false }).decode(file.bytes).replace(/^﻿/, '')
  const labels = pemLabels(text)
  if (labels.length > 0) {
    if (labels.some((label) => label.includes('KEY'))) return { ok: false, reason: 'KEY_MATERIAL_NOT_ACCEPTED' }
    if (labels.some((label) => label.includes('REQUEST'))) return { ok: false, reason: 'REQUEST_FILE_NOT_CERTIFICATE' }
    const certificates = labels.filter((label) => label === 'CERTIFICATE').length
    if (certificates !== 1 || labels.length !== 1) return { ok: false, reason: 'CERTIFICATE_INVALID' }
    return { ok: true, kind: 'pem', pem: text.trim() }
  }

  // ¿DER? Un X.509 es SEQUENCE { SEQUENCE tbsCertificate, … }. PKCS#12 y las claves
  // (PKCS#1/PKCS#8) empiezan con un INTEGER de versión: se rechazan sin enviarse.
  if (file.bytes[0] !== 0x30) return { ok: false, reason: 'CERTIFICATE_INVALID' }
  const outer = derHeaderLength(file.bytes, 0)
  if (outer === null) return { ok: false, reason: 'CERTIFICATE_INVALID' }
  const childTag = file.bytes[outer]
  if (childTag === 0x02) return { ok: false, reason: 'KEY_MATERIAL_NOT_ACCEPTED' }
  if (childTag !== 0x30) return { ok: false, reason: 'CERTIFICATE_INVALID' }
  const derBase64 = toBase64(file.bytes)
  if (derBase64.length > ARCA_CERTIFICATE_MAX_BYTES) return { ok: false, reason: 'TOO_LARGE' }
  return { ok: true, kind: 'der', derBase64 }
}

/** Textos de rechazo local (el servidor tiene los suyos en `arcaSetupErrors`). */
export const ARCA_CERTIFICATE_FILE_COPY: Readonly<Record<ArcaCertificateFileRejection, { title: string; message: string }>> = {
  EMPTY_FILE: { title: 'El archivo está vacío', message: 'Elegí el certificado (.crt) que descargaste de ARCA.' },
  UNSUPPORTED_FILE: { title: 'Formato no admitido', message: 'Subí el certificado de ARCA en formato .crt, .cer, .pem o .der.' },
  TOO_LARGE: { title: 'El archivo es demasiado grande', message: 'Un certificado de ARCA pesa unos pocos kilobytes. Subí sólo el certificado.' },
  KEY_MATERIAL_NOT_ACCEPTED: { title: 'Ese archivo contiene una clave', message: 'No lo subas ni lo compartas: TechRepair Pro no lo necesita. Subí el certificado (.crt) que emitió ARCA.' },
  REQUEST_FILE_NOT_CERTIFICATE: { title: 'Ese es el archivo para ARCA', message: 'Primero presentalo en ARCA; después subí acá el certificado (.crt) que ARCA te devuelva.' },
  CERTIFICATE_INVALID: { title: 'El archivo no es válido', message: 'No parece un certificado de ARCA. Subí el .crt tal como lo descargaste.' },
}
