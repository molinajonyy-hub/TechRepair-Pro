# Fase 2 — Registro formal de fórmulas

Convenciones: **BFE** = `business_finance_entries` · **FM** = `financial_movements` · **CP** = `comprobante_payments` · **CI** = `comprobante_items` · TZ = tratamiento de zona horaria · ⚠️ = riesgo detectado.

Para cada métrica: *cómo se calcula HOY* (código real) y *resultado esperado* (definición contable correcta). "Anulaciones/Devoluciones/Moneda/Impuestos/Parciales" describen el tratamiento actual.

---

### 1. Ventas brutas (devengado)
- **Hoy**: no existe como métrica. Lo más cercano: `finance_dashboard_summary.sales.total_collected` (que en realidad es cobrado) o `opRevenue` (solo `issued`).
- **Esperado**: `Σ CI.subtotal` de comprobantes no anulados del período, por `fecha` AR, antes de descuentos globales, sin NC.
- **Fuente**: CI + comprobantes. **Período**: fecha de emisión. **Anulación**: excluir. **NC**: no restan (van en neta). **Moneda**: `subtotal` ya en ARS con TC de la operación. **Impuestos**: hoy el precio es final (IVA no discriminado salvo factura_a). **Parciales**: no aplica (devengado).
- ⚠️ Riesgo: hoy cada pantalla responde "ventas" con cobros → P2-1.

### 2. Ventas netas
- **Hoy**: no existe. `net_result` del RPC = caja neta, no ventas netas.
- **Esperado**: Ventas brutas − NC del período − descuentos. NC por su monto real (hoy NC siempre es total → parcial imposible, ver P0/roadmap).
- ⚠️ `credit_notes_total` del RPC siempre 0 (clasifica reversos como expense) → P2-2.

### 3. Ingresos devengados
- **Hoy**: BFE income ≈ percibido (por pago), con la excepción P0-3 que devenga el total sin pagos.
- **Esperado**: = Ventas netas (devengado por emisión). Debe salir de CI, nunca de BFE.

### 4. Cobros reales (percibido)
- **Hoy**: `useFinancialDashboard`: `Σ CP.amount_ars` con `date >= hoy-7/30` (UTC), excluyendo `cuenta_corriente`. Sin `range()` → cap 1.000 filas (P1-1). `date` es DATE UTC (P1-11).
- **Esperado**: `Σ CP.amount_ars` del período AR + cobros de CC (`account_movements.credit` tipo 'pago'). Verificado Clic: $10.694.159 histórico.
- **Parciales**: ✅ soportados (N pagos por comprobante). **Mixtos**: ✅ filas separadas.

### 5. Costo de ventas (COGS)
- **Hoy**: BFE `variable_cost` — mezcla `mercaderia` (COGS real, $1,60M), `compras_proveedor` + `repuestos` + `inventario` (pagos de compras, $1,33M) → **doble conteo estructural** (P0-1). COGS devengado al VENDER aunque el ingreso se reconozca al cobrar.
- **Esperado**: `Σ CI.costo_total` de comprobantes no anulados del período = $2.258.003 (Clic, histórico). Compras de stock NUNCA son costo del período; el pago a proveedor NUNCA es costo.
- **Moneda**: `costo_unitario` snapshot ARS ✅. **Anulación**: hoy la anulación no revierte el BFE de costo 'mercaderia' (solo el income) ⚠️. **Costo faltante**: 5 ítems con costo 0 → subestima COGS (P2-9).

### 6. Ganancia bruta
- **Hoy**: `margenBruto = BFE income − BFE variable_cost` (bases mezcladas: ingresos percibidos − costos devengados+compras).
- **Esperado**: Ventas netas − COGS, ambos devengados y del mismo período. La versión percibida (cash) puede existir como métrica separada y rotulada.

### 7. Margen bruto %
- **Hoy**: `margenBruto / ingresos * 100` (contaminado por 5 y 6).
- **Esperado**: Ganancia bruta / Ventas netas. Complementario `opMarginPct` (por ítem) es correcto pero solo cuenta `issued` (excluye 72 drafts con pagos) → P2-6.

### 8. Gastos operativos
- **Hoy**: BFE `fixed_cost_local` ✅ + arrastra `salary` (incluye retiros) y `fixed_cost_personal` en el neto.
- **Esperado**: fijos del local + sueldos de EMPLEADOS + comisiones + variables no-COGS. **Excluir**: retiros del dueño, gastos personales. Sueldo del dueño solo si se define formalmente como gasto (flag explícito).

### 9. Resultado operativo
- **Hoy**: `margenBruto − costosFijosLocal` (Finance.tsx) — hereda todos los errores anteriores.
- **Esperado**: Ganancia bruta − gastos operativos (devengado).

### 10. Resultado de caja / flujo neto
- **Hoy**: `finance_dashboard_summary.net_result = FM income(sign 1) − nc − expenses`; también `caja.net` por sesión. Dos problemas: NC mal clasificadas y FM sin caja_id fuera de sesiones.
- **Esperado**: `Σ FM income − Σ FM expense` del período, TODOS con sesión de caja o cuenta destino, separando: operativo / aportes / retiros / transferencias.

### 11. Deuda de clientes
- **Hoy**: Dashboard = `Σ accounts.balance > 0 (tipo cliente)` → $0. Realidad: `Σ comprobantes.saldo_pendiente` = $25.100 (C2 FALLA).
- **Esperado**: ledger CC como fuente + conciliación `Σ saldo_pendiente = Σ balance` como test.

