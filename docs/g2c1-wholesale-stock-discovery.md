# G2-C.1 · Autoridad del pedido mayorista — discovery y decisión

Base: `8d9a83848ead5f0a28de10f8dbe223b843ce553f` (main, G2-C mergeado).
Rama: `claude/g2-c1-wholesale-stock-authority`.
Migración: `supabase/migrations/20261005120000_g2c1_wholesale_stock_authority.sql`.

> **PEDIDO MAYORISTA = ESTADO COMERCIAL. COMPROBANTE = MOVIMIENTO ECONÓMICO Y DE STOCK.**
>
> Un pedido mayorista registra intención comercial y pasa por estados. Ningún
> estado mueve inventario. La salida real de stock ocurre **sólo** al convertir
> el pedido en comprobante por el checkout canónico, que conserva `inventory_id`
> y el COGS.

Fuentes del discovery: el código de `src/`, las migraciones de
`supabase/migrations/` y el **catálogo vivo** de una base local con el historial
aplicado (consultada sólo en lectura). Producción se consultó una vez, en
lectura, por el owner (§4).

---

## 1. Hechos verificados

### 1.1 Schema real

`public.wholesale_orders` (baseline `20260628190324`, sin cambios posteriores de
columnas):

| Columna | Tipo | Nota |
|---|---|---|
| `business_id` | uuid NOT NULL | FK `businesses` ON DELETE CASCADE |
| `customer_id` | uuid NOT NULL | FK `wholesale_customers` ON DELETE RESTRICT |
| `status` | text NOT NULL DEFAULT `'pending_whatsapp'` | CHECK: `pending_whatsapp, pending_review, approved, rejected, invoiced, delivered, cancelled` |
| `admin_notes`, `notes` | text | |
| `updated_at` | timestamptz DEFAULT now() | **sin trigger**: lo escribe quien actualiza |

`public.wholesale_order_items`:

| Columna | Tipo | Nota |
|---|---|---|
| `order_id` | uuid NOT NULL | FK ON DELETE CASCADE |
| `business_id` | uuid NOT NULL | sin FK y sin CHECK contra el negocio del pedido |
| `inventory_item_id` | uuid NULL | FK `inventory` ON DELETE SET NULL; sin CHECK de tenant |
| `quantity` | integer NOT NULL | **sin CHECK** antes de G2-C.1 |
| `stock_processed` | boolean DEFAULT false | nullable |
| `stock_processed_at` | timestamptz | |
| `stock_movement_id` | uuid | sin FK a `inventory_movements` |

`public.inventory_movements`: `quantity <> 0`, `business_id` NOT NULL, índice
`(reference_type, reference_id)`, sin índice único de idempotencia.
`public.inventory`: `trg_sync_inventory_stock` copia `stock_quantity` → `stock`.

**Triggers sobre `wholesale_orders`, `wholesale_order_items` y
`wholesale_customers`: ninguno.**

### 1.2 RLS y grants antes de G2-C.1 (catálogo vivo)

`authenticated` tenía `SELECT, INSERT, UPDATE` a nivel **tabla** sobre las tres
tablas mayoristas (sin DELETE). `anon`: nada.

| Tabla | Policy | Cmd | Roles | Condición |
|---|---|---|---|---|
| `wholesale_orders` | `wo_staff_read` | SELECT | authenticated | `business_id = current_business_id() AND feature('mayorista') AND current_user_can('wholesale')` |
| | `wo_staff_insert` | INSERT | authenticated | `business_id = current_user_business_id() AND feature AND can_manage_wholesale()` |
| | `wo_staff_update` | UPDATE | authenticated | ídem |
| | `wo_customer_insert` | INSERT | PUBLIC | `customer_id` es del cliente autenticado — **sin restricción de `status`** |
| | `wo_customer_select` | SELECT | PUBLIC | ídem |
| `wholesale_order_items` | `woi_staff_read` / `_insert` / `_update` | | authenticated | igual que arriba |
| | `woi_customer_insert` | INSERT | PUBLIC | el `order_id` es de un pedido propio — **sin restricción de marcadores** |
| | `woi_customer_select` | SELECT | PUBLIC | ídem |

Origen: `20260629115920_caso_e_wholesale_rls_hardening.sql` y
`20260908140000_lote3_is_staff_action_policies.sql:225-236`.

Autoridad canónica tenant-bound disponible:
`public.current_user_can_in_business(p_business_id, 'wholesale')` (SEC-08A
Fase B). Default `admin, manager, sales` + owner, respeta overrides. Un cliente
del portal no tiene perfil en `profiles` y no la pasa.

### 1.3 Escrituras que existían

