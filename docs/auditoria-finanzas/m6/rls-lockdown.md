# M6 · Fase 9 — RLS/grants lockdown final

Migración: `supabase/migrations/20260706180000_m6_rls_lockdown.sql`
Test: `supabase/tests/etapa6_rls_lockdown_test.sql` (39/39 PASS)

## Principio

Toda operación económica entra por una **RPC atómica SECURITY DEFINER** (`SET search_path=public`,
valida `auth.uid()` + pertenencia al `business_id`, idempotente cuando se repite, reverso append-only).
El acceso directo (INSERT/UPDATE/DELETE) a las tablas del libro mayor queda **cerrado por defecto**
(ausencia de policy para ese `cmd` ⇒ RLS lo bloquea). Las RPCs no dependen de estas policies porque
corren como `postgres` (owner) y no están sujetas a RLS.

Se cerraron en esta fase los dos últimos writes client-side migrándolos a RPC:

| Antes (client-side) | Ahora (RPC atómica) |
|---|---|
| `CajaPage.handleAddMovement` → `financial_movements.insert` | `create_manual_cash_movement_atomic` (resuelve caja abierta server-side, idempotente) |
| `suppliersService.createPayment` (pago libre) → `supplier_payments`+`supplier_account_movements`+`business_finance_entries`+`financial_movements` insert | `pay_supplier_free_atomic` (mismos asientos, atómico, idempotente) |

Con esto **`financial_movements` y `business_finance_entries` quedan sin ningún INSERT/UPDATE/DELETE
client-side** → se dropearon sus policies de escritura.

## Matriz de acceso (post-lockdown)

Leyenda: ✅ permitido · ⛔ bloqueado (sin policy) · ⚠️ excepción temporal acotada

| Tabla | SELECT | INSERT | UPDATE | DELETE | Motivo | RPC/flujo permitido | Excepción temporal |
|---|:--:|:--:|:--:|:--:|---|---|---|
| `financial_movements` | ✅ | ⛔ | ⛔ | ⛔ | Libro mayor de caja | `create_manual_cash_movement_atomic`, triggers de cobro/pago, `reverse_manual_cash_movement` | — |
| `business_finance_entries` | ✅ | ⛔ | ⛔ | ⛔ | Libro contable canónico (P&L) | `trg_set_bfe_economic_class` + RPCs; reverso append-only | — |
| `comprobante_payments` | ✅ | ⚠️ | ⛔ | ⛔ | Cobro inicial de venta (POS/checkout) | `replace_comprobante_payment`; alta inicial por `registrarPago` | INSERT propio (WITH CHECK `business_id=current_user_business_id()`) — ver E1 |
| `account_movements` | ✅ | ⚠️ | ⛔ | ⛔ | Ledger CC cliente (aislado, sin FM/BFE/caja) | `record_customer_account_payment_atomic` | INSERT propio (WITH CHECK `current_business_id()=business_id AND is_staff() AND feature currentAccounts`) — ver E2 |
| `supplier_payments` | ✅ | ⛔ | ⛔ | ⛔ | Pagos a proveedor | `pay_supplier_purchase_atomic`, `pay_supplier_free_atomic`, `delete_supplier_purchase_safe` | — |
| `supplier_account_movements` | ✅ | ⛔ | ⛔ | ⛔ | Ledger CC proveedor | mismas RPCs proveedor | — |
| `order_payments` | ✅ | ⛔ | ⛔ | ⛔ | Cobros de orden | `create_order_payment_atomic`, `reverse_order_payment_atomic` | — |
| `expenses` | ✅ | ✅ | ⛔ | ⛔ | Gastos operativos / factura documental | `create_expense_with_finance` (RPC) + alta factura documental; reverso `reverse_operating_expense_atomic` | INSERT acotado por `expenses_insert` (business) — alta legítima |
| `cajas` | ✅ | ⛔ | ⛔ | ⛔ | Sesión de caja | `open_cash_session_atomic`, `close_cash_session_atomic` | — (se reemplazó la policy `ALL` por SELECT) |
| `account_payment_requests` | ✅¹ | ⛔ | ⛔ | ⛔ | Idempotencia cobro CC | insert por RPC | — |
| `cash_session_requests` | ✅¹ | ⛔ | ⛔ | ⛔ | Idempotencia apertura/cierre | insert por RPC | — |
| `order_payment_requests` | ✅¹ | ⛔ | ⛔ | ⛔ | Idempotencia cobro orden | insert por RPC | — |
| `order_payment_reversals` | ✅¹ | ⛔ | ⛔ | ⛔ | Idempotencia reverso orden | insert por RPC | — |
| `operating_expense_reversals` | ✅¹ | ⛔ | ⛔ | ⛔ | Idempotencia reverso gasto | insert por RPC | — |
| `comprobante_payment_replace_requests` | ✅¹ | ⛔ | ⛔ | ⛔ | Idempotencia replace | insert por RPC | — |
| `manual_cash_movement_requests` | ✅¹ | ⛔ | ⛔ | ⛔ | Idempotencia mov. manual (nueva) | insert por RPC | — |
| `supplier_free_payment_requests` | ✅¹ | ⛔ | ⛔ | ⛔ | Idempotencia pago libre (nueva) | insert por RPC | — |

