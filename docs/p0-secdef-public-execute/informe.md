# P0 Seguridad — EXECUTE a PUBLIC sobre funciones SECURITY DEFINER

Informe local. **Nada publicado, nada aplicado a producción.**
Rama: `fix/security-secdef-public-execute-p0` · fecha: 2026-08-04

---

## 1. Estado real (medido, no asumido)

| Qué | Valor |
|---|---|
| `origin/main` | `c69ed8d` — *fix(security): superficie publica del portal mayorista via RPC SECURITY DEFINER (FASE 1)* |
| Merge productivo actual | `c69ed8d` (merge de `babf602`) |
| Migraciones en producción | **211** |
| Última migración productiva | **`20260803120000_wholesale_portal_public_rpc`** |
| FASE 1 del portal | **APLICADA** (`get_wholesale_portal_public(text)` existe en prod) |
| `businesses_portal_public_read` | **ACTIVA** (1 policy, sin cláusula `TO` → PUBLIC) |

> Producción **no** está en 210. La suposición de partida era incorrecta: FASE 1
> se mergeó y se aplicó, dejando prod en 211 / `20260803120000`.

Repo y prod están alineados: el último archivo local es exactamente el último
`version` de `supabase_migrations.schema_migrations`.

---

## 2. Reconciliación 173 / 78 / 51 / 20 / 8

Fuente de verdad: `has_function_privilege('anon', oid, 'EXECUTE')` contra
producción. **`proacl IS NULL` no significa "sin permisos"** — significa
*default = PUBLIC*. Es el mismo falso negativo que `aclexplode(NULL)`.

| Corte | N | Definición |
|---|---|---|
| SECURITY DEFINER en `public` | **173** | `prosecdef` |
| Ejecutables por `anon` | **78** | `has_function_privilege` |
| — de esas, trigger-only | 27 | `prorettype = trigger` → PostgREST **no** las expone |
| Invocables como RPC por `anon` | **51** | 78 − 27 · *(el "~50" del worktree quirúrgico)* |
| — con guard real | 31 | 10 `admin_*` + 13 de `auth.uid()` + 6 helpers + `upsert_*` ×2 |
| **Sin ninguna barrera** | **20** | lo que cierra esta migración |
| Allowlist `anon` final | **8** | 2 superficies del portal + 6 helpers de RLS |

**Los números rivales, explicados:**

- **78** → correcto, es el universo `anon`.
- **~50** → correcto: son las 51 invocables por RPC.
- **19** → mi conteo da **20**. El delta es `rls_auto_enable()`, función de
  *event trigger*: la incluyo por completitud del inventario aunque no sea
  explotable (fuera de un event trigger, `pg_event_trigger_ddl_commands()` falla).
- **9** → allowlist propuesta por el worktree amplio. La mía es **8**: no
  incluyo `is_owner_or_admin()` ni `is_platform_admin()` porque **no** aparecen
  en ninguna policy `{public}`, así que `anon` no las necesita para evitar 42501.

**Corrección a los dos informes rivales:** ambos daban `admin_*` como “sin
guard”. No lo están — usan `public._require_platform_admin('<rol>')`. La
heurística de buscar `RAISE EXCEPTION` en el cuerpo no lo ve. Se verificó
leyendo el código de cada una.

---

## 3. Las 20 sin guard, y qué se hizo con cada una

| # | Función | Riesgo | Consumidor | Acción |
|---|---|---|---|---|
| 1 | `bootstrap_owner_profile(text,text,text)` | **P0 escritura** | Onboarding, NoBusiness | guard `auth.uid()` + REVOKE PUBLIC/anon |
| 2 | `recalculate_product_prices(uuid,numeric)` | **P0 escritura** | **ninguno** | guard pertenencia+rol+rango, REVOKE |
| 3 | `pay_card_statement_atomic(9 args)` | **P0 escritura** | **ninguno** | REVOKE total → sólo `service_role` |
| 4 | `get_business_subscription(uuid)` | **P0 lectura PII** | **ninguno** | guard owner/admin + REVOKE total |
| 5 | `get_active_sales_point(uuid)` | **P0 lectura MP** | **ninguno** | REVOKE total |
| 6 | `get_business_subscription_features(uuid)` | paywall cross-tenant | `requireFeature` | guard pertenencia + superficie nueva del portal |
| 7 | `inventory_product_history(uuid,uuid)` | lectura | **ninguno** | REVOKE total |
| 8 | `create_default_payment_buttons(uuid)` | escritura | **ninguno** | REVOKE total |
| 9 | `recalcular_totales_comprobante(uuid)` | escritura financiera | frontend | REVOKE PUBLIC/anon, `authenticated` |
| 10 | `generar_numero_comprobante(text,uuid,text)` | fuga de numeración | frontend | REVOKE PUBLIC/anon, `authenticated` |
| 11 | `generar_numero_garantia(uuid)` | fuga de numeración | frontend | idem |
| 12–14 | `get_or_create_brand` / `get_or_create_model` / `ensure_brand_and_model` | escritura | frontend | idem |
| 15 | `is_comprobante_annulled(uuid)` | oráculo booleano | interno | idem |
| 16 | `is_platform_admin(uuid,text)` | oráculo de admins | policy | REVOKE PUBLIC/anon |
| 17 | `is_owner_or_admin()` | helper | policies `{authenticated}` | REVOKE PUBLIC/anon |
| 18–20 | `enforce_grace_period` / `expire_trials` / `expire_old_invitations` | escritura (cron) | cron | REVOKE total → `service_role` |

