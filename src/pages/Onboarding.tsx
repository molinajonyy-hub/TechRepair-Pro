/**
 * Onboarding.tsx — Wizard de creación de negocio y configuración inicial.
 * 4 pasos: Negocio + rubro → Logo → Configuración → ¡Listo!
 */
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { uploadBusinessLogo } from '../lib/storageSetup'

const F = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

const RUBROS = [
  { id: 'celulares',        label: 'Celulares y smartphones' },
  { id: 'computadoras',     label: 'Computadoras y laptops' },
  { id: 'electrodomesticos',label: 'Electrónica y electrodomésticos' },
  { id: 'tecnico_general',  label: 'Técnico general' },
  { id: 'redes',            label: 'Redes y telecomunicaciones' },
  { id: 'otro',             label: 'Otro rubro' },
]

const CHECKLIST_INITIAL = [
  'Crear tu primera orden de reparación',
  'Agregar productos al inventario',
  'Registrar tu primer cliente',
  'Hacer tu primer cobro',
  'Configurar métodos de pago',
]

export function Onboarding() {
  const { user, businessId: existingBusinessId, loading, profileLoading, refreshProfile } = useAuth()
  const navigate = useNavigate()

  // ── Guard: si ya tiene negocio → dashboard; si no → wizard ──────────────────
  // guardDone = true significa que el usuario PASÓ el check inicial (no tiene business).
  // Una vez que está en el wizard, NO redirigimos aunque refreshProfile() luego sete businessId
  // (eso sucede en Step 1 — el usuario necesita continuar con Step 2-4).
  const [guardDone, setGuardDone] = useState(false)

  useEffect(() => {
    if (guardDone) return           // ya pasó el guard, no interferir con el wizard
    if (loading || profileLoading) return
    if (!user) { navigate('/login', { replace: true }); return }
    if (existingBusinessId) { navigate('/dashboard', { replace: true }); return }
    setGuardDone(true)              // no tiene business → mostrar wizard
  }, [guardDone, loading, profileLoading, user, existingBusinessId, navigate])

  if (!guardDone) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0f1e' }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', border: '3px solid rgba(99,102,241,0.2)', borderTop: '3px solid #6366f1', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }
  // ────────────────────────────────────────────────────────────────────────────

  const [step, setStep]               = useState(1)
  const [businessName, setBusinessName] = useState('')
  const [rubro, setRubro]             = useState('')
  const [logoFile, setLogoFile]       = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [whatsapp, setWhatsapp]       = useState('')
  const [ciudad, setCiudad]           = useState('')
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState('')
  const [businessId, setBusinessId]   = useState<string | null>(null)

  const totalSteps = 4

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
      // Guardar rubro
      await supabase.from('businesses')
        .update({ rubro })
        .eq('id', bizId)
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
        const MAX_MB = 5
        if (logoFile.size > MAX_MB * 1024 * 1024) {
          setError(`El archivo es muy grande. Máximo ${MAX_MB} MB.`)
          setSaving(false); return
        }
        const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp']
        if (!allowed.includes(logoFile.type)) {
          setError('Formato no soportado. Usá PNG, JPG o WebP.')
          setSaving(false); return
        }
        try {
          const url = await uploadBusinessLogo(logoFile, businessId)
          if (url) {
            await supabase.from('businesses').update({ logo_url: url }).eq('id', businessId)
            await supabase.from('business_settings').update({ logo_url: url }).eq('business_id', businessId)
          }
        } catch (uploadErr: any) {
          // El upload falló pero no bloqueamos el onboarding — pueden subir logo desde Settings
          console.error('[Onboarding] logo upload failed:', uploadErr)
          setError(`No se pudo subir el logo: ${uploadErr.message}. Podés subirlo más tarde desde Configuración.`)
          // Continuamos al paso 3 de todas formas (logo es opcional)
        }
      }
      setStep(3)
    } finally { setSaving(false) }
  }

  // ── Step 3: configuración básica ─────────────────────────────────────────
  const handleStep3 = async () => {
    setSaving(true); setError('')
    try {
      if (businessId && (whatsapp || ciudad)) {
        const cleanWA = whatsapp.replace(/\D/g, '')
        await supabase.from('businesses')
          .update({
            ...(cleanWA ? { wholesale_whatsapp: cleanWA } : {}),
            ...(ciudad ? { ciudad } : {}),
          })
          .eq('id', businessId)
      }
      // Marcar onboarding completado
      if (businessId) {
        await supabase.from('businesses')
          .update({ onboarding_completed: true, onboarding_completed_at: new Date().toISOString() })
          .eq('id', businessId)
      }
      setStep(4)
    } catch (e: any) {
      setError(e.message || 'Error al guardar configuración')
    } finally { setSaving(false) }
  }

  const goToDashboard = () => navigate('/dashboard', { replace: true })

  return (
    <div style={{
      minHeight: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: F,
      padding: '2rem 1.25rem',
      background: `
        radial-gradient(ellipse 70% 50% at 20% 10%, rgba(99,102,241,0.06) 0%, transparent 60%),
        radial-gradient(ellipse 60% 50% at 80% 90%, rgba(139,92,246,0.05) 0%, transparent 60%),
        #0a0f1e
      `,
    }}>
      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
        .ob-card { animation: fadeUp 0.4s cubic-bezier(0.22,1,0.36,1) both; }
        .rubro-btn:hover { border-color: rgba(99,102,241,0.5) !important; background: rgba(99,102,241,0.06) !important; }
        .ob-input:focus { outline:none; border-color:#6366f1 !important; box-shadow: 0 0 0 3px rgba(99,102,241,0.12) !important; }
        .ob-btn-primary:hover:not(:disabled) { opacity:0.88; transform:translateY(-1px); }
        .ob-btn-primary { transition: opacity 0.15s, transform 0.15s; }
      `}</style>

      {/* Progreso */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '2rem' }}>
        {Array.from({ length: totalSteps }, (_, i) => (
          <div key={i} style={{
            width: i + 1 === step ? 24 : 8,
            height: 8,
            borderRadius: 4,
            background: i + 1 <= step ? '#6366f1' : 'rgba(255,255,255,0.1)',
            transition: 'width 0.3s, background 0.3s',
          }} />
        ))}
        <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: '#475569' }}>
          {step < 4 ? `Paso ${step} de ${totalSteps - 1}` : '¡Todo listo!'}
        </span>
      </div>

      <div className="ob-card" key={step} style={{
        width: '100%',
        maxWidth: 480,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 22,
        backdropFilter: 'blur(20px)',
        padding: '2.25rem',
        boxShadow: '0 4px 6px rgba(0,0,0,0.1), 0 24px 48px rgba(0,0,0,0.2)',
      }}>

        {/* ── Paso 1: Negocio ─────────────────────────────────────── */}
        {step === 1 && (
          <>
            <div style={{ marginBottom: '1.75rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>Bienvenido</div>
              <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.03em' }}>
                Creá tu negocio
              </h1>
              <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem', lineHeight: 1.6 }}>
                En menos de 2 minutos vas a tener tu sistema listo.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.125rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                  Nombre del negocio
                </label>
                <input
                  className="ob-input"
                  autoFocus
                  value={businessName}
                  onChange={e => setBusinessName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleStep1()}
                  placeholder="Ej: Tecno Reparaciones"
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    padding: '13px 15px', fontSize: '1rem', fontFamily: F,
                    background: 'rgba(255,255,255,0.05)', border: '1.5px solid rgba(255,255,255,0.1)',
                    borderRadius: 12, color: '#f1f5f9',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                  Rubro principal
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {RUBROS.map(r => (
                    <button
                      key={r.id}
                      className="rubro-btn"
                      onClick={() => setRubro(r.id)}
                      style={{
                        padding: '0.625rem 0.75rem',
                        background: rubro === r.id ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                        border: `1.5px solid ${rubro === r.id ? '#6366f1' : 'rgba(255,255,255,0.08)'}`,
                        borderRadius: 10,
                        color: rubro === r.id ? '#818cf8' : '#64748b',
                        fontSize: '0.78rem', fontWeight: 600,
                        cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.15s',
                      }}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              {error && <p style={{ margin: 0, color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}

              <button
                className="ob-btn-primary"
                onClick={handleStep1}
                disabled={saving}
                style={{
                  width: '100%', padding: '14px',
                  background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                  border: 'none', borderRadius: 12,
                  color: '#fff', fontWeight: 700, fontSize: '0.95rem',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.65 : 1,
                  boxShadow: '0 4px 16px rgba(99,102,241,0.3)',
                }}
              >
                {saving ? 'Creando...' : 'Continuar →'}
              </button>
            </div>
          </>
        )}

        {/* ── Paso 2: Logo ─────────────────────────────────────────── */}
        {step === 2 && (
          <>
            <div style={{ marginBottom: '1.75rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>Identidad visual</div>
              <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.4rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.03em' }}>
                Logo de tu negocio
              </h2>
              <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem' }}>
                Opcional — podés cargarlo después desde Ajustes.
              </p>
            </div>

            {/* Preview */}
            <label style={{ cursor: 'pointer', display: 'block' }}>
              <div style={{
                width: 110, height: 110, borderRadius: 20,
                background: logoPreview ? 'transparent' : 'rgba(99,102,241,0.08)',
                border: `2px dashed ${logoPreview ? '#6366f1' : 'rgba(99,102,241,0.3)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 1.25rem', overflow: 'hidden',
                transition: 'border-color 0.2s',
              }}>
                {logoPreview ? (
                  <img src={logoPreview} alt="logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ textAlign: 'center' }}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5">
                      <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
                    </svg>
                    <p style={{ margin: '0.375rem 0 0', fontSize: '0.72rem', color: '#475569' }}>Subir logo</p>
                  </div>
                )}
              </div>
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleLogoChange} />
            </label>

            {logoPreview && (
              <button onClick={() => { setLogoFile(null); setLogoPreview(null) }}
                style={{ display: 'block', margin: '0 auto 1.25rem', background: 'none', border: 'none', color: '#64748b', fontSize: '0.78rem', cursor: 'pointer' }}>
                Quitar logo
              </button>
            )}

            {error && <p style={{ margin: '0 0 0.75rem', color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}

            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button onClick={() => { setStep(3) }}
                style={{ flex: 1, padding: '12px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, color: '#64748b', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>
                Omitir
              </button>
              <button
                className="ob-btn-primary"
                onClick={handleStep2}
                disabled={saving}
                style={{ flex: 2, padding: '12px', background: 'linear-gradient(135deg, #6366f1, #4f46e5)', border: 'none', borderRadius: 12, color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.65 : 1 }}>
                {saving ? 'Guardando...' : logoFile ? 'Guardar logo →' : 'Continuar →'}
              </button>
            </div>
          </>
        )}

        {/* ── Paso 3: Configuración básica ─────────────────────────── */}
        {step === 3 && (
          <>
            <div style={{ marginBottom: '1.75rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>Configuración</div>
              <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.4rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.03em' }}>
                Datos de contacto
              </h2>
              <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem' }}>
                Opcional — para WhatsApp y datos del comprobante.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {[
                { label: 'WhatsApp del negocio', value: whatsapp, set: setWhatsapp, placeholder: '3512345678', type: 'tel' },
                { label: 'Ciudad / Localidad',   value: ciudad,   set: setCiudad,   placeholder: 'Ej: Córdoba',  type: 'text' },
              ].map(({ label, value, set, placeholder, type }) => (
                <div key={label}>
                  <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                    {label}
                  </label>
                  <input
                    className="ob-input"
                    type={type}
                    value={value}
                    onChange={e => set(e.target.value)}
                    placeholder={placeholder}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      padding: '12px 15px', fontSize: '0.95rem', fontFamily: F,
                      background: 'rgba(255,255,255,0.05)', border: '1.5px solid rgba(255,255,255,0.1)',
                      borderRadius: 12, color: '#f1f5f9',
                    }}
                  />
                </div>
              ))}

              {error && <p style={{ margin: 0, color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem' }}>
                <button onClick={() => setStep(4)}
                  style={{ flex: 1, padding: '12px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, color: '#64748b', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>
                  Omitir
                </button>
                <button
                  className="ob-btn-primary"
                  onClick={handleStep3}
                  disabled={saving}
                  style={{ flex: 2, padding: '12px', background: 'linear-gradient(135deg, #6366f1, #4f46e5)', border: 'none', borderRadius: 12, color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.65 : 1 }}>
                  {saving ? 'Guardando...' : 'Terminar →'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Paso 4: ¡Listo! ──────────────────────────────────────── */}
        {step === 4 && (
          <>
            <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%',
                background: 'rgba(34,197,94,0.15)', border: '2px solid #22c55e',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 1rem',
              }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
              <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.03em' }}>
                ¡Tu negocio está listo!
              </h2>
              <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem', lineHeight: 1.6 }}>
                Tenés <strong style={{ color: '#60a5fa' }}>14 días de acceso gratuito</strong> con todas las funciones del Plan Pro.
              </p>
            </div>

            <div style={{
              background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)',
              borderRadius: 12, padding: '1rem 1.125rem', marginBottom: '1.5rem',
            }}>
              <p style={{ margin: '0 0 0.75rem', fontSize: '0.75rem', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Primeros pasos
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {CHECKLIST_INITIAL.map((item, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                    <div style={{ width: 18, height: 18, borderRadius: '50%', border: '1.5px solid rgba(99,102,241,0.4)', flexShrink: 0 }} />
                    <span style={{ fontSize: '0.82rem', color: '#94a3b8' }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>

            <button
              className="ob-btn-primary"
              onClick={goToDashboard}
              style={{
                width: '100%', padding: '15px',
                background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                border: 'none', borderRadius: 12,
                color: '#fff', fontWeight: 700, fontSize: '1rem',
                cursor: 'pointer',
                boxShadow: '0 4px 20px rgba(99,102,241,0.35)',
              }}>
              Ir al dashboard →
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
