# G2-C.2 — Locks canónicos de inventario (implementación)

> **Estado: CANDIDATO · DRAFT · SIN MERGE.** G2-C.2R (checkout contra alta mayorista, deadlock 3/3)
> queda resuelto en esta **misma** migración (§7). El PR sigue en draft hasta la revisión humana final.
> Nada de esto se aplicó a producción.

Discovery aprobado: [`docs/g2c2-discovery/README.md`](g2c2-discovery/README.md) (sobre `origin/main` 4383a9f).

## 1. Qué cambia

| Objeto | Cambio |
|---|---|
| `private.lock_inventory_rows(uuid, uuid[]) → integer` (**nuevo**) | Único lock canónico de stock |
| W1 `private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)` | **G2-C.2R:** sus 2 locks de `inventory` (pre-lock + relectura por línea) pasan de `FOR UPDATE` a `FOR NO KEY UPDATE` |
| W2 `private.create_quick_inventory_purchase_atomic(…10)` | **G2-C.2R:** su pre-lock de `inventory` pasa a `FOR NO KEY UPDATE` (y el comentario que lo documenta) |
| W3 `private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)` | **G2-C.2R:** su pre-lock de `inventory` pasa a `FOR NO KEY UPDATE`; sus locks de comprobante, pagos y cuenta corriente **siguen** `FOR UPDATE` |
| W4 `private.create_supplier_purchase_atomic(…12)` | Pre-lock ordenado antes del loop (impl privado; el wrapper público no cambia) |
| W5 `public.delete_supplier_purchase_safe(uuid,uuid,uuid)` | Pre-lock ordenado después de lockear la compra y antes del loop |
| W6 `public.repair_missing_stock_movements(uuid,boolean)` | Pre-lock ordenado de la unión de candidatos antes de los loops |
| W7 `public.adjust_stock_on_order_item()` | Lock por negocio; cross-tenant cerrado; pre-lock de la orden al borrar; identidad inmutable en UPDATE |

Una sola migración: `supabase/migrations/20261006120000_g2c2_inventory_concurrency_locks.sql`, con `BEGIN/COMMIT`
explícitos, 8 precondiciones y 9 postcondiciones fail-closed. G2-C.2R vive en ella para que no pueda quedar
G2-C.2 aplicada con G2-C.2R fallida.

**Sin cambios:**
- los wrappers públicos;
- el frontend;
- G2-C.1 (`create_wholesale_order_atomic`, byte a byte);
- las firmas, OID, owner, `SECURITY DEFINER`, `search_path`, ACL, respuestas, marcadores, idempotencia y matemática de stock de los 7 writers.

**Precondición 8 (drift):** el md5 de los 7 cuerpos (normalizado sin `\r`) tiene que ser el de `main` 4383a9f. `CREATE OR REPLACE` reemplaza el cuerpo entero: si producción tuviera otra versión, la migración aborta en vez de pisarla.

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

**Por qué `FOR NO KEY UPDATE` (ahora en los 7 writers y el helper):**
- choca con otro `FOR NO KEY UPDATE`, con el `UPDATE` de otro writer, con `FOR UPDATE` y con `DELETE`, que es todo lo necesario para serializar el stock;
- es el mismo modo que toma el `UPDATE` posterior (que no toca columnas de clave), así que no hay upgrade de lock;
- no choca con el `FOR KEY SHARE` de los chequeos FK (`wholesale_order_items`, `order_items`, `comprobante_items`…), así que no agrega aristas al grafo de deadlocks. Con `FOR UPDATE` sí las agregaba: ese era G2-C.2R (§7).

Ninguna prueba mostró que hiciera falta `FOR UPDATE` sobre `inventory`: ningún writer cambia `id` ni borra la fila, y las columnas de stock no forman parte de ninguna clave.

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

### Matriz de una sesión: `tests/sql/g2c2_inventory_concurrency_locks.test.sql`

