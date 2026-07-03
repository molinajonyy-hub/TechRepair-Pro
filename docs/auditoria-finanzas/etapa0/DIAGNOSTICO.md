# Etapa 0 — Fase 0: Diagnóstico previo

Fecha: 2026-07-02. Fuentes: auditoría `docs/auditoria-finanzas/` (sesión previa), baseline `20260628190324`, migraciones `20260701*`, base remota (solo lectura) y código actual.

## 1. Firmas actuales de las RPC afectadas

| RPC | Firma | Versión vigente |
|---|---|---|
| `create_comprobante_checkout_atomic` | `(p_business_id uuid, p_idempotency_key text, p_request_hash text, p_payload jsonb) → jsonb` | **20260701180000** (no la de 170000): resuelve pricing server-side, reserva número atómico (`reserve_comprobante_number`), split `client_request_hash`/`resolved_checkout_hash` |
| `create_owner_withdrawal` | `(p_business_id uuid, p_amount numeric, p_date date, p_account_id uuid, p_notes text DEFAULT NULL) → jsonb` | baseline — **sin check de ownership sobre p_business_id** |
| `delete_comprobante_with_finance` | `(p_comprobante_id uuid) → jsonb` | baseline — borra FM/BFE/pagos/ítems, **no repone stock ni CC** |
| `create_credit_note_from_comprobante` | `(p_comprobante_id uuid) → jsonb` | baseline — NC total, ítems copiados sin stock |
| `create_credit_note_finance_reversal` | `(p_nc_id uuid) → jsonb` | baseline — reversa FM/BFE idempotente, solo NC emitida |
| `replace_comprobante_payment` | `(p_comprobante_id, p_business_id, p_payment_method, p_amount, p_amount_ars, p_currency, p_exchange_rate, p_notes, p_user_id) → jsonb` | baseline — no limpia BFE de comisiones |
| `create_supplier_purchase_atomic` / `pay_supplier_purchase_atomic` | ver baseline | **SECURITY DEFINER sin `SET search_path`** |

## 2. Triggers que se ejecutan indirectamente

- `comprobante_payments` INSERT → `trigger_comprobante_payment_finance` (**SECURITY INVOKER** — crea FM income + BFE income + BFE comisión; hace `UPDATE financial_movements` en la rama de órdenes → al revocar UPDATE a `authenticated` hay que convertirla en DEFINER) y `trigger_comprobante_payment_sync` (DEFINER, recalcula `total_cobrado/saldo_pendiente/estado_comercial` en I/U/D).
- `financial_movements` BEFORE INSERT → `trigger_set_movement_caja` (asigna caja abierta si `caja_id` NULL).
- `account_movements` BEFORE INSERT → `trigger_account_movement_balance` (FOR UPDATE sobre `accounts`, escribe `balance_after` y `accounts.balance`). **Solo INSERT**: UPDATE/DELETE corrompen el saldo — motivo del lockdown.
- `expenses` INSERT/DELETE → `trigger_expense_finance` (DEFINER).
- `order_payments` BEFORE INSERT → `trigger_payment_creates_movements` (DEFINER, crea FM+BFE — **los componentes PaymentCard/OrderCostManagement insertan un SEGUNDO FM manual: duplicación**).
- `comprobantes` BEFORE UPDATE → `update_comprobantes_updated_at`.
- `trigger_comprobante_finance` existe como función pero **no está attachada** (no interfiere).

## 3. Tablas y columnas que participan

