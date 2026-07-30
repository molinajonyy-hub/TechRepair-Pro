# P0-A.1 — Informe local (entrega **parcial**)

**Fecha:** 2026-07-30 · Rama `fix/p0a1-order-completion-payment-status` · commit `def017a`
Baseline: `origin/main` = 4675ab6 (+ c1e8425 docs) · prod = 206 migraciones · Health Check critical 0
**No publicado, sin PR, sin deploy, sin datos productivos modificados, P0-B no ejecutado.**

> ## ⚠️ Alcance entregado
> **Completo y validado:** §1 inventario · §2 estrategia · §3 regla de cálculo · §4 atomicidad ·
> §5 transiciones · §6 recompute único · §7-§8 CC/parciales/anulaciones · §13 auditoría ·
> §14 (18 de 24 casos, los server-side) · §19 (validación + flujo completo) · §20 rama y commit.
>
> **NO entregado en este lote:** §9 UI · §10 filtros · §11 reemplazo de `service_with_cogs` ·
> §12 health checks de estado de órdenes · §15 dry-run del backfill de estados · §18 guards nuevos.
>
> No lo reduje por decisión propia: es lo que quedó fuera del presupuesto de este turno.
> Las razones y el orden sugerido están en §22. El núcleo server-side —la parte que **tiene**
> que ser correcta porque toca dinero— está entregado, probado y sin regresiones.

---

## 1. Inventario del modelo actual

| Concepto | Fuente actual | Persistido o derivado | Escritor canónico |
|---|---|---|---|
| Estado técnico | `orders.status` — CHECK de 9 valores: `new, diagnosis, waiting_approval, repair, waiting_parts, ready_delivery, waiting_payment, completed, cancelled` | persistido | **ninguno**: lo escribía el frontend con UPDATE directo |
| Total comprobado | `comprobantes.total` / `total_bruto` / `total_ars` | persistido | `create_comprobante_checkout_atomic` |
| Total pagado | `comprobantes.total_cobrado` | persistido | trigger `trig_comprobante_payment_sync` |
| Saldo | `comprobantes.saldo_pendiente` | persistido | mismo trigger |
| Estado financiero del **comprobante** | `comprobantes.estado_comercial` (`pendiente/parcial/pagado/anulado`) | persistido | mismo trigger + `annul_comprobante_atomic` |
| Estado financiero de la **orden** | **no existía** | — | — |
| Comprobante vinculado | `comprobantes.order_id` (3/277) **y** `orders.comprobante_id` (3/93) — dos vías paralelas | persistido | checkout (P0-A) / M6 |
| Timestamps de orden | solo `created_at` / `updated_at`. **No había `completed_at`, `closed_at`, `delivered_at` ni `paid_at`** | — | — |
| Historial de estados | `status_history(order_id, business_id, status, note, created_by)` | persistido | frontend |
| Auditoría financiera | `finance_audit_log` | persistido | `finance_log_audit()` |

**Tres campos que parecían servir y no sirven** — verificado contra datos productivos:

- **`orders.amount_paid`**: huérfano. Ningún trigger ni RPC lo mantiene (`trigger_payment_creates_movements` no lo toca). **1 sola fila ≠ 0** en todo el histórico.
- **`comprobantes.payment_status`**: **muerto**. 220 filas en `'pending'` con `saldo_pendiente = 0` y `estado_comercial = 'pagado'`. Nadie lo escribe desde su default.
- **`orders.comprobante_id`**: vía paralela a `comprobantes.order_id`, ambas con 3 filas. Reutilizarla habría creado una segunda fuente contradictoria.

Ninguno de los tres se usa en la solución.

**Cardinalidad:** hoy **0** órdenes tienen más de un comprobante, pero **no hay constraint** que lo impida. No se introdujo uno (§3 prohíbe imponerlo en silencio): la vista **agrega por orden**, así que N comprobantes funcionan sin supuesto 1:1.

