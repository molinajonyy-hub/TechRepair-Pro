# M6 — Mapa de superficies de escritura financiera (Fase 1)

Auditoría de todas las escrituras económicas todavía posibles desde `src/` (frontend + servicios), cruzada con el inventario de RPCs existentes en producción (`1b23bc2`). **Documento de diagnóstico — no cambia comportamiento.**

Método: `rg "\.from\('<tabla>')"` sobre `src/` + `pg_proc` (prod) + lectura de los handlers críticos.

Leyenda de clasificación (Fase 2):
`A` ya correcto · `B` necesita RPC nueva · `C` necesita idempotencia · `D` necesita bloqueo RLS · `E` UI debe llamar RPC existente · `F` queda para M7 (requiere normalización histórica).

## RPCs financieras existentes en prod
`create_comprobante_checkout_atomic`, `annul_comprobante_atomic`, `replace_comprobante_payment`, `create_expense_with_finance`, `create_owner_withdrawal`, `create_owner_contribution`, `create_supplier_purchase_atomic` (idempotente), `pay_supplier_purchase_atomic`, `register_order_payment`, `pay_recurring_expense`, `reverse_manual_cash_movement`. Triggers: `trigger_expense_finance` (expenses), `trigger_comprobante_payment_finance`/`_sync` (comprobante_payments), `trig_payment_movements` (order_payments), `trg_set_bfe_economic_class` (BFE), `trig_set_movement_caja` (FM→caja), balance de ledgers cliente/proveedor.

## Tabla de superficies

| # | Flujo | Pantalla/servicio | Escrituras actuales | RPC actual | Atómico | Idempotente | Riesgo | Clase |
|---|-------|-------------------|---------------------|-----------|:------:|:-----------:|--------|:----:|
| 1 | **Cobro CC cliente** | `cuentasService.registrarPagoCC` · `CuentasCorrientes.tsx` | `account_movements` insert (credit) **+** `business_finance_entries` insert (income, `cobro_cuenta_corriente`) client-side | — | ❌ | ❌ | **Alto**: 2 inserts sin transacción; **no crea `financial_movements` → la caja NO sube**; doble-click duplica el cobro | B+C |
| 2 | Pago CC proveedor (fuera del módulo) | — | No existe puerta separada; la deuda proveedor vive en `supplier_account_movements` vía RPCs | pay_supplier_* | ✅ | parcial | Bajo | A |
| 3 | Pago proveedor | `suppliersService.createPurchase`/`pay...` | `supplier_payments`/`supplier_account_movements`/`financial_movements`/`business_finance_entries` (vía RPC atómica; hay fallback client-side en `pay`) | pay_supplier_purchase_atomic | ✅* | ❌ | Medio: falta idempotencia; verificar fallback client-side | C |
| 4 | **Reverso/borrado de pago proveedor** | (a auditar UI) `suppliersService` | posible UPDATE/DELETE directo | — | ❌ | — | **Alto** si hay UI de borrado sin RPC | B **o** D |
| 5 | Gasto operativo (alta) | `Expenses.tsx` (`NewExpenseModal`) | RPC `create_expense_with_finance` (BFE+expense+FM atómico) | create_expense_with_finance | ✅ | ❌ | Bajo (alta); falta idempotencia doble-click | C |
| 6 | **Edición/borrado de gasto** | `Expenses.tsx` (a verificar handler delete) | posible `expenses.delete/update` directo → trigger reverso vs huérfano | — | ❌ | — | **Alto**: DELETE puede dejar FM/BFE asimétricos | B+D |
| 7 | **Pago de orden (alta)** | `PaymentCard.tsx` · `ModalCobro.tsx` | `order_payments.insert` client-side (trigger `trig_payment_movements` crea FM+BFE) | register_order_payment (existe, **no usado por UI**) | ✅* (trigger) | ❌ | Medio: no usa la RPC; **USD** con `exchange_rate` dudoso; no pasa `business_id` | E+C |
| 8 | **Eliminación de pago de orden** | `PaymentCard.handleDelete` | `order_payments.delete().eq('id')` **directo** | — | ❌ | — | **Alto**: reverso depende de trigger BEFORE DELETE (a verificar); si no existe → **FM/BFE huérfanos**; borra sobre caja cerrada | B+D |
| 9 | **Apertura de caja** | `CajaPage.handleOpenCaja` | `cajas.insert({status:'abierta'})` client-side | — | ❌ | ❌ | Medio: índice único evita doble-abierta, pero sin ownership/idempotencia server-side | B+C |
| 10 | **Cierre de caja** | `CajaPage.handleCloseCaja` | `cajas.update({status:'cerrada', difference})` con **esperados y diferencias calculados en el cliente** | — | ❌ | ❌ | **Alto**: cierre definitivo calculado client-side; sin recomputo server-side; sin inmutabilidad post-cierre | B |
| 11 | Movimiento manual de caja (alta) | `CajaPage.handleAddMovement` | `financial_movements.insert({source:'manual'})` client-side | — (reverso: reverse_manual_cash_movement ✅) | ❌ | ❌ | Medio: alta client-side; reverso ya existe atómico | E/B |
| 12 | Retiro del dueño | (`create_owner_withdrawal`) | RPC | create_owner_withdrawal | ✅ | ❌ | Bajo | A/C |
| 13 | Aporte del dueño | (`create_owner_contribution`) | RPC | create_owner_contribution | ✅ | ❌ | Bajo | A/C |
| 14 | Reemplazo de pago de comprobante | `facturacionService`/checkout | RPC `replace_comprobante_payment` | replace_comprobante_payment | ✅* | — | Medio: verificar que no deje **BFE de comisiones huérfanas** | A→verify |
| 15 | Eliminación de comprobante | (guard Etapa 0) | delete guard | annul/delete guard | ✅ | — | Bajo | A |
| 16 | Anulación de comprobante | (`annul_comprobante_atomic`) | RPC | annul_comprobante_atomic | ✅ | ✅ | Bajo | A |
| 17 | Compra de inventario | `suppliersService.createPurchase` · `Expenses` factura | RPC atómica idempotente | create_supplier_purchase_atomic | ✅ | ✅ | Bajo | A |
| 18 | Movimiento manual financiero | ver #11 | `financial_movements.insert` (CajaPage) | — | ❌ | ❌ | Medio | E/B |

