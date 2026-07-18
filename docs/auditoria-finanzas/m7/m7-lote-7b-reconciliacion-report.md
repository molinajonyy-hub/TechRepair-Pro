# M7 — Lote 7B · Reconciliación histórica puntual (preparada, NO ejecutada)

**Fecha:** 2026-07-16 · **Estado:** script preparado con `ROLLBACK` por defecto y simulado localmente.
**Cero escrituras en producción.** Sin commit, push, deploy, backfill ni tag.

---

## 1. Identificación exacta del remito

Recuperada de producción por **ID exacto**, nunca por monto ni fecha:

| campo | valor |
|---|---|
| `comprobante_id` | `ac3b00ef-44c4-4978-b51b-289797f7fbe1` |
| `business_id` | `aa930802-0861-46ce-896c-7f68b181cb39` |
| tipo / número | `remito` · `0001-00000003` |
| fecha original | `2026-05-08 14:11:46.431+00` → AR **2026-05-08** |
| estado / estado_comercial / status | `anulado` / `anulado` / `cancelled` |
| estado_fiscal | `anulado_fiscal` |
| CAE / número fiscal | **NULL / NULL** |
| total | **1.235.580,00** |
| costo histórico (`SUM(costo_total)`) | **1.097.006,00** |
| venta (`SUM(subtotal)`) | 1.235.580,00 |
| `customer_id` / `order_id` | `44c18a1d…e94b` / NULL |
| actor (`created_by`) | `dadbf8b6-ee73-453e-a203-6f3c477ef960` (= `owner_user_id` del negocio) |
| ítems (3) | `3ce65733-6f07-4e72-a201-aa7403f8d720`, `b5498383-ccc2-4777-851e-944b670e8546`, `e23e9ad5-f6d6-4666-bc2a-e5c9d47d46f0` |
| inventarios (3 distintos) | `114c5835…4137`, `8bfa66ad…2196`, `da541466…ae23` |
| `created_at` / `updated_at` | 2026-05-08 14:11:46 / **2026-05-12 15:03:21** |

## 2. Evidencia de que fue una anulación legacy

| movimiento | cantidad | primero | último |
|---|---|---|---|
| `sale` | 3 | 2026-05-08 14:11:47.357 | 14:11:48.673 |
| `return` | 3 | 2026-05-08 14:13:06.995 | **14:13:08.138** |

La venta se cargó y **81 segundos después** se devolvió el stock. No existe fila en `comprobante_annulments` (0), ni nota de crédito (0), ni CAE. Es la firma exacta de `facturacionService.anularComprobante()`: repuso stock, marcó el estado y no dejó registro canónico.

> **Discrepancia que declaro explícitamente:** `updated_at` del comprobante es **2026-05-12**, cuatro días después de la restauración de stock. Tomo **2026-05-08** como fecha económica —tal como aprobaste— porque la evidencia del *hecho económico* son los movimientos `return` del 05-08, no un `updated_at` que pudo moverse por cualquier update posterior. La precondición P23 lo verifica contra esos movimientos, no contra `updated_at`. **Ambas fechas caen en 2026-05**, así que el P&L mensual es idéntico en cualquier caso; la elección sólo afecta la granularidad diaria, y el 05-08 hace que **el día neteé a cero**.

## 3. Stock ya restaurado

3 movimientos `return` (uno por inventario, ninguno duplicado — P21/P22). El script **no toca stock**. Nota: los 3 ítems conservan `stock_processed = true` pese a la restauración; es la inconsistencia de marcador W4 del informe 7A, inofensiva y fuera del alcance de este lote.

## 4. Ausencia de efectos financieros

`financial_movements = 0` · `business_finance_entries = 0` · `account_movements = 0` · notas de crédito = 0. Existe **1 fila de pago** (transferencia 1.235.580) que nunca produjo movimiento financiero. **No hay absolutamente nada que compensar**, y por eso la reconciliación no crea compensación alguna.

## 5. Fila exacta que se propondría insertar

En `comprobante_annulments`, usando el esquema real vigente de M7 (sin columnas inventadas, sin migración de esquema):

