# TechRepair Companion

Extensión Chrome (Manifest V3) que administra **una sola** pestaña de WhatsApp Web.

Versión `1.0.0`. Todavía **no publicada** en el Chrome Web Store.

> **No está afiliada a WhatsApp ni a Meta Platforms, Inc.** Es un complemento de
> TechRepair Pro que abre WhatsApp Web; el envío lo sigue haciendo la persona.

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
- usar las APIs de cookies, storage ni history — no las declara, y su código no
  usa `chrome.storage`, `localStorage`, `sessionStorage`, `IndexedDB` ni `CacheStorage`
  (hay un guard que lo verifica sobre el código, porque el manifest no puede probarlo);
- hacer una sola petición de red — no hay `fetch`, `XHR`, `WebSocket` ni código remoto;
- automatizar el botón **Enviar** — eso lo sigue haciendo la persona;
- hablar con la Cloud API de Meta ni manejar tokens;
- navegar a ningún host que no sea `web.whatsapp.com`.

No declara `content_scripts`, ni popup, ni options page, ni código remoto.

### Lo que SÍ pasa, y hay que decirlo: el historial

Abrir el chat es una navegación normal hacia
`https://web.whatsapp.com/send?phone=…&text=…`, y **esa URL lleva el teléfono y
el texto del mensaje**. Como cualquier navegación, Chrome la asienta en el
historial del perfil y en la restauración de sesión, y la sincroniza con la
cuenta de Google si el usuario tiene activada la sincronización de historial.

La extensión **no lee ni borra** el historial —no pide el permiso `history`—
pero lo **escribe** por el sólo hecho de navegar. Buscar `web.whatsapp.com/send`
en `chrome://history` lista cada contacto con su mensaje.

Decir «no toca el historial» sería falso, así que no se dice: está declarado acá,
en el encabezado del service worker, en la ficha del Store y en la política de
privacidad. No se pide el permiso `history` para taparlo.

### Límite conocido de v1: cambiar de cliente recarga WhatsApp

`tabs.update` hace una navegación top-level, así que WhatsApp Web recrea su
documento en cada cambio de destinatario, y **se pierde lo que hubiera en esa
pestaña**: un borrador a medio escribir, o una pantalla de QR sin escanear.

**No hay alternativa dentro del alcance**, y también está medido: el bundle de
WhatsApp no registra **ningún** listener de `popstate` (0 ocurrencias en 59 MB) y
su uso de la Navigation API es instrumentación de React, no un router. Un cambio
sin recarga exigiría internals de WhatsApp — descartado por frágil. La ganancia
real es la que se buscaba: **una sola pestaña**, no cero recargas.

## Permisos — y por qué son los mínimos

```json
"host_permissions": ["https://web.whatsapp.com/*"]
```

**Sin `"tabs"`.** La diferencia está medida: con sólo el host permission, Chrome
entrega `url` y `title` **únicamente** de las pestañas de `web.whatsapp.com`; de
cualquier otra pestaña devuelve `url: null` y `title: null`. Con `"tabs"` se
vería la URL y el título de **todas**.

Aun dentro de ese alcance el código **no ejerce** la lectura: para elegir la
pestaña sólo mira `active`, `lastAccessed`, `windowId` e `index`.

`tabs.update`, `tabs.create` y `windows.update` no requieren permiso en MV3.

No pide `<all_urls>`, `cookies`, `history`, `webRequest`, `declarativeNetRequest`,
`scripting`, `storage`, `activeTab`, `nativeMessaging`, `downloads` ni clipboard.

## Contrato de mensaje

### Descubrimiento

```js
chrome.runtime.sendMessage(EXTENSION_ID, { type: 'PING' },
  r => { /* { ok: true, version: '1.0.0', hostAccess: true } */ })
```

Sirve para que TechRepair sepa si el Companion está instalado **sin heurísticas**:
le habla a una extensión conocida por ID. Si no está, `chrome.runtime.lastError`
queda seteado y la respuesta es `undefined` — medido: eso resuelve en ~1 ms, no
esperando un timeout. El PING **no abre ninguna pestaña**.

`hostAccess` dice si Chrome le está dando acceso a `web.whatsapp.com` **ahora**.

### Apertura

```js
chrome.runtime.sendMessage(EXTENSION_ID, {
  type: 'OPEN_WHATSAPP_WEB',
  phone: '5493511234567',   // sólo dígitos, ya normalizado por TechRepair
  text:  'mensaje resuelto'
}, r => { /* { ok: true, action: 'reused' | 'created' } */ })
```

