# Fases 6-8 — Auditoría UX del dashboard, propuesta de experiencia y motor de explicaciones

## Fase 6 — Auditoría del estado actual

### Problema raíz de UX
Hay **cuatro pantallas financieras** que compiten por la misma pregunta ("¿cómo va el negocio?") con números distintos: Dashboard (`/`), Finanzas (`/finance`), Panel Financiero (`/finance/reports`) y Caja (`/caja`). Un dueño que compare dos de ellas en el mismo minuto ve ingresos diferentes (cobros de caja activa vs FM del período vs BFE del período). La consecuencia no es estética: **destruye la confianza en el sistema**, que es el activo principal de un panel financiero.

### Evaluación por dimensión

| Dimensión | Diagnóstico |
|---|---|
| Jerarquía visual | Sin jerarquía entre "lo vital" (¿gano plata? ¿me alcanza la caja?) y lo secundario (contadores de comprobantes ARCA). Grillas de 4-8 cards equivalentes — el anti-patrón "dashboard made only of cards" que el design system prohíbe. |
| Comprensión inmediata | "Ingresos brutos", "Resultado neto", "Cobrado", "Ventas cobradas" conviven sin definición; ninguna tarjeta explica su fórmula ni su fuente. |
| Sobrecarga cognitiva | Finance.tsx: 6+ métricas de resumen + 3 tabs + 3 sub-charts + tabla + inventario + recurrentes en una página de 2.099 líneas. |
| Métricas redundantes | ingresos × 4 definiciones; deuda proveedores × 2 (una en $0); margen × 3 (margenBruto, opMargin, averageMarginPct). |
| Métricas sin acción | "ARCA emitidas", "Ventas locales" (conteos), "Total issues bajos" — no cambian ninguna decisión del dueño. |
| Dato vs recomendación | No existe capa de recomendación; el único lenguaje natural es el StatusBanner (positivo/negativo) con umbral ±$500 arbitrario. |
| Contraste / accesibilidad | Textos `#334155`/`#475569` sobre `#0b1220` ≈ 3:1 — por debajo de AA para texto funcional (labels 0.62-0.72rem). Estados solo por color (verde/rojo) sin ícono/texto en varios KPIs. Inputs de caja sin `aria-label`. |
| Responsive | Grillas `repeat(4, 1fr)` fijas en CajaPage y FinanceDashboard → colapsan mal en móvil; tablas sin patrón móvil (scroll horizontal crudo). |
| Estados de carga | Spinners genéricos; sin skeletons; cachés módulo (90s/120s) producen "números viejos sin aviso" tras registrar una venta. |
| Estados vacíos | Buenos en Caja/NC; Finance.tsx muestra el SQL de creación de tabla en pantalla (asusta y expone internals). |
| Errores | `alert()`/`confirm()` nativos en flujos financieros (borrar movimiento/entrada); errores de queries silenciados (rotación, inventario). |
| Períodos | Cuatro selectores distintos (hoy/semana/mes/año vs today/yesterday/week/month/last_month) con semánticas de "semana" diferentes (lunes-hoy vs domingo-hoy) y cortes UTC. |
| Comparaciones | Solo "compras vs período anterior" en inventario; sin MoM/YoY en ningún KPI central. |
| Filtros / drill-down | Movimientos con filtro básico; ningún KPI permite ver "qué operaciones lo componen"; el filtro "Reversas" no matchea los datos reales (P2-2). |
| Tooltips / fórmulas | Inexistentes. |
| Exportación | Inexistente en finanzas (solo Excel en otros módulos). |

### Clasificación de componentes actuales

