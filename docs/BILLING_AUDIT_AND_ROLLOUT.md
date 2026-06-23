# Auditoría de Planes, Suscripciones y Cobros (Mercado Pago) — 2026-06-23

Proyecto Supabase: `vrdxxmjzxhfgqlnxmbwx` (techrepair-pro, Postgres 17).
**Nada de esto se aplicó en producción.** Todo es código + migraciones idempotentes
para revisión y rollout por etapas.

---

## 1. Arquitectura encontrada

- **Modalidad MP:** Suscripciones con **Preapproval Plan** (`preapproval_plan_id`).
  El alta **no** crea el preapproval por API: `mp-subscription` (action `create`)
  arma la URL `mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=…&external_reference=<business_id>`
  y redirige. La activación depende del **webhook** (`mp-webhook`), que resuelve el
  negocio por `mp_preapproval_id` o por `external_reference`.
- **Flujo de alta:** `Plans.tsx → createSubscription → mp-subscription(create) → init_point → checkout MP → /subscription/pending (polling) → webhook → businesses.subscription_status='active' → realtime → success`.
- **Flujo de webhook:** `payment | subscription_preapproval | subscription_authorized_payment` → re-fetch contra API MP → update `businesses` + `payments` + `subscription_events`.
- **Renovación:** `subscription_authorized_payment` → `/authorized_payments/{id}` → `/v1/payments/{payment_id}` → approved⇒active+period; rejected⇒past_due+grace 3d.
- **Cancelación:** `mp-subscription(cancel)` → `PUT /preapproval/{id} {status:cancelled}` + DB `canceled`; webhook confirma.
- **Fuente de verdad:** columnas en `businesses` + ledger `payments` + log `subscription_events`. Entitlements server: RPC `get_business_subscription_features`. Espejo cliente: `src/config/planFeatures.ts`.
- **Tablas:** `businesses` (estado), `payments` (ledger canónico), `subscription_events` (log webhook), `subscription_checkout_sessions` (sesión checkout), `subscription_payments` (duplicado, deprecado), `blocked_feature_attempts` (auditoría de gating).

### Reglas comerciales — verificación
| Regla esperada | Implementación | Estado |
|---|---|---|
| Básico $15.000 / Pro $25.000 / Full $45.000 | `subscription.ts` PLANS | ✅ coincide |
| Trial 14 días | `businesses.trial_ends_at DEFAULT now()+14d` | ✅ |
| Trial = features Pro | `TRIAL_FEATURES = PLAN_FEATURES.pro` | ✅ |
| Mi Guita: Básico no / Pro,Full,Trial sí | `planFeatures.ts` ✅ pero **faltaba en el RPC server** | ⚠️ corregido |
| Full multisucursal + 10 usuarios | `PLAN_FEATURES.full` | ✅ |
| Doc setup precios | `$4.900/$9.900/$19.900` (viejos) | ❌ corregido a $15.000/$25.000/$45.000 |

---

## 2. Hallazgos

### CRÍTICO

**C1 — Auto-activación por escritura directa a `businesses`.**
`businesses_update` (RLS) permite a cualquier `owner/admin` actualizar la fila sin
restricción de columna y **no hay trigger protector** (`businesses` sólo tiene
`update_businesses_updated_at`). Un dueño puede ejecutar desde la consola:
`supabase.from('businesses').update({subscription_status:'active',subscription_plan:'full'})`.
Las funciones “admin” (`subscriptionService.adminActivateBusiness`, etc.) hacían
exactamente eso desde React.
- Impacto: cualquier negocio se otorga Full/trial infinito sin pagar.
- Fix: trigger `protect_subscription_columns` (Stage D) + RPCs admin auditadas (Stage C) + frontend reescrito a RPCs.
- Test: `tests/sql/billing_security.test.sql` T1/T4/T8; `tests/unit/billingContracts.test.ts`.

**C2 — El pipeline MP nunca corrió en producción; 7 “active” sin pago verificable.**
`subscription_events=0`, `payments=0`, `subscription_checkout_sessions=0`. Los 7
negocios `active` tienen `mp_preapproval_id = NULL` → activados por escritura directa,
sin registro de pago. (Matriz en §5.)
- Impacto: acceso pago sin pago; estados imposibles (`active` con período vencido).
- Fix: clasificarlos como `manual_grandfathered` (Stage E, con preview) sin inventar IDs/pagos MP; separar “pagado MP” de “manual” vía `access_source`.

### ALTO