**RPCs relevantes:** `create_comprobante_checkout_atomic`, `create_order_payment_atomic`, `reverse_order_payment_atomic`, `replace_comprobante_payment`, `record_customer_account_payment_atomic`, `annul_comprobante_atomic`. Ninguna fue modificada.

## 2. Estrategia: **derivar** (§2, opción 2)

No existía un campo canónico reutilizable, así que se descartó la opción 1. Se eligió **derivar**, no persistir:

- `v_order_financial_status` — una fila por orden, `security_invoker = true`.
- Con 93 órdenes productivas no hay argumento de rendimiento para duplicar el dato, y derivar hace **imposible** la contradicción entre dos fuentes.
- Lo único persistido son **hechos temporales no derivables**: `orders.completed_at` y `orders.paid_at`.
- `recompute_order_payment_status(uuid)` **no está otorgada a `authenticated`** (assert `H2`): el frontend no puede determinar ni escribir el estado financiero, ni siquiera por accidente.

## 3. Estados y regla de cálculo

`sin_facturar | pending | partial | paid`, con la **tolerancia canónica de 1,00 ARS** (la misma de `create_comprobante_checkout_atomic` y `annul_comprobante_atomic`; no se inventó otra).

```
sin comprobantes vigentes           -> sin_facturar
saldo_pendiente <= 1,00             -> paid
total_cobrado  >  0                 -> partial
resto                               -> pending
```

Vigentes = ni anulados, ni `status='cancelled'`, ni notas de crédito. `saldo_en_cc` se expone **por separado**: un asiento de cuenta corriente es deuda, nunca cobro (§3).

Se agregó `sin_facturar` porque el modelo lo necesita: una orden sin comprobante, o cuyo único comprobante fue anulado, no es "pendiente de cobro" — no está facturada. Sin ese valor la anulación dejaba la orden mintiendo.

## 4. Operación atómica (§4)

El cierre ocurre en el trigger `trg_order_complete_on_comprobante` **AFTER INSERT ON comprobantes**, o sea **dentro de la misma transacción del checkout**. Ventajas frente a modificar la RPC:

- Si el checkout falla, el rollback se lleva el cierre: no hay orden completada sin comprobante.
- No hay que reescribir una RPC de ~700 líneas (riesgo desproporcionado, mismo criterio que en P0-A).
- El frontend no ejecuta ningún UPDATE posterior sobre la orden.

El trigger valida **cross-business** (`ORDER_CROSS_BUSINESS`) y rechaza facturar una orden **cancelada** (`ORDER_CANCELLED`).

## 5. Transiciones del estado técnico (§5)

- Orden cancelada → el checkout **se rechaza** (assert `E1`).
- `completed` no se degrada ni se repite; el estado técnico **nunca** lo cambia un evento de dinero.
- `completed_at` se establece **una sola vez** (asserts `B5`, `F2`) y **sobrevive a la anulación** (`G5`): el trabajo se hizo.
- Anular un pago no devuelve la orden a "en reparación" (`C4`); anular el comprobante tampoco (`G4`).
- Un replay idempotente no mueve timestamps ni duplica la transición auditada (`F2`, `F3`).

## 6. Recompute único (§6)

`recompute_order_payment_status(p_order_id)`: server-side, idempotente, con `SELECT … FOR UPDATE` sobre la orden, sin depender de nada enviado por React. Sólo escribe si algo cambió, así que un replay no genera UPDATE ni evento de auditoría.

Disparadores — **ninguna de las 6 RPC financieras fue modificada**, porque todas escriben estas dos tablas:

| Evento | Vía |
|---|---|
| checkout inicial | `trg_order_complete_on_comprobante` |
| pago adicional · reemplazo de forma de pago · reversa | `trg_order_status_on_payment` (AFTER I/U/D en `comprobante_payments`) |
| anulación de comprobante | `trg_order_status_on_comprobante` (AFTER UPDATE) |

El trigger de pagos es **AFTER**, así que corre después de `trig_comprobante_payment_sync` y lee el saldo ya sincronizado.

