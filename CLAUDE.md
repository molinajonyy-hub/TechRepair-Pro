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
