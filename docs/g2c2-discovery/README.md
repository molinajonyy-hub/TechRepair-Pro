# G2-C.2 — Discovery de concurrencia / locks de inventario

> Discovery solamente. Sin migración, sin cambios de código, sin producción, sin commit.
> Evidencia cruda en `evidence/`, harness reproducible en `harness/`.

## 1. Base, worktree y entorno

| | |
|---|---|
| `origin/main` verificado | `4383a9ff86cfa1dd1399828262cd2b96ebae4304` (coincide con el esperado) |
| Worktree | `.worktrees/g2-c2-stock-locks-discovery` |
| Branch | `claude/g2-c2-stock-locks-discovery`, en `4383a9f`, sin commits |
| Stack | Supabase local **aislado**, `project_id = g2c2-locks`, API 54321 / DB 54322 (Supabase CLI 2.109.1, igual que CI) |
| Replay | Desde cero, **276 migraciones**, hasta `20261005120000_g2c1_wholesale_stock_authority.sql`, sin errores |
| Fuente de verdad | Catálogo vivo del replay (`pg_proc`, `pg_trigger`, `pg_policy`, `pg_constraint`, grants), no grep de migraciones |
| Limpieza | `supabase stop --project-id g2c2-locks --no-backup`; `config.toml` restaurado con `git checkout` |
| No tocado | Rama activa del usuario, stacks `techrepair-vite` y `mobile2a-expand`, otros worktrees, producción |

## 2. Catálogo de writers activos

Consulta: todas las funciones de `public`/`private` cuyo `prosrc` hace `UPDATE … inventory`. Aparecen 9; **7 escriben stock**.
Además: triggers sobre `inventory`/`order_items`, grants de columna y writers del frontend. No hay upserts, reglas,
vistas actualizables, jobs de `pg_cron` ni Edge Functions que escriban `inventory`.

### 2.1 Server-side (catálogo vivo)

| # | Writer vivo (firma exacta) | Sec / owner / search_path | EXECUTE | Autoridad de tenant | Operación de producto que lo alcanza |
|---|---|---|---|---|---|
| W1 | `private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)` | DEFINER / postgres / `public, pg_temp` | sólo postgres; entrada por `public.create_comprobante_checkout_atomic` (DEFINER, `pg_catalog, pg_temp`, authenticated + service_role) | `require_action_authority(biz,'comprobantes')`; inventario con `AND business_id = p_business_id` | POS · `ComprobanteProModal` → `comprobanteService.crear` |
| W2 | `private.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb)` | DEFINER / postgres / `public, pg_temp` | sólo postgres; wrapper público (authenticated + service_role) | `require_action_authority(biz,'inventory'[,'finance'])` | **Ningún caller en `src/`** (RPC dormida) |
| W3 | `private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)` | DEFINER / postgres / `public, pg_temp` | sólo postgres; entrada por `public.annul_comprobante_atomic` (authenticated + service_role) | business del comprobante + miembro activo | Anulación de comprobante con `restore_stock` |
| W4 | `private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)` | DEFINER / postgres / `public, pg_temp` | sólo postgres; wrapper `public.create_supplier_purchase_atomic` (DEFINER, `pg_catalog, pg_temp`, authenticated + service_role) | `require_action_authority(biz,'inventory'[,'finance'])` + validación de productos del negocio | Compras a proveedor · `suppliersService.createPurchase` (Suppliers.tsx) |
| W5 | `public.delete_supplier_purchase_safe(uuid,uuid,uuid)` | DEFINER / postgres / `pg_catalog, pg_temp` | postgres + **authenticated** | `_require_business_member` + `current_user_business_id` + `current_user_can('inventory')` | Eliminar compra impaga |
| W6 | `public.repair_missing_stock_movements(uuid,boolean)` | DEFINER / postgres / `pg_catalog, pg_temp` | postgres + authenticated + service_role | owner/admin + `current_user_can('inventory')` | `StockRepairTool` en `/inventory` |
| W7 | `public.adjust_stock_on_order_item()` — trigger `trg_adjust_stock_on_order_item` BEFORE INSERT OR DELETE OR UPDATE ON `order_items` | DEFINER / postgres / `public, pg_temp` | ACL default (irrelevante para triggers) | **Ninguna sobre el producto**: RLS de `order_items` sólo mira `business_id`; el trigger busca `inventory` sólo por `id` | Repuestos de órdenes: `ModalAgregarItem`, `orderPartsService` (alta y baja), `OrderItemsCard` (baja), `Orders.tsx` (borrar orden → CASCADE) |

