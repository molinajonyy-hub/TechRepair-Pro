#!/usr/bin/env node
// ============================================================================
// Guard — WhatsApp estándar (W1): handoff honesto y desacoplado.
//
//   node scripts/guards/whatsapp-w1-standard.mjs             (valida el repo)
//   node scripts/guards/whatsapp-w1-standard.mjs --self-test (valida el guard)
//
// ┌── QUÉ PROTEGE ──────────────────────────────────────────────────────────┐
// │ 1. HONESTIDAD. Abrir wa.me NO es enviar. TechRepair no tiene evidencia  │
// │    de `sent`, `delivered` ni `read`, así que no puede registrarlos ni   │
// │    rotularlos. El historial llegó a mostrar "Enviado" para un evento    │
// │    que sólo significaba "abrimos WhatsApp".                             │
// │ 2. DESACOPLE. El camino estándar (plantilla → preview → wa.me) no puede │
// │    depender del transporte oficial de Meta: ni Cloud API, ni Edge       │
// │    Functions de envío, ni tokens.                                       │
// │ 3. VOCABULARIO. `whatsapp_logs.send_result` tiene un CHECK en producción│
// │    (opened|copied|failed|skipped|sent_api). Un valor fuera de esa lista │
// │    no es un bug de tipos: es un 23514 en runtime, en la cara del user.  │
// │ 4. ALLOWLIST. Las variables de plantilla se declaran en UN solo lugar.  │
// │ 5. MULTITENANT. Toda lectura/escritura de plantillas va acotada por     │
// │    business_id.                                                          │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Se mide sobre el CÓDIGO FUENTE. El comportamiento ya lo cubren
// tests/unit/whatsappTemplate.test.ts y tests/components/whatsappW1.test.tsx;
// acá interesa que no reaparezca la FORMA que causaba el problema.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** Módulos del camino estándar. NO pueden tocar el transporte oficial. */
const MODULOS_W1 = [
  'src/services/whatsappTemplate.ts',
  'src/services/whatsappHandoff.ts',
]

const RENDERER  = 'src/services/whatsappTemplate.ts'
const HANDOFF   = 'src/services/whatsappHandoff.ts'
/** Único módulo que le habla al Companion. */
const CLIENTE_COMPANION = 'src/services/whatsappCompanion.ts'
/** Único lugar donde se lee y valida la configuración del Companion. */
const ENV_COMPANION = 'src/config/whatsappCompanionEnv.ts'
const MODAL     = 'src/components/whatsapp/WhatsAppPreviewModal.tsx'
const HISTORIAL = 'src/components/whatsapp/WhatsAppHistorial.tsx'
const EDITOR    = 'src/components/settings/WhatsAppTemplatesSettings.tsx'

/** Migracion que limita la escritura de whatsapp_templates a owner/admin. */
const MIGRACION_GATE = '20260819120000_whatsapp_templates_settings_sensitive_rls.sql'

/** Vocabulario EXACTO que acepta el CHECK whatsapp_logs_send_result_check. */
const SEND_RESULT_VALIDOS = ['opened', 'copied', 'failed', 'skipped', 'sent_api']

// ─── Comprobaciones puras (testeables) ──────────────────────────────────────

/**
 * Saca los comentarios antes de medir la FORMA del código.
 *
 * Sin esto el guard se dispara con su propia documentación: el encabezado de
 * `whatsappHandoff.ts` nombra `access_token` y `whatsapp-send` justamente para
 * explicar que NO los usa. Un guard que una prosa correcta puede romper obliga
 * a no escribir esa prosa.
 *
 * Se quitan los bloques `/* *\/` y los comentarios de línea que ARRANCAN la
 * línea. Los de fin de línea se dejan a propósito: quitarlos exigiría parsear
 * strings, y truncaría un literal como 'https://wa.me/' en el primer `//`.
 */
