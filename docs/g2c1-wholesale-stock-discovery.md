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
  estas tablas. `wholesale_customers` tiene su propio cierre (§5.3b).

### 5.3 Alta del pedido: RPC atómica, la base es autoridad

> Reemplaza a la primera versión de este lote (INSERT por columnas + policies
> con estado inicial). La revisión humana del PR #144 encontró que el INSERT
> directo seguía dejando en manos del navegador el **tenant**, el **ata item →
> pedido → inventario**, la **aprobación del cliente** y, sobre todo, el
> **precio y los totales** (§7).

```sql
public.create_wholesale_order_atomic(
  p_portal_slug text,
  p_items       jsonb,          -- [{ inventory_item_id, quantity }, ...]
  p_notes       text DEFAULT NULL
) RETURNS jsonb
```

- `SECURITY DEFINER`, owner `postgres`, `search_path = pg_catalog, pg_temp`,
  ACL `{postgres, authenticated}` (REVOKE a PUBLIC, `anon`, `service_role`).
- **Identidad**: `auth.uid()`. No recibe `customer_id` ni `business_id`.
- **Negocio**: se resuelve por el **slug** del portal (`UNIQUE`, verificado en
  una precondición), con la **misma autoridad** que usa el portal para decidir
  si toma pedidos: `public.get_wholesale_portal_features(p_slug)` →
  `mayorista AND active` (portal encendido + plan + suscripción no suspendida).
  No se replica la tabla de planes.
- **Cliente**: el `wholesale_customers` del actor **en ese negocio**; tiene que
  haber exactamente uno (`auth_user_id = auth.uid() AND business_id = negocio`),
  `approved = true` y `suspended = false`. Se bloquea `FOR UPDATE`.
- **Items**: array no vacío; por línea sólo `inventory_item_id` (uuid) y
  `quantity` (entero > 0); sin repetidos. **Cualquier otra clave** del
  navegador (`unit_price`, `product_name`, `business_id`, `stock_processed`,
  …) **se ignora**.
- **Producto**: del **mismo negocio**, `is_active` y `visible_in_wholesale` —
  el contrato del catálogo (`getCatalog`). El stock **no** se exige: el pedido
  no reserva stock, la sobreventa está permitida (G2-C) y la disponibilidad se
  confirma en la revisión. Un producto de otro tenant es indistinguible de uno
  inexistente (`PRODUCT_NOT_AVAILABLE`, P0002).
- **Precio**: la regla del catálogo (`PortalCatalog.tsx`), ahora en la base:
  `precio_mayorista > 0 ? precio_mayorista : sale_price`. `product_name` y
  `product_code` salen de `inventory`. Subtotal por línea y subtotal/total del
  pedido se calculan en la base.
- `order_number` server-side (`PW-` + 10 hex). `status` = DEFAULT
  (`pending_whatsapp`), `admin_notes` NULL, marcadores en sus defaults.
- `last_order_at` del cliente lo escribe la RPC. `total_orders/total_spent`
  **no**: la RPC que el navegador llamaba para eso
  (`increment_wholesale_customer_stats`) no existe en ninguna migración, así
  que hoy nunca se actualizan; darles semántica nueva queda fuera.
- **Atomicidad**: una sola función, una sola transacción. Todo el pedido se
  valida antes de insertar; cualquier fallo (incluido uno después de insertar
  encabezado e items) revierte todo.
- Devuelve `{ok, order_id, order_number, business_id, customer_id, status,
  subtotal, total, notes, created_at, items[]}` con las líneas canónicas.

Con la RPC como única alta, el INSERT directo se cierra **entero**:
`REVOKE INSERT` de `wholesale_orders` y `wholesale_order_items` y
`DROP POLICY wo_customer_insert, wo_staff_insert, woi_customer_insert,
woi_staff_insert`. Discovery de callers: el único INSERT en `src/` era
`createOrder`; ninguna Edge Function escribe estas tablas; ningún flujo de staff
crea pedidos o items a mano.

