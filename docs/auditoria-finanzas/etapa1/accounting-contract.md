# Contrato contable formal — Etapa 1

Define cada clase económica que puede tener un movimiento financiero. Es la
referencia normativa: ninguna vista, RPC o métrica puede contradecirla.
La columna `economic_class` de `business_finance_entries` (ver
[legacy-classification.md](legacy-classification.md)) materializa estas clases.

## Tabla conceptual (efecto por eje)
| Clase | P&L | Caja | Posición |
|---|---|---|---|
| `sale_revenue` (venta devengada) | **Sí** (+) | No necesariamente | +CxC / +caja al cobrar |
| `sales_return` (NC / devolución) | **Sí** (−) | − al reintegrar | −CxC / −caja |
| `cogs` (costo de venta) | **Sí** (−) | No | −inventario |
| `operating_expense` (gasto operativo) | **Sí** (−) | Sí o pendiente | −patrimonio |
| `employee_salary` (sueldo empleado) | **Sí** (−) | Sí o deuda salarial | −patrimonio |
| `payment_fee` (comisión de cobro) | **Sí** (−) | Sí | −patrimonio |
| `inventory_purchase` (compra de stock) | **No** | Puede | +inventario / +pasivo |
| `supplier_liability_payment` (pago a proveedor) | **No** | **Sí** | −pasivo |
| `owner_withdrawal` (retiro del dueño) | **No** | **Sí** | −capital |
| `owner_contribution` (aporte del dueño) | **No** | **Sí** | +capital |
| `transfer` (transferencia entre cuentas) | **No** | neutro neto | reubica activo |
| `cash_adjustment` (ajuste/arqueo de caja) | **No** | Sí | ±caja |
| `manual_adjustment` (ajuste contable manual) | Según signo | Puede | ± |
| `legacy_unclassified` (sin evidencia suficiente) | **No** (excluido) | No | marcado como anomalía |

## Especificación por clase

### `sale_revenue`
- **Definición:** ingreso devengado por una venta comercialmente efectiva.
- **Fuente canónica:** `comprobante_items.subtotal` de comprobantes del *conjunto efectivo* (issued OR draft-con-efectos), no anulados, no NC.
- **P&L:** sí (ingreso). **Caja:** no (el cobro es percibido, clase aparte). **Posición:** genera CxC hasta el cobro.
- **Fecha efectiva:** `COALESCE(fecha, date, created_at)` → día AR.
- **Reversos:** una anulación excluye el comprobante del conjunto (deja de sumar). Una NC resta vía `sales_return`.
- **Trazabilidad:** `comprobante_id` + `comprobante_items.id`.
- **NO se usa** BFE `income` para ventas (es espejo de cobros).

### `sales_return`
- **Definición:** reversión de venta (Nota de Crédito emitida o devolución).
- **Fuente:** `comprobantes` tipo `nota_credito` no anulados (por su total) — aplicada UNA vez.
- **P&L:** sí (resta de ventas netas). **Reversos:** la NC ya es el reverso; no se re-revierte.

### `cogs`
- **Definición:** costo de la mercadería efectivamente vendida.
- **Fuente canónica:** `comprobante_items.costo_total` (snapshot) del conjunto efectivo, no anulado, no NC.
- **P&L:** sí (−). **Caja:** no. **Posición:** reduce inventario.
- **Regla dura:** **nunca** usar `inventory.cost_price` actual para ventas históricas; nunca usar BFE `mercaderia`.
- **Reversos:** anular la venta excluye sus ítems → COGS revertido exactamente una vez.

### `operating_expense`
- **Definición:** gasto del negocio que consume resultado (alquiler, servicios, impuestos, publicidad, mantenimiento…).
- **Fuente:** BFE `fixed_cost_local` y variables no-COGS legítimas.
- **Categorías legacy:** `alquiler`, `luz`, `agua`, `gas`, `internet`, `impuestos`, `contador`, `software`, `publicidad`, `limpieza`, `seguridad`, `mantenimiento`, `otros_fijos_local`, `otros`, `envios`, `insumos`, `reparaciones_tercerizadas`, `servicios`.
- **Regla:** afecta P&L y caja (o queda pendiente si es a crédito).

