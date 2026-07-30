# P0 contable — La ganancia real de órdenes no descuenta el costo de repuestos

**Fecha:** 2026-07-29 · **Baseline:** `origin/main` = f3a492f · prod = 205 migraciones · Health Check critical = 0
**Alcance:** diagnóstico. **No se publicó, no se abrió PR, no se modificó producción ni un solo dato.**
Todas las consultas a producción fueron `SELECT` / `pg_get_functiondef`.

---

## Veredicto

**Causa raíz confirmada.** El ingreso llega al P&L canónico y el costo del repuesto no, porque
**el costo de un repuesto solo existe contablemente si el repuesto viaja como línea del comprobante**,
y el flujo de órdenes excluye por diseño toda línea de repuesto del comprobante.

No es un problema visual, no es el Dashboard, no es la vista. La cadena
`Dashboard → getFinancialSummary → finance_dashboard_summary → v_finance_pnl` es correcta y devuelve
exactamente lo que tiene el modelo: **una venta sin COGS**.

**Recomendación: requiere decisión contable** (3 preguntas, §19) y después
**GO hotfix** para la corrección mínima, que no necesita migración ni backfill.

---

## 1. Orden de control (sanitizada)

| Campo | Valor |
|---|---|
| Order ref | `b1795069…` |
| Creación | 2026-07-27 13:02:48 |
| Repuesto agregado | 2026-07-27 14:16:59 |
| Servicio agregado | 2026-07-27 14:17:31 |
| Estado | `completed` |
| Cobro | 2026-07-29 14:01:48 (comprobante `0001-00759138`, id `b5824a03…`) |
| Servicio | «Cambio de batería» — 1 × **50.000** · costo registrado **0** |
| Repuesto | «Batería Motorola JK 50» — 1 × precio **17.000** · **costo interno 12.200** |
| Flag del repuesto | `cliente_paga_repuesto = false` · `status = used` · con vínculo a inventario |
| Stock | descontado el **2026-07-27** (`order_usage`, 2 → 1), `reference_type='order'` |
| Comprobante emitido | **1 sola línea**: `tipo_linea='servicio'`, 50.000, `costo_unitario=0`, `costo_total=0` |
| Forma de pago / cobrado | efectivo · `total_cobrado` 50.000 · `saldo_pendiente` 0 |
| `comprobantes.order_id` | **NULL** |
| Caja | movimiento `financial_movements` de ingreso 50.000, `source='comprobante'` |

**Resultado esperado vs real (solo esta orden)**

| | Esperado | Real |
|---|---|---|
| Ingreso devengado | 50.000 | 50.000 ✅ |
| COGS | **12.200** | **0** ❌ |
| Contribución | **37.800** | **50.000** |

Sobreestimación: **+12.200 (+32,3 %)**.

`v_finance_pnl` del 2026-07-29 (negocio `aa930802…`): `net_sales` 427.500 · `cogs` 10.765 ·
`gross_profit` = `operating_result` = **416.735** · `data_quality_flags.missing_cost_items` = **0**.

> Nota sobre los otros dos cobros del día (190.000 y 50.000, ambos con COGS 0): en esas dos órdenes
> **nunca se registró un costo** (`costo_unitario = 0` en la orden). Eso es un hueco de carga de datos,
> no una pérdida de la cadena. La pérdida *de cadena* probada hoy es la de la orden de control.

---

## 2. Regla contable vigente (documentada, no cambiada)

| Hecho económico | Cuándo lo reconoce hoy el sistema | Dónde |
|---|---|---|
| **Ingreso de la orden** | Al **emitir el comprobante**, fecha del comprobante en día AR | `comprobante_items` → `v_finance_sales_ledger` (`event_type='sale'`) |
| **COGS de repuesto** | Al emitir el comprobante, **solo si el repuesto es línea del comprobante** | `comprobante_items.costo_total` |
| **Costo interno de servicio** | Al emitir el comprobante, vía `costo_unitario` de la línea de servicio | idem (sí funciona, ver §5) |
| **Descuentos** | `descuento_linea` por línea, en el devengado | `discounts` |
| **Recargos financieros** | Comisión de pago → BFE `payment_fee` | única clase de gasto del P&L que toca el cobro |
| **Anulaciones** | Evento compensatorio en la fecha de anulación (`ar_today()`) | `v_finance_sales_ledger` (`event_type='annulment'`) |
| **Devoluciones** | Nota de crédito efectiva, fecha de la NC | CTE `returns` |

