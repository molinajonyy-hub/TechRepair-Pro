/**
 * Onboarding.tsx — Wizard de creación de negocio y configuración inicial.
 * 7 pasos: Negocio → Logo → Contacto → Fiscal → Métodos de pago → Plan/Trial → ¡Listo!
 */
import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { uploadBusinessLogo } from '../lib/storageSetup'
import { track } from '../lib/analytics'
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

const PAYMENT_METHODS = [
  { id: 'efectivo',       label: '💵 Efectivo' },
  { id: 'transferencia',  label: '🏦 Transferencia' },
  { id: 'tarjeta',        label: '💳 Tarjeta' },
  { id: 'qr',             label: '📱 QR (Mercado Pago, etc.)' },
  { id: 'cuenta_corriente', label: '📒 Cuenta corriente propia' },
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

const TOTAL_STEPS = 7

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
  const { user, businessId: existingBusinessId, loading, profileLoading, refreshProfile } = useAuth()
  const navigate = useNavigate()

  // ── Guard ────────────────────────────────────────────────────────────────────
  const [guardDone, setGuardDone] = useState(false)

  // Plan de origen (landing → ?plan=...), validado contra la fuente de verdad.
  const [originPlan, setOriginPlan] = useState<SubscriptionPlan | null>(null)
  // Idempotencia: la conversión signup_completed se dispara una sola vez por flujo.
  const signupCompletedRef = useRef(false)

  useEffect(() => {
    if (guardDone) return
    if (loading || profileLoading) return
    if (!user) { navigate('/login', { replace: true }); return }
    if (existingBusinessId) { navigate('/dashboard', { replace: true }); return }
    setGuardDone(true)
  }, [guardDone, loading, profileLoading, user, existingBusinessId, navigate])

  useEffect(() => {
    // Lee el plan elegido en la landing: query param primero, luego sessionStorage.
    const fromUrl = new URLSearchParams(window.location.search).get('plan')
    const stored = (() => { try { return sessionStorage.getItem(ORIGIN_PLAN_KEY) } catch { return null } })()
    const candidate = fromUrl ?? stored
    if (isValidPlan(candidate)) {
      setOriginPlan(candidate)
      try { sessionStorage.setItem(ORIGIN_PLAN_KEY, candidate) } catch { /* no-op */ }
    }
  }, [])

  if (!guardDone) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--auth-bg)' }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', border: '3px solid rgba(99,102,241,0.2)', borderTop: '3px solid #6366f1', animation: 'tr-spin 0.8s linear infinite' }} />
      </div>
    )
  }
  // ────────────────────────────────────────────────────────────────────────────

  const [step, setStep]                         = useState(1)
  const [businessName, setBusinessName]         = useState('')
  const [rubro, setRubro]                       = useState('')
  const [logoFile, setLogoFile]                 = useState<File | null>(null)
  const [logoPreview, setLogoPreview]           = useState<string | null>(null)
  const [whatsapp, setWhatsapp]                 = useState('')
  const [ciudad, setCiudad]                     = useState('')
  const [condicionFiscal, setCondicionFiscal]   = useState('')
  const [cuit, setCuit]                         = useState('')
  const [activarArca, setActivarArca]           = useState<'now' | 'later'>('later')
  const [selectedPayments, setSelectedPayments] = useState<string[]>(['efectivo'])
  const [saving, setSaving]                     = useState(false)
  const [error, setError]                       = useState('')
  const [businessId, setBusinessId]             = useState<string | null>(null)

  // ── Step 1: crear negocio ──────────────────────────────────────────────────
  const handleStep1 = async () => {
    if (!businessName.trim()) { setError('El nombre del negocio es obligatorio'); return }
    if (!rubro)                { setError('Seleccioná el rubro de tu negocio'); return }
    if (!user?.email)          { setError('No se detectó usuario autenticado'); return }
    setSaving(true); setError('')
    try {
      const { data: bizId, error: rpcErr } = await supabase.rpc('bootstrap_owner_profile', {
        p_user_email:    user.email,
        p_business_name: businessName.trim(),
        p_full_name:     null,
      })
      if (rpcErr) throw rpcErr
      await supabase.from('businesses').update({ rubro }).eq('id', bizId)
      setBusinessId(bizId)
      await refreshProfile()
      setStep(2)
    } catch (e: any) {
      setError(e.message || 'Error al crear el negocio')
    } finally { setSaving(false) }
  }

  // ── Step 2: logo ──────────────────────────────────────────────────────────
  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLogoFile(file)
    setLogoPreview(URL.createObjectURL(file))
  }

  const handleStep2 = async () => {
    setSaving(true); setError('')
    try {
      if (logoFile && businessId) {
        if (logoFile.size > 5 * 1024 * 1024) { setError('Máximo 5 MB.'); setSaving(false); return }
        if (!['image/png','image/jpeg','image/jpg','image/webp'].includes(logoFile.type)) {
          setError('Formato no soportado. Usá PNG, JPG o WebP.'); setSaving(false); return
        }
        try {
          const url = await uploadBusinessLogo(logoFile, businessId)
          if (url) {
            await supabase.from('businesses').update({ logo_url: url }).eq('id', businessId)
            await supabase.from('business_settings').update({ logo_url: url }).eq('business_id', businessId)
          }
        } catch (uploadErr: any) {
          setError(`No se pudo subir el logo: ${uploadErr.message}. Podés subirlo desde Configuración.`)
        }
      }
      setStep(3)
    } finally { setSaving(false) }
  }

  // ── Step 3: datos de contacto ─────────────────────────────────────────────
  const handleStep3 = async () => {
    setSaving(true); setError('')
    try {
      if (businessId) {
        const cleanWA = whatsapp.replace(/\D/g, '')
        await supabase.from('businesses').update({
          ...(cleanWA ? { wholesale_whatsapp: cleanWA } : {}),
          ...(ciudad ? { ciudad } : {}),
        }).eq('id', businessId)
      }
      setStep(4)
    } catch (e: any) {
      setError(e.message || 'Error al guardar configuración')
    } finally { setSaving(false) }
  }

  // ── Step 4: fiscal ────────────────────────────────────────────────────────
  const handleStep4 = async () => {
    setSaving(true); setError('')
    try {
      if (businessId && (condicionFiscal || cuit)) {
        // Guardamos con cast any — estos campos existen en businesses para integración ARCA
        await supabase.from('businesses').update({
          ...(condicionFiscal ? { condicion_fiscal: condicionFiscal } as any : {}),
          ...(cuit ? { cuit } as any : {}),
        }).eq('id', businessId)
      }
      setStep(5)
    } catch {
      // Non-blocking: si el campo no existe en el schema, continuamos igual
      setStep(5)
    } finally { setSaving(false) }
  }

  // ── Step 5: métodos de pago ───────────────────────────────────────────────
  const togglePayment = (id: string) => {
    setSelectedPayments(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    )
  }

  const handleStep5 = async () => {
    setSaving(true); setError('')
    try {
      if (businessId && selectedPayments.length > 0) {
        await supabase.from('businesses').update({
          payment_methods_enabled: selectedPayments,
        } as any).eq('id', businessId)
      }
      setStep(6)
    } catch {
      setStep(6)
    } finally { setSaving(false) }
  }

  // ── Step 6: plan / trial info ─────────────────────────────────────────────
  const handleStep6 = () => setStep(7)

  // ── Step 7: guardar y listo ───────────────────────────────────────────────
  const handleFinish = async () => {
    // Ya completado en este flujo: no re-disparar la conversión, sólo continuar.
    if (signupCompletedRef.current) { navigate('/dashboard', { replace: true }); return }
    // Sin negocio creado no hubo onboarding válido: no es una conversión.
    if (!businessId) { navigate('/dashboard', { replace: true }); return }

    setSaving(true); setError('')
    try {
      await supabase.from('businesses').update({
        onboarding_completed: true,
        onboarding_completed_at: new Date().toISOString(),
      }).eq('id', businessId)

      // El backend confirmó la finalización del onboarding: recién acá es una
      // conversión real. Guard idempotente para evitar duplicados por reintentos.
      // `business_id` queda sólo en el contrato interno (dataLayer); el sanitizador
      // de analytics lo excluye de GA4/Clarity. A externo sólo van plan/source.
      signupCompletedRef.current = true
      track('signup_completed', { business_id: businessId, plan: originPlan ?? null, source: 'onboarding' })
      try { sessionStorage.removeItem(ORIGIN_PLAN_KEY) } catch { /* no-op */ }

      navigate('/dashboard', { replace: true })
    } catch (e: any) {
      setError(e.message || 'Error al finalizar')
    } finally { setSaving(false) }
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
        .rubro-btn:hover, .pay-btn:hover { border-color: rgba(99,102,241,0.5) !important; background: rgba(99,102,241,0.06) !important; }
        .ob-input:focus { outline:none; border-color:#6366f1 !important; box-shadow: 0 0 0 3px rgba(99,102,241,0.12) !important; }
        .ob-btn-primary:hover:not(:disabled) { opacity:0.88; transform:translateY(-1px); }
        .ob-btn-primary { transition: opacity 0.15s, transform 0.15s; }
      `}</style>

      {/* Progreso */}
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
              <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>Creá tu negocio</h1>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem', lineHeight: 1.6 }}>En menos de 2 minutos vas a tener tu sistema listo.</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.125rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Nombre del negocio</label>
                <input className="ob-input" autoFocus value={businessName} onChange={e => setBusinessName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleStep1()} placeholder="Ej: Tecno Reparaciones" style={OB_INPUT_STYLE} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Rubro principal</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {RUBROS.map(r => (
                    <button key={r.id} className="rubro-btn" onClick={() => setRubro(r.id)} style={{
                      padding: '0.625rem 0.75rem',
                      background: rubro === r.id ? 'rgba(99,102,241,0.15)' : 'var(--bg-hover)',
                      border: `1.5px solid ${rubro === r.id ? '#6366f1' : 'var(--border-color)'}`,
                      borderRadius: 10, color: rubro === r.id ? '#818cf8' : '#64748b',
                      fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
                    }}>{r.label}</button>
                  ))}
                </div>
              </div>
              {error && <p style={{ margin: 0, color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}
              <button className="ob-btn-primary" onClick={handleStep1} disabled={saving} style={{ ...OB_BTN_PRIMARY_STYLE, opacity: saving ? 0.65 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving ? 'Creando...' : 'Continuar →'}
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
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem' }}>Opcional — podés cargarlo después desde Ajustes.</p>
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
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleLogoChange} />
            </label>
            {logoPreview && (
              <button onClick={() => { setLogoFile(null); setLogoPreview(null) }} style={{ display: 'block', margin: '0 auto 1.25rem', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.78rem', cursor: 'pointer' }}>
                Quitar logo
              </button>
            )}
            {error && <p style={{ margin: '0 0 0.75rem', color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button onClick={() => setStep(3)} style={{ flex: 1, padding: '12px', background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>Omitir</button>
              <button className="ob-btn-primary" onClick={handleStep2} disabled={saving} style={{ flex: 2, padding: '12px', background: 'linear-gradient(135deg, #6366f1, #4f46e5)', border: 'none', borderRadius: 12, color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.65 : 1 }}>
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
              {[
                { label: 'WhatsApp del negocio', value: whatsapp, set: setWhatsapp, placeholder: '3512345678', type: 'tel' },
                { label: 'Ciudad / Localidad',   value: ciudad,   set: setCiudad,   placeholder: 'Ej: Córdoba',  type: 'text' },
              ].map(({ label, value, set, placeholder, type }) => (
                <div key={label}>
                  <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>{label}</label>
                  <input className="ob-input" type={type} value={value} onChange={e => set(e.target.value)} placeholder={placeholder} style={OB_INPUT_STYLE} />
                </div>
              ))}
              {error && <p style={{ margin: 0, color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button onClick={() => setStep(4)} style={{ flex: 1, padding: '12px', background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>Omitir</button>
                <button className="ob-btn-primary" onClick={handleStep3} disabled={saving} style={{ flex: 2, padding: '12px', background: 'linear-gradient(135deg, #6366f1, #4f46e5)', border: 'none', borderRadius: 12, color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.65 : 1 }}>
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
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem' }}>Opcional. Podés configurar ARCA / facturación electrónica después.</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Condición fiscal</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {CONDICIONES_FISCALES.map(c => (
                    <button key={c.id} className="rubro-btn" onClick={() => setCondicionFiscal(c.id)} style={{
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
                <input className="ob-input" type="text" value={cuit} onChange={e => setCuit(e.target.value.replace(/\D/g, ''))} placeholder="20123456789" maxLength={11} style={OB_INPUT_STYLE} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>ARCA / Facturación electrónica</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {[{ id: 'now' as const, label: 'Configurar ahora' }, { id: 'later' as const, label: 'Configurar después' }].map(({ id, label }) => (
                    <button key={id} onClick={() => setActivarArca(id)} style={{
                      flex: 1, padding: '0.6rem 0.75rem',
                      background: activarArca === id ? 'rgba(99,102,241,0.15)' : 'var(--bg-hover)',
                      border: `1.5px solid ${activarArca === id ? '#6366f1' : 'var(--border-color)'}`,
                      borderRadius: 10, color: activarArca === id ? '#818cf8' : '#64748b',
                      fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                    }}>{label}</button>
                  ))}
                </div>
                {activarArca === 'now' && (
                  <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: '#6366f1' }}>
                    Podés configurar ARCA en Configuración → ARCA después de entrar al sistema.
                  </p>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem' }}>
                <button onClick={() => setStep(5)} style={{ flex: 1, padding: '12px', background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>Omitir</button>
                <button className="ob-btn-primary" onClick={handleStep4} disabled={saving} style={{ flex: 2, padding: '12px', background: 'linear-gradient(135deg, #6366f1, #4f46e5)', border: 'none', borderRadius: 12, color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.65 : 1 }}>
                  {saving ? 'Guardando...' : 'Continuar →'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Paso 5: Métodos de pago ───────────────────────────── */}
        {step === 5 && (
          <>
            <div style={{ marginBottom: '1.75rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>Cobranza</div>
              <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>Métodos de pago</h2>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem' }}>¿Cómo aceptás pagos? Podés cambiarlo desde Configuración.</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.25rem' }}>
              {PAYMENT_METHODS.map(pm => (
                <button key={pm.id} className="pay-btn" onClick={() => togglePayment(pm.id)} style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.75rem 1rem',
                  background: selectedPayments.includes(pm.id) ? 'rgba(99,102,241,0.12)' : 'var(--bg-hover)',
                  border: `1.5px solid ${selectedPayments.includes(pm.id) ? '#6366f1' : 'var(--border-color)'}`,
                  borderRadius: 12, color: selectedPayments.includes(pm.id) ? '#818cf8' : '#64748b',
                  fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
                }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                    border: `2px solid ${selectedPayments.includes(pm.id) ? '#6366f1' : 'var(--border-strong)'}`,
                    background: selectedPayments.includes(pm.id) ? '#6366f1' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {selectedPayments.includes(pm.id) && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                    )}
                  </div>
                  {pm.label}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button onClick={() => setStep(6)} style={{ flex: 1, padding: '12px', background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>Omitir</button>
              <button className="ob-btn-primary" onClick={handleStep5} disabled={saving} style={{ flex: 2, padding: '12px', background: 'linear-gradient(135deg, #6366f1, #4f46e5)', border: 'none', borderRadius: 12, color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.65 : 1 }}>
                {saving ? 'Guardando...' : 'Continuar →'}
              </button>
            </div>
          </>
        )}

        {/* ── Paso 6: Plan / Trial ─────────────────────────────── */}
        {step === 6 && (
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
            <p style={{ margin: '0 0 1.25rem', fontSize: '0.75rem', color: '#334155', textAlign: 'center' }}>
              Al finalizar el trial podés elegir un plan desde Configuración → Suscripción.
            </p>
            <button className="ob-btn-primary" onClick={handleStep6} style={{ ...OB_BTN_PRIMARY_STYLE }}>
              Entendido, ¡vamos! →
            </button>
          </>
        )}

        {/* ── Paso 7: ¡Listo! ──────────────────────────────────── */}
        {step === 7 && (
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
            {error && <p style={{ margin: '0 0 0.75rem', color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}
            <button className="ob-btn-primary" onClick={handleFinish} disabled={saving} style={{ ...OB_BTN_PRIMARY_STYLE, opacity: saving ? 0.65 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}>
              {saving ? 'Finalizando...' : 'Ir al dashboard →'}
            </button>
            <p style={{ textAlign: 'center', margin: '1rem 0 0', fontSize: '0.75rem', color: '#334155' }}>
              Podés elegir un plan en cualquier momento desde Suscripción
            </p>
          </>
        )}

      </div>
    </div>
  )
}
