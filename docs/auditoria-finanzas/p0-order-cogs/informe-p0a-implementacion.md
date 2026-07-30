# P0-A — Reconocimiento del COGS de repuestos absorbidos · informe de implementación

**Fecha:** 2026-07-30 · **Baseline:** `origin/main` = f3a492f · prod = 205 migraciones · Health Check critical = 0
**Estado:** implementado y validado **en local**. **No publicado, no desplegado, sin PR, sin backfill productivo.**
Sobre producción solo se ejecutaron `SELECT` (dry-run de §15).
Diagnóstico previo: [informe-diagnostico.md](informe-diagnostico.md).

---

## 1. Estrategia elegida: **A (plegado en la línea de servicio)**

El costo del repuesto absorbido se incorpora al `costo_total` de la línea de servicio
correspondiente. **No se crea ninguna línea interna de costo.**

## 2. Razón

La opción B exigía una línea con `precio_unitario = 0` y `costo_total > 0`, y
**`comprobante_items` no tiene forma de marcar una línea como interna**: sus 24 columnas son
`descripcion / cantidad / precio / subtotal / costo / inventory_id / tipo_linea / stock_*`.
`tipo_linea` admite `producto|repuesto|servicio|otro` — ninguno significa "no mostrar". Sin un
campo nuevo, esa línea aparecería como un **producto gratuito** en el comprobante impreso, la
factura fiscal, el PDF, WhatsApp y el portal. El pedido es explícito: en ese caso, usar A.

Trazabilidad por repuesto (requisito de §2): se preserva en la **orden**, que es la fuente
inmutable del snapshot (`order_items` / `order_parts`), ahora vinculada al comprobante por
`comprobantes.order_id`. La función de armado expone además `absorbedParts` con el desglose
(descripción, cantidad, costo, origen) y el detector canónico reconcilia orden ↔ comprobante.

## 3. Visibilidad al cliente: **ninguna**

- No se agrega ni se quita ninguna línea del documento. **El total cotizado no cambia**: el
  predicado de facturación sigue siendo `cliente_paga_repuesto !== false`, idéntico al anterior
  (test: *«el predicado de facturación es idéntico al anterior»*).
- Verificado que **ninguna salida al cliente renderiza costos**: `ComprobantePrintLayout`,
  `ComprobanteDocumento`, `ComprobanteItemsTable`, `ServiceOrderPrint`, `OrderPrintPreviewModal`
  y `PortalOrders` no referencian `costo_unitario`/`costo_total`.
- El único lugar que muestra costo es `src/pages/Comprobante.tsx`, la ficha **interna** del
  operador (ver §7: se corrigió para que use el snapshot).

## 4. Costo snapshot utilizado

Exclusivamente el capturado en la orden al consumir el repuesto: `order_items.costo_unitario`
(y `order_parts.internal_cost` para repuestos sin gemelo). **Nunca `inventory.cost_price`.**

Garantía server-side: la línea plegada va **sin `inventory_id`**, y `create_comprobante_checkout_atomic`
solo resuelve precio y costo desde el inventario vivo cuando la línea trae `inventory_id`. Con
`inventory_id` NULL toma el `costo_unitario` del payload verbatim.

Probado con el inventario "envenenado": en el test SQL el producto tiene `cost_price = 99.999`
y el COGS reconocido es **12.200** (assert `A9`).

Validaciones de §3 cubiertas: costo unitario histórico (`A3`), cantidad (test unitario 4b:
1.500 × 4 = 6.000), moneda (ARS; `costo_absorbido` solo se pliega en líneas ARS), costo total
(`A3`, `A10`), **redondeo** (ver abajo), costo cero legítimo (caso 1: COGS 0 sin marcar hueco) y
costo faltante (`G1`: `snapshot_de_costo_faltante`, nunca pasa como cero silencioso).

**Redondeo.** `comprobante_items.costo_unitario` y `costo_total` son `numeric(14,2)` y el checkout
deriva `costo_total = costo_unitario × cantidad`. El plegado elige como destino, en este orden:
línea de servicio con **cantidad 1** → primera línea de servicio → primera línea facturable. Con
cantidad 1 el residuo es exactamente **0**; si la única línea disponible tiene cantidad > 1 el
residuo queda acotado a **≤ 0,005 × cantidad ARS** (sub-centavo), medido y aseverado por test, e
invisible tras el `ROUND(...,2)` de `v_finance_pnl`.

