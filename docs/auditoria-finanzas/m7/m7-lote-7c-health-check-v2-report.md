# M7 — Lote 7C · Health Check Financiero v2

**Fecha:** 2026-07-16 · **Estado:** completo, local. **Cero escrituras en producción.**
Sin commit, push, backfill ni tag. Sin cambios en `src/`.

---

## 1. Auditoría del health check actual (v1)

`finance_health_check(uuid)` — `SECURITY DEFINER`, owner `postgres`, `search_path=public`, `authenticated` EXECUTE, `anon` no. Aislado por `business_id` con verificación de pertenencia. **16 checks.** Sin timeout propio (hereda el del cliente).

**Consumidor:** `src/pages/FinanceHealthCheck.tsx` (línea 185) → `supabase.rpc('finance_health_check', { p_business_id })`. Contrato consumido:

```ts
HealthResult { ok, critical_count, warning_count, low_count, total_issues,
               business_id, checked_at, checks[], error? }
HealthCheck  { id, title, severity:'low'|'warning'|'critical',
               status:'ok'|'low'|'warning'|'critical', count, description, rows }
```

`SEV_CONFIG` se indexa por **`status`** (no por `severity`), lo cual acota el riesgo de romperlo.

| Check v1 | Qué valida | Fuente | Severidad | Decisión |
|---|---|---|---|---|
| `cae_estado_incorrecto` | CAE con estado fiscal incoherente | comprobantes | warning | **Mantener en v1** (fiscal, fuera de v2) |
| `emitido_sin_numero_fiscal` | emitidos con CAE sin número | comprobantes | warning | **Mantener en v1** |
| `bfe_huerfanas` | BFE sin entidad | BFE | critical | **Reemplazado y ampliado** (`bfe_null_class`, duplicados) |
| `fm_huerfanos` | FM sin entidad | FM | critical | **Reemplazado** (`reversal_without_original`, `cash_without_caja`) |
| `payments_huerfanos` | pagos sin comprobante | pagos | critical | **Reemplazado** (`replacement_chain_broken`, cross-business) |
| `items_huerfanos` | ítems sin comprobante | ítems | critical | **Reemplazado** (`item_inventory_missing`) |
| `nc_sin_original` | NC sin original | comprobantes | critical | **Reemplazado** (`credit_note_without_original`) |
| `anulada_sin_nc` | anuladas sin NC | comprobantes | warning | **Reemplazado** (`annulled_without_record`, ahora con la vía canónica) |
| `nc_duplicadas` | NC duplicadas | comprobantes | critical | **Reemplazado** (`credit_note_duplicated`) |
| `nc_sin_reversa` | NC sin reversa financiera | FM | critical | **Reemplazado** (`credit_note_cash_not_compensated`) |
| `total_cobrado_incorrecto` | header ≠ pagos | comprobantes | warning | **Reemplazado** (`header_vs_live_payments`, ahora **solo pagos vivos**) |
| `saldo_pendiente_incorrecto` | saldo mal calculado | comprobantes | warning | **Mantener en v1** |
| `remito_payment_sin_fm` | remitos con pago sin caja | FM | warning | **Mantener en v1** |
| `remito_cobrado_sin_payment` | remitos legacy sin normalizar | comprobantes | low | **Mantener en v1** |
| `fm_duplicados` | FM duplicados | FM | critical | **Reemplazado** (`annulment_cashflow_double_reversal`) |
| `bfe_duplicadas` | BFE duplicadas | BFE | critical | **Reemplazado** (`bfe_cogs/income/commission_duplicated`) |

**v1 queda intacta.** v2 es una función nueva; no reduje cobertura: los 4 checks que v1 conserva en exclusiva son fiscales/legacy y siguen disponibles allí.

## 2. Contrato v2 — superset aditivo

`finance_health_check_v2(p_business_id uuid, p_include_global boolean DEFAULT false)`.