No escriben stock pero están en el grafo de locks de `inventory`:

| Objeto | Qué hace | Relevancia |
|---|---|---|
| `private.update_inventory_dollar_prices(uuid,numeric)` | `UPDATE` masivo de `sale_price` de productos USD, orden físico | Participa en el grafo de locks sin orden por id (riesgo residual) |
| `public.tg_inventory_inherit_variant_cost()` | AFTER INSERT, costo de la fila recién creada | Irrelevante |
| `public.sync_inventory_stock_alias()` | BEFORE UPDATE OF `stock_quantity`: `NEW.stock := NEW.stock_quantity` | Misma fila, no es read-modify-write |

### 2.2 Browser / cliente

`authenticated` tiene **UPDATE de columna sobre `stock` y `stock_quantity`**; la RLS `inventory_update` sólo exige
`business_id = current_business_id() AND current_user_can('inventory')`.

| Writer | Tipo | Estado |
|---|---|---|
| `inventoryMovementsService.registerMovement` | Read-modify-write **a través de HTTP**: `SELECT` → cálculo en JS → `UPDATE stock_quantity = <absoluto>` → `INSERT` del movimiento; si falla, `UPDATE` compensatorio | **Vivo sólo** desde `productService.createProduct` / `createVariant` con `registerMovement` (ProductFormModal "registrar stock"): siempre sobre una fila recién creada |
| `inventoryService.*` (purchase/sale/order/credit-note/manualAdjustment) | Igual que el anterior | **Muerto**: `salesStockService` no tiene importadores; `pages/Purchases.tsx` no está ruteada; `useInventory.adjustStock` no se destructura en ningún lado |
| `Inventory.tsx · handleImportInventory` (import de Excel) | `UPDATE … stock_quantity = <celda>` absoluto, **sin movimiento** | **Vivo** (botón de importar) — sobrescritura ciega, no RMW |
| Modal legacy de variante, `handleDuplicate`, `ModalAgregarItem` → `createProduct` | `INSERT` de filas nuevas con stock inicial | Vivos; sin concurrencia posible (fila nueva) |
| `api.ts · inventoryService.updateStock` | `UPDATE stock` absoluto | Muerto (nadie importa ese export) |

## 3. Tabla resumen

Leyenda del lock: **pre-lock** = `PERFORM 1 FROM inventory WHERE business_id=… AND id IN (…) ORDER BY id FOR UPDATE`
antes de mutar. **Período** = `assert_period_open()` → `pg_advisory_xact_lock(hash(business, mes de la fecha económica))`.

| Writer | Lock actual sobre inventory | Multi-item | Orden de locks | Movimiento / invariante por fila | Riesgo |
|---|---|---|---|---|---|
| W1 checkout | período → pre-lock ordenado + `FOR UPDATE` por línea (re-entrante) | sí (líneas repetidas OK) | `ORDER BY id`, independiente del payload | `sale`, prev/new leídos bajo lock ✔ | **Correcto.** Lost update sólo si el OTRO writer no bloquea (D1) |
| W2 quick purchase | período → pre-lock ordenado; relee bajo lock | sí (duplicados rechazados) | `ORDER BY id` | `purchase` ✔ | **Correcto** |
| W3 anulación | período → comprobante → pagos → CC → pre-lock ordenado (agrupado) | sí | `ORDER BY id` | `return` ✔ | **Correcto** |
| W4 compra proveedor | período (fecha elegible por el usuario); **sin lock de fila** | sí (duplicados aceptados) | **orden del payload** (el `UPDATE` bloquea al pasar) | `purchase` ✔ fila / ✘ cadena | **Lost update + deadlock** |
| W5 borrar compra | `supplier_purchases FOR UPDATE`; **sin lock de inventario**; no toma período | sí | **orden físico** de `supplier_purchase_items` (sin `ORDER BY`) | `cancellation` ✔ fila / ✘ cadena | **Lost update + deadlock (reproducido)** |
| W6 reparación | `FOR UPDATE OF ci / woi SKIP LOCKED` (líneas, no inventario); sin período | sí | orden del plan | `sale` ✔ fila / ✘ cadena | **Lost update**; deadlock teórico |
| W7 trigger órdenes | **ninguno**; sin `business_id` | por fila; multi-fila en DELETE de orden (cascada) o DELETE por descripción | orden de escaneo | `order_usage`/`return` ✔ fila / ✘ cadena | **Lost update + escritura cross-tenant** |
| registerMovement | imposible (atraviesa HTTP) | no | — | fila ✔ / cadena ✘ | Lost update estructural; hoy sólo sobre filas nuevas |
| Import Excel | ninguno | no | — | **no escribe movimiento** | Sobrescritura ciega (no se arregla con locks) |

