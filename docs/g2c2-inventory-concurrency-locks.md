# G2-C.2 — Locks canónicos de inventario (implementación)

> **Estado: CANDIDATO · NO APTO PARA MERGE.** La prueba extra obligatoria reprodujo el residual
> **G2-C.2R BLOCKER · inventory FK lock graph** (§7). G2-C.2 no lo causa ni lo toca, pero el rollout
> queda detenido hasta revisión humana. Nada de esto se aplicó a producción.

Discovery aprobado: [`docs/g2c2-discovery/README.md`](g2c2-discovery/README.md) (sobre `origin/main` 4383a9f).

## 1. Qué cambia

| Objeto | Cambio |
|---|---|
| `private.lock_inventory_rows(uuid, uuid[]) → integer` (**nuevo**) | Único lock canónico de stock |
| W4 `private.create_supplier_purchase_atomic(…12)` | Pre-lock ordenado antes del loop (impl privado; el wrapper público no cambia) |
| W5 `public.delete_supplier_purchase_safe(uuid,uuid,uuid)` | Pre-lock ordenado después de lockear la compra y antes del loop |
| W6 `public.repair_missing_stock_movements(uuid,boolean)` | Pre-lock ordenado de la unión de candidatos antes de los loops |
| W7 `public.adjust_stock_on_order_item()` | Lock por negocio; cross-tenant cerrado; pre-lock de la orden al borrar; identidad inmutable en UPDATE |

Una sola migración: `supabase/migrations/20261006120000_g2c2_inventory_concurrency_locks.sql`, con `BEGIN/COMMIT`
explícitos, 7 precondiciones y 9 postcondiciones fail-closed.

**Sin cambios:**
- los writers que ya bloqueaban ordenado: checkout, compra rápida y anulación (la postcondición 2 lo verifica por md5);
- los wrappers públicos;
- el frontend;
- las firmas, OID, owner, `SECURITY DEFINER`, `search_path`, ACL y respuestas de las funciones tocadas.

### Helper exacto

```sql
CREATE FUNCTION private.lock_inventory_rows(p_business_id uuid, p_inventory_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE v_locked integer;
BEGIN
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_LOCK_TENANT_REQUIRED: ...' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.inventory i
   WHERE i.business_id = p_business_id
     AND i.id = ANY (COALESCE(p_inventory_ids, '{}'::uuid[]))
   ORDER BY i.id
     FOR NO KEY UPDATE;
  GET DIAGNOSTICS v_locked = ROW_COUNT;
  RETURN v_locked;
END $fn$;
-- owner postgres · REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role
```

**Por qué `FOR NO KEY UPDATE`:**
- choca con el `UPDATE` de otro writer y con el `FOR UPDATE` de checkout, compra rápida y anulación, que es todo lo necesario para serializar;
- es el mismo modo que toma el `UPDATE` posterior, así que no hay upgrade de lock;
- no choca con el `FOR KEY SHARE` de los chequeos FK, así que no agrega aristas al grafo de deadlocks.

Ninguna prueba mostró que hiciera falta `FOR UPDATE`.

### Orden global de locks (sin cambios respecto del discovery)

1. Advisory de período.
2. Documento / idempotencia.
3. `inventory`, todo junto, `ORDER BY id`, del mismo negocio.
4. Filas hijas.
5. Ledgers.

El lock no va en los wrappers públicos: ahí quedaría antes del advisory de período e invertiría el orden global.

### W4–W7 en detalle

- **W4:** después del advisory de período (paso 6), de la reserva idempotente (7), del scope de auditoría (8) y del INSERT de la compra:
  - arma `array_agg(DISTINCT id)` del payload y llama al helper una vez;
  - si bloqueó menos ids de los esperados, `PRODUCT_NOT_FOUND` fail-closed (hace rollback al savepoint y devuelve `INTERNAL_ERROR`, como cualquier falla interna);
  - los duplicados del payload se siguen procesando igual que hoy (dos movimientos).
  - Además, sus relaciones sin calificar se calificaron con `public.` (mismo objeto; su path sigue siendo `public, pg_temp`). Lo exige `guard:secdef` para una SECURITY DEFINER que conserva `public`.
