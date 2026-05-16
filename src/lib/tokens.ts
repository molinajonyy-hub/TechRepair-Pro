/**
 * tokens — design system tokens globales de TechRepair Pro.
 *
 * Usar estas constantes en lugar de hardcodear valores visuales.
 * Paleta dark-first, diseñada para densidad de información alta (POS/ERP).
 *
 * Uso:
 *   import { colors, radius, transitions } from '../lib/tokens'
 *   style={{ background: colors.bg.card, borderRadius: radius.lg }}
 */

// ─── Colores ──────────────────────────────────────────────────────────────────

export const colors = {

  // Superficies
  bg: {
    app:        '#071018',             // fondo global del shell
    surface:    '#0a1628',             // modales, cards primarias
    surfaceAlt: '#07101f',             // panel derecho, paneles secundarios
    card:       'rgba(255,255,255,0.025)',
    cardHover:  'rgba(255,255,255,0.04)',
    input:      'rgba(255,255,255,0.04)',
    overlay:    'rgba(0,0,0,0.85)',
    overlayStrong: 'rgba(0,0,0,0.96)',
  },

  // Bordes
  border: {
    subtle:   'rgba(255,255,255,0.05)',
    default:  'rgba(255,255,255,0.08)',
    medium:   'rgba(255,255,255,0.12)',
    focused:  'rgba(99,102,241,0.35)',
  },

  // Texto
  text: {
    primary:   '#f0f4ff',
    secondary: '#94a3b8',
    subtle:    '#475569',
    muted:     '#334155',
    disabled:  '#1e3a5f',
  },

  // Semántico
  success:   '#34d399',
  successBg: 'rgba(52,211,153,0.10)',
  successBorder: 'rgba(52,211,153,0.25)',

  warning:   '#f59e0b',
  warningBg: 'rgba(245,158,11,0.10)',
  warningBorder: 'rgba(245,158,11,0.25)',

  error:     '#f87171',
  errorBg:   'rgba(248,113,113,0.10)',
  errorBorder: 'rgba(248,113,113,0.25)',

  info:      '#60a5fa',
  infoBg:    'rgba(96,165,250,0.10)',

  // Acento principal (indigo)
  indigo:        '#818cf8',
  indigoBright:  '#6366f1',
  indigoBg:      'rgba(99,102,241,0.12)',
  indigoBorder:  'rgba(99,102,241,0.30)',

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
  card:    '0 4px 20px rgba(0,0,0,0.4)',
  modal:   '0 40px 120px rgba(0,0,0,0.95), 0 0 0 1px rgba(255,255,255,0.04)',
  dropdown:'0 12px 40px rgba(0,0,0,0.6)',
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