Ningún writer usa `SKIP LOCKED` sobre `inventory` ni `UPDATE … RETURNING` para derivar el stock; todos calculan un valor
**absoluto** (`SET stock_quantity = v_new`) a partir de una lectura previa. Ningún writer hace `SET stock = stock ± q`.

## 4. Lost update — reproducido con writers reales y dos conexiones

**Método** (`harness/race.mjs`): dos procesos `psql` independientes (dos backends, dos transacciones) como
`authenticated` del mismo tenant, más una tercera conexión de monitoreo sobre `pg_stat_activity` +
`pg_blocking_pids`. El *holder* ejecuta el writer real y luego `pg_sleep(3)` **antes del COMMIT** (sólo ensancha la
ventana que ya existe entre el `UPDATE` y el fin de su transacción); el *late* arranca 1 s después. Stock inicial 10.
"Cadena" = existe un orden de todos los movimientos con `previous(N+1) = new(N)` que empieza en 10 y termina en el
stock actual.

| Caso | Holder × Late | Final | Correcto | Movimientos (prev → new) | Espera observada |
|---|---|---|---|---|---|
| A | compra +5 × order_item −2 | **8** | 13 | 10→15, **10**→8 | late en `Lock/transactionid` |
| A-rev | order_item −2 × compra +5 | **15** | 13 | 10→8, **10**→15 | idem |
| B | order_item −2 × order_item −3 | **7** | 5 | 10→8, **10**→7 | idem |
| B-upd | UPDATE cantidad 1→4 × INSERT −2 | **7** | 4 | 9→6, **9**→7 | idem |
| B-del | DELETE (+2) × INSERT −3 | **5** | 7 | 8→10, **8**→5 | idem |
| C | borrar compra −4 × compra +5 | **19** | 15 | 14→10, **14**→19 | idem |
| C-rev | compra +5 × borrar compra −4 | **10** | 15 | 14→19, **14**→10 | idem |
| **D1** | **checkout −2 (FOR UPDATE)** × order_item −3 | **7** | 5 | 10→8, **10**→7 | idem |
| D2 | order_item −3 × checkout −2 | 5 ✔ | 5 | 10→7, 7→5 | checkout espera y relee |
| E | checkout × checkout | 5 ✔ | 5 | 10→8, 8→5 | `Lock/advisory` (período) |
| F | anulación +2 × compra +5 (mismo mes) | 15 ✔ | 15 | cadena ✔ | `Lock/advisory` (período) |
| G | compra rápida +5 (pre-lock) × order_item −2 | **8** | 13 | 10→15, **10**→8 | `Lock/transactionid` |
| H | reparación −2 × compra +5 | **15** | 13 | 10→8, **10**→15 | idem |
| I | checkout −2 × borrar compra −4 | **10** | 8 | 14→12, **14**→10 | idem |
| P1 | compra +5 × compra +3 (mismo mes) | 18 ✔ | 18 | cadena ✔ | `Lock/advisory` (período) |
| **P2** | **compra mes anterior +5 × compra hoy +3** | **13** | 18 | 10→15, **10**→13 | `Lock/transactionid` |
| P3 | checkout −2 × compra mes anterior +5 | 13 ✔ | 13 | 10→8, 8→13 | FK `KEY SHARE` choca con `FOR UPDATE` |
| P4 | compra mes anterior +5 × checkout −2 | 13 ✔ | 13 | 10→15, 15→13 | checkout espera y relee |