| Qué | Dónde | Quién |
|---|---|---|
| `wholesale_orders` INSERT | `portalService.createOrder` | cliente del portal, sin `status` |
| `wholesale_orders.status` UPDATE | `portalService.updateOrderStatus` | navegador, UPDATE directo |
| `wholesale_order_items` INSERT | `portalService.createOrder` | cliente, sin marcadores |
| `inventory` / `inventory_movements` / `stock_*` | `portalService._processWholesaleStock` | navegador |
| `inventory` / `inventory_movements` / `stock_*` | `public.repair_missing_stock_movements` | server (SECDEF), manual |

Ninguna Edge Function toca tablas mayoristas.

### 1.4 El writer del navegador era inalcanzable

Los dos callers de `updateOrderStatus` estaban en `src/pages/Mayorista.tsx`:

```ts
await updateOrderStatus(order.id, s)                                   // botones: SIN businessId
await updateOrderStatus(convertOrder.id, 'invoiced', undefined, businessId || undefined)
```

y `updateOrderStatus` cortaba con `if (!businessId) return` antes del stock. Los
botones nunca movían stock; el único caller con `businessId` usaba `'invoiced'`,
que no está en `DEDUCT_ON` ni en `REVERT_ON`. El clamp `Math.max(0, …)` era un
bug **latente**. `git log -S`: el caller entró con `da8e960` (2026-05-08), el
writer con `634a2fa` (2026-05-12), y el caller nunca se actualizó.

### 1.5 El único camino que mueve stock: «Convertir en comprobante»

El botón se ofrece para cualquier pedido que no esté `invoiced`, `cancelled` ni
`rejected`. Abre `ComprobanteProModal` con las líneas del pedido y su
`inventory_id` (`Mayorista.tsx`, `initialItems`), el checkout canónico
descuenta stock (`reference_type='comprobante'`) y registra el COGS, y después
`onCreado` marca el pedido `invoiced`. No hay vínculo en la base entre ese
comprobante y el pedido: el modal no recibe `orderId` para pedidos mayoristas y
`comprobantes.order_id` es FK a `orders` (órdenes de reparación).

---

## 2. Incompatibilidad encontrada con el primer contrato

El primer contrato de G2-C.1 pedía «`approved` descuenta, `cancelled`/`rejected`
revierte». Implementarlo volvía alcanzable una salida que hoy no existe **sin**
quitar la del comprobante: el flujo real `approved → convertir → invoiced`
habría descontado **dos veces** (10 − 4 al aprobar, − 4 al convertir: 2 en vez
de 6). Se detuvo el lote antes de implementar y se escaló la decisión.

## 3. Decisión de producto — Opción A

**El comprobante es la ÚNICA autoridad de salida real de stock** para pedidos
mayoristas.

| Estado destino | Efecto en inventario |
|---|---|
| `pending_whatsapp`, `pending_review` | ninguno |
| `approved` | **ninguno** |
| `rejected` | **ninguno** |
| `cancelled` | **ninguno** |
| `invoiced` | ninguno desde el pedido (lo movió el comprobante) |
| `delivered` | ninguno |

## 4. Evidencia de producción (lecturas read-only, 2026-09-22)

| Consulta | Resultado |
|---|---|
| `wholesale_orders` por estado | **0 filas** |
| `wholesale_order_items`: procesados / `quantity <= 0` / total | **0 / 0 / 0** |
| `inventory_movements` con `reference_type='wholesale_order'` | **0 filas** |

No hay legado que preservar: **no** se implementa rama de reversa histórica,
**no** se crean movimientos `wholesale_order`, **no** hay backfill. La migración
verifica esas tres condiciones al aplicarse y **aborta** si dejaron de ser
ciertas.

---

## 5. Implementación

### 5.1 RPC canónica

```sql
public.update_wholesale_order_status_atomic(
  p_business_id uuid,
  p_order_id    uuid,
  p_status      text,
  p_admin_notes text DEFAULT NULL
) RETURNS jsonb
```

- `SECURITY DEFINER`, owner `postgres`, `SET search_path = pg_catalog, pg_temp`,
  todo schema-qualified. DEFINER porque, cerrado el UPDATE directo,
  `authenticated` ya no puede escribir la fila.
- Grants: `REVOKE ALL FROM PUBLIC, anon, service_role`;
  `GRANT EXECUTE TO authenticated`. ACL resultante:
  `{postgres=X/postgres, authenticated=X/postgres}`.
- Autoridad, en este orden:
  1. `auth.uid()` no nulo (no hay `p_user_id`);
  2. `public.current_user_can_in_business(p_business_id, 'wholesale')`;
  3. `current_user_business_id() = p_business_id` y
     `business_has_feature('mayorista')` — la misma condición de tenant y plan
     que exigía `wo_staff_update`, reusando el helper canónico en vez de
     replicar la tabla de planes.
