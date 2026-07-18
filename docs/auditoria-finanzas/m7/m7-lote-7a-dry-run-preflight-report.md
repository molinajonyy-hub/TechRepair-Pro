# M7 — Lote 7A · Dry-run histórico y preflight productivo conjunto

**Fecha:** 2026-07-16 · **Alcance:** solo lectura, diagnóstico y clasificación de riesgos.
**No se aplicó ninguna corrección.** Sin commit, push, deploy, backfill ni tag.

---

## 1. Entorno consultado

| Dato | Valor |
|---|---|
| Proyecto Supabase | `techrepair-pro` (único de la organización) |
| Project ref | `vrdxx…mbwx` (enmascarado) |
| Host | `db.vrdxx…mbwx.supabase.co` |
| `current_database()` | `postgres` |
| `current_user` | `postgres` |
| Réplica | `pg_is_in_recovery() = false` → **es el primario de producción** |
| Zona horaria del servidor | UTC (el modelo deriva la fecha AR con `AT TIME ZONE 'America/Argentina/Cordoba'`) |
| Hora del servidor | 2026-07-16 17:27 UTC |
| PostgreSQL | 17.6 (aarch64) |
| Commit productivo | `2f63322` (HEAD local == remoto; no hay commits pendientes de M7) |
| **M7 desplegado** | **NO** — verificado por catálogo |

Es inequívocamente producción de TechRepair Pro: único proyecto de la organización, activo, primario, y con los objetos M6 que las memorias del proyecto registran como desplegados el 2026-07-05 y 2026-07-08.

### Confirmación de que M7 no está desplegado

Presentes (M6): `comprobante_annulments`, `comprobante_payment_replace_requests`, `operating_expense_reversals`, `annul_comprobante_atomic`, `replace_comprobante_payment`, `create_comprobante_checkout_atomic`, `business_finance_entries.economic_class`.

Ausentes (M7): `finance_audit_log`, `finance_period_locks`, `assert_period_open`, `finance_log_audit`, `is_comprobante_annulled`, `v_finance_sales_ledger`, `comprobante_payments.replaced_at`, `comprobante_annulments.annulment_date`, `trg_comprobante_annulment_transition`, `trg_cp_annulled_guard`.

## 2. Garantías de solo lectura

Toda consulta se ejecutó dentro de:

```sql
BEGIN; SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='3s';
SET LOCAL idle_in_transaction_session_timeout='120s';
… SELECT … ; ROLLBACK;
```

**Verificado empíricamente**: dentro de la envoltura, `current_setting('transaction_read_only') = 'on'` y `statement_timeout = 1min`. Postgres enforcea la transacción read-only — un write ahí dentro falla, no es disciplina mía.

> ⚠️ **Riesgo de control que debe conocerse.** La sesión de base es `postgres` (superusuario) y **fuera de la envoltura `transaction_read_only = 'off'`**. La garantía es **por transacción**, no por sesión: depende de que cada llamada incluya el wrapper. El control fuerte no está: el MCP de Supabase no está configurado con `--read-only` y no existe un rol de solo lectura dedicado. **Recomendación antes del próximo lote productivo:** habilitar el flag `--read-only` del MCP o crear un rol `readonly` y conectar con él.

Solo se ejecutaron `SELECT`, catálogos `pg_*`, `information_schema` y CTEs. Cero `INSERT/UPDATE/DELETE/DDL/GRANT/CALL`. No se invocó ninguna RPC. No se ejecutó `db push` ni despliegue de funciones.

## 3. Inventario de migraciones M7 (18 archivos, ~355 KB, ninguno aplicado)

