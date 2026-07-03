# Auditoría integral del módulo Finanzas — TechRepair Pro + Mi Guita

**Fecha:** 2026-07-02 · **Alcance:** solo lectura (no se modificó código ni datos)
**Base auditada:** proyecto Supabase `vrdxxmjzxhfgqlnxmbwx`, negocio real "Clic" (`aa930802-…`), 174 comprobantes, 188 pagos, 214 movimientos de caja, 279 asientos BFE, 38 sesiones de caja.

## Índice de entregables

| # | Entregable | Documento |
|---|-----------|-----------|
| 1 | Resumen ejecutivo | este archivo |
| 2 | Mapa completo del flujo financiero + matriz de fuentes de verdad | [01-inventario-y-flujo.md](01-inventario-y-flujo.md) |
| 3 | Registro formal de fórmulas | [02-formulas.md](02-formulas.md) |
| 4 | Auditoría de casos extremos | [03-casos-extremos.md](03-casos-extremos.md) |
| 5 | Auditoría de monedas | [04-monedas.md](04-monedas.md) |
| 6 | Auditoría UX + propuesta de dashboard + specs de gráficos + motor de explicaciones | [05-ux-dashboard.md](05-ux-dashboard.md) |
| 7 | Calidad y seguridad (RLS, SECURITY DEFINER, concurrencia, TZ) | [06-seguridad-calidad.md](06-seguridad-calidad.md) |
| 8 | Arquitectura propuesta, plan de tests, plan de migraciones, roadmap, archivos a tocar | [07-roadmap.md](07-roadmap.md) |
| 9 | Scripts SQL de conciliación (re-ejecutables) | [conciliaciones.sql](conciliaciones.sql) |

---

## 1. Resumen ejecutivo

TechRepair Pro tiene una **base transaccional mucho mejor que el promedio** de sistemas de este tamaño: el checkout del POS es una RPC atómica idempotente (`create_comprobante_checkout_atomic`), los balances de cuenta corriente se calculan server-side con locks reales, existe un health-check financiero de 16 checks en la base, y todas las columnas monetarias son `numeric`. Ese esqueleto es correcto y hay que conservarlo.

El problema central **no es la infraestructura: es el modelo contable**. El sistema tiene **tres libros paralelos que nadie concilia** y que hoy, con datos reales, ya divergen:

| "Lo cobrado" según… | Total histórico (Clic) |
|---|---|
| `comprobante_payments` (pagos, sin CC) | **$10.694.159** |
| `business_finance_entries` tipo `income` (P&L) | **$10.565.057** |
| `financial_movements` income sign=1 (caja) | **$9.030.927** |

Una diferencia de **~$1,66M (15,5%)** entre lo que dicen los pagos y lo que dice la caja. No hay una definición única de "ingreso": cada pantalla (Dashboard, Panel Financiero, Finanzas nuevas, Caja) suma una tabla distinta con filtros distintos.

### Los cinco problemas estructurales

1. **P&L, caja y patrimonio están mezclados en una sola tabla (`business_finance_entries`)**. El "Resultado neto" del Panel Financiero resta del negocio los **costos personales del dueño** y los **retiros** — exactamente lo que la regla funcional prohíbe. El mismo retiro impacta distinto según la puerta: por Mi Guita → solo caja (correcto); por Finanzas manual (`salary/retiros`) → P&L pero **no** caja.

2. **El costo se cuenta dos (a veces tres) veces**. Al pagar una compra a proveedor se registra `variable_cost/compras_proveedor` (pago de pasivo tratado como costo), y al vender el producto se registra `variable_cost/mercaderia` (COGS). El flujo "compra rápida" desde Gastos además genera un **tercer** asiento vía `trigger_expense_finance`. Con datos reales: COGS de ítems vendidos $2.258.003, pero la suma de categorías de costo en BFE (mercaderia + inventario + compras_proveedor + repuestos) = $2.930.777. El margen bruto mostrado está sistemáticamente subestimado.

3. **Bases contables mezcladas**: el costo de venta se devenga al vender (accrual), el ingreso se reconoce al cobrar (caja), y las ventas en cuenta corriente devengan costo hoy e ingreso cuando se cobra. En un mes con ventas a crédito, el margen que muestra el panel es matemáticamente incorrecto por diseño, no por bug.

