# PRE-BETA-1 · Regresiones

Todo local, sobre el stack de Supabase de este repo (CLI 2.109.1, PostgreSQL 17.6) levantado desde cero con
`supabase db reset`. Dos estados comparados:

- **BASE** = `main` f828899 sin el candidato (280 migraciones; catálogo idéntico a producción, ver
  `evidence/production_catalog_equivalence.md`);
- **POST** = BASE + `20261010120000_prebeta1_public_users_api_retirement.sql` aplicada con `supabase migration up`.

## Suites SQL (`tests/sql/*.test.sql`, 51 suites, sin las de PRE-BETA-1)

Cada suite corrió por su script npm cuando existe (`test:sql:*`) o directo con `psql -v ON_ERROR_STOP=1`.

**Resultado: 39 OK / 12 FALLA en BASE y 39 OK / 12 FALLA en POST — mismas suites, mismo error, mismos
conteos de PASS. 0 diferencias atribuibles a PRE-BETA-1.** Ninguna de las 12 fallas toca `public.users`
(finanzas, fiscal/ARCA, lote2/lote3, mayorista, MP, secdef): son preexistentes y quedan fuera de alcance.

| Suite | BASE | POST | Error (idéntico en ambos) |
|---|---|---|---|
| `arca_comprobante_identity_rpc.test.sql` | OK | OK |  |
| `arca_phase0_hardening.test.sql` | OK | OK |  |
| `arca_phase1_status.test.sql` | OK | OK |  |
| `arca_phase2a_initial_setup.test.sql` | OK | OK |  |
| `arca_wsass_homologacion_alias.test.sql` | OK | OK |  |
| `auth_profile_linking.test.sql` | OK | OK |  |
| `billing_grants.test.sql` | OK | OK |  |
| `billing_security.test.sql` | OK | OK |  |
| `canonical_owner_provisioning.test.sql` | OK | OK |  |
| `email_verification_provisioning.test.sql` | OK | OK |  |
| `finance_charts_l1.test.sql` | FALLA | FALLA | C01a net_sales FALLO: obtenido=0.00 esperado=62000 |
| `finance_inventory_capital_perf.test.sql` | OK | OK |  |
| `first_steps_derived.test.sql` | OK | OK |  |
| `fiscal_date_part2.test.sql` | FALLA | FALLA | FAIL: M2 la identidad previa no tiene p_fecha_cbte |
| `fiscal_pv_rbac.test.sql` | FALLA | FALLA | R01: el rol owner no puede leer el PV fiscal (get_arca_config_safe devolvio NULL). El POS le mostraria "sin co |
| `fiscal_sales_point_contract.test.sql` | FALLA | FALLA | FORBIDDEN |
| `g2b_comprobante_items_immutability.test.sql` | OK | OK |  |
| `g2c1_wholesale_stock_authority.test.sql` | OK | OK |  |
| `g2c2_inventory_concurrency_locks.test.sql` | OK | OK |  |
| `g2c3a1_inventory_stock_adjustments.test.sql` | OK | OK |  |
| `g2c3a3_inventory_authority_lockdown.test.sql` | OK | OK |  |
| `g2c3b0_stock_repair_no_wholesale.test.sql` | OK | OK |  |
| `g2c_negative_stock_reversal.test.sql` | OK | OK |  |
| `lote2_secdef_tenant_authority.test.sql` | FALLA | FALLA | FAIL: owner own preview 3 rows |
| `lote3_action_write_authority.test.sql` | FALLA | FALLA | FAIL: pay_supplier_free_atomic role matrix manager expected=true |
| `mobile2a_order_intake.test.sql` | OK | OK |  |
| `mp_pos_beta_containment.test.sql` | FALLA | FALLA | insert or update on table "mp_accounts" violates foreign key constraint "mp_accounts_business_id_fkey" |
| `notifications_contract.test.sql` | OK | OK |  |
| `owner_portal_isolation.test.sql` | FALLA | FALLA | CASO 4 FAIL: tech no puede LEER mayorista (0) |
| `p0_arca_presend_claim_recovery.test.sql` | FALLA | FALLA |  |
| `p0_expense_tax_category.test.sql` | OK | OK |  |
| `p0onb1_canonical_business_profile.test.sql` | OK | OK |  |
| `p0p2_business_invitations.test.sql` | OK | OK |  |
| `p0p5_business_onboarding.test.sql` | OK | OK |  |
| `p0p6_cajas_capability.test.sql` | OK | OK |  |
| `p0p6_capability_rbac.test.sql` | OK | OK |  |
| `permissions_hydration.test.sql` | OK | OK |  |
| `prebeta_order_amounts_identity.test.sql` | FALLA | FALLA | permission denied for function user_can_view_order_amounts |
| `prebeta_p1_closure.test.sql` | FALLA | FALLA | B01..B11 capital de X FALLO: obtenido=<NULL> esperado=17700 |
| `provisioning_decoupled_from_auth.test.sql` | OK | OK |  |
| `sec08a_orders_data_visibility.test.sql` | OK | OK |  |
| `sec08a_phase_b_pivots.test.sql` | OK | OK |  |
| `sec08a_phase_c_payment_visibility.test.sql` | OK | OK |  |
| `sec08b_inventory_cost_visibility.test.sql` | OK | OK |  |
| `sec08c_supplier_finance_visibility.test.sql` | OK | OK |  |
| `sec08d_finance_insights_visibility.test.sql` | OK | OK |  |
| `sec08e_auxiliary_financial_reads.test.sql` | OK | OK |  |
| `secdef_public_execute_lockdown.test.sql` | FALLA | FALLA | CASO 1: anon puede ejecutar SECDEF fuera de la allowlist: check_client_contract() |
| `visual_fixture_date_anchors.test.sql` | OK | OK |  |
| `wholesale_portal_public_read.test.sql` | OK | OK |  |
| `wholesale_portal_public_rpc.test.sql` | OK | OK |  |