- `p_status` ∈ los 7 estados del CHECK (22023 si no). La base **no** impone un
  grafo de transiciones, igual que antes: el grafo vive en la UI y la
  conversión marca `invoiced` desde cualquier estado no terminal.
- `SELECT … WHERE id = p_order_id AND business_id = p_business_id FOR UPDATE`.
  Un pedido de otro tenant es indistinguible de uno inexistente (P0002).
- Actualiza **sólo** `status`, `admin_notes`, `updated_at`. **No** toca
  `inventory`, `inventory_movements` ni `stock_*` (lo verifican una
  postcondición, la matriz y el guard).
- Idempotente: el mismo estado y las mismas notas no escriben la fila
  (`changed=false`, `updated_at` intacto). `p_admin_notes` NULL conserva las
  notas; texto en blanco las borra.
- Devuelve `{ok, order_id, business_id, status, previous_status, admin_notes,
  changed, updated_at}`.

Diferencia de autoridad frente a la policy anterior: `can_manage_wholesale()`
era por **rol** e ignoraba overrides; la capability `wholesale` tiene los
mismos defaults (`owner, admin, manager, sales`) y respeta overrides en ambos
sentidos. Sólo cambia algo para quien tenga un override explícito de
`wholesale`.

### 5.2 Cierre del UPDATE directo

- `REVOKE UPDATE ON wholesale_orders, wholesale_order_items FROM PUBLIC, anon, authenticated`.
- `DROP POLICY wo_staff_update`, `DROP POLICY woi_staff_update` — sin grant,
  una policy muerta es una puerta que el próximo GRANT reabre.
- Discovery de UPDATE legítimos: en `src/` sólo existían `updateOrderStatus` y
  `_processWholesaleStock`, los dos reemplazados. Ninguna Edge Function escribe
  estas tablas. `wholesale_customers` **no** se toca.

### 5.3 Alta: estado inicial y marcadores neutros

Dos capas:

1. **Privilegio por columna.** `REVOKE INSERT` de tabla y `GRANT INSERT` sólo
   de las columnas que manda `createOrder`:
   - pedidos: `business_id, customer_id, order_number, subtotal, total, notes`;
   - items: `order_id, business_id, inventory_item_id, product_name,
     product_code, quantity, unit_price, subtotal`.

   Nombrar `status`, `admin_notes` o un marcador en un INSERT da 42501. El
   estado nace del DEFAULT (`pending_whatsapp`, verificado en la
   precondición); los marcadores, de sus defaults (`false/NULL/NULL`).
2. **Policy.** `wo_customer_insert` y `wo_staff_insert` exigen además
   `status = 'pending_whatsapp' AND admin_notes IS NULL`; `woi_customer_insert`
   y `woi_staff_insert`, `stock_processed IS NOT TRUE AND stock_processed_at IS
   NULL AND stock_movement_id IS NULL`. Si un GRANT futuro devolviera las
   columnas, la fila igual tiene que nacer neutra. Las condiciones de identidad
   y tenant de cada policy no cambian: nadie gana permisos.

Por qué **no** un CHECK de tabla sobre los marcadores: también aplicaría a
`repair_missing_stock_movements` (SECDEF), que hoy puede marcarlos, y la haría
abortar entera. Esa herramienta queda fuera de G2-C.1 por decisión explícita
(§6).

### 5.4 Cantidad

`ALTER TABLE wholesale_order_items ADD CONSTRAINT
wholesale_order_items_quantity_positive CHECK (quantity > 0)` — validado; rige
también para `postgres`.

### 5.5 Frontend

- `portalService.ts`: se elimina `_processWholesaleStock` entero (con el
  `Math.max(0, …)`, la lectura y escritura de `inventory`, el INSERT de
  `inventory_movements` y el UPDATE de `stock_*`). `updateOrderStatus(businessId,
  orderId, status, adminNotes?)` exige `businessId`, llama **sólo** a la RPC y
  propaga el error.
- `Mayorista.tsx`: los botones de estado pasan por `handleCambiarEstado`, que
  manda `businessId`, usa el estado que devolvió el servidor y muestra el
  rechazo en vez de tragarlo. El `onCreado` de la conversión marca `invoiced`
  con la RPC y, si falla, avisa que el comprobante **sí** se creó.

### 5.6 Postcondiciones de la migración

1. RPC por firma exacta, SECDEF, owner `postgres`, `search_path=pg_catalog, pg_temp`.
2. `anon` y `PUBLIC` sin EXECUTE; `authenticated` con EXECUTE.
3. Autoridad tenant-bound, `FOR UPDATE`, y ninguna mención a inventario ni marcadores.
4. Los 7 estados de la RPC son exactamente los del CHECK.
5. Ninguna columna de las dos tablas admite UPDATE de `authenticated`/`anon`;
   no queda policy de UPDATE.
