/**
 * Onboarding.tsx — CONFIGURACIÓN del negocio.
 *
 * P0-P5. El wizard NO crea tenants: cuando esta pantalla se monta el negocio ya
 * existe (lo creó `provision_my_business()` desde /no-business o desde el alta).
 * Acá sólo se configura, y toda la persistencia va por `businessSetupService`.
 *
 * ── QUÉ SE ARREGLÓ ───────────────────────────────────────────────────────────
 * La versión anterior hacía seis `supabase.from('businesses').update(...)`
 * sueltos. TODOS fallaban:
 *   · 42501 — `authenticated` no tiene GRANT de UPDATE sobre `businesses`;
 *   · 42703 — `condicion_fiscal`, `cuit` y `payment_methods_enabled` ni
 *     siquiera existen en esa tabla (los fiscales viven en business_settings).
 *
 * Y no se veía porque `supabase.from().update()` NO LANZA: devuelve
 * `{ data, error }`. El código hacía `await ...update(...)` sin mirar `error`,
 * así que el try/catch no atrapaba nada y el paso avanzaba igual.
 * MEDIDO: de 26 negocios productivos, 1 tenía rubro y 2 tenían logo.
 *
 * Ahora cada paso espera el resultado, corta si falla y precarga desde la DB.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { uploadBusinessLogo, LogoUploadError } from '../lib/storageSetup'
import { track } from '../lib/analytics'
import { logger } from '../lib/logger'
import {
  businessSetupService, BusinessSetupError, type BusinessSetup,
} from '../services/businessSetupService'
import { PLANS, type SubscriptionPlan } from '../types/subscription'

// Plan elegido en la landing (?plan=...). Persistido temporalmente para
// sobrevivir un refresh durante el onboarding. Se valida contra PLANS.
const ORIGIN_PLAN_KEY = 'trp_origin_plan'
function isValidPlan(v: string | null): v is SubscriptionPlan {
  return !!v && PLANS.some(p => p.id === v)
}

const RUBROS = [
  { id: 'celulares',        label: 'Celulares y smartphones' },
  { id: 'computadoras',     label: 'Computadoras y laptops' },
  { id: 'electrodomesticos',label: 'Electrónica y electrodomésticos' },
  { id: 'tecnico_general',  label: 'Técnico general' },
  { id: 'redes',            label: 'Redes y telecomunicaciones' },
  { id: 'otro',             label: 'Otro rubro' },
]

const CONDICIONES_FISCALES = [
  { id: 'monotributo',           label: 'Monotributo' },
  { id: 'responsable_inscripto', label: 'Responsable Inscripto' },
  { id: 'exento',                label: 'Exento' },
  { id: 'consumidor_final',      label: 'Consumidor Final interno' },
]

const CHECKLIST_INITIAL = [
  'Crear tu primera orden de reparación',
  'Agregar productos al inventario',
  'Registrar tu primer cliente',
  'Hacer tu primer cobro',
  'Configurar métodos de pago',
]

const TRIAL_FEATURES_LIST = [
  'Facturación ARCA / CAE',
  'Finanzas avanzadas',
  'Cuentas corrientes',
  'Reportes y exportaciones',
  'WhatsApp templates',
  'Mi Guita — Finanzas Personales',
  'Garantías y postventa',
]

const TOTAL_STEPS = 6

const OB_INPUT_STYLE: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '12px 15px', fontSize: '0.95rem',
  background: 'var(--input-bg)', border: '1.5px solid var(--input-border)',
  borderRadius: 12, color: 'var(--text-primary)',
}

const OB_BTN_PRIMARY_STYLE: React.CSSProperties = {
  width: '100%', padding: '14px',
  background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
  border: 'none', borderRadius: 12,
  color: '#fff', fontWeight: 700, fontSize: '0.95rem',
  cursor: 'pointer',
  boxShadow: '0 4px 16px rgba(99,102,241,0.3)',
}

export function Onboarding() {
  const { authState, refreshProfile } = useAuth()
  const navigate = useNavigate()

  const [originPlan, setOriginPlan] = useState<SubscriptionPlan | null>(null)
  const signupCompletedRef = useRef(false)

  // ── Estado del wizard ──────────────────────────────────────────────────────
  const [cargando, setCargando]                 = useState(true)
  const [setup, setSetup]                       = useState<BusinessSetup | null>(null)
  const [step, setStep]                         = useState(1)
  const [businessName, setBusinessName]         = useState('')
  const [rubro, setRubro]                       = useState('')
  const [logoFile, setLogoFile]                 = useState<File | null>(null)
  const [logoPreview, setLogoPreview]           = useState<string | null>(null)
  const [whatsapp, setWhatsapp]                 = useState('')
  const [ciudad, setCiudad]                     = useState('')
  const [condicionFiscal, setCondicionFiscal]   = useState('')
  const [cuit, setCuit]                         = useState('')
  const [saving, setSaving]                     = useState(false)
  const [error, setError]                       = useState('')

  // ── Guard de routing ───────────────────────────────────────────────────────
  // Se decide SÓLO por `authState`: mientras esté en un estado de espera no se
  // redirige. Es lo que evita el rebote prematuro que tenía la versión anterior.
  useEffect(() => {
    if (authState === 'AUTH_LOADING' || authState === 'AUTHENTICATED_PROFILE_LOADING') return
    if (authState === 'UNAUTHENTICATED') { navigate('/login', { replace: true }); return }
    if (authState === 'EMAIL_UNCONFIRMED') { navigate('/verificar-email', { replace: true }); return }
    // Sin negocio NO se puede configurar nada: el alta del tenant es una acción
    // explícita del usuario y vive en /no-business.
    if (authState === 'AUTHENTICATED_WITHOUT_BUSINESS' || authState === 'AUTH_ERROR') {
      navigate('/no-business', { replace: true })
    }
  }, [authState, navigate])

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('plan')
    const stored = (() => { try { return sessionStorage.getItem(ORIGIN_PLAN_KEY) } catch { return null } })()
    const candidate = fromUrl ?? stored
    if (isValidPlan(candidate)) {
      setOriginPlan(candidate)
      try { sessionStorage.setItem(ORIGIN_PLAN_KEY, candidate) } catch { /* no-op */ }
    }
  }, [])

  // ── PRECARGA / REANUDACIÓN ─────────────────────────────────────────────────
  // Los datos salen de la DB, no del estado de React: cerrar la pestaña en el
  // paso 3 y volver ya no pierde lo guardado.
  useEffect(() => {
    if (authState !== 'AUTHENTICATED_WITH_BUSINESS') return
    let vivo = true

    ;(async () => {
      try {
        const actual = await businessSetupService.getMyBusinessSetup()
        if (!vivo) return

        setSetup(actual)
        // `Mi Negocio` es el nombre por defecto de `provision_my_business`: se
        // trata como «todavía sin elegir» para que el usuario no tenga que
        // borrarlo a mano.
        setBusinessName(actual.name === 'Mi Negocio' ? '' : actual.name)
        setRubro(actual.rubro ?? '')
        setCiudad(actual.ciudad ?? '')
        setWhatsapp(actual.whatsapp ?? '')
        setCuit(actual.cuit ?? '')
        setCondicionFiscal(actual.condicionFiscal ?? '')
        setLogoPreview(actual.logoUrl)

        // Se retoma en el PRIMER paso que todavía tiene algo pendiente, en vez
        // de volver siempre al principio. Los campos ya guardados llegan
        // precargados, así que avanzar es sólo confirmar.
        if (!actual.name || actual.name === 'Mi Negocio' || !actual.rubro) setStep(1)
        else if (!actual.logoUrl) setStep(2)
        else if (!actual.ciudad || !actual.whatsapp) setStep(3)
        else if (!actual.cuit || !actual.condicionFiscal) setStep(4)
        else setStep(5)
      } catch (e) {
        if (!vivo) return
        logger.error('AUTH', 'Onboarding: no se pudo precargar la configuración', e)
        setError(e instanceof BusinessSetupError ? e.message : 'No se pudo cargar la configuración de tu negocio.')
      } finally {
        if (vivo) setCargando(false)
      }
    })()

    return () => { vivo = false }
  }, [authState])

  /**
   * Guarda un tramo y sólo avanza si el servidor confirmó.
   *
   * Es el corazón del arreglo: antes cada paso avanzaba pasara lo que pasara.
   */
  const guardarYAvanzar = useCallback(async (
    patch: Parameters<typeof businessSetupService.updateMyBusinessSetup>[0],
    siguiente: number,
  ): Promise<void> => {
    setSaving(true); setError('')
    try {
      const actualizado = await businessSetupService.updateMyBusinessSetup(patch)
      setSetup(actualizado)
      setStep(siguiente)
    } catch (e) {
      if (!(e instanceof BusinessSetupError)) {
        logger.error('AUTH', 'Onboarding: fallo inesperado al guardar', e)
      }
      setError(e instanceof BusinessSetupError ? e.message : 'No se pudo guardar. Intentá nuevamente.')
      // NO se avanza: el dato obligatorio no quedó persistido.
    } finally {
      setSaving(false)
    }
  }, [])

  // ── Paso 1: identidad del negocio (obligatorio) ────────────────────────────
  const handleStep1 = () => {
    if (!businessName.trim()) { setError('El nombre del negocio es obligatorio'); return }
    if (!rubro)               { setError('Seleccioná el rubro de tu negocio'); return }
    void guardarYAvanzar({ name: businessName.trim(), rubro }, 2)
  }

  // ── Paso 2: logo (opcional) ────────────────────────────────────────────────
  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLogoFile(file)
    setLogoPreview(URL.createObjectURL(file))
    setError('')
  }

  const handleStep2 = async () => {
    if (!logoFile) { setStep(3); return }

    setSaving(true); setError('')
    try {
      const url = await uploadBusinessLogo(logoFile, setup!.businessId)
      const actualizado = await businessSetupService.updateMyBusinessSetup({ logoUrl: url })
      setSetup(actualizado)
      setLogoPreview(actualizado.logoUrl)
      setLogoFile(null)
      setStep(3)
    } catch (e) {
      // El logo es OPCIONAL: su fallo se muestra pero no bloquea el wizard, y el
      // usuario puede omitirlo. Lo que ya NO pasa es que falle en silencio.
      const msg = e instanceof LogoUploadError || e instanceof BusinessSetupError
        ? e.message
        : 'No se pudo subir el logo.'
      setError(`${msg} Podés omitir este paso y cargarlo después desde Configuración.`)
      if (!(e instanceof LogoUploadError) && !(e instanceof BusinessSetupError)) {
        logger.error('AUTH', 'Onboarding: fallo inesperado subiendo el logo', e)
      }
    } finally {
      setSaving(false)
    }
  }

  // ── Paso 3: contacto (opcional) ────────────────────────────────────────────
  const handleStep3 = () => {
    void guardarYAvanzar({ whatsapp: whatsapp.trim(), ciudad: ciudad.trim() }, 4)
  }

  // ── Paso 4: fiscal (opcional) ──────────────────────────────────────────────
  const handleStep4 = () => {
    void guardarYAvanzar({ cuit: cuit.trim(), condicionFiscal: condicionFiscal || '' }, 5)
  }

  // ── Paso 5: plan / trial (informativo) ─────────────────────────────────────
  const handleStep5 = () => setStep(6)

  // ── Paso 6: completar ──────────────────────────────────────────────────────
  const handleFinish = async () => {
    if (signupCompletedRef.current) { navigate('/dashboard', { replace: true }); return }

    setSaving(true); setError('')
    try {
      // El servidor valida contra lo REALMENTE persistido, no contra el estado
      // local: si un paso obligatorio falló antes, esto no marca completo.
      const actualizado = await businessSetupService.updateMyBusinessSetup({ complete: true })
      setSetup(actualizado)

      signupCompletedRef.current = true
      track('signup_completed', { business_id: actualizado.businessId, plan: originPlan ?? null, source: 'onboarding' })
      try { sessionStorage.removeItem(ORIGIN_PLAN_KEY) } catch { /* no-op */ }

      // El nombre y el rubro del negocio acaban de cambiar: sin refrescar, el
      // shell seguiría mostrando los datos viejos.
      await refreshProfile()
      navigate('/dashboard', { replace: true })
    } catch (e) {
      if (e instanceof BusinessSetupError && e.code === 'ONBOARDING_INCOMPLETE') {
        setError('Faltan datos obligatorios. Volvé al primer paso y completá el nombre y el rubro.')
        setStep(1)
        return
      }
      if (!(e instanceof BusinessSetupError)) {
        logger.error('AUTH', 'Onboarding: fallo inesperado al finalizar', e)
      }
      setError(e instanceof BusinessSetupError ? e.message : 'No se pudo finalizar. Intentá nuevamente.')
    } finally {
      setSaving(false)
    }
  }

  // ── Espera ─────────────────────────────────────────────────────────────────
  if (authState !== 'AUTHENTICATED_WITH_BUSINESS' || cargando) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--auth-bg)' }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', border: '3px solid rgba(99,102,241,0.2)', borderTop: '3px solid #6366f1', animation: 'tr-spin 0.8s linear infinite' }} />
        <style>{`@keyframes tr-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  // Sólo owner/admin configuran. A los demás se les dice por qué en vez de
  // dejarlos chocar contra un 42501 al guardar.
  if (setup && !setup.canEdit) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--auth-bg)', padding: '1.25rem' }}>
        <div style={{ maxWidth: 440, textAlign: 'center', background: 'var(--auth-card-bg)', border: '1px solid var(--border-color)', borderRadius: 22, padding: '2.25rem' }}>
          <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.35rem', fontWeight: 800, color: 'var(--text-primary)' }}>
            Ya estás dentro de {setup.name}
          </h2>
          <p style={{ margin: '0 0 1.5rem', color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6 }}>
            La configuración inicial la completa el dueño o un administrador del negocio.
          </p>
          <button data-testid="onboarding-ir-dashboard" className="ob-btn-primary" onClick={() => navigate('/dashboard', { replace: true })} style={OB_BTN_PRIMARY_STYLE}>
            Ir al dashboard →
          </button>
        </div>
      </div>
    )
  }

  const stepLabel = step < TOTAL_STEPS ? `Paso ${step} de ${TOTAL_STEPS - 1}` : '¡Todo listo!'

  return (
    <div style={{
      minHeight: '100dvh',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '2rem 1.25rem',
      background: 'var(--auth-bg)',
    }}>
      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
        @keyframes tr-spin { to { transform: rotate(360deg); } }
        .ob-card { animation: fadeUp 0.4s cubic-bezier(0.22,1,0.36,1) both; }
        .rubro-btn:hover { border-color: rgba(99,102,241,0.5) !important; background: rgba(99,102,241,0.06) !important; }
        .ob-input:focus { outline:none; border-color:#6366f1 !important; box-shadow: 0 0 0 3px rgba(99,102,241,0.12) !important; }
        .ob-btn-primary:hover:not(:disabled) { opacity:0.88; transform:translateY(-1px); }
        .ob-btn-primary { transition: opacity 0.15s, transform 0.15s; }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '2rem' }}>
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div key={i} style={{
            width: i + 1 === step ? 24 : 8, height: 8, borderRadius: 4,
            background: i + 1 <= step ? 'var(--accent-primary)' : 'var(--border-strong)',
            transition: 'width 0.3s, background 0.3s',
          }} />
        ))}
        <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: 'var(--text-subtle)' }}>
          {stepLabel}
        </span>
      </div>

      <div className="ob-card" key={step} style={{
        width: '100%', maxWidth: 480,
        background: 'var(--auth-card-bg)', border: '1px solid var(--border-color)',
        borderRadius: 22, backdropFilter: 'blur(20px)', padding: '2.25rem',
        boxShadow: '0 4px 6px rgba(0,0,0,0.1), 0 24px 48px rgba(0,0,0,0.2)',
      }}>

        {/* ── Paso 1: Negocio ───────────────────────────────────── */}
        {step === 1 && (
          <>
            <div style={{ marginBottom: '1.75rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>Bienvenido</div>
              <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>Configurá tu negocio</h1>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem', lineHeight: 1.6 }}>En menos de 2 minutos vas a tener tu sistema listo.</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.125rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Nombre del negocio</label>
                <input data-testid="onboarding-business-name" className="ob-input" autoFocus value={businessName} onChange={e => setBusinessName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleStep1()} placeholder="Ej: Tecno Reparaciones" style={OB_INPUT_STYLE} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Rubro principal</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {RUBROS.map(r => (
                    <button key={r.id} data-testid={`onboarding-rubro-${r.id}`} className="rubro-btn" onClick={() => setRubro(r.id)} style={{
                      padding: '0.625rem 0.75rem',
                      background: rubro === r.id ? 'rgba(99,102,241,0.15)' : 'var(--bg-hover)',
                      border: `1.5px solid ${rubro === r.id ? '#6366f1' : 'var(--border-color)'}`,
                      borderRadius: 10, color: rubro === r.id ? '#818cf8' : '#64748b',
                      fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
                    }}>{r.label}</button>
                  ))}
                </div>
              </div>
              {error && <p data-testid="onboarding-error" role="alert" style={{ margin: 0, color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}
              <button data-testid="onboarding-step1-submit" className="ob-btn-primary" onClick={handleStep1} disabled={saving} style={{ ...OB_BTN_PRIMARY_STYLE, opacity: saving ? 0.65 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving ? 'Guardando...' : 'Continuar →'}
              </button>
            </div>
          </>
        )}

        {/* ── Paso 2: Logo ──────────────────────────────────────── */}
        {step === 2 && (
          <>
            <div style={{ marginBottom: '1.75rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>Identidad visual</div>
              <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>Logo de tu negocio</h2>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem' }}>Opcional — podés cargarlo después desde Configuración.</p>
            </div>
            <label style={{ cursor: 'pointer', display: 'block' }}>
              <div style={{
                width: 110, height: 110, borderRadius: 20,
                background: logoPreview ? 'transparent' : 'rgba(99,102,241,0.08)',
                border: `2px dashed ${logoPreview ? '#6366f1' : 'rgba(99,102,241,0.3)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 1.25rem', overflow: 'hidden',
              }}>
                {logoPreview ? (
                  <img src={logoPreview} alt="logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ textAlign: 'center' }}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                    <p style={{ margin: '0.375rem 0 0', fontSize: '0.72rem', color: 'var(--text-subtle)' }}>Subir logo</p>
                  </div>
                )}
              </div>
              <input data-testid="onboarding-logo-input" type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={handleLogoChange} />
            </label>
            {logoPreview && (
              <button onClick={() => { setLogoFile(null); setLogoPreview(setup?.logoUrl ?? null) }} style={{ display: 'block', margin: '0 auto 1.25rem', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.78rem', cursor: 'pointer' }}>
                Quitar logo
              </button>
            )}
            {error && <p data-testid="onboarding-error" role="alert" style={{ margin: '0 0 0.75rem', color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button data-testid="onboarding-logo-skip" onClick={() => setStep(3)} style={{ flex: 1, padding: '12px', background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>Omitir</button>
              <button data-testid="onboarding-step2-submit" className="ob-btn-primary" onClick={() => void handleStep2()} disabled={saving} style={{ flex: 2, padding: '12px', background: 'linear-gradient(135deg, #6366f1, #4f46e5)', border: 'none', borderRadius: 12, color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.65 : 1 }}>
                {saving ? 'Guardando...' : logoFile ? 'Guardar logo →' : 'Continuar →'}
              </button>
            </div>
          </>
        )}

        {/* ── Paso 3: Contacto ──────────────────────────────────── */}
        {step === 3 && (
          <>
            <div style={{ marginBottom: '1.75rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>Contacto</div>
              <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>Datos de contacto</h2>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem' }}>Para WhatsApp y el encabezado de tus comprobantes.</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>WhatsApp del negocio</label>
                <input data-testid="onboarding-whatsapp" className="ob-input" type="tel" value={whatsapp} onChange={e => setWhatsapp(e.target.value)} placeholder="3512345678" style={OB_INPUT_STYLE} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Ciudad / Localidad</label>
                <input data-testid="onboarding-ciudad" className="ob-input" type="text" value={ciudad} onChange={e => setCiudad(e.target.value)} placeholder="Ej: Córdoba" style={OB_INPUT_STYLE} />
              </div>
              {error && <p data-testid="onboarding-error" role="alert" style={{ margin: 0, color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button onClick={() => setStep(4)} style={{ flex: 1, padding: '12px', background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>Omitir</button>
                <button data-testid="onboarding-step3-submit" className="ob-btn-primary" onClick={handleStep3} disabled={saving} style={{ flex: 2, padding: '12px', background: 'linear-gradient(135deg, #6366f1, #4f46e5)', border: 'none', borderRadius: 12, color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.65 : 1 }}>
                  {saving ? 'Guardando...' : 'Continuar →'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Paso 4: Configuración fiscal ─────────────────────── */}
        {step === 4 && (
          <>
            <div style={{ marginBottom: '1.75rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>Configuración fiscal</div>
              <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>Datos impositivos</h2>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem' }}>Opcional. La facturación electrónica (ARCA) se configura después, desde Configuración.</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Condición fiscal</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {CONDICIONES_FISCALES.map(c => (
                    <button key={c.id} data-testid={`onboarding-cond-${c.id}`} className="rubro-btn" onClick={() => setCondicionFiscal(c.id)} style={{
                      padding: '0.6rem 0.75rem',
                      background: condicionFiscal === c.id ? 'rgba(99,102,241,0.15)' : 'var(--bg-hover)',
                      border: `1.5px solid ${condicionFiscal === c.id ? '#6366f1' : 'var(--border-color)'}`,
                      borderRadius: 10, color: condicionFiscal === c.id ? '#818cf8' : '#64748b',
                      fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
                    }}>{c.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>CUIT <span style={{ fontWeight: 400, textTransform: 'none' }}>(sin guiones)</span></label>
                <input data-testid="onboarding-cuit" className="ob-input" type="text" value={cuit} onChange={e => setCuit(e.target.value.replace(/\D/g, ''))} placeholder="20123456789" maxLength={11} style={OB_INPUT_STYLE} />
              </div>
              {error && <p data-testid="onboarding-error" role="alert" style={{ margin: 0, color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem' }}>
                <button onClick={() => setStep(5)} style={{ flex: 1, padding: '12px', background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>Omitir</button>
                <button data-testid="onboarding-step4-submit" className="ob-btn-primary" onClick={handleStep4} disabled={saving} style={{ flex: 2, padding: '12px', background: 'linear-gradient(135deg, #6366f1, #4f46e5)', border: 'none', borderRadius: 12, color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.65 : 1 }}>
                  {saving ? 'Guardando...' : 'Continuar →'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Paso 5: Plan / Trial ─────────────────────────────── */}
        {step === 5 && (
          <>
            <div style={{ marginBottom: '1.5rem', textAlign: 'center' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>Tu plan</div>
              <h2 style={{ margin: '0 0 0.375rem', fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>Trial Pro — 14 días gratis</h2>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem', lineHeight: 1.6 }}>
                Acceso completo durante el período de prueba. Sin tarjeta requerida.
              </p>
              {originPlan && (
                <p style={{ margin: '0.625rem 0 0', color: '#818cf8', fontSize: '0.8rem', fontWeight: 600 }}>
                  Elegiste el plan {PLANS.find(p => p.id === originPlan)?.name}: lo vas a poder activar al terminar la prueba.
                </p>
              )}
            </div>
            <div style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 14, padding: '1rem 1.125rem', marginBottom: '1.25rem' }}>
              <p style={{ margin: '0 0 0.75rem', fontSize: '0.72rem', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Incluido en tu trial
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {TRIAL_FEATURES_LIST.map(f => (
                  <div key={f} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{f}</span>
                  </div>
                ))}
              </div>
            </div>
            <p style={{ margin: '0 0 1.25rem', fontSize: '0.75rem', color: 'var(--text-subtle)', textAlign: 'center' }}>
              Los métodos de pago del mostrador se configuran desde Configuración → Métodos de pago.
            </p>
            <button data-testid="onboarding-step5-submit" className="ob-btn-primary" onClick={handleStep5} style={{ ...OB_BTN_PRIMARY_STYLE }}>
              Entendido, ¡vamos! →
            </button>
          </>
        )}

        {/* ── Paso 6: ¡Listo! ──────────────────────────────────── */}
        {step === 6 && (
          <>
            <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%',
                background: 'rgba(34,197,94,0.15)', border: '2px solid #22c55e',
                display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1rem',
              }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>¡Tu negocio está listo!</h2>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem', lineHeight: 1.6 }}>
                Tenés <strong style={{ color: '#60a5fa' }}>14 días de acceso gratuito</strong> con todas las funciones del Plan Pro.
              </p>
            </div>
            <div style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 12, padding: '1rem 1.125rem', marginBottom: '1.5rem' }}>
              <p style={{ margin: '0 0 0.75rem', fontSize: '0.75rem', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Primeros pasos</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {CHECKLIST_INITIAL.map((item, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                    <div style={{ width: 18, height: 18, borderRadius: '50%', border: '1.5px solid rgba(99,102,241,0.4)', flexShrink: 0 }} />
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
            {error && <p data-testid="onboarding-error" role="alert" style={{ margin: '0 0 0.75rem', color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}
            <button data-testid="onboarding-finish" className="ob-btn-primary" onClick={() => void handleFinish()} disabled={saving} style={{ ...OB_BTN_PRIMARY_STYLE, opacity: saving ? 0.65 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}>
              {saving ? 'Finalizando...' : 'Ir al dashboard →'}
            </button>
            <p style={{ textAlign: 'center', margin: '1rem 0 0', fontSize: '0.75rem', color: 'var(--text-subtle)' }}>
              Podés elegir un plan en cualquier momento desde Suscripción
            </p>
          </>
        )}

      </div>
    </div>
  )
}