4. **Los reversos son asimétricos y client-side**. `anular()` revierte finanzas y stock desde el navegador (sin transacción, sin caja_id, sin tocar cuenta corriente); borrar un pago de orden deja los ingresos del trigger huérfanos; borrar un gasto reversa BFE pero no caja; el botón de basura de Caja borra cualquier movimiento (incluso de comprobantes) sin reverso. Evidencia real: 1 comprobante anulado con $13.050 de ingreso sin reversa; 2 comprobantes con `total_cobrado` que no coincide con sus pagos; 24 movimientos ($3,6M) fuera de toda sesión de caja.

5. **La deuda no tiene fuente única**: la deuda de clientes vive en `comprobantes.saldo_pendiente` ($25.100) y en `accounts` ($0 — vacía); la de proveedores en `supplier_purchases/supplier_account_movements` ($4.562.420) y en `accounts` tipo proveedor ($0 — vacía). El Dashboard principal lee `accounts` → **muestra $0 de deuda de proveedores cuando el negocio debe $4,56M**.

### Qué funciona correctamente (verificado contra datos)

- ✅ Checkout POS atómico + idempotente (doble click / retry cubiertos server-side).
- ✅ Conciliación de caja por sesión: inicial + ingresos − egresos = cierre, sin desvíos > $1 en 38 sesiones.
- ✅ Ledger de proveedores concilia exacto con compras pendientes ($4.562.420 = $4.562.420).
- ✅ `trig_comprobante_payment_sync` mantiene `total_cobrado` (los 2 desvíos son datos pre-RPC de abril).
- ✅ Snapshot de costo y TC por ítem vendido (`costo_unitario`, `exchange_rate` en `comprobante_items`) — la rentabilidad histórica no cambia si cambia el dólar.
- ✅ Bloqueo fiscal: no se puede anular/eliminar un comprobante con CAE sin NC; claim atómico por serie fiscal.
- ✅ Sin números locales duplicados, sin cajas solapadas, sin huérfanos de FK en el negocio real.
- ✅ Todas las columnas de dinero son `numeric` (no float).

### Recomendación honesta

**No agregar ni un gráfico más hasta cerrar el modelo contable.** Cualquier waterfall o Sankey construido sobre `business_finance_entries` hoy visualizaría números incorrectos con más convicción. El orden correcto es:

1. **Definir el plan de cuentas mínimo** (ingreso devengado / cobro / COGS / gasto operativo / movimiento de capital) y qué tabla es dueña de cada concepto → [07-roadmap.md](07-roadmap.md) §1.
2. **Cerrar los P0** (doble costo, retiros en P&L, reversos asimétricos, deuda proveedores invisible) — son ~10 cambios acotados, la mayoría en SQL.
3. **Instalar las conciliaciones como tests** (el health-check de 16 checks ya existe; faltan las 6 conciliaciones de flujo de [conciliaciones.sql](conciliaciones.sql)).
4. Recién entonces construir el dashboard de 3 niveles ([05-ux-dashboard.md](05-ux-dashboard.md)), que puede ser espectacular porque la materia prima (snapshots por ítem, ledger por sesión de caja, ledger CC) ya existe.

---

## 2. Lista priorizada de hallazgos

Severidades: **P0** = puede mostrar resultados financieros incorrectos o corromper datos · **P1** = inconsistencia significativa o riesgo frecuente · **P2** = interpretación/UX/cálculo secundario · **P3** = claridad/rendimiento/mantenibilidad.

### P0 — corregir antes de cualquier gráfico nuevo

