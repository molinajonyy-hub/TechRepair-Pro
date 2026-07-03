# Fase 1 — Inventario técnico y mapa del flujo financiero

## 1. Piezas del módulo financiero

### Páginas
| Página | Ruta | Qué muestra | Fuente |
|---|---|---|---|
| `Dashboard.tsx` / `DashboardNew.tsx` | `/` | KPIs generales | `useDashboardStats` + `useFinancialDashboard` |
| `Finance.tsx` (2.099 líneas, "Panel Financiero" / "Análisis P&L") | `/finance/reports` | P&L manual + inventario + recurrentes | `financeService` + `financialMetricsService` + queries inline |
| `FinanceDashboard.tsx` ("Finanzas") | `/finance` | Resumen/Caja/Ventas/Gastos/Movimientos/Auditoría | RPC `finance_dashboard_summary` + FM + `supplier_purchases` |
| `FinanceHealthCheck.tsx` | `/finance/health` | 16 checks de integridad | RPC `finance_health_check` |
| `CajaPage.tsx` | `/caja` | Sesión de caja, arqueo, historial | `cajas` + `financial_movements` (inline) |
| `CuentasCorrientes.tsx` | `/cuentas` | CC clientes/proveedores manual | `cuentasService` (`accounts`/`account_movements`) |
| `Suppliers.tsx` / `Purchases.tsx` | `/suppliers` | Compras, pagos, ledger proveedor | `suppliersService`/`purchasesService` |
| `Expenses.tsx` + `ModalCrearGasto` | `/expenses` | Gastos + compra rápida de inventario | `expenses` + inserts inline |
| `Comprobantes.tsx` + `ComprobanteProModal` | `/comprobantes` | POS / ventas | `comprobanteService` |
| Mi Guita (`src/personal/*`, 23 archivos) | `/personal` | Finanzas personales (identidad Verde) | `personalService` + services propios |
| `OwnerWithdrawal.tsx` (Mi Guita) | `/personal/salary` | Retiro/sueldo del dueño | RPC `create_owner_withdrawal` |

### Hooks financieros
`useFinancialDashboard` (caja activa + cobros 7/30d + CC), `useDashboardStats` (revenue BFE 90d + profit mixto), `useInventoryFinance` (capital inmovilizado, rotación **rota** — columna inexistente), `useRecurringExpenses`, `usePaymentCommissions`, `useCheckoutIdempotency`, `useAutoExchangeRate`.

### Servicios
`comprobanteService` (POS, anulación, NC, pagos), `financeService` (CRUD BFE manual + calculateSummary), `financialMetricsService` (P&L "oficial"), `cuentasService` (CC clientes), `suppliersService`/`purchasesService` (proveedores), `exchangeRateService`/`dollarRateService`/`currencyService` (TC), `personalService` (Mi Guita), `saleTransactionService` (**muerto, no importado**).

### RPCs (server-side, SECURITY DEFINER)
| RPC | Rol | Estado |
|---|---|---|
| `create_comprobante_checkout_atomic` | Venta completa atómica + idempotente | ✅ sólida (ver P0-3) |
| `get_checkout_request_status` | Recuperación post-timeout | ✅ |
| `claim_comprobante_arca_emission` / `complete_arca_attempt` | Lock fiscal por serie | ✅ |
| `create_credit_note_from_comprobante` | NC borrador + copia ítems | ⚠️ NC siempre total; no repone stock |
| `create_credit_note_finance_reversal` | Reversa FM/BFE idempotente de NC | ✅ (solo si NC se emite) |
| `replace_comprobante_payment` | Reemplazo de cobro | ⚠️ deja comisiones huérfanas |
| `delete_comprobante_with_finance` | Borrado con limpieza financiera | ⚠️ no repone stock ni CC |
| `create_supplier_purchase_atomic` / `pay_supplier_purchase_atomic` / `delete_supplier_purchase_safe` | Compras/pagos proveedor | ⚠️ pagos → P&L (P0-1); sin `search_path` en 2 de 3 |
| `create_expense_with_finance` | Gasto triple (BFE+expenses+FM) | ✅ coherente |
| `create_owner_withdrawal` | Retiro dueño (negocio→personal) | ❌ sin check de ownership; no actualiza multi-moneda |
| `finance_dashboard_summary` | Agregados del dashboard Finanzas | ⚠️ clasifica NC como egresos |
| `finance_health_check` | 16 checks de integridad | ✅ gran activo |
| `generar_numero_comprobante` | Numeración local | ⚠️ MAX+1 sin lock |

