import { useEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, CheckCircle2, Lock } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { PORTAL_DOMAINS } from '../portal/portalDomains'
import {
  PASSWORD_MATCH_MESSAGE,
  PASSWORD_PLACEHOLDER,
  PASSWORD_REQUIREMENT,
  checkPasswordPolicy,
  validateTypedPasswordPair,
} from '../lib/passwordPolicy'
import { canalSoporte } from '../config/contacto'
import { SupportContactLink } from '../components/ui/SupportContactButton'
import {
  classifyPasswordUpdateError,
  finishRecovery,
  getRecoveryPhase,
  hasRecoverySession,
  subscribeRecoveryPhase,
  validateNewPassword,
  type PasswordFieldErrors,
} from '../lib/passwordRecovery'
import {
  AuthFlowShell, AuthFlowLoading, AuthFlowActions, AuthFlowNote,
  AuthFlowPrimaryButton, AuthFlowTextButton,
} from '../components/auth/AuthFlowShell'
import {
  AuthFlowAlert, AuthFlowPasswordField, AuthFlowRequirement, focusLeftField,
} from '../components/auth/AuthFlowFields'

// ─────────────────────────────────────────────────────────────────────────────
// BETA-GATE-1 · Lote B — «Nueva contraseña».
//
// El formulario aparece SÓLO con una sesión vigente marcada como de recovery
// para ese mismo usuario (ver src/lib/passwordRecovery.ts). Una sesión normal,
// un enlace vencido o usado, o no tener sesión muestran «enlace no válido» con
// la salida para pedir otro. Nunca se redirige al Dashboard sin pasar por acá.
//
// BETA-UX-1G — sólo cambió la capa visual: marco, tarjeta, campos y botones son
// los del embudo (AuthFlowShell / AuthFlowFields). Los estados, la condición
// para mostrar el formulario, el guardado y los `data-testid` son los mismos.
// Se sumó el aviso de lo ya escrito al salir de un campo.
// ─────────────────────────────────────────────────────────────────────────────

type Vista =
  | { tipo: 'verificando' }
  | { tipo: 'formulario'; userId: string }
  | { tipo: 'invalido'; motivo: 'vencido' | 'invalido' | 'sin_sesion' }
  | { tipo: 'listo'; destino: string }

/** Si crear la sesión con los tokens del enlace tarda más que esto, se asume inválido. */
const VERIFYING_TIMEOUT_MS = 20_000
const REDIRECT_DELAY_MS = 3_000

const TEXTO_INVALIDO: Record<'vencido' | 'invalido' | 'sin_sesion', { titulo: string; detalle: string }> = {
  vencido: {
    titulo: 'El enlace ya no es válido',
    detalle: 'Venció o ya se usó. Cada enlace para restablecer la contraseña sirve una sola vez. Pedí uno nuevo y abrilo desde el último correo.',
  },
  invalido: {
    titulo: 'No pudimos validar el enlace',
    detalle: 'El enlace está incompleto o tu sesión venció antes de terminar. Pedí uno nuevo para restablecer la contraseña.',
  },
  sin_sesion: {
    titulo: 'Abrí el enlace desde tu correo',
    detalle: 'Para elegir una nueva contraseña tenés que entrar desde el enlace que te enviamos. Si no lo encontrás o venció, pedí uno nuevo.',
  },
}

function destinoTrasGuardar(conSesion: boolean): string {
  if (!conSesion) return '/login'
  // En el dominio del portal todo cuelga de la raíz (ver AuthCallback).
  return PORTAL_DOMAINS[window.location.hostname] ? '/' : '/dashboard'
}

