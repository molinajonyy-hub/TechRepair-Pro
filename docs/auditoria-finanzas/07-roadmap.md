# Propuesta de arquitectura financiera, plan de tests, migraciones y roadmap

## 1. Arquitectura financiera propuesta

### 1.1 Separación de los tres ejes (regla funcional del negocio)

| Eje | Pregunta | Fuente canónica propuesta | Qué se saca de acá |
|---|---|---|---|
| **Rentabilidad** (devengado) | ¿gano o pierdo? | vista `v_finance_pnl` sobre `comprobantes`+`comprobante_items` (ventas netas, COGS) + BFE **solo** gastos operativos del negocio | ventas netas, COGS, margen bruto, gastos operativos, resultado operativo |
| **Flujo de caja** (percibido) | ¿cuánta plata entró/salió? | `financial_movements` con `caja_id` obligatorio para fuentes de caja + tipología cerrada (`operativo/capital/transferencia/ajuste`) | cobros, pagos, aperturas/cierres, diferencias, aportes/retiros |
| **Posición financiera** | ¿qué tengo y qué debo? | caja+cuentas (FM), `inventory` valorizado, ledger CC clientes, ledger proveedores, `owner_withdrawals` | activo, pasivo, capital retirado |

`business_finance_entries` **deja de ser "la fuente única de verdad"** y queda como libro de **gastos operativos + asientos manuales**, con catálogo cerrado de categorías. Ingresos y COGS se derivan SIEMPRE de comprobantes (nunca se re-registran en BFE: se eliminan los inserts de income/mercaderia del trigger de pagos y del checkout, reemplazados por las vistas).

> Alternativa conservadora (si no se quiere tocar el trigger de pagos aún): mantener BFE income como espejo del percibido, pero marcar `source` y **prohibir** que el P&L lo use — el P&L lee la vista. Es el paso intermedio del roadmap.

### 1.2 Vistas canónicas (contrato único para toda la UI)

```
v_finance_pnl(business_id, month)          -- devengado: ventas netas, cogs, margen, gastos op, resultado
v_finance_cashflow(business_id, day)       -- percibido por día AR: in/out por tipo y método
v_finance_position(business_id)            -- caja, inventario valorizado (hist. y reposición), CxC, CxP, retiros acumulados
v_finance_receivables_aging / v_payables_aging
v_finance_product_margin(business_id)      -- por producto desde CI (90d)
v_owner_flows(business_id)                 -- retiros/aportes, dos patas linkeadas
```
Toda pantalla/gráfico consume estas vistas (directo o vía RPC de agregación). Prohibido agregar en JS.

### 1.3 Reglas duras a imponer en DB
1. Reversos espejo: toda anulación/NC revierte **exactamente** los asientos originales (mismos montos, referencia al original, pata de CC incluida) vía RPC `annul_comprobante_atomic`.
2. Una puerta por operación: tabla financiera core sin INSERT/UPDATE/DELETE directo de `authenticated` (solo RPCs SECURITY DEFINER con ownership check + idempotency key).
3. Fecha AR única (`ar_today()`), período de cierre mensual con lock.
4. Retiros/aportes del dueño = movimientos de capital (`v_owner_flows`), jamás en P&L salvo flag "sueldo formal".
5. Caja abierta única (unique parcial) + apertura/cierre por RPC con snapshot de totales esperados.

## 2. Plan de tests

### 2.1 Conciliaciones automatizadas (pgTAP o test runner SQL vía CI; base: [conciliaciones.sql](conciliaciones.sql))
- C1 caja por sesión (ya pasa — mantener como regresión)
- C2 `Σ saldo_pendiente = Σ ledger CC clientes` (hoy falla)
- C3 `Σ supplier pending = Σ ledger proveedor` (pasa)
- C5 `Σ BFE costos != COGS` → tras el fix: `v_finance_pnl.cogs = Σ CI.costo_total`
- C6 anulados/NC: ingreso original + reverso = 0 por comprobante
- C8b FM de fuentes de caja sin `caja_id` = 0
- C10 `v_finance_cashflow` reconstruye `finance_dashboard_summary` al peso
- Invariantes: `total_cobrado = Σ pagos`, `balance_after` recomputable, sin FM/BFE huérfanos (ya cubierto por `finance_health_check` — correr en CI con un negocio semilla)