**A1 — Trials eternos.** `pg_cron` no instalado → `expire_trials()`/`enforce_grace_period()`
nunca se ejecutan. 9 trials vencidos siguen `trialing` con acceso Pro; 1 negocio con
`trial_ends_at = NULL`. El cliente trata `trialing` como acceso full sin mirar la fecha.
- Fix: Stage E agenda pg_cron (con preview de filas afectadas) + guard de `trial_ends_at` NULL; helpers `isTrialExpired/isAccessEffective` (`src/lib/mpStatus.ts`) + tests.

**A2 — Webhook frágil.** `mp-webhook`: (a) procesa con fire-and-forget y responde 200
antes de terminar → el isolate puede morir y perder la activación; (b) la firma se
**omitía** si faltaba el secret o los headers; (c) idempotencia sin índice único →
carrera de webhooks duplicados.
- Fix: `await` del procesamiento; firma **obligatoria** (sin secret⇒500, inválida⇒401, comparación de tiempo constante); claim idempotente vía índice único `(provider,event_type,external_id)`; tolerancia a eventos fuera de orden (`mp_last_modified`).
- Test: `tests/unit/billingContracts.test.ts`.

**A3 — `get_business_subscription_features` inseguro/incompleto.** SECURITY DEFINER **sin
`search_path`** (inyección); **omite `personal_finance`** (⇒ `requireFeature('personal_finance')`
lanzaría `FEATURE_NOT_AVAILABLE`); `mayorista` inconsistente (trial sí / pro no).
- Fix: Stage A reescribe el RPC (agrega `personal_finance`, alinea `mayorista` a Full-only, `SET search_path`). Snapshot pre-cambio en `_legacy/`.

### MEDIO

**M1 — Drift de esquema.** `subscription_checkout_sessions`, `subscription_payments`,
`blocked_feature_attempts` existen en prod pero **no** en migraciones del repo.
- Fix: Stage A las captura con `CREATE TABLE IF NOT EXISTS` (no altera datos).

**M2 — Historial de pagos leía la tabla equivocada.** `getSubscriptionPayments` leía
`subscription_payments` (siempre vacía); el ledger real es `payments`.
- Fix: repuntado a `payments`. `subscription_payments` queda deprecada.

**M3 — `FEATURE_REQUIRED_PLAN.mayorista` decía `'pro'`** (mayorista es Full-only) → copy de upgrade incorrecto. Corregido a `'full'`.

**M4 — `SubscriptionSuccess` afirmaba “activada” sin confirmar.** Ahora exige `isActive`.

**M5 — CORS de `mp-subscription` con origin hardcodeado** (posible desync con el dominio real). Ahora configurable por `MP_CORS_ORIGIN`/`APP_URL`.

**M6 — Doc `MERCADOPAGO_SETUP.md` con precios viejos.** Corregido + nota de fuente de verdad.

### BAJO
- Comparaciones de estado dispersas → centralizadas en `src/lib/mpStatus.ts` (tipadas, testeadas).
- `Plans.tsx` ofrece sólo mensual/anual (sin trimestral) aunque el modelo soporta los 3 ciclos. (No corregido; sin impacto de seguridad.)

### Cosas correctas (sin cambio)
- `MP_ACCESS_TOKEN` sólo en Edge Functions; public key no expuesta; sin secretos hardcodeados en billing.
- `v_subscription_overview` es `security_invoker=true` → no filtra otros negocios.
- `requireFeature` es fail-closed.

---

## 3. Archivos

**Nuevos**
- `supabase/migrations/20260623_100_billing_stageA_drift_and_constraints.sql`
- `supabase/migrations/20260623_101_billing_stageA_entitlements_rpc.sql`
- `supabase/migrations/_legacy/get_business_subscription_features_pre_audit.sql`
- `supabase/migrations/20260623_120_billing_stageC_admin_roles_audit.sql`
- `supabase/migrations/20260623_121_billing_stageC_admin_rpcs.sql`
- `supabase/migrations/20260623_140_billing_stageD_protect_trigger.sql`
- `supabase/migrations/20260623_160_billing_stageE_data_normalization.sql`
- `supabase/migrations/20260623_161_billing_stageE_scheduling.sql`
- `src/lib/mpStatus.ts`
- `tests/unit/planEntitlements.test.ts`, `tests/unit/mpStatus.test.ts`, `tests/unit/billingContracts.test.ts`
- `tests/sql/billing_security.test.sql`
- `docs/BILLING_AUDIT_AND_ROLLOUT.md` (este archivo)

