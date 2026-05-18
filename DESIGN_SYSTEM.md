# TechRepair Pro — Design System

> **Guía de referencia visual para desarrolladores.**
> Este documento refleja el estado del sistema después de 11 fases de auditoría y migración visual.
> Toda nueva pantalla, modal o componente debe seguir estas convenciones antes de crear estilos propios.

---

## 1. Objetivo del sistema visual

TechRepair Pro usa un sistema de diseño **dark-mode por defecto**, con acento índigo–cyan, tipografía Inter y componentes Lucide. El objetivo es mantener una experiencia:

- **Consistente**: cada pantalla usa los mismos patrones de header, tabla, modal, badge y alerta.
- **Moderna y premium**: la UI refleja que el producto es SaaS para talleres técnicos profesionales.
- **Responsive**: funciona en desktop, tablet y mobile sin overflow horizontal ni botones pisados.
- **Accesible**: dark-mode y light-mode correctamente tematizados vía CSS variables.
- **Mantenible**: si un patrón visual existe como clase global, se usa — no se reinventa inline.

**Regla de oro**: antes de escribir un `style={{ ... }}` nuevo, verificar si ya existe una clase en `src/index.css` que cubra ese caso.

---

## 2. Principios generales

| Regla | Descripción |
|---|---|
| **Sin inline para UI estática** | `style={{ color: '#f87171' }}` en texto fijo → usar `var(--error)` o clase `.text-danger` |
| **Inline solo para valores runtime** | Colores calculados, dimensiones dinámicas, posiciones absolutas de overlays |
| **Sin @keyframes spin locales** | `@keyframes spin` está definido globalmente. No duplicar en componentes |
| **Spinner → `tr-spin`** | Usar `animation: 'tr-spin 0.8s linear infinite'` o el componente `<Loader>` |
| **Sin emojis como iconos** | En pantallas internas usar `lucide-react`. Emojis solo en contenido de usuario |
| **Iconos Lucide** | `import { NombreIcono } from 'lucide-react'` para todas las acciones y secciones |
| **Dark mode siempre** | Usar `var(--text-primary)`, `var(--bg-card)` etc., no hardcodear `#ffffff` o `#000000` |
| **Mobile-first responsive** | Grids con `auto-fit minmax(...)`, modales con max-height, tablas con `table-wrap` |
| **No mezclar lógica y visual** | Al migrar UI no tocar handlers, services, cálculos ni validaciones |
| **No duplicar componentes** | Si existe `EmptyState`, `Loader`, `page-hdr`, `modal-card` → usarlos |

---

## 3. Variables CSS

Definidas en `src/index.css`. Se adaptan automáticamente al tema activo (dark / light).

### Fondos

```css
var(--bg-base)           /* raíz de la app, casi negro con tinte azul */
var(--bg-primary)        /* fondo principal de páginas */
var(--bg-secondary)      /* fondos secundarios, paneles */
var(--bg-card)           /* cards — más claras que el fondo */
var(--bg-card-raised)    /* cards con mayor elevación */
var(--bg-surface)        /* inputs, hover backgrounds */
var(--bg-modal)          /* fondo de modales */
var(--bg-hover)          /* hover sutil indigo */
var(--app-shell-bg)      /* degradado radial del shell completo */
```

### Texto

```css
var(--text-primary)      /* blanco suave — títulos, datos importantes */
var(--text-secondary)    /* gris azulado claro — texto de cuerpo */
var(--text-muted)        /* gris medio — subtítulos, descripciones */
var(--text-subtle)       /* gris oscuro — labels, placeholders */
var(--text-disabled)     /* texto deshabilitado */
```

### Acento

```css
var(--accent-primary)          /* índigo #6366f1 */
var(--accent-primary-hover)    /* índigo oscuro para hover */
var(--accent-primary-subtle)   /* fondo translúcido índigo */
var(--accent-primary-light)    /* borde/glow índigo */
var(--accent-secondary)        /* cyan #06b6d4 */
var(--accent-secondary-subtle) /* fondo translúcido cyan */
var(--gradient-primary)        /* gradiente índigo → cyan */
var(--gradient-indigo)         /* gradiente índigo → índigo oscuro */
```

### Estados funcionales