### 12. Deuda con proveedores
- **Hoy**: Dashboard = `accounts` tipo proveedor → $0. FinanceDashboard = `Σ supplier_purchases.pending_amount` = $4.562.420 ✅ = ledger ✅ (C3 PASA, C3b FALLA).
- **Esperado**: una sola fuente (`supplier_account_movements`) en todas las pantallas.

### 13. Inventario valorizado / 14. Capital inmovilizado
- **Hoy**: `Σ stock_quantity × cost_price` de activos (excluye padres con variantes) — Finance.tsx e `useInventoryFinance` duplican el cálculo. `cost_price` = último costo de compra (valor de reposición aproximado), USD congelado a TC del alta (1490 vs 1541 → −3,3% silencioso).
- **Esperado**: mismo cálculo, pero con política explícita: "valuación a último costo conocido, TC de la ficha" + fecha del TC visible + variante "a TC actual" como comparativo.

### 15. Ticket promedio
- **Hoy**: no existe. **Esperado**: Ventas netas / # comprobantes no anulados (excluir $0 y NC).

### 16. Margen por operación
- **Hoy**: `profitPerOperation = opProfit mensual / totalOrders históricos` (numerador mes, denominador histórico total) → sin sentido dimensional ⚠️.
- **Esperado**: mediana de `(Σ CI.subtotal − Σ CI.costo_total)` por comprobante del período.

### 17. Margen por producto
- **Hoy**: `topProfitableItems` desde `order_parts` con `Math.max(0, …)` (recorta pérdidas → infla) y solo repuestos de órdenes.
- **Esperado**: por `inventory_id` desde CI: `Σ(subtotal − costo_total)`; pérdidas visibles, agrupado por producto, con drill-down.

### 18. Margen por reparación
- **Hoy**: `realProfit*` desde `order_parts` (mismo recorte de pérdidas); no incluye mano de obra ni ítems de comprobante asociados.
- **Esperado**: por orden: cobros de la orden − repuestos consumidos (order_items/order_parts) − costos tercerizados.

### 19. Punto de equilibrio
- **Hoy**: `fijos+sueldos+personales / (1 − %costoVariable)`, con % contaminado (P0-1) y fallback 0.3 arbitrario; incluye vida personal del dueño.
- **Esperado**: gastos fijos del NEGOCIO / (1 − COGS/Ventas netas). Mostrar día del mes en que se alcanzó (necesita serie diaria devengada).

### 20. Cobertura de gastos fijos
- **Hoy**: no existe. **Esperado**: liquidez disponible (caja + cuentas) / gastos fijos mensuales promedio (3-6 meses de BFE fijos). "Podés cubrir X meses".

### 21. Rotación de inventario
- **Hoy**: SIEMPRE 0 — bug de columna (`inventory_id` vs `inventory_item_id`, P2-3).
- **Esperado**: COGS 90d / stock valorizado promedio; por producto: unidades vendidas 90d / stock actual. Marca "sin movimiento en 90d" desde `inventory_movements`.

### 22. Días promedio de cobro (DSO)
- **Hoy**: no existe. **Esperado**: promedio ponderado de `CP.date − comprobantes.fecha` para ventas CC; requiere fechas TZ-correctas.

### 23. Días promedio de pago (DPO)
- **Hoy**: no existe. **Esperado**: `supplier_payments.payment_date − supplier_purchases.purchase_date` ponderado.

### 24. Proyección de caja
- **Hoy**: no existe (Mi Guita tiene `projectionService` personal).
- **Esperado**: caja actual + cobros esperados (CC por vencimiento + promedio diario percibido) − pagos comprometidos (proveedores pendientes + recurrentes por `day_of_month`) a 14/30 días.

### 25. Retiro saludable sugerido
- **Hoy**: no existe.
- **Esperado**: `max(0, min(resultado operativo acumulado − retiros acumulados, caja disponible − colchón))`, colchón = 1 mes de fijos. Requiere P0-2 resuelto (retiros fuera del P&L, medidos desde `owner_withdrawals`).

### 26. Capacidad de reinversión
- **Hoy**: no existe. **Esperado**: caja proyectada a 30d − colchón − compromisos; mostrada junto a capital inmovilizado por categoría.

### 27. Comisiones de cobro
- **Hoy**: BFE `comisiones_cobro` por pago (trigger) ✅ — pero `replace_comprobante_payment` deja huérfanas (P1-3) y `opCommissions` cruza fecha de pago con emisión (P2-6).
- **Esperado**: igual, con limpieza en reemplazo y ventana consistente.

---

## Reglas transversales hoy vs esperado

| Dimensión | Hoy | Esperado |
|---|---|---|
| **Fecha efectiva** | mezcla `created_at` (timestamptz), `fecha` (timestamptz), `date` (DATE UTC), `CURRENT_DATE` (UTC) | una sola: día calendario AR (`America/Argentina/Cordoba`) derivado en DB |
| **Anulaciones** | excluidas de comprobantes por estado; reversos financieros por total_bruto, a fecha de HOY, en caja de HOY | reverso por lo efectivamente cobrado, referenciado a la caja/fecha original o rotulado como ajuste del día |
| **Devoluciones** | NC solo total, sin stock, solo si se emite en ARCA | NC parcial por ítems, con opción de reponer stock, reversa aunque sea local |
| **Impuestos** | IVA 21% sobre-agregado solo factura_a; resto precio final | config explícita "precios con IVA incluido" + alícuota por ítem cuando fiscal |
| **Cobros parciales** | ✅ bien soportados (CP múltiples + sync trigger) | igual |
| **Moneda** | snapshot por ítem ✅; conversión a ARS en el momento; sin ganancia por diferencia de cambio | igual + reporte explícito de exposición USD (ver 04-monedas.md) |