export function ResetPassword() {
  const navigate = useNavigate()
  const phase = useSyncExternalStore(subscribeRecoveryPhase, getRecoveryPhase)

  const [vista, setVista] = useState<Vista>({ tipo: 'verificando' })
  const [authTick, setAuthTick] = useState(0)
  const [timedOut, setTimedOut] = useState(false)

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [fieldErrors, setFieldErrors] = useState<PasswordFieldErrors>({})
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const savingRef = useRef(false)
  const completedRef = useRef(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)

  // Cualquier cambio de sesión (SIGNED_OUT, PASSWORD_RECOVERY, SIGNED_IN) vuelve a evaluar.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => setAuthTick(t => t + 1))
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (phase !== 'verifying') return
    const t = setTimeout(() => setTimedOut(true), VERIFYING_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [phase])

  useEffect(() => {
    if (completedRef.current) return
    if (phase === 'expired_link') { setVista({ tipo: 'invalido', motivo: 'vencido' }); return }
    if (phase === 'invalid_link') { setVista({ tipo: 'invalido', motivo: 'invalido' }); return }
    if (phase === 'verifying' && !timedOut) { setVista({ tipo: 'verificando' }); return }

    let cancelado = false
    void supabase.auth.getSession()
      .then(({ data }) => {
        if (cancelado || completedRef.current) return
        const userId = data.session?.user?.id
        if (userId && hasRecoverySession(userId)) {
          setVista(v => (v.tipo === 'formulario' && v.userId === userId ? v : { tipo: 'formulario', userId }))
        } else {
          setVista({ tipo: 'invalido', motivo: phase === 'verifying' ? 'invalido' : 'sin_sesion' })
        }
      })
      .catch(() => {
        if (!cancelado && !completedRef.current) setVista({ tipo: 'invalido', motivo: 'invalido' })
      })
    return () => { cancelado = true }
  }, [phase, authTick, timedOut])

  const enFormulario = vista.tipo === 'formulario'
  useEffect(() => {
    if (enFormulario) passwordRef.current?.focus()
  }, [enFormulario])

  useEffect(() => {
    if (vista.tipo !== 'listo') return
    const t = setTimeout(() => navigate(vista.destino, { replace: true }), REDIRECT_DELAY_MS)
    return () => clearTimeout(t)
  }, [vista, navigate])

  // Mientras se completa: se avisa de lo YA escrito al salir del campo. Pasar al
  // botón de mostrar la contraseña no cuenta como salir.
  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    if (!focusLeftField(e)) return
    const fallas = validateTypedPasswordPair(password, confirm)
    if (fallas.password || fallas.confirm) setFieldErrors(f => ({ ...f, ...fallas }))
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (vista.tipo !== 'formulario' || savingRef.current) return

    const errores = validateNewPassword(password, confirm)
    setFieldErrors(errores)
    setFormError('')
    if (errores.password) { passwordRef.current?.focus(); return }
    if (errores.confirm) { confirmRef.current?.focus(); return }

    savingRef.current = true
    setSaving(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) {
        const fallo = classifyPasswordUpdateError(error)
        if (fallo.kind === 'session') {
          setVista({ tipo: 'invalido', motivo: 'invalido' })
        } else if (fallo.kind === 'field') {
          setFieldErrors({ password: fallo.message })
          passwordRef.current?.focus()
        } else {
          setFormError(fallo.message)
        }
        return
      }

      const { data } = await supabase.auth.getSession()
      completedRef.current = true
      setPassword('')
      setConfirm('')
      setVista({ tipo: 'listo', destino: destinoTrasGuardar(Boolean(data.session)) })
      finishRecovery()
    } catch {
      setFormError('No pudimos guardar la contraseña. Revisá tu conexión e intentá de nuevo.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const estado = vista.tipo === 'invalido' ? `invalido:${vista.motivo}` : vista.tipo

  if (vista.tipo === 'verificando') {
    return (
      <AuthFlowLoading
        pageTestId="reset-password-page"
        estado={estado}
        testId="reset-password-checking"
        label="Verificando el enlace…"
      />
    )
  }

  if (vista.tipo === 'invalido') {
    // BETA-UX-1A — canal canónico (WhatsApp), no la casilla institucional.
    const soporte = canalSoporte('recuperarContrasena')
    return (
      <AuthFlowShell
        testId="reset-password-page"
        estado={estado}
        cardTestId="reset-password-invalid"
        contentKey={estado}
        align="center"
        tone="warning"
        icon={<AlertTriangle size={26} />}
        title={TEXTO_INVALIDO[vista.motivo].titulo}
        description={TEXTO_INVALIDO[vista.motivo].detalle}
      >
        <AuthFlowActions layout="stack">
          <AuthFlowPrimaryButton
            data-testid="reset-password-request-new"
            onClick={() => navigate('/login?modo=recuperar', { replace: true })}
          >
            Pedir un enlace nuevo
          </AuthFlowPrimaryButton>
          <AuthFlowTextButton
            data-testid="reset-password-back-login"
            onClick={() => navigate('/login', { replace: true })}
            leftIcon={<ArrowLeft aria-hidden="true" />}
          >
            Volver al inicio de sesión
          </AuthFlowTextButton>
        </AuthFlowActions>
        {soporte.tipo === 'whatsapp' && (
          <AuthFlowNote testId="reset-password-soporte">
            ¿No te llega el correo?{' '}
            <SupportContactLink canal={soporte}>Escribinos por WhatsApp</SupportContactLink>.
          </AuthFlowNote>
        )}
      </AuthFlowShell>
    )
  }

  if (vista.tipo === 'listo') {
    const aLogin = vista.destino === '/login'
    return (
      <AuthFlowShell
        testId="reset-password-page"
        estado={estado}
        cardTestId="reset-password-done"
        contentKey={estado}
        align="center"
        tone="success"
        icon={<CheckCircle2 size={26} />}
        title="Contraseña actualizada"
        description={aLogin
          ? 'Ya podés iniciar sesión con tu nueva contraseña.'
          : 'Listo. Te llevamos a tu cuenta en unos segundos.'}
      >
        <AuthFlowPrimaryButton
          data-testid="reset-password-continue"
          onClick={() => navigate(vista.destino, { replace: true })}
        >
          {aLogin ? 'Ir a iniciar sesión' : 'Continuar'}
        </AuthFlowPrimaryButton>
      </AuthFlowShell>
    )
  }

  return (
    <AuthFlowShell
      testId="reset-password-page"
      estado={estado}
      contentKey={estado}
      icon={<Lock size={24} />}
      title="Nueva contraseña"
      description="Elegí una contraseña nueva para tu cuenta."
    >
      <form onSubmit={handleSubmit} noValidate className="auth-flow__form">
        {formError && <AuthFlowAlert tone="error" testId="reset-password-error">{formError}</AuthFlowAlert>}

        <AuthFlowPasswordField
          id="reset-password-new"
          data-testid="reset-password-new"
          errorTestId="reset-password-new-error"
          toggleTestId="reset-password-toggle-new"
          ref={passwordRef}
          label="Nueva contraseña"
          icon={<Lock />}
          autoComplete="new-password"
          placeholder={PASSWORD_PLACEHOLDER}
          value={password}
          disabled={saving}
          error={fieldErrors.password}
          hint={password
            ? <AuthFlowRequirement met={checkPasswordPolicy(password) === null}>{PASSWORD_REQUIREMENT}</AuthFlowRequirement>
            : undefined}
          onChange={e => { setPassword(e.target.value); setFieldErrors(f => ({ ...f, password: undefined })); setFormError('') }}
          onBlur={handleBlur}
        />

        <AuthFlowPasswordField
          id="reset-password-confirm"
          data-testid="reset-password-confirm"
          errorTestId="reset-password-confirm-error"
          toggleTestId="reset-password-toggle-confirm"
          ref={confirmRef}
          label="Confirmar contraseña"
          icon={<Lock />}
          autoComplete="new-password"
          placeholder="Repetí la contraseña"
          value={confirm}
          disabled={saving}
          error={fieldErrors.confirm}
          hint={confirm && confirm === password
            ? <AuthFlowRequirement met>{PASSWORD_MATCH_MESSAGE}</AuthFlowRequirement>
            : undefined}
          onChange={e => { setConfirm(e.target.value); setFieldErrors(f => ({ ...f, confirm: undefined })); setFormError('') }}
          onBlur={handleBlur}
        />

        <AuthFlowPrimaryButton type="submit" data-testid="reset-password-submit" loading={saving}>
          {saving ? 'Guardando…' : 'Guardar nueva contraseña'}
        </AuthFlowPrimaryButton>
      </form>
    </AuthFlowShell>
  )
}