```css
var(--success)           /* verde  #34d399 */
var(--success-light)     /* fondo verde translúcido */
var(--success-border)    /* borde verde */
var(--success-subtle)    /* fondo muy suave */

var(--warning)           /* ámbar  #fbbf24 */
var(--warning-light)     /* fondo ámbar translúcido */
var(--warning-border)    /* borde ámbar */

var(--error)             /* rojo   #f87171 */
var(--error-light)       /* fondo rojo translúcido */
var(--error-border)      /* borde rojo */
var(--error-subtle)      /* fondo muy suave */

var(--info)              /* azul   #38bdf8 */
var(--info-light)        /* fondo azul translúcido */
var(--info-border)       /* borde azul */
```

### Bordes, sombras, radios y espaciado

```css
/* Bordes */
var(--border-color)      /* borde estándar rgba(255,255,255,0.07) */
var(--border-subtle)     /* muy tenue rgba(255,255,255,0.04) */
var(--border-strong)     /* más visible rgba(255,255,255,0.12) */
var(--border-accent)     /* acento índigo */
var(--border-focus)      /* focus ring */

/* Sombras */
var(--shadow-sm) var(--shadow-md) var(--shadow-lg) var(--shadow-xl)
var(--shadow-card)       /* sombra estándar de cards */
var(--shadow-indigo)     /* sombra con glow índigo */

/* Radios */
var(--radius-xs)   /* 0.25rem */
var(--radius-sm)   /* 0.375rem */
var(--radius-md)   /* 0.5rem */
var(--radius-lg)   /* 0.75rem */
var(--radius-xl)   /* 1rem */
var(--radius-2xl)  /* 1.25rem */
var(--radius-full) /* 9999px (círculos, pills) */

/* Espaciado */
var(--space-xs) var(--space-sm) var(--space-md)
var(--space-lg) var(--space-xl) var(--space-2xl)
```

### Inputs

```css
var(--input-bg)            /* fondo de inputs */
var(--input-border)        /* borde normal */
var(--input-focus-border)  /* borde en focus */
var(--input-focus-shadow)  /* sombra en focus */
var(--input-placeholder)   /* color placeholder */
var(--input-disabled-bg)   /* fondo disabled */
```

---

## 4. Tipografía

La fuente base es **Inter** (Google Fonts), cargada globalmente. No usar `fontFamily` inline.

### Clases de encabezado

| Clase | Tamaño | Peso | Uso |
|---|---|---|---|
| `.heading-xl` | 1.75rem | 800 | Títulos de páginas principales, success screens |
| `.heading-lg` | 1.375rem | 700 | Subtítulos de sección, headers de modales importantes |
| `.heading-md` | 1.0625rem | 700 | Títulos de cards, secciones internas |
| `.heading-sm` | 0.9375rem | 700 | Subtítulos pequeños, nombre de entidad en tabla |

```tsx
<h1 className="heading-xl">Clientes</h1>
<h2 className="heading-lg">Detalle de orden</h2>
<h3 className="heading-md">Información del dispositivo</h3>
```

### Clases de cuerpo

| Clase | Tamaño | Color | Uso |
|---|---|---|---|
| `.body-lg` | 1rem | `--text-secondary` | Párrafos principales, descripciones largas |
| `.body-md` | 0.875rem | `--text-secondary` | Texto de cuerpo estándar |
| `.body-sm` | 0.8125rem | `--text-muted` | Texto secundario, notas, metadatos |

```tsx
<p className="body-md">Gestioná clientes minoristas y mayoristas.</p>
<p className="body-sm">Última modificación: 14/5/2026</p>
```

### Clases especiales

| Clase | Descripción | Uso |
|---|---|---|
| `.label-caps` | 0.65rem, bold, UPPERCASE, `--text-subtle` | Labels de formulario, encabezados de columna, metadatos |
| `.num-big` | 1.75rem, 900, tabular-nums | Valores numéricos grandes (totales, stats) |
| `.mono` | JetBrains Mono / monospace, tabular | Códigos SKU, montos, IDs, CAE, dígitos |

```tsx
<label className="label-caps">Estado del pago</label>
<strong className="num-big">$125.000</strong>
<code className="mono">0001-00001234</code>
```

---

## 5. Botones

### Clases base

```tsx
<button className="btn btn-primary">Guardar</button>
<button className="btn btn-primary btn-lift">Nueva orden</button>
<button className="btn btn-outline">Cancelar</button>
<button className="btn btn-ghost">Volver</button>
<button className="btn btn-danger">Eliminar</button>
<button className="btn btn-success">Confirmar</button>
```

### Variantes de color sólido

