# BETA-UX-1G — Autenticación, registro e invitaciones

Cierra **P1-9**, **P1-10** y **P1-12** del discovery BETA-UX-1 (`beta-ux-1-discovery.md`, §C) y el
pendiente que dejó BETA-UX-1E («el CTA de Auth queda para BETA-UX-1G»).

Base: `main` `a0b1e63fb7539cca809fbce1c77da89c8b980e81` (merge de #176; ya incluye BETA-UX-1A…1F,
BUTTON-SYSTEM-1A #177, PRE-BETA-2D #155 y PRE-BETA-2F #156 — verificado antes de empezar).

Sólo frontend. **Sin migraciones, sin cambios en Edge Functions, sin `db push`, sin deploy, sin tocar
producción ni datos reales.** No cambia ninguna RPC, política, plantilla de correo ni configuración
de Supabase Auth. No toca Mercado Pago, caja, inventario ni lógica financiera.

---

## 1. Problema

El embudo de acceso estaba partido en dos. Las tres pantallas posteriores al login
(`/verificar-email`, `/no-business`, `/onboarding`) usan desde PRE-BETA-3A-1a un shell compartido
(`AuthFlowShell`): una tarjeta, `AppButton`, `.form-control`, tokens. Las cuatro **previas** no:

| Pantalla | Cómo estaba hecha |
|---|---|
| `/login` | `authCardStyles` (`S.*`): campos, botón primario con gradiente y resplandor, pestañas con gradiente y botón de Google, todo inline; foco y hover pintados desde JavaScript; colores fijos (`#334155`, `#f87171`, `#818cf8`); emoji como ícono de las alertas |
| `/reset-password` | la misma tarjeta `S.*` + un tercer juego de estilos locales |
| `/auth/callback` | fondo y tarjeta oscuros fijos (`#060d1a`), sin tema, sin marca, «✕» como ícono |
| `/accept-invite` | `.surface-raised` + `btn btn-primary btn-lift`, otro fondo, sin marca |

Cuatro pantallas, cuatro sistemas. Y, además de lo visual, varios recorridos tenían defectos
reales. Todo lo de abajo está **medido sobre `main`** con el mismo guion que después se corre sobre
la rama (`evidence-1g/verify-auth.mjs`, reporte en `evidence-1g/verify-main.txt`): 41 comprobaciones
se cumplían, 47 no.

### 1.1 Defectos medidos en `main`

**Áreas táctiles (390×844)** — 8 de 14 controles por debajo de 44 px:

| Control | `main` | Rama |
|---|---|---|
| mostrar contraseña | 17×17 | 44×48 |
| «¿Olvidaste tu contraseña?» | 163×20,8 | 300×44 |
| «Volver al inicio» | 112×20,8 | 134×44 |
| pestañas de modo | 135×42,4 | 143×44 |
| invitación · acción principal / volver | 292×39 · 115×32,7 | 300×48 · 300×44 |

**Contraste pintado** — 19 de 42 medidas no cumplían AA (dos de ellas no se pudieron tomar):

| Texto | `main` (claro / oscuro) | Rama (claro / oscuro) |
|---|---|---|
| bajada de la marca | 2,54 / 2,53 | 4,72 / 5,94 |
| botón primario (blanco sobre gradiente) | 4,30 / 4,30 | 6,29 / 6,29 |
| modo elegido | 4,27 / 4,27 | 6,29 / 6,29 |
| «¿Olvidaste tu contraseña?» | 2,00 / 2,99 | 4,71 / 5,96 |
| pie legal | 2,55 / 2,56 | 4,73 / 5,96 |
| alerta de error | 2,54 / 5,83 | 16,16 / 14,66 |
| `/auth/callback` · título | 2,77 / 6,42 | 17,82 / 16,12 |
| `/auth/callback` · detalle | 10,35 / 3,73 | 4,75 / 5,96 |
| invitación · etiqueta del campo | 2,56 / 2,29 | 4,75 / 5,96 |

**Teclado y lectores de pantalla**

- El selector de modo eran dos paradas de Tab sueltas, sin semántica ni flechas.
- Ningún campo del login tenía `aria-invalid` ni el mensaje asociado; el foco no iba al campo que
  fallaba. El «ojo» no exponía su estado.
- `/auth/callback`: `h1=0`, `main=0`. `/accept-invite`: un campo sin etiqueta. La alerta del login
  llevaba un emoji como ícono.

**Flujos** — 10 de 11 no se cumplían:

| # | Recorrido | `main` | Rama |
|---|---|---|---|
| F1 | Ingreso con una invitación pendiente (confirmó el correo en otro dispositivo) | `/login → /dashboard → /no-business` | `/login → /accept-invite → /dashboard` |
| F2 | Ingreso con contraseña con un destino guardado por la pestaña | lo ignora y lo deja guardado | lo respeta y lo consume |
| F3 | `/auth/callback` con error (Google cancelado) | 3 s y salta solo a un login que no explica nada | queda en pantalla con «Volver a iniciar sesión» |
| F4 | `/auth/callback` sin sesión | vuelve al login en silencio | el login lo explica (`?motivo=`) |
| F5 | Aceptar una invitación falla por un motivo que no es del enlace | pide pegar un «token»; sin reintento | «Reintentar» con el mismo enlace |
| F6 | «La invitación es para otro correo» | única salida: «Volver al inicio» | dice con qué cuenta se entró + «Usar otra cuenta» (el enlace viaja) |
| F7 | El reenvío de confirmación falla desde el login | el botón vuelve a su estado y no dice nada | lo dice y ofrece ayuda |
| F8 | Alta | sin Google en «Crear cuenta»; el login no reconoce una invitación | Google en los dos modos; lo dice y arranca en «Crear cuenta» |
| F9 | «¿Olvidaste tu contraseña?» después de escribir el email | lo borra | lo conserva |

### 1.2 Una hipótesis que la medición descartó

Supuse, leyendo el código, que un email con un espacio al final (el que agrega el autocompletado
del teclado del celular) se rechazaba como «email inválido». **No es un defecto**: medido en
Chromium y en WebKit, un `<input type="email">` ya entrega su valor sin espacios alrededor, el
formulario no lo rechaza y el pedido sale limpio. El `trim` quedó sólo como defensa, y así lo dice
el comentario. No figura entre las correcciones.

---

## 2. Qué se hizo

### 2.1 Un solo shell para las siete pantallas

`AuthFlowShell` pasa a ser el marco de **todo** el embudo. Lo que se le agregó:

- `brand`: `compact` (la marca chica sobre la tarjeta, como ya tenían los pasos del embudo), `hero`
  (grande y dentro de la tarjeta: es `/login`, la cara que el usuario ya conoce) y `none` (el
  callback también se sirve en el dominio del portal mayorista, que es del comercio).
- `estado` (→ `data-estado` en la raíz), `footer` (la línea bajo la tarjeta) y tono `danger`.
- `AuthFlowLoading` acepta `pageTestId` / `estado` / `brand`.

`src/components/auth/AuthFlowFields.tsx` (nuevo) tiene los controles que faltaban, presentacionales
y sobre las clases del sistema:

| Primitivo | Qué es |
|---|---|
| `AuthFlowTextField` | etiqueta + `.form-control` + ícono; error con `aria-invalid` / `aria-describedby` y borde por clase (`.border-error`) |
| `AuthFlowPasswordField` | lo anterior + mostrar/ocultar: interruptor de 44 px con nombre fijo y `aria-pressed` |
| `AuthFlowRequirement` | requisito que se cumple mientras se escribe (cambia el ícono, no sólo el color) |
| `AuthFlowAlert` | `.alert` + `.alert-*` con ícono de Lucide; `alert` para errores, `status` para lo demás |
| `AuthFlowSegmented` | selector de modo: `tablist`, una parada de Tab, flechas / Inicio / Fin |
| `AuthFlowDivider` | «o continuá con» |

`authCardStyles.ts` quedó en lo que usa el shell (tarjeta y fondos decorativos): se retiraron el
botón con gradiente, el de Google, las pestañas, los campos y los helpers de foco. Los botones son
`AuthFlowPrimaryButton` / `Secondary` / `Text`, es decir `AppButton`: el primario del login es el
mismo índigo sólido de BUTTON-SYSTEM-1A que ya usaban `/verificar-email` y `/onboarding`.

`src/css/auth-flow.css` sólo compone layout con tokens (ningún color literal). Dos decisiones que
salieron de medir:

- **El texto de una alerta va en `--text-primary`**, con el tono en el ícono, el borde y el fondo.
  `--success` y `--error` no llegan a AA como texto sobre su propio fondo en tema claro.
- **Lo que queda sobre el fondo de la página** (la línea bajo la tarjeta, el texto de una espera) usa
  `--text-secondary`, y su enlace `--indigo-700` en claro: sobre el fondo teñido `--text-muted` mide
  4,4:1 y `--accent-primary` 4,3:1.

### 2.2 Pantalla por pantalla

**`/login`** — misma composición (marca, modos, campos con ícono, Google, recuperación, pie legal),
sobre el shell. Cambios de comportamiento:

- Google también en «Crear cuenta» (el CTA de la landing abría justo el modo que no lo tenía).
- Con `redirectTo=/accept-invite…`: aviso «Te invitaron a un equipo en TechRepair Pro», arranque en
  «Crear cuenta», bajada «…para sumarte al equipo», sin la oferta de prueba gratis. Un `?modo=`
  explícito gana.
- El email se conserva al cambiar de modo; las contraseñas no.
- Validación al salir del campo de lo **ya escrito** (email, política de contraseña, coincidencia),
  con la misma política del envío. Un campo vacío no es error hasta enviar. Pasar al «ojo» no cuenta
  como salir. En «Iniciar sesión» la contraseña no se valida contra la política (cuentas viejas).
- Requisito en vivo («8 caracteres o más», «Las contraseñas coinciden»).
- El reenvío de confirmación informa sus tres resultados (antes, el fallo no decía nada).
- El foco no se pierde al entrar o salir del pedido de recuperación.

**`/reset-password`** — sólo la capa visual + el aviso al salir del campo y el requisito en vivo.
Estados, condición para mostrar el formulario, guardado y `data-testid`: los mismos.

**`/auth/callback`** — shell, tema y marca. Un error se queda en pantalla con título propio
(«No iniciaste sesión» si canceló; ya no «Error al iniciar sesión») y su salida; los parámetros del
error se quitan de la barra. Si la sesión no queda creada, vuelve a `/login?motivo=sesion_no_iniciada`.
Si llega durante la espera, sigue a la app (antes el temporizador ya estaba armado y mandaba igual
al login). Dice «Iniciando sesión…» o «Verificando tu enlace…» según el caso.

**`/accept-invite`** — shell. Cada rechazo tiene título, ícono y salida propios. «Reintentar» para lo
que no es del enlace; «Usar otra cuenta» para el correo equivocado; sin enlace, pide el **enlace**
del correo (pegado entero) en vez de un «token». Mientras acepta muestra la espera del embudo (antes,
por un cuadro, el formulario manual).

**`/verificar-email`** — una nota más, sólo sin sesión: «Si ya tenías una cuenta con este correo,
puede que no te llegue un enlace nuevo…». Con Confirm Email ON, GoTrue responde lo mismo exista o no
la cuenta y a una ya confirmada no le manda nada: el usuario quedaba esperando. La nota es siempre la
misma, así que no revela si el correo existe.

### 2.3 Destino después de autenticarse: una sola regla

`src/lib/postAuthDestination.ts` (nuevo). Había dos copias que no decían lo mismo: `/auth/callback`
consumía el destino guardado y, sin él, miraba la invitación pendiente; el login con contraseña
navegaba al `redirectTo` de la URL sin consumir nada. Ahora los dos llaman a
`consumePostAuthDestination`:

```
destino guardado por la pestaña → destino pedido por la pantalla → invitación pendiente → /dashboard
```

El guardado y el pedido pasan por `sanitizeInternalPath` (sólo paths internos; nunca el login ni las
rutas de auth); el dominio del portal va siempre a `/`. No es autoridad de nada: que el usuario pueda
ver la pantalla lo siguen decidiendo los guards y el servidor.

---

## 3. Seguridad y arquitectura

Nada de esto cambia quién decide:

- **Supabase Auth**: mismos métodos y mismos argumentos (`signInWithPassword`, `signUp`,
  `signInWithOAuth`, `resend`, `resetPasswordForEmail`, `verifyOtp`, `updateUser`). `AuthContext` no
  se tocó.
- **Provisioning**: `provision_my_business()` sigue teniendo un solo llamador (`/no-business`, con un
  click explícito). Ninguna de las cuatro pantallas lo nombra; un invitado no crea un negocio (E2E §5).
- **Invitaciones**: aceptar sigue siendo una RPC con **sólo el token**. Correo, negocio y rol los
  deriva el servidor. `invitationsService` no se tocó.
- **Redirecciones abiertas**: todo destino pasa por `sanitizeInternalPath`. Probado con `//host`,
  `/\host`, esquemas, `%2f%2f`, tabulaciones y las rutas de auth, tanto en lo guardado como en lo pedido.
- **Enumeración de usuarios**: el pedido de recuperación sigue respondiendo lo mismo exista o no la
  cuenta; el alta con un correo existente sigue con su copy neutro; la nota nueva de
  `/verificar-email` es incondicional; el reenvío responde igual para cualquier correo. «Entraste con
  ‹correo›» muestra la cuenta **propia** del usuario, no la de la invitación.
- **Tokens**: no se loguean. El de una invitación queda en memoria de la pantalla sólo para
  reintentar o cambiar de cuenta, y viaja como ya viajaba (`?redirectTo=` saneado). El enlace pegado
  a mano sólo se **lee** (parámetro `token`): no se navega a lo pegado ni se mira su host.
- **Errores**: mapas cerrados. `error_description` no se lee ni se muestra; el texto de GoTrue o de
  Postgres no llega a la pantalla (probado con errores sintéticos con la forma real).

No hizo falta ninguna migración, cambio de permisos ni de Edge Functions.

---

## 4. Decisiones que conviene revisar

1. **`DESIGN_SYSTEM.md` §19 listaba el Login como «sistema propio, no migrar».** El pedido de este
   lote dice lo contrario de forma explícita (reutilizar componentes compartidos, usar el sistema de
   botones certificado, unificar campos y alertas). Apliqué el pedido y actualicé esa sección. La
   **superficie** del login (tarjeta de vidrio, fondos, marca grande) se conservó; lo que cambió son
   los controles. Si se prefiere mantener la excepción, es una decisión del owner.
2. **Quien llega desde una invitación arranca en «Crear cuenta».** Es lo que recomendó el discovery
   (P1-9): lo habitual es que el empleado invitado todavía no tenga cuenta. Quien ya la tiene elige
   «Iniciar sesión» (el aviso se lo dice). El E2E `@m7 6` se ajustó a eso.
3. **El selector de modo es un control segmentado**, con el lenguaje del de Tareas (riel neutro,
   opción elegida en índigo sólido), y no las pestañas subrayadas de `AppTabs`: conserva la forma que
   el login ya tenía.
4. **`.input-group` no se usa en los campos del embudo.** Es también una clase de Bootstrap, que
   entra por CDN: medido, le saca el radio al control y lo apila por encima del ícono y, con el foco,
   del botón de mostrar la contraseña. `AppInput` con `leftIcon` y `AppSearchInput` usan esa clase;
   **no medí** si les pasa lo mismo en otras pantallas (queda anotado en §7).

---

## 5. Pruebas

### 5.1 Automáticas

| Gate | Resultado |
|---|---|
| `tsc --noEmit` | 0 errores |
| `eslint --quiet` (`lint:errors`) | 0 errores (496 advertencias, las mismas que `main`) |
| `vite build` | OK |
| `npm run test:beta-ux-1g` | 2 suites nuevas, **94 / 94** (+ invitaciones y routing vecinas) |
| vitest, suite completa | 140 archivos · **3.248 / 3.249** — el único rojo es `orderIntakeMobile › scanner cross-browser › enumerateDevices vacío`, el intermitente bajo carga ya anotado en BUTTON-SYSTEM-1A; aislado, 8 / 8 tres veces seguidas |
| `node --test tests/unit` | 1.215 / 1.215 |
| guards estáticos de auth, invitaciones, provisioning, soporte, CORS, UI y tenant | 18 / 18 |

Suites nuevas:

- `tests/components/betaUx1gAuthFlows.test.tsx` (47) — las pantallas reales con el `AuthProvider` real
  sobre un Supabase simulado.
- `tests/components/betaUx1gAuthContract.test.ts` (47) — regla de destino, enlace pegado, validación
  al escribir, estructura (ni `style`, ni color literal, ni botón fuera del sistema) y CSS (sólo
  tokens, foco, 44 px, aritmética WCAG).

Tests de lotes anteriores que cambiaron, y por qué:

- `prebeta3a0Guardrails.test.tsx`: dos tests fijaban `authStyles.btnPrimary` / `tab`, que se
  retiraron. Ahora fijan que `authCardStyles` no vuelva a definir controles y que Login y
  `/reset-password` tomen el CTA del shell. La lista «no vuelve a `#fff` inline» suma las cuatro
  pantallas y los campos.
- `p0p2-invitations.spec.ts`: `@m7 6` elige «Iniciar sesión» (decisión 2). Se suma `@m7 7`.

### 5.2 En navegador (`evidence-1g/verify-auth.mjs`, backend simulado)

| Corrida | Cumple | No cumple |
|---|---|---|
| `main` (referencia) — `verify-main.txt` | 41 | 47 |
| rama, Chromium — `verify-rama-chromium.txt` | **101** | **0** |
| rama, WebKit — `verify-rama-webkit.txt` | **101** | **0** |

Mide áreas táctiles, desborde horizontal a 320 / 375 / 390 / 768 / 1440, contraste pintado en claro
y en oscuro, recorrido con teclado, nombres accesibles y los flujos F1–F10 (F10: el aviso de versión
no tapa el CTA a 320×568, con el mismo cálculo que `m7/mobile-shell.spec.ts`).

### 5.3 E2E contra GoTrue real (stack local)

Corrí en local, contra el stack Supabase que estaba levantado y **sin resetearlo ni migrarlo**:

| Spec | Resultado en la rama |
|---|---|
| `p0p2-invitations` | `@m7 1`–`6`: 6 / 6 |
| `p0p2-invitations` `@m7 7` (nuevo: invitado NUEVO, alta + correo real + otra pestaña) | pasa con el enlace que emite ese stack (ver nota) |
| `p0p4p5-routing-onboarding` | 5 / 5 |
| `mobile-shell` (incluye el login con el aviso de versión a 320×568) | 6 / 6 |
| `email-verification` | 8 / 11 |
| `password-recovery` | `1b`, `2`, `3`, `4`: 4 / 4 · `1` y `5` no pasan · `6` no corrió (archivo en serie) |

**Nota — los rojos locales son del entorno, no de la rama.** Ese stack es viejo (le faltan las 7
migraciones posteriores al 2026-10-08, ninguna de auth) y su GoTrue no tiene las plantillas
`token_hash` de PRE-BETA-2D (su entorno no define `GOTRUE_MAILER_TEMPLATES_*`): los
cinco casos que no pasan fallan todos en el mismo punto, «No llegó el correo esperado», antes de
llegar a la UI. Para no dejar ese tramo sin probar hice dos cosas, las dos descartables:

- `@m7 7` lo corrí en una copia que acepta el enlace viejo (`/auth/v1/verify`): pasó entero —
  aviso de invitación, alta, correo real, otra pestaña, aceptación, y en la base 1 perfil en el
  negocio que invitó, rol `tech`, invitación `accepted`, ningún negocio ni trial nuevo.
- Una sonda que arma el enlace `token_hash` con `admin.generateLink` (el mismo que arma la plantilla):
  alta → `/no-business`; el enlace ya usado, en otro navegador → `/login?motivo=link_invalido`;
  recovery → formulario → validación → guardar → «Contraseña actualizada»; el enlace usado →
  «vencido» → pedir otro; la contraseña vieja deja de servir y la nueva entra. 2 / 2.

Los casos que leen el enlace `token_hash` **del correo** (`email-verification @m7 6`–`8`,
`password-recovery @m7 1`, `5`, `6`, y `@m7 7` tal como quedó escrito) los valida el job `e2e-local`
de CI, que levanta el stack desde este árbol.

---

## 6. Matriz de aceptación

A = automática · N = medida en navegador con backend simulado · E = E2E contra GoTrue real (local) ·
CI = pendiente del job `e2e-local` · M = sólo manual.

| # | Escenario | Estado | Evidencia |
|---|---|---|---|
| 1 | Login con contraseña correcta | **PASS** | A `L12`–`L17` · E (todos los specs entran por la pantalla) |
| 2 | Login con contraseña incorrecta | **PASS** | A `L8` · E (sonda: la contraseña vieja se rechaza con el copy propio) |
| 3 | Login con Google | **BLOCKED** (manual) | A `L7`, `L14` de 2D (arranque, destino guardado, error al abrir) y `C1`–`C5` (vuelta, cancelación, sin sesión). El viaje real a Google no se puede automatizar ni correr en local: necesita un smoke humano |
| 4 | Registro de usuario nuevo | **PASS** | A `L5` de 2D, `I4` · E `email-verification @m7 1`, `2` |
| 5 | Registro con correo existente | **PASS** | A `L6b` de 2D (copy neutro), `V1` (nota incondicional) |
| 6 | Confirmación de correo | **PASS** (falta CI para el enlace leído del correo) | E sonda `token_hash` 2 / 2 · CI `email-verification @m7 6`–`8` |
| 7 | Recuperación de contraseña | **PASS** (ídem) | A `R1`–`R16` de Lote B, `R1`–`R2` · E `password-recovery 1b`–`4` + sonda · CI `@m7 1`, `5`, `6` |
| 8 | Enlace expirado o inválido | **PASS** | A `R5`, `R7`, `A2` de Lote B, `L13` de 2D · E `password-recovery @m7 3`, `4` + sonda |
| 9 | Invitación aceptada por usuario nuevo | **PASS** (falta CI con la plantilla `token_hash`) | E `@m7 7` con el enlace de ese stack · CI `@m7 7` |
| 10 | Invitación aceptada por usuario existente | **PASS** | A `A6`, `I2` · E `p0p2 @m7 1`, `2`, `5`, `6` |
| 11 | Invitación inválida o vencida | **PASS** | A `A2`, `A3` ×5 · E `p0p2 @m7 3`, `4` |
| 12 | Redirección correcta posterior al login | **PASS** | A `D1`–`D10`, `L12`–`L17` · N F1, F2 · E `p0p2 @m7 6` |
| 13 | Usuario autenticado sin negocio | **PASS** | A suites de routing (sin cambios) · E `p0p4p5 @m7 1`, `5`, `email-verification @m7 4`, `4b` |
| 14 | Usuario autenticado con negocio | **PASS** | A `L17` · E `p0p2 @m7 2`, setup global (login real del owner) |
| 15 | Navegación móvil | **PASS** | N G (14 / 14 ≥ 44 px), O (5 anchos sin desborde), F10 · E `mobile-shell` 6 / 6 · WebKit 101 / 101 |
| 16 | Accesibilidad básica | **PASS** | A `S1`, `L1`, `L3`, `L6`, `L19` · N K (foco visible en las 10 paradas, flechas, Enter), A (nombres, errores asociados, `h1` y `main`), C (contraste en los dos temas) |
| 17 | Estados de carga y errores | **PASS** | A `L8`–`L11`, `C1`–`C6`, `A1`, `A7` · N F3–F7 |
| 18 | Sin regresiones en provisioning y roles | **PASS** | A `canonicalProvisioning`, `routingRecoveryOnboarding`, `invitationsLifecycle`, guards de provisioning · E `p0p4p5` 5 / 5, `p0p2` (ningún negocio ni trial nuevo) |

Lo único en **BLOCKED** es el viaje real a Google (#3). Los ítems 6, 7 y 9 tienen evidencia local
contra GoTrue real y les falta la confirmación de CI sobre el enlace leído del correo.

---

## 7. Riesgos y pendientes

- **Google real**: sin smoke humano. Cambió el botón (ahora también en «Crear cuenta») y la vuelta
  (`/auth/callback`), no el contrato con Supabase. Recomendado antes de certificar: cuenta existente y
  cuenta nueva, y cancelar en Google.
- **CI**: los E2E que leen el enlace `token_hash` del correo no se pudieron correr en local (§5.3).
- **Dominio del portal mayorista**: `/auth/callback` se sirve también ahí y ahora usa el shell (sin
  marca). Cubierto por test de componente; no se probó en ese dominio.
- **`.input-group` + Bootstrap** (decisión 4): posible defecto en `AppInput` con ícono y
  `AppSearchInput` en el resto del producto. No medido. Fuera de alcance.
- **`.auth-flow__progress-label`** («Paso 2 de 4», Onboarding): usa `--text-muted` sobre el fondo de
  la página, el mismo par que acá medí en 4,4:1 en tema claro. No lo toqué: es de Onboarding.
- **Portal mayorista** (`PortalLogin` / `PortalRegister`): tiene su propia identidad y sus textos de
  reenvío duplicados. Fuera de alcance.
- **`docs/p0-mobile-evidence/…/320x568-login-update-banner.png`**: captura versionada de MOBILE-01
  con el login anterior. El E2E la reescribe en cada corrida; no la actualicé.
- El invitado sigue sin una bienvenida por rol al entrar (P2-12 del discovery): no era de este lote.

---

## 8. Archivos

**Nuevos**: `src/components/auth/AuthFlowFields.tsx` · `src/lib/postAuthDestination.ts` ·
`tests/components/betaUx1gAuthFlows.test.tsx` · `tests/components/betaUx1gAuthContract.test.ts` ·
`docs/beta-ux-1/evidence-1g/` (guiones, tres reportes, tres láminas antes / después).

**Modificados**: `src/pages/Login.tsx` · `ResetPassword.tsx` · `AuthCallback.tsx` · `AcceptInvite.tsx`
· `VerifyEmail.tsx` · `src/components/auth/AuthFlowShell.tsx` · `authCardStyles.ts` ·
`src/css/auth-flow.css` · `src/lib/authErrors.ts` · `passwordPolicy.ts` · `invitationLink.ts` ·
`tests/components/prebeta3a0Guardrails.test.tsx` · `tests/e2e/m7/p0p2-invitations.spec.ts` ·
`package.json` · `.github/workflows/ci.yml` · `DESIGN_SYSTEM.md`.

## 9. Cómo reproducir la evidencia

```bash
# Tests del lote
npm run test:beta-ux-1g

# Verificación en navegador (no usa Docker). El gate falla si algo no se cumple.
node docs/beta-ux-1/evidence-1g/verify-auth.mjs <worktree> <cacheDir> reporte.txt --gate
node docs/beta-ux-1/evidence-1g/verify-auth.mjs <worktree> <cacheDir> reporte.txt --gate --motor=webkit

# Capturas (una corrida sobre main y otra sobre la rama) y lámina comparativa
node docs/beta-ux-1/evidence-1g/capture-auth.mjs <worktree> <cacheDir> <dirSalida>
node docs/beta-ux-1/evidence-1g/contact-sheet.mjs <worktree> <dirAntes> <dirDespues> salida.png "01-login-mobile-light.png=Login"
```