Además se cerraron a `anon` **14 funciones de sesión** que la primera corrida de
la postcondición detectó (invitaciones, cambio de rol, `get_my_profile`,
`upsert_*`, etc.). Son inertes para `anon`, pero *inerte* no es *inalcanzable*.

### Hallazgo nuevo: `pay_card_statement_atomic`

Ningún informe rival lo marcó. Valida propiedad contra **`p_user_id`, que elige
el llamador**:

```sql
IF NOT EXISTS (SELECT 1 FROM public.personal_credit_cards
               WHERE id = p_card_id AND user_id = p_user_id) THEN ...
```

La identidad se **afirma**, no se prueba. `anon` podía escribir pagos en las
finanzas personales (Mi Guita) de cualquier usuario. Sin consumidores en el
repo → se cierra por grants en vez de reescribir a ciegas una función de dinero
que nadie llama.

---

## 4. `bootstrap_owner_profile` — contrato nuevo

El cuerpo real es peor que lo reportado: además de promover a `owner` y forzar
`is_active = true`, **borra** perfiles que compartan el email.

Contrato aplicado:

- `anon` y `PUBLIC` bloqueados; sólo `authenticated`.
- La identidad se resuelve desde `auth.uid()`; `p_user_email` pasa a ser una
  **aserción verificada** contra `auth.users`. Email ajeno → `42501`.
- El `DELETE` queda acotado a `COALESCE(user_id,id) = auth.uid()`: un tercero
  que comparta email ya no es alcanzable.
- Rechazo ⇒ **cero cambios** (probado: CASO 6).
- Idempotente: la segunda llamada devuelve el mismo `business_id`.
- Firma intacta (incluido el `DEFAULT`) → los dos call sites siguen andando sin
  cambios: ya mandaban el email de la propia sesión.

## 5. `recalculate_product_prices` — contrato nuevo

Pertenencia + rol `owner|admin|manager` + validación de rango del multiplicador
(antes no validaba nada). Escribe `cost_price`, o sea que alimenta COGS y
`v_finance_pnl`: cross-tenant acá corrompe el P&L. Rechazo ⇒ cero cambios
(probado: CASO 7).

## 6–7. Suscripción y el problema del portal

`get_business_subscription` queda con guard `owner|admin` **y** sin grants para
`anon`/`authenticated` (no tiene consumidores).

Para features se rechazan explícitamente las dos soluciones incompletas —
dejarla abierta a `anon`, o exigir sólo sesión— y se **separan contratos**:

| | Interno | Portal |
|---|---|---|
| Función | `get_business_subscription_features(p_business_id)` | `get_wholesale_portal_features(p_slug)` |
| Acceso | miembros activos del negocio | `anon` + `authenticated` |
| Devuelve | 14 claves (plan, estado, `access_source`, límites) | **2 booleanos**: `mayorista`, `active` |
| Selector | `business_id` | **slug exacto**, sólo portal encendido |

Un usuario registrado de cualquier tenant ya no puede consultar features de otro
negocio por `business_id`. `portalService.createOrder` migró al contrato seguro
y recibe `portalSlug`; `requireFeature` desapareció de `portalService`.

---

## 8. Triggers y helpers

- **27 trigger-only** conservan sus permisos técnicos. PostgREST no expone
  funciones que devuelven `trigger`: no son superficie RPC. Tocarlas no cierra
  nada y arriesga los triggers financieros. Documentado y verificado (CASO 5).