106 aserciones de G2-C.2 más 30 de G2-C.2R (10.y y sección 11): **136/136 en CI** (run 36024199245, head `f0e7f13`). Cubre:
- **Helper:** ACL, `22023`, conteo por negocio, duplicados, NULL, vacíos y modo de lock.
- **Cross-tenant:** producto ajeno; ítem propio sobre una orden ajena.
- **INSERT / UPDATE cantidad / DELETE** con reversa exacta.
- **Identidad inmutable:** 6 variantes, más el borrado duro de un producto usado y de uno no usado.
- **DELETE multi-fila** y cascada de la orden.
- **Stock negativo.**
- **W4:** duplicados, replay y producto ajeno.
- **W5:** reversa y tombstone.
- **W6:** línea pendiente, línea ajena contada como no encontrada, idempotencia.
- **Invariante de catálogo:** los 7 writers de stock server-side bloquean antes de escribir, y ninguno bloquea `inventory` con `FOR UPDATE` (10.y).
- **G2-C.2R (sección 11):**
  - W1/W2/W3: pre-lock `ORDER BY id FOR NO KEY UPDATE`, conteos exactos de `FOR NO KEY UPDATE` / `FOR UPDATE`, siguen `SECURITY DEFINER` y sin `EXECUTE` para `authenticated`;
  - la anulación conserva `FOR UPDATE` sobre comprobante, pagos y cuenta corriente;
  - el checkout relee el stock por línea con `FOR NO KEY UPDATE` (sin upgrade);
  - el helper no usa `FOR UPDATE`;
  - G2-C.1 intacto (el alta mayorista sigue bloqueando a su cliente).

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
| S1/S2 | pgbench sin sleeps (lost update / [A,B] ∥ [B,A]) | discovery: −1415 esperado vs 382 real · 14 deadlocks en 15 s | CI, S2: **0 deadlocks** y 0 checkouts fallidos en 3951 transacciones; stock exacto de S1/S2: lo verifica la corrida con el chequeo lineal (§6) |

**Escenarios de G2-C.2R** (el grafo de locks contra las FK, §7):

| # | Carrera | Antes (W1–W3 en `FOR UPDATE`) | Ahora (CI, run 36024199245) |
|---|---|---|---|
| K | contratos A–F del modo de lock: el helper retiene la fila y otra conexión prueba NO KEY UPDATE (A), `UPDATE` (B), `FOR UPDATE` (C), `FOR KEY SHARE` (D), `DELETE` (F); más un INSERT real por FK (D bis) y los mismos contratos contra el lock **vivo** del checkout (K-W1) | — | A, B, C y F **esperan**; D **no espera** (2 ms), D bis tampoco (6 ms); contra el checkout vivo: D 2 ms, C y A esperan ✔ |
| WS | checkout [A,B] ∥ alta mayorista [B,A] con compuerta en B, **10 veces** | **deadlock 3/3**, víctima el checkout del POS | **10/10**: deadlocks +0 en cada una, checkout `created`, alta ok, 0 `failed_retryable`, stock A 9 / B 8 exacto ✔ |
| FK | ×3 cada uno: checkout ∥ repuestos de servicio [B,A]; anulación ∥ alta mayorista; compra rápida ∥ alta mayorista | — | **9/9** sin deadlocks, ambos terminan, stock exacto (A 9/B 8 · A 10/B 9 · A 11/B 10) ✔ |
| S3 | pgbench sin sleeps: checkout [A,B] ∥ alta mayorista [B,A] ∥ servicios [B,A] (8 clientes en CI) | — | 5239 transacciones, 0 fallidas: 1687 ventas, 1780 altas, 3544 ítems de servicio. **0 deadlocks**, 0 `failed_retryable`, A = B = −1677 = 10 − 1687 exacto, cadena balanceada ✔ |

**Harness completo en CI:** escenarios 1–12, 16, K, WS, FK y S1–S3, **645 aserciones, 0 fallas**. S1: 6201 transacciones, stock exacto. S2: 3530 transacciones, 0 deadlocks, stock exacto.

El contrato E (sin lost update) lo siguen cubriendo 1–12, S1, S2 y S3, ahora con W1–W3 en NO KEY: los escenarios 3, 8, 9 y 10 ejercitan el checkout y la anulación contra otros writers.

**Resultados:**
- **Después:** escenarios 1–12 y 16, **276 aserciones, 0 fallas.** La primera corrida del escenario 11 falló por un error del test (los dos repuestos estaban en la misma orden, y `orders` se serializa por `recalculate_order_total`, que es previo a G2-C.2). Se corrigió usando otra orden: 12/12.
- **Antes (mismo harness en modo `G2C2_BASELINE=1`):** 243 aserciones, **69 fallas**.
- **Logs:** `docs/g2c2-evidence/before_main_concurrency.log` y `after_g2c2_concurrency_4-to-WS.log`.

### Guard: `scripts/guards/g2c2-inventory-locks.mjs`

- **40 mutaciones** detectadas por el self-test y **2 controles** que no deben dar falso positivo:
  - un writer de stock posterior con `FOR UPDATE` sobre `comprobantes` y el lock canónico de `inventory`;
  - una función que bloquea `inventory_movements` `FOR UPDATE` (otra tabla, aunque empiece igual).
  - Además, el guard pasa sobre el árbol real, donde W6 conserva `FOR UPDATE OF ci SKIP LOCKED` sobre sus líneas y la anulación sus `FOR UPDATE` de comprobante, pagos y cuenta corriente.