Nota: `mp_pos_beta_containment.test.sql` se declara "rollback-only" pero su `GRANT … TO authenticated` corre en
autocommit y queda persistido: en una segunda corrida sobre la misma base falla antes (otro mensaje). No es un
cambio de comportamiento del candidato; la comparación de arriba es sobre bases recién reseteadas.

## Jobs de CI reproducidos localmente (cada uno con su estado de arranque)

| Job de CI | Cómo se reprodujo | Resultado |
|---|---|---|
| `quality` | los 22 pasos del workflow (typecheck, `lint:errors`, tests de componentes, guards + self-tests, build, Deno) | **22/22 OK** (incluye el paso nuevo PRE-BETA-1) |
| `prebeta1-public-users` (nuevo) | `db reset` con el candidato apartado → `test:prebeta1:before` → `migration up` → `test:prebeta1` | **OK** (ver `evidence/`) |
| `sec08e-r3` | `db reset` con R3, SEC-08F, G2-B…G2-C.3A3 **y PRE-BETA-1** apartadas; R3 devuelta; `test:sec08e-r3` | **OK** · 274 aserciones + 82 tests de componentes |
| `sec08f` | `db reset` con SEC-08F apartada (PRE-BETA-1 se aplica en el arranque); `test:sec08f` | **OK** · 189 aserciones PostgREST/JWT pre/post |
| `g2c3a3-inventory-lockdown` | `db reset` con A3 **y PRE-BETA-1** apartadas → `test:p7:g2c3a3` → `migration up` (ledger = 2: A3 + PRE-BETA-1) → `test:g2c3a3` | **OK** · P7 41/41, guards y PostgREST 30/30 |
| `g2b-immutability`, `g2c-stock-arithmetic`, `g2c1-wholesale-authority`, `g2c2-inventory-locks` (con concurrencia real, 8 clientes pgbench), `g2c3b0-stock-repair`, `g2c3a1-stock-adjustments` | sobre `main` + PRE-BETA-1 | **OK** los 6 |
| `e2e-local` (`e2e:ci-local --project=m7-local`) | base recién reseteada con PRE-BETA-1 | 172 OK / 12 FALLA — **las mismas 12 fallan con el código de `origin/main` sobre BASE** (ver abajo) |

Suite completa de componentes (`npm run test:components`): **1298/1298** (89 archivos).

## E2E `m7-local`

Las 12 fallas son de entorno o preexistentes; se reprodujeron idénticas desde un worktree de `origin/main`
(f828899) contra BASE (`12 failed / 28 passed` sobre esos 3 specs):

| Spec | Casos | Causa |
|---|---|---|
| `charts-l1-visual.spec.ts` | 6 | el gate de "0 errores de consola" ve `net::ERR_TUNNEL_CONNECTION_FAILED` / `ERR_CERT_AUTHORITY_INVALID`: recursos externos bloqueados por el proxy del sandbox |
| `finance-caja-visual.spec.ts` | 4 | ídem |
| `customer-core-parity.spec.ts` (alta rápida) | 2 | `toBeHidden()` de Email/Dirección en "Crear cliente rápido"; falla igual en `main` |

Durante toda la corrida del E2E, el log de Postgres registra **0** `permission denied for table users`: el
frontend no toca la tabla.

