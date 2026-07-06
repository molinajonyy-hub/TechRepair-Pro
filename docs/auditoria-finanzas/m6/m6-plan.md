# M6 — Plan de implementación (Fase 2)

Clasificación de cada flujo y alcance exacto de M6. Basado en [write-surface-map.md](write-surface-map.md).

## Clasificación por flujo

| Flujo | Clase | Acción M6 |
|-------|:-----:|-----------|
| 1. Cobro CC cliente | **B+C** | Nueva RPC `record_customer_account_payment_atomic` (ledger credit + FM income a caja + BFE `cobro_cuenta_corriente`/`revenue_collection_mirror`, idempotente). Rewire `cuentasService.registrarPagoCC`. |
| 9. Apertura de caja | **B+C** | Nueva RPC `open_cash_session_atomic` (ownership, anti-doble-abierta, idempotency key). Rewire `CajaPage.handleOpenCaja`. |
| 10. Cierre de caja | **B** | Nueva RPC `close_cash_session_atomic` (recomputa esperados server-side desde FM, recibe conteo, calcula diferencias, cierra, idempotente). Rewire `CajaPage.handleCloseCaja`. |
| 11/18. Movimiento manual caja | **E** | Reverso ya atómico (`reverse_manual_cash_movement`). Alta: opcional envolver en RPC o mantener con guard RLS de caja cerrada. |
| 6. Edición/borrado de gasto | **B+D** | Nueva RPC `reverse_operating_expense_atomic` (append-only, FM/BFE compensatorio, anti-doble-reverso). Bloquear DELETE directo en `expenses` con efecto económico. |
| 7. Pago de orden (alta) | **E+C** | Rewire UI a `register_order_payment` (o RPC atómica), USD correcto. |
| 8. Eliminación de pago de orden | **B+D** | Nueva RPC `reverse_order_payment_atomic` (compensatorio). Bloquear DELETE directo de `order_payments`. |
| 4. Reverso pago proveedor | **B o D** | Si hay UI de borrado: `reverse_supplier_payment_atomic`; si no: bloquear UPDATE/DELETE y documentar. |
| 14. replace_comprobante_payment | **A→verify** | Verificar/corregir comisiones `payment_fee` huérfanas. |
| RLS/grants | **D** | Fase 9: revocar INSERT/UPDATE/DELETE directo de `authenticated` en las 9 tablas; solo RPCs SECURITY DEFINER. |
| Grep guard | — | Fase 10: test que falla ante escrituras directas nuevas en `src/pages`/`src/components`. |
| 3/12/13/15/16/17. proveedor/owner/anulación/checkout/compra | **A** (±C) | Ya atómicos por Etapa 0/1; a lo sumo agregar idempotencia donde falte. |
| Normalización 45 FM sin caja / 2 comprobantes desync | **F** | Fuera de M6 (M7). |

## Contrato transversal de las RPCs nuevas
`auth.uid()` + pertenencia a negocio + permisos · `SECURITY DEFINER` + `SET search_path=public` · fecha AR (`ar_today()`) · idempotencia por `request_hash` server-side (mismo patrón compra rápida/checkout) cuando el flujo sea repetible · **append-only** (correcciones = asientos compensatorios, nunca DELETE destructivo) · caja cerrada inmutable · retornar IDs creados · nunca contaminar `v_finance_pnl` (cobros/compras/retiros excluidos por `economic_class`).

## Secuencia recomendada de implementación (Commit 2)
1. **Migración A — cobro CC** (`record_customer_account_payment_atomic`) + rewire `cuentasService`/`CuentasCorrientes`.
2. **Migración B — caja** (`open_cash_session_atomic`, `close_cash_session_atomic` + inmutabilidad de caja cerrada) + rewire `CajaPage`.
3. **Migración C — gasto reverso** (`reverse_operating_expense_atomic`) + rewire borrado de gasto.
4. **Migración D — orden** (`reverse_order_payment_atomic` + rewire alta a RPC) + `PaymentCard`/`OrderCostManagement`/`ModalCobro`.
5. **Migración E — proveedor** (reverso o bloqueo) + verificación `replace_comprobante_payment` comisiones.
6. **Migración F — RLS lockdown** (revocar writes directos, verificar triggers SECURITY DEFINER/search_path).
7. **Grep guard** + **suites SQL** (`etapa6_*`) + **rewire frontend** + gates completos.

## Riesgo / orden de despliegue (cuando se apruebe)
- La RLS lockdown (paso 6) es la más peligrosa: debe ir **después** de que TODAS las UIs estén ruteadas por RPC, o romperá flujos en producción. Orden de deploy: migraciones RPC → frontend → RLS lockdown al final, con smoke entre cada uno.
- Todo append-only: ninguna migración recalcula históricos ni borra datos. No se tocan los 45 FM sin caja ni los 2 comprobantes desync (F/M7).

## Nota importante (verificado en Fase 0)
El tag `stable-finance-accounting-model-v1` apunta a `3def653`, **no** al HEAD actual `1b23bc2` (quedaron 2 hotfixes/limpiezas después: `ec63963`, `1b23bc2`). El baseline estable real para M6 es `1b23bc2`.
