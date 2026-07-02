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
import { resolveProductPricing } from '../../lib/pricing/productPricing'
import {
  X, Search, Plus, DollarSign, Package, Wrench, Tag,
  AlertCircle, AlertTriangle, CheckCircle2, User, Loader2,
  Wallet, RefreshCw, Zap, ChevronDown,
  Keyboard, Minus, Printer, MessageCircle,
  Check, CreditCard, Banknote, ArrowRightLeft,
  Volume2, VolumeX,
} from 'lucide-react'
import { soundSystem } from '../../lib/sounds'
import { posLogger } from '../../lib/logger'
import { currencyService } from '../../services/currencyService'
import { smartSearch, buildSupabaseQuery } from '../../utils/searchUtils'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { useCaja } from '../../contexts/CajaContext'
import { formatDisplayMessage } from '../../utils/formatMessage'
import {
  comprobanteService,
  TipoComprobante, TipoLinea, MedioPago,
  ComprobantePago, CrearComprobanteInput, Comprobante,
  isArcaConnectionError, ARCA_CONNECTION_ERROR_TITLE, ARCA_CONNECTION_ERROR_MESSAGE,
  ARCA_PENDING_RECONCILIATION_TITLE, ARCA_PENDING_RECONCILIATION_MESSAGE,
  splitArcaRejectionMessage,
} from '../../services/comprobanteService'
import { WhatsAppPreviewModal } from '../whatsapp/WhatsAppPreviewModal'
import { usePaymentCommissions, type FlatPaymentMethod } from '../../hooks/usePaymentCommissions'
import { useKeyboardAwareBottomOffset } from '../../hooks/useKeyboardAwareBottomOffset'
import {
  computeCheckoutRequestHash, getOrCreateIdempotencyKey, clearPendingCheckout, readPendingCheckout,
} from '../../lib/checkoutIdempotency'

// ─── Types ────────────────────────────────────────────────────────────────────

interface InventoryResult {
  id: string; code: string; name: string; variant_name?: string | null
  category: string; stock_quantity: number; cost_price: number
  cost_price_usd?: number | null
  sale_price: number; precio_mayorista?: number | null
  base_price?: number | null; base_currency?: string | null; has_variants?: boolean | null
  auto_update_price?: boolean | null; exchange_rate_used?: number | null
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

/** Precio ARS efectivo para un cliente: dolariza productos USD-auto con la cotización
 *  vigente (motor central) y aplica la regla minorista/mayorista. Función pura. */
function effectiveCustomerPriceARS(
  inv: Parameters<typeof resolveProductPricing>[0],
  rate: number,
  wholesale: boolean,
): number {
  const e = resolveProductPricing(inv, rate)
  return getProductPriceForCustomer(
    { sale_price: e.saleArs, precio_mayorista: e.mayoristaArs },
    wholesale ? { customer_type: 'mayorista' } : { customer_type: 'minorista' },
  ).price
}
const stockState = (qty: number) => qty <= 0 ? 'out' : qty <= 5 ? 'low' : 'ok'
const STOCK_COLORS = { ok: '#22c55e', low: '#f59e0b', out: '#ef4444' }
const STOCK_LABELS = { ok: '', low: 'Stock bajo', out: 'Sin stock' }
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

// ─── Helpers POS ──────────────────────────────────────────────────────────────

/**
 * Parsea formatos de cantidad en scanner: "3*CODE", "CODEx3", "CODE*3"
 * Devuelve el código limpio y la cantidad.
 */
function parseQtyCode(raw: string): { code: string; qty: number } {
  const val = raw.trim()
  const pre = val.match(/^(\d+)[*x×](.+)$/i)
  if (pre) return { qty: Math.max(1, parseInt(pre[1], 10)), code: pre[2].trim() }
  const suf = val.match(/^(.+)[*x×](\d+)$/i)
  if (suf) return { qty: Math.max(1, parseInt(suf[2], 10)), code: suf[1].trim() }
  return { qty: 1, code: val }
}


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
  // Nombre accesible por fila — usa la descripción cargada o el índice como fallback.
  const itemLabel = linea.descripcion.trim() || `Ítem ${idx + 1}`