Por qué **no** un CHECK de tabla sobre los marcadores: también aplicaría a
`repair_missing_stock_movements` (SECDEF), que hoy puede marcarlos, y la haría
abortar entera. Esa herramienta queda fuera de G2-C.1 por decisión explícita
(§6).

### 5.3b `wholesale_customers`: el cliente no se administra a sí mismo

Antes: `authenticated` con INSERT y UPDATE **de tabla**, y `wc_own_update`
(roles PUBLIC) sólo ataba la fila al actor. Un cliente podía autoaprobarse,
quitarse la suspensión, mudar su fila a otro negocio, escribir estadísticas o
verificar su propio WhatsApp; y podía **registrarse** ya aprobado.

Discovery de escrituras legítimas desde el navegador:

| Escritura | Quién | Destino |
|---|---|---|
| `loginCustomer` → `last_login` | cliente | se conserva |
| `insertWholesaleCustomer` → alta | cliente | se conserva, sin campos administrativos |
| `updateCustomerStatus` → `approved/suspended/notes` | staff | pasa a RPC |
| `createOrder` → `last_order_at` | cliente | pasa a la RPC de alta |
| `otpService` → `whatsapp_code/whatsapp_verified` | cliente | **código muerto** (ningún importador); se elimina |

Cierre por **columnas** (el privilegio es por rol, igual para cliente y staff):

- `UPDATE`: sólo `last_login`; `wc_own_update` la limita a la fila propia. Se
  quita `wc_staff_update`.
- `INSERT`: sólo `business_id, auth_user_id, name, business_name, email,
  whatsapp, province, city, instagram`. Todo lo demás nace en su DEFAULT
  (`approved=false`, `suspended=false`, `whatsapp_verified=false`, totales en 0,
  …, verificado en una precondición). `wc_own_insert` además exige ese estado
  neutro (defensa en profundidad). Se quita `wc_staff_insert`: ninguna UI de
  staff crea clientes.
- Administración del staff:

```sql
public.update_wholesale_customer_status_atomic(
  p_business_id uuid,
  p_customer_id uuid,
  p_approved    boolean DEFAULT NULL,
  p_suspended   boolean DEFAULT NULL,
  p_notes       text    DEFAULT NULL
) RETURNS jsonb
```

  Misma autoridad que la RPC de estado de pedidos
  (`current_user_can_in_business(p_business_id, 'wholesale')` + plan del mismo
  negocio), fila `FOR UPDATE`, sólo `approved/suspended/notes/updated_at`
  (NULL conserva), idempotente. SECDEF, `search_path = pg_catalog, pg_temp`,
  ACL `{postgres, authenticated}`.

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
  con la RPC y, si falla, avisa que el comprobante **sí** se creó. Aprobar,
  suspender y reactivar clientes pasan por `handleCambiarCliente` →
  `updateCustomerStatus(businessId, …)` → RPC.
- `portalService.createOrder({ portalSlug, items, notes })`: deja de insertar
  en `wholesale_orders`/`wholesale_order_items`, deja de escribir
  `last_order_at` y de llamar a la RPC de estadísticas inexistente; manda a la
  RPC sólo el slug y, por línea, producto + cantidad. Los rechazos se traducen
  con un mapa cerrado (el texto del servidor no llega a la pantalla).
  `portalFeatureAllowsOrders` queda como pre-chequeo de UX; la autoridad es la
  RPC.
- `PortalCart.tsx`: el mensaje de WhatsApp y el `trackEvent` usan el pedido que
  devolvió la base (líneas, precios y total canónicos), no el carrito.
- `otpService.ts`: eliminado (código muerto que decidía la verificación de
  WhatsApp en el navegador; tras el cierre por columnas, además, ya no podía
  escribir).

### 5.6 Postcondiciones de la migración

