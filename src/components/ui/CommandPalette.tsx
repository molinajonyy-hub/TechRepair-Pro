/**
 * CommandPalette — paleta de comandos global tipo Raycast / Linear.
 *
 * Abre con Ctrl+K / ⌘K desde cualquier parte de la app.
 * Cierra con Esc.
 *
 * Muestra:
 *   - Acciones rápidas (sin query)
 *   - Resultados de búsqueda global en tiempo real (con query)
 *
 * Integración:
 *   1. Renderizar <CommandPalette /> en MainLayout.
 *   2. Para abrir desde código: window.dispatchEvent(new Event('tr-open-palette'))
 *
 * Uso interno:
 *   El componente registra el handler de Ctrl+K internamente.
 *   No necesita props — es completamente autónomo.
 */

import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, X, User, Package, FileText, Wrench,
  Plus, ShoppingCart, DollarSign, BarChart3,
  Loader2, ArrowRight, Zap, Users, Truck,
  ClipboardList, Smartphone, type LucideIcon,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { tokenize } from '../../utils/searchUtils'
import { animate, transition, duration } from '../../lib/motion'
import { colors } from '../../lib/tokens'
import { currencyService } from '../../services/currencyService'
import { resolveProductPricing } from '../../lib/pricing/productPricing'

// ─── Types ────────────────────────────────────────────────────────────────────

type ResultType = 'customer' | 'order' | 'inventory' | 'comprobante' | 'supplier' | 'device'
type ActionType = 'navigation' | 'action'

interface PaletteItem {
  id:       string
  type:     ResultType | ActionType
  icon:     LucideIcon
  label:    string
  sublabel?: string
  badge?:   string
  badgeColor?: string
  /** Precio ARS vigente (productos): mismo valor resuelto que Inventario y POS. */
  price?:   string
  path?:    string
  action?:  () => void
  group:    string
}

// ─── Acciones rápidas (sin query) ─────────────────────────────────────────────

const QUICK_ACTIONS: PaletteItem[] = [
  { id: 'new-order',        type: 'action',     group: 'Crear', icon: Plus,         label: 'Nueva Orden',           path: '/orders/new' },
  { id: 'new-comp',         type: 'action',     group: 'Crear', icon: FileText,     label: 'Nuevo Comprobante',     path: '/comprobantes' },
  { id: 'new-customer',     type: 'action',     group: 'Crear', icon: User,         label: 'Nuevo Cliente',         path: '/customers/new' },
  { id: 'new-expense',      type: 'action',     group: 'Crear', icon: DollarSign,   label: 'Registrar Gasto',       path: '/expenses' },
  { id: 'go-dashboard',     type: 'navigation', group: 'Ir a',  icon: BarChart3,    label: 'Inicio / Dashboard',    path: '/' },
  { id: 'go-orders',        type: 'navigation', group: 'Ir a',  icon: Wrench,       label: 'Órdenes',               path: '/orders' },
  { id: 'go-inventory',     type: 'navigation', group: 'Ir a',  icon: Package,      label: 'Inventario',            path: '/inventory' },
  { id: 'go-customers',     type: 'navigation', group: 'Ir a',  icon: Users,        label: 'Clientes',              path: '/customers' },
  { id: 'go-suppliers',     type: 'navigation', group: 'Ir a',  icon: Truck,        label: 'Proveedores',           path: '/suppliers' },
  { id: 'go-comprobantes',  type: 'navigation', group: 'Ir a',  icon: FileText,     label: 'Comprobantes',          path: '/comprobantes' },
  { id: 'go-caja',          type: 'navigation', group: 'Ir a',  icon: ShoppingCart, label: 'Caja',                  path: '/caja' },
  { id: 'go-cuentas',       type: 'navigation', group: 'Ir a',  icon: Users,        label: 'Cuentas Corrientes',    path: '/cuentas' },
  { id: 'go-finance',       type: 'navigation', group: 'Ir a',  icon: BarChart3,    label: 'Finanzas',              path: '/finance' },
  { id: 'go-tasks',         type: 'navigation', group: 'Ir a',  icon: ClipboardList,label: 'Tareas',                path: '/tasks' },
]

// ─── Config visual por tipo de resultado ─────────────────────────────────────

const TYPE_META: Record<string, { label: string; color: string }> = {
  customer:    { label: 'Cliente',     color: colors.indigo },
  order:       { label: 'Orden',       color: colors.warning },
  inventory:   { label: 'Producto',    color: '#22c55e' },
  comprobante: { label: 'Comprobante', color: '#a78bfa' },
  supplier:    { label: 'Proveedor',   color: '#fb923c' },
  device:      { label: 'Equipo',      color: '#22d3ee' },
  action:      { label: '',            color: colors.text.subtle },
  navigation:  { label: '',            color: colors.text.subtle },
}

