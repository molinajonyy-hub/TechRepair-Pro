# Lote 3 — canonical Beta action-authority inventory (before candidate)

Baseline inspected: `origin/main@cb9299652d11cc5b3fd3d595407c1454eb5486e0`.
This inventory was frozen before creating the Lote 3 migrations. Lote 2 tenant
binding is treated as immutable; this lot adds active actor/action authority.

## Existing capability model

`public.current_user_can(text)` is the canonical server evaluator. It resolves
the canonical profile with `COALESCE(user_id, id) = auth.uid()`, rejects an
explicit `is_active = false` (legacy `NULL` remains active), applies the role
default, then applies a partial boolean custom override. Owner keeps the
existing product-wide allow behavior except for `personal_finance`.

| capability | owner | admin | manager | tech | sales | cashier | viewer | current UI/server use |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `finance` | yes | yes | no | no | no | yes | no | `/finance`, `/expenses`, `/caja`, finance RPC callers |
| `comprobantes` | yes | yes | yes | no | yes | yes | no | `/comprobantes`, POS/checkout |
| `inventory` | yes | yes | yes | no | yes | no | no | `/inventory`, `/suppliers` |
| `inventory_view_costs` | yes | yes | yes | no | no | no | no | cost presentation inside inventory |
| `orders` | yes | yes | yes | yes | yes | yes | yes | order/warranty operational reads |
| `orders_create` | yes | yes | yes | yes | yes | yes | no | order/device/document creation |
| `orders_change_status` | yes | yes | yes | yes | yes | yes | no | order workflow mutations |
| `orders_view_financials` | yes | yes | yes | no | yes | yes | no | order/payment amounts |
| `customers` | yes | yes | yes | no | yes | yes | no | `/customers` |
| `users` | yes | yes | yes | no | no | no | no | users UI |
| `settings_sensitive` | yes | yes | no | no | no | no | no | sensitive settings mutations |
| `wholesale` | yes | yes | yes | no | yes | no | no | wholesale surface plus plan feature |
| `personal_finance` | no | no | no | no | no | no | no | Mi Guita; user-scoped opt-in, out of scope |

For every capability above, an explicit override wins over the role default:
default true + `false` denies; default false + `true` allows. No new capability
is introduced by Lote 3.

## Canonical Beta action matrix