**Todo campo de v1 se emite idéntico** — el frontend actual funciona cambiando solo el nombre de la RPC. Aditivo:

| nivel | campos nuevos |
|---|---|
| resumen | `version`, `overall_status` (pass/warn/fail), `info_count`, `pass_count`, `checks_total`, `duration_ms`, `amount_at_risk`, `schema_state`, `semantics` |
| check | `check_id`, `category`, `result` (pass/warn/fail/info), `severity_level` (critical/high/medium/low/info), `amount_ars`, `message`, `details`, `version` |

Mapeo al vocabulario del frontend: `pass→ok`, `fail→critical`, `warn→warning`, `info→low`; `severity_level` critical/high→`critical`, medium→`warning`, low/info→`low`.

**Semántica de severidades**: `fail` = error actual que afecta dinero, stock, deuda o aislamiento · `warn` = legacy o no material · `info` = limitación explicada · `pass` = sin hallazgos.

## 3. Catálogo — 44 checks por negocio + 2 globales

| categoría | check_id | severidad |
|---|---|---|
| **periods** | `period_locks_overlapping` | high |
| | `period_reopened_without_reason` | medium |
| | `period_reopen_out_of_order` | high |
| | `writes_after_period_close` | **critical** |
| | `entities_null_economic_date` | high |
| **audit** | `audit_without_actor` | high |
| | `audit_entity_missing` | medium |
| | `audit_cross_business` | **critical** |
| | `annulment_without_audit_event` | medium |
| | `audit_duplicated_per_request` | high |
| | `audit_without_economic_date` | medium |
| | `audit_date_vs_entry` | high |
| | `backstop_events` | medium |
| **idempotency** | `request_keys_duplicated` | **critical** |
| | `request_key_or_hash_empty` | high |
| | `request_unknown_status` | high |
| | `request_hash_legacy_md5` | info |
| | `request_completed_without_entity` | high |
| | `request_stale_with_entity` | high |
| | `request_processing_stale` | medium |
| | `request_cross_business` | **critical** |
| **payments** | `replacement_metadata_partial` | high |
| | `replacement_self_reference` | **critical** |
| | `replacement_chain_broken` | **critical** |
| | `header_vs_live_payments` | medium |
| | `replacement_without_compensation` | **critical** |
| | `compensation_without_replacement` | high |
| | `payment_after_annulment` | **critical** |
| **annulments** | `annulled_without_record` | **critical** |
| | `annulment_record_orphan` | high |
| | `annulment_multiple_records` | **critical** |
| | `annulment_signals_partial` | high |
| | `annulment_resurrected` | **critical** |
| | `annulment_date_impossible` | high |
| | `annulment_cross_business` | **critical** |
| | `annulment_stock_restored_twice` | **critical** |
| | `annulment_cashflow_double_reversal` | **critical** |
| | `annulment_cogs_double_reversal` | **critical** |
| | `annulment_and_credit_note` | **critical** |
| **credit_notes** | `credit_note_cash_not_compensated` | high |
| | `credit_note_without_original` | high |
| | `credit_note_duplicated` | **critical** |
| | `credit_note_claims_stock_without_movement` | high |
| | `credit_note_without_physical_return` | **info** |
| **accounting_classification** | `bfe_null_class` | high |
| | `bfe_legacy_annulment_mirrors` | **info** |
| | `bfe_legacy_unclassified_other` | medium/high según monto |
| | `bfe_cogs_duplicated` | **critical** |
| | `bfe_income_duplicated` | **critical** |
| | `bfe_commission_duplicated` | high |
| **cashflow** | `multiple_open_cajas` | **critical** |
| | `cash_without_caja` | medium |
| | `caja_cross_business` | **critical** |
| | `fm_after_caja_close` | high |
| | `reversal_without_original` | high |
| **pnl_ledger** | `annulment_without_ledger_event` | **critical** |
| | `annulled_ledger_not_netting` | **critical** |
| | `pnl_vs_ledger_mismatch` | **critical** |
| | `service_with_cogs` | medium |
| **accounts_receivable** | `account_balance_mismatch` | **critical** |
| | `account_cross_business` | **critical** |
| | `account_movement_orphan` | high |
| | `account_movement_duplicated` | high |
| | `annulled_cc_without_compensation` | **critical** |
| **inventory** | `item_decimal_quantity` | high |
| | `item_non_positive_quantity` | high |
| | `item_inventory_missing` | high |
| | `inventory_cross_business` | **critical** |
| | `inventory_movement_orphan` | medium |
| **multi_tenant** | `cross_business_references` (6 cruces, con desglose en `details`) | **critical** |
| **reconciliation** | `reconciliation_active` | high |
| | `reconciliation_indeterminate` | medium |
| | `reconciliation_corrected` | info |
| | `reconciliation_legacy_accepted` | info |
| **security** *(global)* | `secdef_without_search_path` | **critical** |
| | `alternative_write_paths` | **critical** |

