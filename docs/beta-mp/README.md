# BETA-MP — Suscripciones SaaS por Mercado Pago

> Alcance: **Billing SaaS** (`mp-subscription` + `mp-webhook`). El medio de pago manual
> «MercadoPago» del POS y Merchant Connect (`mp-oauth` / `mp-payments`) son otro dominio y no se
> tocan en este lote.
>
> Principio: **el frontend propone, Mercado Pago confirma, el backend decide.**

Punto de partida: `main` `e44d691` (merge del PR #166, BETA-1).

- [Runbook de rollout y smoke controlado](runbook-rollout.md) — incluye los niveles de evidencia
  y lo que no se puede afirmar hasta un smoke real
- [Preflight de sólo lectura](preflight-readonly.sql)
- [Verificación post-migración de sólo lectura](postdeploy-verify-readonly.sql)

**Estado: código, migración y tests listos. Nada desplegado, nada aplicado en producción y
ningún smoke contra Mercado Pago ejecutado.**

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

## 4. Arquitectura final

### Módulos

```
supabase/functions/
├── mp-subscription/index.ts      CORS + JWT + cableado. Sin reglas de billing.
├── mp-webhook/index.ts           Firma HMAC + cableado. Sin reglas de billing.
└── _shared/billing/
    ├── planCatalog.ts            MP_PLAN_* ↔ { plan, ciclo }. Única tabla de planes.
    ├── mpClient.ts               Cliente de la API de Mercado Pago (fetch inyectable).
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
técnico ya no puede abrir un checkout ni cancelar. Si la consulta a la autoridad falla, la
respuesta es 503: nunca permite.

### Checkout

`create` valida plan y ciclo, resuelve el plan de MP por secret, lo consulta en Mercado Pago
(`GET /preapproval_plan/{id}`: debe existir, estar activo y tener una frecuencia equivalente al
ciclo — un anual es `12 months` o `1 years`, que es como lo devuelve MP para los planes del panel), crea
o reutiliza una fila en `subscription_checkout_sessions` con `service_role` y devuelve el
`init_point`. **No escribe `businesses` y no cancela nada en Mercado Pago.**

La sesión registra: negocio, usuario, plan y ciclo pedidos, plan de MP esperado, email del
pagador (el del JWT, no el del body), importe y moneda informados por MP, `external_reference` y
estado `pending`. La URL de retorno sólo puede ser `/subscription/pending` de un origen
permitido.

`external_reference = trpcs_<uuid>` se genera en el servidor por cada checkout. Permite
reconstruir `checkout → negocio → plan/ciclo esperado`, no se puede adivinar, y un `business_id`
suelto deja de ser una referencia válida.

### Plan pagado = plan otorgado

El plan sale de `preapproval_plan_id` del preapproval consultado en Mercado Pago, mapeado por
`planCatalog` contra los secrets `MP_PLAN_*`. Si MP devuelve Básico y el navegador había pedido
Full, se otorga Básico y la diferencia queda auditada. Un plan desconocido —o un id configurado
en dos secrets a la vez— no activa nada.

### Reglas del camino canónico

| Evidencia de MP | Preapproval ya vinculado al negocio | Preapproval nuevo (se resuelve por la sesión) |
|---|---|---|
| `authorized` | `active`. El plan se reescribe sólo si cambió el plan de MP registrado. No levanta una mora por cobro rechazado: eso lo hace un cobro aprobado | Activa: estado, plan de MP, `mp_preapproval_id`, `access_source = 'mercado_pago'`, período. Marca la sesión `paid`. Si había otra suscripción, la cancela en MP **después** y lo audita |
| `pending` | `active → past_due`; el resto, sin cambios | Sin cambios en el acceso. Anota el preapproval en la sesión |
| `paused` | `active → past_due` + 3 días de gracia. La gracia no se renueva | Sin cambios |
| `cancelled` | `canceled` | Sin cambios en el acceso. La sesión pasa a `canceled` |
| Plan desconocido | Sin cambios, auditado | Sin cambios, auditado |
| Sin referencia, referencia ajena o ya consumida | — | Sin cambios, auditado |

Además: un evento más viejo que el último aplicado no pisa nada (`mp_last_modified`); un acceso
otorgado por un admin (`admin_override` / `manual_grandfathered`) no se degrada ni se recalifica
por la suscripción anterior; una sesión activa una sola suscripción.

### `status` y `reconcile`

- `status` es una lectura local: responde `source: "database"`, no llama a Mercado Pago y no
  escribe nada.
- `reconcile` consulta Mercado Pago y aplica el camino canónico. Con la suscripción ya vinculada
  la relee por id. Para un checkout todavía sin preapproval busca por el **plan esperado**
  (`/preapproval/search` no filtra por `external_reference`) y exige, resultado por resultado, la
  referencia exacta de la sesión; después relee el candidato por id antes de aplicar. Cero
  coincidencias no activa; más de una autorizada tampoco. El email del pagador no se usa.

### Base de datos — migración `20261012120000` (no aplicada)

- `subscription_checkout_sessions` sólo para el backend: revoca todo a `anon`/`authenticated`,
  elimina `scs_insert` y `scs_select`, da `SELECT`/`INSERT`/`UPDATE` a `service_role` (no `DELETE`)
  y agrega `mp_preapproval_plan_id`, `mp_preapproval_id`, `payer_email`, `confirmed_at`.
- `subscription_events`: columna `notification_id` e índice único
  `(provider, event_type, external_id, notification_id)` en lugar del dedupe por recurso.
- `payments`: índice único no parcial sobre `(provider, external_payment_id)`, para que el
  `upsert` del webhook sea inferible.

Idempotente, transaccional, con precondiciones y postcondiciones fail-closed. Cero DML.

### Webhook

Se conservan la firma obligatoria, el `await` real, `verify_jwt = false`, el uso de
`service_role`, el ledger `payments`, `subscription_events` y la protección contra eventos fuera
de orden. Cambia el dedupe (por notificación). Si la URL trae `data.id`, tiene que coincidir con
el del cuerpo: lo firmado y lo procesado no pueden diferir. `mp-webhook` ahora figura en
`supabase/config.toml` con `verify_jwt = false`: antes un redeploy lo habría cerrado.

### Frontend

- `subscriptionService`: `createSubscription` ya no escribe ninguna tabla; `reconcilePayment`
  devuelve lo que decidió el servidor y deja subir el error; `getCheckoutStatus` lee por la Edge
  Function. Se eliminaron `syncSubscriptionStatus`, `getLatestCheckoutSession`, `getPlanId` y los
  `VITE_MP_PLAN_*` (el navegador no necesita conocer los ids de plan).
- `PaymentPending`: confirma sólo cuando el servidor informa el checkout `paid`. No lee la URL de
  retorno ni decide por `isActive`.
- `SubscriptionSuccess`: «activada» exige una suscripción de Mercado Pago activa.
- `Subscription`: los errores de cancelar y de actualizar el medio de pago se muestran en la
  pantalla con el motivo del servidor, no con `alert()`.

---

## 5. Tests

| Gate | Qué corre | Dónde |
|---|---|---|
| `npm run test:beta-mp` | Guard estático (40 sabotajes en su self-test) + guard read-only de los SQL del runbook + 24 contratos de fuente + 253 tests de integración sobre el código real de las Edge Functions | CI, job `quality` |
| `npm run test:beta-mp:local` | 24 aserciones SQL como los roles de la API + 44 comprobaciones del mismo código sobre PostgreSQL / PostgREST / supabase-js reales, con el RPC de capacidad real | CI, job `beta-mp-billing` |
| `tests/deno/mpWebhookSignature.test.ts` | El handler real de `mp-webhook` en Deno: sin secret → 500; firma ausente, incorrecta o de otro recurso → 401 sin tocar nada; firma válida → recién ahí reclama el evento | CI, `npm run test:deno` |
| `npm run test:beta1` | Regresión de BETA-1. Una aserción cambió: fijaba «`Subscription.tsx` tiene 2 `alert()`» y ahora exige 0 | CI, job `quality` |

Los tests de integración usan un PostgREST en memoria que conoce columnas, CHECK, índices únicos
y los GRANT de `service_role`, y un Mercado Pago simulado a nivel HTTP. Los planes del simulador
tienen la forma medida en el preflight real (anuales `1` / `years`). Veinticuatro mutaciones
deliberadas del código (sin autorización, plan desde el pedido, referencia débil, dedupe por
recurso, frecuencia sólo en meses, etc.) hacen fallar la suite.

---

## 6. Riesgos abiertos

1. **Mercado Pago no está certificado.** Ver «Lo que no se puede afirmar hasta el smoke real» en
   el [runbook](runbook-rollout.md#lo-que-no-se-puede-afirmar-hasta-el-smoke-real). El más
   importante: que el checkout de plan conserve `external_reference`. Si no lo hace, nada se
   activa (falla cerrado) y hace falta el Plan B del runbook.
2. **`reconcile` no recupera un cobro recurrente cuyo webhook se perdió.** Reconcilia el estado de
   la suscripción, no el ledger. Una cuenta en mora por un cobro rechazado vuelve a `active` con la
   notificación del cobro aprobado; Mercado Pago reintenta las notificaciones.
3. **Sin transacción entre tablas.** Las escrituras van por PostgREST, una por una, en un orden
   que deja cada paso reintentable (negocio → sesión → auditoría). Un corte a mitad se repara en
   el próximo evento o en `reconcile`.
4. **Cambio de plan con cancelación fallida.** Si Mercado Pago no deja cancelar la suscripción
   reemplazada, la nueva queda activa y hay un evento `preapproval_superseded` sin procesar: el
   negocio tendría dos suscripciones cobrando hasta que alguien cancele la vieja.
5. **Suspensión administrativa.** `admin_suspend_subscription` no deja marca: un `authorized`
   posterior de Mercado Pago reactiva al negocio. Sin cambios respecto de antes.
6. **`process_mp_subscription_payment`.** RPC `SECURITY DEFINER` sin consumidor que activaría con
   el plan de la sesión. Sólo ejecutable por `service_role`. Conviene retirarla en otro lote.
7. **Cancelar corta el acceso de inmediato**, aunque queden días pagos. Decisión comercial
   existente, sin cambios.
8. **Importes.** El importe cobrado lo define el plan en Mercado Pago; el que ve el usuario,
   `PLANS`. `create` registra el de MP en la sesión pero no los compara: la comparación está en el
   preflight del runbook.
9. **Trial y «Cancelar suscripción».** La tarjeta de administración sigue mostrándose a un trial
   (BETA-1 la fijó así). Ahora el botón responde con un mensaje claro en vez de un `alert()`.

---

## 7. Lo que no cambió a propósito

- Precios, planes y textos de Planes.
- La gracia de 3 días y el cron de expiración.
- El POS y Merchant Connect. `tests/e2e/m7/mp-pos-beta.spec.ts` no se tocó.
- WhatsApp y Ayuda siguen siendo soporte: ninguna pantalla de billing los usa para activar un plan.
