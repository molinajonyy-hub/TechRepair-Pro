# G2-C · Stock asimétrico — discovery y diagnóstico

Discovery hecho sobre el **catálogo vivo** (`pg_proc` de una base con todas las
migraciones aplicadas), no sobre los nombres históricos de las migraciones. Eso
importa: el análisis estático de los archivos apunta a
`public.create_comprobante_checkout_atomic` (definida por última vez en
`20260814150000`), pero la implementación que **realmente corre** es
`private.create_comprobante_checkout_atomic`, movida al schema `private` por el
lote 2 de SECDEF. Parchear la primera no habría cambiado nada en producción.

## El bug

```
stock inicial   2
venta       5   ->  GREATEST(2 - 5, 0) =  0     <- se pierden 3 unidades
reversa    +5   ->  0 + 5              =  5     <- aparecen 3 de la nada
```

La salida clampaba a cero; la reversa era aritmética pura. La asimetría fabrica
unidades.

Y hay un segundo daño, menos visible: `quantity` **no** se clampaba pero
`new_stock` sí, así que la propia fila del movimiento quedaba internamente
inconsistente y el libro de inventario dejaba de cerrar:

```
quantity = -5 , previous_stock = 2 , new_stock = 0
new_stock - previous_stock = -2  ≠  quantity = -5
```

Por eso la matriz de G2-C valida movimientos y no sólo `inventory.stock_quantity`.

## Contrato

La sobreventa está **permitida** de forma explícita. El stock puede quedar
**negativo**: es información real (debo unidades), no un error a esconder.

```
new_stock - previous_stock == quantity        (por cada movimiento)
operación + su reversa exacta => stock_final == stock_inicial
```

## Escritores ACTIVOS de stock

| # | Camino | Implementación activa | Resta | Reversa | Clampa | Sobreventa | Idemp. | Lock | Movimiento | Alcanzable |
|---|--------|----------------------|-------|---------|--------|-----------|--------|------|------------|-----------|
| 1 | Venta POS / comprobante | `private.create_comprobante_checkout_atomic` | `GREATEST(0, prev − qty)` | — | **Sí** | no | sí (`stock_processed`) | `FOR UPDATE` | `sale`, `qty=−n` | **Sí — camino principal** |
| 2 | Anulación / reversa | `private.sec08e_annul_comprobante_impl` | — | `prev + qty` | no | — | sí (limpia el marcador) | vía comprobante | `return`, `qty=+n` | Sí |
| 3 | Repuesto de orden · INSERT | `public.adjust_stock_on_order_item` | `GREATEST(prev − qty, 0)` | — | **Sí** | no | sin marcador | **ninguno** | `order_usage`, `qty=−n` | Sí |
| 3b | Repuesto de orden · DELETE | idem | — | `prev + qty` | no | — | — | ninguno | `return`, `qty=+n` | Sí |
| 3c | Repuesto de orden · UPDATE | idem | `GREATEST(prev − Δ, 0)` | idem | **Sí** | no | — | ninguno | según signo de Δ | Sí |
| 4 | Reparación histórica | `public.repair_missing_stock_movements` | `prev − qty` + *skip* si insuficiente | — | no | opt-in (`p_allow_negative`) | sí | `FOR UPDATE SKIP LOCKED` | `sale` | manual |
| 5 | Borrado de compra | `public.delete_supplier_purchase_safe` | `GREATEST(0, prev − qty)` | — | **Sí** | no | tombstone | `FOR UPDATE` (compra) | `cancellation` | **Sí — `Suppliers.tsx`** |
| 6 | Portal mayorista | `portalService._processWholesaleStock` (**cliente**) | `Math.max(0, prev + delta)` | misma expresión | **Sí** | no | sí | ninguno | `sale` / `return` | sólo con portal habilitado |
| 7 | Alta / ajuste manual | `inventoryMovementsService.registerMovement` (**cliente**) | `prev + qty`, **bloquea** `< 0` | — | no | bloqueada | — | ninguno | varios | Sí |

### Qué corrige G2-C

**#1, #3 y #5** — los tres writers que restan stock por un camino alcanzable
desde producto y pueden quedar en déficit legítimo.

**#5 entró en la revisión humana del PR #143.** El discovery inicial lo había
dejado fuera por ser «reversión de una compra y no una venta con sobreventa», y
esa lectura era **equivocada**: es exactamente el mismo P0, y además es un
camino vivo del módulo core de Proveedores
(`Suppliers.tsx` → `suppliersService.deletePurchaseSafe()` → la RPC).

```
stock 0 → comprar 5 → 5 → vender 5 → 0 → eliminar la compra
ANTES:   GREATEST(0, 0 − 5) = 0     ← fabrica 5 respecto de la historia económica
AHORA:            0 − 5    = −5
```

