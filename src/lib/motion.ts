/**
 * motion — sistema de movimiento centralizado de TechRepair Pro.
 *
 * Todos los valores de duración, easing y animaciones se definen aquí.
 * NO hardcodear `transition: all 0.2s ease` inline — importar desde acá.
 *
 * Uso:
 *   import { transition, animate, keyframes as motionKeyframes } from '../lib/motion'
 *   style={{ transition: transition.normal }}
 *
 *   // CSS:
 *   animation: ${animate('tr-modal-in')}
 */

// ─── Duraciones (ms) ──────────────────────────────────────────────────────────

export const duration = {
  instant:  60,    // feedback táctil mínimo, hover rápido
  fast:     120,   // micro-interacciones: botones, chips, badges
  normal:   180,   // modales, dropdowns, cards
  slow:     260,   // page transitions, sidebars
  gentle:   360,   // onboarding, tooltips extensos
} as const

// ─── Easings (CSS cubic-bezier) ───────────────────────────────────────────────

export const easing = {
  /** Suave general — para la mayoría de transiciones */
  premiumEase:  'cubic-bezier(0.25, 0.46, 0.45, 0.94)',

  /** Micro-bounce sutil — botones, íconos */
  softBounce:   'cubic-bezier(0.34, 1.56, 0.64, 1)',

  /** Salida rápida — modales, overlays que desaparecen */
  quickOut:     'cubic-bezier(0.16, 1, 0.3, 1)',

  /** In + Out suave — progress, sliders */
  smoothInOut:  'cubic-bezier(0.4, 0, 0.2, 1)',

  /** Spring elástico — overlays que aparecen */
  springy:      'cubic-bezier(0.175, 0.885, 0.32, 1.275)',

  /** Brusco y rápido — POS feedback, scanner */
  snappy:       'cubic-bezier(0.77, 0, 0.175, 1)',

  /** Linear — spinners, indicadores de progreso */
  linear:       'linear',
} as const

// ─── Transiciones pre-construidas ────────────────────────────────────────────

export const transition = {
  /** Hover, color, borders — 120ms */
  fast:      `all ${duration.fast}ms ${easing.quickOut}`,

  /** Modales, panels, cards — 180ms */
  normal:    `all ${duration.normal}ms ${easing.premiumEase}`,

  /** Page transitions, sidebars — 260ms */
  slow:      `all ${duration.slow}ms ${easing.smoothInOut}`,

  /** Solo color/bg/border (no transform) — eficiente */
  color:     `color ${duration.fast}ms ${easing.quickOut}, background-color ${duration.fast}ms ${easing.quickOut}, border-color ${duration.fast}ms ${easing.quickOut}`,

  /** Solo transform */
  transform: `transform ${duration.normal}ms ${easing.softBounce}`,

  /** Solo opacidad */
  opacity:   `opacity ${duration.fast}ms ${easing.quickOut}`,

  /** Spring para elementos que entran */
  spring:    `transform ${duration.slow}ms ${easing.springy}, opacity ${duration.normal}ms ${easing.quickOut}`,

  /** POS: sin transición — respuesta inmediata */
  none:      'none',
} as const

// ─── CSS @keyframes ──────────────────────────────────────────────────────────
//
// Usar en <style> tag del componente raíz o en index.css
// Nombres con prefijo "tr-" para evitar colisiones globales

export const keyframes = `
/* Modal / overlay */
@keyframes tr-modal-in   { from { opacity:0; transform:scale(0.97) translateY(8px);  } to { opacity:1; transform:none; } }
@keyframes tr-modal-out  { from { opacity:1; transform:none; } to { opacity:0; transform:scale(0.97) translateY(8px); } }
@keyframes tr-overlay-in { from { opacity:0; transform:scale(0.95) translateY(-6px); } to { opacity:1; transform:none; } }

/* Toast / notificaciones */
@keyframes tr-toast-up   { from { opacity:0; transform:translateX(-50%) translateY(10px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
@keyframes tr-toast-right{ from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:none; } }

/* Feedback */
@keyframes tr-shake      { 0%,100%{transform:translateX(0)} 18%{transform:translateX(-5px)} 36%{transform:translateX(5px)} 54%{transform:translateX(-3px)} 72%{transform:translateX(2px)} }
@keyframes tr-bounce-in  { 0%{opacity:0;transform:scale(0.5)} 60%{transform:scale(1.08)} 100%{opacity:1;transform:scale(1)} }
@keyframes tr-pulse-ok   { 0%{box-shadow:0 0 0 0 rgba(52,211,153,0.5)} 60%{box-shadow:0 0 0 10px rgba(52,211,153,0)} 100%{box-shadow:0 0 0 0 rgba(52,211,153,0)} }
@keyframes tr-pulse-err  { 0%{box-shadow:0 0 0 0 rgba(239,68,68,0.5)} 60%{box-shadow:0 0 0 10px rgba(239,68,68,0)} 100%{box-shadow:0 0 0 0 rgba(239,68,68,0)} }
@keyframes tr-pulse-warn { 0%{box-shadow:0 0 0 0 rgba(245,158,11,0.5)} 60%{box-shadow:0 0 0 10px rgba(245,158,11,0)} 100%{box-shadow:0 0 0 0 rgba(245,158,11,0)} }

/* Entrada de elementos */
@keyframes tr-fade-in    { from{opacity:0} to{opacity:1} }
@keyframes tr-slide-down { from{opacity:0;transform:translateY(-10px)} to{opacity:1;transform:translateY(0)} }
@keyframes tr-slide-up   { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
@keyframes tr-scale-in   { from{opacity:0;transform:scale(0.93)} to{opacity:1;transform:scale(1)} }
@keyframes tr-item-in    { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:translateY(0)} }

/* Utility */
@keyframes tr-spin       { to{transform:rotate(360deg)} }
@keyframes tr-glow       { 0%,100%{opacity:1} 50%{opacity:0.5} }
`

// ─── Helper: genera shorthand de animation ────────────────────────────────────

/**
 * Crea el valor de la propiedad CSS `animation`.
 *
 * @example
 * style={{ animation: animate('tr-modal-in') }}
 * style={{ animation: animate('tr-shake', duration.fast, easing.snappy) }}
 */
export function animate(
  name:  string,
  dur:   number = duration.normal,
  ease:  string = easing.premiumEase,
  fill:  string = 'both',
  delay: number = 0,
): string {
  const d = delay > 0 ? ` ${delay}ms` : ''
  return `${name} ${dur}ms ${ease}${d} ${fill}`
}

// ─── Presets de animación comunes ─────────────────────────────────────────────

export const animations = {
  modalIn:       animate('tr-modal-in',    duration.normal, easing.quickOut),
  overlayIn:     animate('tr-overlay-in',  duration.normal, easing.springy),
  toastUp:       animate('tr-toast-up',    duration.fast,   easing.quickOut),
  shake:         animate('tr-shake',       320,             easing.snappy),
  pulseOk:       animate('tr-pulse-ok',    600,             easing.linear),
  pulseErr:      animate('tr-pulse-err',   600,             easing.linear),
  bounceIn:      animate('tr-bounce-in',   duration.slow,   easing.softBounce),
  slideDown:     animate('tr-slide-down',  duration.fast,   easing.quickOut),
  slideUp:       animate('tr-slide-up',    duration.fast,   easing.quickOut),
  fadeIn:        animate('tr-fade-in',     duration.fast,   easing.premiumEase),
  itemIn:        animate('tr-item-in',     duration.fast,   easing.premiumEase),
  spin:          animate('tr-spin',        1000,            easing.linear, 'none'),
} as const
