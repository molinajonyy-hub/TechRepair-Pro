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