- Vigila la migración de G2-C.2 y **toda migración posterior**. Impide:
  - que W1/W2/W3 o el helper vuelvan a bloquear `inventory` con `FOR UPDATE` (G2-C.2R), sin marcar `FOR UPDATE` sobre otras tablas;
  - que la migración pierda la precondición 8 (drift de W1–W3) o la prueba de cambio mínimo de la postcondición 2;
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
| Migración sobre el replay de main | Aplica en el replay limpio de CI con W1–W3 incluidos: 8 precondiciones y 9 postcondiciones OK |
| `guard:g2c2-inventory-locks` + self-test | OK · 40/40 mutaciones + 2 controles |
| `guard:secdef` | Mismo rojo que main (sólo los 2 hallazgos previos de `sec08e-r2a`), ver nota abajo |
| Los 126 `guard:*` del repo | Mismos 7 en rojo que en main (`secdef`, `secdef-exposure`, `realtime-notifications` ×2, `view-invoker`, `sec08e-r2a` ×2), con **salida idéntica** a main |
| `guard:g2c-stock`, `guard:g2c1-wholesale`, `guard:no-fragile-functiondef` | OK |
| TypeScript (`tsc --noEmit`) | 0 errores |
| `lint:errors` | 0 |
| Unit (`node --test`) | OK |
| Components (vitest) | 35 archivos / 264 tests en rojo, **idénticos por nombre a main** (jest-dom no se registra en worktrees; ambiental, previo) |
| Build | CI `quality` ✔ · preview de Vercel ✔ |
| Replay limpio + G2-C.2 / G2-C / G2-C.1 / G2-B / R3 / SEC-08F / E2E | CI ✔ (§6) |

Para `guard:secdef-exposure`, W1–W6 llevan un `REVOKE ALL … FROM PUBLIC` explícito. Es un no-op sobre su ACL, que ya está materializada y sin PUBLIC; la postcondición 1 lo verifica contra el snapshot. W7 queda exento por ser función de trigger.

**Baseline de `guard:secdef` (G2-C.2R):** W1/W2/W3 se reproducen **verbatim** (salvo el modo de lock), con `search_path = public, pg_temp` y referencias sin calificar. Es deuda heredada de sus migraciones de origen (checkout `20260814150000`, compra rápida `20260704101000`, anulación `20260713240000`, movidas luego a `private` con `ALTER … SET SCHEMA`), que ya figuran en el baseline. Se agregó una entrada puntual para esta migración (3 hallazgos), con la justificación en la `nota` del baseline. No se usó `--update-baseline`, para no absorber los 2 rojos previos de `sec08e-r2a`. Calificar esos cuerpos habría sido un cambio mayor que el pedido (sólo el modo de lock).

## 6. Incidente de disco y qué corrió dónde

Durante la medición de línea base, el disco C: local quedó con **0,24 GB libres**. Postgres cortó las conexiones y **Docker Desktop no volvió a arrancar**, lo que también bajó los stacks de otras sesiones. No se borró nada del usuario.

**Causa: el propio harness.** Su chequeo de "cadena continua" era un CTE recursivo que explora caminos. Con los miles de movimientos de pgbench (S1/S2) crece de forma combinatoria y llena `pgsql_tmp`. El CI mostró exactamente ese síntoma en S1/S2 (`could not write to file "base/pgsql_tmp/…": No space left on device`). En local, cada byte que crecía el disco virtual de Docker lo pagaba el disco del host, que ya estaba justo.

**Corregido:**
- La cadena se valida con un **balance euleriano**, de costo lineal: un lost update deja un `previous_stock` con dos salidas.
- El recorrido exacto se usa sólo hasta 12 movimientos.

**Corrido en CI**, con replay desde cero y G2-C.2 aplicada:
- `quality` (TypeScript, lint y **build**);
- G2-B, G2-C, G2-C.1 y SEC-08F con G2-C.2 aplicada;
- R3 con el candidato apartado;
- E2E;
- el job de G2-C.2: migración, guard, SQL y escenarios 1–12 y 16 en verde. En S2, bajo carga con 8 clientes y 3951 transacciones: **0 deadlocks** y ningún checkout fallido.
- G2-C.2R (head `f0e7f13`, run 36024199245): los 8 jobs en verde en el primer intento. Replay con la migración completa; G2-B, G2-C, G2-C.1 y SEC-08F con ella aplicada; R3 con el candidato apartado; E2E 178 ✔; job de G2-C.2 con guard 40+2, SQL 136/136 y concurrencia 645/645.

## 7. G2-C.2R · inventory FK lock graph (resuelto en esta misma migración)

### El problema (reproducido)

**Prueba extra obligatoria:** checkout [A,B] (`FOR UPDATE`, ORDER BY id) contra alta mayorista [B,A]. `create_wholesale_order_atomic` inserta `wholesale_order_items` en una sola sentencia; sus chequeos FK toman `FOR KEY SHARE` en el orden del payload. La compuerta es un repuesto real que retiene B.