| Componente | Veredicto | Justificación |
|---|---|---|
| RPC `finance_dashboard_summary` | **Mantener y corregir** | única agregación server-side; arreglar NC/reversas y fuente de deuda |
| RPC `finance_health_check` + tab Auditoría | **Mantener** | activo diferencial; promover a "salud de datos" visible |
| CajaPage (sesión, arqueo, historial) | **Mantener / mejorar** | concilia bien; quitar delete libre, RPC de apertura/cierre, móvil |
| FinanceDashboard.tsx (tabs Resumen/Caja/Ventas/Gastos/Movimientos) | **Unificar** | base del nuevo panel único (Nivel 1+2) |
| Finance.tsx "Panel Financiero" | **Reemplazar** | P&L sobre BFE contaminado + 2.099 líneas; su parte útil (recurrentes, inventario) se muda a módulos propios |
| `useFinancialDashboard` (Dashboard home) | **Simplificar** | dejar solo caja activa + accesos; quitar "ventas semana/mes" (cobros mal rotulados, cap 1.000) |
| `useDashboardStats` (profit real, top items) | **Reemplazar** | mezcla fuentes, recorta pérdidas, denominadores incoherentes |
| InventoryMetrics/useInventoryFinance | **Mejorar** | concepto correcto (capital inmovilizado); arreglar rotación, mover a vista SQL |
| StatusBanner positivo/negativo | **Reemplazar** | por el motor de explicaciones (Fase 8) |
| CuentasCorrientes page | **Mejorar** | conectarla al ledger real; hoy opera sobre `accounts` huérfana |
| Gráficos actuales (barras diarias SVG, distribución por categoría) | **Mantener** | simples y honestos; migrar a la lib única elegida |
| Donut de distribución de gastos (Finance.tsx) | **Eliminar** | categorías contaminadas (P0-1) + regla "no donas sin explicación" |

---

## Fase 7 — Propuesta: un solo panel, tres niveles

**Principio rector**: una sola página `/finance` con tres alturas de lectura (resumen → gráficos → detalle auditable). Dashboard home conserva solo caja activa + 3 accesos. Se eliminan las definiciones duplicadas: cada número del panel sale de las **vistas SQL canónicas** definidas en [07-roadmap.md](07-roadmap.md) (nunca de agregaciones JS).

### Nivel 1 — Resumen inmediato (siempre visible, sin scroll en desktop; 2×3 en móvil)

Seis piezas, nada más:

1. **Resultado operativo del mes** (devengado, sin retiros ni personal) + Δ vs mes anterior.
2. **Caja disponible ahora** (por método, suma sesión + cuentas) + mini-sparkline 30d.
3. **Margen bruto %** del mes (devengado) + tendencia 6 meses.
4. **Punto de equilibrio**: barra de progreso "ventas del mes vs $X necesarios" + "alcanzado el día N" cuando se cruza.
5. **Compromisos próximos 14 días**: proveedores con vencimiento + recurrentes por `day_of_month` − cobros CC esperados.
6. **Estado general en lenguaje natural** (motor Fase 8): p. ej. *"Tu taller es rentable este mes ($X de resultado), pero la caja podría quedar ajustada: tenés $4,56M comprometidos con proveedores y $25.100 por cobrar."*

Reglas: tipografía tabular para montos; cada tarjeta con ⓘ que abre su fórmula + operaciones incluidas (Nivel 3); color solo como refuerzo (ícono + texto siempre); AA en todos los textos.

### Nivel 2 — Gráficos interactivos (especificación)

Librería recomendada: **Recharts** para todo lo cartesiano/composición (mantenido, tree-shakeable, a11y razonable, tema oscuro simple) + **d3-sankey embebido** solo para el flujo de dinero (Recharts no lo trae; Nivo Sankey es la alternativa si se prefiere no tocar d3). Evitar mezclar 3 libs. Todos los gráficos comparten: mismo selector de período AR-timezone, tooltip con fuente + fórmula, estado vacío con explicación + CTA, estado de error con reintento, export CSV del dataset visible, y en móvil: alto fijo ~240px, scroll horizontal prohibido, leyendas colapsadas.

