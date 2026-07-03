# Fase 3 — Auditoría de casos extremos

Leyenda: ✅ correcto · ⚠️ parcial/con matices · ❌ incorrecto · Ø no soportado.
Columnas: **P&L** (resultado financiero) · **Caja** · **CC** (cuenta corriente) · **Stock** · **Audit** (trazabilidad) · **Idem** (idempotencia) · **Rev** (reversibilidad) · **Tx** (integridad transaccional).

| Caso | P&L | Caja | CC | Stock | Audit | Idem | Rev | Tx | Notas |
|---|---|---|---|---|---|---|---|---|---|
| Venta cobrada completa | ⚠️ | ✅ | — | ✅ | ✅ | ✅ | ⚠️ | ✅ | RPC atómica + key. P&L: ingreso percibido vs COGS devengado conviven; comisión ok. Reverso solo vía anular (ver abajo) |
| Venta pendiente (sin pago, sin CC) | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ⚠️ | ✅ | P0-3: BFE+FM income por el TOTAL sin plata; además no genera deuda en CC (queda solo en saldo_pendiente) |
| Cobro parcial | ✅ | ✅ | — | ✅ | ✅ | ✅ | ⚠️ | ✅ | sync trigger deja `parcial` correcto |
| Cobro mixto (2+ métodos) | ✅ | ✅ | — | ✅ | ✅ | ✅ | ⚠️ | ✅ | filas CP separadas; bug histórico de rows extra ya corregido con `replace_comprobante_payment` (pero deja comisiones huérfanas P1-3) |
| Venta en cuenta corriente | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ingreso NO se reconoce (bien, cash basis) pero COGS SÍ (mismatch de período); débito CC ok; anulación posterior NO revierte CC (P0-5) |
| Pago posterior de CC | ⚠️ | ❌ | ✅ | — | ⚠️ | ❌ | ⚠️ | ❌ | `registrarPagoCC`: ledger + BFE, sin FM (P1-5); 2 escrituras client-side sin transacción; sin idempotency key; categoría fuera de catálogo |
| Venta anulada (sin CAE) | ⚠️ | ❌ | ❌ | ✅ | ⚠️ | ⚠️ | — | ❌ | reverso por total_bruto (no por lo cobrado), a fecha/caja de HOY, client-side sin tx; CC intacta; guards anti-duplicado existen pero con `maybeSingle` frágil |
| NC total (con CAE) | ✅ | ⚠️ | ❌ | ❌ | ✅ | ✅ | — | ⚠️ | reversa FM/BFE idempotente ✅; stock NO vuelve (decisión no documentada); CC intacta; si ARCA falla queda NC draft sin efecto y original vivo (aceptable pero sin estado visible) |
| NC parcial | Ø | Ø | Ø | Ø | — | — | — | — | `create_credit_note_from_comprobante` copia SIEMPRE todos los ítems por el total |
| Devolución de productos | Ø | Ø | Ø | ⚠️ | — | — | — | — | no hay flujo de devolución sin anular todo; `_revertirStock` existe solo para anulación |
| Reembolso | Ø | Ø | Ø | — | — | — | — | — | no existe egreso tipificado "reembolso"; se haría como movimiento manual de caja sin vínculo |
| Chargeback | Ø | Ø | — | — | — | — | — | — | no existe; MP fuera del POS por diseño |
| Edición de operación histórica | ❌ | ❌ | — | ❌ | ❌ | — | — | ❌ | `actualizarPago` reemplaza pagos a fecha de HOY (cambia el período del ingreso); editar BFE manual reescribe el pasado sin log; no hay período de cierre/lock contable |
| Eliminación de comprobante | ⚠️ | ✅ | ❌ | ❌ | ⚠️ | ✅ | — | ✅ | RPC limpia FM/BFE/pagos/ítems pero NO repone stock (72 drafts en riesgo) ni CC (P0-6); queda solo en logs de la RPC |
| Compra proveedor contado | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | ⚠️ | ✅ | caja/ledger bien; P&L: pago tratado como costo (P0-1); sin idempotency key (doble click → 2 compras, stock duplicado) |
| Compra a CC proveedor | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ⚠️ | ✅ | sin pago → sin BFE (correcto); débito ledger ok |
| Pago parcial a proveedor | ❌ | ✅ | ✅ | — | ✅ | ❌ | Ø | ✅ | valida sobre-pago ✅; P&L P0-1; sin reverso de pagos (no hay "anular pago proveedor") |
| Cancelación de deuda proveedor | ⚠️ | — | ⚠️ | — | ⚠️ | — | — | — | solo vía ajuste manual en `accounts` (tabla equivocada) o pagando; no hay ajuste tipificado en supplier ledger |
| Producto con costo faltante | ❌ | — | — | — | ⚠️ | — | — | — | 5 ítems reales vendidos con costo 0: margen inflado sin alerta (P2-9) |
| Producto dolarizado | ⚠️ | ✅ | — | ✅ | ✅ | — | — | — | snapshot TC por ítem ✅; ficha congelada a TC del alta (1490 vs 1541) → precio de lista viejo (ver 04-monedas) |
| Cambio posterior del dólar | ✅ | — | — | — | ✅ | — | — | — | histórico NO se recalcula (correcto); capital inmovilizado sí queda a TC viejo sin aviso |
| Cambio posterior del precio | ✅ | — | — | — | ✅ | — | — | — | ventas pasadas conservan snapshot ✅; `cost_price` pisado por última compra cambia el "margen actual" mostrado sin marca temporal |
| Reparación interna / orden $0 | ⚠️ | ⚠️ | — | ✅ | ⚠️ | — | — | — | venta $0: pagosEffective crea pago efectivo $0 → FM/BFE de $0 (ruido); repuesto interno descuenta stock por order_items sin costo en P&L |
| Operación en cero | ⚠️ | ⚠️ | — | ✅ | ⚠️ | ✅ | — | ✅ | ídem: asientos de $0 |
| Apertura/cierre de caja | ✅ | ✅ | — | — | ⚠️ | ❌ | ⚠️ | ❌ | conciliación por sesión PASA; pero apertura/cierre client-side sin RPC, sin unique de caja abierta (P1-7), `difference` calculado en cliente, cierre no bloquea movimientos posteriores |
| Movimiento fuera de caja abierta | ❌ | ❌ | — | — | ⚠️ | — | — | — | 24 FM ($3,6M) con caja NULL: existen en P&L, invisibles en arqueos |
| Transferencia entre cuentas/métodos | Ø | Ø | — | — | — | — | — | — | no existe: mover efectivo→banco requiere ingreso+egreso manuales que inflan in/out |
| Aporte del dueño | ⚠️ | ⚠️ | — | — | ❌ | — | — | — | solo como movimiento manual 'income' de caja: se mezcla con ventas en gross_income (distorsiona ingresos operativos) |
| Retiro del dueño (Mi Guita) | ✅ | ✅ | — | — | ✅ | ⚠️ | Ø | ✅ | RPC atómica, no toca P&L (correcto); sin ownership check (P0-8), sin reverso (status 'reversed' existe pero no hay RPC), multi-moneda desync |
| Pago de sueldo al dueño (Panel Financiero) | ❌ | ❌ | — | — | ⚠️ | ❌ | ⚠️ | ❌ | BFE `salary` resta P&L y NO toca caja: exactamente invertido respecto del retiro Mi Guita; doble puerta sin conciliación ($3M reales en Clic) |
| Gasto personal pagado por el negocio | ❌ | ⚠️ | — | — | ⚠️ | — | — | — | `fixed_cost_personal` DENTRO del P&L del negocio; no genera cuenta del socio ni viaja a Mi Guita |
| Reintento por conexión (checkout) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | idempotency key + `get_checkout_request_status`: el caso mejor resuelto del sistema |
| Doble click / envío duplicado | ✅/❌ | ✅/❌ | — | ✅/❌ | — | ✅/❌ | — | — | POS ✅; compras proveedor, gastos, pagos CC, pagos de orden, retiros: ❌ sin key (dependen del disable del botón) |
| Dos operaciones concurrentes | ⚠️ | — | ✅ | ⚠️ | — | — | — | — | CC con FOR UPDATE/advisory ✅; stock con FOR UPDATE solo en checkout RPC (rutas JS `_descontarStock`/ModalCrearGasto sin lock); numeración MAX+1 sin lock (P2-8) |
| Zona horaria Argentina | ❌ | ❌ | ❌ | — | — | — | — | — | 8 pagos ya corridos de día; `CURRENT_DATE` UTC en RPCs; cortes 21:00 (P1-11) |
| Cierre de mes | ❌ | — | — | — | ❌ | — | — | — | no existe cierre/lock: cualquier edición reescribe meses cerrados; reversos caen en el mes actual con descripción del original |
| Cambio de año | ⚠️ | — | — | — | — | — | — | — | numeración local no reinicia por año (solo correlativo por tipo); períodos 'year' hardcoded a año calendario del navegador |
| Datos históricos importados | ❌ | ❌ | ❌ | — | ❌ | — | — | — | evidencia: comprobantes de abril con total_cobrado sin pagos/FM/BFE → los históricos pre-RPC no cumplen los invariantes y ningún proceso los normaliza |

## Los tres patrones que explican casi todo

1. **Escrituras financieras client-side** (anular, pagos CC, compra rápida, pagos de orden, caja) → sin atomicidad, sin idempotencia, sin caja/fecha correcta. Todo lo que pasa por RPC está bien; todo lo que no, está mal.
2. **Reversos que no espejan el asiento original** (por total en vez de por lo cobrado; BFE sin FM; FM sin BFE; comisiones nunca reversadas; CC nunca reversada).
3. **Ausencia de período contable**: sin cierre de mes, sin lock, con `CURRENT_DATE` UTC — el pasado es editable y los reversos contaminan el presente.