**La respuesta es exactamente `{ ok, action }`.** No lleva `tabId` ni cuántas
pestañas de WhatsApp se encontraron: TechRepair no necesita saber el estado del
navegador de la persona, y emitirlo hacia una página web sería una superficie de
datos sin consumidor.

**El llamador no aporta la URL.** La extensión arma internamente
`https://web.whatsapp.com/send?phone=<phone>&text=<encodeURIComponent(text)>`.
Host y path nunca vienen del payload — si vinieran, esto sería un open-redirect.

Validaciones: `type` exacto · `phone` contra `/^[0-9]{8,15}$/` (deja afuera `+`, `:`, `/`, espacios y cualquier esquema) · `text` string no vacío, máx. 4096 · cualquier campo extra (`url`, etc.) se **ignora**.

### Errores

`FORBIDDEN_ORIGIN` · `BAD_PAYLOAD` · `UNKNOWN_TYPE` · `BAD_PHONE` · `BAD_TEXT` ·
`TEXT_TOO_LONG` · `HOST_ACCESS_REQUIRED` · `TAB_ERROR`

La respuesta de error lleva **sólo el código**: los mensajes crudos de la Tabs
API pueden incluir la URL completa —o sea el teléfono y el texto— y devolvérselos
a la página es un canal de eco que nadie necesita.

### `HOST_ACCESS_REQUIRED` — el caso que no se podía expresar

Chrome permite dejar el acceso al sitio de una extensión en **«Al hacer clic»**.
En ese estado la extensión está instalada pero no tiene acceso a
`web.whatsapp.com`, y **`tabs.query({url})` NO tira error: devuelve cero pestañas**
(medido). Sin detectarlo, la extensión crearía una pestaña nueva en cada mensaje,
en silencio y respondiendo `ok: true` — exactamente el problema que vino a
resolver.

Por eso consulta `chrome.permissions.contains({ origins: [...] })` —disponible
sin declarar nada— y responde con este código en vez de abrir a ciegas. El
frontend puede así distinguir tres estados: **ausente**, **lista**, e
**instalada pero sin acceso**, que necesitan mensajes distintos.

## Cómo lo usa TechRepair

Del lado del frontend hay exactamente dos módulos:

- `src/config/whatsappCompanionEnv.ts` — **único** lugar que lee las variables
  de entorno, y las valida (ID con forma `[a-p]{32}`, URL de instalación sólo
  `https`). Fail-closed: si algo no pasa, es como si el Companion no estuviera.
- `src/services/whatsappCompanion.ts` — **único** que le habla. Manda el `PING`
  para descubrirlo y el `OPEN_WHATSAPP_WEB` para abrir el chat.

En el preview de WhatsApp: si el Companion responde, hay **un solo botón**
("Abrir WhatsApp"); si no, aparecen los fallbacks (instalar / WhatsApp Desktop /
copiar / WhatsApp Web en pestaña nueva, avisada como tal). En **móvil** no se
consulta ni se ofrece: ahí `wa.me` se lo entrega el sistema a la app nativa.

El registro es siempre `opened` — handoff iniciado. Nunca `sent`/`delivered`/
`read`: TechRepair no tiene evidencia de eso y no la va a inventar.

## Origins autorizados

Doble barrera:

1. `externally_connectable.matches` en el manifest — sin wildcards amplios;
2. revalidación de `sender.origin` en el service worker (`lib/contract.js`).

La 1 ya es fuerte: Chrome **sólo expone** `chrome.runtime.sendMessage` a las páginas que matchean, así que desde otro origin la API ni existe. La 2 cubre que alguien afloje el manifest sin tocar el código.

La lista es **exactamente** ésta, en las dos capas:

- `https://techrepairpro.app/*`
- `https://www.techrepairpro.app/*`

Son el mismo producto: el apex redirige a `www`, y figuran los dos para que
funcione se haya entrado por cualquiera. No se declara la subclave `ids`, así que
**ninguna otra extensión** puede conectarse.

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
La extensión no garantiza que haya una sola pestaña — elige una entre las que haya.

---

## Verificación

```bash
npm run companion:package
```

Camino **canónico** de empaquetado. Arma `dist/companion/techrepair-companion-<ver>.zip`
con lista blanca de archivos, entradas POSIX y `manifest.json` en la raíz, y
después **valida el artefacto**: sin backslashes, sin archivos de desarrollo, y
con todo lo que el manifest referencia realmente adentro. Tiene `--self-test`.

```bash
npm run companion:probe:packaged
```

**La prueba que importa antes de publicar.** Extrae ese ZIP y carga *eso* en un
Chromium real. Probar el fuente no alcanza: el bug del backslash en
`lib\contract.js` produjo un ZIP que **instala sin error y queda inerte**, porque
el import ESM del service worker no resuelve. Ese modo de falla es silencioso.

