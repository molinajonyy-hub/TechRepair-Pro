# P0-CC — Auditoría de Cuenta Corriente, cobranzas y Caja

**Fase:** discovery + diagnóstico. Sin fixes, sin merge, sin deploy, sin migraciones aplicadas.
**Fecha:** 2026-08-25

---

## VEREDICTO: **B**

**Existen bugs contables reales, y hay un camino claro de reparación.**

El modelo canónico **ya existe y es correcto**: `record_customer_account_payment_atomic`
hace en UNA transacción el ledger + el movimiento de caja + el asiento financiero,
con idempotencia, guard de sobrepago, guard de período y auditoría explícita.

El problema no es que falte arquitectura. Es que:

1. **la pantalla principal de Cuenta Corriente no la usa** — usa un `INSERT` directo
   anterior a M6, que no toca la caja;
2. **el camino que sí la usa manda métodos de pago fuera del catálogo de caja**, y la
   RPC los persiste crudos → esa plata desaparece del arqueo;
3. **`accounts.balance` es una columna mutable escribible por cualquier miembro**, y su
   corrupción se propaga hacia adelante para siempre.

Nada de esto requiere rediseñar el modelo. Requiere reconectar la UI, agregar un
normalizador de método, cerrar `accounts` y agregar la reversa que falta.

---

## 1. Baseline

| Ítem | Valor |
|---|---|
| Commit | `c7b3899` — *Merge pull request #73 from molinajonyy-hub/codex/pre-beta-cleanup* |
| Rama | `main`, sincronizada con `origin/main` (0 ahead / 0 behind) |
| P0-P6 | presente (`80322c2`, `7e022ae`) |
| PR #73 | mergeado (`c7b3899`) |
| Migraciones en repo | 237 |
| Head local | `20260828120000_order_amounts_canonical_profile_identity` |
| DB local | 237/237 aplicadas — al día con el repo |
| Working tree | limpio al inicio |

> Nota: el árbol contiene 4 PNG de evidencia E2E modificados y `docs/p0-mobile-evidence/`
> sin trackear, de una sesión previa de hoy. No los tocó esta auditoría y no se commitearon.

**Trabajo hecho en esta fase:** un único archivo nuevo, un test de caracterización
transaccional (`ROLLBACK`), sin migraciones ni cambios de producción.

---

## 2. Arquitectura actual

Hay **dos superficies distintas para el mismo acto de negocio** — "registrar un pago de
cuenta corriente" — con el **mismo texto de botón** y resultados contables opuestos.

```
┌─ SUPERFICIE 1 — /cuentas (CuentasCorrientes.tsx) ──────────────── LEGACY ─┐
│  Botón "Registrar pago"                                                    │
│    → MovementModal (inline, misma pantalla)                                │
│    → cuentasService.registerPayment()                                      │
│    → cuentasService.addMovement()                                          │
│    → supabase.from('account_movements').insert(...)   ← INSERT DIRECTO     │
│                                                                            │
│  Resultado: baja la deuda. NADA MÁS.                                       │
│  ✗ sin financial_movement  → la CAJA NO SE ENTERA                          │
│  ✗ sin business_finance_entry → invisible para finanzas                    │
│  ✗ sin método de pago (sólo descripción libre)                             │
│  ✗ sin caja_id · sin idempotency key · sin guard de sobrepago              │
└────────────────────────────────────────────────────────────────────────────┘

┌─ SUPERFICIE 2 — /customers/:id (CustomerDetail.tsx) ─────────── CANÓNICA ─┐
│  Botón "Registrar pago"                                                    │
│    → ModalPagarCC                                                          │
│    → cuentasService.registrarPagoCC()                                      │
│    → RPC record_customer_account_payment_atomic()                          │
│                                                                            │
│  Resultado, en UNA transacción:                                            │
│  ✓ account_movements (credit) → baja la deuda                              │
│  ✓ financial_movements (income, caja_id, metodo_pago) → SUBE LA CAJA       │
│  ✓ business_finance_entries (espejo, excluido del P&L)                     │
│  ✓ idempotencia · guard de sobrepago · guard de período · auditoría        │
└────────────────────────────────────────────────────────────────────────────┘
```

**Causa raíz #1.** M6 planeó explícitamente *"Rewire `cuentasService.registrarPagoCC`"*
y *"rewire `cuentasService`/`CuentasCorrientes`"* (`docs/auditoria-finanzas/m6/m6-plan.md`).
Se hizo la mitad: se creó la RPC, se creó `registrarPagoCC`, y se construyó
`ModalPagarCC` — pero se lo montó en `CustomerDetail`, **no** en `CuentasCorrientes`.
La página `/cuentas` conservó su `MovementModal` inline con el `INSERT` directo.

El historial de git lo confirma: `CuentasCorrientes.tsx` **nunca** fue tocado por M6.
Su último commit funcional es `f6d18fa` (UI de imputación), posterior a M6 pero que no
tocó el flujo de pago.

El smoke de M6 se registró como *"OK (estático)"* verificando `ModalPagarCC` — la segunda
superficie nunca entró en el alcance.

**Consecuencia medible:** `registrarPagoCC` tiene **cero llamadores fuera de
`ModalPagarCC`**, y `ModalPagarCC` sólo es alcanzable desde la ficha del cliente. El owner
que entra por el menú "Cuentas Corrientes" **nunca toca el camino canónico**.

---

## 3. Tablas, vistas y RPC involucradas

### `accounts` — cabecera de la cuenta

| Columna | Tipo | Nota |
|---|---|---|
| `business_id` | uuid NOT NULL | scope de tenant |
| `type` | text | `cliente` \| `proveedor` |
| `entity_id` | uuid | → `customers.id` / `suppliers.id` |
| `balance` | **numeric mutable** | **saldo materializado. Ver §3.1** |
| `credit_limit` | numeric | **declarativo: no se valida en ningún lado** |

