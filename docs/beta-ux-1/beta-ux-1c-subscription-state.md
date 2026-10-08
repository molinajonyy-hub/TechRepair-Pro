# BETA-UX-1C — Mi Suscripción por estado

Cierra **P1-3**, **P1-4** y **P1-13** del discovery BETA-UX-1 (`beta-ux-1-discovery.md`, §C.6).

Base: `main` `fe649b26d511cedcaf58c3d8f8372fd17294df25` (merge certificado de BETA-UX-1B, #171).

Presentación + lógica de frontend con señales que **ya existían**. **Sin migraciones, sin cambios
en Edge Functions, sin `db push`, sin deploy, sin tocar producción.** No cambia estados de
suscripción, reglas de entitlement, la autoridad de Mercado Pago, el webhook ni los precios del
servidor.

---

## 1. Problema

Confirmado sobre `main` antes de tocar nada:

| | Qué pasaba | Dónde |
|---|---|---|
| **P1-3** | Un owner en trial veía «Verificar pago», «Actualizar método de pago» y «Cancelar suscripción». Las dos últimas respondían `409 no_subscription`; la primera, «No hay ningún pago en curso para verificar». Un acceso otorgado a mano veía además «Cambiar plan», que abre un checkout capaz de reemplazarlo | `Subscription.tsx`: el bloque «Administrar suscripción» se mostraba con `isActive \|\| isPastDue \|\| isTrial` |
| | «Detalles del plan» decía **Pago — $25.000** durante la prueba, como si ya se cobrara | `Subscription.tsx`: `InfoRow label="Pago"` sin mirar el estado |
| **P1-4** | A ~375 px el texto de la tarjeta de estado quedaba en una columna de una palabra por línea | La tarjeta era un flex con el texto en `flex: 1; min-width: 0` (base 0) y el botón al lado: el texto nunca forzaba el salto |
| **P1-13** | El aviso de trial aparecía los 14 días, en todas las páginas | `SubscriptionBanner.tsx` calculaba `trialEndingSoon` (≤ 5 días) pero renderizaba por `isTrial && daysUntilTrialEnd !== null` |
| | Texto `#60a5fa` sobre claro (2,54:1), cierre de 22×22, y el cierre vivía en un `useState`: volvía con cada recarga | idem |

## 2. Matriz de presentación

La pantalla ya no combina flags por botón. `src/lib/subscriptionPresentation.ts` — una función
**pura**, sin Supabase ni React — recibe señales y devuelve el estado a mostrar y sus acciones;
`Subscription.tsx` dibuja lo que sale de ahí.

| Estado de presentación | Cuándo | Muestra | Acción primaria | Secundarias | Administrar | No muestra |
|---|---|---|---|---|---|---|
| `trial` | `trialing`, sin checkout `pending` | Plan Pro · días restantes · «Cuando termine tu prueba, elegí un plan para seguir usando TechRepair Pro. Tus datos quedan guardados.» · precio como **Al terminar la prueba — $25.000/mes** | **Elegir plan** | — | — | Verificar pago, Actualizar método, Cancelar, Próximo cobro |
| `trial_pending_checkout` | `trialing` **y** el servidor informa un checkout `pending` | «Tenés un pago iniciado en Mercado Pago.» + plan y ciclo de ese checkout · días restantes | **Continuar pago** | Verificar pago | — | Actualizar método, Cancelar, Próximo cobro |
| `mp_active` | `active` con una suscripción de Mercado Pago vinculada | Próximo cobro (si hay fecha) · precio · email pagador y período · historial | — | Cambiar plan | Actualizar método · Verificar pago · **Cancelar** | — |
| `past_due` | `past_due` con suscripción vinculada | «Tenemos un pago pendiente…» + días de gracia | **Actualizar método de pago** | Verificar pago · Cambiar plan | **Cancelar** | Próximo cobro |
| `manual_access` | `access_source` = `admin_override` o `manual_grandfathered`, con acceso vigente | **«Acceso otorgado por TechRepair Pro»** · plan concedido · vencimiento si existe | — | **Ayuda** → `/ayuda` | — | Precio, Próximo cobro, Elegir/Cambiar plan, «Ver planes», Verificar, Actualizar, Cancelar, checkout, Historial de pagos (salvo que existan pagos), email pagador, período |
| `active_unlinked` | `active`, sin suscripción de MP ni concesión manual | Plan | — | Cambiar plan | — | Precio como cobro, Próximo cobro, acciones de MP |
| `blocked` | `suspended` / `canceled` / `pending_activation` | Lo que certificó BETA-1: «Prueba finalizada» / «Suspendida» / «Cancelada» | Elegir plan (trial vencido) o Reactivar | — | — | Acciones de MP |

Reglas que valen para **toda** la matriz (las recorre el test, 240 combinaciones):

- «Actualizar método» y «Cancelar» sólo existen con `mp_preapproval_id`: es lo que exige la Edge
  Function para esas dos acciones.
- «Verificar pago» sólo existe si hay algo que verificar: un checkout `pending` o una suscripción
  vinculada.
- «Continuar pago» sólo existe en un trial cuyo checkout el servidor informa `pending`.
- Hay a lo sumo una acción primaria.
- Cada handler de Mercado Pago vuelve a consultar la matriz antes de llamar al servicio: una acción
  que el estado no ofrece no llega a la Edge Function ni por un control que quedara montado.

### Prioridad de clasificación

0. **bloqueada** — manda el muro de BETA-1 (ver abajo);
1. **acceso manual**;
2. trial + checkout pendiente;
3. trial;
4. activa por Mercado Pago;
5. pago vencido;
6. activa sin vínculo.

El acceso manual se evalúa **antes** que «activa por Mercado Pago» porque también resuelve
`active`, y un negocio con concesión manual puede conservar un `mp_preapproval_id` anterior.

**Por qué «bloqueada» va primero.** `SubscriptionGuard` / `subscriptionWall` siguen siendo la
autoridad de esa UX y este lote no la rediseña. El resolver no reclasifica nada: el tipo de muro que
informa es, literalmente, el que devuelve `classifySubscriptionWall` (hay un test que lo compara
caso por caso). Un negocio `suspended` cuya fila todavía dice `admin_override` **no** se presenta
como «acceso otorgado»: ese acceso ya no está vigente, y mostrarle «sólo Ayuda» contradiría al muro,
que le ofrece Planes. Si el override sigue vigente, `resolveEntitlement` ya entrega el estado
efectivo `active` y entonces sí es acceso manual.

## 3. Señales usadas

Todas las escribe el servidor y el frontend ya las cargaba (`getSubscription`, `useSubscription`):

| Señal | De dónde sale | Para qué |
|---|---|---|
| Estado **efectivo** | `resolveEntitlement` (vía los flags de `useSubscription`) | Columna de la matriz. No se recalcula acá |
| `access_source` | `businesses` | Acceso manual |
| `mp_preapproval_id` | `businesses` — lo escribe sólo la activación por Mercado Pago | «Hay una suscripción vinculada» |
| `override_expires_at` | `businesses` — lo escriben las RPC de SaaS Admin | Vencimiento de un acceso manual |
| `trial_ends_at`, `last_payment_status` | `businesses` | Sólo para que `classifySubscriptionWall` clasifique el muro |
| `checkout` | acción `status` de `mp-subscription` (`getCheckoutStatus`) | Trial con pago iniciado |

`hasPaidSubscription()` no se tocó. Sigue respondiendo «¿existe o existió billing?» para el muro y
para el aviso de período por vencer. Para decidir acciones se usa algo más estricto,
`mp_preapproval_id`, porque `last_payment_status` o `access_source` no prueban que haya una
suscripción que hoy se pueda cancelar.

`mp_preapproval_id` en la fila del negocio **no** aparece durante un checkout pendiente: el
servidor lo guarda en la sesión de checkout y recién lo copia al negocio al activar
(`applyToUnbound`). Sí puede quedar uno viejo en un negocio que volvió a `trialing` (un admin
extendió la prueba después de una baja); por eso un trial se presenta como trial tenga o no ese id.

## 4. `trial_pending_checkout` es un estado derivado

No existe en la base ni en ningún tipo de la base. El negocio sigue `trialing`; lo que cambia es
que el servidor tiene registrada una intención de compra abierta.

**Cómo se detecta.** `Subscription.tsx` llama a `getCheckoutStatus(businessId)` — la acción
`status` de `mp-subscription`, que es una lectura de `subscription_checkout_sessions` hecha por el
servidor con la autorización de siempre. Si responde `checkout.status === 'pending'`, el estado es
`trial_pending_checkout`.

- La lectura se hace **una vez por visita** a Mi Suscripción y **sólo durante un trial** que no sea
  acceso manual (`shouldLookUpPendingCheckout`): es el único estado cuya presentación cambia con la
  respuesta. No corre en cada render ni en el resto de la app.
- El servidor ya devuelve `expired` para una sesión `pending` con más de 48 h, así que un checkout
  viejo no se presenta como pago iniciado.
- **Si la lectura falla** (red, función caída, respuesta sin `checkout`), la pantalla queda en el
  trial normal. No se muestra un error y no se inventa un checkout.
- No se usan parámetros de URL, `localStorage`, lecturas directas de la tabla ni escrituras. Hay un
  test que carga la URL con `?checkout=pending&status=approved…` y `localStorage` con un checkout
  falso y comprueba que la pantalla sigue en `trial`.

**«Continuar pago».** No se fabrica ninguna URL. Se llama a `createSubscription` con el `plan` y el
`billing_cycle` **que informó el servidor en ese checkout** (no los del negocio, no una elección
del navegador), y el servidor reutiliza la intención y devuelve su `init_point`. Después se navega
con `window.location.href`, exactamente como hace Planes. El pedido lleva `action`, `business_id`,
`plan`, `billing_cycle` y `back_url`: ni importe, ni referencia, ni preapproval.

Casos que el servidor resuelve y la pantalla sólo muestra:

| Respuesta de `create` | Qué hace la pantalla |
|---|---|
| `200` con `init_point` | Navega al checkout |
| `422 mp_payer_email_required` | Abre el **mismo** `MercadoPagoEmailDialog` de Planes y reintenta con ese email. Pasa cuando el checkout se había abierto con un email distinto al del login: el servidor sólo reutiliza la sesión si el email coincide |
| `409 checkout_already_paid` | Muestra el mensaje del servidor («…Tocá «Verificar pago»…»); no da nada por activado |
| otro error | Muestra el mensaje y vuelve a leer el checkout, porque el servidor pudo haberlo cerrado |

**«Verificar pago»** usa `reconcilePayment`, como antes. Con la respuesta se actualiza el mensaje y
el checkout (los dos vienen del servidor) y se llama a `refresh()`. Nada se declara activo desde el
navegador: si el servidor activó, `refresh()` trae `active` y la matriz pasa a `mp_active`.

## 5. Acceso manual — decisión del owner

Decisión cerrada para BETA-UX-1C: un acceso otorgado a mano por TechRepair Pro no debe poder
reemplazarse por accidente con una suscripción paga desde esta pantalla.

Con `access_source` = `admin_override` o `manual_grandfathered` y acceso vigente:

- Título con el plan concedido y el texto **«Acceso otorgado por TechRepair Pro.»**
- Si existe `override_expires_at`: «Tu acceso vence el 12 de noviembre de 2026.» (o «venció el…»
  si la fecha ya pasó). Si no existe, no se muestra ninguna fecha.
- Un solo botón propio del estado: **Ayuda**, que navega a `/ayuda`.
- «Detalles del plan» muestra Plan, Acceso («Otorgado por TechRepair Pro») y Vencimiento si lo hay.
- No hay precio, próximo cobro, «Elegir plan», «Cambiar plan», «Ver planes» (el CTA de la tarjeta
  de funciones también se oculta), «Verificar pago», «Actualizar método», «Cancelar», email
  pagador ni período de facturación.
- «Historial de pagos» se oculta si no hay pagos registrados; si los hay, se conservan a la vista.
- No se consulta el checkout y no sale ninguna llamada a `mp-subscription`.

`/ayuda` es navegación interna: `Subscription.tsx` sigue sin usar el canal de WhatsApp para activar
nada (lo fija `beta1SubscriptionWall.test.ts`).

## 6. Tarjeta de estado responsive (P1-4)

Sólo CSS (`.sub-status*` en `index.css`); la pantalla no mide la ventana.

- La tarjeta es un flex que envuelve dos bloques: `[ícono + textos]` y `[acciones]`. El primero
  pide `flex: 1 1 22rem`. Si no entran lado a lado, **las acciones bajan** en vez de comprimir el
  texto. Ésa era la causa: el texto tenía base 0 y nunca forzaba el salto.
- **≤ 480 px:** el ícono acompaña al título en la misma fila; los textos y las acciones usan todo el
  ancho; cada acción ocupa una fila completa.
- **≤ 767 px:** toda acción de la pantalla mide al menos 44 px de alto.
- **≥ 1200 px:** las acciones van siempre al costado; si son varias se acomodan en un bloque de
  hasta 22rem.

## 7. Superficies y contraste de la pantalla

Regla del bloque: el color del estado va en superficies, bordes, íconos y puntos; **el texto usa
siempre los tokens de texto**, que cumplen contraste en claro y en oscuro. El bloque de CSS no tiene
ningún hex ni `rgb()`.

| Antes | Ahora |
|---|---|
| «Usuarios incluidos» sobre `rgba(255,255,255,0.03)` con borde `rgba(255,255,255,0.07)` | `--bg-surface` + `--border-color` |
| Funciones del plan: ✓ `#34d399`, texto deshabilitado `#475569` | ✓ `--order-badge-paid-fg`; texto `--text-secondary` / `--text-muted` |
| Insignia de estado y líneas del trial con `STATUS_COLORS` / `#60a5fa` / `#fbbf24` como color de texto | texto `--text-primary` / `--text-secondary`; el tono queda en el punto, el ícono y el borde |
| «Cancelar suscripción» con rojo fijo en línea | `.btn-danger` (tokens) |
| Insignias del historial con `PAYMENT_STATUS_COLORS` en línea | misma insignia por tono |

No se tocó `STATUS_COLORS` ni `PAYMENT_STATUS_COLORS`: los usan otras pantallas (ver §12).

## 8. Aviso de suscripción (P1-13)

`src/components/subscription/SubscriptionBanner.tsx` + `src/lib/subscriptionBannerDismissal.ts`.

**Cuándo aparece el de trial:**

```
isTrial && daysUntilTrialEnd !== null && 0 <= daysUntilTrialEnd && daysUntilTrialEnd <= 5
```

Del día 14 al 6 no hay aviso. Con `0` (la fecha ya pasó y el negocio sigue `trialing`) dice «Tu
período de prueba ha vencido.», nunca «0 días». El de pago vencido y el de período por vencer
conservan sus condiciones.

**Cierre por día.** Cerrar el aviso lo oculta por el día local: no vuelve al navegar, al remontar ni
al recargar; al día siguiente, si la condición sigue, vuelve. No es un «no mostrar más».

- Clave en `localStorage`: `techrepair:subscription-banner:dismissed:<businessId>:<tipo>:<AAAA-MM-DD>`,
  con valor `1`. La fecha es la **local** del usuario.
- Un negocio no silencia a otro y un tipo de aviso no silencia a otro.
- No guarda email, datos de pago ni estado de la suscripción. Que el aviso esté cerrado no dice nada
  de billing y nadie lo lee como tal.
- Al cerrar se borran las marcas de días anteriores del mismo negocio y tipo: queda a lo sumo una.
- Si el navegador no deja usar `localStorage`, el cierre dura lo que la pantalla (lo de antes).

| Tipo | ¿Recuerda el cierre durante el día? |
|---|---|
| `trial` | Sí |
| `period_ending` | Sí |
| `past_due` | **No** — conserva su comportamiento: el cierre dura hasta recargar. Es el único que habla de una deuda en curso y se dejó como estaba a propósito |

**Contraste y táctil.** Clases `.sub-banner*`, sólo tokens. Texto en `--text-primary` /
`--text-secondary`; el tono (`--info`, `--warning`, índigo) va en el ícono, el borde y el fondo.
Cierre de 44×44 con su `aria-label` de siempre; acción de 44 px de alto en mobile; foco visible en
los dos.

**Altura.** En desktop sigue siendo una línea (el cierre de 44 px usa margen negativo para no
engordar el aviso). En mobile el texto usa todo el ancho y la acción y el cierre comparten una fila.

## 9. Tests

### Componentes y lógica (`npm run test:beta-ux-1c`)

| Suite | Qué fija |
|---|---|
| `betaUx1cSubscriptionPresentation.test.ts` | **A.** La matriz pura, estado por estado, más invariantes sobre las 240 combinaciones de estado × fuente × vínculo × checkout; que el tipo de muro es el de `classifySubscriptionWall`; que el módulo no importa nada más que tipos y el muro |
| `betaUx1cSubscriptionPage.test.tsx` | **B.** Pago vencido (primaria, gracia, errores junto al botón); «Continuar pago» con email requerido, pago ya registrado, MP caído y doble toque; ningún estado sin vínculo expone controles de MP; bloqueadas como en BETA-1; la lectura del checkout no se repite; estructura y CSS de la tarjeta |
| `betaMp/betaMpFrontend.test.tsx` | **B.** Reemplazo del test «cancelar sin suscripción de MP…» (ver abajo) + bloque **U**: trial, trial con pago iniciado, «Continuar pago» con el plan y ciclo del servidor, lectura fallida, URL/navegador no fabrican un pago, activa por MP, acceso manual |
| `betaUx1cSubscriptionBanner.test.tsx` | **C.** Umbral (14…6 no, 5…1 sí, 0, negativos, sin fecha), cierre, remontaje el mismo día, día siguiente, otro negocio, otro tipo, forma de la marca, limpieza, almacenamiento roto, helper puro, contrato táctil y de tokens del CSS |
| `beta1TrialEndBilling`, `beta1SubscriptionWall`, `trialBannerSingleton`, `trialBannerDateIntegration` | Las suites de BETA-1 que ya cubrían estas pantallas, con el contrato nuevo |

**Tests existentes que codificaban el comportamiento viejo** (ninguno se borró sin reemplazo):

| Test | Decía | Ahora |
|---|---|---|
| `betaMpFrontend` · «cancelar sin suscripción de MP: el motivo del servidor aparece en pantalla» | Un trial toca «Cancelar» y ve el `no_subscription` | **Dos** tests: en un trial no existen Cancelar, Actualizar ni Verificar, y con todo lo demás tocado sólo sale la lectura `status`; y el motivo del servidor sigue apareciendo en pantalla (sin `alert()`) al cancelar una suscripción real que el servidor rechaza |
| `beta1TrialEndBilling` · «trial: conserva «Elegir plan» y la tarjeta de administración» | El trial tiene las tres acciones | El trial tiene una sola salida, «Elegir plan», sin tarjeta de administración |
| `trialBannerSingleton`, `trialBannerDateIntegration`, `prebeta3a0Guardrails` | Aviso con 6 días | Mismo caso con 5 días (el primero en que aparece) + un caso nuevo: con 6 no hay aviso |

### Navegador (`npx playwright test --project=m7-local --grep @beta-ux-1c`)

`tests/e2e/m7/subscription-state.spec.ts`. Mide sobre el bundle servido lo que jsdom no puede. Cada
estado se alcanza parcheando **en el navegador** la respuesta real de la lectura de la suscripción y
simulando la acción `status`; la base, la sesión y RLS son las reales y nada queda modificado.

- **375×812, claro y oscuro, los 6 estados:** sin desborde horizontal (se mide también
  `.main-content`, que recorta, y cualquier elemento que termine fuera del viewport); los textos
  usan el ancho de la tarjeta; ningún párrafo ocupa más líneas de las que su largo justifica (el
  síntoma exacto de P1-4); las acciones quedan **debajo** del contenido, de lado a lado, con 44 px y
  recibiendo el toque; todos los botones de la pantalla ≥ 44 px; título, estado y texto con
  contraste AA; el aviso presente sólo donde corresponde; dibujar la pantalla no dispara ninguna
  acción de Mercado Pago más que la lectura `status`, y sólo en trial.
- **320 px**, **480 / 600 / 768 / 1024 px** con el estado de tres acciones, y **1440 px** con
  composición horizontal en los 6 estados.
- **Aviso** a 375 y 1440, claro y oscuro: no desborda, cierre ≥ 44×44, acción ≥ 44 px en mobile,
  cierre y acción no se pisan, altura acotada, **contraste AA medido** del texto destacado, del texto
  y de la acción, foco visible. Umbral 5/6 días. Cierre que sobrevive a navegar y a recargar, con la
  forma exacta de la marca; una marca de otro día o de otro negocio no lo oculta.

El contraste se mide con el helper que ya usaba `tab-contrast`, que pasó a
`tests/e2e/helpers/contrast.ts` sin cambios (el script de extracción comparó el código quitado
contra el helper).

### Resultados medidos (local, 2026-10-08, base `main` `fe649b2`)

| Gate | Resultado |
|---|---|
| `tsc --noEmit` | 0 errores |
| `eslint src --quiet` | 0 errores (sin warnings nuevos en los archivos tocados) |
| `npm run test:beta-ux-1c` | 8 archivos, **293 / 293** |
| `tests/components/betaMp` (BETA-MP completo) | 8 archivos, **413 / 413** |
| `node --test` de `billingContracts`, `mpSubscriptionCors`, `mpStatus`, `entitlements` | 44 / 44 |
| Suite completa de componentes | 128 archivos, **2750 / 2750** |
| `npm run test:unit` | **1215 / 1215** |
| Guards estáticos del job `quality` (incluye `guard:no-real-data`, `guard:beta-mp`, `guard:edge-cors-contract`) | 54 ok, 1 omitido (`no-real-data:verify-removed`, necesita historial) |
| `vite build` (producción) | OK |
| E2E `@beta-ux-1c` | **35 / 35** |
| E2E vecinos, con `--enable-smooth-scrolling` (la condición de CI): `subscription-state`, `tab-contrast`, `mobile-shell`, `mp-pos-beta`, `customer-core-parity`, `pos-viewport-containment`, `pos-open-caja`, `order-history`, `error-codes` | **116 / 116** |

Los E2E corrieron contra un stack local aislado (285 migraciones, sin Edge), ya eliminado.

**Controles negativos.** Se reintrodujo cada defecto y se exigió que la suite fallara:

- Componentes: **47 / 47** mutaciones detectadas — entre ellas el trial con las tres acciones, el
  acceso manual clasificado después de «activa», cualquier checkout tomado como pendiente, la
  lectura fallida que inventa un pago, «Continuar pago» con el plan del negocio o con un importe
  agregado, el umbral en 14 días, el cierre que no persiste / persiste para siempre / no lleva el
  negocio o el tipo, y el bloque de texto de la tarjeta con base 0.
- E2E, dos builds mutados:
  - con el CSS de P1-4 reintroducido (texto con base 0, sin salto), los 12 casos de 375 px fallan
    en «los textos del estado no usan el ancho de la tarjeta» (recibido: **92 px**, o 0), más 320 px
    y los cuatro anchos intermedios; con el cierre de 22 px fallan los cuatro casos del aviso;
  - sin el mínimo de 44 px los botones miden 39 px y fallan los 13 casos mobile; con el texto del
    aviso en el color del estado (`--info`) el contraste medido en claro es **3,49:1** y falla; con
    el umbral en 14 fallan los dos casos de ausencia; sin persistencia falla el caso del cierre.

Dos fallas que NO son del lote, vistas durante las corridas y verificadas:

- `orderIntakeMobile` · escáner: un timeout cuando la suite completa corrió junto con otra carga
  pesada. Aislado pasa 8/8 y la suite completa, sin carga, 2750/2750 (ya visto en BETA-UX-1B).
- `mailpitConfig` y `safeDevPreflight` (unit): dependen del entorno del worktree —el primero del
  `supabase/config.toml` commiteado, que estaba aislado temporalmente para los E2E; el segundo de
  un `.env.development.local` que un worktree nuevo no tiene—. Con el entorno en su lugar,
  1215/1215.

## 10. Evidencia

`docs/beta-ux-1/evidence-1c/` — capturas generadas por el spec con `BETA_UX_1C_EVIDENCE=1` (sin la
variable el spec no escribe ningún archivo):

- `<estado>-375-light.png`, `<estado>-375-dark.png`, `<estado>-1440-light.png` para `trial`,
  `trial-por-vencer`, `trial-pago-iniciado`, `activa-mercado-pago`, `pago-vencido`, `acceso-manual`;
- `aviso-trial-375-light.png`, `aviso-trial-375-dark.png`, `aviso-trial-1440-light.png`,
  `aviso-trial-1440-dark.png`.

Los datos que se ven son los del negocio E2E sembrado, con el estado de suscripción simulado.

## 11. Smoke manual sugerido (Preview)

1. **Owner en trial con más de 5 días.** Sin aviso en ninguna página. En Mi Suscripción: «Plan Pro»,
   días restantes, la explicación de qué pasa al terminar, un solo botón («Elegir plan») y «Al
   terminar la prueba — $25.000/mes». No existe «Administrar suscripción».
2. **Owner con 5 días o menos.** Aviso visible. Cerrarlo, navegar a otra página y recargar: no
   vuelve. Al día siguiente vuelve.
3. **Trial con checkout pendiente** (elegir un plan en Planes y volver sin pagar). Mi Suscripción
   dice «Tenés un pago iniciado en Mercado Pago» con el plan y el ciclo elegidos. «Continuar pago»
   lleva al mismo checkout. «Verificar pago» muestra el mensaje del servidor. No hay «Cancelar» ni
   «Actualizar método».
4. **Activa por Mercado Pago.** Próximo cobro, «Cambiar plan», y en «Administrar suscripción»:
   Actualizar método, Verificar pago, Cancelar.
5. **Acceso manual.** «Acceso otorgado por TechRepair Pro», vencimiento si se cargó uno, sólo
   «Ayuda». Ninguna mención a precios ni cobros.
6. **375 px, claro y oscuro.** Tarjeta de estado legible, sin palabras apiladas, sin scroll
   horizontal.

## 12. Fuera de alcance — hallazgos

Documentados, sin tocar:

1. **`override_expires_at` no lo aplica nadie.** Lo escriben `admin_activate_subscription` y
   `admin_grant_legacy_access` y lo leen las pantallas; ningún cron, RPC ni Edge Function vence el
   acceso en esa fecha. Mi Suscripción ahora dice «Tu acceso vence el…», y la fecha puede pasar sin
   que el acceso cambie.
2. **`admin_extend_trial` no toca `access_source`.** Un negocio que tuvo una concesión manual y
   después recibe una extensión de prueba queda `trialing` + `admin_override`: se presenta como
   acceso manual (sin «Elegir plan»), aunque el aviso de ≤ 5 días sí lo lleva a Planes.
3. **«Continuar pago» puede volver a pedir el email de Mercado Pago.** El servidor sólo reutiliza
   la sesión si el `payer_email` coincide, y al no coincidir la cierra antes de intentar con el del
   login. La acción `status` no informa si ese checkout usó un email explícito. Mejorarlo es un
   cambio de Edge.
4. **«Pago» muestra siempre el precio mensual del catálogo**, también para quien paga anual: la
   lectura de la suscripción no trae el ciclo vigente.
5. **«Historial de pagos» se abre con un `<div onClick>`**: no es alcanzable con teclado ni anuncia
   su estado.
6. **Los usuarios activos se cargan en el inicializador de un `useState`** (`Subscription.tsx`):
   corre una sola vez y no reintenta si el negocio todavía no estaba resuelto.
7. **`STATUS_COLORS` / `PAYMENT_STATUS_COLORS`** siguen siendo hex pensados para oscuro y los usan
   otras pantallas (SaaS Admin, entre otras). Es parte de BETA-UX-1E.
8. **`SubscriptionBanner`** envuelve `<BannerInner />` en un `try/catch` que no puede atrapar un
   error de render, con un `console.error`.
