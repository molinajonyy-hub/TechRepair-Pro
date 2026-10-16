# BETA-UX-3 — Administración más simple + Centro de ayuda

Rama `claude/blissful-rubin-9vn7nw` (base `main` `cc11184`). Sin migraciones, sin Edge Functions, sin cambios
de Mercado Pago, de facturación ARCA ni de lógica financiera. Ninguna pantalla se borró ni cambió de ruta.

## 1. Discovery — lo que había

### 1.1 Menú lateral · sección Administración

| Entrada | Ruta | Gate del menú | Guard de la ruta | `SubscriptionGuard` |
|---|---|---|---|---|
| Usuarios | `/users` | `users` | `ProtectedRouteByPermission users` | **bloquea** con el negocio suspendido |
| Configuración | `/settings` | `settings` | `settings` | exime |
| Moneda | `/currency-settings` | `settings` | `settings` | **bloquea** |
| Suscripción | `/subscription` (+ `/plans`, `/pending`, `/success`, `/failure`) | `subscription` | `subscription` | exime (`/subscription/suspended` sin guard de capacidad) |
| Tutoriales | `/tutorials` | ninguno | ninguno | **bloquea** |
| Ayuda | `/ayuda` | ninguno (BETA-1) | ninguno | exime (BETA-1) |

El drawer «Más» del celular sale de la misma lista (`menuSections` de `Sidebar.tsx`), y el filtro es el contrato
único `isNavigationItemAuthorized` (`useNavigationAccess.ts`), que también usan la barra inferior y la paleta.

Capacidades por rol (defaults de `config/permissions.ts`): `settings` y `users` sólo owner y admin;
`subscription` sólo owner. Los overrides por persona pueden dar cualquiera de las tres sin las otras.

### 1.2 Pantallas y consumidores

- **Configuración** (`Settings.tsx`): la navegación agrupada de BETA-UX-2 (`SettingsNav`), diez secciones en
  `?tab=`, escrita dentro de la página.
- **Usuarios** (`UsersManagement.tsx`), **Moneda** (`CurrencySettings.tsx`) y **Mi Suscripción**
  (`Subscription.tsx`): páginas completas con su propio encabezado `.page-hdr` (h1).
- **Ayuda** (`Ayuda.tsx`): un botón al canal de soporte (`SupportContactButton` → `canalSoporte()` de
  `config/contacto.ts`, WhatsApp; sin canal, un aviso). Enlazada desde el muro de fin de prueba, Mi Suscripción,
  Pago pendiente y el error global.
- **Tutoriales** (`Tutorials.tsx`): una lista con un tutorial (ARCA) y el contenido de la guía, elegido por estado
  local (sin URL propia).
- Enlaces dentro de la app a estas rutas: `SubscriptionBanner`, `useFeatureErrorHandler`, `PaymentPending`,
  `SubscriptionSuccess` → `/subscription`; `FirstStepsChecklist` → `/settings`; `insightsService` →
  `/currency-settings`; el muro y Mi Suscripción → `/ayuda`. **Decenas de tests** (componentes y E2E) entran por
  `/users`, `/subscription` y `/currency-settings` directo.

### 1.3 Lo que decidió el diseño

Mudar Usuarios, Moneda y Suscripción a `/settings?tab=` habría cambiado **quién entra**: `SubscriptionGuard`
exime `/settings` pero no `/users` ni `/currency-settings`, así que con el negocio suspendido se habría abierto la
gestión de usuarios y de moneda. Por eso las tres pantallas **se quedan en su ruta y con su guard** y lo que cambia
es dónde se dibujan: dentro del marco de Configuración. Los enlaces viejos no necesitan redirección.

## 2. Qué se cambió

**Menú lateral.** Administración queda en dos entradas:

- **Configuración** → `/settings`. Visible con CUALQUIERA de las capacidades de sus secciones
  (`anyPermission: SETTINGS_PERMISSIONS` = `settings`, `users`, `subscription`; nuevo gate del contrato de
  navegación, AND con los demás, lista vacía = no). Queda marcada (`aria-current="page"`, clase `active`, peso
  600) en `/settings`, `/users`, `/currency-settings`, `/subscription` y sus subrutas.
