# Charts L1 — §24 Source of truth del inventario

**Estado:** resuelto antes de escribir código, según lo exige §24.
**Fecha:** 2026-08-10
**Rama:** `feat/finance-charts-l1` (desde `origin/main` = `9cfdd87`)

Este documento decide qué métricas patrimoniales de inventario se pueden
construir con integridad y **cuáles quedan bloqueadas**. Ninguna cifra de L1
puede existir sin una fila acá.

La evidencia se midió sobre producción en modo **sólo lectura** (agregados, sin
DML, sin backfill). El stack local está en 217/217 pero vacío: sirve para tests,
no para caracterizar el modelo real.

---

## 1. Fuente del stock físico actual

`inventory.stock_quantity` (integer).

Existe también `inventory.stock`, sincronizada por el trigger
`sync_inventory_stock_alias`. **Canónica: `stock_quantity`** — es la que usan
`v_finance_position`, la regla `dead_stock` de M8 y `inventoryMovementsService`.

`inventory_movements.new_stock` **no** es una fuente alternativa de stock actual:
`productService` e `inventoryService` actualizan `stock_quantity` directo en
varios caminos sin emitir movimiento, así que la cadena
`previous_stock → new_stock` tiene huecos. Ver §13.

## 2. Fuente del costo vigente

`inventory.cost_price` — `numeric(10,2) NOT NULL`, **siempre expresada en ARS**.

Para los productos con `base_currency='USD'`, `cost_price` es un **valor ARS
materializado**: lo reescribe el flujo de actualización de precios usando el tipo
de cambio del momento, que queda registrado en `inventory.exchange_rate_used`.

Medición en producción (1340 activos, todos `tipo='product'`):

| base_currency | filas | cost_price_usd>0 | cost_price>0 | exchange_rate_used | rango de tasa |
|---|---|---|---|---|---|
| USD | 686 | 623 | 685 | 686 | 1420,00 – 1546,00 |
| ARS | 654 | 52 | 573 | 630 | 0,00 – 1420,00 |

**Consecuencia:** `stock_quantity * cost_price` es una valuación ARS al **costo
efectivamente registrado hoy en el producto**, no una revaluación FX en vivo.
Ésa es exactamente la semántica que L1 llama **Capital en stock**.

## 3. Tratamiento de variantes

El modelo admite **dos convenciones** de vínculo padre→variante:

- `inventory.parent_id` (columna real, existe en el esquema)
- `inventory.supplier_code = 'VPREF-' || parent_id` (convención usada por
  `productService.createVariant` y por las vistas canónicas de M5)

En producción **ambas dan 0 filas**: `parent_id IS NOT NULL` → 0,
`supplier_code LIKE 'VPREF-%'` → 0. Hay 23 productos con `has_variants=true`,
pero es una bandera huérfana: no existe ninguna fila-variante.

Verificación de que la elección no mueve el número hoy:

| regla de exclusión | capital |
|---|---|
| sólo `VPREF-` (la de `v_finance_position`) | 37.906.051,76 |
| `parent_id` **o** `VPREF-` (la de L1) | 37.906.051,76 |

**Decisión:** L1 excluye padres por **las dos** convenciones. Hoy es idéntico al
legacy (probado arriba), y no se rompe el día que alguien cree una variante por
`parent_id`. **No se modifica `v_finance_position`**: es superficie auditada en
M7 y cambiarla movería un número en producción fuera del alcance de este lote.

## 4. Stock <= 0

- `stock_quantity < 0`: **0 filas** en producción. `inventoryMovementsService`
  lo impide (`newStock < 0` → error).
- `stock_quantity = 0`: 176 filas.

**Decisión:** el universo valuado exige `stock_quantity > 0`. Stock 0 aporta
$0 y no debe inflar el contador de "productos valuados". Si alguna vez aparece
stock negativo, entra al agregado con su signo (restando) y se cuenta aparte en
la cobertura, para que se vea en vez de esconderse.

## 5. Productos sin costo

84 filas con `cost_price = 0`.

**Decisión (§25):** no se valúan como $0 en silencio. El contrato devuelve
cobertura explícita: `products_total`, `products_valued`, `products_missing_cost`,
`units_missing_cost`. La UI declara sobre cuántos productos se calculó, y si la
cobertura cae del umbral documentado pasa a estado `incomplete`.