Los checks se **auto-adaptan al esquema**: si M7 no está desplegado (`v_finance_sales_ledger`, `finance_audit_log`, `finance_period_locks`, `replaced_at`, `annulment_date` ausentes), esos bloques se omiten en vez de fallar. `schema_state` reporta qué había.

## 4. Deuda legacy vs error activo

La distinción está implementada, no solo documentada:

- **`bfe_legacy_annulment_mirrors`** → `info` / `legacy_classification_debt`. Condiciones: `source='annulment'` **Y** `economic_class='legacy_unclassified'` **Y** vinculado uno a uno con un comprobante efectivamente anulado. `details.remediacion` dice explícitamente que reclasificar sería un backfill sobre asientos históricos. No alimentan `operating_result` (solo `data_quality_flags`).
- **`bfe_legacy_unclassified_other`** → conserva alerta: `warn`/medium por defecto, **`fail`/high si supera 100.000 ARS**. Escala por monto y origen.
- **`request_hash_legacy_md5`** → `info`: MD5 = M6, SHA-256 = M7; ambos coexisten legítimamente.
- **`request_unknown_status`** → `status IS NULL` es **legacy M6 compatible**, no se marca.
- **Request tables vacías → `pass`**, nunca `warn`. Probado (CL4–CL6).
- **`cash_without_caja`** → `warn`/medium: clasificación M6 heredada; el neto y las referencias son correctos.

En el dry-run productivo actual `legacy_unclassified = 0` → **pass**, como pedía el §10.

## 5. Semántica de NC y COGS

Implementada tal como la definiste, con las dos dimensiones **separadas**:

- **`credit_reversal`** → **obligatoria**: `credit_note_cash_not_compensated` es `fail`/high si una NC emitida no compensó su cobro.
- **`inventory_return`** → **no se asume**: `credit_note_without_physical_return` es **`info`/info**, nunca fail. Cuantifica el COGS retenido en `amount_ars` y documenta la política en `details`:

> *La NC revierte ingreso/cobro. El COGS se revierte SOLO si hubo devolución física o restauración de inventario. Una NC total sin retorno de mercadería puede producir legítimamente ventas netas cero, COGS positivo y pérdida.*

También va en el `semantics` del resumen, para que un operador lea la regla sin abrir el código.

`credit_note_claims_stock_without_movement` cubre el caso inverso: una NC que **sí** declara inventario en sus ítems pero no registró la entrada → `fail`/high.

**La factura C de producción (COGS residual 2.186)** → `info`, con su monto. **El remito reconciliado por 7B** → `annulled_without_record` pasa a `pass`, y `annulled_ledger_not_netting` confirma que netea a cero.

## 6. Rendimiento

**8 ms** en el escenario de test (negocio con ~15 comprobantes y todos los casos fallidos sembrados). Meta era < 2 s: **250× de margen**.