Todas las filas de movimiento cumplen `new_stock − previous_stock = quantity` **individualmente**: el bug no rompe la
fila, rompe la **cadena** (dos movimientos parten del mismo `previous_stock`). Por eso G2-C no lo detectaba.

**Sin ningún `pg_sleep`** (`pgbench`, 8 clientes, 10 s, order_items + compras con fecha del mes anterior):
2865 transacciones, stock esperado **−1415**, stock real **382** → 1797 unidades de deriva.
**Control** (checkout + compra rápida, mismos parámetros): 1332 transacciones, esperado −680, real **−680** (exacto).

### Mecanismos que hoy ya serializan (incidentales, no son contrato)

1. **Advisory lock de período.** `assert_period_open(business, fecha)` toma `pg_advisory_xact_lock` por
   (negocio, mes) **antes** de leer stock en checkout (`ar_today`), anulación (`ar_today`), compra (`p_purchase_date`)
   y compra rápida (`p_date`). Serializa esos cuatro entre sí **sólo si la fecha económica cae en el mismo mes**
   (casos E, F, P1). No lo toman: trigger de órdenes, borrar compra, reparación, browser. Una compra con fecha de otro
   mes —la UI deja elegir la fecha— escapa (P2).
2. **FK `KEY SHARE` contra `FOR UPDATE`.** Insertar una fila que referencia `inventory` (p. ej.
   `supplier_purchase_items`) toma `FOR KEY SHARE`, que choca con `FOR UPDATE` (no con `FOR NO KEY UPDATE`). Si el
   holder es checkout/anulación/compra rápida y el late hace ese INSERT **antes** de leer stock, queda serializado (P3).
   El trigger de órdenes lee en BEFORE, antes del chequeo FK, y no se salva (D1).

Ambos dependen de la fecha económica, del orden interno de sentencias y del modo de lock del otro writer.
**G2-C.2 no debe apoyarse en ninguno.**

## 5. Deadlock — reproducido

**Harness determinista de 3 conexiones.** Una "compuerta" (un `order_item` real que retiene la fila X) fuerza el
orden de espera: el writer ordenado por id encola primero en X; el writer por payload/orden físico ya tiene Y y encola
en X. Al liberar la compuerta, X va al primero, que necesita Y → ciclo.

| Caso | Writers | `pg_stat_database.deadlocks` | Víctima y lo que ve el usuario |
|---|---|---|---|
| **DL1** | checkout [X,Y] × `delete_supplier_purchase_safe` (ítems creados [Y,X]) — mismo mes | 0 → **1** | borrar compra → `{"ok":false,"error_code":"INTERNAL_ERROR","error":"No se pudo eliminar la compra"}` |
| **DL2b** | checkout [X,Y] × compra con fecha del mes anterior [Y,X], compuerta en Y | 1 → **2** | **checkout del POS** → `failed_retryable / INTERNAL_ERROR`, `last_error_message = 'deadlock detected'`; además lost update en Y (11 vs 10) |
| DL3 (control) | checkout [X,Y] × compra rápida mes anterior [Y,X] (pre-lock por id) | 2 → 2 | ninguna: la compra rápida encola en X sin tener Y |

**Natural, sin compuerta ni sleeps** (`pgbench`, 8 clientes, 15 s, checkout [A,B] × compra mes anterior [B,A]):
**14 deadlocks**, todas las víctimas checkouts del POS (`failed_retryable: deadlock detected`). `pgbench` reporta
0 transacciones fallidas porque **las RPCs tragan el 40P01** y devuelven un error genérico.

Hoy no hay deadlock entre compras del mismo mes, ni entre compra del mismo mes y checkout, porque el advisory lock de
período serializa antes de tocar inventario. Es incidental.

**Writers multi-item que necesitan pre-lock ordenado:** W4 compra, W5 borrar compra, W6 reparación y W7 cuando una
sola sentencia toca varios repuestos (borrar una orden → `ON DELETE CASCADE` → un trigger por ítem en orden de
escaneo; `DELETE … WHERE descripcion = …` en `orderPartsService`). El caso de cascada es analítico (no reproducido).

