# TechRepair Pro — Mercado Pago para suscripciones SaaS

Esta guía cubre **Billing SaaS**: el cobro de los planes Básico / Pro / Full de TechRepair Pro
(`mp-subscription` + `mp-webhook`). No cubre el medio de pago manual «MercadoPago» del POS, que
es un registro interno y no usa la red de Mercado Pago, ni Merchant Connect (`mp-oauth` /
`mp-payments`), que queda para después de la beta.

> **Estado (BETA-MP Plan B, 2026-10-02).** El primer smoke real (2026-10-02) cobró una
> suscripción por el checkout de un **plan** de Mercado Pago y no se pudo vincular con ningún
> negocio: Mercado Pago no conservó `external_reference`. Ese camino («Plan A») queda
> **CONFIRMED UNSUPPORTED**. El código de este repositorio implementa el Plan B —el servidor crea
> la suscripción por API— y está probado con tests de integración y contra un stack Supabase
> local, con Mercado Pago **simulado**. El Plan B todavía no se midió contra Mercado Pago: ver
> [docs/beta-mp/runbook-rollout.md](docs/beta-mp/runbook-rollout.md).
>
> Arquitectura, matriz de riesgos y decisiones: [docs/beta-mp/README.md](docs/beta-mp/README.md).

---

## 1. Principio

**El frontend propone. Mercado Pago confirma. El backend decide.**

- Abrir un checkout no cambia el estado ni el plan del negocio.
- Un negocio queda activo sólo cuando el servidor consulta a Mercado Pago y la suscripción está
  `authorized`.
- La suscripción la crea el servidor, y su id queda guardado antes de que nadie pague: ese id es
  la identidad del pago. El email del pagador, el importe y las fechas no identifican a nadie.
- El plan que se otorga es el de la intención que el servidor registró al crear esa suscripción,
  y sólo si Mercado Pago informa el importe y la frecuencia de esa intención.
- Volver de Mercado Pago a una URL de la app no activa nada.

---

## 2. Aplicación y credenciales

1. Crear una aplicación en https://www.mercadopago.com.ar/developers/
2. En **Credenciales** tomar el Access Token.

| Variable | Dónde vive |
|---|---|
| `MP_ACCESS_TOKEN` | Sólo en los secrets de las Edge Functions. Nunca en el frontend |

Para probar se usan las credenciales de un usuario vendedor **de prueba** y un usuario
comprador de prueba (panel de developers → cuentas de prueba). Las tarjetas de prueba vigentes
están en la documentación de Mercado Pago: no se copian acá porque cambian.

---

## 3. Precios

**No hay que crear planes en el panel de Mercado Pago.** El servidor crea cada suscripción por
API con el importe y la frecuencia de su propio catálogo
(`supabase/functions/_shared/billing/planCatalog.ts`, `PLAN_PRICES`):

| Plan | Ciclo | Importe ARS | Frecuencia que se le pide a Mercado Pago |
|---|---|---|---|
| Básico | Mensual | $15.000 | 1 / `months` |
| Básico | Anual | $144.000 | 12 / `months` |
| Pro | Mensual | $25.000 | 1 / `months` |
| Pro | Anual | $240.000 | 12 / `months` |
| Full | Mensual | $45.000 | 1 / `months` |
| Full | Anual | $432.000 | 12 / `months` |

Planes ofrece hoy mensual y anual. El ciclo trimestral está en el modelo pero no tiene precio en
el servidor: no se vende.

> ⚠️ **El importe que se cobra lo define `PLAN_PRICES`**, no el frontend ni el panel de Mercado
> Pago. Lo que ve el usuario sale de `src/types/subscription.ts` (`PLANS`). Las dos tablas tienen
> que coincidir y un test de CI (`tests/unit/billingContracts.test.ts`) falla si no. Para cambiar
> un precio: se cambian las dos y se redespliega `mp-subscription`.
>
> Al leer una suscripción, el servidor compara lo que cobra Mercado Pago con lo que registró al
> crearla. Un anual puede volver como `12` / `"months"` o como `1` / `"years"` (así expresa
> Mercado Pago los anuales del panel, medido el 2026-10-01/02): se aceptan las dos formas. Otro
> importe, otra moneda u otra frecuencia no activan nada.

