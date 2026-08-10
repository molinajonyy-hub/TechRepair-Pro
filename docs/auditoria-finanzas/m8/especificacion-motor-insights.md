# M8 — Motor determinístico de insights financieros

**Estado**: especificación cerrada + gate de factibilidad. **Implementación NO iniciada.**
**Rama**: `feat/finance-m8-insights` (creada desde `origin/main` = `1291dd5`).
**Producción**: 214 migraciones, última `20260805120000_notifications_contract.sql`. Sin tocar.

---

## 0. Resumen del gate

| Veredicto | Reglas |
|---|---|
| ✅ Factible sin reservas | `margin_drop_cost`, `withdrawals_vs_profit`, `fx_stale_prices`, `data_quality` |
| 🟡 Factible con reformulación documentada | `cash_down_sales_up`, `dead_stock`, `fixed_coverage`, `breakeven_day`, `cc_aging` |
| 🔴 **BLOQUEADA** | `supplier_crunch` — en su forma especificada |

**Recomendación del gate: BLOQUEADO para las 10 reglas tal como fueron especificadas.**
9 de 10 son implementables (5 requieren reformulación explícita y aprobación).
`supplier_crunch` no lo es sin una decisión de producto o una columna nueva. Detalle en §4.G.

---

## 1. Fuentes canónicas verificadas

Todas las vistas viven en `supabase/migrations/20260704120000_canonical_views.sql`, son
`WITH (security_invoker = true)` y tienen `GRANT SELECT` a `authenticated` + `service_role`.

| Vista | Grano | Columnas relevantes para M8 |
|---|---|---|
| `v_finance_pnl` | (business_id, period_date AR) | `net_sales`, `cogs`, `gross_profit`, `payment_fees`, `operating_expenses`, `employee_salaries`, `operating_result`, `data_quality_flags` |
| `v_finance_cashflow` | 1 fila por `financial_movements` | `movement_date_ar`, `cashflow_class` (`operating`/`capital`/`supplier`/`reversal`/`adjustment`), `net_ars`, `is_reversal`, `payment_method`, `caja_id` |
| `v_finance_receivables_aging` | (business_id, bucket) | `bucket` (`0-7`/`8-30`/`31-60`/`60+`), `amount`, `comprobantes` |
| `v_finance_payables_aging` | (business_id, bucket) | ídem sobre `supplier_purchases.pending_amount` |
| `v_finance_product_margin` | (business_id, inventory_id) | `net_sales`, `cogs`, `margin_pct`, `units`, `missing_cost_count` |
| `v_owner_flows` | 1 fila por `owner_withdrawals` | `flow_type` (`withdrawal`/`contribution`), `status`, `date`, `amount` |
| `v_finance_position` | 1 fila por negocio | `cash_total`, `inventory_at_cost`, `receivables`, `payables`, `owner_*` |
| `v_finance_effective_comprobantes` | 1 fila por comprobante efectivo | `period_date`, `is_credit_note`, `saldo_pendiente`, `customer_id` |

Tablas base adicionales verificadas (todas en `20260628190324_remote_baseline.sql`):

- `recurring_expenses(business_id, name, type, category, amount, currency, day_of_month, is_active)`
  — `day_of_month` con `CHECK (1..28)`. **Única fuente canónica de "gasto fijo".**
- `inventory(..., base_currency, base_price, exchange_rate_used, auto_update_price, linked_to_dolar, price_usd, cost_price_usd, is_active, tipo, stock_quantity, cost_price)`
- `exchange_rates(business_id, base_currency, target_currency, rate, is_manual, source, updated_at)`
- `inventory_movements(business_id, inventory_item_id, movement_type, quantity, created_at, reference_type, reference_id)`
  — `movement_type CHECK IN (in,out,adjustment,order_usage,sale,purchase,return,credit_note,cancellation)`
- `supplier_purchases(business_id, supplier_id, purchase_date, total_amount, paid_amount, pending_amount, payment_status, ...)`
  — **sin columna de vencimiento.**
- `public.ar_today()` → fecha Argentina (`America/Argentina/Cordoba`).

`finance_health_check_v2(p_business_id uuid, p_include_global boolean)` — `plpgsql STABLE SECURITY DEFINER`,
`SET search_path TO 'public'`, `REVOKE ALL FROM PUBLIC`, `REVOKE EXECUTE FROM anon`,
`GRANT EXECUTE TO authenticated, service_role`. Devuelve `jsonb` con
`ok, business_id, checked_at, critical_count, warning_count, low_count, total_issues, checks,
version, overall_status, info_count, pass_count, checks_total, duration_ms, amount_at_risk,
schema_state, semantics`.