**Criterio de fecha de «Ganancia real hoy»**: **devengado por fecha del comprobante**, con corte diario en
`America/Argentina/Cordoba`. No usa fecha de cobro, ni de finalización de la orden, ni de consumo del repuesto.

Casos aclarados:
- **Orden terminada y no cobrada** → no hay comprobante → **no hay ingreso ni costo**. Correcto y verificado.
- **Cobro parcial / múltiples pagos / pago mixto / cuenta corriente** → **irrelevantes para el P&L**:
  el devengado no mira `comprobante_payments`. El cobro solo afecta caja (`v_finance_cashflow`).
- **Repuesto consumido antes del cobro** → el stock sale en la fecha de consumo; el costo (cuando llega)
  se fecha en el comprobante. **Hay desfase de período por diseño.**
- **Costo modificado después de consumir el repuesto** → ver hallazgo **S3**: para líneas con
  `inventory_id`, la RPC resuelve el costo **del inventario vivo al momento de facturar**, no un snapshot
  del consumo.

---

## 3. Golden path del ingreso (funciona)

```
ModalAgregarItem → order_items(tipo='servicio', precio, costo)
  └ trg_recalculate_order_total  → orders.estimated_total / orders.total_cost
OrderDetail → ComprobanteProModal(initialItems) → comprobanteService.crear()
  └ create_comprobante_checkout_atomic (SECURITY DEFINER, idempotente por business_id+key)
       ├ comprobantes                         (fecha, total)
       ├ comprobante_items                    ← precio y costo RESUELTOS server-side
       ├ comprobante_payments                 → trig_comprobante_payment_sync (total_cobrado)
       ├ financial_movements  source='comprobante'      (caja / percibido)
       └ business_finance_entries  income → revenue_collection_mirror  (EXCLUIDO del P&L)
                                  mercadería → cogs_mirror            (EXCLUIDO del P&L)
v_finance_sales_ledger (append-only, 1 fila por ítem×evento)
  └ v_finance_pnl.net_sales / .cogs / .operating_result
       └ finance_dashboard_summary → getFinancialSummary → stats.realProfitToday
```

`realProfitToday` = `operating_result` (`useDashboardStats.ts:396`). Fuente canónica, sin cálculo en React. ✅

**Anti-doble-conteo verificado:** el ingreso del P&L sale **solo** de `comprobante_items`. Los BFE espejo
(`revenue_collection_mirror`) y el `cogs_mirror` **no** entran al CTE `expenses`, que solo suma
`payment_fee`, `operating_expense` y `employee_salary`. No hay doble ingreso ni doble COGS.

---

## 4. Golden path del costo de repuesto (se corta)

```
ModalAgregarItem (repuesto)
  ├ order_items(tipo='repuesto', costo_unitario=12200, cliente_paga_repuesto=FALSE)
  │    └ trg_adjust_stock_on_order_item  → inventory −1  +  inventory_movements('order_usage')
  │         ⚠ NINGÚN asiento económico. No hay trigger contable en order_items.
  └ order_parts(internal_cost=12200, status='used', deduct_from_inventory=false)
       ⚠ order_parts NO TIENE NINGÚN TRIGGER. Es metadata operativa pura.

OrderDetail.tsx:533-546   filtra:  repuesto ⇒ requiere cliente_paga_repuesto !== false
     → 100 % de los repuestos productivos tienen false  ⇒  EXCLUIDO
OrderDetail.tsx:549-561   fallback order_parts: excluye si el nombre ya está en order_items
     → ModalAgregarItem crea las DOS filas con el mismo nombre  ⇒  EXCLUIDO TAMBIÉN

⇒ el repuesto nunca se convierte en comprobante_item
⇒ costo_total = 0
⇒ v_finance_pnl.cogs no lo ve nunca, en ningún período, por ninguna vía
```

