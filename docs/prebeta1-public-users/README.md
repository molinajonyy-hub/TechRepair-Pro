# PRE-BETA-1 · `public.users` — aislamiento cross-tenant

> **Estado: CANDIDATO · SIN MERGE · SIN DEPLOY · SIN `db push`.** Nada de esto se aplicó a producción.
> Toda consulta a producción fue read-only (catálogo, conteos y logs; ninguna PII volcada).

**Pregunta del lote:** ¿`public.users` puede seguir siendo alcanzada por un usuario de un tenant para leer o
modificar información de otro tenant?
**Respuesta con el candidato aplicado: NO** (evidencia en §7).

---

## 0. Identidad

| Chequeo | Resultado |
|---|---|
| `HEAD == origin/main` | `f828899` (merge de #151), árbol limpio |
| Última migración del repo | `20261009120000_g2c3a3_inventory_authority_lockdown.sql` |
| Última migración de producción | `20261009120000` (`g2c3a3_inventory_authority_lockdown`), 280 filas en el ledger |
| Proyecto de producción | `vrdxxmjzxhfgqlnxmbwx` (`techrepair-pro`, us-east-1, PostgreSQL 17.6) — el único del org |
| `public.users` existe | sí en producción y en el replay local (`supabase db reset`, CLI 2.109.1, 280 migraciones) |

## 1. Contrato real de `public.users`

### 1.1 Esquema (catálogo de producción = replay)

| Aspecto | Valor |
|---|---|
| Columnas | `id uuid NOT NULL DEFAULT gen_random_uuid()`, `name text NOT NULL`, `email text NOT NULL`, `role text NOT NULL`, `phone text`, `active boolean DEFAULT true`, `created_at timestamptz DEFAULT now()`, `created_by uuid` |
| **Sin `business_id`** | ninguna columna relaciona la fila con un negocio |
| PK / UNIQUE / CHECK | `users_pkey (id)`, `users_email_key (email)` (UNIQUE **global**), `users_role_check` (`admin`/`technician`/`receptionist`) |
| FK saliente | `users_created_by_fkey`: `created_by → auth.users(id)` |
| FK entrante | **una**: `orders_technician_id_fkey`: `orders.technician_id → users(id) ON DELETE SET NULL` |
| Índices | `users_pkey`, `users_email_key` |
| Triggers | ninguno |
| Owner / RLS / FORCE RLS | `postgres` / on / off |
| ACL de tabla (prod) | `postgres=arwdDxtm`, `anon=arwdDxtm`, `authenticated=arwdDxtm` (el replay no tiene la `m` = MAINTAIN de PG17) |
| ACL de columna | ninguna |
| `service_role` / `PUBLIC` | sin privilegios |
| Publicación realtime | no |

| Policy | Comando | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `users_select` | SELECT | authenticated | `true` | — |
| `users_insert` | INSERT | authenticated | — | `current_user_role() = ANY ('{owner,admin}')` |
| `users_update` | UPDATE | authenticated | `current_user_role() = ANY ('{owner,admin}')` | ídem |
| `users_delete` | DELETE | authenticated | `current_user_role() = ANY ('{owner,admin}')` | — |

`current_user_role()` (SECURITY DEFINER) devuelve el rol del perfil activo del usuario **en cualquier negocio**:
ninguna policy relaciona la fila con un tenant.

### 1.2 Datos (sólo conteos/estructura)

| Medida | Producción |
|---|---|
| Filas | 3 (1 `admin`, 2 `technician`; creadas el mismo día de abril) |
| `id` presente en `auth.users` | 0 |
| `email` presente en `auth.users` | 0 |
| `id` presente en `profiles` (`id`/`user_id`) | 0 |
| `email` presente en `profiles` | 0 |
| `created_by` no nulo | 0 |
| Relación derivable con un negocio | **ninguna** (no hay columna, ni FK, ni `created_by`, ni match por identidad) |
| Órdenes con `technician_id` no nulo | 0 de 130 (0 referencian `public.users`) |
| Órdenes con `assigned_profile_id` | 15 (el modelo moderno) |
| Tráfico API (edge_logs, 72 h, ~5.800 requests al gateway) | 0 a `/rest/v1/users`, 0 embeds `users(` |

Las 3 filas son huérfanas y nadie las usa.

### 1.3 Consumidores

**Base de datos** (producción, catálogo): 0 funciones de schemas de app que la nombren (las únicas menciones a
`'users'` son el literal de la capability RBAC), 0 vistas/reglas, 0 policies de otras tablas, 0 triggers,
0 publicaciones, 0 jobs de `pg_cron`. **Edge Functions:** 0.

**Repo:**

| Archivo | Función / componente | Operación | Para qué | ¿Alcanzable en UI? | Modelo correcto hoy |
|---|---|---|---|---|---|
| `src/pages/Reports.tsx` | `Reports` → consulta de órdenes completadas | SELECT embed `technician:users(name)` | ranking "Técnicos con más cierres" | **sí** (`/reports`) | `profiles` vía `assigned_profile_id` (lote aparte) |
| `src/hooks/useOrderSimple.ts` | carga inicial y `refresh` | SELECT `.from('users')` (2) | nombre del técnico en el detalle/impresión | **sí** (`OrderDetail`), pero sólo si `technician_id` ≠ NULL: nunca en prod | ídem |
| `src/services/api.ts` | `ordersService.getAll` / `getById` | SELECT embed `technician:users(id, name)` | técnico en listados/detalle legacy | no: sus únicos callers (`src/hooks/index.ts`) no se importan; `getById` sí lo usa el test de integración SEC-08E R1 | ídem |
| `src/services/api.ts` | `usersService` (legacy) | SELECT/INSERT/UPDATE/DELETE | CRUD de la tabla vieja | **no** (código muerto; la gestión del equipo usa `src/services/usersService.ts` → `business_users_view`/RPC) | `profiles` / `business_users_view` |
| `src/hooks/useOrder.ts` | `useOrder` | SELECT embed `technician:users(id, name)` | detalle legacy | no (sin importadores) | ídem |
| `scripts/test-supabase.ts` | `testConnection` | SELECT `.from('users')` | probe de conexión | no (script suelto; su import `./src/lib/supabase` ni resuelve) | — (sin cambios) |
| `supabase/_archive/**`, `supabase/seed.sql` | scripts históricos | varias | — | no (archivo; `[db.seed] enabled = false`) | — |
| `src/data/mockData.ts`, `src/pages/Users.tsx` | mocks | ninguna | — | `Users.tsx` usa datos mock, no la base | — |

Riesgo que el discovery hizo visible: con el embed `technician:users(...)`, revocar SELECT hace fallar **la
consulta padre entera** con 42501 (PostgREST no degrada el embed). Sin tocar el frontend, `/reports` habría
mostrado 0 órdenes completadas.

## 2. El bypass ANTES (replay idéntico a producción)

Fixture A/B (owner, admin, tech, sales en A; owner, tech en B). Filas legacy `LA`/`LB` "del técnico de A/B".

- **SQL** (`tests/sql/prebeta1_public_users_baseline.test.sql`, como la API): 10 huecos reproducidos —
  tech de A lee email/teléfono de B; owner/admin de A hacen UPDATE (incluido `role`) y DELETE de la fila de B;
  owner de A inserta filas arbitrarias; owner de B pisa la de A; TRUNCATE latente para anon/authenticated.
  → `evidence/before_sql_negative_control.log`
- **HTTP real** (`scripts/security/prebeta1-users-postgrest.mjs --baseline`, JWT firmados): los mismos huecos
  por PostgREST **y por GraphQL** (`usersCollection`), y el embed del front respondiendo 200.
  → `evidence/before_postgrest_negative_control.log`
- **Guard global** sobre ese catálogo (idéntico a producción, ver `evidence/production_catalog_equivalence.md`):
  pin + 5 hallazgos, todos de `public.users`. → `evidence/before_guard_catalog.log`

## 3. Decisión: **opción A** (retirar de la API) + limpieza de consumidores muertos

- **No C:** no existe una relación real fila→tenant (sin `business_id`, sin FK, `created_by` NULL, 0 matches
  por identidad). Inventarla violaría el discovery.
- **No B:** ningún flujo vivo necesita la tabla. Los consumidores vivos leen por `orders.technician_id`, que es
  NULL en el 100% de las órdenes y nadie escribe: hoy ya devuelven vacío. Migrar el técnico a
  `assigned_profile_id` es el bug explícitamente excluido de este lote.
- **A:** la tabla se conserva (cero DML sobre las 3 filas) y queda inaccesible para anon, authenticated y
  service_role. Se quitan del frontend las lecturas/embeds (comportamiento visible idéntico: técnico vacío /
  "Sin asignar") porque, si no, el REVOKE rompería `/reports`.

## 4. Migración `20261010120000_prebeta1_public_users_api_retirement.sql`

Posterior a A3. `BEGIN/COMMIT` explícitos, `search_path` fijado, **cero DML**.

Precondiciones (cualquier diferencia → `RAISE`, nada se aplica):
1. tabla existe, `relkind r`, owner postgres, RLS on / FORCE off, sin herencia;
2. A3 es la última migración aplicada y no hay un `prebeta1` en el ledger;
3. columnas = snapshot (nombre, tipo, NOT NULL);
4. constraints propios + **una** FK entrante (`orders.technician_id`) exactos;
5. las 4 policies con su texto exacto (detecta un PRE-BETA-1 parcial);
6. ACL exacto como conjunto (MAINTAIN de anon/authenticated opcional por PG17; cualquier otro grantee o
   privilegio, o uno faltante → aborta), sin ACL de columna, ningún rol de API miembro de postgres;
7. consumidores en base = 0 (triggers, publicación, vistas/reglas, funciones de app, `pg_cron`);
8. `orders.technician_id` sin uso (si alguien empezó a usarlo, retirar la tabla cambiaría lo que ve el usuario).

Cierre: `DROP POLICY` ×4 · `REVOKE ALL ON public.users FROM PUBLIC, anon, authenticated, service_role`
(MAINTAIN incluido) · `COMMENT ON TABLE` · RLS queda on sin policies (deny-by-default ante un GRANT futuro).

Postcondiciones: 0 policies y RLS on; ningún grantee distinto del owner; `has_table_privilege` /
`has_any_column_privilege` falsos para anon, authenticated, service_role y authenticator; forma, constraints,
índices, cantidad de filas y **huella md5 del contenido** idénticos; `current_user_role()` intacta; FK
`orders_technician_id_fkey` intacta.

Matriz de precondiciones (`scripts/security/prebeta1-precondition-matrix.mjs`, 36 verificaciones): aplica completa
en el replay, en un estado **production-like** (MAINTAIN + 3 filas huérfanas) y con MAINTAIN parcial; aborta en
su precondición en 20 drifts (FORCE/DISABLE RLS, ledger, columna nueva, FK nueva, policy faltante/reescrita/extra,
grants extra a service_role/PUBLIC, REVOKE parcial, ACL de columna, vista, función calificada y sin calificar,
trigger, publicación, `technician_id` en uso) sin dejar rastro. → `evidence/precondition_matrix.log`

## 5. Frontend

| Archivo | Cambio |
|---|---|
| `src/pages/Reports.tsx` | la consulta de completadas pide sólo `updated_at`; el ranking agrupa en "Sin asignar" (lo que ya mostraba) |
| `src/hooks/useOrderSimple.ts` | sin lecturas a `users`; `technician` queda `null` (como ya quedaba) |
| `src/services/api.ts` | `getAll`/`getById` sin el embed; se retira `usersService` legacy (sin callers) |
| `src/hooks/useOrder.ts` | sin el embed (código sin importadores) |

`tests/components/prebeta1PublicUsersRetired.test.tsx` simula el PostgREST post-fix (cualquier request a `users`
o con embed `users(` → 42501): OrderDetail carga y refresca sin consultar `users`, `ordersService` responde,
y Reports sigue contando las órdenes completadas. **Control negativo:** contra el `src` de `main` los 4 tests fallan.

## 6. Guard global anti-reincidencia (`scripts/guards/tenant-isolation.mjs`)

- **Catálogo** (base local; `tenant-isolation-catalog.sql` es un único SELECT, sirve igual contra producción):
  para cada tabla de `public` expuesta a anon/authenticated evalúa las policies PERMISSIVE aplicables:
  `USING_TRUE`, `CHECK_TRUE`, `SIN_ANCLA` (no referencia una columna clave propia —`business_id`, `id`,
  `user_id`, `owner_user_id`, `auth_user_id`, `created_by`, `profile_id`, `assigned_profile_id` o FK— o no llama a
  una fuente de identidad —`auth.uid()`/`auth.jwt()`/helper de `public`/`private`—; columnas y funciones salen
  de `pg_depend`), `RLS_OFF`; marca **GLOBAL** los hallazgos en tablas sin `business_id` y lista esas tablas
  (hoy 11, todas ancladas: tablas por usuario `user_id = auth.uid()` y la raíz del tenant `businesses`).
  Pin PRE-BETA-1: `public.users` sin grantees, sin ACL de columna, sin acceso de anon/authenticated/service_role,
  sin policies.
- **Allowlist** (`GLOBAL_ALLOWLIST`): tabla + razón + acceso (`rol:comando`); suprime sólo ese acceso; `users`
  no puede entrar; una entrada vieja falla. Hoy vacía (no hay tablas globales legítimas expuestas).
- **Deuda preexistente** (`DEUDA_PREEXISTENTE`, separada de la allowlist, **no** legítima): hoy
  `customer_events.ce_insert` (`WITH CHECK (true)` para INSERT de authenticated). Se reporta en cada corrida y
  trinquetea: si se arregla, la entrada queda vieja y el guard falla hasta quitarla.
- **Estático** (`--static`, job `quality`, sin DB): `src/` y `supabase/functions/` no consultan `public.users`;
  ninguna migración posterior le vuelve a dar GRANT/policy, debilita su RLS ni hace `GRANT … ON ALL TABLES`.
- **Self-tests:** catálogo 19 casos con mutaciones reales en `BEGIN/ROLLBACK` (reabrir users por policy, por
  GRANT y para service_role; `USING (true)`; `WITH CHECK (true)`; SELECT global por RLS off y por policy de
  rol; UPDATE/DELETE global de owner/admin; ancla falsa con columna no clave; tabla global insegura nueva con y
  sin RLS; trinquete de deuda; controles sin falso positivo: tabla por usuario, policy sólo service_role, tabla
  global de allowlist; allowlist sólo cubre el acceso declarado; allowlist vieja; users en allowlist).
  Estático 10 casos (incluye controles `getBusinessUsers(`, `business_users_view`, `auth.users`).

Resultado: ANTES (= producción) `evidence/before_guard_catalog.log` → falla por `public.users`; DESPUÉS
`evidence/after_guard_catalog.log` → 0 violaciones, pin cumplido, 1 deuda reportada.

## 7. DESPUÉS (migración aplicada con la CLI sobre el replay limpio)

`evidence/migration_apply.log` (una fila en el ledger) y `evidence/after_test_prebeta1.log` (`npm run test:prebeta1`):

- **SQL como la API** (`tests/sql/prebeta1_public_users_isolation.test.sql`): matriz de 88 casos
  (owner/admin/tech/sales de A, owner/tech de B, anon, service_role × SELECT propia/ajena/listado/columna,
  INSERT, UPDATE propia/ajena, DELETE propia/ajena, TRUNCATE, JOIN por la FK) → todos 42501; tabla intacta
  (huella md5); ningún privilegio de tabla ni de columna para anon/authenticated/service_role/authenticator;
  defensa en profundidad: aun con un GRANT futuro, RLS sin policies no lee ni escribe una fila; flujos vivos
  (`business_users_view` aislado por negocio, órdenes) intactos; la FK `technician_id` sigue validando.
- **HTTP** (52 verificaciones): tenant A y B, anon y service_role → 401/403 42501 en GET/POST/PATCH/DELETE/UPSERT
  y en el embed desde `orders`; GraphQL sin `usersCollection` ni `deleteFromusersCollection` para ningún rol;
  huella intacta; las lecturas de órdenes que manda el front responden y no cruzan tenants; owner/admin listan
  sólo los miembros de su negocio, tech/sales no ven miembros de B.

## 8. CI

- `quality`: guard estático (+ self-test) y el test de componentes.
- Job nuevo `prebeta1-public-users`: arranca en A3 con el candidato apartado → controles negativos + matriz de
  precondiciones → `supabase migration up --local` (1 fila en el ledger) → `npm run test:prebeta1`.
- `sec08e-r3` y `g2c3a3-inventory-lockdown` apartan también PRE-BETA-1 durante `supabase start` (arrancan con A3
  apartada y la PRECONDICIÓN 2 abortaría). En `g2c3a3`, `migration up` aplica A3 y PRE-BETA-1 (2 filas).

## 9. Regresiones

Ver [`regressions.md`](regressions.md).

## 10. Riesgos residuales

Ver [`regressions.md`](regressions.md#riesgos-residuales).
