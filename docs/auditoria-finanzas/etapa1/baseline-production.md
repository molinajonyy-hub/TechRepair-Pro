# Baseline productivo — Etapa 1 (contrato "ANTES", congelado)

> Capturado **2026-07-04 10:05 (Córdoba)** contra producción, solo `SELECT`.
> `origin/main` = `9aec747`. Migración remota más reciente: `20260702140000`.
> Este documento NO se modifica después para hacer coincidir el resultado final.
> Consultas re-ejecutables en [baseline-production.sql](baseline-production.sql).

## Volumen global
| Tabla | Filas |
|---|---:|
| comprobantes | 199 |
| comprobante_items | 349 |
| comprobante_payments | 197 |
| financial_movements | 223 |
| business_finance_entries | 295 |
| cajas | 45 |
| supplier_purchases / payments / account_movements | 4 / 3 / 7 |
| accounts / account_movements | 1 / 1 |
| owner_withdrawals | 0 |
| expenses / purchases (legacy) | 18 / 1 |
| comprobante_annulments | 0 |

Por negocio con actividad: **Clic** `aa930802…` (183 comprobantes, 193 FM, 267 BFE, 40 cajas, 4 compras) · **Mi Negocio** `ac591b32…` (13/21/19/1/0) · **Mi Negocio** `e82cc855…` (3/9/9/1/0).

## Aclaración obligatoria — FM sin `caja_id` (global vs Clic)
| Alcance | Filas | Monto ARS |
|---|---:|---:|
| **Global** | 45 | 4.434.258 |
| **Clic** | **24** | **3.597.758** |
| Mi Negocio `ac591b32` | 21 | 836.500 |

- Por `source` (global): comprobante 36 · bfe 7 · pago_proveedor 1 · cobro_rapido 1.
- Por mes (global): 2026-04 → 17 · 2026-05 → 28. **Ninguno en 2026-06/07.**
- **Anteriores a Etapa 0: 45 · Posteriores: 0.**

**Conclusión:** los 24 de Clic son exactamente los mismos que reportó la auditoría (no aumentaron). Los "45 globales" incluyen 21 de otro negocio. El deploy de Etapa 0 **no generó ningún FM sin caja nuevo**. Se dejan como están (sin backfill, alcance M6/M7).

## Tres libros (Clic, histórico) — NO son una igualdad universal
| Libro | Monto ARS | Qué mide |
|---|---:|---|
| Pagos POS (no CC) | 11.005.259 | percibido bruto por comprobante_payments |
| FM income (sign=1) | 9.342.027 | caja física (excluye lo que cayó sin caja) |
| BFE income | 10.876.157 | espejo de cobros (181 ref) + 6 asientos manuales ($1.112.028) |
| BFE variable_cost | 3.384.244 | mezcla COGS-mirror + compras + comisiones |
| BFE fixed_cost_local | 2.244.800 | opex real (alquiler, impuestos, servicios) |
| BFE salary | 3.000.000 | "Mi sueldo del mes" (sueldo_dueno) |
| BFE fixed_cost_personal | 0 | — |

La diferencia entre libros es **estructural** (percibido vs devengado vs caja física), no un error a "cuadrar". Se concilia **por origen**, no globalmente.

## Doble/triple costo (Clic)
| Concepto | Monto ARS | `source` | ¿Es costo del período? |
|---|---:|---|---|
| **COGS real** (ítems vendidos, issued no anulados) | **2.309.906** | comprobante_items | **Sí — fuente canónica** |
| COGS real (conjunto efectivo, incl. drafts legacy) | 3.874.762 | comprobante_items | Sí |
| BFE `mercaderia` (COGS-mirror) | 1.684.888 | manual 1.656.416 / comprobante 28.472 | No — espejo, no debe sumar |
| BFE `inventario` | 660.866 | expense (compra rápida) | No — compra de stock |
| BFE `compras_proveedor` | 443.600 | pago_proveedor | No — pago de pasivo |
| BFE `repuestos` | 230.275 | manual (compra rápida legacy) | No — compra de stock |

**Contaminación total en P&L de costo** = mercaderia 1.684.888 + inventario 660.866 + compras_proveedor 443.600 + repuestos 230.275 = **3.019.629** que NO son COGS devengado y hoy reducen el resultado.

