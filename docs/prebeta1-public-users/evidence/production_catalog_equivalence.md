# Guard global · equivalencia replay ↔ producción (read-only)

El guard (`scripts/guards/tenant-isolation.mjs`) evalúa un snapshot producido por
`scripts/guards/tenant-isolation-catalog.sql` (una sola consulta SELECT: sin
escrituras, sin filas de datos). La misma consulta se ejecutó sobre:

- el replay limpio de `main` (`supabase db reset`, 280 migraciones, PRE-BETA-1
  apartada), **antes de correr cualquier suite**;
- producción (`vrdxxmjzxhfgqlnxmbwx`, última migración `20261009120000`), read-only.

| Huella (md5) | Replay local de main | Producción |
|---|---|---|
| snapshot completo | `9c27422475e948fd603174fd4a58296c` | `9c27422475e948fd603174fd4a58296c` |
| arreglo `tables` (124 tablas de `public`) | `347d5ba20a57a63e0745e7c3c255a3ea` | `347d5ba20a57a63e0745e7c3c255a3ea` |
| bloque `legacy_users` | `dac3113f4c6d798d0c0ce8b99322019d` | `dac3113f4c6d798d0c0ce8b99322019d` |

Hardening del guard (anclas explícitas): el snapshot suma `fk_refs` (columna → tabla referenciada),
`business_id_write` y `helpers` (huella de los 8 helpers revisados). Ambos se compararon por separado, read-only:

| Huella | Replay local de main | Producción |
|---|---|---|
| `fk_refs` de las 124 tablas | `d9fefa9ccb7ad723000882f349711068` | `d9fefa9ccb7ad723000882f349711068` |
| `business_id_write` (INSERT/UPDATE de `business_id` para anon/authenticated) | `3b51847131230a1a889fdd2292a69e96` | `3b51847131230a1a889fdd2292a69e96` |
| `current_business_id()` | `957edd22f3d089b6e00d4a9c2a6175dc` | `957edd22f3d089b6e00d4a9c2a6175dc` |
| `current_user_business_id()` | `2be08115b0347ad01a35e54965d4f65b` | `2be08115b0347ad01a35e54965d4f65b` |
| `user_business_ids()` | `bdde43834cd4216d6408bad03bd78fac` | `bdde43834cd4216d6408bad03bd78fac` |
| `current_user_can_in_business(uuid,text)` | `3d920821b9924602a57739ca6d3e8b7f` | `3d920821b9924602a57739ca6d3e8b7f` |
| `can_view_inventory_cost(uuid)` | `0fa04ed61e833dbbac50da069d45714a` | `0fa04ed61e833dbbac50da069d45714a` |
| `can_view_supplier_finance(uuid)` | `21623accfb9fbfbf3b3aa6cb1dec46bc` | `21623accfb9fbfbf3b3aa6cb1dec46bc` |
| `can_view_payment_allocations(uuid)` | `a20216aec8725952082dcde9c222b1ba` | `a20216aec8725952082dcde9c222b1ba` |
| `user_can_view_order_amounts(uuid,uuid)` | `927ee9e9ea0783bca597a3fb8be22165` | `927ee9e9ea0783bca597a3fb8be22165` |

Snapshot idéntico ⇒ el guard sobre producción HOY da exactamente
`before_guard_catalog.log`: PIN PRE-BETA-1 + 5 hallazgos de `public.users`
(`USING (true)` y 4 expresiones sin relación con la fila), más la deuda
preexistente `customer_events.ce_insert`. Con la migración aplicada:
`after_guard_catalog.log` (0 violaciones).

Nota de método: una primera comparación mostró `mp_accounts` distinta. La causa fue
`tests/sql/mp_pos_beta_containment.test.sql` (preexistente): se declara
"rollback-only" pero su `GRANT ... TO authenticated` corre en autocommit y queda
persistido en la base local. Tomada la huella antes de correr las suites, la
diferencia desaparece. El test no se modifica en este lote (fuera de alcance).