> `critical_count` cuenta `status='critical'`, que deriva de `result='fail'`.
> `amount_at_risk` suma `amount_ars` **sólo** de checks con `result='fail'`.
> Es `STABLE`: Postgres impide físicamente que escriba.

---

## 2. Rutas verificadas (destinos permitidos para `action`)

Extraídas de `src/App.tsx`. **Ninguna acción puede apuntar fuera de esta lista.**

`/finance` · `/finance/reports` · `/finance/health` · `/finance/dashboard` · `/inventory` ·
`/suppliers` · `/cuentas` · `/caja` · `/expenses` · `/comprobantes` · `/customers` · `/currency-settings`

No existen rutas de gráficos (`/finance/charts/*`). Las acciones que la especificación original
mandaba a "gráfico 5/6/10" se resuelven en este lote como `drawer:calculation` (Ver cálculo) o
como ruta existente equivalente.

---

## 3. Convenciones transversales

- **Moneda**: todo importe se persiste `numeric` en ARS. El frontend formatea. Nunca texto.
- **Zona horaria**: toda fecha se deriva de `ar_today()` o de las columnas `*_ar` / `period_date`
  de las vistas, que ya aplican `America/Argentina/Cordoba`.
- **Período**: `period_start`/`period_end` son `date` inclusivos. El período de comparación es el
  bloque inmediatamente anterior de la misma longitud, salvo que la regla diga otra cosa.
- **División por cero**: toda razón usa `NULLIF(denominador, 0)`; si el denominador es 0 o NULL la
  regla **no dispara** y se registra `reason_skipped`.
- **Período incompleto**: si `period_end >= ar_today()` el período está en curso; las reglas que
  comparan totales exigen `min_days` (ver cada regla) y rotulan `is_partial_period: true`.
- **Sin datos**: ausencia de datos nunca es un insight. Se omite con `reason_skipped`.
- **Privacidad**: `evidence` **no** puede contener nombres de clientes, emails, teléfonos, SQL,
  tokens ni payloads. Sólo métricas, conteos, ratios e IDs internos cuando sean imprescindibles.

---

## 4. Las 10 reglas

### A. `margin_drop_cost` — ✅ FACTIBLE

- **Pregunta**: ¿el margen cayó *por costo*, no por vender menos?
- **Fuente**: `v_finance_pnl` (`net_sales`, `cogs`, `gross_profit`).
- **Período**: mes actual vs mes anterior completo.
- **Fórmula**:
  - `margin_pct(p) = SUM(gross_profit) / NULLIF(SUM(net_sales),0) * 100`
  - `cogs_ratio(p) = SUM(cogs) / NULLIF(SUM(net_sales),0) * 100`
  - dispara si `margin_pct(actual) - margin_pct(previo) <= -3.0` **Y** `cogs_ratio(actual) - cogs_ratio(previo) >= +1.0`
- **Por qué no confunde volumen con margen**: ambas métricas son *ratios sobre ventas*. Una caída
  de volumen puro deja ambos ratios constantes y no dispara. La segunda condición exige que el
  costo relativo haya subido — que es la causa que el texto afirma.
- **Umbral**: `-3.0 pp` de margen, `+1.0 pp` de COGS/venta.
- **Severidad**: `warning`.
- **Datos mínimos**: `net_sales > 0` en **ambos** períodos.
- **Acción**: `drawer:calculation` (no existe la ficha de producto por margen como ruta).
- **Evidence**: `margin_pct_current`, `margin_pct_previous`, `cogs_ratio_current`, `cogs_ratio_previous`, `net_sales_current`, `net_sales_previous`, `delta_pp`.

### B. `cash_down_sales_up` — 🟡 FACTIBLE CON REFORMULACIÓN

- **Pregunta**: ¿vendí más pero entró menos plata?
- **Fuente**: `v_finance_pnl.net_sales` (devengado) + `v_finance_cashflow` (percibido).
- **Caja operativa** = `SUM(net_ars) WHERE cashflow_class = 'operating' AND is_reversal = false`.
  Se excluyen `capital` (retiros/aportes del dueño), `supplier`, `adjustment` y `reversal`:
  incluirlos haría que un retiro del dueño se leyera como "cayó la caja", que es falso.