| columna | valor | justificación |
|---|---|---|
| `business_id` | `aa930802…cb39` | del comprobante |
| `comprobante_id` | `ac3b00ef…fbe1` | ID exacto |
| `user_id` | `dadbf8b6…f960` | `created_by`, que además es el owner |
| `idempotency_key` | `m7-7b-reconcile-ac3b00ef-…-289797f7fbe1` | determinística |
| `request_hash` | sha256 canónico | mismo formato que calcula `annul_comprobante_atomic` |
| `op` | `comprobante_annulment` | |
| `mode` | **`commercial_annulment`** | ver abajo |
| `motivo` | `Reconciliación M7 de anulación legacy realizada por vía client-side` | el recomendado |
| `restore_stock` | `true` | reconstruye el hecho: el stock sí se restauró |
| `stock_restored_count` | `3` | 3 inventarios restaurados el 05-08 |
| `annulment_date` | **`2026-05-08`** | fecha económica canónica |
| `reverted_cash_ars` / `_cc_` / `_commissions_` / `_cogs_` | **0 / 0 / 0 / 0** | este registro no revierte nada: no había nada que revertir |
| `original_fm_ids` / `fm_reversal_ids` / `bfe_reversal_ids` | `{}` | no hay movimientos |
| `refund_caja_id` / `cc_reversal_movement_id` | NULL | |
| `status` | `completed` | |

**Sobre `mode`:** de los tres modos del CHECK, `commercial_annulment` es el único que **no implica devolución de dinero**, y no existe un solo `financial_movement` que reversar. Declaro la tensión: la RPC en vivo **habría rechazado** este modo, porque valida `v_cobrado <= tolerancia` y hay una fila de pago de 1.235.580. Precisamente por eso esto es una **reconciliación documental** y no una llamada a la RPC. `mode` es un campo descriptivo: el ledger no lo lee (deriva el evento de `comprobante_id` + `status` + `annulment_date`).

## 6. Actor y motivo

Actor = `created_by` del comprobante, que coincide con el `owner_user_id` del negocio: atribución real y compatible con el esquema (`user_id` es NOT NULL). Motivo = exactamente el recomendado.

## 7. Idempotencia — triple

1. **Precondición P12** bajo lock: si ya existe registro, `RAISE` y aborta sin escribir.
2. **`WHERE NOT EXISTS`** en el propio INSERT: no-op declarativo.
3. **Índice único parcial** `idx_comprobante_annulments_comp (comprobante_id) WHERE status='completed'`: la base lo impide aunque se cambie la key.

Verificado (ID1–ID3): segunda ejecución → sigue habiendo **1** registro y el efecto neto sigue en 0; forzar una segunda fila con otra key **falla por índice único**.

## 8. Resultado de la simulación local

`supabase/tests/etapa7_7b_reconcile_legacy_annulment_test.sql` — **47/47**. Reproduce el estado productivo exacto de ambos comprobantes (incluida la fila de pago sin FM y la ventana de 81 segundos).

**ANTES**

```
registro de anulación     = 0
eventos del ledger        = 3 sale, 0 annulment
venta sin compensar       = 1.235.580
P&L 2026-05-08            = 1.235.580
```

**DESPUÉS**

```
registro de anulación     = 1   · annulment_date = 2026-05-08 · status = completed
venta original            = CONSERVADA en 2026-05-08 (+1.235.580)
compensación derivada     = -1.235.580 en 2026-05-08 (mismo día)
efecto neto ventas / COGS = 0 / 0
P&L 2026-05-08            = 0
```

**Nada más cambió** (D15–D22): stock idéntico, **0** `financial_movements` nuevos, **0** BFE, **0** `account_movements`, **0** `inventory_movements`, **0** pagos, cashflow acumulado idéntico, y el `updated_at` del comprobante **intacto** — el comprobante no se modifica.

## 9. P&L antes / después

| período | concepto | antes | después |
|---|---|---|---|
| 2026-05-08 | ventas | 1.235.580 | **0** |
| 2026-05-08 | resultado | 138.574 | **0** |
| acumulado del negocio | `net_sales` | — | **0** |
| acumulado del negocio | `cogs` | — | **+2.186** |

El remito deja de introducir restatement: el período original ya no cambia respecto de lo que hoy muestra producción.