  return (
    <div data-testid={`comprobante-item-row-${idx}`} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.625rem', overflow: 'visible', animation: 'itemSlideIn 0.12s ease', transition: 'border-color 0.12s' }}
      onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(99,102,241,0.2)'}
      onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.06)'}
    >
      {/* Card body */}
      <div className="cpm-item-row">
        {/* Product icon — compacto */}
        <div className="cpm-item-icon" style={{ width: 26, height: 26, borderRadius: '0.375rem', background: linea.tipo_linea === 'servicio' ? 'rgba(52,211,153,0.1)' : linea.tipo_linea === 'repuesto' ? 'rgba(245,158,11,0.1)' : 'rgba(99,102,241,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <TipoIcon size={13} color={linea.tipo_linea === 'servicio' ? '#34d399' : linea.tipo_linea === 'repuesto' ? '#f59e0b' : '#818cf8'} />
        </div>

        {/* Description + badges */}
        <div className="cpm-item-main" style={{ flex: 1, minWidth: 0 }} ref={dropdownRef}>
          <div style={{ position: 'relative' }}>
            <input
              className="cpm-input16"
              data-testid="comprobante-item-description"
              value={linea.descripcion}
              onChange={e => onDescChange(idx, e.target.value)}
              onFocus={onSearchFocus}
              placeholder={`Ítem ${idx + 1}...`}
              style={{ width: '100%', background: 'none', border: 'none', outline: 'none', color: '#f0f4ff', fontSize: '0.875rem', fontWeight: 600, fontFamily: F, padding: 0, boxSizing: 'border-box' }}
            />
            {/* Badges row — condensado */}
            <div style={{ display: 'flex', gap: '0.2rem', flexWrap: 'wrap', marginTop: '0.1rem', alignItems: 'center' }}>
              {ss && ss !== 'ok' && (
                <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.4rem', borderRadius: '9999px', background: `${STOCK_COLORS[ss]}18`, color: STOCK_COLORS[ss], border: `1px solid ${STOCK_COLORS[ss]}44` }}>
                  {STOCK_LABELS[ss]}
                </span>
              )}
              {ss === 'ok' && stock >= 0 && <span style={{ fontSize: '0.62rem', color: '#22c55e', opacity: 0.7 }}>{stock} en stock</span>}
              {linea.applied_price_type === 'mayorista' && <span style={{ fontSize: '0.62rem', color: '#818cf8', background: 'rgba(99,102,241,0.1)', padding: '0.1rem 0.35rem', borderRadius: '9999px' }}>Mayorista</span>}
              {linea.no_mayorista_warning && <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.15rem', fontSize: '0.62rem', color: '#f59e0b' }}><AlertTriangle size={10} /> Sin precio may.</span>}
              {/* Currency + tipo */}
              <button onClick={() => onUpdate({ currency: linea.currency === 'ARS' ? 'USD' : 'ARS' })}
                className="cpm-item-currency"
                aria-label={`Moneda de ${itemLabel}, actual ${linea.currency}. Cambiar`}
                style={{ fontSize: '0.62rem', padding: '0.1rem 0.35rem', background: linea.currency === 'USD' ? 'rgba(34,197,94,0.1)' : 'transparent', border: `1px solid ${linea.currency === 'USD' ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '9999px', color: linea.currency === 'USD' ? '#22c55e' : 'var(--pos-text-muted)', cursor: 'pointer', fontFamily: F, fontWeight: 700 }}>
                {linea.currency}
              </button>
              <select value={linea.tipo_linea} onChange={e => onUpdate({ tipo_linea: e.target.value as TipoLinea })}
                className="cpm-item-type cpm-input16"
                aria-label={`Tipo de ${itemLabel}`}
                style={{ fontSize: '0.62rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '9999px', color: 'var(--pos-text-muted)', cursor: 'pointer', outline: 'none', fontFamily: F, padding: '0.1rem 0.3rem' }}>
                {(['producto','repuesto','servicio','otro'] as TipoLinea[]).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {/* Inline search dropdown */}
            {isSearchActive && (
              <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 300, background: '#0c1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.625rem', boxShadow: '0 12px 40px rgba(0,0,0,0.6)', overflow: 'hidden', maxHeight: 200, overflowY: 'auto' }}>
                {lineSearchLoading ? (
                  <div style={{ padding: '0.625rem 0.875rem', color: '#334155', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}><Loader2 size={12} style={{ animation: 'tr-spin 0.8s linear infinite' }} /> Buscando...</div>
                ) : lineResults.slice(0, 8).map(inv => (
                  <button key={inv.id} onMouseDown={() => onSelectInv(inv)}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0.5rem 0.875rem', background: 'none', border: 'none', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.04)', textAlign: 'left', fontFamily: F, gap: '0.5rem' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.08)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#f0f4ff', fontSize: '0.82rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.name}{inv.variant_name ? ` — ${inv.variant_name}` : ''}</div>
                      <div style={{ color: 'var(--pos-text-muted)', fontSize: '0.7rem' }}>{inv.stock_quantity} stock · {inv.category}</div>
                    </div>
                    <span style={{ color: '#818cf8', fontSize: '0.82rem', fontWeight: 700, flexShrink: 0 }}>{fmtARS(effectiveCustomerPriceARS(inv, exchangeRate, esClienteMayorista))}</span>
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

        {/* Fields zone: qty + price + discount + subtotal */}
        <div className="cpm-item-fields">
          {/* Qty with +/- — compacto */}
          <div className="cpm-item-stepper" style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.375rem', overflow: 'hidden' }}>
            <button onClick={() => onUpdate({ cantidad: Math.max(0.01, linea.cantidad - 1) })}
              className="cpm-item-step"
              aria-label={`Restar uno a ${itemLabel}`}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--pos-text-muted)', padding: '0.2rem 0.3rem', display: 'flex', alignItems: 'center', fontFamily: F }}>
              <Minus size={11} />
            </button>
            <input data-testid="comprobante-item-quantity" type="number" value={linea.cantidad} min="0.01" step="1"
              className="cpm-input16"
              aria-label={`Cantidad de ${itemLabel}`}
              onChange={e => onUpdate({ cantidad: parseFloat(e.target.value) || 1 })}
              style={{ width: '2.25rem', textAlign: 'center', background: 'none', border: 'none', outline: 'none', color: '#f0f4ff', fontSize: '0.82rem', fontWeight: 700, fontFamily: F, padding: '0.2rem 0' }} />
            <button onClick={() => onUpdate({ cantidad: linea.cantidad + 1 })}
              className="cpm-item-step"
              aria-label={`Sumar uno a ${itemLabel}`}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--pos-text-muted)', padding: '0.2rem 0.3rem', display: 'flex', alignItems: 'center', fontFamily: F }}>
              <Plus size={11} />
            </button>
          </div>

          {/* Price — compacto */}
          <div className="cpm-item-price" style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: '0.3rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--pos-text-muted)', fontSize: '0.65rem', pointerEvents: 'none' }}>$</span>
            <input data-testid="comprobante-item-price" type="number" value={linea.precio_unitario}
              className="cpm-input16"
              aria-label={`Precio unitario de ${itemLabel}`}
              onChange={e => onUpdate({ precio_unitario: parseFloat(e.target.value) || 0, applied_price_type: 'manual' })}
              style={{ width: '5.25rem', paddingLeft: '0.875rem', paddingRight: '0.3rem', paddingTop: '0.25rem', paddingBottom: '0.25rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.375rem', color: '#f0f4ff', fontSize: '0.78rem', fontWeight: 600, outline: 'none', textAlign: 'right', fontFamily: F }} />
          </div>

          {/* Discount — compacto */}
          <div className="cpm-item-discount" style={{ position: 'relative' }}>
            <input type="number" value={linea.descuento_linea || ''} min="0" max="100" placeholder="0"
              className="cpm-input16"
              aria-label={`Descuento porcentual de ${itemLabel}`}
              onChange={e => onUpdate({ descuento_linea: parseFloat(e.target.value) || 0 })}
              style={{ width: '2.75rem', paddingRight: '1rem', paddingLeft: '0.25rem', paddingTop: '0.25rem', paddingBottom: '0.25rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.375rem', color: linea.descuento_linea > 0 ? '#22c55e' : '#475569', fontSize: '0.72rem', outline: 'none', textAlign: 'right', fontFamily: F }} />
            <span style={{ position: 'absolute', right: '0.25rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--pos-text-muted)', fontSize: '0.6rem', pointerEvents: 'none' }}>%</span>
          </div>

          {/* Subtotal — compacto */}
          <div className="cpm-item-subtotal" data-testid="comprobante-item-subtotal" style={{ textAlign: 'right', minWidth: '4.25rem' }}>
            <div style={{ color: '#f0f4ff', fontSize: '0.82rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmtARS(subtotal)}</div>
            {linea.descuento_linea > 0 && <div style={{ color: '#22c55e', fontSize: '0.62rem', textDecoration: 'line-through', opacity: 0.5 }}>{fmtARS(linea.cantidad * linea.precio_unitario * (linea.currency === 'USD' ? exchangeRate : 1))}</div>}
          </div>
        </div>

        {/* Delete — fuera de .cpm-item-fields para ubicarlo en la zona superior del grid móvil */}
        <button data-testid="comprobante-item-remove" onClick={onDelete} disabled={!canDelete}
          className="cpm-item-delete"
          style={{ background: 'none', border: 'none', cursor: canDelete ? 'pointer' : 'not-allowed', color: '#ef4444', opacity: canDelete ? 0.4 : 0.1, padding: '0.2rem', display: 'flex', alignItems: 'center', transition: 'opacity 0.1s' }}
          onMouseEnter={e => canDelete && ((e.currentTarget as HTMLButtonElement).style.opacity = '1')}
          onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.opacity = canDelete ? '0.4' : '0.1')}>
          <X size={13} />
        </button>
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

  // ── Scanner detection (speed heuristic) ─────────────────────────────────
  // Si avg de últimos 5 keypresses < 80ms → lector físico, no teclado humano
  const lastKeyTimeRef = useRef<number>(0)
  const keyTimesRef    = useRef<number[]>([])

  // ── Micro toast ───────────────────────────────────────────────────────────
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const toastTimerRef     = useRef<ReturnType<typeof setTimeout>>()

  // ── Overlay "Producto agregado" ────────────────────────────────────────────
  const [addedOverlay, setAddedOverlay] = useState<{
    name: string; price: number; qty: number; totalQty: number; stockLeft: number
  } | null>(null)
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // ── Sonidos POS ────────────────────────────────────────────────────────────
  const [soundsEnabled, setSoundsEnabled] = useState(() => soundSystem.isEnabled())

  // ── Último método de pago ──────────────────────────────────────────────────
  const [lastPayMethod, setLastPayMethod] = useState<string | null>(() => {
    try { return localStorage.getItem('pos_last_method') } catch { return null }
  })

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
  // UI puramente presentacional: grupo de pago desplegado (MP/Tarjeta) y
  // revelado manual de filas del carrito. No alteran lógica ni contratos.
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [manualRows, setManualRows] = useState(false)

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
  const [comprobanteCreado, setComprobanteCreado] = useState<Comprobante | null>(null)
  const [showWaModal, setShowWaModal] = useState(false)
  const [arcaWarning, setArcaWarning] = useState<string | null>(null)
  const [arcaPending, setArcaPending] = useState(false)
  // Idempotencia de checkout (auditoría 2026-07-01): already_processing / idempotency_conflict
  // son estados explícitos del contrato de create_comprobante_checkout_atomic — nunca se
  // muestran como error genérico (ver Fase 6/10 del informe).
  const [checkoutBlockedTitle,   setCheckoutBlockedTitle]   = useState<string | null>(null)
  const [checkoutBlockedMessage, setCheckoutBlockedMessage] = useState<string | null>(null)

  // ── Draft ────────────────────────────────────────────────────────────────
  const DRAFT_KEY = useMemo(() => `draft_comp_${businessId ?? 'x'}_${user?.id ?? 'x'}`, [businessId, user?.id])
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [draftInfo, setDraftInfo] = useState<{ data: object; savedAt: string } | null>(null)
  const hasContent = useMemo(() => lineas.some(l => l.descripcion.trim()), [lineas])

  // ── Refs ──────────────────────────────────────────────────────────────────
  const clienteWrapperRef  = useRef<HTMLDivElement>(null)
  const clienteInputRef    = useRef<HTMLInputElement>(null)
  const isSubmittingRef    = useRef(false)        // anti-doble-submit
  const lastScanTimeRef    = useRef<number>(0)    // cooldown anti-doble-scan (150ms)

  // ── Full Cashier mode ─────────────────────────────────────────────────────
  const [fullCashier, setFullCashier] = useState(() => {
    try { return localStorage.getItem('pos_full_cashier') === '1' } catch { return false }
  })

  // ── Error shake key ───────────────────────────────────────────────────────
  const [errorShakeKey, setErrorShakeKey] = useState(0)

  // ── Bottom sheet (checkout móvil) ─────────────────────────────────────────
  // El panel .cpm-right es una ÚNICA instancia: en desktop es columna derecha y
  // en teléfono/tablet vertical se reposiciona visualmente como bottom sheet vía CSS.
  const [sheetOpen, setSheetOpen] = useState(false)
  const openSheetBtnRef  = useRef<HTMLButtonElement>(null)
  const sheetCloseBtnRef = useRef<HTMLButtonElement>(null)
  const openSheet  = useCallback(() => { setSheetOpen(true);  setTimeout(() => sheetCloseBtnRef.current?.focus(), 60) }, [])
  const closeSheet = useCallback(() => { setSheetOpen(false); setTimeout(() => openSheetBtnRef.current?.focus(), 60) }, [])

  // Offset del teclado virtual (px) — reusa el hook compartido (visualViewport).
  // Se expone como CSS custom property en .cpm-root para que el sheet/footer lo consuman.
  const keyboardOffset = useKeyboardAwareBottomOffset()

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
    // Desglose CC vs caja
    const pagadoCC   = pagos.filter(p => p.payment_method === 'cuenta_corriente').reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
    const pagadoCaja = pagos.filter(p => p.payment_method !== 'cuenta_corriente').reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
    return { subtotal, iva, total, descuento, costo, ganancia, margenPct, totalPagado, saldo, totalRecargo, vuelto, pagadoCC, pagadoCaja }
  }, [lineas, tipo, exchangeRate, pagos])

  // ── refocusInput — función central, SIEMPRE usar en lugar de setTimeout directo
  const refocusInput = useCallback((delayMs = 40) => {
    setTimeout(() => { spotRef.current?.focus() }, delayMs)
  }, [])

  // ── handleSubmit ──────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (isSubmittingRef.current) return                    // anti-doble-submit
    const validLines = lineas.filter(l => l.descripcion.trim() && l.cantidad > 0 && l.precio_unitario >= 0)
    if (validLines.length === 0) { setSubmitError('Agregá al menos un ítem'); setErrorShakeKey(k => k + 1); return }
    if (!businessId) { setSubmitError('Error: negocio no identificado'); setErrorShakeKey(k => k + 1); return }
    if (!cajaIsOpen && !skipFinanceEntry) { setSubmitError('No hay caja abierta. Abrí caja antes de emitir.'); setErrorShakeKey(k => k + 1); return }
    const pagosConMonto = pagos.filter(p => parseFloat(p.amount) > 0)
    if (pagos.length > 0 && pagosConMonto.length === 0) { setSubmitError('Ingresá el monto del cobro'); setErrorShakeKey(k => k + 1); return }

    isSubmittingRef.current = true
    setSubmitting(true); setSubmitError(null); setArcaWarning(null); setArcaPending(false)
    setCheckoutBlockedTitle(null); setCheckoutBlockedMessage(null)

    const itemsPayload = validLines.map(l => ({
      descripcion: l.descripcion, tipo_linea: l.tipo_linea, cantidad: l.cantidad,
      precio_unitario: l.precio_unitario, descuento_linea: l.descuento_linea || 0,
      costo_unitario: l.costo_unitario || 0, currency: l.currency,
      exchange_rate: l.currency === 'USD' ? exchangeRate : 1,
      inventory_id: l.inventory_id || null, applied_price_type: l.applied_price_type || null,
    }))
    const pagosPayload = pagosConMonto.map(p => ({
      payment_method: p.payment_method, payment_provider: p.payment_provider || undefined,
      amount: parseFloat(p.amount) || 0, currency: 'ARS' as const, commission_rate: p.commission_rate,
    }) as ComprobantePago)

    // Clave de idempotencia del INTENTO COMERCIAL — se genera una sola vez y
    // se conserva en sessionStorage durante doble click/timeout/retry/refresh.
    // Nunca se regenera automáticamente ante un timeout o un already_processing;
    // solo cambia si el hash del carrito cambió (venta distinta) — ver
    // src/lib/checkoutIdempotency.ts.
    const ccTotalForHash = pagos.filter(p => p.payment_method === 'cuenta_corriente')
      .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
    const requestHash = await computeCheckoutRequestHash({
      business_id: businessId,
      tipo,
      customer_id: clienteId || null,
      condicion_fiscal: condicion,
      currency: 'ARS',
      items: itemsPayload,
      pagos: pagosPayload,
      subtotal: totales.subtotal,
      tax: totales.iva,
      total: totales.total,
      cc_total: ccTotalForHash,
    })
    const { idempotencyKey } = getOrCreateIdempotencyKey(businessId, requestHash)

    const input: CrearComprobanteInput = {
      tipo, punto_venta: puntoVenta, condicion_fiscal: condicion,
      customer_id: clienteId || null, observaciones, exchange_rate: exchangeRate,
      es_fiscal: TIPO_CONFIG[tipo].fiscal, emitir_en_arca: emitirEnArca,
      items: itemsPayload,
      pagos: pagosPayload,
      business_id: businessId, created_by: user?.id, caja_id: cajaId || null,
      skip_finance_entry: skipFinanceEntry,
      idempotency_key: idempotencyKey,
    }

    const result = await comprobanteService.crear(input)

    if (result.idempotencyConflict) {
      // Nunca seguir silenciosamente con datos distintos, y nunca generar una
      // key nueva automáticamente para esquivar el conflicto — se descarta el
      // pendiente (para que el PRÓXIMO submit explícito arranque de cero) y se
      // exige revisión manual.
      clearPendingCheckout(businessId)
      setCheckoutBlockedTitle('La operación cambió')
      setCheckoutBlockedMessage('Esta venta fue modificada después de iniciar el cobro. Revisá los datos antes de volver a intentarlo.')
      setErrorShakeKey(k => k + 1)
      soundSystem.play('payment_fail')
      setSubmitting(false)
      isSubmittingRef.current = false
      return
    }
    if (result.alreadyProcessing) {
      // Otra transacción con la MISMA key está confirmándose — nunca se
      // genera otra key ni se reintenta la creación; se conserva el
      // pendiente para que un reintento manual recupere el mismo resultado.
      setCheckoutBlockedTitle('La venta ya se está procesando')
      setCheckoutBlockedMessage('Estamos confirmando el comprobante. No vuelvas a cobrarlo.')
      setSubmitting(false)
      isSubmittingRef.current = false
      return
    }
    if (!result.success) {
      setSubmitError(result.error || 'Error al crear el comprobante')
      setErrorShakeKey(k => k + 1)
      soundSystem.play('payment_fail')
      setSubmitting(false)
      isSubmittingRef.current = false
      return
    }

    // Creación local resuelta de forma definitiva (created o existing — un
    // retry que recuperó la misma venta) — el checkout ya no está pendiente.
    clearPendingCheckout(businessId)

    if (result.arcaError) {
      // El detalle técnico (DNS, timeouts, faults SOAP) queda solo en logs;
      // la UI muestra un mensaje amigable — ver ARCA_CONNECTION_ERROR_* más abajo.
      posLogger.error('Emisión ARCA falló al crear comprobante', result.arcaError)
      setArcaWarning(result.arcaError)
      setArcaPending(!!result.arcaPendingReconciliation)
    }

    // Sonido + vibración de éxito
    soundSystem.play('payment_success')
    if ('vibrate' in navigator) navigator.vibrate(80)

    try { localStorage.removeItem(DRAFT_KEY) } catch {}
    setComprobanteCreado(result.comprobante ?? null)
    setSubmitting(false)
    isSubmittingRef.current = false
    setShowSuccess(true)
    // Vibración táctil
    if ('vibrate' in navigator) navigator.vibrate(80)
  }, [lineas, businessId, cajaIsOpen, skipFinanceEntry, pagos, tipo, puntoVenta, condicion, clienteId, observaciones, exchangeRate, emitirEnArca, user, cajaId, DRAFT_KEY, totales])

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen) return
    setTipo(tipoInicial ?? 'factura_c'); setPuntoVenta(puntoVentaInicial ?? '0001')
    setCondicion(condicionFiscalInicial ?? 'Consumidor Final'); setClienteId(initialClienteId ?? '')
    setClienteQuery(''); setObservaciones(''); setEmitirEnArca(false)
    setSubmitError(null); setShowSuccess(false); setArcaWarning(null)
    setComprobanteCreado(null); setShowWaModal(false)
    setPagos([]); setSpotQ(''); setSpotResults([]); setSpotKeyIdx(-1); setSpotlightMode(false)
    setActiveSearchIdx(null); setLineResults([])
    setShowCloseConfirm(false); setShowRecalcPrompt(false)
    setExpandedGroup(null); setManualRows(false)

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

  // ── Recuperación de checkout incierto (fase 9 — timeout/refresh/cierre) ────
  // Al abrir el modal, si hay un intento comercial pendiente en sessionStorage
  // para este negocio, se consulta su estado real server-side ANTES de
  // permitir un cobro nuevo — nunca se crea una segunda venta mientras la
  // anterior siga sin resolverse.
  useEffect(() => {
    if (!isOpen || !businessId) return
    const pending = readPendingCheckout(businessId)
    if (!pending) return

    let cancelled = false
    ;(async () => {
      const status = await comprobanteService.getCheckoutStatus(businessId, pending.idempotencyKey)
      if (cancelled) return

      if (!status.found || status.checkoutStatus === 'failed_final') {
        // Nunca se comiteó nada (o falló de forma definitiva) — no hay nada
        // que recuperar, se descarta el pendiente.
        clearPendingCheckout(businessId)
        return
      }
      if (status.checkoutStatus === 'completed' && status.comprobanteId) {
        // La venta local SÍ se creó (posiblemente ARCA sigue pendiente) —
        // se recupera como éxito, nunca se dispara una creación nueva.
        const comp = await comprobanteService.getById(status.comprobanteId, businessId)
        if (cancelled) return
        clearPendingCheckout(businessId)
        setComprobanteCreado(comp)
        setShowSuccess(true)
        if (status.estadoFiscal === 'pendiente_conciliacion') {
          setArcaWarning(ARCA_PENDING_RECONCILIATION_MESSAGE)
          setArcaPending(true)
        }
      }
      // 'processing' / 'failed_retryable': se conserva el pendiente tal cual —
      // el próximo submit manual reutiliza la MISMA key (mismo hash) y la RPC
      // decide (already_processing / retry limpio), nunca se crea otra venta.
    })()

    return () => { cancelled = true }
  }, [isOpen, businessId])

  useEffect(() => {
    if (!isOpen || !businessId || puntoVentaInicial) return
    supabase.from('sales_points').select('punto_venta').eq('business_id', businessId)
      .eq('is_active', true).order('created_at', { ascending: true }).limit(1).maybeSingle()
      .then(({ data }) => { if (data?.punto_venta) setPuntoVenta(String(data.punto_venta).padStart(4, '0')) })
  }, [isOpen, businessId, puntoVentaInicial])

  useEffect(() => {
    if (!isOpen || !businessId) return
    supabase.from('customers').select('id, name, customer_type, phone')
      .eq('business_id', businessId).order('name').limit(300)
      .then(({ data }) => setClientes((data || []) as ClienteOption[]))
  }, [isOpen, businessId])

  // Productos recientes (últimos vendidos desde comprobante_items)
  useEffect(() => {
    if (!isOpen || !businessId) return
    supabase.from('comprobante_items')
      .select('inventory_id, inventory:inventory_id(id,name,variant_name,sale_price,stock_quantity,cost_price,cost_price_usd,precio_mayorista,base_price,base_currency,auto_update_price,exchange_rate_used,code,category,has_variants,is_active)')
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

  // Auto-focus del input de búsqueda al abrir; cleanup al cerrar
  useEffect(() => {
    if (!isOpen) {
      clearTimeout(toastTimerRef.current); setToast(null)
      clearTimeout(overlayTimerRef.current); setAddedOverlay(null)
      keyTimesRef.current = []
      return
    }
    const t = setTimeout(() => refocusInput(0), 200)
    return () => clearTimeout(t)
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

  // Ref estable para activeSearchIdx: evita re-registrar el listener en cada cambio
  const activeSearchIdxRef = useRef<number | null>(null)
  activeSearchIdxRef.current = activeSearchIdx

  // Outside click — listener registrado UNA SOLA VEZ mientras el modal está abierto
  useEffect(() => {
    if (!isOpen) return
    const fn = (e: MouseEvent) => {
      if (clienteWrapperRef.current && !clienteWrapperRef.current.contains(e.target as Node)) setClienteOpen(false)
      const idx = activeSearchIdxRef.current
      if (idx !== null) {
        const ref = dropdownRefs.current[idx]
        if (ref && !ref.contains(e.target as Node)) { setActiveSearchIdx(null); setLineResults([]) }
      }
    }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [isOpen])

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
        // Prioridad: si el bottom sheet está abierto, cerrarlo primero (sin tocar el modal).
        if (sheetOpen && !showSuccess) { e.preventDefault(); closeSheet(); return }
        if (hasContent && !showSuccess) setShowCloseConfirm(true); else if (!showSuccess) onClose(); return
      }
      if ((e.key === 'F4' || (e.shiftKey && e.key === 'Enter') || (e.ctrlKey && e.key === 'Enter')) && !showSuccess) { e.preventDefault(); void handleSubmit(); return }
      if (e.key === 'F2' && !showSuccess) { e.preventDefault(); clienteInputRef.current?.focus(); return }
      // Ctrl+B → focus directo al input POS (no abre overlay)
      if ((e.ctrlKey && (e.key === 'b' || e.key === 'B')) && !showSuccess) { e.preventDefault(); refocusInput(0); return }
      // Shift+Backspace → eliminar último ítem cargado
      if (e.shiftKey && e.key === 'Backspace' && !showSuccess && document.activeElement === spotRef.current) {
        e.preventDefault()
        setLineas(prev => {
          const filled = prev.filter(l => l.descripcion.trim())
          if (filled.length === 0) return prev
          const last = filled[filled.length - 1]
          const next = prev.filter(l => l._key !== last._key)
          return next.length > 0 ? next : [emptyLinea()]
        })
        refocusInput(30)
        return
      }
      // Ctrl+Shift+F → toggle Full Cashier mode
      if (e.ctrlKey && e.shiftKey && (e.key === 'f' || e.key === 'F') && !showSuccess) {
        e.preventDefault()
        setFullCashier(v => { try { localStorage.setItem('pos_full_cashier', !v ? '1' : '0') } catch {} return !v })
        return
      }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [isOpen, hasContent, onClose, handleSubmit, showCloseConfirm, draftInfo, showSuccess, sheetOpen, closeSheet])

  // ── Search helpers ────────────────────────────────────────────────────────

  const runSearch = useCallback(async (q: string, onResult: (r: InventoryResult[]) => void, setLoad: (v: boolean) => void) => {
    if (q.length < 2) { onResult([]); return }
    setLoad(true)
    try {
      const dbQ = buildSupabaseQuery(q)
      const { data, error: searchErr } = await supabase.from('inventory')
        .select('id,code,name,variant_name,category,stock_quantity,cost_price,cost_price_usd,sale_price,precio_mayorista,base_price,base_currency,auto_update_price,exchange_rate_used,has_variants')
        .eq('business_id', businessId).eq('is_active', true).not('has_variants', 'is', true)
        .or(`name.ilike.${dbQ},variant_name.ilike.${dbQ},code.ilike.${dbQ},category.ilike.${dbQ}`).limit(40)
      if (searchErr) {
        console.warn('[ComprobanteProModal.runSearch] DB error:', searchErr.message)
        onResult([])
        return
      }
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

  // ── showToast (debe ir ANTES de addOrIncrement) ───────────────────────────

  const showToast = useCallback((msg: string, ok: boolean) => {
    clearTimeout(toastTimerRef.current)
    setToast({ msg, ok })
    toastTimerRef.current = setTimeout(() => setToast(null), 1800)
  }, [])

  // ── addOrIncrement ────────────────────────────────────────────────────────
  // Agrega producto al carrito; si ya existe incrementa cantidad en lugar de
  // crear una nueva línea (comportamiento POS / supermercado)

  const addOrIncrement = useCallback((inv: InventoryResult, qty = 1) => {
    const customer = esClienteMayorista ? { customer_type: 'mayorista' } : { customer_type: 'minorista' }
    // Precio ARS vigente: dolariza productos USD-auto con la cotización actual antes de aplicar la regla por cliente.
    const eff  = resolveProductPricing(inv, exchangeRate)
    const pr   = getProductPriceForCustomer({ sale_price: eff.saleArs, precio_mayorista: eff.mayoristaArs }, customer)
    const desc = [inv.name, inv.variant_name].filter(Boolean).join(' — ') + (inv.code ? ` [${inv.code}]` : '')
    const stock = inv.stock_quantity

    let finalQty   = qty
    let totalQty   = qty

    setLineas(prev => {
      const existIdx = prev.findIndex(l => l.inventory_id === inv.id)
      if (existIdx >= 0) {
        totalQty = prev[existIdx].cantidad + qty
        return prev.map((l, i) => i === existIdx ? { ...l, cantidad: l.cantidad + qty } : l)
      }
      const populated: Partial<LineaItem> = {
        // Costo ARS vigente: dolariza USD-auto con la cotización actual (eff.costArs),
        // mismo motor que el precio. Se congela en comprobante_items al confirmar la venta.
        descripcion: desc, precio_unitario: pr.price, costo_unitario: eff.costArs,
        inventory_id: inv.id, inv_sale_price: eff.saleArs, inv_stock: stock,
        inv_mayorista_price: eff.mayoristaArs,
        applied_price_type: pr.priceType as 'minorista' | 'mayorista', no_mayorista_warning: pr.fallback,
      }
      const ei = prev.findIndex(l => !l.descripcion.trim())
      finalQty = qty
      if (ei >= 0) return prev.map((l, i) => i === ei ? { ...l, ...populated, cantidad: qty } : l)
      return [...prev, { ...emptyLinea(), ...populated, cantidad: qty }]
    })

    // ── Alerta de stock ──────────────────────────────────────────────────────
    const stockLeft = stock - qty
    if (stock <= 0) {
      showToast('Sin stock — se agrega de todas formas', false)
    } else if (stock === 1) {
      showToast(`⚠ Última unidad de ${inv.name.slice(0, 28)}`, false)
    }

    // ── Overlay premium ──────────────────────────────────────────────────────
    clearTimeout(overlayTimerRef.current)
    setAddedOverlay({ name: desc.slice(0, 40), price: pr.price, qty: finalQty, totalQty, stockLeft: Math.max(0, stockLeft) })
    overlayTimerRef.current = setTimeout(() => setAddedOverlay(null), 750)

    setSpotQ(''); setSpotResults([]); setSpotKeyIdx(-1); setSpotlightMode(false)
    refocusInput(30)
  }, [esClienteMayorista, showToast, exchangeRate])

  // ── doExactSearch — búsqueda por código/barcode exacto (scanner) ──────────

  const doExactSearch = useCallback(async (raw: string) => {
    if (!raw.trim() || !businessId) return

    // Anti-doble-scan: ignorar si el mismo scan llega < 150ms después del anterior
    const now = Date.now()
    if (now - lastScanTimeRef.current < 150) return
    lastScanTimeRef.current = now

    // Parsear formatos de cantidad: "3*CODE", "CODEx3", "CODE*3"
    const { code, qty } = parseQtyCode(raw)

    const { data } = await supabase
      .from('inventory')
      .select('id,code,name,variant_name,category,stock_quantity,cost_price,cost_price_usd,sale_price,precio_mayorista,base_price,base_currency,auto_update_price,exchange_rate_used,has_variants')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .not('has_variants', 'is', true)
      .or(`code.eq.${code},barcode.eq.${code}`)
      .limit(1)

    const found = data?.[0] as InventoryResult | undefined
    setSpotQ(''); setSpotResults([])

    if (found) {
      addOrIncrement(found, qty)
      soundSystem.play('scan_success')
      if ('vibrate' in navigator) navigator.vibrate(40)
    } else {
      showToast('Código no encontrado en inventario', false)
      soundSystem.play('scan_error')
      refocusInput(50)
    }
    keyTimesRef.current = []
  }, [businessId, addOrIncrement, showToast])

  // ── handleSearchKeyDown — maneja tipeo humano Y scanner físico ────────────

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Medir velocidad entre teclas
    const now = Date.now()
    const gap = now - lastKeyTimeRef.current
    if (lastKeyTimeRef.current > 0 && gap < 2000) {
      keyTimesRef.current = [...keyTimesRef.current.slice(-7), gap]
    }
    lastKeyTimeRef.current = now

    if (e.key === 'ArrowDown') { e.preventDefault(); setSpotKeyIdx(i => Math.min(i + 1, spotResults.length - 1)); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setSpotKeyIdx(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Escape')    { if (spotQ) { setSpotQ(''); setSpotResults([]) } return }
    // Tab siempre atrapado — el input principal nunca pierde foco por Tab
    if (e.key === 'Tab') { e.preventDefault(); return }

    if (e.key === 'Enter') {
      e.preventDefault()
      const val = spotQ.trim()
      // Enter inteligente: vacío + hay items → cobrar directo (siempre, no solo en caja rápida)
      if (!val && hasContent) { void handleSubmit(); return }
      if (!val) return

      // Heurística: scanner físico manda chars muy rápido (< 80ms entre teclas)
      const recent = keyTimesRef.current.filter(g => g < 400)
      const avgGap = recent.length >= 4
        ? recent.reduce((a, b) => a + b, 0) / recent.length
        : 999
      const isScan = avgGap < 80 && val.length >= 6

      if (isScan || spotResults.length === 0) {
        void doExactSearch(val)
      } else {
        const target = spotKeyIdx >= 0 ? spotResults[spotKeyIdx] : spotResults[0]
        if (target) addOrIncrement(target)
      }
      keyTimesRef.current = []
    }
  }, [spotQ, spotResults, spotKeyIdx, addOrIncrement, doExactSearch, hasContent, handleSubmit])

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
    const eff = resolveProductPricing(inv, exchangeRate)
    const pr = getProductPriceForCustomer({ sale_price: eff.saleArs, precio_mayorista: eff.mayoristaArs }, customer)
    const desc = [inv.name, inv.variant_name].filter(Boolean).join(' — ') + (inv.code ? ` [${inv.code}]` : '')
    setLineas(prev => prev.map((l, i) => i === idx ? {
      ...l, descripcion: desc, precio_unitario: pr.price, costo_unitario: eff.costArs,
      currency: 'ARS', inventory_id: inv.id, inv_sale_price: eff.saleArs, inv_stock: inv.stock_quantity,
      inv_mayorista_price: eff.mayoristaArs,
      applied_price_type: pr.priceType as 'minorista' | 'mayorista', no_mayorista_warning: pr.fallback,
    } : l))
    setActiveSearchIdx(null); setLineResults([])
  }, [esClienteMayorista, exchangeRate])

  // Precio ARS efectivo para mostrar en buscadores/recientes — mismo motor que el alta
  // (dolariza USD-auto con la cotización vigente y aplica la regla minorista/mayorista).
  const effPrice = useCallback((p: InventoryResult): number =>
    effectiveCustomerPriceARS(p, exchangeRate, esClienteMayorista),
  [esClienteMayorista, exchangeRate])

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
      // Persistir último método usado
      try { localStorage.setItem('pos_last_method', metodo.id) } catch {}
      setLastPayMethod(metodo.id)
    }
  }, [pagos, totales.total])

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
  const [showKbdPopover, setShowKbdPopover] = useState(false)

  // ── Guard ─────────────────────────────────────────────────────────────────
  if (!isOpen) return null

  const tc = TIPO_CONFIG[tipo]
  const filledLineas = lineas.filter(l => l.descripcion.trim())

  // ── Shared icon-button style ─────────────────────────────────────────────
  const iBtn: React.CSSProperties = {
    background: 'rgba(255,255,255,0.04)', border: '1px solid var(--pos-border)',
    cursor: 'pointer', color: 'var(--pos-text-muted)', padding: '0.4rem', borderRadius: '0.5rem',
    display: 'flex', alignItems: 'center', transition: 'all 0.15s',
  }

  // ── Payment chip styling (medios primarios y grupos) ──────────────────────
  const payChip = (active: boolean, color?: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '0.45rem',
    padding: '0.55rem 0.625rem', borderRadius: '0.625rem', minHeight: 44,
    border: `1px solid ${active ? (color || 'var(--pos-accent)') : 'var(--pos-border)'}`,
    background: active ? `${color || '#6366f1'}1f` : 'rgba(255,255,255,0.025)',
    color: active ? (color || 'var(--pos-accent)') : 'var(--pos-text-secondary)',
    fontSize: '0.8rem', fontWeight: active ? 700 : 600, cursor: 'pointer',
    transition: 'all 0.15s', textAlign: 'left', fontFamily: F,
  })
  const payHover = (e: React.MouseEvent<HTMLButtonElement>, active: boolean, enter: boolean) => {
    if (active) return
    e.currentTarget.style.background = enter ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.025)'
    e.currentTarget.style.color = enter ? 'var(--pos-text-primary)' : 'var(--pos-text-secondary)'
    e.currentTarget.style.borderColor = enter ? 'var(--pos-border-hover)' : 'var(--pos-border)'
  }
  // ── Empty-state action button style ───────────────────────────────────────
  const emptyAction: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.45rem 0.75rem',
    background: 'rgba(255,255,255,0.04)', border: '1px solid var(--pos-border)', borderRadius: '0.5rem',
    color: 'var(--pos-text-secondary)', fontSize: '0.74rem', fontWeight: 600, cursor: 'pointer', fontFamily: F,
  }

  // Carrito visualmente vacío: ninguna línea con descripción y sin filas
  // manuales reveladas. No toca la estructura interna de `lineas`.
  const showCartEmpty = filledLineas.length === 0 && !manualRows

  // ── JSX ───────────────────────────────────────────────────────────────────
  return (
    <>
    <div
      className={`cpm-root${sheetOpen ? ' cpm-sheet-open' : ''}`}
      onClick={e => { if (e.target === e.currentTarget) tryClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: fullCashier ? 'rgba(0,0,0,0.98)' : 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(12px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: fullCashier ? 0 : '0.5rem', fontFamily: F,
        '--cpm-keyboard-offset': `${keyboardOffset}px`,
      } as React.CSSProperties}
    >
      <div className={`cpm-shell${fullCashier ? ' cpm-shell-full' : ''}`} style={{
        background: '#0a1628',
        border: fullCashier ? 'none' : '1px solid rgba(255,255,255,0.08)',
        borderRadius: fullCashier ? 0 : '1.375rem',
        width: '100%',
        maxWidth: fullCashier ? '100vw' : '1340px',
        display: 'flex', flexDirection: 'column',
        boxShadow: fullCashier ? 'none' : '0 40px 120px rgba(0,0,0,0.95), 0 0 0 1px rgba(255,255,255,0.04)',
        overflow: 'hidden',
        transition: 'border-radius 0.18s ease, height 0.18s ease',
      }}>

        {/* ── HEADER ──────────────────────────────────────────────────────── */}
        <div className="cpm-header" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0 1.25rem', height: 64, borderBottom: '1px solid #263750', flexShrink: 0, background: 'linear-gradient(180deg, #0f1f3d 0%, #07111f 100%)' }}>

          {/* Tipo — segmented control */}
          <div role="group" aria-label="Tipo de comprobante" style={{ display: 'flex', background: 'rgba(0,0,0,0.35)', borderRadius: '0.75rem', padding: '0.2rem', gap: '0.125rem' }}>
            {(Object.entries(TIPO_CONFIG) as [TipoComprobante, typeof tc][]).map(([k, cfg]) => {
              const sel = k === tipo
              return (
                <button key={k} onClick={() => setTipo(k)} aria-pressed={sel} title={cfg.label}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.35rem 0.875rem', borderRadius: '0.5rem', border: `1px solid ${sel ? cfg.border : 'transparent'}`, background: sel ? cfg.bg : 'transparent', color: sel ? cfg.color : 'var(--pos-text-secondary)', fontSize: '0.78rem', fontWeight: sel ? 800 : 500, cursor: 'pointer', transition: 'all 0.15s', fontFamily: F }}>
                  {/* Indicador no-cromático: check para el tipo activo */}
                  {sel && <Check size={12} style={{ flexShrink: 0 }} />}
                  {cfg.label}
                </button>
              )
            })}
          </div>

          {/* Centro: PV + dólar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.375rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', background: 'rgba(0,0,0,0.25)', border: '1px solid #263750', borderRadius: '0.5rem', padding: '0.25rem 0.625rem' }}>
              <span style={{ fontSize: '0.68rem', color: '#8494aa', fontWeight: 700 }}>PV</span>
              <input value={puntoVenta} onChange={e => setPuntoVenta(e.target.value)} style={{ width: '3.5rem', background: 'none', border: 'none', outline: 'none', color: '#b8c4d6', fontSize: '0.82rem', textAlign: 'center', fontFamily: F }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', background: 'rgba(0,0,0,0.25)', border: '1px solid #263750', borderRadius: '0.5rem', padding: '0.25rem 0.625rem' }}>
              <DollarSign size={11} color="#8494aa" />
              <input type="number" value={exchangeRate} onChange={e => setExchangeRate(parseFloat(e.target.value) || 1)} style={{ width: '4.5rem', background: 'none', border: 'none', outline: 'none', color: '#b8c4d6', fontSize: '0.82rem', textAlign: 'right', fontFamily: F }} />
            </div>
          </div>

          {/* Acciones */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            {/* Sonidos */}
            <button onClick={() => setSoundsEnabled(soundSystem.toggle())} className="cpm-touch" title="Sonidos POS" aria-label={soundsEnabled ? 'Desactivar sonidos' : 'Activar sonidos'} style={iBtn}>
              {soundsEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </button>

            {/* Atajos — popover */}
            <div style={{ position: 'relative' }}>
              <button onClick={() => setShowKbdPopover(v => !v)} title="Atajos de teclado" aria-label="Atajos de teclado" aria-pressed={showKbdPopover}
                style={{ ...iBtn, background: showKbdPopover ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.04)', borderColor: showKbdPopover ? 'rgba(99,102,241,0.3)' : '#263750', color: showKbdPopover ? '#818cf8' : '#8494aa' }}>
                <Keyboard size={14} />
              </button>
              {showKbdPopover && (
                <div style={{ position: 'absolute', top: 'calc(100% + 0.5rem)', right: 0, zIndex: 200, background: '#0c1829', border: '1px solid #263750', borderRadius: '0.875rem', padding: '1rem', minWidth: 230, boxShadow: '0 12px 40px rgba(0,0,0,0.7)', animation: 'spotlightSlide 0.12s ease' }}>
                  <div style={{ fontSize: '0.62rem', fontWeight: 700, color: '#8494aa', textTransform: 'uppercase' as const, letterSpacing: '0.07em', marginBottom: '0.625rem' }}>Atajos</div>
                  {[['F4 / Enter','Cobrar'],['F2','Buscar cliente'],['Ctrl+B','Focus scanner'],['⇧+⌫','Quitar último ítem'],['Ctrl+⇧+F','Pantalla completa'],['Esc','Cerrar']].map(([k,d]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.2rem 0', gap: '1rem' }}>
                      <span style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid #263750', borderRadius: '0.25rem', padding: '0.1rem 0.45rem', fontSize: '0.65rem', color: '#b8c4d6', fontWeight: 600, whiteSpace: 'nowrap' as const, fontFamily: 'monospace' }}>{k}</span>
                      <span style={{ fontSize: '0.72rem', color: '#8494aa' }}>{d}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Pantalla completa */}
            <button
              onClick={() => setFullCashier(v => { try { localStorage.setItem('pos_full_cashier', !v ? '1' : '0') } catch {} return !v })}
              title={fullCashier ? 'Salir pantalla completa' : 'Pantalla completa (Ctrl+Shift+F)'}
              aria-label={fullCashier ? 'Salir pantalla completa' : 'Pantalla completa'}
              style={{ ...iBtn, background: fullCashier ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.04)', borderColor: fullCashier ? 'rgba(99,102,241,0.3)' : '#263750', color: fullCashier ? '#818cf8' : '#8494aa' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                {fullCashier
                  ? <><polyline points="8 3 3 3 3 8"/><polyline points="21 8 21 3 16 3"/><polyline points="3 16 3 21 8 21"/><polyline points="16 21 21 21 21 16"/></>
                  : <><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></>
                }
              </svg>
            </button>

            {/* Cerrar */}
            <button data-testid="comprobante-cancel-button" className="cpm-touch" onClick={tryClose} aria-label="Cerrar"
              style={iBtn}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#f8fafc' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#8494aa' }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ── BODY ────────────────────────────────────────────────────────── */}
        <div className="cpm-body" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* ── LEFT COLUMN ─────────────────────────────────────────────── */}
          <div className="cpm-left" style={{ flex: 1, overflow: 'auto', padding: '1.125rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '1.125rem', borderRight: '1px solid #263750', position: 'relative' as const }}>

            {/* OVERLAY PRODUCTO AGREGADO */}
            {addedOverlay && (
              <div style={{
                position: 'absolute' as const, top: '0.875rem', right: '0.875rem', zIndex: 50,
                background: 'rgba(7,17,31,0.97)', border: '1px solid rgba(52,211,153,0.4)',
                borderRadius: '1rem', padding: '0.875rem 1.125rem', minWidth: 200,
                boxShadow: '0 8px 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(52,211,153,0.12)',
                animation: 'overlayIn 0.15s ease', pointerEvents: 'none' as const,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.35rem' }}>
                  <Check size={12} color="#34d399" />
                  <span style={{ color: '#34d399', fontSize: '0.72rem', fontWeight: 800, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>Agregado</span>
                </div>
                <div style={{ color: '#f8fafc', fontSize: '0.875rem', fontWeight: 700, marginBottom: '0.25rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                  {addedOverlay.name}
                </div>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                  <span style={{ color: '#a5b4fc', fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9rem', fontVariantNumeric: 'tabular-nums' }}>{fmtARS(addedOverlay.price)}</span>
                  <span style={{ color: '#8494aa', fontSize: '0.72rem' }}>×{addedOverlay.totalQty}</span>
                  <span style={{ color: addedOverlay.stockLeft <= 0 ? '#f87171' : addedOverlay.stockLeft <= 5 ? '#fbbf24' : '#8494aa', fontSize: '0.68rem' }}>
                    {addedOverlay.stockLeft <= 0 ? 'Sin stock' : `${addedOverlay.stockLeft} restante${addedOverlay.stockLeft !== 1 ? 's' : ''}`}
                  </span>
                </div>
              </div>
            )}

            {/* STATUS BAR */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.2rem 0.625rem', borderRadius: '9999px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)' }}>
                <Zap size={10} color="#818cf8" />
                <span style={{ fontSize: '0.63rem', fontWeight: 700, color: '#818cf8' }}>POS</span>
              </div>
              {lastPayMethod && (
                <div style={{ fontSize: '0.63rem', color: '#8494aa', padding: '0.2rem 0.5rem', borderRadius: '9999px', background: 'rgba(255,255,255,0.03)', border: '1px solid #263750' }}>
                  Últ.: {lastPayMethod}
                </div>
              )}
            </div>

            {/* CLIENTE */}
            <div ref={clienteWrapperRef} style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <User size={13} color="#8494aa" />
                <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#8494aa', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Cliente</span>
                {selectedCliente && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginLeft: 'auto' }}>
                    {esClienteMayorista && <span style={{ fontSize: '0.65rem', fontWeight: 800, padding: '0.15rem 0.5rem', borderRadius: '9999px', background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }}>MAYORISTA</span>}
                    <button onClick={() => { setClienteId(''); setClienteQuery('') }} style={{ background: 'none', border: 'none', color: '#8494aa', cursor: 'pointer', fontSize: '0.7rem', fontFamily: F, display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                      <X size={10} /> Quitar
                    </button>
                  </div>
                )}
              </div>

              {/* Badge Consumidor Final automático — visible cuando hay items pero no hay cliente */}
              {!selectedCliente && !clienteOpen && hasContent && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.25rem 0.625rem', background: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.15)', borderRadius: '9999px', marginBottom: '0.375rem', width: 'fit-content' }}>
                  <User size={11} color="var(--pos-text-muted)" />
                  <span style={{ fontSize: '0.67rem', color: '#b8c4d6', fontWeight: 600 }}>Consumidor Final automático</span>
                </div>
              )}

              {/* Selected client mini card */}
              {selectedCliente && !clienteOpen ? (
                <div onClick={() => setClienteOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 0.875rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '0.75rem', cursor: 'pointer', transition: 'all 0.1s' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(99,102,241,0.2)'}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <User size={15} color="#818cf8" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#f8fafc', fontSize: '0.875rem', fontWeight: 700 }}>{selectedCliente.name}</div>
                    {selectedCliente.phone && <div style={{ color: '#8494aa', fontSize: '0.72rem' }}>{selectedCliente.phone}</div>}
                  </div>
                  <ChevronDown size={13} color="#8494aa" />
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  <User size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#8494aa', pointerEvents: 'none' }} />
                  <input data-testid="comprobante-customer-search" className="cpm-input16" ref={clienteInputRef} value={clienteQuery}
                    onChange={e => { setClienteQuery(e.target.value); setClienteOpen(true); if (!e.target.value) setClienteId('') }}
                    onFocus={() => setClienteOpen(true)}
                    placeholder="Buscar cliente por nombre... (F2)"
                    style={{ width: '100%', padding: '0.625rem 0.875rem 0.625rem 2.25rem', background: 'rgba(255,255,255,0.04)', border: '1px solid #263750', borderRadius: '0.75rem', color: '#f8fafc', fontSize: '0.875rem', outline: 'none', fontFamily: F, boxSizing: 'border-box' }} />
                </div>
              )}

              {/* Cliente dropdown */}
              {clienteOpen && (() => {
                const clienteResults = clienteQuery
                  ? smartSearch(clientes, clienteQuery, [
                      { getValue: (c) => c.name,  weight: 3 },
                      { getValue: (c) => c.phone ?? null, weight: 5 },
                      { getValue: (c) => c.cuit ?? null,  weight: 8 },
                    ]).slice(0, 25)
                  : clientes.slice(0, 25)
                return (
                  <div data-testid="comprobante-customer-results" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200, background: '#0c1a2e', border: '1px solid #263750', borderRadius: '0.875rem', boxShadow: '0 16px 48px rgba(0,0,0,0.7)', maxHeight: 240, overflowY: 'auto', marginTop: '0.25rem', animation: 'spotlightSlide 0.12s ease' }}>
                    {clienteResults.map(c => (
                      <button data-testid="comprobante-customer-option" key={c.id} onMouseDown={() => { setClienteId(c.id); setClienteQuery(c.name); setClienteOpen(false) }}
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0.625rem 1rem', background: c.id === clienteId ? 'rgba(99,102,241,0.1)' : 'none', border: 'none', cursor: 'pointer', color: '#f8fafc', fontSize: '0.845rem', textAlign: 'left', fontFamily: F, gap: '0.5rem', transition: 'background 0.08s' }}
                        onMouseEnter={e => { if (c.id !== clienteId) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = c.id === clienteId ? 'rgba(99,102,241,0.1)' : 'none' }}>
                        <div>
                          <div style={{ fontWeight: c.id === clienteId ? 700 : 500 }}>{c.name}</div>
                          {c.phone && <div style={{ color: '#8494aa', fontSize: '0.7rem' }}>{c.phone}</div>}
                        </div>
                        {c.customer_type === 'mayorista' && <span style={{ fontSize: '0.65rem', color: '#818cf8', fontWeight: 700, flexShrink: 0 }}>MAYORISTA</span>}
                      </button>
                    ))}
                    {clienteResults.length === 0 && (
                      <div style={{ padding: '0.75rem 1rem', color: '#8494aa', fontSize: '0.8rem' }}>Sin resultados</div>
                    )}
                  </div>
                )
              })()}

              {/* Recalc prompt */}
              {showRecalcPrompt && (
                <div style={{ marginTop: '0.5rem', padding: '0.625rem 0.875rem', background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '0.625rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.78rem', color: '#f59e0b', flex: 1 }}>Tipo de cliente cambió. ¿Recalcular precios?</span>
                  <button onClick={() => handleRecalcPrices(esClienteMayorista)} style={{ padding: '0.2rem 0.625rem', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: '0.375rem', color: '#f59e0b', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}>Recalcular</button>
                  <button onClick={() => setShowRecalcPrompt(false)} style={{ background: 'none', border: 'none', color: '#8494aa', cursor: 'pointer', fontSize: '0.75rem', fontFamily: F }}>No</button>
                </div>
              )}
            </div>

            {/* POS SEARCH BAR — buscador manual + scanner unificados ──────── */}
            <div style={{ position: 'relative' as const }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.75rem 0.875rem',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid #263750',
                borderRadius: '0.875rem',
                transition: 'border-color 0.15s, box-shadow 0.15s',
                minHeight: '52px',
              }}
                onFocusCapture={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(99,102,241,0.5)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 0 0 3px rgba(99,102,241,0.12)' }}
                onBlurCapture={e => { (e.currentTarget as HTMLDivElement).style.borderColor = '#263750'; (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}
              >
                <Search size={15} color="#8494aa" style={{ flexShrink: 0 }} />
                <input
                  data-testid="comprobante-product-search"
                  className="cpm-no-focus-ring cpm-input16"
                  ref={spotRef}
                  value={spotQ}
                  onChange={e => handleSpotChange(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Buscar producto, SKU o escanear código..."
                  style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#f8fafc', fontSize: '0.9rem', fontFamily: F, caretColor: '#818cf8' }}
                />
                {spotLoading && <Loader2 size={13} color="#818cf8" style={{ flexShrink: 0, animation: 'tr-spin 0.8s linear infinite' }} />}
                {spotQ && !spotLoading && (
                  <button
                    onClick={() => { setSpotQ(''); setSpotResults([]); refocusInput(0) }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8494aa', padding: '0.1rem', display: 'flex', flexShrink: 0 }}>
                    <X size={13} />
                  </button>
                )}
              </div>

              {/* Quick actions — only when not typing */}
              {!spotQ && (
                <div style={{ display: 'flex', gap: '0.375rem', marginTop: '0.5rem' }}>
                  <button onClick={() => { setPfmInitialName(''); setShowPFM(true) }}
                    style={{ ...iBtn, flex: 1, justifyContent: 'center', gap: '0.375rem', fontSize: '0.72rem', fontWeight: 600 }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.color = '#b8c4d6' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#8494aa' }}>
                    <Package size={12} /> Prod. manual
                  </button>
                  <button onClick={() => refocusInput(0)}
                    style={{ ...iBtn, flex: 1, justifyContent: 'center', gap: '0.375rem', fontSize: '0.72rem', fontWeight: 600 }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.color = '#b8c4d6' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#8494aa' }}>
                    <Search size={12} /> Escanear
                  </button>
                </div>
              )}

              {/* Inline dropdown resultados */}
              {spotResults.length > 0 && (
                <div data-testid="comprobante-product-results" style={{
                  position: 'absolute' as const, top: 'calc(100% + 0.375rem)', left: 0, right: 0, zIndex: 200,
                  background: '#0c1a2e', border: '1px solid #263750',
                  borderRadius: '0.875rem', boxShadow: '0 16px 48px rgba(0,0,0,0.7)',
                  maxHeight: 280, overflowY: 'auto' as const, animation: 'spotlightSlide 0.12s ease',
                }}>
                  {spotResults.map((r, i) => {
                    const ss3      = stockState(r.stock_quantity)
                    const isHL     = i === spotKeyIdx || (spotKeyIdx === -1 && i === 0)
                    const prShow   = effPrice(r)
                    return (
                      <button data-testid="comprobante-product-option" key={r.id}
                        onMouseDown={() => addOrIncrement(r)}
                        onMouseEnter={() => setSpotKeyIdx(i)}
                        style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', padding: '0.625rem 1rem', background: isHL ? 'rgba(99,102,241,0.1)' : 'none', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', textAlign: 'left' as const, fontFamily: F, transition: 'background 0.08s' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: STOCK_COLORS[ss3], flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: '#f8fafc', fontSize: '0.82rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                            {r.name}{r.variant_name && <span style={{ color: '#8494aa' }}> — {r.variant_name}</span>}
                          </div>
                          <div style={{ color: '#8494aa', fontSize: '0.68rem' }}>{r.category}{r.code && ` · ${r.code}`}</div>
                        </div>
                        <div style={{ flexShrink: 0, textAlign: 'right' as const }}>
                          <div style={{ color: isHL ? '#a5b4fc' : '#818cf8', fontSize: '0.82rem', fontWeight: 700, fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{fmtARS(prShow)}</div>
                          <div style={{ fontSize: '0.65rem', color: STOCK_COLORS[ss3] }}>{r.stock_quantity} stock</div>
                        </div>
                        {isHL && <span style={{ fontSize: '0.63rem', color: '#8494aa', background: 'rgba(255,255,255,0.07)', padding: '0.1rem 0.4rem', borderRadius: '0.25rem', flexShrink: 0 }}>Enter</span>}
                      </button>
                    )
                  })}
                  <button onClick={() => { setPfmInitialName(spotQ); setShowPFM(true); setSpotResults([]); setSpotQ('') }}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', padding: '0.5rem 1rem', background: 'rgba(99,102,241,0.05)', border: 'none', borderTop: '1px solid rgba(255,255,255,0.05)', color: '#818cf8', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
                    <Plus size={12} /> Crear "{spotQ}"
                  </button>
                </div>
              )}
            </div>

            {/* PRODUCTOS RECIENTES — acceso rápido horizontal */}
            {recentProducts.length > 0 && (
              <div>
                <span style={{ fontSize: '0.62rem', fontWeight: 700, color: '#8494aa', textTransform: 'uppercase', letterSpacing: '0.07em', display: 'block', marginBottom: '0.375rem' }}>Recientes</span>
                <div style={{ display: 'flex', overflowX: 'auto', gap: '0.375rem', paddingBottom: '0.25rem' }}>
                  {recentProducts.map(p => {
                    const ss2 = stockState(p.stock_quantity)
                    return (
                      <button key={p.id} onClick={() => addOrIncrement(p)}
                        style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.75rem', background: 'rgba(255,255,255,0.03)', border: '1px solid #263750', borderRadius: '9999px', cursor: 'pointer', fontFamily: F, transition: 'all 0.15s', flexShrink: 0 }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.08)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.3)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = '#263750' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: STOCK_COLORS[ss2], flexShrink: 0 }} />
                        <span style={{ color: '#b8c4d6', fontSize: '0.75rem', maxWidth: '8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                        <span style={{ color: '#8494aa', fontSize: '0.72rem', fontWeight: 700, flexShrink: 0 }}>{fmtARS(effPrice(p))}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* ITEMS CARDS */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.625rem' }}>
                <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#8494aa', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  Ítems {filledLineas.length > 0 && `(${filledLineas.length})`}
                </span>
                {!showCartEmpty && (
                  <button onClick={() => { setManualRows(true); setLineas(p => [...p, emptyLinea()]) }}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.275rem 0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--pos-border)', borderRadius: '0.5rem', color: 'var(--pos-text-secondary)', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', fontFamily: F, transition: 'all 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.color = 'var(--pos-text-primary)'; e.currentTarget.style.borderColor = 'var(--pos-border-hover)' }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--pos-text-secondary)'; e.currentTarget.style.borderColor = 'var(--pos-border)' }}>
                    <Plus size={11} /> Agregar fila
                  </button>
                )}
              </div>

              {showCartEmpty ? (
                <div data-testid="comprobante-cart-empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '0.75rem', padding: '1.75rem 1rem', border: '1px dashed var(--pos-border)', borderRadius: '0.875rem', background: 'rgba(255,255,255,0.015)' }}>
                  <div style={{ width: 44, height: 44, borderRadius: '0.75rem', background: 'var(--pos-accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Package size={20} color="var(--pos-accent)" />
                  </div>
                  <div>
                    <div style={{ color: 'var(--pos-text-primary)', fontSize: '0.9rem', fontWeight: 700 }}>Todavía no agregaste productos</div>
                    <div style={{ color: 'var(--pos-text-secondary)', fontSize: '0.78rem', marginTop: '0.25rem', maxWidth: 300 }}>Buscá un producto, escaneá un código o agregá un servicio manual.</div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                    <button onClick={() => refocusInput(0)} className="cpm-empty-action" style={emptyAction}><Search size={12} /> Buscar / escanear</button>
                    <button onClick={() => { setPfmInitialName(''); setShowPFM(true) }} className="cpm-empty-action" style={emptyAction}><Package size={12} /> Producto manual</button>
                    <button onClick={() => { setManualRows(true); setLineas(prev => prev.map((l, i) => i === 0 ? { ...l, tipo_linea: 'servicio' as TipoLinea } : l)) }} className="cpm-empty-action" style={emptyAction}><Tag size={12} /> Servicio manual</button>
                  </div>
                </div>
              ) : (
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
              )}
            </div>

            {/* BOTTOM: condicion + arca + observaciones */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid #263750', marginTop: 'auto' }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={condicion} onChange={e => setCondicion(e.target.value)}
                  className="cpm-input16"
                  style={{ flex: 1, padding: '0.4rem 0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid #263750', borderRadius: '0.5rem', color: '#b8c4d6', fontSize: '0.78rem', cursor: 'pointer', outline: 'none', fontFamily: F }}>
                  {CONDICIONES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                {TIPO_CONFIG[tipo].fiscal && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', color: '#b8c4d6', fontSize: '0.78rem', cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={emitirEnArca} onChange={e => setEmitirEnArca(e.target.checked)} />
                    Emitir en ARCA
                  </label>
                )}
              </div>
              {/* Aviso Factura A: requiere CUIT del receptor */}
              {tipo === 'factura_a' && emitirEnArca && condicion === 'Consumidor Final' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.625rem', background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '0.375rem', fontSize: '0.72rem', color: '#f87171', fontFamily: F }}>
                  <AlertTriangle size={13} style={{ flexShrink: 0 }} />
                  <span>Factura A requiere receptor con CUIT. Cambiá la condición a Responsable Inscripto o Monotributo.</span>
                </div>
              )}
              <textarea value={observaciones} onChange={e => setObservaciones(e.target.value)}
                className="cpm-input16"
                placeholder="Observaciones..."
                rows={2}
                style={{ padding: '0.5rem 0.625rem', background: 'rgba(255,255,255,0.03)', border: '1px solid #263750', borderRadius: '0.5rem', color: '#b8c4d6', fontSize: '0.78rem', outline: 'none', resize: 'none', fontFamily: F, lineHeight: 1.4 }} />
            </div>
          </div>

          {/* ── RIGHT COLUMN ─────────────────────────────────────────────── */}
          <div className="cpm-right" id="comprobante-mobile-checkout-sheet" data-testid="comprobante-mobile-checkout-sheet" style={{ width: 400, display: 'flex', flexDirection: 'column', background: '#07101f', flexShrink: 0, position: 'relative' }}>

            {/* SHEET HEADER — solo visible en teléfono/tablet vertical (CSS lo oculta en desktop) */}
            <div className="cpm-sheet-header">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.62rem', fontWeight: 700, color: '#8494aa', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Cobro</div>
                <div style={{ color: '#f8fafc', fontSize: '1.15rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{fmtARS(totales.total)}</div>
              </div>
              <button ref={sheetCloseBtnRef} type="button" data-testid="comprobante-mobile-checkout-close" className="cpm-touch" onClick={closeSheet} aria-label="Cerrar cobro" style={iBtn}>
                <X size={18} />
              </button>
            </div>

            {/* ITEMS COMPACT */}
            {filledLineas.length > 0 && (
              <div style={{ padding: '0.875rem 1rem 0', maxHeight: '22%', overflowY: 'auto', flexShrink: 0 }}>
                <span style={{ fontSize: '0.62rem', fontWeight: 700, color: '#8494aa', textTransform: 'uppercase', letterSpacing: '0.07em', display: 'block', marginBottom: '0.375rem' }}>Resumen</span>
                {filledLineas.map(l => {
                  const sub = l.cantidad * l.precio_unitario * (1 - (l.descuento_linea || 0) / 100) * (l.currency === 'USD' ? exchangeRate : 1)
                  return (
                    <div key={l._key} style={{ display: 'flex', gap: '0.5rem', justifyContent: 'space-between', padding: '0.2rem 0', borderBottom: '1px solid rgba(255,255,255,0.03)', alignItems: 'baseline' }}>
                      <span style={{ color: '#8494aa', fontSize: '0.75rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.cantidad > 1 && <span style={{ color: '#b8c4d6', marginRight: '0.2rem', fontWeight: 700 }}>{l.cantidad}×</span>}
                        {l.descripcion}
                      </span>
                      <span style={{ color: '#b8c4d6', fontSize: '0.75rem', fontWeight: 600, flexShrink: 0 }}>{fmtARS(sub)}</span>
                    </div>
                  )
                })}
              </div>
            )}

            {/* TOTALES */}
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid #263750', flexShrink: 0 }}>
              {totales.descuento > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span style={{ color: '#8494aa', fontSize: '0.78rem' }}>Bruto</span>
                  <span style={{ color: '#8494aa', fontSize: '0.78rem' }}>{fmtARS(totales.subtotal + totales.descuento)}</span>
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
                  <span style={{ color: '#8494aa', fontSize: '0.78rem' }}>IVA 21%</span>
                  <span style={{ color: '#8494aa', fontSize: '0.78rem' }}>{fmtARS(totales.iva)}</span>
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
                  <div style={{ color: '#8494aa', fontSize: '0.78rem', fontWeight: 600 }}>Total</div>
                  {totales.costo > 0 && (
                    <div style={{ fontSize: '0.7rem', color: totales.ganancia > 0 ? '#22c55e' : '#ef4444', marginTop: '0.1rem' }}>
                      Ganancia {fmtARS(totales.ganancia)} ({totales.margenPct.toFixed(0)}%)
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div data-testid="comprobante-total" style={{ color: '#f8fafc', fontSize: '2.25rem', fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{fmtARS(totales.total)}</div>
                </div>
              </div>
            </div>

            {/* MÉTODOS DE PAGO — grid unificado con CC integrada */}
            <div style={{ padding: '0.875rem 1rem', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              <span style={{ fontSize: '0.62rem', fontWeight: 700, color: '#8494aa', textTransform: 'uppercase', letterSpacing: '0.07em' }}>¿Cómo paga?</span>

              {/* Medios primarios — chips. Efectivo/Transferencia agregan en un clic;
                  los grupos dinámicos (MercadoPago/Tarjeta) despliegan sus opciones. */}
              <div role="group" aria-label="Medios de pago" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.375rem' }}>
                {paymentGroups.map(group => {
                  const fixed = group.methods.length === 1 && (group.methods[0].id === 'efectivo' || group.methods[0].id === 'transferencia')
                  if (fixed) {
                    const m = group.methods[0]
                    const active = !!pagos.find(p => p.payment_method === m.id)
                    const Icon = m.id === 'efectivo' ? Banknote : ArrowRightLeft
                    return (
                      <button data-testid={`comprobante-payment-${m.id}`} key={group.name} onClick={() => toggleMetodo(m)} aria-pressed={active}
                        className="cpm-pay-chip"
                        style={payChip(active, m.color)} onMouseEnter={e => payHover(e, active, true)} onMouseLeave={e => payHover(e, active, false)}>
                        <Icon size={15} style={{ flexShrink: 0 }} />
                        <span style={{ flex: 1 }}>{m.label}</span>
                        {active && <Check size={13} style={{ flexShrink: 0 }} />}
                      </button>
                    )
                  }
                  const groupActive = group.methods.some(m => !!pagos.find(p => p.payment_method === 'otro' && (p as any)._option_id === m.id))
                  const expanded = expandedGroup === group.name
                  return (
                    <button key={group.name} onClick={() => setExpandedGroup(g => g === group.name ? null : group.name)}
                      aria-expanded={expanded} aria-pressed={groupActive} aria-controls={`pos-pay-group-${slugify(group.name)}`}
                      className="cpm-pay-chip"
                      style={payChip(groupActive, group.color)} onMouseEnter={e => payHover(e, groupActive, true)} onMouseLeave={e => payHover(e, groupActive, false)}>
                      <CreditCard size={15} style={{ flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>{group.name}</span>
                      <ChevronDown size={13} style={{ flexShrink: 0, transition: 'transform 0.15s', transform: expanded ? 'rotate(180deg)' : 'none' }} />
                    </button>
                  )
                })}
              </div>

              {/* Opciones del grupo seleccionado: variantes, cuotas y recargos (solo al desplegar) */}
              {paymentGroups.map(group => {
                const fixed = group.methods.length === 1 && (group.methods[0].id === 'efectivo' || group.methods[0].id === 'transferencia')
                if (fixed || expandedGroup !== group.name) return null
                return (
                  <div key={`opts-${group.name}`} id={`pos-pay-group-${slugify(group.name)}`} role="group" aria-label={`Opciones de ${group.name}`}
                    style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.3rem', padding: '0.5rem', background: 'rgba(0,0,0,0.18)', border: '1px solid var(--pos-border)', borderRadius: '0.625rem', animation: 'spotlightSlide 0.15s ease' }}>
                    {group.methods.map(m => {
                      const active = !!pagos.find(p => p.payment_method === 'otro' && (p as any)._option_id === m.id)
                      return (
                        <button data-testid={`comprobante-payment-${m.id}`} key={m.id} onClick={() => toggleMetodo(m)} aria-pressed={active}
                          className="cpm-pay-chip"
                          style={{ padding: '0.5rem 0.4rem', borderRadius: '0.5rem', border: `1px solid ${active ? (m.color || 'var(--pos-accent)') : 'var(--pos-border)'}`, background: active ? `${m.color || '#6366f1'}22` : 'rgba(255,255,255,0.02)', color: active ? (m.color || 'var(--pos-accent)') : 'var(--pos-text-secondary)', fontSize: '0.72rem', fontWeight: active ? 700 : 600, cursor: 'pointer', transition: 'all 0.15s', textAlign: 'center', fontFamily: F, lineHeight: 1.3 }}
                          onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'var(--pos-text-primary)' } }}
                          onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'rgba(255,255,255,0.02)'; e.currentTarget.style.color = 'var(--pos-text-secondary)' } }}>
                          {m.short_label || m.label}
                          {m.percentage > 0 && <div style={{ fontSize: '0.6rem', opacity: 0.85, marginTop: '0.1rem' }}>+{m.percentage}% recargo</div>}
                        </button>
                      )
                    })}
                  </div>
                )
              })}

              {/* CC — siempre presente. Sin cliente: explicación visible + acción para elegirlo. */}
              {(() => {
                const ccActive = !!pagos.find(p => p.payment_method === 'cuenta_corriente')
                const sinCliente = !clienteId
                const ccDisabled = sinCliente || totales.total <= 0
                return (
                  <div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--pos-text-muted)', marginBottom: '0.25rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Cuenta corriente cliente</div>
                    <button
                      data-testid="comprobante-payment-cuenta_corriente"
                      className="cpm-pay-chip"
                      onClick={() => {
                        if (sinCliente || totales.total <= 0) return
                        if (ccActive) {
                          setPagos(prev => prev.filter(p => p.payment_method !== 'cuenta_corriente'))
                        } else {
                          const montoCC = totales.saldo > 0 ? totales.saldo : Math.max(0, totales.total - pagos.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0))
                          const amt = Math.round(montoCC > 0 ? montoCC : totales.total)
                          if (amt <= 0) return
                          setPagos(prev => [...prev.filter(p => p.payment_method !== 'cuenta_corriente'), {
                            _key: Math.random().toString(36).slice(2), payment_method: 'cuenta_corriente' as MedioPago,
                            payment_provider: '', amount: String(amt), commission_rate: 0,
                            _option_label: 'Cta. Corriente', _color: '#818cf8', _original_amount: String(amt),
                          } as any])
                        }
                      }}
                      disabled={ccDisabled}
                      aria-pressed={ccActive}
                      style={{ ...payChip(ccActive, '#818cf8'), width: '100%', justifyContent: 'space-between', cursor: ccDisabled ? 'not-allowed' : 'pointer', opacity: ccDisabled && !ccActive ? 0.6 : 1 }}
                      onMouseEnter={e => payHover(e, ccActive || ccDisabled, true)}
                      onMouseLeave={e => payHover(e, ccActive || ccDisabled, false)}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <Wallet size={14} />
                        Cuenta Corriente
                        {ccActive && <Check size={13} />}
                      </span>
                      {!sinCliente && !ccActive && totales.saldo > 0 && (
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtARS(totales.saldo)}</span>
                      )}
                    </button>
                    {sinCliente && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.375rem', padding: '0.5rem 0.625rem', background: 'var(--pos-accent-soft)', border: '1px solid var(--pos-border)', borderRadius: '0.5rem' }}>
                        <AlertCircle size={13} color="var(--pos-accent)" style={{ flexShrink: 0 }} />
                        <span style={{ flex: 1, fontSize: '0.72rem', color: 'var(--pos-text-secondary)' }}>Seleccioná un cliente para cobrar en cuenta corriente.</span>
                        <button onClick={() => { setClienteOpen(true); clienteInputRef.current?.focus() }}
                          style={{ flexShrink: 0, fontSize: '0.72rem', fontWeight: 700, color: 'var(--pos-accent)', background: 'transparent', border: '1px solid var(--pos-border-hover)', borderRadius: '0.375rem', padding: '0.25rem 0.55rem', cursor: 'pointer', fontFamily: F }}>
                          Elegir cliente
                        </button>
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* CHIPS — todos los métodos seleccionados en un único listado */}
              {pagos.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.275rem', paddingTop: '0.375rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ fontSize: '0.6rem', color: '#8494aa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.1rem' }}>Cobros registrados</div>
                  {pagos.map(p => {
                    const color = (p as any)._color || '#818cf8'
                    const isCC = p.payment_method === 'cuenta_corriente'
                    return (
                      <div data-testid="comprobante-payment-chip" key={p._key} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.375rem 0.625rem', background: `${color}12`, border: `1px solid ${color}30`, borderRadius: '0.5rem', transition: 'border-color 0.1s' }}>
                        {isCC && <Wallet size={12} color={color} style={{ flexShrink: 0 }} />}
                        {!isCC && <div style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />}
                        <span style={{ flex: 1, fontSize: '0.775rem', color, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {(p as any)._option_label || p.payment_method}
                        </span>
                        <span style={{ color: '#8494aa', fontSize: '0.7rem' }}>$</span>
                        <input data-testid="comprobante-payment-amount" className="cpm-input16" type="number" min="0" value={p.amount}
                          aria-label={`Monto cobrado en ${(p as any)._option_label || p.payment_method}`}
                          onChange={e => setPagos(prev => prev.map(pp => pp._key === p._key ? { ...pp, amount: e.target.value } : pp))}
                          style={{ width: '5.25rem', textAlign: 'right', padding: '0.175rem 0.3rem', background: `${color}08`, border: `1px solid ${color}28`, borderRadius: '0.375rem', color: isCC ? '#a5b4fc' : '#f8fafc', fontSize: '0.82rem', fontWeight: 700, outline: 'none', fontFamily: F, fontVariantNumeric: 'tabular-nums' }} />
                        <button data-testid="comprobante-payment-remove" className="cpm-pay-remove" onClick={() => setPagos(prev => prev.filter(pp => pp._key !== p._key))}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8494aa', padding: '0.1rem', display: 'flex', alignItems: 'center', transition: 'color 0.1s' }}
                          onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                          onMouseLeave={e => e.currentTarget.style.color = '#8494aa'}>
                          <X size={12} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* ── RESUMEN FINANCIERO ── */}
              {totales.total > 0 && (pagos.length > 0 || totales.saldo > 0) && (
                <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: '0.625rem', padding: '0.625rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '0.25rem', borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: '0.1rem' }}>
                    <span style={{ fontSize: '0.75rem', color: '#8494aa', fontWeight: 600 }}>Total</span>
                    <span style={{ fontSize: '0.75rem', color: '#b8c4d6', fontWeight: 700 }}>{fmtARS(totales.total)}</span>
                  </div>
                  {totales.pagadoCaja > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '0.75rem', color: '#8494aa' }}>Pagado en caja</span>
                      <span style={{ fontSize: '0.75rem', color: '#22c55e', fontWeight: 600 }}>{fmtARS(totales.pagadoCaja)}</span>
                    </div>
                  )}
                  {totales.pagadoCC > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '0.75rem', color: '#8494aa' }}>Cuenta corriente</span>
                      <span style={{ fontSize: '0.75rem', color: '#818cf8', fontWeight: 700 }}>{fmtARS(totales.pagadoCC)}</span>
                    </div>
                  )}
                  {totales.totalRecargo > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '0.75rem', color: '#8494aa' }}>Recargo tarjeta</span>
                      <span style={{ fontSize: '0.75rem', color: '#f59e0b' }}>+{fmtARS(totales.totalRecargo)}</span>
                    </div>
                  )}
                  {totales.saldo > 0 && (
                    <div data-testid="comprobante-balance" style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '0.2rem', borderTop: '1px solid rgba(245,158,11,0.2)' }}>
                      <span style={{ fontSize: '0.78rem', color: '#f59e0b', fontWeight: 700 }}>Saldo pendiente</span>
                      <span style={{ fontSize: '0.85rem', color: '#f59e0b', fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{fmtARS(totales.saldo)}</span>
                    </div>
                  )}
                  {totales.vuelto > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '0.2rem', borderTop: '1px solid rgba(34,197,94,0.15)' }}>
                      <span style={{ fontSize: '0.82rem', color: '#22c55e', fontWeight: 700 }}>Vuelto</span>
                      <span style={{ fontSize: '1rem', color: '#22c55e', fontWeight: 900 }}>{fmtARS(totales.vuelto)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* COBRAR BUTTON */}
            <div className="cpm-cobrar-footer" style={{ padding: '0.875rem 1rem', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
              {!cajaIsOpen && !skipFinanceEntry && (
                <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.5rem', padding: '0.5rem 0.625rem', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)', borderRadius: '0.5rem' }}>
                  <AlertCircle size={13} color="#f87171" style={{ flexShrink: 0 }} />
                  <span style={{ color: '#f87171', fontSize: '0.72rem', fontWeight: 600 }}>Caja cerrada — no se pueden emitir comprobantes</span>
                </div>
              )}
              {/* Hint proactivo: por qué todavía no se puede cobrar (sin deshabilitar el botón) */}
              {(() => {
                if (submitError || (!cajaIsOpen && !skipFinanceEntry)) return null
                const hint = filledLineas.length === 0
                  ? 'Agregá al menos un producto para cobrar.'
                  : (pagos.length > 0 && pagos.every(p => (parseFloat(p.amount) || 0) <= 0) ? 'Ingresá el monto del cobro.' : null)
                if (!hint) return null
                return (
                  <div data-testid="comprobante-cobrar-hint" style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.5rem', padding: '0.5rem 0.625rem', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--pos-border)', borderRadius: '0.5rem' }}>
                    <AlertCircle size={13} color="var(--pos-text-muted)" style={{ flexShrink: 0 }} />
                    <span style={{ color: 'var(--pos-text-secondary)', fontSize: '0.72rem' }}>{hint}</span>
                  </div>
                )
              })()}
              {checkoutBlockedTitle && (
                <div data-testid="comprobante-checkout-blocked-message" key={errorShakeKey} style={{ marginBottom: '0.5rem', padding: '0.5rem 0.625rem', background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.28)', borderRadius: '0.5rem', animation: errorShakeKey > 0 ? 'shake 0.32s ease' : undefined }}>
                  <div style={{ color: '#eab308', fontSize: '0.74rem', fontWeight: 700, marginBottom: '0.125rem' }}>{checkoutBlockedTitle}</div>
                  <span style={{ color: 'var(--pos-text-secondary)', fontSize: '0.72rem' }}>{checkoutBlockedMessage}</span>
                </div>
              )}
              {submitError && (
                <div data-testid="comprobante-error-message" key={errorShakeKey} style={{ marginBottom: '0.5rem', padding: '0.5rem 0.625rem', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '0.5rem', animation: errorShakeKey > 0 ? 'shake 0.32s ease' : undefined }}>
                  <span style={{ color: '#f87171', fontSize: '0.72rem' }}>{formatDisplayMessage(submitError)}</span>
                </div>
              )}
              <button data-testid="comprobante-save-button" onClick={() => void handleSubmit()} disabled={submitting}
                style={{ width: '100%', padding: '1rem', minHeight: 56, borderRadius: 14, border: 'none', background: submitting ? 'rgba(99,102,241,0.4)' : 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontSize: '1.0625rem', fontWeight: 800, cursor: submitting ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', fontFamily: F, transition: 'all 0.15s', boxShadow: submitting ? 'none' : '0 4px 20px rgba(99,102,241,0.4)' }}
                onMouseEnter={e => { if (!submitting) { e.currentTarget.style.boxShadow = '0 6px 28px rgba(99,102,241,0.55)'; e.currentTarget.style.transform = 'translateY(-1px)' } }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = submitting ? 'none' : '0 4px 20px rgba(99,102,241,0.4)'; e.currentTarget.style.transform = '' }}
                onMouseDown={e => { if (!submitting) e.currentTarget.style.transform = 'scale(0.98)' }}
                onMouseUp={e => { e.currentTarget.style.transform = '' }}>
                {submitting ? (
                  <><RefreshCw size={16} style={{ animation: 'tr-spin 0.8s linear infinite' }} /> Procesando...</>
                ) : totales.saldo > 0 ? (
                  <><Zap size={16} /> Completar pago{' '}
                  <span style={{ transition: 'opacity 180ms ease, transform 180ms ease', display: 'inline-block' }}>
                    {fmtARS(totales.saldo)}
                  </span>{' '}
                  <span style={{ opacity: 0.55, fontSize: '0.72rem', fontWeight: 500 }}>F4</span>
                  </>
                ) : (
                  <><Zap size={16} /> {totales.total > 0 ? `Cobrar ${fmtARS(totales.total)}` : 'Cobrar'}{' '}
                  <span style={{ opacity: 0.55, fontSize: '0.72rem', fontWeight: 500 }}>F4</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* OVERLAY del bottom sheet — solo se monta con el sheet abierto (CSS lo limita a móvil/tablet vertical) */}
        {sheetOpen && (
          <div className="cpm-sheet-overlay" data-testid="comprobante-mobile-checkout-overlay" onClick={closeSheet} aria-hidden="true" />
        )}

        {/* BARRA COMPACTA — solo visible en teléfono/tablet vertical (CSS la oculta en desktop) */}
        <div className="cpm-compact-bar" data-testid="comprobante-mobile-checkout-bar">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '0.62rem', fontWeight: 700, color: '#8494aa', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Total</div>
            <div style={{ color: '#f8fafc', fontSize: '1.25rem', fontWeight: 900, fontVariantNumeric: 'tabular-nums', lineHeight: 1.05 }}>{fmtARS(totales.total)}</div>
            {totales.saldo > 0 ? (
              <div style={{ fontSize: '0.7rem', color: '#f59e0b', fontWeight: 700 }}>Saldo pendiente {fmtARS(totales.saldo)}</div>
            ) : pagos.length > 0 ? (
              <div style={{ fontSize: '0.7rem', color: '#8494aa', fontWeight: 600 }}>{pagos.length} {pagos.length === 1 ? 'cobro agregado' : 'cobros agregados'}</div>
            ) : null}
          </div>
          <button ref={openSheetBtnRef} type="button" data-testid="comprobante-mobile-checkout-open"
            onClick={openSheet} aria-expanded={sheetOpen} aria-controls="comprobante-mobile-checkout-sheet"
            style={{ flexShrink: 0, minHeight: 48, padding: '0 1.125rem', borderRadius: '0.75rem', border: 'none', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontSize: '0.95rem', fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem', fontFamily: F }}>
            <Zap size={15} /> Revisar y cobrar
          </button>
        </div>

        {/* SUCCESS OVERLAY — overlay de nivel modal (hermano de .cpm-body), independiente del
            bottom sheet: siempre visible tras un cobro real, también con F4. Única instancia. */}
        {showSuccess && (
          <div data-testid="comprobante-success-screen" style={{ position: 'absolute', inset: 0, background: '#07101f', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: '1.5rem', animation: 'spotlightSlide 0.25s ease' }}>
            {/* Icon and title change depending on whether ARCA succeeded */}
            <div style={{ width: 72, height: 72, borderRadius: '50%', background: arcaWarning ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.1)', border: `2px solid ${arcaWarning ? 'rgba(245,158,11,0.4)' : 'rgba(34,197,94,0.4)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1.25rem', animation: 'successBounce 0.4s ease' }}>
              <CheckCircle2 size={36} color={arcaWarning ? '#f59e0b' : '#22c55e'} />
            </div>
            <h3 style={{ margin: '0 0 0.25rem', color: '#f0f4ff', fontSize: '1.25rem', fontWeight: 800, textAlign: 'center' }}>
              {arcaWarning ? 'Cobro registrado' : 'Cobro exitoso'}
            </h3>
            <p style={{ margin: '0 0 1.5rem', color: 'var(--pos-text-secondary)', fontSize: '0.875rem', textAlign: 'center' }}>
              {arcaWarning
                ? 'El comprobante se guardó localmente. No se pudo emitir en ARCA.'
                : `${tc.label} emitido correctamente`}
            </p>

            <div style={{ width: '100%', background: 'rgba(255,255,255,0.04)', borderRadius: '0.875rem', padding: '1rem 1.25rem', marginBottom: '1.5rem', textAlign: 'center' }}>
              <div style={{ color: '#8494aa', fontSize: '0.78rem', marginBottom: '0.25rem' }}>Total cobrado</div>
              <div style={{ color: '#f0f4ff', fontSize: '2rem', fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{fmtARS(totales.total)}</div>
              {totales.vuelto > 0 && (
                <div style={{ marginTop: '0.5rem', padding: '0.375rem 0.75rem', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: '0.5rem', color: '#22c55e', fontSize: '0.875rem', fontWeight: 700, display: 'inline-block' }}>
                  Vuelto: {fmtARS(totales.vuelto)}
                </div>
              )}
            </div>

            {/* ARCA error/pendiente — prominent block, not just a footnote.
                El detalle técnico (DNS, timeouts, faults SOAP) solo va a logs (posLogger.error
                arriba); acá mostramos un mensaje amigable. Los rechazos fiscales legítimos de
                ARCA (ej. "ARCA rechazó el comprobante: ...") sí son accionables: se muestra
                prominente el motivo del rechazo, y los avisos informativos que AFIP concatena
                ("IMPORTANTE: ...") quedan en un detalle expandible.
                pending_reconciliation es un caso aparte: NUNCA reintentar manualmente, el
                sistema reconcilia solo en el próximo intento desde Comprobantes. */}
            {arcaWarning && (
              <div style={{
                width: '100%', padding: '0.75rem 0.875rem', borderRadius: '0.75rem', marginBottom: '1rem',
                background: arcaPending ? 'rgba(167,139,250,0.1)' : 'rgba(245,158,11,0.1)',
                border: `1px solid ${arcaPending ? 'rgba(167,139,250,0.3)' : 'rgba(245,158,11,0.3)'}`,
              }}>
                <div style={{ color: arcaPending ? '#a78bfa' : '#f59e0b', fontSize: '0.78rem', fontWeight: 700, marginBottom: '0.25rem' }}>
                  {arcaPending
                    ? ARCA_PENDING_RECONCILIATION_TITLE
                    : isArcaConnectionError(arcaWarning) ? ARCA_CONNECTION_ERROR_TITLE : 'ARCA rechazó el comprobante'}
                </div>
                <div style={{ color: 'var(--pos-text-secondary)', fontSize: '0.75rem', lineHeight: 1.4 }}>
                  {arcaPending
                    ? ARCA_PENDING_RECONCILIATION_MESSAGE
                    : isArcaConnectionError(arcaWarning) ? ARCA_CONNECTION_ERROR_MESSAGE : splitArcaRejectionMessage(arcaWarning).principal}
                </div>
                {!arcaPending && !isArcaConnectionError(arcaWarning) && splitArcaRejectionMessage(arcaWarning).detalle && (
                  <details style={{ marginTop: '0.375rem' }}>
                    <summary style={{ color: 'var(--pos-text-muted)', fontSize: '0.7rem', cursor: 'pointer' }}>Ver aviso completo de ARCA</summary>
                    <div style={{ color: 'var(--pos-text-muted)', fontSize: '0.7rem', lineHeight: 1.4, marginTop: '0.25rem' }}>
                      {splitArcaRejectionMessage(arcaWarning).detalle}
                    </div>
                  </details>
                )}
                {!arcaPending && !isArcaConnectionError(arcaWarning) && (
                  <div style={{ color: 'var(--pos-text-muted)', fontSize: '0.7rem', marginTop: '0.375rem' }}>
                    El comprobante quedó como borrador. Podés reintentarlo desde la vista del comprobante.
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button style={{ flex: 1, padding: '0.625rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.625rem', color: '#64748b', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem', fontFamily: F }}>
                  <Printer size={14} /> Imprimir
                </button>
                <button
                  data-testid="comprobante-success-whatsapp"
                  onClick={() => setShowWaModal(true)}
                  style={{ flex: 1, padding: '0.625rem', background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: '0.625rem', color: '#22c55e', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem', fontFamily: F }}>
                  <MessageCircle size={14} /> WhatsApp
                </button>
              </div>
              <button data-testid="comprobante-new-after-success" onClick={() => { onCreado?.(); onClose() }}
                style={{ width: '100%', padding: '0.75rem', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', border: 'none', borderRadius: '0.75rem', color: '#fff', fontSize: '0.9rem', fontWeight: 800, cursor: 'pointer', fontFamily: F }}>
                <Plus size={15} style={{ verticalAlign: 'middle', marginRight: '0.375rem' }} />
                Nuevo comprobante
              </button>
              <button data-testid="comprobante-close-after-success" onClick={() => { onCreado?.(); onClose() }}
                style={{ width: '100%', padding: '0.5rem', background: 'transparent', border: 'none', color: '#8494aa', fontSize: '0.78rem', cursor: 'pointer', fontFamily: F }}>
                Cerrar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>

    {/* Animations */}
    <style>{`
      @keyframes itemSlideIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes spotlightSlide { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes successBounce { 0% { transform: scale(0.5); opacity: 0; } 60% { transform: scale(1.08); } 100% { transform: scale(1); opacity: 1; } }
      @keyframes shake { 0%,100%{transform:translateX(0)} 18%{transform:translateX(-5px)} 36%{transform:translateX(5px)} 54%{transform:translateX(-3px)} 72%{transform:translateX(3px)} }
      @keyframes toastUp { from { opacity: 0; transform: translateX(-50%) translateY(8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
      @keyframes overlayIn { from { opacity: 0; transform: scale(0.96) translateY(-4px); } to { opacity: 1; transform: scale(1) translateY(0); } }
      @keyframes scanPulse { 0%{box-shadow:0 0 0 0 rgba(99,102,241,0.4)} 60%{box-shadow:0 0 0 8px rgba(99,102,241,0)} 100%{box-shadow:0 0 0 0 rgba(99,102,241,0)} }
    `}</style>

    {/* ── MICRO TOAST ──────────────────────────────────────────────────────── */}
    {toast && (
      <div style={{
        position: 'fixed', bottom: '5rem', left: '50%', transform: 'translateX(-50%)',
        zIndex: 99999, padding: '0.5rem 1.125rem', borderRadius: '9999px', pointerEvents: 'none',
        background: toast.ok ? 'rgba(22,163,74,0.96)' : 'rgba(220,38,38,0.96)',
        color: '#fff', fontSize: '0.8rem', fontWeight: 700, whiteSpace: 'nowrap' as const,
        boxShadow: `0 8px 24px ${toast.ok ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)'}`,
        animation: 'toastUp 0.18s ease',
      }}>
        {toast.msg}
      </div>
    )}

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
              autoFocus
              value={spotQ}
              onChange={e => handleSpotChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSpotKeyIdx(i => Math.min(i + 1, spotResults.length - 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSpotKeyIdx(i => Math.max(i - 1, 0)) }
                else if (e.key === 'Enter') {
                  e.preventDefault()
                  const target = spotKeyIdx >= 0 && spotResults[spotKeyIdx] ? spotResults[spotKeyIdx] : spotResults[0]
                  if (target) addOrIncrement(target)
                  else if (!spotQ && spotResults.length === 0) closeSpotlight()
                }
                else if (e.key === 'Escape') closeSpotlight()
              }}
              placeholder="Buscar por nombre, SKU, código de barras, IMEI..."
              style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#f0f4ff', fontSize: '1.0625rem', fontFamily: F, caretColor: '#818cf8' }}
            />
            {spotLoading && <Loader2 size={16} color="#475569" style={{ flexShrink: 0, animation: 'tr-spin 0.8s linear infinite' }} />}
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
                const ePr = resolveProductPricing(inv, exchangeRate)
                const priceToShow = effPrice(inv)
                const active = i === spotKeyIdx || (spotKeyIdx === -1 && i === 0)
                return (
                  <button key={inv.id}
                    onClick={() => addOrIncrement(inv)}
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
                      {esClienteMayorista && ePr.mayoristaArs && ePr.mayoristaArs !== ePr.saleArs && (
                        <div style={{ color: '#334155', fontSize: '0.7rem', textDecoration: 'line-through' }}>{fmtARS(ePr.saleArs)}</div>
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
                    <button key={p.id} onClick={() => addOrIncrement(p)}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.75rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '9999px', cursor: 'pointer', fontFamily: F, transition: 'all 0.1s' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.1)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.3)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: STOCK_COLORS[ss2], flexShrink: 0 }} />
                      <span style={{ color: '#64748b', fontSize: '0.82rem', maxWidth: '12rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}{p.variant_name ? ` — ${p.variant_name}` : ''}</span>
                      <span style={{ color: '#475569', fontSize: '0.78rem', fontWeight: 700, flexShrink: 0 }}>{fmtARS(effPrice(p))}</span>
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
        const inv: InventoryResult = { id: product.id, code: product.code ?? '', name: product.name, category: product.category ?? '', stock_quantity: product.stock_quantity, cost_price: product.cost_price, cost_price_usd: product.cost_price_usd ?? null, sale_price: product.sale_price, base_price: product.base_price ?? null, base_currency: product.base_currency ?? null, auto_update_price: product.auto_update_price ?? null, exchange_rate_used: product.exchange_rate_used ?? null, has_variants: false }
        if (pfmLineIdx !== null) selectInventoryItem(pfmLineIdx, inv)
        else addOrIncrement(inv)
        setShowPFM(false); setPfmLineIdx(null)
      }}
      initialName={pfmInitialName} registerStock={false} sourceType="manual"
    />

    {/* WhatsApp — enviar el comprobante recién cobrado sin volver a buscar al cliente */}
    <WhatsAppPreviewModal
      isOpen={showWaModal}
      onClose={() => setShowWaModal(false)}
      recipientName={selectedCliente?.name ?? 'Cliente'}
      phone={selectedCliente?.phone ?? null}
      defaultTemplateKey="comprobante_issued"
      vars={{
        nombre:             (selectedCliente?.name ?? '').split(' ')[0] || (selectedCliente?.name ?? ''),
        cliente:            selectedCliente?.name ?? '',
        tipo_comprobante:   tc?.label ?? 'Comprobante',
        numero_comprobante: comprobanteCreado?.numero_fiscal ?? comprobanteCreado?.numero ?? '',
        precio:             `$${Math.round(comprobanteCreado?.total ?? totales.total).toLocaleString('es-AR')}`,
      }}
      context={{
        comprobantId: comprobanteCreado?.id,
        customerId:   clienteId || undefined,
      }}
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
            <p style={{ margin: 0, color: '#b8c4d6', fontSize: '0.875rem' }}>Hay ítems en el comprobante. ¿Qué querés hacer?</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem 1.5rem 1.25rem' }}>
            <button onClick={() => setShowCloseConfirm(false)} style={{ width: '100%', padding: '0.625rem', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', border: 'none', borderRadius: '0.75rem', color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>Seguir editando</button>
            <button onClick={saveDraftAndClose} style={{ width: '100%', padding: '0.625rem', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.75rem', color: '#818cf8', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>Guardar borrador y cerrar</button>
            <button onClick={discardAndClose} style={{ width: '100%', padding: '0.625rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.75rem', color: '#8494aa', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>Descartar y cerrar</button>
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
            <p style={{ margin: 0, color: '#b8c4d6', fontSize: '0.875rem' }}>
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
              style={{ width: '100%', padding: '0.625rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.75rem', color: '#8494aa', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>
              Empezar de cero
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