`✅*` = atómico vía trigger/RPC pero con caveats a verificar en implementación.

## Hallazgos confirmados (lectura de handlers)
- **#1 CC cobro** (`cuentasService.ts:247-275`): `registrarPagoCC` hace `addMovement`→`account_movements` + `business_finance_entries` insert income; **no inserta `financial_movements`**. Como la caja se computa desde FM, el cobro **no aumenta la caja** ("cobros sin caja") y no es atómico ni idempotente.
- **#9/#10/#11 Caja** (`CajaPage.tsx:385-467`): apertura por `cajas.insert`, cierre por `cajas.update` con `difference` calculado **en el cliente**; movimiento manual por `financial_movements.insert`. Sin RPC, sin recomputo server-side, sin inmutabilidad DB post-cierre.
- **#7/#8 Pago de orden** (`PaymentCard.tsx:79-117`): alta por `order_payments.insert` (trigger `trig_payment_movements`), **borrado por `order_payments.delete()` directo**. La RPC `register_order_payment` existe pero la UI no la usa.

## Pendiente de verificar en implementación (no leído en profundidad aún)
- Handler de borrado/edición de gasto en `Expenses.tsx` (#6).
- ¿Existe trigger `BEFORE DELETE` en `order_payments`/`comprobante_payments`/`expenses` que revierta FM/BFE? (define si #8/#6 dejan huérfanos).
- Fallback client-side en `suppliersService.pay*` (#3) y UI de borrado de pago proveedor (#4).
- Cuerpo de `replace_comprobante_payment` — comisiones `payment_fee` (#14).
- `useRecurringExpenses` BFE inserts (¿vía `pay_recurring_expense`?).
- `comprobanteService.ts:911` `comprobante_payments.insert` (¿parte del checkout atómico o camino paralelo?).
