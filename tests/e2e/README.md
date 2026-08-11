# TechRepair Pro — Tests E2E con Playwright

> **Los E2E corren SIEMPRE contra el Supabase LOCAL. Nunca contra un proyecto remoto.**
>
> No es una recomendación: es lo que impone el código. `tests/e2e/setup/globalSetup.ts`
> valida el destino antes del primer test y **aborta** si la URL es un Supabase gestionado
> (`*.supabase.co` / `*.supabase.in`), si el host no es local, o si el backend no tiene el
> marker `e2e_environment_marker`. No existe ningún escape tipo `ALLOW_PRODUCTION_E2E`, y
> hay un test que falla si alguien lo agrega.
>
> Los E2E **escriben datos**: crean comprobantes, pagos y movimientos de caja. Por eso el
> guard es fail-closed — ante la duda, corta.

Fuente de verdad de la operativa: [`docs/auditoria-finanzas/m7/7d2-e2e-local-operativa.md`](../../docs/auditoria-finanzas/m7/7d2-e2e-local-operativa.md).

---

## Requisitos

- **Docker corriendo** — el stack local de Supabase vive ahí.
- **Node 20+** (el camino de un solo comando necesita **Node 22+**: los scripts de
  `scripts/e2e/` importan `assertLocalTarget.ts` para no duplicar el guard, y eso usa el
  type stripping nativo).
- Browsers de Playwright:

```bash
npm ci && npx playwright install chromium
```

---

## Cómo correr los E2E

### Camino de un solo comando (el mismo que corre CI)

```bash
npm run e2e:ci-local
```

Levanta el stack, valida el destino, genera `.env.e2e` desde `supabase status`, aplica el
marker y el seed, y lanza la suite `m7-local`. **Es literalmente el mismo comando que
ejecuta GitHub Actions**: un fallo de CI se reproduce acá sin empujar commits a ciegas.

Respeta un `.env.e2e` existente (no lo pisa) y verifica que apunte al stack en marcha.

```bash
npm run e2e:ci-local -- --reset          # además resetea la DB a las migraciones
npm run e2e:ci-local -- --write-env      # fuerza regenerar .env.e2e
npm run e2e:ci-local -- --grep @m7       # cualquier flag extra va a Playwright
```

### Camino manual

```bash
npx supabase start        # stack local (Docker)
npm run e2e:prepare       # marker de entorno + datos de negocio (idempotente)
npm run e2e:m7            # suite M7
npm run e2e:m7:ui         # la misma, en modo UI
```

### Lo que NO hay que hacer

- **No levantes `npm run dev`.** Playwright arranca **su propio** server con el bloque
  `webServer` de `playwright.config.ts` (`vite build --mode e2e && vite preview --port 5174`),
  y `reuseExistingServer: false`.
- **El puerto es 5174, no 5173.** A propósito: `npm run dev` sirve en 5173 un bundle
  construido contra el `.env` **productivo**. Con puerto propio, el server de E2E siempre
  es uno que arrancamos nosotros en modo `e2e`.
- **`--mode e2e` no es cosmético.** Sin él, `vite build` corre en modo production y hornea
  `.env` → el Supabase productivo. Ese fue exactamente el blocker de 7D.1.

---

## Variables de entorno

**`.env.e2e` es el único archivo de entorno de los E2E.** Plantilla versionada:
[`.env.e2e.example`](../../.env.e2e.example). Se completa con `npx supabase status`.

```bash
cp .env.e2e.example .env.e2e   # y completar con `npx supabase status`
```

| Variable | Para qué |
|---|---|
| `VITE_SUPABASE_URL` | **Debe** ser el stack local. El guard rechaza cualquier otra cosa. |
| `VITE_SUPABASE_ANON_KEY` | Anon key local. |
| `E2E_DATABASE_URL` | El "DB URL" de `supabase status`. Lo usa `e2e:prepare` para marker y datos. |
| `E2E_BASE_URL` | Default `http://localhost:5174`. |
| `E2E_EMAIL` / `E2E_PASSWORD` | Usuario que **siembra el setup**, no una cuenta real. |
| `SUPABASE_SERVICE_ROLE_KEY` | Sólo procesos Node (seed y guard). **Nunca** como `VITE_*`. |