## 7. Cuenta corriente y pagos parciales — dos hallazgos

**Hallazgo 1 — el pago parcial puro NO existe en este modelo.** El checkout rechaza cualquier cobro que no cubra el total:

> `el cobro no cubre el total del comprobante: total=50000.00 pagos=20000.00 cuenta_corriente=0.00 diferencia=30000.00`

El **único** modo de que una orden quede con saldo es el pago mixto con la diferencia a cuenta corriente. El caso **§7.B** de la especificación (pago 40.000 sobre 100.000, sin CC) **no es representable**; se expresa como **§7.F**. Los tests usan la forma real.

**Hallazgo 2 — la cuenta corriente no tiene imputación open-item.** `record_customer_account_payment_atomic` inserta el cobro con `reference_type='manual'` y **sin `reference_id`**: es un pago **a cuenta del cliente**, no imputado a un comprobante ni a una orden.

**Consecuencia: el caso §7.D no se puede implementar sin una decisión contable nueva.** Bajar el saldo de una orden concreta cuando el cliente paga su cuenta corriente exige elegir una política de imputación (FIFO por antigüedad, proporcional, o manual) que el ledger **no tiene**. Preferí exponer el hecho —`saldo_en_cc` y `deuda_en_cc` como columnas separadas— antes que inventar una imputación y presentarla como si fuera contabilidad existente.

Estado verificado por caso:

| Caso | Resultado | Assert |
|---|---|---|
| A · pago total | completed + **paid** | — |
| B · parcial puro | **no representable** (el checkout lo rechaza) | — |
| C · 100 % cuenta corriente | completed + **pending**, saldo 50.000, `deuda_en_cc` | `D3`-`D6` |
| D · cobro posterior de CC | **bloqueado**: requiere imputación open-item | §22 |
| E · pago que completa el saldo | **paid**, `paid_at` presente | `B1`-`B3` |
| F · mixto 20.000 + 30.000 CC | completed + **partial**, saldo 30.000 | `A5`-`A9b` |

## 8. Anulaciones y reversas (§8)

Todo se **recalcula desde las fuentes canónicas**; no hay transiciones manuales basadas en el estado anterior.

- `paid → partial` por reemplazo de forma de pago: `C1`, `C2`, y `paid_at` **se limpia** (`C3`).
- Anulación del único comprobante → la orden queda **`sin_facturar`** (`G2`), no "cobrada". Estado técnico intacto (`G4`), `completed_at` sobrevive (`G5`), `paid_at` limpio (`G6`).
- No se inventa un comprobante nuevo, no se borra auditoría, no hay DELETE financiero.

Nota: marcar `replaced_at` a mano viola el CHECK `comprobante_payments_replacement_consistency`; hay que usar `replace_comprobante_payment`. El test lo hace.

## 9. Timestamps

`completed_at` (una vez, sobrevive a anulación) y `paid_at` (mantenido por el helper, limpiado al reabrirse el saldo). Ambos con `COMMENT` explicando el contrato.

## 10. Auditoría (§13)

Se reutiliza **`finance_audit_log`** vía `finance_log_audit()` — no se creó tabla paralela. La transición de estado financiero registra: orden, negocio, estado, total comprobado, total cobrado, saldo, saldo en CC, `paid_at` anterior y nuevo, actor y fecha económica. **Sin datos personales, sin tokens, sin información fiscal, sin payloads.** La auditoría está en un `BEGIN…EXCEPTION` para que nunca pueda tumbar un cobro. El cierre técnico se registra además en `status_history`.

## 11. Tests

`supabase/tests/p0a1_order_payment_status_test.sql` — **47 asserts**, todos en verde:
cierre automático dentro de la transacción · `completed_at` · auditoría en `status_history` · partial con saldo · CC expuesta aparte · **regresión P0-A** (COGS 12.200, `operating_result` 37.800, stock una sola vez) · pago posterior → paid + `paid_at` · el estado técnico no se mueve al cobrar · reemplazo → partial y limpieza de `paid_at` · CC 100 % → pending · orden cancelada rechazada · replay idempotente sin mover timestamps ni duplicar auditoría · anulación → `sin_facturar` · aislamiento multi-negocio · `authenticated` sin permiso de ejecución.