- **RLS:** una única policy `accounts_plan` **`FOR ALL`** con `is_staff()`.
- **Grants:** `GRANT ALL ON accounts TO authenticated`.
- **No hay** columna de moneda.

### `account_movements` — el ledger

| Columna | Tipo | Nota |
|---|---|---|
| `date` | date | fecha económica |
| `type` | text CHECK | `venta`\|`compra`\|`gasto`\|`pago`\|`ajuste`\|`apertura` |
| `debit` / `credit` | numeric ≥ 0 | `debit` genera deuda, `credit` la reduce |
| `balance_after` | numeric | saldo corrido, lo pone el trigger |
| `reference_type` / `reference_id` | text / uuid | imputación open-item |

- **No hay** `currency`, `exchange_rate` ni `amount_ars`. **No hay** `payment_method`.
  **No hay** `caja_id`. **No hay** columna de reversa/anulación.
- **RLS:** `account_movements_select` + `account_movements_insert`, ambas con `is_staff()`.
  `UPDATE`/`DELETE` revocados a `authenticated` (`20260702140000_ledger_protection.sql`).
- **Triggers:** `trig_account_movement_balance` (BEFORE INSERT, saldo),
  `trg_finance_period_guard_am` (BEFORE INSERT, período),
  `trg_finance_audit_backstop_am` (AFTER INSERT, auditoría — **audita, no bloquea**).

### `financial_movements` — la caja

Escrita por la RPC canónica con `caja_id`, `metodo_pago`, `source='cobro_cuenta_corriente'`,
`reference_type='account_movement'`, `reference_id=<account_movement.id>`.
`CajaPage` lee `financial_movements WHERE caja_id = <caja>`.

### RPC

| RPC | Estado |
|---|---|
| `record_customer_account_payment_atomic` | ✅ existe, correcta — **pero sólo la llama `ModalPagarCC`** |
| `allocate_account_payment_atomic` | ✅ imputación open-item (AllocationModal) |
| `reverse_payment_allocation_atomic` | ✅ revierte la **imputación** |
| `create_comprobante_checkout_atomic` | ✅ crea la deuda desde el POS |
| `annul_comprobante_atomic` | ✅ revierte la **deuda** al anular |
| `close_cash_session_atomic` | ✅ arqueo server-side |
| **`reverse_customer_account_payment_atomic`** | ❌ **NO EXISTE** |

### 3.1 ¿Dónde vive la verdad del saldo?

**En dos lugares a la vez, y no está garantizado que coincidan.**

1. **`accounts.balance`** — columna **mutable**. Es lo que lee **toda la UI**
   (lista de cuentas, panel de detalle, tarjeta del cliente, stats de la cabecera).
2. **`SUM(debit - credit)` sobre `account_movements`** — derivado. Es lo que usa
   **la RPC canónica** para su guard de sobrepago.

El trigger `trigger_account_movement_balance` las mantiene alineadas… pero de una forma
frágil: **no recalcula la suma, lee `accounts.balance` como punto de partida.**

```sql
SELECT COALESCE(balance,0) INTO v_prev FROM accounts WHERE id = NEW.account_id FOR UPDATE;
NEW.balance_after := v_prev + NEW.debit - NEW.credit;
UPDATE accounts SET balance = NEW.balance_after WHERE id = NEW.account_id;
```

**¿Quién puede escribirlo?** Con `GRANT ALL` + policy `FOR ALL` con `is_staff()`:
**cualquier miembro activo del negocio, incluido un `viewer`**, puede hacer
`UPDATE accounts SET balance = 0`. Sin movimiento, sin auditoría, sin rastro.

Y como el trigger **ancla en la columna**, el saldo pisado se convierte en la nueva base:
**la corrupción se propaga a todos los movimientos siguientes, para siempre.**
Medido — ver §15, caso H.

---

## 4. Flujo de creación de deuda

Todos los caminos que generan deuda de CC convergen en **un solo escritor**:
`create_comprobante_checkout_atomic`, paso 8.

```sql
IF v_cc_total > 0.01 AND v_customer_id IS NOT NULL THEN
  SELECT id INTO v_account_id FROM accounts WHERE business_id=... AND entity_id=v_customer_id;
  IF v_account_id IS NULL THEN INSERT INTO accounts (...) END IF;   -- auto-crea la cuenta
  INSERT INTO account_movements (..., type='venta', debit=v_cc_total, credit=0,
    reference_type='comprobante', reference_id=v_comp_id, ...);
END IF;
```

**Esto está bien.** Es atómico, auto-crea la cuenta, y la deuda nace **imputable**
(lleva `reference_type`/`reference_id`). Verificado: caso A3.

**No hay duplicación de caminos de deuda.** Los únicos otros escritores de
`account_movements` son la anulación (`annul_comprobante_atomic`), el reemplazo de pagos
y el ledger de devengado — todos reversas o correcciones del mismo comprobante.

### Hallazgo: las órdenes NO generan cuenta corriente

**Ninguna migración inserta en `account_movements` desde el flujo de órdenes.** Una orden
finalizada sin pago **no crea deuda de CC**. Las órdenes tienen su propio modelo:
`order_payments` + `get_order_financial_amounts` + `v_order_financial_status`, y
`useOrderCanonicalBalance` sólo devuelve saldo si la orden **tiene un comprobante vinculado**.

Consecuencia operativa: un cliente puede deber plata por una orden y **no aparecer en
Cuentas Corrientes**. Los dos libros de deuda sólo se unifican cuando se emite el comprobante.

### Asimetría de imputación

| | `reference_type` | `reference_id` |
|---|---|---|
| Deuda (venta) | `'comprobante'` | ✅ el comprobante |
| Cobro (RPC canónica) | `'manual'` | ❌ **NULL** |