- **W5:** después de `supplier_purchases FOR UPDATE` y de `BLOCKED_PAID`:
  - arma `DISTINCT inventory_id` de sus ítems, llama al helper y exige el conteo exacto (si no, `42501`);
  - tombstone, CC de proveedor, aritmética y respuestas iguales.
- **W6:** unión `DISTINCT` de productos candidatos (líneas de comprobante y de pedido mayorista), lockeada una vez.
  - Los loops procesan sólo líneas de ese conjunto: una línea que aparece después queda para la próxima reparación.
  - Se mantienen `SKIP LOCKED` sobre las líneas, `p_allow_negative`, marcadores, conteo de "producto no encontrado" y respuestas.
  - El mojibake de sus notas (`ReparaciÃ³n`) viene de la migración que la definió y se conserva byte a byte.
- **W7:** ver §2 y §3.

## 2. Cómo se cerró el cross-tenant (W7)

**Antes:** el trigger buscaba y actualizaba `inventory` **sólo por id**. Resultado probado: el tenant A, que ni siquiera puede leer el producto de B, le bajó el stock de 7 a 4 desde su propia orden.

**Ahora:**
- El negocio canónico es `order_items.business_id` (NOT NULL, lo exige la RLS) y tiene que coincidir con el de la orden padre. En el `ON DELETE CASCADE` la orden ya no existe y manda el ítem.
- INSERT y UPDATE: `lock_inventory_rows(v_business_id, ARRAY[product_id]) <> 1` → `INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH` / `42501`.
- Toda lectura y todo `UPDATE` posterior llevan `AND business_id = v_business_id`.
- DELETE: pre-lock ordenado de **todos** los repuestos de la misma orden (conteo exacto o `42501`). Cubre:
  - borrar un repuesto;
  - el DELETE multi-fila;
  - el `ON DELETE CASCADE` al borrar una orden (un trigger por ítem en orden de escaneo: el primero bloquea el conjunto).
- **Precondición 6 de la migración:** aborta si existe algún `order_items` cuyo producto (o cuya orden) sea de otro negocio. No repara datos.

## 3. UPDATE estructural de `order_items`

- Cambiar `business_id`, `order_id`, `product_id` o `tipo` (`IS DISTINCT FROM`) → `ORDER_ITEM_STOCK_IDENTITY_IMMUTABLE` / **`0A000`**.
- Los UPDATE de cantidad (y de datos no estructurales) siguen permitidos y toman el lock del producto canónico.

**Discovery de callers antes de implementarlo:**
- **UI:** sólo hace INSERT (`ModalAgregarItem`, `orderPartsService`) y DELETE (`orderPartsService`, `OrderItemsCard`, borrar orden → cascada). Ningún UPDATE.
- **Funciones de base:** cero funciones hacen UPDATE o DELETE de `order_items`, y cero hacen DELETE de `inventory`.
- **Tests y fixtures:** G2-C sólo cambia `cantidad`; ningún fixture de SEC-08F, R3 ni E2E borra en duro un producto usado en una orden.

**Consecuencia a revisar:** la FK `order_items.product_id` es `ON DELETE SET NULL`. Borrar **en duro** un producto usado en una orden es un UPDATE de `product_id` a NULL, así que ahora falla con `0A000` en vez de perder la referencia en silencio.
- Ninguna UI activa lo hace: el borrado de producto es soft (`is_active = false`).
- Un producto sin órdenes se sigue borrando en duro (rollback de `productService`); está probado en el caso 4.13.

## 4. Pruebas

### Matriz de una sesión: `tests/sql/g2c2_inventory_concurrency_locks.test.sql`, 106 aserciones

Todas en verde localmente. Cubre:
- **Helper:** ACL, `22023`, conteo por negocio, duplicados, NULL, vacíos y modo de lock.
- **Cross-tenant:** producto ajeno; ítem propio sobre una orden ajena.
- **INSERT / UPDATE cantidad / DELETE** con reversa exacta.
- **Identidad inmutable:** 6 variantes, más el borrado duro de un producto usado y de uno no usado.
- **DELETE multi-fila** y cascada de la orden.
- **Stock negativo.**
- **W4:** duplicados, replay y producto ajeno.
- **W5:** reversa y tombstone.
- **W6:** línea pendiente, línea ajena contada como no encontrada, idempotencia.
- **Invariante de catálogo:** los 7 writers de stock server-side bloquean antes de escribir.

