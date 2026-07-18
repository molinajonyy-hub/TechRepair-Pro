# M7 — Lote 7D.1 · Cierre de idempotencia frontend y QA visual

**Fecha:** 2026-07-16 · **Estado:** idempotencia completa; **QA visual E2E NO ejecutada** (motivo abajo).
Sin deploy, sin escrituras en producción, sin commit/push/backfill/tag.

---

## 🔴 Hallazgo que bloquea la parte E2E del lote

**El `.env` del repositorio apunta la app a la instancia PRODUCTIVA:**

```
.env → VITE_SUPABASE_URL=https://vrdxxmjzxhfgqlnxmbwx.supabase.co
```

Es el mismo ref que auditamos en 7A. Los E2E levantan la app con esa config y `.env.test` sólo define `E2E_BASE_URL`/`E2E_EMAIL`/`E2E_PASSWORD` — **no** el Supabase. Por lo tanto, hoy, **correr la suite E2E escribe datos reales en producción**: comprobantes, pagos, movimientos de caja, con la cuenta QA.

Eso explica de otra manera las ~136 fallas históricas del `@smoke`: no es sólo "cuenta QA sin plan" — es que **los tests corren contra producción**.

Tu §7 pide explícitamente *"no uses producción"* e *"incapaz de apuntar accidentalmente a producción"*. Con la configuración actual, **cualquier corrida de E2E viola esa regla**. Por eso **no ejecuté ningún E2E** y priorizé entregar el guard que lo impide.

## 1. Flujo completo de `replace_comprobante_payment`

| aspecto | estado ANTES |
|---|---|
| componente | modal "Editar cobro" en `src/pages/Comprobante.tsx` (`openEditPago` / `handleSaveEditPago`) |
| servicio | `comprobanteService.actualizarPago()` (no `actualizarCobro`: ese nombre no existe) |
| **dónde nacía la UUID** | **`Comprobante.tsx:339`**, en el componente: `idempotencyKey: crypto.randomUUID()` |
| **cuántas veces por intención** | **una por clic**: N clics = N keys |
| respuesta perdida | el retry mandaba **key nueva** → el server la trataba como intención nueva → si la primera SÍ se aplicó, el set vivo ya cambió → **`PAYMENT_SET_CHANGED`**. El usuario veía un error confuso en vez del resultado real. **Sin replay posible.** |
| doble clic | `editPagoLoading` deshabilita el botón, pero dos intentos consecutivos = dos keys |
| payload modificado tras un fallo | key nueva — correcto **por accidente**, no por diseño |
| cerrar y reabrir | key nueva — correcto por accidente |
| servicio | `idempotencyKey?: string` **opcional** y `p_idempotency_key: params.idempotencyKey ?? null` |

**El fallback silencioso era peor de lo que decía el §3**: no generaba una UUID, mandaba **`null`**. Y con `p_idempotency_key = NULL`, la RPC de 6F.3 saltea el bloque `IF v_key IS NOT NULL` entero: **no crea request, no hay replay, no hay conflicto detectable**. Un caller que se olvidara la key producía una operación económica sin ninguna idempotencia, en silencio.

## 2. Boundary elegido

La intención es **"reemplazar el cobro de ESTE comprobante por ESTE"**, y vive en el modal de `Comprobante.tsx` — no en el servicio.

Implementación: dos `useRef` + el helper existente `resolvePurchaseKey` (mismo patrón que compras, caja y CC). **No creé ninguna abstracción nueva.**

El hash de intención lleva **los 9 campos económicos** que viajan a la RPC, no sólo los 3 que el modal edita hoy — así, si mañana el formulario expone provider o comisión, la rotación ya funciona:

```
replace_payment § comprobanteId § method § amount § amount_ars § currency § rate § provider § commission § notes
```

## 3. Lifecycle de la key

