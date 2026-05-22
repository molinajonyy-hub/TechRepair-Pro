import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import '../css/landing.css'

// ─── Contacto — actualizar antes del lanzamiento ──────────────────────────────
const CONTACT = {
  whatsapp:    '5491112345678',
  email:       'hola@techrepairpro.app',
  instagram:   'techrepairpro',
  whatsappMsg: 'Hola!%20Quiero%20m%C3%A1s%20info%20sobre%20TechRepair%20Pro',
}


// ─── Icons (inline SVG) ───────────────────────────────────────────────────────
const IC = {
  Menu:         () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>,
  X:            () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Check:        () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>,
  ArrowRight:   () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>,
  ChevronDown:  () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>,
  Zap:          () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  Wrench:       () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>,
  Package:      () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>,
  Receipt:      () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>,
  Users:        () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  TrendUp:      () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
  Shield:       () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Smartphone:   () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>,
  DollarSign:   () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  Wallet:       () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>,
  MessageCircle:() => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  Star:         () => <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  Instagram:    () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>,
}

const WhatsAppSVG = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="#25d366">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
  </svg>
)

const CatLogoSVG = ({ size = 24 }: { size?: number }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} fill="none">
    <path d="M18 46 L25 14 L38 36 Q50 30 62 36 L75 14 L82 46 Q86 60 82 70 Q70 88 50 88 Q30 88 18 70 Q14 60 18 46 Z" fill="white" opacity="0.93"/>
    <path d="M26 18 L20 43 L37 36 Z" fill="#6366f1" opacity="0.45"/>
    <path d="M74 18 L80 43 L63 36 Z" fill="#6366f1" opacity="0.45"/>
    <ellipse cx="37" cy="58" rx="5.5" ry="5" fill="#6366f1" opacity="0.8"/>
    <ellipse cx="63" cy="58" rx="5.5" ry="5" fill="#6366f1" opacity="0.8"/>
  </svg>
)

// ─── Mock Dashboard Visual ────────────────────────────────────────────────────
function MockDashboard() {
  return (
    <div className="lp-mock-wrap" aria-hidden="true">
      <div className="lp-mock-glow" />
      <div className="lp-mock-screen">
        {/* Top bar — imita el header del sistema real */}
        <div className="lp-mock-topbar">
          <div className="lp-mock-dots"><span/><span/><span/></div>
          <div className="lp-mock-topbar-logo">
            <svg viewBox="0 0 100 100" width="14" height="14" fill="none">
              <path d="M18 46 L25 14 L38 36 Q50 30 62 36 L75 14 L82 46 Q86 60 82 70 Q70 88 50 88 Q30 88 18 70 Q14 60 18 46 Z" fill="white" opacity="0.9"/>
              <ellipse cx="37" cy="58" rx="5" ry="4.5" fill="#818cf8"/>
              <ellipse cx="63" cy="58" rx="5" ry="4.5" fill="#818cf8"/>
            </svg>
            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#94a3b8' }}>TechRepair Pro</span>
          </div>
          <div className="lp-mock-badge lp-badge-green" style={{ fontSize: '0.62rem' }}>● Activo</div>
        </div>

        {/* KPI row — datos reales del sistema */}
        <div className="lp-mock-stats">
          {[
            { label: 'Órdenes activas', value: '24', color: '#818cf8', icon: '🔧' },
            { label: 'Caja del día', value: '$142.5k', color: '#34d399', icon: '💰' },
            { label: 'Stock bajo', value: '3 items', color: '#fbbf24', icon: '⚠' },
          ].map(s => (
            <div key={s.label} className="lp-mock-stat">
              <div style={{ fontSize: '0.8rem', marginBottom: '0.2rem' }}>{s.icon}</div>
              <div className="lp-mock-stat-val" style={{ color: s.color }}>{s.value}</div>
              <div className="lp-mock-stat-lbl">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Tabs — como en el sistema real */}
        <div className="lp-mock-tabs">
          {['Órdenes', 'Comprobantes', 'Inventario', 'Caja'].map((t, i) => (
            <div key={t} className={`lp-mock-tab ${i === 0 ? 'lp-mock-tab-active' : ''}`}>{t}</div>
          ))}
        </div>

        {/* Order list — imitando orden de trabajo real */}
        <div className="lp-mock-orders">
          {[
            { device: 'iPhone 14 Pro', brand: 'Apple · Pantalla rota', status: 'En reparación', color: '#818cf8' },
            { device: 'Galaxy S23', brand: 'Samsung · Batería', status: 'Listo ✓', color: '#34d399' },
            { device: 'Redmi Note 12', brand: 'Xiaomi · No enciende', status: 'Diagnóstico', color: '#fbbf24' },
            { device: 'Moto G84', brand: 'Motorola · Carga rota', status: 'Recibido', color: '#60a5fa' },
          ].map((o, i) => (
            <div key={i} className="lp-mock-order">
              <div className="lp-mock-order-icon">📱</div>
              <div className="lp-mock-order-info">
                <div className="lp-mock-order-device">{o.device}</div>
                <div className="lp-mock-order-brand">{o.brand}</div>
              </div>
              <div className="lp-mock-badge" style={{ color: o.color, background: o.color + '15', borderColor: o.color + '30', fontSize: '0.62rem' }}>
                {o.status}
              </div>
            </div>
          ))}
        </div>

        {/* Finance bar — como en finanzas del sistema */}
        <div className="lp-mock-finance">
          <div className="lp-mock-finance-row">
            <span>Ingresos del mes</span>
            <span style={{ color: '#34d399', fontWeight: 700 }}>$1.840.000</span>
          </div>
          <div className="lp-mock-bar-track">
            <div className="lp-mock-bar-fill" style={{ width: '72%', background: 'linear-gradient(90deg, #6366f1, #34d399)' }}/>
          </div>
          <div className="lp-mock-finance-row" style={{ marginTop: '0.375rem' }}>
            <span style={{ color: '#334155', fontSize: '0.62rem' }}>Facturación ARCA: 8 comp.</span>
            <span style={{ color: '#334155', fontSize: '0.62rem' }}>WhatsApp: 12 enviados</span>
          </div>
        </div>
      </div>

      {/* Tarjeta flotante — simula notificación/comprobante real */}
      <div className="lp-mock-mobile">
        <div className="lp-mock-mobile-top">
          <div className="lp-mock-mobile-icon">🧾</div>
          <div>
            <div className="lp-mock-mobile-title">Comp. N° 00000042</div>
            <div className="lp-mock-mobile-sub">$38.500 · efectivo</div>
          </div>
        </div>
        <div className="lp-mock-badge lp-badge-green" style={{ fontSize: '0.62rem' }}>Emitido ✓</div>
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function Badge({ children, color = 'indigo' }: { children: React.ReactNode; color?: 'indigo' | 'green' | 'cyan' | 'amber' }) {
  const map = { indigo: '#818cf8', green: '#34d399', cyan: '#22d3ee', amber: '#fbbf24' }
  const c = map[color]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', fontWeight: 700, padding: '0.3rem 0.75rem', borderRadius: '999px', background: c + '15', border: `1px solid ${c}30`, color: c, letterSpacing: '0.03em' }}>
      {children}
    </span>
  )
}

function SectionLabel({ children, color = 'indigo' }: { children: React.ReactNode; color?: 'indigo' | 'green' | 'cyan' }) {
  const map: Record<string, [string, string, string]> = {
    indigo: ['#818cf8', 'rgba(99,102,241,0.1)', 'rgba(99,102,241,0.2)'],
    green:  ['#34d399', 'rgba(52,211,153,0.08)', 'rgba(52,211,153,0.2)'],
    cyan:   ['#22d3ee', 'rgba(6,182,212,0.08)', 'rgba(6,182,212,0.2)'],
  }
  const [c, bg, br] = map[color]
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.72rem', fontWeight: 700, color: c, textTransform: 'uppercase', letterSpacing: '0.12em', padding: '0.35rem 1rem', borderRadius: '999px', background: bg, border: `1px solid ${br}`, marginBottom: '1.25rem' }}>
      {children}
    </div>
  )
}

function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', fontSize: '0.9rem', color: '#94a3b8' }}>
      <span style={{ color: '#34d399', flexShrink: 0 }}><IC.Check /></span>
      {children}
    </li>
  )
}

