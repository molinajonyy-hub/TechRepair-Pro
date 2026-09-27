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

## Resto de la matriz

_En curso: E2E `m7-local`, job `quality`, jobs SEC-08F / SEC-08E R3 / G2-C.3A3 reproducidos con sus estados de
arranque, suites HTTP comparadas BASE vs POST._

## Riesgos residuales

_Se completa al cerrar la matriz._
