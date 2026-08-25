# P0-CC — Informe de cierre

**Fecha:** 2026-08-25
**Veredicto:** **B — código y deploy correctos; falta el smoke humano.**

---

## Resumen

Cuenta Corriente tenía **dos superficies de «Registrar pago»** con el mismo texto de
botón y contabilidad opuesta. La de la pantalla de Cuentas Corrientes hacía un
`INSERT` directo al ledger: bajaba la deuda del cliente y no creaba ni el movimiento
de caja ni el asiento financiero.

Los seis lotes están **desplegados en producción**. Lo único que falta para el
veredicto A es que un humano lo use.

| | |
|---|---|
| Baseline inicial | `c7b3899` · DB 237 · sin PRs posteriores al discovery |
| Merges | `9e9e355` (PR #75) · `2cacbbe` (PR #76) |
| DB producción | **241 / 241** · head `20260901120000` |
| Filas de negocio modificadas | **0** (verificado pre/post con snapshot) |
| Frontend | verificado en el **bundle servido**, no en el commit |

---

## CC-0 · Medición read-only de producción

Sólo `SELECT`. Informe completo en `docs/p0-cc-historical-findings.md`.

- **0** `financial_movements` con método fuera del catálogo de caja. **No existe ni
  un `debito` ni un `credito`**: CC-2 era real en el código y **nunca se disparó**.
- **1** cobro legacy: `bdd1e30e-1ccf-4c11-b12f-c52600af4ca4`, ARS 500.000 del
  2026-08-25, sin `financial_movement` ni BFE. Es la prueba humana del owner. **Su
  caja sigue abierta.**
- El owner escribió literalmente **`"efectivo"` en el campo descripción**: la
  evidencia más directa de que faltaba el selector de método.
- **0** divergencias entre `accounts.balance` y `SUM(debit-credit)`: el agujero de
  CC-3 era real pero nunca fue explotado.

**Consecuencia:** CC-G queda vacío en la dimensión «métodos» y acotado a un único
movimiento identificado por su id. El blast radius (2 cuentas, 2 negocios) hizo que
los lotes restrictivos fueran mucho menos riesgosos de lo estimado.

---

## Los lotes

### CC-A — Normalización server-side del método

**Problema.** La RPC persistía el método CRUDO en `financial_movements.metodo_pago`.
El arqueo sólo conoce `efectivo | transferencia | tarjeta | usd`, y `ModalPagarCC`
ofrecía `debito`/`credito`: esa plata quedaba atada a la caja pero fuera de todos
los buckets.

**Causa.** El POS **sí** mapea (trigger de `comprobante_payments`, con `ELSE`). La
cuenta corriente se escribió después, sin mapeo.

**Solución.** Dos funciones, replicando el desdoblamiento del POS:
`canonical_cc_payment_method` (método de negocio → BFE y auditoría) y
`normalize_cc_payment_method` (bucket de caja → FM).

**Deliberadamente NO hay `ELSE 'efectivo'`.** Convertir un método desconocido en
efectivo inventa un ingreso de caja que quizá nunca ocurrió — la misma clase de
fallback silencioso que produjo el lote. Desconocido, vacío, `usd` y `mixto`
devuelven NULL y la RPC corta con `INVALID_PAYMENT_METHOD` **antes de escribir**.

El hash de idempotencia sigue calculándose sobre el método crudo, para que ninguna
`idempotency_key` viva pase de replay a conflicto por el deploy.

- Migración: `20260829120000_p0cc_a_normalize_payment_method.sql`
- Frontend: `ModalPagarCC.tsx`, `cuentasService.ts`, `financeErrors.ts`
- Tests: `p0cc_a_payment_method_normalization_test.sql` — **47 aserciones**

### CC-B — Una sola superficie de cobro

`/cuentas` monta `ModalPagarCC` y va por la RPC atómica, igual que la ficha del
cliente. En el camino se cerraron cuatro defectos de la misma pantalla:

- el **badge congelado** leía la prop `account.balance` mientras el monto leía estado
  fresco: cobrar toda la deuda mostraba `$0` junto a «En deuda»;
- el saldo ahora **dice si es deuda o saldo a favor** en vez de confiar sólo en el color;
- se retiró el **campo de fecha** que `handleSave` nunca enviaba (prometía un
  antedatado inexistente);
- la **observación pasó a ser opcional**. Cuando era obligatoria y no había selector,
  el operador la usaba para anotar el método — que es exactamente lo que pasó en
  producción.

Los pagos a proveedor dejaron de ofrecerse acá: tienen su propio ledger y sus propias
RPC en la pantalla de Proveedores, y este modal los escribía en el libro equivocado.

- Frontend: `CuentasCorrientes.tsx`, `ModalPagarCC.tsx`
- Tests: `cuentasCorrientesCobro.test.tsx` — **13 tests**, incluida una verificación
  del código fuente (la regresión más probable es un `insert` en una rama que el
  render no ejercita)

### CC-C — Capacidad `finance` y blindaje del saldo

Las tres policies exigían `is_staff()`, que es **verdadero para todos los roles,
`viewer` incluido**. Medido antes del cambio: un viewer leía toda la deuda, escribía
el ledger y corría `UPDATE accounts SET balance = 0`.

`/cuentas` estaba gateada **sólo por plan** (`currentAccounts`), que *parecía* un gate.
Por eso P0-P6 no la cubrió. El sidebar además la listaba bajo la capacidad
`customers`, así que un `sales` veía el link.

El guard va también **dentro de la RPC**: es SECURITY DEFINER y la RLS no la ve.

**`accounts.balance` dejó de ser escribible.** Un GRANT de tabla cubre todas las
columnas y no admite resta: hay que revocar el de tabla y re-otorgar columna por
columna. Falla con **42501** —error explícito, no cero filas en silencio— y el
trigger del ledger sigue funcionando porque es SECDEF de `postgres`. Editar el límite
de crédito y las notas sigue andando.

**Cambio de comportamiento documentado:** `manager` pierde el acceso por default,
alineándose con `/caja` y `/expenses` donde ya no entraba. Se recupera con override.

- Migración: `20260830120000_p0cc_c_capability_rbac_and_balance_lockdown.sql`
- Frontend: `App.tsx`, `Sidebar.tsx`
- Tests: `p0cc_c_capability_rbac_test.sql` — **30 aserciones**, matriz completa de 7 roles

### CC-D — Movimientos manuales y reversa canónica

**Un cobro equivocado era irreversible.** M7 construyó la reversa *por documento*;
el cobro a cuenta —que no es un documento— quedó sin la suya, y el ledger es
append-only para el cliente.

`reverse_customer_account_payment_atomic` escribe contra-movimientos en las tres
patas, fechados **hoy**, enlazados al original, que queda en el historial. Sigue el
patrón M7 6F.2 sin desviarse: sólo se valida el período de hoy (revertir un cobro de
un mes cerrado no reabre aquel mes), el FM conserva el método real, y el BFE es un
income **negativo** fuera del P&L.

**La unicidad no depende del hash**: es un `UNIQUE` sobre `original_movement_id`. Con
otra clave devuelve `ALREADY_REVERSED`. Un cobro ya imputado se rechaza con
`PAYMENT_ALLOCATED` en vez de desimputar en cascada: deshacer algo que el usuario no
pidió es justo lo que no se hace con dinero.

`record_customer_account_adjustment_atomic` reemplaza los INSERT directos de deuda
manual y ajuste. **No se inventó un `type` nuevo**: una deuda cargada a mano no es
una `venta` y llamarla así contaminaría el devengado. La distinción es la
**dirección**, que es un hecho contable, no una etiqueta.

- Migración: `20260831120000_p0cc_d_manual_movements_and_reversal.sql`
- Tests: `p0cc_d_reversal_and_adjustments_test.sql` — **47 aserciones**

### CC-E — Fin del INSERT directo al ledger

`ledger_protection` había revocado UPDATE y DELETE en julio, pero dejó el INSERT
abierto. Ese hueco es el que permitió todo el defecto.

Verificado en todo el repo antes de aplicar: las tres referencias que quedan en
`src/` son `SELECT`. `addMovement`, `registerSale` y `registerPurchase` se
eliminaron. Una postcondición asegura que las cinco RPC del ledger siguen siendo
SECDEF de `postgres`, porque este revoke las rompería en silencio si alguna dejara
de serlo.

El guard `no-direct-finance-writes` **perdió la excepción E2**, que existía para
exactamente este insert. No se reemplazó por otra.

- Migración: `20260901120000_p0cc_e_revoke_direct_ledger_insert.sql`
- Guard: `scripts/guards/no-direct-finance-writes.mjs` — self-test 13/13

---

## El test de caracterización se evolucionó, no se reemplazó

`p0cc_current_account_characterization_test.sql` nació con 39 aserciones, 14 marcadas
`[BUG]`. Cada una está **invertida** y el archivo conserva la numeración original,
de modo que se lee qué cambió y por qué. Dejó de describir defectos y es la
regresión del contrato: **47 aserciones**, todas verdes.

Ejemplos: `B1` pasó de «el INSERT directo baja el saldo» a «el INSERT directo es
rechazado con 42501»; `H3` de «un viewer pisa `accounts.balance`» a «ya no puede»;
`I1` de «no existe RPC de reversa» a «existe, y funciona de punta a punta».

También se invirtió `F9-6a` de `etapa6_rls_lockdown_test.sql`: M6 documentaba una
«excepción acotada» que permitía el insert del cliente, y CC-E la cierra a propósito.

---

## Negative gates

Los seis, ejecutados y revertidos.

| | Regresión introducida | Qué falló, como debía |
|---|---|---|
| **A** | `ELSE 'efectivo'` en el normalizador | `pepe` → `efectivo`; T18/T24 caen |
| **B** | `.from('account_movements').insert` en `/cuentas` | el test de código fuente lo detecta |
| **C** | volver a `is_staff()` en la policy | el viewer pasa a ver 1 cuenta; R8/R26/R27 caen |
| **D** | `GRANT UPDATE` de tabla sobre `accounts` | `balance` vuelve a ser escribible; R16–R20 caen |
| **E** | reversa que no escribe el FM | el saldo vuelve **pero la caja queda en 40.000**; D15/D16 caen |
| **F** | reversa sin el `UNIQUE` | 2 contra-movimientos y **deuda inflada a 140.000**; D19/D26/D27/D30 caen |

El gate F es el más elocuente: sin esa restricción, una doble reversa no sólo
duplica el asiento — infla la deuda del cliente por encima de la original.

---

## Verificación

| | |
|---|---|
| Aserciones SQL nuevas | **171** en 4 suites P0-CC, todas verdes |
| Caracterización evolucionada | 47 aserciones (14 invertidas) |
| Component tests | **512/512** en 33 archivos |
| `tsc --noEmit` | 0 |
| `lint:errors` | 0 |
| Suite `guards` | exit 0 |
| `guard:secdef` | **0 hallazgos en 241 archivos** |
| CI en ambos PRs | TypeScript+Lint+Build ✓ · E2E Smoke (6m) ✓ · Vercel ✓ |

### Producción, pre/post `db push`

| | Antes | Después |
|---|---:|---:|
| `accounts` / `account_movements` | 2 / 4 | 2 / 4 |
| `financial_movements` / BFE | 380 / 590 | 380 / 590 |
| `cajas` / `comprobantes` | 88 / 353 | 88 / 353 |
| Suma de saldos | 320.001 | 320.001 |
| Suma `amount_ars` de FM | 22.832.143,24 | 22.832.143,24 |

**0 filas de negocio modificadas.**

### Postcondiciones medidas en producción

`INSERT` al ledger `false` · `SELECT` `true` · `balance UPDATE` `false` ·
`credit_limit UPDATE` `true` · `DELETE accounts` `false` · policies con `is_staff` **0** ·
policies sin capacidad **0** · policies de escritura en el ledger **0** ·
`normalize('debito')='tarjeta'` · `normalize('pepe')=NULL` · `normalize('usd')=NULL`.

Smoke read-only post-deploy: **0** saldos divergentes, **0** FM fuera de catálogo,
**1** cobro sin caja (el legacy conocido de CC-0), deuda viva 320.001.

---

## El guard SECDEF bloqueó el lote, y tenía tres causas

No se silenció con el baseline: se arreglaron las tres.

1. Las migraciones declaraban `search_path` **entre comillas** (así lo imprime
   `pg_get_functiondef`), y el guard blanquea los literales antes de parsear, así que
   leía la ruta vacía y reportaba «OMITE pg_temp». Se pasó a la forma sin comillas;
   `proconfig` queda byte-idéntico.
2. Los cuerpos referenciaban tablas sin calificar. Con `public` en el path el guard
   exige calificar todo: **64 referencias** ahora llevan `public.`
3. **Dos regex del guard eran imposibles de satisfacer.** `%ROWTYPE` podía empezar a
   matchear *después* del punto, así que `public.accounts%ROWTYPE` se reportaba igual
   que la forma sin calificar. Y `IS DISTINCT FROM v_hash` —la comparación canónica
   del contrato de idempotencia— se leía como una tabla. Ambas corregidas con
   lookbehinds y **4 fixtures nuevas**: dos prueban que calificar ahora sirve, dos que
   el código sin calificar **sigue fallando**. La regla se reparó, no se aflojó.

Eso además limpió el hallazgo preexistente de `accept_business_invitation` (P0-P2),
que era el mismo falso positivo.

---

## Suites preexistentes en rojo — NO son de este lote

Medido levantando **todas** las restricciones de CC: fallan **idénticamente**.

- `etapa7_period_locks_audit` y `etapa7_rpc_integration_customer_order` **dependen de
  la fecha**: cierran el mes anterior y después insertan con fechas `2026-07-*`
  hardcodeadas. Como hoy es agosto, el mes que cierran es el que después escriben.
  Con `ar_today()` stubbeado a septiembre pasan **72/0** y **54/0** — con las
  migraciones de CC aplicadas.
- `etapa7_7c1`, `etapa7_7e1b`, `etapa7_7e2`,
  `etapa7_rpc_integration_comprobante_annulment` y `p0a1_order_payment_status`:
  dominio ARCA, notas de crédito y permisos de `is_comprobante_annulled` /
  `v_order_financial_status`.

Ninguna toca cuenta corriente. **No se repararon**: están fuera del alcance.

---

## Riesgos y decisiones

**El `db push` fue ANTES del merge**, invirtiendo la regla habitual del repo. Con el
frontend nuevo y la DB vieja, `ModalPagarCC` mandaría `tarjeta_debito` a una RPC que
lo persiste crudo —rompiendo el arqueo— y llamaría a RPC inexistentes. En la ventana
inversa lo único que se degrada es que el camino legacy falla con 42501 en vez de
registrar mal la plata: **falla fuerte, no silenciosa**. Se eligió la ventana segura.

**Lo que NO se hizo, a propósito:** reparar historia, tocar cajas cerradas, agregar
USD, unificar la deuda de órdenes con CC, validar `credit_limit`, o rediseñar mobile.

**El Health Check v2 no se pudo ejecutar**: tiene guard `auth.uid()` y devuelve «No
autenticado» sin JWT. Es una limitación conocida, no un resultado del lote. En su
lugar se corrieron sus invariantes clave como smoke read-only.

---

## Qué falta para el veredicto A

Un **smoke humano** con el owner:

1. abrir caja → cliente con deuda → **Registrar cobro**;
2. efectivo impacta la caja · transferencia va a su bucket · débito cae en tarjeta;
3. el saldo baja y el badge lo acompaña; refrescar conserva;
4. **Revertir cobro** devuelve saldo y caja;
5. doble click no duplica;
6. un `tech` o `viewer` **no ve** Cuentas Corrientes.

Y una decisión de negocio, no técnica: **¿los ARS 500.000 del cobro legacy entraron
físicamente al cajón?** Su caja sigue abierta, así que todavía hay ventana para
repararlo sin tocar un cierre consolidado.

---

## Handoffs registrados

`CC-G` reparación histórica · `CC-MULTICURRENCY` · deuda unificada órdenes + CC ·
`credit_limit` sin validar · semántica de `balance_after` en el extracto ·
`CommandPalette` sin gate de capacidad (lista `/caja` y `/finance` igual: es previo y
más amplio que CC) · suites SQL con fechas hardcodeadas · rediseño mobile profundo.