**Resultado con W1 en `FOR UPDATE`: deadlock en 3 de 3 intentos.** `pg_stat_database.deadlocks +1` cada vez. La víctima fue siempre el **checkout del POS** (`failed_retryable`, `last_error_message = 'deadlock detected'`); el alta mayorista quedó OK.

**Mecanismo:**
1. El checkout tiene A con `FOR UPDATE` y espera B, que retiene la compuerta.
2. El alta tomó `KEY SHARE` de B (compatible con la compuerta) y espera `KEY SHARE` de A, que choca con el `FOR UPDATE` del checkout.
3. Al soltarse la compuerta, el checkout necesita `FOR UPDATE` de B, que choca con el `KEY SHARE` del alta: ciclo.

No lo introducía G2-C.2: el ciclo involucra sólo el checkout (W1) y G2-C.1. Pero G2-C.2 no se podía mergear con él abierto.

### La decisión (revisión humana)

Normalizar el modo de lock de stock de W1/W2/W3 a `FOR NO KEY UPDATE`, **en la misma migración** `20261006120000` y en el mismo PR. No se tocó G2-C.1 ni se reordenó su payload.

**Qué cambió exactamente** (sólo locks de `inventory`; 4 `FOR UPDATE` → 4 `FOR NO KEY UPDATE`):

| Writer | Statement | Antes | Ahora |
|---|---|---|---|
| W1 checkout | pre-lock del conjunto, `ORDER BY id` | `FOR UPDATE` | `FOR NO KEY UPDATE` |
| W1 checkout | relectura del stock por línea (`SELECT stock_quantity INTO v_prev_stock … AND business_id = p_business_id`) | `FOR UPDATE` | `FOR NO KEY UPDATE` |
| W2 compra rápida | pre-lock del conjunto, `ORDER BY id` (y su comentario) | `FOR UPDATE` | `FOR NO KEY UPDATE` |
| W3 anulación | pre-lock de los productos a reponer, `ORDER BY id` | `FOR UPDATE` | `FOR NO KEY UPDATE` |

**Qué NO cambió:** los 3 `FOR UPDATE` de la anulación sobre `comprobantes`, `comprobante_payments` y `account_movements`; firma, OID, owner, `SECURITY DEFINER`, `search_path`, ACL, autoridad, idempotencia, aritmética de stock, marcadores y respuestas. Ningún lock de W1/W2/W3 necesitaba `FOR UPDATE`: ninguno borra la fila ni cambia su clave.

**Cómo lo garantiza la migración:**
- **Precondición 8:** W1/W2/W3 llegan con el cuerpo exacto de main (md5 normalizado sin `\r`); si no, aborta por drift.
- **Postcondición 1:** conservan OID, owner, `SECURITY DEFINER`, config y ACL.
- **Postcondición 2 (cambio mínimo):** `md5(replace(cuerpo, 'FOR NO KEY UPDATE', 'FOR UPDATE'))` es igual al md5 de main. O sea: el único cambio es el modo de lock. Además exige los conteos exactos (W1 2/0, W2 2/0, W3 1/3), el pre-lock `ORDER BY id FOR NO KEY UPDATE` y cero `FOR UPDATE` sobre `inventory`.
- **Postcondición 6:** ningún writer canónico ni el helper bloquea `inventory` con `FOR UPDATE`.

**Semántica de PostgreSQL que se prueba (escenario K, dos conexiones reales):**
- A: choca con otro `FOR NO KEY UPDATE`;
- B: choca con `UPDATE`;
- C: choca con `FOR UPDATE`;
- D: **compatible con `FOR KEY SHARE`**, tanto el `SELECT … FOR KEY SHARE` como un INSERT real por FK (D bis) y contra el lock vivo del checkout (K-W1);
- E: sigue impidiendo lost updates (1–12, S1–S3);
- F: bloquea un `DELETE` concurrente.

**Resultado (CI, run 36024199245, head `f0e7f13`):** WS **10/10** sin deadlocks (`pg_stat_database.deadlocks +0` en cada corrida), con el checkout `created` y el alta ok. Cruces FK 9/9. S3: 5239 transacciones bajo carga con 0 deadlocks y stock exacto. Detalle en §4.

## 8. Fuera de este lote

- Writers del navegador (`registerMovement`, import de Excel) y la revocación de `UPDATE(stock, stock_quantity)`: **G2-C.3, bloqueante para cerrar BETA-GATE-2**.
- `update_inventory_dollar_prices`.
- Doble conversión y vínculo mayorista ↔ comprobante.
- Hacer reintentables los errores 40P01 (hoy se tragan como `INTERNAL_ERROR`).
- Precios, finanzas, ARCA y UX.
