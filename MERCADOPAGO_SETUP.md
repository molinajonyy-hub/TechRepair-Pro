# TechRepair Pro — Mercado Pago para suscripciones SaaS

Esta guía cubre **Billing SaaS**: el cobro de los planes Básico / Pro / Full de TechRepair Pro
(`mp-subscription` + `mp-webhook`). No cubre el medio de pago manual «MercadoPago» del POS, que
es un registro interno y no usa la red de Mercado Pago, ni Merchant Connect (`mp-oauth` /
`mp-payments`), que queda para después de la beta.

> **Estado (BETA-MP, 2026-10-01).** El pipeline nunca completó un pago en producción. El código
> de este repositorio está probado con tests de integración y contra un stack Supabase local,
> con Mercado Pago **simulado**. Lo que Mercado Pago hace de verdad todavía no se midió: ver
> [docs/beta-mp/runbook-rollout.md](docs/beta-mp/runbook-rollout.md).
>
> Arquitectura, matriz de riesgos y decisiones: [docs/beta-mp/README.md](docs/beta-mp/README.md).

---

## 1. Principio

**El frontend propone. Mercado Pago confirma. El backend decide.**

- Abrir un checkout no cambia el estado ni el plan del negocio.
- Un negocio queda activo sólo cuando el servidor consulta a Mercado Pago y la suscripción está
  `authorized`.
- El plan que se otorga es el que Mercado Pago informa (`preapproval_plan_id`), no el que eligió
  el navegador.
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

## 3. Planes de suscripción en Mercado Pago

Panel → **Suscripciones → Planes** → nuevo plan. Uno por cada combinación que se venda:

| Plan | Ciclo | Importe ARS | Frecuencia |
|---|---|---|---|
| Básico | Mensual | $15.000 | 1 mes |
| Básico | Anual | $144.000 | 1 año |
| Pro | Mensual | $25.000 | 1 mes |
| Pro | Anual | $240.000 | 1 año |
| Full | Mensual | $45.000 | 1 mes |
| Full | Anual | $432.000 | 1 año |

Planes ofrece hoy mensual y anual. El ciclo trimestral ($39.000 / $64.500 / $117.000, cada 3
meses) está en el modelo pero no en la pantalla: sus secrets son opcionales.

> ⚠️ **El importe que se cobra lo define el plan de Mercado Pago**, no el frontend. Los valores
> de arriba tienen que coincidir con `src/types/subscription.ts` (`PLANS`), que es lo que ve el
> usuario. Si se cambia un precio, se cambia en los dos lugares.
>
> La frecuencia del plan también importa: al abrir un checkout el servidor consulta el plan y
> rechaza (503) uno cuya frecuencia no coincide con el ciclo pedido. La API de Mercado Pago
> devuelve un plan anual creado desde el panel como `frequency = 1`, `frequency_type = "years"`
> (medido el 2026-10-01/02), y uno creado por API puede venir como `12` / `"months"`: se aceptan
> las dos formas. Mensual es `1` / `"months"` y trimestral `3` / `"months"`. Cualquier otra
> combinación se rechaza.

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
| `MP_ACCESS_TOKEN` | API de Mercado Pago |
| `MP_WEBHOOK_SECRET` | Firma del webhook. Sin él `mp-webhook` responde 500 |
| `MP_PLAN_BASICO_MONTHLY`, `MP_PLAN_BASICO_ANNUAL` | Id del plan de MP |
| `MP_PLAN_PRO_MONTHLY`, `MP_PLAN_PRO_ANNUAL` | Id del plan de MP |
| `MP_PLAN_FULL_MONTHLY`, `MP_PLAN_FULL_ANNUAL` | Id del plan de MP |
| `MP_PLAN_*_QUARTERLY` | Opcional |
| `APP_URL` | Origen del frontend: `https://www.techrepairpro.app` |
| `MP_CORS_ORIGIN` | Opcional: orígenes extra, separados por coma |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase.

Los ids `MP_PLAN_*` son la **única** tabla que traduce «plan de Mercado Pago» a «plan de
TechRepair Pro», en las dos direcciones:

- Un id que no está en ningún secret no otorga ningún plan.
- El mismo id en dos secrets deja a esos dos planes sin venderse y sin otorgarse.

---

## 6. Base de datos

La migración de este lote es
`supabase/migrations/20261012120000_beta_mp_checkout_session_server_authority.sql`. Va **antes**
que las Edge Functions.

```bash
supabase db push --dry-run
```

Tiene que listar esa migración y ninguna otra. Recién entonces `supabase db push`.

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

---

## 9. Flujo de alta

```
Usuario elige plan y ciclo en Planes
    ↓
Frontend → mp-subscription (create)
    ↓
La función exige la capacidad `subscription` del usuario en ese negocio,
resuelve el plan de MP por secret, lo verifica en Mercado Pago,
registra la intención en subscription_checkout_sessions
y devuelve el init_point            ← el negocio NO cambia
    ↓
El navegador va al checkout de Mercado Pago
    ↓
El usuario paga y Mercado Pago lo devuelve a /subscription/pending
    ↓
Mercado Pago llama a mp-webhook (subscription_preapproval)
    ↓
La función valida la firma, relee el preapproval en Mercado Pago,
resuelve el negocio por la referencia del checkout,
toma el plan de preapproval_plan_id
y recién ahí escribe businesses      ← acá cambia el acceso
    ↓
/subscription/pending muestra «Pago confirmado» cuando el servidor
informa que ESE checkout quedó pagado
```

Si el webhook no llega, **Verificar pago** (`mp-subscription: reconcile`) hace que el servidor
consulte a Mercado Pago y aplique exactamente las mismas reglas.

La referencia del checkout (`external_reference`) la genera el servidor, una por checkout, y
viaja en la URL del checkout del plan. Que Mercado Pago la conserve en la suscripción no está
documentado: es lo primero que mide el smoke. Si no la conserva, el pago no se vincula y no se
activa nada.

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
| `create` | Abre un checkout | Sólo la sesión de checkout |
| `status` | Lectura local del estado y del último checkout. No consulta Mercado Pago | Nada |
| `reconcile` | Consulta Mercado Pago y lleva la base al estado confirmado | Lo mismo que el webhook |
| `update_payment_method` | Devuelve el enlace de Mercado Pago de la suscripción del negocio | Nada |
| `cancel` | Cancela en Mercado Pago, lo confirma releyendo y refleja la baja | Lo mismo que el webhook |

Todas exigen la capacidad `subscription` del usuario en el negocio que nombran. Ninguna acepta
un id de suscripción, un id de plan o un email de pagador del navegador.

---

## 12. Verificación

```bash
npm run test:beta-mp
```

Tests de integración, guard estático y contratos de fuente. Corre en CI.

```bash
npm run test:beta-mp:local
```

Matriz contra un stack Supabase local con la migración aplicada. Corre en CI (job
`beta-mp-billing`).

Ninguno de los dos habla con Mercado Pago. La certificación real es el smoke de
[docs/beta-mp/runbook-rollout.md](docs/beta-mp/runbook-rollout.md).