Los planes que ya existen en el panel (los del Plan A) dejaron de usarse. Una suscripción creada
por el checkout de uno de esos planes no se vincula con ningún negocio.

---

## 4. Variables de entorno del frontend

El frontend **no** necesita los ids de plan ni ninguna credencial de Mercado Pago. Sólo:

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Las variables `VITE_MP_PLAN_*` que pedía una versión anterior de esta guía ya no se leen.

---

## 5. Secrets de las Edge Functions

Sólo nombres; los valores se cargan con `supabase secrets set` y no se versionan.

| Secret | Uso |
|---|---|
| `MP_ACCESS_TOKEN` | API de Mercado Pago. Con este token el servidor **crea** las suscripciones: tiene que ser el de la aplicación cuyo webhook está configurado |
| `MP_WEBHOOK_SECRET` | Firma del webhook. Sin él `mp-webhook` responde 500 |
| `APP_URL` | Origen del frontend: `https://www.techrepairpro.app` |
| `MP_CORS_ORIGIN` | Opcional: orígenes extra, separados por coma |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase.

Los secrets `MP_PLAN_*` del Plan A ya no se leen. Pueden quedar cargados: no hacen nada.

---

## 6. Base de datos

| Migración | Qué hace | Estado en producción |
|---|---|---|
| `20261012120000_beta_mp_checkout_session_server_authority.sql` | La sesión de checkout es sólo del backend; dedupe de eventos por notificación; `upsert` del ledger | Aplicada |
| `20261013120000_beta_mp_plan_b_session_preapproval_unique.sql` | Un preapproval pertenece a una sola sesión (índice único) | **Sin aplicar** |

```bash
supabase db push --dry-run
```

Tiene que listar la `20261013120000` y ninguna otra. Recién entonces `supabase db push`.

---

## 7. Deploy de las Edge Functions

Las dos van con `verify_jwt = false`, y está declarado en `supabase/config.toml`:

```toml
[functions.mp-webhook]
verify_jwt = false

[functions.mp-subscription]
verify_jwt = false
```

- `mp-webhook`: Mercado Pago llama sin un JWT de Supabase. Su seguridad es la firma HMAC
  (`x-signature`), que la función exige siempre. Con `verify_jwt = true` el gateway responde 401
  antes de llegar a la función y ninguna notificación se procesa.
- `mp-subscription`: valida el JWT adentro y necesita que el preflight `OPTIONS` llegue sin JWT.

```bash
supabase functions deploy mp-webhook --no-verify-jwt
```

```bash
supabase functions deploy mp-subscription --no-verify-jwt
```

Verificación antes de desplegar (`tsc` sólo cubre `src/`):

```bash
deno check supabase/functions/mp-subscription/index.ts supabase/functions/mp-webhook/index.ts
```

---

## 8. Webhook en Mercado Pago

1. Panel → la aplicación → **Webhooks**.
2. URL: `https://<ref>.supabase.co/functions/v1/mp-webhook`
3. Eventos:
   - ✅ `subscription_preapproval` — alta, cambios y baja de la suscripción. Decide el acceso.
   - ✅ `subscription_authorized_payment` — cada cobro. Alimenta el ledger `payments`.
   - `payment` — opcional. Se registra y **no escribe nada**: no es una autoridad de billing.
4. La clave secreta que genera Mercado Pago es `MP_WEBHOOK_SECRET`.

