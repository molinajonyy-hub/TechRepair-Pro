/** Stub pages for modules coming in future phases. */
import { AlertCircle, BarChart3, Settings, Tag, List, RepeatIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { PageContainer, EmptyPersonal } from '../components/ui'

function ComingSoon({ Icon, title, description }: { Icon: React.ElementType; title: string; description: string }) {
  const navigate = useNavigate()
  return (
    <PageContainer style={{ justifyContent: 'center', minHeight: '60dvh' }}>
      <EmptyPersonal
        icon={<Icon size={26} />}
        title={title}
        description={description}
        cta="Volver al inicio"
        onCta={() => navigate('/personal')}
      />
      <div style={{ textAlign: 'center' }}>
        <span style={{ fontSize: '0.7rem', color: '#1e3a5f', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Próximamente</span>
      </div>
    </PageContainer>
  )
}


export function PersonalDebts() {
  return <ComingSoon Icon={AlertCircle} title="Deudas personales" description="Registrá tus deudas, seguí los pagos y sabe cuánto te falta cancelar." />
}

export function PersonalProjection() {
  return <ComingSoon Icon={BarChart3} title="Proyecciones" description="Ve cuánto vas a tener disponible a fin de mes considerando todos tus compromisos." />
}

export function PersonalCategories() {
  return <ComingSoon Icon={Tag} title="Categorías" description="Personalizá las categorías de gastos e ingresos para organizar mejor tus finanzas." />
}

export function PersonalSettings() {
  return <ComingSoon Icon={Settings} title="Configuración" description="Ajustá la moneda principal, preferencias visuales y opciones de la app." />
}

export function PersonalMore() {
  const navigate = useNavigate()
  const items = [
    { label: 'Mis cuentas',    path: '/personal/cuentas',       Icon: List        },
    { label: 'Gastos fijos',   path: '/personal/gastos-fijos',  Icon: RepeatIcon  },
    { label: 'Deudas',         path: '/personal/deudas',        Icon: AlertCircle },
    { label: 'Categorías',     path: '/personal/categorias',    Icon: Tag         },
    { label: 'Proyecciones',   path: '/personal/proyecciones',  Icon: BarChart3   },
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
