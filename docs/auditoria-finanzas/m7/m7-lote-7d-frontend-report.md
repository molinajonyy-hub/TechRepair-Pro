# M7 — Lote 7D · Frontend mínimo y wiring de gates

**Fecha:** 2026-07-16 · **Estado:** completo, local. **Sin deploy, sin escrituras en producción.**
Sin commit, push, backfill ni tag.

---

## 1. Auditoría del frontend anterior

`src/pages/FinanceHealthCheck.tsx` — una sola pantalla, sin servicio ni hook intermedio.

| dato | valor |
|---|---|
| invocación v1 | **línea 185**: `supabase.rpc('finance_health_check', { p_business_id: businessId })` |
| campos consumidos | `ok`, `error`, `critical_count`, `warning_count`, `low_count`, `checked_at`, `checks[]` → `{id, title, status, count, description, rows}` |
| campos ignorados | `severity` se tipaba pero **nunca se usaba**: `SEV_CONFIG` se indexa por `status` |
| supuesto de severidades | 4 estados fijos `ok/low/warning/critical`; un valor fuera de eso rompía `SEV_CONFIG[status]` → `cfg.color` sobre `undefined` |
| supuesto de orden | ninguno: filtraba por `status` en 4 listas planas (critical/warning/low/ok) |
| errores RPC | `rpcErr.message` o `data.error` → un solo string en un banner |
| loading/estado | `loading`, `error`, `copied`; sin retry automático |
| tipos | locales, sin `any` |
| tests | ninguno unitario; el E2E `finance-tabs.spec.ts` sólo navega |
| permisos | ninguno en el cliente: la RPC valida ownership |

**Colores hardcodeados** (`#34d399`, `#ef4444`…) en `SEV_CONFIG`, fuera del sistema de temas.

## 2. Archivos modificados

| archivo | qué |
|---|---|
| `src/lib/financeHealth.ts` | **nuevo** — tipos v2 + parsing fail-closed + agrupación + `fmtARS` + detector de fallback. Puro: sin `supabase`, testeable |
| `src/services/financeHealthService.ts` | **nuevo** — `runHealthCheck()`, capa de I/O y fallback acotado |
| `src/pages/FinanceHealthCheck.tsx` | reescrito: v2, categorías, fail/warn/info/pass, monto en riesgo, plataforma aparte, diagnóstico |
| `src/components/order/PaymentCard.tsx` | key durable en `reverse_order_payment_atomic` |
| `src/pages/Expenses.tsx` | key durable en `reverse_operating_expense_atomic` |
| `src/pages/Comprobante.tsx` | key durable en `annul_comprobante_atomic` |
| `package.json` | `guard:secdef`, `guard:secdef:self-test`, `guard:readonly-sql`, `guard:readonly-healthcheck`, `guards` |
| `scripts/finance/guard-security-definer.mjs` | estrategia de baseline |
| `scripts/finance/secdef-baseline.json` | **nuevo** — deuda legacy conocida |
| `tests/unit/financeHealthService.test.ts` | **nuevo** — 26 tests |
| `tests/unit/m7IdempotencyLifecycle.test.ts` | **nuevo** — 12 tests |

Seguí la convención del repo: `lib/` puro y testeable, `services/` con I/O — por eso el módulo quedó partido en dos.

## 3. Tipos v2

Todos los campos pedidos, con **compatibilidad legacy**: los 7 por check (`id, title, severity, status, count, description, rows`) y los 8 del resumen se conservan. **Cero `any`.**

### Parsing fail-closed — y un bug que el test encontró

La regla es que un valor desconocido **nunca** se degrade a `pass`. Mi primera implementación tenía un agujero: si `result` venía presente pero desconocido y el `status` legacy decía `ok`, derivaba a **`pass`** y se pintaba verde. El test `el grupo propaga si hay checks no reconocidos` lo cazó.

Corregido: sólo se deriva del `status` cuando `result` está **ausente** (respuesta v1 legítima). Si vino y no se reconoce → `warn` + `unrecognized: true`, y el badge dice **"Revisar"** con tooltip. Dejé la regresión testeada (`result desconocido + status ok legacy: NO se pinta verde`).

## 4. UI por categorías

12 grupos en el orden pedido, usando las **categorías reales** de la RPC. Cada grupo muestra: cantidad de checks, pills de fail/warn/info, monto en riesgo del grupo (sólo suma los `fail`) y estado agregado.

- Un grupo con `fail` o `warn` **arranca abierto**: nunca se oculta un problema de entrada.
- Dentro del grupo, orden por urgencia: fail → warn → info → pass.
- **Una categoría desconocida se sigue mostrando**, al final, con su `id` como rótulo (testeado).

## 5. fail / warn / info / pass

Cuatro tratamientos distintos — **`info` ya no se ve como warning**:

| result | color | icono | etiqueta |
|---|---|---|---|
| `fail` | `--error` | `AlertCircle` | **Problema** |
| `warn` | `--warning` | `AlertTriangle` | **Revisar** |
| `info` | `--info` | `Info` | **Informativo** |
| `pass` | `--success` | `CheckCircle2` | **OK** |