## 5. Prevención de doble stock

`order_items` ya descuenta stock al agregar el repuesto (`adjust_stock_on_order_item` →
`inventory_movements` tipo `order_usage`). Por eso **toda** línea derivada de la orden va con
`inventory_id` ausente.

Esto además **corrige un bug latente**: el armado anterior mandaba `inventory_id: i.product_id`
en las líneas de repuesto facturables. No explotó nunca solo porque ninguna fila productiva tiene
`cliente_paga_repuesto = true`; con el toggle activado habría descontado stock dos veces.

Test exigido por §4, verificado sobre la base real:

```
stock inicial 10 → agregar repuesto a la orden → 9 → facturar/cobrar → 9   (NUNCA 8)
```

Asserts `C0`, `A6`, `A7`, `A8`, `B4`, `D4` (`D4`: 10 − 3 consumos = 7, tras tres checkouts).
El detector canónico agrega una cuarta dimensión, `riesgo_doble_stock`, para que no reaparezca
por otra vía.

## 6. `order_id`

- `ComprobanteProModal` recibe la prop `orderId` y la transmite como `order_id`.
- `comprobanteService.crear` ya la propagaba al payload; la RPC ya la persistía y **valida
  pertenencia al negocio** (`ORDER_NOT_FOUND`). El defecto era solo la prop faltante.
- Verificado en simple (`A2`), mixto (`C3`) y cuenta corriente, y en **replay idempotente**
  (`B1`/`B2`: misma key → `existing`, mismo comprobante, mismo vínculo).
- No se infiere `order_id` por nombre ni por cliente en ningún checkout nuevo.
- Guard/test: el test unitario *caso 10* falla si `OrderDetail` deja de pasar `orderId={order.id}`,
  si vuelve el armado anterior o si reaparece `inventory_id: i.product_id`.

## 7. Costos internos

Inventario real de campos: **hay uno solo**, `order_items.costo_unitario`, espejado en
`order_parts.internal_cost`. No hay tabla ni catálogo de conceptos internos.

Semántica vigente documentada, sin ampliarla:
- En un ítem `tipo='servicio'` es un **costo interno directamente atribuible** a la orden ⇒ costo
  directo del servicio. Ya llegaba al P&L (las líneas de servicio siempre se facturan) y se
  conserva igual.
- En un ítem `tipo='repuesto'` es el **costo del repuesto** consumido ⇒ COGS. Es el que se perdía.
- Gastos generales del taller **no** pasan por acá: siguen siendo `operating_expense` vía BFE. No
  se convirtió ningún gasto general en COGS.

Por cada concepto se conserva: orden de origen (`order_id`), concepto (`descripcion`), importe
(`costo_unitario × cantidad`), moneda (ARS), snapshot (la fila de `order_items` es inmutable en la
práctica), fecha económica (la del comprobante, decisión 1) e idempotencia (heredada de la key
del checkout).

**Corrección adicional necesaria** (`src/pages/Comprobante.tsx`): esa ficha calculaba la ganancia
releyendo `inventory.cost_price` **vivo** e ignorando `costo_total`, y asumía `margin: 100` cuando
ninguna línea tenía `inventory_id`. Sin tocarla, la orden de control habría mostrado **margen
100 %** en la ficha del comprobante y **75,6 %** en Finanzas — el fix habría parecido roto y se
habría violado el invariante «Dashboard y Finanzas muestran lo mismo». Ahora lee el snapshot
persistido: se elimina un motor de rentabilidad paralelo en el frontend, no se agrega uno.

## 8. Reversas

**No hizo falta código nuevo.** Al viajar el costo en `comprobante_items.costo_total`, la
anulación lo revierte por la vía canónica que ya existía: `v_finance_sales_ledger` emite el evento
`annulment` con `−ci.costo_total` en la fecha económica de la anulación. Sin `DELETE`, sin tocar
snapshots, idempotente por `comprobante_annulments.idempotency_key`.

Verificado: `E2` (el par venta/anulación netea 0 en ingreso **y** en COGS), `E3` (la venta no
desaparece: queda el evento de compensación).