Primera corrida descartada: el onboarding (3 casos) falló porque `scripts/guards/onboarding-compat-matrix.mjs`,
corrido antes sobre la misma base, **borra** `get_my_business_profile()` / `update_my_business_profile(jsonb,
boolean)` para simular un backend viejo y, al abortar por el 409 del gate R2B, no las restaura. Sobre una base
recién reseteada los 3 pasan.

## Suites HTTP/SQL de node (BASE vs POST)

Corridas desde el worktree de `main` sobre BASE y desde esta rama sobre POST: **mismo exit y mismo mensaje en las
12**.

| Script | Resultado (BASE = POST) |
|---|---|
| `test:p0p2:negative-gates` (invitaciones) | OK |
| `test:provisioning-concurrency` | OK (1 business, 1 profile, 4/4) |
| `test:compat:onboarding` | FALLA en ambos: `409 CLIENT_UPDATE_REQUIRED` (harness anterior al gate R2B; no manda el header de contrato) |
| `test:postgrest:sec08a`, `-phase-b`, `-phase-c` | FALLA en ambos: 409 del gate R2B |
| `test:postgrest:sec08b`, `test:compat:sec08b`, `test:preservation:sec08b` | FALLA en ambos: 409 del gate R2B |
| `test:sec08c` | SQL OK; la parte PostgREST FALLA en ambos: 409 del gate R2B |
| `test:sql:lote3-authority`, `test:postgrest:lote3-authority` | FALLA en ambos (matriz de roles / 409) |

CI no corre estos harnesses: la cobertura vigente de SEC-08A–E está en las suites SQL de arriba (todas OK en BASE y
POST) y en los jobs `sec08e-r3` y `sec08f`. `test:sec08e-r2` y el runner R1 local exigen un ledger anterior a
SEC-08E/R2A (certificaciones históricas) y no aplican a `main`.

## Riesgos residuales

1. **`customer_events.ce_insert` (`WITH CHECK (true)`)**: cualquier authenticated puede insertar eventos con un
   `business_id` ajeno (escritura cross-tenant; la lectura sí está anclada). Preexistente desde el
   `remote_baseline`, fuera de alcance. El guard lo reporta en cada corrida y trinquetea. **Requiere un P1 propio.**
2. **Las 3 filas huérfanas con PII siguen en `public.users`** (cero DML por diseño). Sólo `postgres`/superusuario
   las alcanza (SQL editor / dashboard). Decidir retención o borrado es una tarea aparte.
3. **`orders.technician_id` y su FK siguen vivos** y `authenticated` conserva UPDATE sobre esa columna. Como el
   chequeo de FK corre como el owner, un usuario podría distinguir "existe / no existe" un `id` de
   `public.users` probando UUIDs (23503 vs OK): un oráculo de existencia sobre 3 UUIDv4 aleatorios, sin lectura
   de datos. La PRECONDICIÓN 8 frena el deploy si alguien empieza a usar la columna. El retiro de la columna o
   la migración a `assigned_profile_id` es el lote del técnico (excluido acá).
4. **El técnico sigue sin mostrarse** en OrderDetail/impresión/Reports ("Sin asignar"): es exactamente lo que
   se veía antes (0 órdenes con `technician_id`). Mostrar el perfil asignado es el bug excluido.
5. **Privilegios latentes en otras tablas**: `anon`/`authenticated` conservan `TRUNCATE`/`REFERENCES`/`TRIGGER`
   en varias tablas del baseline (p. ej. `orders`). PostgREST no los expone y el guard no los evalúa (su
   alcance son las policies de tenant); conviene un lote de higiene de grants.
6. **Límites del guard**: "anclada" = columna clave propia + fuente de identidad (medido en `pg_depend`); no
   prueba la corrección semántica de la expresión (p. ej. `business_id IS NOT NULL AND <helper>` pasaría).
   Las vistas (6 vistas definer expuestas, p. ej. `v_inventory_costs`) quedan fuera: las cubren los guards de
   SEC-08B/E. GraphQL comparte privilegios con PostgREST, así que el mismo catálogo lo cubre.
7. **Deploy**: la migración aborta si producción cambió desde el discovery (policies, ACL, consumidores,
   `technician_id` en uso, otra migración después de A3). Es fail-closed a propósito: si aborta, re-discovery.
8. **Higiene de tests encontrada (no tocada)**: `mp_pos_beta_containment.test.sql` filtra un `GRANT` fuera de
   transacción; `onboarding-compat-matrix.mjs` deja RPCs borradas si aborta; 12 suites SQL, 10 suites de node
   (9 por el 409 del gate R2B, 1 por su matriz de roles) y 12 casos E2E fallan igual en `main`.
9. `scripts/test-supabase.ts` todavía nombra `users` (script suelto sin uso cuyo import ni resuelve); no se tocó.