- **Fórmula**: dispara si `Δ%(net_sales) >= +10` **Y** `Δ%(caja_operativa) <= -5`.
- **Reformulación necesaria**: la especificación pide `cc_delta` (cuánto quedó en cuenta corriente).
  `v_finance_receivables_aging` **no tiene dimensión temporal histórica** — sólo buckets al día de
  hoy. No hay snapshot de aging por período. Por lo tanto `cc_delta` se calcula directo de
  `comprobantes.saldo_pendiente` de comprobantes efectivos **emitidos dentro de cada período**,
  no del aging. Es una aproximación fiel (deuda originada en el período) pero **no** es
  "variación del saldo de CC", y el texto debe decir exactamente eso.
- **Umbral**: `+10%` ventas, `-5%` caja. **Severidad**: `warning`.
- **Datos mínimos**: ambos períodos con `net_sales > 0` y al menos 1 movimiento operativo.
- **Acción**: `/cuentas`.

### C. `dead_stock` — 🟡 FACTIBLE CON REFORMULACIÓN

- **Pregunta**: ¿cuánto capital está inmovilizado sin rotar?
- **Problema detectado**: `inventory_movements` **no es confiable por sí solo**. Existe
  `repair_missing_stock_movements()` (baseline línea ~4565) precisamente porque hubo
  `comprobante_items` con `stock_processed = false` que nunca escribieron su movimiento.
  Usar sólo movimientos produciría **falsos "muertos"**: productos que sí se vendieron.
- **Reformulación (obligatoria)**: la última salida es el **máximo de dos fuentes**:
  1. `MAX(e.period_date)` de `comprobante_items ci JOIN v_finance_effective_comprobantes e`
     (`e.is_credit_note = false`, `ci.inventory_id = <producto>`) — captura ventas aunque falte el movimiento.
  2. `MAX(created_at AT TIME ZONE 'America/Argentina/Cordoba')::date` de `inventory_movements`
     con `movement_type IN ('sale','out','order_usage')` — captura consumo en órdenes, que
     **no** aparece como `comprobante_items.inventory_id` (ver memoria P0-A: las líneas de orden
     se pliegan en la línea de servicio y nunca llevan `inventory_id`).
  La unión de ambas es estrictamente más segura que cualquiera sola.
- **Universo**: mismo criterio que `v_finance_position.inv` — `is_active = true`,
  `COALESCE(tipo,'product') = 'product'`, excluyendo productos-padre con variantes
  (`NOT EXISTS supplier_code = 'VPREF-' || id`), y `stock_quantity > 0 AND cost_price > 0`.
- **Fórmula**: `dead_value = Σ(stock_quantity × cost_price)` de productos sin salida en 90 días.
  Dispara si `dead_value / NULLIF(inventory_at_cost,0) > 0.20`.
- **Umbral**: `20%` del inventario valorizado. **Severidad**: `warning`.
- **Datos mínimos**: `inventory_at_cost > 0` y al menos 5 productos en el universo.
- **Acción**: `/inventory`. **Evidence**: `dead_value`, `inventory_at_cost`, `dead_pct`, `dead_product_count`, `total_product_count`, `days_threshold: 90`.

### D. `withdrawals_vs_profit` — ✅ FACTIBLE

- **Fuente**: `v_owner_flows` (`flow_type='withdrawal'`, `status='completed'`) vs
  `v_finance_pnl.operating_result`, ambos sobre los **3 meses calendario completos** previos.
- **Confirmado**: los retiros **no** están dentro de `operating_result`. `v_finance_pnl` sólo suma
  `economic_class IN ('payment_fee','operating_expense','employee_salary')`; el capital quedó
  fuera del P&L en la migración `20260704110000_owner_capital_flows.sql`. Por eso comparar
  retiros contra resultado **no** los resta dos veces.
- **Fórmula**: dispara si `operating_result_3m > 0` **Y** `withdrawals_3m / operating_result_3m > 0.70`.
- **Si `operating_result_3m <= 0`**: no dispara esta regla (se omite con
  `reason_skipped='non_positive_result'`) — un ratio contra un denominador negativo no significa nada.
- **Umbral**: `70%`. **Severidad**: `warning`. **Acción**: `drawer:calculation`.

### E. `fixed_coverage` — 🟡 FACTIBLE CON REFORMULACIÓN

- **Problema**: `economic_class='operating_expense'` agrupa **todo** el gasto operativo. No
  distingue fijo de variable. Usarlo entero sería exactamente lo que la especificación prohíbe.
- **Reformulación (obligatoria)**: el gasto fijo se toma de **`recurring_expenses`**
  (`is_active = true`), que es la declaración explícita del dueño de qué es fijo y cuánto.
  `fixed_monthly = SUM(amount)` convertido a ARS. Es la única fuente canónica y no inventa nada.