Nunca se depende sólo del color: van color + icono + etiqueta textual + mensaje.

**Corregí un error mío**: había inventado tokens (`--success-bg`, `--danger-bg`, `--bg-subtle`) que **no existen** — habrían renderizado fondos transparentes. Los tokens reales son `-light`/`-subtle`/`-border`, y el rojo del proyecto es **`--error`**, no `--danger`. Ahora usa sólo tokens existentes, que `index.css` redefine en el bloque light → light/dark salen solos.

Se ven como **info**: NC sin devolución física, reconciliación 7B corregida, mirrors legacy explicados y `global_checks_restricted` (testeado).

## 6. Resumen y monto en riesgo

Tarjetas: problemas · **monto potencialmente afectado** · advertencias · observaciones informativas. Más una barra de estado general con `checks_total` y `duration_ms`.

- `amount_at_risk` viene **de la RPC**: el frontend no suma importes.
- Se rotula **"monto potencialmente afectado"** con subtítulo *"No es una pérdida confirmada"*.
- `fmtARS` usa `Intl.NumberFormat('es-AR', {currency:'ARS'})`. **No existe helper monetario canónico** en el proyecto (cada componente define su `fmt` local); seguí ese patrón y lo dejo anotado como deuda menor.

## 7. Detalles y checks globales

`details` se renderiza como lista `dt/dd` con etiquetas legibles y orden por prioridad (negocio, período, monto, entidad, explicación, semántica, recomendación). Nunca vuelca un JSON crudo: los objetos anidados se resumen y hay **vista técnica expandible** acotada a 2000 caracteres. No hay secretos, tokens ni SQL en el contrato.

Los checks globales viven en su propia sección **"Seguridad de plataforma"**, con la aclaración de que *no afecta la salud financiera de este negocio* — separada de los 12 grupos del comercio.

## 8. Estado del schema y versión

Sección **"Información del diagnóstico"** colapsada: versión, origen, fecha, duración, `schema_state` y `semantics` (NC y deuda legacy en texto plano). En estado normal no molesta.

Si la base respondió por v1, se muestra un aviso visible: *"Diagnóstico en modo compatibilidad (health_version = legacy_v1): faltan migraciones de M7"*, y el `data-health-version` queda en el DOM.

## 9. Matriz de idempotency keys

| Operación | RPC | Genera key | Reutiliza en retry | Persiste el intento | Acción |
|---|---|---|---|---|---|
| Checkout / cobro | `create_comprobante_checkout_atomic` | `useCheckoutIdempotency` | ✅ | ✅ | **ya correcto** |
| Compra a proveedor | `create_supplier_purchase_atomic` | `resolvePurchaseKey` + refs | ✅ | ✅ | **ya correcto** |
| Caja: abrir/mov/cerrar | RPC de caja | `resolvePurchaseKey` + refs | ✅ | ✅ | **ya correcto** |
| Pago de CC | `registrarPagoCC` | `resolvePurchaseKey` + refs | ✅ | ✅ | **ya correcto** |
| Anulación (listado) | `annul_comprobante_atomic` | key en estado (`anulandoKey`) | ✅ | ✅ | **ya correcto** |
| **Anulación (detalle)** | `annul_comprobante_atomic` | UUID por clic | ❌ | ❌ | **corregido** |
| **Reversa de gasto** | `reverse_operating_expense_atomic` | UUID por clic | ❌ | ❌ | **corregido** |
| **Reversa de pago de orden** | `reverse_order_payment_atomic` | UUID por clic | ❌ | ❌ | **corregido** |
| Pago de orden | `create_order_payment_atomic` | UUID por clic | ❌ | ❌ | **no tocado** (ver riesgos) |
| Costo de orden | `OrderCostManagement:216` | UUID por clic | ❌ | ❌ | **no tocado** |
| Reemplazo de cobro | `replace_comprobante_payment` | `comprobanteService.actualizarCobro` | — | — | **no tocado** (ver riesgos) |

## 10. Flujos corregidos

Los 3 pasaron a **una UUID por intención**, reutilizando `resolvePurchaseKey` (el patrón ya existente y testeado) en vez de crear una abstracción nueva:

```ts
const intent = `annul§${businessId}§${comprobanteId}§${motivo.trim()}`
const { key } = resolvePurchaseKey(keyRef.current, hashRef.current, intent, () => crypto.randomUUID())
```

Se crea al empezar el intento · se reutiliza en retries · **rota sola** si cambia negocio, entidad o motivo · **se descarta** al completar con éxito · vive en un `ref`, no en storage.

## 11. Códigos de error

**No toqué el manejo actual**: cada consumidor ya muestra el mensaje server-side, que M7 escribió pensado para el usuario (`"El cobro cambió mientras se procesaba. Volvé a intentarlo"`, `"El comprobante ya está anulado"`, `"No hay caja abierta…"`). Agregar mensajes de UX encima sólo tendría sentido si fueran **más claros sin ocultar la causa**, y hoy no lo son. `IDEMPOTENCY_CONFLICT` ya se maneja explícito en los 3 flujos tocados.