export function sinComentarios(fuente) {
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** Un módulo del camino estándar no puede importar el transporte oficial. */
export function importaTransporteOficial(fuente) {
  return /from\s+['"][^'"]*whatsappCloudService/.test(fuente)
      || /from\s+['"][^'"]*\/lib\/supabase/.test(fuente)
      || /supabase\s*\.\s*functions\s*\.\s*invoke/.test(fuente)
      || /whatsapp-send|whatsapp-embedded-signup/.test(fuente)
}

/** Ni conocer credenciales de Meta. */
export function mencionaSecretosMeta(fuente) {
  return /access_token|phone_number_id|META_APP_ID|META_APP_SECRET/.test(fuente)
}

/**
 * Registrar un envío que no ocurrió. `send_result` sólo puede tomar valores
 * del CHECK, y `sent`/`delivered`/`read` no están ahí por diseño.
 */
export function registraEnvioInexistente(fuente) {
  const asignaciones = [...fuente.matchAll(/send_result\s*:\s*['"]([a-z_]+)['"]/g)]
  return asignaciones.some(m => !SEND_RESULT_VALIDOS.includes(m[1]))
}

/** El historial no puede rotular una apertura como "Enviado". */
export function rotulaAperturaComoEnviado(fuente) {
  // Caza `opened: { label: 'Enviado' ...` con cualquier separación.
  return /\bopened\s*:\s*\{[^}]*label\s*:\s*['"]\s*Enviado\s*['"]/.test(fuente)
}

/** El renderer declara la allowlist y la expone. */
export function declaraAllowlist(fuente) {
  return /export const WHATSAPP_VARIABLES/.test(fuente)
}

/**
 * El renderer hace UNA sola pasada con replacer.
 *
 * La forma peligrosa es construir una RegExp POR CLAVE y aplicarla una clave
 * por vez (lo que hacía `interpolateTemplate`): la iteración N+1 vuelve a
 * recorrer el texto ya sustituido, así que un valor que contenga `{precio}`
 * termina expandido. Se caza esa forma directamente, sin depender de matchear
 * el encabezado del `for` (que lleva paréntesis anidados).
 */
export function reemplazaEnUnaPasada(fuente) {
  if (/\.replace\(\s*new RegExp\(/.test(fuente)) return false
  // Y la forma correcta tiene que estar presente, no sólo ausente la mala.
  return /\.replace\(\s*PLACEHOLDER_RE\s*,/.test(fuente)
}

/** Nada de evaluar plantillas dinámicamente. */
export function evaluaDinamicamente(fuente) {
  return /\beval\s*\(|new\s+Function\s*\(/.test(fuente)
}

/** El handoff móvil sigue siendo wa.me (deja que el sistema abra la app). */
export function usaWaMe(fuente) {
  return /https:\/\/wa\.me\//.test(fuente)
}

/** En desktop se va directo a WhatsApp Web, sin pantalla intermedia. */
export function usaWebSendEnDesktop(fuente) {
  return /https:\/\/web\.whatsapp\.com\/send/.test(fuente)
}

/**
 * `api.whatsapp.com/send` es la pantalla intermedia ("Abrir aplicación" /
 * "Continuar en WhatsApp Web"). Es el paso que hacía que el navegador
 * estrenara pestaña fuera del nombre de ventana que fija el módulo, así que el
 * camino Standard no puede volver a apuntar ahí.
 */
export function usaPantallaIntermedia(fuente) {
  return /api\.whatsapp\.com/.test(fuente)
}

/**
 * Maquinaria de reutilización de pestaña — PROHIBIDA.
 *
 * MEDIDO en Chromium real: `web.whatsapp.com` manda `COOP: same-origin`, así
 * que al navegar hacia allá el `WindowProxy` queda severed y `closed` pasa a
 * `true` con la pestaña abierta. Fallan las tres vías: referencia con opener
 * anulado, referencia con opener conservado, y target por nombre. Cualquier
 * intento de volver a "reutilizar la pestaña" es humo, y peor: los tests con
 * un WindowProxy falso lo dan por bueno.
 *
 * Además `ref.opener = null` renuncia al permiso de navegar esa pestaña
 * después (SecurityError), así que el patrón estaba roto por dos motivos.
 */
export function intentaReutilizarPestana(fuente) {
  return /\.closed\b/.test(fuente)          // guardar y consultar una referencia
      || /\.opener\s*=\s*null/.test(fuente) // cortar el opener para conservarla
      || /WHATSAPP_WINDOW_NAME/.test(fuente)// target con nombre estable
      || /techrepair_whatsapp/.test(fuente)
}

/**
 * TechRepair NO navega su propia pestaña hacia WhatsApp.
 *
 * ESTO INVIERTE EL INVARIANTE ANTERIOR, a propósito. Antes se EXIGÍA
 * `location.assign` porque, sin forma de reutilizar una pestaña, navegar la
 * actual era el único modo determinista de no acumularlas — a costa de sacar al
 * usuario de su trabajo. Con el Companion resolviendo el caso bueno, el fallback
 * puede ser una pestaña nueva avisada, y navegar TechRepair pasa a estar
 * prohibido.
 *
 * `abrirAppDeEscritorio` sigue usando `location.href` para `whatsapp://`: eso no
 * es navegar, el sistema operativo se lo lleva. Por eso la segunda rama exige
 * que el destino sea un host de WhatsApp en la MISMA línea.
 */
export function navegaTechRepairAWhatsApp(fuente) {
  return /location\.assign\(/.test(fuente)
      || /location\.href\s*=[^\n;]*(web\.whatsapp|wa\.me)/.test(fuente)
}

/** El fallback sin Companion abre una pestaña nueva, y existe. */
export function ofreceFallbackDePestanaNueva(fuente) {
  return /abrirWhatsAppWebEnNuevaPestana/.test(fuente)
}

// ─── Companion (extensión de Chrome) ────────────────────────────────────────

/**
 * Al Companion se le manda SÓLO `{ type, phone, text }`.
 *
 * Si el llamador pudiera aportar `url`/`hostname`/`path`, la extensión —que
 * tiene permiso de navegar pestañas— se volvería un open-redirect. El destino
 * lo construye ella con host y path constantes suyos.
 */
export function mandaCamposDeMas(fuente) {
  const payloads = [...fuente.matchAll(/const payload\s*=\s*\{([\s\S]*?)\}/g)]
  if (payloads.length === 0) return false
  return payloads.some(p => /\b(url|hostname|scheme|path|origin|business_id|customer)\s*:/.test(p[1]))
}

/** El payload lleva las tres claves del contrato, no otras. */
export function mandaElContratoCompleto(fuente) {
  const payload = fuente.match(/const payload\s*=\s*\{([\s\S]*?)\}/)
  if (!payload) return false
  return /\btype\s*:/.test(payload[1])
      && /\bphone\s*:/.test(payload[1])
      && /\btext\s*:/.test(payload[1])
}

/** El extension ID sale de configuración, nunca hardcodeado. */
export function hardcodeaExtensionId(fuente) {
  return /['"][a-p]{32}['"]/.test(fuente)
}

/** ...y si falta, el cliente se declara no disponible en vez de adivinar. */
export function fallaCerradoSinExtensionId(fuente) {
  return /if\s*\(\s*!extensionId\s*\)\s*return/.test(fuente)
}

/** La configuración sale del entorno, y se valida antes de usarse. */
export function leeLaConfiguracionDelEntorno(fuente) {
  return /VITE_WHATSAPP_COMPANION_EXTENSION_ID/.test(fuente)
      && /VITE_WHATSAPP_COMPANION_INSTALL_URL/.test(fuente)
      && /\[a-p\]\{32\}/.test(fuente)
}

/** Una URL de instalación que no sea https no puede llegar a un href. */
export function exigeHttpsEnLaInstalacion(fuente) {
  return /protocol\s*===\s*['"]https:['"]/.test(fuente)
}

/**
 * El descubrimiento no puede ensuciar la consola.
 *
 * Son dos cosas distintas: no escribir con `console.*`, y LEER
 * `runtime.lastError` dentro del callback — si no se lee, Chrome imprime
 * "Unchecked runtime.lastError" en la consola de todo usuario sin la extensión.
 */
export function ensuciaLaConsola(fuente) {
  // Se exige la LECTURA (`= …lastError`), no la mera aparición de la palabra:
  // la declaración de tipo `lastError?: { message?: string }` la contiene y
  // dejaría pasar un callback que nunca la consulta.
  const leeLastError = /=\s*[\w.]*\blastError\b/.test(fuente)
  return /\bconsole\s*\.\s*(log|warn|error|info|debug)\s*\(/.test(fuente)
      || !leeLastError
}

/** Existe el camino de la app de escritorio (protocolo whatsapp://). */
export function ofreceAppDeEscritorio(fuente) {
  return /buildAppUrl/.test(fuente) && /abrirAppDeEscritorio/.test(fuente)
}

/** El copy no puede prometer lo que el navegador no permite. */
export function prometeReutilizarPestana(fuente) {
  return /reutiliza[^\n]*pesta/i.test(fuente)
      || /misma pesta[^\n]*siempre/i.test(fuente)
}

/** El handoff falla CERRADO: un teléfono inválido no produce URL. */
export function fallaCerradoSinTelefono(fuente) {
  return /ok:\s*false/.test(fuente) && /telefono\.valid/.test(fuente)
}

/** El modal bloquea la apertura cuando queda una variable sin resolver. */
export function bloqueaVariableSinResolver(fuente) {
  return /motivoDeBloqueo/.test(fuente) && /!bloqueo/.test(fuente)
}

/** El modal arma el mensaje con el renderer de allowlist. */
export function usaRendererCanonico(fuente) {
  return /from\s+['"][^'"]*whatsappTemplate['"]/.test(fuente)
      && /\brenderTemplate\s*\(/.test(fuente)
}

/**
 * Una migracion que reabre la escritura de whatsapp_templates a is_staff().
 *
 * El chequeo AUTORITATIVO del gate es dinamico y vive en
 * supabase/tests/whatsapp_templates_rls_test.sql (consulta pg_policies). Esto
 * es solo la red estatica: caza el `CREATE POLICY ... FOR INSERT/UPDATE/DELETE
 * ... is_staff()` sobre esa tabla en cualquier migracion nueva, que es la forma
 * concreta en que el agujero volveria.
 */
export function reabreEscrituraATodoElStaff(fuente) {
  const bloques = fuente.match(
    /CREATE\s+POLICY[\s\S]*?ON\s+(?:public\.)?"?whatsapp_templates"?[\s\S]*?(?=CREATE\s+POLICY|DROP\s+POLICY|COMMIT|$)/gi)
  if (!bloques) return false
  return bloques.some(b =>
    /FOR\s+(INSERT|UPDATE|DELETE)/i.test(b) && /is_staff\(\)/.test(b))
}

/** El editor de plantillas gatea con el helper canónico de permisos. */
export function gateaConPermisoCanonico(fuente) {
  return /from\s+['"][^'"]*usePermissions['"]/.test(fuente)
      && /can\(\s*['"]settings_sensitive['"]\s*\)/.test(fuente)
}

/** ...y no inventa un sistema paralelo de roles. */
export function inventaRolesAMano(fuente) {
  return /role\s*===\s*['"](owner|admin|manager|tech|sales|cashier|viewer)['"]/.test(fuente)
      || /\bisOwner\s*\|\|\s*isAdmin\b/.test(fuente)
}

/** Toda operación sobre las tablas de WhatsApp va acotada por negocio. */
export function acotaPorNegocio(fuente) {
  const tocaTablas = /\.from\(\s*['"]whatsapp_(templates|settings)['"]\s*\)/.test(fuente)
  if (!tocaTablas) return true
  return /\.eq\(\s*['"]business_id['"]/.test(fuente)
      || /business_id:\s*businessId/.test(fuente)
}

/** El editor guarda sólo si tiene permiso (fail-closed en el handler). */
export function guardaSoloConPermiso(fuente) {
  return /if\s*\(\s*!businessId\s*\|\|\s*!puedeEditar\s*\)\s*return/.test(fuente)
}

// ─── Recorrido del repo ─────────────────────────────────────────────────────

function validarRepo() {
  const fallas = []
  // Se mide la FORMA del código, no la documentación que la explica.
  const leer = p => sinComentarios(readFileSync(join(RAIZ, p), 'utf-8'))

  // 0. Los archivos del lote existen.
  for (const p of [RENDERER, HANDOFF, MODAL, HISTORIAL, EDITOR, CLIENTE_COMPANION, ENV_COMPANION]) {
    if (!existsSync(join(RAIZ, p))) {
      fallas.push(`Falta ${p}: el camino estándar de WhatsApp perdió una pieza.`)
    }
  }
  if (fallas.length) return fallas

  // 1. Desacople del transporte oficial.
  for (const p of MODULOS_W1) {
    const fuente = leer(p)
    if (importaTransporteOficial(fuente)) {
      fallas.push(`${p}: importa el transporte oficial (Cloud API / Supabase / Edge Function de envío). El camino estándar tiene que poder funcionar sin nada de Meta.`)
    }
    if (mencionaSecretosMeta(fuente)) {
      fallas.push(`${p}: menciona credenciales de Meta. Ese material es server-side y vive en Vault, nunca en el camino wa.me.`)
    }
    if (evaluaDinamicamente(fuente)) {
      fallas.push(`${p}: usa eval/new Function. Una plantilla es TEXTO: evaluarla convierte un campo editable por el negocio en ejecución de código.`)
    }
  }

  // 2. Honestidad de estados — en TODO el frontend, no sólo en los módulos W1.
  for (const p of [MODAL, HISTORIAL, EDITOR, 'src/services/whatsappService.ts']) {
    const fuente = leer(p)
    if (registraEnvioInexistente(fuente)) {
      fallas.push(`${p}: escribe un send_result fuera del CHECK de producción (${SEND_RESULT_VALIDOS.join('|')}). Si es 'sent'/'delivered'/'read', además afirma algo que el sistema no puede saber.`)
    }
  }
  if (rotulaAperturaComoEnviado(leer(HISTORIAL))) {
    fallas.push(`${HISTORIAL}: vuelve a rotular 'opened' como "Enviado". Abrir WhatsApp no confirma envío: el usuario todavía tiene que tocar Enviar allá.`)
  }

  // 3. El renderer conserva sus propiedades.
  const renderer = leer(RENDERER)
  if (!declaraAllowlist(renderer)) {
    fallas.push(`${RENDERER}: perdió la allowlist WHATSAPP_VARIABLES. Sin allowlist, cualquier {placeholder} de una plantilla viaja literal al chat del cliente.`)
  }
  if (!reemplazaEnUnaPasada(renderer)) {
    fallas.push(`${RENDERER}: volvió al reemplazo en bucle por clave. Eso re-expande un valor que contenga otra variable ⇒ template injection.`)
  }

  // 4. El handoff es wa.me, con pestaña estable y fail-closed.
  const handoff = leer(HANDOFF)
  if (!usaWaMe(handoff)) {
    fallas.push(`${HANDOFF}: dejó de usar https://wa.me/. Ése es el handoff móvil, el que deja abrir la app nativa.`)
  }
  if (!usaWebSendEnDesktop(handoff)) {
    fallas.push(`${HANDOFF}: dejó de usar https://web.whatsapp.com/send para desktop. Sin eso vuelve la pantalla intermedia que abría pestañas nuevas.`)
  }
  for (const p of [HANDOFF, MODAL]) {
    if (usaPantallaIntermedia(leer(p))) {
      fallas.push(`${p}: apunta a api.whatsapp.com, la pantalla intermedia ("Continuar en WhatsApp Web"). Ese paso saca al usuario de la pestaña techrepair_whatsapp y estrena una nueva.`)
    }
  }
  for (const p of [HANDOFF, MODAL]) {
    if (intentaReutilizarPestana(leer(p))) {
      fallas.push(`${p}: volvió la maquinaria de reutilización de pestaña (referencia/.closed, opener=null o target con nombre). MEDIDO: web.whatsapp.com manda COOP same-origin, el WindowProxy queda severed y .closed pasa a true con la pestaña abierta. Las tres vías fallan; no hay forma de reutilizarla.`)
    }
  }
  for (const p of [HANDOFF, MODAL]) {
    if (navegaTechRepairAWhatsApp(leer(p))) {
      fallas.push(`${p}: navega la pestaña de TechRepair hacia WhatsApp. Eso saca al usuario de su trabajo y el Back devuelve a una SPA recargada. El fallback tiene que ser una pestaña NUEVA, avisada como tal.`)
    }
  }
  if (!ofreceFallbackDePestanaNueva(handoff)) {
    fallas.push(`${HANDOFF}: se perdió el fallback de WhatsApp Web en pestaña nueva, que es el único camino cuando no están ni el Companion ni la app de escritorio.`)
  }
  if (!ofreceAppDeEscritorio(handoff)) {
    fallas.push(`${HANDOFF}: se perdió el camino de la app de escritorio (whatsapp://), que es el único que no toca ninguna pestaña.`)
  }
  if (prometeReutilizarPestana(leer(MODAL))) {
    fallas.push(`${MODAL}: el copy promete reutilizar una pestaña. El navegador no lo permite; no se le puede decir eso al usuario.`)
  }
  if (!fallaCerradoSinTelefono(handoff)) {
    fallas.push(`${HANDOFF}: dejó de fallar cerrado ante un teléfono inválido. Sin eso se abre https://wa.me/?text=… , que no lleva a ningún contacto.`)
  }

  // 5. El modal usa el renderer y bloquea los huecos.
  const modal = leer(MODAL)
  if (!usaRendererCanonico(modal)) {
    fallas.push(`${MODAL}: no arma el mensaje con renderTemplate. Volver a interpolateTemplate reintroduce los placeholders desconocidos silenciosos.`)
  }
  if (!bloqueaVariableSinResolver(modal)) {
    fallas.push(`${MODAL}: dejó de bloquear la apertura cuando queda una variable sin resolver. El cliente recibiría "tenés un saldo pendiente de {saldo}".`)
  }

  // 5b. El cliente del Companion no le da poder de más a la extensión.
  const cliente = leer(CLIENTE_COMPANION)
  if (mandaCamposDeMas(cliente)) {
    fallas.push(`${CLIENTE_COMPANION}: le manda al Companion campos fuera del contrato (url/hostname/path/business_id/...). La extensión navega pestañas: si el destino viniera de acá, sería un open-redirect con permisos.`)
  }
  if (!mandaElContratoCompleto(cliente)) {
    fallas.push(`${CLIENTE_COMPANION}: el payload dejó de tener las tres claves del contrato (type/phone/text).`)
  }
  if (hardcodeaExtensionId(cliente)) {
    fallas.push(`${CLIENTE_COMPANION}: hardcodea un extension ID. El del unpacked de desarrollo no es el de producción; tiene que salir de VITE_WHATSAPP_COMPANION_EXTENSION_ID.`)
  }
  if (!fallaCerradoSinExtensionId(cliente)) {
    fallas.push(`${CLIENTE_COMPANION}: dejó de fallar cerrado sin extension ID configurado.`)
  }
  const envCompanion = leer(ENV_COMPANION)
  if (!leeLaConfiguracionDelEntorno(envCompanion)) {
    fallas.push(`${ENV_COMPANION}: dejó de leer y validar la configuración del Companion desde el entorno (ID con forma [a-p]{32} + URL de instalación).`)
  }
  if (hardcodeaExtensionId(envCompanion)) {
    fallas.push(`${ENV_COMPANION}: hardcodea un extension ID.`)
  }
  if (!exigeHttpsEnLaInstalacion(envCompanion)) {
    fallas.push(`${ENV_COMPANION}: la URL de instalación dejó de exigir https. Un javascript: o un http:// en una variable de entorno no puede terminar en un href de la app.`)
  }
  if (ensuciaLaConsola(cliente)) {
    fallas.push(`${CLIENTE_COMPANION}: ensucia la consola. Sin console.*, y hay que LEER runtime.lastError en el callback: si no se lee, Chrome imprime "Unchecked runtime.lastError" a todo usuario que no tenga la extensión.`)
  }

  // 6. RBAC y multitenant del editor.
  const editor = leer(EDITOR)
  if (!gateaConPermisoCanonico(editor)) {
    fallas.push(`${EDITOR}: no gatea la edición con can('settings_sensitive') del helper canónico usePermissions.`)
  }
  if (inventaRolesAMano(editor)) {
    fallas.push(`${EDITOR}: compara roles a mano. El permiso canónico es usePermissions().can(...), no un if de roles.`)
  }
  if (!guardaSoloConPermiso(editor)) {
    fallas.push(`${EDITOR}: el handler de guardado no corta sin permiso. Deshabilitar el botón no es fail-closed.`)
  }
  for (const p of [EDITOR, 'src/services/whatsappService.ts']) {
    if (!acotaPorNegocio(leer(p))) {
      fallas.push(`${p}: opera sobre whatsapp_templates/whatsapp_settings sin acotar por business_id.`)
    }
  }

  // 7. Ninguna migracion posterior al gate reabre la escritura a is_staff().
  const DIR_MIGRACIONES = join(RAIZ, 'supabase', 'migrations')
  if (!existsSync(join(DIR_MIGRACIONES, MIGRACION_GATE))) {
    fallas.push(`Falta supabase/migrations/${MIGRACION_GATE}: es la migracion que limita la escritura de whatsapp_templates a owner/admin.`)
  }
  for (const nombre of readdirSync(DIR_MIGRACIONES)) {
    if (!nombre.endsWith('.sql')) continue
    if (nombre <= MIGRACION_GATE) continue          // el baseline SI tiene el is_staff() viejo
    if (reabreEscrituraATodoElStaff(readFileSync(join(DIR_MIGRACIONES, nombre), 'utf-8'))) {
      fallas.push(`supabase/migrations/${nombre}: reabre la ESCRITURA de whatsapp_templates a is_staff(), que incluye a viewer. Ese es exactamente el agujero que cerro ${MIGRACION_GATE}.`)
    }
  }

  return fallas
}

// ─── Self-test ──────────────────────────────────────────────────────────────
//
// Cada comprobación se prueba en los DOS sentidos: que cace lo que dice cazar
// y que no marque lo correcto. Un guard que nunca falla no protege nada.

function selfTest() {
  const casos = []
  const chequear = (nombre, real, esperado) => casos.push({ nombre, ok: real === esperado })

  // Stripping de comentarios
  chequear('el bloque de doc no dispara el guard',
    importaTransporteOficial(sinComentarios(
      "/**\n * NO invoca whatsapp-send ni usa access_token.\n */\nimport { x } from './whatsappFormat.ts'")), false)
  chequear('el comentario de línea tampoco',
    mencionaSecretosMeta(sinComentarios("  // nunca toca access_token\nconst u = 'https://wa.me/'")), false)
  chequear('pero el CÓDIGO real sí dispara',
    mencionaSecretosMeta(sinComentarios("/** doc */\nconst t = cfg.access_token")), true)
  chequear('no truncar una URL con // dentro de un string',
    usaWaMe(sinComentarios("const u = 'https://wa.me/' + tel")), true)

  // Desacople
  chequear('caza el import de Cloud API',
    importaTransporteOficial(`import { getConnection } from './whatsappCloudService'`), true)
  chequear('caza el import de supabase',
    importaTransporteOficial(`import { supabase } from '../lib/supabase'`), true)
  chequear('caza la invocación de la edge function',
    importaTransporteOficial(`await supabase.functions.invoke('whatsapp-send', {})`), true)
  chequear('no marca un módulo puro',
    importaTransporteOficial(`import { normalizeWhatsAppPhone } from './whatsappFormat.ts'`), false)

  chequear('caza el access_token', mencionaSecretosMeta(`const t = cfg.access_token`), true)
  chequear('no marca texto normal', mencionaSecretosMeta(`const url = 'https://wa.me/549'`), false)

  // Honestidad
  chequear('caza send_result: sent', registraEnvioInexistente(`send_result: 'sent',`), true)
  chequear('caza send_result: delivered', registraEnvioInexistente(`send_result: 'delivered'`), true)
  chequear('caza send_result: read', registraEnvioInexistente(`send_result: 'read'`), true)
  chequear('acepta opened', registraEnvioInexistente(`send_result: 'opened',`), false)
  chequear('acepta copied y sent_api',
    registraEnvioInexistente(`send_result: 'copied'\nsend_result: 'sent_api'`), false)
  chequear('no marca un archivo sin send_result', registraEnvioInexistente(`const x = 1`), false)

  chequear('caza el rótulo "Enviado" sobre opened',
    rotulaAperturaComoEnviado(`opened: { label: 'Enviado', color: '#25d366' },`), true)
  chequear('acepta el rótulo "Abierto"',
    rotulaAperturaComoEnviado(`opened: { label: 'Abierto', color: '#25d366' },`), false)
  chequear('no confunde sent_api con opened',
    rotulaAperturaComoEnviado(`sent_api: { label: 'Enviado (API)', color: '#818cf8' },`), false)

  // Renderer
  chequear('reconoce la allowlist', declaraAllowlist(`export const WHATSAPP_VARIABLES = []`), true)
  chequear('caza su ausencia', declaraAllowlist(`const vars = []`), false)

  chequear('caza el reemplazo en bucle (template injection)', reemplazaEnUnaPasada(
    "for (const [key, value] of Object.entries(reps)) {\n" +
    "  result = result.replace(new RegExp('\\\\{' + key + '\\\\}', 'g'), () => value)\n" +
    "}"), false)
  chequear('acepta la pasada única con replacer',
    reemplazaEnUnaPasada(`const text = template.replace(PLACEHOLDER_RE, (m, key) => resolver(key))`), true)
  chequear('exige la forma correcta, no sólo la ausencia de la mala',
    reemplazaEnUnaPasada(`const text = template`), false)

  chequear('caza eval', evaluaDinamicamente(`return eval(tpl)`), true)
  chequear('caza new Function', evaluaDinamicamente(`const f = new Function('v', tpl)`), true)
  chequear('no marca código normal', evaluaDinamicamente(`const f = (v) => v.trim()`), false)

  // Handoff
  chequear('reconoce wa.me', usaWaMe('`https://wa.me/${tel}?text=${t}`'), true)
  chequear('caza su ausencia', usaWaMe(`'https://web.whatsapp.com/send'`), false)

  chequear('reconoce web.whatsapp.com/send',
    usaWebSendEnDesktop('`https://web.whatsapp.com/send?phone=${t}&text=${m}`'), true)
  chequear('caza su ausencia',
    usaWebSendEnDesktop('`https://wa.me/${t}?text=${m}`'), false)

  chequear('caza la pantalla intermedia',
    usaPantallaIntermedia('`https://api.whatsapp.com/send?phone=${t}`'), true)
  chequear('no marca web.whatsapp.com',
    usaPantallaIntermedia('`https://web.whatsapp.com/send?phone=${t}`'), false)
  chequear('no marca wa.me',
    usaPantallaIntermedia('`https://wa.me/${t}?text=${m}`'), false)

  // Maquinaria de reutilización — prohibida
  chequear('caza la referencia con .closed',
    intentaReutilizarPestana(`if (pestana && !pestana.closed) { pestana.location.href = url }`), true)
  chequear('caza el corte de opener',
    intentaReutilizarPestana(`win.opener = null`), true)
  chequear('caza el target con nombre estable',
    intentaReutilizarPestana(`window.open(u, 'techrepair_whatsapp')`), true)
  chequear('caza la constante del nombre',
    intentaReutilizarPestana(`const WHATSAPP_WINDOW_NAME = 'x'`), true)
  chequear('no marca el handoff determinista',
    intentaReutilizarPestana(`window.location.assign(url)`), false)

  // TechRepair no se navega a WhatsApp
  chequear('caza la navegación de la pestaña actual',
    navegaTechRepairAWhatsApp(`window.location.assign(u)`), true)
  chequear('caza el href hacia WhatsApp Web',
    navegaTechRepairAWhatsApp(`window.location.href = 'https://web.whatsapp.com/send?phone=' + t`), true)
  chequear('caza el href hacia wa.me',
    navegaTechRepairAWhatsApp(`window.location.href = 'https://wa.me/' + t`), true)
  chequear('NO marca el protocolo whatsapp:// de la app de escritorio',
    navegaTechRepairAWhatsApp(`navegar: (u) => { window.location.href = u }`), false)
  chequear('no marca la pestaña nueva',
    navegaTechRepairAWhatsApp(`const win = open(url, '_blank')`), false)

  chequear('reconoce el fallback de pestaña nueva',
    ofreceFallbackDePestanaNueva(`export function abrirWhatsAppWebEnNuevaPestana(u) {}`), true)
  chequear('caza su ausencia',
    ofreceFallbackDePestanaNueva(`export function irAWhatsAppWeb(u) {}`), false)

  // Companion — contrato del payload
  chequear('caza una url en el payload',
    mandaCamposDeMas(`const payload = { type: T, phone: p, text: m, url: destino }`), true)
  chequear('caza business_id en el payload',
    mandaCamposDeMas(`const payload = { type: T, phone: p, text: m, business_id: b }`), true)
  chequear('no marca el payload correcto',
    mandaCamposDeMas(`const payload = { type: COMPANION_TIPO_APERTURA, phone: t.normalized, text: message }`), false)

  chequear('reconoce las tres claves',
    mandaElContratoCompleto(`const payload = { type: T, phone: p, text: m }`), true)
  chequear('caza la falta de text',
    mandaElContratoCompleto(`const payload = { type: T, phone: p }`), false)
  chequear('caza la ausencia total de payload',
    mandaElContratoCompleto(`sendMessage(id, { type: 'X' })`), false)

  chequear('caza un extension ID hardcodeado',
    hardcodeaExtensionId(`const ID = 'abcdefghijklmnopabcdefghijklmnop'`), true)
  chequear('no marca un string cualquiera',
    hardcodeaExtensionId(`const t = 'OPEN_WHATSAPP_WEB'`), false)
  chequear('no marca un id con caracteres fuera de a-p',
    hardcodeaExtensionId(`const ID = 'abcdefghijklmnopabcdefghijklmnoz'`), false)

  chequear('reconoce el fail-closed sin ID', fallaCerradoSinExtensionId(
    `if (!extensionId) return { disponible: false, motivo: 'sin_configurar' }`), true)
  chequear('caza el fail-open', fallaCerradoSinExtensionId(
    `const id = extensionId || 'algo'`), false)

  chequear('reconoce la lectura validada del entorno', leeLaConfiguracionDelEntorno(`
    const RE = /^[a-p]{32}$/
    env().VITE_WHATSAPP_COMPANION_EXTENSION_ID
    env().VITE_WHATSAPP_COMPANION_INSTALL_URL`), true)
  chequear('caza que se deje de validar la forma del ID', leeLaConfiguracionDelEntorno(`
    env().VITE_WHATSAPP_COMPANION_EXTENSION_ID
    env().VITE_WHATSAPP_COMPANION_INSTALL_URL`), false)
  chequear('caza que falte la URL de instalación', leeLaConfiguracionDelEntorno(`
    const RE = /^[a-p]{32}$/
    env().VITE_WHATSAPP_COMPANION_EXTENSION_ID`), false)

  chequear('reconoce la exigencia de https',
    exigeHttpsEnLaInstalacion(`return u.protocol === 'https:' ? u.toString() : null`), true)
  chequear('caza que se acepte cualquier esquema',
    exigeHttpsEnLaInstalacion(`return u.toString()`), false)

  chequear('caza console.log', ensuciaLaConsola(`lastError; console.log('ping')`), true)
  chequear('caza console.warn', ensuciaLaConsola(`lastError; console.warn(e)`), true)
  chequear('caza NO leer lastError',
    ensuciaLaConsola(`runtime.sendMessage(id, m, (r) => resolve(r))`), true)
  chequear('la sola DECLARACIÓN del tipo no alcanza',
    ensuciaLaConsola(`interface R { lastError?: { message?: string } }\nsendMessage(id, m, (r) => resolve(r))`), true)
  chequear('acepta el callback que lo lee',
    ensuciaLaConsola(`runtime.sendMessage(id, m, (r) => { const e = runtime.lastError; resolve(e ? null : r) })`), false)

  // App de escritorio
  chequear('reconoce el camino de la app',
    ofreceAppDeEscritorio(`export function buildAppUrl(){} export function abrirAppDeEscritorio(){}`), true)
  chequear('caza su ausencia', ofreceAppDeEscritorio(`export function irAWhatsAppWeb(){}`), false)

  // Copy honesto
  chequear('caza la promesa de reutilizar',
    prometeReutilizarPestana(`“Abrir WhatsApp” reutiliza siempre la misma pestaña.`), true)
  chequear('caza "misma pestaña siempre"',
    prometeReutilizarPestana(`usa la misma pestaña siempre`), true)
  chequear('no marca el copy correcto',
    prometeReutilizarPestana(`Se abre en esta misma pestaña; con Atrás volvés a TechRepair.`), false)

  chequear('reconoce el fail-closed',
    fallaCerradoSinTelefono(`if (!telefono.valid) return { ok: false, error: e }`), true)
  chequear('caza el fail-open',
    fallaCerradoSinTelefono(`return { ok: true, url: 'https://wa.me/?text=' + t }`), false)

  // Modal
  chequear('reconoce el renderer canónico', usaRendererCanonico(`
    import { renderTemplate } from '../../services/whatsappTemplate'
    const r = renderTemplate(tpl, vals)`), true)
  chequear('caza la vuelta a interpolateTemplate', usaRendererCanonico(`
    import { interpolateTemplate } from '../../services/whatsappService'
    const msg = interpolateTemplate(tpl, vars)`), false)

  chequear('reconoce el bloqueo por variable faltante',
    bloqueaVariableSinResolver(`const bloqueo = motivoDeBloqueo(message)\nconst canSend = ok && !bloqueo`), true)
  chequear('caza su ausencia',
    bloqueaVariableSinResolver(`const canSend = phoneResult.valid && message.length > 0`), false)

  // RBAC
  chequear('reconoce el permiso canónico', gateaConPermisoCanonico(`
    import { usePermissions } from '../../hooks/usePermissions'
    const puedeEditar = can('settings_sensitive')`), true)
  chequear('caza la falta de gate', gateaConPermisoCanonico(`const { businessId } = useAuth()`), false)

  chequear('caza el if de roles a mano', inventaRolesAMano(`const ok = role === 'owner' || role === 'admin'`), true)
  chequear('caza isOwner || isAdmin', inventaRolesAMano(`const canManage = isOwner || isAdmin;`), true)
  chequear('no marca el uso canónico', inventaRolesAMano(`const puedeEditar = can('settings_sensitive')`), false)

  chequear('reconoce el corte fail-closed del handler',
    guardaSoloConPermiso(`if (!businessId || !puedeEditar) return`), true)
  chequear('caza el handler sin corte',
    guardaSoloConPermiso(`if (!businessId) return`), false)

  // Migraciones
  chequear('caza una migracion que reabre la ESCRITURA a is_staff()', reabreEscrituraATodoElStaff(`
    CREATE POLICY "whatsapp_templates_update" ON public.whatsapp_templates
      FOR UPDATE USING (business_id = public.current_business_id() AND public.is_staff())
      WITH CHECK (business_id = public.current_business_id() AND public.is_staff());`), true)
  chequear('no marca la policy correcta', reabreEscrituraATodoElStaff(`
    CREATE POLICY "whatsapp_templates_update" ON public.whatsapp_templates
      FOR UPDATE USING (business_id = public.current_business_id() AND public.is_owner_or_admin());`), false)
  chequear('no marca el SELECT, que SI debe seguir en is_staff()', reabreEscrituraATodoElStaff(`
    CREATE POLICY "whatsapp_templates_select" ON public.whatsapp_templates
      FOR SELECT USING (business_id = public.current_business_id() AND public.is_staff());`), false)
  chequear('no marca una migracion de otra tabla', reabreEscrituraATodoElStaff(`
    CREATE POLICY "otra_cosa_update" ON public.whatsapp_logs
      FOR UPDATE USING (public.is_staff());`), false)

  // Multitenant
  chequear('caza la query sin business_id',
    acotaPorNegocio(`supabase.from('whatsapp_templates').select('*')`), false)
  chequear('reconoce el acotado',
    acotaPorNegocio(`supabase.from('whatsapp_templates').select('*').eq('business_id', businessId)`), true)
  chequear('reconoce el acotado en el insert',
    acotaPorNegocio(`supabase.from('whatsapp_templates').upsert({ business_id: businessId })`), true)
  chequear('no marca un archivo que no toca esas tablas',
    acotaPorNegocio(`supabase.from('orders').select('*')`), true)

  for (const c of casos) console.log(`  ${c.ok ? '✓' : '✗'} ${c.nombre}`)
  const fallidos = casos.filter(c => !c.ok)
  if (fallidos.length) {
    console.error(`\n✗ Self-test FALLIDO: ${fallidos.length}/${casos.length} comprobaciones no se comportan como dicen.`)
    process.exit(1)
  }
  console.log(`\n✓ Self-test OK: ${casos.length} comprobaciones verificadas en ambos sentidos.`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  console.log('\n─── guard:whatsapp-w1 · self-test ──────────────────────────────────')
  selfTest()
} else {
  const fallas = validarRepo()
  if (fallas.length) {
    console.error('\n' + '═'.repeat(74))
    console.error('  GUARD FALLIDO — WhatsApp estándar (W1) se salió del contrato')
    console.error('═'.repeat(74))
    for (const f of fallas) console.error(`  ✗ ${f}`)
    console.error('═'.repeat(74) + '\n')
    process.exit(1)
  }
  console.log('✓ guard:whatsapp-w1 — handoff wa.me honesto, desacoplado y con allowlist.')
}