6. El alta no puede nombrar estado, notas administrativas ni marcadores, y
   conserva exactamente las columnas de `createOrder`; `anon` no inserta.
7. `authenticated` conserva SELECT.
8. Las policies de alta fuerzan `pending_whatsapp` y marcadores neutros.
9. CHECK `quantity > 0` instalado y validado.
10. Ningún trigger sobre las tablas mayoristas.

### 5.7 Pruebas

- `tests/sql/g2c1_wholesale_stock_authority.test.sql` — **146 aserciones**,
  dentro de `BEGIN … ROLLBACK`: los 23 casos del contrato, más RBAC (tech,
  override `wholesale=false`, plan sin mayorista, sin `auth.uid()`), la
  defensa en profundidad de las policies con la columna concedida a propósito,
  un fallo forzado **después** de la escritura (rollback total) y el flujo de
  conversión completo (el stock sale una vez, del comprobante, con la
  aritmética de G2-C).
- `scripts/guards/g2c1-wholesale-authority.mjs` — guard estático con
  **35 mutaciones** en el self-test.
- `tests/components/g2c1WholesaleOrderStatus.test.ts` — 5 tests de runtime del
  servicio: sólo la RPC, ninguna tabla, falla sin `businessId`, propaga el
  rechazo.
- Verificación HTTP manual (no versionada): `@supabase/supabase-js` real contra
  PostgREST de un stack local aislado — alta del cliente con el INSERT masivo
  de items (`?columns=`) bajo los grants por columna, rechazo de `status` y de
  marcadores, PATCH directo rechazado, RPC y recorrido completo de estados con
  el stock intacto: 19 aserciones OK.
- Concurrencia: la RPC sólo escribe la fila del pedido y la bloquea con
  `FOR UPDATE`; no toca inventario, así que no hay orden de locks que
  coordinar. Se cubre estructuralmente (postcondición 3, caso 0 de la matriz y
  el guard). No se agregó un test de dos sesiones: bajo la Opción A no hay
  efecto de stock que pueda duplicarse.

---

## 6. Riesgos residuales

1. **G2-C.2 sigue pendiente.** `adjust_stock_on_order_item()` no toma
   `FOR UPDATE` sobre `inventory` y `delete_supplier_purchase_safe()` bloquea la
   compra pero no la fila de inventario. G2-C.1 no escribe inventario, así que
   no agrega un writer más, pero la concurrencia global sigue abierta.
2. **`StockRepairTool` / `repair_missing_stock_movements`.** Trata como «venta
   sin movimiento» a todo ítem mayorista con `stock_processed=false` cuyo pedido
   no esté `cancelled`/`rejected`, incluidos `pending_*` e `invoiced`.
   Repararlo **descuenta stock por un pedido**, contra la Opción A, y duplica la
   salida de un pedido ya convertido en comprobante. Es SECDEF: los grants y
   policies de G2-C.1 no lo frenan. Fuera de alcance por decisión explícita.
3. **Conversión pedido → comprobante sin vínculo en la base.** El checkout y el
   `invoiced` posterior son dos operaciones separadas disparadas desde el
   navegador. Si la segunda falla, el comprobante existe y el pedido no quedó
   `invoiced` (la UI ahora lo avisa); el botón «Convertir» sigue disponible y
   una segunda conversión emitiría otro comprobante y otra salida. No hay forma
   de reconciliar desde la base qué comprobante corresponde a qué pedido. No se
   rediseña el checkout en este lote.
4. **Cantidades del pedido vs. del comprobante.** El POS permite editar las
   líneas antes de confirmar, así que el comprobante puede tener cantidades
   distintas de las del pedido. El stock sale por el comprobante (la autoridad),
   pero el pedido `invoiced` puede describir otra cosa. Después de G2-C.1 los
   items del pedido **no** se pueden editar desde el navegador (no había UI que
   lo hiciera); el comprobante sigue su propio contrato (G2-B).
5. **Tenant del alta del cliente (preexistente).** `wo_customer_insert` no
   verifica que `business_id` sea el negocio del cliente, y los items no están
   atados al negocio del pedido. G2-C.1 no reescribe esa condición: ningún
   estado mueve stock, así que ya no puede tocar inventario ajeno, pero un
   cliente puede dejar un pedido en la bandeja de otro negocio.
6. **Grafo de transiciones.** La base acepta cualquiera de los 7 estados, como
   antes. El grafo vive en la UI.
7. **Override de capability.** Quien tenga `wholesale: true` explícito sin ser
   `owner/admin/manager/sales` ahora puede cambiar estados por la RPC (la UI,
   que decide por rol, no le muestra los botones); quien tenga
   `wholesale: false` pierde un acceso que la policy por rol le daba.
