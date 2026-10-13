// ─────────────────────────────────────────────────────────────────────────────
// Superficie del embudo de acceso: la tarjeta y los fondos decorativos que usa
// AuthFlowShell. Valores sobre las variables del tema (--auth-card-bg,
// --border-color, --shadow-xl): acompañan light y dark sin ramas.
//
// BETA-UX-1G — este archivo guardaba además TODO el sistema visual del Login
// (página, campos, botón primario con gradiente, botón de Google, pestañas con
// gradiente, foco pintado desde JavaScript). Esas piezas se retiraron: el
// embudo entero usa `.form-control`, AppButton y los primitivos de
// AuthFlowFields, igual que el resto del producto. Acá no se agregan estilos de
// controles: si falta uno, va a AuthFlowFields + src/css/auth-flow.css.
// ─────────────────────────────────────────────────────────────────────────────

export const S = {
  // Blobs de fondo
  blob1: {
    position: 'fixed' as const,
    top: '-15%', left: '-10%',
    width: '55vw', height: '55vw',
    maxWidth: '650px', maxHeight: '650px',
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(99,102,241,0.14) 0%, transparent 70%)',
    pointerEvents: 'none' as const,
  },
  blob2: {
    position: 'fixed' as const,
    bottom: '-15%', right: '-10%',
    width: '50vw', height: '50vw',
    maxWidth: '580px', maxHeight: '580px',
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(168,85,247,0.1) 0%, transparent 70%)',
    pointerEvents: 'none' as const,
  },
  blob3: {
    position: 'fixed' as const,
    top: '40%', right: '10%',
    width: '30vw', height: '30vw',
    maxWidth: '350px', maxHeight: '350px',
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(6,182,212,0.07) 0%, transparent 70%)',
    pointerEvents: 'none' as const,
  },

  // Card de glass
  card: {
    background: 'var(--auth-card-bg)',
    backdropFilter: 'blur(24px)',
    WebkitBackdropFilter: 'blur(24px)',
    border: '1px solid var(--border-color)',
    borderRadius: '1.5rem',
    padding: 'clamp(1.75rem, 5vw, 2.5rem)',
    boxShadow: 'var(--shadow-xl)',
    position: 'relative' as const,
    overflow: 'hidden',
  },

  // Línea top del card (glow)
  cardTopGlow: {
    position: 'absolute' as const,
    top: 0, left: '20%', right: '20%',
    height: '1px',
    background: 'linear-gradient(90deg, transparent, rgba(99,102,241,0.6), transparent)',
  },
}