### Auditoría del checkout (W1)

- Qué bloquea: filas de `inventory` del negocio cuyo id aparece en líneas `producto`/`repuesto` (`nota_credito` excluida).
- Cuándo: después de insertar el comprobante y reservar el número, **antes** del loop de ítems (M7 §11).
- Cómo: una sola sentencia `ORDER BY id FOR UPDATE` → orden global independiente del payload; líneas repetidas se
  bloquean una vez. El `SELECT … FOR UPDATE` por línea es re-entrante.
- La lectura de precio (`SELECT * INTO v_inv`) ocurre antes del lock, pero sólo lee precio/costo; el stock se relee bajo lock.
- ¿Puede deadlockear? **Sí, contra writers que no ordenan** (DL1, DL2b). La corrección va en los otros writers.
  Residual: su `FOR UPDATE` choca con `FOR KEY SHARE`, así que un insertador multi-fila por FK en orden de payload que
  no es writer de stock (p. ej. `create_wholesale_order_atomic` → `wholesale_order_items`) puede cerrar un ciclo con él.
  Analítico, no reproducido.

## 6. Writers que G2-C.2 debe modificar

1. `public.adjust_stock_on_order_item()` — lock + **acotar por `business_id`** + fail-closed si el producto no es del negocio.
2. `private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)` — pre-lock ordenado.
3. `public.delete_supplier_purchase_safe(uuid,uuid,uuid)` — pre-lock ordenado.
4. `public.repair_missing_stock_movements(uuid,boolean)` — pre-lock ordenado.

Más un helper nuevo: `private.lock_inventory_rows(uuid, uuid[])`.

### Hallazgo de seguridad asociado (W7)

Probado dentro de `BEGIN … ROLLBACK`: el tenant A (como `authenticated`, con RLS) **no puede leer** un producto del
tenant B (0 filas), pero sí puede insertar en **su propia orden** un `order_item` con `product_id` = producto de B. El
trigger SECURITY DEFINER bajó el stock de B de **7 a 4** y escribió un movimiento con `business_id = A` que expone a A
el stock de B (7 → 4). Requiere conocer el UUID ajeno. El lock acotado por tenant de G2-C.2 lo cierra de paso; si
G2-C.2 no se hace pronto, merece su propio P0.

## 7. Writers que NO debe tocar

| Writer | Por qué |
|---|---|
| W1 checkout, W2 compra rápida, W3 anulación | Ya cumplen el contrato (lock previo ordenado, relectura bajo lock); son las funciones más grandes; probado correcto (D2, E, F, DL3, control pgbench) |
| `update_inventory_dollar_prices` | No escribe stock; riesgo de deadlock residual documentado (§12) |
| `sync_inventory_stock_alias`, `tg_inventory_inherit_variant_cost` | Misma fila / sólo costo |
| Writers del browser (`registerMovement`, import de Excel) | No se arreglan con locks de fila: el read-modify-write atraviesa HTTP o es una sobrescritura ciega. Requieren RPC server-side + revocar `UPDATE(stock, stock_quantity)` a `authenticated` con despliegue frontend-primero → lote propio (G2-C.3) |
| Wrappers públicos de W1–W4 | No tocan inventario. **Poner el pre-lock en el wrapper sería un error**: bloquearía inventario *antes* del advisory de período (que el impl toma después), invirtiendo el orden global contra el checkout → deadlock nuevo |

## 8. Diseño propuesto

### Helper común (sí conviene)

```sql
-- Contrato G2-C.2: único punto que decide modo, orden y alcance de tenant del lock de stock.
CREATE FUNCTION private.lock_inventory_rows(p_business_id uuid, p_inventory_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER                      -- corre con el rol del caller (writers SECDEF de postgres)
SET search_path = pg_catalog, pg_temp -- sin comillas (guard:secdef)
AS $$
DECLARE v_locked integer;
BEGIN
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_LOCK_TENANT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.inventory i
   WHERE i.business_id = p_business_id
     AND i.id = ANY (COALESCE(p_inventory_ids, '{}'::uuid[]))
   ORDER BY i.id
   FOR NO KEY UPDATE;
  GET DIAGNOSTICS v_locked = ROW_COUNT;
  RETURN v_locked;                    -- el caller decide si count <> esperado es error
END $$;
REVOKE ALL ON FUNCTION private.lock_inventory_rows(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
```