**Modificados**
- `supabase/functions/mp-webhook/index.ts` (reescrito: firma, await, idempotencia, orden)
- `supabase/functions/mp-subscription/index.ts` (CORS por env)
- `src/services/subscriptionService.ts` (admin → RPCs; historial → `payments`; `access_source`)
- `src/pages/AdminSubscriptions.tsx` (gate platform-admin; motivo obligatorio; badge access_source)
- `src/pages/SubscriptionSuccess.tsx` (confirma activación real)
- `src/config/planFeatures.ts` (mayorista Full-only)
- `src/types/subscription.ts` (`AccessSource`, campos nuevos)
- `MERCADOPAGO_SETUP.md` (precios + fuente de verdad)

---

## 4. Cambios de base de datos (resumen)
- **Constraints/índices:** `uq_subscription_events_dedupe`, `uq_businesses_mp_preapproval_id`, `businesses_access_source_chk` (NOT VALID).
- **Columnas:** `businesses.{access_source,override_*,mp_last_modified}`, `subscription_events.processed_at`.
- **RPC:** `get_business_subscription_features` (fix); `is_platform_admin`, `current_platform_admin_role`; 7 RPCs admin + `admin_list_subscriptions`.
- **Triggers:** `trg_protect_subscription_columns`.
- **RLS/Tablas:** `system_admins` extendida con `role`/`is_active`/auditoría (reusa el allowlist existente, no crea tabla nueva); `subscription_admin_actions` (append-only); captura de 3 tablas drift.
- **Reparación de datos:** clasificación `manual_grandfathered` de 7 cuentas (con preview); fix `trial_ends_at` NULL.
- **Cron:** `pg_cron` para expiry de trials/gracia (gated).

---

## 5. Matriz de las 7 cuentas activas (sin mp_preapproval_id)

| business_id | plan | provider | period_end | trial_ends | origen probable | acción |
|---|---|---|---|---|---|---|
| aa930802… | full | mercadopago | **2099-12-31** | null | override permanente (SQL directo) | grandfather (sin vencimiento) |
| e7610990… | basico | mercadopago | 2026-06-12 | 2026-05-27 | UPDATE directo batch 05-13 19:49 | grandfather |
| f6262268… | pro | mercadopago | 2026-06-12 | 2026-05-27 | UPDATE directo batch 05-13 19:49 | grandfather |
| a69a72e4… | full | mercadopago | 2026-06-12 | 2026-05-27 | UPDATE directo batch 05-13 19:49 | grandfather |
| d93dfda8… | pro | manual | 2026-06-11 | 2026-05-26 | activación manual batch 05-12 23:11 | grandfather |
| 128209d4… | full | manual | 2026-06-11 | 2026-05-26 | activación manual batch 05-12 23:11 | grandfather |
| 7642f30c… | basico | manual | 2026-06-11 | 2026-05-26 | activación manual batch 05-12 23:11 | grandfather |

Ninguna tiene suscripción MP real. **No desactivar.** Clasificar como
`manual_grandfathered` (Stage E) preservando plan/acceso; sin inventar pagos ni IDs MP.
Nota: 6 de 7 tienen `current_period_end` ya vencido (estado imposible `active`+período
pasado) → por eso `override_expires_at = NULL` (acceso legado gestionado), a migrar a
suscripción MP real cuando paguen.

---

## 6. Plan de rollout por etapas (orden exacto)

> Validar primero en un **branch de Supabase** o stack local:
> `supabase db push` (branch) → `psql -f tests/sql/billing_security.test.sql`.

### Etapa A — esquema (no bloqueante)
- Preflight: `select count(*) from subscription_events;` (esperado 0).
- Aplicar `20260623_100`, `20260623_101`.
- Postflight: `select proname, proconfig from pg_proc where proname='get_business_subscription_features';` (debe tener `search_path`); `select obj_description` de columnas nuevas.
- Rollback: ver pie de cada archivo + `_legacy/` para el RPC.

### Etapa B — backend / Edge Functions
- Setear secrets: `MP_WEBHOOK_SECRET`, `MP_CORS_ORIGIN` (o `APP_URL`).
- `supabase functions deploy mp-webhook && supabase functions deploy mp-subscription`.
- Postflight: enviar webhook de prueba firmado (sandbox) → 200; firma inválida → 401; sin secret → 500.

### Etapa C — admin seguro (RPCs + auditoría)
- Aplicar `20260623_120`, `20260623_121`. Reusa `system_admins` (no crea tabla nueva):
  las filas existentes quedan `role='super_admin', is_active=true` → **no hay que sembrar nada**,
  los admins actuales siguen funcionando. Para agregar un `billing_admin` luego:
  `select public.admin_grant_role('<user_id>','billing_admin','motivo');` (sólo super_admin).
- Deploy del frontend (ya usa las RPCs + `is_active`). Verificar panel admin.
- Postflight: `tests/sql/billing_security.test.sql` (T4/T6/T7/T8/T9).

