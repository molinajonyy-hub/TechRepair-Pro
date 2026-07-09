import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Menu, X, ArrowRight, Check, ChevronDown, HelpCircle,
  ClipboardList, Search, Wrench, MessageCircle, CreditCard, BarChart3,
  Receipt, Package, Users, User, Wallet, Building2,
  DollarSign, FileText, ShieldCheck, Smartphone, Zap, Sun, Moon,
} from 'lucide-react'
import { PLANS, type SubscriptionPlan } from '../types/subscription'
import { initLandingAnalytics, track } from '../lib/analytics'
import { useTheme } from '../hooks/useTheme'
import '../css/landing.css'

// ─── Acentos temables del mockup ──────────────────────────────────────────────
// Los acentos se guardan como hex de 6 dígitos porque se componen con sufijos
// de alpha ("55", "1a"). En light se sustituyen por variantes más oscuras para
// mantener contraste sobre superficies claras; en dark quedan idénticos.
const LIGHT_ACCENT: Record<string, string> = {
  '#818cf8': '#4f46e5',
  '#60a5fa': '#2563eb',
  '#a78bfa': '#7c3aed',
  '#34d399': '#059669',
  '#fbbf24': '#b45309',
  '#22d3ee': '#0e7490',
  '#f87171': '#dc2626',
}

function useThemedAccent() {
  const { resolvedTheme } = useTheme()
  return useCallback(
    (hex: string) => (resolvedTheme === 'dark' ? hex : LIGHT_ACCENT[hex] ?? hex),
    [resolvedTheme],
  )
}

// ─── Contacto ─────────────────────────────────────────────────────────────────
// Se leen de variables de entorno (ver .env.example). NO hay valores por defecto:
// si una variable no está configurada, el enlace simplemente no se renderiza, para
// no mostrar contactos ficticios o rotos en producción.
const CONTACT = {
  whatsapp:  (import.meta.env.VITE_CONTACT_WHATSAPP  as string | undefined)?.trim() || '',
  email:     (import.meta.env.VITE_CONTACT_EMAIL     as string | undefined)?.trim() || '',
  instagram: (import.meta.env.VITE_CONTACT_INSTAGRAM as string | undefined)?.trim() || '',
}
const HAS_SOCIAL = !!(CONTACT.whatsapp || CONTACT.instagram)

// Duración real de la prueba (verificada en Onboarding.tsx: trial Pro, 14 días, sin tarjeta)
const TRIAL_DAYS = 14

// ─── Marca ────────────────────────────────────────────────────────────────────
const BrandLogo = ({ size = 22 }: { size?: number }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} fill="none" aria-hidden="true">
    <path d="M18 46 L25 14 L38 36 Q50 30 62 36 L75 14 L82 46 Q86 60 82 70 Q70 88 50 88 Q30 88 18 70 Q14 60 18 46 Z" fill="#fff" opacity="0.95" />
    <ellipse cx="37" cy="58" rx="5.2" ry="4.8" fill="#4f46e5" />
    <ellipse cx="63" cy="58" rx="5.2" ry="4.8" fill="#4f46e5" />
  </svg>
)

const WhatsAppGlyph = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
  </svg>
)

// ─── Recorrido del producto (sección central) ─────────────────────────────────
type RailKey = 'orden' | 'inventario' | 'cliente' | 'caja'

interface Stage {
  id: string
  tab: string
  Icon: typeof Wrench
  title: string
  body: string
  status: string
  accent: string
  rail: RailKey[]
  detail: { label: string; value: string }[]
}