- **Fórmula**: `coverage_months = v_finance_position.cash_total / NULLIF(fixed_monthly,0)`.
  Dispara si `coverage_months < 1.0`.
- **Datos mínimos**: al menos 1 `recurring_expense` activo. Sin recurrentes cargados la regla se
  omite con `reason_skipped='no_fixed_costs_declared'` — **no** se estima desde el P&L.
- **Umbral**: `< 1 mes`. **Severidad**: `warning` (`critical` si `< 0.5`).
- **Acción**: `/expenses`. **Evidence**: `cash_total`, `fixed_monthly`, `coverage_months`, `recurring_count`.
- **Moneda**: `recurring_expenses.currency` puede ser USD → se convierte con la cotización
  almacenada en `exchange_rates`; si falta cotización, la regla se omite.

### F. `breakeven_day` — 🟡 FACTIBLE CON REFORMULACIÓN

- Hereda la definición de fijo de §E (misma dependencia de `recurring_expenses`).
- **Fórmula**:
  - `contribution_margin_pct = SUM(gross_profit) / NULLIF(SUM(net_sales),0)` del mes en curso.
  - `breakeven_sales = fixed_monthly / NULLIF(contribution_margin_pct,0)`
  - se recorre `v_finance_pnl` por día AR acumulando `net_sales`; el primer día en que el
    acumulado `>= breakeven_sales` es `breakeven_day`.
- **Se rotula SIEMPRE como estimación.**
- **No dispara si**: han pasado `< 10` días del mes; `contribution_margin_pct <= 0`; no hay
  recurrentes declarados; o el día proyectado cae fuera del mes.
- **Severidad**: `info` cuando ya se cruzó (buena noticia). **Acción**: `drawer:calculation`.

### G. `supplier_crunch` — 🔴 BLOQUEADA

- **Especificación**: "compromisos próximos 14 días > caja proyectada" → `critical`.
- **Bloqueo**: `supplier_purchases` **no tiene columna de vencimiento**. Sus columnas son
  `purchase_date, total_amount, paid_amount, pending_amount, payment_status` — ninguna fecha de
  pago comprometida. `v_finance_payables_aging` bucketea por **antigüedad de la compra**, que es
  una medida de *hace cuánto* se compró, **no de cuándo hay que pagar**.
- **Por qué no se puede improvisar**: derivar un vencimiento (p. ej. "purchase_date + 30 días")
  sería exactamente la heurística inventada que la especificación prohíbe, y dispararía
  `critical` — la severidad más alta — sobre un dato que nadie cargó.
- **Qué falta exactamente**: una de estas dos, y es decisión de producto, no técnica:
  1. Columna `supplier_purchases.due_date date NULL` + su carga en la UI de compras; o
  2. Redefinir la regla como **"deuda vencida + fijos del horizonte vs caja"**, usando
     `v_finance_payables_aging` bucket `60+` (deuda inequívocamente vieja) +
     `recurring_expenses` con `day_of_month` dentro de los próximos 14 días, contra
     `v_finance_position.cash_total`. Esto **sí** es computable hoy, pero **ya no es la regla
     especificada** y su texto debe cambiar (no puede decir "vencimientos").
- **Decisión requerida del dueño de producto antes de implementar.** No se implementa por defecto.

### H. `fx_stale_prices` — ✅ FACTIBLE

- **Fuente**: `inventory.exchange_rate_used` (la cotización con la que se fijó el precio) vs
  `exchange_rates.rate` (cotización **almacenada**, con `updated_at`).
- **Sin API externa**: la comparación usa la fila almacenada en `exchange_rates`. El motor nunca
  llama a la red. Si la cotización almacenada tiene `updated_at` más viejo que 7 días, la regla
  se omite (`reason_skipped='stale_reference_rate'`) — comparar contra una referencia vieja
  produciría un insight falso.
- **Universo**: `base_currency = 'USD' AND base_price > 0 AND is_active = true`.
- **Fórmula**: producto desactualizado si
  `exchange_rate_used < current_rate * (1 - 0.02)`.
  Dispara si `stale_count >= 1` y `stale_count / total_usd_products >= 0.10`.
- **Umbral**: `2%` de diferencia de cotización, `10%` del catálogo USD. **Severidad**: `warning`.
- **Acción**: `/currency-settings`. **Evidence**: `stale_count`, `total_usd_products`,
  `avg_rate_used`, `current_rate`, `rate_updated_at`, `diff_pct`.

### I. `data_quality` — ✅ FACTIBLE

