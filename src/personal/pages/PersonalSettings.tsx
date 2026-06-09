import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, MessageCircle, Info, Zap, Check, Copy, Play, Link } from 'lucide-react'
import { PageContainer } from '../components/ui'
import { useQuickExpense } from '../components/QuickExpensePopup'

const HIDE_KEY        = 'miGuitaHideAmounts'
const ASSISTANT_KEY   = 'miguita_recommendations_enabled'
const APP_VERSION     = 'stable-miguita-quick-expense-shortcut-v2'

const QUICK_EXPENSE_URL = typeof window !== 'undefined'
  ? `${window.location.origin}/personal?quickExpense=1`
  : 'https://mi-guita.app/personal?quickExpense=1'

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 44, height: 24, borderRadius: 99, flexShrink: 0, cursor: 'pointer',
        border: 'none', padding: '2px',
        background: checked ? '#34d399' : 'rgba(255,255,255,0.1)',
        transition: 'background 0.18s',
        display: 'flex', alignItems: 'center',
        justifyContent: checked ? 'flex-end' : 'flex-start',
      }}
    >
      <div style={{ width: 20, height: 20, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transition: 'all 0.18s' }} />
    </button>
  )
}

function SettingRow({ icon, title, description, right }: { icon: React.ReactNode; title: string; description: string; right: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.875rem', padding: '0.875rem 1rem' }}>
      <div style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: '0.875rem', color: '#f0f4ff' }}>{title}</div>
        <div style={{ fontSize: '0.72rem', color: '#475569', lineHeight: 1.4, marginTop: '0.15rem' }}>{description}</div>
      </div>
      <div style={{ flexShrink: 0 }}>{right}</div>
    </div>
  )
}