// ─── HEADER ───────────────────────────────────────────────────────────────────
function Header({ onNav }: { onNav: (id: string) => void }) {
  const navigate = useNavigate()
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', fn, { passive: true })
    return () => window.removeEventListener('scroll', fn)
  }, [])

  const links = [
    { label: 'Funciones', id: 'features' },
    { label: 'Planes', id: 'pricing' },
    { label: 'FAQ', id: 'faq' },
  ]

  return (
    <header className={`lp-header${scrolled ? ' scrolled' : ''}`} style={{ position: 'sticky', top: 0, zIndex: 1000 }}>
      <div className="lp-header-inner">
        <a href="#hero" className="lp-logo" onClick={e => { e.preventDefault(); onNav('hero') }}>
          <div className="lp-logo-icon"><CatLogoSVG size={22} /></div>
          <span className="lp-logo-text">TechRepair<span>Pro</span></span>
        </a>

        <nav className="lp-nav">
          {links.map(l => (
            <a key={l.id} className="lp-nav-link" href={`#${l.id}`} onClick={e => { e.preventDefault(); onNav(l.id) }}>
              {l.label}
            </a>
          ))}
          <a href={`https://wa.me/${CONTACT.whatsapp}?text=${CONTACT.whatsappMsg}`} className="lp-nav-link" target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <WhatsAppSVG size={16} /> Demo
          </a>
        </nav>

        <div className="lp-header-cta">
          <button className="lp-btn-outline lp-btn-sm" onClick={() => navigate('/login')} aria-label="Iniciar sesión">
            Ingresar
          </button>
          <button className="lp-btn-primary lp-btn-sm" onClick={() => navigate('/onboarding')} aria-label="Probar gratis 14 días">
            Probar gratis
          </button>
          <button className="lp-mobile-menu-btn" onClick={() => setMenuOpen(v => !v)} aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}>
            {menuOpen ? <IC.X /> : <IC.Menu />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="lp-mobile-menu">
          {links.map(l => (
            <a key={l.id} className="lp-mobile-menu-link" href={`#${l.id}`} onClick={e => { e.preventDefault(); onNav(l.id); setMenuOpen(false) }}>
              {l.label}
            </a>
          ))}
          <div className="lp-mobile-menu-sep" />
          <button className="lp-btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => navigate('/onboarding')}>
            Probar gratis — 14 días sin tarjeta
          </button>
          <button className="lp-btn-outline" style={{ width: '100%', justifyContent: 'center', marginTop: '0.5rem' }} onClick={() => navigate('/login')}>
            Ingresar
          </button>
        </div>
      )}
    </header>
  )
}