**La etapa exacta donde se pierde el costo:** `src/pages/OrderDetail.tsx:533-563`, al construir
`initialItems`. El dato está intacto en la DB (`order_items.costo_unitario` = 12.200); simplemente
nunca se le ofrece al modelo contable.

**Por qué el ingreso sí llega:** el operador cotiza el servicio incluyendo el repuesto
(50.000 por una batería de 17.000 + mano de obra). El precio entra completo como servicio.
**Facturación − 0 = ganancia.**

Evidencia de que la exclusión es total y no un caso de borde:

```
order_items:  tipo=repuesto  n=26  costo=730.162,50  →  cliente_paga_repuesto=false en 26/26
              tipo=servicio  n=49  costo=364.600,00  →  cliente_paga_repuesto=false en 49/49
comprobante_items: COGS en líneas 'repuesto'  =  30.400
                   COGS en líneas 'servicio'  = 339.600   (de 364.600 registrados ⇒ el costo de
                                                            servicio SÍ fluye, ver §5)
```

El default de la columna en la DB es `true`; lo que escribe `false` es
`ModalAgregarItem.tsx:244` con la preferencia de `localStorage`
(`techrepair_pref_cliente_paga_repuesto`), cuyo **default es OFF** (líneas 42 y 97).
Para `tipo='servicio'` el ternario fuerza `false` siempre.

`orderPartsService.addPartToOrder` sí escribe `cliente_paga_repuesto: true` — pero **no tiene ningún
consumidor**: no hay una sola fila con `true` en producción.

---

## 5. Costos internos

- **Dónde viven:** `order_items.costo_unitario` (`numeric NOT NULL DEFAULT 0`, ARS) y su espejo
  `order_parts.internal_cost`. Un concepto por ítem; admite varios ítems por orden. Sin moneda propia:
  `ModalAgregarItem` convierte USD→ARS con `currencyService` antes de insertar.
- **¿Son solo metadata?** Para **repuestos, sí**: hoy no tienen ningún impacto financiero.
  Para **servicios, no**: fluyen correctamente, porque las líneas de servicio siempre se incluyen en el
  comprobante y `create_comprobante_checkout_atomic` toma `costo_unitario` del payload cuando
  `inventory_id` es NULL. Confirmado en producción: comprobante `0001-00759141`, servicio 120.000 con
  `costo_unitario` 6.800, trazable al `order_items` de la orden `0272deea…`.
- **`economic_class` esperada:** ninguna. El P&L no tiene clase para «costo devengado de orden»; el COGS
  entra exclusivamente como `comprobante_items.costo_total`.

**Contrato mínimo necesario:** que todo costo consumido en una orden llegue a `v_finance_sales_ledger`
(vía línea de comprobante) **o** a `v_finance_pnl.expenses` (vía una clase económica nueva), con
`business_id`, fecha económica, idempotencia y reversa. Hoy no tiene ninguna de las dos vías.

---

## 6. El cobro de la orden

- **RPC canónica de cobro de orden:** `create_order_payment_atomic` → `order_payments` →
  `trig_payment_movements` → `financial_movements` + BFE espejo. **Registra solo el ingreso.**
  No reconoce ni espera costos.
- **Uso real:** **1 sola fila en todo el histórico de `order_payments`.** El cobro productivo ocurre
  por comprobante, no por esta vía.
- **`register_order_payment`** está deshabilitada desde `20260720140000_security_disable_register_order_payment.sql`.
- **Idempotencia:** sí, por `business_id + idempotency_key`, con key durable por intención
  (M7 7D.1/7D.3, `OrderCostManagement.tsx:217` y `ModalCobro.tsx:401`).
- **Relación order_id ↔ comprobante_id ↔ payment_id:** **rota** — ver hallazgo **S2**.
- **Cobro simple / mixto / cuenta corriente:** los tres se comportan igual respecto del P&L (no lo tocan).
  El defecto es **independiente de la forma de pago**.