## 10. Confirmación: la factura C no fue tocada

F1–F7, todos verdes:

- **No recibe registro de anulación** (0).
- No emite evento `annulment` en el ledger: se sigue compensando por su **nota de crédito**.
- `net_sales` del 2026-05-21 = **0** (venta +13.050, returns −13.050) → **sin doble reversión**.
- Emite **un solo** evento de venta: no hay doble conteo.
- Residuo conocido y explicado: **+2.186 de COGS**, porque el CTE `returns` de la vía fiscal nunca revierte COGS (brecha preexistente que 6F.4 §5 dejó deliberadamente intacta).

## 11. Preflight posterior

PF1–PF8, todos verdes sobre el escenario reconciliado:

- Anulados sin registro canónico y sin NC: **0**.
- Doble reversión (registro interno + NC): **0**.
- Registros duplicados por comprobante: **0**.
- Anulaciones cross-business: **0**.
- Fecha de anulación anterior a la venta: **0**.
- El remito #1 **no introduce delta acumulado**.
- Constraints M7 siguen compatibles; batería completa **1749 asserts, 0 fallas**.

**Única diferencia restante frente al reporte antiguo: +2.186 de COGS de la factura C**, explicada una a una — es el doble descuento fiscal histórico que M7 corrige (hoy producción excluye la venta *y además* resta la NC).

## 12. Script preparado

`docs/auditoria-finanzas/m7/m7-7b-reconcile-legacy-annulment.sql`, con dos secciones separadas:

- **Dry-run**: sólo `SELECT`; 25 precondiciones con veredicto `OK` / `*** ABORTA ***`, evidencia de la ventana de 81 s, la fila propuesta y el efecto esperado.
- **Apply**: `BEGIN` + `statement_timeout='30s'` + `lock_timeout='3s'`, lock explícito `FOR UPDATE` del comprobante, revalidación **completa** de las 25 precondiciones bajo lock (fail-closed vía `RAISE`), INSERT mínimo (evidencia canónica + fila explicativa en `finance_ledger_reconciliation`), 10 verificaciones posteriores, y **`ROLLBACK` por defecto**.

**Fail-closed probado**: ejecutado tal cual contra la base local (donde el comprobante no existe), el dry-run marca `*** ABORTA ***` y el apply lanza `7B ABORTA P01: el comprobante no existe` → transacción abortada, **0 filas escritas**.

**`finance_ledger_reconciliation`**: encaja (`entity_table='comprobantes'` está permitido). Limitación documentada: **no tiene estado `proposed`** — su CHECK sólo admite `corrected | legacy_accepted | active_inconsistency | indeterminate`. Uso `corrected`, que es exacto en el momento del apply. La fila registra entidad, negocio, comprobante, inconsistencia, evidencia, decisión, fecha reconstruida, referencia al informe 7A y **`movimientos_creados_por_esta_reconciliacion = 0`** en todas las tablas.

## 13. Riesgos restantes

1. **⚠️ Orden de ejecución obligatorio.** El registro **debe** llevar `annulment_date = 2026-05-08` explícita, y esa columna sólo existe tras aplicar 6F.4. Insertado **antes** del deploy, el ledger derivaría la fecha de `created_at` (= hoy, julio) y pondría la compensación en **el mes equivocado**. Por eso: **desplegar M7 primero, y este script inmediatamente después, en la misma ventana**. Entre ambos pasos el P&L de 2026-05 muestra el restatement de +138.574. La precondición P25 lo bloquea si se intenta antes.
2. **`mode='commercial_annulment'` con una fila de pago viva.** La RPC habría rechazado esa combinación. Es coherente como documento (no hubo movimiento financiero), pero un lector futuro puede encontrarlo contradictorio. Mitigado por el `motivo` y por la fila de `finance_ledger_reconciliation`.
3. **La fila de pago de 1.235.580 sigue viva** sobre un comprobante anulado. No afecta cashflow (no hay FM), pero `total_cobrado` del header sigue diciendo 1.235.580. No lo toco: sería reescribir historia.
4. **`stock_processed = true`** en los 3 ítems pese al stock restaurado (W4 de 7A). Inofensivo: la RPC rechazaría el comprobante por `ALREADY_ANNULLED` antes de mirarlo.
5. **La fecha 2026-05-08 es una reconstrucción**, no un dato registrado. Está fundada en los movimientos `return`; `updated_at` (05-12) discrepa. Ambas caen en el mismo mes.
6. **+2.186 de COGS de la factura C** sin reversar: brecha de la vía NC, fuera de alcance.