`AUDIT_FAILED` devuelve `ok:false` con *"No se pudo registrar la auditoria de la operacion"* y los consumidores lo tratan como error — **no como éxito**, que es lo que pedía el §11.

## 12. Refresh

Los 3 flujos corregidos ya invocan su recarga al terminar (`cargarComprobante`, `loadExpenses`, `onPaymentsChange`). No agregué recálculos en React: la base sigue siendo la fuente canónica. El health check se re-ejecuta a demanda.

## 13. Guard `guard:secdef` + baseline

```
guard:secdef, guard:secdef:self-test, guard:readonly-sql, guard:readonly-healthcheck
guards  → corre los 6 encadenados
```

**Baseline** (`scripts/finance/secdef-baseline.json`): **39 archivos** con deuda legacy conocida. Reglas: un archivo **nuevo** con hallazgos **bloquea siempre** · un archivo del baseline que **empeora** bloquea (regresión) · si mejora, avisa para actualizar · **nada entra al baseline automáticamente** (sólo con `--update-baseline`, explícito y visible en el diff).

**Probado**: `npm run guards` = 0 con la deuda conocida; inyecté una función nueva insegura y **bloqueó** con `[BLOQUEA] … SIN search_path fijo`.

## 14. Suites y gates

- **Unit: 378 pass, 0 fail** (+38: 26 de health check v2, 12 de idempotencia).
- `tsc` **0** · `lint:errors` **0** · `build` **0** · `guards` **0** · `git diff --check` **0**.
- SQL: sin cambios (no toqué migraciones ni lógica financiera).

Cobertura nueva: contrato v2 · fail-closed (result/severidad/basura/`null`) · compatibilidad v1 · resumen y `amount_at_risk` · agrupación, orden y categorías desconocidas · info ≠ warn · checks globales restringidos · fallback sólo si v2 no existe y **nunca** por permisos/SQL/timeout/JWT · ciclo de vida de keys (reuse, rotación por negocio/entidad/motivo, descarte al completar y al cancelar).

## 15. Verificación en navegador — limitación honesta

Levanté el dev server: la app compila y carga con **cero errores de consola y cero errores del servidor**. Pero **no pude verificar visualmente el panel**: la ruta exige sesión autenticada, y no tengo credenciales ni puedo ingresarlas. Lo digo en vez de afirmar que "se ve bien".

Lo verificado de verdad: tipos, parsing, agrupación y ciclo de keys por unit tests; que compila y no rompe en runtime, por el dev server. **El render de light/dark, mobile y los 44 checks agrupados no está verificado visualmente.**

## 16. Riesgos restantes

1. **E2E de la pantalla no agregados.** El §14 los pedía (panel con fail/warn/info, 44 checks, light/dark, mobile, PAYMENT_SET_CHANGED, refresh). Requieren sesión autenticada y datos sembrados; la memoria del proyecto registra ~136 fallas preexistentes del `@smoke` por una cuenta QA sin plan. Montar eso excede el lote y habría entregado tests rotos de entrada. **Queda pendiente explícito.**
2. **`create_order_payment_atomic` y `OrderCostManagement` siguen con UUID por clic.** No estaban en los 4 prioritarios y no quise ampliar alcance. Riesgo real: una respuesta perdida en un pago de orden puede no replayar. **Mismo patrón, lote chico.**
3. **`replace_comprobante_payment` no lo toqué**: la key nace en `comprobanteService.actualizarCobro`, no en un componente; corregirlo bien implica decidir dónde vive la intención del usuario (el modal), y no quise tocar el servicio sin ver ese flujo entero. Era uno de los 4 prioritarios: **lo declaro como no hecho**.
4. **`amount_at_risk` asume ARS.** Correcto hoy (la RPC normaliza), pero el nombre engaña si aparece multi-moneda.
5. **No hay helper monetario canónico**; agregué otro `fmtARS` local. Consolidarlos es deuda del proyecto, no de este lote.
6. **v1 sigue existiendo** y el fallback puede dispararse: es intencional y visible (`legacy_v1`), pero significa que la pantalla puede mostrar 16 checks en vez de 44 si M7 no está desplegado.

## 17. Recomendación

# 🟡 CONDITIONAL GO

La migración a v2 está completa, tipada, testeada y con los gates en verde; el guard quedó cableado con baseline y **probado que bloquea lo nuevo**. Pero no llego a **GO RELEASE PREP** por dos cosas que declaro sin maquillar:

1. **`replace_comprobante_payment` era prioritario del §10 y no lo corregí.**
2. **Los E2E del §14 no están**, y la verificación visual del panel quedó sin hacer por falta de sesión.

Ninguna de las dos es un bug introducido —el estado es igual o mejor que antes—, pero el lote no cumple su checklist completo. Sugiero un **7D.1 chico**: `replace_comprobante_payment` + `create_order_payment_atomic` + los E2E del panel con una cuenta sembrada.

---

**Me detengo acá.** No hice commit, push, deploy, backfill ni tag.