### Triggers financieros (tabla → función)
| Trigger | Tabla | Efecto | Riesgo |
|---|---|---|---|
| `trig_comprobante_payment_finance` | `comprobante_payments` (INSERT) | Crea FM income + BFE income + BFE comisión (excepto CC) | Solo INSERT: DELETE deja huérfanos |
| `trig_comprobante_payment_sync` | `comprobante_payments` (I/U/D) | Recalcula `total_cobrado/saldo_pendiente/estado_comercial` | ✅ |
| `trig_account_movement_balance` | `account_movements` (BEFORE INSERT) | `balance_after` + `accounts.balance` con FOR UPDATE | Solo INSERT; UPDATE/DELETE corrompen |
| `trig_supplier_account_movement_balance` | `supplier_account_movements` (BEFORE INSERT) | `balance_after` con advisory lock | Orden por `created_at`; recalc de deletes usa `movement_date` |
| `trig_expense_finance` | `expenses` (INSERT/DELETE) | BFE + FM al crear; **solo BFE** al borrar | Asimetría caja/P&L |
| `trig_payment_movements` | `order_payments` (BEFORE INSERT) | FM + BFE income órdenes | USD 1:1; duplica con inserts manuales de la UI |
| `trig_pt_approved` | `payment_transactions` | FM+BFE al aprobar pago MP | Dormido (MP no está en POS) |
| `trig_set_movement_caja` | `financial_movements` (BEFORE INSERT) | Auto-asigna caja abierta si `caja_id` NULL | Asigna movimientos viejos/reversos a la caja de HOY |
| `trigger_comprobante_finance` | **ninguna** | Función huérfana (income al emitir) | Si se conecta → doble ingreso |
| `adjust_stock_on_order_item` / `recalculate_order_total` | `order_items` | Stock y totales de orden | ✅ |
| `sync_inventory_stock_alias` | `inventory` | `stock` ↔ `stock_quantity` | ✅ |
| `set_exchange_rate_on_product_save` | `inventory` | Congela `exchange_rate_used` y deriva `sale_price` | TC por producto queda viejo |

## 2. Mapa de flujo de dinero (quién escribe qué)