El cobro nace **a cuenta**, sin imputar. Imputarlo es un **segundo acto explícito**
(`AllocationModal` → `allocate_account_payment_atomic`). Es una decisión de diseño válida
(open-item), pero explica parte de la confusión del owner: cobra y el comprobante sigue
figurando con saldo hasta que además impute.

---

## 5. Flujo "Registrar pago" — traza completa

| # | Pregunta | `/cuentas` (LEGACY) | ficha del cliente (CANÓNICA) |
|---|---|---|---|
| 1 | UI que abre | `MovementModal` inline | `ModalPagarCC` |
| 2 | Datos que pide | monto, **descripción (obligatoria)**, fecha | monto, **método**, descripción |
| 3 | Función | `cuentasService.registerPayment` | `cuentasService.registrarPagoCC` |
| 4 | Ejecuta | `INSERT INTO account_movements` | `rpc(record_customer_account_payment_atomic)` |
| 5 | ¿Movimiento financiero (BFE)? | ❌ **no** | ✅ sí |
| 6 | ¿Movimiento de Caja (FM)? | ❌ **no** | ✅ sí |
| 7 | ¿Reduce saldo? | ✅ sí | ✅ sí |
| 8 | ¿Método de pago? | ❌ **no existe el campo** | ⚠️ sí, pero **catálogo equivocado** (§6) |
| 9 | ¿Moneda? | ❌ no | ⚠️ ARS fijo |
| 10 | ¿Atómico? | trivial (1 insert) | ✅ real (3 tablas, 1 tx) |
| 11 | ¿Idempotente? | ❌ **no** | ✅ sí |

**Bug adicional en el modal legacy:** captura una **fecha** (`useState(today())`,
input `type="date"`) que **`handleSave` nunca usa**. El movimiento siempre se graba con
`new Date().toISOString().split('T')[0]` dentro de `addMovement`. El operador cree estar
antedatando un cobro y no lo está. `CuentasCorrientes.tsx:58,120` vs `:66-78`.

**Sobre "sólo aparece un campo de descripción":** es exacto y es peor de lo que parece.
La descripción **no es** un complemento del método de pago — **es el único dato** que el
operador puede dejar. No hay `payment_method` que registrar: la columna **no existe en
`account_movements`**. La descripción es texto libre que nada consume.

---

## 6. Comparación con el POS — matriz

### Catálogos de método de pago en el sistema: **cinco, incompatibles**

| # | Catálogo | Dónde | Valores |
|---|---|---|---|
| 1 | `MedioPago` | `comprobanteService.ts:24` → `comprobante_payments.payment_method` | `efectivo`, `transferencia`, `tarjeta_debito`, `tarjeta_credito`, `qr`, `mixto`, `otro`, `cuenta_corriente` |
| 2 | `CajaMethod` | `financial_movements.metodo_pago` → **el arqueo** | `efectivo`, `transferencia`, `tarjeta`, `usd` |
| 3 | `PosPayMethod` | `posSettlement.ts:20` (aritmética pura) | `efectivo`, `transferencia`, `cuenta_corriente`, `tarjeta`, `otro` |
| 4 | `METODOS` | `ModalPagarCC.tsx:8` (**cuenta corriente**) | `efectivo`, `transferencia`, **`debito`**, **`credito`** |
| 5 | `MetodoPago` | `ModalCobro.tsx:22` | **código muerto — no está montado** |
| — | *(ninguno)* | `CuentasCorrientes.tsx` | **no hay selector** |

El POS **sí tiene un mapper** 1 → 2, en el trigger de `comprobante_payments`
(`20260702140000_ledger_protection.sql:97`):

```sql
v_caja_method := CASE
  WHEN NEW.currency = 'USD'                                   THEN 'usd'
  WHEN NEW.payment_method = 'efectivo'                        THEN 'efectivo'
  WHEN NEW.payment_method = 'transferencia'                   THEN 'transferencia'
  WHEN NEW.payment_method IN ('tarjeta_debito','tarjeta_credito',
                              'qr','mercado_pago','otro','mixto') THEN 'tarjeta'
  ELSE 'efectivo'
END;
```

Con ese `ELSE`, el POS **jamás** produce un `metodo_pago` fuera del catálogo de caja.

**La cuenta corriente no tiene mapper.** La RPC persiste el string crudo:

```sql
v_method := NULLIF(btrim(COALESCE(p_payment_method,'')), '');
INSERT INTO financial_movements (..., metodo_pago, ...) VALUES (..., v_method, ...);
```

### Matriz Concepto | POS | Cuenta Corriente | diferencia | canónico

| Concepto | POS | Cuenta Corriente | Diferencia | Cuál debe ser canónico |
|---|---|---|---|---|
| Catálogo de métodos | `MedioPago` (8) | `debito`/`credito` (fuera de todo catálogo) | **CC inventa valores** | **POS** (`MedioPago`) |
| Mapeo a `CajaMethod` | ✅ trigger con `ELSE` | ❌ **ninguno** | **CC evapora plata del arqueo** | **el mapper del POS** |
| Efectivo | FM `metodo_pago='efectivo'` | ✅ igual | — | ok |
| Transferencia | FM `'transferencia'` | ✅ igual | — | ok |
| Débito / Crédito | → `'tarjeta'` | → `'debito'` / `'credito'` **crudo** | **P0** | mapear a `'tarjeta'` |
| USD | `currency='USD'` → `'usd'` nativo | **imposible** (ARS fijo) | CC es monomoneda | — |
| Cobro mixto | ✅ N líneas de pago | ❌ un solo método por cobro | CC no soporta mixto | POS |
| Cuenta corriente | no genera FM ni BFE | n/a | — | ok |
| `caja_id` | vía trigger + `caja_id` explícito | ✅ parámetro | — | ok |
| `comprobante_payments` | ✅ | ✗ (usa `account_movements`) | libros distintos por diseño | ok |
| Idempotencia | ✅ `intent_hash` | ✅ `account_payment_requests` | — | ok |
| Cotización | `exchange_rate` por línea | fijo `1` | CC no cotiza | — |

