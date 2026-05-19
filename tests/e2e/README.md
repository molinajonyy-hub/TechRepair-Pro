# TechRepair Pro — Tests E2E con Playwright

## Instalación

```bash
# Instalar dependencias (Playwright ya está en devDependencies)
npm install

# Instalar browsers de Playwright
npx playwright install chromium
```

---

## Configurar variables de entorno

```bash
# 1. Copiar el template
cp .env.test.example .env.test

# 2. Completar .env.test manualmente (NUNCA commitear este archivo)
```

Contenido mínimo de `.env.test`:

```
E2E_BASE_URL=http://localhost:5173
E2E_EMAIL=tu_usuario_qa@ejemplo.com
E2E_PASSWORD=tu_password_qa
```

**Reglas de seguridad:**
- `.env.test` está en `.gitignore` — nunca aparecerá en commits.
- Usar un usuario QA dedicado, no una cuenta de negocio real.
- No correr tests `@finance` contra `techrepairpro.app` (producción) sin datos aislados.

---

## Cómo correr los tests

### Paso 1 — levantar el dev server (en una terminal separada)

```bash
npm run dev
```

### Paso 2 — correr tests

```bash
# Todos los tests
npm run test:e2e

# Solo tests @smoke (seguros, solo lectura + crear datos E2E)
npm run test:e2e -- --grep @smoke

# Solo tests @finance
npm run test:e2e -- --grep @finance

# Modo UI interactivo (recomendado para desarrollo)
npm run test:e2e:ui

# Con browser visible
npm run test:e2e:headed

# Debug paso a paso
npm run test:e2e:debug
```

---

## Tests disponibles

| Archivo | Tags | Descripción | Crea datos | Seguro en producción |
|---|---|---|---|---|
| `auth-navigation.spec.ts` | `@smoke` | Login + navegación por 6 secciones + redirect protegido | No | Sí — solo lectura |
| `customer-inventory.spec.ts` | `@smoke` | Crear cliente E2E + crear producto E2E | Sí — prefijo `E2E ` | No — crea datos |
| `editar-cobro-unico.spec.ts` | `@finance` | Regresión BUG-01 — autosuficiente (toma primer comprobante disponible) | No | No — modifica cobro |
| `editar-cobro-mixto.spec.ts` | `@finance` | Regresión BUG-01 pago mixto — requiere ID manual | No | No — modifica cobro |
| `expenses-atomic.spec.ts` | `@finance` | Gastos atómicos INF-02 — crear gasto + validar error | Sí — prefijo `E2E ` | No — crea datos |
| `nota-credito.spec.ts` | `@finance` | Widget NC correcto sin "Pendiente de cobro" | No | No — requiere NC |
| `orders-create.spec.ts` | `@orders` | Crear orden via UI, verificar detalle + navegación lista | Sí — marca, modelo, orden | No — crea datos |
| `orders-minimal.spec.ts` | `@orders` | Orden mínima: verifica que no aparecen undefined/null/NaN en preview | Sí | No — crea datos |
| `orders-print.spec.ts` | `@orders @print` | Branding en impresión (tabla + modal detalle) — estructura y consistencia | Sí | No — crea datos |
| `orders-status.spec.ts` | `@orders` | Crear orden y cambiar estado; verifica persistencia | Sí | No — crea datos |

### Cómo correr @orders

```bash
npm run dev   # terminal 1

npm run test:e2e -- --grep @orders      # terminal 2
npm run test:e2e -- --grep "@orders @print"  # solo tests de impresión
```

### Datos creados por @orders

- Marcas de dispositivo: `E2E-Brand-XXXXXX`
- Modelos de dispositivo: `E2E-Model-XXXXXX`
- Órdenes: vinculadas a clientes E2E existentes

### Advertencia de impresión

Los tests `@print` no activan el diálogo nativo del browser. Validan el DOM del `ServiceOrderPrint` (hidden div o modal preview) antes de que se abra la ventana. El `window.open` se stubea para tests de tabla.

### Requisitos de @orders

