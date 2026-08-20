// ============================================================================
// Contrato del Companion — lógica PURA.
//
// Vive aparte del service worker para poder testearla sin `chrome.*`: el probe
// en Chromium real cubre el comportamiento, y esto cubre las reglas. Un guard
// sin tests es una ilusión de guard, y una validación de seguridad sin tests
// unitarios también.
// ============================================================================

export const VERSION = '1.0.0';

/** Único destino posible. Nunca viene del llamador. */
export const WHATSAPP_ORIGEN = 'https://web.whatsapp.com';
export const WHATSAPP_PATRON = 'https://web.whatsapp.com/*';

/** Límite defensivo del cuerpo. WhatsApp no acepta mucho más. */
export const MAX_TEXTO = 4096;

/**
 * Origins que pueden hablarle.
 *
 * Duplica `externally_connectable` a propósito: el manifest ya filtra (Chrome
 * ni siquiera inyecta `chrome.runtime` fuera de esa lista), pero esto cubre que
 * alguien afloje el manifest sin mirar el código.
 */
export const ORIGENES_AUTORIZADOS = Object.freeze([
  'https://techrepairpro.app',
  'https://www.techrepairpro.app',
]);

/**
 * El teléfono llega YA normalizado por TechRepair (`normalizeWhatsAppPhone`).
 * Acá sólo se valida la forma. Por construcción quedan afuera `+`, `:`, `/`,
 * espacios y cualquier esquema, así que no hay forma de colar una URL.
 */
const TELEFONO_VALIDO = /^[0-9]{8,15}$/;

/**
 * Códigos de error del contrato.
 *
 * `HOST_ACCESS_REQUIRED` es distinto de todos los demás y de "no instalada":
 * la extensión ESTÁ, pero Chrome le retiró el acceso a web.whatsapp.com (el
 * usuario o una política puso el acceso al sitio en «Al hacer clic»). Sin ese
 * acceso, `tabs.query({url})` NO tira error: devuelve CERO pestañas —medido—,
 * así que la extensión crearía una pestaña nueva cada vez, en silencio, que es
 * exactamente lo que existe para evitar. Por eso se detecta y se dice.
 */
export const CODIGOS = Object.freeze({
  FORBIDDEN_ORIGIN: 'FORBIDDEN_ORIGIN',
  BAD_PAYLOAD: 'BAD_PAYLOAD',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  BAD_PHONE: 'BAD_PHONE',
  BAD_TEXT: 'BAD_TEXT',
  TEXT_TOO_LONG: 'TEXT_TOO_LONG',
  HOST_ACCESS_REQUIRED: 'HOST_ACCESS_REQUIRED',
  TAB_ERROR: 'TAB_ERROR',
});

/**
 * Respuesta de error. SÓLO el código.
 *
 * No se adjunta el detalle del error de Chrome: esos mensajes pueden incluir la
 * URL completa —o sea el teléfono y el mensaje— y devolvérselos a la página es
 * un canal de eco que nadie necesita. El llamador sólo usa el código.
 */
export const error = (code) => ({ ok: false, code });

/**
 * Respuesta de apertura exitosa. MÍNIMA a propósito.
 *
 * No lleva `tabId` ni la cantidad de pestañas encontradas. TechRepair no
 * necesita saber cuántas pestañas de WhatsApp Web tiene abiertas la persona, y
 * emitir ese dato hacia una página web es estado del navegador saliendo de la
 * extensión sin ninguna razón. Lo único que el llamador usa es si se reutilizó
 * una pestaña o se creó una.
 */
export const respuestaApertura = (action) => ({ ok: true, action });

/** True sólo para un origin de la allowlist. Fail-closed ante cualquier cosa rara. */
export function origenAutorizado(sender) {
  if (!sender || typeof sender !== 'object') return false;
  let origen = typeof sender.origin === 'string' ? sender.origin : null;
  if (!origen && typeof sender.url === 'string') {
    try { origen = new URL(sender.url).origin; } catch { return false; }
  }
  return origen !== null && ORIGENES_AUTORIZADOS.includes(origen);
}

/**
 * Valida el payload. Devuelve `null` si está bien, o el error a responder.
 *
 * Cualquier campo extra (`url`, `hostname`, `scheme`, `path`…) se IGNORA: el
 * destino no se negocia con el llamador.
 */
export function validarApertura(msg) {
  if (!msg || typeof msg !== 'object') return error(CODIGOS.BAD_PAYLOAD);
  if (msg.type !== 'OPEN_WHATSAPP_WEB') return error(CODIGOS.UNKNOWN_TYPE);
  if (typeof msg.phone !== 'string' || !TELEFONO_VALIDO.test(msg.phone)) return error(CODIGOS.BAD_PHONE);
  if (typeof msg.text !== 'string' || msg.text.length === 0) return error(CODIGOS.BAD_TEXT);
  if (msg.text.length > MAX_TEXTO) return error(CODIGOS.TEXT_TOO_LONG);
  return null;
}

/**
 * Construye la URL destino INTERNAMENTE, con un solo `encodeURIComponent`.
 * Host y path son constantes de este módulo.
 */
export function construirUrl(phone, text) {
  return `${WHATSAPP_ORIGEN}/send?phone=${phone}&text=${encodeURIComponent(text)}`;
}

/**
 * Elige DETERMINÍSTICAMENTE qué pestaña reutilizar.
 *
 *   1. la pestaña ACTIVA de WhatsApp, si hay alguna;
 *   2. si no, la de `lastAccessed` más reciente (Chrome 121+);
 *   3. fallback estable por `(windowId, index)`.
 *
 * Nunca aleatorio. Nunca cierra las demás: si el usuario tiene varias, son suyas.
 *
 * Sólo lee propiedades no sensibles: `active`, `lastAccessed`, `windowId` e
 * `index`. Chrome también entrega `url`, `title` y `favIconUrl` de las pestañas
 * que matchean el host permission —está medido—, pero acá no se leen.
 */
export function elegirPestana(tabs) {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  if (tabs.length === 1) return tabs[0];

  const activa = tabs.find((t) => t && t.active);
  if (activa) return activa;

  const conMarca = tabs.filter((t) => t && typeof t.lastAccessed === 'number');
  if (conMarca.length > 0) {
    return conMarca.reduce((a, b) => (b.lastAccessed > a.lastAccessed ? b : a));
  }

  return [...tabs].sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index))[0];
}