| Migración | Objeto principal | Tipo de cambio | Riesgo de compat. | Preflight |
|---|---|---|---|---|
| `…100000_finance_audit_log` | `finance_audit_log`, `finance_log_audit`, `finance_begin_audit_scope`, backstop E1 | tabla + funciones + triggers | Bajo (tabla nueva) | §11 |
| `…110000_finance_period_locks` | `finance_period_locks`, `assert_period_open` | tabla + función | Bajo (tabla nueva) | §11 |
| `…120000_finance_ledger_reconciliation` | vistas de conciliación | vistas nuevas | Bajo | §10 |
| `…130000_e1e2_period_guard` | guards de período E1/E2 | triggers | **Medio** — bloquea escrituras en períodos cerrados | §11 |
| `…140000_6a_owner_flows_guard` + `…141000_6a1` | owner flows | RPC | Bajo | §11 |
| `…150000_6b_expense_cash_guard` | gastos y caja | RPC | Bajo | §9 |
| `…160000_6c_customer_order_guard` | pagos de órdenes | RPC | Bajo | §8 |
| `…165000_6d2b_supplier_method_helper` | `normalize_supplier_payment_method` | función IMMUTABLE | Bajo | §4 |
| `…170000_6d1` / `…180000_6d2` | proveedores | RPC | Bajo | §4 |
| `…200000_6e1_quick_purchase_guard` | compra rápida | RPC | **Medio** — exige cantidades enteras | §4 CN1 |
| `…210000_6e2_checkout_guard` | checkout | RPC + `compute_checkout_intent_hash` | **Medio** — contrato frontend | §7 |
| `…220000_6f1` / `…230000_6f2` | reversas de gastos y de pagos de orden | RPC | Bajo | §11 |
| `…240000_6f3_payment_replacement_append_only` | `comprobante_payments.replaced_at/replaced_by/replacement_payment_id`, índice parcial, guard, request table | **columnas + índices + triggers + parches quirúrgicos a 6 objetos** | **Alto** | §7 |
| `…250000_6f4_annulment_accrual_ledger_and_guard` | `v_finance_sales_ledger`, `v_finance_pnl`, `v_finance_product_margin`, `comprobante_annulments.annulment_date`, `bfe_economic_class`, transition guard, RPC | **vistas financieras + columna + trigger** | **Alto — restatement** | §5, §6 |
| `…260000_6f4a_annulled_invariants` | `is_comprobante_annulled`, `comprobante_state_is_annulled`, `trg_cp_annulled_guard`, parche a `replace` | funciones + trigger | **Medio** — cierra vías de escritura | §12 |

Dependencias: `6d2b` precede a `6d1/6d2` (por eso su timestamp es menor); `6f4a` parchea la función que crea `6f3` y usa la tabla que altera `6f4`; el orden de timestamps ya las resuelve.

## 4. Preflight conjunto y guard estático

- **`docs/auditoria-finanzas/m7/m7-preflight-productivo-conjunto.sql`** — consolida los preflights de todos los lotes (auditoría, períodos, owner flows, gastos/caja, pagos de clientes y órdenes, proveedores, compra rápida, checkout, reversas, 6F.3, 6f4-preflight-anulaciones, 6F.4a). Duplicados unificados; cobertura preservada. Todo chequeo que dependa de un objeto M7 se protege con `to_regclass()`/`information_schema` y devuelve "n/a" en vez de fallar: **ningún SELECT referencia una columna inexistente**.
- **`scripts/finance/guard-readonly-sql.mjs`** — guard estático que despoja comentarios y literales antes de buscar `INSERT/UPDATE/DELETE/MERGE/ALTER/CREATE/DROP/TRUNCATE/GRANT/REVOKE/COMMENT/CALL/DO/COPY…FROM/PERFORM/db push/migration up`.

**Resultado del guard:** ✅ ambos archivos limpios. Prueba negativa: detecta un `INSERT` inyectado e **ignora** `UPDATE`/`DROP TABLE` mencionados dentro de un comentario. Exit 1 correcto.

## 5. Resumen ejecutivo

Producción es **pequeña y notablemente sana**: 235 comprobantes, 233 pagos, 399 ítems, 259 movimientos financieros, 360 BFE, 20 negocios. **Integridad multi-tenant perfecta (10/10 en cero)**, sin referencias rotas, sin cantidades decimales, sin métodos fuera de catálogo, sin `legacy_unclassified`, cuenta corriente consistente.

El riesgo se concentra en **un solo hecho**: hay **2 comprobantes anulados y 0 registros en `comprobante_annulments`**. Las dos anulaciones se hicieron por fuera de la RPC canónica. Como el ledger de 6F.4 deriva la compensación **desde el registro de anulación**, sin registro no hay evento compensatorio: la venta reaparece en su período original y **el restatement no netea a cero**.

| Severidad | Cantidad |
|---|---|
| **BLOCKER** | **1** |
| **WARN** | **5** |
| **INFO** | **6** |

## 6. Restatement por negocio y período

| business_id | mes | ventas actual | ventas corregida | Δ ventas | COGS actual | COGS corregido | Δ COGS | Δ resultado |
|---|---|---|---|---|---|---|---|---|
| `aa930802…cb39` | 2026-05 | 6.196.015 | 7.444.645 | **+1.248.630** | 2.758.547 | 3.857.739 | **+1.099.192** | **+149.438** |