`comprobantes` (estado/status/estado_comercial/estado_fiscal/cae/numero_fiscal/total_bruto/total_cobrado/saldo_pendiente/numero_secuencial), `comprobante_items` (stock_processed/stock_movement_id/costo_total/list_price_ars), `comprobante_payments` (amount_ars/commission_amount/date DATE), `financial_movements` (type/sign/source/source_id/reference_type/reference_id/comprobante_id/caja_id/metodo_pago/date DATE), `business_finance_entries` (type/category/source **DEFAULT 'manual'**/reference_comprobante_id/date DATE), `accounts`+`account_movements` (debit/credit/balance_after/reference_type/reference_id), `inventory`+`inventory_movements` (**columna `inventory_item_id`**), `cajas` (status 'abierta'/'cerrada', *_inicial/*_cierre/difference), `owner_withdrawals`, `personal_accounts`+`personal_account_balances`+`personal_transactions`, `comprobante_checkout_requests`, `comprobante_number_sequences`.

Hallazgo nuevo (durante este diagnóstico): `business_finance_entries.source` tiene DEFAULT `'manual'` → el BFE de costo del checkout queda `source='manual'` sin referencia, indistinguible de un asiento manual. Y `cuentasService.registrarPagoCC` inserta una columna **inexistente** (`caja_id`) en BFE con el error silenciado → **el BFE de cobros CC nunca se crea** (la única pata que se escribe es el ledger).

## 4. RLS y permisos actuales (ledgers)

| Tabla | Policies | Efecto |
|---|---|---|
| `financial_movements` | `fm_write` ALL (authenticated, scope negocio) + insert/select/update públicas por perfil | cliente puede INSERT/UPDATE/**DELETE** cualquier FM de su negocio |
| `business_finance_entries` | `bfe_select/insert/update/delete` (scope negocio) | CRUD completo desde cliente, sin distinguir manual/automático |
| `comprobante_payments` | `cp_select` + `cp_write` ALL | cliente puede borrar/editar pagos procesados |
| `account_movements` | `account_movements_plan` ALL (`current_business_id()` + `is_staff()` + feature `currentAccounts`) | UPDATE/DELETE posibles sin recálculo de balance |
| `cajas` | `cajas_staff` ALL | apertura/cierre/edición libre (sin unique de abierta) |
| `owner_withdrawals` | `owner_withdrawals_own` (user_id) | ok |

## 5. Cajas abiertas/cerradas

`cajas.status IN ('abierta','cerrada')`; "caja actual" = última `abierta` por `opened_at DESC` (CajaContext y `trigger_set_movement_caja`). **No hay unique parcial** → dos abiertas posibles; el trigger elegiría la más nueva. Cierre: UPDATE client-side con `*_cierre` y `difference` calculada en el navegador. Movimientos con `caja_id` NULL (24 en prod) quedan fuera de toda sesión.

## 6. Relación FM ↔ BFE ↔ pagos ↔ CC ↔ stock ↔ comprobante

```
comprobante ──1:N── comprobante_items ──(stock_processed/stock_movement_id)──> inventory_movements → inventory
     │
     ├─1:N─ comprobante_payments ──trigger──> FM income (comprobante_id, source='comprobante')
     │                              └───────> BFE income (reference_comprobante_id) + BFE comisión
     ├─ checkout RPC ─> BFE costo 'mercaderia' (HOY: source='manual', SIN reference — se corrige acá)
     ├─ (cc_total>0) ─> account_movements débito (reference_type='comprobante') → accounts.balance
     └─ comprobante_checkout_requests (idempotencia) / arca_emission_attempts (fiscal)
```
Reversos hoy: `anular()` **client-side** (FM sign=-1 por total_bruto + BFE negativo, sin CC, sin caja original); NC vía `create_credit_note_finance_reversal` (por total, sin stock).

## 7. Diferencias conceptuales (guían los modos de la nueva RPC)

| Operación | Qué es | Efecto correcto |
|---|---|---|
| **Anulación comercial** | la operación no debió existir; no hubo plata o la plata nunca entró (CC/pendiente) | revertir deuda CC + COGS + stock (si volvió); **sin** movimiento de caja |
| **Devolución de dinero** | la venta existió y se devuelve el cobro | egreso en la **caja actual** por lo efectivamente cobrado, espejando cada FM original; caja cerrada original intacta |
| **Void misma sesión** | error inmediato dentro de la misma caja abierta | compensación dentro de la misma sesión, con trazabilidad |
| **Nota de crédito fiscal** | comprobante con CAE: la anulación es un documento fiscal | fuera de esta RPC — flujo `crearNotaCredito` (se rechaza con mensaje) |
| **Cancelación de deuda** | condonar/ajustar CC sin tocar la venta | ajuste en ledger CC (flujo existente `cuentasService.addAdjustment`) |
| **Borrado de borrador** | el documento nunca tuvo efectos | permitido **solo** si no hay stock/pagos/FM/BFE/CC/fiscal (Fase 5) |

## 8. Riesgos de compatibilidad (medidos contra producción)

1. **Invariante de cobro**: el POS hoy permite confirmar con saldo>0 sin CC. Impacto real: **1 caso en 90 días** (parcial sin CC) + 46 `pendiente` (mayoría CC-total, que el invariante permite). Mitigación: error funcional con importes; el botón CC ya existe en ambos modales.
2. **NC por POS**: `TIPO_CONFIG` incluye `nota_credito` (1 caso real con `comprobante_original_id` NULL) → la NC queda **exenta** del invariante y sin efectos de ingreso/stock; no se rechaza el tipo.
3. **Pagos con recargo/vuelto**: el guard superior (cash+cc ≤ total+1) ya existe en prod → no se endurece; solo se agrega el piso.
4. **Idempotencia checkout**: se preservan intactos el flujo de `comprobante_checkout_requests`, hashes y recuperación; los cambios son internos al bloque de trabajo (validaciones + fechas + eliminación de la rama income-sin-pagos).
5. **ARCA**: `_claimYEmitirArca`/`claim_comprobante_arca_emission`/`complete_arca_attempt` no se tocan; la nueva anulación **rechaza** comprobantes con CAE/numero_fiscal/estado emitido.
6. **Revocar UPDATE/DELETE en FM** rompería `trigger_comprobante_payment_finance` (invoker hace UPDATE en la rama órdenes) → se convierte a SECURITY DEFINER con `search_path` en la misma migración.
7. **Numeración local**: ya resuelta por `20260701180000` (contador + UNIQUE parcial `(business_id, tipo, numero_secuencial)`); la serie real local es `(business_id, tipo)` — `punto_venta` es solo formato. **No se agrega otra constraint** (una sobre `numero` crudo podría chocar con históricos con formato libre).
8. **`registrarPagoCC` roto** (columna inexistente): no se arregla en Etapa 0 (es M6 — pago CC por RPC con FM); documentado como caso no resuelto.
