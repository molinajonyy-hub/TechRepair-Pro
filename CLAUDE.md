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