## 14. Recomendación final

**Ejecutar en producción — condicionado a tres cosas:**

1. **Después** del deploy de M7, en la misma ventana de mantenimiento.
2. Correr primero la **sección dry-run** y confirmar que las **25 precondiciones dicen OK** (contra producción darán todas OK; localmente dan ABORTA porque el comprobante no existe ahí).
3. Cambiar `ROLLBACK` → `COMMIT` **manualmente, con testigo humano**, tras leer el bloque POST-APPLY en la misma sesión.

Con eso, el único BLOCKER del informe 7A queda cerrado y M7 pasa de **CONDITIONAL GO** a **GO**.

### Seguridad operativa (§10)

**No usar el MCP de Supabase conectado como `postgres` para el apply.** Comando recomendado:

> ⚠️ **Corregido en el Lote 7B.1.** La versión anterior de este informe usaba `--single-transaction`, que es **incompatible** con un script que maneja su propia transacción: psql abriría un `BEGIN` externo y el `BEGIN`/`ROLLBACK` del archivo quedarían anidados de forma ambigua — el `ROLLBACK` del archivo podría abortar la transacción externa y dejar el resto del script sin ejecutar, o peor, un `COMMIT` del archivo cerraría la transacción de psql antes de tiempo. **La transacción la controla el archivo, no psql.**

```bash
# 1. Verificar el proyecto ANTES de conectar
supabase projects list          # confirmar ref vrdxx…mbwx = techrepair-pro

# 2. La transacción la controla EL ARCHIVO. Sin --single-transaction.
psql -X -v ON_ERROR_STOP=1 --echo-all \
     --file="docs/auditoria-finanzas/m7/m7-7b-reconcile-legacy-annulment.sql" \
     "$DATABASE_URL_PRODUCCION"

# 3. El archivo termina en ROLLBACK. Sólo tras aprobación humana explícita se
#    edita a COMMIT y se vuelve a correr.
```

| flag | por qué |
|---|---|
| `-X` | ignora `~/.psqlrc`: evita que una configuración local inesperada (por ejemplo `AUTOCOMMIT off`, `ON_ERROR_ROLLBACK`, o un `\set` con formato) altere el comportamiento del script |
| `-v ON_ERROR_STOP=1` | aborta en el primer error en vez de seguir ejecutando sentencias sobre una transacción ya rota |
| `--echo-all` | deja en el log cada sentencia ejecutada: evidencia auditable de qué se corrió |
| `--file=` | ejecución no interactiva y determinística |
| **sin** `--single-transaction` | la transacción es del archivo; `ROLLBACK` es el valor por defecto y `COMMIT` se habilita a mano sólo tras aprobación |

**Verificado**: en `m7-7b-reconcile-legacy-annulment.sql` **no hay ninguna sentencia después del `ROLLBACK`/`COMMIT`**. Las 10 verificaciones críticas (V1–V10) y el chequeo de efecto neto del ledger corren **dentro de la misma transacción**, antes de la decisión final — de modo que quien aprueba el `COMMIT` ya leyó el resultado real del apply en esa misma sesión.

Para **diagnósticos** productivos futuros: habilitar el flag `--read-only` del MCP de Supabase, o crear un rol dedicado

```sql
-- (a ejecutar por el DBA, fuera de este lote)
CREATE ROLE readonly_diag LOGIN PASSWORD '…';
GRANT pg_read_all_data TO readonly_diag;
```

y conectar los dry-runs con ese rol. Hoy la garantía depende de que cada llamada lleve `SET TRANSACTION READ ONLY`; con un rol read-only sería estructural.

---

**Me detengo acá.** No ejecuté el apply en producción, no avancé con health check v2, y no hice commit, push, deploy, backfill ni tag.