- **6 helpers de RLS** quedan en la allowlist `anon`: `current_business_id` (95
  policies), `is_staff` (81), `current_user_business_id` (53), `can_manage` (20),
  `user_business_ids` (16), `current_user_role` (14). Las 135 policies `{public}`
  de `public` las evalúa también `anon`; revocarlas no devuelve 0 filas, devuelve
  **42501**. Todas derivan de `auth.uid()` → inertes para `anon`.

---

## 9–11. Migración y permisos antes/después

`supabase/migrations/20260804120000_secdef_public_execute_lockdown.sql`
— timestamp nuevo, sin colisión con el `20260803140000` compartido por las dos
ramas rivales.

Transaccional con `BEGIN`/`COMMIT` **explícitos**: se comprobó que el CLI aplica
cada archivo en *autocommit* (sin el bloque, los `SET LOCAL` emiten
`25P01: SET LOCAL can only be used in transaction blocks` y no tienen efecto).
Sin transacción, una postcondición fallida dejaría los `REVOKE` a medio aplicar.

| Rol | Antes | Después |
|---|---|---|
| `anon` — SECDEF RPC-callable | **51** | **8** (allowlist exacta) |
| `authenticated` — SECDEF | **135** | **128** |
| Credenciales (`arca_*`, `whatsapp_*`, `encrypt/decrypt_data`) | cerradas | **cerradas** |

`authenticated` pierde 9 (funciones muertas o de cron que sólo alcanzaba vía
PUBLIC) y gana 2: `get_wholesale_portal_features` y el helper
`_require_business_member`. Neto **−7**, por debajo del baseline. La postcondición
admite `+1` como excepción documentada y el resultado queda holgado.

**Las 5 postcondiciones abortan la migración si fallan.** No es decorativo: la
primera corrida **falló** y detectó que la allowlist estaba incompleta (14
funciones de sesión sin revocar) y que la comparación de firmas usaba nombres de
parámetro en vez de tipos. Ambos defectos se corrigieron antes de seguir.

---

## 12–14. Tests, guards, archivos

**Tests SQL** — `tests/sql/secdef_public_execute_lockdown.test.sql`, 10 casos,
todos verdes. No usa `SET LOCAL ROLE` dentro de `DO` (produce SIGSEGV en el
PostgreSQL local): se verifica por catálogo y por HTTP.

**HTTP con `anon` contra PostgREST local:** las 10 funciones probadas devuelven
**404** — no 403: desaparecieron del schema cache de `anon`. El portal sigue
verde: `get_wholesale_portal_public` → 200 con 7 columnas (sin `mp_payer_email`),
`get_wholesale_portal_features` → `{"active":true,"mayorista":true}`, slug
parcial → `null` (sin enumeración).

**Guard** — `scripts/finance/guard-secdef-exposure.mjs` (`npm run guard:secdef-exposure`),
enganchado en `npm run guards`. **No duplica** `guard-security-definer.mjs`: ése
cubre higiene del cuerpo (`search_path`), éste cubre exposición. Reglas R1–R6:
grants a `anon` fuera de allowlist · SECDEF sin `REVOKE` · `proacl IS NULL` como
prueba de ausencia · grants en bloque · función sensible que pierde su guard ·
**timestamps duplicados** (el incidente que obligó a descartar las dos ramas).
Self-test: 12/12.

| Archivo | |
|---|---|
| `supabase/migrations/20260804120000_secdef_public_execute_lockdown.sql` | nuevo |
| `tests/sql/secdef_public_execute_lockdown.test.sql` | nuevo |
| `scripts/finance/guard-secdef-exposure.mjs` | nuevo |
| `src/portal/portalPublicContract.ts` | +RPC de features, `portalCanOrder` |
| `src/portal/services/portalService.ts` | migrado al contrato seguro |
| `src/portal/pages/PortalCart.tsx` | pasa `portalSlug` |
| `tests/unit/portalPublicContract.test.ts` | +4 tests |
| `package.json` | +2 scripts |

### Validación

| Paso | Resultado |
|---|---|
| `db reset` ×2 | OK — `authenticated 135 → 128`, allowlist 8 |
| Suite SQL nueva (10 casos) | **10/10** |
| Suites SQL existentes (4) | **4/4** |
| HTTP `anon` (10 bloqueadas + 3 portal) | OK |
| `npx tsc --noEmit` | 0 errores |
| `npm run lint:errors` | 0 |
| `npm run test:unit` | **604/604** |
| `npm run test:components` | **56/56** |
| `npm run build` | OK |
| `npm run guards` (cadena completa) | OK |
| Secret scan | sin hallazgos (el repo no tiene gitleaks; barrido por patrones) |

