# SEC-08A — Orders Data Visibility

Lote de seguridad sobre **qué datos recibe realmente el browser** cuando abre una orden,
aunque la UI los oculte. No trata sobre autoridad de escritura: eso fue LOTE 3.

Baseline: `origin/main` = `20251c6c9a06edb867d450e282b26ee2525a83c8`
(ancestro `2da39a3e42e90db6f6d75e074fdd65340e8f9626`, tag `stable-security-lote3-action-authority-v1`).
Rama: `claude/sec08a-orders-data-visibility`.

---

## 1. El problema, medido

`orders_select` es `business_id = current_business_id() AND is_staff()`. Es una frontera de
**filas**. No dice nada sobre **columnas**, y `authenticated` tenía `SELECT` sobre la tabla
entera. Medido contra PostgREST real en el stack local, con JWT firmados:

| actor | `orders` | `orders_view_financials` | `device_access_secret` | qué recibía |
|---|---|---|---|---|
| tech | ✔ | ✘ | ✔ | `total_cost:99999`, `estimated_total:123456`, `labor_cost:7777`, `amount_paid:5555`, `paid_at` |
| viewer | ✔ | ✘ | ✘ | lo mismo, **más** `device_password:"pin:8391"` |
| sales | ✔ | ✔ | ✘ | `device_password:"pin:8391"` |
| cashier | ✔ | ✔ | ✘ | `device_password:"pin:8391"` |

Todas con `200 OK`. Y el mismo dato salía por la relación anidada, sin tocar `/orders`:

```
GET /customers?id=eq.<id>&select=id,name,orders(id,total_cost,estimated_total)   → 200
GET /customers?id=eq.<id>&select=orders(id,device_password)                      → 200
GET /customers?id=eq.<id>&select=*,orders(*)                                     → 200
```

Controles que YA estaban bien en el baseline: `anon`, tenant ajeno y perfil inactivo recibían
`[]` (la RLS de filas funcionaba).

---

## 2. Clasificación de `public.orders` (22 columnas, leídas del catálogo productivo)

| clase | columnas |
|---|---|
| **O0 · operativas** | `status`, `priority`, `notes`, `access_mode`, `created_at`, `updated_at`, `completed_at` |
| **O1 · financieras** | `estimated_total`, `estimated_total_currency`, `labor_cost`, `total_cost`, `amount_paid`, `paid_at` |
| **O2 · secreto del equipo** | `device_password` |
| **O3 · identidad / vínculos** | `id`, `business_id`, `customer_id`, `device_id`, `technician_id`, `assigned_profile_id`, `created_by`, `comprobante_id` |

Notas de clasificación:

* `access_mode` es **O0**, no O2: dice si hay PIN/patrón/contraseña, no cuál. La UI lo necesita
  para etiquetar la tarjeta y no revela nada.
* `total_cost` es el **COGS** que escribe `recalculate_order_total`, no el precio al cliente
  (ver `src/hooks/useOrderCanonicalBalance.ts`). Este lote no cambia qué significa; sólo quién
  puede leerlo.
* `comprobante_id` queda **O3 seleccionable**, consistente con `v_order_payment_state`, que ya
  expone `comprobante_id`/`comprobante_numero` a cualquier rol del negocio a propósito.

---

## 3. Arquitectura elegida

Mínima, y sin fuentes de verdad nuevas:

1. **GRANT de `SELECT` por columna** sobre `public.orders`. Las 6 columnas O1 y `device_password`
   dejan de ser seleccionables por el browser; `anon` pierde el `SELECT` de tabla entero (nunca
   tuvo policy). La RLS no se toca: sigue siendo la frontera de filas.
2. **Importes**: se reutiliza la ruta que ya existía, `get_order_financial_amounts` (P0-A.1U1).
   Se le agregan las columnas propias de la orden que antes se leían crudas, y su autorización
   pasa a ser `current_user_can('orders_view_financials')` en vez de una lista de roles
   hardcodeada, para que los overrides por perfil valgan en los dos sentidos.
3. **Secreto del equipo**: **no se crea nada**. Ya existe `reveal_order_device_access`
   (Mobile2A): on-demand, Vault, gate por `device_access_secret`, auditado en
   `private.order_device_access_audit`. `orders.device_password` sigue siendo el shadow legacy
   **escribible** que Mobile2A necesita durante la ventana de compatibilidad — este lote cierra
   sólo su **lectura**.

Por qué RLS no alcanzaba: RLS decide filas, no columnas. Un `CASE WHEN capability THEN col END`
dentro de una vista sí resolvería la visibilidad, pero dejaría la tabla cruda abierta y agregaría
un segundo read model. El GRANT por columna cierra el bypass en la raíz.

---

## 4. Contrato de la tabla cruda después del candidato

```sql
REVOKE SELECT ON TABLE public.orders FROM anon;
REVOKE SELECT ON TABLE public.orders FROM authenticated;
GRANT SELECT (
  status, priority, notes, access_mode, created_at, updated_at, completed_at,
  id, business_id, customer_id, device_id, technician_id, assigned_profile_id,
  created_by, comprobante_id
) ON TABLE public.orders TO authenticated;
```