1. RPC por firma exacta, SECDEF, owner `postgres`, `search_path=pg_catalog, pg_temp`.
2. `anon` y `PUBLIC` sin EXECUTE; `authenticated` con EXECUTE.
3. Autoridad tenant-bound, `FOR UPDATE`, y ninguna mención a inventario ni marcadores.
4. Los 7 estados de la RPC son exactamente los del CHECK.
5. Ninguna columna de pedidos ni items admite UPDATE de `authenticated`/`anon`;
   no queda policy de UPDATE.
6. Ninguna columna de pedidos ni items admite INSERT directo; no queda policy
   de INSERT.
7. `authenticated` conserva SELECT.
8. La RPC de alta: firma exacta, SECDEF, owner, `search_path`, ACL; usa
   `get_wholesale_portal_features`, `auth.uid()`, exige cliente aprobado y no
   suspendido, precio de la base y producto visible del mismo negocio; bloquea
   al cliente; **no** escribe inventario ni marcadores.
9. CHECK `quantity > 0` instalado y validado.
10. Ningún trigger sobre las tablas de pedidos.
11. La RPC de clientes: firma exacta, SECDEF, owner, `search_path`, ACL,
    autoridad tenant-bound y lock.
12. `wholesale_customers`: el único UPDATE directo es `last_login`.
13. `wholesale_customers`: el INSERT directo es exactamente el del registro;
    SELECT intacto.
14. Sin `wc_staff_update`/`wc_staff_insert`; `wc_own_insert` exige estado neutro.

Precondiciones nuevas: existe `get_wholesale_portal_features(text)`, ninguna
de las tres RPC existe todavía, `wholesale_portal_slug` es `UNIQUE` y los
DEFAULT administrativos de `wholesale_customers` son `false`.

### 5.7 Pruebas

- `tests/sql/g2c1_wholesale_stock_authority.test.sql` — **271 aserciones**,
  dentro de `BEGIN … ROLLBACK`:
  - catálogo de las tres RPC y de los cierres de pedidos, items y clientes;
  - A–E: el cliente no se autoaprueba, no se des-suspende, no cambia
    `business_id` ni `auth_user_id`, no escribe estadísticas, notas, tags,
    `whatsapp_verified` ni `last_order_at`; sí su `last_login`; el alta nace
    neutra; con la columna concedida a propósito la policy sigue rechazando;
  - administración de clientes sólo por la RPC (tech, override, otro tenant y
    el propio cliente rechazados; aprobar/suspender/reactivar; idempotencia);
  - F–H: cliente de A en el portal de B, INSERT directo en B, cliente no
    aprobado, suspendido, staff que no es cliente, portal apagado, plan sin
    mayorista, slug inexistente, sin identidad, `anon`;
  - I, J, N: inventario de B, producto oculto, inactivo o inexistente, items
    malformados (vacío, `NULL`, 0, negativo, fraccionario, texto, sin producto,
    repetido), INSERT directo de items, y un **fallo forzado en el último paso
    del alta** (después de insertar encabezado e items): rollback total;
  - K, L, M, O, P, Q: precio `$1` → 700 / 1000 / 450 según la regla,
    nombre/código canónicos, el item no puede declarar otro negocio, totales
    de la base (8400), pedido + items juntos, `pending_whatsapp`, marcadores
    neutros, `last_order_at` escrito por la RPC, estadísticas intactas;
  - los casos de estado 9–23 (sobre pedidos creados por la RPC);
  - R: alta por la RPC → aprobado → checkout canónico → `invoiced`: el stock
    sale **una** vez, del comprobante, con la aritmética de G2-C.
- `scripts/guards/g2c1-wholesale-authority.mjs` — guard estático con
  **69 mutaciones** en el self-test.
- `tests/components/g2c1WholesaleOrderStatus.test.ts` — **10 tests** de runtime
  del servicio: estado, alta (sólo slug + producto + cantidad; total del
  servidor; mapa cerrado de errores) y administración de clientes.
