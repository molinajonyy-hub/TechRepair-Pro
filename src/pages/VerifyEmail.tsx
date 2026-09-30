import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Mail, RefreshCw, CheckCircle2, AlertTriangle, LogOut } from 'lucide-react'
import {
  useAuth,
  readPendingConfirmationEmail,
  clearPendingConfirmationEmail,
} from '../contexts/AuthContext'
import { CONTACTO_SOPORTE } from '../config/contacto'
import {
  AuthFlowShell, AuthFlowLoading, AuthFlowActions, AuthFlowNote,
  AuthFlowPrimaryButton, AuthFlowSecondaryButton, AuthFlowTextButton,
} from '../components/auth/AuthFlowShell'

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL VERIFICATION P0 — pantalla de correo pendiente.
//
// Es la ÚNICA superficie de producto accesible con sesión y sin confirmar.
// Todo lo demás está detrás del guard central (ver ProtectedRoute).
//
// Los estados son un enum cerrado y los textos salen de un mapa: nunca se
// muestra un mensaje crudo de Supabase ni de Postgres.
//
// PRE-BETA-3A-1a — sólo cambió la capa visual (AuthFlowShell). Estados,
// reenvío, cooldown, salida y navegación son los mismos.
// ─────────────────────────────────────────────────────────────────────────────

type Estado =
  | 'SIGNUP_SUBMITTED_UNCONFIRMED'
  | 'RESEND_SUCCESS'
  | 'RESEND_RATE_LIMITED'
  | 'CONFIRMED'
  | 'LINK_EXPIRED_OR_INVALID'
  | 'ALREADY_CONFIRMED'
  | 'RESEND_FAILED'
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
  // PRE-BETA-2D — el reenvío fallido ya no se presenta como «no pudimos
  // verificar tu cuenta»: lo que falló es el envío (típicamente el SMTP).
  RESEND_FAILED: {
    tono: 'warn',
    texto: 'No pudimos reenviar el correo. Probá de nuevo en unos minutos.',
  },
  AUTH_ERROR: {
    tono: 'warn',
    texto: 'No pudimos verificar el estado de tu cuenta. Probá de nuevo en un momento.',
  },
}

/** Estados en los que conviene dejar visible el contacto de soporte. */
const MUESTRA_SOPORTE: ReadonlySet<Estado> = new Set(['RESEND_FAILED', 'AUTH_ERROR'])

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
        setEstado('RESEND_FAILED')
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
    return <AuthFlowLoading />
  }

  const mensaje = MENSAJE[estado]
  const botonReenvioDeshabilitado = reenviando || cooldown > 0 || !emailObjetivo

  return (
    <AuthFlowShell
      testId="verify-email-page"
      align="center"
      icon={<Mail size={26} />}
      title="Confirmá tu correo"
    >
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

      <AuthFlowActions layout="stack">
        <AuthFlowPrimaryButton
          onClick={handleYaConfirme}
          loading={verificando}
          data-testid="verify-email-ya-confirme"
          leftIcon={<CheckCircle2 size={16} />}
        >
          {verificando
            ? 'Verificando…'
            : isAuthenticated
              ? 'Ya confirmé, continuar'
              : 'Ya confirmé, iniciar sesión'}
        </AuthFlowPrimaryButton>

        <AuthFlowSecondaryButton
          onClick={handleReenviar}
          disabled={botonReenvioDeshabilitado}
          loading={reenviando}
          data-testid="verify-email-reenviar"
          leftIcon={<RefreshCw size={16} />}
        >
          {reenviando
            ? 'Enviando…'
            : cooldown > 0
              ? `Reenviar en ${cooldown}s`
              : 'Reenviar correo'}
        </AuthFlowSecondaryButton>

        <AuthFlowTextButton
          onClick={handleSalir}
          data-testid="verify-email-salir"
          leftIcon={<LogOut size={15} />}
        >
          {isAuthenticated ? 'Cerrar sesión / usar otra cuenta' : 'Usar otra cuenta'}
        </AuthFlowTextButton>
      </AuthFlowActions>

      <AuthFlowNote>
        <AlertTriangle size={13} aria-hidden="true" />
        Si no lo ves, revisá la carpeta de spam o correo no deseado.
      </AuthFlowNote>

      {MUESTRA_SOPORTE.has(estado) && (
        <AuthFlowNote testId="verify-email-soporte">
          Si sigue sin llegar, escribinos a{' '}
          <a href={`mailto:${CONTACTO_SOPORTE}`}>{CONTACTO_SOPORTE}</a>.
        </AuthFlowNote>
      )}
    </AuthFlowShell>
  )
}

// ── Estilos ──────────────────────────────────────────────────────────────────
// Sólo lo propio de esta pantalla: el marco, la tarjeta y los botones son los
// de AuthFlowShell. Tokens de tema: acompaña light y dark sin ramas.

const S = {
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
}