Separación de los tres hechos distintos (§7 del pedido):
- **Anulación financiera** → revierte ingreso y COGS. **No repone stock** del repuesto consumido,
  porque nunca hubo salida por venta: la pieza está dentro del equipo reparado (assert `E4`).
- **Devolución física** del repuesto → quitar el ítem de la orden; el trigger de `order_items`
  repone stock y emite `return`.
- **Cancelación de orden** → sin flujo canónico. Fuera de alcance; el detector expone las órdenes
  canceladas con costo (1 caso, 16.000 ARS) para decisión aparte.

## 9. Health Check

Nueva vista canónica `v_finance_order_cogs_gaps` (migración `20260730120000`), read-only y con
`security_invoker = true`. Cuatro dimensiones:

| `gap_type` | Qué detecta | Severidad |
|---|---|---|
| `cogs_incompleto` | comprobante vinculado con COGS menor al costo atribuible de la orden | critical |
| `orden_sin_comprobante_vinculado` | costo atribuible sin comprobante efectivo vinculado (incluye el `order_id` NULL histórico) | critical si la orden está cerrada, si no warning |
| `snapshot_de_costo_faltante` | repuesto consumido con costo 0 | warning |
| `riesgo_doble_stock` | línea con `inventory_id` sobre un producto ya consumido por la orden | critical |

**No se tocó `missing_cost`.** Su semántica actual (ítem de inventario facturado sin costo
resuelto) es correcta y tiene otros consumidores; el pedido advierte explícitamente contra
resolverlo quitando la condición `inventory_id NOT NULL`. Se agregó una dimensión nueva con
trazabilidad propia por `order_id`, mismo criterio que 6F.4 usó con el ledger devengado.

Asserts: `F2`/`F3` (el detector acusa el armado viejo con 12.200 critical — control de regresión:
si el detector fuera ciego, este test falla), `A15`/`A16` (sin huecos para la orden corregida),
`G1`, `H1` (aislamiento entre negocios verificado con rol `authenticated`).

La integración de esta vista en la pantalla `FinanceHealthCheck` quedó **fuera** de este lote a
propósito: `finance_health_check_v2` es una función de ~700 líneas y reemplazarla completa para
agregar dos checks es un riesgo desproporcionado frente al beneficio. La vista ya está expuesta a
`authenticated` y es consultable; sumarla al panel es un lote de UI aparte.

## 10. Resultado de la orden de control

Reproducción local completa (dentro de `BEGIN … ROLLBACK`), con el inventario en `cost_price = 99.999`
para probar que el costo **no** sale de ahí:

```
=== 1. ORDEN ===
 order_ref | status    | precio_cotizado | costo_interno
 ----------+-----------+-----------------+--------------
 (orden)   | completed |        67000.00 |      12200.00

=== 2. ITEMS DE LA ORDEN (snapshot del costo) ===
 tipo     | descripcion       | cant | precio_unit | costo_unit | cliente_paga | con_inventario
 ---------+-------------------+------+-------------+------------+--------------+---------------
 repuesto | Bateria JK50      |    1 |    17000.00 |   12200.00 | f            | t
 servicio | Cambio de bateria |    1 |    50000.00 |       0.00 | f            | f

=== 3. COMPROBANTE ===
 numero        | order_ref | estado  | total    | total_cobrado | saldo | fecha_ar
 --------------+-----------+---------+----------+---------------+-------+-----------
 0001-00000001 | (orden)   | emitido | 50000.00 |      50000.00 |  0.00 | 2026-07-30
                 ^^^^^^^^^ order_id POBLADO

=== 4. COMPROBANTE_ITEMS ===
 descripcion       | tipo_linea | cant | precio_unit | subtotal | costo_unit | costo_total | inventory_id | stock_processed
 ------------------+------------+------+-------------+----------+------------+-------------+--------------+----------------
 Cambio de bateria | servicio   | 1.00 |    50000.00 | 50000.00 |   12200.00 |    12200.00 | (NULL)       | f

=== 5. INVENTORY MOVEMENTS ===
 movement_type | qty | previous_stock | new_stock | reference_type | note
 --------------+-----+----------------+-----------+----------------+----------------------------------
 order_usage   |  -1 |             10 |         9 | order          | Repuesto usado en orden #…
 (UNA sola fila · stock_actual = 9 · ningún movimiento 'sale')

=== 6. LEDGER DEVENGADO ===
 event_type | period_date | tipo_linea | descripcion       | sales_amount_ars | cogs_amount_ars | missing_cost
 -----------+-------------+------------+-------------------+------------------+-----------------+-------------
 sale       | 2026-07-30  | servicio   | Cambio de bateria |         50000.00 |        12200.00 | f

=== 7. v_finance_pnl ===
 period_date | gross_sales | net_sales | cogs     | gross_profit | operating_result | data_quality_flags
 ------------+-------------+-----------+----------+--------------+------------------+-------------------------------
 2026-07-30  |    50000.00 |  50000.00 | 12200.00 |     37800.00 |         37800.00 | {"missing_cost_items": 0, …}

=== 8. DETECTOR DE HUECOS ===
 (0 rows)
```