`INSERT` / `UPDATE` / `DELETE` y las cuatro policies quedan **exactamente igual**. En particular
`UPDATE (device_password)` sigue concedido: el trigger
`mobile2a_mirror_legacy_device_password` depende de eso, y la migración tiene una postcondición
que falla si alguien lo rompe.

Efecto colateral esperado y deseado: `select=*` sobre `orders` ahora responde `42501` para
**todos** los roles del browser, incluido el owner. La autoridad sobre los importes es la ruta,
no el privilegio de columna.

---

## 5. Evidencia

### 5.1 SQL (`tests/sql/sec08a_orders_data_visibility.test.sql`)

92 aserciones, 0 fallas, todo dentro de una transacción con `ROLLBACK`. Incluye los dos
**controles negativos del propio test**: reabre `total_cost` y `device_password` dentro de la
transacción, comprueba que entonces el valor SÍ llega, y los vuelve a cerrar. Sin eso, un test
que sólo ve `DENIED` no prueba que sepa mirar.

### 5.2 PostgREST real (`scripts/security/sec08a-postgrest.mjs`)

160 requests, 361 aserciones, 0 fallas. Cada aserción negativa comprueba que **el valor testigo
no aparece en el cuerpo**, no que el status sea feo.

| bloque | resultado |
|---|---|
| lectura operativa (7 roles) | 200, con `status` y `access_mode`, sin importes ni secreto |
| pedido financiero explícito (9 actores × 6 columnas + `select=*`) | 401/403, valor ausente |
| pedido del secreto (9 actores + anon) | 401/403, valor ausente |
| bypass anidado (7 roles × 6 rutas `customers`/`devices` → `orders(...)`) | 401/403, valor ausente |
| ruta autorizada de importes (owner, admin, manager, sales, cashier) | `authorized:true` con los 4 importes + derivados |
| ruta de importes sin capacidad (tech, viewer, inactive, anon) | `authorized:false`, `rows: []` |
| ruta del secreto (owner, admin, manager, tech) | devuelve el secreto de Vault |
| ruta del secreto (sales, cashier, viewer, inactive, tenant ajeno, anon) | denegada, valor ausente |
| override `false → true` (tech) | recibe importes por la ruta; la tabla cruda **sigue** denegada |
| override `true → false` (manager) | deja de recibir importes |
| override `device_access_secret` en ambos sentidos | respetado |
| tenant ajeno | 0 filas / `FORBIDDEN` |
| dual-write legacy Mobile2A | `PATCH device_password` → 204, persiste, y **no** lo vuelve legible |

### 5.3 Sesión real del navegador

Con la app corriendo contra el stack local y el token real del usuario logueado:

```
/orders?select=*                          → 403 42501
/orders?select=id,total_cost              → 403 42501
/orders?select=id,device_password         → 403 42501
/customers?select=id,orders(total_cost)   → 403 42501
/orders?select=id,status                  → 200  [{"id":"…","status":"new"}]
```

Con rol `owner`: la lista muestra los totales, la ficha del cliente muestra la columna Total, y
"Revelar" trae el PIN sólo al pedirlo. Con el mismo usuario degradado a `tech`: la lista muestra
`—` e "Importes restringidos", la ficha del cliente **no dibuja la columna Total**, y no hay
ningún `$0` inventado.

---

## 6. Realtime, Edge Functions y RPCs

* **Realtime**: `public.orders` **no** está en ninguna publicación, ni en local ni en producción
  (`supabase_realtime` sólo publica `notifications`). Tampoco hay ningún binding
  `postgres_changes` sobre `orders` en `src/`. → **NO REACHABLE REALTIME ORDER READER**.
* **Edge Functions**: ninguna menciona `orders`.
* **Vistas dependientes**: `v_order_payment_state` (sin importes, `authenticated` SELECT, por
  diseño), `v_order_financial_status` (`authenticated` **sin** SELECT), `v_finance_order_cogs_gaps`
  (no lee columnas O1 de `orders`; sus costos vienen de `order_items`/`order_parts` — ver §8).
* **Funciones alcanzables por `authenticated` que tocan esas columnas**: sólo
  `get_my_first_steps()`, y únicamente porque un **comentario** menciona `orders.amount_paid`;
  devuelve cinco booleanos.

---

## 7. Lectores migrados

