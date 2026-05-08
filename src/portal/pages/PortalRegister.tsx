import { useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { usePortal } from '../contexts/PortalContext'
import { registerCustomer } from '../services/portalService'
import { PortalLayout, PortalCard, PortalButton, PortalInput, PT } from '../components/PortalLayout'

const PROVINCES = [
  'Buenos Aires', 'CABA', 'Catamarca', 'Chaco', 'Chubut',
  'Córdoba', 'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy',
  'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquén',
  'Río Negro', 'Salta', 'San Juan', 'San Luis', 'Santa Cruz',
  'Santa Fe', 'Santiago del Estero', 'Tierra del Fuego', 'Tucumán',
]

export function PortalRegister() {
  const { slug } = useParams<{ slug: string }>()
  const { business } = usePortal()
  const navigate = useNavigate()

  const [form, setForm] = useState({
    name: '', businessName: '', email: '', password: '', confirmPassword: '',
    whatsapp: '', province: '', city: '', instagram: '',
  })
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const set = (k: keyof typeof form) => (v: string) => setForm(p => ({ ...p, [k]: v }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!business) return
    if (form.password.length < 6) { setError('La contraseña debe tener al menos 6 caracteres'); return }
    if (form.password !== form.confirmPassword) { setError('Las contraseñas no coinciden'); return }
    setLoading(true); setError('')
    const { error: err } = await registerCustomer({
      businessId:   business.id,
      name:         form.name,
      businessName: form.businessName,
      email:        form.email,
      password:     form.password,
      whatsapp:     form.whatsapp,
      province:     form.province,
      city:         form.city,
      instagram:    form.instagram,
    })
    setLoading(false)
    if (err) { setError(err); return }
    navigate(`/mayorista/${slug}/pendiente`)
  }

  return (
    <PortalLayout title="Solicitar acceso" showBack showCart={false} backTo={`/mayorista/${slug}/login`}>
      <div style={{ padding: '1.25rem 1rem 0.75rem' }}>
        <p style={{ color: PT.textSub, margin: 0, fontSize: '0.9rem' }}>
          Completá el formulario. Tu cuenta será revisada y aprobada manualmente.
        </p>
      </div>

      <div style={{ padding: '0 1rem' }}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <PortalCard style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ margin: 0, fontSize: '0.78rem', fontWeight: 700, color: PT.textSub, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Datos personales
            </p>
            <PortalInput label="Nombre completo"       value={form.name}         onChange={set('name')}         required placeholder="Juan García" />
            <PortalInput label="Nombre del negocio"    value={form.businessName}  onChange={set('businessName')} placeholder="Tech Accesorios" />
            <PortalInput label="WhatsApp"              type="tel" value={form.whatsapp}    onChange={set('whatsapp')}    placeholder="+54 9 11 1234-5678" />
            <PortalInput label="Instagram (opcional)"  value={form.instagram}     onChange={set('instagram')}   placeholder="@tu_negocio" />
          </PortalCard>

          <PortalCard style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ margin: 0, fontSize: '0.78rem', fontWeight: 700, color: PT.textSub, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Ubicación
            </p>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: PT.textSub, marginBottom: '0.35rem' }}>
                Provincia
              </label>
              <select
                value={form.province} onChange={e => set('province')(e.target.value)}
                style={{ width: '100%', padding: '0.75rem 1rem', background: PT.bg, border: `1px solid ${PT.border}`, borderRadius: PT.radius, color: PT.text, fontFamily: PT.font, fontSize: '1rem', outline: 'none', appearance: 'none' }}
              >
                <option value="">Seleccioná provincia</option>
                {PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <PortalInput label="Ciudad" value={form.city} onChange={set('city')} placeholder="Córdoba" />
          </PortalCard>

          <PortalCard style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ margin: 0, fontSize: '0.78rem', fontWeight: 700, color: PT.textSub, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Cuenta
            </p>
            <PortalInput label="Email" type="email" value={form.email} onChange={set('email')} required placeholder="tu@email.com" />
            <PortalInput label="Contraseña" type="password" value={form.password} onChange={set('password')} required placeholder="Mínimo 6 caracteres" />
            <PortalInput label="Repetir contraseña" type="password" value={form.confirmPassword} onChange={set('confirmPassword')} required placeholder="••••••••" />
          </PortalCard>

          {error && (
            <div style={{ padding: '0.875rem 1rem', background: `${PT.danger}15`, border: `1px solid ${PT.danger}40`, borderRadius: PT.radius, color: PT.danger, fontSize: '0.875rem' }}>
              {error}
            </div>
          )}

          <PortalButton type="submit" loading={loading}>
            Enviar solicitud de acceso
          </PortalButton>

          <p style={{ textAlign: 'center', color: PT.textSub, fontSize: '0.85rem', margin: 0 }}>
            ¿Ya tenés cuenta?{' '}
            <Link to={`/mayorista/${slug}/login`} style={{ color: PT.primary, fontWeight: 600, textDecoration: 'none' }}>
              Ingresá acá
            </Link>
          </p>
        </form>
      </div>
      <div style={{ height: '2rem' }} />
    </PortalLayout>
  )
}