**Sobre el doble costo:** con la corrección propuesta el costo se reconoce **una sola vez**, en el
comprobante. No se agregan costos «durante el cobro» y no existe hoy ningún devengamiento previo al
consumir el repuesto que pudiera duplicarse.

---

## 7. `v_finance_pnl` — cuál de las hipótesis es

Definición vigente: `20260713270000_m7_6f4c_accrual_views.sql` (Fase C de M7 6F.4).
`cogs = sum(l.cogs_amount_ars)` donde `cogs_amount_ars = ci.costo_total`, sobre
`v_finance_sales_ledger`, filtrando `is_credit_note = false`, agrupado por `(business_id, period_date)`
con `period_date` = fecha del comprobante en día AR. Gastos: solo `payment_fee`,
`operating_expense`, `employee_salary`. Anulados: compensados, no excluidos. Signos correctos.

**Diagnóstico: hipótesis A — no se crean las entradas de costo.**

- **A. No se crean entradas de costo** → ✅ **SÍ, esta es la causa.**
- B. Existen y la vista las excluye → ❌ no existen; no hay ninguna fila financiera asociada al repuesto.
- C. Clasificación incorrecta → ❌ no aplica (no hay fila que clasificar).
- D. Fecha distinta → ❌ no aplica. (Pero **sí** hay un desfase estructural de fechas: ver §19-Q1.)
- E. Ingreso duplicado / costo mal revertido → ❌ verificado: ingreso una sola vez, sin reversas espurias.
- F. Combinación → parcialmente: **A** es la causa, y **S1** (flag ciego) explica por qué nadie lo detectó.

La vista está bien. El modelo nunca recibió el dato.

---

## 8. Reproducción local — **NO EJECUTADA** (declarado explícitamente)

No levanté el stack local ni sembré la orden 100.000 / 20.000 / 5.000 / 10.000 del §8 del pedido.
**Motivo:** la cadena causal quedó probada de punta a punta sobre **datos productivos reales** con una
orden de control concreta, el código exacto que la excluye (`OrderDetail.tsx:533-563`), la ausencia de
triggers contables en `order_items`/`order_parts` (verificada en `pg_trigger`) y la definición vigente de
la vista. Una reproducción sintética confirmaría lo mismo con menos fuerza probatoria.

Queda como **suite de aceptación de la corrección**, junto con §9 y §12. Los casos ya respondidos por la
forensia productiva están marcados abajo.

---

## 9. Casos obligatorios — estado

| # | Caso | Estado |
|---|---|---|
| 1 | Solo mano de obra, sin costos | ✅ correcto hoy (ingreso sin COGS es lo real) |
| 2 | Un repuesto | ❌ **falla** — orden de control |
| 3 | Varios repuestos | ❌ falla igual (la exclusión es por línea) |
| 4 | Costo interno de servicio | ✅ funciona hoy (§5) |
| 5 | Repuestos + costo interno | ⚠️ parcial: el de servicio sí, el de repuesto no |
| 6 | Pago único | ❌ falla (indiferente al pago) |
| 7 | Pago mixto | ❌ falla (indiferente al pago) |
| 8 | Pago parcial | ❌ falla + **política sin definir** (§19-Q2) |
| 9 | Cuenta corriente | ❌ falla (indiferente al pago) |
| 10 | Finalizada sin cobrar | ✅ correcto: no reconoce nada |
| 11 | Repuesto devuelto / retirado | ⚠️ el `DELETE` de `order_items` devuelve stock (trigger); no hay costo que revertir porque nunca se reconoció |
| 12 | Anulación de cobro | ✅ 6F.3, append-only |
| 13 | Anulación de comprobante | ✅ 6F.4, compensación en su período |
| 14 | Anulación de orden | ⚠️ **sin evaluar** — no hay flujo canónico de anulación de orden |
| 15 | Retry idempotente | ✅ verificado por diseño (key + hash) |
| 16 | Costo cambiado después de consumir | ❌ **hallazgo S3** |
| 17 | Cambio de día en TZ AR | ✅ `ar_today()` / `at time zone` consistentes en todo el modelo |