## 6. Tratamiento de USD

`linked_to_dolar` es `false` en **las 1455 filas**: es una columna muerta, no se
puede usar como señal de dolarización. La señal real es `base_currency='USD'`
(686 activos) más `cost_price_usd > 0` (780).

**Decisión:** el contrato **no** convierte USD→ARS. Lee `cost_price`, que ya está
en ARS. Devuelve además, sólo como metadato de calidad,
`usd_based_products` y `fx_rate_min/max/last_applied` desde `exchange_rate_used`,
para que la UI pueda explicar *por qué* el valor puede moverse sin movimientos
físicos (§21). Ese metadato **no participa de ningún cálculo**.

## 7. Fuente del tipo de cambio

**No existe fuente de FX server-side.** `exchangeRateService` la busca en vivo
desde el cliente contra Bluelytics y contra la Edge Function `infodolar-cordoba`.
No hay tabla de cotizaciones ni histórico de tasas en la base.

**Consecuencia dura:** una superficie SQL **no puede** aplicar un dólar a nada, ni
actual ni histórico. La prohibición de §14 no depende de disciplina: es
estructuralmente imposible de violar desde la base. Lo único que persiste es
`exchange_rate_used` (la tasa que se aplicó la última vez, por producto) y
`inventory_movements.exchange_rate` (la del momento del movimiento).

## 8. Snapshots históricos disponibles

`inventory_valuation_history` — existe, con UNIQUE `(business_id, fecha)`.

Contenido real en producción:

```
1 negocio · 3 snapshots · 2026-04-13 .. 2026-04-15 · span 3 días
```

Los escribe **el frontend** (`useInventoryFinance`, paso 6) de forma oportunista:
sólo si alguien abre la pantalla, y sólo si `totalCapital > 0`. No hay job, no hay
trigger, no hay garantía de continuidad.

**Veredicto: NO es una serie histórica legítima.** 3 días sueltos de abril para un
solo negocio, y los movimientos de inventario van de 2026-05-08 a 2026-08-09 — o
sea, los snapshots ni siquiera se solapan con el período con actividad.

→ **BLOQUEADA la línea histórica de "Capital en stock" (§14).**

## 9. Source de compras (entradas)

`inventory_movements` con `movement_type IN ('purchase','in')`, valuadas a
`unit_cost * quantity` — **costo snapshot del momento de la compra**.

| movement_type | filas | qty>0 | qty<0 | unit_cost>0 |
|---|---|---|---|---|
| purchase | 36 | 36 | 0 | **36 (100 %)** |
| in | 15 | 15 | 0 | **15 (100 %)** |
| sale | 376 | 0 | 376 | **0 (0 %)** |
| order_usage | 26 | 0 | 26 | **0 (0 %)** |
| return | 7 | 7 | 0 | 0 (0 %) |

`reference_type`: `supplier_purchase/purchase`=36, `manual/in`=14,
`supplier_invoice/in`=1.

**Cobertura de costo en entradas: 51/51 = 100 %.** Las compras se pueden valuar.

## 10. Source de consumo (salidas)

**No se puede usar `inventory_movements`**: `sale` y `order_usage` tienen
`unit_cost` en 0 % de las filas. Valuar salidas desde ahí daría $0 — una cifra
falsa con apariencia de exacta.

**Fuente canónica del consumo: el COGS del ledger devengado**
(`v_finance_sales_ledger.cogs_amount_ars`, agregado en `v_finance_pnl.cogs`),
que sale de `comprobante_items.costo_total` — costo snapshot al momento de la
venta.

Ventajas de esta elección, y no es una elección de conveniencia:

1. Es la **misma** fuente que alimenta el gráfico *Resultado del negocio*. El
   consumo del bloque de inventario y el COGS del P&L no pueden divergir.
2. Ya compensa anulaciones de forma append-only (evento `annulment` con importes
   negativos en la fecha de la anulación), lo cual resuelve §36-N y §37 sin
   lógica nueva.
3. Desde P0-A el COGS de repuestos de órdenes está plegado en la línea de
   servicio del comprobante, así que el consumo por órdenes también está cubierto.