Ningún otro negocio ni mes cambia. **Δ acumulado ≠ 0** → condición de bloqueo del §8 del pedido.

### Detalle por comprobante

| # | comprobante | tipo / número | fecha orig. | fecha anulación | total | COGS | Δ resultado | período que hoy pierde la venta | período de compensación | NC | calidad de fecha |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `ac3b00ef…fbe1` | remito 0001-00000003 | 2026-05-08 | **desconocida** (sin registro; `updated_at` 2026-05-12) | 1.235.580 | 1.097.006 | **+138.574** | 2026-05 | **ninguno** | no | ❌ inexistente |
| 2 | `95cbf330…3a62` | factura_c 0010-00000001 (CAE) | 2026-05-21 | **desconocida** (sin registro; `updated_at` 2026-05-21) | 13.050 | 2.186 | +10.864 | 2026-05 | vía NC (2026-05) | **sí** | ❌ inexistente |

Ninguno tiene fecha de anulación explícita ni derivable de `created_at` de un registro: **no hay registro**. `updated_at` del comprobante es el único rastro y no es una fecha económica confiable.

### Rastro económico reconstruido

**#1 (remito, BLOCKER).** Venta creada 14:11:47–48 (3 movimientos `sale`, pago transferencia 1.235.580). Anulada 14:13:06–08 (**3 movimientos `return`** → el stock **sí** se restauró). **Cero `financial_movements`. Cero BFE.** Sin nota de crédito. Es la vía client-side legacy: repuso stock, marcó el estado y dejó (o borró) el rastro financiero. Sus 3 ítems siguen con `stock_processed = true` pese a haberse restaurado el stock.

**#2 (factura_c con CAE, WARN).** Venta 14:01 con pago transferencia 13.050, FM income 13.050 y BFE mirror `revenue_collection_mirror`. **Nota de crédito emitida a las 21:02** (estado `emitido`, total 13.050) y original marcado `anulado_fiscal`. Es **la vía fiscal legítima** (`create_credit_note_from_comprobante` exige CAE; por eso no hay registro de anulación: la NC nunca lo crea).

> **Corrección (Lote 7B.1).** Aquí decía que «el FM de ingreso no está reversado». Es engañoso: el FM de ingreso original efectivamente conserva `reversed_at = NULL`, pero **la NC sí emitió su propia compensación** — un FM `expense/comprobante sign=-1` de 13.050 y un BFE mirror de **−13.050**, ambos a las 21:08. **El efectivo de #2 netea a cero**; la vía NC compensa con un asiento contrario, no marcando `reversed_at`. Lo que sí es cierto y se confirma: **el stock nunca se restauró** (el inventario afectado no tiene un solo movimiento `return` en toda su historia).

### Hallazgo colateral: hoy la NC produce un doble descuento que M7 corrige

Para #2, el modelo **actual** excluye la venta (por `estado='anulado'`) **y además** resta la NC en el CTE `returns` → el P&L de mayo carga **−13.050 dos veces reversados**. Bajo M7: venta +13.050 en mayo, NC −13.050 en su período → neto 0. **M7 arregla un doble descuento existente en producción.** Queda un residuo de **+2.186 de COGS sin reversar**, que es la brecha conocida de la vía NC (el CTE `returns` nunca revierte COGS) y que 6F.4 §5 dejó explícitamente sin tocar.

## 7. Hallazgos por módulo

### Multi-tenant (§7) — ✅ limpio
MT1–MT10 **todos en 0**: comprobante↔cliente, ↔orden, pago↔comprobante, FM↔comprobante, BFE↔entidad, ítem↔inventory, account_movement↔account, inventory_movement↔inventory, FM↔caja, ítem↔comprobante. **Ningún BLOCKER multi-tenant.**

### Compatibilidad de constraints (§6) — ✅ pasarían
- `cantidad` decimal: **0** → la regla de unidades enteras de 6E.1a es satisfacible.
- `cantidad <= 0`: 0. `subtotal/costo/precio` NULL: 0.
- Métodos fuera del catálogo del checkout: **0**.
- `amount_ars <= 0`: 0.
- Referencias huérfanas (pagos, ítems, inventory_id, NC→original): **0**.
- Índices únicos M7 (`UNIQUE(business_id, idempotency_key)`, parcial por comprobante): las tres request tables están **vacías** → no hay duplicados posibles.
- `comprobante_payments.replaced_at` y `comprobante_annulments.annulment_date` se agregan como **nullable** → ninguna fila existente las viola.

