import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import '../css/landing.css'

// ─────────────────────────────────────────────────────────────────────
// Icons (inline SVG to avoid extra deps)
// ─────────────────────────────────────────────────────────────────────

// ── Cat logo SVG (design system) ──
const CatLogoSVG = ({ size = 22 }: { size?: number }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M18 46 L25 14 L38 36 Q50 30 62 36 L75 14 L82 46 Q86 60 82 70 Q70 88 50 88 Q30 88 18 70 Q14 60 18 46 Z" fill="white" opacity="0.93"/>
    <path d="M26 18 L20 43 L37 36 Z" fill="#6366f1" opacity="0.45"/>
    <path d="M74 18 L80 43 L63 36 Z" fill="#6366f1" opacity="0.45"/>
    <ellipse cx="37" cy="58" rx="5.5" ry="5" fill="#6366f1" opacity="0.8"/>
    <ellipse cx="63" cy="58" rx="5.5" ry="5" fill="#6366f1" opacity="0.8"/>
  </svg>
)

// ── WhatsApp SVG icon ──
const WhatsAppSVG = ({ size = 26, color = '#25d366' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
  </svg>
)

const Icon = {
  Wrench:      () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>,
  Check:       () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  CheckCircle: () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
  Star:        () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  ChevronDown: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>,
  ChevronRight:() => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>,
  Menu:        () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>,
  X:           () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Zap:         () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  Shield:      () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Globe:       () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  Phone:       () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.18h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 9a16 16 0 0 0 6.09 6.09l.71-.94a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>,
  Mail:        () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
  MapPin:      () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  Instagram:   () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>,
  Plus:        () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  ArrowRight:  () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>,
  TrendUp:     () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
}

// ─────────────────────────────────────────────────────────────────────
// Data
// ─────────────────────────────────────────────────────────────────────

const PLANS = {
  monthly: [
    {
      name: 'Starter', badge: null,
      price: 9990, desc: 'Ideal para empezar a ordenar tu taller',
      color: '#64748b',
      features: ['1 usuario', 'Órdenes de servicio', 'Clientes ilimitados', 'Stock básico', 'Impresión de tickets', 'Soporte por email'],
      cta: 'Empezar gratis',
    },
    {
      name: 'Pro', badge: 'Más elegido',
      price: 19990, desc: 'Para talleres en crecimiento con más control',
      color: '#6366f1',
      features: ['Hasta 5 usuarios', 'Todo lo de Starter', 'Finanzas completas', 'Cuentas corrientes', 'WhatsApp automático', 'Reportes avanzados', 'Multimoneda ARS/USD', 'Soporte prioritario'],
      cta: 'Suscribirme',
    },
    {
      name: 'Elite', badge: null,
      price: 34990, desc: 'Gestión total con facturación oficial',
      color: '#a855f7',
      features: ['Usuarios ilimitados', 'Todo lo de Pro', 'Facturación AFIP (ARCA)', 'Integraciones (MP, Excel)', 'API access', 'Soporte dedicado', 'Capacitación incluida', 'SLA garantizado'],
      cta: 'Suscribirme',
    },
  ],
  annual: [
    {
      name: 'Starter', badge: null,
      price: 7990, desc: 'Ideal para empezar a ordenar tu taller',
      color: '#64748b',
      features: ['1 usuario', 'Órdenes de servicio', 'Clientes ilimitados', 'Stock básico', 'Impresión de tickets', 'Soporte por email'],
      cta: 'Empezar gratis',
    },
    {
      name: 'Pro', badge: 'Más elegido',
      price: 15990, desc: 'Para talleres en crecimiento con más control',
      color: '#6366f1',
      features: ['Hasta 5 usuarios', 'Todo lo de Starter', 'Finanzas completas', 'Cuentas corrientes', 'WhatsApp automático', 'Reportes avanzados', 'Multimoneda ARS/USD', 'Soporte prioritario'],
      cta: 'Suscribirme',
    },
    {
      name: 'Elite', badge: null,
      price: 27990, desc: 'Gestión total con facturación oficial',
      color: '#a855f7',
      features: ['Usuarios ilimitados', 'Todo lo de Pro', 'Facturación AFIP (ARCA)', 'Integraciones (MP, Excel)', 'API access', 'Soporte dedicado', 'Capacitación incluida', 'SLA garantizado'],
      cta: 'Suscribirme',
    },
  ],
}

const FAQS = [
  { q: '¿Tiene prueba gratis?', a: 'Sí, ofrecemos 14 días de prueba gratuita con acceso completo al plan Pro, sin necesidad de tarjeta de crédito.' },
  { q: '¿Necesito tarjeta de crédito para registrarme?', a: 'No. Podés probar TechRepair Pro 14 días sin ingresar datos de pago. Solo te pedimos email y nombre del negocio.' },
  { q: '¿Puedo cancelar cuando quiera?', a: 'Claro. No hay contratos ni penalidades. Cancelás en cualquier momento desde tu panel de configuración, sin vueltas.' },
  { q: '¿Funciona desde el celular o tablet?', a: 'Sí, es 100% responsive. Podés gestionar órdenes, ver el stock y consultar finanzas desde cualquier dispositivo con internet.' },
  { q: '¿Incluye soporte técnico?', a: 'Todos los planes incluyen soporte. El plan Starter tiene soporte por email, el Pro es prioritario y el Elite incluye soporte dedicado con SLA.' },
  { q: '¿Puedo migrar mis datos actuales al sistema?', a: 'Sí. Te ayudamos a importar clientes, órdenes e inventario desde Excel o desde otros sistemas. El equipo de soporte te acompaña en el proceso.' },
]

// ─────────────────────────────────────────────────────────────────────
// Mock Dashboard component (hero visual)
// ─────────────────────────────────────────────────────────────────────

function MockDashboard() {
  const statCards = [
    { label: 'Órdenes hoy', value: '12', color: '#6366f1', icon: '📋', trend: '+3' },
    { label: 'Ingresos', value: '$48.500', color: '#10b981', icon: '💰', trend: '+12%' },
    { label: 'Clientes', value: '8', color: '#f59e0b', icon: '👥', trend: 'nuevos' },
  ]

  const orders = [
    { name: 'Juan García', device: 'iPhone 14 Pro', status: 'En reparación', statusColor: '#6366f1', statusBg: 'rgba(99,102,241,0.12)', price: '$15.000' },
    { name: 'María López', device: 'Samsung S23', status: 'Diagnóstico', statusColor: '#06b6d4', statusBg: 'rgba(6,182,212,0.12)', price: '$8.000' },
    { name: 'Pedro Díaz', device: 'Motorola G84', status: 'Listo ✓', statusColor: '#10b981', statusBg: 'rgba(16,185,129,0.12)', price: '$12.000' },
    { name: 'Ana Torres', device: 'Xiaomi 13T', status: 'Esperando', statusColor: '#f59e0b', statusBg: 'rgba(245,158,11,0.12)', price: '$5.500' },
  ]

  const sideIcons = ['📋', '👥', '📦', '💰', '📊', '⚙️']

  return (
    <div className="lp-float" style={{

      width: '100%',
      maxWidth: '560px',
      background: '#0d0d12',
      borderRadius: '1.25rem',
      border: '1px solid rgba(255,255,255,0.08)',
      boxShadow: '0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(99,102,241,0.08), inset 0 1px 0 rgba(255,255,255,0.04)',
      overflow: 'hidden',
      fontSize: '12px',
      fontFamily: 'Inter, sans-serif',
    }}>
      {/* Title bar */}
      <div style={{
        padding: '0.625rem 1rem',
        background: 'rgba(255,255,255,0.03)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
      }}>
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', opacity: 0.8 }} />
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#f59e0b', opacity: 0.8 }} />
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', opacity: 0.8 }} />
        <span style={{ marginLeft: '0.5rem', color: '#475569', fontSize: '11px' }}>TechRepair Pro — Dashboard</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%', background: '#22c55e',
            boxShadow: '0 0 6px #22c55e',
          }} />
          <span style={{ color: '#475569', fontSize: '10px' }}>En línea</span>
        </div>
      </div>

      <div style={{ display: 'flex', height: '320px' }}>
        {/* Sidebar */}
        <div style={{
          width: '44px',
          background: 'rgba(255,255,255,0.015)',
          borderRight: '1px solid rgba(255,255,255,0.05)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: '0.625rem',
          gap: '0.25rem',
        }}>
          {/* Cat logo at top */}
          <div style={{
            width: '28px', height: '28px', borderRadius: '7px',
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: '0.25rem', flexShrink: 0,
          }}>
            <CatLogoSVG size={18} />
          </div>
          {sideIcons.map((icon, i) => (
            <div key={i} style={{
              width: '28px', height: '28px',
              borderRadius: '0.4rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '12px',
              background: i === 0 ? 'rgba(99,102,241,0.2)' : 'transparent',
              cursor: 'default',
            }}>{icon}</div>
          ))}
        </div>

        {/* Main content */}
        <div style={{ flex: 1, padding: '0.875rem', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#94a3b8', fontWeight: 700, fontSize: '11px', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Resumen del día</span>
            <span style={{ color: '#475569', fontSize: '10px' }}>Hoy, {new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'short' })}</span>
          </div>

          {/* Stat cards */}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {statCards.map((card, i) => (
              <div key={i} style={{
                flex: 1,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '0.625rem',
                padding: '0.625rem',
              }}>
                <div style={{ color: '#475569', fontSize: '10px', marginBottom: '0.25rem' }}>{card.label}</div>
                <div style={{ color: card.color, fontWeight: 700, fontSize: '13px' }}>{card.value}</div>
                <div style={{ color: '#22c55e', fontSize: '9px', marginTop: '0.15rem' }}>↑ {card.trend}</div>
              </div>
            ))}
          </div>

          {/* Orders table */}
          <div style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.05)',
            borderRadius: '0.625rem',
            overflow: 'hidden',
            flex: 1,
          }}>
            <div style={{
              padding: '0.5rem 0.75rem',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span style={{ color: '#64748b', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Últimas órdenes</span>
              <span style={{ color: '#6366f1', fontSize: '9px', cursor: 'pointer' }}>Ver todas →</span>
            </div>
            {orders.map((order, i) => (
              <div key={i} style={{
                padding: '0.5rem 0.75rem',
                borderBottom: i < orders.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}>
                <div style={{
                  width: '22px', height: '22px', borderRadius: '50%',
                  background: 'rgba(99,102,241,0.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '10px', fontWeight: 700, color: '#818cf8', flexShrink: 0,
                }}>
                  {order.name.charAt(0)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{order.name}</div>
                  <div style={{ color: '#475569', fontSize: '9px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{order.device}</div>
                </div>
                <div style={{
                  padding: '0.15rem 0.4rem',
                  borderRadius: '999px',
                  background: order.statusBg,
                  color: order.statusColor,
                  fontSize: '9px',
                  fontWeight: 600,
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}>{order.status}</div>
                <div style={{ color: '#94a3b8', fontSize: '10px', fontWeight: 700, flexShrink: 0 }}>{order.price}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div style={{
        padding: '0.5rem 1rem',
        background: 'rgba(255,255,255,0.015)',
        borderTop: '1px solid rgba(255,255,255,0.05)',
        display: 'flex',
        gap: '1rem',
        alignItems: 'center',
      }}>
        {['📱 24 reparaciones activas', '📦 Stock: 142 items', '💵 Caja: $156.800'].map((item, i) => (
          <span key={i} style={{ color: '#475569', fontSize: '10px' }}>{item}</span>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────

function Header({ onNav }: { onNav: (id: string) => void }) {
  const navigate = useNavigate()
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const links = [
    { label: 'Inicio', id: 'hero' },
    { label: 'Funciones', id: 'features' },
    { label: 'Integraciones', id: 'integrations' },
    { label: 'Precios', id: 'pricing' },
    { label: 'FAQ', id: 'faq' },
  ]

  return (
    <header className={`lp-header${scrolled ? ' scrolled' : ''}`}>
      <div className="lp-header-inner">
        {/* Logo */}
        <a href="#hero" className="lp-logo" onClick={e => { e.preventDefault(); onNav('hero') }}>
          <div className="lp-logo-icon"><CatLogoSVG size={22} /></div>
          <span className="lp-logo-text">TechRepair<span>Pro</span></span>
        </a>

        {/* Nav */}
        <nav className="lp-nav">
          {links.map(l => (
            <a key={l.id} className="lp-nav-link" href={`#${l.id}`}
              onClick={e => { e.preventDefault(); onNav(l.id) }}>
              {l.label}
            </a>
          ))}
        </nav>

        {/* CTA */}
        <div className="lp-header-cta">
          <button className="lp-btn-outline lp-btn-sm" onClick={() => navigate('/login')}>
            Ingresar
          </button>
          <button className="lp-btn-primary lp-btn-sm" onClick={() => navigate('/login')}>
            Probar gratis
          </button>
          {/* Mobile menu button */}
          <button
            onClick={() => setMobileOpen(v => !v)}
            style={{
              display: 'none',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '0.5rem',
              padding: '0.5rem',
              color: '#94a3b8',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            className="lp-mobile-menu-btn"
          >
            {mobileOpen ? <Icon.X /> : <Icon.Menu />}
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {mobileOpen && (
        <div style={{
          position: 'absolute',
          top: '68px',
          left: 0,
          right: 0,
          background: 'rgba(9,9,11,0.97)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.25rem',
          backdropFilter: 'blur(20px)',
        }}>
          {links.map(l => (
            <a key={l.id} className="lp-nav-link" href={`#${l.id}`}
              style={{ padding: '0.75rem 1rem', borderRadius: '0.625rem' }}
              onClick={e => { e.preventDefault(); onNav(l.id); setMobileOpen(false) }}>
              {l.label}
            </a>
          ))}
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '0.5rem 0' }} />
          <button className="lp-btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => navigate('/login')}>
            Probar gratis — 14 días sin tarjeta
          </button>
        </div>
      )}
    </header>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Hero
// ─────────────────────────────────────────────────────────────────────

function Hero({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  return (
    <section id="hero" style={{
      padding: '8rem 2rem 5rem',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Background blobs */}
      <div style={{
        position: 'absolute', top: '-10%', left: '-5%',
        width: '60vw', height: '60vw', maxWidth: '700px', maxHeight: '700px',
        background: 'radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)',
        borderRadius: '50%', pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', bottom: '0%', right: '-10%',
        width: '50vw', height: '50vw', maxWidth: '550px', maxHeight: '550px',
        background: 'radial-gradient(circle, rgba(168,85,247,0.09) 0%, transparent 70%)',
        borderRadius: '50%', pointerEvents: 'none',
      }} />

      <div style={{ maxWidth: '1200px', margin: '0 auto', position: 'relative' }}>
        {/* Grid */}
        <div className="lp-hero-grid" style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '3rem',
          alignItems: 'center',
        }}>
          {/* Left column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
            {/* Badge */}
            <div className="lp-fade-up lp-d-0">
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.35rem 1rem',
                background: 'rgba(99,102,241,0.1)',
                border: '1px solid rgba(99,102,241,0.25)',
                borderRadius: '999px',
              }}>
                <span style={{ fontSize: '13px' }}>⚡</span>
                <span style={{ color: '#818cf8', fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.04em' }}>
                  Sistema en la nube · Listo para usar hoy
                </span>
              </div>
            </div>

            {/* Title */}
            <div className="lp-fade-up lp-d-1">
              <h1 style={{
                fontSize: 'clamp(2.25rem, 4.5vw, 3.5rem)',
                fontWeight: 900,
                lineHeight: 1.1,
                letterSpacing: '-0.04em',
                color: '#f8fafc',
                margin: 0,
              }}>
                Gestioná tu taller de celulares{' '}
                <span className="lp-gradient-text">de punta a punta</span>
              </h1>
            </div>

            {/* Subtitle */}
            <div className="lp-fade-up lp-d-2">
              <p style={{
                fontSize: '1.125rem',
                color: '#64748b',
                lineHeight: 1.7,
                margin: 0,
                maxWidth: '500px',
              }}>
                Órdenes, clientes, stock, finanzas, caja, comprobantes y WhatsApp en un solo sistema.
                Todo bajo control, desde cualquier lugar.
              </p>
            </div>

            {/* Bullets */}
            <div className="lp-fade-up lp-d-3" style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              {['Sin instalación, funciona en el navegador', 'Acceso desde cualquier dispositivo', 'Prueba gratis 14 días · Sin tarjeta de crédito'].map((b, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                  <div style={{
                    width: '18px', height: '18px', borderRadius: '50%',
                    background: 'rgba(16,185,129,0.15)',
                    border: '1px solid rgba(16,185,129,0.3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#10b981', flexShrink: 0,
                  }}>
                    <Icon.Check />
                  </div>
                  <span style={{ color: '#94a3b8', fontSize: '0.9rem' }}>{b}</span>
                </div>
              ))}
            </div>

            {/* Buttons */}
            <div className="lp-fade-up lp-d-4 lp-hero-btns" style={{ display: 'flex', gap: '0.875rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="lp-btn-primary lp-btn-lg" onClick={() => navigate('/login')}>
                Probar gratis
                <Icon.ArrowRight />
              </button>
              <button className="lp-btn-outline lp-btn-lg" onClick={() => document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' })}>
                Ver planes
              </button>
            </div>

            {/* Social proof */}
            <div className="lp-fade-up lp-d-5" style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
              <div style={{ display: 'flex' }}>
                {['J', 'M', 'P', 'A', 'C'].map((l, i) => (
                  <div key={i} style={{
                    width: '28px', height: '28px', borderRadius: '50%',
                    background: `hsl(${200 + i * 30}, 70%, 50%)`,
                    border: '2px solid #09090b',
                    marginLeft: i > 0 ? '-8px' : 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '11px', fontWeight: 700, color: '#fff',
                  }}>{l}</div>
                ))}
              </div>
              <div>
                <div style={{ display: 'flex', gap: '2px' }}>
                  {[1,2,3,4,5].map(i => <span key={i} style={{ color: '#f59e0b', fontSize: '12px' }}>★</span>)}
                </div>
                <span style={{ color: '#475569', fontSize: '0.78rem' }}>+200 talleres ya lo usan</span>
              </div>
            </div>
          </div>

          {/* Right column — Mock dashboard */}
          <div className="lp-mock-hide lp-fade-in lp-d-3" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <MockDashboard />
          </div>
        </div>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────
// WhatsApp Feature Banner (shown right after Hero)
// ─────────────────────────────────────────────────────────────────────

function WhatsAppBanner() {
  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 2rem 5rem' }}>
      <div style={{
        background: 'rgba(37,211,102,0.06)',
        border: '1px solid rgba(37,211,102,0.16)',
        borderRadius: '1.25rem',
        padding: '1.5rem 2rem',
        display: 'flex',
        alignItems: 'center',
        gap: '1.5rem',
      }}>
        {/* WhatsApp icon box */}
        <div style={{
          width: '52px', height: '52px',
          borderRadius: '0.875rem',
          background: 'rgba(37,211,102,0.12)',
          border: '1px solid rgba(37,211,102,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <WhatsAppSVG size={26} color="#25d366" />
        </div>

        {/* Text */}
        <div style={{ flex: 1 }}>
          <div style={{ color: '#4ade80', fontWeight: 700, fontSize: '0.9375rem', marginBottom: '0.2rem' }}>
            WhatsApp — Integración activa
          </div>
          <div style={{ color: '#475569', fontSize: '0.8125rem', lineHeight: 1.55 }}>
            Mensajes automáticos al cliente al cambiar el estado de la orden. El ícono ahora muestra el logo real de WhatsApp en todo el sistema.
          </div>
        </div>

        {/* Badge */}
        <div style={{
          padding: '0.25rem 0.75rem',
          background: 'rgba(34,197,94,0.1)',
          border: '1px solid rgba(34,197,94,0.25)',
          borderRadius: '999px',
          color: '#22c55e',
          fontSize: '0.72rem',
          fontWeight: 700,
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}>
          Activo
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// For Technicians
// ─────────────────────────────────────────────────────────────────────

function ForTechnicians() {
  const cards = [
    { icon: '🔧', title: 'Servicio técnico', desc: 'Órdenes, diagnóstico, seguimiento y entrega. Todo en un flujo claro.' },
    { icon: '📱', title: 'Venta de accesorios', desc: 'Stock automático, punto de venta, precios y proveedores integrados.' },
    { icon: '⚡', title: 'Microelectrónica', desc: 'Historial técnico, checklistpor equipo y notas internas por orden.' },
    { icon: '🏢', title: 'Gestión completa', desc: 'Finanzas, caja, usuarios, roles y reportes para tomar decisiones reales.' },
  ]

  return (
    <section style={{ background: 'rgba(255,255,255,0.015)', borderTop: '1px solid rgba(255,255,255,0.05)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="lp-section">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3.5rem', alignItems: 'center' }}>
          {/* Left */}
          <div>
            <div className="lp-section-label">💡 Hecho para vos</div>
            <h2 className="lp-section-title">
              Creado para talleres y locales de celulares
            </h2>
            <p className="lp-section-subtitle" style={{ marginBottom: '1.5rem' }}>
              No es un sistema genérico. Está diseñado para técnicos que necesitan controlar
              reparaciones, stock, ventas y finanzas en un solo lugar, sin perder tiempo.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {['Sin curva de aprendizaje', 'Todo en español', 'Soporte real'].map(t => (
                <span key={t} style={{
                  padding: '0.3rem 0.75rem',
                  background: 'rgba(99,102,241,0.08)',
                  border: '1px solid rgba(99,102,241,0.18)',
                  borderRadius: '999px',
                  color: '#818cf8',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                }}>{t}</span>
              ))}
            </div>
          </div>

          {/* Right — cards grid */}
          <div className="lp-for-tech-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            {cards.map((card, i) => (
              <div key={i} className="lp-glass" style={{
                padding: '1.375rem',
                borderRadius: '1rem',
              }}>
                <div style={{ fontSize: '1.75rem', marginBottom: '0.625rem' }}>{card.icon}</div>
                <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: '0.9375rem', marginBottom: '0.375rem' }}>{card.title}</div>
                <div style={{ color: '#475569', fontSize: '0.8125rem', lineHeight: 1.6 }}>{card.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Features
// ─────────────────────────────────────────────────────────────────────

function Features() {
  const blocks = [
    {
      icon: '📋', label: 'Operación',
      color: '#6366f1', colorBg: 'rgba(99,102,241,0.08)',
      title: 'Servicio técnico sin papel',
      items: ['Órdenes de servicio digitales', 'Seguimiento por estados', 'Firma del cliente', 'Impresión A4 y ticket', 'Historial completo de reparaciones', 'Notas internas y fotos'],
    },
    {
      icon: '📦', label: 'Inventario',
      color: '#10b981', colorBg: 'rgba(16,185,129,0.08)',
      title: 'Stock siempre actualizado',
      items: ['Control de stock automático', 'Productos con variantes', 'Múltiples listas de precios', 'Gestión de proveedores', 'Compras y movimientos', 'Alerta de stock mínimo'],
    },
    {
      icon: '💰', label: 'Finanzas',
      color: '#f59e0b', colorBg: 'rgba(245,158,11,0.08)',
      title: 'Finanzas reales del negocio',
      items: ['Caja diaria con corte', 'Gastos fijos y variables', 'Sueldos y retiros', 'Ganancia real automática', 'Tesorería ARS y USD', 'Cuentas corrientes'],
    },
    {
      icon: '⚙️', label: 'Administración',
      color: '#a855f7', colorBg: 'rgba(168,85,247,0.08)',
      title: 'Control total del negocio',
      items: ['Gestión de clientes', 'Historial por cliente', 'Usuarios y roles', 'Reportes completos', 'Comprobantes AFIP', 'Exportar a Excel'],
    },
  ]

  return (
    <section id="features" style={{ padding: '6rem 2rem' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '3.5rem' }}>
          <div className="lp-section-label" style={{ display: 'inline-flex', margin: '0 auto 1rem' }}>🚀 Funcionalidades</div>
          <h2 className="lp-section-title" style={{ textAlign: 'center' }}>
            Todo lo que necesitás, en un solo sistema
          </h2>
          <p className="lp-section-subtitle" style={{ textAlign: 'center', margin: '0 auto' }}>
            Desde la primera llamada del cliente hasta el cobro final. Sin hojas de cálculo, sin apuntes en papel, sin caos.
          </p>
        </div>

        <div className="lp-features-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
          {blocks.map((block, i) => (
            <div key={i} className="lp-glass" style={{
              padding: '1.75rem',
              borderRadius: '1.25rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1.25rem',
            }}>
              {/* Icon */}
              <div style={{
                width: '44px', height: '44px',
                borderRadius: '0.875rem',
                background: block.colorBg,
                border: `1px solid ${block.color}28`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '1.25rem',
              }}>{block.icon}</div>

              {/* Label */}
              <div>
                <div style={{
                  fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: block.color, marginBottom: '0.25rem',
                }}>{block.label}</div>
                <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: '1rem', lineHeight: 1.3 }}>
                  {block.title}
                </div>
              </div>

              {/* Items */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {block.items.map((item, j) => (
                  <div key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{
                      width: '14px', height: '14px', borderRadius: '50%',
                      background: block.colorBg, border: `1px solid ${block.color}30`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: block.color, flexShrink: 0, marginTop: '2px',
                    }}>
                      <Icon.Check />
                    </div>
                    <span style={{ color: '#64748b', fontSize: '0.8125rem', lineHeight: 1.5 }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Integrations
// ─────────────────────────────────────────────────────────────────────

function Integrations() {
  const active = [
    { icon: null, name: 'WhatsApp', desc: 'Mensajes automáticos al cliente al cambiar el estado de la orden', color: '#25d366', isWhatsApp: true },
    { icon: '🧾', name: 'Facturación AFIP', desc: 'Emisión de comprobantes electrónicos (A, B, C) con CAE real', color: '#4299e1' },
    { icon: '💳', name: 'Mercado Pago', desc: 'Registro de pagos y link de pago directo al cliente', color: '#009ee3' },
    { icon: '📊', name: 'Exportar a Excel', desc: 'Exportación de órdenes, clientes, stock e informes', color: '#217346' },
  ]

  const coming = [
    { icon: '🛒', name: 'Mercado Libre', desc: 'Gestión de ventas y stock desde el marketplace' },
    { icon: '🏪', name: 'Tienda Nube', desc: 'Sincronización automática con tu tienda online' },
    { icon: '🛍️', name: 'Shopify', desc: 'Conectá tu ecommerce con el inventario del taller' },
  ]

  return (
    <section id="integrations" style={{
      background: 'rgba(255,255,255,0.012)',
      borderTop: '1px solid rgba(255,255,255,0.05)',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
      padding: '6rem 2rem',
    }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <div className="lp-section-label" style={{ display: 'inline-flex', margin: '0 auto 1rem' }}>🔗 Integraciones</div>
          <h2 className="lp-section-title" style={{ textAlign: 'center' }}>
            Integraciones que potencian tu negocio
          </h2>
          <p className="lp-section-subtitle" style={{ textAlign: 'center', margin: '0 auto' }}>
            Conectado con las herramientas que ya usás, sin complicaciones.
          </p>
        </div>

        {/* Active */}
        <div style={{ marginBottom: '2.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e' }} />
            <span style={{ color: '#22c55e', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Disponibles ahora</span>
          </div>
          <div className="lp-integrations-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
            {active.map((int, i) => (
              <div key={i} className="lp-integration-card">
                <div style={{
                  width: '44px', height: '44px', borderRadius: '0.75rem',
                  background: `${int.color}18`,
                  border: `1px solid ${int.color}30`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.375rem', flexShrink: 0,
                }}>
                  {(int as any).isWhatsApp
                    ? <WhatsAppSVG size={26} color="#25d366" />
                    : int.icon}
                </div>
                <div>
                  <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: '0.9375rem', marginBottom: '0.2rem' }}>{int.name}</div>
                  <div style={{ color: '#475569', fontSize: '0.8rem', lineHeight: 1.5 }}>{int.desc}</div>
                </div>
                <div style={{
                  marginLeft: 'auto', flexShrink: 0,
                  padding: '0.2rem 0.6rem',
                  background: 'rgba(34,197,94,0.1)',
                  border: '1px solid rgba(34,197,94,0.25)',
                  borderRadius: '999px',
                  color: '#22c55e', fontSize: '0.72rem', fontWeight: 700,
                }}>Activo</div>
              </div>
            ))}
          </div>
        </div>

        {/* Coming soon */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#f59e0b' }} />
            <span style={{ color: '#f59e0b', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Próximamente</span>
          </div>
          <div className="lp-integrations-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', opacity: 0.55 }}>
            {coming.map((int, i) => (
              <div key={i} className="lp-integration-card" style={{ cursor: 'default' }}>
                <div style={{
                  width: '40px', height: '40px', borderRadius: '0.75rem',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.25rem', flexShrink: 0,
                }}>{int.icon}</div>
                <div>
                  <div style={{ color: '#94a3b8', fontWeight: 700, fontSize: '0.875rem', marginBottom: '0.2rem' }}>{int.name}</div>
                  <div style={{ color: '#334155', fontSize: '0.78rem', lineHeight: 1.5 }}>{int.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Benefits
// ─────────────────────────────────────────────────────────────────────

function Benefits() {
  const benefits = [
    { icon: '🎯', title: 'Pensado para tu rubro', desc: 'Cada función fue diseñada con técnicos reales, no con consultores de software.' },
    { icon: '🗂️', title: 'Todo en un solo lugar', desc: 'Nada de abrir 5 apps distintas. El negocio completo en una sola pantalla.' },
    { icon: '📱', title: 'Desde cualquier dispositivo', desc: 'Celular, tablet, notebook o PC. Solo necesitás internet y el sistema.' },
    { icon: '🤝', title: 'Soporte humano real', desc: 'No bots. Una persona de soporte que conoce el sistema y te ayuda a usarlo.' },
    { icon: '☁️', title: 'Sistema en la nube', desc: 'Tus datos siempre seguros, con backup automático. Sin instalaciones.' },
    { icon: '📈', title: 'Crecés sin límites', desc: 'Podés empezar con 1 técnico y escalar a múltiples locales con el mismo sistema.' },
  ]

  return (
    <section style={{ padding: '6rem 2rem' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '3.5rem' }}>
          <div className="lp-section-label" style={{ display: 'inline-flex', margin: '0 auto 1rem' }}>✨ Por qué elegirnos</div>
          <h2 className="lp-section-title" style={{ textAlign: 'center' }}>
            Más control, menos caos
          </h2>
        </div>

        <div className="lp-benefits-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
          {benefits.map((b, i) => (
            <div key={i} className="lp-benefit-card">
              <div style={{ fontSize: '1.875rem', marginBottom: '0.875rem' }}>{b.icon}</div>
              <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: '0.9375rem', marginBottom: '0.375rem' }}>{b.title}</div>
              <div style={{ color: '#475569', fontSize: '0.8125rem', lineHeight: 1.65 }}>{b.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Pricing
// ─────────────────────────────────────────────────────────────────────

function Pricing({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  const [billing, setBilling] = useState<'monthly' | 'annual'>('monthly')
  const plans = PLANS[billing]

  return (
    <section id="pricing" style={{
      background: 'rgba(255,255,255,0.012)',
      borderTop: '1px solid rgba(255,255,255,0.05)',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
      padding: '6rem 2rem',
    }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <div className="lp-section-label" style={{ display: 'inline-flex', margin: '0 auto 1rem' }}>💎 Planes</div>
          <h2 className="lp-section-title" style={{ textAlign: 'center' }}>
            Elegí el plan ideal para tu negocio
          </h2>
          <p className="lp-section-subtitle" style={{ textAlign: 'center', margin: '0 auto 1.75rem' }}>
            Empezá gratis 14 días y luego elegí el plan que más te convenga. Sin sorpresas.
          </p>

          {/* Toggle */}
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.875rem' }}>
            <div className="lp-toggle-track">
              <button className={`lp-toggle-opt${billing === 'monthly' ? ' active' : ''}`} onClick={() => setBilling('monthly')}>
                Mensual
              </button>
              <button className={`lp-toggle-opt${billing === 'annual' ? ' active' : ''}`} onClick={() => setBilling('annual')}>
                Anual
              </button>
            </div>
            {billing === 'annual' && (
              <span style={{
                padding: '0.25rem 0.625rem',
                background: 'rgba(16,185,129,0.1)',
                border: '1px solid rgba(16,185,129,0.25)',
                borderRadius: '999px',
                color: '#10b981', fontSize: '0.75rem', fontWeight: 700,
              }}>
                Ahorrás 20%
              </span>
            )}
          </div>
        </div>

        {/* Plans grid */}
        <div className="lp-plans-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.25rem', alignItems: 'start' }}>
          {plans.map((plan, i) => (
            <div key={i} className={`lp-plan-card${plan.badge ? ' lp-plan-featured' : ''}`}>
              {/* Featured badge */}
              {plan.badge && (
                <div style={{
                  position: 'absolute', top: '-1px', left: '50%', transform: 'translateX(-50%)',
                  background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  color: '#fff', fontSize: '0.7rem', fontWeight: 800,
                  padding: '0.25rem 1rem', borderRadius: '0 0 0.625rem 0.625rem',
                  letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                  boxShadow: '0 4px 12px rgba(99,102,241,0.4)',
                }}>
                  ⭐ {plan.badge}
                </div>
              )}

              {/* Plan name */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                  <div style={{
                    width: '10px', height: '10px', borderRadius: '50%',
                    background: plan.color, boxShadow: `0 0 8px ${plan.color}60`,
                  }} />
                  <span style={{ color: plan.color, fontSize: '0.8rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {plan.name}
                  </span>
                </div>
                <p style={{ color: '#475569', fontSize: '0.8125rem', margin: 0, lineHeight: 1.5 }}>{plan.desc}</p>
              </div>

              {/* Price */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.25rem' }}>
                <span style={{ color: '#64748b', fontSize: '1.125rem', fontWeight: 600 }}>$</span>
                <span style={{ color: '#f8fafc', fontSize: '2.375rem', fontWeight: 900, letterSpacing: '-0.03em' }}>
                  {plan.price.toLocaleString('es-AR')}
                </span>
                <span style={{ color: '#475569', fontSize: '0.875rem' }}>/mes</span>
              </div>

              {/* Features */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
                {plan.features.map((feat, j) => (
                  <div key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{
                      width: '16px', height: '16px', borderRadius: '50%',
                      background: plan.badge ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.05)',
                      border: `1px solid ${plan.badge ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.1)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: plan.badge ? '#818cf8' : '#64748b',
                      flexShrink: 0, marginTop: '2px',
                    }}>
                      <Icon.Check />
                    </div>
                    <span style={{ color: '#64748b', fontSize: '0.8125rem', lineHeight: 1.5 }}>{feat}</span>
                  </div>
                ))}
              </div>

              {/* CTA */}
              <button
                className={plan.badge ? 'lp-btn-primary' : 'lp-btn-outline'}
                style={{ width: '100%', justifyContent: 'center', ...(plan.badge ? {} : { borderColor: 'rgba(255,255,255,0.1)' }) }}
                onClick={() => navigate('/login')}
              >
                {plan.cta}
              </button>

              {plan.name === 'Starter' && (
                <p style={{ textAlign: 'center', color: '#334155', fontSize: '0.75rem', margin: '-0.5rem 0 0' }}>
                  14 días gratis incluidos
                </p>
              )}
            </div>
          ))}
        </div>

        <p style={{ textAlign: 'center', color: '#334155', fontSize: '0.8125rem', marginTop: '2rem' }}>
          Todos los planes incluyen 14 días de prueba gratis · Sin tarjeta de crédito · Cancelás cuando querés
        </p>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────
// FAQ
// ─────────────────────────────────────────────────────────────────────

function FAQ() {
  const [open, setOpen] = useState<number | null>(null)

  return (
    <section id="faq" style={{ padding: '6rem 2rem' }}>
      <div style={{ maxWidth: '700px', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <div className="lp-section-label" style={{ display: 'inline-flex', margin: '0 auto 1rem' }}>❓ Preguntas frecuentes</div>
          <h2 className="lp-section-title" style={{ textAlign: 'center' }}>
            Dudas frecuentes
          </h2>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {FAQS.map((faq, i) => (
            <div key={i} className="lp-faq-item">
              <button className="lp-faq-btn" onClick={() => setOpen(open === i ? null : i)}>
                <span>{faq.q}</span>
                <div className={`lp-faq-icon${open === i ? ' open' : ''}`}>+</div>
              </button>
              <div className={`lp-faq-answer${open === i ? ' open' : ''}`}>
                {faq.a}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────
// CTA Final
// ─────────────────────────────────────────────────────────────────────

function CTAFinal({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  return (
    <section style={{ padding: '6rem 2rem', position: 'relative', overflow: 'hidden' }}>
      {/* Glow */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '600px', height: '300px',
        background: 'radial-gradient(ellipse, rgba(99,102,241,0.18) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      <div style={{ maxWidth: '720px', margin: '0 auto', textAlign: 'center', position: 'relative' }}>
        {/* Badge */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
          padding: '0.375rem 1rem',
          background: 'rgba(99,102,241,0.1)',
          border: '1px solid rgba(99,102,241,0.25)',
          borderRadius: '999px', marginBottom: '1.5rem',
        }}>
          <Icon.Zap />
          <span style={{ color: '#818cf8', fontSize: '0.8rem', fontWeight: 700 }}>Empezá en menos de 5 minutos</span>
        </div>

        <h2 style={{
          fontSize: 'clamp(2rem, 4vw, 3rem)',
          fontWeight: 900,
          letterSpacing: '-0.04em',
          lineHeight: 1.15,
          color: '#f8fafc',
          margin: '0 0 1rem',
        }}>
          Empezá a ordenar tu negocio hoy
        </h2>

        <p style={{
          fontSize: '1.125rem',
          color: '#64748b',
          lineHeight: 1.7,
          marginBottom: '2.25rem',
        }}>
          Probalo gratis 14 días y empezá a tener control total de tu taller.
          Sin tarjeta, sin compromisos, sin complicaciones.
        </p>

        <div className="lp-cta-btns" style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="lp-btn-primary lp-btn-lg" onClick={() => navigate('/login')}>
            Probar gratis — 14 días
            <Icon.ArrowRight />
          </button>
          <button className="lp-btn-outline lp-btn-lg"
            onClick={() => document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' })}>
            Ver planes y precios
          </button>
        </div>

        <p style={{ color: '#334155', fontSize: '0.8125rem', marginTop: '1.25rem' }}>
          ✓ Sin tarjeta  &nbsp;·&nbsp;  ✓ Cancelás cuando quieras  &nbsp;·&nbsp;  ✓ Soporte incluido
        </p>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Footer
// ─────────────────────────────────────────────────────────────────────

function Footer() {
  const cols = [
    {
      title: 'Producto',
      links: ['Funcionalidades', 'Integraciones', 'Precios', 'Changelog', 'Roadmap'],
    },
    {
      title: 'Soporte',
      links: ['Centro de ayuda', 'Guías de uso', 'Soporte por WhatsApp', 'Estado del sistema'],
    },
    {
      title: 'Legal',
      links: ['Términos de uso', 'Privacidad', 'Cookies'],
    },
  ]

  return (
    <footer className="lp-footer">
      <div className="lp-footer-inner">
        <div className="lp-footer-grid" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: '3rem', marginBottom: '3rem' }}>
          {/* Brand */}
          <div>
            <div className="lp-logo" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
              <div className="lp-logo-icon"><CatLogoSVG size={22} /></div>
              <span className="lp-logo-text">TechRepair<span className="lp-gradient-text">Pro</span></span>
            </div>
            <p style={{ color: '#334155', fontSize: '0.8125rem', lineHeight: 1.7, marginBottom: '1.25rem', maxWidth: '280px' }}>
              El sistema de gestión diseñado para talleres y locales de celulares. Control total desde cualquier dispositivo.
            </p>
            {/* Contact */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {[
                { icon: <Icon.Phone />, text: '+54 11 1234-5678' },
                { icon: <Icon.Mail />, text: 'hola@techrepairpro.com.ar' },
                { icon: <Icon.MapPin />, text: 'Buenos Aires, Argentina' },
              ].map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#334155', fontSize: '0.8rem' }}>
                  <span style={{ color: '#475569' }}>{c.icon}</span>
                  {c.text}
                </div>
              ))}
            </div>
          </div>

          {/* Nav cols */}
          {cols.map((col, i) => (
            <div key={i}>
              <div style={{ color: '#94a3b8', fontWeight: 700, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '1rem' }}>
                {col.title}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {col.links.map(l => (
                  <a key={l} href="#" style={{
                    color: '#334155', fontSize: '0.8125rem',
                    transition: 'color 0.15s ease', textDecoration: 'none',
                  }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#818cf8')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#334155')}
                  >{l}</a>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <hr className="lp-divider" />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
          <span style={{ color: '#1e293b', fontSize: '0.78rem' }}>
            © {new Date().getFullYear()} TechRepair Pro. Todos los derechos reservados.
          </span>

          {/* Social */}
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            {[
              { icon: '💬', label: 'WhatsApp', href: 'https://wa.me/541112345678' },
              { icon: '📸', label: 'Instagram', href: '#' },
              { icon: '✉️', label: 'Email', href: 'mailto:hola@techrepairpro.com.ar' },
            ].map(s => (
              <a key={s.label} href={s.href} target="_blank" rel="noopener noreferrer"
                style={{
                  width: '34px', height: '34px', borderRadius: '0.5rem',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '15px',
                  transition: 'background 0.2s ease, border-color 0.2s ease',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLElement
                  el.style.background = 'rgba(99,102,241,0.1)'
                  el.style.borderColor = 'rgba(99,102,241,0.3)'
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLElement
                  el.style.background = 'rgba(255,255,255,0.04)'
                  el.style.borderColor = 'rgba(255,255,255,0.07)'
                }}
                title={s.label}
              >{s.icon}</a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Scroll-to-section helper
// ─────────────────────────────────────────────────────────────────────

function scrollTo(id: string) {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────

export function LandingPage() {
  const navigate = useNavigate()

  return (
    <div className="landing-root">
      <Header onNav={scrollTo} />
      <main>
        <Hero navigate={navigate} />
        <WhatsAppBanner />
        <hr className="lp-divider" />
        <ForTechnicians />
        <hr className="lp-divider" />
        <Features />
        <hr className="lp-divider" />
        <Integrations />
        <hr className="lp-divider" />
        <Benefits />
        <hr className="lp-divider" />
        <Pricing navigate={navigate} />
        <hr className="lp-divider" />
        <FAQ />
        <hr className="lp-divider" />
        <CTAFinal navigate={navigate} />
      </main>
      <Footer />
    </div>
  )
}

export default LandingPage