De los 24 casos de §14: **cubiertos 1, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 19, 20, 24** y parcialmente 2 (ver §7). **Pendientes**: 10 (orden entregada no se degrada), 15-18 (health checks nuevos), 21-23 (filtros y UI).

## 12. Validación ejecutada (§19)

`db reset` ×2 (**207** migraciones, ambos limpios) · `tsc --noEmit` **0** · `lint:errors` **0** ·
`node --test` **572/572** · `build` OK · `guards` **OK** · secret scan limpio ·
**523 asserts SQL en 10 suites, 0 fallas, 0 regresiones** (checkout, anulaciones, reemplazo de pagos, modelo canónico, P&L, dashboard, M6, health check v2, P0-A y P0-A.1).

El guard `guard:secdef` rechazó la primera versión de las funciones: exige el patrón endurecido de 7C.1 (`search_path = pg_catalog, pg_temp` con **todas** las referencias calificadas con `public.`). Corregido y re-verificado.

## 13. Archivos y migraciones

| Archivo | Cambio |
|---|---|
| `supabase/migrations/20260731120000_p0a1_order_completion_payment_status.sql` | **nueva** (207): 2 columnas + 1 vista + 1 helper + 3 triggers. Rollback documentado. |
| `supabase/tests/p0a1_order_payment_status_test.sql` | **nuevo**: 47 asserts |

Sin cambios de frontend en este lote. Ninguna RPC, trigger financiero ni vista del motor contable fue modificada.

## 14. Riesgos

- **Bajo — nuevos triggers sobre `comprobantes` y `comprobante_payments`.** Es el riesgo principal: tocan el camino de todo cobro. Mitigado con 523 asserts sin regresiones, incluidas las suites de checkout, anulación y reemplazo de pagos.
- **Bajo — `ORDER_CANCELLED` / `ORDER_CROSS_BUSINESS` son excepciones nuevas** que abortan el checkout. Correcto por diseño, pero cambia el comportamiento: antes se podía facturar una orden cancelada.
- **Medio — la UI todavía no muestra el estado financiero**, así que hasta que se haga §9 el dato existe pero no se ve. No es un riesgo de datos.
- **Documentado, no resuelto — §7.D** (imputación de cobros de CC).

## 15. Recomendación de release

**No liberar todavía.** El núcleo es correcto y está probado, pero soltar la DB sin la UI deja el estado financiero invisible, y `service_with_cogs` sigue creciendo con warnings que ya no significan nada. Sugerencia: completar §9-§12 y §18 en un segundo turno de este mismo lote, y liberar todo junto.

Si hiciera falta liberar sólo la DB, es seguro (aditiva y compatible con el frontend actual), pero no aporta valor visible.

## 16. Propuestas separadas

**a) Lo pendiente de P0-A.1**, en este orden: §11-§12 (health checks: `service_with_cogs` exige `CREATE OR REPLACE` de `finance_health_check_v2`, una función de ~917 líneas — es la pieza de mayor riesgo y merece su propio lote y revisión), §9-§10 (UI y filtros, apoyados en `v_order_financial_status`), §18 (guards), §15 (dry-run del backfill de estados).

**b) Backfill de estados** (§15): distinto del P0-B de COGS. Con `completed_at`/`paid_at` recién creados, todas las órdenes históricas los tienen en NULL. Sólo son auto-corregibles las relaciones determinísticas (3 órdenes con `order_id`). **No ejecutado.**

**c) P0-B COGS histórico**: **sigue bloqueado**, sin cambios. 730.162,50 ARS — 14 determinísticas (433.212,50), 6 cerradas ambiguas (210.390), 70.560 en órdenes vivas que se corrigen solas, 16.000 en una orden cancelada. **No mezclar con (b).**