---

## 15. Riesgos residuales

1. **`businesses_portal_public_read` sigue activa.** Esta rama **no** toca la
   FASE 2. `anon` continúa leyendo las 34 columnas de `businesses` de cualquier
   negocio con el portal encendido, incluido `mp_payer_email`. **Este P0 no
   queda cerrado por esta migración** — es una rama aparte.
2. **`business_has_feature(text)`** ya era no-ejecutable por `anon` y aparece en
   12 policies `{public}`. Es una latencia previa, no introducida acá: esas
   tablas no son alcanzables por `anon` hoy. No se tocó.
3. **27 trigger-only** conservan EXECUTE para `anon` (justificado en §8).
4. **`pay_card_statement_atomic` no fue reescrita**, sólo cerrada por grants. Si
   alguna vez se le da un consumidor, hay que ligar la identidad a `auth.uid()`
   antes de reabrirla.
5. El guard es **estático**: no valida la ACL viva. La verificación de permisos
   efectivos la hacen la migración (postcondiciones) y la suite SQL.

## 16. Propuesta de release

Orden **DB primero**, y el frontend puede ir después sin ventana de riesgo:

1. `supabase db push` → aplica sólo `20260804120000` (prod 211 → 212).
   Si una postcondición falla, la transacción revierte sola.
2. Verificar en prod: allowlist = 8, `authenticated ≤ 135`, credenciales cerradas.
3. Publicar el frontend.

**El paso 3 no puede demorarse indefinidamente:** entre 1 y 3, el portal
mayorista **no puede crear pedidos**, porque el frontend viejo llama a
`get_business_subscription_features` con un cliente que no es miembro y ahora
recibe `42501` → `requireFeature` es fail-closed y bloquea la orden. El resto de
la app no se ve afectada. Si esa ventana no es aceptable, invertir el orden
(frontend primero) también es seguro: `get_wholesale_portal_features` no existe
todavía, `portalFeatureAllowsOrders` devuelve `false` y el efecto es el mismo.
La opción sin ventana es desplegar ambos a la vez.

---

# DELTA — Gate final: aislamiento `authenticated` de las funciones retenidas

Reducir la superficie `anon` no demostraba aislamiento cross-tenant. Nueve
firmas seguían siendo invocables por cualquier usuario logueado y aceptaban un
id de entidad **sin verificar que fuera de su negocio**.

## D1. Matriz por función

| Firma | Consumidor | Params del cliente | business_id | Cross-tenant antes | Acción | Grant final |
|---|---|---|---|---|---|---|
| `recalcular_totales_comprobante(uuid)` | `facturacionService` (activo) | `comprobante_id` | **derivado de `comprobantes`** | **sí** — reescribía totales ajenos | guard + derivación | `authenticated` |
| `generar_numero_comprobante(text,uuid,text)` | `comprobanteService` (activo) | `tipo`, `business_id`, `pto` | param, validado | **sí** — leía numeración ajena | guard sobre id efectivo | `authenticated` |
| `generar_numero_garantia(uuid)` | `useWarranties` (activo) | `business_id` | param, validado | **sí** | guard | `authenticated` |
| `get_or_create_brand(text,uuid)` | `api`, `deviceCatalogService` | `name`, `business_id` | param, validado | **sí** — escribía catálogo ajeno | guard | `authenticated` |
| `get_or_create_model(text,uuid,uuid)` | `api`, `deviceCatalogService` | `name`, `brand_id`, `business_id` | param, validado | **sí** + cruce de marca | guard + marca del mismo negocio | `authenticated` |
| `ensure_brand_and_model(text,text,uuid)` | `deviceCatalogService` | `brand`, `model`, `business_id` | param, validado | **sí** | guard propio | `authenticated` |
| `is_comprobante_annulled(uuid)` | **ninguno** | `comprobante_id` | n/a | oráculo | **cerrada** | — |
| `is_platform_admin(uuid,text)` | policy `saa_select_admin` | `user_id` | n/a | oráculo de admins | sólo `auth.uid()` | `authenticated` |
| `is_owner_or_admin()` | 4 policies `{authenticated}` | **ninguno** | n/a | **no** (deriva de `auth.uid()`) | sin cambio | `authenticated` |