| Surface | Action | Current caller | Route/UI guard | DB path | Current server guard | Required capability | Destructive? |
| --- | --- | --- | --- | --- | --- | --- | ---: |
| Dashboard | financial cards | Dashboard queries | `finance` | finance read RPCs/tables | tenant membership | `finance` | no |
| Caja | open session | Caja context | `finance` | `open_cash_session_atomic` | tenant membership | `finance` | yes |
| Caja | close session | Caja context | `finance` | `close_cash_session_atomic` | tenant membership | `finance` | yes |
| Caja | manual movement | Caja context | `finance` | `create_manual_cash_movement_atomic` | tenant membership | `finance` | yes |
| Caja | reverse movement | Caja history | `finance` | `reverse_manual_cash_movement` | tenant membership | `finance` | yes |
| POS | checkout/create comprobante | POS checkout | `comprobantes`; Caja readable for `finance OR comprobantes` | `create_comprobante_checkout_atomic` | tenant membership | `comprobantes` | yes |
| Comprobantes | replace payment | comprobante service/UI | `comprobantes` | `replace_comprobante_payment` | tenant membership | `comprobantes` | yes |
| Comprobantes | credit note draft | comprobante service | `comprobantes` | `create_credit_note_from_comprobante` | tenant membership | `comprobantes` | yes |
| Comprobantes | fiscal credit-note reversal | `afip-cae` after its human authorization | `comprobantes` | `create_credit_note_finance_reversal` | tenant membership or service role | `comprobantes`; retain trusted service role | yes |
| Comprobantes | delete with finance | comprobante service | `comprobantes` | `delete_comprobante_with_finance` | tenant membership | `comprobantes` | yes |
| POS | checkout status | checkout recovery | `comprobantes` | `get_checkout_request_status` | tenant membership | `comprobantes` | no |
| Orders | record payment | legacy order payment callers | financial order UI is `orders_view_financials`; tender actions align with POS | `create_order_payment_atomic` | tenant membership | `comprobantes` | yes |
| Orders | reverse payment | legacy order payment callers | same tender surface | `reverse_order_payment_atomic` | tenant membership | `comprobantes` | yes |
| Expenses | create financial expense | `/expenses` | `finance` | `create_expense_with_finance` | tenant membership | `finance` | yes |
| Expenses | reverse expense | `/expenses` | `finance` | `reverse_operating_expense_atomic` | tenant membership | `finance` | yes |
| Suppliers | create purchase | `/suppliers` | `inventory` | `create_supplier_purchase_atomic` | tenant membership | `inventory` | yes |
| Inventory | quick purchase | `/inventory` | `inventory` | `create_quick_inventory_purchase_atomic` | tenant membership | `inventory` | yes |
| Suppliers | pay linked purchase | `/suppliers` | `inventory` | `pay_supplier_purchase_atomic` | tenant membership | `inventory` | yes |
| Suppliers | free supplier payment | `/suppliers` | `inventory` | `pay_supplier_free_atomic` | tenant membership | `inventory` | yes |
| Currency settings | bulk dollar-price update | settings/inventory pricing | owner/admin UI; sensitive setting | `update_inventory_dollar_prices` | tenant membership | `settings_sensitive` | yes |
| Finance | dashboard summary | `/finance` | `finance` | `finance_dashboard_summary` | tenant membership | `finance` | no |
| Finance | health | `/finance` | `finance` | `finance_health_check`, `finance_health_check_v2` | tenant membership | `finance` | no |
| Finance | insights | `/finance` | `finance` + advanced-finance feature in UI | `generate_finance_insights` | tenant membership | `finance` (feature contract unchanged) | no |
| Finance | pending historicals | finance tooling | `finance` | `finance_pending_historicals` | owner/admin hardcode | `finance` | no |
| Customers | purchase history including totals/payment data | Customer detail | `customers` only before candidate | `customer_purchase_history` | tenant membership | `customers` AND `orders_view_financials` | no |

The product currently has no separate destructive comprobante capability and no
separate supplier-payment capability. The minimum Beta contract therefore keeps
the existing `comprobantes` and `inventory` boundaries. Finer-grained delete,
refund, and supplier-payment capabilities are recorded as post-Beta product
authority debt, not invented here.

## Per-RPC frozen authority matrix

Every function below was already tenant-bound by Lote 2 and had **no**
`current_user_can` call. `legacy/partial` means its body used a mix of
`profiles.user_id`, owner checks, or an active check that was not the canonical
identity contract. The candidate places a canonical gate before the preserved
implementation and before resource locks/effects.