### P&L y BFE legacy (§13) — ✅ mejor de lo esperado
`legacy_unclassified` **= 0 filas**. `source='annulment'` = 0. `economic_class` NULL = 0. **La nota de 6F.4a sobre mirrors históricos resulta vacía en producción**: no hay deuda de clasificación que explicar ni riesgo de falso positivo en el health check v2. (La nota sigue siendo válida como prevención.)

### Cuenta corriente (§11) — ✅ limpio
1 cuenta, 1 movimiento. Saldo persistido == suma canónica (0 diferencias). Sin movimientos sin cuenta, sin duplicados, sin anulados a CC sin compensar. **Módulo prácticamente sin uso.**

### Caja y cashflow (§12)
- Más de una caja abierta por negocio: **0**.
- FM en caja de otro negocio: **0**. FM de anulación duplicados: **0**. `reversed_at` seteado: **0**.
- **FM efectivo sin caja: 25** → WARN legacy.

### Inventario (§14)
- Decimales, cantidades ≤ 0, inventory_id inexistente, cross-business, restauraciones duplicadas: **todos 0**.
- **Movimientos sin referencia: 15** → WARN.
- Caso #1: stock restaurado pero `stock_processed` sigue en `true` → WARN (inofensivo hoy porque la RPC rechazaría el comprobante por `ALREADY_ANNULLED`).

### Idempotencia (§15) — ✅ trivial
Las tres request tables (`comprobante_annulments`, `comprobante_payment_replace_requests`, `operating_expense_reversals`) tienen **0 filas**. No hay keys duplicadas, vacías, hashes nulos, estados desconocidos, `processing` antiguas, ni links rotos. **El riesgo MD5→SHA-256 es nulo**: no existe ni una request previa que pueda entrar en conflicto en un retry.

### Seguridad (§16)
Funciones `SECURITY DEFINER` que tocan `comprobantes` o insertan pagos:

| función | owner | search_path | authenticated | anon |
|---|---|---|---|---|
| `annul_comprobante_atomic` | postgres | `public` | ✅ (canónica) | ❌ |
| `complete_arca_attempt` | postgres | `public` | ❌ | ❌ |

Ninguna función con `search_path` ausente. Ninguna vía SECURITY DEFINER alternativa invocable por `authenticated` capaz de anular o cobrar saltándose la RPC.

**Pero sí existen vías directas por grant/RLS — que son exactamente las que M7 cierra:**

| vía | hoy | tras 6F.4/6F.4a |
|---|---|---|
| `authenticated` INSERT en `comprobante_payments` | ✅ **abierta** | bloqueada en anulados por `trg_cp_annulled_guard` |
| `authenticated` UPDATE en `comprobantes` | ✅ **abierta** | transición a/desde anulado bloqueada por `trg_comprobante_annulment_transition` |
| `authenticated` UPDATE/DELETE en `comprobante_payments` | ❌ | ❌ |
| `anon` INSERT en `comprobante_payments` | ❌ | ❌ |

Esas dos vías abiertas **son la causa comprobada del BLOCKER**: así se anularon los 2 comprobantes. No las clasifico como BLOCKER del deploy porque **el deploy es su remedio**.

### Consumidores frontend y jobs (§17)

| consumidor | clasificación | nota |
|---|---|---|
| `facturacionService.anularComprobante()` (`src/services/facturacionService.ts:698`) | **código muerto alcanzable** | Hace `UPDATE comprobantes SET estado='anulado'` sin compensación. Ningún componente destructura `anularComprobante` de `useComprobantes`. **Es la firma exacta del BLOCKER #1.** Tras 6F.4 la base lo rechaza. |
| `comprobanteService.registrarPago()` (`:911`) | **código muerto alcanzable** | INSERT directo en `comprobante_payments`. Sin consumidor. Tras 6F.4a queda bloqueado solo sobre anulados. |
| `comprobanteService.anular()` | **activo** | `Comprobantes.tsx:62`, `Comprobante.tsx:193` → RPC canónica. Contrato `{ok, error, requiere_nota_credito}` preservado por M7. |
| `comprobanteService.actualizarCobro()` | **activo** | → `replace_comprobante_payment`. |
| `comprobanteService.crear()` | **activo** | → checkout. Compara `status` estrictamente. |
| request/reversal tables | **sin consumidor** | Nadie las lee desde `src/`; pasarlas a fail-closed no rompe nada. |
| jobs que muten request tables | **ninguno** | `scripts/finance/run-m6-validation.mjs` es validación local. |