Cubre descubrimiento, adopción de una pestaña abierta a mano, A → B → C sobre la
misma pestaña, recreación si se cierra, la forma mínima de la respuesta, los
negativos de seguridad, y el caso **sin acceso al host**.

```bash
npm run companion:probe          # lo mismo, contra la carpeta fuente
npm run guard:whatsapp-companion # permisos, origins, íconos, almacenamiento
npm run companion:iconos         # regenera los PNG desde src/assets/logo.svg
npm run test:unit                # reglas puras del contrato
```

### Prueba manual en tu Chrome

1. `chrome://extensions` → activá **Modo de desarrollador**.
2. **Cargar descomprimida** → elegí `tools/whatsapp-companion/`.
3. Copiá el **ID** que muestra la tarjeta.
4. Entrá a `https://www.techrepairpro.app` (un origin autorizado) y probá desde ahí.

**Qué tiene que pasar:** siempre **una sola** pestaña de WhatsApp cambiando de
destinatario, y TechRepair intacto. Si cerrás la pestaña, el próximo handoff
responde `action: "created"` y crea exactamente una.

> **Ojo:** el ID de una extensión desempaquetada deriva de la ruta de la carpeta,
> así que **no es** el del Store. Ver «Identidad» abajo.

---

## Íconos

Se derivan del logo **canónico** de TechRepair Pro, `src/assets/logo.svg` — el
mismo que usa el Sidebar de la app. No se usa iconografía de WhatsApp ni de Meta:
la extensión no está afiliada a ellos y el ícono no puede insinuar lo contrario.

```bash
npm run companion:iconos
```

Produce `icons/icon{16,32,48,128}.png` —los que declara el manifest— y
`icons/store-icon-128.png`, con el arte dentro de 96×96 y 16 px de padding
transparente, que es lo que pide la **ficha** del Store. Ese último **no va en el
ZIP**: se sube por el dashboard.

---

## Publicación en Chrome Web Store

### Identidad: el ID y el orden que hay que respetar

El frontend le habla a la extensión **por ID**, así que el ID tiene que ser
estable y conocido antes de que un revisor pruebe nada.

El ID **se asigna al crear el ítem**, no al aprobarlo. El orden correcto es:

1. crear el ítem en el Developer Dashboard y subir el ZIP **como borrador**;
2. anotar el Extension ID que asigna el Store;
3. cargarlo en `VITE_WHATSAPP_COMPANION_EXTENSION_ID` (Vercel, Production);
4. desplegar el frontend que le habla;
5. **recién entonces** enviar a revisión.

Al revés no funciona: la extensión no tiene interfaz propia y sólo responde a
`techrepairpro.app`, así que un revisor que la instale sin ese frontend
desplegado no ve absolutamente nada.

Opcional y recomendado: copiar la clave pública del ítem al manifest como
`"key": "<base64>"`. Con eso el ID de la carga desempaquetada pasa a ser el del
Store y el camino de producción se puede probar **antes** de publicar — hoy es
intesteable por construcción.

La **clave privada** (`.pem`) no se sube al repo. La guarda el owner.

### Antes de subir

- [ ] `npm run guards` en verde (incluye el guard del Companion y el self-test del empaquetado).
- [ ] `npm run test:unit` en verde.
- [ ] `npm run companion:package` y `npm run companion:probe:packaged` en verde.
- [ ] `manifest.json` → `version` incrementada respecto de la publicada.
- [ ] Política de privacidad publicada y accesible **sin login**.
- [ ] Ícono de la ficha (128×128) y al menos una captura de 1280×800, **con datos ficticios**.
- [ ] Revisión de seguridad de un segundo par de ojos sobre `lib/contract.js` y `service-worker.js`.

### Qué se sube

Sólo lo que arma `companion:package`: `manifest.json`, `service-worker.js`,
`lib/contract.js` y los cuatro íconos. Este README, el probe y los spikes **no**
van en el paquete — y no es una promesa en prosa: la lista es blanca y el script
falla si aparece cualquier otra cosa.

### Ficha

Nombre **TechRepair Companion**: marca propia adelante, sin la marca de Meta en
el título. La descripción puede mencionar «para usar con WhatsApp Web» de forma
descriptiva, pero no puede afirmar que esté desarrollada, aprobada o afiliada por
WhatsApp o Meta.

El idioma de la ficha hay que **setearlo a mano** en español: el contenido está
en español y la política del Store exige que coincida con el idioma declarado.

Justificación de `host_permissions`: encontrar y navegar la pestaña de WhatsApp
Web de la propia persona, sin el permiso `tabs`, sin content scripts y sin leer
contenido. Remote code: **no**.
