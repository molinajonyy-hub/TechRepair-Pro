# Comparativo ANTES / DESPUÉS — Etapa 1

Compara el [baseline productivo](baseline-production.md) (modelo BFE viejo) contra
el modelo canónico. El "después" se obtiene de DOS fuentes independientes que
coinciden:
1. **Datos reales de Clic** — la lógica canónica aplicada read-only a producción
   (mismo conjunto efectivo y misma clasificación que implementan las migraciones).
2. **Fixtures locales** — `supabase/tests/etapa1_canonical_model_test.sql` prueba
   que las vistas `v_finance_*` producen exactamente estos resultados sobre un
   dataset controlado (30 asserts en verde).

Ninguna migración se aplicó a producción; ningún monto/fecha histórico cambió.

## P&L — Clic, histórico (ARS)
| Métrica | ANTES (BFE) | DESPUÉS (canónico) | Cambio | Reconstrucción |
|---|---:|---:|---:|---|
| Ventas netas | 10.876.157 | **10.030.076** | −846.081 | devengado por ítems (conjunto efectivo) − NC 13.050, en vez de cobros+manual |
| COGS | 3.384.244¹ | **3.874.762** | +490.518 | `comprobante_items.costo_total`, contado una sola vez |
| Ganancia bruta | 7.491.913 | **6.155.314** | −1.336.599 | net_sales − cogs |
| Margen bruto % | 68,9% | **61,4%** | −7,5 pp | real, sin inflar |
| Gastos operativos | 2.244.800 | **2.609.415** | +364.615 | fijos 2.244.800 + comisiones (payment_fee) 364.615 |
| Sueldos empleados | (dentro de sueldos 3.000.000) | **0** | — | Clic no tiene sueldo_empleados |
| **Resultado operativo** | 5.247.113² | **3.545.899** | −1.701.214 | rentabilidad real, sin retiro ni compras como costo |
| — Retiro del dueño (capital, fuera del P&L) | −3.000.000³ | fuera del P&L | +3.000.000 | `owner_withdrawal` (era `salary/sueldo_dueno`) |
| Deuda proveedores mostrada | 0 | **4.562.420** | +4.562.420 | ledger real, no `accounts` vacía |
| Montos sin clasificar | — | **0** | — | Clic: 267/267 BFE clasificados, 0 `legacy_unclassified` |

¹ `variable_cost` completo (mezcla). ² `margenBruto − fixed_local`. ³ el modelo viejo restaba el retiro en `resultadoNeto` = 2.247.113.

### Reconstrucción del Δ resultado operativo (−1.701.214)
```
ANTES operativo  = income 10.876.157 − varcost 3.384.244 − fixed 2.244.800 = 5.247.113
DESPUÉS operativo = net_sales 10.030.076 − cogs 3.874.762 − opex 2.609.415  = 3.545.899
Δ = −846.081 (ventas devengadas < cobros) − 855.133 (COGS real > costo mezclado en P&L) = −1.701.214
```
Cada diferencia se reconstruye desde filas concretas (ver clasificación abajo).

## Clasificación aplicada (backfill preview real, Clic)
| economic_class | Filas | Monto ARS | ¿En el P&L? |
|---|---:|---:|---|
| revenue_collection_mirror | 187 | 10.876.157 | **No** (ventas salen de ítems) |
| owner_withdrawal | 2 | 3.000.000 | **No** (capital) |
| operating_expense | 12 | 2.244.800 | **Sí** |
| cogs_mirror | 47 | 1.684.888 | **No** (COGS sale de ítems) |
| inventory_purchase | 3 | 891.141 | **No** (compra de stock) |
| supplier_liability_payment | 2 | 443.600 | **No** (pago de pasivo) |
| payment_fee | 14 | 364.615 | **Sí** |
| legacy_unclassified | 0 | 0 | — |
| **Total** | **267** | **19.505.201** | Excluido del P&L: 16.895.787 |

## Control de conservación (el backfill NO altera datos)
| Invariante | Verificación |
|---|---|
| Cantidad de BFE | 267 antes = 267 después (0 filas creadas/borradas) |
| Suma `amount_ars` | 19.505.201 antes = 19.505.201 después (idéntica) |
| Montos / fechas / type / category / source | **sin cambios** — solo se pobló `economic_class` |
| Comprobantes / pagos / FM / inventario | **sin cambios** — M3/M4 no los tocan |
| Snapshots de precio/costo/TC | **sin cambios** |

El test `etapa1_canonical_model_test.sql` C9 verifica la conservación sobre fixtures
(suma BFE intacta, 0 NULL tras clasificar). En producción, el backfill emite
`RAISE NOTICE` con filas y monto por clase ANTES de escribir (preview auditable).

## Expected failures documentados (fuera del gate)
- **2 comprobantes desincronizados** (pre-RPC) — no se inventan pagos; quedan en `data_quality`.
- **24 FM sin caja de Clic** (todos ≤ mayo 2026, ninguno post-Etapa 0) — sin backfill; en `data_quality`.
- **CxC comprobantes ($25.100) vs ledger accounts ($0)** — se usa la fuente canónica (saldo de ventas efectivas con cliente); el desvío histórico es alcance M6/M7.
- **5 ítems vendidos con costo 0** — expuestos en `data_quality.missing_cost_items`, no se inventa costo.