### `employee_salary`
- **Definición:** remuneración de empleados (NO del dueño).
- **Fuente:** BFE `salary` con categoría `sueldo_empleados` / `adelantos` / `bonos` / `comisiones`.
- **P&L:** sí (−). **Distinción crítica:** `sueldo_dueno` NO entra acá → es `owner_withdrawal` salvo flag de sueldo formal.

### `payment_fee`
- **Definición:** comisión cobrada por el medio de pago (tarjeta, MP…).
- **Fuente:** BFE `variable_cost` categoría `comisiones_cobro`.
- **P&L:** sí (−, gasto operativo). **Trazabilidad:** `reference_comprobante_id`.

### `inventory_purchase`
- **Definición:** compra de stock para revender.
- **Fuente:** BFE categorías `inventario`, `repuestos`, `mercaderia` cuando provienen de una compra (no de una venta) — y las compras rápidas.
- **P&L:** **no** (no afecta resultado hasta vender). **Caja:** puede (si se paga). **Posición:** +inventario / +pasivo.
- **Reclasificación:** los BFE `inventario`/`repuestos` de compra rápida y el `mercaderia` sin `reference_comprobante_id` (COGS-mirror histórico) → excluidos del P&L.

### `supplier_liability_payment`
- **Definición:** pago de una deuda a proveedor.
- **Fuente:** BFE categoría `compras_proveedor` (source `pago_proveedor`).
- **P&L:** **no** (reduce pasivo, no es gasto). **Caja:** sí. **Posición:** −pasivo proveedor.
- **Puede conservarse** como asiento técnico trazable siempre que **ninguna métrica de P&L lo consuma**.

### `owner_withdrawal`
- **Definición:** retiro de dinero del negocio hacia el dueño.
- **Fuente canónica:** `owner_withdrawals` (Etapa 0) + BFE `salary/sueldo_dueno` y `salary/retiros` y `fixed_cost_personal` históricos.
- **P&L:** **no**. **Caja:** sí (−). **Posición:** −capital.
- **Dos patas vinculadas:** salida del negocio + ingreso personal (`owner_withdrawals` linkea ambas).

### `owner_contribution`
- **Definición:** aporte de dinero del dueño al negocio.
- **Fuente canónica:** `owner_withdrawals` con signo inverso / RPC `create_owner_contribution` (M4).
- **P&L:** **no** (nunca es venta). **Caja:** sí (+). **Posición:** +capital.

### `transfer`
- **Definición:** movimiento entre cuentas/métodos del mismo negocio (efectivo→banco).
- **P&L:** no. **Caja:** neutro en neto. Hoy no modelado explícitamente (queda `manual_adjustment` si aparece).

### `cash_adjustment`
- **Definición:** ajuste de arqueo / diferencia de caja.
- **Fuente:** FM `source='manual'` de corrección; diferencias de cierre de caja.
- **P&L:** no. **Caja:** sí.

### `manual_adjustment`
- **Definición:** asiento contable manual del usuario en el Panel Financiero.
- **Fuente:** BFE `source='manual'` sin referencia y sin categoría reconocible de otra clase.
- **P&L:** según signo y categoría; se muestra pero se puede auditar.

### `legacy_unclassified`
- **Definición:** BFE histórico sin evidencia suficiente para asignarlo con certeza.
- **P&L:** **excluido** (nunca se suma silenciosamente como gasto ni ingreso válido).
- **Regla:** las vistas lo cuentan aparte y el dashboard muestra una **alerta de calidad** con cantidad y monto. No se adivina por coincidencia de texto.

## Invariantes del contrato (gates)
```
1. Pagar proveedor            → caja − , pasivo − , P&L 0
2. Comprar inventario         → inventario + , (caja − o pasivo +) , P&L 0
3. Vender                     → sale_revenue + , cogs − (una sola vez)
4. Cobrar (percibido)         → caja + , CxC − , P&L 0
5. Retiro del dueño           → caja − , capital − , P&L 0
6. Aporte del dueño           → caja + , capital + , P&L 0 (nunca venta)
7. Sueldo de empleado         → P&L − (sí afecta resultado)
8. Anular venta               → revierte sale_revenue y cogs exactamente una vez
9. Transferencia empresa↔dueño→ una sola fila origen→destino en consolidado
10. legacy_unclassified       → nunca entra al P&L en silencio
```