| Clase | Color | Uso |
|---|---|---|
| `.btn-primary` | Gradiente índigo → cyan | Acción principal de la pantalla |
| `.btn-indigo` | Índigo sólido | Acción importante, alternativa a primary |
| `.btn-cyan` | Cyan sólido | Acciones rápidas, acción secundaria |
| `.btn-green` | Verde sólido | Confirmar cobro, completar, activar |
| `.btn-amber` | Ámbar sólido | Nueva orden, acciones secundarias |
| `.btn-red` | Rojo sólido | Eliminar, acción destructiva con confirmación |
| `.btn-teal` | Teal sólido | Caja, confirmar pago |

### Variantes de contorno/ghost

| Clase | Uso |
|---|---|
| `.btn-outline` / `.btn-secondary` | Botón cancelar, acción alternativa |
| `.btn-ghost` | Botón volver, acción terciaria sin peso visual |
| `.btn-danger` | Peligro suave (fondo translúcido, texto rojo) |
| `.btn-success` | Éxito suave (fondo translúcido, texto verde) |

### Tamaños

```tsx
<button className="btn btn-primary btn-xs">Muy pequeño</button>
<button className="btn btn-primary btn-sm">Pequeño</button>
<button className="btn btn-primary">Estándar</button>
<button className="btn btn-primary btn-lg">Grande</button>
<button className="btn btn-primary btn-full">Ancho completo</button>
```

### Modificadores de micro-interacción

```tsx
/* btn-lift: levita 1px en hover, escala en active */
<button className="btn btn-primary btn-lift">Crear</button>

/* press-scale: escala ligeramente en active */
<button className="btn btn-outline press-scale">Opción</button>
```

### Botones icono-only

Siempre requieren `aria-label` para accesibilidad.

```tsx
<button className="icon-btn" aria-label="Actualizar">
  <RefreshCw size={16} />
</button>

<button className="icon-btn icon-btn-primary" aria-label="Ver detalle">
  <Eye size={16} />
</button>

<button className="icon-btn icon-btn-violet" aria-label="Editar">
  <Edit2 size={15} />
</button>

<button className="icon-btn icon-btn-danger" aria-label="Eliminar">
  <Trash2 size={15} />
</button>
```

---

## 6. Header de página

Usar `.page-hdr` en **todas** las páginas internas para consistencia.

```tsx
<div className="page-hdr">
  <div className="page-hdr-left">
    <div className="page-hdr-icon">
      <Users size={22} style={{ color: 'var(--accent-primary)' }} />
    </div>
    <div>
      <h1 className="page-hdr-title">Clientes</h1>
      <p className="page-hdr-subtitle">Gestioná clientes minoristas y mayoristas</p>
    </div>
  </div>
  <div className="page-hdr-right">
    <button className="btn btn-ghost btn-sm">
      <RefreshCw size={14} /> Actualizar
    </button>
    <button className="btn btn-primary btn-lift">
      <Plus size={16} /> Nuevo cliente
    </button>
  </div>
</div>
```

### Variantes de color del icono

```tsx
/* Por defecto: índigo */
<div className="page-hdr-icon"> ... </div>

/* Verde */
<div className="page-hdr-icon green"> ... </div>

/* Ámbar */
<div className="page-hdr-icon amber"> ... </div>

/* Rojo */
<div className="page-hdr-icon red"> ... </div>

/* Cyan */
<div className="page-hdr-icon cyan"> ... </div>
```

---

## 7. Cards y superficies

### Cards estándar

```tsx
/* Card base */
<div className="card">
  <div className="card-header">
    <h3 className="card-title">Título</h3>
  </div>
  <div className="card-body">
    Contenido
  </div>
</div>

/* Card clickeable */
<div className="card card-interactive" onClick={...}>
  Clickeable con hover lift
</div>

/* Card con acento superior */
<div className="card card-accent">
  Borde índigo superior con brillo
</div>
```

### Surfaces

```tsx
/* Glass: para overlays, sidebars flotantes */
<div className="surface-glass">...</div>

/* Raised: para panels secundarios, sidebars de detalle */
<div className="surface-raised">...</div>

/* Inset: para secciones internas dentro de cards */
<div className="surface-inset">...</div>
```

### Stat cards (métricas)

```tsx
<div className="stat-card">
  <div className="stat-card-label">Órdenes activas</div>
  <div className="stat-card-value" style={{ color: 'var(--accent-primary)' }}>
    42
  </div>
</div>

/* Grid de stat cards */
<div className="stats-grid">
  <div className="stat-card">...</div>
  <div className="stat-card">...</div>
  <div className="stat-card">...</div>
</div>
```

---