**Limitación declarada:** el consumo por `order_usage` que nunca llegó a un
comprobante no aparece. El contrato lo expone como
`consumption_movements_uncosted` (cantidad de movimientos de salida sin costo
asociado) para que la limitación sea visible y no silenciosa.

## 11. Source de ajustes

`movement_type='adjustment'`: **0 filas en producción**. El tipo existe en el
CHECK y `inventoryMovementsService.revertMovement` puede generarlo.

**Decisión:** se expone `inventory_adjustments_*` en **unidades** y, sólo cuando
`unit_cost` está presente, también en pesos, con su propio contador de cobertura.
Nunca se asume costo para un ajuste. Los ajustes **no** entran en el numerador de
reposición (§16, §37).

## 12. Reversas / anulaciones / devoluciones

| hecho | dónde vive | tratamiento en L1 |
|---|---|---|
| devolución física | `movement_type='return'` (7 filas, qty>0, sin costo) | **no** es compra; flujo aparte |
| anulación de comprobante | `comprobante_annulments.status='completed'` (2 en prod) | compensación append-only en la fecha de anulación |
| pagos de un comprobante anulado | **siguen existiendo** (1 fila medida) | se compensan, no se borran |
| reemplazo de pago | `comprobante_payments.replaced_at` (0 en prod) | vivo = `replaced_at IS NULL`, por 6F.3 |
| reversa de caja | `financial_movements.sign=-1` / `reference_type='annulment_reversal'` | ya clasificado por `v_finance_cashflow` |

Confirmado en producción: anular **no** borra `comprobante_payments`. Por eso los
cobros deben compensarse explícitamente, no filtrarse por existencia.

## 13. ¿Hay base suficiente para stock inicial histórico?

**No.**

- Reconstruir stock hacia atrás por `previous_stock/new_stock` tiene huecos:
  hay caminos que escriben `stock_quantity` sin emitir movimiento.
- Aun con el stock reconstruido, **valuarlo requeriría un costo histórico por
  producto y por día que no existe** en ninguna tabla.
- Aplicarle el `cost_price` de hoy es exactamente el cálculo prohibido por §14.

→ **BLOQUEADO el puente/waterfall de inventario (§17).**

---

## Resumen de decisiones

### Se implementa

| métrica | base | por qué es sólida |
|---|---|---|
| **Capital en stock** (valor actual) | `stock_quantity * cost_price`, `stock>0`, activos, `tipo='product'`, sin padres de variante | costo ARS ya materializado; sin FX en vivo |
| **Compras del período** | `inventory_movements` `purchase`/`in` a `unit_cost` | 100 % de cobertura de costo |
| **Consumo del período** | COGS del ledger devengado | mismo origen que el P&L; compensa anulaciones |
| **Ajustes / devoluciones** | `inventory_movements` por tipo | en unidades; en pesos sólo con costo presente |
| **Índice de reposición** | compras ÷ consumo | ambas bases son costo histórico ARS → homogéneas |

### Se bloquea, con motivo

| métrica | motivo |
|---|---|
| Serie histórica de Capital en stock | 3 snapshots de 1 negocio, sin solape con el período con actividad (§8) |
| Puente/waterfall de inventario | no hay costo histórico por producto/día; el stock inicial no se puede valuar sin violar §14 (§13) |
| Cualquier revaluación FX | no existe fuente de FX server-side (§7) |
| Consumo valuado desde `inventory_movements` | `unit_cost` ausente en el 100 % de las salidas (§10) |

Se muestran, en cambio y por separado: **Capital actual en stock** y
**Flujos de inventario del período** — que es la salida explícitamente prevista
por §14 y §17 cuando no hay base homogénea.

### Comparabilidad con `dead_stock` de M8 (§18)

La regla M8 calcula su `inventory_at_cost` sobre un universo **más restringido**
que `v_finance_position`: exige `stock_quantity > 0 AND cost_price > 0`.

Para que "de este total, $X está inmovilizado" sea una afirmación consistente, el
contrato L1 expone `inventory_at_cost_valued` con **exactamente** ese predicado,
además del total. La UI combina las dos cifras sólo cuando comparten denominador;
nunca recalcula la regla de M8 en el frontend.
