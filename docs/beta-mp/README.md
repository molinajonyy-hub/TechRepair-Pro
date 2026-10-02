# BETA-MP — Suscripciones SaaS por Mercado Pago

> Alcance: **Billing SaaS** (`mp-subscription` + `mp-webhook`). El medio de pago manual
> «MercadoPago» del POS y Merchant Connect (`mp-oauth` / `mp-payments`) son otro dominio y no se
> tocan en este lote.
>
> Principio: **el frontend propone, Mercado Pago confirma, el backend decide.**

Dos lotes:

| Lote | Base | Qué hizo | Estado |
|---|---|---|---|
| BETA-MP (PR #167) | `main` `e44d691` | Autoridad del servidor: autorización uniforme, checkout sin efecto sobre el negocio, `reconcile`, dedupe por notificación, ledger. **Plan A**: checkout por URL de un plan de Mercado Pago | Mergeado (`ecbba69`). Migración `20261012120000` aplicada y funciones v32 / v25 desplegadas en producción |
| **BETA-MP Plan B** (este lote) | `main` `ecbba69` | El backend crea el preapproval por API y lo vincula a la sesión antes de devolver el checkout. La identidad de un pago es ese id | Código, migración `20261013120000` y tests listos. **Nada desplegado** |

- [Runbook de rollout y smoke controlado](runbook-rollout.md) — la evidencia real del smoke del
  2026-10-02, por qué el Plan A queda **CONFIRMED UNSUPPORTED**, el hallazgo del webhook y lo que
  no se puede afirmar hasta el próximo smoke
- [Preflight de sólo lectura](preflight-readonly.sql)
- [Verificación post-migración de sólo lectura](postdeploy-verify-readonly.sql)

**Por qué existe el Plan B.** En el smoke real del 2026-10-02 se pagó un Básico Mensual por el
checkout de un plan de Mercado Pago. El pago se aprobó y Mercado Pago creó un preapproval
`authorized` con `external_reference` **vacía**: no había forma de saber a qué negocio
pertenecía sin adivinar (email, importe, fecha). El código no activó a nadie, que es lo que
tenía que hacer. Además `mp-webhook` no recibió ninguna notificación de Mercado Pago. Las
secciones 1 a 3 describen el estado anterior a BETA-MP y se conservan como registro; la
arquitectura vigente es la de la sección 4.

---

## 1. Estado inicial medido

### Producción (sólo lectura, 2026-10-01, proyecto `vrdxxmjzxhfgqlnxmbwx`)

| Dato | Valor |
|---|---|
| `payments` | 0 filas |
| `subscription_events` | 1 fila (marcador de migración; 0 de Mercado Pago) |
| `subscription_checkout_sessions` | 0 filas |
| Negocios con `mp_preapproval_id` | 0 |
| Negocios con `access_source = 'mercado_pago'` | 0 |
| Estados | 9 `active` · 23 `suspended` · 1 `trialing` |
| `mp-subscription` | v30, `verify_jwt = false` |
| `mp-webhook` | v23, `verify_jwt = false` |
| Última migración aplicada | `20261011130000` |
| Cron | `billing-expire-trials` y `billing-enforce-grace` activos |

**El pipeline de Mercado Pago nunca completó un pago en producción.** Eso explica por qué
varios de los problemas de abajo no se habían manifestado.

### Privilegios de `subscription_checkout_sessions` (Fase 11)

| Pregunta | Respuesta medida |
|---|---|
| ¿`authenticated` puede insertar? | **No.** Existe la policy `scs_insert`, pero no hay `GRANT`: el `insert` del navegador fallaba con `42501` y el código no miraba el error |
| ¿Puede modificar `status`? | No: ni `GRANT` ni policy de `UPDATE` |
| ¿Puede elegir otro `business_id`? | No llega a evaluarse (sin `GRANT`). La policy lo limitaría a `current_user_business_id()` |
| ¿Puede leer? | No: `scs_select` existe, sin `GRANT`. `PaymentPending` nunca vio una sesión |
| ¿Qué columnas controlaba el cliente? | Todas las del `insert`: `business_id`, `plan_id`, `billing_cycle`, `amount`, `mp_preference_id`, `external_reference`, `status` |
| ¿Y `service_role`? | `SELECT` + `UPDATE(status, updated_at)`. **No podía insertar** |

La tabla estaba vacía por construcción: ni el navegador ni el backend podían crear una sesión.

---

## 2. Matriz de acciones (antes de BETA-MP)

`acción → quién puede llamarla → input del cliente → autoridad real → escritura DB → riesgo → corrección`

| Acción | Quién podía llamarla | Input del cliente | Autoridad real | Escritura en DB | Riesgo | Corrección |
|---|---|---|---|---|---|---|
| `mp-subscription:create` | Miembro activo del negocio, cualquier rol | `business_id`, `plan`, `billing_cycle`, `payer_email`, `back_url` | Ninguna de MP: sólo el pedido del navegador | `businesses`: `subscription_status = 'pending_activation'`, `subscription_plan`, `mp_preapproval_plan_id`, `mp_payer_email`. Además cancelaba en MP el preapproval vigente | **P0.** Abrir el checkout y abandonarlo: un trial pierde el acceso, un trial vencido sale del muro, un suscriptor pierde su suscripción. El plan pedido queda como plan canónico. Un técnico podía hacerlo. El 403 devolvía un objeto `debug` | No toca `businesses` ni Mercado Pago. Capacidad `subscription`. Intención en `subscription_checkout_sessions`, escrita por el backend. Plan resuelto por secrets y verificado en MP |
| `mp-subscription:cancel` | Miembro activo, cualquier rol | `business_id` | `businesses.mp_preapproval_id` | `PUT` a MP + `subscription_status = 'canceled'` sin verificar que MP canceló; evento `user_cancelled` | **P1.** Un técnico cancela la suscripción. No verificaba el resultado en MP. Errores de escritura ignorados. La segunda cancelación chocaba contra el dedupe | Capacidad `subscription`. Relee MP después del `PUT` y aplica el estado por el camino canónico. Idempotente |
| `mp-subscription:status` | **Cualquier usuario autenticado**, de cualquier negocio | `business_id` | — | Ninguna | **P0 (fuga cross-tenant).** Devolvía estado de billing, email del pagador y el objeto completo del preapproval de MP de otro negocio | Capacidad `subscription`. Lectura local, sin llamar a MP, respuesta recortada |
| `mp-subscription:reconcile` | — | `business_id` | — | — | **P0 funcional.** La acción **no existía**: respondía 400, el frontend lo tragaba y mostraba «No se detectó pago aprobado». Sin recuperación si el webhook se pierde | Implementada: consulta MP y aplica el mismo camino canónico que el webhook |
| `mp-subscription:update_payment_method` | **Cualquier usuario autenticado**, de cualquier negocio | `business_id` | `businesses.mp_preapproval_id` | Ninguna | **P0 (cross-tenant).** Devolvía el `init_point` y el id del preapproval de otro negocio | Capacidad `subscription` + verificación de pertenencia del preapproval |
| `mp-webhook` · `subscription_preapproval` | Mercado Pago (firma HMAC) | `data.id` | `GET /preapproval/{id}` | `businesses`: estado, `mp_preapproval_id`, `access_source`. **No el plan** | **P0.** (a) El plan activado era el que `create` había guardado a pedido del navegador. (b) Resolvía el negocio con `external_reference = business_id`: quien arma la URL pública del plan con el id de otro negocio le reemplaza la suscripción. (c) `pending` degradaba a `pending_activation`. (d) **Dedupe por recurso**: `created` y `updated` comparten `data.id`, así que la segunda notificación del mismo preapproval se descartaba — el `authorized` posterior a un `pending` no se procesaba nunca | Plan desde `preapproval_plan_id` de MP. Negocio resuelto por una sesión emitida por el servidor. `pending` no toca el acceso. Dedupe por notificación |
| `mp-webhook` · `subscription_authorized_payment` | Mercado Pago | `data.id` | `GET /authorized_payments/{id}` + `/v1/payments/{id}` | `payments` + `businesses` (`active` / `past_due`) | **P0.** El `upsert` del ledger fallaba con `42P10` (el índice único era parcial) y el error se ignoraba: **ningún cobro se habría registrado**. Además: mismo dedupe roto, un cobro aprobado reactivaba una suscripción cancelada, cada rechazo renovaba la gracia, dependía de que el webhook del preapproval llegara antes, y leía `payment_id` donde MP documenta `payment.id` | Índice único inferible. Aplica primero el preapproval por el camino canónico; sólo activa si MP lo informa `authorized`; la gracia no se renueva; toda escritura verifica su error |
| `mp-webhook` · `payment` | Mercado Pago | `data.id` | `GET /v1/payments/{id}` | `payments` (`one_time`) + `businesses.last_payment_*`, negocio tomado de `external_reference` | **P1.** `external_reference` lo elige quien paga: apuntaba a un negocio arbitrario. Duplicaba en el ledger los cobros que también llegan como `subscription_authorized_payment` | Sólo auditoría. El ledger de cobros recurrentes tiene una única autoridad |
| `payments.raw_payload` | Cualquier miembro activo del negocio (`SELECT` por RLS) | — | — | El webhook guardaba el pago completo de MP | **P2 (privacidad).** El objeto de pago de MP trae documento y datos de tarjeta del pagador, legibles por un técnico | Se guarda un recorte: ids, estados y fechas |
| Navegador → `subscription_checkout_sessions` | Usuario autenticado | Todas las columnas | — | Ninguna (sin `GRANT`) | La intención de compra «vivía» en una escritura que nunca ocurría | Se elimina. La sesión la crea `create` con `service_role` |
| Navegador → `PaymentPending` | Capacidad `subscription` (ruta) | — | `isActive` del negocio | Ninguna | Mostraba **«¡Pago confirmado!»** a cualquier cuenta que ya estuviera `active` (plan anterior o acceso manual), sin que existiera un pago | La confirmación sale del estado de la sesión de checkout que informa el servidor |
| `src/lib/mpStatus.ts` · `mapPreapprovalToInternal` | — (sin uso) | — | — | — | Segunda copia, en el cliente, del mapeo de estados; mandaba `pending` a `pending_activation` | Eliminada |
| `process_mp_subscription_payment` (RPC) | Sólo `service_role`; sin caller en el repo | — | La sesión de checkout | Activaría con el plan de la sesión | Latente: segunda autoridad de activación que confía en el plan pedido | Fuera de alcance: se documenta. No se llama |

Todas las referencias pedidas en el discovery (`mp_preapproval_id`, `subscription_plan`,
`pending_activation`, `external_reference`, `reconcile`, `createSubscription`,
`syncSubscriptionStatus`, `getLatestCheckoutSession`, etc.) están cubiertas por esta matriz.

---

## 3. Causa raíz de cada problema

1. **`create` cambiaba el acceso canónico.** La intención de compra y el estado del negocio
   compartían las mismas columnas de `businesses`. No había dónde guardar «quiso comprar Pro» sin
   escribir «tiene Pro pendiente».
2. **El plan pagado no se validaba.** El webhook nunca leyó `preapproval_plan_id`. El único dato
   de plan era el que el navegador había mandado a `create`.
3. **`reconcile` no existía.** El frontend se escribió contra una acción que la Edge Function
   nunca implementó, y el `catch` lo ocultaba.
4. **`status` y `update_payment_method` sin autorización.** Cada handler copiaba —o no— su propia
   verificación de pertenencia; dos de cuatro la omitieron, y las que la tenían no miraban la
   capacidad.
5. **Dependencia del webhook.** Sin `reconcile` no había otro camino, y el dedupe por recurso
   descartaba la segunda notificación de un mismo preapproval o cobro.
6. **Referencia débil.** `external_reference = business_id` no identifica un checkout, no es
   secreta y la arma quien paga.
7. **Sesiones de checkout imposibles de crear.** Ni el navegador ni `service_role` tenían `INSERT`.
8. **Ledger imposible de escribir.** `payments` sólo tenía un índice único parcial; PostgREST arma
   `ON CONFLICT (provider, external_payment_id)` sin predicado y PostgreSQL responde `42P10`.
   Apareció al correr el código contra el stack local: la base en memoria de los tests no lo
   modelaba (ahora sí).
9. **Errores de escritura ignorados.** Ninguna escritura de las dos funciones miraba su resultado,
   por eso 7 y 8 nunca dieron señal.

---

## 4. Arquitectura vigente (Plan B)

### Módulos

```
supabase/functions/
├── mp-subscription/index.ts      CORS + JWT + cableado. Sin reglas de billing.
├── mp-webhook/index.ts           Firma HMAC + cableado. Sin reglas de billing.
└── _shared/billing/
    ├── planCatalog.ts            Precio y frecuencia de cada plan/ciclo. Única fuente de lo que se cobra.
    ├── mpClient.ts               Cliente de la API de Mercado Pago (fetch inyectable). Sin búsquedas.
    ├── store.ts                  Acceso a datos (service_role) + autorizador por capacidad.
    ├── preapproval.ts            applyPreapprovalEvidence: EL camino canónico.
    ├── subscriptionActions.ts    create / cancel / status / reconcile / update_payment_method.
    └── webhook.ts                Claim idempotente + despacho de notificaciones.
```

Un solo camino escribe el acceso de un negocio por evidencia de Mercado Pago:
`applyPreapprovalEvidence`. Lo usan el webhook, `reconcile`, `cancel` y el handler de cobros
recurrentes. No hay dos implementaciones del mapeo de estados.

### Autorización

Las cinco acciones pasan por el mismo helper antes de leer o escribir nada:
`current_user_can_in_business(business_id, 'subscription')`, ejecutada **con el JWT del usuario**.
Es la autoridad server-side que ya usa el resto del producto (SEC-08A): resuelve identidad,
perfil activo, negocio y override de permisos en el contexto de ese negocio. Es más estricta
que «pertenece al negocio» y coincide con la capacidad que exige la ruta `/subscription/*`: un
técnico no puede abrir un checkout ni cancelar. Si la consulta a la autoridad falla, la
respuesta es 503: nunca permite.

### Checkout: el servidor crea el preapproval

El navegador propone `business_id`, `plan` y `billing_cycle`. `create`:

1. Toma importe, moneda y frecuencia de `PLAN_PRICES` (`planCatalog.ts`). Un ciclo sin precio
   responde 503. Importe, moneda, frecuencia, referencia, `payer_email` o ids que mande el
   navegador se ignoran.
2. Inserta la sesión en `subscription_checkout_sessions` con `external_reference = trpcs_<uuid>`
   generada por el servidor.
3. Llama a `POST /preapproval` de Mercado Pago: `status: "pending"`, esa referencia, el email del
   JWT, `auto_recurring` del catálogo y una `back_url` que sólo puede ser `/subscription/pending`
   de un origen permitido. Sin plan de Mercado Pago y sin medio de pago.
4. Valida la respuesta: tiene que traer un `id`, estar `pending`, cobrar exactamente lo pedido,
   no informar otra referencia y traer un `init_point` de Mercado Pago que sea el de **ese**
   preapproval. Si algo falla: 502, sin checkout, la sesión queda `failed`.
5. **Guarda el `id` del preapproval en la sesión.** Si esa escritura falla, no entrega el
   checkout (503) y cancela el preapproval recién creado para que tampoco se pueda pagar.
6. Recién entonces devuelve el `init_point`.

**No escribe `businesses`, no aplica evidencia y no toca la suscripción vigente.** Pedir dos
veces el mismo plan y ciclo devuelve el mismo preapproval mientras siga `pending`, sea del mismo
pagador y cobre lo que hoy dice el catálogo. Si ese preapproval ya está `authorized` (se pagó y
la confirmación todavía no llegó) responde 409 en lugar de abrir un segundo cobro.

### Identidad de un pago: el id del preapproval

| Pregunta | Respuesta |
|---|---|
| ¿A qué negocio pertenece un preapproval? | Al de la sesión que tiene ese `mp_preapproval_id`, o al negocio que ya lo tiene vinculado. Un índice único por tabla impide que figure en dos sesiones o en dos negocios |
| ¿Y si Mercado Pago no devuelve `external_reference`? | Alcanza con el id: lo vinculó el servidor antes del pago |
| ¿Y si devuelve una referencia distinta de la de esa sesión? | No se aplica (`reference_mismatch`) |
| ¿Y un preapproval que el servidor no creó? | No activa nada (`unknown_preapproval`), aunque traiga una referencia válida, el mismo email, el mismo importe o la misma fecha que un checkout abierto |
| ¿Qué plan se otorga? | El de la sesión que originó **ese** preapproval — la intención que registró el servidor, no lo que mande el navegador después |
| ¿Y si Mercado Pago informa otro importe, moneda o frecuencia que los de la sesión? | No se aplica (`terms_mismatch`): no se sabe qué se pagó |

Email del pagador, importe y fechas **nunca** resuelven un negocio. `mpClient` no tiene ningún
endpoint de búsqueda.

### Reglas del camino canónico

| Evidencia de MP | Preapproval ya vinculado al negocio | Preapproval de una sesión todavía sin activar |
|---|---|---|
| `authorized` | `active`. El plan no se reescribe (un cambio hecho por un admin no se pisa); sólo se repone si falta. No levanta una mora por cobro rechazado: eso lo hace un cobro aprobado | Si las condiciones coinciden, activa: estado, plan de la sesión, `mp_preapproval_id`, `access_source = 'mercado_pago'`, período. Marca la sesión `paid`. Si había otra suscripción, la cancela en MP **después** y lo audita |
| `pending` | `active → past_due`; el resto, sin cambios | Sin cambios |
| `paused` | `active → past_due` + 3 días de gracia. La gracia no se renueva | Sin cambios |
| `cancelled` | `canceled` | Sin cambios en el acceso. La sesión pasa a `canceled` |
| Id que el servidor no creó | — | Sin cambios, auditado |
| Referencia o condiciones que no coinciden | — | Sin cambios, auditado |

Además: un evento más viejo que el último aplicado no pisa nada (`mp_last_modified`); un acceso
otorgado por un admin (`admin_override` / `manual_grandfathered`) no se degrada ni se recalifica
por la suscripción anterior; una sesión vencida que igual se paga activa (el pago es real).

### Cambio de plan

Abrir el checkout del plan nuevo no toca la suscripción vigente. La nueva se vincula cuando
Mercado Pago la confirma, y **recién entonces** se cancela la anterior. Si esa cancelación falla,
la nueva queda activa y queda un evento `preapproval_superseded` sin procesar para que alguien lo
vea.

### `status` y `reconcile`

- `status` es una lectura local: responde `source: "database"`, no llama a Mercado Pago y no
  escribe nada.
- `reconcile` es la vía de recuperación cuando el webhook no llega. Relee **por id** el
  preapproval del negocio y el de cada sesión todavía sin activar (incluidas las vencidas), y
  aplica el camino canónico fijando el negocio autorizado. No busca por plan, email ni fecha: un
  checkout sin preapproval vinculado no se puede reconciliar, a propósito. Dos llamadas seguidas
  no escriben nada la segunda vez.

### Base de datos

- **`20261012120000` (aplicada en producción).** `subscription_checkout_sessions` sólo para el
  backend; `subscription_events` deduplica por notificación; `payments` admite el `upsert`.
- **`20261013120000` (este lote, sin aplicar).** Reemplaza el índice no único sobre
  `subscription_checkout_sessions.mp_preapproval_id` por uno **único** (parcial). La base
  garantiza preapproval → una sesión → un negocio. Sin la migración el código detecta el
  duplicado y falla cerrado; con ella el duplicado no puede existir.

Las dos son idempotentes, transaccionales, con precondiciones y postcondiciones fail-closed y
cero DML.

### Webhook

Se conservan la firma obligatoria, el `await` real, `verify_jwt = false`, el uso de
`service_role`, el ledger `payments`, `subscription_events`, el dedupe por notificación y la
protección contra eventos fuera de orden. Si la URL trae `data.id`, tiene que coincidir con el
del cuerpo. Cambia cómo se resuelve el negocio (por el id conocido de antemano) y cada rechazo
previo a reclamar el evento deja una línea en el log, para poder distinguir «Mercado Pago no
notificó» de «notificó y lo rechazamos». El webhook dejó de ser condición para activar: ver el
[segundo hallazgo del runbook](runbook-rollout.md#segundo-hallazgo-mp-webhook-no-recibió-ninguna-notificación).

### Frontend

Sin cambios de comportamiento en este lote: el navegador manda lo mismo y recibe un `init_point`.
`CreateSubscriptionResponse` ya no declara `preapproval_id` (el id queda en el servidor).

- `subscriptionService`: `createSubscription` no escribe ninguna tabla; `reconcilePayment`
  devuelve lo que decidió el servidor y deja subir el error; `getCheckoutStatus` lee por la Edge
  Function.
- `PaymentPending`: confirma sólo cuando el servidor informa el checkout `paid`. No lee la URL de
  retorno ni decide por `isActive`. Llama a `reconcile` cada 8 segundos: si el webhook no llega,
  esa llamada es la que activa.
- `SubscriptionSuccess`: «activada» exige una suscripción de Mercado Pago activa.

---

## 5. Tests

| Gate | Qué corre | Dónde |
|---|---|---|
| `npm run test:beta-mp` | Guard estático (73 sabotajes en su self-test) + guard read-only de los SQL del runbook + 28 contratos de fuente (incluido «el precio del servidor es el de Planes») + 309 tests de integración sobre el código real de las Edge Functions | CI, job `quality` |
| `npm run test:beta-mp:local` | 33 aserciones SQL como los roles de la API + 54 comprobaciones del mismo código sobre PostgreSQL / PostgREST / supabase-js reales, con el RPC de capacidad real | CI, job `beta-mp-billing` |
| `tests/deno/mpWebhookSignature.test.ts` | El handler real de `mp-webhook` en Deno: sin secret → 500; firma ausente, incorrecta o de otro recurso → 401 sin tocar nada; firma válida → recién ahí reclama el evento | CI, `npm run test:deno` |
| `npm run test:beta1` | Regresión de BETA-1 | CI, job `quality` |

Los tests de integración usan un PostgREST en memoria que conoce columnas, CHECK, índices únicos
y los GRANT de `service_role`, y un Mercado Pago simulado a nivel HTTP que implementa
`POST /preapproval` y puede omitir `external_reference`, como se midió en producción.

Además de los sabotajes del guard (que corren en CI), al cerrar el lote se aplicaron a mano 46
mutaciones del código, una por vez, y las 46 hicieron fallar la suite de comportamiento: vincular
un id desconocido por referencia, no contrastar la referencia, exigirla, no comparar condiciones,
plan fijo, importe o email del navegador, entregar el checkout sin guardar el id, cancelar la
suscripción vigente al abrir el checkout, `reconcile` sin fijar el negocio, etc. Esa pasada no
está automatizada en CI.

**Ninguno de estos gates habla con Mercado Pago.**

---

## 6. Riesgos abiertos

1. **El Plan B no está certificado contra Mercado Pago.** Ver «Lo que no se puede afirmar hasta
   el próximo smoke» en el [runbook](runbook-rollout.md#lo-que-no-se-puede-afirmar-hasta-el-próximo-smoke).
   Los dos que más importan: que `POST /preapproval` responda como dice la documentación, y qué
   exige Mercado Pago sobre el `payer_email` cuando quien paga usa una cuenta con otro email.
2. **El webhook no está certificado.** En el smoke real Mercado Pago no llamó a `mp-webhook`. La
   activación ya no depende de él, pero el ledger `payments` y la mora por cobro rechazado sí:
   sin notificaciones no se registran cobros ni se detecta un rechazo.
3. **`reconcile` no recupera un cobro recurrente cuyo webhook se perdió.** Reconcilia el estado de
   la suscripción, no el ledger.
4. **Sin transacción entre tablas ni con Mercado Pago.** Las escrituras van una por una, en un
   orden que deja cada paso reintentable (sesión → preapproval → vínculo; negocio → sesión →
   auditoría). Un corte entre crear el preapproval y vincularlo deja un preapproval `pending`
   cancelado (o, si tampoco se pudo cancelar, uno que no activa nada y queda en el log como
   `unlinked_preapproval_not_cancelled`). Si `POST /preapproval` se corta por timeout **después**
   de que Mercado Pago lo creó, el servidor no llega a conocer su id: nadie recibe ese checkout
   y la sesión queda `failed`, pero el preapproval existe en Mercado Pago. Si alguien lo pagara
   por un enlace que le mande Mercado Pago, no activaría nada (`unknown_preapproval`) y habría
   que resolverlo a mano.
5. **Cambio de plan con cancelación fallida.** La nueva queda activa y hay un evento
   `preapproval_superseded` sin procesar: dos suscripciones cobrando hasta que alguien cancele la
   vieja.
6. **Precios en dos tablas.** `PLAN_PRICES` (servidor) y `PLANS` (pantalla). Un contrato de CI
   falla si mensual o anual difieren; cambiar un precio exige cambiar las dos y redesplegar
   `mp-subscription`. Los preapprovals ya creados conservan el precio con el que se abrieron.
7. **Suspensión administrativa.** `admin_suspend_subscription` no deja marca: un `authorized`
   posterior de Mercado Pago reactiva al negocio. Sin cambios.
8. **`process_mp_subscription_payment`.** RPC `SECURITY DEFINER` sin consumidor. Sólo ejecutable
   por `service_role`. Conviene retirarla en otro lote.
9. **Cancelar corta el acceso de inmediato**, aunque queden días pagos. Decisión comercial
   existente, sin cambios.
10. **El preapproval real del smoke del Plan A** sigue `authorized` en Mercado Pago, sin vínculo
    con ningún negocio. Decisión del owner: ver el runbook.

---

## 7. Lo que no cambió a propósito

- Precios, planes y textos de Planes.
- La gracia de 3 días y el cron de expiración.
- El POS y Merchant Connect. `tests/e2e/m7/mp-pos-beta.spec.ts` no se tocó.
- WhatsApp y Ayuda siguen siendo soporte: ninguna pantalla de billing los usa para activar un plan.
- El negocio del smoke: no se tocó en la base ni se vinculó su pago por aproximación.