| # | Hallazgo | Evidencia | Dónde |
|---|----------|-----------|-------|
| P0-1 | **Doble/triple contabilización de costos**: pago a proveedor → `variable_cost/compras_proveedor`; venta del mismo producto → `variable_cost/mercaderia`; compra rápida desde Gastos genera BFE propio **más** el del trigger `trigger_expense_finance` (inserta `expenses` sin `finance_entry_id`). | BFE Clic: mercaderia $1,60M + inventario $0,66M + compras_proveedor $0,44M + repuestos $0,23M vs COGS real $2,26M | `pay_supplier_purchase_atomic`, `create_supplier_purchase_atomic`, [ModalCrearGasto.tsx:605-634](../../src/components/expenses/ModalCrearGasto.tsx), `trigger_expense_finance` |
| P0-2 | **Retiros del dueño y gastos personales dentro del resultado del negocio**: `resultadoNeto = margen − fijos − sueldos/retiros − costos personales`. Categorías `retiros`, `fixed_cost_personal` restan del P&L empresarial. | $3.000.000 en `salary/sueldo_dueno` restando del resultado de Clic | [financialMetricsService.ts:126](../../src/services/financialMetricsService.ts), [financeService.ts:207-245](../../src/services/financeService.ts) |
| P0-3 | **Ingreso de caja/P&L para ventas sin ningún pago**: la RPC de checkout inserta BFE income + FM income por el **total** cuando `cash=0 y cc=0` (venta "pendiente" pura o NC creada por `crear()`); reconoce ingreso de dinero que no entró. | Rama `IF v_cash_total = 0 AND v_cc_total = 0` | `create_comprobante_checkout_atomic` paso 5 |
| P0-4 | **Pagos de orden duplicados en caja**: `order_payments` INSERT dispara `trigger_payment_creates_movements` (FM+BFE) **y** el componente inserta un segundo FM income manual. Borrar el pago no borra ninguno de los dos. | Solo 1 order_payment en datos (riesgo latente en cada uso del módulo órdenes) | [PaymentCard.tsx:78-110](../../src/components/order/PaymentCard.tsx), [OrderCostManagement.tsx:204-238](../../src/components/order/OrderCostManagement.tsx) |
| P0-5 | **Anulación client-side incompleta**: `anular()` revierte por `total_bruto` (aunque lo cobrado fuera parcial), sin transacción, sin `caja_id` (cae en la caja abierta actual vía trigger), y **no revierte cuenta corriente**: un cliente anulado sigue debiendo. | Comprobante `95cbf330` anulado con $13.050 de ingreso sin reversa | [comprobanteService.ts:805-916](../../src/services/comprobanteService.ts) |
| P0-6 | **Eliminar comprobante no repone stock ni CC**: `delete_comprobante_with_finance` borra pagos/FM/BFE/ítems pero no revierte `inventory` ni `account_movements`. Hay **72 borradores con stock ya descontado**: si se eliminan, ese stock desaparece para siempre. | 72 drafts con `stock_processed=true` en Clic | RPC `delete_comprobante_with_finance` |
| P0-7 | **Deuda de proveedores invisible en el Dashboard**: lee `accounts` tipo proveedor (vacía). El ledger real (`supplier_account_movements`) dice $4.562.420. Igual para clientes: `saldo_pendiente` $25.100 vs `accounts` $0. | Query R2b/R3 de conciliación | [useFinancialDashboard.ts:139-145](../../src/hooks/useFinancialDashboard.ts) |
| P0-8 | **`create_owner_withdrawal` no valida pertenencia al negocio**: SECURITY DEFINER, cualquier usuario autenticado puede insertar egresos de caja en cualquier `business_id`. Además no actualiza `personal_account_balances` (multi-moneda) → el ingreso personal no aparece en el resumen de Mi Guita. | Sin check de ownership en el cuerpo de la función | RPC `create_owner_withdrawal` |

### P1 — inconsistencias significativas

