import { useEffect, useState, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Lock, Mail, Eye, EyeOff, Loader2, User, ArrowLeft } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

// ── Inline styles (misma estética que la landing page) ──────────────

const S = {
  // Fondo global
  page: {
    minHeight: '100dvh',
    background: '#09090b',
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
    background: 'rgba(255,255,255,0.025)',
    backdropFilter: 'blur(24px)',
    WebkitBackdropFilter: 'blur(24px)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '1.5rem',
    padding: 'clamp(1.75rem, 5vw, 2.5rem)',
    boxShadow: '0 32px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05)',
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
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${hasError ? 'rgba(248,113,113,0.6)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius: '0.875rem',
    color: '#f1f5f9',
    fontSize: '0.9375rem',
    outline: 'none',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
    opacity: disabled ? 0.55 : 1,
    caretColor: '#818cf8',
    boxSizing: 'border-box',
  }),

  // Input derecho (para contraseña con ojo)
  inputWithRight: (hasError: boolean, disabled: boolean): React.CSSProperties => ({
    width: '100%',
    padding: '0.875rem 3rem 0.875rem 3rem',
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${hasError ? 'rgba(248,113,113,0.6)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius: '0.875rem',
    color: '#f1f5f9',
    fontSize: '0.9375rem',
    outline: 'none',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
    opacity: disabled ? 0.55 : 1,
    caretColor: '#818cf8',
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
    color: '#94a3b8',
    marginBottom: '0.5rem',
    letterSpacing: '0.01em',
  },

  errorText: {
    color: '#f87171',
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
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '0.875rem',
    color: '#e2e8f0',
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
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
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
    color: active ? '#fff' : '#64748b',
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
    background: 'rgba(255,255,255,0.07)',
  },

  dividerText: {
    color: '#334155',
    fontSize: '0.78rem',
    fontWeight: 500,
    whiteSpace: 'nowrap' as const,
  },
}

// ── Helpers de foco ──────────────────────────────────────────────────

function focusOn(e: React.FocusEvent<HTMLInputElement>, hasError: boolean) {
  e.target.style.borderColor = hasError ? 'rgba(248,113,113,0.8)' : 'rgba(99,102,241,0.7)'
  e.target.style.boxShadow = hasError
    ? '0 0 0 3px rgba(248,113,113,0.12)'
    : '0 0 0 3px rgba(99,102,241,0.15)'
}

function blurOn(e: React.FocusEvent<HTMLInputElement>, hasError: boolean) {
  e.target.style.borderColor = hasError ? 'rgba(248,113,113,0.6)' : 'rgba(255,255,255,0.1)'
  e.target.style.boxShadow = 'none'
}

// ── Componente ───────────────────────────────────────────────────────

export function Login() {
  const navigate    = useNavigate()
  const location    = useLocation()
  const { signIn, signUp, signInWithGoogle, isAuthenticated, isLoading: authLoading } = useAuth()
  const emailInputRef = useRef<HTMLInputElement>(null)

  const [mode, setMode]                         = useState<'login' | 'register' | 'forgot'>('login')
  const [email, setEmail]                       = useState('')
  const [password, setPassword]                 = useState('')
  const [confirmPassword, setConfirmPassword]   = useState('')
  const [fullName, setFullName]                 = useState('')
  const [showPassword, setShowPassword]         = useState(false)
  const [showConfirm, setShowConfirm]           = useState(false)
  const [isLoading, setIsLoading]               = useState(false)
  const [isGoogleLoading, setIsGoogleLoading]   = useState(false)
  const [error, setError]                       = useState('')
  const [success, setSuccess]                   = useState('')
  const [emailError, setEmailError]             = useState('')
  const [passwordError, setPasswordError]       = useState('')
  const [confirmError, setConfirmError]         = useState('')

  const from = location.state?.from?.pathname || '/dashboard'

  // Detectar errores OAuth que redirigen de vuelta al login (ej: acceso denegado)
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const oauthError = params.get('error')
    const oauthErrorDesc = params.get('error_description')
    if (oauthError) {
      const msg = oauthErrorDesc
        ? decodeURIComponent(oauthErrorDesc.replace(/\+/g, ' '))
        : oauthError === 'access_denied'
        ? 'Cancelaste el inicio de sesión con Google.'
        : `Error de Google: ${oauthError}`
      setError(msg)
    }
  }, [location.search])

  useEffect(() => { emailInputRef.current?.focus() }, [])

  useEffect(() => {
    if (isAuthenticated) {
      const stored = sessionStorage.getItem('post_login_redirect')
      sessionStorage.removeItem('post_login_redirect')
      navigate(stored || from, { replace: true })
    }
  }, [isAuthenticated, from, navigate])

  useEffect(() => {
    const t = setTimeout(() => {
      if (authLoading) console.warn('Auth loading timeout - showing login form anyway')
    }, 5000)
    return () => clearTimeout(t)
  }, [authLoading])

  const validateEmail    = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
  const validatePassword = (v: string) => v.length >= 6

  const clearErrors = () => {
    setError(''); setSuccess('')
    setEmailError(''); setPasswordError(''); setConfirmError('')
  }

  const handleModeChange = (m: 'login' | 'register' | 'forgot') => {
    setMode(m); clearErrors()
    setEmail(''); setPassword(''); setConfirmPassword(''); setFullName('')
  }

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    clearErrors()
    if (!email.trim())         { setEmailError('Ingresá tu email'); return }
    if (!validateEmail(email)) { setEmailError('Email inválido'); return }
    setIsLoading(true)
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/callback`,
      })
      if (resetError) throw resetError
      setSuccess(`Enviamos un enlace a ${email}. Revisá tu bandeja de entrada (y spam).`)
    } catch (err: any) {
      setError(err.message || 'Error al enviar el email.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    clearErrors()

    if (!email.trim())          { setEmailError('Por favor ingresá tu email'); emailInputRef.current?.focus(); return }
    if (!validateEmail(email))  { setEmailError('Por favor ingresá un email válido'); emailInputRef.current?.focus(); return }
    if (!password.trim())       { setPasswordError('Por favor ingresá tu contraseña'); return }
    if (!validatePassword(password)) { setPasswordError('La contraseña debe tener al menos 6 caracteres'); return }

    if (mode === 'register') {
      if (!confirmPassword.trim()) { setConfirmError('Por favor confirmá tu contraseña'); return }
      if (password !== confirmPassword) { setConfirmError('Las contraseñas no coinciden'); return }
    }

    setIsLoading(true)
    try {
      if (mode === 'login') {
        await signIn(email, password)
        navigate(from, { replace: true })
      } else {
        const result = await signUp(email, password, fullName.trim() || undefined)
        if (result.needsEmailConfirmation) {
          setMode('login'); setPassword(''); setConfirmPassword('')
          setSuccess('Cuenta creada. Revisá tu email para confirmar y luego iniciá sesión.')
          setIsLoading(false); return
        }
        navigate('/no-business', { replace: true })
      }
    } catch (err: any) {
      const raw: string = (err?.message || '').toLowerCase()
      let msg: string
      if (mode === 'login') {
        msg = raw.includes('invalid login') || raw.includes('invalid credentials') || raw.includes('email not confirmed')
          ? 'Email o contraseña incorrectos. Verificá tus datos.'
          : err?.message || 'Error al iniciar sesión. Intentá nuevamente.'
      } else {
        if (raw.includes('already registered') || raw.includes('already been registered')) {
          msg = 'Este email ya tiene una cuenta. Iniciá sesión o recuperá tu contraseña.'
        } else if (raw.includes('email') && (raw.includes('send') || raw.includes('500') || raw.includes('smtp') || raw.includes('resend'))) {
          msg = 'No pudimos enviar el email de confirmación. Si el problema persiste, contactá al administrador.'
        } else {
          msg = err?.message || 'Error al crear la cuenta. Intentá nuevamente.'
        }
      }
      setError(msg)
      setIsLoading(false)
    }
  }

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true); clearErrors()
    sessionStorage.setItem('post_login_redirect', from)
    try {
      await signInWithGoogle()
    } catch (err: any) {
      sessionStorage.removeItem('post_login_redirect')
      setError(err.message || 'No se pudo iniciar sesión con Google.')
      setIsGoogleLoading(false)
    }
  }

  const disabled = isLoading || isGoogleLoading

  return (
    <div style={S.page}>
      {/* Blobs de fondo */}
      <div style={S.blob1} />
      <div style={S.blob2} />
      <div style={S.blob3} />

      {/* Grilla de puntos decorativa */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none',
        backgroundImage: 'radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
      }} />

      <div style={S.shell}>
        {/* Link volver a landing */}
        <button
          onClick={() => navigate('/landing')}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.375rem',
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#475569', fontSize: '0.8125rem', fontWeight: 500,
            marginBottom: '1.5rem', transition: 'color 0.15s ease',
            padding: 0,
          }}
          onMouseEnter={e => (e.currentTarget.style.color = '#818cf8')}
          onMouseLeave={e => (e.currentTarget.style.color = '#475569')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Volver al inicio
        </button>

        {/* Card */}
        <div style={S.card}>
          {/* Glow top */}
          <div style={S.cardTopGlow} />

          {/* Logo */}
          <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
            <div style={S.logoIcon}>
              <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" width="68" height="68">
                <defs>
                  <linearGradient id="loginCatBg" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" style={{ stopColor: '#6366f1' }} />
                    <stop offset="100%" style={{ stopColor: '#8b5cf6' }} />
                  </linearGradient>
                </defs>
                <rect width="100" height="100" rx="22" fill="url(#loginCatBg)" />
                <path d="M18 46 L25 14 L38 36 Q50 30 62 36 L75 14 L82 46 Q86 60 82 70 Q70 88 50 88 Q30 88 18 70 Q14 60 18 46 Z" fill="white" opacity="0.93" />
                <path d="M26 18 L20 43 L37 36 Z" fill="#6366f1" opacity="0.45" />
                <path d="M74 18 L80 43 L63 36 Z" fill="#6366f1" opacity="0.45" />
                <ellipse cx="37" cy="58" rx="5.5" ry="5" fill="#6366f1" opacity="0.85" />
                <ellipse cx="63" cy="58" rx="5.5" ry="5" fill="#6366f1" opacity="0.85" />
              </svg>
            </div>
            <h1 style={{
              fontSize: '1.625rem', fontWeight: 900, letterSpacing: '-0.04em',
              color: '#f8fafc', margin: '0 0 0.3rem',
            }}>
              TechRepair
              <span style={{
                background: 'linear-gradient(135deg, #818cf8, #a78bfa)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}>Pro</span>
            </h1>
            <p style={{ color: '#334155', fontSize: '0.875rem', margin: 0 }}>
              {mode === 'login' ? 'Ingresá a tu panel de gestión' : mode === 'register' ? 'Creá tu cuenta gratuita' : 'Te enviamos un enlace por email'}
            </p>
          </div>

          {/* Tabs (solo en login/register, no en forgot) */}
          {mode !== 'forgot' && (
            <div style={S.tabTrack}>
              <button type="button" style={S.tab(mode === 'login', disabled)} onClick={() => handleModeChange('login')} disabled={disabled}>
                Iniciar sesión
              </button>
              <button type="button" style={S.tab(mode === 'register', disabled)} onClick={() => handleModeChange('register')} disabled={disabled}>
                Crear cuenta
              </button>
            </div>
          )}

          {/* Alerta de error */}
          {error && (
            <div style={{
              padding: '0.875rem 1rem', borderRadius: '0.75rem',
              background: 'rgba(248,113,113,0.08)',
              border: '1px solid rgba(248,113,113,0.25)',
              color: '#f87171', fontSize: '0.875rem',
              marginBottom: '1.25rem',
              display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
            }} role="alert">
              <span style={{ fontSize: '1rem', flexShrink: 0 }}>⚠️</span>
              {error}
            </div>
          )}

          {/* Mensaje de éxito */}
          {success && (
            <div style={{
              padding: '0.875rem 1rem', borderRadius: '0.75rem',
              background: 'rgba(16,185,129,0.08)',
              border: '1px solid rgba(16,185,129,0.25)',
              color: '#10b981', fontSize: '0.875rem',
              marginBottom: '1.25rem',
              display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
            }} role="status">
              <span style={{ fontSize: '1rem', flexShrink: 0 }}>✅</span>
              {success}
            </div>
          )}

          {/* Formulario de recuperación de contraseña */}
          {mode === 'forgot' && (
            <form onSubmit={handleForgotPassword} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1.125rem' }}>
              <div>
                <label htmlFor="forgot-email" style={S.label}>Email de tu cuenta</label>
                <div style={{ position: 'relative' }}>
                  <Mail size={17} style={{ ...S.iconLeft, color: emailError ? '#f87171' : '#334155' }} />
                  <input
                    id="forgot-email" type="email" value={email}
                    placeholder="tu@email.com" autoComplete="email" disabled={isLoading}
                    style={S.input(!!emailError, isLoading)}
                    onChange={e => { setEmail(e.target.value); setEmailError(''); setError('') }}
                    onFocus={e => focusOn(e, !!emailError)}
                    onBlur={e => blurOn(e, !!emailError)}
                    autoFocus
                  />
                </div>
                {emailError && <p style={S.errorText}>{emailError}</p>}
              </div>

              <button type="submit" disabled={isLoading} style={S.btnPrimary(isLoading)}>
                {isLoading
                  ? <><Loader2 size={18} style={{ animation: 'tr-spin 1s linear infinite' }} /> Enviando...</>
                  : 'Enviar enlace de recuperación'
                }
              </button>

              <button
                type="button"
                onClick={() => handleModeChange('login')}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#475569', fontSize: '0.8125rem', fontWeight: 500,
                  padding: '0.25rem', transition: 'color 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.color = '#818cf8')}
                onMouseLeave={e => (e.currentTarget.style.color = '#475569')}
              >
                <ArrowLeft size={14} /> Volver al login
              </button>
            </form>
          )}

          {/* Formulario normal login/registro */}
          {mode !== 'forgot' && (
          <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1.125rem' }}>

            {/* Nombre (sólo registro) */}
            {mode === 'register' && (
              <div>
                <label htmlFor="fullName" style={S.label}>Nombre completo</label>
                <div style={{ position: 'relative' }}>
                  <User size={17} style={{ ...S.iconLeft, color: '#334155' }} />
                  <input
                    id="fullName" type="text" value={fullName} placeholder="Juan Pérez"
                    autoComplete="name" disabled={disabled}
                    style={S.input(false, disabled)}
                    onChange={e => { setFullName(e.target.value); clearErrors() }}
                    onFocus={e => focusOn(e, false)}
                    onBlur={e => blurOn(e, false)}
                  />
                </div>
              </div>
            )}

            {/* Email */}
            <div>
              <label htmlFor="email" style={S.label}>Email</label>
              <div style={{ position: 'relative' }}>
                <Mail size={17} style={{ ...S.iconLeft, color: emailError ? '#f87171' : '#334155' }} />
                <input
                  id="email" ref={emailInputRef} type="email" value={email}
                  placeholder="tu@email.com" autoComplete="email" disabled={disabled}
                  style={S.input(!!emailError, disabled)}
                  onChange={e => { setEmail(e.target.value); setEmailError(''); setError('') }}
                  onFocus={e => focusOn(e, !!emailError)}
                  onBlur={e => blurOn(e, !!emailError)}
                />
              </div>
              {emailError && <p style={S.errorText}>{emailError}</p>}
            </div>

            {/* Contraseña */}
            <div>
              <label htmlFor="password" style={S.label}>Contraseña</label>
              <div style={{ position: 'relative' }}>
                <Lock size={17} style={{ ...S.iconLeft, color: passwordError ? '#f87171' : '#334155' }} />
                <input
                  id="password" type={showPassword ? 'text' : 'password'} value={password}
                  placeholder="••••••••"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  disabled={disabled}
                  style={S.inputWithRight(!!passwordError, disabled)}
                  onChange={e => { setPassword(e.target.value); setPasswordError(''); setError('') }}
                  onFocus={e => focusOn(e, !!passwordError)}
                  onBlur={e => blurOn(e, !!passwordError)}
                />
                <button
                  type="button" onClick={() => setShowPassword(v => !v)} disabled={disabled}
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  style={{
                    position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', padding: 0, cursor: disabled ? 'not-allowed' : 'pointer',
                    color: '#334155', display: 'flex', alignItems: 'center',
                    transition: 'color 0.15s ease',
                  }}
                  onMouseEnter={e => { if (!disabled) (e.currentTarget as HTMLElement).style.color = '#818cf8' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#334155' }}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              {passwordError && <p style={S.errorText}>{passwordError}</p>}
            </div>

            {/* Confirmar contraseña (sólo registro) */}
            {mode === 'register' && (
              <div>
                <label htmlFor="confirmPassword" style={S.label}>Confirmar contraseña</label>
                <div style={{ position: 'relative' }}>
                  <Lock size={17} style={{ ...S.iconLeft, color: confirmError ? '#f87171' : '#334155' }} />
                  <input
                    id="confirmPassword" type={showConfirm ? 'text' : 'password'} value={confirmPassword}
                    placeholder="••••••••" autoComplete="new-password" disabled={disabled}
                    style={S.inputWithRight(!!confirmError, disabled)}
                    onChange={e => { setConfirmPassword(e.target.value); setConfirmError(''); setError('') }}
                    onFocus={e => focusOn(e, !!confirmError)}
                    onBlur={e => blurOn(e, !!confirmError)}
                  />
                  <button
                    type="button" onClick={() => setShowConfirm(v => !v)} disabled={disabled}
                    aria-label={showConfirm ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                    style={{
                      position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', padding: 0, cursor: disabled ? 'not-allowed' : 'pointer',
                      color: '#334155', display: 'flex', alignItems: 'center',
                      transition: 'color 0.15s ease',
                    }}
                    onMouseEnter={e => { if (!disabled) (e.currentTarget as HTMLElement).style.color = '#818cf8' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#334155' }}
                  >
                    {showConfirm ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
                {confirmError && <p style={S.errorText}>{confirmError}</p>}
              </div>
            )}

            {/* Botón principal */}
            <button
              type="submit" disabled={disabled} style={S.btnPrimary(disabled)}
              onMouseEnter={e => { if (!disabled) { (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 8px 28px rgba(99,102,241,0.55)' } }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 20px rgba(99,102,241,0.4)' }}
            >
              {isLoading ? (
                <>
                  <Loader2 size={18} style={{ animation: 'tr-spin 1s linear infinite' }} />
                  {mode === 'login' ? 'Iniciando sesión...' : 'Creando cuenta...'}
                </>
              ) : (
                mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta gratis'
              )}
            </button>
          </form>

          )} {/* fin mode !== 'forgot' */}

          {/* Google + olvidé contraseña (sólo login) */}
          {mode === 'login' && (
            <>
              <div style={S.dividerWrap}>
                <div style={S.dividerLine} />
                <span style={S.dividerText}>o continuá con</span>
                <div style={S.dividerLine} />
              </div>

              <button
                type="button" onClick={handleGoogleSignIn} disabled={disabled}
                style={S.btnGoogle(disabled)}
                onMouseEnter={e => {
                  if (!disabled) {
                    const el = e.currentTarget as HTMLElement
                    el.style.background = 'rgba(255,255,255,0.07)'
                    el.style.borderColor = 'rgba(255,255,255,0.18)'
                    el.style.transform = 'translateY(-1px)'
                  }
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLElement
                  el.style.background = 'rgba(255,255,255,0.04)'
                  el.style.borderColor = 'rgba(255,255,255,0.1)'
                  el.style.transform = 'translateY(0)'
                }}
              >
                {isGoogleLoading ? (
                  <>
                    <Loader2 size={18} style={{ animation: 'tr-spin 1s linear infinite' }} />
                    Redirigiendo a Google...
                  </>
                ) : (
                  <>
                    <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    Continuar con Google
                  </>
                )}
              </button>

              <div style={{ textAlign: 'center', marginTop: '1.25rem' }}>
                <button
                  type="button"
                  onClick={() => handleModeChange('forgot')}
                  style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    color: '#818cf8', fontSize: '0.8125rem', fontWeight: 600,
                    transition: 'color 0.15s ease',
                    textDecoration: 'underline',
                    textDecorationColor: 'rgba(129,140,248,0.4)',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#a78bfa')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#818cf8')}
                >
                  ¿Olvidaste tu contraseña?
                </button>
              </div>
            </>
          )}

          {/* Pie */}
          <p style={{
            textAlign: 'center', color: '#1e293b',
            fontSize: '0.75rem', marginTop: '1.5rem', lineHeight: 1.6,
          }}>
            Al continuar aceptás los{' '}
            <a href="#" style={{ color: '#6366f1', textDecoration: 'none' }}>Términos de uso</a>
            {' '}y la{' '}
            <a href="#" style={{ color: '#6366f1', textDecoration: 'none' }}>Política de privacidad</a>
          </p>
        </div>

        {/* Prueba gratis badge */}
        {mode === 'login' && (
          <div style={{
            textAlign: 'center', marginTop: '1.25rem',
            color: '#1e293b', fontSize: '0.78rem',
          }}>
            ¿No tenés cuenta?{' '}
            <button
              type="button"
              onClick={() => handleModeChange('register')}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: '#818cf8', fontWeight: 700, fontSize: '0.78rem',
                transition: 'color 0.15s ease',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = '#a78bfa')}
              onMouseLeave={e => (e.currentTarget.style.color = '#818cf8')}
            >
              Probalo 14 días gratis →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