Diseño: sin N+1 ni loops por entidad. Todo es agregación (`count(*)`, `SUM`, `FILTER`), CTEs y subconsultas escalares, siempre filtrando por `business_id` primero. `EXPLAIN` no justificó **ningún índice nuevo**: los conjuntos son chicos y los índices existentes por `business_id` alcanzan. **No agregué índices.**

**Checks que NO conviene ejecutar interactivamente:** los 2 de `security` (`secdef_without_search_path`, `alternative_write_paths`). No son costosos — son **globales**: miran catálogo y grants, no filas del negocio. Un hallazgo de plataforma no debe pintar de rojo el health check de cada comercio. Van detrás de `p_include_global=true`, como auditoría operativa. Probado (CL9/CL10, GL1–GL5).

## 7. Seguridad read-only

**Tres barreras independientes:**

1. **El motor.** La función es `STABLE`. Probado en vivo: una función STABLE que intenta un INSERT falla con `ERROR: INSERT is not allowed in a non-volatile function`. **No es disciplina, es Postgres.** No puede insertar resultados, corregir saldos, crear reconciliaciones, modificar estados ni abrir/cerrar períodos.
2. **Guard estático** — `scripts/finance/guard-readonly-healthcheck.mjs`. Extrae el **cuerpo** de las funciones (el guard de 7A no servía: la migración contiene un `CREATE FUNCTION` legítimo), despoja comentarios y literales, y rechaza INSERT/UPDATE/DELETE/MERGE/TRUNCATE/ALTER/DROP/GRANT/REVOKE/COPY…FROM, más `set_config`, `nextval`, `assert_period_open`, `finance_log_audit` y `finance_begin_audit_scope` (helpers que mutan). Verifica además que se declare no-VOLATILE y con `search_path` fijo. **Probado en ambas direcciones**: pasa el archivo real y detecta un INSERT inyectado.
3. **Permisos.** `anon` sin EXECUTE; `authenticated` sí; ownership verificado contra `businesses.owner_user_id`/`profiles`.

`RC4` verifica explícitamente que el health check **no modificó ningún estado de reconciliación**.

## 8. Suites

`supabase/tests/etapa7_7c_health_check_v2_test.sql` — **90 asserts**. Batería completa: **41 suites, 1839 asserts, 0 fallas**.

Cobertura: contrato v1 completo + campos v2 (CT1–CT12) · base limpia todo en pass (CL1–CL10) · auth/cross-tenant/sin business_id (SE1–SE5) · read-only declarativo (RO1–RO4) · checks globales (GL1–GL5) · anulado sin registro con monto, detalle y **aislamiento entre negocios** (F1–F10) · NC sin retorno físico → info (NC1–NC7) · NC sin compensar cobro → fail (NC8–NC9) · deuda legacy explicada → info (LG1–LG5) · legacy de otro origen escalando por monto (LG6–LG9) · cobro mixto válido (MX1) · header desalineado (HD1–HD2) · pago posterior a anulación (PA1–PA3) · metadata de reemplazo (RP0–RP4) · cajas múltiples (CJ0–CJ3) · cantidad decimal (IV1) · multi-tenant con desglose (MT1–MT3) · reconciliación sin mutar (RC1–RC4) · rendimiento (PF1–PF2).

Dos casos me obligaron a un patrón mejor: `replacement_metadata_partial` y `multiple_open_cajas` son **inalcanzables** — un CHECK y un índice único ya los impiden. La suite ahora afirma primero esa barrera y después la retira para comprobar que el health check los detecta igual. Es defensa en profundidad real, no cobertura de fantasía.

## 9. Compatibilidad frontend

**Cero cambios en `src/`.** v1 sigue existiendo y `FinanceHealthCheck.tsx` funciona sin tocar nada. Los 7 campos por check y los 8 del resumen que consume el frontend se emiten idénticos en v2 (CT3–CT6), y `status`/`severity` respetan su vocabulario (probado). Migrar es cambiar `'finance_health_check'` → `'finance_health_check_v2'`.