| # | Hallazgo | Dónde |
|---|----------|-------|
| P1-1 | **Truncamiento silencioso a 1.000 filas** (límite PostgREST) en agregados hechos en cliente: `financialMetricsService` baja **todos** los `comprobante_items` históricos y filtra en JS; `useFinancialDashboard` suma pagos de 7/30 días sin `range()`. Con >1.000 filas los totales se achican en silencio. | [financialMetricsService.ts:142-158](../../src/services/financialMetricsService.ts), [useFinancialDashboard.ts:113-165](../../src/hooks/useFinancialDashboard.ts) |
| P1-2 | **Borrado libre del ledger desde la UI**: CajaPage permite eliminar cualquier FM (incluso de comprobantes) sin reverso; RLS (`fm_write`/`cp_write`/`bfe_delete` ALL para authenticated) permite DELETE/UPDATE directo de FM, BFE y pagos; `account_movements` tiene policy ALL y el balance solo se recalcula en INSERT → un UPDATE/DELETE corrompe el saldo. | [CajaPage.tsx:480-484](../../src/pages/CajaPage.tsx), policies de `financial_movements`, `business_finance_entries`, `account_movements` |
| P1-3 | **`replace_comprobante_payment` no limpia comisiones**: borra FM/BFE de income pero deja los BFE `comisiones_cobro` del pago original → costos fantasma acumulables. | RPC `replace_comprobante_payment` |
| P1-4 | **Borrar un gasto reversa BFE pero no caja**: `trigger_expense_finance` en DELETE inserta el reverso en BFE y no toca `financial_movements` → caja y P&L divergen con cada gasto borrado. | `trigger_expense_finance` (rama DELETE) |
| P1-5 | **Cobro de cuenta corriente no toca caja**: `registrarPagoCC` acredita el ledger y crea BFE income, pero no crea `financial_movements` → la plata entró al cajón y la sesión de caja no la ve. | [cuentasService.ts:247-275](../../src/services/cuentasService.ts) |
| P1-6 | **Dos sistemas de compras desconectados**: `purchases/purchase_items` (compra rápida, sin CC ni estado de pago) y `supplier_purchases` (módulo proveedores, con ledger). El P&L de Finance.tsx solo compara `supplier_purchases`. | [ModalCrearGasto.tsx](../../src/components/expenses/ModalCrearGasto.tsx), [Finance.tsx:1664-1674](../../src/pages/Finance.tsx) |
| P1-7 | **Sin unicidad de caja abierta**: no existe índice único parcial sobre `cajas(business_id) WHERE status='abierta'`; dos pestañas pueden abrir dos cajas y `trigger_set_movement_caja` reparte los movimientos entre ellas. | DDL de `cajas` |
| P1-8 | **`trigger_payment_creates_movements` convierte USD 1:1**: inserta `amount_ars = amount` con `exchange_rate=1` para pagos de orden en USD. | trigger `trig_payment_movements` |
| P1-9 | **24 movimientos ($3,6M) sin `caja_id`** (fuentes: comprobante, bfe, cobro_rapido, pago_proveedor): registrados sin caja abierta; ninguna sesión los contiene y el arqueo por sesión pierde plata que sí está en el P&L. | Query D2 |
| P1-10 | **`estado_comercial` contradictorio**: 1 comprobante `pagado` sin ningún pago; 1 borrador con `total_cobrado=332.000` sin pagos ni FM ni BFE (datos pre-RPC sin política de migración). | Query R4/D1/D3 |
| P1-11 | **Timezone**: 8 pagos con `date` (UTC) distinto del día argentino de su `created_at`. Todo el frontend mezcla `todayAR()` con `new Date().toISOString()` y la DB usa `CURRENT_DATE` (UTC): ventas post-21:00 caen al día siguiente; cierres de mes desplazados. | Query R15; `registrarPago`, `getPeriodDates`, RPCs |
| P1-12 | **`trigger_comprobante_finance` existe pero no está attachado**: función muerta en DB que, si alguien la conecta, duplicaría todos los ingresos (income al emitir + income por pago). Eliminar o documentar. | baseline línea 5065 |

### P2 — interpretación, UX, cálculos secundarios

| # | Hallazgo | Dónde |
|---|----------|-------|
| P2-1 | "Ventas semana/mes" del Dashboard son **cobros**, no ventas (excluye CC, incluye cobros de ventas viejas) — sin etiqueta que lo aclare. | useFinancialDashboard |
| P2-2 | La UI de "Reversas" filtra `type='income' AND sign=-1`, pero los reversos reales se escriben como `type='expense' sign=-1` → el filtro siempre da vacío y las NC aparecen como "Egresos"; `credit_notes_total` del RPC siempre 0. | FinanceDashboard.tsx + `finance_dashboard_summary` |
| P2-3 | Rotación de inventario siempre 0: `useInventoryFinance` consulta `inventory_movements.inventory_id`, la columna real es `inventory_item_id` (error silenciado). Estados "inmovilizado" no confiables. | [useInventoryFinance.ts:116-120](../../src/hooks/useInventoryFinance.ts) |
| P2-4 | Punto de equilibrio: usa el % de costo variable contaminado por P0-1/P0-2 e incluye costos personales como fijos; el umbral "break_even" ±$500 es arbitrario. | financeService.calculateSummary |
| P2-5 | IVA: `factura_a` suma 21% **sobre** el precio (asume precios netos) sin configuración; factura_c sin discriminar. Sin campo de alícuota por ítem. | comprobanteService.crear |
| P2-6 | `opProfit` solo cuenta comprobantes `issued`, pero 72/174 comprobantes están en `draft` con pagos reales → el "margen de operaciones" ignora el 40% de la operatoria; comisiones filtradas por fecha de pago vs comprobantes por fecha de emisión. | financialMetricsService |
| P2-7 | Métodos de pago incongruentes entre capas: pagos (`tarjeta_debito`, `qr`…) → FM (`efectivo/transferencia/tarjeta/usd`) → BFE (método original) → dashboards con mapas distintos y bucket "otro". `cheque` cae a `efectivo`. | trigger_comprobante_payment_finance + METHOD_META × 3 |
| P2-8 | `generar_numero_comprobante` hace MAX+1 sin lock ni unique → carrera de numeración local posible. | RPC |
| P2-9 | 5 ítems vendidos con `costo_unitario=0` teniendo inventario ($71.190 de venta) → margen sobreestimado; no hay alerta de "costo faltante". | Query M3 |
| P2-10 | `getMovements`/`computeRunningBalance` recalculan saldos en el cliente con otro orden (movement_date vs created_at) → el saldo mostrado puede diferir del `balance_after` persistido. | suppliersService |
| P2-11 | Dif. de cierre de caja USD usa la cotización del momento del cierre, no la de apertura; `difference` mezcla ARS y USD convertido. | CajaPage.handleCloseCaja |
| P2-12 | `owner_withdrawal` FM con `movement_type='income'` y `type='expense'` (metadato contradictorio) y sin `metodo_pago` → cae al bucket "efectivo" por defecto en Caja. | RPC create_owner_withdrawal |

