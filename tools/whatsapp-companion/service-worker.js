// ============================================================================
// TechRepair WhatsApp Companion — service worker (Manifest V3)
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
// React, no un router. Conseguir un cambio sin recarga exigiría internals de
// WhatsApp — explícitamente fuera de alcance por frágil.
//
// LO QUE ESTE CÓDIGO NO HACE, Y NO DEBE HACER NUNCA
//   · no inyecta content scripts ni JavaScript en WhatsApp;
//   · no lee el DOM, los chats, los contactos ni el QR;
//   · no toca cookies, storage ni historial;
//   · no automatiza el botón Enviar — eso lo sigue haciendo la persona;
//   · no habla con la Cloud API de Meta ni maneja tokens.
// ============================================================================
import {
  VERSION,
  WHATSAPP_PATRON,
  error,
  origenAutorizado,
  validarApertura,
  construirUrl,
  elegirPestana,
} from './lib/contract.js';

/** Encuentra y reutiliza, o crea. No filtra nada del contenido de WhatsApp. */
async function abrirEnWhatsApp(url) {
  const tabs = await chrome.tabs.query({ url: WHATSAPP_PATRON });
  const elegida = elegirPestana(tabs);

  if (elegida) {
    const tab = await chrome.tabs.update(elegida.id, { url, active: true });
    // Traer al frente la ventana que la contiene, no sólo la pestaña.
    try { await chrome.windows.update(elegida.windowId, { focused: true }); } catch { /* ventana cerrada */ }
    return { ok: true, action: 'reused', tabId: tab.id, encontradas: tabs.length };
  }

  const tab = await chrome.tabs.create({ url, active: true });
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* noop */ }
  return { ok: true, action: 'created', tabId: tab.id, encontradas: 0 };
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!origenAutorizado(sender)) {
    sendResponse(error('FORBIDDEN_ORIGIN'));
    return false;
  }

  // PING — así TechRepair descubre si el Companion está instalado. No es una
  // heurística de "app instalada": es hablarle a una extensión conocida por ID.
  if (msg && msg.type === 'PING') {
    sendResponse({ ok: true, version: VERSION });
    return false;
  }

  const invalido = validarApertura(msg);
  if (invalido) {
    sendResponse(invalido);
    return false;
  }

  // `msg.url` y cualquier otro campo se IGNORAN: el destino lo arma la
  // extensión, nunca el llamador.
  abrirEnWhatsApp(construirUrl(msg.phone, msg.text))
    .then(sendResponse)
    .catch((e) => sendResponse(error('TAB_ERROR', String(e && e.message ? e.message : e))));

  return true; // respuesta asíncrona
});
