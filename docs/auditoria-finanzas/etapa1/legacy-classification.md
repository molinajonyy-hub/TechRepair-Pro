# Diseño de clasificación BFE — `economic_class`

## Decisión de diseño
Cambio **aditivo**: una columna nueva `business_finance_entries.economic_class`
(text, nullable, con CHECK cerrado) + una función determinística
`bfe_economic_class(type, category, source, reference_comprobante_id)` + un
backfill idempotente. **No** se reutiliza `type` para conceptos incompatibles,
**no** se tocan montos, fechas, `type`, `category` ni `source` históricos.

### Por qué una columna y no reusar `type`
`type` tiene un CHECK productivo (`income/variable_cost/fixed_cost_local/
fixed_cost_personal/salary`) consumido por el trigger de pagos y por servicios.
Cambiarlo rompería inserts existentes. La columna nueva es ortogonal: los
flujos viejos siguen escribiendo `type` como hoy; la clase económica se deriva.

## Valores de `economic_class` (16 = las 14 del contrato + 2 espejos técnicos)
Las 14 clases económicas del [contrato](accounting-contract.md) más dos marcadores
de **espejo técnico** que representan una venta/costo ya contabilizado en su
fuente canónica (comprobante_items) y por eso **se excluyen del P&L**:

```
sale_revenue · sales_return · cogs · operating_expense · employee_salary ·
payment_fee · inventory_purchase · supplier_liability_payment ·
owner_withdrawal · owner_contribution · transfer · cash_adjustment ·
manual_adjustment · legacy_unclassified
+ revenue_collection_mirror   (BFE income espejo de un cobro — no es P&L)
+ cogs_mirror                 (BFE 'mercaderia' — el COGS real vive en items)
```

`revenue_collection_mirror` y `cogs_mirror` mapean conceptualmente a
`sale_revenue`/`cogs` pero marcados como NO-primarios: las vistas canónicas
toman ventas y COGS de `comprobante_items`, nunca de estos espejos, evitando
el doble conteo. Se conservan para trazabilidad/auditoría.

## Regla P&L (cómo las vistas usan la clase)
`v_finance_pnl`:
- **Ventas y COGS** → SIEMPRE de `comprobante_items` (conjunto efectivo). Nunca de BFE.
- **Gastos** → de BFE **solo** `economic_class IN ('operating_expense','payment_fee','employee_salary')`.
- Todo el resto de BFE (mirrors, compras, pagos de pasivo, retiros, aportes, ajustes, legacy) queda **fuera del P&L por construcción**.
- `legacy_unclassified` nunca entra al P&L; se cuenta aparte y dispara alerta de calidad.

## Matriz de reglas (determinísticas, orden de evaluación)
Evaluadas de arriba hacia abajo; primera que matchea gana.

| # | Filtro exacto | economic_class | Confianza |
|---|---|---|---|
| R1 | `type='income' AND (source='comprobante' OR category='cobro_cuenta_corriente' OR (source='manual' AND category='ventas_productos'))` | `revenue_collection_mirror` | alta |
| R2 | `category='comisiones_cobro'` | `payment_fee` | alta |
| R3 | `category='mercaderia'` | `cogs_mirror` | alta |
| R4 | `category IN ('inventario','repuestos','insumos','mercaderia_compra')` | `inventory_purchase` | alta |
| R5 | `category='compras_proveedor' OR source='pago_proveedor'` | `supplier_liability_payment` | alta |
| R6 | `type='salary' AND category IN ('sueldo_dueno','retiros')` | `owner_withdrawal` | alta |
| R7 | `type='salary' AND category IN ('sueldo_empleados','adelantos','bonos','comisiones')` | `employee_salary` | alta |
| R8 | `type='salary'` (resto) | `owner_withdrawal` | media (sin sueldo_empleados explícito → capital por defecto) |
| R9 | `type='fixed_cost_personal'` | `owner_withdrawal` | alta (gasto personal pagado por el negocio = retiro) |
| R10 | `type='fixed_cost_local' AND category IN (<lista opex conocida>)` | `operating_expense` | alta |
| R11 | `type='variable_cost' AND category IN ('envios','reparaciones_tercerizadas','otros_variables')` | `operating_expense` | alta |
| R12 | `type IN ('income') AND source='manual'` (no matcheado antes) | `manual_adjustment` | media |
| R13 | `type IN ('fixed_cost_local','variable_cost') AND (category IS NULL OR category='')` | `legacy_unclassified` | baja |
| R14 | catch-all (nada matcheó) | `legacy_unclassified` | baja |

Lista opex conocida (R10): `alquiler, luz, agua, gas, internet, impuestos,
contador, software, publicidad, publicidad_fija, limpieza, seguridad,
mantenimiento, otros_fijos_local, otros, servicios`.

## Requisitos de seguridad del backfill
- **Preview obligatorio** antes del UPDATE: cantidad y suma por regla/clase (se emite con `RAISE NOTICE`).
- Determinístico: misma entrada → misma clase, siempre.
- **No** cambia montos, fechas, `type`, `category`, `source`, referencias.
- Solo escribe `economic_class` (y `updated_at`). Idempotente (re-ejecutable).
- Los ambiguos (R13/R14) quedan `legacy_unclassified` **marcados**, no adivinados.
- **Rollback:** `UPDATE ... SET economic_class = NULL` + `DROP COLUMN` (documentado en la migración).
- Las vistas NO incluyen `legacy_unclassified` como gasto válido; el dashboard muestra alerta con cantidad y monto.

## Aplicación esperada a Clic (histórico, según baseline)
| economic_class | Filas aprox | Monto ARS | Regla |
|---|---:|---:|---|
| `revenue_collection_mirror` | 187 | 10.876.157 | R1 (181 comprobante + 6 manual) |
| `cogs_mirror` | 47 | 1.684.888 | R3 (44 manual + 3 comprobante) |
| `payment_fee` | 14 | 364.615 | R2 |
| `inventory_purchase` | 3 | 891.141 | R4 (2 inventario + 1 repuestos) |
| `supplier_liability_payment` | 2 | 443.600 | R5 |
| `owner_withdrawal` | 2 | 3.000.000 | R6 (sueldo_dueno) |
| `operating_expense` | 12 | 2.244.800 | R10 (alquiler/impuestos/otros_fijos/otros) |
| `legacy_unclassified` | 0 | 0 | — (Clic no tiene ambiguos) |

**Control de conservación:** ninguna fila se agrega ni borra; la suma de
`amount_ars` de BFE es idéntica antes/después; solo se puebla `economic_class`.