### P3 — claridad, rendimiento, mantenibilidad

- Cuatro páginas de finanzas que compiten (`Dashboard`, `Finance.tsx` "Panel Financiero", `FinanceDashboard.tsx` "Finanzas", `FinanceHealthCheck`), cada una con su propia definición de ingreso/egreso.
- `Finance.tsx` (2.099 líneas) incrusta SQL de creación de tabla en el JSX; `console.log` en servicios (viola regla de logger).
- Caches módulo-level (90s/120s) sin invalidación cross-módulo tras anulaciones/pagos.
- `saleTransactionService` muerto (documentado) y `trigger_comprobante_finance` muerto (no documentado).
- Claves de categoría BFE sin catálogo cerrado (`cobro_cuenta_corriente`, `inventario`, `compras_proveedor` no existen en `ENTRY_TYPES` → labels crudos y buckets invisibles en la distribución).
- Consultas N+1 en conciliaciones de UI (getSuppliersWithStats trae todas las compras por proveedor).
- `decrypt_data`/`encrypt_data` con clave hardcodeada en SQL (fuera de alcance financiero, pero crítico de seguridad).

---

## 3. Conciliaciones ejecutadas — estado actual

Ejecutadas el 2026-07-02 contra el negocio Clic (queries re-ejecutables en [conciliaciones.sql](conciliaciones.sql)):

| # | Conciliación | Resultado | Detalle |
|---|--------------|-----------|---------|
| C1 | Caja inicial + ingresos − egresos = cierre (por sesión, efectivo) | ✅ **PASA** | 0 desvíos > $1 en 38 sesiones cerradas |
| C2 | Ventas pendientes − cobros = deuda de clientes (`accounts`) | ❌ **FALLA** | saldo_pendiente $25.100 vs accounts $0 (ledger CC vacío) |
| C3 | Compras pendientes − pagos = deuda proveedores (ledger) | ✅ **PASA** | $4.562.420 = $4.562.420 |
| C3b | Deuda proveedores visible en Dashboard (`accounts` tipo proveedor) | ❌ **FALLA** | Dashboard muestra $0 |
| C4 | Stock: movimientos ↔ inventario | ⚠️ **PARCIAL** | Sin huérfanos de FK; pero 72 drafts con stock descontado y reposición no garantizada al eliminar |
| C5 | COGS = costo de ítems efectivamente vendidos | ❌ **FALLA** | BFE costos $2,93M vs COGS real $2,26M (+30% doble conteo) |
| C6 | NC/anulaciones revierten la operación original | ❌ **FALLA** | 1 anulado con ingreso $13.050 sin reversa; reversos por total_bruto y no por lo cobrado |
| C7 | Movimientos reversados fuera de agregados | ⚠️ **PARCIAL** | `finance_dashboard_summary` los clasifica como "Egresos"; filtro "Reversas" de la UI vacío |
| C8 | Sin movimientos financieros huérfanos (FK) | ✅ **PASA** | 0 FM/BFE/IM huérfanos |
| C8b | Todo movimiento pertenece a una sesión de caja | ❌ **FALLA** | 24 FM ($3,6M) con caja_id NULL |
| C9 | Trazabilidad operación → origen | ⚠️ **PARCIAL** | Ventas/NC sí; asientos manuales BFE y compras rápidas sin referencia dura |
| C10 | Totales del dashboard reconstruibles desde movimientos | ❌ **FALLA** | BFE income $10,57M ≠ FM income $9,03M ≠ pagos $10,69M |

**Otros datos duros**: 8 pagos con fecha UTC corrida (TZ) · 475 productos USD congelados a TC 1490 (actual 1541) · 5 ítems vendidos sin costo · `total_cobrado` desincronizado en 2 comprobantes pre-RPC.
