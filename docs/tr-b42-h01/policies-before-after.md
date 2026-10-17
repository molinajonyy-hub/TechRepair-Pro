# TR-B42 / H01 — políticas y privilegios antes/después

## Fuente y alcance

El estado anterior se reconstruyó desde `supabase/migrations/20260628190324_remote_baseline.sql`, las migraciones posteriores y la evidencia de producción suministrada en el pedido. Este trabajo no consultó ni modificó producción. El conteo de 0 eventos corresponde a la auditoría previa informada por el usuario; no es una nueva medición.

El estado posterior descrito abajo es el contrato de `supabase/migrations/20261017142335_tr_b42_h01_customer_events_hardening.sql`. La ejecución local y sus resultados se registran en el README. El preflight permite capturar el catálogo efectivo del entorno elegido, incluidos permisos heredados y de columna.

## Políticas

| Aspecto | Antes | Después |
|---|---|---|
| RLS de `public.customer_events` | Activado | Activado |
| `ce_insert` | Permisiva; `FOR INSERT TO PUBLIC`; `WITH CHECK (true)` | Permisiva; `FOR INSERT TO authenticated`; exige UID y cliente no nulos, cliente existente, mismo negocio y `wc.auth_user_id = auth.uid()` |
| `ce_admin` | Permisiva; `FOR ALL TO PUBLIC`; sin `WITH CHECK`, por lo que su `USING` también habilitaba INSERT | Permisiva; `FOR SELECT TO PUBLIC`; mismo `USING` |
| Otras políticas INSERT/ALL | Ninguna descubierta en el historial vigente | Se eliminan por catálogo antes de crear la única política INSERT; postcondición verifica que no quede ninguna alternativa |
| UPDATE/DELETE de API | Sin privilegio de tabla según baseline/evidencia | Sin privilegio de tabla ni de columna aplicable; postcondiciones verifican herencia |
| Trigger de `customer_events` | Ninguno definido por el usuario | No se crea ninguno |
| `customer_id` y FK | Nullable; FK a `wholesale_customers(id)`, `ON DELETE SET NULL` | Sin cambios; nuevos INSERT de cliente con NULL son rechazados por RLS |
| Tipos de evento | CHECK de 7 tipos | Mismo CHECK y mismos 7 tipos |

La lectura administrativa conserva exactamente esta autoridad:

```sql
business_id IN (
  SELECT profiles.business_id
  FROM public.profiles
  WHERE profiles.user_id = auth.uid()
)
```

No se añade `COALESCE(profiles.user_id, profiles.id)`, permiso mayorista, rol administrativo ni filtro de actividad. La visibilidad de `profiles` sigue su RLS existente. Se conserva `TO PUBLIC`; el acceso efectivo sigue dependiendo de los GRANT existentes. Los eventos históricos cuyo `customer_id` sea NULL siguen siendo legibles por el personal que ya cumplía esa condición.

## Privilegios efectivos de customer_events

| Rol | SELECT antes/después | INSERT antes/después | UPDATE/DELETE antes/después |
|---|---|---|---|
| `anon` | No / no se amplía | No / no | No / no |
| `authenticated` | Sí, sujeto a `ce_admin` / mismo alcance | Sí, sin aislamiento del evento / sí, sólo cliente propio y mismo negocio | No / no |
| `PUBLIC` | Sin GRANT nuevo | No se concede / se revoca explícitamente | No se concede / se revoca explícitamente |
| `service_role` | Sin GRANT específico descubierto; comprobar herencia | Sin GRANT nuevo | Sin GRANT nuevo |

La migración revoca INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER de tabla para PUBLIC, anon y authenticated, elimina INSERT/UPDATE/REFERENCES de columna y restaura únicamente SELECT+INSERT de tabla para authenticated. Ningún privilegio de otros objetos se modifica. Si un rol padre todavía otorgara mutaciones a anon/authenticated, las postcondiciones abortan la transacción: no se revocan privilegios de roles ajenos a esta tabla de forma general.

`BYPASSRLS` no reemplaza un GRANT de tabla. El preflight enumera ambas dimensiones por separado. No se agrega SECURITY DEFINER, RPC, servicio privilegiado ni excepción confiada al navegador.

## Dependencia de wholesale_customers

El EXISTS de inserción se ejecuta con permisos del actor. `authenticated` ya tiene SELECT sobre `wholesale_customers`; `wc_own_read` permite ver su fila mediante `auth_user_id = auth.uid()`. La nueva condición correlaciona simultáneamente `wc.id`, `wc.business_id` y `wc.auth_user_id`. Las lecturas administrativas de clientes mayoristas mantienen sus políticas existentes. No se cambian sus grants, su estado de aprobación ni su autenticación.

## Evidencia local

Validación local del 17/10/2026: migración aplicada dos veces, preflight con 9/9 gates, matriz de roles reales y controles negativos aprobados. El control histórico recrea las dos políticas originales dentro de un savepoint y permite A→B; tras restaurar H01, el mismo intento devuelve 42501. El navegador confirma evento propio persistido y vinculado al pedido. Ver README para comandos, suites y estado de CI/PR. La certificación final requiere revisión humana y autorización expresa.