`finance_dashboard_summary` sobre el mismo día devuelve `cogs = 12200` y
`operating_result = 37800` (asserts `A13`/`A14`): **comprobante_items = ledger = v_finance_pnl =
fuente del Dashboard**.

| | Antes | Ahora |
|---|---|---|
| Ingreso | 50.000 | 50.000 |
| COGS | **0** | **12.200** |
| Resultado | **50.000** | **37.800** |

## 11. Tests

**Unitarios** — `tests/unit/orderCogsAbsorbed.test.ts`, 23 tests sobre la función pura
`buildOrderComprobanteItems` más contratos de wiring: servicio sin costo · repuesto absorbido
(100.000/25.000 → 75.000) · repuesto cobrado aparte · varios absorbidos · cantidad > 1 · repuesto
+ costo interno · flag `false` no elimina COGS · flag `true` no lo duplica · sin `inventory_id` en
ninguna línea · snapshot (no lee `inventory`) · preferencia de destino y residuo de redondeo ·
`order_parts` sin gemelo · repuesto devuelto (`returned`) no es COGS · orden sin línea facturable ·
`NULL` = facturable · orden de control · el total cotizado no cambia · `order_id` en las tres capas ·
ficha del comprobante con snapshot · detector read-only con `security_invoker`.

**SQL de integración** — `supabase/tests/p0a_order_cogs_test.sql`, **40 asserts** contra la base
real: checkout con `order_id`, costo snapshot, stock exactamente una vez, ledger, P&L, Dashboard,
retry idempotente, pago mixto, cuenta corriente, P&L acumulado (150.000 − 36.600 = 113.400),
anulación con reversa de ingreso y COGS, corte diario en TZ Argentina, control de regresión del
armado viejo, snapshot faltante y aislamiento entre negocios.

Cobertura de los 20 casos de §9: **1-13 y 15-19 cubiertos**. El 14 (parcialidad) queda documentado
sin prorrateo (decisión 4: el COGS es completo al devengar; el pago parcial no lo altera —
verificado en CC, donde el ingreso está 100 % impago y el COGS es igual). El 20 no aplica: no se
usó línea interna.

## 12. Archivos

| Archivo | Cambio |
|---|---|
| `src/lib/orderBilling.ts` | **nuevo** — función pura del armado (fold, snapshot, sin `inventory_id`) |
| `src/pages/OrderDetail.tsx` | usa la función; pasa `orderId`; −40 líneas de armado ad-hoc |
| `src/components/comprobantes/ComprobanteProModal.tsx` | prop `orderId` → `order_id` + dep del `useCallback` |
| `src/pages/Comprobante.tsx` | ganancia desde el snapshot, no desde `inventory` vivo |
| `supabase/migrations/20260730120000_p0a_order_cogs_gap_detector.sql` | **nuevo** — detector canónico |
| `supabase/tests/p0a_order_cogs_test.sql` | **nuevo** — 40 asserts |
| `tests/unit/orderCogsAbsorbed.test.ts` | **nuevo** — 23 tests |
| `docs/auditoria-finanzas/p0-order-cogs/*.md` | diagnóstico + este informe |

Sin cambios en `comprobanteService`, en `create_comprobante_checkout_atomic`, en `v_finance_pnl`,
en `v_finance_sales_ledger` ni en ningún trigger. **El motor contable no se tocó.**

