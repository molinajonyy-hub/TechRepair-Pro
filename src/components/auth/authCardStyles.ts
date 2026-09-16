// ─────────────────────────────────────────────────────────────────────────────
// Tarjeta de las pantallas de acceso (Login, nueva contraseña).
//
// BETA-GATE-1 · Lote B: movido TAL CUAL desde src/pages/Login.tsx para que
// /reset-password se vea igual que el login sin copiar 250 líneas de estilos.
// Usa las variables del tema (--auth-bg, --auth-card-bg, --input-*), así que
// respeta light/dark igual que antes.
// ─────────────────────────────────────────────────────────────────────────────

// ── Inline styles (misma estética que la landing page) ──────────────

export const S = {
  // Fondo global
  page: {
    minHeight: '100dvh',
    background: 'var(--auth-bg)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1.5rem',
    position: 'relative' as const,
    overflow: 'hidden',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },

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

  // Envoltorio del card
  shell: {
    width: '100%',
    maxWidth: '420px',
    position: 'relative' as const,
    zIndex: 1,
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

  // Logo icon
  logoIcon: {
    width: '68px', height: '68px',
    borderRadius: '1.125rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 1.25rem',
    boxShadow: '0 12px 32px rgba(99,102,241,0.45)',
    overflow: 'hidden',
  },

  // Input field wrapper
  inputWrap: { position: 'relative' as const, display: 'flex', flexDirection: 'column' as const },

  // Input base
  input: (hasError: boolean, disabled: boolean): React.CSSProperties => ({
    width: '100%',
    padding: '0.875rem 1rem 0.875rem 3rem',
    background: 'var(--input-bg)',
    border: `1px solid ${hasError ? 'rgba(248,113,113,0.6)' : 'var(--input-border)'}`,
    borderRadius: '0.875rem',
    color: 'var(--text-primary)',
    fontSize: '0.9375rem',
    outline: 'none',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
    opacity: disabled ? 0.55 : 1,
    caretColor: 'var(--accent-primary)',
    boxSizing: 'border-box',
  }),

  // Input derecho (para contraseña con ojo)
  inputWithRight: (hasError: boolean, disabled: boolean): React.CSSProperties => ({
    width: '100%',
    padding: '0.875rem 3rem 0.875rem 3rem',
    background: 'var(--input-bg)',
    border: `1px solid ${hasError ? 'rgba(248,113,113,0.6)' : 'var(--input-border)'}`,
    borderRadius: '0.875rem',
    color: 'var(--text-primary)',
    fontSize: '0.9375rem',
    outline: 'none',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
    opacity: disabled ? 0.55 : 1,
    caretColor: 'var(--accent-primary)',
    boxSizing: 'border-box',
  }),

  iconLeft: {
    position: 'absolute' as const,
    left: '1rem',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none' as const,
  },

  label: {
    display: 'block',
    fontSize: '0.8125rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
    marginBottom: '0.5rem',
    letterSpacing: '0.01em',
  },

  errorText: {
    color: 'var(--error)',
    fontSize: '0.75rem',
    marginTop: '0.375rem',
    marginLeft: '0.25rem',
  },

  // Botón principal (gradient)
  btnPrimary: (disabled: boolean): React.CSSProperties => ({
    width: '100%',
    padding: '0.9375rem',
    background: disabled
      ? 'rgba(99,102,241,0.4)'
      : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
    border: 'none',
    borderRadius: '0.875rem',
    color: '#fff',
    fontWeight: 700,
    fontSize: '0.9375rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    transition: 'all 0.22s ease',
    boxShadow: disabled ? 'none' : '0 4px 20px rgba(99,102,241,0.4)',
  }),

  // Botón Google
  btnGoogle: (disabled: boolean): React.CSSProperties => ({
    width: '100%',
    padding: '0.875rem',
    background: 'var(--input-bg)',
    border: '1px solid var(--input-border)',
    borderRadius: '0.875rem',
    color: 'var(--text-secondary)',
    fontWeight: 600,
    fontSize: '0.9375rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.75rem',
    transition: 'all 0.2s ease',
    opacity: disabled ? 0.55 : 1,
  }),

  // Toggle tabs
  tabTrack: {
    display: 'flex',
    background: 'var(--input-bg)',
    border: '1px solid var(--border-color)',
    borderRadius: '0.875rem',
    padding: '0.25rem',
    marginBottom: '1.75rem',
    gap: '0.25rem',
  },

  tab: (active: boolean, disabled: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '0.625rem',
    background: active
      ? 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)'
      : 'transparent',
    border: 'none',
    borderRadius: '0.625rem',
    color: active ? '#fff' : 'var(--text-muted)',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'all 0.2s ease',
    boxShadow: active ? '0 2px 12px rgba(99,102,241,0.35)' : 'none',
    opacity: disabled ? 0.6 : 1,
  }),

  dividerWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    margin: '1.5rem 0',
  },

  dividerLine: {
    flex: 1,
    height: '1px',
    background: 'var(--border-color)',
  },

  dividerText: {
    color: 'var(--text-subtle)',
    fontSize: '0.78rem',
    fontWeight: 500,
    whiteSpace: 'nowrap' as const,
  },
}

// ── Helpers de foco ──────────────────────────────────────────────────

export function focusOn(e: React.FocusEvent<HTMLInputElement>, hasError: boolean) {
  e.target.style.borderColor = hasError ? 'rgba(248,113,113,0.8)' : 'var(--input-focus-border)'
  e.target.style.boxShadow = hasError
    ? '0 0 0 3px rgba(248,113,113,0.12)'
    : 'var(--input-focus-shadow)'
}

export function blurOn(e: React.FocusEvent<HTMLInputElement>, hasError: boolean) {
  e.target.style.borderColor = hasError ? 'rgba(248,113,113,0.6)' : 'var(--input-border)'
  e.target.style.boxShadow = 'none'
}