**Catálogo (caso D): es POR NEGOCIO, no global.** `brands` y `device_models`
tienen `business_id` y su unicidad lo incluye → guard de membresía obligatorio.

## D2. Guards agregados

Criterio: derivar el `business_id` de la entidad cuando la función recibe un id
de entidad; si el parámetro *es* el `business_id`, validarlo contra el actor;
recién después exigir rol. Rechazo = `42501` **antes** de escribir.
Mensajes genéricos: no distinguen "no existe" de "no es tuyo".

- Financiero/POS: `owner, admin, manager, sales, cashier`.
- Catálogo y garantías: agrega `tech`.
- `get_or_create_model` verifica además que `p_brand_id` sea del mismo negocio.

**Hallazgo del gate:** `trg_recalcular_totales_comprobante_items` llama a
`recalcular_totales_comprobante`, y ese camino **no siempre tiene JWT**
(service_role, webhooks, seeds). El guard tal cual rompía toda escritura de
`comprobante_items` — lo detectó el test, no el review. Se acotó con
`pg_trigger_depth() = 0`: el guard corre sólo en la invocación directa; dentro
del trigger la autorización ya la resolvió RLS. Una RPC por PostgREST siempre
entra con profundidad 0, así que no es falsificable.

## D3. Cerradas por falta de consumidor

`is_comprobante_annulled(uuid)` — sin frontend, sin vista, sin policy; sus
llamadores (`comprobante_payments_annulled_guard`, `replace_comprobante_payment`)
son SECDEF y corren como owner. Se cierra en vez de conservarla.

## D4. `authenticated` antes/después — por firma

**135 → 127.** La postcondición ya no compara conteos: compara **conjuntos por
firma**. Sólo dos altas permitidas, por firma exacta:
`get_wholesale_portal_features(text)` y `_require_business_member(uuid,text[])`.
Cualquier otra firma nueva aborta **aunque el total haya bajado**.

Probado en CASO 11: se cierran dos inocuas y se abre
`arca_get_credential_for_signing` → el total baja de **127 a 126** (la regla por
conteo la deja pasar) y la regla por firma **la detecta**. Es la demostración de
que el conteo no alcanzaba.

## D5. Tests cross-tenant

`tests/sql/secdef_public_execute_lockdown.test.sql` → **19 casos**. Los usuarios
se simulan con `set_config('request.jwt.claims', …)`, que es como resuelve
`auth.uid()`; **no** se usa `SET LOCAL ROLE` dentro de `DO` (SIGSEGV local).

`npm run verify:secdef-cross-tenant` → HTTP/PostgREST con **JWT real** de un
usuario A del negocio A: 10 intentos contra el negocio B dan **403**, 5 flujos
legítimos dan **200**, y tras los rechazos el total de B y su catálogo quedan
**sin cambios**. El script aborta si la API no es local.

## D6. Validación repetida

| Paso | Resultado |
|---|---|
| `db reset` ×2 | OK — `135 → 127`, allowlist 8 |
| Suite SECDEF | **19/19** |
| Suites existentes (4) | **4/4** |
| HTTP `anon` (16 RPC) | todas bloqueadas |
| HTTP `authenticated` cross-tenant | **15/15** + 2 aserciones de cero cambios |
| `tsc` · `lint:errors` | 0 · 0 |
| `test:unit` · `test:components` · `build` | 604/604 · 56/56 · OK |
| `guards` (cadena completa) | OK |
| Secret scan · diff check | sin hallazgos · sólo los 4 archivos previstos |

## D7. Riesgo residual del delta

`recalcular_totales_comprobante` confía en RLS de `comprobante_items` cuando
corre dentro del trigger. Es correcto —ahí la fila ya pasó por RLS— pero implica
que la protección de ese camino es la policy de `comprobante_items`, no el guard.
Queda documentado en el cuerpo de la función.

Los riesgos 1–5 de §15 siguen vigentes; en particular **FASE 2 sigue sin hacerse**.

---

## 17. Recomendación

**GO para hotfix**, con la salvedad del §16: coordinar DB y frontend para no
dejar el portal sin pedidos más de lo necesario.

Cierra 5 P0 confirmados leyendo código, uno de ellos (`pay_card_statement_atomic`)
que ninguna de las dos ramas rivales había detectado. Reduce la superficie `anon`
de 51 RPC a 8, sin ampliar `authenticated` y sin reabrir credenciales.

**No cierra** el P0 del portal (`businesses_portal_public_read`): eso es FASE 2 y
debería ser el siguiente lote.