### Concurrencia real: `scripts/inventory/g2c2-concurrency-local.mjs`

**Cómo corre:** dos procesos `psql` independientes (dos backends) como `authenticated`, más un monitor sobre `pg_stat_activity` / `pg_blocking_pids` que **prueba que hubo espera de lock**. Cada escenario corre en su propio negocio.

**Qué verifica cada carrera:**
- `stock_final == esperado == inicial + SUM(quantity)`;
- cadena `previous(N+1) = new(N)`;
- invariante por fila;
- alias `stock`;
- delta de `pg_stat_database.deadlocks`.

| # | Carrera | Antes (main) | Después (G2-C.2) |
|---|---|---|---|
| 1 | order_item −2 ∥ −3 (ambos órdenes) | 7 y 8 (esperado 5) | 5 ✔ |
| 2 | order_item −2 ∥ compra +5 (ambos) | 15 y 8 (esperado 13) | 13 ✔ |
| 3 | checkout −2 ∥ order_item −3 (ambos) | 7 con checkout primero (esperado 5) | 5 ✔ |
| 4 | compra mes anterior +5 ∥ compra hoy +3 (ambos) | 13 y 15 (esperado 18) | 18 ✔ |
| 5 | borrar compra −4 ∥ compra +5 (ambos) | 19 y 10 (esperado 15) | 15 ✔ |
| 6 | reparación −2 ∥ compra +5 (ambos) | 15 y 8 (esperado 13) | 13 ✔ |
| 6b | reparación ∥ reparación | — | 1 + 0 procesadas, sin doble impacto ✔ |
| 7 | UPDATE ∥ INSERT · DELETE ∥ INSERT · UPDATE ∥ DELETE | 7/5/8 (esperado 4/7/9) | exacto ✔ |
| 8 | stock 1: −2 ∥ −3 | −4 ✔ (el checkout ya bloqueaba) | −4 ✔ |
| 9 | anulación +2 ∥ order_item −3 (ambos) | 5 con anulación primero (esperado 7) | 7 ✔ |
| 10 | [A,B] ∥ [B,A] con compuerta, 4 writers × compuerta en A y en B | **4 deadlocks** (2 checkouts del POS víctimas) + cadenas rotas | **0 deadlocks**, 8/8 ✔ |
| 11 | productos distintos, writers sin advisory | — | sin espera de lock, 17–33 ms ✔ |
| 12 | A descuenta el producto de B mientras B vende | A lo logra; B termina en 7 (esperado 8) | A: `42501`; B: 8; cero filtración ✔ |
| 16 | misma key de compra en paralelo | — | crea + replay, una sola compra ✔ |
| S1/S2 | pgbench sin sleeps (lost update / [A,B] ∥ [B,A]) | discovery: −1415 esperado vs 382 real · 14 deadlocks en 15 s | **pendiente: corre en CI** (§6) |

**Resultados:**
- **Después:** escenarios 1–12 y 16, **276 aserciones, 0 fallas.** La primera corrida del escenario 11 falló por un error del test (los dos repuestos estaban en la misma orden, y `orders` se serializa por `recalculate_order_total`, que es previo a G2-C.2). Se corrigió usando otra orden: 12/12.
- **Antes (mismo harness en modo `G2C2_BASELINE=1`):** 243 aserciones, **69 fallas**.
- **Logs:** `docs/g2c2-evidence/before_main_concurrency.log` y `after_g2c2_concurrency_4-to-WS.log`.

### Guard: `scripts/guards/g2c2-inventory-locks.mjs`

- **30 mutaciones** detectadas por el self-test.
- Vigila la migración de G2-C.2 y **toda migración posterior**. Impide:
  - read-modify-write de stock sin lock previo;
  - lock después de escribir;
  - helper sin tenant, sin orden o con `SKIP LOCKED`;
  - `EXECUTE` del helper para roles de API;
  - que W7 vuelva a buscar el producto sólo por id o pierda la identidad inmutable;
  - deshabilitar o borrar el trigger;
  - borrar el helper.
- Límite declarado: no cubre los writers del navegador (G2-C.3).

## 5. Regresiones