- **Por qué helper:** un solo lugar define orden (`ORDER BY id`), modo y tenant; el guard estático puede exigir su uso;
  los writers nuevos cambian una línea en vez de reescribir su loop.
- **Modo `FOR NO KEY UPDATE`:** alcanza para serializar RMW (choca con `NO KEY UPDATE` y con el `FOR UPDATE` de
  W1–W3), es el mismo modo que toma el `UPDATE` posterior (sin upgrade de lock) y **no** choca con el `FOR KEY SHARE`
  de los chequeos FK, así que no agrega aristas nuevas de deadlock con inserts de `order_items`,
  `comprobante_items`, `wholesale_order_items` e `inventory_movements`. `FOR UPDATE` también sería correcto, con más
  contención.

### Cambios por writer (cuerpo completo con `CREATE OR REPLACE`, diff mínimo)

- **W7 `adjust_stock_on_order_item`:**
  - INSERT/UPDATE: `IF private.lock_inventory_rows(v_business_id, ARRAY[NEW.product_id]) <> 1 THEN RAISE 'INVENTORY_NOT_FOUND' …`; después `SELECT`/`UPDATE … WHERE id = … AND business_id = v_business_id`.
  - DELETE: pre-lock de **todos** los repuestos de la misma orden (`SELECT DISTINCT product_id FROM order_items WHERE order_id = OLD.order_id AND tipo = 'repuesto'`) y después el chequeo por fila. Cubre la cascada al borrar una orden y el DELETE multi-fila por descripción.
- **W4 compra (impl `private`):** justo antes del loop de ítems (después de `assert_period_open`, la reserva de idempotencia y el INSERT de `supplier_purchases`): `PERFORM private.lock_inventory_rows(p_business_id, ARRAY(SELECT DISTINCT … FROM jsonb_array_elements(p_items) …))`. El loop queda igual; las lecturas ya ocurren bajo lock (los duplicados se leen a sí mismos).
- **W5 borrar compra:** después de `supplier_purchases FOR UPDATE` y del chequeo `BLOCKED_PAID`, antes del loop: pre-lock de `DISTINCT inventory_id` de sus ítems.
- **W6 reparación:** después de la autorización, antes de ambos loops: pre-lock de la unión de `inventory_id` candidatos (líneas de comprobante y de pedido mayorista). Los loops quedan con `SKIP LOCKED` sobre las líneas (idempotencia intacta: una segunda reparación concurrente espera en inventario, y después relee las líneas ya procesadas).

Semántica preservada en todos: stock negativo permitido, aritmética G2-C, mismos movimientos, mismas respuestas.

## 9. Orden canónico de locks

1. **Advisory de período** (`assert_period_open`) — si la operación tiene fecha económica.
2. **Fila documento / idempotencia** (comprobante, `supplier_purchases`, request de checkout, pagos y movimientos de CC del documento).
3. **`inventory`, todo junto, `ORDER BY id`, acotado por tenant** (helper o el `PERFORM` idéntico que ya tienen W1–W3).
4. Filas hijas que referencian inventario (`comprobante_items`, `supplier_purchase_items`, `order_items`, `inventory_movements`).
5. Ledgers derivados (advisory de `supplier_account_movements`, `accounts` vía `trig_account_movement_balance`).

Reglas: nunca tomar un lock de inventario después de uno de nivel 4–5; nunca bloquear inventario de a uno en orden de
payload o de escaneo; nunca bloquear inventario antes del advisory de período (por eso no va en los wrappers).
Verificado contra los writers actuales: W1, W2 y W3 ya cumplen; W5 (sin período) y W6 (sin período, `ci` después de
inventario) quedan consistentes con W3 (inventario antes que `comprobante_items`).

## 10. Plan de migración fail-closed