```
VENTA POS (ComprobanteProModal / ModalCrearComprobante)
  └─ comprobanteService.crear()
       └─ RPC create_comprobante_checkout_atomic  [1 transacción]
            ├─ comprobantes (total_cobrado=0; el trigger sync lo recalcula)
            ├─ comprobante_items (snapshot precio/costo/TC por línea)
            ├─ inventory ↓stock + inventory_movements ('sale')          [FOR UPDATE]
            ├─ comprobante_payments (solo pagos de caja, no CC)
            │     └─ trig_comprobante_payment_finance
            │          ├─ financial_movements income (metodo mapeado, caja por trigger)
            │          ├─ business_finance_entries income 'ventas_productos'
            │          └─ business_finance_entries variable_cost 'comisiones_cobro'
            ├─ business_finance_entries variable_cost 'mercaderia' (COGS devengado)
            ├─ [si no hay NINGÚN pago] BFE income + FM income por el TOTAL  ← P0-3
            └─ account_movements débito (si hay CC)
                  └─ trig_account_movement_balance → accounts.balance

COBRO CC (ModalPagarCC) → cuentasService.registrarPagoCC
  ├─ account_movements crédito → accounts.balance
  └─ BFE income 'cobro_cuenta_corriente'    ← SIN financial_movements (P1-5)

ANULACIÓN (sin CAE) → comprobanteService.anular()  [CLIENT-SIDE, no atómico]
  ├─ inventory ↑stock + inventory_movements ('return')
  ├─ comprobantes → anulado
  ├─ FM expense sign=-1 por TOTAL_BRUTO (sin caja_id → caja de hoy)
  └─ BFE income negativo por TOTAL_BRUTO   ← no toca CC (P0-5)

NOTA DE CRÉDITO (con CAE) → crearNotaCredito()
  ├─ RPC create_credit_note_from_comprobante (draft + ítems, sin stock)
  ├─ ARCA (claim atómico) → si OK:
  ├─ original → anulado_fiscal
  └─ RPC create_credit_note_finance_reversal (FM sign=-1 + BFE negativo, idempotente)
       ← no repone stock; siempre por el total; nada si la NC no se emite

COMPRA PROVEEDOR → RPC create_supplier_purchase_atomic
  ├─ supplier_purchases + items
  ├─ inventory ↑stock + inventory_movements ('purchase') + cost_price := último costo
  ├─ supplier_account_movements débito (advisory lock)
  └─ [si paga algo] FM expense + BFE variable_cost 'compras_proveedor'  ← P0-1

PAGO PROVEEDOR → RPC pay_supplier_purchase_atomic
  ├─ FM expense + BFE variable_cost 'compras_proveedor'  ← P0-1
  ├─ supplier_payments + supplier_account_movements crédito
  └─ supplier_purchases.paid/pending/status

COMPRA RÁPIDA (Gastos → ModalCrearGasto)  [CLIENT-SIDE, 6 pasos sin transacción]
  ├─ inventory ↑stock (inventoryMovementsService) + cost_price
  ├─ purchases + purchase_items  (sistema paralelo sin CC)
  ├─ BFE variable_cost 'repuestos'
  └─ expenses (sin finance_entry_id)
       └─ trig_expense_finance → OTRO BFE 'mercaderia' + FM expense  ← P0-1 (doble)

GASTO NORMAL → RPC create_expense_with_finance (BFE + expenses + FM, coherente)

PAGO DE ORDEN (PaymentCard / OrderCostManagement)  [CLIENT-SIDE]
  ├─ order_payments → trig_payment_movements → FM income + BFE income
  └─ INSERT manual de OTRO FM income                     ← P0-4 (duplicado)

RETIRO DUEÑO (Mi Guita → OwnerWithdrawal) → RPC create_owner_withdrawal [atómico]
  ├─ personal_transactions income + personal_accounts.current_balance
  │      ← NO actualiza personal_account_balances (multi-moneda)
  ├─ FM expense del negocio (sin BFE → no toca P&L: CORRECTO)
  └─ owner_withdrawals (vínculo auditable las dos puntas)

RETIRO/SUELDO vía Panel Financiero (EntryModal) → financeService.createEntry
  └─ BFE salary/'retiros' o 'sueldo_dueno'  ← resta del P&L y NO toca caja (P0-2)
```

## 3. Matriz de fuentes de verdad