const STAGES: Stage[] = [
  {
    id: 'ingresa', tab: 'Ingresa', Icon: ClipboardList, accent: '#818cf8',
    title: 'Entra un equipo y queda registrado',
    body: 'Cargás marca, modelo y falla en segundos. El cliente y todo su historial quedan vinculados a la orden desde el primer momento.',
    status: 'Recibido', rail: ['orden', 'cliente'],
    detail: [
      { label: 'Cliente', value: 'M. López' },
      { label: 'Falla', value: 'Pantalla rota' },
    ],
  },
  {
    id: 'diagnostica', tab: 'Se diagnostica', Icon: Search, accent: '#60a5fa',
    title: 'Diagnóstico y presupuesto, claros',
    body: 'Asignás técnico, anotás el diagnóstico y definís el presupuesto. El cliente sabe qué se va a hacer y cuánto cuesta antes de empezar.',
    status: 'Diagnóstico', rail: ['orden'],
    detail: [
      { label: 'Técnico', value: 'J. Pérez' },
      { label: 'Presupuesto', value: '$60.900' },
    ],
  },
  {
    id: 'trabaja', tab: 'Se trabaja', Icon: Wrench, accent: '#a78bfa',
    title: 'Usás repuestos sin perder el control del stock',
    body: 'No solo descontás un repuesto: sabés en qué reparación se usó, cuánto costó y cuánto margen dejó el trabajo.',
    status: 'En reparación', rail: ['orden', 'inventario'],
    detail: [
      { label: 'Repuesto', value: 'Pantalla iPhone 14 Pro' },
      { label: 'Stock', value: '−1 · Margen 38%' },
    ],
  },
  {
    id: 'informa', tab: 'Se informa', Icon: MessageCircle, accent: '#34d399',
    title: 'El cliente se entera sin que lo persigas',
    body: 'Mensajes de WhatsApp listos para cada estado: recibido, en reparación, listo para retirar. Menos llamados y menos idas y vueltas.',
    status: 'Avisado', rail: ['cliente'],
    detail: [
      { label: 'WhatsApp', value: '“Tu equipo está listo”' },
      { label: 'Estado', value: 'Enviado' },
    ],
  },
  {
    id: 'cobra', tab: 'Se cobra', Icon: CreditCard, accent: '#fbbf24',
    title: 'Cobrás y emitís el comprobante en el acto',
    body: 'Venta rápida con varios métodos de pago. Si corresponde, factura ARCA con CAE sin salir del sistema.',
    status: 'Cobrado', rail: ['orden', 'caja'],
    detail: [
      { label: 'Cobro', value: '$60.900 · efectivo' },
      { label: 'Comprobante', value: 'N° 00000042' },
    ],
  },
  {
    id: 'registra', tab: 'Se registra', Icon: BarChart3, accent: '#22d3ee',
    title: 'Todo impacta solo en caja y finanzas',
    body: 'Cada cobro actualiza la caja, las finanzas, el stock y la cuenta corriente del cliente. Los números quedan cuadrados sin planillas.',
    status: 'Cerrada', rail: ['caja', 'inventario', 'cliente'],
    detail: [
      { label: 'Caja del día', value: '+$60.900' },
      { label: 'Resultado', value: 'Actualizado' },
    ],
  },
]

const RAIL_META: Record<RailKey, { label: string; Icon: typeof Wrench }> = {
  orden:      { label: 'Orden',      Icon: Receipt },
  inventario: { label: 'Inventario', Icon: Package },
  cliente:    { label: 'Cliente',    Icon: Users },
  caja:       { label: 'Caja',       Icon: Wallet },
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="lp-eyebrow">{children}</span>
}

function smoothScroll(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}

