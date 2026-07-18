# M7 — Lote 7B.1 · Análisis del residuo de COGS y plan de release por fases

**Fecha:** 2026-07-16 · **Alcance:** análisis y preparación. **Cero escrituras en producción.**
Sin commit, push, deploy, backfill ni tag.

---

## 1. Naturaleza exacta del residuo de COGS

### Los datos

| | original | nota de crédito |
|---|---|---|
| id | `95cbf330-0714-412a-9d5d-f6aa85123a62` | `1abfc1a1-2264-42ad-8850-b44f7b87e279` |
| tipo / número | `factura_c` `0010-00000001` | `nota_credito` `0010-00000001` |
| fecha AR | 2026-05-21 | 2026-05-21 |
| estado / fiscal | `anulado` / `anulado_fiscal` | `emitido` / `emitido` |
| total | **13.050,00** | **13.050,00** |
| ítems | 1 | 1 |
| cantidad | 1 | 1 |
| ítem | `Magnetic Transparente - iPhone XR` · pu 13.050 · **cu 2.186 · ct 2.186** | `NC: Magnetic Transparente…` · pu 13.050 · **cu 0 · ct 0** |
| `inventory_id` | `dda30d18-6bec-4917-b517-005ea791cb53` | **NULL** |
| `stock_processed` | true | false |

**La NC es TOTAL**: mismo total (13.050 = 13.050) y misma cantidad (1 = 1).

### Movimientos económicos

- **FM de la NC**: `expense/comprobante sign=-1` de **13.050** (21:08) → **el efectivo sí se reversó**.
- **BFE de la NC**: `income/ventas_productos` `revenue_collection_mirror` de **−13.050** (21:08) → el espejo de ingreso también.
- **Movimientos de inventario de la NC**: **NINGUNO**.
- El inventario `dda30d18…` tiene **5 movimientos `sale` y CERO `return`** en toda su historia; `stock_quantity` hoy es **0**.

> Esto corrige una afirmación imprecisa del informe 7A ("el FM de ingreso no está reversado"). El FM original conserva `reversed_at = NULL`, pero la NC emitió su **asiento contrario**: el efectivo netea a cero. Ya corregí el informe 7A.

### La causa raíz, en el código

`create_credit_note_from_comprobante` copia los ítems del original así:

```sql
-- ── 8. Copiar ítems del original (sin descuento de stock) ──
  cantidad, precio_unitario, descuento_linea, subtotal,
  0, 0,                    -- NC no tiene costo de mercadería
  currency, exchange_rate,
  NULL,                    -- NC no descuenta stock
  orden
FROM comprobante_items WHERE comprobante_id = p_comprobante_id;
```

**Es una decisión de diseño explícita y deliberada**: la nota de crédito revierte **dinero**, no **mercadería**. Por eso `ct = 0` y `inventory_id = NULL`.

## 2. Clasificación: **A — el residuo es económicamente correcto**

No es **C** (defecto de la fuente contable M7). Verifiqué los cuatro puntos del §2:

| verificación | resultado |
|---|---|
| ¿el ledger duplica el ingreso de la NC? | **No** — `v_finance_pnl.sales` filtra `is_credit_note = false`; el ingreso de la NC entra sólo por `returns`, una vez |
| ¿duplica COGS? | **No** — un único evento `sale` por ítem del original |
| ¿omite COGS de una devolución total? | **No lo omite**: lo mantiene, porque la mercadería no volvió |
| ¿usa el costo actual del inventario? | **No** — usa `ci.costo_total`, el costo histórico persistido en el ítem |

No es **B** (error de datos legacy). Los datos son exactamente lo que la RPC de NC está diseñada para producir. Nada está corrupto.

Es **A**: el registro es **internamente consistente**. La unidad salió del inventario (stock 2→1) y **nunca volvió**; el dinero se devolvió. El resultado —pérdida de 2.186— es la lectura contable correcta de esos hechos: *le devolviste la plata al cliente y la mercadería no está*.

### Sobre la regla "NC total ⇒ COGS 0"