---

## 10. Hallazgos secundarios (todos verificados)

**S1 — El flag de calidad de datos es ciego a este caso.**
`missing_cost` exige `inventory_id IS NOT NULL AND tipo_linea IN ('producto','repuesto')`. Las líneas que
pierden el costo son `servicio` con `inventory_id` NULL ⇒ `missing_cost_items = 0` mientras el COGS es
silenciosamente 0. **Por eso el bug vivió 3 meses sin alarma.** Hay además 31 líneas de servicio con
costo 0 por **2.441.500** de ingreso — cota superior del margen de servicio no verificable.

**S2 — Trazabilidad orden ↔ comprobante rota.**
`ComprobanteProModalProps` no tiene `order_id`, así que nunca se pasa a `comprobanteService.crear()`
(que sí lo acepta) ni al payload de la RPC (que sí tiene `v_order_id`).
**`comprobantes.order_id` está poblado en 3 de 277 filas.** Sin esto no hay reconciliación posible ni
health check automático.

**S3 — El costo no es un snapshot del consumo.**
En `create_comprobante_checkout_atomic`, si la línea trae `inventory_id`, precio **y costo** se resuelven
server-side con `resolve_product_pricing(...)` sobre el `inventory` **vivo** — el `costo_unitario` del
cliente se ignora. Si el costo del producto cambió entre el consumo y la facturación, el COGS usa el
costo nuevo. Viola el requisito de «costo histórico estable» (§10 del pedido).

**S4 — `orders.total_cost` contiene COSTO, no precio.**
`recalculate_order_total` escribe `estimated_total = Σ precio` y `total_cost = Σ costo`.
`ModalCobro.prefillOrden` calcula `saldo = total_cost − amount_paid` → **le cobraría al cliente el costo
interno** (en la orden de control: 12.200 en lugar de 67.000). `ModalCobro` **no está importado en
ningún lado** (código muerto hoy), pero `useOrderSimple.ts:253` usa la misma expresión para
`balance_pending`. Landmine, fuera del alcance de este P0.

**S5 — Asimetría física/económica.**
El stock sale al agregar el repuesto (`order_usage`) y no hay contrapartida económica:
`v_finance_position.inventory_at_cost` baja 12.200 y el resultado no se mueve. El activo desaparece sin
gasto reconocido. La identidad patrimonial queda abierta por el mismo monto.

**S6 — Trampa de doble descuento de stock (crítica para la corrección).**
La RPC descuenta stock para **toda** línea con `inventory_id` y `tipo_linea IN ('producto','repuesto')`.
Como `order_items` ya descontó al agregar, incluir el repuesto **con** `inventory_id` produciría un
**segundo** descuento. Cualquier corrección debe mandar `inventory_id = NULL` en esas líneas o agregar a
la RPC un flag explícito de «stock ya consumido».

---

## 11. Causa raíz (una frase)

> En este modelo el COGS existe **únicamente** como snapshot en una línea de comprobante; un repuesto
> cuyo precio fue absorbido por el servicio (`cliente_paga_repuesto = false`, el **100 %** de los
> repuestos productivos) no genera línea de comprobante y por lo tanto **no genera COGS**, aunque se
> consumió físicamente y se descontó del stock — mientras el ingreso se reconoce completo.

---

## 12. Alcance del defecto

- **¿Todas las órdenes o un flujo?** **Todas las órdenes con repuestos**, sin excepción: 26/26 filas de
  repuesto tienen el flag en `false` desde el 2026-04-20. No es un flujo minoritario ni un caso de borde.
- **¿Pagos simples, mixtos o CC?** **Los tres por igual.** El devengado no mira la forma de pago.
- **No afecta** ventas de POS/mostrador: ahí la línea lleva `inventory_id` y la RPC resuelve el costo
  server-side (por eso los comprobantes de `producto` sí muestran COGS coherente).

---