`.env.e2e` está en `.gitignore` — nunca aparece en commits.

> **`.env.test` está muerto: nada lo lee.** `playwright.config.ts` carga `.env.e2e` y
> documenta por qué dejó de leer `.env.test` — nunca definió `VITE_SUPABASE_URL`, y aunque
> lo hubiera hecho, un build en modo production jamás lo habría leído. Su plantilla
> `.env.test.example` todavía sugiere un proyecto remoto (`https://YOUR_PROJECT.supabase.co`):
> apuntar a un backend real era el diseño de entonces, no un accidente. Si tenés un
> `.env.test` viejo, ignoralo.

> **`service_role` jamás como `VITE_*`.** Cualquier `VITE_*` termina en el bundle del
> browser.

---

## Las cuatro barreras

Son independientes a propósito: cada una tapa lo que las otras no ven.

| # | Barrera | Dónde | Qué tapa |
|---|---|---|---|
| 1 | Modo `e2e` | `playwright.config.ts` (`vite build --mode e2e`) | Que el bundle se hornee contra `.env` productivo |
| 2 | Guard de destino | `setup/globalSetup.ts` → `setup/assertLocalTarget.ts` | Que la URL sea remota, o local sin marker |
| 3 | Verificación del bundle servido | `setup/globalSetup.ts` | Que el `.env` leído y el `.env` horneado difieran |
| 4 | Bloqueo de red en el browser | `m7/fixtures.ts` | Una URL productiva hardcodeada, un tercero, telemetría |

**El marker.** Un hostname local no alcanza como prueba de destino seguro: se puede
tunelizar producción a `127.0.0.1`. El guard exige evidencia positiva — la tabla
`public.e2e_environment_marker` con `environment='e2e_local'`. En producción no existe, así
que la suite aborta antes de conectarse. `setup/e2eMarker.sql` **no es una migración** y
vive fuera de `supabase/migrations/` a propósito.

---

## El seed (no hay usuario QA que crear a mano)

`tests/e2e/setup/seedE2E.ts` es idempotente y usa UUIDs determinísticos. El `globalSetup`
lo corre en cada arranque y siembra:

- Usuario de Auth (`E2E_EMAIL`), perfil y negocio `E2E Local`
- Cliente e inventario de prueba
- **Caja abierta** (`cajas.status = 'abierta'`)
- Un **segundo negocio ajeno** que el usuario E2E no debe poder ver

El `globalSetup` verifica ese aislamiento en cada corrida: si RLS se rompe, la suite no
arranca. Después hace **login real** por formulario y guarda `storageState` en
`tests/e2e/.auth/` (ignorado por Git). No se simulan sesiones ni se inyectan tokens: si el
login no funciona, los E2E no prueban nada.

> **Trampa de RLS:** `current_business_id()` resuelve por `profiles.id = auth.uid()`, **no**
> por `profiles.user_id`. Si el login termina en `/no-business`, es esto.

---

## Suites

| Proyecto | Qué corre | Estado |
|---|---|---|
| `m7-local` | `tests/e2e/m7/*.spec.ts` — autenticada vía `storageState` | Suite mantenida. Es la que gatea CI. |
| `chromium` | El resto de `tests/e2e/` | Legacy. Conserva sus ~136 fallas históricas. |

El guard vive en `globalSetup`, así que aplica a **las dos**. Está probado: apuntar
`.env.e2e` a producción hace abortar incluso un spec legacy.

7D.2 **no** arregla las fallas legacy — sólo garantiza que ya no corran contra producción.
Al comparar resultados, usar ese baseline histórico, no "verde absoluto".

### Suite `m7-local`

