# Fase 9 — Calidad y seguridad

## RLS y permisos

| Ítem | Estado | Detalle / acción |
|---|---|---|
| Scope por `business_id` | ✅ general | policies presentes en todas las tablas financieras; RLS auto-enable por event trigger |
| Escritura directa del ledger desde el cliente | ❌ | `fm_write` (ALL, authenticated), `cp_write` (ALL), `bfe_insert/update/delete` (public) permiten INSERT/UPDATE/DELETE arbitrario de movimientos, pagos y asientos. La regla "el frontend no inserta movimientos críticos" NO está impuesta por la base. Acción: revocar UPDATE/DELETE (y a término INSERT) a `authenticated` sobre `financial_movements`, `business_finance_entries`, `comprobante_payments`, `account_movements`; canalizar todo por RPC |
| `account_movements` policy ALL + trigger solo BEFORE INSERT | ❌ | un UPDATE/DELETE deja `accounts.balance` y `balance_after` inconsistentes sin recálculo. Acción: bloquear UPDATE/DELETE o trigger de recálculo |
| `create_owner_withdrawal` sin ownership check | ❌ P0-8 | SECURITY DEFINER acepta cualquier `business_id`: cross-tenant write de egresos de caja. Patrón correcto ya existe en `finance_health_check`/`create_credit_note_*` — copiarlo |
| Fuga entre negocios en SELECT | ✅ | no se hallaron SELECT sin filtro de business en código financiero (los hooks siempre filtran) |
| `trigger_comprobante_payment_finance` sin SECURITY DEFINER | ⚠️ | corre como invoker; funciona porque las policies de FM/BFE son laxas — al endurecerlas (arriba) habrá que marcarlo DEFINER |

## SECURITY DEFINER / search_path

- Con `SET search_path`: la mayoría ✅.
- **Sin** `search_path`: `create_supplier_purchase_atomic`, `pay_supplier_purchase_atomic`, `personal_savings_goal_operation` — riesgo clásico de search-path hijacking en DEFINER. Acción: `ALTER FUNCTION … SET search_path = public`.
- `decrypt_data`/`encrypt_data`: clave simétrica hardcodeada en el cuerpo SQL (visible para cualquiera con acceso al catálogo). Fuera del alcance financiero pero crítico: mover a Vault.
- `EXCEPTION WHEN OTHERS RETURN jsonb(error)` en casi todas las RPC: correcto para UX, pero se pierde el stack; loggear con `RAISE LOG` antes de devolver.

## Agregados en el cliente + límite de 1.000 filas

`financialMetricsService` (todos los `comprobante_items` históricos), `useFinancialDashboard` (pagos 7/30d), `useDashboardStats` (BFE 90d), `Finance.tsx` (inventario completo, ~1.444 filas ya roza el cap), `getSuppliersWithStats` (compras embebidas): todos agregan en JS sin `range()` ni `count`. Con crecimiento normal, los KPIs se **truncan en silencio**. Acción: mover agregación a vistas/RPC (ya demostrado viable con `finance_dashboard_summary`).

## Idempotencia y concurrencia

| Flujo | Estado |
|---|---|
| Checkout POS | ✅ ejemplar (unique index como lock, hash de payload, recuperación) |
| Emisión ARCA | ✅ claim por comprobante y por serie fiscal |
| CC clientes / proveedores | ✅ FOR UPDATE / advisory lock |
| Compras, pagos proveedor, gastos, pagos CC, pagos orden, retiros | ❌ sin idempotency key — doble click = doble asiento (el disable del botón es la única barrera) |
| Stock | ⚠️ FOR UPDATE solo en checkout RPC; `_descontarStock` (emitir), `ModalCrearGasto` y `adjust_stock_on_order_item` hacen read-modify-write sin lock; `GREATEST(0, …)` esconde ventas sin stock y fabrica stock al revertir |
| Numeración local | ⚠️ MAX+1 sin lock ni UNIQUE(business_id, tipo, numero) |
| Caja abierta | ❌ sin unique parcial → dos cajas abiertas posibles |

## Redondeos y tipos

- ✅ Todo el dinero es `numeric`; sin `float` en columnas monetarias.
- ⚠️ Redondeo solo en presentación (`Math.round`, `maximumFractionDigits:0`) — correcto; falta regla escrita y helper único (`fmtARS` está duplicado en 4 archivos con variantes).
- ⚠️ Tolerancias mágicas dispersas: `±1` (RPC checkout), `±0.01` (sync trigger, CC), `±500` (status banner). Unificar en constantes documentadas.

## Timezone

- ❌ `CURRENT_DATE`/`toISOString().split('T')[0]` (UTC) conviven con `todayAR()`. Evidencia: 8 pagos con `date` ≠ día AR de su `created_at`. Todas las ventas de 21:00-00:00 caen al día siguiente: series diarias, cortes de mes y aging quedan corridos.
- Acción única: función SQL `ar_today()` (`(now() AT TIME ZONE 'America/Argentina/Cordoba')::date`) + usarla en defaults/RPCs; en front, un solo helper de fecha AR.

## Rendimiento / índices / N+1

- Índices financieros clave presentes (`idx_fm_biz_caja`, `idx_checkout_requests_*`, etc.). Faltantes útiles: `comprobante_payments(business_id, date)`, `business_finance_entries(business_id, type, date)`, `comprobantes(business_id, fecha)` — verificar con `EXPLAIN` al mover agregados a SQL.
- N+1/anchos: `getSuppliersWithStats` (embebe todas las compras), `financialMetricsService` (items completos), `Finance.tsx` (inventario completo dos veces por render de tab).
- Cachés JS módulo-level (90s/120s) sin invalidación tras ventas/anulaciones desde otros módulos → "datos viejos" percibidos como bug.

## Trazabilidad y logs

- ✅ `comprobante_checkout_requests`, `arca_emission_attempts`, `owner_withdrawals` con vínculos duros; `inventory_movements` con previous/new stock.
- ❌ Sin log de auditoría para: ediciones/borrados de BFE manual, borrado de FM desde Caja, cambios de `cost_price`/`sale_price`, cierres de caja. Acción mínima: tabla `finance_audit_log` por trigger en DELETE/UPDATE de FM/BFE.
- ⚠️ `console.log/error` en servicios financieros (viola regla del logger central) — `financialMetricsService`, `useFinancialDashboard`, `saleTransactionService`.

## Recalculo de históricos

- ✅ Ventas: snapshots inmutables (regla cumplida).
- ❌ No hay cierre de período: todo el pasado es editable (BFE update/delete, replace payment a fecha de hoy). Acción: `finance_period_locks(business_id, month, locked_at)` + guard en triggers/RPCs.
- ❌ Datos pre-RPC (abril 2026) violan invariantes actuales (total_cobrado sin pagos) y no hay proceso de normalización marcado (`migrated=true` o corrección puntual).