## 13. Riesgo histórico cuantificado

COGS de repuestos consumidos en órdenes que **nunca** llegó al ledger: **730.162,50 ARS** (26 ítems).

| Mes | Ventas netas | COGS publicado | Resultado publicado | COGS faltante | Resultado corregido | Sobreestimación |
|---|---|---|---|---|---|---|
| 2026-04 | 1.637.400 | 454.304 | **−5.232,74** | 135.840,00 | **−141.072,74** | 2.596 % |
| 2026-05 | 6.196.015 | 2.760.733 | 2.083.244,15 | 195.590,00 | 1.887.654,15 | 9,4 % |
| 2026-06 | 1.877.110,80 | 569.976,40 | 1.238.086,34 | 77.362,50 | 1.160.723,84 | 6,2 % |
| 2026-07 | 5.506.770 | 1.991.957,63 | 3.514.812,37 | 260.370,00 | 3.254.442,37 | 7,4 % |
| 2026-07 (otro negocio) | — | — | — | 61.000,00 | −61.000,00 | — |

Abril es el caso grave: un mes que se reporta **casi en equilibrio** en realidad perdió **141 mil**.

---

## 14. Propuesta mínima

### Fase 0 — Trazabilidad (sin cambio contable, habilita todo lo demás)
Pasar `order_id` de `OrderDetail` → `ComprobanteProModal` → `comprobanteService.crear()` → payload.
La RPC ya lo soporta (`v_order_id`). Sin migración. Habilita reconciliación y health check.

### Fase 1 — La corrección (opción A, recomendada)
Incluir el repuesto absorbido como **línea portadora de costo** en el comprobante:

```
tipo_linea:      'repuesto'
precio_unitario: 0                          // el ingreso ya está en la línea de servicio
costo_unitario:  order_items.costo_unitario  // costo histórico registrado en la orden
inventory_id:    null                        // OBLIGATORIO — ver S6 (doble descuento de stock)
```

Por qué esta y no otra:
- El COGS viaja por el canal canónico existente (`comprobante_items.costo_total` →
  `v_finance_sales_ledger` → `v_finance_pnl`). **Sin migración, sin clase económica nueva, sin vista
  nueva, sin segundo motor de rentabilidad.**
- Queda en el **mismo período que el ingreso** (matching correcto).
- La anulación ya lo compensa automáticamente (el evento `annulment` niega `−ci.costo_total`).
- Es idempotente por herencia (misma key de checkout) y append-only.

Costos de la opción: el documento al cliente muestra una línea en 0 (mitigable en el render), y
`v_finance_product_margin` no atribuye ese COGS al producto (`inventory_id` NULL). **Trade-off explícito**,
consecuencia directa de S6.

**Alternativa 1b** (solo si la respuesta a Q1 es «al consumir»): asiento devengado propio en el consumo,
con clase económica nueva incluida en `v_finance_pnl.expenses`, reversa al quitar el repuesto y guard
anti-doble-conteo contra el canal del comprobante. Es más correcta conceptualmente y **mucho** más
grande: migración + cambio de vista + semántica de backfill + rompe el matching con el ingreso.

### Fase 2 — Cerrar el punto ciego (S1)
Extender la detección: marcar todo comprobante efectivo cuya orden vinculada tenga repuestos consumidos
con costo no reflejado, y sumarlo al Health Check. Depende de la Fase 0.

### Fase 3 — Reconciliación histórica
730.162,50 en 4 meses, según Q4: asiento de ajuste explícito por período, al estilo del script
`7B` de la anulación legacy. **Nunca** `UPDATE`/`DELETE` sobre el ledger.

**Objetos a modificar:** `src/pages/OrderDetail.tsx:533-563`,
`src/components/comprobantes/ComprobanteProModal.tsx` (prop `order_id` → `crear`),
`src/components/order/ModalAgregarItem.tsx` (separar «el cliente paga aparte» de «reconocer el costo»).
Para 1b, además: migración sobre `v_finance_pnl` + tabla/clase de asientos de orden.

---

## 15. Tests requeridos para la corrección