- **Centro de ayuda** → `/ayuda`. Sin gates (como «Ayuda» en BETA-1).

**Configuración** (`SettingsNav` + `SettingsShell` nuevo). La navegación de BETA-UX-2, ahora con seis grupos y
cada sección con la capacidad que exige su destino:

| Grupo | Sección | Destino | Capacidad |
|---|---|---|---|
| Negocio | Datos del negocio · Preferencias · **Moneda y cotización** · Seguridad | `?tab=` · `?tab=` · **`/currency-settings`** · `?tab=` | `settings` |
| **Equipo** | **Usuarios y permisos** | **`/users`** | `users` |
| Facturación | Puntos de venta · Integración ARCA | `?tab=` | `settings` |
| Cobros | Cobros y pagos · Comisiones y mayorista | `?tab=` | `settings` |
| Documentos y mensajes | Orden impresa · Comprobantes · WhatsApp | `?tab=` | `settings` |
| **TechRepair Pro** | **Plan y suscripción** | **`/subscription`** | `subscription` |

- La lista sólo muestra lo que el actor puede abrir y no deja grupos vacíos. El grupo de la suscripción se llama
  como el producto: es el plan de TechRepair Pro, no la facturación del negocio (ARCA está en «Facturación»).
- `SettingsShell` es el marco (encabezado «Configuración», lista, región de la sección, «‹ Secciones» en el
  celular). Lo usan `Settings.tsx` y las tres pantallas, como elemento de ruta **debajo** de su guard
  (`SettingsPageRoute`): un rebote no llega a pintar el marco. Planes y los retornos de Mercado Pago quedan fuera.
- `/settings` pasa a admitir cualquiera de las tres capacidades (`ProtectedRouteByPermission` acepta una lista:
  entra con al menos una; lista vacía no entra nadie). Sin `settings`, Settings **no lee ni dibuja** nada del
  negocio —ni con `?tab=arca`—: queda la lista con lo que el actor sí puede abrir y, en escritorio, «Elegí una
  sección…». Owner y admin (los únicos con `settings` por defecto) no notan diferencia.
- En el marco, el encabezado de cada pantalla es el de la sección: `h1` → `h2` (el `h1` es «Configuración») y
  una escala menor sólo dentro de `.settings-content`. El resto de la pantalla no se tocó.
- Filas de la lista de escritorio de 40 → 36 px para que las trece secciones entren en 1440×900 con la última
  elegida (en el celular siguen de 52 px).
- Foco: al elegir una sección en el celular, el foco va a la sección (como en BETA-UX-2); en escritorio, pasar
  de `/settings` a una pantalla con ruta propia (o al revés) vuelve a montar el marco, y el foco del teclado va a
  la sección elegida de la lista en vez de caer al `<body>`. Entrar por URL no mueve el foco.
- La tabla de Usuarios se rehízo en la ronda 2 (ver §8): ya no depende de un scroll horizontal.
- Mi Suscripción entre 1200 y 1439 px se comporta dentro del marco como en anchos intermedios (las acciones bajan
  en vez de apretar el texto).

**Centro de ayuda** (`Ayuda.tsx`, `/ayuda`). Una pantalla con `AppPageHeader` y dos accesos:

- **Soporte** — «Consultas y problemas técnicos» y el **mismo** `SupportContactButton` (mismo canal, mismo texto,
  mismo aviso sin canal). No es un sistema de tickets.
- **Tutoriales** — el catálogo de `config/tutorials.ts` (sólo metadatos: tipo, título, descripción, duración,
  nivel). Una guía se abre en `/ayuda/tutoriales/<id>` con «‹ Centro de ayuda»; un video (`kind: 'video'`, `url`)
  se abre en otra pestaña. Sumar contenido es sumar una entrada al catálogo (y, si es guía, su componente en
  `TUTORIAL_GUIDES`). El contenido de la guía de ARCA no cambió.
- ≥1024 px: Soporte y Tutoriales lado a lado; por debajo, apilados con Soporte arriba. Filas de 56 px con foco
  visible.
