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
  /** Aclaración para un caso particular del paso (se muestra debajo del detalle). */
  note?: string
  /** Lugar reservado para una captura futura (ruta dentro de /public). */
  screenshot?: string
}

export interface ArcaGuideLink {
  label: string
  href: string
}

/** La Clave Fiscal se usa sólo en el sitio de ARCA. TechRepair Pro nunca la pide ni la guarda. */
export const ARCA_CLAVE_FISCAL_NOTE = 'Estos pasos se hacen en el sitio de ARCA, con tu Clave Fiscal. TechRepair Pro nunca te pide ni guarda tu Clave Fiscal.'

export interface ArcaSetupGuide {
  intro: string
  /** Aclaración fija sobre la Clave Fiscal (ARCA_CLAVE_FISCAL_NOTE). */
  claveFiscalNote: string
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

  // Homologación: pasos confirmados en el smoke real con WSASS (2026-09-15).
  if (input.ambiente === 'homologacion') {
    return {
      intro: 'Homologación es el ambiente de pruebas de ARCA: los comprobantes no tienen validez fiscal.',
      claveFiscalNote: ARCA_CLAVE_FISCAL_NOTE,
      steps: [
        { key: 'login', title: 'Ingresá a ARCA con tu Clave Fiscal', detail: `Usá el CUIT ${input.cuitLabel}.` },
        { key: 'wsass', title: 'Abrí el servicio de certificados de homologación (WSASS)', detail: 'Si no aparece en tu lista de servicios, primero tenés que adherirlo desde el Administrador de Relaciones de Clave Fiscal.' },
        {
          key: 'certificate',
          title: 'Creá el certificado con el archivo',
          detail: `Usá exactamente el mismo nombre de equipo que muestra TechRepair Pro: en homologación sólo lleva letras y números. Si es la primera vez que usás ese nombre, creá el certificado normalmente con el contenido de ${file}. Guardá el certificado que te devuelve ARCA.`,
          copyValue: aliasCopy,
          note: 'Si ese nombre ya existe en WSASS y estás cargando un archivo nuevo, no lo crees de nuevo: usá «agregar certificado a DN existente» con el archivo nuevo.',
        },
        {
          key: 'authorize',
          title: 'Autorizá la facturación electrónica',
          detail: 'En el mismo servicio, creá la autorización del servicio de facturación electrónica (wsfe) para ese nombre de equipo.',
          note: 'Si el DN ya tenía autorizado WSFE, esa autorización se conserva: no hace falta crearla otra vez.',
        },
      ],
      warning: 'Si no autorizás la facturación electrónica para el equipo, ARCA rechaza la conexión aunque el certificado esté bien.',
      links: [CLAVE_FISCAL_LOGIN],
    }
  }

  return {
    intro: 'Vas a necesitar Clave Fiscal nivel 3 o superior del CUIT que va a facturar.',
    claveFiscalNote: ARCA_CLAVE_FISCAL_NOTE,
    steps: [
      { key: 'login', title: 'Ingresá a ARCA con tu Clave Fiscal', detail: `Usá el CUIT ${input.cuitLabel}.` },
      { key: 'certificate', title: 'Abrí «Administración de Certificados Digitales»', detail: `Elegí «Agregar alias», usá exactamente este nombre de equipo y subí ${file}. Después descargá el certificado (.crt) que emite ARCA.`, copyValue: aliasCopy },
      { key: 'relation', title: 'Abrí «Administrador de Relaciones de Clave Fiscal»', detail: 'Creá una nueva relación: en Representante elegí ese nombre de equipo y en Servicio elegí Facturación Electrónica (WSFE). Confirmala.' },
    ],
    warning: 'Este último paso se olvida fácil: sin la relación, ARCA responde que el equipo no está autorizado aunque el certificado esté bien.',
    links: [CLAVE_FISCAL_LOGIN],
  }
}
