import { useState } from 'react'
import { Eye, MessageCircle, Info } from 'lucide-react'
import { PageContainer } from '../components/ui'

const HIDE_KEY        = 'miGuitaHideAmounts'
const ASSISTANT_KEY   = 'miguita_recommendations_enabled'
const APP_VERSION     = 'stable-miguita-monthly-plan-settings-v1'

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
  const [hideAmounts, setHideAmounts] = useState(() => localStorage.getItem(HIDE_KEY) === 'true')
  const [assistant,   setAssistant]   = useState(() => localStorage.getItem(ASSISTANT_KEY) !== 'false')

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
