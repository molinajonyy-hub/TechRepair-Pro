# PRE-BETA-3A-2S — Autoridad server-side de Mayorista + Portal Clic

Estado: **candidato, NO cerrado.** La parte SQL se validó en un PostgreSQL 16 local con un
shim mínimo de Supabase (roles, `auth.uid()`, `storage`), **no** en la imagen oficial de
Supabase (PG17). En esta sesión, los registros de imágenes estaban bloqueados (Docker Hub
devolvió 429, ECR/ghcr devolvieron 403). La validación en el stack oficial la hace el job de
CI `prebeta3a2s-server-authority`, que sigue pendiente. No se corrieron E2E.

## Contrato

| | Básico | Pro | Full | Trial |
|---|---|---|---|---|
| Feature `mayorista` | no | sí | sí | sí (semántica Pro) |

| Rol (con la feature) | Acceso | Escribe en Mayorista |
|---|---|---|
| owner, admin | automático (aunque tenga override `wholesale: false`) | sí |
| manager, sales | solo con `wholesale` efectivo (default **false**) | sí |
| tech, cashier, viewer | solo con `wholesale` efectivo (default false) | no (lectura) |

- **customers:** sin autoridad no se crea un mayorista, no se convierte minorista → mayorista y
  no se tocan `business_name`/`contact_person` de un mayorista. Los campos comunes de un mayorista
  histórico se siguen editando. Ningún mayorista existente se convierte.
- **Checkout:** el precio mayorista requiere cliente mayorista **y** autoridad del actor. Sin
  autoridad, la venta **no** se rechaza: se cotiza minorista.
- **Conversión portal → customers:** solo por `get_or_create_customer_from_wholesale_atomic`
  (match por email exacto, normalizado; si es ambiguo no adivina; es idempotente).
- **Portal Clic:** herramienta **interna**. Un único principal (`user_id` + `business_id`) por
  herramienta, en `private.internal_tool_principals`. No se obtiene por plan, rol, `wholesale`,
  `system_admins` ni `wholesale_portal_enabled` (eso es activación, no autorización).

## Archivos

| Archivo | Qué es | ¿Escribe? |
|---|---|---|
| `supabase/migrations/20261011120000_prebeta3a2s_wholesale_server_authority.sql` | Entitlement Pro+, capacidad/autoridad Mayorista, RLS `wholesale_*`, trigger de `customers`, checkout, RPC de conversión | sí (DDL; cero DML sobre datos) |
| `supabase/migrations/20261011130000_prebeta3a2s_portal_clic_internal_authority.sql` | Tabla de principal interno + auditoría, helper, RLS de `clic_wholesale_product_settings` y storage | sí (DDL; **no** bindea a nadie) |
| `preflight-readonly.sql` | Gates + impacto + huella | no (`READ ONLY`) |
| `postdeploy-verify-readonly.sql` | Verificación del catálogo desplegado | no (`READ ONLY`) |
| `smoke-rollback.sql` | Comportamiento real con fixtures sintéticos | solo dentro de `BEGIN … ROLLBACK` |
| `portal-clic-binding.sql` | Alta/baja del principal de Portal Clic | sí, **manual**, `confirm=yes` |

Las dos migraciones son atómicas (`BEGIN … COMMIT`), con PRECONDICIONES fail-closed (md5 de cada
función que redefinen, objetos que no existen todavía, policies relevadas) y POSTCONDICIONES. Entre
las postcondiciones: la matriz de plan y de capacidades solo cambia donde dice el contrato,
`customers` no se modifica y no queda ningún principal. Si algo falla, no queda nada aplicado.

## Orden de rollout

Todo lo que sigue lo ejecuta un operador. Nada de esto se ejecutó contra producción.

1. **Preflight** (solo lectura). Guardar la salida.
   ```
   psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f docs/prebeta3a2s/preflight-readonly.sql
   ```
   - Sección 1: `TODOS LOS GATES` tiene que dar `t`. Si no, **no aplicar**.
   - Sección 2: revisar el impacto con producto **antes** de aplicar:
     - 2a/2b: negocios que ganan Mayorista y portales públicos Pro que se **encienden**.
     - 2c: miembros que pierden o ganan acceso.
     - 2d: mayoristas históricos.
     - 2e: ventas mayoristas recientes que con el contrato nuevo se habrían cotizado minoristas.
     - 2f/2g: quién usa hoy Portal Clic y los `system_admins`.
   - Sección 3: anotar `customers_huella`.
2. **Migraciones**, en orden, por el pipeline normal de deploy:
   `20261011120000` y luego `20261011130000`.
3. **Post-deploy** (solo lectura). `TODOS LOS CHECKS` tiene que dar `t`.
   ```
   psql "$DB_URL" -X -v ON_ERROR_STOP=1 -v preflight_customers_huella=<huella> \
        -f docs/prebeta3a2s/postdeploy-verify-readonly.sql
   ```
   - Un `ERROR` de objeto inexistente significa que alguna migración no está aplicada.
   - La huella de `customers` puede moverse por tráfico normal entre preflight y post-deploy.
     La verificación autoritativa es la POSTCONDICION 9, dentro de la transacción de la migración.
4. **Smoke** (`BEGIN … ROLLBACK`). Termina en `SMOKE 3A-2S OK` y `ROLLBACK`.
   ```
   psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f docs/prebeta3a2s/smoke-rollback.sql
   ```
   - Requiere el rol `postgres`, por `SET LOCAL ROLE authenticated` y `session_replication_role`.
   - Consume valores de secuencias y toma locks breves sobre filas sintéticas nuevas.
   - Si ya existe el principal real de Portal Clic, el positivo de esa sección se saltea (`SKIP`)
     y no se toca.