## 13. Migraciones

Una sola, **aditiva y read-only**: `20260730120000_p0a_order_cogs_gap_detector.sql` (una vista).
No altera tablas, ni funciones, ni datos. Rollback documentado en el archivo (`DROP VIEW`).

## 14. Commit

`fefa816` en la rama **`fix/p0a-order-cogs-absorbed`** (no `main`), **sin push, sin PR**.
9 archivos, +1931 / −86.

## 15. Dry-run histórico (P0-B) — solo lectura, no ejecutado

**`finance_period_locks` está VACÍA**: hoy no hay ningún período cerrado en producción, así que no
haría falta reabrir nada. El reconciliador debe respetar el lock igualmente, porque un cierre puede
ocurrir antes de que P0-B corra.

Universo inequívoco: **730.162,50 ARS** en 23 órdenes con costo de repuesto consumido y snapshot
presente (coincide exactamente con el total del diagnóstico).

**Clasificación por matching determinista** (mismo negocio + mismo cliente + una línea de servicio
con descripción **y** importe idénticos + unicidad 1:1 en ambas direcciones):

| Clasificación | Órdenes | Monto ARS |
|---|---|---|
| `resoluble_1a1` | 14 | **433.212,50** |
| `ambiguo_sin_candidato` | 9 | **296.950,00** |

Ningún caso cayó en `ambiguo_multiples_comprobantes` ni `ambiguo_comprobante_compartido`.

**Resolubles, por mes del ingreso original (`effective_at` = fecha del comprobante):**

| Mes | Ajustes | COGS a reconocer | Resultado publicado | Resultado corregido | Impacto |
|---|---|---|---|---|---|
| 2026-05 | 3 | 121.040,00 | 2.083.244,15 | 1.962.204,15 | −5,8 % |
| 2026-06 | 3 | 77.362,50 | 1.238.086,34 | 1.160.723,84 | −6,2 % |
| 2026-07 | 8 | 234.810,00 | 3.514.812,37 | 3.280.002,37 | −6,7 % |
| **Total** | **14** | **433.212,50** | | | |

Rangos de `effective_at`: 2026-05-21…28 · 2026-06-08…09 · 2026-07-08…29.

**Idempotency keys propuestas** (deterministas, derivadas del hecho económico, no del intento):
`order_cogs_backfill§<business_id>§<order_id>§<comprobante_id>§<costo_total_centavos>`.
Misma orden + mismo comprobante + mismo importe ⇒ misma key ⇒ un reintento es replay, nunca un
segundo ajuste. Cambia si cambia el importe, lo que fuerza revisión explícita.

## 16. Casos ambiguos

| Mes orden | Estado | Órdenes | Monto | Interpretación |
|---|---|---|---|---|
| 2026-04 | completed | 3 | 135.840,00 | facturadas, pero ninguna línea de servicio coincide en descripción **e** importe ⇒ **revisión manual** |
| 2026-05 | completed | 3 | 74.550,00 | ídem (1 sin línea de servicio) ⇒ **revisión manual** |
| 2026-07 | ready_delivery | 1 | 25.560,00 | **no es error**: orden aún sin facturar |
| 2026-07 | repair | 1 | 45.000,00 | **no es error**: orden abierta |
| 2026-07 | cancelled | 1 | 16.000,00 | orden cancelada con repuesto consumido ⇒ **decisión contable aparte** |

Neto: **210.390,00 ARS** en 6 órdenes cerradas requieren resolución manual;
**70.560,00** son órdenes vivas que se van a reconocer solas al facturarse con el código corregido;
**16.000,00** dependen de definir el tratamiento de la cancelación.

**El reconciliador debe rechazar los 9 ambiguos, no adivinar.** Ninguna heurística por cliente o
por fecha es determinista y §11 lo prohíbe explícitamente.

## 17. Riesgos

- **Bajo · redondeo sub-centavo** si el plegado cae en una línea con cantidad > 1. Acotado, medido
  por test e invisible tras el `ROUND(...,2)` del P&L.
- **Bajo · el operador borra en el POS la línea que lleva el costo plegado.** El costo se pierde en
  ese comprobante. Es una acción explícita, y el detector canónico lo acusa como `cogs_incompleto`.
  Mitigable más adelante mostrando el costo plegado en el POS.
