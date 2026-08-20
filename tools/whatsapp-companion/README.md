# TechRepair WhatsApp Companion — POC

Extensión Chrome (Manifest V3) que administra **una sola** pestaña de WhatsApp Web.

> **POC. No integrado a TechRepair.** Nada de `src/` lo usa todavía.

---

## Por qué existe

Reutilizar una pestaña de WhatsApp Web **desde una página normal es imposible**, y está medido:

- `web.whatsapp.com` responde `Cross-Origin-Opener-Policy: same-origin`. Al navegar un popup hacia allá, el `WindowProxy` del opener queda *severed* y `ref.closed` pasa a `true` **con la pestaña abierta**. Fallan las tres vías: referencia con opener anulado, con opener conservado, y target por nombre.
- La **PWA tampoco**: su manifest declara `launch_handler.client_mode = "focus-existing"`, pero el único `launchQueue.setConsumer` de su bundle parsea **call links** (`parseCallLink`); `parseSendLink` y `"/send"` no aparecen. Medido: `PWA.launch(url=/send…)` contra una instancia abierta devuelve el **mismo target** pero la ventana **no cambia de URL** — el destinatario nuevo se descarta. Confirmado además por el owner en su Chrome real.

Acá el problema desaparece porque **la navegación la ejecuta Chrome vía Tabs API**: no hay ningún `WindowProxy` cross-origin de por medio, así que COOP no participa.

## Lo que hace — y lo que NO

Encuentra, crea, enfoca y navega **una** pestaña. Nada más.

**Deliberadamente NO puede:**

- inyectar content scripts ni JavaScript en WhatsApp;
- leer el DOM, los chats, los contactos, el QR ni los mensajes;
- tocar cookies, storage o historial;
- automatizar el botón **Enviar** — eso lo sigue haciendo la persona;
- hablar con la Cloud API de Meta ni manejar tokens;
- navegar a ningún host que no sea `web.whatsapp.com`.

No declara `content_scripts`, ni popup, ni options page, ni código remoto.

## Permisos — y por qué son los mínimos

```json
"host_permissions": ["https://web.whatsapp.com/*"]
```

**Sin `"tabs"`.** Verificado en Chromium real: con sólo ese host permission funcionan `tabs.query({url})`, `tabs.update`, `tabs.create` y `windows.update`. Agregar `"tabs"` daría acceso a URL/título de **todas** las pestañas, que no hace falta.

No pide `<all_urls>`, `cookies`, `history`, `webRequest`, `scripting`, `nativeMessaging`, `downloads` ni clipboard.

## Contrato de mensaje

```js
chrome.runtime.sendMessage(EXTENSION_ID, {
  type: 'OPEN_WHATSAPP_WEB',
  phone: '5493511234567',   // sólo dígitos, ya normalizado por TechRepair
  text:  'mensaje resuelto'
}, respuesta => { /* { ok, action: 'reused'|'created', tabId } */ })
```

**El llamador no aporta la URL.** La extensión arma internamente
`https://web.whatsapp.com/send?phone=<phone>&text=<encodeURIComponent(text)>`.
Host y path nunca vienen del payload — si vinieran, esto sería un open-redirect.

Validaciones: `type` exacto · `phone` contra `/^[0-9]{8,15}$/` (deja afuera `+`, `:`, `/`, espacios y cualquier esquema) · `text` string no vacío, máx. 4096 · cualquier campo extra (`url`, etc.) se **ignora**.

Errores: `FORBIDDEN_ORIGIN` · `BAD_PAYLOAD` · `UNKNOWN_TYPE` · `BAD_PHONE` · `BAD_TEXT` · `TEXT_TOO_LONG` · `TAB_ERROR`. La respuesta nunca incluye contenido de WhatsApp.

## Origins autorizados

Doble barrera:

1. `externally_connectable.matches` en el manifest — sin wildcards amplios;
2. revalidación de `sender.origin` en el service worker.

La 1 ya es fuerte: Chrome **sólo expone** `chrome.runtime.sendMessage` a las páginas que matchean, así que desde otro origin la API ni existe. La 2 cubre que alguien afloje el manifest sin tocar el código.

Hoy:

- `https://techrepairpro.app/*` y `https://www.techrepairpro.app/*` — producción (futuro).
- `http://localhost:4599/*` — **sólo para el harness del POC**. Puerto y esquema fijos,
  lo más angosto posible. **Sacarlo antes de cualquier distribución.**

## Elección de pestaña (determinista)

1. la pestaña **activa** de WhatsApp, si hay alguna;
2. si no, la de `lastAccessed` más reciente (Chrome 121+);
3. fallback estable por `(windowId, index)`.

Nunca aleatorio, y **nunca cierra** las demás: si tenés varias abiertas, son tuyas.

---

## Probarlo en tu Chrome

```bash
npx serve tools/whatsapp-companion/harness -l 4599
```

1. `chrome://extensions` → activá **Modo de desarrollador**.
2. **Cargar descomprimida** → elegí la carpeta `tools/whatsapp-companion/`.
3. Copiá el **ID** que muestra la tarjeta de la extensión.
4. Abrí `http://localhost:4599/` y pegá el ID en el campo (queda guardado).
5. Abrí WhatsApp Web a mano en otra pestaña y probá Cliente A / B / C.

El puerto **4599 no es decorativo**: es el único de localhost autorizado en
`externally_connectable`. Si servís en otro puerto, `chrome.runtime` no existe en esa
página y el harness no puede hablarle a la extensión.

**Qué tiene que pasar:** siempre **una sola** pestaña de WhatsApp, el **mismo `tabId`**, cambiando de destinatario, y TechRepair intacto. Si cerrás la pestaña, el próximo handoff responde `action: "created"` y crea exactamente una.

### Prueba automatizada

```bash
node tools/whatsapp-companion/probe.mjs
```

Carga la extensión en un Chromium con perfil temporal y corre los casos 0–3 más los negativos de seguridad. Resultado actual: **todos los chequeos pasan**, y confirma que `host_permissions` solo alcanza.

---

## Distribución

**No** distribuir un `.crx` improvisado. Si esto avanza: proyecto/PR aparte, revisión de seguridad, Chrome Web Store con ID estable y documentación de instalación. No se mete dentro del frontend de W1.