| evento | acción | verificado |
|---|---|---|
| abrir el modal (`openEditPago`) | **descarta** la key anterior | `reabrir tras un resultado terminal NO reutiliza la key vieja` |
| mismo payload, retry | **reutiliza** | `doble clic…`, `error de red: la key se CONSERVA` |
| error de red / timeout | **conserva** (incierto: no se asume que falló) | ✅ |
| error de validación | conserva; rota sola si el usuario corrige | ✅ |
| cambio de cualquier campo económico | **rota** | 9 tests, uno por campo |
| **éxito** | limpia + cierra modal + `cargarComprobante(id)` | ✅ |
| **`PAYMENT_SET_CHANGED`** | **limpia la key stale** + refresca + exige intención nueva + **no reenvía solo** | ✅ |
| **`IDEMPOTENCY_CONFLICT`** | **no rota ni reintenta solo** + refresca + lo revisa el usuario | ✅ |
| cancelar (`closeEditPago`, X o Cancelar) | **descarta** | ✅ |

`PAYMENT_SET_CHANGED` **debe** limpiar la key: 6F.3a la deja en estado `stale_source` terminal server-side, así que reintentarla devolvería el mismo error para siempre.

## 4. Contrato del servicio

| | antes | después |
|---|---|---|
| tipo | `idempotencyKey?: string` | **`idempotencyKey: string`** (obligatoria) |
| envío | `params.idempotencyKey ?? null` | `params.idempotencyKey` |
| retorno | `{success, error, conflict}` | `{success, error, **errorCode**, conflict}` |

Un caller sin key **ahora no compila**. Hay un solo consumidor (`Comprobante.tsx`), así que no hizo falta conservar compatibilidad. `errorCode` se propaga tal cual (`PAYMENT_SET_CHANGED`, `PERIOD_CLOSED`, `AUDIT_FAILED`…) para que la UI decida el lifecycle **sin reinterpretar el mensaje**.

## 5. Auditoría de `create_order_payment_atomic`

| Consumidor | Nacimiento de key | Reuse en retry | Rotación por payload | Estado |
|---|---|---|---|---|
| `PaymentCard.tsx:87` | `crypto.randomUUID()` por clic | ❌ | ❌ | **corregido** |
| `OrderCostManagement.tsx:206` | `crypto.randomUUID()` por clic | ❌ | ❌ | **corregido** |
| `ModalCobro.tsx:397` | `crypto.randomUUID()` por clic, **dentro de un loop** | ❌ | ❌ | **corregido** |

Los tres cumplían el criterio *"UUID nueva en cada clic"* → §5 manda corregirlos. Rotan por negocio, orden, monto, moneda, método, TC y notas.

**`ModalCobro` era distinto**: un cobro mixto son N pagos en un loop, cada uno con su propia key. Usé un `useRef` con `{ hash del conjunto, Map<índice, key> }`: si cambia **cualquier** pago del conjunto, se descartan todas y se regeneran; un retry del mismo conjunto reusa cada key. Es un lifecycle local, no una abstracción universal.

## 6. Matriz final de idempotencia frontend

| Operación | RPC | Key nace en | Se reutiliza | Rota por payload | Se limpia en |
|---|---|---|---|---|---|
| Checkout | `create_comprobante_checkout_atomic` | `useCheckoutIdempotency` (UI) | ✅ | ✅ | éxito |
| Compra a proveedor | `create_supplier_purchase_atomic` | `Expenses` (UI) | ✅ | ✅ | éxito |
| Caja abrir/mov/cerrar | RPC de caja | `CajaPage` (UI) | ✅ | ✅ | éxito |
| Pago de CC | `registrarPagoCC` | `ModalPagarCC` (UI) | ✅ | ✅ | éxito |
| Anulación (listado) | `annul_comprobante_atomic` | `Comprobantes` (estado) | ✅ | ✅ | éxito |
| Anulación (detalle) | `annul_comprobante_atomic` | `Comprobante` (UI, 7D) | ✅ | ✅ | éxito |
| Reversa de gasto | `reverse_operating_expense_atomic` | `Expenses` (UI, 7D) | ✅ | ✅ | éxito |
| Reversa pago de orden | `reverse_order_payment_atomic` | `PaymentCard` (UI, 7D) | ✅ | ✅ | éxito |
| **Reemplazo de cobro** | `replace_comprobante_payment` | **`Comprobante` (UI, 7D.1)** | ✅ | ✅ | éxito / stale / cancelar |
| **Pago de orden ×3** | `create_order_payment_atomic` | **UI (7D.1)** | ✅ | ✅ | éxito |