**¿Cuenta Corriente usa un flujo legacy anterior a M7?** **Sí, en la pantalla principal.**
`/cuentas` usa un `INSERT` directo anterior a M6. La ficha del cliente sí usa el contrato
M6/M7 — pero con el catálogo de métodos equivocado.

---

## 7. Impacto en Caja

`CajaPage` lee `financial_movements WHERE caja_id = <caja>`; `close_cash_session_atomic`
recalcula los esperados server-side en **cuatro buckets, y sólo cuatro**:

```sql
v_exp_ef  := ... WHERE caja_id=p_caja_id AND COALESCE(metodo_pago,'efectivo')='efectivo';
v_exp_tr  := ... WHERE caja_id=p_caja_id AND metodo_pago='transferencia';
v_exp_ta  := ... WHERE caja_id=p_caja_id AND metodo_pago='tarjeta';
v_exp_usd := ... WHERE caja_id=p_caja_id AND metodo_pago='usd';
```

Un `metodo_pago='debito'` **no cae en ninguno**. `COALESCE` sólo rescata el `NULL`.

Y en el frontend, `CajaPage.tsx` agrava el efecto en direcciones **opuestas**:

- **la lista** (`:241`) hace `METHOD_META[...] || METHOD_META.efectivo` → el movimiento
  se muestra **etiquetado "Efec"**;
- **los totales** (`computeTotals`, `:102`) hacen `if (!result[method]) continue` → el
  movimiento **se descarta del balance**.

El operador ve una línea que dice "Efectivo" por $10 y un total de efectivo que no la
incluye. Y al cerrar, el arqueo le marca una diferencia fantasma.

**Verificado (caso E):** tras cobrar 20 efectivo + 10 transferencia + 10 débito en la
misma caja, los 4 buckets suman **30**, mientras que el total real de `financial_movements`
de esa caja es **40**. **10 evaporados.**

### Escenario del pedido, medido

| Paso | Resultado medido |
|---|---|
| A. Cliente debe $100 | ✅ saldo 100; la venta a CC **no** genera movimiento de caja (correcto) |
| B. Cobro $40 efectivo **por `/cuentas`** | saldo → 60 ✅ · **caja: 0** ❌ · BFE: 0 ❌ |
| C. Cobro $20 efectivo **por la ficha** | saldo → 40 ✅ · **arqueo efectivo = 20** ✅ · BFE ✅ |
| D. Cobro $10 transferencia | saldo → 30 ✅ · efectivo sigue 20 ✅ · transferencia = 10 ✅ |
| E. Cobro $10 débito | saldo → 20 ✅ · **FM creado pero fuera de los 4 buckets** ❌ |

El punto D del pedido —*"no inventar ingreso de efectivo"*— **funciona bien** por el
camino canónico. El problema no es que la transferencia contamine el efectivo; es que
por `/cuentas` **no entra nada** y por débito/crédito **se pierde**.

---

## 8. Impacto en el ledger financiero

| Camino | `account_movements` | `financial_movements` | `business_finance_entries` |
|---|---|---|---|
| `/cuentas` (legacy) | ✅ | ❌ | ❌ |
| ficha (canónico) | ✅ | ✅ | ✅ `cobro_cuenta_corriente` |

El BFE canónico se marca como espejo (`revenue_collection_mirror`) y queda **excluido del
P&L** — correcto: cobrar una deuda no reconoce venta nueva, la venta ya se reconoció al
emitir el comprobante. Ese diseño está bien y no hay que tocarlo.

Con el camino legacy, la plata cobrada **no existe** para finanzas: ni caja, ni
`v_finance_position`, ni el mix de medios de pago.

---

## 9. Reversas y anulaciones

| Evento | ¿Qué pasa hoy? |
|---|---|
| Anular un comprobante | ✅ `annul_comprobante_atomic` revierte la deuda de CC |
| Revertir una **imputación** | ✅ `reverse_payment_allocation_atomic` |
| **Revertir un cobro de CC** | ❌ **no existe RPC** |
| Borrar un cobro mal cargado | ❌ `DELETE` denegado — **42501** (medido, caso I3) |
| Editar un cobro | ❌ `UPDATE` revocado |

**El ledger es append-only para el cliente y no hay reversa canónica.** Un cobro mal
cargado —monto equivocado, cliente equivocado, cobro que nunca ocurrió— **no se puede
deshacer por ninguna vía de producto.** La única salida es un `ajuste` manual en sentido
contrario, que:

- deja el saldo correcto,
- pero **no revierte** el `financial_movement` → la caja queda con el ingreso fantasma,
- y no queda enlazado al cobro original (sin `reference_id`).

Esto es P0-OPERATIVO: en una beta con dinero real, equivocarse una vez es inevitable.

---

## 10. Moneda (ARS / USD)

**La cuenta corriente es ARS por construcción. No hay modelo multimoneda, ni parcial.**

Verificado (casos J1/J2):

- `account_movements` **no tiene** `currency`, `exchange_rate` ni `amount_ars`.
  `debit`/`credit` son numerics desnudos.
- `accounts.balance` es un numeric desnudo.
- La RPC fija `'ARS'`, `amount_ars := p_amount`, `exchange_rate := 1`. **No acepta**
  parámetros de moneda ni cotización.

Comparar con `create_order_payment_atomic`, que **sí** toma `p_currency` y
`p_exchange_rate`. La asimetría es real: órdenes y comprobantes cotizan; la CC no.

**Deuda en una moneda y pago en otra: no está soportado, ni siquiera representable.**
Y `CajaPage` sí tiene bucket `usd` — pero la CC nunca puede alimentarlo.