Tu §1 pide que, si la NC es total, exija `ventas = 0, COGS = 0, resultado = 0`. **Tengo que objetar esa regla**, y prefiero decirlo antes que aplicarla mecánicamente: sólo es válida si una NC total implica **devolución de mercadería**. En este sistema **explícitamente no la implica** (`-- NC no descuenta stock`).

Forzar `COGS = 0` sin restaurar stock crearía una **inconsistencia nueva**: el P&L diría "no salió mercadería" mientras el inventario dice que sí salió. Y restaurar el stock hoy sería peor: ese producto siguió vendiéndose (hay un `sale` del 2026-07-10) y su stock actual es 0 — sumarle una unidad hoy falsearía el inventario presente.

### Resultado esperado correcto de la factura C

```
ventas acumuladas    = 0          ✅ (13.050 de venta − 13.050 de la NC)
COGS acumulado       = 2.186      ← correcto: la mercadería no volvió
resultado acumulado  = −2.186     ← pérdida real: dinero devuelto, producto entregado
```

**Salvo que el dueño confirme que la mercadería sí volvió físicamente.** En ese caso el residuo pasa a ser **B** y hace falta una **reconciliación puntual separada** (`return` de inventario + reversión de COGS, ambos con fecha 2026-05-21), que **no forma parte de este lote** y no recomiendo sin esa confirmación.

## 3. La brecha general del modelo (§2 — condición de parada)

**Me detengo acá y no toco vistas.** El problema **es general, no de esta fila**: *toda* nota de crédito total en este sistema deja el COGS sin revertir y el stock sin restaurar. Silenciosamente, una NC "total" se contabiliza como un regalo de mercadería.

`v_finance_pnl` calcula las NC así:
- **Ingreso**: `returns` = `sum(e.total)` del **header** de la NC, en el período de la NC.
- **COGS**: **no existe término de COGS para NC**. Ninguno.
- **Relación con el original**: **ninguna** — `returns` no hace join con `comprobante_original_id`; sólo resta totales de NC.
- **Costos cuando el ítem de NC no tiene costo**: `ct = 0` siempre, por diseño de la RPC.
- **Totales vs parciales**: `returns` las trata **igual** (resta el total del header). Una NC parcial resta su propio total; una total, el total completo.

### Propuesta mínima (NO implementada — requiere tu decisión)

**Opción 1 — La NC ofrece devolución de mercadería (recomendada a futuro).**
Extender `create_credit_note_from_comprobante` con un parámetro explícito `p_restore_stock`, que cuando sea true: copie `inventory_id` y `costo_total` en los ítems de la NC, cree los `inventory_movements` de entrada y deje que el ledger derive el COGS negativo. Es la única forma de que "NC total ⇒ COGS 0" sea *verdad* en vez de un maquillaje. **Toca ARCA-adyacente y cambia una política comercial: fuera del alcance de M7.**

**Opción 2 — Documentar la semántica y no tocar nada.**
Declarar formalmente: "la nota de crédito revierte dinero, no mercadería; si la mercadería vuelve, hay que registrarla como devolución aparte". Cero código. El P&L sigue siendo correcto respecto de lo registrado.

**Mi recomendación: Opción 2 ahora, Opción 1 como lote propio después de M7.** El residuo de 2.186 es un caso único en toda la base productiva y su tratamiento actual es contablemente defendible.

## 4. Comando `psql` corregido

El informe 7B tenía un error real que ya corregí: recomendaba `--single-transaction` **combinado** con un script que maneja su propio `BEGIN`/`ROLLBACK`. Eso es incompatible: psql abriría una transacción externa y el `ROLLBACK` del archivo la abortaría, dejando el resto del script sin ejecutar de forma ambigua.

```bash
psql -X -v ON_ERROR_STOP=1 --echo-all \
     --file="docs/auditoria-finanzas/m7/m7-7b-reconcile-legacy-annulment.sql" \
     "$DATABASE_URL_PRODUCCION"
```

- **`-X`** — ignora `~/.psqlrc`: evita que un `AUTOCOMMIT off` o un `ON_ERROR_ROLLBACK` local cambien el comportamiento.
- **`ON_ERROR_STOP=1`** — aborta en el primer error, no sigue sobre una transacción rota.
- **`--echo-all`** — deja evidencia auditable de cada sentencia.
- **Sin `--single-transaction`** — **la transacción la controla el archivo**; `ROLLBACK` es el default y `COMMIT` se habilita a mano tras aprobación.

