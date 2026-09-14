/**
 * ARCA Self-Service Phase 2B — capa ÚNICA de errores del asistente.
 *
 * Traduce los estados acotados que devuelve `arcaSetupService` (nunca texto del servidor ni de
 * ARCA) a lenguaje de negocio: categoría, título, explicación, acción recomendada y si se puede
 * reintentar. Los componentes no ramifican por código: consumen esta vista.
 *
 * Las ESPERAS (hold) no se deciden acá: la autoridad es `setup.verification_hold` de Phase 1.
 * `retry: 'after_hold'` sólo indica que la pantalla debe volver a leer el estado.
 *
 * Módulo puro (sin React ni Supabase).
 */

export type ArcaSetupErrorCategory =
  | 'input' | 'auth' | 'plan' | 'certificate' | 'arca' | 'hold' | 'ambiguous' | 'activation' | 'network' | 'flow'

/**
 * now        → el usuario puede volver a intentar ya (mismo pedido).
 * after_fix  → hay que corregir algo (datos, certificado, autorización en ARCA) antes de reintentar.
 * after_hold → la base impuso una espera: releer el estado; nunca reintentar desde la UI.
 * later      → problema transitorio: probar más tarde.
 * never      → no hay reintento posible desde el asistente.
 */
export type ArcaSetupRetryPolicy = 'now' | 'after_fix' | 'after_hold' | 'later' | 'never'

export type ArcaSetupErrorField = 'cuit' | 'razon_social' | 'ambiente' | 'punto_venta' | 'alias' | 'certificate'

export interface ArcaSetupErrorView {
  code: string
  category: ArcaSetupErrorCategory
  tone: 'danger' | 'warning' | 'info'
  title: string
  message: string
  action: string
  retry: ArcaSetupRetryPolicy
  field?: ArcaSetupErrorField
}

type Entry = Omit<ArcaSetupErrorView, 'code'>

const GENERIC: Entry = {
  category: 'network', tone: 'warning', retry: 'later',
  title: 'No pudimos completar el paso',
  message: 'Algo no respondió como esperábamos. No se perdió ningún dato.',
  action: 'Probá de nuevo en unos minutos.',
}