> **Recomendación:** no inventar soporte USD en este lote. Agregar moneda a la CC es un
> cambio de modelo (columnas nuevas, política de revaluación, decidir si la deuda se fija
> en USD o en ARS al tipo del día). Para la beta: **declararlo explícitamente como
> ARS-only en la UI** y no ofrecer un método "USD" que el backend no puede honrar.

---

## 11. Métodos de pago — por qué hay una descripción libre

**No es una elección de UX: es una consecuencia del esquema.**

`account_movements` **no tiene columna `payment_method`**. En el camino legacy, el único
destino posible para "cómo pagó" es el texto libre de `description`. El modal no muestra
un selector porque **no tendría dónde guardar el valor**.

El método de pago sólo existe cuando el cobro pasa por la RPC, porque el método vive en
`financial_movements.metodo_pago` — una tabla que el camino legacy nunca escribe.

**La descripción no debe reemplazar `payment_method`.** El objetivo del pedido
(monto → método → caja/finanzas según método → observación opcional) es exactamente el
contrato que la RPC canónica **ya implementa**. Falta conectarlo y corregir el catálogo.

---

## 12. RBAC

**P0-P6 dejó `/cuentas` afuera.** Comparación en `src/App.tsx`:

```tsx
<Route element={<ProtectedRouteByPermission permission="finance" />}>
  <Route path="/expenses" element={<Expenses />} />
  <Route path="/caja" element={<CajaPage />} />
</Route>

{/* Rutas PRO — currentAccounts */}
<Route element={<ProtectedRouteByFeature feature="currentAccounts" />}>
  <Route path="/cuentas" element={<CuentasCorrientes />} />   {/* ← SIN capacidad */}
</Route>

{/* P0-P6: feature del negocio Y capacidad del actor.
    El plan solo no alcanza: dejaba entrar a cualquier miembro. */}
<Route element={<ProtectedRouteByPermission permission="finance" />}>
<Route element={<ProtectedRouteByFeature feature="advancedFinance" />}>
  <Route path="/finance" element={<FinanceDashboard />} />
```

El comentario de P0-P6 describe **exactamente** el bug que sigue vivo en `/cuentas`:
está gateada **sólo por plan**, no por capacidad.

Y la RLS no compensa. Ambas policies usan `is_staff()`:

```sql
is_staff() := current_user_role() IN ('owner','admin','manager','tech','sales','cashier','viewer')
```

**`is_staff()` es verdadero para TODOS los roles, incluido `viewer`.**

Medido (casos H1–H3), actuando como un perfil `role='viewer'`:

| Acción | Resultado |
|---|---|
| Leer la deuda de todos los clientes | ✅ **permitido** |
| Insertar un movimiento en el ledger | ✅ **permitido** |
| `UPDATE accounts SET balance = 0` | ✅ **permitido** |

La RPC canónica tampoco ayuda: usa el modelo de pertenencia M6 —*"cualquier perfil activo
del negocio"*, documentado como preservado a propósito— **no** `current_user_can()`.

