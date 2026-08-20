# TechRepair WhatsApp Companion

Extensión Chrome (Manifest V3) que administra **una sola** pestaña de WhatsApp Web.

Versión `1.0.0` — lista para revisión y publicación. La integración con el frontend
de TechRepair va en un PR aparte; hoy nada de `src/` la usa.

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

### Límite conocido de v1: cambiar de cliente recarga WhatsApp

`tabs.update` hace una navegación top-level, así que WhatsApp Web recrea su
documento en cada cambio de destinatario. **No hay alternativa dentro del alcance**,
y también está medido: su bundle no registra **ningún** listener de `popstate`
(0 ocurrencias en 59 MB) y su uso de la Navigation API es instrumentación de React,
no un router. Un cambio sin recarga exigiría internals de WhatsApp — descartado por
frágil. La ganancia real es la que se buscaba: **una sola pestaña**, no cero recargas.

## Permisos — y por qué son los mínimos

```json
"host_permissions": ["https://web.whatsapp.com/*"]
```

**Sin `"tabs"`.** Verificado en Chromium real: con sólo ese host permission funcionan `tabs.query({url})`, `tabs.update`, `tabs.create` y `windows.update`. Agregar `"tabs"` daría acceso a URL/título de **todas** las pestañas, que no hace falta.

No pide `<all_urls>`, `cookies`, `history`, `webRequest`, `scripting`, `nativeMessaging`, `downloads` ni clipboard.

## Contrato de mensaje

### Descubrimiento

```js
chrome.runtime.sendMessage(EXTENSION_ID, { type: 'PING' },
  r => { /* { ok: true, version: '1.0.0' } */ })
```

Sirve para que TechRepair sepa si el Companion está instalado **sin heurísticas**:
le habla a una extensión conocida por ID. Si no está, `chrome.runtime.lastError`
queda seteado y la respuesta es `undefined`. El PING **no abre ninguna pestaña**.

### Apertura

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
2. revalidación de `sender.origin` en el service worker (`lib/contract.js`).

La 1 ya es fuerte: Chrome **sólo expone** `chrome.runtime.sendMessage` a las páginas que matchean, así que desde otro origin la API ni existe. La 2 cubre que alguien afloje el manifest sin tocar el código.

La lista es **exactamente** ésta, en las dos capas:

- `https://techrepairpro.app/*`
- `https://www.techrepairpro.app/*`

**No hay ningún origin de desarrollo**, y no puede volver a haberlo por descuido:
`scripts/guards/whatsapp-companion-release.mjs` falla el build si aparece
`localhost`, `127.0.0.1`, `*://*`, `<all_urls>` o un esquema `http:` en cualquiera
de las dos capas. Para probar en local se sirve el harness **desde el origin de
producción** (ver abajo), no se afloja el manifest.

## Elección de pestaña (determinista)

1. la pestaña **activa** de WhatsApp, si hay alguna;
2. si no, la de `lastAccessed` más reciente (Chrome 121+);
3. fallback estable por `(windowId, index)`.

Nunca aleatorio, y **nunca cierra** las demás: si tenés varias abiertas, son tuyas.

---

## Verificación

```bash
npm run test:unit -- --test-name-pattern="Companion"
```

Reglas puras (origen, payload, URL, elección de pestaña) en
`tests/unit/whatsappCompanion.test.ts`.

```bash
npm run guard:whatsapp-companion
```

Guard de release: permisos, wildcards, origins de dev, `content_scripts`,
`web_accessible_resources` y que el destino se construya internamente. Tiene
`--self-test` bidireccional (falla si dejara de detectar lo que promete).

```bash
npm run companion:probe
```

Chromium real, perfil temporal, extensión unpacked: PING, casos 0–3 y los
negativos de seguridad. El harness se sirve **desde el origin de producción**
interceptando la red — así se prueba la lista real, no una aflojada.

### Prueba manual en tu Chrome

1. `chrome://extensions` → activá **Modo de desarrollador**.
2. **Cargar descomprimida** → elegí la carpeta `tools/whatsapp-companion/`.
3. Copiá el **ID** que muestra la tarjeta.
4. Entrá a `https://www.techrepairpro.app` (un origin autorizado) y probá desde ahí.

**Qué tiene que pasar:** siempre **una sola** pestaña de WhatsApp, el **mismo `tabId`**, cambiando de destinatario, y TechRepair intacto. Si cerrás la pestaña, el próximo handoff responde `action: "created"` y crea exactamente una.

---

## Publicación en Chrome Web Store

**No** distribuir un `.crx` improvisado. El ID de la extensión tiene que ser
**estable**, porque el frontend lo usa para hablarle.

### Antes de subir

- [ ] `npm run guard:whatsapp-companion` en verde (sin origins de dev, sin permisos de más).
- [ ] `npm run test:unit` y `npm run companion:probe` en verde.
- [ ] `manifest.json` → `version` incrementada respecto de la publicada.
- [ ] Revisión de seguridad de un segundo par de ojos sobre `lib/contract.js` y `service-worker.js`.

### Empaquetado

Se sube **sólo** el contenido de `tools/whatsapp-companion/`:
`manifest.json`, `service-worker.js`, `lib/contract.js`, íconos.
El `probe.mjs`, los spikes y el `harness/` **no** van en el paquete (son de desarrollo).

### Clave e ID

La **clave privada** (`.pem`) que fija el ID **no se sube al repo**. La guarda el
owner en el gestor de secretos. Con la extensión ya publicada, el ID lo asigna el
Store y no cambia mientras se mantenga la misma cuenta y el mismo ítem.

### Después de publicar

- [ ] Anotar el ID publicado.
- [ ] Cargarlo en `VITE_WHATSAPP_COMPANION_EXTENSION_ID` (Vercel: Production y Preview).
- [ ] Publicar la URL de instalación en `VITE_WHATSAPP_COMPANION_INSTALL_URL`.
- [ ] Verificar el PING desde producción antes de anunciar la función.

### Ficha del Store

La justificación de permisos es corta y verdadera: `host_permissions` sobre
`https://web.whatsapp.com/*` para **encontrar y navegar** la pestaña de WhatsApp
Web del propio usuario. Sin `tabs`, sin content scripts, sin lectura de contenido,
sin código remoto.