| Spec | Cubre |
|---|---|
| `defensa-red.spec.ts` | Bloqueo HTTP + WebSocket + service worker a destinos prohibidos |
| `replace-normal.spec.ts` | Reemplazo de cobro exitoso, verificación completa en base |
| `replace-lost-response.spec.ts` | Respuesta perdida → retry con la misma key → replay |
| `replace-payment-set-changed.spec.ts` | Reemplazo canónico de otro actor + contrato `PAYMENT_SET_CHANGED` |
| `replace-idempotency-conflict.spec.ts` | Key reusada con payload distinto → `IDEMPOTENCY_CONFLICT` |
| `replace-key-rotation.spec.ts` | Rotación de key por medio/monto/notas |
| `error-codes.spec.ts` | `PERIOD_CLOSED`, `CASH_REGISTER_NOT_OPEN`, `ALREADY_ANNULLED` — errores reales |
| `double-click.spec.ts` | Doble confirmación → una sola operación, una sola key |
| `gasto-idempotencia.spec.ts` | Doble clic, respuesta perdida, conflicto y refresh en gastos |
| `health-check.spec.ts` | Health Check v2, fallback avisado a v1, estados controlados |
| `health-check-visual.spec.ts` | `@visual` — gate visual del Health Check |
| `finance-caja-visual.spec.ts` | `@visual-caja` — gate visual de Finanzas → Caja (P1-A / P1-D) |
| `charts-l1-visual.spec.ts` | `@visual-l1` — gate visual de Charts L1 |

Helpers: `m7/observability.ts` (`GrabadorRPC`: distingue doble-clic / retry / replay /
intención nueva / error terminal), `setup/fixturesM7.ts` (fixtures de período cerrado, caja
cerrada, anulación + verificadores en base) y `setup/sqlLocal.ts` (ejecutor SQL por
`docker exec`, que estructuralmente no puede tocar prod).

### Suite legacy (extracto)

| Archivo | Tags | Descripción | Crea datos |
|---|---|---|---|
| `auth-navigation.spec.ts` | `@smoke` | Login + navegación por 6 secciones + redirect protegido | No |
| `customer-inventory.spec.ts` | `@smoke` | Crear cliente E2E + crear producto E2E | Sí — prefijo `E2E ` |
| `editar-cobro-unico.spec.ts` | `@finance` | Regresión BUG-01 — autosuficiente (toma el primer comprobante) | No |
| `editar-cobro-mixto.spec.ts` | `@finance` | Regresión BUG-01 pago mixto — requiere ID manual | No |
| `expenses-atomic.spec.ts` | `@finance` | Gastos atómicos INF-02 — crear gasto + validar error | Sí — prefijo `E2E ` |
| `nota-credito.spec.ts` | `@finance` | Widget NC correcto sin "Pendiente de cobro" | No |
| `orders-create.spec.ts` | `@orders` | Crear orden via UI, verificar detalle + navegación lista | Sí |
| `orders-minimal.spec.ts` | `@orders` | Orden mínima: sin `undefined`/`null`/`NaN` en el preview | Sí |
| `orders-print.spec.ts` | `@orders @print` | Branding en impresión — estructura y consistencia | Sí |
| `orders-status.spec.ts` | `@orders` | Crear orden y cambiar estado; verifica persistencia | Sí |

El resto de `tests/e2e/*.spec.ts` (personal/Mi Guita, WhatsApp, proveedores, garantías,
tema, SaaS) corre en el mismo proyecto `chromium` y arrastra el grueso del baseline.

```bash
npm run test:e2e -- --grep @orders
npm run test:e2e -- --grep "@orders @print"
```

**Impresión:** los tests `@print` no activan el diálogo nativo del browser. Validan el DOM
de `ServiceOrderPrint` antes de que se abra la ventana; `window.open` se stubea. El nombre
del negocio depende de `business_settings.nombre_comercial`; si está vacío muestra
"Mi Negocio" (correcto). Los tests verifican **consistencia entre rutas**, no un valor
absoluto.

---

## Tests que se saltean si faltan IDs

Algunos specs legacy aceptan un UUID fijo por entorno. Si no está, se **saltean** sin
fallar la suite. Van en **`.env.e2e`** (`playwright.config.ts` lo carga a `process.env`):

| Variable | Spec | Qué necesita |
|---|---|---|
| `E2E_COMPROBANTE_ID_MIXTO` | `editar-cobro-mixto` | Comprobante con pago mixto (varias filas en `comprobante_payments`) |
| `E2E_NOTA_CREDITO_ID` | `nota-credito` | Comprobante tipo nota de crédito |
| `E2E_COMPROBANTE_ID_EFECTIVO` | `editar-cobro-unico` | Opcional — fija el comprobante en vez de tomar el primero |
| `E2E_CUSTOMER_ID` | `customer-purchases`, `whatsapp-actions` | Cliente con compras |
| `E2E_INVENTORY_ID` | `inventory-product-history` | Producto con movimientos |
| `E2E_SUPPLIER_ID` | `supplier-detail` | Proveedor con cuenta corriente |
| `E2E_ORDER_ID`, `E2E_COMPROBANTE_ID`, `E2E_WARRANTY_ID` | `whatsapp-actions` | Entidades con acción de WhatsApp |