- `tests/sql/owner_portal_isolation.test.sql` (suite preexistente, fuera de CI):
  CASO 3/4/5/6 adaptados al contrato nuevo (el staff administra por RPC; el
  UPDATE directo ahora falla por privilegio en vez de afectar 0 filas). Sigue
  cortando en el CASO 4 por la lectura de `tech`, igual que en `main`
  (preexistente, Lote 3); con esa única aserción salteada en una copia local,
  los CASOS 1–10 pasan.
- Verificación HTTP manual (no versionada): `@supabase/supabase-js` real contra
  PostgREST de un stack local aislado — registro neutro, autoaprobación
  rechazada, `last_login`, pedido de no aprobado rechazado, aprobación por RPC,
  INSERT directo de pedido e items rechazado, alta con precio adulterado
  guardada al precio canónico, estados, `anon` afuera y stock intacto:
  18 aserciones OK.
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
5. **~~Tenant del alta del pedido~~ — CERRADO en la revisión humana (§7).** El
   alta ya no es un INSERT: la RPC resuelve el negocio por slug y el cliente
   por `auth.uid()` en ese negocio, y ata cada producto al mismo negocio.
   Queda, preexistente y **fuera** de este lote: el **registro** del cliente
   (`wc_own_insert`) no exige que el `business_id` tenga el portal encendido.
   Un usuario puede crear su ficha no aprobada en cualquier negocio; no puede
   pedir ni verse aprobado sin que el staff de ese negocio lo apruebe.
6. **Grafo de transiciones.** La base acepta cualquiera de los 7 estados, como
   antes. El grafo vive en la UI.
7. **Override de capability.** Quien tenga `wholesale: true` explícito sin ser
   `owner/admin/manager/sales` ahora puede cambiar estados por la RPC (la UI,
   que decide por rol, no le muestra los botones); quien tenga
   `wholesale: false` pierde un acceso que la policy por rol le daba.

---

## 7. Revisión humana del PR #144 — blockers cerrados

La revisión aprobó el núcleo de estados (Opción A, RPC de estado, UPDATE
directo cerrado, frontend de estados, `quantity > 0`) y encontró cuatro
blockers en la **alta del pedido** y la **cuenta del cliente**, que seguían
confiando en escrituras del navegador:

| # | Blocker | Cómo quedó |
|---|---|---|
| B1 | `wholesale_customers` permitía autoaprobarse, des-suspenderse, cambiar `business_id`/`auth_user_id` y escribir estadísticas | UPDATE sólo de `last_login`; INSERT sólo del registro con estado neutro; staff por `update_wholesale_customer_status_atomic` (§5.3b) |
| B2 | el INSERT de pedidos no ataba `order.business_id` al negocio del cliente; no exigía aprobado/no suspendido | alta por `create_wholesale_order_atomic`: negocio por slug, cliente del actor en ese negocio, aprobado y no suspendido; INSERT directo cerrado |
| B3 | el INSERT de items no ataba item → pedido → inventario | la RPC deriva `business_id` del pedido e ignora el del navegador; cada producto del mismo negocio, activo y visible |
| B4 | precio, subtotales y total los decidía el navegador | la base aplica `precio_mayorista > 0 ? precio_mayorista : sale_price`, toma nombre/código de `inventory` y calcula subtotales y total |

La RPC de estado y el cierre del UPDATE directo **no** se reescribieron (la
sección 1 y 2 de la migración quedan iguales salvo un comentario que decía que
`wholesale_customers` no se tocaba).

Siguen siendo follow-ups **separados**, antes del cierre definitivo de
BETA-GATE-2 (no se mezclan en #144): G2-C.2, `StockRepairTool`, el vínculo
persistente pedido ↔ comprobante y el reintento / doble conversión cuando el
comprobante se crea pero el `invoiced` falla (§6).