### 2.2 Unit (Vitest)
- Fórmulas de las vistas espejadas en fixtures (ventas netas, margen, break-even, DSO/DPO, retiro sugerido).
- Motor de explicaciones: cada regla con casos borde (sin datos, división por cero, períodos incompletos).
- Helpers de fecha AR (21:00-00:00, cambio de año, meses de 28/31 días).

### 2.3 E2E (Playwright, ya hay harness)
- Venta cobrada / parcial / CC → verificar los tres ejes en pantalla.
- Anulación y NC → los KPIs vuelven al estado previo.
- Doble click en compra proveedor / gasto / pago CC → un solo asiento.
- Cierre de caja con diferencia → arqueo e historial coherentes.
- Retiro dueño → caja baja, P&L intacto, Mi Guita sube.

## 3. Plan de migraciones (orden de aplicación)

Cada una con rollback documentado, patrón de las migraciones ARCA existentes:

| # | Migración | Contenido | Riesgo |
|---|---|---|---|
| M1 | `finance_hardening_base` | `ar_today()`; unique parcial `cajas(business_id) WHERE status='abierta'`; UNIQUE `comprobantes(business_id, tipo, numero)` (previa dedup — hoy no hay duplicados); índices de agregación; `SET search_path` en RPCs proveedor; ownership check en `create_owner_withdrawal` + update de `personal_account_balances` | bajo |
| M2 | `annul_comprobante_atomic` | RPC de anulación server-side: reverso por lo cobrado, pata CC, stock, comisiones, referencia y caja original; `comprobanteService.anular()` pasa a llamarla | medio |
| M3 | `fix_cost_double_count` | pagos a proveedor dejan de escribir `variable_cost` (pasan a `tipo='pago_pasivo'` fuera del P&L o BFE con type nuevo `debt_payment`); compra rápida: eliminar BFE duplicado (insertar expenses CON `finance_entry_id`); backfill: reclasificar BFE `compras_proveedor/repuestos/inventario` históricos | **alto** (cambia números mostrados — comunicar) |
| M4 | `owner_capital_flows` | quitar `fixed_cost_personal` y `retiros` del P&L (reclasificar como capital); `create_owner_contribution`; flag `owner_salary_is_expense` | alto (ídem) |
| M5 | `canonical_views` | crear `v_finance_*` + RPC agregadora; corregir `finance_dashboard_summary` (NC/reversas, deuda proveedores desde ledger) | bajo |
| M6 | `ledger_lockdown` | revocar UPDATE/DELETE directo de FM/BFE/CP/account_movements; RPCs para pago CC (con FM), delete-movement con reverso, apertura/cierre de caja; fix `delete_comprobante_with_finance` (repone stock+CC) y `replace_comprobante_payment` (comisiones) | medio |
| M7 | `period_locks_and_audit` | `finance_period_locks` + `finance_audit_log` + normalización de históricos pre-RPC (marcar `legacy=true` o corregir los 2 desync) | bajo |
| M8 | `finance_insights` | tabla + `generate_finance_insights()` (reglas Fase 8) | bajo |

## 4. Roadmap de implementación

**Etapa 0 — Estabilizar el piso (M1+M2, ~1 semana)**
Seguridad (P0-8), unicidad de caja, anulación atómica, TZ. Sin cambios visuales. Gate: conciliaciones C1/C6/C8 verdes.

**Etapa 1 — Modelo contable correcto (M3+M4+M5, ~2 semanas)**
Es la etapa que cambia números visibles: doble costo fuera, retiros fuera del P&L, vistas canónicas, deuda de proveedores real en el Dashboard. Incluye banner de release notes para el usuario ("tus márgenes ahora se calculan así"). Gate: C2/C5/C10 verdes + snapshot comparativo antes/después documentado.