## 8. Tablas

### Patrón estándar

```tsx
<div className="table-wrap">
  <table className="data-table">
    <thead>
      <tr>
        <th className="label-caps">Nombre</th>
        <th className="label-caps">Estado</th>
        <th className="label-caps">Fecha</th>
        <th className="label-caps" style={{ textAlign: 'right' }}>Acciones</th>
      </tr>
    </thead>
    <tbody>
      {items.map(item => (
        <tr key={item.id}>
          <td>{item.name}</td>
          <td><span className="badge badge-success">Activo</span></td>
          <td style={{ color: 'var(--text-muted)' }}>{item.date}</td>
          <td>
            <div style={{ display: 'flex', gap: '0.375rem', justifyContent: 'flex-end' }}>
              <button className="icon-btn icon-btn-violet" aria-label="Editar">
                <Edit2 size={14} />
              </button>
              <button className="icon-btn icon-btn-danger" aria-label="Eliminar">
                <Trash2 size={14} />
              </button>
            </div>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

> **Nota**: `.table-wrap` maneja el scroll horizontal en mobile. Siempre wrappear tablas con él.

---

## 9. Formularios

### Inputs y labels

```tsx
/* Input estándar */
<div>
  <label className="label-caps">Nombre del cliente</label>
  <input
    type="text"
    className="form-control"
    placeholder="Ej: Juan Pérez"
    value={name}
    onChange={e => setName(e.target.value)}
  />
</div>

/* Select */
<div>
  <label className="label-caps">Tipo de cliente</label>
  <select className="form-select" value={type} onChange={e => setType(e.target.value)}>
    <option value="minorista">Minorista</option>
    <option value="mayorista">Mayorista</option>
  </select>
</div>

/* Textarea */
<div>
  <label className="label-caps">Observaciones</label>
  <textarea className="form-control" rows={3} placeholder="..." />
</div>

/* Input con ícono */
<div className="input-group">
  <Search size={16} className="input-icon" />
  <input className="form-control" style={{ paddingLeft: '2.25rem' }} placeholder="Buscar..." />
</div>
```

### Clases auxiliares de formulario

```tsx
/* Hint debajo del input */
<p className="form-hint">El código se genera automáticamente.</p>

/* Error debajo del input */
<p className="form-error"><AlertCircle size={12} /> Campo requerido</p>
```

### Filter bar (barra de filtros sobre tabla)

```tsx
<div className="filter-bar">
  <div style={{ position: 'relative', flex: 1 }}>
    <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-muted)' }} />
    <input className="form-control" style={{ paddingLeft: '2.25rem' }} placeholder="Buscar..." />
  </div>
  <select className="form-select" style={{ width: 'auto' }}>
    <option>Todos</option>
  </select>
</div>
```

---

## 10. Badges y estados

### Semántica por color

| Clase | Color | Usar para |
|---|---|---|
| `.badge-success` | Verde | Activo, pagado, completado, aprobado |
| `.badge-warning` | Ámbar | Pendiente, en proceso, próximo a vencer |
| `.badge-error` | Rojo | Cancelado, vencido, error, suspendido |
| `.badge-info` | Azul índigo | En diagnóstico, en reparación, trial |
| `.badge-neutral` | Gris | Inactivo, borrador, sin estado |
| `.badge-primary` | Índigo | Estado propio del sistema (prioridad media) |
| `.badge-cyan` | Cyan | Entrega, listo para retirar |

```tsx
<span className="badge badge-success">Pagado</span>
<span className="badge badge-warning">Pendiente</span>
<span className="badge badge-error">Cancelado</span>
<span className="badge badge-info">En diagnóstico</span>
<span className="badge badge-neutral">Borrador</span>

/* Sin punto indicador */
<span className="badge badge-success badge-no-dot">Activo</span>

/* Con color dinámico (e.g. suscripciones) */
<span className="badge" style={{ background: STATUS_COLORS[status] + '20', color: STATUS_COLORS[status] }}>
  {STATUS_LABELS[status]}
</span>
```

---

## 11. Alerts inline

Para mensajes de error, warning, success e info dentro de la pantalla (no modales).

```tsx
import { AlertCircle, CheckCircle, AlertTriangle, Info } from 'lucide-react'

/* Error */
<div className="alert-inline alert-error">
  <AlertCircle size={15} style={{ flexShrink: 0 }} />
  <span>El teléfono ingresado no es válido.</span>
</div>