| # | Gráfico | Pregunta que responde | Datos/Fórmula | Interacción y drill-down | Riesgo de mala lectura → mitigación |
|---|---|---|---|---|---|
| 1 | **Waterfall del resultado** (mensual) | ¿Cómo pasé de vender $X a ganar $Y? | Ventas netas → −COGS → −comisiones → −fijos → −sueldos empleados → = Resultado operativo → −retiros dueño → = Caja retenida. Fuente: vistas canónicas | click en cada barra → lista de operaciones (Nivel 3); toggle devengado/percibido | mezclar retiros como "gasto" → barra de retiros en color capital (índigo) separada por una línea "resultado" |
| 2 | **Sankey "adónde va la plata"** (trimestre) | ¿En qué se me va lo que entra? | Cobros → {COGS, fijos por categoría, comisiones, proveedores(deuda saldada), retiros, queda en caja} desde FM+BFE saneados | hover por flujo = monto+%; click = detalle | doble conteo si COGS y pagos a proveedor coexisten → usar SOLO percibido (pagos) en este gráfico |
| 3 | **Línea de caja histórica + proyección** | ¿Me quedo sin plata? | saldo diario real (Σ FM por día, sesiones) + proyección 30d: promedio cobros 28d − compromisos fechados | banda de confianza; hover día = movimientos; marcador "hoy" | proyección leída como promesa → banda + etiqueta "estimado"; sin datos <14d → no proyectar |
| 4 | **Barras ingresos vs egresos** (diaria/semanal) | ¿Qué días gano/pierdo? | FM income sign1 vs expense por día AR (ya existe; migrar y corregir TZ) | click día → movimientos | reversos como egreso operativo → excluir sign=-1 a una serie "ajustes" |
| 5 | **Aging CxC / CxP** (barras apiladas espejo) | ¿Quién me debe / a quién debo y hace cuánto? | buckets 0-7/8-30/31-60/+60 desde `saldo_pendiente`+fecha y `supplier_purchases.pending`+purchase_date | click bucket → clientes/proveedores; acción "cobrar/pagar" | CC vacía muestra $0 falso → alimentar ledger primero (P0-7) |
| 6 | **Treemap capital inmovilizado** | ¿Dónde está enterrada la plata? | stock×cost_price por categoría→producto; color = días sin movimiento (necesita rotación arreglada P2-3) | click categoría → productos; toggle costo histórico / reposición TC hoy | tamaño+color saturan → máx 2 niveles, leyenda de color explícita |
| 7 | **Dispersión rentabilidad por producto/servicio** | ¿Qué conviene vender? | x=unidades vendidas 90d, y=margen % (desde CI), tamaño=ganancia $ | cuadrantes rotulados ("estrella", "de nicho", "revisar precio", "muerto"); click → ficha | ítems costo-0 aparecen 100% margen → excluirlos con badge "sin costo (N)" |
| 8 | **Evolución del margen** (línea 12m) | ¿Estoy perdiendo rentabilidad? | margen bruto % mensual devengado + banda margen operativo | hover mes = waterfall mini; anotaciones de eventos (suba dólar) | cambios de mix leídos como "aumento de costos" → tooltip descompone precio/costo/mix |
| 9 | **Punto de equilibrio** (gauge lineal, no velocímetro) | ¿Ya cubrí los fijos este mes? | fijos del mes / margen de contribución %; progreso = ventas netas MTD | marcador "hoy" + proyección fin de mes | fijo mensual volátil → usar promedio 3m con ⓘ |
| 10 | **Resultado vs retiros del dueño** (barras pareadas 6m) | ¿Estoy retirando más de lo que gano? | resultado operativo mensual vs `owner_withdrawals`+BFE salary dueño | click mes → detalle de retiros; línea "% retirado" | leerlo como reproche → framing neutro "capital retenido" |
| 11 | **Proyección personal (Mi Guita)** | ¿Cómo queda MI plata? | ya existe `projectionService`; agregar overlay "retiro sugerido" | vive en Mi Guita (identidad Verde), NO en el panel del negocio | mezcla de identidades → solo un link cruzado, sin datos del negocio dentro de Mi Guita |
| 12 | **Vista puente empresa↔dueño** | ¿Cuánto pasó del negocio a mi bolsillo y cuánto volvió? | `owner_withdrawals` (retiros) + aportes tipificados; saldo neto anual; NUNCA como gasto/ingreso duplicado en consolidado — es una transferencia con 2 patas linkeadas | tabla cronológica con ambas patas; filtro año | sumar las dos patas como si fueran 2 flujos → mostrar SIEMPRE como fila única con origen→destino |

Explícitamente **no** incluir: donas de composición, velocímetros, KPIs de conteo sin acción (ARCA emitidas, etc. van a la pantalla de Comprobantes).

### Nivel 3 — Detalle auditable (el diferencial)

Cada tarjeta/gráfico abre un panel lateral con:
- **Fórmula** en lenguaje claro + fuente (tabla/vista) + período aplicado y TZ.
- **Operaciones incluidas** (paginadas server-side) y **excluidas** con motivo (anulada, draft, sin costo, fuera de período) — esta lista de excluidas es lo que hoy no existe en ningún lado y evita el "no me cierra el número".
- Comparador de períodos (mismo rango anterior / mismo mes año pasado).
- Filtros: sucursal (futuro), categoría, técnico, cliente, medio de pago.
- Export CSV.
- Badge de calidad de datos: "N ítems sin costo", "N movimientos sin caja", "última conciliación: OK/errores" (alimentado por `finance_health_check`).