- La cuenta QA debe tener al menos **un cliente registrado** (creado por `@smoke` o manualmente).
- Para los tests de impresión desde tabla: debe haber al menos una orden (los tests `@orders` crean una).
- El nombre del negocio mostrado en impresión depende de `business_settings.nombre_comercial`. Si está vacío, muestra "Mi Negocio" (comportamiento correcto). Los tests verifican CONSISTENCIA entre rutas, no un valor absoluto.

---

## Tests con `test.fixme` (se saltean si faltan IDs)

Estos tests requieren IDs manuales en `.env.test`. Si los IDs no están, el test se **saltea automáticamente** sin fallar la suite.

### `editar-cobro-mixto.spec.ts`

Necesita un comprobante con pago **mixto** (múltiples filas en `comprobante_payments`).

**Por qué no es autosuficiente:** Crear un comprobante mixto desde UI requiere interactuar con `ComprobanteProModal` + seleccionar método "Mixto". Esto es frágil en tests automatizados hasta tener un helper de setup más robusto.

**Cómo activarlo:**
1. Crear un comprobante desde la app con método de pago **Mixto** ($500 efectivo + $500 transferencia).
2. Abrir el comprobante y copiar el UUID de la URL: `/comprobantes/<uuid>`
3. Agregar en `.env.test`:
   ```
   E2E_COMPROBANTE_ID_MIXTO=<uuid>
   ```

### `nota-credito.spec.ts`

Necesita un comprobante de tipo **nota de crédito**.

**Por qué no es autosuficiente:** Crear una NC requiere crear primero un comprobante base y luego emitir la NC desde ese comprobante. Dos pasos dependientes, propenso a flakiness.

**Cómo activarlo:**
1. Crear una nota de crédito desde la app.
2. Abrir la NC y copiar el UUID de la URL.
3. Agregar en `.env.test`:
   ```
   E2E_NOTA_CREDITO_ID=<uuid>
   ```

---

## Convenciones de datos E2E

- Todos los datos creados por tests usan prefijo **`E2E `** (ej: `E2E Cliente 1A2B3C`).
- Los datos E2E se acumulan en la DB de la cuenta QA. Limpiarlos manualmente o con un script de cleanup.
- Nunca usar datos de clientes o comprobantes reales en los tests.

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
| Inventory — nuevo | `[data-testid="inventory-new-button"]` |
| Inventory — búsqueda | `[data-testid="inventory-search-input"]` |
| ProductForm — nombre | `[data-testid="product-name-input"]` |
| ProductForm — stock | `[data-testid="product-stock-input"]` |
| ProductForm — costo | `[data-testid="product-cost-input"]` |
| ProductForm — precio | `[data-testid="product-price-input"]` |
| ProductForm — guardar | `[data-testid="product-save-button"]` |
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

---

## Usuario QA

- Crear en Supabase Auth un usuario específico para tests.
- El usuario debe tener un negocio configurado (completar onboarding).
- No usar cuentas de negocio reales.

---

## Requisitos de runtime para @finance

Algunos tests @finance requieren estado activo en la cuenta QA:

### `expenses-atomic` — crear gasto simple

Requiere **caja abierta**. Si la caja está cerrada, `handleSaveGeneral` retorna con error client-side antes de llamar a la RPC, y el test salta automáticamente con el mensaje:

> `Caja cerrada — abrir caja desde la app antes de correr este test @finance`

**Cómo abrir la caja:** Menú → Caja → botón "Abrir caja".

### `editar-cobro-unico` — regresión BUG-01

Requiere al menos **un comprobante** en la cuenta QA. Si la lista está vacía, el test salta con:

> `Sin comprobantes visibles en el listado tras 15s — crear al menos uno desde la app.`

**Cómo activarlo:** Crear cualquier comprobante desde la app (venta, remito) y correr el test nuevamente.

---

## Artefactos ante falla

Los tests guardan trace, screenshot y video en `playwright-report/` y `test-results/` cuando fallan.

```bash
# Ver reporte HTML post-ejecución
npx playwright show-report
```