## 8. Clasificación de hallazgos

### 🔴 BLOCKER (1)

**B1 — Restatement inexplicable: +149.438 de resultado en 2026-05 sin compensación.**
Los 2 comprobantes anulados no tienen registro en `comprobante_annulments`, así que `v_finance_sales_ledger` no puede derivar su evento `annulment`. Al desplegar M7, sus ventas reaparecen en mayo 2026 y **nunca se netean**: Δ ventas +1.248.630, Δ COGS +1.099.192, Δ resultado **+149.438** para el negocio `aa930802…`. De ese total, **+138.574 corresponde a #1** (sin NC, sin compensación de ningún tipo) y **+10.864 a #2** (netado por su NC salvo +2.186 de COGS).
Impacto: el P&L histórico de mayo de ese negocio cambia de forma visible y permanente. Viola el invariante del §8 ("delta acumulado = 0").

### 🟡 WARN (5)

- **W1 — Vía client-side legacy comprobadamente usada.** `facturacionService.anularComprobante()` está sin consumidor hoy, pero **ya produjo** las 2 anulaciones incompletas. Es código muerto *alcanzable*: cualquiera con sesión puede reproducirlo por PostgREST hasta que M7 se despliegue.
- **W2 — La vía NC nunca revierte COGS.** #2 deja +2.186 de COGS en mayo bajo M7. Es la semántica preexistente del CTE `returns`, que 6F.4 §5 dejó intacta a propósito. Requiere decisión de producto.
- **W3 — 25 FM en efectivo sin caja** (`caja_id IS NULL`). Clasificación legacy, no error económico; no rompe ningún constraint M7.
- **W4 — 15 movimientos de inventario sin referencia** y `stock_processed=true` en #1 pese al stock restaurado. Inconsistencia de marcadores legacy, sin impacto económico.
- **W5 — 2 remitos con `total_cobrado` sin filas de pago** (`cb590249…`: 332.000; `de5b7c70…`: 7.500). Header escrito a mano en la era pre-trigger. M7 no reescribe headers existentes; no falla ningún constraint. Distorsiona cualquier conciliación header-vs-pagos.

### 🔵 INFO (6)

- **I1** — M7 corrige un **doble descuento existente**: hoy la venta de #2 se excluye *y* su NC se resta.
- **I2** — `legacy_unclassified` = 0: la deuda de clasificación anticipada por 6F.4a **no existe** en producción.
- **I3** — Request tables vacías: idempotencia sin riesgo de conflicto; el residuo MD5→SHA-256 es inexistente.
- **I4** — Multi-tenant impecable en los 10 cruces.
- **I5** — Cantidades enteras al 100%: la regla de 6E.1a es compatible sin excepciones.
- **I6** — Historia eliminada por M6 (§10 categoría 2): **no aplica** — 0 requests de reemplazo, así que M6 nunca borró filas de pago en producción.

## 9. Constraints que pasarían o fallarían

**Todos pasarían.** Columnas nuevas nullable; índices únicos sobre tablas vacías; CHECK de métodos satisfecho; cantidades enteras; sin huérfanos ni cross-business. **Ninguna migración M7 fallaría al aplicarse.** El BLOCKER no es un fallo de constraint: es una consecuencia **semántica** correcta del ledger sobre datos históricos incompletos.

## 10. Impacto esperado del deploy

1. **Contable:** el P&L de 2026-05 del negocio `aa930802…` sube +149.438 de resultado. Ningún otro negocio/mes cambia.
2. **Correctivo:** desaparece el doble descuento de la NC de #2.
3. **Seguridad:** se cierran las dos vías directas (INSERT de pagos y UPDATE de estado) que causaron el problema.
4. **Operativo:** el guard de períodos empieza a rechazar escrituras en períodos cerrados — no hay ninguno cerrado hoy (`finance_period_locks` no existe), así que el impacto inmediato es nulo.
5. **Frontend:** contratos preservados; cero cambios en `src/` en todo M7.

## 11. Plan de resolución del BLOCKER

**No ejecutar nada de esto en este lote.** Opciones, en orden de preferencia:

**Opción A — Registrar canónicamente las 2 anulaciones históricas (recomendada).**
Insertar 2 filas en `comprobante_annulments` (`status='completed'`, `annulment_date` explícita) que representen los hechos ya ocurridos. El ledger derivaría entonces el evento `annulment` y el restatement netearía a 0. Requiere decidir la fecha económica: `updated_at` del comprobante es el mejor dato disponible (#1: 2026-05-12; #2: 2026-05-21). **Es un backfill** — necesita tu autorización explícita y su propio lote, con dry-run previo. Para #2 hay que decidir si corresponde registro de anulación además de la NC: si se registra, **la compensación se duplicaría con el CTE `returns`** → probablemente solo #1 deba registrarse.

**Opción B — Excluir del ledger los anulados sin registro canónico.**
Agregar al `eff` de `v_finance_sales_ledger` la condición de que un anulado sin registro no emita evento `sale`. Preserva exactamente el comportamiento actual para esos 2 y evita el backfill, pero **perpetúa la exclusión retroactiva** para ellos y agrega una rama de compatibilidad legacy a la vista canónica. Es un cambio de migración, no de datos.

**Opción C — Aceptar el restatement y documentarlo.**
Declarar que mayo 2026 de ese negocio se corrige a +149.438 porque la venta de #1 **efectivamente ocurrió y su anulación nunca se registró**. Contablemente defendible sólo si el dueño confirma que la venta de 1.235.580 debe contarse; el rastro (stock devuelto a los 78 segundos, sin FM) sugiere lo contrario — parece una carga errónea anulada de inmediato.

Mi lectura del rastro de #1: venta cargada y anulada a los ~78 segundos, con stock devuelto y sin ningún movimiento financiero. **Se parece a un error de carga, no a una venta real.** Si el dueño lo confirma, la Opción A con `annulment_date = 2026-05-08` (mismo día) es la más fiel: la venta y su compensación se netean dentro de mayo y el mes queda igual que hoy.

## 12. Decisión recomendada

# 🟡 CONDITIONAL GO

M7 puede desplegarse **en cuanto se resuelva B1**. La base productiva está limpia en todo lo demás: ninguna migración fallaría, no hay cross-business, ni duplicados económicos, ni doble reversión, ni vías SECURITY DEFINER alternativas, ni deuda de clasificación, ni requests conflictivas.

**Condición única de GO:** decidir el tratamiento de los 2 comprobantes anulados sin registro canónico (Opción A, B o C) y ejecutarla con su propio dry-run.

No recomiendo NO-GO: el problema está acotado a 2 filas de un negocio y un mes, es perfectamente explicable, y **el deploy además cierra las vías que lo causaron y corrige un doble descuento vigente**.

---

## 13. Trazabilidad de la ejecución

| Métrica | Valor |
|---|---|
| Consultas ejecutadas contra producción | **8** (todas `SELECT`, todas en transacción read-only) |
| Consultas fallidas | 1 (error de sintaxis propio: `UNION` con distinto número de columnas; reescrita — no tocó datos) |
| Consultas omitidas | Ver abajo |
| Duración total | ~4 minutos |
| Timeouts | **0** (`statement_timeout=60s`, `lock_timeout=3s` nunca alcanzados) |
| Filas devueltas | ~90 en total; ninguna consulta superó 30 filas |
| Escrituras | **0** |
| RPC invocadas | **0** |

**Consultas omitidas y motivo:**

- Chequeos sobre `replaced_at`, `annulment_date`, `finance_period_locks`, `finance_audit_log`, `v_finance_sales_ledger`, `is_comprobante_annulled`: **omitidas porque los objetos no existen** (M7 no desplegado). En el archivo conjunto quedan protegidas por `to_regclass()`/`information_schema`.
- `EXPLAIN`: innecesario — el mayor conjunto es de 399 filas.
- Ejecución del archivo `m7-preflight-productivo-conjunto.sql` completo vía `psql`: **omitida** porque no tengo un canal `psql` directo a producción; el MCP ejecuta sentencia por sentencia y no interpreta `\echo`/`\i`. Todos sus chequeos se ejecutaron igual, adaptados, en las 8 consultas. El archivo queda como entregable para correr con `psql` en la ventana de deploy.
- Reconciliación de stock actual vs movimientos: **omitida** — requiere la vista canónica de conciliación que M7 aún no despliega.