| Concepto | Fuente de verdad REAL hoy | Otras copias que divergen | Fuente única propuesta |
|---|---|---|---|
| Venta (devengado) | `comprobantes` + `comprobante_items` | — | igual |
| Cobro | `comprobante_payments` | BFE income, FM income (derivados que hoy no cierran entre sí) | `comprobante_payments` (+ FM como proyección de caja generada solo por trigger) |
| Caja física | `financial_movements` por `caja_id` | Movimientos con caja NULL quedan fuera | FM con `caja_id NOT NULL` obligatorio para fuentes de caja |
| P&L | `business_finance_entries` (mezcla caja+devengado+capital) | `financialMetricsService` vs `finance_dashboard_summary` vs `calculateSummary` | **Vista SQL** sobre comprobante_items (ingresos/COGS devengados) + BFE solo gastos operativos |
| Deuda clientes | `comprobantes.saldo_pendiente` | `accounts` tipo cliente (vacía) | `account_movements` alimentada SIEMPRE por venta CC + saldo_pendiente como check |
| Deuda proveedores | `supplier_account_movements` (+`supplier_purchases.pending`) | `accounts` tipo proveedor (vacía, la lee el Dashboard) | ledger proveedor; Dashboard debe leerlo |
| Stock | `inventory.stock_quantity` | `inventory_movements` (auditoría) | igual + conciliación periódica |
| Costo del producto | `inventory.cost_price` (pisado por última compra) | `comprobante_items.costo_unitario` (snapshot histórico ✅) | igual, documentando la política |
| TC | `exchange_rates` (scraping blue) | `exchange_rate_used` por producto (congelado) | igual + fecha visible |
| Retiros dueño | `owner_withdrawals` | BFE `salary/retiros` (puerta alternativa inconsistente) | `owner_withdrawals` única puerta |
| Finanzas personales | `personal_transactions` + `personal_account_balances` | `personal_accounts.current_balance` (legacy desync) | `personal_account_balances` |

## 4. Lógica duplicada detectada

1. **Cuatro P&L**: `calculateSummary` (JS), `getFinancialSummary` (JS), `finance_dashboard_summary` (SQL), `useDashboardStats` (JS) — cuatro definiciones de ingreso/egreso.
2. **Tres catálogos de métodos de pago** con mapeos distintos (POS → trigger → CajaPage/Dashboard).
3. **Dos ledgers de CC** (accounts/account_movements vs supplier_account_movements) + una tabla `accounts` compartida que nadie alimenta.
4. **Dos sistemas de compras** (`purchases` vs `supplier_purchases`).
5. **Dos caminos de retiro del dueño** con semánticas opuestas.
6. **Dos rutas de stock por venta** (`_descontarStock` JS para `emitir()` vs SQL en checkout RPC).
7. **Recalculo de saldos** de proveedor en cliente (`computeRunningBalance`) vs trigger.

## 5. Snapshots vs cálculos dinámicos

| Dato | Tipo | Riesgo |
|---|---|---|
| `comprobante_items.costo_unitario/exchange_rate/precio_unitario` | Snapshot ✅ | ninguno — es lo correcto |
| `comprobantes.total_cobrado/saldo_pendiente` | Materializado por trigger | ok mientras nadie escriba pagos sin trigger (datos pre-RPC ya lo violaron) |
| `accounts.balance` / `balance_after` | Materializado por trigger (solo INSERT) | UPDATE/DELETE lo corrompen |
| `inventory.cost_price` | Dinámico (pisado por última compra) | margen "por producto" cambia retroactivamente si se usa cost_price actual |
| `inventory.sale_price` de productos USD | Congelado a `exchange_rate_used` (hoy 1490 vs TC 1541) | precios desactualizados silenciosamente |
| KPIs de dashboards | Dinámicos en JS con caps de 1.000 filas | truncamiento silencioso |

## 6. Zonas de aplicación parcial (operación a medias)

1. `anular()` — 4 escrituras client-side sin transacción (stock ok / update ok / FM falla → estado mixto).
2. `ModalCrearGasto` compra rápida — 6 pasos sin transacción ni rollback.
3. `crearNotaCredito` sin ARCA — NC queda `pendiente_emision` sin reversa financiera ni anulación del original (estado intermedio indefinido).
4. `registrarPagoCC` — ledger sí, caja no.
5. PaymentCard — order_payment ok + FM manual falla (o viceversa) → duplicado o faltante.
6. `createTransaction`/`deleteTransaction` de Mi Guita — insert + RPC de saldo con rollback manual best-effort.