**Verificado**: no hay ninguna sentencia después del `ROLLBACK`. Las 10 verificaciones (V1–V10) y el chequeo de efecto neto corren **dentro de la misma transacción**, antes de la decisión — quien aprueba el `COMMIT` ya vio el resultado real del apply.

## 5. Mapa de migraciones y refactor

**Antes**: `20260713250000` mezclaba prerrequisitos (Fase A) con las vistas contables (Fase C) — imposible desplegar sin abrir la ventana del restatement.

| objeto | antes | ahora |
|---|---|---|
| `comprobante_annulments.annulment_date`, `op`, inmutabilidad | 250000 §A | **250000 (Fase A)** |
| `bfe_economic_class` | 250000 §D | **250000 (Fase A)** |
| guard de transición de anulación | 250000 §E | **250000 (Fase A)** |
| RPC `annul_comprobante_atomic` | 250000 §F | **250000 (Fase A)** |
| `is_comprobante_annulled`, guard de pagos, parche a `replace` | 260000 | **260000 (Fase A)** |
| **`v_finance_sales_ledger`** | 250000 §B | **270000 (Fase C)** |
| **`v_finance_pnl`** | 250000 §C | **270000 (Fase C)** |
| **`v_finance_product_margin`** | 250000 §C | **270000 (Fase C)** |

Nuevo archivo: **`20260713270000_m7_6f4c_accrual_views.sql`**. **Contenido funcional idéntico** — sólo cambió de archivo; se ajustaron encabezados y se documentó la dependencia (`annulment_date` de 250000) y el rollback. Las migraciones M7 pasan de 18 a **19**. Permitido reorganizar porque M7 no está desplegado.

*(Al hacerlo me comí un `Set-Content -Encoding UTF8` de PowerShell 5.1 que insertó un **BOM** y rompió la migración con `syntax error at or near "﻿"`. Detectado y eliminado; ambos archivos verifican bytes iniciales `45,45,32`.)*

## 6. Simulación completa del release por fases

Base local limpia + snapshot representativo (el remito legacy sin registro y la factura C con su NC):

| momento | ledger | registro anul. | P&L 2026-05-08 | P&L 2026-05-21 | resultado total |
|---|---|---|---|---|---|
| **Fase A** aplicada | ✗ | 0 | *(sin fila)* | net_sales **−13.050** | **−13.050** |
| **Fase B** (reconcilia) | ✗ | **1** | *(sin fila)* | net_sales **−13.050** | **−13.050** |
| **Fase C** (activa vistas) | ✓ | 1 | ventas 0 · **resultado 0** | ventas 13.050 · cogs 2.186 · net_sales **0** · resultado **−2.186** | **−2.186** |

**Requisitos del §5, todos cumplidos:**

- ✅ **Ninguna ventana lógica con P&L inconsistente.** Tras A y tras B el P&L es *exactamente* el productivo de hoy. El cambio ocurre en un solo instante: C.
- ✅ **Remito neto cero** — no aporta delta.
- ✅ **Factura C con resultado explicado** — −2.186, uno a uno.
- ✅ **Blockers cero.**
- ✅ **Todas las migraciones aplicables en orden** — `db reset` limpio.
- ✅ **Rollback documentado por fase** (abajo).
- ✅ **Batería completa: 40 suites, 1749 asserts, 0 fallas.** Guard read-only OK.

El único delta del release para ese negocio es **+10.864**: la corrección del doble descuento que hoy sufre la factura C (producción excluye la venta *y además* resta la NC).

## 7. Plan de reversión

**Ningún rollback elimina historia económica.**