---

## Fase 8 — Motor de explicaciones financieras (determinístico)

**Arquitectura**: tabla `finance_insights` poblada por una función SQL/Edge `generate_finance_insights(business_id, period)` que evalúa reglas fijas sobre las vistas canónicas. Cero LLM, cero heurística opaca: cada insight persiste `rule_id`, `evidence` (jsonb con los números), `severity`, `action`, `link`. La UI solo renderiza. Máximo 3 visibles, ordenados por severidad; el resto colapsado.

Formato fijo de cada regla:

| Campo | Ejemplo (regla R3) |
|---|---|
| rule_id | `cash_down_sales_up` |
| Condición | ventas netas MoM > +10% AND caja neta MoM < −5% |
| Evidencia | `{ventas_actual, ventas_prev, caja_actual, caja_prev, cc_delta}` |
| Texto | "Vendiste 18% más, pero tu caja bajó porque $X quedaron en cuenta corriente sin cobrar." |
| Cálculo visible | link "ver cálculo" → los 5 números y la resta |
| Severidad | warning |
| Acción | "Revisá el aging de cuentas por cobrar" → gráfico 5 |
| Período | mes actual vs anterior |

Reglas iniciales (todas computables hoy con datos existentes una vez saneado el modelo):

1. `margin_drop_cost` — margen bruto % cae >3pp y COGS/venta sube → "El margen cayó N pp por aumento del costo de repuestos (de X% a Y%)."
2. `cash_down_sales_up` — (ejemplo de arriba).
3. `dead_stock` — % de capital sin movimiento 90d > 20% → "El 27% de tu inventario ($X) no rotó en 90 días — capital dormido." → treemap.
4. `withdrawals_vs_profit` — retiros 3m / resultado operativo 3m > 70% → "Los retiros representan el 88% de la utilidad del trimestre." → gráfico 10.
5. `fixed_coverage` — liquidez / fijos promedio → "Podés cubrir 1,7 meses de gastos fijos con la caja actual."
6. `breakeven_day` — al cruzar el punto de equilibrio → "Alcanzaste el punto de equilibrio el día 21."
7. `supplier_crunch` — compromisos 14d > caja proyectada → severity critical + CTA a proyección.
8. `fx_stale_prices` — TC ficha < TC actual −2% → "475 productos USD tienen precios calculados a $1.490 (hoy $1.541)." → acción de re-valuación.
9. `data_quality` — health-check con críticos > 0 → "Hay N inconsistencias que pueden distorsionar estos números" (bloquea la confianza del resto con banner).
10. `cc_aging` — deuda >30d crece → "$X de deuda de clientes tiene más de 30 días; el 60% es de 2 clientes."

Anti-reglas (prohibido): consejos genéricos sin evidencia ("considerá reducir costos"), umbrales invisibles, insights sin link al detalle, más de un insight por regla y período.

## Mi Guita — relación sin mezcla (resumen operativo)

- **Una sola puerta** para plata negocio↔dueño: `owner_withdrawals` (RPC, dos patas linkeadas). Se elimina la categoría `salary/retiros` y TODA `fixed_cost_personal` del P&L del negocio (P0-2); "sueldo del dueño como gasto" pasa a ser un flag explícito del negocio que, si se activa, genera FM+BFE de sueldo Y la pata personal, siempre por la RPC.
- **Aporte del dueño**: RPC espejo `create_owner_contribution` (personal→negocio), tipificada como capital, jamás como ingreso operativo.
- **Gasto personal pagado por el negocio**: registrarlo como retiro (con nota), nunca como gasto del local.
- **Vista consolidada** (gráfico 12): las transferencias aparecen UNA vez (origen→destino); jamás como gasto en un lado e ingreso en el otro sumados.
- **Identidades**: el panel del negocio (Índigo) muestra retiros agregados; Mi Guita (Verde) muestra la pata personal. Ningún componente comparte estilos ni datos crudos del otro dominio; el deep-link `/personal/salary` ya existe y es el patrón correcto.