- `/tutorials` redirige a `/ayuda#tutoriales` (y la página baja a esa sección). `/ayuda/tutoriales/*` hereda la
  excepción de `SubscriptionGuard` por prefijo.

## 3. Compatibilidad — enlaces históricos

| Enlace | Antes | Después |
|---|---|---|
| `/users` | Usuarios (página) | Usuarios, dentro de Configuración · mismo guard |
| `/currency-settings` | Moneda (página) | Moneda, dentro de Configuración · mismo guard |
| `/subscription` | Mi Suscripción (página) | Mi Suscripción, dentro de Configuración · mismo guard |
| `/subscription/plans`, `/pending`, `/success`, `/failure`, `/suspended` | flujo de pago | sin cambios |
| `/settings`, `/settings?tab=…` | Configuración | igual (diez claves de `?tab=` intactas) |
| `/tutorials` | Tutoriales | → `/ayuda#tutoriales` |
| `/ayuda` | Ayuda | Centro de ayuda |

## 4. Decisiones que conviene revisar

1. **Las pantallas no se mudaron a `?tab=`** (ver §1.3). Si más adelante se quiere una sola familia de URLs, hay
   que decidir antes qué pasa con Usuarios y Moneda con el negocio suspendido.
2. **`/settings` para quien no tiene `settings`.** Antes rebotaba; ahora muestra la lista (sin datos del negocio)
   si el actor tiene `users` o `subscription`. Es lo que hace falta para que el celular tenga una lista a la que
   volver con «‹ Secciones».
3. **Tutoriales con el negocio suspendido.** `/tutorials` no estaba exento de `SubscriptionGuard`; al vivir en
   `/ayuda` ahora se puede leer la guía de ARCA con el negocio suspendido. Es contenido estático; se dejó así a
   propósito porque el Centro de ayuda es la salida del muro.
4. **Títulos de la barra superior del celular**: `/users` sigue diciendo «Usuarios» (y `/currency-settings`,
   «Moneda»), igual que antes; `/ayuda` dice «Centro de ayuda».
5. **«Moneda y cotización»** en vez de «Moneda»: la sección es la moneda por defecto y la fuente del dólar; con el
   nombre corto nadie encontraba el dólar.

## 5. Tests

- `tests/components/betaUx3AdminHelp.test.tsx` (nuevo, 70): menú por rol y por override, marca de «Configuración»
  en cada ruta, lista filtrada por capacidad, guards con URL a mano, `/settings` sin `settings` sin lecturas,
  guard con lista (fail-closed), rutas viejas dentro del marco y con su guard (contra `App.tsx`), `/tutorials`,
  Centro de ayuda (canal, catálogo, guía, id inexistente, todos los roles), móvil (drawer, lista → sección con
  foco → volver; en escritorio el foco sigue en la sección elegida), contrato de CSS y que el marco no se vuelve
  a montar al terminar de cargar. Los dos últimos se comprobaron rompiendo el arreglo: fallan sin él.
- Actualizados al contrato nuevo, sin perder lo que fijaban: `beta1Ayuda` (la entrada se llama «Centro de ayuda»;
  el CTA único se mide dentro de Soporte), `betaUx2Consistency` (seis grupos; las diez claves de `?tab=` iguales),
  `rbacCapabilities` (el bloque del guard de suscripción se delimita contando anidamiento).
- E2E `tests/e2e/m7/beta-ux-3-admin-help.spec.ts` (job `e2e-local`): navegación de punta a punta, enlaces viejos,
  contraste AA y foco del Centro de ayuda en claro y oscuro, lista entera en 1440×900, celular 390/320 (drawer,
  44 px, foco, desborde) y **dos empleados reales**: técnico con su rol (sólo Centro de ayuda; URLs a mano
  rebotan) y técnico con el override `users` (sólo «Usuarios y permisos»; `?tab=arca` no abre nada).
  `beta-ux-2-consistency.spec.ts`: seis grupos, trece secciones.
- CI: paso «BETA-UX-3 — simpler admin navigation + help center» (`npm run test:beta-ux-3`).

## 6. Evidencia