| falla | acción |
|---|---|
| **Fase A** | Las migraciones son transaccionales por archivo: la fallida no queda a medias. Rollback documentado en cada archivo: `DROP TRIGGER trg_comprobante_annulment_transition`, `DROP FUNCTION comprobante_annulment_transition_guard/comprobante_annulments_immutable`, `ALTER TABLE comprobante_annulments DROP COLUMN annulment_date, DROP COLUMN op`, recrear `bfe_economic_class` y `annul_comprobante_atomic` M6. Sin datos afectados: no se escribió ninguna fila. **Abortar el release y reanalizar.** |
| **Dry-run 7B** (alguna de las 25 precondiciones falla) | **No ejecutar el apply.** Nada que revertir: es sólo `SELECT`. La precondición que falló describe un estado distinto del aprobado → reanalizar el caso. Fase A puede quedar aplicada sin riesgo (no cambia el P&L). |
| **INSERT 7B** | La precondición bajo lock hace `RAISE` → **rollback automático al inicio de la transacción**. Cero filas. Reintentable. |
| **Fila insertada pero falla la verificación** (V1–V10) | Las verificaciones corren **dentro de la misma transacción, antes del `COMMIT`**. Se lee el resultado, y si algo no cuadra **se deja el `ROLLBACK`**: la fila nunca se confirma. **Este es el rollback normal y es el default del archivo.** |
| **Fase C** | `DROP VIEW v_finance_sales_ledger` + recrear `v_finance_pnl` y `v_finance_product_margin` desde `20260704120000_canonical_views.sql`. **Probado en esta simulación**: vuelve exactamente al P&L pre-M7. La fila de reconciliación queda, inerte: sin el ledger nadie la lee, y al reactivar C vuelve a funcionar. |
| **P&L post-deploy ≠ dry-run** | **No borrar nada.** Revertir **sólo la Fase C** (vistas) → el P&L vuelve al de hoy y el negocio opera normal. Diagnosticar con el preflight conjunto y el dry-run 7B contra el estado real. Toda corrección posterior debe ser **explícita y auditada** (nueva fila en `finance_ledger_reconciliation` + su propio lote), **nunca un `DELETE` improvisado** sobre `comprobante_annulments` — además el trigger de inmutabilidad y la política append-only lo impiden. |

**Después del `COMMIT` de 7B**: la fila es inmutable por trigger y no admite `DELETE`. Si hubiera que dejarla sin efecto, la vía correcta es un lote nuevo, con dry-run, que documente la decisión — no una corrección improvisada.

## 8. Conteo final de hallazgos

| severidad | cantidad | detalle |
|---|---|---|
| **BLOCKER** | **0** | El único de 7A (restatement de +149.438) queda resuelto: +138.574 por la reconciliación 7B y +10.864 reclasificado como corrección legítima del doble descuento |
| **WARN** | **5** | W1 vía client-side legacy (la cierra el deploy) · **W2 la vía NC nunca revierte COGS ni restaura stock — brecha general del modelo, propuesta en §3** · W3 25 FM en efectivo sin caja · W4 15 movimientos de inventario sin referencia + `stock_processed` inconsistente · W5 2 remitos con `total_cobrado` sin filas de pago |
| **INFO** | **7** | I1 M7 corrige un doble descuento vigente · I2 `legacy_unclassified` = 0 · I3 request tables vacías · I4 multi-tenant impecable · I5 cantidades enteras 100% · I6 M6 nunca borró historia de pagos · **I7 (nuevo) el residuo de 2.186 es económicamente correcto (clase A)** |

## 9. Recomendación

# 🟢 GO — por fases, en este orden

1. **Fase A** — `20260713100000` … `20260713260000` (18 migraciones). El P&L no cambia.
2. **Fase B** — dry-run 7B → confirmar las 25 precondiciones → `ROLLBACK`→`COMMIT` con testigo → verificar V1–V10.
3. **Fase C** — `20260713270000_m7_6f4c_accrual_views.sql`. El P&L pasa al modelo corregido en un solo instante.
4. Repetir el preflight conjunto y confirmar blockers = 0.

Fases A y B pueden ir en ventanas separadas sin riesgo (ninguna cambia el P&L). **La única que debe ir después de B es la C.**

**Condición que sigue abierta y no bloquea:** confirmar con el dueño si la mercadería de la factura C volvió físicamente. Si volvió, el residuo de 2.186 pasa de A a B y merece su propia reconciliación puntual. Si no volvió —que es lo que dicen los registros— no hay nada que hacer.

---

**Me detengo acá.** No ejecuté nada en producción, no avancé con health check v2, frontend ni deploy, y no hice commit, push, deploy, backfill ni tag.
