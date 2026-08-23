import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Mail, Loader2, RefreshCw, CheckCircle2, AlertTriangle, LogOut } from 'lucide-react'
import {
  useAuth,
  readPendingConfirmationEmail,
  clearPendingConfirmationEmail,
} from '../contexts/AuthContext'

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL VERIFICATION P0 — pantalla de correo pendiente.
//
// Es la ÚNICA superficie de producto accesible con sesión y sin confirmar.
// Todo lo demás está detrás del guard central (ver ProtectedRoute).
//
// Los estados son un enum cerrado y los textos salen de un mapa: nunca se
// muestra un mensaje crudo de Supabase ni de Postgres.
// ─────────────────────────────────────────────────────────────────────────────

type Estado =
  | 'SIGNUP_SUBMITTED_UNCONFIRMED'
  | 'RESEND_SUCCESS'
  | 'RESEND_RATE_LIMITED'
  | 'CONFIRMED'
  | 'LINK_EXPIRED_OR_INVALID'
  | 'ALREADY_CONFIRMED'
  | 'AUTH_ERROR'

/** Segundos de cooldown del botón de reenvío. */
const RESEND_COOLDOWN_S = 60

/**
 * Redacta el correo para no exhibirlo entero en pantalla.
 * `juanperez@gmail.com` -> `jua•••ez@gmail.com`
 */
function redactEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const [user, domain] = email.split('@')
  if (!user || !domain) return null
  if (user.length <= 4) return `${user[0]}•••@${domain}`
  return `${user.slice(0, 3)}•••${user.slice(-2)}@${domain}`
}

const MENSAJE: Record<Estado, { tono: 'info' | 'ok' | 'warn'; texto: string }> = {
  SIGNUP_SUBMITTED_UNCONFIRMED: {
    tono: 'info',
    texto: 'Te enviamos un enlace para activar tu cuenta de TechRepair Pro.',
  },
  RESEND_SUCCESS: {
    tono: 'ok',
    texto: 'Listo, te reenviamos el correo. Revisá tu bandeja de entrada y la carpeta de spam.',
  },
  RESEND_RATE_LIMITED: {
    tono: 'warn',
    texto: 'Ya enviamos varios correos en poco tiempo. Esperá unos minutos antes de pedir otro.',
  },
  CONFIRMED: {
    tono: 'ok',
    texto: 'Tu correo quedó confirmado. Estamos preparando tu cuenta…',
  },
  LINK_EXPIRED_OR_INVALID: {
    tono: 'warn',
    texto: 'Ese enlace venció o ya no es válido. Pedí uno nuevo con el botón de abajo.',
  },
  ALREADY_CONFIRMED: {
    tono: 'ok',
    texto: 'Tu correo ya estaba confirmado. Podés continuar.',
  },
  AUTH_ERROR: {
    tono: 'warn',
    texto: 'No pudimos verificar el estado de tu cuenta. Probá de nuevo en un momento.',
  },
}

const TONO_COLOR = {
  info: 'var(--text-secondary)',
  ok: 'var(--success)',
  warn: 'var(--error)',
} as const