`supabase/migrations/20261006120000_g2c2_inventory_concurrency_locks.sql` (**no creado**), con `BEGIN; … COMMIT;` explícitos.

**Precondiciones (RAISE si falla):**
- G2-C y G2-C.1 presentes (sin clamp `GREATEST(…,0)`; existe `create_wholesale_order_atomic`).
- Las 4 firmas exactas resuelven; `trg_adjust_stock_on_order_item` existe, está habilitado, BEFORE INSERT OR DELETE OR UPDATE.
- W1, W2 y W3 contienen su pre-lock `ORDER BY id FOR UPDATE` (el orden global depende de eso).
- **Datos:** cero `order_items` cuyo `product_id` pertenece a otro negocio (el trigger nuevo es fail-closed también en DELETE).
- Snapshot de `prosecdef`, `proowner`, `proconfig` y `proacl` de las 4 funciones.

**Cuerpo:** helper + REVOKE + COMMENT; `CREATE OR REPLACE` de las 4 con **cuerpo canónico completo** copiado del
`pg_get_functiondef` del replay (el repo prohíbe parchear texto vivo: `guard:no-fragile-functiondef`), repitiendo
`SECURITY DEFINER` y el `SET search_path` vivo exacto, sin comillas. `CREATE OR REPLACE` conserva OID, owner, ACL y el
binding del trigger.

**Postcondiciones:**
- owner/secdef/search_path/ACL == snapshot;
- helper sin EXECUTE para anon/authenticated/service_role; USAGE de `private` sin cambios;
- **invariante de catálogo:** toda función de `public`/`private` que haga `UPDATE … inventory … SET … stock` contiene `private.lock_inventory_rows(` o `ORDER BY id … FOR (NO KEY )?UPDATE` (atrapa writers futuros);
- sin clamp (regresión G2-C); trigger ligado y habilitado.

**CI y despliegue:**
- Agregar el archivo a la lista que el job R3 aparta (cambia 4 definiciones que R3 compara contra `production-discovery.json`).
- Job nuevo `g2c2-inventory-locks` (supabase start → `npm run test:g2c2`).
- Guard estático `scripts/guards/g2c2-inventory-locks.mjs` + self-test.
- Deploy sólo DB (firmas y respuestas iguales: compatible con el frontend actual), con `db push`.
- Chequeos read-only en prod antes: `order_items` cross-tenant, drift de los 4 cuerpos vivos contra el replay (normalizando CRLF).
- Rollback: `CREATE OR REPLACE` con los cuerpos previos + `DROP` del helper (no cambia forma de datos).

## 11. Plan de tests (dos conexiones reales)

Harness: procesos `psql` independientes (o un cliente `pg` por conexión) con la técnica holder/late y la compuerta
de 3 conexiones de este discovery, más `pgbench` (viene en la imagen de Supabase, también en CI). Aserciones
comunes: `stock == inicial + Σquantity`; cadena continua `previous(N+1) = new(N)`; invariante por fila;
`pg_stat_database.deadlocks` sin cambios en los casos de orden.

