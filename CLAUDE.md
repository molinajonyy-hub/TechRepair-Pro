# TechRepair Pro — Convenciones de Arquitectura

Sistema de gestión comercial para talleres técnicos.
Stack: React 18 + TypeScript + Vite + Supabase (PostgreSQL + RLS).

---

## Fuentes únicas de verdad

### Productos e inventario
**SIEMPRE usar `productService` (`src/services/productService.ts`).**

```typescript
// ✅ Correcto
await productService.createProduct(input, context)
await productService.createVariant(parentId, input, context)
await productService.createProductWithVariants(base, variants, context)

// ❌ NUNCA insertar directo
supabase.from('inventory').insert(...)  // PROHIBIDO
```

`productService` garantiza:
- Código SKU auto-generado (nunca `null`)
- Anti double-stock (cuando `registerMovement: true`, inserta con `stock_quantity: 0`)
- Retry automático ante colisión de código
- Rollback atómico si el movimiento de stock falla

### Movimientos de inventario
**Usar `inventoryMovementsService` (`src/services/inventoryMovementsService.ts`).**

El trigger `trig_supplier_account_movement_balance` garantiza atomicidad server-side
via `pg_advisory_xact_lock`.

### Comprobantes / POS
**Usar `comprobanteService.crear()` (`src/services/comprobanteService.ts`).**

- `total_cobrado` y `saldo_pendiente` son calculados server-side por el trigger
  `trig_comprobante_payment_sync` cuando se insertan `comprobante_payments`.
- No setear `total_cobrado` manualmente en el insert del comprobante.

### Cuentas corrientes (clientes)
**Usar `cuentasService` (`src/services/cuentasService.ts`).**

- `balance_after` calculado server-side por `trig_account_movement_balance` con `SELECT FOR UPDATE`.
- Nunca calcular balance en el cliente.

### Cuentas corrientes (proveedores)
**Usar `suppliersService._addAccountMovement()` que llama al trigger
`trig_supplier_account_movement_balance`.**

El balance se calcula con `pg_advisory_xact_lock(hash(supplier_id, business_id))`.

---

## Reglas de ingeniería

### Finanzas — reglas absolutas

1. **Toda lógica financiera vive en la DB** (triggers, RPCs). El cliente no calcula balances definitivos.
2. **Anti-duplicados**: los triggers tienen guards (`IF NOT EXISTS`) para evitar doble impacto.
3. **`business_id` siempre obligatorio** en `inventory_movements` (NOT NULL en DB).
4. **`inventory.code` nunca es null** — `productService` auto-genera si no se provee.