¹ SELECT de request/audit tables acotado al `business_id` propietario (owner o profile del negocio) —
no expone `request_hash` de otros negocios.

## Policies eliminadas / modificadas

**Dropeadas (INSERT client-side ya migrado a RPC):**
- `financial_movements`: `fm_insert`, `financial_movements_business_insert`
- `business_finance_entries`: `bfe_insert`
- `supplier_payments`: `supplier_payments_insert`
- `supplier_account_movements`: `supplier_account_movements_insert`
- `order_payments`: `order_payments_insert`

**Dropeadas (UPDATE/DELETE peligroso, sin flujo vivo que lo use):**
- `business_finance_entries`: `bfe_update_manual`, `bfe_delete_manual` — heredadas del ex-`Finance.tsx`
  (ya borrado). Cerraban el hueco de editar/borrar BFE `source='manual'` directo. Ninguna UI viva las usa.
- `order_payments`: `order_payments_update`
- `expenses`: `expenses_update`, `expenses_delete`

**Reemplazada:**
- `cajas`: `cajas_staff [ALL]` → `cajas_select [SELECT]` (misma condición `current_business_id()=business_id AND is_staff()`).
  Apertura/cierre/movimientos van por RPC.

**Sin cambio (ya eran SELECT-only o SELECT+INSERT acotado):** request tables (SELECT), `comprobante_payments`
(`cp_select`+`cp_insert`), `account_movements` (`account_movements_select`+`account_movements_insert`).

No se usó `GRANT/REVOKE` sobre las tablas (la RLS es la herramienta principal); sólo `REVOKE/GRANT EXECUTE`
sobre las dos RPCs nuevas (patrón estándar: revoke a `public`/`anon`, grant a `authenticated`/`service_role`).

## Funciones/RPCs nuevas

- `create_manual_cash_movement_atomic(p_business_id, p_type, p_method, p_amount, p_description, p_user_id, p_exchange_rate=1, p_idempotency_key=NULL)`
  — resuelve la caja abierta server-side (rechaza si no hay), idempotente, ownership check. Reverso: `reverse_manual_cash_movement` (ya existía).
- `pay_supplier_free_atomic(p_business_id, p_supplier_id, p_user_id, p_supplier_name, p_payment_date, p_amount, p_payment_method, p_notes, p_idempotency_key=NULL)`
  — replica **exactamente** los asientos del flujo anterior (supplier_payment + account_movement 'payment' +
  BFE `variable_cost/compras_proveedor` [clasificado por `trg_set_bfe_economic_class`] + FM `expense/pago_proveedor`
  si el método es cash-like). Atómico (antes, si el FM fallaba, quedaba `supplier_payment` huérfano). Idempotente.