export function PersonalSettings() {
  const navigate                        = useNavigate()
  const { openPopup }                   = useQuickExpense()
  const [hideAmounts, setHideAmounts]   = useState(() => localStorage.getItem(HIDE_KEY) === 'true')
  const [assistant,   setAssistant]     = useState(() => localStorage.getItem(ASSISTANT_KEY) !== 'false')
  const [copied,      setCopied]        = useState(false)

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(QUICK_EXPENSE_URL)
    } catch {
      const el = document.createElement('textarea')
      el.value = QUICK_EXPENSE_URL
      document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleTestLink = () => {
    navigate('/personal?quickExpense=1')
  }

  const toggleHide = (v: boolean) => {
    setHideAmounts(v)
    localStorage.setItem(HIDE_KEY, String(v))
  }

  const toggleAssistant = (v: boolean) => {
    setAssistant(v)
    localStorage.setItem(ASSISTANT_KEY, String(v))
  }

  return (
    <PageContainer>

      <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff', padding: '0.25rem 0 0.125rem', display: 'block' }}>
        Configuración
      </span>

      {/* Privacy */}
      <div>
        <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
          Privacidad
        </div>
        <SettingRow
          icon={<Eye size={17} color="#818cf8" />}
          title="Ocultar importes"
          description="Enmascara todos los montos con ••••. Útil al compartir pantalla."
          right={<Toggle checked={hideAmounts} onChange={toggleHide} />}
        />
      </div>

      {/* Assistant */}
      <div>
        <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
          Asistente
        </div>
        <SettingRow
          icon={<MessageCircle size={17} color="#818cf8" />}
          title="Recomendaciones de Miguita"
          description="Muestra sugerencias y alertas contextuales basadas en tus datos."
          right={<Toggle checked={assistant} onChange={toggleAssistant} />}
        />
      </div>

      {/* Atajos iOS */}
      <div>
        <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
          Atajos
        </div>
        <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.875rem', padding: '0.875rem 1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

          {/* Título */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.875rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Zap size={17} color="#f87171" />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.875rem', color: '#f0f4ff', marginBottom: '0.25rem' }}>Gasto rápido con Toque posterior</div>
              <div style={{ fontSize: '0.72rem', color: '#475569', lineHeight: 1.5 }}>
                Doble toque atrás del iPhone abre el panel flotante de gasto rápido vía Atajos de iOS.
              </div>
            </div>
          </div>

          {/* Botones de prueba */}
          <div>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
              Probar
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                data-testid="personal-settings-test-popup"
                onClick={openPopup}
                style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', borderRadius: '0.625rem', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', color: '#34d399', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer', minHeight: 36, transition: 'all 0.15s' }}
              >
                <Play size={12} /> Probar popup
              </button>
              <button
                data-testid="personal-settings-test-link"
                onClick={handleTestLink}
                style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', borderRadius: '0.625rem', background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.2)', color: '#818cf8', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer', minHeight: 36, transition: 'all 0.15s' }}
              >
                <Link size={12} /> Probar link
              </button>
              <button
                data-testid="personal-settings-copy-shortcut-link"
                onClick={() => void handleCopyLink()}
                style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', borderRadius: '0.625rem', background: copied ? 'rgba(52,211,153,0.12)' : 'rgba(255,255,255,0.05)', border: `1px solid ${copied ? 'rgba(52,211,153,0.35)' : 'rgba(255,255,255,0.1)'}`, color: copied ? '#34d399' : '#94a3b8', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer', minHeight: 36, transition: 'all 0.15s' }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? '¡Copiado!' : 'Copiar link'}
              </button>
            </div>
          </div>

          {/* URL */}
          <div>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.4rem' }}>
              Link del atajo
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: '#34d399', background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)', borderRadius: '0.5rem', padding: '0.5rem 0.75rem', wordBreak: 'break-all', lineHeight: 1.4 }}>
              {QUICK_EXPENSE_URL}
            </div>
          </div>

          {/* Cómo crear el atajo */}
          <div>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
              Crear el atajo (una sola vez)
            </div>
            {[
              { n: 1, text: 'Copiá el link de arriba.' },
              { n: 2, text: 'Abrí la app Atajos en tu iPhone.' },
              { n: 3, text: 'Nuevo atajo → "+" → buscá y agregá la acción "URL", pegá el link.' },
              { n: 4, text: 'Agregá una segunda acción: "Abrir URL" (no "Obtener contenido"). No usar "Abrir app".' },
              { n: 5, text: 'Guardá el atajo con un nombre como "Gasto rápido".' },
            ].map(({ n, text }) => (
              <div key={n} style={{ display: 'flex', gap: '0.625rem', marginBottom: '0.4rem', fontSize: '0.8rem', color: '#475569' }}>
                <span style={{ color: '#34d399', fontWeight: 800, flexShrink: 0, minWidth: 16 }}>{n}.</span>
                <span style={{ lineHeight: 1.45 }}>{text}</span>
              </div>
            ))}
          </div>

          {/* Cómo asignar Toque posterior */}
          <div>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
              Asignar a Toque posterior
            </div>
            {[
              { n: 1, text: 'Ajustes → Accesibilidad → Tocar → Toque posterior.' },
              { n: 2, text: 'Tocá "Tocar dos veces".' },
              { n: 3, text: 'Bajá hasta la sección "Atajos" y seleccioná el atajo "Gasto rápido".' },
            ].map(({ n, text }) => (
              <div key={n} style={{ display: 'flex', gap: '0.625rem', marginBottom: '0.4rem', fontSize: '0.8rem', color: '#475569' }}>
                <span style={{ color: '#f87171', fontWeight: 800, flexShrink: 0, minWidth: 16 }}>{n}.</span>
                <span style={{ lineHeight: 1.45 }}>{text}</span>
              </div>
            ))}
          </div>

          {/* Nota técnica */}
          <div style={{ fontSize: '0.7rem', color: '#1e3a5f', lineHeight: 1.5, padding: '0.5rem 0.625rem', background: 'rgba(52,211,153,0.04)', borderRadius: '0.5rem', border: '1px solid rgba(52,211,153,0.08)' }}>
            La integración usa Atajos de iOS. La app no detecta el gesto físico directamente — iOS ejecuta el atajo que abre el link, y Mi Guita lo intercepta al volver a primer plano.
          </div>
        </div>
      </div>

      {/* App info */}
      <div>
        <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
          Información
        </div>
        <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.875rem', padding: '0.875rem 1rem', display: 'flex', gap: '0.875rem', alignItems: 'flex-start' }}>
          <div style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Info size={17} color="#818cf8" />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.875rem', color: '#f0f4ff', marginBottom: '0.25rem' }}>Mi Guita</div>
            <div style={{ fontSize: '0.72rem', color: '#475569', lineHeight: 1.5 }}>
              Tu dinero, explicado con claridad.
            </div>
            <div style={{ fontSize: '0.65rem', color: '#1e3a5f', marginTop: '0.375rem', fontFamily: 'monospace' }}>
              {APP_VERSION}
            </div>
          </div>
        </div>
      </div>

    </PageContainer>
  )
}