**Ningún consumidor activo genera la key dentro de un servicio.** Ninguno la genera por clic.

## 7. Guard de entorno E2E

`tests/e2e/helpers/assertLocalEnv.ts` — **fail-closed**:

- rechaza el ref productivo `vrdxxmjzxhfgqlnxmbwx` con mensaje explícito;
- rechaza **cualquier** host remoto, no sólo el conocido;
- acepta `localhost`, `127.0.0.1`, `[::1]`, `host.docker.internal`, `kong`;
- **sin URL → aborta** (no asume local);
- el mensaje dice cómo arreglarlo (`E2E_SUPABASE_URL`).

**6 tests** cubren producción, otros remotos, los 6 hosts locales, fail-closed y URL inválida.

## 8–10. Specs E2E y validación visual — **NO ENTREGADOS**

**No los hice, y no voy a simular que sí.** El motivo es el hallazgo de arriba: el único entorno configurado apunta a producción, y correr E2E ahí viola tu propia instrucción y escribiría datos reales.

Para hacerlo bien hace falta una decisión de entorno que no me corresponde tomar solo:

1. **Apuntar el build de E2E al Supabase local.** El Supabase local **está corriendo** (`API_URL` en `127.0.0.1`), pero la app se buildea con `.env` → producción. Redirigirlo implica tocar el manejo de env de Vite (`--mode test` / `.env.test.local`) **y** el `webServer` de `playwright.config.ts`. Eso cambia el entorno de desarrollo de todo el equipo.
2. **Sembrar el usuario E2E** vía Admin API local (negocio activo, rol, plan compatible, datos financieros).
3. Recién entonces: specs de integración real, estados controlados por intercepción, códigos de error y capturas light/dark/desktop/mobile.

Lo que **sí** dejo listo: el guard que impide la corrida contra producción (probado en ambas direcciones) y el diagnóstico exacto de qué falta cablear. Prefiero eso a specs que no puedo correr o, peor, que ensucien producción.

**Sigue sin verificarse visualmente** el panel de Health Check v2 (light/dark/mobile/44 checks), igual que en 7D.

## 11. Refresh e invalidaciones

**El proyecto no usa cache central** (no hay React Query/SWR): cada flujo hace su reload explícito. Documentado exactamente:

| flujo | qué se ejecuta |
|---|---|
| reemplazo de cobro | `cargarComprobante(id)` → recarga comprobante, pagos y estado |
| reemplazo → `PAYMENT_SET_CHANGED` | `await cargarComprobante(id)` **antes** de avisar, para que el usuario vea el cobro real |
| reemplazo → `IDEMPOTENCY_CONFLICT` | `await cargarComprobante(id)` |
| anulación (detalle) | `cargarComprobante(id)` |
| reversa de gasto | `loadExpenses()` |
| reversa/alta pago de orden | `onPaymentsChange()` (lo provee el padre) |
| Health Check | se re-ejecuta a demanda con el botón |

**Sin cálculos financieros en React**: la base sigue siendo la fuente canónica. **Limitación**: el Health Check **no** se invalida solo tras una operación terminal — si está abierto en otra pestaña muestra datos viejos hasta que se re-ejecute. Sin cache central, cablearlo sería inventar uno.

## 12. Guard SECURITY DEFINER

Todo verificado:

| prueba | resultado |
|---|---|
| self-test (10 fixtures) | ✅ 0 |
| baseline estable | ✅ 0 |
| función nueva insegura | ✅ exit 1 — `[BLOQUEA] … SIN search_path fijo` |
| función segura | ✅ pass |
| **función legacy modificada sin endurecer** | ✅ exit 1 — `[BLOQUEA] … 2 hallazgos fuera del baseline` |
| **baseline auto-actualizado** | ✅ **no**: `git diff` de `secdef-baseline.json` vacío tras las pruebas |

**No agregué ninguna excepción para hacer pasar el gate.**

### Las 39 rutas del baseline vs las 128 funciones

Son dos métricas distintas y conviene no confundirlas:

- **128 funciones** = lo que ve el **health check en la base viva**: SECURITY DEFINER cuyo `search_path` incluye `public` (schema escribible). Es el estado *runtime*.
- **39 archivos** = lo que ve el **guard en las migraciones**: archivos `.sql` con al menos un hallazgo estático. Un archivo declara varias funciones, y muchas de las 128 se declaran en migraciones históricas ya consolidadas o en el baseline remoto.

Relación: el baseline congela la deuda **por archivo**; el health check la mide **por función**. Ambos apuntan al mismo pendiente — calificar referencias y sacar `public` del path — y **el vector de tabla temporal ya está cerrado en las 141** por la barrera de `20260713310000`. Bajar los 39 a 0 es el lote *Platform Schema Privileges Hardening*.

## 13. Suites y gates

**Nuevos, ejecutados:**
- `tests/unit/replacePaymentIdempotency.test.ts` — **21 asserts** (lifecycle completo, 9 campos que rotan, 4 resultados terminales).
- `tests/unit/e2eEnvGuard.test.ts` — **6 asserts**.
- **Unit total: 405 pass, 0 fail** (+27 sobre 7D).

**Gates:** `tsc` 0 · `lint:errors` 0 · `build` 0 · `guards` 0 (los 6) · `git diff --check` 0.

**No ejecutados:**
- **Specs E2E focalizados**: no entregados (§8–§10 arriba).
- **Suite E2E general**: **no ejecutada a propósito** — apunta a producción.

**Evidencia de que no introduje fallas históricas:** no toqué ningún spec E2E existente ni `playwright.config.ts`; las ~136 fallas del `@smoke` están intactas y ahora, además, tienen una explicación mejor (corren contra producción). Mis cambios de `src/` están cubiertos por 405 unit tests en verde y por `tsc`/`build`.

## 14. Riesgos restantes

1. **🔴 Los E2E del repo apuntan a producción.** Es el riesgo más grave que encontré en este lote. El guard existe pero **todavía no está cableado** a los specs (nadie lo llama): hay que agregarlo al `beforeAll` de cada spec que escriba, o mejor a un `globalSetup`. **Lo dejo señalado, no cableado**, porque hacerlo haría fallar toda la suite existente de golpe — una decisión que te corresponde.
2. **QA visual del Health Check sigue sin hacerse** (light/dark/mobile/44 checks). Arrastrado de 7D.
3. **El Health Check no se auto-invalida** tras operaciones terminales.
4. **`ModalCobro`**: si el loop de un cobro mixto falla en el pago 2 de 3, el retry reusa las keys de los 3 → el 1 hace replay y el 2 y 3 se ejecutan. Es el comportamiento correcto, pero **no lo probé end-to-end**, sólo por unit test del helper.
5. **El intent de reemplazo hardcodea `provider='∅'` y `comisión=0`** porque el modal no los expone. Si alguien agrega esos campos al formulario y olvida sumarlos al intent, la key no rotará. Dejé el comentario en el código.

## 15. Recomendación

# 🟡 CONDITIONAL GO

**Lo de idempotencia está cerrado y verificado**: `replace_comprobante_payment` con boundary correcto, key obligatoria en el tipo, lifecycle completo por resultado terminal, los 3 consumidores de `create_order_payment_atomic` corregidos, y la matriz sin un solo consumidor activo generando keys en un servicio. 405 unit tests y todos los gates en verde.

**Pero no llego a GO RELEASE PREP**, por lo mismo que en 7D más un motivo nuevo y más serio:

1. **Los E2E del §8–§10 no están y la QA visual tampoco**, bloqueados por que el único entorno configurado es producción.
2. **Descubrí que la suite E2E existente escribe en producción.** Eso es un problema de higiene del proyecto que excede este lote y merece decisión explícita.

Sugiero un **7D.2** acotado: cablear el build de E2E al Supabase local, sembrar el usuario, enganchar `assertLocalEnv` en un `globalSetup`, y recién ahí los specs focalizados y las capturas. Es un lote de infraestructura de test, no de finanzas.

---

**Me detengo acá.** No avancé con el release, no escribí en producción, y no hice commit, push, deploy, backfill ni tag.
