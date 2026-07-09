/**
 * tokens — design system tokens globales de TechRepair Pro.
 *
 * Usar estas constantes en lugar de hardcodear valores visuales.
 * Los colores referencian las CSS custom properties de index.css, por lo que
 * responden automáticamente al tema activo (light/dark vía data-theme).
 *
 * Uso:
 *   import { colors, radius, transitions } from '../lib/tokens'
 *   style={{ background: colors.bg.card, borderRadius: radius.lg }}
 */

// ─── Colores ──────────────────────────────────────────────────────────────────

export const colors = {

  // Superficies
  bg: {
    app:        'var(--bg-primary)',      // fondo global del shell
    surface:    'var(--bg-modal)',        // modales, cards primarias
    surfaceAlt: 'var(--bg-sidebar)',      // panel derecho, paneles secundarios
    card:       'var(--bg-hover)',
    cardHover:  'var(--bg-tertiary)',
    input:      'var(--input-bg)',
    overlay:    'rgba(0,0,0,0.85)',       // overlays siempre oscuros
    overlayStrong: 'rgba(0,0,0,0.96)',
  },

  // Bordes
  border: {
    subtle:   'var(--border-subtle)',
    default:  'var(--border-color)',
    medium:   'var(--border-strong)',
    focused:  'var(--border-focus)',
  },

  // Texto
  text: {
    primary:   'var(--text-primary)',
    secondary: 'var(--text-secondary)',
    subtle:    'var(--text-tertiary)',
    muted:     'var(--text-subtle)',
    disabled:  'var(--text-disabled)',
  },

  // Semántico
  success:   'var(--success)',
  successBg: 'var(--success-subtle)',
  successBorder: 'var(--success-border)',

  warning:   'var(--warning-soft)',
  warningBg: 'var(--warning-subtle)',
  warningBorder: 'var(--warning-border)',

  error:     'var(--error)',
  errorBg:   'var(--error-subtle)',
  errorBorder: 'var(--error-border)',

  info:      'var(--info)',
  infoBg:    'var(--info-subtle)',

  // Acento principal (indigo)
  indigo:        'var(--color-primary-light)',
  indigoBright:  'var(--accent-primary)',
  indigoBg:      'var(--accent-primary-subtle)',
  indigoBorder:  'var(--border-accent)',

  // Stock
  stock: {
    ok:   '#22c55e',
    low:  '#f59e0b',
    out:  '#ef4444',
  },

  // Métodos de pago
  payment: {
    cash:     '#22c55e',
    transfer: '#3b82f6',
    debit:    '#f59e0b',
    credit:   '#f97316',
    qr:       '#8b5cf6',
    cc:       '#94a3b8',   // cuenta corriente
    usd:      '#22c55e',
  },

} as const

// ─── Espaciado ────────────────────────────────────────────────────────────────

export const spacing = {
  xs:   '0.25rem',   //  4px
  sm:   '0.5rem',    //  8px
  md:   '0.875rem',  // 14px
  lg:   '1.25rem',   // 20px
  xl:   '1.75rem',   // 28px
  '2xl':'2.5rem',    // 40px
} as const

// ─── Border radius ────────────────────────────────────────────────────────────

export const radius = {
  sm:   '0.375rem',   //  6px — inputs compactos
  md:   '0.625rem',   // 10px — cards
  lg:   '0.875rem',   // 14px — modales, panels
  xl:   '1.125rem',   // 18px — modales grandes
  '2xl':'1.375rem',   // 22px — modal principal
  full: '9999px',     // chips, badges
} as const

// ─── Sombras ──────────────────────────────────────────────────────────────────

export const shadows = {
  card:    'var(--shadow-card)',
  modal:   'var(--shadow-xl)',
  dropdown:'var(--shadow-lg)',
  glow: {
    indigo: '0 0 16px rgba(99,102,241,0.4)',
    green:  '0 0 12px rgba(34,197,94,0.3)',
    red:    '0 0 12px rgba(248,113,113,0.3)',
    amber:  '0 0 12px rgba(245,158,11,0.3)',
  },
} as const

// ─── Transiciones ─────────────────────────────────────────────────────────────

export const transitions = {
  fast:   'all 0.12s ease',
  normal: 'all 0.18s ease',
  slow:   'all 0.25s ease',
  color:  'color 0.12s ease, background 0.12s ease, border-color 0.12s ease',
} as const

// ─── Z-index ──────────────────────────────────────────────────────────────────

export const zIndex = {
  base:        0,
  raised:      10,
  dropdown:    100,
  sticky:      200,
  overlay:     500,
  modal:       9999,
  spotlight:   10000,
  toast:       99999,
} as const

// ─── Tipografía ───────────────────────────────────────────────────────────────

export const fontFamily = {
  sans: "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
  mono: "'JetBrains Mono','Fira Code','Cascadia Code',monospace",
} as const

export const fontSize = {
  xs:   '0.65rem',
  sm:   '0.75rem',
  base: '0.875rem',
  md:   '1rem',
  lg:   '1.125rem',
  xl:   '1.25rem',
  '2xl':'1.5rem',
  '3xl':'2rem',
} as const

// ─── Duraciones de animación ──────────────────────────────────────────────────

export const duration = {
  instant: 80,    // ms — feedback táctil mínimo
  fast:    120,   // ms — hover, small state changes
  normal:  200,   // ms — modal open, card appear
  slow:    350,   // ms — page transitions
  toast:   1800,  // ms — duración de toasts
  overlay: 750,   // ms — overlay "producto agregado"
} as const