/* Warning */
<div className="alert-inline alert-warning">
  <AlertTriangle size={15} style={{ flexShrink: 0 }} />
  <span>El stock está por debajo del mínimo.</span>
</div>

/* Success */
<div className="alert-inline alert-success">
  <CheckCircle size={15} style={{ flexShrink: 0 }} />
  <span>Cambios guardados correctamente.</span>
</div>

/* Info */
<div className="alert-inline alert-info">
  <Info size={15} style={{ flexShrink: 0 }} />
  <span>La suscripción se renova automáticamente.</span>
</div>
```

---

## 12. Tabs

Para navegación entre secciones de una misma pantalla.

```tsx
<div className="tabs">
  <button className="tab tab-active">
    <Package size={15} /> Órdenes
  </button>
  <button className="tab">
    <CreditCard size={15} /> Pagos
  </button>
  <button className="tab">
    <Clock size={15} /> Historial
  </button>
</div>
```

---

## 13. Modales

### Patrón estándar

```tsx
{showModal && (
  <div className="modal-overlay-dark" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="modal-card" style={{ maxWidth: 520 }}>

      {/* Header */}
      <div className="modal-hdr">
        <h2>Título del modal</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
          <X size={16} />
        </button>
      </div>

      {/* Body scrolleable */}
      <div className="modal-body-scroll">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label className="label-caps">Campo</label>
            <input className="form-control" />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="modal-ftr">
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary btn-lift" onClick={handleSave}>
          Guardar
        </button>
      </div>

    </div>
  </div>
)}
```

### Tamaños disponibles

```tsx
<div className="modal-card">          {/* 480px — default */}
<div className="modal-card modal-card-lg">  {/* 640px */}
<div className="modal-card modal-card-xl">  {/* 800px */}
<div className="modal-card" style={{ maxWidth: 360 }}>  {/* custom */}
```

> **Regla**: nunca usar `position: 'fixed'` manual para overlays de modal interno. Usar `.modal-overlay-dark`.

---

## 14. Loaders y spinners

### Componente Loader

```tsx
import { Loader } from '../components/ui/Loader'

/* Página completa loading */
<div style={{ display: 'flex', justifyContent: 'center', height: '60vh', alignItems: 'center' }}>
  <Loader size="lg" />
</div>

/* Dentro de card */
<div style={{ padding: '2rem', textAlign: 'center' }}>
  <Loader size="md" text="Cargando datos..." />
</div>

/* Pequeño en tabla */
<Loader size="sm" />
```

Tamaños: `"sm"` (24px) · `"md"` (40px) · `"lg"` (64px)

### Spinner inline (en botón o input)

```tsx
<Loader2 size={16} style={{ animation: 'tr-spin 0.8s linear infinite' }} />
```

> **Regla**: usar `tr-spin`, nunca `spin` para nuevos spinners. No definir `@keyframes spin` localmente — ya existe globalmente.

---

## 15. Empty states

### Componente EmptyState

```tsx
import { EmptyState } from '../components/ui/EmptyState'
import { Package } from 'lucide-react'

/* Básico */
<EmptyState
  icon={Package}
  title="Sin órdenes"
  description="Todavía no hay órdenes registradas."
/>

/* Con acción */
<EmptyState
  icon={Package}
  title="Sin órdenes"
  description="Creá tu primera orden de servicio."
  action={{ label: 'Nueva orden', onClick: () => navigate('/orders/new') }}
/>

/* Compacto (dentro de card) */
<EmptyState
  icon={Package}
  title="Sin resultados"
  compact
/>
```

> El prop `icon` espera el **componente** Lucide (sin `<>`), no un elemento JSX.

---

## 16. Animaciones

### Clases utilitarias de entrada

```tsx
/* Fade + slide up */
<div className="animate-fade-in">Contenido que aparece</div>

/* Fade rápido */
<div className="animate-fade-in-fast">Toast</div>

/* Slide desde izquierda */
<div className="animate-slide-in">Panel lateral</div>

/* Slide desde abajo */
<div className="animate-slide-up">Modal bottom sheet</div>
```

### Keyframes del sistema (`tr-*`)

Disponibles para uso directo en `style`:

```tsx
animation: 'tr-fade-in 150ms ease both'
animation: 'tr-slide-up 200ms ease both'
animation: 'tr-scale-in 180ms ease both'
animation: 'tr-modal-in 180ms cubic-bezier(0.16,1,0.3,1) both'
animation: 'tr-bounce-in 300ms ease both'
animation: 'tr-shake 0.32s ease'
animation: 'tr-spin 0.8s linear infinite'
animation: 'tr-pulse-ok 1.5s ease-in-out infinite'
animation: 'tr-pulse-err 1.5s ease-in-out infinite'
```

### Clases de micro-interacción

```tsx
/* Levita 1px en hover */
<button className="btn btn-primary btn-lift">Guardar</button>