const ENTRIES: Readonly<Record<string, Entry>> = {
  // ── Datos fiscales ──
  INVALID_CUIT: { category: 'input', tone: 'danger', retry: 'after_fix', field: 'cuit',
    title: 'Revisá el CUIT', message: 'El CUIT no es válido: tiene que tener 11 dígitos y el dígito verificador correcto.', action: 'Corregí el CUIT y volvé a confirmar.' },
  CUIT_TENANT_MISMATCH: { category: 'input', tone: 'danger', retry: 'after_fix', field: 'cuit',
    title: 'El CUIT no coincide con tu negocio', message: 'Es distinto del CUIT cargado en «Datos del negocio».', action: 'Usá el CUIT del negocio o corregilo primero en «Datos del negocio».' },
  INVALID_AMBIENTE: { category: 'input', tone: 'danger', retry: 'after_fix', field: 'ambiente',
    title: 'Elegí dónde vas a emitir', message: 'Falta indicar si la conexión es de producción o de homologación.', action: 'Elegí una opción y volvé a confirmar.' },
  INVALID_PUNTO_VENTA: { category: 'input', tone: 'danger', retry: 'after_fix', field: 'punto_venta',
    title: 'Revisá el punto de venta', message: 'Tiene que ser un número entre 1 y 99998.', action: 'Corregí el punto de venta y volvé a confirmar.' },
  INVALID_ALIAS: { category: 'input', tone: 'danger', retry: 'after_fix', field: 'alias',
    title: 'Revisá el nombre del equipo', message: 'Usá entre 3 y 50 letras sin acentos, números, puntos o guiones.', action: 'Corregí el nombre y volvé a confirmar.' },
  INVALID_RAZON_SOCIAL: { category: 'input', tone: 'danger', retry: 'after_fix', field: 'razon_social',
    title: 'Revisá la razón social', message: 'Completala tal como figura en ARCA (hasta 200 caracteres).', action: 'Corregila y volvé a confirmar.' },
  IDEMPOTENCY_CONFLICT: { category: 'flow', tone: 'warning', retry: 'now',
    title: 'Los datos cambiaron', message: 'El pedido anterior tenía otros datos.', action: 'Revisá los datos y confirmá de nuevo.' },
  IDEMPOTENCY_KEY_CONSUMED: { category: 'flow', tone: 'warning', retry: 'now',
    title: 'Empezá de nuevo', message: 'Esa configuración ya se había cancelado.', action: 'Confirmá los datos para generar una nueva.' },
  INVALID_IDEMPOTENCY_KEY: { ...GENERIC, category: 'flow', retry: 'now', action: 'Volvé a intentar.' },
  BAD_REQUEST: { ...GENERIC, category: 'flow', retry: 'now', action: 'Volvé a intentar.' },
  UNEXPECTED_FIELD: { ...GENERIC, category: 'flow', retry: 'now', action: 'Volvé a intentar.' },
  UNKNOWN_ACTION: { ...GENERIC, category: 'flow', retry: 'now', action: 'Volvé a intentar.' },

  // ── Flujo ──
  ARCA_ALREADY_CONFIGURED: { category: 'flow', tone: 'info', retry: 'never',
    title: 'ARCA ya está conectado', message: 'Este negocio ya tiene una conexión con ARCA.', action: 'Revisá el estado de la integración.' },
  SETUP_IN_PROGRESS: { category: 'flow', tone: 'info', retry: 'never',
    title: 'Ya hay una configuración en curso', message: 'Alguien de tu equipo empezó a configurar ARCA.', action: 'Continuá desde el paso en el que quedó.' },
  NO_SETUP_IN_PROGRESS: { category: 'flow', tone: 'info', retry: 'never',
    title: 'No hay una configuración en curso', message: 'La configuración ya no está activa.', action: 'Revisá el estado y empezá de nuevo si hace falta.' },
  SETUP_NOT_IN_PROGRESS: { category: 'flow', tone: 'info', retry: 'never',
    title: 'No hay una configuración en curso', message: 'No había nada para cancelar.', action: 'Revisá el estado de la integración.' },
  SETUP_ALREADY_COMPLETED: { category: 'flow', tone: 'info', retry: 'never',
    title: 'La configuración ya terminó', message: 'ARCA ya quedó conectado.', action: 'Revisá el estado de la integración.' },
  CERTIFICATE_REQUIRED: { category: 'flow', tone: 'warning', retry: 'after_fix', field: 'certificate',
    title: 'Falta el certificado', message: 'Antes de verificar hay que subir el certificado que emitió ARCA.', action: 'Subí el certificado.' },
  CERTIFICATE_LOCKED_VERIFIED: { category: 'flow', tone: 'info', retry: 'never',
    title: 'El certificado ya fue verificado', message: 'No hace falta volver a subirlo.', action: 'Continuá con la activación.' },
  CERTIFICATE_CHANGED: { category: 'flow', tone: 'warning', retry: 'now',
    title: 'El certificado cambió', message: 'Se subió otro certificado mientras se verificaba.', action: 'Revisá el estado y volvé a verificar.' },
  NOT_VERIFIED: { category: 'flow', tone: 'warning', retry: 'now',
    title: 'Falta verificar la conexión', message: 'La conexión con ARCA todavía no se verificó.', action: 'Verificá la conexión.' },

  // ── Esperas decididas por la base ──
  VERIFICATION_IN_PROGRESS: { category: 'hold', tone: 'info', retry: 'after_hold',
    title: 'Estamos verificando con ARCA', message: 'Hay una verificación en curso. Puede tardar unos minutos.', action: 'Esperá: la pantalla se actualiza sola.' },
  WSAA_RESULT_UNKNOWN: { category: 'ambiguous', tone: 'warning', retry: 'after_hold',
    title: 'ARCA puede haber procesado la verificación', message: 'Por seguridad vamos a esperar antes de repetirla.', action: 'No hace falta hacer nada: te avisamos cuándo se puede volver a verificar.' },
  WSAA_TICKET_ALREADY_ISSUED: { category: 'hold', tone: 'warning', retry: 'after_hold',
    title: 'ARCA ya habilitó un acceso reciente', message: 'Existe un acceso vigente para este equipo. Por seguridad hay que esperar a que venza.', action: 'Volvé a verificar cuando termine la espera.' },
  VERIFICATION_EXPIRED: { category: 'hold', tone: 'warning', retry: 'after_hold',
    title: 'La verificación venció', message: 'Pasó demasiado tiempo antes de terminar la activación.', action: 'Cuando termine la espera, volvé a verificar. No hace falta un certificado nuevo.' },
  VERIFICATION_COOLDOWN: { category: 'hold', tone: 'info', retry: 'after_hold',
    title: 'Esperá un momento', message: 'Hubo un intento reciente.', action: 'Vas a poder volver a intentar en unos segundos.' },

  // ── Certificado ──
  KEY_MATERIAL_NOT_ACCEPTED: { category: 'certificate', tone: 'danger', retry: 'after_fix', field: 'certificate',
    title: 'Ese archivo no es un certificado', message: 'Parece un archivo de clave. Nunca lo compartas: TechRepair Pro no lo necesita.', action: 'Subí el certificado (.crt) que descargaste de ARCA.' },
  CERTIFICATE_INVALID: { category: 'certificate', tone: 'danger', retry: 'after_fix', field: 'certificate',
    title: 'El archivo no es válido', message: 'El archivo no parece ser un certificado válido de ARCA.', action: 'Subí el certificado (.crt) tal como lo descargaste de ARCA.' },
  CERTIFICATE_KEY_MISMATCH: { category: 'certificate', tone: 'danger', retry: 'after_fix', field: 'certificate',
    title: 'El certificado no corresponde', message: 'Este certificado no corresponde al archivo generado por TechRepair Pro.', action: 'En ARCA, usá el archivo de esta configuración y subí el certificado que emita.' },
  CERTIFICATE_CUIT_MISMATCH: { category: 'certificate', tone: 'danger', retry: 'after_fix', field: 'certificate',
    title: 'El certificado es de otro CUIT', message: 'Pertenece a una identidad fiscal distinta de la de esta configuración.', action: 'Generá el certificado en ARCA con el CUIT del negocio.' },
  CERTIFICATE_ALIAS_MISMATCH: { category: 'certificate', tone: 'danger', retry: 'after_fix', field: 'certificate',
    title: 'El certificado es de otro equipo', message: 'Fue emitido con otro nombre de equipo.', action: 'En ARCA usá exactamente el nombre de equipo de esta configuración.' },
  CERTIFICATE_SUBJECT_MISMATCH: { category: 'certificate', tone: 'danger', retry: 'after_fix', field: 'certificate',
    title: 'El certificado no corresponde a esta configuración', message: 'Sus datos no coinciden con los de esta configuración.', action: 'Generá el certificado en ARCA con el archivo de esta configuración.' },
  CERTIFICATE_EXPIRED: { category: 'certificate', tone: 'danger', retry: 'after_fix', field: 'certificate',
    title: 'El certificado está vencido', message: 'ARCA ya no lo acepta.', action: 'Generá un certificado nuevo en ARCA con el archivo de esta configuración.' },
  CERTIFICATE_NOT_YET_VALID: { category: 'certificate', tone: 'warning', retry: 'after_fix', field: 'certificate',
    title: 'El certificado todavía no está vigente', message: 'Su fecha de inicio es posterior a hoy.', action: 'Revisá la fecha de tu equipo o probá más tarde.' },
  CERTIFICATE_ISSUER_UNEXPECTED: { category: 'certificate', tone: 'danger', retry: 'after_fix', field: 'certificate',
    title: 'El certificado no es de este ambiente', message: 'No fue emitido por ARCA para el ambiente elegido (producción u homologación).', action: 'Generá el certificado en el sitio de ARCA que corresponde al ambiente.' },
  TOO_LARGE: { category: 'certificate', tone: 'danger', retry: 'after_fix', field: 'certificate',
    title: 'El archivo es demasiado grande', message: 'Un certificado de ARCA pesa unos pocos kilobytes.', action: 'Subí sólo el certificado (.crt).' },

  // ── Verificación con ARCA ──
  WSAA_SERVICE_NOT_AUTHORIZED: { category: 'arca', tone: 'danger', retry: 'after_fix',
    title: 'Falta autorizar la facturación electrónica', message: 'ARCA no tiene autorizado este equipo para el servicio de facturación electrónica.', action: 'En ARCA, autorizá el servicio de facturación electrónica para este equipo y volvé a verificar.' },
  WSAA_CERTIFICATE_REJECTED: { category: 'arca', tone: 'danger', retry: 'after_fix',
    title: 'ARCA rechazó el certificado', message: 'ARCA no aceptó el certificado para esta conexión.', action: 'Revisá que sea el certificado emitido para esta configuración y el ambiente correcto.' },
  WSAA_REJECTED: { category: 'arca', tone: 'danger', retry: 'later',
    title: 'ARCA rechazó la verificación', message: 'ARCA respondió con un rechazo.', action: 'Probá de nuevo más tarde. Si se repite, contactá a soporte.' },
  WSAA_UNAVAILABLE: { category: 'arca', tone: 'warning', retry: 'later',
    title: 'ARCA no está disponible', message: 'El servicio de ARCA no respondió.', action: 'Probá de nuevo en unos minutos.' },
  SIGNING_FAILED: { category: 'certificate', tone: 'danger', retry: 'after_fix', field: 'certificate',
    title: 'No pudimos usar el certificado', message: 'El certificado no coincide con el archivo generado para esta configuración.', action: 'Subí el certificado que emitió ARCA para el archivo de esta configuración.' },

  // ── Activación ──
  ACTIVATION_PENDING: { category: 'activation', tone: 'warning', retry: 'now',
    title: 'Falta terminar la activación', message: 'La verificación con ARCA quedó guardada.', action: 'Reintentá la activación. No hace falta volver a ARCA.' },
  ACTIVATION_FAILED: { category: 'activation', tone: 'danger', retry: 'now',
    title: 'No pudimos activar la conexión', message: 'La verificación quedó guardada, pero la activación no terminó.', action: 'Reintentá la activación. Si se repite, contactá a soporte.' },
  FISCAL_IDENTITY_MISMATCH: { category: 'activation', tone: 'danger', retry: 'never',
    title: 'Los datos fiscales no coinciden', message: 'Los datos del negocio cambiaron y ya no coinciden con el certificado.', action: 'Contactá a soporte antes de continuar.' },

  // ── Autoridad / plan / red ──
  FORBIDDEN: { category: 'auth', tone: 'danger', retry: 'never',
    title: 'No tenés permiso para configurar ARCA', message: 'Sólo el dueño o un administrador con permiso de configuración avanzada puede hacerlo.', action: 'Pedíselo a quien administra el negocio.' },
  UNAUTHORIZED: { category: 'auth', tone: 'danger', retry: 'never',
    title: 'No tenés permiso para configurar ARCA', message: 'Sólo el dueño o un administrador con permiso de configuración avanzada puede hacerlo.', action: 'Pedíselo a quien administra el negocio.' },
  UNAUTHENTICATED: { category: 'auth', tone: 'warning', retry: 'never',
    title: 'Tu sesión venció', message: 'Por seguridad hay que volver a ingresar.', action: 'Iniciá sesión de nuevo y continuá desde donde quedaste.' },
  ARCA_FEATURE_REQUIRED: { category: 'plan', tone: 'info', retry: 'never',
    title: 'Tu plan no incluye ARCA', message: 'La facturación electrónica está disponible en los planes que la incluyen.', action: 'Revisá los planes disponibles.' },
  AUTHORIZATION_UNAVAILABLE: GENERIC,
  SETUP_UNAVAILABLE: GENERIC,
  KEY_GENERATION_FAILED: { ...GENERIC, retry: 'now', action: 'Volvé a confirmar los datos.' },
}

/** Vista de error para un estado acotado. Un código desconocido nunca se muestra: da el mensaje genérico. */
export function describeArcaSetupError(code: string | null | undefined): ArcaSetupErrorView {
  const key = typeof code === 'string' && Object.prototype.hasOwnProperty.call(ENTRIES, code) ? code : 'SETUP_UNAVAILABLE'
  return { code: key, ...ENTRIES[key] }
}

/** Códigos con mensaje propio (para tests de cobertura del contrato). */
export const ARCA_SETUP_ERROR_CODES: readonly string[] = Object.freeze(Object.keys(ENTRIES))