| Chequeo | Resultado |
|---|---|
| Migración sobre el replay de main | Aplica: 7 precondiciones y 9 postcondiciones OK |
| `guard:g2c2-inventory-locks` + self-test | OK · 30/30 |
| Los 126 `guard:*` del repo | Mismos 7 en rojo que en main (`secdef`, `secdef-exposure`, `realtime-notifications` ×2, `view-invoker`, `sec08e-r2a` ×2), con **salida idéntica** a main |
| `guard:g2c-stock`, `guard:g2c1-wholesale`, `guard:no-fragile-functiondef` | OK |
| TypeScript (`tsc --noEmit`) | 0 errores |
| `lint:errors` | 0 |
| Unit (`node --test`) | OK |
| Components (vitest) | 35 archivos / 264 tests en rojo, **idénticos por nombre a main** (jest-dom no se registra en worktrees; ambiental, previo) |
| Build | CI (`quality`) |
| Fresh replay por CLI + G2-C.2 / G2-C / G2-C.1 / G2-B / R3 / SEC-08F / S1–S2 | **CI**: el disco local se llenó (§6) |

Para `guard:secdef-exposure`, W4, W5 y W6 llevan un `REVOKE ALL … FROM PUBLIC` explícito. Es un no-op sobre su ACL, que ya está materializada y sin PUBLIC; la postcondición 1 lo verifica contra el snapshot. W7 queda exento por ser función de trigger.

## 6. Qué no se pudo correr local

Durante la medición de línea base, el disco C: quedó con **0,24 GB libres**. Postgres cortó las conexiones (no podía escribir WAL) y **Docker Desktop no volvió a arrancar**. Eso afecta también a los stacks de otras sesiones. No se borró nada del usuario.

Pendiente por eso, y cubierto por los jobs de CI que replayan desde cero con la migración:
- replay limpio por CLI;
- S1/S2 después de G2-C.2;
- matrices de G2-C, G2-C.1, G2-B y SEC-08F con G2-C.2 aplicada;
- R3 con el candidato apartado.

## 7. G2-C.2R BLOCKER · inventory FK lock graph (reproducido)

**Prueba extra obligatoria:** checkout [A,B] (`FOR UPDATE`, ORDER BY id) contra alta mayorista [B,A]. `create_wholesale_order_atomic` inserta `wholesale_order_items` en una sola sentencia; sus chequeos FK toman `FOR KEY SHARE` en el orden del payload. La compuerta es un repuesto real que retiene B.

**Resultado: deadlock en 3 de 3 intentos.** `pg_stat_database.deadlocks +1` cada vez. La víctima fue siempre el **checkout del POS** (`failed_retryable`, `last_error_message = 'deadlock detected'`); el alta mayorista quedó OK.

**Mecanismo:**
1. El checkout tiene A con `FOR UPDATE` y espera B, que retiene la compuerta.
2. El alta tomó `KEY SHARE` de B (compatible con la compuerta) y espera `KEY SHARE` de A, que choca con el `FOR UPDATE` del checkout.
3. Al soltarse la compuerta, el checkout necesita `FOR UPDATE` de B, que choca con el `KEY SHARE` del alta: ciclo.

**No lo introduce G2-C.2:** involucra sólo el checkout (W1) y G2-C.1, que este lote no toca. El harness lo puede medir sobre main (`npm run test:residual:g2c2r` sale con código 3 mientras se reproduzca).

**Por contrato:** no se modificó W1/W2/W3 ni G2-C.1, y el PR queda **no apto para merge** hasta decidir. Opciones para la revisión humana, ninguna aplicada:
1. Bajar el pre-lock de checkout, compra rápida y anulación a `FOR NO KEY UPDATE`: deja de chocar con `KEY SHARE` y cierra la arista.
2. Que el alta mayorista inserte sus ítems en orden de id.

## 8. Fuera de este lote

- Writers del navegador (`registerMovement`, import de Excel) y la revocación de `UPDATE(stock, stock_quantity)`: **G2-C.3, bloqueante para cerrar BETA-GATE-2**.
- `update_inventory_dollar_prices`.
- Doble conversión y vínculo mayorista ↔ comprobante.
- Hacer reintentables los errores 40P01 (hoy se tragan como `INTERNAL_ERROR`).
- Precios, finanzas, ARCA y UX.