const F = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"

// ─── ResultRow ────────────────────────────────────────────────────────────────

interface ResultRowProps {
  item:      PaletteItem
  isActive:  boolean
  onSelect:  () => void
  onHover:   () => void
}

const ResultRow = memo(function ResultRow({ item, isActive, onSelect, onHover }: ResultRowProps) {
  const Icon = item.icon
  const meta = TYPE_META[item.type] ?? TYPE_META.action

  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); onSelect() }}
      onMouseEnter={onHover}
      style={{
        display: 'flex', alignItems: 'center', gap: '0.75rem',
        width: '100%', padding: '0.625rem 1rem',
        background: isActive ? 'rgba(99,102,241,0.1)' : 'none',
        border: 'none', cursor: 'pointer', textAlign: 'left',
        fontFamily: F, transition: `background ${duration.fast}ms`,
      }}
    >
      {/* Icon */}
      <div style={{
        width: 34, height: 34, borderRadius: '0.5rem', flexShrink: 0,
        background: isActive ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.05)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: `background ${duration.fast}ms`,
      }}>
        <Icon size={15} color={isActive ? colors.indigo : colors.text.subtle} />
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          color: isActive ? '#f0f4ff' : colors.text.secondary,
          fontSize: '0.845rem', fontWeight: 500,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {item.label}
        </div>
        {item.sublabel && (
          <div style={{ color: colors.text.muted, fontSize: '0.72rem', marginTop: '0.1rem',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.sublabel}
          </div>
        )}
      </div>

      {/* Precio vigente (productos) */}
      {item.price && (
        <span style={{
          fontSize: '0.78rem', fontWeight: 700, color: '#22c55e', flexShrink: 0,
        }}>
          {item.price}
        </span>
      )}

      {/* Badge */}
      {(item.badge || meta.label) && (
        <span style={{
          fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.4rem',
          borderRadius: '0.25rem',
          background: `${item.badgeColor ?? meta.color}18`,
          color: item.badgeColor ?? meta.color,
          flexShrink: 0,
        }}>
          {item.badge ?? meta.label}
        </span>
      )}

      {/* Enter indicator */}
      {isActive && (
        <span style={{
          fontSize: '0.62rem', color: colors.text.disabled,
          background: 'rgba(255,255,255,0.06)', padding: '0.1rem 0.4rem',
          borderRadius: '0.25rem', flexShrink: 0, fontFamily: 'monospace',
        }}>
          Enter
        </span>
      )}
    </button>
  )
})

// ─── Componente principal ─────────────────────────────────────────────────────