| archivo | antes | ahora |
|---|---|---|
| `src/hooks/useOrders.ts` | `select('*', head)` + `estimated_total, labor_cost` | `select('id', head)`; importes por la RPC |
| `src/pages/Orders.tsx` | `order.labor_cost \|\| order.estimated_total` | mapa autorizado; `—` si no |
| `src/hooks/useOrderSimple.ts` | `select('*')` ×2 | lista explícita + RPC; sin autorización los importes son `undefined`, no `0` |
| `src/pages/Customers.tsx` | `id, customer_id, total_cost, estimated_total` | `id, customer_id` + RPC |
| `src/services/api.ts` (`customersService.getById`) | `orders(id, status, total_cost, estimated_total, …)` | `orders(id, status, created_at, …)` |
| `src/pages/CustomerDetail.tsx` | leía los importes anidados | RPC + `showOrderTotals` (autoridad del servidor) |
| `src/hooks/useDashboardStats.ts` | `select('*', head)` ×3, `total_cost, amount_paid` | `select('id', head)`, ids + RPC, `pendingPaymentsAuthorized` |
| `src/pages/DashboardNew.tsx` | `$${pendingPayments}` | `—` si el servidor no autorizó |
| `src/components/cobro/ModalCobro.tsx` | `total_cost, amount_paid` ×2 | operativo + RPC |
| `src/services/api.ts` (`ordersService`), `src/hooks/useOrder.ts`, `src/services/orderService.ts` | `select('*')` | columnas explícitas (código sin consumidores, ver §8) |

`src/lib/supabase.ts`: los campos financieros de `Order` pasan a **opcionales**. Declararlos
obligatorios hacía que cualquier lector asumiera que siempre están, que es el supuesto que este
lote rompe.

---

## 8. Hallazgos separados (NO se tocan acá)

1. **SEC-08B · costos de inventario en la orden** — `order_items.precio_unitario`/`costo_unitario`
   y `order_parts.internal_cost`/`sale_price` siguen siendo legibles por cualquier miembro del
   negocio: la policy de `order_items` es `FOR ALL` con sólo pertenencia (ni `is_staff` ni
   capacidad). `useOrders`, `useOrderSimple` y `Orders.tsx` los leen. Son **precios de la orden**
   aunque vivan en otra tabla: cerrar `orders.total_cost` sin cerrar esto deja un camino parcial.
2. **SEC-08C · visibilidad financiera de proveedores** — fuera de alcance por definición.
3. **Pivot vía `comprobantes`** — `comprobantes_select` gatea sólo por tenant, así que un `tech`
   puede leer el total facturado de una orden por `comprobantes.order_id`. Es la visibilidad de
   comprobantes, no de `orders`, y merece su propio lote.
4. **`v_finance_order_cogs_gaps`** — `authenticated` tiene SELECT y la vista expone costos por
   orden. Es `security_invoker`, así que hereda la RLS de `order_items`/`order_parts`; se cierra
   con el hallazgo 1.
5. **Lectores de órdenes sin consumidores** — `src/hooks/index.ts`, `src/hooks/useOrder.ts`,
   `src/services/orderService.ts` y `ordersService.getAll/getById` no los importa nadie. Acá se
   les corrigió el `select`, pero merecen retiro, como se hizo con `order_checklists`.
6. **`anon` conserva `INSERT`/`UPDATE`/`DELETE` de tabla sobre `orders`** — privilegio muerto (no
   hay policy para `anon`), pero es superficie vestigial. Territorio LOTE 3.
7. **`user_can_view_order_amounts` ignora los overrides de `profiles.permissions`** — sigue
   siendo la autoridad de `get_allocation_workspace`, `get_payment_allocations` y
   `get_customer_unallocated_credit` (cuenta corriente). Acá se dejó intacta a propósito para no
   mover esos tres consumidores; la divergencia queda registrada.

---

## 9. Producción

**NO MERGE · NO DEPLOY · NO DB PUSH · NO PRODUCTION WRITE.**

Preflight de producción, sólo metadata de catálogo (`docs/security-sec08a/production-preflight.json`):
252 migraciones, última `20260910120000`; 22 columnas; `anon` y `authenticated` con las 7
privilegios de tabla, **ninguna** columna denegada; `orders` fuera de `supabase_realtime`; las
rutas canónicas presentes con los grants esperados; 119 órdenes, 50 con shadow legacy de
`device_password` no vacío. Es decir: la fuga descrita en §1 **está viva en producción hoy**.

### Orden de despliegue (cuando se apruebe)

**DB primero NO sirve acá.** El frontend desplegado hoy hace `select('*')` sobre `orders` en
`useOrderSimple` (detalle de orden) y `select('*', head)` en el dashboard y la lista: aplicar la
migración antes que el frontend rompe esas tres pantallas con `42501` para **todos** los roles.

El orden correcto es **frontend → DB**, como en `p0-businesses-portal-rls`. Durante esa ventana:

* el frontend nuevo pide sólo columnas operativas, que la DB vieja concede → **sin ruptura**;
* pide los importes por `get_order_financial_amounts`, que en la DB vieja **todavía no devuelve**
  `estimated_total`/`labor_cost`/`total_cost`/`amount_paid` → esas pantallas muestran `—` /
  "Importes restringidos" hasta que la migración entre. Degradación visible, **nunca un `$0`
  inventado**, y nunca una fuga;
* la autorización durante la ventana la sigue dando `user_can_view_order_amounts` (lista de
  roles), no la capacidad: los overrides recién valen después del `db push`.

Verificar post-deploy con la matriz de §5.2 apuntada al proyecto productivo.