// ─── HEADER ───────────────────────────────────────────────────────────────────
function Header({ onTrial }: { onTrial: (source: string) => void }) {
  const navigate = useNavigate()
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const { resolvedTheme, setTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 16)
    fn()
    window.addEventListener('scroll', fn, { passive: true })
    return () => window.removeEventListener('scroll', fn)
  }, [])

  const links = [
    { label: 'Cómo funciona', id: 'recorrido' },
    { label: 'Soluciones', id: 'crecimiento' },
    { label: 'Planes', id: 'planes' },
    { label: 'Preguntas', id: 'faq' },
  ]

  const go = (id: string) => { smoothScroll(id); setOpen(false) }

  return (
    <header className={`lp-header${scrolled ? ' is-scrolled' : ''}`}>
      <div className="lp-header-inner">
        <a href="#top" className="lp-logo" onClick={e => { e.preventDefault(); smoothScroll('top') }}>
          <span className="lp-logo-mark"><BrandLogo size={20} /></span>
          <span className="lp-logo-text">TechRepair<span>Pro</span></span>
        </a>

        <nav className="lp-nav" aria-label="Secciones">
          {links.map(l => (
            <button key={l.id} className="lp-nav-link" onClick={() => go(l.id)}>{l.label}</button>
          ))}
        </nav>

        <div className="lp-header-actions">
          <button
            className="lp-btn lp-btn-ghost lp-btn-sm"
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
            aria-label={isDark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
            title={isDark ? 'Tema claro' : 'Tema oscuro'}
            style={{ paddingLeft: '0.7rem', paddingRight: '0.7rem' }}
          >
            {isDark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
          </button>
          <button className="lp-btn lp-btn-ghost lp-btn-sm lp-hide-mobile" onClick={() => navigate('/login')}>
            Ingresar
          </button>
          <button className="lp-btn lp-btn-primary lp-btn-sm" onClick={() => onTrial('header')}>
            Probar gratis
          </button>
          <button
            className="lp-burger"
            onClick={() => setOpen(v => !v)}
            aria-label={open ? 'Cerrar menú' : 'Abrir menú'}
            aria-expanded={open}
            aria-controls="lp-mobile-menu"
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {open && (
        <div className="lp-mobile-menu" id="lp-mobile-menu">
          {links.map(l => (
            <button key={l.id} className="lp-mobile-link" onClick={() => go(l.id)}>{l.label}</button>
          ))}
          <div className="lp-mobile-sep" />
          <button className="lp-btn lp-btn-primary lp-btn-block" onClick={() => onTrial('mobile_menu')}>
            Probar gratis {TRIAL_DAYS} días
          </button>
          <button className="lp-btn lp-btn-ghost lp-btn-block" onClick={() => navigate('/login')}>
            Ingresar
          </button>
        </div>
      )}
    </header>
  )
}

// ─── HERO ─────────────────────────────────────────────────────────────────────
function Hero({ onTrial, onDemo }: { onTrial: (s: string) => void; onDemo: () => void }) {
  const trust = [
    `${TRIAL_DAYS} días gratis`,
    'Sin tarjeta',
    'Facturación ARCA',
    'Hecho en Argentina',
  ]
  return (
    <section id="top" className="lp-hero">
      <div className="lp-hero-bg" aria-hidden="true">
        <span className="lp-hero-glow lp-hero-glow-1" />
        <span className="lp-hero-glow lp-hero-glow-2" />
        <span className="lp-hero-grid" />
      </div>

      <div className="lp-container lp-hero-inner">
        <div className="lp-hero-copy">
          <div className="lp-reveal"><Eyebrow>Para servicios técnicos y locales de celulares</Eyebrow></div>
          <h1 className="lp-hero-title lp-reveal">
            Tu taller, bajo control.
            <span className="lp-accent"> Del ingreso del equipo hasta que cobrás.</span>
          </h1>
          <p className="lp-hero-sub lp-reveal">
            TechRepair Pro conecta reparaciones, clientes, repuestos, ventas y finanzas
            para que trabajes sin perseguir información.
          </p>

          <div className="lp-hero-ctas lp-reveal">
            <button className="lp-btn lp-btn-primary lp-btn-lg" onClick={() => onTrial('hero')}>
              Probar gratis {TRIAL_DAYS} días <ArrowRight size={18} />
            </button>
            <button className="lp-btn lp-btn-ghost lp-btn-lg" onClick={onDemo}>
              Ver cómo funciona
            </button>
          </div>

          <ul className="lp-hero-trust lp-reveal" aria-label="Lo que incluye">
            {trust.map(t => (
              <li key={t}><Check size={15} aria-hidden="true" /> {t}</li>
            ))}
          </ul>
        </div>

        <div className="lp-hero-visual lp-reveal" aria-hidden="true">
          <SystemWindow stage={STAGES[4]} floating />
        </div>
      </div>
    </section>
  )
}

// ─── Ventana del sistema (visual reutilizable del recorrido) ──────────────────
function SystemWindow({ stage, floating = false }: { stage: Stage; floating?: boolean }) {
  const accent = useThemedAccent()
  const a = accent(stage.accent)
  return (
    <div className={`lp-window${floating ? ' is-floating' : ''}`}>
      <div className="lp-window-bar">
        <span className="lp-window-dots"><i /><i /><i /></span>
        <span className="lp-window-title">Orden #00042 · iPhone 14 Pro</span>
        <span className="lp-window-status" style={{ color: a, borderColor: `${a}55`, background: `${a}1a` }}>
          {stage.status}
        </span>
      </div>

      <div className="lp-window-rail">
        {(Object.keys(RAIL_META) as RailKey[]).map(key => {
          const active = stage.rail.includes(key)
          const { label, Icon } = RAIL_META[key]
          return (
            <span key={key} className={`lp-rail-chip${active ? ' is-active' : ''}`} style={active ? { color: a, borderColor: `${a}55`, background: `${a}14` } : undefined}>
              <Icon size={14} aria-hidden="true" /> {label}
            </span>
          )
        })}
      </div>

      <div className="lp-window-body" key={stage.id}>
        <div className="lp-window-headline">
          <span className="lp-window-step-icon" style={{ color: a, background: `${a}18` }}>
            <stage.Icon size={18} aria-hidden="true" />
          </span>
          <span>{stage.title}</span>
        </div>
        <div className="lp-window-rows">
          {stage.detail.map(d => (
            <div className="lp-window-row" key={d.label}>
              <span className="lp-window-row-label">{d.label}</span>
              <span className="lp-window-row-value">{d.value}</span>
            </div>
          ))}
          <div className="lp-window-progress">
            <span className="lp-window-progress-fill" style={{ width: `${((STAGES.indexOf(stage) + 1) / STAGES.length) * 100}%`, background: a }} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── PROBLEMA ─────────────────────────────────────────────────────────────────
function ProblemSection() {
  const questions = [
    '¿En qué estado está ese equipo?',
    '¿Quién habló con el cliente?',
    '¿Llegó el repuesto?',
    '¿Ya se cobró?',
    '¿Qué quedó en cuenta corriente?',
    '¿Cuánto ganó realmente el negocio?',
  ]
  return (
    <section className="lp-section lp-section-tint">
      <div className="lp-container">
        <div className="lp-section-head lp-reveal">
          <Eyebrow>El día a día real</Eyebrow>
          <h2 className="lp-section-title">Tu taller creció. La forma de organizarlo, no tanto.</h2>
          <p className="lp-section-sub">
            Entre WhatsApp, papeles, la memoria y tres planillas distintas, todos los días
            aparecen las mismas preguntas sin respuesta rápida:
          </p>
        </div>

        <div className="lp-questions">
          {questions.map((q, i) => (
            <div key={q} className="lp-question lp-reveal" style={{ transitionDelay: `${i * 50}ms` }}>
              <HelpCircle size={18} aria-hidden="true" />
              <span>{q}</span>
            </div>
          ))}
        </div>

        <p className="lp-problem-bridge lp-reveal">
          TechRepair Pro reúne cada respuesta en un solo lugar.
        </p>
      </div>
    </section>
  )
}

// ─── RECORRIDO (interactivo) ──────────────────────────────────────────────────
function JourneySection() {
  const [active, setActive] = useState(0)
  const [autoplay, setAutoplay] = useState(true)
  const [visible, setVisible] = useState(false)
  const tablistRef = useRef<HTMLDivElement | null>(null)
  const sectionRef = useRef<HTMLElement | null>(null)
  const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // Visibilidad de la sección (sólo autoavanza en pantalla)
  useEffect(() => {
    const node = sectionRef.current
    if (!node) return
    const obs = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.35 },
    )
    obs.observe(node)
    return () => obs.disconnect()
  }, [])

  // Autoavance suave, se detiene al interactuar y respeta reduced-motion
  useEffect(() => {
    if (reduce || !autoplay || !visible) return
    const t = window.setInterval(() => setActive(s => (s + 1) % STAGES.length), 4200)
    return () => window.clearInterval(t)
  }, [reduce, autoplay, visible])

  const selectStage = useCallback((i: number, userInitiated = true) => {
    setActive(i)
    if (userInitiated) {
      setAutoplay(false)
      track('journey_step_interaction', { stage: STAGES[i].id, index: i })
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault(); selectStage((active + 1) % STAGES.length)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault(); selectStage((active - 1 + STAGES.length) % STAGES.length)
    }
  }

  const stage = STAGES[active]

  return (
    <section id="recorrido" ref={sectionRef} data-track="journey" className="lp-section">
      <div className="lp-container">
        <div className="lp-section-head lp-reveal">
          <Eyebrow>El recorrido</Eyebrow>
          <h2 className="lp-section-title">Una reparación. Todo el negocio conectado.</h2>
          <p className="lp-section-sub">
            Seguí una orden a medida que avanza por el sistema. Cada paso actualiza al siguiente,
            sin volver a cargar nada.
          </p>
        </div>

        <div className="lp-journey">
          <div
            className="lp-journey-steps"
            role="tablist"
            aria-label="Etapas de una reparación"
            aria-orientation="vertical"
            ref={tablistRef}
            onKeyDown={onKeyDown}
          >
            {STAGES.map((s, i) => {
              const isActive = i === active
              return (
                <button
                  key={s.id}
                  role="tab"
                  id={`lp-tab-${s.id}`}
                  aria-selected={isActive}
                  aria-controls="lp-journey-panel"
                  tabIndex={isActive ? 0 : -1}
                  className={`lp-journey-step${isActive ? ' is-active' : ''}`}
                  onClick={() => selectStage(i)}
                >
                  <span className="lp-journey-step-icon" style={isActive ? { color: s.accent, background: `${s.accent}1f`, borderColor: `${s.accent}55` } : undefined}>
                    <s.Icon size={18} aria-hidden="true" />
                  </span>
                  <span className="lp-journey-step-text">
                    <span className="lp-journey-step-tab">{s.tab}</span>
                    <span className="lp-journey-step-title">{s.title}</span>
                    {isActive && <span className="lp-journey-step-body">{s.body}</span>}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="lp-journey-visual">
            <div className="lp-journey-sticky" id="lp-journey-panel" role="tabpanel" aria-labelledby={`lp-tab-${stage.id}`}>
              <SystemWindow stage={stage} />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── CRECIMIENTO ──────────────────────────────────────────────────────────────
function GrowthSection() {
  const scenarios = [
    {
      Icon: User, tag: 'Trabajás solo',
      title: 'Dejás de depender de tu memoria',
      body: 'Órdenes, clientes, stock y caja en un solo lugar. Sabés qué tenés que entregar hoy y cuánto cerraste, sin abrir tres apps.',
    },
    {
      Icon: Users, tag: 'Sumás un equipo',
      title: 'Cada uno sabe qué le toca',
      body: 'Asignás técnicos, repartís tareas y controlás quién hizo qué. Con roles y permisos, cada persona ve lo que necesita.',
    },
    {
      Icon: Building2, tag: 'El negocio crece',
      title: 'Escalás sin cambiar de sistema',
      body: 'Multisucursal, métricas por local y auditoría. El mismo sistema que usaste solo te acompaña cuando sos varios.',
    },
  ]
  return (
    <section id="crecimiento" className="lp-section lp-section-tint">
      <div className="lp-container">
        <div className="lp-section-head lp-reveal">
          <Eyebrow>Crece con vos</Eyebrow>
          <h2 className="lp-section-title">Arrancás solo. Crecés con equipo.</h2>
          <p className="lp-section-sub">
            No necesitás cambiar de herramienta cuando tu negocio cambia de tamaño.
          </p>
        </div>

        <div className="lp-growth-grid">
          {scenarios.map((s, i) => (
            <article key={s.tag} className="lp-growth-card lp-reveal" style={{ transitionDelay: `${i * 70}ms` }}>
              <span className="lp-growth-icon"><s.Icon size={20} aria-hidden="true" /></span>
              <span className="lp-growth-tag">{s.tag}</span>
              <h3 className="lp-growth-title">{s.title}</h3>
              <p className="lp-growth-body">{s.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── DIFERENCIACIÓN LOCAL ─────────────────────────────────────────────────────
function LocalSection() {
  const items = [
    { Icon: Wallet, title: 'Cobro y caja conectados', body: 'Cada venta y cada cobro actualizan la caja del día al instante. El cierre cuadra sin sumar a mano.' },
    { Icon: FileText, title: 'Comprobantes y ARCA', body: 'Emití comprobantes internos o factura ARCA con CAE según tu condición fiscal, desde el mismo flujo de venta.' },
    { Icon: DollarSign, title: 'Pesos y dólares', body: 'Cargás costos en USD y vendés en pesos. El sistema convierte con la cotización que elegís y mantiene todo coherente.' },
    { Icon: MessageCircle, title: 'WhatsApp del taller', body: 'Mensajes preparados para avisar estados, presupuestos y entregas. La comunicación queda registrada en la orden.' },
    { Icon: Users, title: 'Cuentas corrientes', body: 'Llevás lo que te deben los clientes y lo que le debés a proveedores, con saldo calculado por el sistema.' },
    { Icon: Package, title: 'Proveedores y compras', body: 'Registrás compras, pagos y deuda por proveedor, y los repuestos entran directo al inventario.' },
  ]
  return (
    <section className="lp-section">
      <div className="lp-container">
        <div className="lp-section-head lp-reveal">
          <Eyebrow>Hecho acá</Eyebrow>
          <h2 className="lp-section-title">Pensado para cómo trabaja un taller argentino.</h2>
          <p className="lp-section-sub">
            No es un sistema importado con cosas que no usás. Es la operación real de un taller, resuelta.
          </p>
        </div>

        <div className="lp-local-grid">
          {items.map((it, i) => (
            <article key={it.title} className="lp-local-card lp-reveal" style={{ transitionDelay: `${(i % 3) * 60}ms` }}>
              <span className="lp-local-icon"><it.Icon size={18} aria-hidden="true" /></span>
              <div>
                <h3 className="lp-local-title">{it.title}</h3>
                <p className="lp-local-body">{it.body}</p>
              </div>
            </article>
          ))}
        </div>

        <p className="lp-fineprint lp-reveal">
          <Zap size={14} aria-hidden="true" />
          La cotización del dólar es configurable y la facturación ARCA depende de los certificados fiscales de tu negocio.
        </p>
      </div>
    </section>
  )
}

// ─── VISTA DEL NEGOCIO ────────────────────────────────────────────────────────
function BusinessViewSection() {
  const accent = useThemedAccent()
  const rows = [
    { label: 'Ingresos del mes', value: '$1.840.000', pct: 88, color: '#34d399' },
    { label: 'Gastos', value: '$520.000', pct: 28, color: '#f87171' },
    { label: 'Resultado neto', value: '$1.320.000', pct: 72, color: '#818cf8' },
  ]
  const bullets = [
    'Qué se cobró y qué quedó pendiente',
    'Qué productos se vendieron y con qué margen',
    'Qué reparaciones tienen demora',
    'Cómo está la caja, hoy y en el mes',
  ]
  return (
    <section className="lp-section lp-section-tint">
      <div className="lp-container lp-split">
        <div className="lp-split-visual lp-reveal" aria-hidden="true">
          <div className="lp-window">
            <div className="lp-window-bar">
              <span className="lp-window-dots"><i /><i /><i /></span>
              <span className="lp-window-title">Finanzas · Mes actual</span>
              <span className="lp-window-status" style={{ color: accent('#34d399'), borderColor: `${accent('#34d399')}55`, background: `${accent('#34d399')}1a` }}>En vivo</span>
            </div>
            <div className="lp-fin-body">
              {rows.map(r => (
                <div key={r.label} className="lp-fin-row">
                  <div className="lp-fin-row-top">
                    <span>{r.label}</span>
                    <strong style={{ color: accent(r.color) }}>{r.value}</strong>
                  </div>
                  <div className="lp-fin-track"><span className="lp-fin-fill" style={{ width: `${r.pct}%`, background: accent(r.color) }} /></div>
                </div>
              ))}
              <div className="lp-fin-kpis">
                <div><strong style={{ color: accent('#fbbf24') }}>3</strong><span>Alertas</span></div>
                <div><strong style={{ color: accent('#60a5fa') }}>18</strong><span>Ventas hoy</span></div>
                <div><strong style={{ color: accent('#34d399') }}><Check size={18} /></strong><span>Caja abierta</span></div>
              </div>
            </div>
          </div>
        </div>

        <div className="lp-split-copy">
          <div className="lp-reveal"><Eyebrow>Para el dueño</Eyebrow></div>
          <h2 className="lp-section-title lp-reveal">Vos ves el negocio. No solo las reparaciones.</h2>
          <p className="lp-section-sub lp-reveal" style={{ marginBottom: '1.5rem' }}>
            Mientras el equipo trabaja, vos tenés una foto clara de cómo viene el negocio, sin pedirle números a nadie.
          </p>
          <ul className="lp-check-list lp-reveal">
            {bullets.map(b => (
              <li key={b}><span className="lp-check"><Check size={14} aria-hidden="true" /></span>{b}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

// ─── PRUEBA / CREDIBILIDAD ────────────────────────────────────────────────────
function CredibilitySection() {
  const items = [
    { Icon: Wrench, title: 'Hecho desde un taller real', body: 'No es un software genérico adaptado. Nació de la operación diaria de un servicio técnico.' },
    { Icon: ShieldCheck, title: 'Tus datos, en la nube', body: 'Infraestructura moderna sobre Supabase y PostgreSQL. Accedés desde donde estés.' },
    { Icon: Smartphone, title: 'Sin instalar nada', body: 'Funciona en el navegador: computadora, tablet y celular. Empezás hoy.' },
    { Icon: FileText, title: 'Facturación ARCA integrada', body: 'Emití comprobantes con CAE sin salir del sistema, según tu situación fiscal.' },
  ]
  return (
    <section className="lp-section">
      <div className="lp-container">
        <div className="lp-credibility">
          {items.map((it, i) => (
            <div key={it.title} className="lp-credibility-item lp-reveal" style={{ transitionDelay: `${i * 60}ms` }}>
              <span className="lp-credibility-icon"><it.Icon size={18} aria-hidden="true" /></span>
              <h3>{it.title}</h3>
              <p>{it.body}</p>
            </div>
          ))}
        </div>
        {/*
          Espacio reservado para prueba social real (testimonios verificables, logos, métricas).
          No se incluyen datos inventados. Cuando existan reseñas reales de talleres usuarios,
          insertar aquí un carrusel/grilla con nombre, local y resultado concreto.
        */}
      </div>
    </section>
  )
}

// ─── PLANES (precios desde la fuente única: PLANS) ─────────────────────────────
type Cycle = 'monthly' | 'annual'

function PricingSection({ onSelect }: { onSelect: (plan: SubscriptionPlan) => void }) {
  const [cycle, setCycle] = useState<Cycle>('monthly')
  const annual = cycle === 'annual'

  const audience: Record<SubscriptionPlan, string> = {
    basico: 'Para empezar a ordenar el taller',
    pro:    'Para controlar operación, números y crecimiento',
    full:   'Para equipos y operaciones más complejas',
  }

  return (
    <section id="planes" data-track="pricing" className="lp-section lp-section-tint">
      <div className="lp-container">
        <div className="lp-section-head lp-reveal">
          <Eyebrow>Planes</Eyebrow>
          <h2 className="lp-section-title">Empezá con el plan que se adapta a vos.</h2>
          <p className="lp-section-sub">
            {TRIAL_DAYS} días de prueba con funciones del plan Pro. Sin tarjeta. Cancelás cuando quieras.
          </p>

          <div className="lp-billing" role="group" aria-label="Ciclo de facturación">
            <button className={`lp-billing-opt${!annual ? ' is-active' : ''}`} onClick={() => setCycle('monthly')} aria-pressed={!annual}>
              Mensual
            </button>
            <button className={`lp-billing-opt${annual ? ' is-active' : ''}`} onClick={() => setCycle('annual')} aria-pressed={annual}>
              Anual <span className="lp-billing-save">−20%</span>
            </button>
          </div>
        </div>

        <div className="lp-plans">
          {PLANS.map(plan => {
            const monthly = annual ? Math.round(plan.price_annual / 12) : plan.price_monthly
            const featured = !!plan.highlighted
            return (
              <article key={plan.id} className={`lp-plan${featured ? ' is-featured' : ''} lp-reveal`}>
                {featured && <span className="lp-plan-ribbon">Más elegido</span>}
                <header className="lp-plan-head">
                  <span className="lp-plan-name">{plan.name}</span>
                  <span className="lp-plan-audience">{audience[plan.id]}</span>
                </header>
                <div className="lp-plan-price">
                  <span className="lp-plan-currency">$</span>
                  <span className="lp-plan-amount">{monthly.toLocaleString('es-AR')}</span>
                  <span className="lp-plan-period">/mes</span>
                </div>
                <p className="lp-plan-cycle">
                  {annual
                    ? `$${plan.price_annual.toLocaleString('es-AR')} al año`
                    : 'Facturación mensual'}
                </p>
                <ul className="lp-plan-features">
                  {plan.features.map(f => (
                    <li key={f}>
                      <span className="lp-check" style={featured ? { color: 'var(--lp-accent-2)' } : undefined}><Check size={14} aria-hidden="true" /></span>
                      {f}
                    </li>
                  ))}
                </ul>
                <button
                  className={`lp-btn lp-btn-block ${featured ? 'lp-btn-primary' : 'lp-btn-ghost'}`}
                  onClick={() => onSelect(plan.id)}
                >
                  Probar gratis {TRIAL_DAYS} días
                </button>
              </article>
            )
          })}
        </div>

        <p className="lp-fineprint lp-reveal">
          <ShieldCheck size={14} aria-hidden="true" />
          Mi Guita (finanzas personales) y la facturación ARCA están incluidas desde el plan Pro.
        </p>
      </div>
    </section>
  )
}

// ─── FAQ ──────────────────────────────────────────────────────────────────────
function FAQSection() {
  const [open, setOpen] = useState<number | null>(0)
  const faqs = [
    { q: '¿Puedo probarlo gratis?', a: `Sí. Tenés ${TRIAL_DAYS} días de prueba con las funciones del plan Pro, sin tarjeta de crédito. Al terminar elegís un plan o seguís más adelante.` },
    { q: '¿Necesito instalar algo?', a: 'No. Funciona en el navegador, en computadora, tablet y celular. No instalás programas ni servidores.' },
    { q: '¿Funciona desde el celular?', a: 'Sí. Es responsive y está pensado para usarse también desde el mostrador con el teléfono.' },
    { q: '¿Cuánto cuesta empezar?', a: `Empezás con ${TRIAL_DAYS} días gratis. Después, los planes arrancan en $${PLANS[0].price_monthly.toLocaleString('es-AR')} por mes (Básico), con opción mensual o anual con descuento.` },
    { q: '¿Puedo cancelar cuando quiera?', a: 'Sí. No hay contratos ni permanencia. Cancelás cuando quieras desde Configuración → Suscripción.' },
    { q: '¿Sirve para un técnico que trabaja solo?', a: 'Sí. El plan Básico está pensado para técnicos independientes y locales chicos: órdenes, clientes, inventario, caja y comprobantes internos.' },
    { q: '¿Sirve para varias sucursales?', a: 'Sí. El plan Full incluye multisucursal con stock, caja y métricas por local, y permisos por usuario.' },
    { q: '¿Cómo funciona la facturación ARCA?', a: 'Desde el plan Pro podés emitir facturas y notas de crédito con CAE. Requiere configurar los certificados fiscales de tu negocio.' },
    { q: '¿Qué acompañamiento recibo?', a: 'Tenés soporte humano por los canales del negocio y actualizaciones del sistema sin costo adicional.' },
    { q: '¿Qué pasa con mis datos?', a: 'Tus datos quedan en la nube sobre Supabase y PostgreSQL, asociados a tu negocio. Accedés desde cualquier dispositivo con tu cuenta.' },
  ]
  const toggle = (i: number) => {
    const next = open === i ? null : i
    setOpen(next)
    // faq_id viaja a GA4 (allowlist); `question` queda sólo en el contrato interno.
    if (next === i) track('faq_opened', { faq_id: i, question: faqs[i].q })
  }
  return (
    <section id="faq" className="lp-section">
      <div className="lp-container">
        <div className="lp-section-head lp-reveal">
          <Eyebrow>Preguntas frecuentes</Eyebrow>
          <h2 className="lp-section-title">Las dudas antes de empezar.</h2>
        </div>
        <div className="lp-faq">
          {faqs.map((f, i) => {
            const isOpen = open === i
            return (
              <div key={f.q} className={`lp-faq-item${isOpen ? ' is-open' : ''} lp-reveal`}>
                <button
                  className="lp-faq-q"
                  onClick={() => toggle(i)}
                  aria-expanded={isOpen}
                  aria-controls={`lp-faq-a-${i}`}
                >
                  <span>{f.q}</span>
                  <ChevronDown size={18} className="lp-faq-chev" aria-hidden="true" />
                </button>
                <div className="lp-faq-a-wrap" id={`lp-faq-a-${i}`} role="region" aria-labelledby={`lp-faq-q-${i}`}>
                  <div className="lp-faq-a-inner"><p>{f.a}</p></div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ─── CTA FINAL ────────────────────────────────────────────────────────────────
function FinalCTA({ onTrial }: { onTrial: (s: string) => void }) {
  return (
    <section className="lp-final">
      <div className="lp-final-bg" aria-hidden="true"><span className="lp-hero-glow lp-hero-glow-1" /></div>
      <div className="lp-container lp-final-inner lp-reveal">
        <h2 className="lp-final-title">Tu taller ya funciona.<br />Ahora puede funcionar como una empresa.</h2>
        <p className="lp-final-sub">
          Probá TechRepair Pro gratis durante {TRIAL_DAYS} días y poné cada reparación, venta y peso en un solo lugar.
        </p>
        <button className="lp-btn lp-btn-primary lp-btn-lg" onClick={() => onTrial('cta_final')}>
          Probar gratis {TRIAL_DAYS} días <ArrowRight size={18} />
        </button>
        <p className="lp-final-note">Sin tarjeta · Funciones Pro durante la prueba · Cancelás cuando quieras</p>
      </div>
    </section>
  )
}

// ─── FOOTER ───────────────────────────────────────────────────────────────────
function Footer({ onTrial }: { onTrial: (s: string) => void }) {
  const navigate = useNavigate()
  return (
    <footer className="lp-footer">
      <div className="lp-container">
        <div className="lp-footer-grid">
          <div className="lp-footer-brand">
            <a href="#top" className="lp-logo" onClick={e => { e.preventDefault(); smoothScroll('top') }}>
              <span className="lp-logo-mark"><BrandLogo size={20} /></span>
              <span className="lp-logo-text">TechRepair<span>Pro</span></span>
            </a>
            <p>Sistema de gestión para servicios técnicos, talleres de reparación y locales de celulares. Hecho en Argentina.</p>
            {HAS_SOCIAL && (
              <div className="lp-footer-social">
                {CONTACT.instagram && (
                  <a href={`https://instagram.com/${CONTACT.instagram}`} target="_blank" rel="noopener noreferrer" aria-label="Instagram de TechRepair Pro">
                    <Smartphone size={18} aria-hidden="true" />
                  </a>
                )}
                {CONTACT.whatsapp && (
                  <a href={`https://wa.me/${CONTACT.whatsapp}`} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp de TechRepair Pro">
                    <WhatsAppGlyph size={18} />
                  </a>
                )}
              </div>
            )}
          </div>

          <nav className="lp-footer-col" aria-label="Producto">
            <h3>Producto</h3>
            <button onClick={() => smoothScroll('recorrido')}>Cómo funciona</button>
            <button onClick={() => smoothScroll('crecimiento')}>Soluciones</button>
            <button onClick={() => smoothScroll('planes')}>Planes</button>
            <button onClick={() => smoothScroll('faq')}>Preguntas frecuentes</button>
          </nav>

          <nav className="lp-footer-col" aria-label="Empezar">
            <h3>Empezar</h3>
            <button onClick={() => onTrial('footer')}>Probar gratis</button>
            <button onClick={() => navigate('/login')}>Ingresar</button>
            {CONTACT.email && <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>}
          </nav>
        </div>

        <div className="lp-footer-bottom">
          <span>© {new Date().getFullYear()} TechRepair Pro · Argentina</span>
          <span>Hecho para técnicos, por técnicos.</span>
        </div>
      </div>
    </footer>
  )
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export function LandingPage() {
  const navigate = useNavigate()
  const rootRef = useRef<HTMLDivElement | null>(null)

  const startTrial = useCallback((source: string) => {
    if (source === 'hero') track('hero_trial_click', { source })
    track('signup_started', { source })
    navigate('/onboarding')
  }, [navigate])

  const openDemo = useCallback(() => {
    track('hero_product_demo_click')
    smoothScroll('recorrido')
  }, [])

  const selectPlan = useCallback((plan: SubscriptionPlan) => {
    // `plan` proviene de PLANS (la grilla mapea sobre la fuente de verdad), así que
    // ya es un id válido. Se pasa por query param y el onboarding lo revalida.
    track('plan_selected', { plan })
    track('signup_started', { source: 'pricing', plan })
    navigate(`/onboarding?plan=${plan}`)
  }, [navigate])

  // Analytics + reveals + section tracking
  useEffect(() => {
    initLandingAnalytics()
    track('landing_view')

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const root = rootRef.current

    let revealObs: IntersectionObserver | null = null
    if (!reduce && root) {
      root.classList.add('lp-anim')
      revealObs = new IntersectionObserver((entries, obs) => {
        entries.forEach(e => {
          if (e.isIntersecting) { e.target.classList.add('is-visible'); obs.unobserve(e.target) }
        })
      }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' })
      root?.querySelectorAll('.lp-reveal').forEach(el => revealObs?.observe(el))
    }

    const seen = new Set<string>()
    const sectionObs = new IntersectionObserver(entries => {
      entries.forEach(e => {
        const id = (e.target as HTMLElement).dataset.track
        if (e.isIntersecting && id && !seen.has(id)) {
          seen.add(id)
          if (id === 'journey') track('journey_section_reached')
          if (id === 'pricing') track('pricing_section_reached')
        }
      })
    }, { threshold: 0.3 })
    root?.querySelectorAll('[data-track]').forEach(el => sectionObs.observe(el))

    return () => { revealObs?.disconnect(); sectionObs.disconnect() }
  }, [])

  return (
    <div className="landing-root" ref={rootRef}>
      <Header onTrial={startTrial} />
      <main>
        <Hero onTrial={startTrial} onDemo={openDemo} />
        <ProblemSection />
        <JourneySection />
        <GrowthSection />
        <LocalSection />
        <BusinessViewSection />
        <CredibilitySection />
        <PricingSection onSelect={selectPlan} />
        <FAQSection />
        <FinalCTA onTrial={startTrial} />
      </main>
      <Footer onTrial={startTrial} />
    </div>
  )
}

export default LandingPage