Láminas «antes · main | después · BETA-UX-3» (sesión falsa + backend simulado; nada sale de la máquina):

- `evidence/01-menu-administracion.png` — dueño, administrador y técnico
- `evidence/02-configuracion-escritorio.png` — Usuarios, Suscripción y Moneda dentro del marco
- `evidence/03-configuracion-lista-y-roles.png` — lista completa, administrador sin suscripción, 1280 px
- `evidence/04-centro-de-ayuda.png` — `/ayuda`, `/tutorials`, tema oscuro
- `evidence/05-celular.png` — «Más», lista, Usuarios, Centro de ayuda
- `evidence/report-before-main.txt`, `evidence/report-after.txt` — qué ofrecía Administración en cada captura

Reproducir:

```bash
node docs/beta-ux-3/evidence/capture.mjs . <salida> after          # sobre la rama; «before» sobre main
node docs/beta-ux-3/evidence/contact-sheet.mjs . <dirAntes> <dirDespues> <salida>
node node_modules/@playwright/test/cli.js test --config docs/beta-ux-3/evidence/e2e-mock/playwright.config.ts
```

El último corre los specs reales de este lote y el de BETA-UX-2 contra el Supabase simulado de BETA-UX-2, sin los
empleados reales (`@beta-ux-3-actores`, sólo con la base real). `CHROMIUM_PATH` (opcional) apunta a un Chromium ya
instalado en las tres herramientas.

## 7. Pendiente / fuera de alcance

- Los encabezados de Usuarios, Moneda y Mi Suscripción siguen escritos a mano (`.page-hdr`); migrarlos a
  `AppPageHeader` con un nivel de título configurable es refactor sin cambio visual.
- Videos: el catálogo los admite; todavía no hay ninguno publicado.
- Sistema de tickets / inbox de soporte: fuera de este lote (pedido explícito).

## 8. Ronda 2 — Usuarios entre 1024 y 1280 px + CI

Pedido de revisión: entre 1024 y 1280 px las acciones de la tabla de Usuarios no pueden quedar detrás de un scroll
horizontal; editar usuarios y administrar permisos tiene que ser intuitivo y accesible por teclado; mismos permisos,
funcionalidades y rutas.

### 8.1 Lo que había

- Dentro de Configuración la tabla mide **428 px a 1024** de ancho de ventana, 556 a 1152 y 684 a 1280. Con cinco
  columnas (Usuario, Email, Rol, Estado, Acciones) a 1024 ni el rol entraba entero; Estado y Acciones quedaban
  detrás del scroll (lámina 06, «antes»).
- Acciones de la fila: dos íconos sueltos (escudo = permisos, con un punto ámbar si eran personalizados; usuario
  tachado = desactivar) con `title` como único nombre. El selector de rol no tenía nombre accesible.
- Editor de permisos: un overlay armado a mano, sin `role="dialog"`. El foco quedaba en la fila de atrás, Escape no
  cerraba y Tab salía del diálogo. Las casillas eran `<div onClick>`: **con el teclado no se podía tildar nada**.

### 8.2 Qué cambió (sólo `UsersManagement.tsx` y CSS acotado a `.users-table` / `.perm-toggle`)

- **Columnas**: Usuario (nombre + email debajo) · Rol · Estado · Acciones.
- **Acciones**: «Permisos» es un botón con texto (la tarea principal de la fila), nombre accesible «Editar permisos
  de <nombre>» y «(personalizados)» cuando corresponde; el `title` «Editar permisos» se conserva. Activar/Desactivar
  pasa al menú de la fila (`OverflowMenu`, el mismo de Clientes y Órdenes, sin modificarlo): lo destructivo en un
  menú deliberado, con la misma confirmación de antes.
- **Responsive por el ancho de la tabla** (container query, no por la ventana): con ≥640 px, tabla; con menos, cada
  fila es una ficha de dos renglones (identidad + estado · rol + acciones) con objetivos de 44 px; con menos de 330
  px (celular de 320), rol y acciones en renglones separados. Resultado: 1024 y 1152 → fichas; 1280 y 1440 → tabla.
  Sin container queries (navegadores viejos) vuelve el scroll de antes. Los roles ARIA (`table`, `row`, `cell`,
  `columnheader`) están en el marcado, así la semántica de tabla no depende del `display`.
