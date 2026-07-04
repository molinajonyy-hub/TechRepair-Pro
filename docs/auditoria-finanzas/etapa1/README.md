# Etapa 1 — Modelo contable correcto

Separa definitivamente los tres ejes financieros de TechRepair Pro:
**rentabilidad (devengado)**, **flujo de caja (percibido)** y **posición financiera**.

Parte del estado estable post-Etapa 0:

```
HEAD / origin/main : 9aec74728b87cf342f9eec3dcce6c260d304ce06
Etapa 0 funcional  : 56d28b82716ec985acbf4b8976b32587b20bf5a3
Tag estable        : stable-finance-hardening-v1
Migración remota   : 20260702140000_ledger_protection (la última aplicada en prod)
```

## Alcance
- **M3** `fix_cost_double_count` — elimina el doble/triple costo (pagos a proveedor, compra de inventario y COGS-mirror dejan de contaminar el resultado).
- **M4** `owner_capital_flows` — retiros/sueldo del dueño/gastos personales fuera del P&L; `create_owner_contribution`.
- **M5** `canonical_views` — vistas `v_finance_*` como fuente única + RPC `finance_dashboard_summary` v2.
- Migración del frontend actual a esas fuentes (sin rediseño, sin gráficos nuevos).
- Comparativo documentado antes/después.

## NO incluye
M6, M7, M8; rediseño de dashboard; gráficos nuevos; segunda librería de charts;
backfill de los 45 FM sin caja; corrección de los 2 comprobantes desincronizados
inventando pagos; recálculo de históricos con valores actuales.

## Documentos
| Archivo | Contenido |
|---|---|
| [baseline-production.sql](baseline-production.sql) | Consultas `SELECT` re-ejecutables del baseline (solo lectura) |
| [baseline-production.md](baseline-production.md) | Resultados del baseline + tabla antes/después (contrato "antes", congelado) |
| [accounting-contract.md](accounting-contract.md) | 14 clases económicas: definición, fuente, efecto en P&L/caja/patrimonio |
| [legacy-classification.md](legacy-classification.md) | Diseño de `economic_class` + matriz de reglas de reclasificación |
| [comparativo-local.md](comparativo-local.md) | Antes/después sobre copia local + control de conservación |

## Regla de oro
Los montos, fechas y snapshots históricos **no se modifican**. La Etapa 1 solo
**agrega clasificación** y **cambia de qué fuente lee cada métrica**. Todo lo
demás (checkout, anulación atómica, ledger protegido, caja única, ownership,
fechas AR) de la Etapa 0 se preserva sin degradar.
