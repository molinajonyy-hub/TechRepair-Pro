/**
 * ComprobanteProModal — POS premium single-screen comprobante.
 * UX inspirada en Shopify POS / Stripe / Apple Store.
 *
 * Misma lógica que ModalCrearComprobante.
 * Solo UI/UX rediseñada: cards premium, spotlight con teclado,
 * panel derecho jerarquizado, success screen, animaciones suaves.
 */
import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { ProductFormModalSafe as ProductFormModal } from '../products/ProductFormModal'
import type { InventoryItem as InventoryItemFull } from '../../hooks/useInventory'
import { isWholesaleCustomer, getProductPriceForCustomer } from '../../utils/pricing'
import {
  X, Search, Plus, DollarSign, Package, Wrench, Tag,
  AlertCircle, CheckCircle2, User, Loader2,
  Wallet, Receipt, RefreshCw, Zap, ChevronUp, ChevronDown,
  Keyboard, Minus, Printer, MessageCircle,
} from 'lucide-react'
import { currencyService } from '../../services/currencyService'
import { smartSearch, buildSupabaseQuery } from '../../utils/searchUtils'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { useCaja } from '../../contexts/CajaContext'
import { formatDisplayMessage } from '../../utils/formatMessage'
import {
  comprobanteService,
  TipoComprobante, TipoLinea, MedioPago,
  ComprobantePago, CrearComprobanteInput,
} from '../../services/comprobanteService'
import { usePaymentCommissions, type FlatPaymentMethod } from '../../hooks/usePaymentCommissions'

// ─── Types ────────────────────────────────────────────────────────────────────

interface InventoryResult {
  id: string; code: string; name: string; variant_name?: string | null
  category: string; stock_quantity: number; cost_price: number
  sale_price: number; precio_mayorista?: number | null
  base_price?: number | null; base_currency?: string | null; has_variants?: boolean | null
}
interface ClienteOption { id: string; name: string; cuit?: string; customer_type?: string; phone?: string }
interface LineaItem {
  _key: string; tipo_linea: TipoLinea; descripcion: string; inventory_id?: string | null
  cantidad: number; precio_unitario: number; descuento_linea: number
  costo_unitario: number; currency: 'ARS' | 'USD'
  inv_sale_price?: number; inv_cost_price?: number
  inv_stock?: number; inv_mayorista_price?: number | null
  applied_price_type?: 'minorista' | 'mayorista' | 'manual'
  no_mayorista_warning?: boolean
}
interface PagoLinea {
  _key: string; payment_method: MedioPago; payment_provider: string
  amount: string; commission_rate: number
}

// ─── Config ───────────────────────────────────────────────────────────────────

const TIPO_CONFIG: Record<TipoComprobante, { label: string; short: string; color: string; bg: string; border: string; fiscal: boolean }> = {
  factura_a:    { label: 'Factura A',       short: 'A',     color: '#818cf8', bg: 'rgba(99,102,241,0.12)',  border: 'rgba(99,102,241,0.4)',  fiscal: true },
  factura_c:    { label: 'Factura C',       short: 'C',     color: '#34d399', bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.4)',  fiscal: true },
  nota_credito: { label: 'Nota Crédito',    short: 'NC',    color: '#f87171', bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.4)',   fiscal: true },
  remito:       { label: 'Remito',          short: 'REM',   color: '#fbbf24', bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.4)',  fiscal: false },
}
const CONDICIONES = ['Consumidor Final','Responsable Inscripto','Monotributo','Exento','Responsable No Inscripto']
const emptyLinea = (): LineaItem => ({
  _key: Math.random().toString(36).slice(2),
  tipo_linea: 'producto', descripcion: '', cantidad: 1,
  precio_unitario: 0, descuento_linea: 0, costo_unitario: 0, currency: 'ARS',
})
const F = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
const fmtARS = (n: number) => '$' + Math.round(n).toLocaleString('es-AR')
const stockState = (qty: number) => qty <= 0 ? 'out' : qty <= 5 ? 'low' : 'ok'
const STOCK_COLORS = { ok: '#22c55e', low: '#f59e0b', out: '#ef4444' }
const STOCK_LABELS = { ok: '', low: 'Stock bajo', out: 'Sin stock' }

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ComprobanteProModalProps {
  isOpen: boolean; onClose: () => void; onCreado?: () => void
  tipoInicial?: TipoComprobante; puntoVentaInicial?: string; condicionFiscalInicial?: string
  initialItems?: { descripcion: string; cantidad: number; precio_unitario: number; currency?: 'ARS'|'USD'; inventory_id?: string; costo_unitario?: number; tipo_linea?: TipoLinea }[]
  initialClienteId?: string; usarPrecioMayorista?: boolean; skipFinanceEntry?: boolean
}

// ─── LineaCard (memoized) ─────────────────────────────────────────────────────

interface LineaCardProps {
  linea: LineaItem; idx: number; canDelete: boolean; esClienteMayorista: boolean
  exchangeRate: number
  isSearchActive: boolean; lineResults: InventoryResult[]; lineSearchLoading: boolean
  onDescChange: (idx: number, val: string) => void
  onUpdate: (updates: Partial<LineaItem>) => void
  onDelete: () => void
  onSelectInv: (inv: InventoryResult) => void
  onCreateProduct: () => void
  onSearchFocus: () => void
  dropdownRef: (el: HTMLDivElement | null) => void
}