> ⚠️ En el smoke real del 2026-10-02 `mp-webhook` **no recibió ninguna notificación** de Mercado
> Pago (los únicos dos requests del día fueron pruebas manuales). No fue un rechazo de firma: no
> hubo request. Antes del próximo smoke hay que confirmar en el panel que la URL está cargada en
> **modo productivo** con el evento «Planes y suscripciones», y revisar el historial de
> notificaciones. Detalle y verificación:
> [runbook](docs/beta-mp/runbook-rollout.md#segundo-hallazgo-mp-webhook-no-recibió-ninguna-notificación).

---

## 9. Flujo de alta

```
Usuario elige plan y ciclo en Planes
    ↓
Frontend → mp-subscription (create)
    ↓
La función exige la capacidad `subscription` del usuario en ese negocio,
toma importe y frecuencia de SU catálogo,
registra la intención en subscription_checkout_sessions,
crea en Mercado Pago un preapproval `pending` (POST /preapproval),
valida la respuesta y GUARDA EL ID del preapproval en la sesión,
y recién entonces devuelve su init_point   ← el negocio NO cambia
    ↓
El navegador va al checkout de ESE preapproval
    ↓
El usuario paga y Mercado Pago lo devuelve a /subscription/pending
    ↓
Mercado Pago llama a mp-webhook (subscription_preapproval)        ┐ lo que llegue
        — o —                                                     ├ primero
/subscription/pending llama a mp-subscription (reconcile)         ┘
    ↓
El servidor relee el preapproval en Mercado Pago, resuelve el negocio
por el id que guardó, comprueba que cobra lo de esa sesión
y recién ahí escribe businesses            ← acá cambia el acceso
    ↓
/subscription/pending muestra «Pago confirmado» cuando el servidor
informa que ESE checkout quedó pagado
```

El webhook y **Verificar pago** (`mp-subscription: reconcile`) aplican exactamente las mismas
reglas sobre el mismo preapproval. La pantalla de espera llama a `reconcile` cada 8 segundos: si
el webhook no llega, la compra se activa igual.

La referencia del checkout (`external_reference`) la genera el servidor, una por checkout, y se
le manda a Mercado Pago al crear el preapproval. Si Mercado Pago la devuelve, se contrasta; si
no la devuelve, alcanza con el id. Un preapproval que el servidor no creó no activa nada.

---

## 10. Cobro recurrente

```
Mercado Pago cobra el período
    ↓
mp-webhook (subscription_authorized_payment)
    ↓
La función relee el cobro, el pago y la suscripción en Mercado Pago
    ↓
Registra el cobro en payments (una fila por cobro, se actualiza si cambia)
    ↓
aprobado  → active + período nuevo, si la suscripción sigue authorized
rechazado → past_due + 3 días de gracia (un segundo rechazo no renueva la gracia)
    ↓
Vencida la gracia → suspended   (cron billing-enforce-grace)
```

El cron (`billing-expire-trials`, `billing-enforce-grace`) ya corre en producción.

---

## 11. Acciones de `mp-subscription`

| Acción | Qué hace | Escribe |
|---|---|---|
| `create` | Crea el preapproval `pending` en Mercado Pago y devuelve su checkout | Sólo la sesión de checkout (con el id del preapproval) |
| `status` | Lectura local del estado y del último checkout. No consulta Mercado Pago | Nada |
| `reconcile` | Relee por id los preapprovals del negocio y lleva la base al estado confirmado | Lo mismo que el webhook |
| `update_payment_method` | Devuelve el enlace de Mercado Pago de la suscripción del negocio | Nada |
| `cancel` | Cancela en Mercado Pago, lo confirma releyendo y refleja la baja | Lo mismo que el webhook |

Todas exigen la capacidad `subscription` del usuario en el negocio que nombran. Ninguna acepta
un id de suscripción, una referencia, un importe o un email de pagador del navegador.

---

## 12. Verificación

```bash
npm run test:beta-mp
```

Tests de integración, guard estático y contratos de fuente. Corre en CI.

```bash
npm run test:beta-mp:local
```

Matriz contra un stack Supabase local con las dos migraciones aplicadas. Corre en CI (job
`beta-mp-billing`).

Ninguno de los dos habla con Mercado Pago. La certificación real es el smoke de
[docs/beta-mp/runbook-rollout.md](docs/beta-mp/runbook-rollout.md).