**Etapa 2 — Una sola puerta (M6+M7, ~1-2 semanas)**
Lockdown de ledger, RPCs de caja y pagos CC, cierres de período, auditoría. Se eliminan los inserts financieros de PaymentCard/OrderCostManagement/ModalCrearGasto/CajaPage. Gate: grep CI que prohíba `.from('financial_movements').insert` fuera de servicios permitidos (0 ocurrencias en src/components y src/pages).

**Etapa 3 — Nueva experiencia (~2-3 semanas)**
Panel único de 3 niveles ([05-ux-dashboard.md](05-ux-dashboard.md)): Nivel 1 + gráficos 1-5 + Nivel 3 auditable primero; luego 6-10; motor de explicaciones (M8) al final. Retirar Finance.tsx y los KPIs duplicados del Dashboard.

**Etapa 4 — Puente Mi Guita (~1 semana)**
`create_owner_contribution`, retiro sugerido, vista puente (gráfico 12), proyección personal con overlay.

## 5. Archivos concretos a modificar

**SQL (nuevas migraciones)**: las M1-M8 de arriba.

**Servicios**
- `src/services/comprobanteService.ts` — `anular()` → RPC; quitar rama income-sin-pagos del payload cuando se corrija la RPC; `registrarPago` con fecha AR + key.
- `src/services/cuentasService.ts` — `registrarPagoCC` → RPC atómica con FM.
- `src/services/suppliersService.ts` / `purchasesService.ts` — sin BFE variable_cost en pagos; idempotency keys; unificar con `purchases` legacy.
- `src/services/financialMetricsService.ts` — reescribir sobre `v_finance_pnl` (elimina descarga masiva de items).
- `src/services/financeService.ts` — catálogo cerrado; quitar categorías personales/retiros; logger.
- `src/personal/services/personalService.ts` — withdrawal multi-moneda; `deleteTransaction` atómica.

**Hooks**
- `useFinancialDashboard.ts` — leer vistas; deuda proveedores del ledger; quitar "ventas semana/mes".
- `useDashboardStats.ts` — adelgazar a órdenes/clientes; profit desde vistas.
- `useInventoryFinance.ts` — fix `inventory_item_id`; mover cálculo a vista.

**Componentes/páginas**
- `src/pages/FinanceDashboard.tsx` — evoluciona al panel 3 niveles (base a conservar).
- `src/pages/Finance.tsx` — retirar (mover recurrentes a módulo propio; inventario a Inventory).
- `src/pages/CajaPage.tsx` — apertura/cierre por RPC; delete con reverso y solo para `manual`; USD al TC de apertura.
- `src/components/order/PaymentCard.tsx` y `OrderCostManagement.tsx` — eliminar INSERT manual de FM (P0-4); delete de pago por RPC con reverso.
- `src/components/expenses/ModalCrearGasto.tsx` — compra rápida vía `create_supplier_purchase_atomic` (o RPC nueva), un solo asiento.
- `src/pages/CuentasCorrientes.tsx` — conectar al ledger real.
- Nuevos: `src/pages/finance/` (niveles 1-3), `src/components/finance/charts/*`, `src/services/insightsService.ts`.

**Tests**: `tests/unit/financeFormulas.test.ts`, `tests/unit/insightRules.test.ts`, `tests/e2e/finance-panel.spec.ts`, `tests/sql/conciliaciones.sql` (CI).

## 6. Qué NO hacer
- No recalcular históricos con valores actuales (mantener snapshots; los backfills de M3/M4 solo **reclasifican** categorías, nunca montos ni fechas).
- No borrar `business_finance_entries` ni históricos: reclasificar y marcar.
- No construir gráficos nuevos sobre el modelo actual.
- No introducir una segunda librería de charts "mientras tanto".
- No duplicar el flujo de venta: `ComprobanteProModal` sigue siendo el único POS.