**Por qué no son autosuficientes:** crear un comprobante mixto desde UI requiere el
`ComprobanteProModal` con método "Mixto"; una NC requiere primero un comprobante base y
después emitirla. Dos pasos dependientes, propensos a flakiness.

**Cómo obtener un ID:** crear la entidad desde la app (contra el stack local) y copiar el
UUID de la URL — `/comprobantes/<uuid>`.

---

## Convenciones de datos E2E

- Los datos creados por los tests usan prefijo **`E2E `** (ej: `E2E Cliente 1A2B3C`).
- La base es local y descartable: para limpiar, `npx supabase db reset` (o
  `npm run e2e:ci-local -- --reset`). No hace falta script de cleanup.
- El seed es idempotente: correrlo dos veces deja el mismo estado.

---

## data-testid disponibles

| Elemento | Selector |
|---|---|
| Login email | `[data-testid="login-email"]` |
| Login password | `[data-testid="login-password"]` |
| Login submit | `[data-testid="login-submit"]` |
| Customers — nuevo | `[data-testid="customers-new-button"]` |
| Customers — búsqueda | `[data-testid="customers-search-input"]` |
| NewCustomer — nombre | `[data-testid="customer-name-input"]` |
| NewCustomer — teléfono | `[data-testid="customer-phone-input"]` |
| NewCustomer — guardar | `[data-testid="customer-save-button"]` |
| Inventory — nuevo (abre dropdown) | `[data-testid="inventory-new-product-button"]` |
| Inventory — nuevo · simple | `[data-testid="inventory-new-product-simple"]` |
| Inventory — nuevo · con variantes | `[data-testid="inventory-new-product-variants"]` |
| Inventory — búsqueda | `[data-testid="inventory-search-input"]` |
| ProductForm — nombre | `[data-testid="product-name-input"]` |
| ProductForm — stock | `[data-testid="product-stock-input"]` |
| ProductForm — costo | `[data-testid="product-cost-input"]` |
| ProductForm — precio | `[data-testid="product-price-input"]` |
| ProductForm — guardar | `[data-testid="product-form-save-button"]` |
| Expense — nuevo | `[data-testid="expense-new-button"]` |
| Expense — descripción | `[data-testid="expense-description-input"]` |
| Expense — monto | `[data-testid="expense-amount-input"]` |
| Expense — método | `[data-testid="expense-payment-method-select"]` |
| Expense — guardar | `[data-testid="expense-save-button"]` |
| Comprobante widget cobro | `[data-testid="estado-cobro-widget"]` |
| Comprobante editar cobro | `[data-testid="edit-payment-button"]` |
| Editar cobro — método | `[data-testid="edit-payment-method-select"]` |
| Editar cobro — monto | `[data-testid="edit-payment-amount-input"]` |
| Editar cobro — guardar | `[data-testid="edit-payment-save-button"]` |

> **Ojo con dos selectores que cambiaron en producto y siguen viejos en specs legacy:**
> `inventory-new-button` → hoy es `inventory-new-product-button`, y
> `product-save-button` → hoy es `product-form-save-button`. Los specs
> `stock-sale`, `customer-inventory`, `cuenta-corriente-cliente` y `caja-comprobante`
> todavía usan los nombres viejos; es parte del baseline de fallas legacy, no un problema
> de entorno. La tabla de arriba refleja **el producto**, que es la referencia para
> cualquier spec nuevo.

---

## Artefactos ante falla

Trace, screenshot y video quedan en `playwright-report/` y `test-results/`.

```bash
npx playwright show-report
```

## Evidencia visual

Los gates visuales comparan contra las imágenes de `tests/e2e/evidencia/`. Para
regenerarlas después de un cambio de UI intencional:

```bash
npm run e2e:m7:evidencia
```

> Un gate puramente geométrico con datos sembrados chicos puede **no** detectar una
> regresión de layout. Al tocar un gate visual, romperlo a propósito una vez para
> comprobar que efectivamente falla.