const LineaCard = memo(function LineaCard({
  linea, idx, canDelete, esClienteMayorista, exchangeRate,
  isSearchActive, lineResults, lineSearchLoading,
  onDescChange, onUpdate, onDelete, onSelectInv, onCreateProduct, onSearchFocus, dropdownRef,
}: LineaCardProps) {
  const subtotal = linea.cantidad * linea.precio_unitario * (1 - (linea.descuento_linea || 0) / 100) * (linea.currency === 'USD' ? exchangeRate : 1)
  const stock = linea.inv_stock ?? -1
  const ss = stock >= 0 ? stockState(stock) : null
  const TipoIcon = linea.tipo_linea === 'repuesto' ? Wrench : linea.tipo_linea === 'servicio' ? Tag : Package

  return (
    <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.875rem', overflow: 'visible', animation: 'itemSlideIn 0.18s ease', transition: 'border-color 0.15s' }}
      onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(99,102,241,0.25)'}
      onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.07)'}
    >
      {/* Card body */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', padding: '0.75rem 0.875rem' }}>
        {/* Product icon */}
        <div style={{ width: 36, height: 36, borderRadius: '0.5rem', background: linea.tipo_linea === 'servicio' ? 'rgba(52,211,153,0.1)' : linea.tipo_linea === 'repuesto' ? 'rgba(245,158,11,0.1)' : 'rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: '0.1rem' }}>
          <TipoIcon size={16} color={linea.tipo_linea === 'servicio' ? '#34d399' : linea.tipo_linea === 'repuesto' ? '#f59e0b' : '#818cf8'} />
        </div>

        {/* Description + badges */}
        <div style={{ flex: 1, minWidth: 0 }} ref={dropdownRef}>
          <div style={{ position: 'relative' }}>
            <input
              value={linea.descripcion}
              onChange={e => onDescChange(idx, e.target.value)}
              onFocus={onSearchFocus}
              placeholder={`Ítem ${idx + 1}...`}
              style={{ width: '100%', background: 'none', border: 'none', outline: 'none', color: '#f0f4ff', fontSize: '0.875rem', fontWeight: 600, fontFamily: F, padding: 0, boxSizing: 'border-box' }}
            />
            {/* Badges row */}
            <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginTop: '0.2rem' }}>
              {ss && ss !== 'ok' && (
                <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.4rem', borderRadius: '9999px', background: `${STOCK_COLORS[ss]}18`, color: STOCK_COLORS[ss], border: `1px solid ${STOCK_COLORS[ss]}44` }}>
                  {STOCK_LABELS[ss]}
                </span>
              )}
              {ss === 'ok' && stock >= 0 && <span style={{ fontSize: '0.62rem', color: '#22c55e', opacity: 0.7 }}>{stock} en stock</span>}
              {linea.applied_price_type === 'mayorista' && <span style={{ fontSize: '0.62rem', color: '#818cf8', background: 'rgba(99,102,241,0.1)', padding: '0.1rem 0.35rem', borderRadius: '9999px' }}>Mayorista</span>}
              {linea.no_mayorista_warning && <span style={{ fontSize: '0.62rem', color: '#f59e0b' }}>⚠ Sin precio may.</span>}
              {/* Currency + tipo */}
              <button onClick={() => onUpdate({ currency: linea.currency === 'ARS' ? 'USD' : 'ARS' })}
                style={{ fontSize: '0.62rem', padding: '0.1rem 0.35rem', background: linea.currency === 'USD' ? 'rgba(34,197,94,0.1)' : 'transparent', border: `1px solid ${linea.currency === 'USD' ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '9999px', color: linea.currency === 'USD' ? '#22c55e' : '#334155', cursor: 'pointer', fontFamily: F, fontWeight: 700 }}>
                {linea.currency}
              </button>
              <select value={linea.tipo_linea} onChange={e => onUpdate({ tipo_linea: e.target.value as TipoLinea })}
                style={{ fontSize: '0.62rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '9999px', color: '#334155', cursor: 'pointer', outline: 'none', fontFamily: F, padding: '0.1rem 0.3rem' }}>
                {(['producto','repuesto','servicio','otro'] as TipoLinea[]).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {/* Inline search dropdown */}
            {isSearchActive && (
              <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 300, background: '#0c1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.625rem', boxShadow: '0 12px 40px rgba(0,0,0,0.6)', overflow: 'hidden', maxHeight: 200, overflowY: 'auto' }}>
                {lineSearchLoading ? (
                  <div style={{ padding: '0.625rem 0.875rem', color: '#334155', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}><Loader2 size={12} style={{ animation: 'spin 0.8s linear infinite' }} /> Buscando...</div>
                ) : lineResults.slice(0, 8).map(inv => (
                  <button key={inv.id} onMouseDown={() => onSelectInv(inv)}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0.5rem 0.875rem', background: 'none', border: 'none', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.04)', textAlign: 'left', fontFamily: F, gap: '0.5rem' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.08)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#f0f4ff', fontSize: '0.82rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.name}{inv.variant_name ? ` — ${inv.variant_name}` : ''}</div>
                      <div style={{ color: '#334155', fontSize: '0.7rem' }}>{inv.stock_quantity} stock · {inv.category}</div>
                    </div>
                    <span style={{ color: '#818cf8', fontSize: '0.82rem', fontWeight: 700, flexShrink: 0 }}>{fmtARS(esClienteMayorista && inv.precio_mayorista ? inv.precio_mayorista : inv.sale_price)}</span>
                  </button>
                ))}
                <button onMouseDown={onCreateProduct}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', width: '100%', padding: '0.4rem 0.875rem', background: 'rgba(99,102,241,0.06)', border: 'none', color: '#818cf8', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
                  <Plus size={11} /> Crear producto completo
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right side: qty + price + discount + subtotal + delete */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexShrink: 0 }}>
          {/* Qty with +/- */}
          <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', overflow: 'hidden' }}>
            <button onClick={() => onUpdate({ cantidad: Math.max(0.01, linea.cantidad - 1) })}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem 0.4rem', display: 'flex', alignItems: 'center', fontFamily: F }}>
              <Minus size={12} />
            </button>
            <input type="number" value={linea.cantidad} min="0.01" step="1"
              onChange={e => onUpdate({ cantidad: parseFloat(e.target.value) || 1 })}
              style={{ width: '2.75rem', textAlign: 'center', background: 'none', border: 'none', outline: 'none', color: '#f0f4ff', fontSize: '0.875rem', fontWeight: 700, fontFamily: F, padding: '0.25rem 0' }} />
            <button onClick={() => onUpdate({ cantidad: linea.cantidad + 1 })}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem 0.4rem', display: 'flex', alignItems: 'center', fontFamily: F }}>
              <Plus size={12} />
            </button>
          </div>

          {/* Price */}
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: '0.4rem', top: '50%', transform: 'translateY(-50%)', color: '#334155', fontSize: '0.7rem', pointerEvents: 'none' }}>$</span>
            <input type="number" value={linea.precio_unitario}
              onChange={e => onUpdate({ precio_unitario: parseFloat(e.target.value) || 0, applied_price_type: 'manual' })}
              style={{ width: '6rem', paddingLeft: '1rem', paddingRight: '0.4rem', paddingTop: '0.3rem', paddingBottom: '0.3rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#f0f4ff', fontSize: '0.82rem', fontWeight: 600, outline: 'none', textAlign: 'right', fontFamily: F }} />
          </div>

          {/* Discount */}
          <div style={{ position: 'relative' }}>
            <input type="number" value={linea.descuento_linea || ''} min="0" max="100" placeholder="0"
              onChange={e => onUpdate({ descuento_linea: parseFloat(e.target.value) || 0 })}
              style={{ width: '3rem', paddingRight: '1.1rem', paddingLeft: '0.3rem', paddingTop: '0.3rem', paddingBottom: '0.3rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: linea.descuento_linea > 0 ? '#22c55e' : '#475569', fontSize: '0.78rem', outline: 'none', textAlign: 'right', fontFamily: F }} />
            <span style={{ position: 'absolute', right: '0.3rem', top: '50%', transform: 'translateY(-50%)', color: '#334155', fontSize: '0.68rem', pointerEvents: 'none' }}>%</span>
          </div>

          {/* Subtotal */}
          <div style={{ textAlign: 'right', minWidth: '5rem' }}>
            <div style={{ color: '#f0f4ff', fontSize: '0.9rem', fontWeight: 800 }}>{fmtARS(subtotal)}</div>
            {linea.descuento_linea > 0 && <div style={{ color: '#22c55e', fontSize: '0.68rem', textDecoration: 'line-through', opacity: 0.6 }}>{fmtARS(linea.cantidad * linea.precio_unitario * (linea.currency === 'USD' ? exchangeRate : 1))}</div>}
          </div>

          {/* Delete */}
          <button onClick={onDelete} disabled={!canDelete}
            style={{ background: 'none', border: 'none', cursor: canDelete ? 'pointer' : 'not-allowed', color: '#ef4444', opacity: canDelete ? 0.5 : 0.15, padding: '0.25rem', display: 'flex', alignItems: 'center', transition: 'opacity 0.1s' }}
            onMouseEnter={e => canDelete && ((e.currentTarget as HTMLButtonElement).style.opacity = '1')}
            onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.opacity = canDelete ? '0.5' : '0.15')}>
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  )
})

// ─── Main Component ───────────────────────────────────────────────────────────

export function ComprobanteProModal({
  isOpen, onClose, onCreado,
  tipoInicial, puntoVentaInicial, condicionFiscalInicial,
  initialItems, initialClienteId,
  usarPrecioMayorista = false, skipFinanceEntry = false,
}: ComprobanteProModalProps) {
  const { businessId, user } = useAuth()
  const { isOpen: cajaIsOpen, cajaId } = useCaja()
  const { flatMethods } = usePaymentCommissions()

  // ── Encabezado ───────────────────────────────────────────────────────────
  const [tipo, setTipo]             = useState<TipoComprobante>(tipoInicial ?? 'factura_c')
  const [puntoVenta, setPuntoVenta] = useState(puntoVentaInicial ?? '0001')
  const [condicion, setCondicion]   = useState(condicionFiscalInicial ?? 'Consumidor Final')
  const [clienteId, setClienteId]   = useState(initialClienteId ?? '')
  const [clienteQuery, setClienteQuery] = useState('')
  const [clientes, setClientes]     = useState<ClienteOption[]>([])
  const [clienteOpen, setClienteOpen] = useState(false)
  const [observaciones, setObservaciones] = useState('')
  const [exchangeRate, setExchangeRate]   = useState(1)
  const [emitirEnArca, setEmitirEnArca]   = useState(false)

  // ── Ítems ────────────────────────────────────────────────────────────────
  const [lineas, setLineas] = useState<LineaItem[]>([emptyLinea()])

  // ── Spotlight search (Raycast-style overlay) ─────────────────────────────
  const [spotQ, setSpotQ]           = useState('')
  const [spotResults, setSpotResults] = useState<InventoryResult[]>([])
  const [spotLoading, setSpotLoading] = useState(false)
  const [spotKeyIdx, setSpotKeyIdx] = useState(-1)
  const [spotlightMode, setSpotlightMode] = useState(false)  // overlay abierto
  const [recentProducts, setRecentProducts] = useState<InventoryResult[]>([])
  const spotRef   = useRef<HTMLInputElement>(null)
  const spotTimer = useRef<ReturnType<typeof setTimeout>>()

  // ── Line search ──────────────────────────────────────────────────────────
  const [activeSearchIdx, setActiveSearchIdx] = useState<number | null>(null)
  const [lineResults, setLineResults]         = useState<InventoryResult[]>([])
  const [lineSearchLoading, setLineSearchLoading] = useState(false)
  const lineTimer      = useRef<ReturnType<typeof setTimeout>>()
  const dropdownRefs   = useRef<(HTMLDivElement | null)[]>([])

  // ── Mayorista ────────────────────────────────────────────────────────────
  const selectedCliente = useMemo(() => clientes.find(c => c.id === clienteId) ?? null, [clientes, clienteId])
  const esClienteMayorista = useMemo(() => usarPrecioMayorista || isWholesaleCustomer(selectedCliente), [usarPrecioMayorista, selectedCliente])
  const [showRecalcPrompt, setShowRecalcPrompt] = useState(false)
  const prevClienteIdRef = useRef<string>('')

  // ── Pago ─────────────────────────────────────────────────────────────────
  const [pagos, setPagos] = useState<PagoLinea[]>([])

  // ── Payment groups ────────────────────────────────────────────────────────
  const paymentGroups = useMemo(() => {
    const map = new Map<string, { name: string; color: string; methods: FlatPaymentMethod[] }>()
    for (const m of flatMethods) {
      if (!map.has(m.group_name)) map.set(m.group_name, { name: m.group_name, color: m.color, methods: [] })
      map.get(m.group_name)!.methods.push(m)
    }
    return Array.from(map.values())
  }, [flatMethods])

  // ── Submit ───────────────────────────────────────────────────────────────
  const [submitting, setSubmitting]   = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [showSuccess, setShowSuccess] = useState(false)
  const [arcaWarning, setArcaWarning] = useState<string | null>(null)

  // ── Draft ────────────────────────────────────────────────────────────────
  const DRAFT_KEY = useMemo(() => `draft_comp_${businessId ?? 'x'}_${user?.id ?? 'x'}`, [businessId, user?.id])
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [draftInfo, setDraftInfo] = useState<{ data: object; savedAt: string } | null>(null)
  const hasContent = useMemo(() => lineas.some(l => l.descripcion.trim()), [lineas])

  // ── Refs ──────────────────────────────────────────────────────────────────
  const clienteWrapperRef = useRef<HTMLDivElement>(null)
  const clienteInputRef   = useRef<HTMLInputElement>(null)

  // ── Totales ───────────────────────────────────────────────────────────────
  const totales = useMemo(() => {
    let subtotal = 0, iva = 0, costo = 0, descuento = 0
    for (const l of lineas) {
      const disc  = (l.descuento_linea || 0) / 100
      const raw   = l.cantidad * l.precio_unitario
      const net   = raw * (1 - disc)
      const inARS = l.currency === 'USD' ? net * exchangeRate : net
      subtotal   += inARS
      descuento  += l.currency === 'USD' ? raw * disc * exchangeRate : raw * disc
      costo      += (l.costo_unitario || 0) * l.cantidad * (l.currency === 'USD' ? exchangeRate : 1)
    }
    iva = tipo === 'factura_a' ? subtotal * 0.21 : 0
    const total        = subtotal + iva
    const totalPagado  = pagos.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
    const totalOriginal = pagos.reduce((s, p) => s + (parseFloat((p as any)._original_amount ?? p.amount) || 0), 0)
    const saldo        = Math.max(0, total - totalOriginal)
    const totalRecargo = Math.max(0, totalPagado - totalOriginal)
    const ganancia     = total - costo
    const margenPct    = total > 0 ? (ganancia / total) * 100 : 0
    const vuelto       = totalPagado > total ? totalPagado - total : 0
    return { subtotal, iva, total, descuento, costo, ganancia, margenPct, totalPagado, saldo, totalRecargo, vuelto }
  }, [lineas, tipo, exchangeRate, pagos])

  // ── handleSubmit ──────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    const validLines = lineas.filter(l => l.descripcion.trim() && l.cantidad > 0 && l.precio_unitario >= 0)
    if (validLines.length === 0) { setSubmitError('Agregá al menos un ítem'); return }
    if (!businessId) { setSubmitError('Error: negocio no identificado'); return }
    if (!cajaIsOpen && !skipFinanceEntry) { setSubmitError('No hay caja abierta. Abrí caja antes de emitir.'); return }
    const pagosConMonto = pagos.filter(p => parseFloat(p.amount) > 0)
    if (pagos.length > 0 && pagosConMonto.length === 0) { setSubmitError('Ingresá el monto del cobro'); return }

    setSubmitting(true); setSubmitError(null); setArcaWarning(null)

    const input: CrearComprobanteInput = {
      tipo, punto_venta: puntoVenta, condicion_fiscal: condicion,
      customer_id: clienteId || null, observaciones, exchange_rate: exchangeRate,
      es_fiscal: TIPO_CONFIG[tipo].fiscal, emitir_en_arca: emitirEnArca,
      items: validLines.map(l => ({
        descripcion: l.descripcion, tipo_linea: l.tipo_linea, cantidad: l.cantidad,
        precio_unitario: l.precio_unitario, descuento_linea: l.descuento_linea || 0,
        costo_unitario: l.costo_unitario || 0, currency: l.currency,
        exchange_rate: l.currency === 'USD' ? exchangeRate : 1,
        inventory_id: l.inventory_id || null, applied_price_type: l.applied_price_type || null,
      })),
      pagos: pagosConMonto.map(p => ({
        payment_method: p.payment_method, payment_provider: p.payment_provider || undefined,
        amount: parseFloat(p.amount) || 0, currency: 'ARS', commission_rate: p.commission_rate,
      }) as ComprobantePago),
      business_id: businessId, created_by: user?.id, caja_id: cajaId || null,
      skip_finance_entry: skipFinanceEntry,
    }

    const result = await comprobanteService.crear(input)
    if (!result.success) { setSubmitError(result.error || 'Error al crear el comprobante'); setSubmitting(false); return }
    if (result.arcaError) setArcaWarning(result.arcaError)

    try { localStorage.removeItem(DRAFT_KEY) } catch {}
    setSubmitting(false)
    setShowSuccess(true)
    // Vibración táctil
    if ('vibrate' in navigator) navigator.vibrate(80)
  }, [lineas, businessId, cajaIsOpen, skipFinanceEntry, pagos, tipo, puntoVenta, condicion, clienteId, observaciones, exchangeRate, emitirEnArca, user, cajaId, DRAFT_KEY])

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen) return
    setTipo(tipoInicial ?? 'factura_c'); setPuntoVenta(puntoVentaInicial ?? '0001')
    setCondicion(condicionFiscalInicial ?? 'Consumidor Final'); setClienteId(initialClienteId ?? '')
    setClienteQuery(''); setObservaciones(''); setEmitirEnArca(false)
    setSubmitError(null); setShowSuccess(false); setArcaWarning(null)
    setPagos([]); setSpotQ(''); setSpotResults([]); setSpotKeyIdx(-1); setSpotlightMode(false)
    setActiveSearchIdx(null); setLineResults([])
    setShowCloseConfirm(false); setShowRecalcPrompt(false)

    if (initialItems && initialItems.length > 0) {
      setLineas(initialItems.map(i => ({
        _key: Math.random().toString(36).slice(2),
        tipo_linea: (i.tipo_linea ?? 'producto') as TipoLinea, descripcion: i.descripcion,
        cantidad: i.cantidad, precio_unitario: i.precio_unitario, descuento_linea: 0,
        costo_unitario: i.costo_unitario ?? 0, currency: (i.currency ?? 'ARS') as 'ARS' | 'USD',
        inventory_id: i.inventory_id,
      })))
    } else {
      setLineas([emptyLinea()])
      if (!initialClienteId) {
        try {
          const raw = localStorage.getItem(DRAFT_KEY)
          if (raw) {
            const parsed = JSON.parse(raw) as { data: object; savedAt: string }
            if (parsed?.data && (parsed.data as any).lineas?.some?.((l: LineaItem) => l.descripcion?.trim())) setDraftInfo(parsed)
          }
        } catch { try { localStorage.removeItem(DRAFT_KEY) } catch {} }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || !businessId || puntoVentaInicial) return
    supabase.from('sales_points').select('punto_venta').eq('business_id', businessId)
      .eq('is_active', true).order('created_at', { ascending: true }).limit(1).maybeSingle()
      .then(({ data }) => { if (data?.punto_venta) setPuntoVenta(String(data.punto_venta).padStart(4, '0')) })
  }, [isOpen, businessId, puntoVentaInicial])

  useEffect(() => {
    if (!isOpen || !businessId) return
    supabase.from('customers').select('id, name, customer_type, phone')
      .eq('business_id', businessId).order('name')
      .then(({ data }) => setClientes((data || []) as ClienteOption[]))
  }, [isOpen, businessId])

  // Productos recientes (últimos vendidos desde comprobante_items)
  useEffect(() => {
    if (!isOpen || !businessId) return
    supabase.from('comprobante_items')
      .select('inventory_id, inventory:inventory_id(id,name,variant_name,sale_price,stock_quantity,cost_price,precio_mayorista,code,category,has_variants,is_active)')
      .eq('business_id', businessId)
      .not('inventory_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(60)
      .then(({ data }) => {
        if (!data) return
        const seen = new Set<string>()
        const recent: InventoryResult[] = []
        for (const item of data) {
          const inv = (item as any).inventory
          if (inv && !seen.has(inv.id) && inv.is_active && !inv.has_variants) {
            seen.add(inv.id); recent.push(inv as InventoryResult)
            if (recent.length >= 10) break
          }
        }
        setRecentProducts(recent)
      })
  }, [isOpen, businessId])

  useEffect(() => {
    if (!isOpen) return
    currencyService.getCurrentExchangeRate('USD', 'ARS').then(r => setExchangeRate(r || 1)).catch(() => setExchangeRate(1))
  }, [isOpen])

  // Recalc prompt
  useEffect(() => {
    const prev = prevClienteIdRef.current
    if (!prev || prev === clienteId) { prevClienteIdRef.current = clienteId; return }
    prevClienteIdRef.current = clienteId
    if (!lineas.some(l => l.inventory_id)) return
    const wasW = isWholesaleCustomer(clientes.find(c => c.id === prev) ?? null)
    const nowW = isWholesaleCustomer(clientes.find(c => c.id === clienteId) ?? null)
    if (wasW !== nowW) setShowRecalcPrompt(true)
  }, [clienteId, clientes, lineas])

  // Outside click
  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (clienteWrapperRef.current && !clienteWrapperRef.current.contains(e.target as Node)) setClienteOpen(false)
      if (activeSearchIdx !== null) {
        const ref = dropdownRefs.current[activeSearchIdx]
        if (ref && !ref.contains(e.target as Node)) { setActiveSearchIdx(null); setLineResults([]) }
      }
    }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [activeSearchIdx])

  // Auto-save
  useEffect(() => {
    if (!isOpen || !hasContent) return
    const t = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ data: { tipo, puntoVenta, condicion, clienteId, clienteQuery, lineas, pagos, observaciones, exchangeRate }, savedAt: new Date().toISOString() })) } catch {}
    }, 2000)
    return () => clearTimeout(t)
  }, [tipo, puntoVenta, condicion, clienteId, clienteQuery, lineas, pagos, observaciones, exchangeRate, isOpen, hasContent, DRAFT_KEY])

  // beforeunload
  useEffect(() => {
    if (!hasContent) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [hasContent])

  // Keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showCloseConfirm && !draftInfo) {
        if (hasContent && !showSuccess) setShowCloseConfirm(true); else if (!showSuccess) onClose(); return
      }
      if ((e.key === 'F4' || (e.shiftKey && e.key === 'Enter')) && !showSuccess) { e.preventDefault(); void handleSubmit(); return }
      if (e.key === 'F2' && !showSuccess) { e.preventDefault(); clienteInputRef.current?.focus(); return }
      if ((e.ctrlKey && (e.key === 'b' || e.key === 'B')) && !showSuccess) { e.preventDefault(); setSpotlightMode(true); return }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [isOpen, hasContent, onClose, handleSubmit, showCloseConfirm, draftInfo, showSuccess])

  // ── Search helpers ────────────────────────────────────────────────────────

  const runSearch = useCallback(async (q: string, onResult: (r: InventoryResult[]) => void, setLoad: (v: boolean) => void) => {
    if (q.length < 2) { onResult([]); return }
    setLoad(true)
    try {
      const dbQ = buildSupabaseQuery(q)
      const { data } = await supabase.from('inventory')
        .select('id,code,name,variant_name,category,stock_quantity,cost_price,sale_price,precio_mayorista,base_price,base_currency,has_variants')
        .eq('business_id', businessId).eq('is_active', true).not('has_variants', 'is', true)
        .or(`name.ilike.${dbQ},variant_name.ilike.${dbQ},code.ilike.${dbQ},category.ilike.${dbQ}`).limit(40)
      const sorted = smartSearch((data || []) as InventoryResult[], q, [
        { getValue: (inv) => inv.name, weight: 2 },
        { getValue: (inv) => inv.variant_name ?? '', weight: 1.5 },
        { getValue: (inv) => inv.code, weight: 1.5 },
      ])
      onResult(sorted.slice(0, 10))
    } finally { setLoad(false) }
  }, [businessId])

  const handleSpotChange = useCallback((q: string) => {
    setSpotQ(q); setSpotKeyIdx(-1)
    clearTimeout(spotTimer.current)
    if (q.length < 2) { setSpotResults([]); return }
    spotTimer.current = setTimeout(() => {
      void runSearch(q, setSpotResults, setSpotLoading)
    }, 150)
  }, [runSearch])

  const closeSpotlight = useCallback(() => {
    setSpotlightMode(false); setSpotQ(''); setSpotResults([]); setSpotKeyIdx(-1)
  }, [])

  const selectFromSpotlight = useCallback((inv: InventoryResult) => {
    const customer = esClienteMayorista ? { customer_type: 'mayorista' } : { customer_type: 'minorista' }
    const pr = getProductPriceForCustomer({ sale_price: inv.sale_price, precio_mayorista: inv.precio_mayorista }, customer)
    const desc = [inv.name, inv.variant_name].filter(Boolean).join(' — ') + (inv.code ? ` [${inv.code}]` : '')
    const populated: Partial<LineaItem> = {
      descripcion: desc, precio_unitario: pr.price, costo_unitario: Number(inv.cost_price) || 0,
      inventory_id: inv.id, inv_sale_price: Number(inv.sale_price), inv_stock: inv.stock_quantity,
      inv_mayorista_price: inv.precio_mayorista != null ? Number(inv.precio_mayorista) : null,
      applied_price_type: pr.priceType as 'minorista' | 'mayorista', no_mayorista_warning: pr.fallback,
    }
    setLineas(prev => {
      const ei = prev.findIndex(l => !l.descripcion.trim())
      if (ei >= 0) return prev.map((l, i) => i === ei ? { ...l, ...populated } : l)
      return [...prev, { ...emptyLinea(), ...populated }]
    })
    setSpotQ(''); setSpotResults([]); setSpotKeyIdx(-1); setSpotlightMode(false)
    setTimeout(() => spotRef.current?.focus(), 30)
  }, [esClienteMayorista])

  const handleLineDescChange = useCallback((idx: number, val: string) => {
    setLineas(prev => prev.map((l, i) => i === idx ? { ...l, descripcion: val, inventory_id: undefined } : l))
    setActiveSearchIdx(idx)
    clearTimeout(lineTimer.current)
    lineTimer.current = setTimeout(() => {
      void runSearch(val, setLineResults, setLineSearchLoading)
    }, 250)
  }, [runSearch])

  const selectInventoryItem = useCallback((idx: number, inv: InventoryResult) => {
    const customer = esClienteMayorista ? { customer_type: 'mayorista' } : { customer_type: 'minorista' }
    const pr = getProductPriceForCustomer({ sale_price: inv.sale_price, precio_mayorista: inv.precio_mayorista }, customer)
    const desc = [inv.name, inv.variant_name].filter(Boolean).join(' — ') + (inv.code ? ` [${inv.code}]` : '')
    setLineas(prev => prev.map((l, i) => i === idx ? {
      ...l, descripcion: desc, precio_unitario: pr.price, costo_unitario: Number(inv.cost_price) || 0,
      currency: 'ARS', inventory_id: inv.id, inv_sale_price: Number(inv.sale_price), inv_stock: inv.stock_quantity,
      inv_mayorista_price: inv.precio_mayorista != null ? Number(inv.precio_mayorista) : null,
      applied_price_type: pr.priceType as 'minorista' | 'mayorista', no_mayorista_warning: pr.fallback,
    } : l))
    setActiveSearchIdx(null); setLineResults([])
  }, [esClienteMayorista])

  // ── Payment helpers ───────────────────────────────────────────────────────

  const toggleMetodo = useCallback((metodo: FlatPaymentMethod) => {
    const pmKey = (metodo.id === 'efectivo' || metodo.id === 'transferencia') ? metodo.id as MedioPago : 'otro' as MedioPago
    const optionId = metodo.group_id ? metodo.id : null
    const exists = pagos.find(p => p.payment_method === pmKey && (p as any)._option_id === optionId)
    if (exists) {
      setPagos(prev => prev.filter(p => !((p as any)._option_id === optionId && p.payment_method === pmKey)))
    } else {
      const saldo = totales.total - pagos.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
      const base = Math.round(Math.max(0, saldo))
      const withSurcharge = metodo.charge_mode === 'customer' && metodo.percentage > 0 ? Math.round(base * (1 + metodo.percentage / 100)) : base
      setPagos(prev => [...prev, {
        _key: Math.random().toString(36).slice(2), payment_method: pmKey,
        payment_provider: (metodo.group_name !== 'Efectivo' && metodo.group_name !== 'Transferencia') ? metodo.group_name : '',
        amount: String(withSurcharge), commission_rate: metodo.percentage / 100,
        _option_id: optionId, _option_label: metodo.label, _color: metodo.color,
        _original_amount: String(base),
      } as any])
    }
  }, [pagos, totales.total])

  const handleAddCC = useCallback(() => {
    const s = totales.saldo
    if (s <= 0) return
    setPagos(prev => [...prev.filter(p => p.payment_method !== 'cuenta_corriente'), {
      _key: Math.random().toString(36).slice(2), payment_method: 'cuenta_corriente' as MedioPago,
      payment_provider: '', amount: String(Math.round(s)), commission_rate: 0,
      _option_label: 'Cuenta Corriente', _color: '#818cf8', _original_amount: String(Math.round(s)),
    } as any])
  }, [totales.saldo])

  const handleRecalcPrices = useCallback((useWholesale: boolean) => {
    setLineas(prev => prev.map(l => {
      if (!l.inventory_id) return l
      const r = getProductPriceForCustomer(l, useWholesale ? { customer_type: 'mayorista' } : { customer_type: 'minorista' })
      return { ...l, precio_unitario: r.price, applied_price_type: r.priceType as 'minorista' | 'mayorista', no_mayorista_warning: r.fallback }
    }))
    setShowRecalcPrompt(false)
  }, [])

  // ── Close guard ───────────────────────────────────────────────────────────
  const tryClose = useCallback(() => {
    if (hasContent && !showSuccess) setShowCloseConfirm(true); else onClose()
  }, [hasContent, showSuccess, onClose])

  const discardAndClose = useCallback(() => {
    try { localStorage.removeItem(DRAFT_KEY) } catch {}
    setShowCloseConfirm(false); onClose()
  }, [DRAFT_KEY, onClose])

  const saveDraftAndClose = useCallback(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ data: { tipo, puntoVenta, condicion, clienteId, lineas, pagos, observaciones }, savedAt: new Date().toISOString() })) } catch {}
    setShowCloseConfirm(false); onClose()
  }, [DRAFT_KEY, tipo, puntoVenta, condicion, clienteId, lineas, pagos, observaciones, onClose])

  // ── Product Form Modal ────────────────────────────────────────────────────
  const [showPFM, setShowPFM]         = useState(false)
  const [pfmLineIdx, setPfmLineIdx]   = useState<number | null>(null)
  const [pfmInitialName, setPfmInitialName] = useState('')

  // ── Guard ─────────────────────────────────────────────────────────────────
  if (!isOpen) return null

  const tc = TIPO_CONFIG[tipo]
  const filledLineas = lineas.filter(l => l.descripcion.trim())

  // ── JSX ───────────────────────────────────────────────────────────────────
  return (
    <>
    <div
      onClick={e => { if (e.target === e.currentTarget) tryClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(12px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.5rem', fontFamily: F }}
    >
      <div style={{ background: '#0a1628', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '1.375rem', width: '100%', maxWidth: '1340px', height: '96vh', display: 'flex', flexDirection: 'column', boxShadow: '0 40px 120px rgba(0,0,0,0.95), 0 0 0 1px rgba(255,255,255,0.04)', overflow: 'hidden' }}>

        {/* ── HEADER ──────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.75rem 1.375rem', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0, background: 'linear-gradient(180deg, #0f1f3d 0%, #0a1628 100%)' }}>
          {/* Tipo tabs */}
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.3)', borderRadius: '0.625rem', padding: '0.175rem', gap: '0.1rem' }}>
            {(Object.entries(TIPO_CONFIG) as [TipoComprobante, typeof tc][]).map(([k, cfg]) => (
              <button key={k} onClick={() => setTipo(k)}
                style={{ padding: '0.3rem 0.875rem', borderRadius: '0.5rem', border: 'none', background: k === tipo ? cfg.bg : 'transparent', color: k === tipo ? cfg.color : '#334155', fontSize: '0.78rem', fontWeight: k === tipo ? 800 : 500, cursor: 'pointer', transition: 'all 0.15s', fontFamily: F, letterSpacing: k === tipo ? '0.01em' : 0 }}>
                {cfg.label}
              </button>
            ))}
          </div>

          {/* PV + TC */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.5rem', padding: '0.2rem 0.5rem' }}>
              <span style={{ fontSize: '0.68rem', color: '#334155', fontWeight: 700 }}>PV</span>
              <input value={puntoVenta} onChange={e => setPuntoVenta(e.target.value)} style={{ width: '3.5rem', background: 'none', border: 'none', outline: 'none', color: '#64748b', fontSize: '0.8rem', textAlign: 'center', fontFamily: F }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.5rem', padding: '0.2rem 0.5rem' }}>
              <DollarSign size={11} color="#334155" />
              <input type="number" value={exchangeRate} onChange={e => setExchangeRate(parseFloat(e.target.value) || 1)} style={{ width: '4.5rem', background: 'none', border: 'none', outline: 'none', color: '#64748b', fontSize: '0.8rem', textAlign: 'right', fontFamily: F }} />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginLeft: '0.25rem', color: '#1e3a5f', fontSize: '0.65rem' }}>
            <Keyboard size={11} />
            <span>F4 cobrar · F2 cliente · Ctrl+B buscar · Shift+Enter cobrar rápido</span>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button onClick={tryClose} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', cursor: 'pointer', color: '#475569', padding: '0.375rem', borderRadius: '0.5rem', display: 'flex', alignItems: 'center', transition: 'all 0.1s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#94a3b8' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#475569' }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ── BODY ────────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* ── LEFT COLUMN ─────────────────────────────────────────────── */}
          <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem', borderRight: '1px solid rgba(255,255,255,0.05)' }}>

            {/* CLIENTE */}
            <div ref={clienteWrapperRef} style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <User size={13} color="#334155" />
                <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#1e3a5f', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Cliente</span>
                {selectedCliente && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginLeft: 'auto' }}>
                    {esClienteMayorista && <span style={{ fontSize: '0.65rem', fontWeight: 800, padding: '0.15rem 0.5rem', borderRadius: '9999px', background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }}>MAYORISTA</span>}
                    <button onClick={() => { setClienteId(''); setClienteQuery('') }} style={{ background: 'none', border: 'none', color: '#334155', cursor: 'pointer', fontSize: '0.7rem', fontFamily: F, display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                      <X size={10} /> Quitar
                    </button>
                  </div>
                )}
              </div>

              {/* Selected client mini card */}
              {selectedCliente && !clienteOpen ? (
                <div onClick={() => setClienteOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 0.875rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '0.75rem', cursor: 'pointer', transition: 'all 0.1s' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(99,102,241,0.2)'}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <User size={15} color="#818cf8" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#f0f4ff', fontSize: '0.875rem', fontWeight: 700 }}>{selectedCliente.name}</div>
                    {selectedCliente.phone && <div style={{ color: '#334155', fontSize: '0.72rem' }}>{selectedCliente.phone}</div>}
                  </div>
                  <ChevronDown size={13} color="#334155" />
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  <User size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#334155', pointerEvents: 'none' }} />
                  <input ref={clienteInputRef} value={clienteQuery}
                    onChange={e => { setClienteQuery(e.target.value); setClienteOpen(true); if (!e.target.value) setClienteId('') }}
                    onFocus={() => setClienteOpen(true)}
                    placeholder="Buscar cliente por nombre... (F2)"
                    style={{ width: '100%', padding: '0.625rem 0.875rem 0.625rem 2.25rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.75rem', color: '#f0f4ff', fontSize: '0.875rem', outline: 'none', fontFamily: F, boxSizing: 'border-box' }} />
                </div>
              )}

              {/* Cliente dropdown */}
              {clienteOpen && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200, background: '#0c1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.875rem', boxShadow: '0 16px 48px rgba(0,0,0,0.7)', maxHeight: 240, overflowY: 'auto', marginTop: '0.25rem', animation: 'spotlightSlide 0.12s ease' }}>
                  {clientes.filter(c => !clienteQuery || c.name.toLowerCase().includes(clienteQuery.toLowerCase())).slice(0, 25).map(c => (
                    <button key={c.id} onMouseDown={() => { setClienteId(c.id); setClienteQuery(c.name); setClienteOpen(false) }}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0.625rem 1rem', background: c.id === clienteId ? 'rgba(99,102,241,0.1)' : 'none', border: 'none', cursor: 'pointer', color: '#f0f4ff', fontSize: '0.845rem', textAlign: 'left', fontFamily: F, gap: '0.5rem', transition: 'background 0.08s' }}
                      onMouseEnter={e => { if (c.id !== clienteId) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = c.id === clienteId ? 'rgba(99,102,241,0.1)' : 'none' }}>
                      <div>
                        <div style={{ fontWeight: c.id === clienteId ? 700 : 500 }}>{c.name}</div>
                        {c.phone && <div style={{ color: '#334155', fontSize: '0.7rem' }}>{c.phone}</div>}
                      </div>
                      {c.customer_type === 'mayorista' && <span style={{ fontSize: '0.65rem', color: '#818cf8', fontWeight: 700, flexShrink: 0 }}>MAYORISTA</span>}
                    </button>
                  ))}
                  {clientes.filter(c => !clienteQuery || c.name.toLowerCase().includes(clienteQuery.toLowerCase())).length === 0 && (
                    <div style={{ padding: '0.75rem 1rem', color: '#334155', fontSize: '0.8rem' }}>Sin resultados</div>
                  )}
                </div>
              )}

              {/* Recalc prompt */}
              {showRecalcPrompt && (
                <div style={{ marginTop: '0.5rem', padding: '0.625rem 0.875rem', background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '0.625rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.78rem', color: '#f59e0b', flex: 1 }}>Tipo de cliente cambió. ¿Recalcular precios?</span>
                  <button onClick={() => handleRecalcPrices(esClienteMayorista)} style={{ padding: '0.2rem 0.625rem', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: '0.375rem', color: '#f59e0b', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}>Recalcular</button>
                  <button onClick={() => setShowRecalcPrompt(false)} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '0.75rem', fontFamily: F }}>No</button>
                </div>
              )}
            </div>

            {/* SPOTLIGHT TRIGGER — abre el overlay Raycast */}
            <button
              onClick={() => setSpotlightMode(true)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', width: '100%', padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.75rem', cursor: 'pointer', textAlign: 'left', transition: 'all 0.12s', fontFamily: F }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.06)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.25)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)' }}
            >
              <Search size={15} color="#334155" />
              <span style={{ flex: 1, color: '#1e3a5f', fontSize: '0.875rem' }}>Buscar producto, SKU, barcode...</span>
              <div style={{ display: 'flex', gap: '0.2rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.65rem', color: '#1e3a5f', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.25rem', padding: '0.1rem 0.4rem', fontWeight: 600 }}>Ctrl</span>
                <span style={{ fontSize: '0.65rem', color: '#1e3a5f', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.25rem', padding: '0.1rem 0.4rem', fontWeight: 600 }}>B</span>
              </div>
            </button>

            {/* PRODUCTOS RECIENTES — chips de acceso rápido */}
            {recentProducts.length > 0 && (
              <div>
                <span style={{ fontSize: '0.62rem', fontWeight: 700, color: '#1e3a5f', textTransform: 'uppercase', letterSpacing: '0.07em', display: 'block', marginBottom: '0.375rem' }}>Recientes</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                  {recentProducts.map(p => {
                    const ss2 = stockState(p.stock_quantity)
                    return (
                      <button key={p.id} onClick={() => selectFromSpotlight(p)}
                        style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.3rem 0.625rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '9999px', cursor: 'pointer', fontFamily: F, transition: 'all 0.1s' }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.08)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.25)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: STOCK_COLORS[ss2], flexShrink: 0 }} />
                        <span style={{ color: '#475569', fontSize: '0.75rem', maxWidth: '9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                        <span style={{ color: '#334155', fontSize: '0.72rem', fontWeight: 700, flexShrink: 0 }}>{fmtARS(esClienteMayorista && p.precio_mayorista ? p.precio_mayorista : p.sale_price)}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* ITEMS CARDS */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.625rem' }}>
                <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#1e3a5f', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  Ítems {filledLineas.length > 0 && `(${filledLineas.length})`}
                </span>
                <button onClick={() => setLineas(p => [...p, emptyLinea()])}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.275rem 0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#475569', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', fontFamily: F, transition: 'all 0.1s' }}
                  onMouseEnter={e => { e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)' }}
                  onMouseLeave={e => { e.currentTarget.style.color = '#475569'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}>
                  <Plus size={11} /> Agregar fila
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {lineas.map((l, idx) => (
                  <LineaCard
                    key={l._key}
                    linea={l} idx={idx}
                    canDelete={lineas.length > 1}
                    esClienteMayorista={esClienteMayorista}
                    exchangeRate={exchangeRate}
                    isSearchActive={activeSearchIdx === idx}
                    lineResults={lineResults}
                    lineSearchLoading={lineSearchLoading}
                    onDescChange={handleLineDescChange}
                    onUpdate={(updates) => setLineas(prev => prev.map((r, i) => i === idx ? { ...r, ...updates } : r))}
                    onDelete={() => setLineas(p => p.filter(r => r._key !== l._key))}
                    onSelectInv={(inv) => selectInventoryItem(idx, inv)}
                    onCreateProduct={() => { setPfmInitialName(l.descripcion); setPfmLineIdx(idx); setShowPFM(true); setActiveSearchIdx(null); setLineResults([]) }}
                    onSearchFocus={() => { if (lineResults.length > 0 && l.descripcion.trim()) setActiveSearchIdx(idx) }}
                    dropdownRef={el => { dropdownRefs.current[idx] = el }}
                  />
                ))}
              </div>
            </div>

            {/* BOTTOM: condicion + arca + observaciones */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.05)', marginTop: 'auto' }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={condicion} onChange={e => setCondicion(e.target.value)}
                  style={{ flex: 1, padding: '0.4rem 0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#64748b', fontSize: '0.78rem', cursor: 'pointer', outline: 'none', fontFamily: F }}>
                  {CONDICIONES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                {TIPO_CONFIG[tipo].fiscal && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', color: '#334155', fontSize: '0.78rem', cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={emitirEnArca} onChange={e => setEmitirEnArca(e.target.checked)} />
                    Emitir en ARCA
                  </label>
                )}
              </div>
              <textarea value={observaciones} onChange={e => setObservaciones(e.target.value)}
                placeholder="Observaciones..."
                rows={2}
                style={{ padding: '0.5rem 0.625rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.5rem', color: '#64748b', fontSize: '0.78rem', outline: 'none', resize: 'none', fontFamily: F, lineHeight: 1.4 }} />
            </div>
          </div>

          {/* ── RIGHT COLUMN ─────────────────────────────────────────────── */}
          <div style={{ width: 400, display: 'flex', flexDirection: 'column', background: '#07101f', flexShrink: 0, position: 'relative' }}>

            {/* SUCCESS OVERLAY */}
            {showSuccess && (
              <div style={{ position: 'absolute', inset: 0, background: '#07101f', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 10, padding: '1.5rem', animation: 'spotlightSlide 0.25s ease' }}>
                <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(34,197,94,0.1)', border: '2px solid rgba(34,197,94,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1.25rem', animation: 'successBounce 0.4s ease' }}>
                  <CheckCircle2 size={36} color="#22c55e" />
                </div>
                <h3 style={{ margin: '0 0 0.25rem', color: '#f0f4ff', fontSize: '1.25rem', fontWeight: 800, textAlign: 'center' }}>Cobro exitoso</h3>
                <p style={{ margin: '0 0 1.5rem', color: '#475569', fontSize: '0.875rem', textAlign: 'center' }}>{tc.label} emitido correctamente</p>

                <div style={{ width: '100%', background: 'rgba(255,255,255,0.04)', borderRadius: '0.875rem', padding: '1rem 1.25rem', marginBottom: '1.5rem', textAlign: 'center' }}>
                  <div style={{ color: '#334155', fontSize: '0.78rem', marginBottom: '0.25rem' }}>Total cobrado</div>
                  <div style={{ color: '#f0f4ff', fontSize: '2rem', fontWeight: 900 }}>{fmtARS(totales.total)}</div>
                  {totales.vuelto > 0 && (
                    <div style={{ marginTop: '0.5rem', padding: '0.375rem 0.75rem', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: '0.5rem', color: '#22c55e', fontSize: '0.875rem', fontWeight: 700, display: 'inline-block' }}>
                      Vuelto: {fmtARS(totales.vuelto)}
                    </div>
                  )}
                </div>

                {arcaWarning && (
                  <div style={{ width: '100%', padding: '0.625rem 0.875rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '0.625rem', marginBottom: '1rem', color: '#f59e0b', fontSize: '0.75rem' }}>
                    {arcaWarning}
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button style={{ flex: 1, padding: '0.625rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.625rem', color: '#64748b', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem', fontFamily: F }}>
                      <Printer size={14} /> Imprimir
                    </button>
                    <button style={{ flex: 1, padding: '0.625rem', background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: '0.625rem', color: '#22c55e', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem', fontFamily: F }}>
                      <MessageCircle size={14} /> WhatsApp
                    </button>
                  </div>
                  <button onClick={() => { onCreado?.(); onClose() }}
                    style={{ width: '100%', padding: '0.75rem', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', border: 'none', borderRadius: '0.75rem', color: '#fff', fontSize: '0.9rem', fontWeight: 800, cursor: 'pointer', fontFamily: F }}>
                    <Plus size={15} style={{ verticalAlign: 'middle', marginRight: '0.375rem' }} />
                    Nuevo comprobante
                  </button>
                  <button onClick={() => { onCreado?.(); onClose() }}
                    style={{ width: '100%', padding: '0.5rem', background: 'transparent', border: 'none', color: '#334155', fontSize: '0.78rem', cursor: 'pointer', fontFamily: F }}>
                    Cerrar
                  </button>
                </div>
              </div>
            )}

            {/* ITEMS COMPACT */}
            {filledLineas.length > 0 && (
              <div style={{ padding: '0.875rem 1rem 0', maxHeight: '22%', overflowY: 'auto', flexShrink: 0 }}>
                <span style={{ fontSize: '0.62rem', fontWeight: 700, color: '#1e3a5f', textTransform: 'uppercase', letterSpacing: '0.07em', display: 'block', marginBottom: '0.375rem' }}>Resumen</span>
                {filledLineas.map(l => {
                  const sub = l.cantidad * l.precio_unitario * (1 - (l.descuento_linea || 0) / 100) * (l.currency === 'USD' ? exchangeRate : 1)
                  return (
                    <div key={l._key} style={{ display: 'flex', gap: '0.5rem', justifyContent: 'space-between', padding: '0.2rem 0', borderBottom: '1px solid rgba(255,255,255,0.03)', alignItems: 'baseline' }}>
                      <span style={{ color: '#334155', fontSize: '0.75rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.cantidad > 1 && <span style={{ color: '#1e3a5f', marginRight: '0.2rem', fontWeight: 700 }}>{l.cantidad}×</span>}
                        {l.descripcion}
                      </span>
                      <span style={{ color: '#475569', fontSize: '0.75rem', fontWeight: 600, flexShrink: 0 }}>{fmtARS(sub)}</span>
                    </div>
                  )
                })}
              </div>
            )}

            {/* TOTALES */}
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
              {totales.descuento > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span style={{ color: '#334155', fontSize: '0.78rem' }}>Bruto</span>
                  <span style={{ color: '#334155', fontSize: '0.78rem' }}>{fmtARS(totales.subtotal + totales.descuento)}</span>
                </div>
              )}
              {totales.descuento > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span style={{ color: '#22c55e', fontSize: '0.78rem' }}>Descuentos</span>
                  <span style={{ color: '#22c55e', fontSize: '0.78rem', fontWeight: 600 }}>-{fmtARS(totales.descuento)}</span>
                </div>
              )}
              {totales.iva > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span style={{ color: '#334155', fontSize: '0.78rem' }}>IVA 21%</span>
                  <span style={{ color: '#334155', fontSize: '0.78rem' }}>{fmtARS(totales.iva)}</span>
                </div>
              )}
              {totales.totalRecargo > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span style={{ color: '#f59e0b', fontSize: '0.78rem' }}>Recargo tarjeta</span>
                  <span style={{ color: '#f59e0b', fontSize: '0.78rem', fontWeight: 600 }}>+{fmtARS(totales.totalRecargo)}</span>
                </div>
              )}

              {/* TOTAL GRANDE */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                <div>
                  <div style={{ color: '#334155', fontSize: '0.78rem', fontWeight: 600 }}>Total</div>
                  {totales.costo > 0 && (
                    <div style={{ fontSize: '0.7rem', color: totales.ganancia > 0 ? '#22c55e' : '#ef4444', marginTop: '0.1rem' }}>
                      Ganancia {fmtARS(totales.ganancia)} ({totales.margenPct.toFixed(0)}%)
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: '#f0f4ff', fontSize: '2.25rem', fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1 }}>{fmtARS(totales.total)}</div>
                </div>
              </div>
            </div>

            {/* MÉTODOS DE PAGO */}
            <div style={{ padding: '0.875rem 1rem', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <span style={{ fontSize: '0.62rem', fontWeight: 700, color: '#1e3a5f', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Método de cobro</span>

              {/* Grouped payment buttons */}
              {paymentGroups.map(group => (
                <div key={group.name}>
                  {paymentGroups.length > 1 && <div style={{ fontSize: '0.62rem', color: '#1e3a5f', marginBottom: '0.3rem', fontWeight: 600 }}>{group.name}</div>}
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(group.methods.length, 4)}, 1fr)`, gap: '0.3rem' }}>
                    {group.methods.map(m => {
                      const optionId = m.group_id ? m.id : null
                      const pmKey = (m.id === 'efectivo' || m.id === 'transferencia') ? m.id : 'otro'
                      const active = !!pagos.find(p => p.payment_method === pmKey && (p as any)._option_id === optionId)
                      return (
                        <button key={m.id} onClick={() => toggleMetodo(m)}
                          style={{ padding: '0.45rem 0.3rem', borderRadius: '0.5rem', border: `1px solid ${active ? (m.color || 'rgba(99,102,241,0.5)') : 'rgba(255,255,255,0.06)'}`, background: active ? `${m.color}20` : 'rgba(255,255,255,0.02)', color: active ? m.color || '#818cf8' : '#334155', fontSize: '0.72rem', fontWeight: active ? 700 : 500, cursor: 'pointer', transition: 'all 0.12s', textAlign: 'center', fontFamily: F, lineHeight: 1.3 }}
                          onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                          onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.02)' }}>
                          {m.short_label || m.label}
                          {m.percentage > 0 && <div style={{ fontSize: '0.6rem', opacity: 0.7, marginTop: '0.1rem' }}>+{m.percentage}%</div>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}

              {/* Payment chips */}
              {pagos.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  {pagos.map(p => (
                    <div key={p._key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.625rem', background: `${(p as any)._color || '#818cf8'}0d`, border: `1px solid ${(p as any)._color || '#818cf8'}2a`, borderRadius: '0.5rem' }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: (p as any)._color || '#818cf8', flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: '0.78rem', color: (p as any)._color || '#94a3b8', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {(p as any)._option_label || p.payment_method}
                      </span>
                      <span style={{ color: '#334155', fontSize: '0.72rem', flexShrink: 0 }}>$</span>
                      <input type="number" min="0" value={p.amount}
                        onChange={e => setPagos(prev => prev.map(pp => pp._key === p._key ? { ...pp, amount: e.target.value } : pp))}
                        style={{ width: '5.5rem', textAlign: 'right', padding: '0.2rem 0.375rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.375rem', color: '#f0f4ff', fontSize: '0.82rem', fontWeight: 700, outline: 'none', fontFamily: F }} />
                      <button onClick={() => setPagos(prev => prev.filter(pp => pp._key !== p._key))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#334155', padding: '0.1rem', display: 'flex', alignItems: 'center', transition: 'color 0.1s' }}
                        onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                        onMouseLeave={e => e.currentTarget.style.color = '#334155'}>
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* CC + Saldo / Vuelto */}
              {clienteId && totales.saldo > 0 && !pagos.find(p => p.payment_method === 'cuenta_corriente') && (
                <button onClick={handleAddCC}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.45rem 0.75rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.18)', borderRadius: '0.5rem', color: '#818cf8', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: F, width: '100%' }}>
                  <span><Wallet size={12} style={{ verticalAlign: 'middle', marginRight: '0.375rem' }} />Enviar a cuenta corriente</span>
                  <span>{fmtARS(totales.saldo)}</span>
                </button>
              )}

              {pagos.length > 0 && (
                <div style={{ padding: '0.375rem 0', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  {totales.saldo > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '0.78rem', color: '#f59e0b', fontWeight: 600 }}>Saldo pendiente</span>
                      <span style={{ fontSize: '0.78rem', color: '#f59e0b', fontWeight: 800 }}>{fmtARS(totales.saldo)}</span>
                    </div>
                  )}
                  {totales.vuelto > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '0.82rem', color: '#22c55e', fontWeight: 700 }}>Vuelto</span>
                      <span style={{ fontSize: '0.95rem', color: '#22c55e', fontWeight: 900 }}>{fmtARS(totales.vuelto)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* COBRAR BUTTON */}
            <div style={{ padding: '0.875rem 1rem', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
              {!cajaIsOpen && !skipFinanceEntry && (
                <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.5rem', padding: '0.5rem 0.625rem', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)', borderRadius: '0.5rem' }}>
                  <AlertCircle size={13} color="#f87171" style={{ flexShrink: 0 }} />
                  <span style={{ color: '#f87171', fontSize: '0.72rem', fontWeight: 600 }}>Caja cerrada — no se pueden emitir comprobantes</span>
                </div>
              )}
              {submitError && (
                <div style={{ marginBottom: '0.5rem', padding: '0.5rem 0.625rem', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)', borderRadius: '0.5rem' }}>
                  <span style={{ color: '#f87171', fontSize: '0.72rem' }}>{formatDisplayMessage(submitError)}</span>
                </div>
              )}
              <button onClick={() => void handleSubmit()} disabled={submitting}
                style={{ width: '100%', padding: '1rem', borderRadius: '0.875rem', border: 'none', background: submitting ? 'rgba(99,102,241,0.4)' : 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontSize: '1.0625rem', fontWeight: 800, cursor: submitting ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', fontFamily: F, transition: 'all 0.15s', boxShadow: submitting ? 'none' : '0 4px 20px rgba(99,102,241,0.4)' }}
                onMouseEnter={e => { if (!submitting) e.currentTarget.style.boxShadow = '0 6px 28px rgba(99,102,241,0.55)' }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = submitting ? 'none' : '0 4px 20px rgba(99,102,241,0.4)' }}>
                {submitting ? (
                  <><RefreshCw size={16} style={{ animation: 'spin 0.8s linear infinite' }} /> Procesando...</>
                ) : (
                  <><Zap size={16} /> Cobrar {totales.total > 0 ? fmtARS(totales.total) : ''} <span style={{ opacity: 0.55, fontSize: '0.72rem', fontWeight: 500 }}>F4</span></>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    {/* Animations */}
    <style>{`
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes itemSlideIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes spotlightSlide { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes successBounce { 0% { transform: scale(0.5); opacity: 0; } 60% { transform: scale(1.08); } 100% { transform: scale(1); opacity: 1; } }
    `}</style>

    {/* ── SPOTLIGHT OVERLAY (Raycast style) ──────────────────────────────── */}
    {spotlightMode && (
      <div
        onClick={e => { if (e.target === e.currentTarget) closeSpotlight() }}
        style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '7%', fontFamily: F }}
      >
        <div style={{ width: '100%', maxWidth: 620, background: '#0c1a2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '1.375rem', boxShadow: '0 40px 100px rgba(0,0,0,0.95)', overflow: 'hidden', animation: 'spotlightSlide 0.14s ease' }}>
          {/* Search input */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '1rem 1.25rem', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <Search size={20} color={spotQ ? '#818cf8' : '#334155'} style={{ flexShrink: 0, transition: 'color 0.15s' }} />
            <input
              ref={spotRef}
              autoFocus
              value={spotQ}
              onChange={e => handleSpotChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSpotKeyIdx(i => Math.min(i + 1, spotResults.length - 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSpotKeyIdx(i => Math.max(i - 1, 0)) }
                else if (e.key === 'Enter') {
                  e.preventDefault()
                  const target = spotKeyIdx >= 0 && spotResults[spotKeyIdx] ? spotResults[spotKeyIdx] : spotResults[0]
                  if (target) selectFromSpotlight(target)
                  else if (!spotQ && spotResults.length === 0) closeSpotlight()
                }
                else if (e.key === 'Escape') closeSpotlight()
              }}
              placeholder="Buscar por nombre, SKU, código de barras, IMEI..."
              style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#f0f4ff', fontSize: '1.0625rem', fontFamily: F, caretColor: '#818cf8' }}
            />
            {spotLoading && <Loader2 size={16} color="#475569" style={{ flexShrink: 0, animation: 'spin 0.8s linear infinite' }} />}
            {!spotLoading && spotQ && <button onClick={closeSpotlight} style={{ background: 'none', border: 'none', color: '#334155', cursor: 'pointer', padding: '0.2rem', display: 'flex', fontFamily: F }}><X size={15} /></button>}
          </div>

          {/* Results */}
          {spotQ.length >= 2 && (
            <div style={{ maxHeight: 340, overflowY: 'auto' }}>
              {spotResults.length === 0 && !spotLoading && (
                <div style={{ padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ color: '#334155', fontSize: '0.875rem' }}>Sin resultados para "{spotQ}"</span>
                  <button onClick={() => { setPfmInitialName(spotQ); setShowPFM(true); closeSpotlight() }}
                    style={{ color: '#818cf8', fontWeight: 700, background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.5rem', padding: '0.35rem 0.875rem', cursor: 'pointer', fontSize: '0.8rem', fontFamily: F }}>
                    + Crear producto
                  </button>
                </div>
              )}
              {spotResults.map((inv, i) => {
                const ss2 = stockState(inv.stock_quantity)
                const priceToShow = esClienteMayorista && inv.precio_mayorista ? inv.precio_mayorista : inv.sale_price
                const active = i === spotKeyIdx || (spotKeyIdx === -1 && i === 0)
                return (
                  <button key={inv.id}
                    onClick={() => selectFromSpotlight(inv)}
                    onMouseEnter={() => setSpotKeyIdx(i)}
                    style={{ display: 'flex', alignItems: 'center', gap: '1rem', width: '100%', padding: '0.75rem 1.25rem', background: active ? 'rgba(99,102,241,0.1)' : 'none', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', textAlign: 'left', fontFamily: F, transition: 'background 0.07s' }}>
                    <div style={{ width: 40, height: 40, borderRadius: '0.625rem', background: active ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 0.07s' }}>
                      <Package size={18} color={active ? '#818cf8' : '#334155'} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#f0f4ff', fontSize: '0.9375rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {inv.name}{inv.variant_name ? ` — ${inv.variant_name}` : ''}
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.15rem' }}>
                        {inv.code && <span style={{ color: '#334155', fontSize: '0.72rem' }}>#{inv.code}</span>}
                        <span style={{ color: '#1e3a5f', fontSize: '0.72rem' }}>{inv.category}</span>
                        <span style={{ color: STOCK_COLORS[ss2], fontSize: '0.72rem', fontWeight: ss2 !== 'ok' ? 700 : 400 }}>
                          {ss2 === 'out' ? 'Sin stock' : ss2 === 'low' ? `${inv.stock_quantity} bajo mínimo` : `${inv.stock_quantity} en stock`}
                        </span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ color: active ? '#a5b4fc' : '#818cf8', fontSize: '1rem', fontWeight: 800 }}>{fmtARS(priceToShow)}</div>
                      {esClienteMayorista && inv.precio_mayorista && inv.precio_mayorista !== inv.sale_price && (
                        <div style={{ color: '#334155', fontSize: '0.7rem', textDecoration: 'line-through' }}>{fmtARS(inv.sale_price)}</div>
                      )}
                    </div>
                    {active && <span style={{ fontSize: '0.65rem', color: '#475569', background: 'rgba(255,255,255,0.07)', padding: '0.15rem 0.45rem', borderRadius: '0.3rem', flexShrink: 0 }}>Enter</span>}
                  </button>
                )
              })}
              {spotResults.length > 0 && (
                <button onClick={() => { setPfmInitialName(spotQ); setShowPFM(true); closeSpotlight() }}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', padding: '0.625rem 1.25rem', background: 'rgba(99,102,241,0.05)', border: 'none', borderTop: '1px solid rgba(255,255,255,0.05)', color: '#818cf8', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
                  <Plus size={13} /> Crear producto completo: "{spotQ}"
                </button>
              )}
            </div>
          )}

          {/* Recientes (cuando no hay query) */}
          {!spotQ && recentProducts.length > 0 && (
            <div style={{ padding: '0.875rem 1.25rem' }}>
              <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#1e3a5f', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>Recientes</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                {recentProducts.map(p => {
                  const ss2 = stockState(p.stock_quantity)
                  return (
                    <button key={p.id} onClick={() => selectFromSpotlight(p)}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.75rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '9999px', cursor: 'pointer', fontFamily: F, transition: 'all 0.1s' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.1)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.3)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: STOCK_COLORS[ss2], flexShrink: 0 }} />
                      <span style={{ color: '#64748b', fontSize: '0.82rem', maxWidth: '12rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}{p.variant_name ? ` — ${p.variant_name}` : ''}</span>
                      <span style={{ color: '#475569', fontSize: '0.78rem', fontWeight: 700, flexShrink: 0 }}>{fmtARS(esClienteMayorista && p.precio_mayorista ? p.precio_mayorista : p.sale_price)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Footer hints */}
          <div style={{ display: 'flex', gap: '1.25rem', padding: '0.625rem 1.25rem', borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.2)' }}>
            {[['↑↓','navegar'],['Enter','agregar'],['Esc','cerrar']].map(([k,l]) => (
              <span key={k} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.65rem', color: '#1e3a5f' }}>
                <span style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.25rem', padding: '0.1rem 0.35rem', fontWeight: 600 }}>{k}</span>
                {l}
              </span>
            ))}
          </div>
        </div>
      </div>
    )}

    {/* ProductFormModal */}
    <ProductFormModal
      isOpen={showPFM}
      onClose={() => { setShowPFM(false); setPfmLineIdx(null) }}
      onCreated={(product: InventoryItemFull) => {
        const inv: InventoryResult = { id: product.id, code: product.code ?? '', name: product.name, category: product.category ?? '', stock_quantity: product.stock_quantity, cost_price: product.cost_price, sale_price: product.sale_price, has_variants: false }
        if (pfmLineIdx !== null) selectInventoryItem(pfmLineIdx, inv)
        else selectFromSpotlight(inv)
        setShowPFM(false); setPfmLineIdx(null)
      }}
      initialName={pfmInitialName} registerStock={false} sourceType="manual"
    />

    {/* Close confirm */}
    {showCloseConfirm && (
      <div style={{ position: 'fixed', inset: 0, zIndex: 10001, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', fontFamily: F }}>
        <div style={{ background: '#0d1a30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '1.125rem', width: '100%', maxWidth: '380px', overflow: 'hidden', animation: 'spotlightSlide 0.15s ease' }}>
          <div style={{ padding: '1.5rem 1.5rem 1rem' }}>
            <div style={{ width: 40, height: 40, borderRadius: '0.75rem', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem' }}>
              <AlertCircle size={20} color="#f59e0b" />
            </div>
            <h3 style={{ margin: '0 0 0.375rem', color: '#f1f5f9', fontSize: '1rem', fontWeight: 800 }}>Cambios sin guardar</h3>
            <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem' }}>Hay ítems en el comprobante. ¿Qué querés hacer?</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem 1.5rem 1.25rem' }}>
            <button onClick={() => setShowCloseConfirm(false)} style={{ width: '100%', padding: '0.625rem', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', border: 'none', borderRadius: '0.75rem', color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>Seguir editando</button>
            <button onClick={saveDraftAndClose} style={{ width: '100%', padding: '0.625rem', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.75rem', color: '#818cf8', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>Guardar borrador y cerrar</button>
            <button onClick={discardAndClose} style={{ width: '100%', padding: '0.625rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.75rem', color: '#475569', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>Descartar y cerrar</button>
          </div>
        </div>
      </div>
    )}

    {/* Draft restore */}
    {draftInfo && (
      <div style={{ position: 'fixed', inset: 0, zIndex: 10001, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', fontFamily: F }}>
        <div style={{ background: '#0d1a30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '1.125rem', width: '100%', maxWidth: '380px', overflow: 'hidden', animation: 'spotlightSlide 0.15s ease' }}>
          <div style={{ padding: '1.5rem 1.5rem 1rem' }}>
            <div style={{ width: 40, height: 40, borderRadius: '0.75rem', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.22)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem' }}>
              <CheckCircle2 size={20} color="#22c55e" />
            </div>
            <h3 style={{ margin: '0 0 0.375rem', color: '#f1f5f9', fontSize: '1rem', fontWeight: 800 }}>Borrador encontrado</h3>
            <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem' }}>
              Hay un comprobante sin finalizar
              {draftInfo.savedAt ? ` (${new Date(draftInfo.savedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })})` : ''}.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem 1.5rem 1.25rem' }}>
            <button onClick={() => {
              const d = draftInfo.data as any
              if (d.tipo) setTipo(d.tipo); if (d.puntoVenta) setPuntoVenta(d.puntoVenta)
              if (d.condicion) setCondicion(d.condicion)
              if (d.clienteId) { setClienteId(d.clienteId); setClienteQuery(d.clienteQuery || '') }
              if (Array.isArray(d.lineas) && d.lineas.length) setLineas(d.lineas)
              if (Array.isArray(d.pagos) && d.pagos.length) setPagos(d.pagos)
              if (d.observaciones) setObservaciones(d.observaciones)
              setDraftInfo(null)
            }} style={{ width: '100%', padding: '0.625rem', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', border: 'none', borderRadius: '0.75rem', color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>
              Restaurar borrador
            </button>
            <button onClick={() => { try { localStorage.removeItem(DRAFT_KEY) } catch {} setDraftInfo(null) }}
              style={{ width: '100%', padding: '0.625rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.75rem', color: '#475569', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>
              Empezar de cero
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