// ─── HERO ─────────────────────────────────────────────────────────────────────
function Hero({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  return (
    <section id="hero" className="lp-hero">
      {/* Background orbs */}
      <div className="lp-orb lp-orb-1" />
      <div className="lp-orb lp-orb-2" />
      <div className="lp-orb lp-orb-3" />

      <div className="lp-hero-inner">
        <div className="lp-hero-content">
          <div className="lp-fade-up" style={{ animationDelay: '0ms' }}>
            <Badge color="indigo">⚡ Para servicios técnicos y locales de celulares</Badge>
          </div>

          <h1 className="lp-hero-title lp-fade-up" style={{ animationDelay: '80ms' }}>
            Gestioná tu servicio técnico<br />
            o local de celulares{' '}
            <span className="lp-gradient-text">como una empresa pro</span>
          </h1>

          <p className="lp-hero-subtitle lp-fade-up" style={{ animationDelay: '160ms' }}>
            Órdenes de reparación, ventas, clientes, inventario, caja, proveedores, facturación ARCA,
            garantías, WhatsApp y finanzas en un solo sistema.
          </p>

          <div className="lp-hero-ctas lp-fade-up" style={{ animationDelay: '240ms' }}>
            <button className="lp-btn-primary lp-btn-lg" onClick={() => navigate('/onboarding')} aria-label="Probar gratis 14 días">
              Probar gratis 14 días <IC.ArrowRight />
            </button>
            <a href={`https://wa.me/${CONTACT.whatsapp}?text=${CONTACT.whatsappMsg}`} className="lp-btn-outline lp-btn-lg" target="_blank" rel="noopener noreferrer" aria-label="Ver demo en WhatsApp">
              <WhatsAppSVG size={18} /> Ver demo
            </a>
          </div>

          <div className="lp-hero-badges lp-fade-up" style={{ animationDelay: '320ms' }}>
            <Badge color="green">✓ Sin tarjeta para probar</Badge>
            <Badge color="indigo">✓ Facturación ARCA</Badge>
            <Badge color="cyan">✓ Inventario + caja</Badge>
          </div>
        </div>

        <div className="lp-hero-visual lp-fade-up" style={{ animationDelay: '200ms' }}>
          <MockDashboard />
        </div>
      </div>
    </section>
  )
}

// ─── PROBLEM ──────────────────────────────────────────────────────────────────
function ProblemSection() {
  const problems = [
    '📋 Órdenes anotadas en papel o perdidas',
    '📦 Stock desordenado sin saber qué entra y sale',
    '💸 Caja que no cierra ni cuadra',
    '👤 Clientes sin historial de lo que trajeron',
    '🔩 Repuestos que no se descuentan del inventario',
    '🏭 Proveedores sin control de deuda ni pagos',
    '🧾 Facturas y notas de crédito difíciles de seguir',
    '📱 WhatsApps mezclados sin registro',
  ]
  return (
    <section id="problem" className="lp-section lp-section-alt">
      <div className="lp-container">
        <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <SectionLabel>El problema real</SectionLabel>
          <h2 className="lp-section-title">
            Cuando el taller crece,<br />
            <span className="lp-gradient-text">la planilla queda chica</span>
          </h2>
        </div>

        <div className="lp-problem-grid">
          {problems.map((p, i) => (
            <div key={i} className="lp-problem-item lp-fade-up" style={{ animationDelay: `${i * 60}ms` }}>
              <span>{p}</span>
            </div>
          ))}
        </div>

        <div className="lp-problem-cta">
          <p className="lp-problem-close">
            TechRepair Pro centraliza todo para que cada reparación, venta y movimiento quede registrado y visible desde cualquier dispositivo.
          </p>
        </div>
      </div>
    </section>
  )
}

// ─── FLOW ─────────────────────────────────────────────────────────────────────
function FlowSection() {
  const steps = [
    { n: '01', icon: '📥', title: 'Recibís el equipo', desc: 'Seleccionás marca y modelo. Si no existen, los creás y quedan guardados para siempre.' },
    { n: '02', icon: '👤', title: 'Registrás el cliente', desc: 'Con historial completo: órdenes anteriores, compras y cuenta corriente.' },
    { n: '03', icon: '🔍', title: 'Diagnóstico y presupuesto', desc: 'Cargás el problema, asignás técnico y establecés un presupuesto estimado.' },
    { n: '04', icon: '🔩', title: 'Repuestos y servicios', desc: 'Agregás los repuestos del inventario. El stock se descuenta automáticamente.' },
    { n: '05', icon: '📱', title: 'Avisás por WhatsApp', desc: 'Mensajes pre-armados para cada estado: recibido, listo, en espera, entregado.' },
    { n: '06', icon: '💰', title: 'Cobrás y emitís comprobante', desc: 'Venta rápida con múltiples métodos de pago. Factura ARCA si corresponde.' },
    { n: '07', icon: '📊', title: 'Impacta en caja y finanzas', desc: 'Cada cobro actualiza caja, finanzas, stock y cuenta corriente del cliente.' },
  ]
  return (
    <section id="flow" className="lp-section">
      <div className="lp-container">
        <div style={{ textAlign: 'center', marginBottom: '3.5rem' }}>
          <SectionLabel>El flujo completo</SectionLabel>
          <h2 className="lp-section-title">
            Del ingreso del equipo<br />
            <span className="lp-gradient-text">al cobro final</span>
          </h2>
          <p className="lp-section-subtitle">Todo conectado, sin pasos en el aire.</p>
        </div>

        <div className="lp-flow-grid">
          {steps.map((s, i) => (
            <div key={i} className="lp-flow-step lp-fade-up" style={{ animationDelay: `${i * 70}ms` }}>
              <div className="lp-flow-number">{s.n}</div>
              <div className="lp-flow-icon">{s.icon}</div>
              <h3 className="lp-flow-title">{s.title}</h3>
              <p className="lp-flow-desc">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── SCALABILITY ─────────────────────────────────────────────────────────────
function ScalabilitySection({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  const stages = [
    {
      plan: 'Básico', price: '$15.000/mes', color: '#64748b',
      title: 'Para ordenar el inicio',
      items: ['Órdenes y clientes', 'Inventario básico', 'Caja diaria', 'Comprobantes locales'],
    },
    {
      plan: 'Pro', price: '$25.000/mes', color: '#818cf8',
      title: 'Para operar con más control',
      items: ['Todo lo del Básico', 'ARCA / Facturación', 'Finanzas avanzadas', 'Proveedores, WhatsApp', 'Mi Guita incluido'],
      highlight: true,
    },
    {
      plan: 'Full', price: '$45.000/mes', color: '#22d3ee',
      title: 'Para escalar con equipo',
      items: ['Todo lo del Pro', 'Multi-sucursal', 'Hasta 10 usuarios', 'Permisos granulares'],
    },
  ]
  return (
    <section className="lp-section">
      <div className="lp-container">
        <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <SectionLabel>Sistema escalable</SectionLabel>
          <h2 className="lp-section-title">
            Arrancá simple.<br />
            <span className="lp-gradient-text">Crecé sin cambiar de sistema.</span>
          </h2>
          <p className="lp-section-subtitle" style={{ margin: '0 auto' }}>
            Hoy podés necesitar órdenes, clientes y stock. Mañana tal vez sumes facturación ARCA, proveedores, WhatsApp, finanzas, Mi Guita o equipo de trabajo. TechRepair Pro está pensado para acompañar cada etapa.
          </p>
        </div>

        <div className="lp-scale-grid">
          {stages.map((s, i) => (
            <div key={i} className={`lp-scale-card ${s.highlight ? 'lp-scale-featured' : ''}`}>
              {s.highlight && <div className="lp-scale-ribbon">Más elegido</div>}
              <div className="lp-scale-header">
                <span className="lp-scale-plan" style={{ color: s.color }}>{s.plan}</span>
                <span className="lp-scale-price">{s.price}</span>
              </div>
              <p className="lp-scale-title">{s.title}</p>
              <ul className="lp-scale-items">
                {s.items.map((it, j) => (
                  <li key={j}><span style={{ color: s.highlight ? '#818cf8' : '#34d399' }}><IC.Check /></span>{it}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div style={{ textAlign: 'center', marginTop: '2.5rem' }}>
          <p style={{ color: '#475569', fontSize: '0.95rem', marginBottom: '1.5rem' }}>
            No necesitás cambiar de sistema cuando tu negocio crece. TechRepair Pro crece con vos.
          </p>
          <button className="lp-btn-primary" onClick={() => navigate('/onboarding')}>
            Empezar con 14 días gratis <IC.ArrowRight />
          </button>
        </div>
      </div>
    </section>
  )
}

// ─── FEATURES ─────────────────────────────────────────────────────────────────
function FeaturesSection({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  const features = [
    {
      icon: <IC.Wrench />, color: '#818cf8',
      title: 'Órdenes de trabajo',
      desc: 'Recepción, diagnóstico, estados, presupuestos, impresión y seguimiento en tiempo real.',
      items: ['Estados personalizables', 'Impresión ticket/A4', 'Garantías y notas'],
    },
    {
      icon: <IC.Users />, color: '#34d399',
      title: 'Clientes',
      desc: 'Historial de reparaciones, compras, cuenta corriente y datos siempre a mano.',
      items: ['Historial completo', 'Cuenta corriente', 'Comunicación WhatsApp'],
    },
    {
      icon: <IC.Package />, color: '#60a5fa',
      title: 'Inventario',
      desc: 'Productos, variantes, stock, precios en USD/ARS, mayorista y movimientos.',
      items: ['Variantes por producto', 'Precios en USD y ARS', 'Alertas de stock'],
    },
    {
      icon: <IC.Receipt />, color: '#f472b6',
      title: 'Ventas y comprobantes',
      desc: 'Ventas rápidas, comprobantes, pagos mixtos, cuenta corriente y notas de crédito.',
      items: ['Múltiples métodos de pago', 'Cuenta corriente', 'Notas de crédito'],
    },
    {
      icon: <IC.Shield />, color: '#fbbf24',
      title: 'ARCA / AFIP',
      desc: 'Emití facturas y notas de crédito desde el sistema según tu configuración fiscal.',
      items: ['Factura C y A', 'CAE y estados fiscales', 'Manejo de errores visible'],
    },
    {
      icon: <IC.DollarSign />, color: '#34d399',
      title: 'Caja diaria',
      desc: 'Controlá ingresos, egresos, métodos de pago y cierres diarios sin planillas.',
      items: ['Apertura y cierre', 'Por método de pago', 'Historial completo'],
    },
    {
      icon: <IC.TrendUp />, color: '#a78bfa',
      title: 'Proveedores',
      desc: 'Compras, pagos, deuda, historial y productos comprados por proveedor.',
      items: ['Cuenta corriente proveedor', 'Historial de compras', 'Facturación interna'],
    },
    {
      icon: <IC.Zap />, color: '#22d3ee',
      title: 'Finanzas',
      desc: 'Dashboard claro con ingresos, gastos, caja, ventas, deudas y alertas.',
      items: ['Dashboard visual', 'Resultado neto', 'Auditoría y alertas'],
    },
    {
      icon: <IC.MessageCircle />, color: '#25d366',
      title: 'WhatsApp',
      desc: 'Mensajes preparados para avisos, órdenes, garantías y seguimiento.',
      items: ['Templates por estado', 'Historial de envíos', 'WhatsApp Business API'],
    },
  ]
  return (
    <section id="features" className="lp-section lp-section-alt">
      <div className="lp-container">
        <div style={{ textAlign: 'center', marginBottom: '3.5rem' }}>
          <SectionLabel>Funciones</SectionLabel>
          <h2 className="lp-section-title">
            Todo lo que necesita<br />
            <span className="lp-gradient-text">tu negocio técnico</span>
          </h2>
          <p className="lp-section-subtitle">Módulos conectados entre sí. No son apps separadas.</p>
        </div>

        <div className="lp-features-grid">
          {features.map((f, i) => (
            <div key={i} className="lp-feature-card lp-fade-up" style={{ animationDelay: `${(i % 3) * 80}ms` }}>
              <div className="lp-feature-icon" style={{ color: f.color, background: f.color + '12', borderColor: f.color + '25' }}>
                {f.icon}
              </div>
              <h3 className="lp-feature-title">{f.title}</h3>
              <p className="lp-feature-desc">{f.desc}</p>
              <ul className="lp-feature-items">
                {f.items.map((it, j) => (
                  <li key={j}><span style={{ color: f.color }}><IC.Check /></span> {it}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div style={{ textAlign: 'center', marginTop: '2.5rem' }}>
          <button className="lp-btn-primary" onClick={() => navigate('/onboarding')}>
            Probar todas las funciones gratis <IC.ArrowRight />
          </button>
        </div>
      </div>
    </section>
  )
}

// ─── INVENTORY / DOLAR ────────────────────────────────────────────────────────
function InventorySection() {
  return (
    <section id="inventory" className="lp-section">
      <div className="lp-container">
        <div className="lp-two-col">
          <div className="lp-two-col-text">
            <SectionLabel>📦 Inventario multimoneda</SectionLabel>
            <h2 className="lp-section-title" style={{ fontSize: 'clamp(1.6rem, 3.5vw, 2.4rem)' }}>
              Comprás en dólares,<br />
              <span className="lp-gradient-text">cobrás en pesos</span>
            </h2>
            <p style={{ color: '#64748b', fontSize: '1rem', lineHeight: 1.75, marginBottom: '2rem' }}>
              TechRepair Pro maneja precios en USD y ARS al mismo tiempo. Elegís tu fuente de cotización — InfoDolar Córdoba o Ámbito — y el sistema la usa para calcular precios en pesos, actualizar productos configurados en USD y mantener coherencia entre inventario, ventas y dashboard.
            </p>
            <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '2rem' }}>
              {[
                'Precio de costo en USD o ARS',
                'Precio de venta en USD convertido a pesos',
                'Precio mayorista en USD y ARS',
                'Cotización actualizable con un click',
                'Auto-actualización de productos atados al dólar',
                'Categorías dinámicas creadas desde el negocio',
                'Productos, servicios y variantes (colores, capacidades, etc.)',
              ].map((it, i) => <CheckItem key={i}>{it}</CheckItem>)}
            </ul>
          </div>

          <div className="lp-inv-visual">
            <div className="lp-inv-card">
              <div className="lp-inv-card-header">
                <span style={{ fontWeight: 700, color: '#f1f5f9' }}>Pantalla iPhone 14 Pro</span>
                <span style={{ fontSize: '0.72rem', color: '#64748b' }}>Pantallas</span>
              </div>
              <div className="lp-inv-prices">
                <div className="lp-inv-price-row">
                  <span>Costo</span>
                  <span style={{ color: '#94a3b8' }}>U$D 28 ≈ <strong>$40.600</strong></span>
                </div>
                <div className="lp-inv-price-row">
                  <span>Venta</span>
                  <span style={{ color: '#34d399' }}>U$D 42 → <strong>$60.900</strong></span>
                </div>
                <div className="lp-inv-price-row">
                  <span>Mayorista</span>
                  <span style={{ color: '#818cf8' }}>U$D 36 → <strong>$52.200</strong></span>
                </div>
                <div className="lp-inv-divider" />
                <div className="lp-inv-price-row">
                  <span>Stock</span>
                  <Badge color="green">12 unidades</Badge>
                </div>
                <div className="lp-inv-price-row">
                  <span>Cotización USD/ARS</span>
                  <span style={{ color: '#fbbf24', fontWeight: 700 }}>$1.450</span>
                </div>
              </div>
            </div>
            <div className="lp-inv-note">
              <IC.Zap />
              Cotización configurable: InfoDolar Córdoba o Ámbito, sincronizada con inventario y dashboard.
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── FINANZAS ─────────────────────────────────────────────────────────────────
function FinanceSection() {
  return (
    <section id="finance" className="lp-section lp-section-alt">
      <div className="lp-container">
        <div className="lp-two-col lp-two-col-reverse">
          <div className="lp-finance-visual">
            <div className="lp-fin-card">
              <div className="lp-fin-header">
                <span>Dashboard Financiero</span>
                <Badge color="green">Mes actual</Badge>
              </div>
              {[
                { label: 'Ingresos', value: '$1.840.000', pct: 85, color: '#34d399' },
                { label: 'Gastos', value: '$520.000', pct: 28, color: '#f87171' },
                { label: 'Resultado neto', value: '$1.320.000', pct: 72, color: '#818cf8' },
              ].map((row, i) => (
                <div key={i} className="lp-fin-row">
                  <div className="lp-fin-row-top">
                    <span>{row.label}</span>
                    <span style={{ color: row.color, fontWeight: 700 }}>{row.value}</span>
                  </div>
                  <div className="lp-fin-bar-track">
                    <div className="lp-fin-bar-fill" style={{ width: `${row.pct}%`, background: row.color }} />
                  </div>
                </div>
              ))}
              <div className="lp-fin-footer">
                <div className="lp-fin-kpi"><span className="lp-fin-kpi-val" style={{ color: '#fbbf24' }}>3</span><span>Alertas</span></div>
                <div className="lp-fin-kpi"><span className="lp-fin-kpi-val" style={{ color: '#60a5fa' }}>18</span><span>Ventas hoy</span></div>
                <div className="lp-fin-kpi"><span className="lp-fin-kpi-val" style={{ color: '#34d399' }}>✓</span><span>Caja abierta</span></div>
              </div>
            </div>
          </div>

          <div className="lp-two-col-text">
            <SectionLabel>📊 Finanzas del negocio</SectionLabel>
            <h2 className="lp-section-title" style={{ fontSize: 'clamp(1.6rem, 3.5vw, 2.4rem)' }}>
              No alcanza con vender.<br />
              <span className="lp-gradient-text">Necesitás saber qué queda.</span>
            </h2>
            <p style={{ color: '#64748b', fontSize: '1rem', lineHeight: 1.75, marginBottom: '2rem' }}>
              TechRepair Pro incluye un dashboard financiero completo para que siempre sepás exactamente cuánto entrá, cuánto salió y cuánto quedó.
            </p>
            <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {[
                'Ingresos, gastos y resultado neto',
                'Caja por método de pago (efectivo, tarjeta, QR...)',
                'Ventas ARCA y comprobantes locales',
                'Notas de crédito y anulaciones',
                'Deuda de proveedores y clientes',
                'Alertas de auditoría y movimientos sospechosos',
              ].map((it, i) => <CheckItem key={i}>{it}</CheckItem>)}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── ARCA ─────────────────────────────────────────────────────────────────────
function ARCASection({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  return (
    <section id="arca" className="lp-section">
      <div className="lp-container">
        <div className="lp-arca-wrap">
          <div className="lp-arca-badge">
            <svg width="32" height="32" viewBox="0 0 200 100" fill="none">
              <text x="10" y="72" fontFamily="Arial" fontWeight="900" fontSize="70" fill="#3b82f6">ARCA</text>
            </svg>
          </div>
          <SectionLabel>Facturación electrónica</SectionLabel>
          <h2 className="lp-section-title">
            Facturación ARCA<br />
            <span className="lp-gradient-text">integrada en el flujo</span>
          </h2>
          <p className="lp-section-subtitle">
            Generá comprobantes con CAE sin salir del sistema. Todo configurado para tu situación fiscal.
          </p>

          <div className="lp-arca-cards">
            {[
              { icon: '🧾', title: 'Factura C / A', desc: 'Emití según tu condición fiscal. Punto de venta configurable.' },
              { icon: '✅', title: 'CAE automático', desc: 'Conexión directa con ARCA/AFIP para obtener el código fiscal.' },
              { icon: '❌', title: 'Notas de crédito', desc: 'Anulá comprobantes y emití notas de crédito con el mismo flujo.' },
              { icon: '🔄', title: 'Estados visibles', desc: 'Error, pendiente, emitido — siempre sabés qué pasó con cada comprobante.' },
            ].map((c, i) => (
              <div key={i} className="lp-arca-card">
                <div className="lp-arca-card-icon">{c.icon}</div>
                <h4 style={{ fontWeight: 700, color: '#f1f5f9', margin: '0 0 0.375rem' }}>{c.title}</h4>
                <p style={{ color: '#64748b', fontSize: '0.85rem', margin: 0, lineHeight: 1.5 }}>{c.desc}</p>
              </div>
            ))}
          </div>

          <p style={{ fontSize: '0.78rem', color: '#334155', marginTop: '2rem' }}>
            La disponibilidad depende de la configuración fiscal y los certificados del negocio. Plan Pro requerido.
          </p>
          <button className="lp-btn-primary" style={{ marginTop: '1.5rem' }} onClick={() => navigate('/onboarding')}>
            Probarlo gratis <IC.ArrowRight />
          </button>
        </div>
      </div>
    </section>
  )
}

// ─── MI GUITA ─────────────────────────────────────────────────────────────────
function MiGuitaSection() {
  return (
    <section id="miguita" className="lp-section lp-section-alt">
      <div className="lp-container">
        <div className="lp-miguita-wrap">
          <div className="lp-miguita-icon">💰</div>
          <SectionLabel color="green">Módulo personal — Plan Pro y Full</SectionLabel>
          <h2 className="lp-section-title">
            Separá tu plata del negocio<br />
            <span className="lp-gradient-text">con Mi Guita</span>
          </h2>
          <p className="lp-section-subtitle" style={{ maxWidth: 560 }}>
            TechRepair Pro incluye una app personal para controlar tus finanzas privadas, separada del negocio pero conectada a él.
          </p>

          <div className="lp-miguita-grid">
            {[
              { icon: '🏦', label: 'Cuentas personales' },
              { icon: '💳', label: 'Tarjetas de crédito' },
              { icon: '📈', label: 'Ahorros y metas' },
              { icon: '📋', label: 'Gastos recurrentes' },
              { icon: '💸', label: 'Deudas personales' },
              { icon: '💵', label: 'Pagarme sueldo' },
            ].map((it, i) => (
              <div key={i} className="lp-miguita-item">
                <span style={{ fontSize: '1.5rem' }}>{it.icon}</span>
                <span style={{ fontSize: '0.85rem', color: '#94a3b8', fontWeight: 500 }}>{it.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── PRICING ──────────────────────────────────────────────────────────────────
function PricingSection({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  const [annual, setAnnual] = useState(false)

  const plans = [
    {
      id: 'basico', name: 'Básico', price: annual ? 12000 : 15000,
      color: '#64748b', highlight: false,
      desc: 'Para talleres que quieren ordenar lo esencial.',
      features: [
        'Órdenes de trabajo ilimitadas',
        'Clientes con historial',
        'Inventario con alertas de stock',
        'Comprobantes locales',
        'Caja diaria',
        '1 usuario',
      ],
    },
    {
      id: 'pro', name: 'Pro', price: annual ? 20000 : 25000,
      color: '#6366f1', highlight: true,
      desc: 'El más elegido. Incluye facturación ARCA y todas las funciones avanzadas.',
      features: [
        'Todo lo del Básico',
        'Facturación electrónica ARCA / CAE',
        'Finanzas avanzadas con métricas',
        'Proveedores y cuentas corrientes',
        'Garantías y postventa',
        'WhatsApp integrado',
        'Mi Guita — finanzas personales',
        'Hasta 3 usuarios',
      ],
    },
    {
      id: 'full', name: 'Full', price: annual ? 36000 : 45000,
      color: '#475569', highlight: false,
      desc: 'Para negocios con más equipo o mayor operación.',
      features: [
        'Todo lo del Pro',
        'Multi-sucursal',
        'Hasta 10 usuarios',
        'Permisos granulares',
        'Auditoría completa',
        'Soporte prioritario',
      ],
    },
  ]

  return (
    <section id="pricing" className="lp-section">
      <div className="lp-container">
        <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <SectionLabel>Planes</SectionLabel>
          <h2 className="lp-section-title">
            Empezá con el plan que<br />
            <span className="lp-gradient-text">se adapta a vos</span>
          </h2>
          <p className="lp-section-subtitle">14 días de prueba gratis con funciones Pro. Sin tarjeta de crédito.</p>

          {/* Toggle mensual/anual */}
          <div className="lp-billing-toggle">
            <span className={!annual ? 'lp-billing-active' : ''}>Mensual</span>
            <button
              className="lp-toggle-btn"
              onClick={() => setAnnual(v => !v)}
              aria-label="Cambiar facturación"
              role="switch"
              aria-checked={annual}
            >
              <span className={`lp-toggle-thumb ${annual ? 'lp-toggle-on' : ''}`} />
            </button>
            <span className={annual ? 'lp-billing-active' : ''}>
              Anual <Badge color="green">-20%</Badge>
            </span>
          </div>
        </div>

        <div className="lp-pricing-grid">
          {plans.map(p => (
            <div key={p.id} className={`lp-plan-card ${p.highlight ? 'lp-plan-featured' : ''}`}>
              {p.highlight && <div className="lp-plan-ribbon">⭐ Más elegido</div>}
              <div className="lp-plan-header">
                <h3 className="lp-plan-name" style={{ color: p.color }}>{p.name}</h3>
                <div className="lp-plan-price">
                  <span className="lp-plan-currency">$</span>
                  <span className="lp-plan-amount">{p.price.toLocaleString('es-AR')}</span>
                  <span className="lp-plan-period">/mes</span>
                </div>
                <p className="lp-plan-desc">{p.desc}</p>
              </div>
              <ul className="lp-plan-features">
                {p.features.map((f, i) => (
                  <li key={i}>
                    <span style={{ color: p.highlight ? '#818cf8' : '#34d399' }}><IC.Check /></span>
                    {f}
                  </li>
                ))}
              </ul>
              <button
                className={p.highlight ? 'lp-btn-primary' : 'lp-btn-outline'}
                style={{ width: '100%', justifyContent: 'center', marginTop: 'auto' }}
                onClick={() => navigate('/onboarding')}
              >
                {p.highlight ? 'Empezar gratis 14 días' : 'Probar gratis'}
              </button>
            </div>
          ))}
        </div>

        <div className="lp-pricing-note">
          <IC.Shield />
          <span>Todos los planes incluyen soporte por WhatsApp y actualizaciones sin costo adicional.</span>
        </div>
      </div>
    </section>
  )
}

// ─── ANTES / DESPUÉS ──────────────────────────────────────────────────────────
function BeforeAfterSection() {
  const before = [
    '📋 Órdenes en papel o Excel',
    '💬 WhatsApps sin registro ni orden',
    '📦 Stock manual en planilla',
    '💸 Caja desordenada sin cierre',
    '👤 Clientes sin historial',
    '💰 Precios desactualizados',
    '🏭 Proveedores sin control',
  ]
  const after = [
    '✅ Todo centralizado y buscable',
    '📱 WhatsApp con plantillas y registro',
    '📦 Stock actualizado en tiempo real',
    '💸 Caja con cierre y reportes',
    '👤 Historial completo por cliente',
    '💰 Precios USD/ARS siempre al día',
    '🏭 Proveedor con deuda y pagos',
  ]
  return (
    <section id="compare" className="lp-section lp-section-alt">
      <div className="lp-container">
        <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <SectionLabel>La diferencia</SectionLabel>
          <h2 className="lp-section-title">
            Antes y <span className="lp-gradient-text">después</span>
          </h2>
        </div>
        <div className="lp-compare-grid">
          <div className="lp-compare-col lp-compare-before">
            <div className="lp-compare-header">
              <span>😣</span> Antes
            </div>
            {before.map((it, i) => <div key={i} className="lp-compare-item">{it}</div>)}
          </div>
          <div className="lp-compare-col lp-compare-after">
            <div className="lp-compare-header">
              <span>🚀</span> Con TechRepair Pro
            </div>
            {after.map((it, i) => <div key={i} className="lp-compare-item">{it}</div>)}
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── TRUST ────────────────────────────────────────────────────────────────────
function TrustSection() {
  const trust = [
    { icon: '🔧', title: 'Pensado para el negocio real', desc: 'Cada flujo fue pensado para servicios técnicos, locales de celulares y comercios que venden, reparan y administran stock.' },
    { icon: '📱', title: 'Pensado para el flujo de reparación', desc: 'Del ingreso del equipo al cobro final: todo el proceso sin pasos innecesarios.' },
    { icon: '🛡️', title: 'Datos seguros en la nube', desc: 'Infraestructura moderna con Supabase/PostgreSQL. Accedés desde cualquier dispositivo.' },
    { icon: '🔄', title: 'Actualizaciones constantes', desc: 'El sistema mejora continuamente. Lo que pedís hoy puede estar disponible mañana.' },
    { icon: '💬', title: 'Soporte por WhatsApp', desc: 'No hay chatbots. Un equipo real responde tus consultas por WhatsApp en horario de negocio.' },
    { icon: '📊', title: 'Sin instalación', desc: 'Funciona en el navegador. Desktop, tablet y mobile. Sin instalar nada.' },
  ]
  return (
    <section id="trust" className="lp-section">
      <div className="lp-container">
        <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <SectionLabel>Por qué confiar</SectionLabel>
          <h2 className="lp-section-title">
            Hecho para el día a día<br />
            <span className="lp-gradient-text">de un local técnico</span>
          </h2>
        </div>
        <div className="lp-trust-grid">
          {trust.map((t, i) => (
            <div key={i} className="lp-trust-card lp-fade-up" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="lp-trust-icon">{t.icon}</div>
              <h4 className="lp-trust-title">{t.title}</h4>
              <p className="lp-trust-desc">{t.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── FAQ ──────────────────────────────────────────────────────────────────────
function FAQSection() {
  const [open, setOpen] = useState<number | null>(null)
  const faqs = [
    { q: '¿Puedo probarlo gratis?', a: 'Sí. Tenés 14 días de prueba gratuita con funciones del plan Pro. Sin tarjeta de crédito.' },
    { q: '¿Sirve solo para servicios técnicos?', a: 'No. TechRepair Pro está pensado para servicios técnicos, locales de celulares, tiendas de accesorios y negocios que combinan reparación, venta, stock, caja y proveedores. El sistema se adapta a cómo trabaja tu local.' },
    { q: '¿Puedo usarlo si solo vendo accesorios o celulares?', a: 'Sí. Podés usar inventario, ventas, caja, clientes, proveedores, precios en USD/ARS, comprobantes y finanzas aunque no uses el módulo de reparaciones todos los días.' },
    { q: '¿El sistema crece con mi negocio?', a: 'Sí. Podés empezar con funciones esenciales (Básico) y avanzar a planes con más herramientas: ARCA, proveedores, WhatsApp, Mi Guita, equipo de trabajo y multisucursal (Pro y Full). No necesitás cambiar de sistema cuando tu negocio crece.' },
    { q: '¿Tiene facturación ARCA/AFIP?', a: 'Sí. El plan Pro incluye integración con ARCA para emitir facturas C y A, obtener CAE y emitir notas de crédito. Requiere configuración de certificados del negocio.' },
    { q: '¿Qué fuentes de dólar puedo usar?', a: 'Podés trabajar con cotización desde InfoDolar Córdoba o Ámbito, según la configuración de tu negocio. Esa referencia se usa para precios en USD, conversiones y actualización automática de productos.' },
    { q: '¿Tiene caja diaria?', a: 'Sí. Podés abrir y cerrar caja, registrar ingresos y egresos, controlar por método de pago (efectivo, tarjeta, QR, transferencia) y ver el historial completo.' },
    { q: '¿Puedo tener varios usuarios?', a: 'Sí. El plan Pro incluye hasta 3 usuarios y el plan Full hasta 10, con roles y permisos granulares por módulo.' },
    { q: '¿Qué pasa con mis proveedores?', a: 'TechRepair Pro tiene un módulo completo de proveedores con historial de compras, pagos, deuda y cuenta corriente por proveedor.' },
    { q: '¿Funciona desde el celular?', a: 'Sí. Es completamente responsive. Funciona en desktop, tablet y mobile sin instalar nada. Mi Guita se puede instalar como PWA en el celular.' },
    { q: '¿Qué incluye Mi Guita?', a: 'Mi Guita es un módulo de finanzas personales incluido en el plan Pro y Full. Te permite manejar cuentas, movimientos, tarjetas, ahorros, deudas y pagarte sueldo desde el negocio.' },
    { q: '¿Cómo es el soporte?', a: 'El soporte es por WhatsApp con respuesta en horario de negocio. No hay chatbots automáticos.' },
  ]
  return (
    <section id="faq" className="lp-section lp-section-alt">
      <div className="lp-container">
        <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <SectionLabel>Preguntas frecuentes</SectionLabel>
          <h2 className="lp-section-title">
            Dudas que seguro <span className="lp-gradient-text">ya tenés</span>
          </h2>
        </div>
        <div className="lp-faq-list">
          {faqs.map((f, i) => (
            <div key={i} className={`lp-faq-item ${open === i ? 'lp-faq-open' : ''}`}>
              <button className="lp-faq-btn" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                <span>{f.q}</span>
                <span className="lp-faq-chevron"><IC.ChevronDown /></span>
              </button>
              {open === i && <div className="lp-faq-answer">{f.a}</div>}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── CTA FINAL ────────────────────────────────────────────────────────────────
function CTAFinal({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  return (
    <section className="lp-cta-final">
      <div className="lp-orb lp-cta-orb-1" />
      <div className="lp-orb lp-cta-orb-2" />
      <div className="lp-container" style={{ position: 'relative', zIndex: 1 }}>
        <div style={{ textAlign: 'center', maxWidth: 640, margin: '0 auto' }}>
          <h2 className="lp-section-title" style={{ fontSize: 'clamp(2rem, 4vw, 2.8rem)', marginBottom: '1.25rem' }}>
            Ordená tu taller<br />
            <span className="lp-gradient-text">desde hoy</span>
          </h2>
          <p style={{ color: '#64748b', fontSize: '1.1rem', lineHeight: 1.7, marginBottom: '2.5rem' }}>
            Probá TechRepair Pro gratis durante 14 días y empezá a controlar órdenes, stock, caja y facturación desde un solo lugar.
          </p>
          <div className="lp-hero-ctas" style={{ justifyContent: 'center' }}>
            <button className="lp-btn-primary lp-btn-lg" onClick={() => navigate('/onboarding')} aria-label="Probar gratis 14 días">
              Probar gratis 14 días <IC.ArrowRight />
            </button>
            <a href={`https://wa.me/${CONTACT.whatsapp}?text=${CONTACT.whatsappMsg}`} className="lp-btn-outline lp-btn-lg" target="_blank" rel="noopener noreferrer" aria-label="Consultar por WhatsApp">
              <WhatsAppSVG size={18} /> Consultar
            </a>
          </div>
          <p style={{ fontSize: '0.8rem', color: '#334155', marginTop: '1.25rem' }}>Sin tarjeta de crédito · 14 días con funciones Pro · Cancelá cuando quieras</p>
        </div>
      </div>
    </section>
  )
}

// ─── FOOTER ───────────────────────────────────────────────────────────────────
function Footer({ onNav }: { onNav: (id: string) => void }) {
  const navigate = useNavigate()
  return (
    <footer className="lp-footer">
      <div className="lp-container">
        <div className="lp-footer-grid">
          {/* Brand */}
          <div className="lp-footer-brand">
            <div className="lp-logo" style={{ marginBottom: '0.875rem' }}>
              <div className="lp-logo-icon"><CatLogoSVG size={22} /></div>
              <span className="lp-logo-text">TechRepair<span>Pro</span></span>
            </div>
            <p style={{ color: '#475569', fontSize: '0.875rem', lineHeight: 1.7, maxWidth: 260 }}>
              Sistema de gestión para servicios técnicos, talleres de reparación y tiendas de celulares. Hecho en Argentina.
            </p>
            <div className="lp-footer-social">
              <a href={`https://instagram.com/${CONTACT.instagram}`} target="_blank" rel="noopener noreferrer" aria-label="Instagram TechRepair Pro">
                <IC.Instagram />
              </a>
              <a href={`https://wa.me/${CONTACT.whatsapp}`} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp TechRepair Pro">
                <WhatsAppSVG size={18} />
              </a>
            </div>
          </div>

          {/* Links */}
          <div className="lp-footer-col">
            <h4>Producto</h4>
            <a href="#features" onClick={e => { e.preventDefault(); onNav('features') }}>Funciones</a>
            <a href="#pricing" onClick={e => { e.preventDefault(); onNav('pricing') }}>Planes</a>
            <a href="#arca" onClick={e => { e.preventDefault(); onNav('arca') }}>Facturación ARCA</a>
            <a href="#miguita" onClick={e => { e.preventDefault(); onNav('miguita') }}>Mi Guita</a>
            <a href="#faq" onClick={e => { e.preventDefault(); onNav('faq') }}>Preguntas frecuentes</a>
          </div>

          <div className="lp-footer-col">
            <h4>Empezar</h4>
            <button onClick={() => navigate('/onboarding')}>Probar gratis</button>
            <button onClick={() => navigate('/login')}>Ingresar</button>
            <a href={`https://wa.me/${CONTACT.whatsapp}?text=${CONTACT.whatsappMsg}`} target="_blank" rel="noopener noreferrer">Contacto</a>
            <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
          </div>
        </div>

        <div className="lp-footer-bottom">
          <span>© {new Date().getFullYear()} TechRepair Pro. Buenos Aires, Argentina.</span>
          <span>Hecho para técnicos, por técnicos.</span>
        </div>
      </div>
    </footer>
  )
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export function LandingPage() {
  const navigate = useNavigate()

  // Intersection Observer for scroll animations
  const observerRef = useRef<IntersectionObserver | null>(null)
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      entries => entries.forEach(e => { if (e.isIntersecting) (e.target as HTMLElement).style.opacity = '1' }),
      { threshold: 0.1 }
    )
    document.querySelectorAll('.lp-fade-up').forEach(el => {
      ;(el as HTMLElement).style.opacity = '0'
      observerRef.current?.observe(el)
    })
    return () => observerRef.current?.disconnect()
  }, [])

  return (
    <div className="landing-root">
      <Header onNav={scrollTo} />
      <main>
        <Hero navigate={navigate} />
        <ProblemSection />
        <FlowSection />
        <ScalabilitySection navigate={navigate} />
        <FeaturesSection navigate={navigate} />
        <InventorySection />
        <FinanceSection />
        <ARCASection navigate={navigate} />
        <MiGuitaSection />
        <PricingSection navigate={navigate} />
        <BeforeAfterSection />
        <TrustSection />
        <FAQSection />
        <CTAFinal navigate={navigate} />
      </main>
      <Footer onNav={scrollTo} />
    </div>
  )
}

export default LandingPage
