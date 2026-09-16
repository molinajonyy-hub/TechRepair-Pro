import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, CheckCircle, Eye, EyeOff, Loader2, Lock } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { S, blurOn, focusOn } from '../components/auth/authCardStyles'
import { colors } from '../lib/tokens'
import { PORTAL_DOMAINS } from '../portal/portalDomains'
import {
  PASSWORD_MIN_LENGTH,
  classifyPasswordUpdateError,
  finishRecovery,
  getRecoveryPhase,
  hasRecoverySession,
  subscribeRecoveryPhase,
  validateNewPassword,
  type PasswordFieldErrors,
} from '../lib/passwordRecovery'

// ─────────────────────────────────────────────────────────────────────────────
// BETA-GATE-1 · Lote B — «Nueva contraseña».
//
// El formulario aparece SÓLO con una sesión vigente marcada como de recovery
// para ese mismo usuario (ver src/lib/passwordRecovery.ts). Una sesión normal,
// un enlace vencido o usado, o no tener sesión muestran «enlace no válido» con
// la salida para pedir otro. Nunca se redirige al Dashboard sin pasar por acá.
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
  const [showPwd, setShowPwd] = useState(false)
  const [showCfm, setShowCfm] = useState(false)
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

  const handleSubmit = async (e: React.FormEvent) => {
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

  return (
    <div style={S.page} data-testid="reset-password-page" data-estado={estado}>
      <div style={S.blob1} />
      <div style={S.blob2} />
      <div style={S.blob3} />

      <div style={S.shell}>
        <div style={S.card}>
          <div style={S.cardTopGlow} />

          {vista.tipo === 'verificando' && (
            <div style={{ textAlign: 'center', padding: '1.5rem 0' }} role="status" data-testid="reset-password-checking">
              <Loader2 size={36} style={{ color: colors.indigo, animation: 'tr-spin 1s linear infinite', margin: '0 auto 1rem' }} />
              <p style={{ color: colors.text.secondary, fontSize: '0.9375rem', margin: 0 }}>
                Verificando el enlace…
              </p>
            </div>
          )}

          {vista.tipo === 'invalido' && (
            <div data-testid="reset-password-invalid" style={{ textAlign: 'center' }}>
              <div style={badge(colors.warningBg, colors.warningBorder)}>
                <AlertTriangle size={26} style={{ color: colors.warning }} />
              </div>
              <h1 style={titulo}>{TEXTO_INVALIDO[vista.motivo].titulo}</h1>
              <p style={{ ...subtitulo, marginBottom: '1.75rem' }}>{TEXTO_INVALIDO[vista.motivo].detalle}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <button
                  type="button"
                  data-testid="reset-password-request-new"
                  style={S.btnPrimary(false)}
                  onClick={() => navigate('/login?modo=recuperar', { replace: true })}
                >
                  Pedir un enlace nuevo
                </button>
                <button
                  type="button"
                  data-testid="reset-password-back-login"
                  style={linkButton}
                  onClick={() => navigate('/login', { replace: true })}
                >
                  <ArrowLeft size={14} /> Volver al inicio de sesión
                </button>
              </div>
            </div>
          )}

          {vista.tipo === 'listo' && (
            <div data-testid="reset-password-done" style={{ textAlign: 'center' }} role="status">
              <div style={badge(colors.successBg, colors.successBorder)}>
                <CheckCircle size={26} style={{ color: colors.success }} />
              </div>
              <h1 style={titulo}>Contraseña actualizada</h1>
              <p style={{ ...subtitulo, marginBottom: '1.75rem' }}>
                {vista.destino === '/login'
                  ? 'Ya podés iniciar sesión con tu nueva contraseña.'
                  : 'Listo. Te llevamos a tu cuenta en unos segundos.'}
              </p>
              <button
                type="button"
                data-testid="reset-password-continue"
                style={S.btnPrimary(false)}
                onClick={() => navigate(vista.destino, { replace: true })}
              >
                {vista.destino === '/login' ? 'Ir a iniciar sesión' : 'Continuar'}
              </button>
            </div>
          )}

          {vista.tipo === 'formulario' && (
            <>
              <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
                <div style={badge(colors.indigoBg, colors.indigoBorder)}>
                  <Lock size={24} style={{ color: colors.indigo }} />
                </div>
                <h1 style={titulo}>Nueva contraseña</h1>
                <p style={subtitulo}>Elegí una contraseña nueva para tu cuenta.</p>
              </div>

              {formError && (
                <div role="alert" data-testid="reset-password-error" style={alerta}>
                  {formError}
                </div>
              )}

              <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1.125rem' }}>
                <div>
                  <label htmlFor="reset-password-new" style={S.label}>Nueva contraseña</label>
                  <div style={{ position: 'relative' }}>
                    <Lock size={17} style={{ ...S.iconLeft, color: fieldErrors.password ? colors.error : colors.text.muted }} />
                    <input
                      id="reset-password-new"
                      data-testid="reset-password-new"
                      ref={passwordRef}
                      type={showPwd ? 'text' : 'password'}
                      value={password}
                      placeholder={`Mínimo ${PASSWORD_MIN_LENGTH} caracteres`}
                      autoComplete="new-password"
                      disabled={saving}
                      aria-invalid={Boolean(fieldErrors.password)}
                      aria-describedby={fieldErrors.password ? 'reset-password-new-error' : undefined}
                      style={S.inputWithRight(Boolean(fieldErrors.password), saving)}
                      onChange={e => { setPassword(e.target.value); setFieldErrors(f => ({ ...f, password: undefined })); setFormError('') }}
                      onFocus={e => focusOn(e, Boolean(fieldErrors.password))}
                      onBlur={e => blurOn(e, Boolean(fieldErrors.password))}
                    />
                    <button
                      type="button"
                      data-testid="reset-password-toggle-new"
                      onClick={() => setShowPwd(v => !v)}
                      disabled={saving}
                      aria-label={showPwd ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      aria-pressed={showPwd}
                      style={toggle}
                    >
                      {showPwd ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                  {fieldErrors.password && (
                    <p id="reset-password-new-error" data-testid="reset-password-new-error" style={S.errorText}>{fieldErrors.password}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="reset-password-confirm" style={S.label}>Confirmar contraseña</label>
                  <div style={{ position: 'relative' }}>
                    <Lock size={17} style={{ ...S.iconLeft, color: fieldErrors.confirm ? colors.error : colors.text.muted }} />
                    <input
                      id="reset-password-confirm"
                      data-testid="reset-password-confirm"
                      ref={confirmRef}
                      type={showCfm ? 'text' : 'password'}
                      value={confirm}
                      placeholder="Repetí la contraseña"
                      autoComplete="new-password"
                      disabled={saving}
                      aria-invalid={Boolean(fieldErrors.confirm)}
                      aria-describedby={fieldErrors.confirm ? 'reset-password-confirm-error' : undefined}
                      style={S.inputWithRight(Boolean(fieldErrors.confirm), saving)}
                      onChange={e => { setConfirm(e.target.value); setFieldErrors(f => ({ ...f, confirm: undefined })); setFormError('') }}
                      onFocus={e => focusOn(e, Boolean(fieldErrors.confirm))}
                      onBlur={e => blurOn(e, Boolean(fieldErrors.confirm))}
                    />
                    <button
                      type="button"
                      data-testid="reset-password-toggle-confirm"
                      onClick={() => setShowCfm(v => !v)}
                      disabled={saving}
                      aria-label={showCfm ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                      aria-pressed={showCfm}
                      style={toggle}
                    >
                      {showCfm ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                  {fieldErrors.confirm && (
                    <p id="reset-password-confirm-error" data-testid="reset-password-confirm-error" style={S.errorText}>{fieldErrors.confirm}</p>
                  )}
                </div>

                <button type="submit" data-testid="reset-password-submit" disabled={saving} style={S.btnPrimary(saving)}>
                  {saving
                    ? <><Loader2 size={18} style={{ animation: 'tr-spin 1s linear infinite' }} /> Guardando…</>
                    : 'Guardar nueva contraseña'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Estilos locales (sobre las variables del tema) ────────────────────────────

function badge(background: string, border: string): React.CSSProperties {
  return {
    width: '56px', height: '56px', borderRadius: '1rem',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    margin: '0 auto 1rem', background, border: `1px solid ${border}`,
  }
}

const titulo: React.CSSProperties = {
  fontSize: '1.375rem', fontWeight: 800, letterSpacing: '-0.03em',
  color: colors.text.primary, margin: '0 0 0.375rem',
}

const subtitulo: React.CSSProperties = {
  color: colors.text.secondary, fontSize: '0.875rem', lineHeight: 1.55, margin: 0,
}

const alerta: React.CSSProperties = {
  padding: '0.875rem 1rem', borderRadius: '0.75rem', marginBottom: '1.25rem',
  background: colors.errorBg, border: `1px solid ${colors.errorBorder}`,
  color: colors.error, fontSize: '0.875rem',
}

const toggle: React.CSSProperties = {
  position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)',
  width: '44px', height: '44px',
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: colors.text.muted, display: 'flex', alignItems: 'center', justifyContent: 'center',
}

const linkButton: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem',
  minHeight: '44px', background: 'none', border: 'none', cursor: 'pointer',
  color: colors.text.secondary, fontSize: '0.875rem', fontWeight: 500,
}