Para cualquier cambio que toque semántica, cálculo, fuente o flujo financiero, ver
[Financial Skills / Financial Authority](#financial-skills--financial-authority).

### Modales y UX

- **Un solo flujo de venta**: `ComprobanteProModal`. No crear mini-POS ni modales paralelos.
- **No duplicar realtime**: max 1 subscription por entidad. Usar `useNotifications` y `useSubscription` existentes.
- **Error Boundaries**: usar `PremiumErrorBoundary` para wrappear modales críticos. La app ya tiene uno global en `App.tsx`.
- Para trabajo visual, de layout o de rediseño, ver [UI / Design Skills](#ui--design-skills).

### Código

```
// ✅ Usar el logger centralizado
import { logger } from '../lib/logger'
logger.error('POS', 'Scan falló', err)

// ❌ No usar console.log sueltos (ESLint lo detecta)
console.log('debug')  // ESLint warning
```

```typescript
// ✅ Usar design tokens para nuevos componentes
import { colors, radius, transitions } from '../lib/tokens'
style={{ background: colors.bg.card, borderRadius: radius.lg }}

// ❌ No hardcodear inline en nuevo código
style={{ background: 'rgba(255,255,255,0.025)' }}  // usar tokens
```

---

## Estructura de carpetas

```
src/
├── components/
│   ├── auth/          # ProtectedRoute, ProtectedRouteByFeature
│   ├── comprobantes/  # ComprobanteProModal (POS principal), layout, documento
│   ├── inventory/     # ProductMovementsModal
│   ├── products/      # ProductFormModal (creación/edición)
│   ├── shared/        # TimelineView (reutilizable en toda la app)
│   └── ui/            # PremiumErrorBoundary, componentes base
├── contexts/          # AuthContext, CajaContext, ThemeContext
├── hooks/
│   ├── useEntityTimeline.ts    # Timeline para cualquier entidad
│   ├── useFinancialDashboard.ts # KPIs del dashboard
│   └── useDashboardStats.ts    # Stats generales
├── lib/
│   ├── logger.ts      # Logger centralizado (reemplaza console.log)
│   ├── tokens.ts      # Design tokens (colores, spacing, radius, etc.)
│   └── supabase.ts    # Cliente Supabase
├── pages/             # Una carpeta por módulo
├── portal/            # Portal mayorista (dominio separado)
└── services/          # Lógica de negocio
    ├── productService.ts         # FUENTE ÚNICA para inventory
    ├── inventoryMovementsService.ts
    ├── comprobanteService.ts     # FUENTE ÚNICA para ventas/comprobantes
    ├── suppliersService.ts       # Proveedores + CC proveedor
    └── cuentasService.ts         # CC clientes (accounts/account_movements)
```

---

## ESLint

```bash
npm run lint          # Reporte completo (errors + warnings)
npm run lint:errors   # Solo errores reales (debe ser 0)
npm run lint:fix      # Auto-fix
npm run lint:ci       # Gate CI (máx 100 warnings)
```

**Target**: `npm run lint:errors` debe retornar 0 antes de cada deploy.

Reglas clave activas:
- `react-hooks/rules-of-hooks` — warn (hooks condicionales)
- `react-hooks/exhaustive-deps` — warn (deps de useEffect)
- `no-duplicate-imports` — error
- `no-async-promise-executor` — error
- `@typescript-eslint/no-explicit-any` — warn
- `no-console` — warn (usar `logger` en su lugar)

---

## TypeScript

```bash
npx tsc --noEmit    # Debe retornar 0 errores
```

Config en `tsconfig.json`:
- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`

---

## Supabase — reglas críticas

### RLS
- **Toda tabla tiene RLS activo** con `business_id` como scope.
- Nunca hacer SELECT sin filtrar por `businessId`.

### Triggers importantes (no tocar sin análisis)
| Trigger | Tabla | Qué hace |
|---------|-------|----------|
| `trig_account_movement_balance` | `account_movements` | Balance CC atómico |
| `trig_supplier_account_movement_balance` | `supplier_account_movements` | Balance proveedor atómico |
| `trig_comprobante_payment_sync` | `comprobante_payments` | Sincroniza `total_cobrado` en comprobantes |
| `adjust_stock_on_order_item` | `order_items` | Descuenta stock al agregar repuesto en orden |
| `recalculate_order_total` | `order_items` | Recalcula totales de orden |
| `sync_inventory_stock_alias` | `inventory` | Sincroniza `stock` ↔ `stock_quantity` |

### Columnas con constraints críticos
- `inventory.code` — `NOT NULL` + `UNIQUE` global. `productService` siempre auto-genera.
- `inventory_movements.business_id` — `NOT NULL`. Siempre requerido.
- `comprobantes.total_cobrado` — calculado por trigger, no escribir directamente.

---

## Convenciones de naming

```typescript
// Services: camelCase, export named object
export const productService = { ... }

// Hooks: prefijo use, retornan objeto
export function useEntityTimeline(...): UseEntityTimelineReturn

// Components: PascalCase
export function ComprobanteProModal(...)

// Types/interfaces: PascalCase con I-prefix nunca
export interface CreateProductInput { ... }

// Constantes: SCREAMING_SNAKE para valores fijos globales
const MAX_SCAN_COOLDOWN_MS = 150
```

---

## Seguridad

- **MercadoPago**: solo para suscripciones desde la landing. NO usar en POS del comercio.
- **Portal/ecommerce**: NO incluir en planes de negocio actuales.
- **`requireFeature()`**: fail-closed — nunca ejecutar acciones premium si no se puede validar el plan.
- **Webhooks**: no tocan comprobantes, caja, ventas, inventario ni finanzas del comercio.

---

## Financial Skills / Financial Authority

### Cuándo considerar una skill financiera

Cuando una tarea pueda **modificar semántica financiera, cálculos, fuentes de verdad o flujo de
dinero**, considerar automáticamente `techrepair-finance` antes de proponer o editar nada.

- Claude puede invocarla automáticamente sin que el usuario la mencione en cada prompt.
- El detalle financiero **no vive en este archivo**: vive en
  `.claude/skills/techrepair-finance/SKILL.md` y sus `references/`. Esta sección define
  **autoridad, activación y límites**, no el modelo financiero.

### Jerarquía de skills financieras

| Nivel | Skill | Rol |
|-------|-------|-----|
| 0 | `techrepair-finance` | Autoridad financiera de producto |
| 1 | Metodología financiera externa (no instalada hoy) | Sólo método, subordinada |
| 2 | `data:*` (plugin `data`, instalado) | Validación de datos, nunca semántica |
| 3 | Plugin oficial `finance` (**no instalado**) | Futuro, subordinado y nunca automático |

#### Nivel 0 — Autoridad financiera del producto

**`techrepair-finance`**

Es la autoridad principal para cualquier tarea que pueda modificar: semántica financiera;
cálculos financieros; fuentes de verdad; flujo de dinero; deuda; caja; payments; comprobantes;
cuentas corrientes; proveedores; compras; revenue; COGS; profit; P&L; ledger/read models;
conciliación; cierres; anulaciones; owner withdrawals; owner contributions; y cualquier flujo que
pueda afectar balances o reporting financiero.

> **For TechRepair Pro financial logic, project-specific financial guidance always takes precedence
> over generic accounting or financial skills.**

> **For TechRepair Pro financial logic, discover first, modify second.**

> **Never create a second source of financial truth in the client.**

> **Do not recompute canonical financial balances in React when Supabase already owns the
> calculation.**

> **Financial correctness takes precedence over UI convenience.**

> **A financial skill may suggest methodology, but TechRepair Pro's implemented financial model
> remains authoritative.**

### Modelo de autoridad — no existe un "ledger" único

TechRepair Pro **no** tiene un único ledger genérico. Existen stores distintos, con reglas y
autoridades distintas, y confundirlos es la forma más común de equivocarse:

| Store | Qué representa |
|-------|----------------|
| `account_movements` | Deuda de **clientes** (cuenta corriente) |
| `supplier_account_movements` | Deuda de **proveedores** (libro separado, con RPCs propias) |
| `financial_movements` (FM) | **Caja / tesorería** |
| `business_finance_entries` (BFE) | **Clasificación económica** (`economic_class`) |

> **Do not treat FM, BFE, customer account movements, and supplier account movements as
> interchangeable ledgers.**

> **Do not infer revenue or COGS by summing BFE classifications unless the canonical financial
> model explicitly requires it.**

La fuente canónica de cada número la determina **la implementación actual** (migraciones, RPCs,
triggers y vistas `v_finance_*`), no esta tabla resumida ni documentación previa. Ante desacuerdo
entre documentación e implementación, **gana la implementación**, y hay que decirlo explícitamente.

El detalle del modelo (taxonomía `economic_class`, fórmula real del P&L, ledger devengado) está en
`references/financial-model.md` de la skill. No replicarlo acá.

### Source of truth — qué determinar antes de tocar finanzas

Antes de realizar cualquier cambio financiero, determinar explícitamente:

1. **Source of truth** — qué tabla base es la autoridad.
2. **Derived / read model** — qué vista o RPC de resumen deriva el número.
3. **UI presentation layer** — qué es sólo formato, borrador o carrito sin confirmar.
4. **RPC / trigger / constraint** que protege la operación.
5. **Invariantes afectados**.
6. **Tests existentes** que cubren el flujo.
7. **Impacto cross-module** (ledger, balances, caja, payments, deuda, costo, P&L, auditoría).

Reglas de lectura:

- **No** asumir que una tabla base es una API de escritura válida.
- **No** asumir que una vista derivada es fuente de verdad.
- **No** asumir que el frontend puede reconstruir balances.

Si un número no se puede clasificar en (1), (2) o (3), el discovery **no terminó**.

### Invariantes críticos

Cuando el flujo los involucre, deben preservarse:

- atomicidad
- idempotencia
- no doble contabilización
- reversas oficiales (compensación, nunca borrado ni reescritura de historia)
- period locks
- append-only cuando corresponda
- balances server-side
- tenant isolation
- RLS
- RBAC / capabilities
- auditabilidad
- `SECURITY DEFINER` endurecido
- trazabilidad

**No** eliminar ni simplificar estas propiedades sin discovery explícito que lo justifique.

### Diferencias semánticas que no se pueden colapsar

Está explícitamente prohibido asumir que:

- cash = profit
- revenue = money collected
- comprobante emitido = cobrado
- orden completada = pagada
- partial = paid
- retiro del owner = gasto operativo
- aporte del owner = revenue
- cierre de caja = cierre de período

> **Financial concepts that look similar in the UI may have different accounting and cash
> semantics. Preserve those distinctions.**

### Nivel 2 — Skills `data:*`

Las skills del plugin oficial `data`, especialmente `data:validate-data`, pueden usarse para:

- comprobar aritmética
- validar agregaciones
- detectar anomalías
- revisar consistencia
- validar tendencias o resultados

Pero:

> **`data:*` skills validate data; they do not define TechRepair Pro financial semantics.**

`data:validate-data` **nunca** reemplaza a `techrepair-finance`. Puede probar que una agregación
está aritméticamente mal; no puede decidir qué es revenue ni cuándo se reconoce.

### Nivel 3 — Futuro plugin `finance`

El plugin oficial `finance` **no está instalado, y es intencional**. Si alguna vez se instala:

- queda **subordinado** a `techrepair-finance`;
- GAAP, ASC, SOX y metodologías externas se consideran **referencias externas**;
- **no** puede redefinir revenue recognition;
- **no** puede introducir journal-entry logic externa automáticamente;
- **no** puede recalcular estados financieros paralelos a las fuentes canónicas del producto;
- **no** puede sustituir a Supabase como autoridad financiera.

> **External accounting standards are references, not automatic implementation requirements.**

### Cuándo activar `techrepair-finance`

Considerarla automáticamente cuando la tarea pueda afectar: finanzas; caja; payments; cobros;
deuda; cuentas corrientes; proveedores; compras; costos; revenue; COGS; profit; P&L; conciliación;
cierres; anulaciones; financial movements; BFE; owner capital flows; reporting financiero; o
inconsistencias financieras.

**No** activarla necesariamente sólo porque una pantalla muestre un precio, un importe, un símbolo
de moneda o una tarjeta financiera, si el cambio es **puramente visual** y no modifica cálculo,
semántica, fuente ni flujo. En esos casos puede bastar `techrepair-product-design`.

Cuando una tarea afecta simultáneamente lógica financiera y UI:

- `techrepair-finance` define **semántica e invariantes**.
- `techrepair-product-design` define **presentación y UX**.

Ninguna de las dos puede invadir la jurisdicción de la otra. Finanzas **restringe**, diseño
**da forma**: el número se decide en una, se presenta en la otra.

### Prohibiciones financieras

- **No** crear balances paralelos en React.
- **No** escribir directamente en tablas protegidas cuando exista una RPC canónica.
- **No** crear movimientos ad hoc para "hacer cerrar" números.
- **No** ocultar inconsistencias financieras en el frontend.
- **No** quitar idempotencia.
- **No** saltar period locks.
- **No** debilitar RLS ni RBAC para arreglar un bug.
- **No** cambiar economic classification sin discovery.
- **No** escribir en vistas derivadas.
- **No** asumir reglas GAAP/SOX/ASC automáticamente.
- **No** modificar ARCA ni lógica fiscal argentina por recomendaciones contables genéricas.

### Discovery incompleto — no tratar como reglas

La skill documenta puntos que **todavía no fueron verificados completamente**. No convertirlos en
autoridad ni asumir una conclusión en ninguna dirección. Requieren discovery adicional cuando una
tarea los toque:

- `docs/auditoria-finanzas/` (no leído en su totalidad)
- convención de signo en `supplier_account_movements`
- política de captura de costo del producto
- contrato de cotización del dólar
- el trabajo `m8`
- `src/hooks/useFinancialDashboard.ts`

Ver `references/open-findings.md` en la skill para el estado real de cada punto.

---

## UI / Design Skills

### Cuándo considerar una skill de diseño

Cuando una tarea involucre **frontend UI, UX, layout, jerarquía visual, spacing, responsive
behavior, estados visuales, componentes o rediseño**, considerar automáticamente las skills de
diseño instaladas que sean relevantes.

- Claude puede invocar automáticamente las skills relevantes sin que el usuario las mencione en
  cada prompt.
- Si una tarea claramente se beneficia de una skill específica, puede utilizarla automáticamente.
- No es necesario anunciar cada uso de una skill, salvo que sea relevante para explicar una
  decisión importante.

### Jerarquía de skills de diseño

| Nivel | Skill | Rol |
|-------|-------|-----|
| 0 | `techrepair-product-design` | Autoridad de producto |
| 1 | `redesign-existing-projects` | Refinamiento de interfaces existentes |
| 2 | `design-taste-frontend` (v2) | Superficies públicas |
| 3 | `minimalist-ui`, `high-end-visual-design`, `image-to-code`, `brandkit` | Sólo cuando la dirección visual lo justifique |
| 4 | `design:accessibility-review`, `design:design-critique` | Auditoría complementaria |

#### Nivel 0 — Autoridad de producto

**`techrepair-product-design`**

Es la autoridad principal para cualquier decisión de UI/UX dentro del producto TechRepair Pro.
Sus reglas, junto con `design-system.md`, `engineering-safety.md`, los design tokens, los
componentes existentes y los patrones establecidos del proyecto, tienen prioridad sobre cualquier
skill externa.

> **For TechRepair Pro product UI, project-specific design guidance always takes precedence over
> generic external design skills.**

#### Nivel 1 — Refinamiento de interfaces existentes

**`redesign-existing-projects`**

Herramienta **complementaria** para: auditoría de UI existente, layout, spacing, jerarquía,
estados visuales, responsive, formularios, modales, tablas, dashboard, tareas, órdenes, clientes,
inventario, proveedores, POS, caja, finanzas y garantías.

Debe seguir el enfoque **Scan → Diagnose → Fix**, pero sus recomendaciones son **subordinadas a
`techrepair-product-design`**.

**No** aplicar mecánicamente sus recomendaciones externas sobre: fuentes, paleta, color Índigo,
acentos semánticos, iconografía, design tokens, sombras, navegación, sistema de superficies o
identidad visual.

Si alguna recomendación de `redesign-existing-projects` contradice a TechRepair Pro, **ignorar esa
recomendación específica**.

> **For existing TechRepair Pro interfaces, audit first, modify second. Prefer targeted
> improvements over visual rewrites.**

#### Nivel 2 — Superficies públicas

**`design-taste-frontend` (v2)**

Usar principalmente para: landing, marketing, páginas públicas, páginas promocionales y
onboarding visual no operativo.

**No** usarla como autoridad principal para: dashboards, tablas, POS, formularios operativos
complejos, flujos administrativos o UI densa de gestión.

La **v2 es la versión preferida** frente a `design-taste-frontend-v1`. La v1 puede permanecer
instalada por compatibilidad, pero **no debe seleccionarse automáticamente** si la v2 es apropiada.

#### Nivel 3 — Sólo cuando la dirección visual lo justifique

`minimalist-ui`, `high-end-visual-design`, `image-to-code`, `brandkit`

**No** usarlas automáticamente para cambiar la identidad del producto. Entran cuando la tarea
específica lo justifique o cuando se solicite expresamente esa dirección visual.

#### Nivel 4 — Auditoría complementaria

`design:accessibility-review`, `design:design-critique`

Si están disponibles, pueden usarse como herramientas complementarias de evaluación, porque no
deberían reemplazar la identidad visual del producto. Con el mismo criterio se pueden usar
`design:design-system` y `design:ux-copy`.

### Skills que NO deben definir TechRepair Pro

No usar como dirección visual general del producto:

- `design-taste-frontend-v1`
- `gpt-taste`
- `industrial-brutalist-ui`
- `stitch-design-taste`

Pueden permanecer instaladas, pero **no deben seleccionarse automáticamente** para trabajo normal
de TechRepair Pro.

### La skill es una guía, no la autoridad

Una skill externa es una **guía de diseño**, no la autoridad final sobre TechRepair Pro.
Cuando una skill contradiga una instrucción explícita del proyecto, un patrón ya establecido o
un requisito funcional, **prevalece TechRepair Pro**.

Siempre preservar, antes que nada:

- el design system existente
- design tokens (`src/lib/tokens.ts`, ver [Código](#código))
- variables CSS
- comportamiento light/dark
- accesibilidad y contraste
- responsive behavior
- RBAC y permisos
- navegación
- semántica de estados
- lógica funcional y comportamiento de negocio
- componentes compartidos
- consistencia entre módulos

### Identidad visual de TechRepair Pro

- Producto SaaS profesional.
- Lenguaje visual moderno y premium.
- Inspiración iOS cuando corresponda.
- Superficies limpias y buena jerarquía.
- Interacción móvil cuidada.
- **Índigo** como identidad principal de gestión.
- Evitar estéticas genéricas de template SaaS o "AI generated".

Prohibiciones:

- **No** cambiar fuentes, iconografía, navegación, sistema de colores, radios, sombras, layout
  global o componentes compartidos sólo porque una skill sugiera otra estética.
- **No** introducir un segundo design system paralelo.
- **No** reemplazar componentes existentes funcionales sólo para ajustarlos a la preferencia
  estética de una skill.
- **No** convertir automáticamente el Índigo de TechRepair Pro en un supuesto patrón "AI purple".
  El Índigo es una decisión explícita de identidad del producto.
- **No** eliminar los colores semánticos (verde, rojo, ámbar, etc.) por reglas genéricas de
  "single accent color": tienen función de producto.

### Cómo trabajar sobre código existente

> **For existing TechRepair Pro interfaces, audit first, modify second. Prefer targeted
> improvements over visual rewrites.**

Antes de un rediseño importante de una pantalla existente:

1. Inspeccionar la implementación actual.
2. Identificar los componentes y tokens compartidos.
3. Detectar problemas visuales reales.
4. Proponer o aplicar cambios incrementales.
5. Preservar funcionalidad y consistencia global.

Para cambios pequeños de UI: no sobrediseñar ni rehacer toda la pantalla. Resolver
específicamente el problema solicitado.

> **Design skills must improve product quality without creating visual drift between modules.**

### Patrones a evitar

Evitar los patrones visuales genéricos que suele producir la IA cuando no agregan valor:

- gradients arbitrarios
- glassmorphism excesivo
- cards innecesarias
- tres cards iguales por defecto
- exceso de pills
- animaciones decorativas constantes
- sombras exageradas
- fondos "AI purple"
- layouts centrados genéricos
- uso indiscriminado de efectos visuales

Tampoco agregar noise, grain, imágenes decorativas, motion, gradients ni efectos visuales sólo
porque una skill los recomienda.

### Densidad y motion

La densidad visual se adapta al contexto:

- **Dashboards y herramientas operativas**: pueden ser más densos.
- **Landing y marketing**: pueden respirar más.
- **Mobile**: priorizar claridad, targets táctiles y jerarquía.

Las animaciones deben tener **propósito funcional**. No agregar motion sólo porque una skill lo
recomienda.