### Etapa D — trigger protector
- Confirmar que **no** quedan escrituras directas legítimas (panel ya usa RPCs).
- Aplicar `20260623_140`.
- Postflight: T1/T3 de `billing_security.test.sql` (cliente bloqueado; webhook/RPC siguen funcionando).

### Etapa E — datos + expiración
- **Preview** (correr antes): las queries `PREFLIGHT` dentro de `20260623_160` y `_161` (deben listar 7 grandfather y los 9 trials vencidos).
- Resolver `trial_ends_at` NULL (incluido).
- Aplicar `20260623_160` (grandfather, con safety rail >10).
- **Decidir** sobre los 9 trials vencidos (extender vía `admin_extend_trial` / convertir / aceptar suspensión) **antes** de `20260623_161`.
- Aplicar `20260623_161` (pg_cron). Postflight: `select jobname, schedule from cron.job;`.

---

## 7. Checklist manual — sandbox Mercado Pago
Usar credenciales **TEST** (nunca producción). Tarjetas en `MERCADOPAGO_SETUP.md` §12.
1. **Alta:** elegir plan → checkout → pagar con tarjeta de aprobación → volver a `/subscription/pending` → verificar que el webhook llega (`subscription_events`) y `businesses.subscription_status='active'`, `access_source='mercado_pago'`.
2. **Aprobado:** confirmar `payments` con `status='approved'`.
3. **Rechazado:** tarjeta de rechazo → `past_due` + `grace_until` ~3 días.
4. **Pendiente:** pago pendiente → pantalla “confirmando”, sin activar desde la URL.
5. **Renovación:** disparar `subscription_authorized_payment` → period_end actualizado.
6. **Cancelación:** botón cancelar → `PUT /preapproval cancelled` → webhook → `canceled`.
7. **Webhook repetido:** reenviar el mismo evento → 1 sola fila procesada (idempotente).
8. **Webhook inválido:** firma incorrecta → 401, sin cambios.
9. **Cambio de plan:** desde `/subscription/plans`.

---

## 8. Variables de entorno (sólo nombres)
**Edge Function secrets** (`supabase secrets set`): `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`,
`APP_URL`, `MP_CORS_ORIGIN` (opcional), `MP_PLAN_{BASICO,PRO,FULL}_{MONTHLY,QUARTERLY,ANNUAL}`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (auto), `SUPABASE_ANON_KEY` (auto).
**Frontend** (`.env.local`, públicas): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_MP_PLAN_*` (IDs de plan, no secretos), `VITE_APP_URL`.

---

## 9. Pruebas ejecutadas
- `npm run typecheck` → **0 errores**.
- `npm run test:unit` → **91 pass / 0 fail** (24 nuevas de billing).
- `npm run lint:errors` → **0 errores** (gate del proyecto).
- `npm run build` → **OK** (built in ~10s).
- `npm run lint:ci` (budget 100 warnings) → falla con **644 warnings**, que es la
  **línea base preexistente** del repo (no introducida por estos cambios; los archivos
  tocados no agregan errores ni warnings nuevos relevantes).
- `tests/sql/billing_security.test.sql` → **requiere** branch/local con migraciones
  aplicadas (no se corrió contra producción).
- **Branch de Supabase:** intentado, **rechazado** (`Branching is supported only on the
  Pro plan or above`) — sin cargo. Validación alternativa: verificación read-only de que
  **todas las dependencias** de las migraciones existen en prod (`businesses`, `profiles`,
  `payments`, `subscription_events`, `system_admins`, `auth.users`,
  `current_user_business_id()`, `current_user_role()`, `expire_trials()`,
  `enforce_grace_period()`, `get_business_subscription_features()`) → **todas presentes**.
  Las migraciones aplicarán contra el esquema real (excepto `pg_cron` en Stage E, gateado).
  Para validación completa: `supabase start && supabase db push` en local + correr el test SQL.

---

## 10. Riesgos pendientes
- **Mapeo preapproval↔negocio depende de `external_reference`** en la URL del checkout de
  plan. Hay que verificar en sandbox que MP lo propaga al preapproval; si no, agregar
  creación del preapproval por API para fijar `external_reference`/`mp_preapproval_id` al alta.
- **6 de 7 cuentas tienen período vencido** pero siguen `active`; quedan como legado
  gestionado hasta migrarlas a MP real.
- **pg_cron** puede requerir habilitación de extensión en el plan de Supabase; si no está
  disponible, usar el scheduler alternativo documentado en `20260623_161`.
- Migraciones **no aplicadas ni validadas en una DB**; correr `billing_security.test.sql`
  en un branch antes de producción.
