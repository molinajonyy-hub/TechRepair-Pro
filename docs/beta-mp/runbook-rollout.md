# BETA-MP — Runbook de rollout y smoke controlado

> **Nada de este runbook fue ejecutado.** No se aplicó la migración, no se desplegó ninguna
> Edge Function, no se tocaron secrets y no se hizo ninguna compra. Cada paso que escribe en
> producción necesita la autorización explícita del owner.

Contexto y arquitectura: [README](README.md).

---

## Niveles de evidencia

Qué está demostrado, y dónde. Esta tabla es la que hay que leer antes de decir «Mercado Pago
está listo para beta».

| Nivel | Qué corre | Qué prueba | Qué NO prueba |
|---|---|---|---|
| 1 · Tests de integración (`npm run test:beta-mp`) | El código real de las Edge Functions sobre un PostgREST en memoria y un Mercado Pago simulado por HTTP | Autorización, checkout sin efecto sobre el negocio, plan pagado = plan otorgado, idempotencia, orden de eventos, `reconcile`, cancelación, UI de espera | La base real. Mercado Pago |
| 2 · Stack local (`npm run test:beta-mp:local`) | El mismo código sobre PostgreSQL + PostgREST + supabase-js reales, con JWT firmados; la migración aplicada desde cero | GRANT y columnas reales, índices únicos, RLS, el RPC de capacidad real, el navegador contra la tabla de checkout | Mercado Pago. El runtime de Deno desplegado. La firma del webhook |
| 3 · Sandbox de Mercado Pago | Las funciones contra la API de MP con credenciales de prueba | Lo que MP hace de verdad: checkout de plan, `external_reference`, forma de las notificaciones, firma | Producción |
| 4 · Producción | Smoke controlado de este runbook | Secrets, webhook y planes reales | — |

**Hoy están demostrados los niveles 1 y 2.** Los niveles 3 y 4 no se ejecutaron.

### Lo que no se puede afirmar hasta el smoke real

Todo esto depende del comportamiento de Mercado Pago y no está documentado por ellos, o lo está
de forma contradictoria:

1. **Que el checkout de un plan conserve `external_reference`.** La guía de «suscripciones con
   plan asociado» sólo documenta crearlas por API con `card_token_id`; pasar `external_reference`
   (y `payer_email`, `back_url`) por la URL del checkout del plan no figura en la documentación.
   Es el punto del que depende toda la activación. Si MP no la conserva, ningún pago se vincula:
   el webhook registra `not_applied:no_reference` y **no activa nada** (fail-closed). Ver
   [Plan B](#plan-b-si-mercado-pago-no-conserva-la-referencia).
2. Que `GET /preapproval_plan/{id}` devuelva `status`, `auto_recurring` e `init_point` como dice la
   referencia. `create` falla cerrado (503) si el plan no existe, no está activo o su frecuencia
   no coincide con el ciclo: un supuesto equivocado se ve en el paso 1 del smoke.
3. Que `GET /preapproval/search?preapproval_plan_id=…` acepte `offset` y `limit`. El código
   tolera que los ignore, pero entonces `reconcile` sólo ve la primera página.
4. Que `PUT /preapproval/{id}` con `status: "cancelled"` cancele. La referencia usa `cancelled`
   y la guía de gestión dice `canceled`. `cancel` relee el preapproval después del `PUT`: si MP
   no lo canceló responde 502 y **no** marca nada en la base.
5. Que el `init_point` de un preapproval ya autorizado sirva para cambiar la tarjeta. La forma
   documentada es `PUT /preapproval/{id}` con `card_token_id` (requiere tokenizar la tarjeta en
   el navegador). Si el enlace no sirve, «Actualizar método de pago» necesita otro lote.
6. Que los cobros de la suscripción lleguen como `subscription_authorized_payment`. La
   notificación `payment` ahora es sólo auditoría: si MP mandara los cobros únicamente por
   `payment`, el ledger quedaría vacío (el acceso no se ve afectado: lo decide el preapproval).
7. La firma del webhook para notificaciones de suscripciones (el manifiesto usa `data.id`).
8. Que los importes de los planes en Mercado Pago coincidan con los de la pantalla de Planes.

---

## 1. Preflight

### 1.1 Secrets (sólo nombres)

```bash
supabase secrets list --project-ref vrdxxmjzxhfgqlnxmbwx
```

Tienen que existir:

| Secret | Uso |
|---|---|
| `MP_ACCESS_TOKEN` | API de Mercado Pago (las dos funciones) |
| `MP_WEBHOOK_SECRET` | Firma del webhook. Sin él, `mp-webhook` responde 500 |
| `MP_PLAN_BASICO_MONTHLY`, `MP_PLAN_BASICO_ANNUAL` | Plan Básico |
| `MP_PLAN_PRO_MONTHLY`, `MP_PLAN_PRO_ANNUAL` | Plan Pro |
| `MP_PLAN_FULL_MONTHLY`, `MP_PLAN_FULL_ANNUAL` | Plan Full |
| `APP_URL` | Origen del frontend (URL de retorno por defecto y CORS) |
| `MP_CORS_ORIGIN` | Opcional: orígenes extra de CORS |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Automáticos |

`MP_PLAN_*_QUARTERLY` es opcional: Planes sólo ofrece mensual y anual. Un ciclo sin secret
responde 503 «plan no disponible».

**Dos secrets `MP_PLAN_*` no pueden tener el mismo valor.** El listado muestra un digest por
secret: si dos coinciden, esos dos planes dejan de venderse y de otorgarse (no se sabría cuál
se pagó).

### 1.2 Funciones desplegadas (medido el 2026-10-01)

| Función | Versión | `verify_jwt` |
|---|---|---|
| `mp-subscription` | v30 | `false` |
| `mp-webhook` | v23 | `false` |

```bash
supabase functions list --project-ref vrdxxmjzxhfgqlnxmbwx
```

### 1.3 Webhook en el panel de Mercado Pago

- URL: `https://vrdxxmjzxhfgqlnxmbwx.supabase.co/functions/v1/mp-webhook`
- Eventos: `subscription_preapproval` y `subscription_authorized_payment`. `payment` puede quedar
  suscripto: se registra y no escribe nada.
- La clave secreta del panel es la misma que `MP_WEBHOOK_SECRET`.

Esto no se pudo verificar desde el repositorio: lo confirma quien tenga acceso al panel.

### 1.4 Planes esperados

Por cada secret `MP_PLAN_*`, con el token de la cuenta que cobra (no pegar el token en ningún
lado: usar una variable de entorno de la terminal):

```bash
curl -s -H "Authorization: Bearer $MP_ACCESS_TOKEN" "https://api.mercadopago.com/preapproval_plan/$PLAN_ID"
```

| Plan | Ciclo | `auto_recurring.frequency` / `frequency_type` | `transaction_amount` | `status` |
|---|---|---|---|---|
| Básico | mensual | 1 / `months` | 15000 | `active` |
| Básico | anual | 12 / `months` | 144000 | `active` |
| Pro | mensual | 1 / `months` | 25000 | `active` |
| Pro | anual | 12 / `months` | 240000 | `active` |
| Full | mensual | 1 / `months` | 45000 | `active` |
| Full | anual | 12 / `months` | 432000 | `active` |

Los importes son los de `src/types/subscription.ts` (`PLANS`). Si alguno difiere, es drift de
precios: **reportarlo antes de seguir**, no corregirlo sobre la marcha. Anotar también el
`back_url` y el `external_reference` que tenga configurado cada plan.

### 1.5 Línea de base

Correr [preflight-readonly.sql](preflight-readonly.sql) y guardar la salida. Todas las filas
`gate:*` tienen que dar `true`.

---

## 2. Deploy (futuro, con autorización)

El orden importa: **base → Edge Functions → frontend**.

| Combinación | Qué pasa |
|---|---|
| Migración + funciones viejas | Funciona como hoy. El webhook viejo no manda `notification_id`, así que no choca con el índice nuevo |
| Funciones nuevas sin la migración | `create` no puede registrar la sesión y responde 503 sin devolver un checkout (fail-closed). No hacer |
| Funciones nuevas + frontend viejo | Funciona. «Verificar pago» empieza a andar |
| Frontend nuevo + funciones viejas | «Verificar pago» muestra el error del servidor. Por eso el merge va al final |

### 2.1 Migración

Desde un worktree limpio en el commit del PR:

```bash
supabase db push --dry-run --project-ref vrdxxmjzxhfgqlnxmbwx
```

Tiene que listar **una sola** migración: `20261012120000_beta_mp_checkout_session_server_authority.sql`.
Si lista otra, parar.

```bash
supabase db push --project-ref vrdxxmjzxhfgqlnxmbwx
```

La migración corre en una transacción con precondiciones y postcondiciones: si algo no coincide
con el discovery, no aplica nada. Después, [postdeploy-verify-readonly.sql](postdeploy-verify-readonly.sql)
sección 1: todas las filas `check:*` en `true`.

### 2.2 Edge Functions

Las dos con `verify_jwt = false`. Está declarado en `supabase/config.toml`; el flag explícito
es un segundo seguro.

- `mp-webhook`: Mercado Pago no manda un JWT de Supabase. Su seguridad es la firma HMAC.
- `mp-subscription`: valida el JWT adentro (`getAuthUser`) y necesita que el preflight `OPTIONS`
  llegue sin JWT.

```bash
supabase functions deploy mp-webhook --no-verify-jwt --project-ref vrdxxmjzxhfgqlnxmbwx
```

```bash
supabase functions deploy mp-subscription --no-verify-jwt --project-ref vrdxxmjzxhfgqlnxmbwx
```

Si la CLI responde «No change found» no redesplegó: repetir con `--use-api`. Verificar con
`supabase functions list` que las dos subieron de versión y siguen con `verify_jwt = false`.

### 2.3 Verificación sin pagar

```bash
curl -i -X OPTIONS "https://vrdxxmjzxhfgqlnxmbwx.supabase.co/functions/v1/mp-subscription" -H "Origin: https://www.techrepairpro.app" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: authorization,apikey,content-type,x-client-info"
```

Esperado: `204` con `Access-Control-Allow-Origin: https://www.techrepairpro.app`.

```bash
curl -i -X POST "https://vrdxxmjzxhfgqlnxmbwx.supabase.co/functions/v1/mp-subscription" -H "Content-Type: application/json" -d "{\"action\":\"status\"}"
```

Esperado: `401`.

```bash
curl -i -X POST "https://vrdxxmjzxhfgqlnxmbwx.supabase.co/functions/v1/mp-webhook" -H "Content-Type: application/json" -d "{\"type\":\"subscription_preapproval\",\"data\":{\"id\":\"x\"}}"
```

Esperado: `401` (sin firma). Un `500` significa que falta `MP_WEBHOOK_SECRET`.

### 2.4 Frontend

Mergear el PR despliega el frontend en Vercel. Va último.

---

## 3. Smoke controlado

### Dónde correrlo

- **Opción A — sandbox sin tocar producción (recomendada primero).** Stack local con la
  migración, las dos funciones servidas con `supabase functions serve`, credenciales de un
  usuario vendedor **de prueba** de Mercado Pago, planes creados con ese usuario y un túnel
  HTTPS hacia `mp-webhook` configurado en la aplicación de prueba. Responde las ocho incógnitas
  de arriba sin riesgo. Las credenciales de prueba van en un archivo de entorno local que no se
  versiona.
- **Opción B — producción.** Con la cuenta real: implica un cobro real del plan elegido, que se
  cancela en el paso 13. Usar un negocio de prueba (el tenant de QA), nunca el de un cliente.

No cambiar los secrets de producción por credenciales de prueba: durante esa ventana cualquier
usuario real que abra Planes iría a un checkout de prueba.

### Secuencia

Antes de empezar: anotar el `business_id` del negocio de prueba y reemplazarlo en
[postdeploy-verify-readonly.sql](postdeploy-verify-readonly.sql). «Consultar» significa correr
las secciones 2 a 5 de ese archivo.

| # | Paso | Resultado esperado |
|---|---|---|
| 1 | **Crear el checkout.** Con el owner del negocio de prueba, Planes → elegir Básico mensual. | Redirige a Mercado Pago. En la base: una fila en `subscription_checkout_sessions` con `status = pending`, `plan_id = basico`, `mp_preapproval_plan_id` = el secret, `referencia_del_servidor = true`. Un 503 acá es una de las incógnitas 2 u 8: leer el log de la función |
| 2 | **El negocio conserva su acceso mientras no paga.** Sin pagar, volver a la app. Consultar. | La fila de `businesses` es idéntica a la del preflight: mismo `subscription_status`, mismo plan, mismo `trial_ends_at`. Nunca `pending_activation`. `/subscription/pending` dice «Verificando tu pago», no «Pago confirmado» |
| 3 | **Completar una suscripción de prueba.** Repetir el paso 1 y pagar. | Mercado Pago confirma y vuelve a `/subscription/pending` |
| 4 | **Confirmar el webhook.** Logs de `mp-webhook`. | `Received type=subscription_preapproval` y una línea `preapproval_evidence` con `kind: "activated"`. **Si dice `reason: "no_reference"` o `"unknown_reference"`, Mercado Pago no conservó la referencia: PARAR**, es la incógnita 1 |
| 5 | **Confirmar `subscription_events`.** Consultar (sección 4). | Filas `subscription_preapproval` con `processed = true`, `notification_id` no nulo y el `business_id` del negocio; una fila `billing_state_applied` con `origen = webhook`, `estado_resultante = active` |
| 6 | **Confirmar `payments`.** Consultar (sección 5). | Una fila `recurring`, `status = approved`, con el importe del plan. Si no aparece y hay eventos `payment` con `error_message = ignored:payment_topic_is_not_a_billing_authority`, es la incógnita 6 |
| 7 | **Confirmar `mp_preapproval_id`.** Consultar (sección 2). | No nulo, y es el `external_id` de los eventos del paso 5. La sesión del paso 3 quedó `paid` con el mismo id |
| 8 | **Confirmar el plan.** | `subscription_plan = basico` y `mp_preapproval_plan_id` = el secret de Básico mensual. Es el plan que cobró Mercado Pago |
| 9 | **Confirmar `access_source`.** | `mercado_pago`, y `subscription_status = active` |
| 10 | **Confirmar `current_period_*`.** | `current_period_end` = la próxima fecha de cobro que muestra Mercado Pago. `current_period_start` no nulo |
| 11 | **Probar «Verificar pago».** Mi Suscripción → Verificar pago, dos veces. | «Tu suscripción al plan Básico está activa.» Sin filas nuevas en `billing_state_applied` y sin cambios en `businesses` |
| 12 | **Probar «Actualizar método de pago».** | Abre una página de Mercado Pago de esa suscripción. Si la página no permite cambiar la tarjeta, es la incógnita 5 |
| 13 | **Probar cancelar.** Mi Suscripción → Cancelar suscripción → confirmar. | En Mercado Pago la suscripción figura cancelada; en la base `subscription_status = canceled`; un evento `user_cancelled`. Un 502 «no confirmó la cancelación» es la incógnita 4. Repetir el botón: responde igual, sin un segundo `PUT` |
| 14 | **Probar un webhook duplicado.** Desde el panel de Mercado Pago, reenviar una notificación ya entregada (o esperar el reintento). | La función responde `{"received":true,"result":"duplicate"}`; no hay filas nuevas ni cambios |

Dos controles más, baratos y que conviene hacer en la misma sesión:

- **Recuperación sin webhook** (sólo opción A): cortar el túnel, pagar una suscripción, y usar
  «Verificar pago». Tiene que activar con `origen = reconcile`. Es la incógnita 3.
- **Cross-tenant con un JWT real**: con la sesión de un usuario de otro negocio, llamar a
  `status` con el `business_id` del negocio de prueba. Tiene que responder 403.

### Cómo leer un evento que no activó

`subscription_events.error_message` de una notificación procesada:

| Valor | Significado |
|---|---|
| `not_applied:no_reference` | El preapproval no trae una referencia emitida por el servidor |
| `not_applied:unknown_reference` | La referencia tiene el formato correcto pero no corresponde a ninguna sesión |
| `not_applied:unknown_plan` | El `preapproval_plan_id` no está en ningún secret `MP_PLAN_*`, o está en dos |
| `not_applied:not_authorized` | El preapproval todavía no está `authorized` (o es uno que ya no es el vigente) |
| `not_applied:reference_consumed` | Segunda suscripción con la referencia de un checkout ya activado: **revisar en MP**, puede haber dos suscripciones cobrando |
| `not_applied:stale` | Notificación más vieja que el último estado aplicado |
| `unchanged:awaiting_payment` | Sigue `authorized`, pero el último cobro fue rechazado: la mora la levanta un cobro aprobado |
| `applied:plan_differs_from_checkout` | Se activó, con un plan distinto del que se había pedido. Prevalece Mercado Pago |
| `ignored:payment_topic_is_not_a_billing_authority` | Notificación `payment`: sólo auditoría |

Un evento `preapproval_superseded` con `processed = false` significa que, en un cambio de plan,
no se pudo cancelar la suscripción anterior: hay que cancelarla a mano en Mercado Pago.

---

## 4. Rollback

- **Edge Functions**: redesplegar las dos desde `main` en `e44d691`, con `--no-verify-jwt`. Las
  funciones viejas funcionan con el esquema nuevo.
- **Frontend**: revertir el merge.
- **Base**: no hace falta para volver a las funciones viejas. Si igual se quiere, el SQL manual
  está en la cabecera de la migración.

Los datos que haya escrito el smoke (sesiones, eventos, pagos del negocio de prueba) no se
borran: son el registro de lo que pasó.

---

## Plan B si Mercado Pago no conserva la referencia

Si el paso 4 muestra `no_reference`, el checkout por URL de plan no sirve para vincular un pago
con un negocio y **no hay que compensarlo con heurísticas** (email del pagador, proximidad de
fechas, importe): cualquiera de ellas permite activar el negocio equivocado.

La alternativa documentada por Mercado Pago es crear la suscripción por API en estado `pending`
(«suscripción sin plan asociado con pago pendiente»): `POST /preapproval` con `reason`,
`external_reference`, `payer_email`, `auto_recurring` y `back_url`, que devuelve el `id` del
preapproval y su `init_point` **antes** del pago. Eso da una vinculación más fuerte (el servidor
conoce el preapproval desde el inicio), pero cambia la evidencia de plan: sin `preapproval_plan_id`,
el plan habría que derivarlo del preapproval creado por el servidor. Es otro lote y necesita su
propio diseño.