## 10. Hallazgo real de seguridad

**13 funciones `SECURITY DEFINER` sin `search_path` fijo, todas ejecutables por `authenticated` Y `anon`:**

`business_has_feature`, `check_user_limit_before_invite`, `insert_personal_default_categories`, `pay_personal_debt`, `pay_recurring_expense`, `personal_savings_goal_operation`, `personal_update_balance`, `personal_update_currency_balance`, `preview_missing_stock_movements`, `process_mp_subscription_payment`, `repair_missing_stock_movements`, `sync_business_logo_url`, `update_inventory_dollar_prices`.

Una SECURITY DEFINER sin `search_path` es vulnerable a secuestro de esquema: quien pueda crear objetos en un esquema que preceda a `public` puede hacer que la función ejecute su código como `postgres`. Que además sean invocables por **`anon`** agrava el alcance.

**Preexistente y fuera del dominio económico de M7** (finanzas personales, suscripciones MP, reparación de stock). **No lo corregí**: no es el objetivo de este lote y cambiar 13 funciones de otros dominios sin análisis sería exactamente lo que venimos evitando. Queda como **hallazgo crítico documentado**, detectado automáticamente por `secdef_without_search_path` en modo global.

## 11. Riesgos restantes

1. **Las 13 SECURITY DEFINER sin `search_path`** (arriba). Crítico, preexistente, merece su propio lote.
2. **v1 y v2 conviven.** Mientras el frontend consuma v1, los 44 checks nuevos no se ven en la UI. v1 podría dar verde con problemas que v2 marca.
3. **4 checks fiscales viven solo en v1** (`cae_estado_incorrecto`, `emitido_sin_numero_fiscal`, `saldo_pendiente_incorrecto`, `remito_*`). Si el frontend migra a v2 se pierden de vista. Portarlos es trabajo de un lote fiscal.
4. **`p_include_global` no tiene control de acceso propio**: cualquier `authenticated` con un negocio puede pedir el diagnóstico de plataforma. No expone datos de otros negocios (solo conteos de catálogo), pero conviene restringirlo a owner/admin cuando se exponga en UI.
5. **`amount_ars` mezcla monedas**: asume ARS. Correcto hoy (`amount_ars` ya está normalizado), pero el nombre podría inducir a error con multi-moneda.
6. **Umbral de 100.000 ARS hardcodeado** en `bfe_legacy_unclassified_other`. Razonable para el tamaño actual; debería ser configurable por negocio si crece.

## 12. Recomendación para el frontend mínimo

**Cambiar una línea**: `supabase.rpc('finance_health_check_v2', { p_business_id })` en `FinanceHealthCheck.tsx:185`. Nada más — el contrato es superset y la UI actual renderiza los 44 checks sin tocarse.

Con eso funcionando, tres mejoras baratas, en orden de valor:

1. **Agrupar por `category`** (12 grupos) en vez de por severidad: hoy la UI agrupa por status y con 44 checks se vuelve una lista larga. Es un `groupBy` sobre un campo que ya viene.
2. **Mostrar `amount_ars` y `amount_at_risk`**: "3 problemas" comunica mucho menos que "3 problemas por $1.248.630".
3. **Renderizar `info` distinto de `warn`**: hoy ambos caen en `low`. El campo `result` ya los separa, y es justo lo que evita que la deuda legacy explicada parezca un problema.

El modo global (`p_include_global`) **no debería ir en la pantalla del comercio**: es diagnóstico de plataforma. Sugiero exponerlo aparte, restringido a owner, o dejarlo como consulta de operador.

---

**Me detengo acá.** No avancé con frontend ni deploy, no escribí en producción, y no hice commit, push, backfill ni tag.