- **Fuente**: `finance_health_check_v2(p_business_id, false)` — nunca `true` (los checks globales
  exigen ser owner y exponen configuración de plataforma).
- **Fórmula**: dispara **sólo** si `critical_count > 0`. Severidad `critical` si además
  `amount_at_risk > 0`, si no `warning`.
- **No dispara con el baseline productivo** (`critical_count = 0`, `amount_at_risk = 0`,
  `warning_count = 5`, `low_count = 2`, `overall_status = 'warn'`). Se ignora deliberadamente
  `overall_status`, que hoy vale `warn` por los 5 warnings legacy aceptados: usarlo convertiría
  histórico aceptado en alerta permanente, que es lo que la especificación prohíbe.
- **Los warnings y los low nunca se promueven a critical.** Se persisten en `evidence` como
  contexto informativo, no como disparador.
- **Nota de implementación**: `finance_health_check_v2` es `STABLE SECURITY DEFINER`. Invocarla
  desde `generate_finance_insights` (que debe ser `VOLATILE` para insertar) es válido — una
  función volátil puede llamar a una estable. La inversa no.
- **Acción**: `/finance/health`. **Evidence**: `critical_count`, `amount_at_risk`, `warning_count`,
  `low_count`, `checks_total`, `pass_count`, `overall_status`, `health_version`.

### J. `cc_aging` — 🟡 FACTIBLE CON REFORMULACIÓN

- **Monto vencido**: `v_finance_receivables_aging`, buckets `31-60` + `60+`. Ya excluye anulados
  (pasa por `v_finance_effective_comprobantes`) y exige `customer_id IS NOT NULL`.
- **Concentración**: **no** es derivable de la vista (no tiene dimensión cliente). Se calcula
  directo sobre `comprobantes c JOIN v_finance_effective_comprobantes e`, agrupando por
  `c.customer_id`, con `saldo_pendiente > 0.01` y antigüedad `> 30` días.
  **`evidence` guarda sólo `top_debtor_count` y `top_debtor_share` — nunca nombres ni IDs de clientes.**
- **"Crece" no es computable**: no existe snapshot histórico de aging. La regla se reformula a
  **nivel** (deuda vencida significativa), no a **tendencia**. El texto no puede decir "creció".
- **Fórmula**: dispara si `overdue_30plus > 0` **Y**
  `overdue_30plus / NULLIF(receivables_total,0) >= 0.30`.
- **Umbral**: `30%` de la CxC con más de 30 días. **Severidad**: `warning`.
- **Acción**: `/cuentas`. **Evidence**: `overdue_30plus`, `receivables_total`, `overdue_share`,
  `top_debtor_count`, `top_debtor_share`, `bucket_31_60`, `bucket_60plus`.

---

## 5. Reglas que cambian de texto respecto de la especificación original

| Regla | La especificación decía | Debe decir |
|---|---|---|
| `cash_down_sales_up` | "$X quedaron en cuenta corriente" | "$X de las ventas del período quedaron sin cobrar" |
| `cc_aging` | "deuda >30d **crece**" | "$X de la deuda tiene más de 30 días" (nivel, no tendencia) |
| `breakeven_day` | "Alcanzaste el punto de equilibrio el día 21" | idem + rótulo **estimado** visible |
| `fixed_coverage` | "gastos fijos" (implícito: todo op-ex) | "gastos fijos declarados" (recurrentes) |
| `supplier_crunch` | "vencimientos próximos 14 días" | **bloqueada** — no hay vencimientos cargados |

---

## 6. Qué falta para levantar el gate

1. **Decisión de producto sobre `supplier_crunch`** (§4.G): agregar `due_date` o aceptar la
   redefinición. Sin esto no hay 10 reglas.
2. **Aprobación de las 5 reformulaciones** de §5 — cambian el texto que ve el usuario.

Con esas dos decisiones, el resto de M8 (tabla `finance_insights`, `generate_finance_insights`,
superficie de lectura, RLS, panel, tests, guards) es implementable sin bloqueos conocidos.

---

## 7. Riesgo residual detectado (fuera de alcance de M8, no corregir acá)

- `inventory_movements` tiene cobertura histórica incompleta (existe `repair_missing_stock_movements`).
  M8 lo mitiga uniendo dos fuentes (§4.C) pero **no** lo corrige. No se ejecuta ningún backfill.
- `v_finance_receivables_aging` y `v_finance_payables_aging` no tienen historia: ninguna regla de
  M8 puede hablar de *tendencia* de aging hasta que exista un snapshot.