/* Escala en active */
<div className="press-scale">...</div>

/* Card interactiva con lift + glow */
<div className="card card-interactive" onClick={...}>...</div>

/* Pulse suave continuo */
<span className="pulse-soft">●</span>

/* Glow pulsante */
<div className="glow-pulse">...</div>
```

---

## 17. Grids y layout

```tsx
/* Grid responsivo de stats */
<div className="stats-grid">
  <div className="stat-card">...</div>
  <div className="stat-card">...</div>
</div>

/* Grid de 2 columnas */
<div className="grid-2-col">...</div>

/* Grid de 3 columnas */
<div className="grid-3-col">...</div>

/* Grid completamente responsivo — recomendado para cards de planes, productos */
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
  ...
</div>

/* Page shell (contenedor con padding estándar) */
<div className="page-shell">...</div>
```

---

## 18. Componentes reutilizables disponibles

| Componente | Ruta | Uso |
|---|---|---|
| `EmptyState` | `src/components/ui/EmptyState.tsx` | Estados vacíos en listados, tablas, tabs |
| `Loader` | `src/components/ui/Loader.tsx` | Spinners de carga de página o sección |
| `FinanceBarChart` | `src/components/finance/FinanceBarChart.tsx` | Gráfico de barras para datos financieros |
| `FinanceDonutChart` | `src/components/finance/FinanceDonutChart.tsx` | Gráfico donut para distribución |
| `FinanceLineChart` | `src/components/finance/FinanceLineChart.tsx` | Gráfico de línea para series temporales |
| `DollarRateBadge` | `src/components/ui/DollarRateBadge.tsx` | Badge del tipo de cambio USD/ARS |
| `CloseButton` | `src/components/ui/CloseButton.tsx` | Botón X estandarizado para modales |
| `CommandPalette` | `src/components/ui/CommandPalette.tsx` | Paleta de comandos global (Ctrl+K) |
| `PremiumErrorBoundary` | `src/components/ui/PremiumErrorBoundary.tsx` | Error boundary para modales críticos |

---

## 19. Páginas con sistemas propios (no migrar)

Estas páginas tienen su propio sistema visual coherente. **No aplicar clases internas del sistema**.

| Páginas / componentes | Sistema | Razón |
|---|---|---|
| `src/portal/` (todos) | Light-theme iOS + `PT` tokens | Portal mayorista self-contained |
| `src/pages/Login.tsx` | Sistema `S.*` glass-morphism | Diseño premium de auth con blobs |
| `src/pages/LandingPage.tsx` | Sistema propio `const F` | Landing pública con branding propio |
| `src/components/LoadingDino.tsx` | SVG animado propio | Dinosaurio animado con keyframe propio |
| `src/components/comprobantes/ComprobanteProModal.tsx` | POS complejo | Sistema de sonido, animaciones, scanner, responsive propio |

---

## 20. Checklist para nuevas pantallas

Antes de hacer PR de una pantalla nueva, verificar:

- [ ] Header usa `page-hdr` con icono Lucide
- [ ] Botones usan clases `btn` globales
- [ ] Botones icon-only tienen `aria-label`
- [ ] Inputs usan `form-control`, selects usan `form-select`, labels usan `label-caps`
- [ ] Tablas usan `table-wrap` + `data-table`
- [ ] Badges usan `badge badge-*`
- [ ] Alertas inline usan `alert-inline alert-*`
- [ ] Modales usan `modal-overlay-dark` + `modal-card` + `modal-hdr` + `modal-body-scroll` + `modal-ftr`
- [ ] Estados vacíos usan `EmptyState`
- [ ] Loaders usan `Loader` o `tr-spin`
- [ ] Sin `@keyframes spin` locales
- [ ] Sin `const F = "'Inter'..."` — la fuente es global
- [ ] Sin colores hardcodeados (`#ffffff`, `#f87171`) — usar CSS vars
- [ ] Sin emojis como iconos de sección
- [ ] `npx tsc --noEmit` → 0 errores
- [ ] `npm run lint:errors` → 0 errores
- [ ] `npx vite build` → exitoso

---

*Generado: Mayo 2026 · TechRepair Pro v3.x · src/index.css como fuente de verdad*