| Function | Current actor/tenant guard | Active membership | UI caller | Required capability | Destructive authority | Fix required |
| --- | --- | --- | --- | --- | ---: | --- |
| `close_cash_session_atomic` | same tenant, actor parameters | partial | Caja | `finance` | yes | canonical wrapper |
| `create_comprobante_checkout_atomic` | same tenant, `user_id` profile | none | POS | `comprobantes` | yes | canonical wrapper |
| `create_credit_note_finance_reversal` | resource tenant; human or service role | none for human | `afip-cae` | `comprobantes` / service role | yes | canonical wrapper, retain service role |
| `create_credit_note_from_comprobante` | resource tenant, `user_id` profile | none | Comprobantes | `comprobantes` | yes | canonical wrapper |
| `create_expense_with_finance` | same tenant | partial | Expenses | `finance` | yes | canonical wrapper |
| `create_manual_cash_movement_atomic` | same tenant | partial | Caja | `finance` | yes | canonical wrapper |
| `create_order_payment_atomic` | same tenant | partial | legacy order tender | `comprobantes` | yes | canonical wrapper |
| `create_quick_inventory_purchase_atomic` | same tenant | partial | Inventory | `inventory` | yes | canonical wrapper |
| `create_supplier_purchase_atomic` | same tenant | partial | Suppliers | `inventory` | yes | canonical wrapper |
| `customer_purchase_history` | requested tenant, `user_id` profile | none | Customer detail | `customers` + `orders_view_financials` | no | combined gate + UI alignment |
| `delete_comprobante_with_finance` | resource tenant, `user_id` profile | none | Comprobantes | `comprobantes` | yes | canonical wrapper before lock |
| `finance_dashboard_summary` | requested tenant, `user_id` profile | none | Finance | `finance` | no | canonical wrapper |
| `finance_health_check` | requested tenant, `user_id` profile | none | Finance | `finance` | no | canonical wrapper |
| `finance_health_check_v2` | requested/current tenant | partial | Finance | `finance` | no | canonical wrapper |
| `finance_pending_historicals` | requested tenant + owner/admin hardcode | partial | Finance | `finance` | no | wrapper + remove internal role hardcode |
| `generate_finance_insights` | canonical tenant membership | yes | Finance | `finance` | no | capability wrapper |
| `get_checkout_request_status` | requested tenant, `user_id` profile | none | POS recovery | `comprobantes` | no | canonical wrapper |
| `open_cash_session_atomic` | same tenant | partial | Caja | `finance` | yes | canonical wrapper |
| `pay_supplier_free_atomic` | same tenant | partial | Suppliers | `inventory` | yes | canonical wrapper |
| `pay_supplier_purchase_atomic` | same tenant | partial | Suppliers | `inventory` | yes | canonical wrapper before lock |
| `replace_comprobante_payment` | same tenant | partial | Comprobantes | `comprobantes` | yes | canonical wrapper before lock |
| `reverse_manual_cash_movement` | resource tenant | partial | Caja | `finance` | yes | canonical wrapper before lock |
| `reverse_operating_expense_atomic` | same tenant/resource | partial | Expenses | `finance` | yes | canonical wrapper before lock |
| `reverse_order_payment_atomic` | same tenant/resource | partial | legacy order tender | `comprobantes` | yes | canonical wrapper before lock |
| `update_inventory_dollar_prices` | same tenant, `user_id` profile | partial | Currency settings | `settings_sensitive` | yes | canonical wrapper |

## `is_staff()` exact meaning and consumer catalog

At baseline, `public.is_staff()` is exactly:

```sql
public.current_user_role() IN
  ('owner','admin','manager','tech','sales','cashier','viewer')
```

`current_user_role()` is canonical and rejects explicit inactive profiles, so
Lote 3 does not redefine `is_staff()`. Direct catalog dependency inspection found
75 policies: 25 SELECT policies and 50 INSERT/UPDATE/DELETE/ALL policies. There
were no non-policy indirect dependencies in `pg_depend`.

| Classification | Tables / baseline policies | `is_staff` role | Candidate action |
| --- | --- | --- | --- |
| MEMBERSHIP_READ | `devices`, `device_inspections`, `documents`, `notes`, `order_checklists`, `order_parts`, `orders`, `parts_used`, `status_history`, operational `tasks*`, `warranties` | active tenant membership | retain for nonsensitive read; task feature remains additive |
| SENSITIVE_READ | `comprobantes`, `expenses`, `inventory`, `inventory_movements`, `order_payments`, `purchase_items`, `purchases`, supplier financial tables, payment commission tables, wholesale tables | membership incorrectly stood in for authority | replace with the existing surface capability where the policy is touched/split |
| WRITE | INSERT/UPDATE policies on `comprobante_items`, `comprobantes`, device/order operational tables, finance/inventory/supplier tables, `notifications`, `tasks*`, `warranties`, `whatsapp_logs` | any active staff including viewer | capability gate or no direct write |
| DELETE | ALL policies on settings/inventory/supplier/task tables plus dedicated task deletes | any active staff including viewer | capability gate; preserve existing stronger `can_manage()` deletes where present |