Unitarios (frontend, sobre `initialItems`): servicio sin costo · repuesto con costo histórico · varios
repuestos · costo interno de servicio · repuesto + costo interno · flag `true` (no duplicar la línea) ·
`inventory_id` siempre NULL en la línea de costo.
SQL (`supabase/tests/`): igualdad `ledger = v_finance_pnl = finance_dashboard_summary` · sin doble COGS ·
sin doble descuento de stock (S6, el más importante) · reversa por anulación que netea 0 ·
idempotencia del retry · corte diario AR (00:30 / 23:30) · cobro simple, mixto y CC con el **mismo**
resultado devengado · parcialidad según la política que se decida.

---

## 16. Riesgos

- **Alto — doble descuento de stock** si la línea de costo lleva `inventory_id` (S6). El test SQL es
  obligatorio antes de cualquier deploy.
- **Medio — restatement de períodos cerrados** en la Fase 3: `assert_period_open` va a rechazar asientos
  en meses cerrados; hay que decidir Q4 antes de escribir una línea.
- **Medio — el resultado publicado va a BAJAR** (~7 % mensual, 2.596 % en abril). Es la cifra correcta,
  pero hay que comunicarlo antes de que aparezca en pantalla.
- **Bajo — documento al cliente** con una línea en 0.
- **Fuera de alcance, anotado:** S3 (snapshot de costo) y S4 (`total_cost` como costo) son P1 separados.
  No mezclar con este P0.

---

## 17. Invariantes que la propuesta preserva

Ingreso una sola vez ✅ · costo una sola vez ✅ · ningún cálculo financiero definitivo en frontend ✅ ·
anulaciones por reversa, no `DELETE` ✅ · idempotencia ✅ · aislamiento por `business_id` ✅ ·
ledger append-only ✅ · `v_finance_pnl` sigue siendo la fuente canónica ✅ · Dashboard y Finanzas
muestran el mismo número ✅.
**Costo histórico estable: NO** — queda pendiente por S3, incluso después de la corrección.

---

## 18. Lo que NO se hizo (según §11 del pedido)

No se restó nada en `Dashboard.tsx`; no se calculó ganancia desde `inventory`; no se creó un segundo
motor de rentabilidad; no se escribió en tablas financieras; **no se modificó ni un dato productivo**;
no se corrigió la orden de control; no se cambió ninguna fecha; no se tocó RLS; no se usó `DELETE`
sobre el ledger; no se mezcló ningún otro P0.

---

## 19. Decisiones contables requeridas (bloquean la Fase 1)

**Q1 — ¿Cuándo se reconoce el costo del repuesto?**
(a) **Al facturar** → matching con el ingreso, opción A, sin migración. *Recomendada.*
(b) **Al consumir** → coincide con la salida de stock y con S5, pero desacopla costo e ingreso entre días
y meses. Implica la alternativa 1b.

**Q2 — Cobro parcial:** el modelo actual reconoce el 100 % del ingreso y del COGS al devengar,
independientemente de lo cobrado. Lo consistente es **costo completo al devengar**. Requiere confirmación
explícita antes de fijar el caso 8.

**Q3 — Repuesto absorbido sin ingreso propio** (garantía, gesto comercial): ¿`cogs` o
`operating_expense`? Cambia el margen bruto sin cambiar el resultado operativo.

**Q4 — Restatement histórico:** ¿los 730.162,50 se imputan a sus períodos originales (reabriendo meses
cerrados) o como ajuste del período corriente?

---

## 20. Recomendación

**REQUIERE DECISIÓN CONTABLE** en Q1, Q3 y Q4.

Con Q1 = «al facturar» y Q3 resuelta, **Fase 0 + Fase 1 (opción A) es GO hotfix**: no necesita migración,
no necesita backfill para empezar a medir bien, y usa el canal canónico que ya existe. La Fase 3
(reconciliación de los 730 mil) es un lote aparte, posterior y con su propio gate.

Los lotes siguientes quedan frenados hasta que se cierren Q1/Q3/Q4.