- **Teclado**: Tab recorre rol → Permisos → menú, con foco visible. Enter en «Permisos» abre el editor, que ahora es
  `AppModal` (el diálogo compartido): foco adentro, Tab que no se escapa, Escape cierra sin guardar y el foco vuelve
  al botón. Las casillas son checkboxes nativos (ocultos a la vista, con el foco pintado en el cuadro): Space
  tilda; un permiso automático (Mayorista para admin) es un checkbox tildado y deshabilitado. Enter en el menú lo
  abre con el foco en su acción; Escape lo cierra y devuelve el foco.
- **Sin cambios**: quién gestiona usuarios (owner/admin), filas protegidas («Protegido», «Tu usuario»), cambiar el
  rol desde la fila, activar/desactivar con confirmación, el diff de permisos que se guarda, invitaciones, rutas y
  guards. En celular el editor es una hoja inferior y «Guardar permisos» ocupa su renglón.

### 8.3 CI de la ronda 1 (run 38917968505)

392 E2E en verde y 8 rojos, todos en `dashboard-day-one.spec.ts` (el chip del dólar no aparecía); `main` estaba
verde con ese spec. Causa: el spec nuevo abre `/currency-settings`, y Moneda, en un negocio sin fila en
`business_settings`, crea los ajustes por defecto con `auto_update_rate: false`; desde ahí la cotización sólo se lee
de la base (vacía en el negocio E2E) y el chip no se dibuja en los specs que corren después. Arreglo sólo en el test
(`e7260b3`): el spec responde esa escritura en el navegador con la fila que devolvería el servidor y deja el
negocio como estaba. Moneda y `dashboard-day-one` no cambiaron.

### 8.4 Tests y evidencia

- `tests/components/betaUx3UsersTable.test.tsx` (nuevo, 17): columnas y roles ARIA, nombres accesibles, menú por
  estado (activo → «Desactivar usuario» con confirmación; inactivo → «Activar usuario»), cambio de rol, permisos
  personalizados, orden de Tab, Enter/Escape con retorno de foco en diálogo y menú, Space en la matriz con el diff
  guardado, permiso automático deshabilitado, filas protegidas, actor con `users` sin ser owner/admin (sin acciones,
  como antes) y el contrato de CSS. La trampa de foco con Tab necesita layout: la mide el E2E.
- E2E `@beta-ux-3 Usuarios · acciones a la vista y por teclado (1024–1280)`, a 1024, 1152 y 1280 px: rol, Permisos
  y menú dentro de la tabla y de la ventana, sin scroll (ni en la tabla ni en la página), objetivos de 44 px en
  ficha; Tab → Permisos (foco visible) → Enter → diálogo con el foco adentro → Space tilda la primera casilla → 40
  Tab sin salir → Escape cierra sin guardar y el foco vuelve → Tab → menú → Enter → foco en «Desactivar usuario» →
  Escape. Y 1440: tabla de cuatro columnas. Usa un integrante sintético agregado a la respuesta de
  `business_users_view` en el navegador: no escribe en la base.
- `prebeta3a2WholesaleAccess`: el editor se ubica por su rol de diálogo (antes, por la clase `.modal-card`).
- Láminas: `evidence/06-usuarios-1024-1280.png` (1024 · 1152 · 1280 · 1440, antes y después) y
  `evidence/07-usuarios-acciones.png` (menú, editor de permisos, oscuro, celular). Reproducir con
  `capture.mjs … usuarios-1024,usuarios-1152,…` y `contact-sheet.mjs <root> <antes> <después> <salida> usuarios`.

### 8.5 Pendiente

- Los colores de los badges de rol y de estado de la tabla siguen siendo los de antes (en claro, «Activo» tiene
  poco contraste). Son estilos compartidos del sistema; ajustarlos es otro lote.
- La trampa de foco de `AppModal` usa `offsetParent`: en jsdom no recorre con Tab (en el navegador sí). No se tocó
  el componente compartido.