export function VerifyEmail() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user, isAuthenticated, loading, emailConfirmed, resendConfirmation, refreshUser, signOut } = useAuth()

  // `?estado=` sólo lo escribe /auth/callback cuando un enlace falla. Se valida
  // contra el enum: un valor arbitrario en la URL no puede pintar la pantalla.
  const estadoDeUrl = searchParams.get('estado')
  const estadoInicial: Estado =
    estadoDeUrl === 'LINK_EXPIRED_OR_INVALID' ? 'LINK_EXPIRED_OR_INVALID' : 'SIGNUP_SUBMITTED_UNCONFIRMED'

  const [estado, setEstado] = useState<Estado>(estadoInicial)
  const [verificando, setVerificando] = useState(false)
  const [reenviando, setReenviando] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const navegadoRef = useRef(false)

  /**
   * El correo a mostrar y al que reenviar.
   *
   * Con «Confirm Email» ON el signup NO deja sesión, así que `user` es null y
   * el único rastro del registro es el email que AuthContext guardó. Ese es el
   * caso PRINCIPAL de esta pantalla, no un borde.
   */
  const emailPendiente = readPendingConfirmationEmail()
  const emailObjetivo = user?.email ?? emailPendiente
  const emailRedactado = redactEmail(emailObjetivo)
  /** Hay flujo en curso aunque no haya sesión. */
  const hayContexto = isAuthenticated || !!emailPendiente

  // Countdown del cooldown de reenvío.
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  // Si ya está confirmado (o se confirmó mientras esta pantalla estaba
  // abierta), salir. Un `replace` evita que el botón «atrás» vuelva acá.
  //
  // Este efecto es lo que impide el loop con el guard: el guard manda acá
  // cuando NO está confirmado, y esta pantalla se va sola en cuanto lo está.
  // Los dos leen la misma señal, así que no pueden contradecirse.
  useEffect(() => {
    if (loading) return

    // Sin sesión Y sin registro pendiente no hay nada que verificar: alguien
    // llegó a la URL de prestado.
    if (!hayContexto) {
      if (!navegadoRef.current) {
        navegadoRef.current = true
        navigate('/login', { replace: true })
      }
      return
    }

    if (isAuthenticated && emailConfirmed && !navegadoRef.current) {
      navegadoRef.current = true
      clearPendingConfirmationEmail()
      navigate('/dashboard', { replace: true })
    }
  }, [loading, hayContexto, isAuthenticated, emailConfirmed, navigate])

  const handleYaConfirme = async () => {
    setVerificando(true)
    try {
      // Sin sesión en este browser (el caso típico: se registró acá y confirmó
      // desde el celular). No hay nada que refrescar: la confirmación es
      // válida, pero para entrar hace falta iniciar sesión.
      if (!isAuthenticated) {
        setEstado('ALREADY_CONFIRMED')
        clearPendingConfirmationEmail()
        navigate('/login', { replace: true })
        return
      }

      // Estado REAL contra el servidor. Nunca una bandera local.
      const confirmado = await refreshUser()
      if (confirmado) {
        setEstado('CONFIRMED')
        // La navegación la hace el efecto de arriba cuando `emailConfirmed`
        // se propaga por el contexto. No se navega a mano acá para que haya
        // un solo camino de salida.
      } else {
        // Se queda en la pantalla, que es el contrato.
        setEstado('SIGNUP_SUBMITTED_UNCONFIRMED')
      }
    } catch {
      setEstado('AUTH_ERROR')
    } finally {
      setVerificando(false)
    }
  }

  const handleReenviar = async () => {
    if (!emailObjetivo || cooldown > 0) return
    setReenviando(true)
    try {
      const res = await resendConfirmation(emailObjetivo)
      if (res.status === 'sent') {
        setEstado('RESEND_SUCCESS')
        setCooldown(RESEND_COOLDOWN_S)
      } else if (res.status === 'rate_limited') {
        setEstado('RESEND_RATE_LIMITED')
        setCooldown(RESEND_COOLDOWN_S)
      } else {
        setEstado('AUTH_ERROR')
      }
    } finally {
      setReenviando(false)
    }
  }

  const handleSalir = async () => {
    if (isAuthenticated) await signOut()
    clearPendingConfirmationEmail()
    navigate('/login', { replace: true })
  }

  if (loading) {
    return (
      <div style={S.page}>
        <Loader2 className="animate-spin" size={30} style={{ color: '#6366f1' }} />
      </div>
    )
  }

  const mensaje = MENSAJE[estado]
  const botonReenvioDeshabilitado = reenviando || cooldown > 0 || !emailObjetivo

  return (
    <div style={S.page} data-testid="verify-email-page">
      <div style={S.shell}>
        <div style={S.card}>
          <div style={S.iconWrap}>
            <Mail size={30} style={{ color: '#6366f1' }} />
          </div>

          <h1 style={S.title}>Confirmá tu correo</h1>

          <p
            style={{ ...S.message, color: TONO_COLOR[mensaje.tono] }}
            role="status"
            data-testid="verify-email-estado"
            data-estado={estado}
          >
            {mensaje.texto}
          </p>

          {emailRedactado && (
            <p style={S.email} data-testid="verify-email-address">{emailRedactado}</p>
          )}

          <div style={S.actions}>
            <button
              type="button"
              onClick={handleYaConfirme}
              disabled={verificando}
              data-testid="verify-email-ya-confirme"
              style={{ ...S.primary, opacity: verificando ? 0.6 : 1, cursor: verificando ? 'wait' : 'pointer' }}
            >
              {verificando
                ? <><Loader2 size={16} className="animate-spin" /> Verificando…</>
                : isAuthenticated
                  ? <><CheckCircle2 size={16} /> Ya confirmé, continuar</>
                  : <><CheckCircle2 size={16} /> Ya confirmé, iniciar sesión</>}
            </button>

            <button
              type="button"
              onClick={handleReenviar}
              disabled={botonReenvioDeshabilitado}
              data-testid="verify-email-reenviar"
              style={{
                ...S.secondary,
                opacity: botonReenvioDeshabilitado ? 0.55 : 1,
                cursor: botonReenvioDeshabilitado ? 'not-allowed' : 'pointer',
              }}
            >
              {reenviando
                ? <><Loader2 size={16} className="animate-spin" /> Enviando…</>
                : cooldown > 0
                  ? <><RefreshCw size={16} /> Reenviar en {cooldown}s</>
                  : <><RefreshCw size={16} /> Reenviar correo</>}
            </button>

            <button
              type="button"
              onClick={handleSalir}
              data-testid="verify-email-salir"
              style={S.ghost}
            >
              <LogOut size={15} /> {isAuthenticated ? 'Cerrar sesión / usar otra cuenta' : 'Usar otra cuenta'}
            </button>
          </div>

          <p style={S.hint}>
            <AlertTriangle size={13} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
            Si no lo ves, revisá la carpeta de spam o correo no deseado.
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Estilos ──────────────────────────────────────────────────────────────────
// Mismos tokens de tema que Login: la pantalla acompaña light y dark sin ramas.

const S = {
  page: {
    minHeight: '100dvh',
    background: 'var(--auth-bg)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1.5rem',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  } as const,

  shell: { width: '100%', maxWidth: '420px' } as const,

  card: {
    background: 'var(--auth-card-bg)',
    backdropFilter: 'blur(24px)',
    WebkitBackdropFilter: 'blur(24px)',
    border: '1px solid var(--border-color)',
    borderRadius: '1.5rem',
    padding: 'clamp(1.75rem, 5vw, 2.5rem)',
    boxShadow: 'var(--shadow-xl)',
    textAlign: 'center',
  } as const,

  iconWrap: {
    width: '64px',
    height: '64px',
    borderRadius: '1.125rem',
    background: 'rgba(99,102,241,0.12)',
    border: '1px solid rgba(99,102,241,0.25)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 1.25rem',
  } as const,

  title: {
    margin: '0 0 0.625rem',
    fontSize: '1.35rem',
    fontWeight: 800,
    letterSpacing: '-0.02em',
    color: 'var(--text-primary)',
  } as const,

  message: {
    margin: '0 0 0.5rem',
    fontSize: '0.9rem',
    lineHeight: 1.6,
  } as const,

  email: {
    margin: '0 0 1.5rem',
    fontSize: '0.85rem',
    fontWeight: 600,
    color: 'var(--text-primary)',
    wordBreak: 'break-all',
  } as const,

  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
  } as const,

  primary: {
    width: '100%',
    padding: '0.875rem',
    background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
    border: 'none',
    borderRadius: '0.875rem',
    color: '#fff',
    fontWeight: 700,
    fontSize: '0.9rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    boxShadow: '0 4px 16px rgba(99,102,241,0.35)',
  } as const,

  secondary: {
    width: '100%',
    padding: '0.8rem',
    background: 'transparent',
    border: '1px solid var(--border-color)',
    borderRadius: '0.875rem',
    color: 'var(--text-secondary)',
    fontWeight: 600,
    fontSize: '0.875rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
  } as const,

  ghost: {
    width: '100%',
    padding: '0.6rem',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    fontWeight: 600,
    fontSize: '0.8rem',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.4rem',
  } as const,

  hint: {
    margin: '1.25rem 0 0',
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    lineHeight: 1.5,
  } as const,
}