## Conjunto EFECTIVO (base devengada canónica, Clic, histórico)
`issued` OR draft con pagos/stock/CC · no anulado · no NC → **180 comprobantes**.
- **net_sales** = 10.043.126 · **COGS** = 3.874.762 · **NC** = 13.050
- Sin incluir los drafts legacy, "issued-only" sería solo 91 comprobantes / $6.264.895 → subestimaría ventas en ~$3,4M. **La base efectiva DEBE incluir los drafts legacy con efectos** (ver [legacy-classification.md](legacy-classification.md)).

## Flujos del propietario (Clic)
| Origen | Filas | Monto ARS | Clasificación |
|---|---:|---:|---|
| BFE `salary` / `sueldo_dueno` ("Mi sueldo del mes") | 2 | 3.000.000 | **Retiro (capital)** — inequívoco |
| BFE `fixed_cost_personal` | 0 | 0 | — |
| BFE `retiros` | 0 | 0 | — |
| `owner_withdrawals` | 0 | 0 | — |
| `sueldo_empleados` | 0 | 0 | (sería gasto operativo si existiera) |

No hay flag de sueldo formal del dueño → `sueldo_dueno` se reclasifica a retiro (fuera del P&L). Único caso, inequívoco por categoría.

## Deuda
| Métrica | Fuente | Monto ARS |
|---|---|---:|
| CxC | comprobantes.saldo_pendiente | 25.100 |
| CxC | ledger `accounts` (cliente) | 0 (vacía) |
| **CxP** | supplier_purchases.pending | **4.562.420** |
| **CxP** | supplier ledger (debit−credit) | **4.562.420** ✓ concilian |
| CxP | `accounts` proveedor (lo que lee el Dashboard) | **0** ← muestra mal |

## Calidad de datos (Clic)
5 ítems vendidos con costo 0 · 76 drafts con stock procesado · 2 comprobantes desincronizados · 0 BFE sin source ni referencia · 0 cobros CC en BFE.

---

## Tabla ANTES / ESPERADO Etapa 1 (Clic, histórico) — CONTRATO CONGELADO
"Actual" = lo que hoy calcula `financialMetricsService` (BFE-based).
"Esperado" = contrato contable nuevo (devengado por ítems + opex real, retiros y compras fuera del P&L).

| Métrica | Actual | Esperado Etapa 1 | Diferencia | Motivo |
|---|---:|---:|---:|---|
| Ventas netas | 10.876.157 | **10.030.076** | −846.081 | actual = cobros+manual (percibido); esperado = devengado por ítems − NC |
| COGS | 3.384.244¹ | **3.874.762** | +490.518 | esperado = `costo_total` de ítems del conjunto efectivo, contado una vez |
| Ganancia bruta | 7.491.913 | **6.155.314** | −1.336.599 | consecuencia de las dos anteriores |
| Margen bruto % | 68,9% | **61,4%** | −7,5 pp | el margen real es menor; el anterior estaba inflado |
| Gastos operativos | 2.244.800 | **2.609.415** | +364.615 | comisiones de cobro pasan a opex (payment_fee) |
| Resultado operativo | 5.247.113² | **3.545.899** | −1.701.214 | resultado real, sin el $3M de retiro ni compras como costo |
| Pagos a proveedores en costo | 443.600 | **0** | −443.600 | pago de pasivo, no gasto |
| Compras rápidas duplicadas en costo | 891.141³ | **0** | −891.141 | compra de inventario, no gasto |
| COGS-mirror en costo | 1.684.888 | **0** | −1.684.888 | el COGS canónico vive en los ítems |
| Retiros/personal en P&L | 3.000.000 | **0** | −3.000.000 | retiro del dueño = capital, no gasto operativo |
| Deuda proveedores mostrada | 0 | **4.562.420** | +4.562.420 | leer del ledger real, no de `accounts` vacía |
| Montos sin clasificar | — | 0⁴ | — | todo BFE de Clic cae en una regla determinística |

¹ El "COGS" actual es en realidad todo `variable_cost` (mezcla). ² `margenBruto − fixed_local`. ³ inventario 660.866 + repuestos 230.275. ⁴ ver matriz en [legacy-classification.md](legacy-classification.md).

**Nota honesta:** limpiar el modelo hace el resultado operativo **más bajo** ($3,55M vs $5,25M mostrado), no más alto. El número viejo no era "optimista": era incorrecto en ambos sentidos (contaba cobros como ventas, subcontaba el COGS real, y luego restaba un retiro de capital de $3M). El valor de Etapa 1 no es un número mejor sino uno **correcto y separable** en rentabilidad / caja / patrimonio.
