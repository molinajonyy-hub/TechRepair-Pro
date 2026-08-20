// ============================================================================
// TechRepair WhatsApp Companion — service worker (Manifest V3)
//
// ÚNICA responsabilidad: administrar UNA pestaña de WhatsApp Web.
//
// POR QUÉ EXISTE
// `web.whatsapp.com` manda `Cross-Origin-Opener-Policy: same-origin`. Medido en
// Chromium real: al navegar un popup hacia allá, el `WindowProxy` que conserva
// el opener queda severed y `closed` pasa a `true` con la pestaña abierta, así
// que desde una página normal es IMPOSIBLE reutilizar esa pestaña — ni por
// referencia, ni por `window.name`, ni conservando el opener. La PWA tampoco
// sirve: `launch_handler: focus-existing` enfoca la instancia existente pero su
// único consumer de `launchQueue` parsea CALL LINKS, así que el deep link
// `/send?phone=&text=` se descarta.
//
// Acá el problema desaparece porque la navegación la ejecuta Chrome vía Tabs
// API. COOP no participa: no hay ningún WindowProxy cross-origin de por medio.
//
// LO QUE ESTE CÓDIGO NO HACE, Y NO DEBE HACER NUNCA
//   · no inyecta content scripts ni JavaScript en WhatsApp;
//   · no lee el DOM, los chats, los contactos ni el QR;
//   · no toca cookies, storage ni historial;
//   · no automatiza el botón Enviar — eso lo sigue haciendo la persona;
//   · no habla con la Cloud API de Meta ni maneja tokens.
// Sólo encuentra/crea/enfoca una pestaña y la navega a una URL que construye
// él mismo.
// ============================================================================

/**
 * Origins que pueden hablarle. Duplica `externally_connectable` a propósito.
 *
 * `http://localhost:4599` es SÓLO para el harness del POC: puerto fijo y
 * esquema fijo, lo más angosto que se puede. Sacarlo antes de cualquier
 * distribución.
 */
const ORIGENES_AUTORIZADOS = new Set([
  'https://techrepairpro.app',
  'https://www.techrepairpro.app',
  'http://localhost:4599',
]);

const WHATSAPP_PATRON = 'https://web.whatsapp.com/*';
const WHATSAPP_ORIGEN = 'https://web.whatsapp.com';

/** Límite defensivo del cuerpo del mensaje. WhatsApp no acepta mucho más. */
const MAX_TEXTO = 4096;

/**
 * El teléfono llega YA normalizado por TechRepair (`normalizeWhatsAppPhone`).
 * Acá sólo se comprueba la forma: dígitos, largo E.164 plausible. Cualquier
 * `+`, `:`, `/`, espacio o esquema queda afuera por construcción.
 */
const TELEFONO_VALIDO = /^[0-9]{8,15}$/;

const error = (code, detalle) => ({ ok: false, code, ...(detalle ? { detalle } : {}) });

/**
 * Construye la URL destino INTERNAMENTE.
 *
 * El host y el path nunca vienen del llamador: si vinieran, TechRepair (o
 * cualquier cosa que lograra hablarle) podría convertir a la extensión en un
 * open-redirect hacia `javascript:`, `data:`, `file:` u otro host.
 */
function construirUrl(phone, text) {
  return `${WHATSAPP_ORIGEN}/send?phone=${phone}&text=${encodeURIComponent(text)}`;
}

/**
 * Elige DETERMINÍSTICAMENTE qué pestaña de WhatsApp reutilizar.
 *
 * Orden, documentado y estable:
 *   1. la pestaña activa de WhatsApp, si hay alguna activa;
 *   2. la usada más recientemente (`lastAccessed`, Chrome 121+);
 *   3. fallback estable por (windowId, index) — nunca aleatorio.
 *
 * Nunca cierra las demás: si el usuario tiene varias abiertas, son suyas.
 */
function elegirPestana(tabs) {
  if (tabs.length === 0) return null;
  if (tabs.length === 1) return tabs[0];

  const activa = tabs.find((t) => t.active);
  if (activa) return activa;

  const conMarca = tabs.filter((t) => typeof t.lastAccessed === 'number');
  if (conMarca.length > 0) {
    return conMarca.reduce((a, b) => (b.lastAccessed > a.lastAccessed ? b : a));
  }

  return [...tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index)[0];
}

/** Encuentra y reutiliza, o crea. Devuelve qué hizo, sin filtrar nada más. */
async function abrirEnWhatsApp(url) {
  const tabs = await chrome.tabs.query({ url: WHATSAPP_PATRON });
  const elegida = elegirPestana(tabs);

  if (elegida) {
    const tab = await chrome.tabs.update(elegida.id, { url, active: true });
    // Traer al frente la ventana que la contiene, no sólo la pestaña.
    try { await chrome.windows.update(elegida.windowId, { focused: true }); } catch { /* ventana ya cerrada */ }
    return { ok: true, action: 'reused', tabId: tab.id, encontradas: tabs.length };
  }

  const tab = await chrome.tabs.create({ url, active: true });
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* noop */ }
  return { ok: true, action: 'created', tabId: tab.id, encontradas: 0 };
}

/**
 * Segunda barrera de origen.
 *
 * `externally_connectable` ya filtra en el manifest, pero se vuelve a validar
 * en runtime: es la diferencia entre una lista que alguien puede aflojar por
 * descuido al editar el manifest y una negativa explícita en el código.
 */
function remitenteAutorizado(sender) {
  const origen = sender && sender.origin
    ? sender.origin
    : (sender && sender.url ? (() => { try { return new URL(sender.url).origin; } catch { return null; } })() : null);
  return origen !== null && ORIGENES_AUTORIZADOS.has(origen);
}

function validarPayload(msg) {
  if (!msg || typeof msg !== 'object') return error('BAD_PAYLOAD');
  if (msg.type !== 'OPEN_WHATSAPP_WEB') return error('UNKNOWN_TYPE');
  if (typeof msg.phone !== 'string' || !TELEFONO_VALIDO.test(msg.phone)) return error('BAD_PHONE');
  if (typeof msg.text !== 'string' || msg.text.length === 0) return error('BAD_TEXT');
  if (msg.text.length > MAX_TEXTO) return error('TEXT_TOO_LONG');
  return null;
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!remitenteAutorizado(sender)) {
    sendResponse(error('FORBIDDEN_ORIGIN'));
    return false;
  }

  const invalido = validarPayload(msg);
  if (invalido) {
    sendResponse(invalido);
    return false;
  }

  // `msg.url` y cualquier otro campo se IGNORAN a propósito: el destino lo
  // arma la extensión, nunca el llamador.
  abrirEnWhatsApp(construirUrl(msg.phone, msg.text))
    .then(sendResponse)
    .catch((e) => sendResponse(error('TAB_ERROR', String(e && e.message ? e.message : e))));

  return true; // respuesta asíncrona
});