| # | Caso | Construcción | Esperado |
|---|---|---|---|
| 1 | Dos descuentos | order_item −2 ∥ order_item −3; checkout ∥ order_item | 5, cadena continua, en ambos órdenes |
| 2 | Descuento + compra | order_item ∥ compra; checkout ∥ compra **de otro mes** | 13 en ambos órdenes |
| 3 | Dos compras | mismo mes y **meses distintos** (P2) | 18 |
| 4 | Compra + borrar compra | C y C-rev; checkout ∥ borrar (I) | 15 / 8 |
| 5 | Order item INSERT/UPDATE/DELETE | B, B-upd, B-del + borrar orden con 2 repuestos ∥ checkout | exacto |
| 6 | Stock negativo | stock 1: −2 ∥ −3 | −4, cadena continua |
| 7 | Reversa exacta | venta ∥ compra, después anular la venta | stock = inicial + compra |
| 8 | Invariante de movimientos | todos los casos | por fila y cadena |
| 9 | Orden opuesto sin deadlock | DL1, DL2b con compuerta + pgbench [A,B] ∥ [B,A] (compra, borrar, reparación, borrar orden) | 0 deadlocks, 0 `INTERNAL_ERROR` |
| 10 | Productos distintos no se bloquean | holder en X, late en Y con writers **sin** advisory de período (trigger, borrar, reparación, compra de otro mes) | sin espera `Lock/*`, < 200 ms. El advisory de período ya serializa por negocio y mes las RPCs financieras: comportamiento previo, no afirmar contra él |
| 11 | Aislamiento de tenant | `order_item` con producto ajeno → error, stock ajeno intacto; helper con ids ajenos → 0 filas; helper no ejecutable por `authenticated` | fail-closed |
| 12 | Idempotencia | misma key de compra en paralelo (una crea, otra replay), replay de checkout y anulación, doble reparación en paralelo | sin doble impacto |
| 13 | Replay limpio | `supabase start` desde cero | migración aplica, postcondiciones OK |
| 14–16 | Regresión G2-C / G2-C.1 / G2-B | `npm run test:g2c`, `test:g2c1`, `test:g2b` | verdes |
| 17 | SEC-08E | `test:sec08e-r3` con G2-C.2 apartada | verde |
| 18 | SEC-08F | `test:sec08f` (stack sin SEC-08F) | verde |

## 12. Riesgos residuales

1. **Writers del browser:** `registerMovement` (hoy sólo sobre filas nuevas) y el **import de Excel** (sobrescritura absoluta, sin movimiento, vivo). Necesitan G2-C.3: RPC server-side + revocar `UPDATE(stock, stock_quantity)` a `authenticated`, con frontend primero.
2. **Cross-tenant vía `order_items.product_id`:** se cierra con G2-C.2; antes, verificar en prod (read-only) si hay filas existentes.
3. **Deadlocks invisibles:** las RPCs convierten 40P01 en `INTERNAL_ERROR` (checkout → `failed_retryable`, reintentable; compra/borrar → error genérico). G2-C.2 elimina los ciclos entre writers de stock; mapear 40P01/55P03 a un código reintentable queda para después.
4. **`FOR UPDATE` de W1–W3 contra `KEY SHARE`:** un insertador multi-fila por FK que no es writer de stock (alta de pedido mayorista) todavía puede cerrar un ciclo con un checkout. Analítico. Opción futura: bajar esos tres pre-locks a `FOR NO KEY UPDATE`.
5. **`update_inventory_dollar_prices` y UPDATEs multi-fila del browser** (`is_active` por `parent_id`) bloquean en orden físico: deadlock posible contra writers multi-item, baja frecuencia.
6. **El advisory de período ya es un mutex por negocio y mes** para todas las RPCs financieras: límite de throughput existente, G2-C.2 no lo empeora; no hay que apoyarse en él para stock.
7. **Semántica de UPDATE en W7:** cambiar `product_id`/`tipo` de un ítem ajusta sólo NEW. Ninguna ruta de la UI lo hace. Fuera de alcance.
8. **W6 sigue procesando `wholesale_order_items`** (follow-up conocido de G2-C.1) y sus notas vivas tienen mojibake (`ReparaciÃ³n`): decidir si el cuerpo nuevo lo preserva o lo corrige.
9. **W4 acepta ítems duplicados y cantidades fraccionarias** (FLOOR para stock). No es concurrencia; sin cambios.
10. **Esperas de lock y `statement_timeout = 8s` de `authenticated`:** una reparación grande retiene muchas filas y puede hacer esperar o fallar checkouts de esos productos. Es rara y sólo para admins; considerar lotes.

## Diferencias con el brief

- El loop de W4 vive en `private.create_supplier_purchase_atomic`; `public.create_supplier_purchase_atomic` es un wrapper de 3 líneas.
- W5 confirmado en vivo: sin lock de inventario, orden físico, no toma el advisory de período.
- No estaban en la lista: W2 compra rápida (correcta, dormida), W6 reparación (sin lock), import de Excel (sobrescritura absoluta), borrar orden (cascada multi-ítem en W7), escritura cross-tenant en W7.
- Algunos pares ya son seguros por mecanismos incidentales (advisory de período, FK `KEY SHARE` contra `FOR UPDATE`); se documentan pero no se usan como contrato.
