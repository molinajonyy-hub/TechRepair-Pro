/**
 * ARCA Self-Service Phase 2B — guía corta para presentar el archivo en ARCA.
 *
 * Contenido como DATOS (no JSX) para poder sumar capturas, videos o links oficiales sin tocar
 * los componentes. Sólo usa pasos ya documentados en el repo (tutorial de ARCA); los nombres
 * de pantallas de ARCA pueden cambiar: la guía nunca promete un texto exacto de ARCA.
 *
 * Nunca incluye datos que el usuario no cargó: alias, CUIT y archivo vienen del estado del servidor.
 */

export interface ArcaGuideStep {
  key: string
  title: string
  detail: string
  /** Valor para copiar (alias, CUIT). */
  copyValue?: { label: string; value: string }
  /** Lugar reservado para una captura futura (ruta dentro de /public). */
  screenshot?: string
}

export interface ArcaGuideLink {
  label: string
  href: string
}

export interface ArcaSetupGuide {
  intro: string
  steps: ArcaGuideStep[]
  warning: string
  links: ArcaGuideLink[]
}

/** Único link oficial ya usado en el producto (tutorial de ARCA). */
const CLAVE_FISCAL_LOGIN: ArcaGuideLink = {
  label: 'Ingresar a ARCA con Clave Fiscal',
  href: 'https://auth.afip.gob.ar/contribuyente_/login.xhtml',
}

export function buildArcaSetupGuide(input: {
  ambiente: 'homologacion' | 'produccion' | null
  alias: string | null
  cuitLabel: string
  filename: string | null
}): ArcaSetupGuide {
  const alias = input.alias ?? ''
  const file = input.filename ?? 'el archivo que descargaste'
  const aliasCopy = alias ? { label: 'Nombre del equipo', value: alias } : undefined

  if (input.ambiente === 'homologacion') {
    return {
      intro: 'Homologación es el ambiente de pruebas de ARCA: los comprobantes no tienen validez fiscal.',
      steps: [
        { key: 'login', title: 'Ingresá a ARCA con tu Clave Fiscal', detail: `Usá el CUIT ${input.cuitLabel}.` },
        { key: 'wsass', title: 'Abrí el servicio de certificados de homologación (WSASS)', detail: 'Si no aparece en tu lista de servicios, primero tenés que adherirlo desde el Administrador de Relaciones de Clave Fiscal.' },
        { key: 'certificate', title: 'Creá el certificado con el archivo', detail: `Usá exactamente este nombre de equipo y pegá o subí ${file}. Descargá el certificado que te devuelve ARCA.`, copyValue: aliasCopy },
        { key: 'authorize', title: 'Autorizá la facturación electrónica', detail: 'En el mismo servicio, creá la autorización del servicio de facturación electrónica (wsfe) para ese nombre de equipo.' },
      ],
      warning: 'Si no autorizás la facturación electrónica para el equipo, ARCA rechaza la conexión aunque el certificado esté bien.',
      links: [CLAVE_FISCAL_LOGIN],
    }
  }

  return {
    intro: 'Vas a necesitar Clave Fiscal nivel 3 o superior del CUIT que va a facturar.',
    steps: [
      { key: 'login', title: 'Ingresá a ARCA con tu Clave Fiscal', detail: `Usá el CUIT ${input.cuitLabel}.` },
      { key: 'certificate', title: 'Abrí «Administración de Certificados Digitales»', detail: `Elegí «Agregar alias», usá exactamente este nombre de equipo y subí ${file}. Después descargá el certificado (.crt) que emite ARCA.`, copyValue: aliasCopy },
      { key: 'relation', title: 'Abrí «Administrador de Relaciones de Clave Fiscal»', detail: 'Creá una nueva relación: en Representante elegí ese nombre de equipo y en Servicio elegí Facturación Electrónica (WSFE). Confirmala.' },
    ],
    warning: 'Este último paso se olvida fácil: sin la relación, ARCA responde que el equipo no está autorizado aunque el certificado esté bien.',
    links: [CLAVE_FISCAL_LOGIN],
  }
}
