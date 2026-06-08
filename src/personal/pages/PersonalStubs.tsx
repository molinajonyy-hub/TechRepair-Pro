/** Navigation menu — "Más" section. */
import { AlertCircle, BarChart3, Settings, Tag, List, RepeatIcon, Wallet, Lightbulb, CalendarDays } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '../components/ui'

export function PersonalMore() {
  const navigate = useNavigate()
  const items = [
    { label: 'Mis cuentas',    path: '/personal/cuentas',       Icon: List        },
    { label: 'Gastos fijos',   path: '/personal/gastos-fijos',  Icon: RepeatIcon  },
    { label: 'Deudas',         path: '/personal/deudas',        Icon: AlertCircle },
    { label: 'Categorías',     path: '/personal/categorias',    Icon: Tag         },
    { label: 'Proyecciones',   path: '/personal/proyecciones',  Icon: BarChart3   },
    { label: 'Presupuestos',   path: '/personal/presupuestos',  Icon: Wallet      },
    { label: 'Plan del mes',   path: '/personal/plan',          Icon: CalendarDays},
    { label: 'Diagnóstico',    path: '/personal/insights',      Icon: Lightbulb   },
    { label: 'Configuración',  path: '/personal/configuracion', Icon: Settings    },
  ]
  return (
    <PageContainer>
      <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff', padding: '0.5rem 0 0.25rem' }}>Más</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
        {items.map(({ label, path, Icon }) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '1rem', background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.875rem', cursor: 'pointer', textAlign: 'left', transition: 'background 0.12s' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.025)')}
          >
            <div style={{ width: 38, height: 38, borderRadius: '0.75rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon size={17} color="#818cf8" />
            </div>
            <span style={{ fontWeight: 600, color: '#f0f4ff', fontSize: '0.9375rem' }}>{label}</span>
          </button>
        ))}
      </div>
    </PageContainer>
  )
}
