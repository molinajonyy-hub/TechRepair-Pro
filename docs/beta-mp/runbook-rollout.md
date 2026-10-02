# BETA-MP — Runbook de rollout y smoke controlado (Plan B)

> **El microfix del email del pagador (este PR) no fue desplegado.** Cada paso que escribe en
> producción necesita la autorización explícita del owner. No trae migración.
>
> El Plan B (PR #168) se mergeó el 2026-10-02 y corrió en producción lo suficiente como para
> medir `POST /preapproval`: ver [la evidencia](#evidencia-real-de-post-preapproval-2026-10-02).

Contexto y arquitectura: [README](README.md).

---

## Estado medido (producción, sólo lectura, 2026-10-02 ~13:10 UTC)

Medición anterior al merge del Plan B. Lo que pasó después está en la evidencia de
`POST /preapproval`; el estado de la base y de las funciones no se volvió a medir.

| Dato | Valor |
|---|---|
| Última migración aplicada | `20261012120000` (BETA-MP, Plan A) |
| `mp-subscription` | v32, `verify_jwt = false` (código del Plan A, desplegado el 2026-10-02 02:23 UTC) |
| `mp-webhook` | v25, `verify_jwt = false` (ídem) |
| `subscription_checkout_sessions` | 2 filas, las dos `pending`, las dos sin `mp_preapproval_id` |
| `subscription_events` | 1 fila (marcador de junio). **0 de Mercado Pago** |
| `payments` | 0 filas |
| Negocios con `mp_preapproval_id` / `access_source = 'mercado_pago'` | 0 / 0 |

---

## Plan A — CONFIRMED UNSUPPORTED

El Plan A mandaba al usuario al checkout **por URL de un `preapproval_plan`** del panel de
Mercado Pago, con `external_reference=trpcs_<uuid>` como parámetro, y esperaba que Mercado Pago
copiara esa referencia a la suscripción.

### Evidencia real del smoke del 2026-10-02

| Paso | Resultado medido |
|---|---|
| Checkout Básico Mensual (ARS 15.000) | Creado. La sesión del servidor se registró con `external_reference = trpcs_<uuid>` |
| URL enviada a Mercado Pago | Contenía `external_reference=trpcs_<uuid>` |
| Pago | **Real y aprobado** |
| Preapproval creado por Mercado Pago | `33b5f5ad…25f8`, `status = authorized`, `preapproval_plan_id = dc679c2a…438b`, `next_payment_date = 2026-11-02…` |
| `external_reference` de ese preapproval | **VACÍA** |
| «Verificar pago» (`reconcile`) | `not_found` |
| Negocio | Sin `mp_preapproval_id`, sin acceso por Mercado Pago |
| `subscription_events` | Ninguna fila nueva |

**Conclusión:** el checkout por URL de un `preapproval_plan` **no conserva** `external_reference`.
Era la incógnita #1 de la versión anterior de este runbook. El código falló cerrado, como estaba
diseñado: no activó a nadie.

### Por qué no se compensa con heurísticas

Sin referencia, lo único que une ese preapproval con un negocio es el email del pagador, el
importe o la cercanía de fechas. Ninguno es identidad: dos negocios pueden pagar el mismo plan
el mismo día, y el email del pagador lo elige quien paga. Cualquiera de esas reglas permite
activar el negocio equivocado. **El preapproval del smoke no se vincula a mano ni por
aproximación**, y el negocio del smoke no se «arregla» en la base.

### Lo que quedó pendiente del smoke (decisión del owner, fuera de este PR)

- El preapproval `33b5f5ad…25f8` sigue `authorized` en Mercado Pago y **va a cobrar de nuevo el
  2026-11-02**. No está vinculado a ningún negocio y con el Plan B tampoco lo estará
  (`not_applied:unknown_preapproval`). Si no se quiere ese cobro, hay que cancelarlo desde el
  panel de Mercado Pago.
- Las dos sesiones `pending` del Plan A quedan como registro. No tienen preapproval vinculado:
  `reconcile` no puede recuperarlas y no lo intenta.

---

## Segundo hallazgo: `mp-webhook` no recibió ninguna notificación

Independiente del anterior: aunque Mercado Pago hubiera conservado la referencia, **el webhook
no habría activado nada, porque no fue invocado**.

### Qué se midió

Logs del gateway de Edge Functions de producción (`function_edge_logs`), ventana de 24 horas
hasta las 13:10 UTC del 2026-10-02. Cubre todo el smoke.

| Hora (UTC) | Función | Método | Status | Origen |
|---|---|---|---|---|
| 02:25:51 | `mp-webhook` | POST | 400 | `curl` — verificación manual post-deploy |
| 12:11:31 | `mp-webhook` | POST | 401 | PowerShell — verificación manual «sin firma» |
| 12:15–12:20 | `mp-subscription` | POST ×3 | 200 | `create` (Pro mensual), una sesión |
| 12:45–12:48 | `mp-subscription` | POST ×2 | 200 | `create` (Básico mensual), la sesión del smoke |
| 12:49:09 | `mp-subscription` | POST | 409 | acción sobre un negocio sin suscripción |

`mp-webhook` recibió **dos** requests en toda la ventana y los dos son del operador. No hay
ninguno con origen en Mercado Pago, ni antes ni después del pago aprobado. El log de la función
tiene una sola línea propia: `Rejected: invalid signature (type=subscription_preapproval id=x)`,
la de la prueba de las 12:11. El log del gateway de la API (`edge_logs`) tampoco tiene requests a
ninguna ruta `webhook` ni con user-agent de Mercado Pago.

### Qué responde y qué no

- **No fue un rechazo nuestro.** Una notificación con firma inválida deja un `401` en el
  gateway y una línea `Rejected: invalid signature`; un cuerpo inválido deja un `400`. No hay
  ninguno atribuible a Mercado Pago. No se llegó a `claimEvent` porque no hubo request.
- **Mercado Pago no llamó a esta URL.** Lo que no se puede ver desde el repositorio ni desde
  Supabase es por qué. Causas posibles, sin verificar:
  1. La URL de producción no está cargada en el panel de la aplicación (o está sólo la de
     modo prueba), o el evento «Planes y suscripciones» no está tildado.
  2. El preapproval del smoke lo creó el checkout de un **plan creado desde el panel**, no la
     aplicación dueña del `MP_ACCESS_TOKEN`: las notificaciones de un recurso van a la
     aplicación que lo creó. En el Plan B el preapproval lo crea el servidor con ese token, así
     que este caso cambia; hay que medirlo.
  3. La documentación de webhooks de Mercado Pago es ambigua sobre cómo se configuran las
     notificaciones de Suscripciones, y la referencia de `POST /preapproval` no documenta
     `notification_url`. Este PR **no** manda ese campo.
- **«El endpoint sin firma dio 401» no prueba que el webhook funcione.** Sólo prueba que la
  función rechaza lo que no está firmado. Que una notificación real de Mercado Pago pase la
  firma sigue sin medirse.

### Cómo verificarlo (owner, panel de Mercado Pago)

1. Tus integraciones → la aplicación del `MP_ACCESS_TOKEN` → Webhooks → **modo productivo**:
   URL `https://vrdxxmjzxhfgqlnxmbwx.supabase.co/functions/v1/mp-webhook` y evento «Planes y
   suscripciones» tildado.
2. El historial de notificaciones del panel: ¿figura algún intento de entrega del 2026-10-02?
   Si no figura ninguno, Mercado Pago no generó la notificación para esa aplicación.
3. `GET /preapproval/33b5f5ad…` con el token: el campo `application_id` dice qué aplicación es
   dueña de ese preapproval.

### Qué cambia en este PR respecto del webhook

- Cada rechazo previo a reclamar el evento deja una línea en el log (método, cuerpo no JSON,
  firma inválida con **qué partes** de la firma llegaron: `x-signature`, `x-request-id`,
  `data.id` en la URL — sólo presencia, nunca valores).
- **La activación no depende del webhook.** `reconcile` relee el preapproval por el id que el
  servidor guardó y llega al mismo resultado. Si el webhook sigue sin llegar, «Verificar pago» y
  la pantalla de espera (que llama a `reconcile` cada 8 segundos) activan igual.

BETA-MP **no se puede dar por certificado** hasta medir una notificación real de Mercado Pago
procesada de punta a punta (pasos 5 y 13 del smoke).

---

## Evidencia real de `POST /preapproval` (2026-10-02)

Con el Plan B ya mergeado, `create` llegó a `POST /preapproval` en producción.

| Intento | `payer_email` | Respuesta de Mercado Pago |
|---|---|---|
| El de la app | El email del login de TechRepair Pro (un alias `+…` de una casilla de Gmail) | **`400`** `{"message":"User bad request","status":400}` |
| El mismo POST, a mano | El email real de una cuenta de Mercado Pago | **`201`** |

Lo que devolvió el `201`:

| Campo | Valor medido | Qué confirma |
|---|---|---|
| `status` | `pending` | El preapproval se crea sin medio de pago, como dice la documentación |
| `id` | Presente (`ba83bbb6…c29b`) | El servidor conoce el id antes de que nadie pague |
| `external_reference` | **Conservada** (la que se mandó) | La referencia sí vuelve cuando el preapproval lo crea la API (no así en el checkout por URL de un plan) |
| `init_point` | `…?preapproval_id=<ese id>` | El checkout es el de ese preapproval |
| `auto_recurring` | 15000 ARS / `1` / `months` | Mercado Pago cobra lo que pidió el servidor |
| `application_id` | Presente | El preapproval queda a nombre de la aplicación del token |

Ese preapproval fue **sólo un diagnóstico**: se canceló a mano y no se asocia a ningún negocio.

**Conclusión.** Mercado Pago exige un `payer_email`, y el email del login de TechRepair Pro no
se puede asumir como el de una cuenta de Mercado Pago. La forma de la respuesta de
`POST /preapproval` (incógnitas 1 y 3 de la versión anterior de este runbook) quedó confirmada.

### Lo que cambia: el email del pagador, con fallback

No se le pide el email de Mercado Pago a todo el mundo.

1. El usuario toca «Elegir». El navegador manda negocio, plan y ciclo — **sin email**.
2. El backend intenta `POST /preapproval` con el email del JWT.
3. Si Mercado Pago lo acepta: checkout directo. El usuario no ve ningún paso extra.
4. Si Mercado Pago rechaza **ese POST** con el rechazo medido, `create` responde
   `422 mp_payer_email_required`, no entrega ningún checkout y la sesión queda `failed`.
5. Planes muestra «Necesitamos un dato de Mercado Pago» con un único campo, «Email de tu cuenta
   de Mercado Pago», y reintenta `create` con `mp_payer_email`.
6. Si ese email funciona: checkout. Si tampoco: `422 mp_payer_email_rejected`, el error se
   muestra en el diálogo y **no hay reintento automático**: el usuario corrige o cierra.

**El email no es autoridad.** Es un parámetro que Mercado Pago exige para crear el
preapproval. Se le manda a Mercado Pago y se anota en la sesión (`payer_email`) como registro de
lo enviado, y nada más: no resuelve un `business_id`, no vincula un preapproval, no activa, no
se usa para buscar suscripciones, no participa en `reconcile` ni en el webhook. La cadena de
autoridad no cambió: JWT → capacidad `subscription` → sesión del servidor → preapproval creado
por el servidor → `mp_preapproval_id` guardado → Mercado Pago confirma → el backend aplica.

En el navegador el email es estado efímero de la pantalla: no se guarda en `localStorage` ni en
el perfil, y se pierde al recargar. Si el usuario ya lo ingresó en esa visita, el siguiente
plan que elija lo manda directo.

#### Qué rechazo dispara el pedido de email (lista cerrada)

Sólo un `400` de **`POST /preapproval`** cuyo mensaje sea `User bad request` o nombre
`payer_email`, y sólo cuando el intento fue con el email del JWT. Cualquier otro `400`, un
`401`/`403`/`5xx`, un timeout o un error de otra operación siguen siendo `502 mp_unavailable`,
con el motivo de Mercado Pago en el log.

**Limitación conocida.** «User bad request» no dice que la causa sea el email: es el único dato
que devuelve Mercado Pago, y se midió una sola vez. Si Mercado Pago usara ese mismo mensaje
para otro problema, el usuario vería el pedido de email y, al reintentar, el error
`mp_payer_email_rejected`. El costo de equivocarse es un paso de más para el usuario; nunca una
activación incorrecta, porque el email no decide nada.

**Sin medir todavía.** Que un `payer_email` aceptado al crear obligue a pagar con esa misma
cuenta. Si Mercado Pago acepta el email del login pero después rechaza el checkout porque quien
paga usa otra cuenta, hoy el usuario no tiene desde dónde indicar otro email: el pedido sólo
aparece cuando falla la creación.

---

## Plan B — qué cambia

El **backend** crea la suscripción por API (`POST /preapproval`, «sin plan asociado, con pago
pendiente») y conoce su id **antes** de que nadie pague.

1. El navegador propone `business_id`, `plan` y `billing_cycle`. Nada más se usa, salvo
   `mp_payer_email` en el reintento descripto arriba.
2. El backend autoriza la capacidad `subscription`, toma importe y frecuencia de **su**
   catálogo, registra la sesión con `trpcs_<uuid>`, crea el preapproval `pending` en Mercado
   Pago (referencia del servidor, email del pagador, `back_url` permitida), valida la respuesta,
   **guarda el `id` del preapproval en la sesión** y recién entonces devuelve el `init_point`
   de ese preapproval.
3. La activación resuelve el negocio por ese id. `external_reference` se contrasta cuando
   Mercado Pago la devuelve; si no la devuelve, alcanza con el id. Un preapproval que el servidor
   no creó no activa nada.

Los planes del panel (`MP_PLAN_*`) dejan de usarse.

---

## Niveles de evidencia

| Nivel | Qué corre | Qué prueba | Qué NO prueba |
|---|---|---|---|
| 1 · Tests de integración (`npm run test:beta-mp`) | El código real de las Edge Functions sobre un PostgREST en memoria y un Mercado Pago simulado por HTTP (incluido `POST /preapproval`) | Autorización, creación y vínculo del preapproval, activación por id, condiciones, idempotencia, `reconcile`, cambio de plan, cancelación, UI de espera | La base real. Mercado Pago |
| 2 · Stack local (`npm run test:beta-mp:local`) | El mismo código sobre PostgreSQL + PostgREST + supabase-js reales, con JWT firmados; las dos migraciones aplicadas desde cero | GRANT y columnas reales, índices únicos (incluido preapproval → sesión), RLS, el RPC de capacidad real | Mercado Pago. El runtime de Deno desplegado. La firma del webhook |
| 3 · Sandbox de Mercado Pago | Las funciones contra la API de MP con credenciales de prueba | Lo que MP hace con un preapproval creado por API | Producción |
| 4 · Producción | Smoke controlado de este runbook | Secrets, webhook y cobro reales | — |

**Para el Plan B están demostrados los niveles 1 y 2, y del nivel 4 sólo la creación del
preapproval** (`POST /preapproval`, medido a mano). Nadie pagó todavía un preapproval creado por
el Plan B: la activación de punta a punta contra Mercado Pago sigue sin medirse.

### Lo que no se puede afirmar hasta el próximo smoke

Depende de Mercado Pago:

1. ~~Que `POST /preapproval` con `status: "pending"` responda con `id`, `status = pending`,
   `auto_recurring` e `init_point`.~~ **CONFIRMED** (2026-10-02). Si alguna vez la respuesta no
   trae alguno de esos datos, `create` responde 502 `checkout_unavailable` y no entrega checkout.
2. **Qué exige Mercado Pago sobre `payer_email`.** Medido a medias: un email que no es de una
   cuenta de Mercado Pago da `400 User bad request` al crear (**CONFIRMED**, y es lo que resuelve
   este microfix). **Sin medir:** si un email aceptado al crear obliga a pagar con esa cuenta, y
   si «User bad request» puede significar otra cosa.
3. ~~Que el preapproval creado por API conserve `external_reference`.~~ **CONFIRMED**: la
   conserva. No hace falta para activar; queda registrado en la auditoría (`reference_echoed`).
4. Que Mercado Pago acepte `12` / `months` para el anual y cómo lo devuelve. Se aceptan
   `12` / `months` y `1` / `years` al leer; cualquier otra forma falla cerrado.
5. **Que Mercado Pago notifique** un preapproval creado por la aplicación. Ver el segundo
   hallazgo.
6. La firma del webhook para notificaciones de suscripciones.
7. Que `PUT /preapproval/{id}` con `status: "cancelled"` cancele. `cancel` relee después del
   `PUT`: si MP no lo canceló responde 502 y no marca nada.
8. Que el `init_point` de un preapproval ya autorizado sirva para cambiar la tarjeta.
9. Que los cobros lleguen como `subscription_authorized_payment`.
10. Que Mercado Pago respete `X-Idempotency-Key` en `POST /preapproval`. No se depende de eso:
    hay una sola sesión `pending` por negocio, plan y ciclo.

### Importes

Los importes los define el servidor (`PLAN_PRICES` en
`supabase/functions/_shared/billing/planCatalog.ts`) y un contrato de CI exige que coincidan con
los de la pantalla de Planes.

| Plan | Mensual (1 / months) | Anual (12 / months) |
|---|---|---|
| Básico | 15000 | 144000 |
| Pro | 25000 | 240000 |
| Full | 45000 | 432000 |

Coinciden con lo medido en Mercado Pago: los tres anuales en el preflight del 2026-10-01/02 y el
Básico mensual en el cobro real del smoke. El trimestral no se vende (no tiene precio en el
servidor).

---

## 1. Preflight

### 1.1 Secrets (sólo nombres)

```bash
supabase secrets list --project-ref vrdxxmjzxhfgqlnxmbwx
```

| Secret | Uso |
|---|---|
| `MP_ACCESS_TOKEN` | API de Mercado Pago (las dos funciones). **Tiene que ser de la aplicación cuyo webhook está configurado** |
| `MP_WEBHOOK_SECRET` | Firma del webhook. Sin él, `mp-webhook` responde 500 |
| `APP_URL` | Origen del frontend (URL de retorno por defecto y CORS) |
| `MP_CORS_ORIGIN` | Opcional: orígenes extra de CORS |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Automáticos |

Los `MP_PLAN_*` ya no se leen. Pueden quedar cargados: no hacen nada.

### 1.2 Webhook en el panel de Mercado Pago

Ver «Cómo verificarlo» en el segundo hallazgo. **Hacerlo antes del smoke.**

### 1.3 Línea de base

Correr [preflight-readonly.sql](preflight-readonly.sql) y guardar la salida. Todas las filas
`gate:*` tienen que dar `true`.

---

## 2. Deploy (futuro, con autorización)

Orden recomendado: **base → Edge Functions → frontend**.

| Combinación | Qué pasa |
|---|---|
| Migración + funciones actuales (Plan A) | Igual que hoy: los checkouts del Plan A siguen sin poder activar |
| Funciones del Plan B sin la migración | Funciona. La base todavía no impide que un preapproval figure en dos sesiones, pero el código lo trata como error y no activa nada |
| Funciones del Plan B + frontend actual | Funciona: el contrato del navegador no cambió |
| Frontend nuevo + funciones actuales | Funciona: el frontend sólo cambió tipos y un comentario |

### 2.1 Migración

Desde un worktree limpio en el commit del PR:

```bash
supabase db push --dry-run --project-ref vrdxxmjzxhfgqlnxmbwx
```

Tiene que listar **una sola** migración: `20261013120000_beta_mp_plan_b_session_preapproval_unique.sql`.
Si lista otra, parar.

```bash
supabase db push --project-ref vrdxxmjzxhfgqlnxmbwx
```

Corre en una transacción con precondiciones y postcondiciones: si algo no coincide con el
discovery, no aplica nada. Cero DML. Después, [postdeploy-verify-readonly.sql](postdeploy-verify-readonly.sql)
sección 1: todas las filas `check:*` en `true`.

### 2.2 Edge Functions

Las dos con `verify_jwt = false` (declarado en `supabase/config.toml`; el flag es un segundo
seguro).

```bash
supabase functions deploy mp-webhook --no-verify-jwt --project-ref vrdxxmjzxhfgqlnxmbwx
```

```bash
supabase functions deploy mp-subscription --no-verify-jwt --project-ref vrdxxmjzxhfgqlnxmbwx
```

Si la CLI responde «No change found» no redesplegó: repetir con `--use-api`. Verificar con
`supabase functions list` que las dos subieron de versión (v32 → v33, v25 → v26) y siguen con
`verify_jwt = false`.

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

Esperado: `401`, y en el log de la función
`Rejected: invalid signature (… x-signature=no x-request-id=no url-data-id=no)`. Un `500`
significa que falta `MP_WEBHOOK_SECRET`. **Este 401 no certifica el webhook.**

### 2.4 Frontend

Mergear el PR despliega el frontend en Vercel.

---

## 3. Smoke controlado

Con la cuenta real implica un cobro real del plan elegido, que se cancela en el paso 12. Usar el
negocio de prueba (el tenant de QA), nunca el de un cliente. **Pagar con una cuenta de Mercado
Pago distinta de la que cobra**, y anotar si su email es el mismo del usuario de TechRepair Pro
(incógnita 2).

«Consultar» significa correr las secciones 2 a 5 de [postdeploy-verify-readonly.sql](postdeploy-verify-readonly.sql)
con el `business_id` del negocio de prueba.

| # | Paso | Resultado esperado |
|---|---|---|
| 1 | **Crear el checkout.** Con el owner del negocio de prueba, Planes → Básico mensual. | **Si el email del login es el de una cuenta de Mercado Pago:** redirige directo, sin pedir nada. **Si no** (el caso medido): aparece «Necesitamos un dato de Mercado Pago»; en el log, `payer_email_rejected` con `explicit: false` y `detail: "User bad request"`; en la base, una sesión `failed` sin preapproval. Ingresar el email de la cuenta de Mercado Pago que va a pagar → «Continuar con Mercado Pago». En los dos casos termina en una URL `…/subscriptions/checkout?preapproval_id=…`, con una sesión `pending`, `plan_id = basico`, `amount = 15000`, **`mp_preapproval_id` no nulo** e igual al de la URL, y `checkout_opened` en el log. Un 502 `checkout_unavailable`: leer `preapproval_rejected`. Un 502 `mp_unavailable` con `status: 400` trae en `detail` el motivo de Mercado Pago (no era un rechazo del pagador) |
| 2 | **Consultar el preapproval creado.** `GET /preapproval/{id}` con el token. | `status = pending`, `auto_recurring` = 15000 / 1 / months, `payer_email` del usuario. Anotar si trae `external_reference` (incógnita 3) y su `application_id` |
| 3 | **El negocio conserva su acceso mientras no paga.** Volver a la app sin pagar. Consultar. | La fila de `businesses` es idéntica a la del preflight. `/subscription/pending` dice «Verificando tu pago» |
| 4 | **Pagar.** Completar el checkout con la cuenta de Mercado Pago del email usado en el paso 1. | Mercado Pago confirma y vuelve a `/subscription/pending`. Si Mercado Pago rechaza el checkout por la cuenta que paga, es la parte sin medir de la incógnita 2: **PARAR** y anotar el mensaje |
| 5 | **¿Llegó el webhook?** Logs de `mp-webhook`. | `Received type=subscription_preapproval` y una línea `preapproval_evidence` con `kind: "activated"`, `source: "webhook"`. **Si no hay ningún request de Mercado Pago, es el segundo hallazgo: anotarlo y seguir** — el paso 6 activa igual |
| 6 | **Activación.** Consultar (sección 2). | `subscription_status = active`, `subscription_plan = basico`, `access_source = mercado_pago`, `mp_preapproval_id` = el del paso 1, `current_period_end` = la próxima fecha de cobro de Mercado Pago. La sesión quedó `paid`. Un evento `billing_state_applied` con `origen = webhook` **o** `reconcile` (lo que haya llegado primero), `vinculo = preapproval_id` |
| 7 | **«Verificar pago», dos veces.** Mi Suscripción → Verificar pago. | «Tu suscripción al plan Básico está activa.» Sin filas nuevas en `billing_state_applied` y sin cambios en `businesses` |
| 8 | **`payments`.** Consultar (sección 5). | Una fila `recurring`, `status = approved`, importe 15000. Si no aparece: el webhook no llegó (hallazgo 2) o los cobros llegan sólo por `payment` (incógnita 9) |
| 9 | **Cambio de plan.** Planes → Pro mensual. **Sin pagar**, consultar. | Sigue Básico, activo, con el mismo `mp_preapproval_id`. En Mercado Pago la suscripción Básico sigue `authorized` |
| 10 | **Confirmar el cambio.** Pagar el checkout de Pro. | Pasa a Pro con el preapproval nuevo. La suscripción Básico queda **cancelada en Mercado Pago**; un evento `preapproval_superseded` con `processed = true` |
| 11 | **«Actualizar método de pago».** | Abre una página de Mercado Pago de esa suscripción. Si no permite cambiar la tarjeta, es la incógnita 8 |
| 12 | **Cancelar.** Mi Suscripción → Cancelar suscripción → confirmar. | En Mercado Pago figura cancelada; en la base `subscription_status = canceled`; un evento `user_cancelled`. Un 502 «no confirmó la cancelación» es la incógnita 7. Repetir el botón: responde igual, sin un segundo `PUT` |
| 13 | **Webhook duplicado** (sólo si el paso 5 recibió notificaciones). Reenviar una notificación desde el panel. | `{"received":true,"result":"duplicate"}`; sin filas nuevas ni cambios |
| 14 | **Anual.** Planes → Básico anual. Sin pagar: `GET /preapproval/{id}`. | 144000 y la frecuencia que devuelva Mercado Pago (`12` / `months` o `1` / `years`). Cualquier otra cosa se habría visto como 502 en `create` (incógnita 4). No hace falta pagarlo |

Dos controles más:

- **Cross-tenant con un JWT real**: con la sesión de un usuario de otro negocio, llamar a `status`
  con el `business_id` del negocio de prueba. Tiene que responder 403.
- **El preapproval del Plan A sigue sin activar**: después del deploy, «Verificar pago» en el
  negocio del smoke anterior no lo activa; una notificación sobre `33b5f5ad…` quedaría
  `not_applied:unknown_preapproval`.

### Cómo leer un evento que no activó

`subscription_events.error_message` de una notificación procesada:

| Valor | Significado |
|---|---|
| `not_applied:unknown_preapproval` | Ninguna sesión del servidor originó ese preapproval. Es lo esperado para una suscripción creada por fuera (un plan del panel, otra aplicación, el checkout del Plan A) |
| `not_applied:reference_mismatch` | Mercado Pago devuelve una `external_reference` que no es la de la sesión vinculada a ese preapproval. No se activa a nadie: **revisar** |
| `not_applied:terms_mismatch` | Está `authorized`, pero el importe, la moneda o la frecuencia no son los de la sesión. El motivo exacto está en el log (`terms_mismatch` → `problem`). **Revisar en MP**: alguien está pagando algo distinto de lo que vendió el servidor |
| `not_applied:not_authorized` | Todavía no está `authorized` (lo normal mientras no se paga), o es una suscripción que ya no es la vigente |
| `not_applied:superseded_preapproval` | Una suscripción que ya fue reemplazada sigue `authorized`: **revisar en MP**, puede haber dos cobrando |
| `not_applied:unknown_plan` | Suscripción vinculada a un negocio sin plan y sin sesión de origen |
| `not_applied:stale` | Notificación más vieja que el último estado aplicado |
| `unchanged:awaiting_payment` | Sigue `authorized`, pero el último cobro fue rechazado: la mora la levanta un cobro aprobado |
| `ignored:payment_topic_is_not_a_billing_authority` | Notificación `payment`: sólo auditoría |

Un evento `preapproval_superseded` con `processed = false` significa que, en un cambio de plan,
no se pudo cancelar la suscripción anterior: hay que cancelarla a mano en Mercado Pago.

Una sesión `failed` significa que `create` no llegó a entregar un checkout (Mercado Pago no
respondió, rechazó el email del pagador, respondió algo inválido o no se pudo guardar el
vínculo). No tiene preapproval. Su columna `payer_email` dice con qué email se intentó: es un
registro de lo enviado, no una identidad.

Eventos del log de `mp-subscription` sobre el email del pagador (nunca incluyen el email):

| Evento | Significado |
|---|---|
| `payer_email_rejected` · `explicit: false` | Mercado Pago rechazó el email del JWT. El navegador recibió `mp_payer_email_required` |
| `payer_email_rejected` · `explicit: true` | Mercado Pago rechazó también el email que indicó el usuario. El navegador recibió `mp_payer_email_rejected` |
| `mp_unavailable` · `operation: "POST preapproval"` | Otro error de Mercado Pago al crear. `detail` trae su motivo. **No** es un rechazo del pagador |

---

## 4. Rollback

- **Edge Functions**: redesplegar las dos desde `main` en `ecbba69`, con `--no-verify-jwt`.
  Vuelve el Plan A, que no puede activar a nadie: sirve para detener un problema, no para vender.
  Los preapprovals que el Plan B haya creado quedan vinculados en la base; al volver a desplegar
  el Plan B, `reconcile` los recupera.
- **Frontend**: revertir el merge.
- **Base**: no hace falta. Si igual se quiere, el SQL manual está en la cabecera de la migración.

Los datos que escriba el smoke (sesiones, eventos, pagos del negocio de prueba) no se borran: son
el registro de lo que pasó.