### Qué NO corrige, y por qué

- **#2** ya era correcto: es la mitad sana de la asimetría.
- **#4** ya es aritmético. Su `p_allow_negative=false` no es un clamp silencioso
  sino un *skip* deliberado que además se **reporta** en
  `items_sin_stock_suficiente`. Es una herramienta manual conservadora: no
  fabrica unidades ni rompe el invariante. Se dejó igual y se prueban sus dos
  ramas (caso 17 de la matriz).
- **#6** tiene el mismo defecto → **G2-C.1**, ver abajo.
- **#7** no clampa; **bloquea** el negativo de forma explícita. Es alta de
  producto y ajuste manual, no una venta.

---

## G2-C.1 — BLOCKER pendiente antes del cierre de BETA-GATE-2

**El portal mayorista escribe stock desde el navegador, con el mismo clamp.**

`src/portal/services/portalService.ts` · `_processWholesaleStock()`:

```ts
const delta    = mode === 'deduct' ? -item.quantity : item.quantity
const newStock = Math.max(0, prevStock + delta)     // ← el clamp, en AMBAS direcciones
await supabase.from('inventory').update({ stock_quantity: newStock })...
await supabase.from('inventory_movements').insert({ quantity: delta, previous_stock: prevStock, new_stock: newStock })...
```

Alcanzable desde `updateOrderStatus()`: `approved` → *deduct*,
`cancelled`/`rejected` → *revert*. Reproduce el P0 completo: `2 − 5 → 0` y
después `0 + 5 → 5`. Y escribe el movimiento con `quantity = delta` sin clampar,
así que rompe el mismo invariante.

**No se parchea en este lote, y no por olvido.** Cambiar `Math.max(0, …)` por
`prevStock + delta` dejaría el resto tal cual: client-side, sin lock, sin
atomicidad entre las tres escrituras y sin autoridad server-side. Sería una
corrección cosmética sobre una arquitectura que G2-B ya declaró incorrecta para
el camino POS.

La corrección correcta es **moverlo server-side**: atómico, con lock sobre la
fila de inventario, idempotente y con autoridad de tenant — igual que el
checkout. Es un lote propio.

> **G2-C.1 bloquea el cierre definitivo de BETA-GATE-2.**

## Otros riesgos registrados (no se expanden en este PR)

- **`adjust_stock_on_order_item` no toma `FOR UPDATE`.** Independiente del clamp
  y preexistente: dos altas concurrentes del mismo repuesto pueden leer el mismo
  `prev_stock` y perder una actualización. G2-C no lo empeora ni lo arregla.
- **`delete_supplier_purchase_safe` bloquea la fila de `supplier_purchases` pero
  no la de `inventory`.** Misma clase de riesgo, también preexistente.

## Diagnóstico histórico

**No se ejecuta ninguna reparación automática.** El stock negativo que produzca
G2-C de acá en adelante es dato legítimo, no corrupción. Lo que sí es rastreable
es la huella que dejó el clamp: movimientos donde el invariante no cierra.

```sql
-- [1] Movimientos con el invariante roto (huella del clamp).
SELECT count(*) AS filas_con_invariante_roto
FROM public.inventory_movements
WHERE new_stock - previous_stock <> quantity;

-- [2] Desglose por tipo y unidades que el clamp se comió.
SELECT movement_type,
       count(*)                                          AS filas,
       SUM(ABS((new_stock - previous_stock) - quantity))  AS unidades_perdidas
FROM public.inventory_movements
WHERE new_stock - previous_stock <> quantity
GROUP BY movement_type ORDER BY 2 DESC;

-- [3] Productos donde ADEMÁS hubo una reversa posterior: son los que pudieron
--     FABRICAR unidades, no sólo perderlas.
SELECT m.business_id, m.inventory_item_id, SUM(m.quantity) AS suma_declarada
FROM public.inventory_movements m
WHERE EXISTS (
  SELECT 1 FROM public.inventory_movements c
   WHERE c.inventory_item_id = m.inventory_item_id
     AND c.new_stock - c.previous_stock <> c.quantity)
GROUP BY m.business_id, m.inventory_item_id
HAVING count(*) FILTER (WHERE m.movement_type IN ('return','cancellation')) > 0;
```

**Medición local (stack aislado, replay completo desde cero): 0 filas.** La base
local no tiene historia de producción, así que el cero es esperable y no dice
nada sobre producción. El query se validó sembrando a propósito una fila con la
huella del clamp (`quantity=-5`, `previous=2`, `new=0`) dentro de una
transacción revertida: la detectó, y tras el `ROLLBACK` volvió a 0.

Antes de decidir cualquier reparación en producción hay que correr [1]–[3] allá,
en modo lectura, y evaluar caso por caso. **Producción no se toca en este lote.**