Direct policy names grouped by surface (each command is inventoried separately
in the generated catalog evidence):

- Comprobantes: `comprobante_items_insert/update`, `comprobantes_insert/update`.
- Order operations: `device_inspections_insert/select/update`,
  `devices_insert/select/update`, `documents_insert/select/update`,
  `notes_insert/select/update`, `order_checklists_insert/select/update`,
  `order_parts_insert/select/update`, `orders_insert/select/update`,
  `parts_used_insert/select/update`, `status_history_insert/select/update`, and
  `order_payments_select`.
- Finance/settings: `rls_drh`, `rls_ec`, `expenses_insert/select`, `rls_pcg`,
  `rls_pco`.
- Inventory/suppliers: `inventory_insert/select/update`,
  `inventory_movements_insert/select`, `product_offers_all`,
  `purchase_items_insert/select/update`, `purchases_insert/select/update`,
  `suppliers_insert/select/update`, `supplier_account_movements_select`,
  `supplier_payments_select`, `supplier_purchase_items_all`, and
  `supplier_purchases_all`.
- Collaboration: `notifications_insert/update`, `task_comments_plan`,
  `task_history_plan`, `task_items_plan`, `tasks_plan_delete/insert/select/update`,
  `warranties_insert/select/update`, `whatsapp_logs_insert/select`.
- Wholesale: the three `wholesale_*_select` policies (feature entitlement plus
  membership at baseline).

`notifications_delete` and `warranties_delete` use `can_manage()` rather than
`is_staff()` and are not counted in the 75. They remain unchanged.

## Direct-write and alternate-path findings

- `payment_transactions`: no Beta caller in `src/`, Edge Functions, scripts, or
  tests. Authenticated nevertheless had INSERT/UPDATE/DELETE plus tenant-only
  `pt_write`; updating `status` to `approved` reached the SECDEF trigger and
  wrote both finance ledgers and the comprobante payment state.
- The trigger is a valid trusted-upstream mechanism; the browser write surface is
  not. Candidate contract: authenticated SELECT only, service-role writes
  retained, history untouched.
- Canonical finance RPCs are the browser ledger writers. The existing finance
  static guard has two documented exceptions: documentary supplier invoices in
  `Expenses.tsx`, and the not-yet-migrated `comprobante_payments` insertion in
  `comprobanteService.ts`. Lote 3 capability-gates their table policies but does
  not mix in an unrelated finance rewrite.
- Inventory/supplier services have direct stock/document CRUD paths. They remain
  direct RLS paths and receive `inventory` authority; the atomic RPCs remain the
  canonical paths for financial purchase/payment effects.
- `whatsapp_logs` is written by the service-role Edge function; no authenticated
  browser insert caller exists. Candidate contract is authenticated SELECT only.

## Authority decisions and bounded debt

1. Order tender creation/reversal uses `comprobantes`, not `orders` (viewer has
   `orders`) and not the read-only `orders_view_financials`. This matches the
   existing POS/tender role set: owner/admin/manager/sales/cashier, excluding
   tech/viewer.
2. Supplier purchase and supplier payment both use `inventory`, because the
   current `/suppliers` product surface does not distinguish them. A dedicated
   payment capability is post-Beta product debt.
3. Task and warranty mutations use `orders_change_status`; generic operational
   reads keep `orders`/membership plus the existing task feature entitlement.
4. Payment-commission configuration and dollar-rate mutation use
   `settings_sensitive`; POS consumption remains readable to `comprobantes`.
5. Customer history requires both customer access and financial-order visibility
   because the response includes totals and payment details; the API is not
   redesigned or partially sanitized in this lot.