- **Bajo · seleccionar un producto de inventario sobre la línea plegada** reemplaza el
  `costo_unitario` por el del inventario. Misma detección.
- **Medio · el resultado publicado baja** ~6 % mensual en cuanto el código corregido opere, y
  ~433 mil más si se aplica el backfill. Es la cifra correcta: hay que comunicarlo antes.
- **Nulo en producción hoy**: nada fue desplegado.
- **Sin verificación en navegador.** La base local quedó recién reseteada y sin negocio/sesión
  sembrados; no se hizo el recorrido de UI. Compilación (`tsc`, `build`), lógica pura (23 tests) y
  contrato server-side con el payload exacto (40 asserts) sí están cubiertos. El riesgo residual es
  de render, no contable.

**Validación ejecutada** (§13): `db reset` ×2 (206 migraciones, ambos limpios) · `tsc --noEmit` 0
errores · `lint:errors` 0 · `node --test` **572/572** · `build` OK · `guards` OK (incluye
`guard:view-invoker`, que exige `security_invoker` en toda vista expuesta) · secret scan sobre los
archivos tocados: limpio · SQL de checkout, órdenes, pagos, anulaciones, P&L y Health Check:
**360 asserts, 0 fallas, 0 regresiones** en 7 suites preexistentes + la nueva.

## 18. Recomendación de release P0-A

**GO**, con dos condiciones de secuencia:

1. **DB primero**: aplicar `20260730120000` (una vista aditiva y read-only; el frontend viejo no la
   usa, así que no hay ventana de incompatibilidad).
2. **Frontend después**, y avisar que «Ganancia real hoy» va a **bajar** ~6 %: no es una regresión,
   es el costo que antes faltaba.

El riesgo técnico es bajo: no se modificó ninguna RPC, ningún trigger, ninguna vista del motor
contable y ninguna fila. Lo que cambió es **qué se le manda** al checkout.

## 19. Propuesta separada de ejecución P0-B

Lote aparte, con su propio gate. Diseño del reconciliador:

1. **Localizar** con `v_finance_order_cogs_gaps` (`cogs_incompleto` + `orden_sin_comprobante_vinculado`).
2. **Costo** exclusivamente del snapshot de la orden. Sin snapshot ⇒ no se ajusta; se reporta.
3. **Vincular** con la regla 1:1 estricta de §15. **Rechazar** los 9 ambiguos hacia una cola de
   revisión manual con el detalle de por qué.
4. **Fecha** = `effective_at` del ingreso original (fecha del comprobante), no la de hoy.
   **No agrupar los 730 mil como gasto del día actual.**
5. **Asientos append-only** e idempotentes con las keys de §15.
6. **Períodos bloqueados**: sin bypass. Reapertura auditada → ajuste → reconciliación → cierre.
   Hoy `finance_period_locks` está vacía.
7. **Dry-run obligatorio** antes de cada corrida, con el mismo formato de §15/§16.
8. **Decisión contable pendiente**: qué hacer con los 6 casos ambiguos cerrados (210.390) y con la
   orden cancelada con repuesto consumido (16.000).

**Bloqueado a propósito hasta aprobación explícita.** No se escribió ningún script de escritura.

---

### P1 registrados, no mezclados

1. Líneas de producto normales resuelven el costo desde el inventario **vivo** al facturar
   (`resolve_product_pricing`): no es snapshot del momento de la venta. **P0-A ya dejó de usar
   inventario vivo para los costos de órdenes**; rehacer el flujo de productos es otro lote.
2. `orders.total_cost` contiene la suma de **costos**, no de precios (`recalculate_order_total`), y
   `ModalCobro.prefillOrden` cobra ese campo ⇒ le cobraría al cliente el costo interno.
   `ModalCobro` no está importado en ningún lado (código muerto), pero `useOrderSimple:253` usa la
   misma expresión para `balance_pending`.
3. Semántica y nombre de `cliente_paga_repuesto`: hoy nombra una decisión de facturación y se leía
   como una decisión contable. Renombrarlo a algo como `facturar_al_cliente` evitaría la recaída.
4. 274 de 277 comprobantes históricos sin `order_id`: solo resoluble por revisión manual (§16).