## Excepciones temporales (archivo · línea · motivo)

| # | Flujo | Archivo:línea | Tabla | Por qué se deja | A migrar en |
|---|---|---|---|---|---|
| E1 | Cobro inicial de comprobante | `src/services/comprobanteService.ts:911` (`registrarPago`) | `comprobante_payments` INSERT | Path de POS/checkout/ARCA sensible; el trigger de finanzas crea FM+BFE. Migrar arriesga el flujo central de venta. INSERT acotado por `business_id` propio; UPDATE/DELETE bloqueados; el reemplazo ya va por `replace_comprobante_payment`. | Fase 10/11 |
| E2 | CC manual (pago/deuda/ajuste) | `src/services/cuentasService.ts:150` (`addMovement` ← `CuentasCorrientes.tsx:71-73`) | `account_movements` INSERT | UI activa lo usa. Ledger CC aislado: **no** genera FM/BFE/caja; balance por trigger con `SELECT FOR UPDATE`. INSERT acotado por `current_business_id()+is_staff()+feature currentAccounts`; UPDATE/DELETE bloqueados. | Fase 10/11 |
| E3 | Alta de gasto (factura documental) | `src/pages/Expenses.tsx:421` | `expenses` INSERT | Alta legítima (factura documental / RPC `create_expense_with_finance`). El spec permite mantener INSERT en `expenses`. UPDATE/DELETE bloqueados; reverso por RPC. | — (permitido) |

> Nota (E2/`account_movements`): el caso de test obligatorio #6 pedía "INSERT bloqueado". Se **adaptó** a
> test-de-excepción (INSERT propio OK, cross-tenant bloqueado, UPDATE/DELETE bloqueados) porque la regla del
> spec para `account_movements` es condicional ("si ninguna UI activa lo necesita") y su regla rectora prohíbe
> revocar INSERT donde una UI activa lo requiere salvo migración in-fase. Queda como excepción acotada.

## Grep obligatorio — clasificación

**Writes directos a tablas económicas en `src` (post-rewire):**

| Resultado | Clasificación |
|---|---|
| `financial_movements` insert/update | **eliminado** (CajaPage → RPC; suppliers → RPC; CurrencySettings:152 era falso positivo = `source` de exchange_rates) |
| `business_finance_entries` insert/update/delete | **eliminado** (pago libre → RPC; `financeService.createEntry/updateEntry/deleteEntry` = código muerto removido) |
| `account_movements` insert (`cuentasService.ts:150`) | **permitido temporal** (E2) |
| `comprobante_payments` insert (`comprobanteService.ts:911`) | **permitido temporal** (E1) |
| `expenses` insert (`Expenses.tsx:421`) | **permitido** (E3); `api.ts` expensesService.create/update = código muerto **removido** |
| `order_payments` insert/update/delete | **migrado a RPC** (Fase 6) — 0 en `src` |
| `supplier_payments` / `supplier_account_movements` insert | **migrado a RPC** (`_addAccountMovement`/`_recordPaymentInternal` removidos) |
| `cajas` insert/update | **migrado a RPC** (Fase 4) — 0 en `src` |
| `.delete(` en tablas no-financieras (orders, order_parts, suppliers, inventory, tasks, personal, offers…) | **falso positivo** (fuera del libro mayor M6) |

**Policies `FOR ALL TO authenticated`:**

| Resultado | Clasificación |
|---|---|
| `20260629115920_..._wholesale_rls_hardening.sql` (`clic_wholesale_product_settings`) | **falso positivo** — tabla del portal mayorista, no es libro económico M6 (mayorista fuera de planes) |
| `supabase/_archive/loose-scripts/*` (incluye `cp_all` histórica sobre comprobante_payments) | **falso positivo** — scripts archivados, **no aplicados** a la DB |

Estado vivo verificado (test F9-24): **0 policies `ALL`** en las 9 tablas económicas críticas.