export function CommandPalette() {
  const { businessId } = useAuth()
  const navigate = useNavigate()

  const [open,     setOpen]     = useState(false)
  const [query,    setQuery]    = useState('')
  const [results,  setResults]  = useState<PaletteItem[]>([])
  const [loading,  setLoading]  = useState(false)
  const [activeIdx,setActiveIdx]= useState(0)

  const inputRef   = useRef<HTMLInputElement>(null)
  const listRef    = useRef<HTMLDivElement>(null)
  const searchRef  = useRef<ReturnType<typeof setTimeout>>()
  // Cotización USD→ARS vigente para dolarizar precios de productos (compute-at-read).
  // En un ref para no recrear la búsqueda ni re-render al cargarse.
  const rateRef    = useRef(0)

  useEffect(() => {
    if (!businessId) { rateRef.current = 0; return }
    let alive = true
    currencyService.getCurrentExchangeRate('USD', 'ARS')
      .then(r => { if (alive) rateRef.current = r || 0 })
      .catch(() => { if (alive) rateRef.current = 0 })
    return () => { alive = false }
  }, [businessId])

  // Mostrar acciones rápidas cuando no hay query
  const displayItems = query.length >= 2 ? results : QUICK_ACTIONS

  // ── Open/close ────────────────────────────────────────────────────────────

  const openPalette = useCallback(() => {
    setOpen(true)
    setQuery('')
    setResults([])
    setActiveIdx(0)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const closePalette = useCallback(() => {
    setOpen(false)
    setQuery('')
    setResults([])
  }, [])

  // ── Keyboard handler global ───────────────────────────────────────────────

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (open) closePalette(); else openPalette()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, openPalette, closePalette])

  // ── Custom event (para abrir desde otros componentes) ─────────────────────

  useEffect(() => {
    const h = () => openPalette()
    window.addEventListener('tr-open-palette', h)
    return () => window.removeEventListener('tr-open-palette', h)
  }, [openPalette])

  // ── Keyboard navigation dentro del overlay ────────────────────────────────

  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { closePalette(); return }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx(i => Math.min(i + 1, displayItems.length - 1))
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx(i => Math.max(i - 1, 0))
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = displayItems[activeIdx]
        if (item) handleSelect(item)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, displayItems, activeIdx])

  // ── Auto-scroll del item activo ───────────────────────────────────────────

  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  // ── Búsqueda ──────────────────────────────────────────────────────────────

  useEffect(() => {
    clearTimeout(searchRef.current)
    if (query.length < 2) { setResults([]); setActiveIdx(0); return }

    setLoading(true)
    searchRef.current = setTimeout(() => {
      void performSearch(query)
    }, 160)

    return () => clearTimeout(searchRef.current)
  }, [query, businessId])

  const performSearch = async (q: string) => {
    if (!businessId || q.length < 2) { setLoading(false); return }

    const tokens = tokenize(q)
    if (!tokens.length) { setLoading(false); return }
    const term = `%${tokens.sort((a, b) => b.length - a.length)[0]}%`

    try {
      const [customersRes, inventoryRes, ordersRes, comprobantesRes, suppliersRes, devicesRes] = await Promise.all([
        supabase.from('customers').select('id,name,phone,customer_type')
          .eq('business_id', businessId)
          .or(`name.ilike.${term},phone.ilike.${term},email.ilike.${term}`)
          .limit(4),
        // Trae los campos de pricing para resolver el precio vigente con el mismo
        // motor que Inventario y POS (resolveProductPricing) — sin cálculo duplicado.
        supabase.from('inventory').select('id,name,code,stock_quantity,category,sale_price,precio_mayorista,cost_price,cost_price_usd,base_price,base_currency,auto_update_price,exchange_rate_used')
          .eq('business_id', businessId).eq('is_active', true)
          .or(`name.ilike.${term},code.ilike.${term},description.ilike.${term}`)
          .limit(4),
        supabase.from('orders').select('id,status,customer:customers(name)')
          .eq('business_id', businessId).ilike('id', term).limit(3),
        supabase.from('comprobantes').select('id,numero,numero_fiscal,tipo,total_ars,estado')
          .eq('business_id', businessId)
          .or(`numero.ilike.${term},numero_fiscal.ilike.${term}`)
          .limit(4),
        supabase.from('suppliers').select('id,name,phone')
          .eq('business_id', businessId).eq('active', true)
          .ilike('name', term).limit(3),
        // Devices: search by IMEI, brand, model — no business_id (linked via order)
        supabase.from('devices').select('id,brand,model,imei,order_id')
          .or(`imei.ilike.${term},brand.ilike.${term},model.ilike.${term}`)
          .limit(4),
      ])

      const items: PaletteItem[] = []

      for (const c of customersRes.data ?? []) {
        items.push({ id: c.id, type: 'customer', group: 'Clientes', icon: User,
          label: c.name, sublabel: c.phone || undefined,
          path: `/customers/${c.id}` })
      }
      for (const p of inventoryRes.data ?? []) {
        // Precio vigente minorista, dolarizado si el producto es USD-auto.
        // Mismo motor que Inventario y POS → siempre el mismo precio.
        const saleArs = resolveProductPricing(p, rateRef.current).saleArs
        items.push({ id: p.id, type: 'inventory', group: 'Productos', icon: Package,
          label: p.name, sublabel: `${p.code} · stock: ${p.stock_quantity}`,
          price: saleArs > 0 ? '$' + Math.round(saleArs).toLocaleString('es-AR') : undefined,
          path: '/inventory' })
      }
      for (const s of suppliersRes.data ?? []) {
        items.push({ id: s.id, type: 'supplier', group: 'Proveedores', icon: Truck,
          label: s.name, sublabel: s.phone || undefined,
          path: '/suppliers' })
      }
      for (const o of ordersRes.data ?? []) {
        const cust = (o.customer as any)?.name ?? 'Sin cliente'
        items.push({ id: o.id, type: 'order', group: 'Órdenes', icon: Wrench,
          label: `Orden #${o.id.slice(-6).toUpperCase()}`, sublabel: cust,
          badge: o.status, path: `/orders/${o.id}` })
      }
      for (const c of comprobantesRes.data ?? []) {
        const num = c.numero_fiscal ?? c.numero
        items.push({ id: c.id, type: 'comprobante', group: 'Comprobantes', icon: FileText,
          label: `${c.tipo ?? 'Comprobante'} #${num}`,
          sublabel: c.total_ars ? `$${Math.round(c.total_ars).toLocaleString('es-AR')}` : undefined,
          path: `/comprobantes/${c.id}` })
      }
      // Devices: navigate to the associated order
      for (const d of devicesRes.data ?? []) {
        const label = [d.brand, d.model].filter(Boolean).join(' ') || 'Equipo'
        items.push({
          id: d.id, type: 'device', group: 'IMEI / Equipos', icon: Smartphone,
          label, sublabel: d.imei ? `IMEI: ${d.imei}` : undefined,
          path: d.order_id ? `/orders/${d.order_id}` : '/orders',
        })
      }

      setResults(items)
      setActiveIdx(0)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  // ── Selección ─────────────────────────────────────────────────────────────

  const handleSelect = useCallback((item: PaletteItem) => {
    closePalette()
    if (item.path) navigate(item.path)
    if (item.action) item.action()
  }, [navigate, closePalette])

  // ── Agrupar items ─────────────────────────────────────────────────────────

  const groups = displayItems.reduce<Record<string, PaletteItem[]>>((acc, item) => {
    if (!acc[item.group]) acc[item.group] = []
    acc[item.group].push(item)
    return acc
  }, {})

  // ── Render ────────────────────────────────────────────────────────────────

  if (!open) return null

  return (
    <div
      data-testid="global-search-modal"
      style={{
        position: 'fixed', inset: 0, zIndex: 99998,
        background: 'rgba(0,0,0,0.72)',
        backdropFilter: 'blur(12px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '8vh', fontFamily: F,
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) closePalette() }}
    >
      <div style={{
        width: '100%', maxWidth: 620,
        background: 'rgba(8,16,32,0.98)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '1.125rem',
        boxShadow: '0 40px 100px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.04)',
        overflow: 'hidden',
        animation: animate('tr-overlay-in'),
      }}>

        {/* ── Search input ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.875rem',
          padding: '1rem 1.25rem',
          borderBottom: `1px solid ${colors.border.subtle}`,
        }}>
          {loading
            ? <Loader2 size={18} color={colors.indigo} style={{ flexShrink: 0, animation: animate('tr-spin', 800, 'linear', 'none') }} />
            : <Search size={18} color={query ? colors.indigo : colors.text.muted} style={{ flexShrink: 0, transition: transition.fast }} />
          }
          <input
            ref={inputRef}
            data-testid="global-search-input"
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIdx(0) }}
            placeholder="Buscar clientes, órdenes, comprobantes, productos, equipos/IMEI... (Esc para cerrar)"
            style={{
              flex: 1, background: 'none', border: 'none', outline: 'none',
              color: '#f0f4ff', fontSize: '1rem', fontFamily: F,
              caretColor: colors.indigo,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
            <kbd style={{ fontSize: '0.65rem', color: colors.text.disabled, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.25rem', padding: '0.1rem 0.4rem' }}>Esc</kbd>
          </div>
          <button onClick={closePalette} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.text.muted, padding: '0.2rem', display: 'flex', flexShrink: 0 }}>
            <X size={15} />
          </button>
        </div>

        {/* ── Results ── */}
        <div ref={listRef} style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {displayItems.length === 0 && query.length >= 2 && !loading && (
            <div style={{ padding: '2rem', textAlign: 'center', color: colors.text.muted, fontSize: '0.875rem' }}>
              Sin resultados para "<strong style={{ color: colors.text.subtle }}>{query}</strong>"
            </div>
          )}

          {Object.entries(groups).map(([group, items]) => (
            <div key={group}>
              <div style={{
                padding: '0.5rem 1rem 0.25rem',
                fontSize: '0.62rem', fontWeight: 700, color: colors.text.disabled,
                textTransform: 'uppercase', letterSpacing: '0.07em',
                display: 'flex', alignItems: 'center', gap: '0.5rem',
              }}>
                {group}
                <div style={{ flex: 1, height: 1, background: colors.border.subtle }} />
              </div>
              {items.map((item) => {
                const globalIdx = displayItems.indexOf(item)
                return (
                  <ResultRow
                    key={item.id}
                    item={item}
                    isActive={globalIdx === activeIdx}
                    onSelect={() => handleSelect(item)}
                    onHover={() => setActiveIdx(globalIdx)}
                  />
                )
              })}
            </div>
          ))}
        </div>

        {/* ── Footer ── */}
        <div style={{
          padding: '0.5rem 1rem',
          borderTop: `1px solid ${colors.border.subtle}`,
          display: 'flex', alignItems: 'center', gap: '1rem',
          fontSize: '0.65rem', color: colors.text.disabled,
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <ArrowRight size={10} /> Seleccionar
          </span>
          <span>↑↓ Navegar</span>
          <span>Esc Cerrar</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', marginLeft: 'auto' }}>
            <Zap size={9} color={colors.indigo} />
            <span style={{ color: colors.indigo, fontWeight: 700 }}>⌘K</span>
          </span>
        </div>
      </div>

      {/* Inject keyframes */}
      <style>{`
        @keyframes tr-overlay-in { from { opacity:0; transform:scale(0.96) translateY(-8px); } to { opacity:1; transform:none; } }
        @keyframes tr-spin        { to { transform:rotate(360deg); } }
      `}</style>
    </div>
  )
}