**Esto contradice directamente el requisito del pedido** (*"No abrir acceso financiero a
tech/viewer"*). Hoy está abierto, para lectura **y para escritura**.

La primitiva correcta existe y está desplegada: **`current_user_can(p_key text)`**.

---

## 13. UI / UX actual

**Ambigüedades de concepto**

1. **Dos botones "Registrar pago"** en dos pantallas, con el **mismo texto**, distinta
   contabilidad. Es la trampa central.
2. **"pago" vs "cobro"**. En `/cuentas` el botón dice *"Registrar pago"* (el cliente
   paga). En `ModalPagarCC` el título dice *"Registrar pago de CC"* pero el campo dice
   *"Monto a **cobrar**"* y el botón *"Confirmar pago"*. Desde el negocio es un **cobro**.
3. **"Registrar deuda"** graba `type='ajuste'`, no `type='venta'`. La UI dice una cosa y
   el ledger otra.
4. **Saldo sin signo explícito.** `fmtARS` hace `Math.abs()` y el signo se comunica sólo
   por color (rojo/azul). En "A favor" se lee un positivo que es un negativo.
5. **`credit_limit`** se pide al crear la cuenta y **no se valida en ninguna parte**.
6. **Bug visible:** el badge de estado del panel de detalle usa
   `getAccountStatus(account.balance)` (prop **congelada**) mientras el monto usa
   `localBalance` (fresco). Tras cobrar, el número se actualiza y **el badge no**:
   saldo $0 con badge "En deuda". `CuentasCorrientes.tsx:296` vs `:298`.
7. **Fecha inerte** en el modal legacy (§5).
8. **Extracto confuso:** `getMovements` ordena por `date DESC, created_at DESC`, pero
   `balance_after` es un saldo corrido **en orden de inserción**. Con cualquier
   antedatado, la columna de saldo del extracto no cuadra con la secuencia mostrada.
9. **Mobile:** el layout es `display:flex` con la lista en `flex: 0 0 360px` y el detalle
   al lado, **sin breakpoint**. En un teléfono, lista y panel compiten por el ancho.
10. **Métodos que mienten:** "Débito"/"Crédito" existen en el modal, se guardan, y luego
    no aparecen en el arqueo ni tienen etiqueta en los gráficos de mix
    (`METHOD_META` de `financialDashboardLoaders.ts` no tiene esas claves → se renderiza
    el string crudo).

**Flujo propuesto (simple, sin rediseñar todavía)**

```
/cuentas → seleccionar cliente → [Registrar cobro]
   ├─ Deuda actual:  $100                    (sólo lectura, server-side)
   ├─ Monto a cobrar: [ 40 ]  [Todo]         (tope = deuda; rechaza sobrepago)
   ├─ Método:  ( ) Efectivo  ( ) Transferencia  ( ) Débito  ( ) Crédito  ( ) Otro
   │            └─ efectivo exige caja abierta (ya lo valida la RPC)
   ├─ Observación (opcional)                 ← NO reemplaza el método
   └─ [Confirmar cobro]
        → "Cobrado $40. Nuevo saldo: $60. Impacta en caja."
        → si quedan comprobantes abiertos: [Imputar ahora] (opcional)
```

Es decir: **`ModalPagarCC`, con el catálogo corregido, montado también en `/cuentas`**.

---

## 14. Tests de caracterización

**Archivo nuevo:** `supabase/tests/p0cc_current_account_characterization_test.sql`

- **39 aserciones, todas PASS** contra la DB local en el head 237.
- Íntegramente dentro de `BEGIN … ROLLBACK`. Verificado post-ejecución: 0 filas
  residuales, 237 migraciones intactas.
- Documenta el comportamiento **actual**. Las aserciones que fijan un bug están marcadas
  `[BUG]` y **deben invertirse** cuando se repare.
- Escala 1:1 con el escenario humano del pedido (deuda 100, cobro 40, cobro 20).

**Caveat metodológico registrado en el propio archivo:** `finance_begin_audit_scope()`
hace `set_config('m7.audit_managed','1', true)` — **transaccional**. Como el test entero
es una sola transacción, el flag que pone el checkout silenciaría el backstop de auditoría
en los pasos siguientes. Se baja a mano antes de cada `INSERT` directo para medir el
comportamiento real. En producción cada request de PostgREST es su propia transacción, así
que no es un problema productivo — **pero cualquier test que mezcle RPC e `INSERT` directo
en una tx va a medir mal la auditoría si no lo contempla.**

---

## 15. Bugs reproducidos y clasificados

| ID | Clase | Hallazgo | Evidencia |
|---|---|---|---|
| **CC-1** | **P0-CONTABLE** | "Registrar pago" en `/cuentas` **no crea movimiento de caja ni asiento financiero**. El saldo baja, la plata desaparece del sistema. | B2, B3, B4 |
| **CC-2** | **P0-CONTABLE** | `ModalPagarCC` manda `debito`/`credito`; la RPC los persiste crudos; el arqueo tiene 4 buckets y ninguno los captura. **La plata se evapora del cierre.** | E2, E3, E4 |
| **CC-3** | **P0-CONTABLE / P0-SEGURIDAD** | `accounts.balance` es escribible directamente (`GRANT ALL` + policy `FOR ALL`). Se pisa sin ledger ni auditoría, **y el trigger ancla en él → corrupción permanente**. | H3, H4, H5 |
| **CC-4** | **P0-SEGURIDAD** | `/cuentas` gateada **sólo por plan**. Un `viewer` lee toda la deuda, **escribe en el ledger** y pisa saldos. P0-P6 no la cubrió. | H1, H2, H3 |
| **CC-5** | **P0-OPERATIVO** | **No existe reversa de un cobro de CC.** `DELETE` da 42501, `UPDATE` revocado. Un cobro mal cargado es irreversible por producto. | I1, I3 |
| **CC-6** | **P0-CONTABLE** | El camino legacy **no es idempotente**: doble click = doble cobro. | F4 |
| **CC-7** | **P0-CONTABLE** | El camino legacy **acepta sobrepago** sin guard → saldo negativo arbitrario. (El canónico lo rechaza: G1.) | G2 |
| **CC-8** | UX-PRE-BETA | El input de **fecha del modal legacy no se usa**: siempre graba hoy. | `CuentasCorrientes.tsx:58,120` vs `:66-78` |
| **CC-9** | UX-PRE-BETA | Badge de estado congelado: saldo $0 con badge "En deuda". | `:296` vs `:298` |
| **CC-10** | UX-PRE-BETA | `CajaPage` **etiqueta como "Efectivo"** todo método desconocido, pero lo **excluye** de los totales. | `CajaPage.tsx:241` vs `:102` |
| **CC-11** | UX-PRE-BETA | Dos botones "Registrar pago" idénticos con contabilidad distinta. | §2 |
| **CC-12** | UX-PRE-BETA | "Registrar deuda" graba `type='ajuste'`, no `'venta'`. | `cuentasService.ts:181-188` |
| **CC-13** | P1 | `credit_limit` se captura y **nunca se valida**. | `cuentasService.ts:126` |
| **CC-14** | P1 | `debito`/`credito` sin entrada en `METHOD_META` → string crudo en los gráficos. | `financialDashboardLoaders.ts:119` |
| **CC-15** | P1 | `ModalCobro.tsx` (836 líneas) **no está montado**: código muerto. | sin `<ModalCobro` en todo `src` |
| **CC-16** | P1 | Órdenes y CC son **libros de deuda disjuntos**; sólo convergen vía comprobante. | §4 |
| **CC-17** | P1 | Extracto ordenado por fecha pero `balance_after` corre por inserción. | `cuentasService.ts:132-141` |

---

## 16. Causas raíz

1. **M6 se aplicó a medias.** Se construyó el contrato canónico y se montó en una sola de
   las dos superficies. El smoke *"OK (estático)"* validó la superficie migrada y nunca
   preguntó si había otra. → CC-1, CC-6, CC-7, CC-11.

2. **El catálogo de métodos de pago nunca se unificó.** Existen 5 catálogos. El POS tiene
   un mapper con `ELSE` que lo hace infalible; la CC se escribió después, sin mapper, con
   valores inventados en el componente. → CC-2, CC-10, CC-14.

3. **`ledger_protection` blindó el ledger pero no la cabecera.** Se revocó `UPDATE`/`DELETE`
   sobre `account_movements` y se olvidó `accounts`, que conserva `GRANT ALL` + policy
   `FOR ALL` del baseline. Con un saldo materializado que el trigger usa como ancla, esa
   omisión es contable, no sólo de permisos. → CC-3.

4. **P0-P6 recorrió las rutas financieras conocidas** (`/caja`, `/expenses`, `/finance`) y
   `/cuentas` no estaba en esa lista porque su gate existente (`currentAccounts`) *parecía*
   un gate. Es de plan, no de actor. → CC-4.

5. **El modelo de reversa se construyó por documento** (anular comprobante, revertir
   imputación) y el cobro a cuenta —que no es un documento— quedó sin su reversa. → CC-5.

---

## 17. Propuesta de arquitectura canónica

**Una sola superficie, una sola RPC, un solo catálogo.**

```
CUALQUIER "registrar cobro de CC"
   └─→ ModalPagarCC (único componente)
        └─→ cuentasService.registrarPagoCC
             └─→ record_customer_account_payment_atomic
                  ├─ normalize_cc_payment_method(p_method) → CajaMethod   ← NUEVO
                  ├─ account_movements (credit)
                  ├─ financial_movements (income, caja_id, metodo_pago NORMALIZADO)
                  └─ business_finance_entries (espejo, fuera del P&L)
```

**Principios:**

1. **`account_movements` deja de ser escribible directamente desde el cliente** para
   `type='pago'`. Los `ajuste`/`deuda` manuales necesitan su propia RPC con capacidad.
2. **`accounts.balance` deja de ser escribible.** Sólo el trigger.
3. **El método de pago se normaliza server-side**, igual que en el POS. El cliente puede
   mandar cualquier cosa: la DB decide en qué bucket cae. Nunca un valor huérfano.
4. **Todo acto financiero de CC exige `current_user_can('finance')`** — en la ruta, en la
   RLS y en la RPC.
5. **ARS explícito.** No se ofrece USD hasta que exista el modelo.
6. **Toda operación tiene reversa canónica**, enlazada al original.

---

## 18. Lista exacta de archivos y migraciones a tocar

### Frontend

| Archivo | Cambio |
|---|---|
| `src/pages/CuentasCorrientes.tsx` | Reemplazar la rama `'pago'` de `MovementModal` por `ModalPagarCC`. Arreglar el badge congelado (`:298`). Quitar o cablear el input de fecha (`:58,120`). Renombrar a "Registrar cobro". Breakpoint mobile. |
| `src/components/comprobantes/ModalPagarCC.tsx` | `METODOS`: `debito`→`tarjeta_debito`, `credito`→`tarjeta_credito`, agregar `otro`. Deshabilitar "Efectivo" sin caja abierta (hoy sólo falla al confirmar). |
| `src/services/cuentasService.ts` | Marcar `registerPayment` como `@deprecated` y sacarle los llamadores; luego eliminarla. `registerDebt`/`addAdjustment` → RPC nueva. |
| `src/App.tsx` | Envolver `/cuentas` en `<ProtectedRouteByPermission permission="finance" />`. |
| `src/pages/CajaPage.tsx` | `computeTotals`: no descartar en silencio — acumular lo desconocido en un bucket visible. La lista no debe etiquetar como "Efectivo" lo que no lo es (`:241`). |
| `src/hooks/financialDashboardLoaders.ts` | Alinear `METHOD_META` con el catálogo canónico. |
| `src/components/cobro/ModalCobro.tsx` | **Eliminar** (código muerto). |

### Migraciones (todas nuevas, ninguna escrita todavía)

| # | Migración | Contenido |
|---|---|---|
| **M1** | `..._p0cc_normalize_cc_payment_method` | `normalize_cc_payment_method(text) → CajaMethod` (IMMUTABLE, con `ELSE 'efectivo'` como el POS). `CREATE OR REPLACE` de `record_customer_account_payment_atomic` para aplicarlo antes del `INSERT` en `financial_movements`. **Sólo esto ya cierra CC-2.** |
| **M2** | `..._p0cc_accounts_lockdown` | `REVOKE UPDATE, DELETE ON accounts FROM authenticated, anon`. Reemplazar la policy `accounts_plan` (`FOR ALL`) por `SELECT` + `INSERT`. Trigger que rechace cualquier `UPDATE` de `balance` que no venga del trigger de ledger. Cierra CC-3. |
| **M3** | `..._p0cc_capability_rbac` | Policies de `accounts` y `account_movements`: `is_staff()` → `current_user_can('finance')`. Guard de capacidad dentro de la RPC canónica. Cierra CC-4. |
| **M4** | `..._p0cc_manual_movement_rpc` | RPC para `ajuste`/`deuda` manual con capacidad, auditoría e idempotencia. Habilita revocar el `INSERT` directo. |
| **M5** | `..._p0cc_reverse_account_payment` | `reverse_customer_account_payment_atomic`: contra-movimiento en el ledger **+** reversa del `financial_movement` **+** reversa del BFE, enlazado por `reference_id`, idempotente. Cierra CC-5. |
| **M6** | `..._p0cc_ledger_insert_lockdown` | Revocar el `INSERT` directo de `account_movements` a `authenticated` (después de M4/M5). Cierra CC-1 a nivel DB, CC-6 y CC-7. |
| **M7** | *(condicional)* `..._p0cc_repair_orphan_methods` | Reparación histórica de `financial_movements` con `metodo_pago` fuera de catálogo. **Requiere medición previa en prod.** No recalcular cajas ya cerradas. |

### Tests

| Archivo | Cambio |
|---|---|
| `supabase/tests/p0cc_current_account_characterization_test.sql` | **Ya escrito.** Invertir las aserciones `[BUG]` a medida que cada lote cierra. |
| `tests/components/cuentasCorrientes.test.tsx` | **Nuevo.** Que `/cuentas` monte `ModalPagarCC` y que un cobro llame a la RPC — no a `.from('account_movements').insert`. |
| `scripts/guards/no-direct-finance-writes.mjs` | Extender el guard existente para prohibir `.from('account_movements').insert` en `src/`. |

---

## 19. Plan de implementación por lotes

| Lote | Alcance | Cierra | Riesgo | Deploy |
|---|---|---|---|---|
| **CC-A** | **M1** (normalizador) + `ModalPagarCC` al catálogo canónico | CC-2 | **Bajo** — aditivo, sin cambio de contrato | DB primero, luego frontend |
| **CC-B** | Montar `ModalPagarCC` en `/cuentas`; deprecar `registerPayment`; fix badge y fecha | CC-1, CC-6, CC-7, CC-8, CC-9, CC-11 | **Bajo** — sólo frontend | Frontend |
| **CC-C** | **M2** + **M3**: lockdown de `accounts` y capacidad `finance` | CC-3, CC-4 | **Medio** — puede romper lectores legítimos. Medir antes quién consulta `accounts` | DB, con smoke por rol |
| **CC-D** | **M4** + **M5**: RPC de ajuste manual y **reversa de cobro** + UI | CC-5, CC-12 | **Medio** — lógica financiera nueva | DB primero |
| **CC-E** | **M6**: revocar el `INSERT` directo | blinda CC-1 | **Alto** — fail-closed. Sólo tras A–D | DB, con rollback listo |
| **CC-F** | Limpieza: borrar `ModalCobro`, `METHOD_META`, `credit_limit`, mobile, extracto | CC-13..CC-17 | Bajo | Frontend |
| **CC-G** | *(condicional)* **M7**: reparación histórica | — | **Alto** — toca datos reales | Sólo con dry-run aprobado |

**Mínimo para desbloquear la beta: CC-A + CC-B + CC-C.**
CC-A y CC-B eliminan la pérdida de dinero; CC-C cierra el acceso financiero indebido.

---

## 20. Riesgos

1. **Datos históricos con `metodo_pago` huérfano.** Antes de M1 hay que **medir en
   producción** cuántos `financial_movements` tienen `metodo_pago NOT IN
   ('efectivo','transferencia','tarjeta','usd')`. Cada uno es plata fuera del arqueo.
   *No se midió en esta fase: el pedido excluye tocar producción.*

2. **Cobros legacy ya registrados.** Cada cobro hecho por `/cuentas` desde M6 bajó una
   deuda sin subir la caja. Las cajas de esos días cerraron con una diferencia que el
   operador probablemente justificó a mano. **No recalcular cierres históricos** (regla
   M6/M7). La reparación, si se hace, es hacia adelante.

3. **CC-C puede romper lecturas legítimas.** Pasar de `is_staff()` a
   `current_user_can('finance')` es más restrictivo. Un `cashier` que hoy cobra por
   `/cuentas` necesita `finance` — según P0-P6 lo tiene por default, pero hay que
   confirmarlo por rol antes de aplicar.

4. **`GRANT` y RLS son capas distintas** (lección de `p0-finance-position-403`): revocar el
   `GRANT` produce **42501**, no un set vacío. La UI debe manejar el error, no mostrar $0.

5. **CC-E es fail-closed.** Si queda algún escritor directo sin migrar, deja de funcionar
   en silencio. Va último, con el guard de `scripts/guards/` como red.

6. **Orden de deploy.** Regla del repo, ya medida: para cambios que **restringen**, DB
   primero sólo si el frontend desplegado ya es compatible. CC-B (frontend) debe salir
   **antes** de CC-E (DB restrictiva).

7. **Vercel auto-deploya en el merge** (lección de `p0-secdef-public-execute-canonical`):
   el frontend sale con el merge, la DB no. Planificar la ventana.

---

## 21. Tests necesarios

- ✅ **Ya escrito:** `p0cc_current_account_characterization_test.sql` (39 aserciones).
- **Por lote:** invertir cada aserción `[BUG]` al cerrarla — es el criterio de aceptación.
- **Nuevo, por rol:** que `viewer`/`tech` reciban 42501 al insertar en el ledger y al
  actualizar `accounts`, y que `cashier`/`owner` sigan cobrando.
- **Nuevo, normalizador:** tabla de verdad de `normalize_cc_payment_method` — todo input,
  incluido basura, cae en uno de los 4 buckets.
- **Nuevo, arqueo:** invariante `SUM(4 buckets) == SUM(financial_movements de la caja)`.
  Es el test que hubiera atrapado CC-2 solo.
- **Nuevo, reversa:** cobrar → revertir → saldo, caja y BFE vuelven al estado previo; dos
  reversas de la misma key no duplican.
- **Componente:** que `/cuentas` no llame nunca a `.from('account_movements').insert`.
- **E2E:** cobrar desde `/cuentas` y verificar que la caja sube en la misma sesión.

---

## 22. Resumen ejecutivo

El backend financiero de M6/M7 **está bien construido**. La RPC canónica de cobro de
cuenta corriente hace todo lo que hay que hacer, de forma atómica, idempotente y auditada.

Lo que pasó es que **la pantalla que el owner usa no la llama**, y la pantalla que sí la
llama **le manda un método de pago que la caja no sabe leer**. A eso se suma que la
columna de saldo quedó fuera del blindaje del ledger, que `/cuentas` quedó fuera de
P0-P6, y que un cobro mal cargado no se puede deshacer.

Son **7 hallazgos P0** (5 contables, 1 de seguridad con arista contable, 1 operativo),
todos **reproducidos con evidencia** contra la DB real, todos con reparación conocida y
acotada. El modelo no hay que rediseñarlo: **hay que terminar de conectarlo.**

**Veredicto: B.**

---

## 23. Estado de esta fase

- ❌ No se implementaron fixes.
- ❌ No se aplicaron migraciones.
- ❌ No se hizo merge ni deploy.
- ❌ No se tocaron datos reales — todo en `BEGIN … ROLLBACK` verificado.
- ✅ Un archivo nuevo: el test de caracterización.

**Detenido después del informe, según lo pedido.**
