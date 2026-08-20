// ============================================================================
// TechRepair Companion — service worker (Manifest V3)
//
// ÚNICA responsabilidad: administrar UNA pestaña de WhatsApp Web.
//
// POR QUÉ EXISTE — las dos vías web están descartadas CON MEDICIÓN:
//   · `web.whatsapp.com` manda `Cross-Origin-Opener-Policy: same-origin`. Al
//     navegar un popup hacia allá el `WindowProxy` del opener queda severed y
//     `closed` pasa a `true` con la pestaña abierta. Fallan las tres vías:
//     referencia con opener anulado, con opener conservado, y target por nombre.
//   · La PWA tampoco: `launch_handler: focus-existing` enfoca la instancia
//     existente, pero el único `launchQueue.setConsumer` de su bundle parsea
//     CALL LINKS; el deep link `/send?phone=&text=` se descarta.
//
// Acá el problema desaparece porque la navegación la ejecuta Chrome vía Tabs
// API: no hay `WindowProxy` cross-origin, así que COOP no participa.
//
// LÍMITE ACEPTADO EN v1: `tabs.update` hace una navegación top-level, así que
// WhatsApp Web recrea su documento en cada cambio de cliente. Se midió que no
// hay alternativa: su bundle no registra ningún listener de `popstate` (0
// ocurrencias en 59 MB) y su uso de la Navigation API es instrumentación de
// React, no un router. Y como es una navegación real, se pierde lo que hubiera
// en esa pestaña: un borrador a medio escribir, o una pantalla de QR.
//
// LO QUE ESTE CÓDIGO NO HACE, Y NO DEBE HACER NUNCA
//   · no inyecta content scripts ni JavaScript en WhatsApp;
//   · no lee el DOM, los chats, los contactos ni el QR;
//   · no usa las APIs de cookies, storage ni history, y no las declara;
//   · no automatiza el botón Enviar — eso lo sigue haciendo la persona;
//   · no habla con la Cloud API de Meta ni maneja tokens.
//
// LO QUE SÍ PASA, Y HAY QUE DECIRLO: abrir el chat es una navegación normal
// hacia `web.whatsapp.com/send?phone=…&text=…`, y esa URL lleva el teléfono y
// el texto. Como cualquier navegación, Chrome la asienta en el historial del
// perfil y en la restauración de sesión, y la sincroniza con la cuenta de
// Google si el usuario tiene la sincronización de historial activada. La
// extensión no lee ni borra el historial —no pide ese permiso— pero lo escribe
// por el sólo hecho de navegar. Está declarado en el README y en la política de
// privacidad; no se oculta, y no se pide el permiso `history` para taparlo.
// ============================================================================
import {
  VERSION,
  WHATSAPP_PATRON,
  CODIGOS,
  error,
  respuestaApertura,
  origenAutorizado,
  validarApertura,
  construirUrl,
  elegirPestana,
} from './lib/contract.js';

/**
 * ¿Chrome le está dando acceso a web.whatsapp.com ahora mismo?
 *
 * El host permission está en el manifest, pero el usuario —o una política de
 * empresa— puede poner el acceso al sitio en «Al hacer clic», y entonces no lo
 * tiene. MEDIDO: en ese estado `tabs.query({url})` NO tira error, devuelve CERO
 * pestañas. Sin este chequeo la extensión crearía una pestaña nueva en cada
 * mensaje, en silencio y respondiendo `ok: true` — el peor modo de falla
 * posible, porque es exactamente el problema que vino a resolver.
 *
 * `chrome.permissions` está disponible sin declarar nada (verificado).
 */
async function tieneAccesoAWhatsApp() {
  try {
    return await chrome.permissions.contains({ origins: [WHATSAPP_PATRON] });
  } catch {
    // Fail-closed: si no se puede saber, se asume que no hay acceso y se
    // devuelve una instrucción accionable en vez de crear pestañas a ciegas.
    return false;
  }
}

/** Encuentra y reutiliza, o crea. No filtra nada del contenido de WhatsApp. */
async function abrirEnWhatsApp(url) {
  const tabs = await chrome.tabs.query({ url: WHATSAPP_PATRON });
  const elegida = elegirPestana(tabs);

  if (elegida) {
    await chrome.tabs.update(elegida.id, { url, active: true });
    // Traer al frente la ventana que la contiene, no sólo la pestaña.
    try { await chrome.windows.update(elegida.windowId, { focused: true }); } catch { /* ventana cerrada */ }
    return respuestaApertura('reused');
  }

  const tab = await chrome.tabs.create({ url, active: true });
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* noop */ }
  return respuestaApertura('created');
}

// El listener se registra en el nivel superior y de forma SÍNCRONA: el grafo de
// módulos es estático (un solo import, sin `await` de nivel superior), así que
// queda instalado en el primer turno de evaluación. Eso es lo que permite que
// Chrome despierte al worker y le entregue el mensaje sin perderlo.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!origenAutorizado(sender)) {
    sendResponse(error(CODIGOS.FORBIDDEN_ORIGIN));
    return false;
  }

  // PING — así TechRepair descubre si el Companion está instalado. No es una
  // heurística de "app instalada": es hablarle a una extensión conocida por ID.
  // Informa además si Chrome le está dando acceso al sitio, para que la app
  // pueda distinguir «no instalada» de «instalada pero sin acceso».
  if (msg && msg.type === 'PING') {
    void tieneAccesoAWhatsApp().then((hostAccess) => {
      sendResponse({ ok: true, version: VERSION, hostAccess });
    });
    return true; // respuesta asíncrona
  }

  const invalido = validarApertura(msg);
  if (invalido) {
    sendResponse(invalido);
    return false;
  }

  // `msg.url` y cualquier otro campo se IGNORAN: el destino lo arma la
  // extensión, nunca el llamador.
  void (async () => {
    try {
      if (!(await tieneAccesoAWhatsApp())) {
        sendResponse(error(CODIGOS.HOST_ACCESS_REQUIRED));
        return;
      }
      sendResponse(await abrirEnWhatsApp(construirUrl(msg.phone, msg.text)));
    } catch {
      // Sin detalle: el texto crudo del error de Chrome puede contener la URL
      // completa, o sea el teléfono y el mensaje.
      sendResponse(error(CODIGOS.TAB_ERROR));
    }
  })();

  return true; // respuesta asíncrona
});