5. **Frontend**: desplegarlo en la misma ventana, inmediatamente después del paso 3.
   - Entre DB nueva y frontend viejo, Portal Clic queda cerrado (fail-closed).
   - En esa misma ventana, la conversión vieja (INSERT directo) solo funciona para quien tiene
     autoridad, porque el trigger la bloquea para el resto.
   - En esa misma ventana, el POS viejo puede mandar el precio mayorista para un actor sin
     autoridad. El servidor lo trata como override manual: owner/admin/manager/sales pueden
     hacerlo (queda `manual_override`), y cashier/tech/viewer reciben un rechazo.
6. **Binding de Portal Clic**: paso **separado y manual**, cuando se confirme la identidad.
   Hasta entonces `/portal-clic` está cerrado para todos, incluido el owner de Clic.

## Binding de Portal Clic (NO ejecutado)

Datos necesarios (ninguno está en el repo):
- `internal_user_id`: `auth.users.id` de la cuenta interna que administra Portal Clic.
- `clic_business_id`: `businesses.id` del negocio Clic.
- `reason`: motivo o ticket, de al menos 10 caracteres; queda en la auditoría.

La identidad tiene que ser owner registrado o miembro **activo** de ese negocio.

```
# 1. Obtener los ids (solo lectura)
psql "$DB_URL" -X -v ON_ERROR_STOP=1 -v action=lookup \
     -v internal_email='<email>' -v clic_slug='<slug>' -f docs/prebeta3a2s/portal-clic-binding.sql
# 2. Dry-run: valida, escribe, verifica con la autoridad real y hace ROLLBACK
psql "$DB_URL" -X -v ON_ERROR_STOP=1 -v action=bind -v internal_user_id=<uuid> \
     -v clic_business_id=<uuid> -v reason='<motivo>' -f docs/prebeta3a2s/portal-clic-binding.sql
# 3. Confirmar: lo mismo con -v confirm=yes
# 4. Post-deploy otra vez: el check 13 tiene que mostrar "1 principal(es)"
```

`action=revoke` desactiva el principal; la fila y la auditoría quedan. Para cambiar de identidad
hay que hacer primero `revoke` y después `bind`. El script nunca pisa un principal activo en
silencio. No existe ninguna RPC `authenticated` para auto-asignarse la herramienta.

## Validación hecha en esta sesión (shim PG16 local, no Supabase oficial)

- **Migraciones:** replay de las 283 desde cero, con precondiciones y postcondiciones OK.
- **Tests SQL nuevos:**
  - `prebeta3a2s_wholesale_authority`: 175 PASS.
  - `prebeta3a2s_portal_clic_authority`: 56 PASS.
- **Suite SQL completa** antes y después: el mismo estado por archivo y los mismos mensajes,
  salvo los dos tests nuevos y `owner_portal_isolation`. Ese test no está en CI, ya fallaba
  antes y ahora falla en CASO 1 por diseño: el owner ya no lee la config de Portal Clic.
- **Rollout completo sobre datos sembrados:**
  - preflight con todos los gates OK;
  - migraciones;
  - post-deploy 16/16 con huella de `customers` idéntica;
  - smoke 42 PASS, sin rastro.
- **Preflight sobre una base ya migrada:** bloquea, con los gates en false.
- **Controles negativos de DB:** los 6 sabotajes los detectan los tests SQL, el smoke y el
  post-deploy:
  - Mayorista vuelve a Full-only;
  - manager con wholesale por defecto;
  - admin bloqueado por override;
  - bypass de `customers`;
  - checkout que solo mira `customer_type`;
  - Portal Clic de nuevo por owner/portal.
- **Binding** sobre una base descartable, todos los modos:
  - sin action;
  - action inválida;
  - lookup;
  - faltan ids;
  - motivo corto;
  - no miembro;
  - uuid inválido;
  - dry-run;
  - confirm;
  - repetido (no-op);
  - otra identidad sin revoke (aborta);
  - revoke dry-run y revoke confirm;
  - revoke repetido;
  - nueva identidad tras revoke.

## Guards y deuda heredada

- `guard:secdef`: el checkout privado se reproduce **verbatim** desde G2-C.2, más una línea
  (`search_path = public, pg_temp` con referencias sin calificar). Entra al baseline
  (`scripts/finance/secdef-baseline.json`) con **1** hallazgo heredado y 0 deuda nueva. Es el
  mismo criterio que G2-C.2: no reescribir una función financiera dentro de un cambio de autoridad.
- `tests/unit/planEntitlements.test.ts`: el test «GAP PRE-BETA-3A-2S», escrito para fallar cuando
  el servidor se alineara, se reemplazó por tests de **paridad**. Esos tests leen la última
  definición migrada de las tres superficies de features y de la regla de plan.

## Riesgos abiertos

- Los negocios Pro con `wholesale_portal_enabled = true` pasan a tener el portal público
  operativo (preflight 2b).
- manager/sales sin override pierden Mayorista. Los admins con override `false` lo recuperan
  (preflight 2c).
- Las ventas a mayoristas hechas por actores sin autoridad pasan a minorista, y Básico con
  mayoristas históricos también (preflight 2d/2e).
- El override manual de precio sigue permitido para owner/admin/manager/sales
  (`user_can_override_price`) y queda auditado como `manual_override`. 3A-2S no lo cambia.
- Una policy de storage fuera de banda sobre `clic-wholesale-products` aborta la migración 2 por
  diseño (PRECONDICION 3): revisarla a mano.
- Hay que actualizar o retirar `tests/sql/owner_portal_isolation.test.sql`, que es obsoleto
  frente al contrato nuevo.
