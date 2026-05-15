/**
 * ComprobanteProModal — POS single-screen comprobante.
 *
 * Misma lógica que ModalCrearComprobante, rediseño UX completo:
 * - dos columnas sin wizard/pasos
 * - spotlight search de productos
 * - todos los métodos de pago visibles
 * - draft persistence
 * - keyboard shortcuts
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ProductFormModalSafe as ProductFormModal } from '../products/ProductFormModal'
import type { InventoryItem as InventoryItemFull } from '../../hooks/useInventory'
import { isWholesaleCustomer, getProductPriceForCustomer } from '../../utils/pricing'
import {
  X, Search, Plus, DollarSign, Package, Wrench, Tag,
  AlertCircle, CheckCircle2, User, Loader2, ChevronDown,
  Wallet, Receipt, RefreshCw, Zap, Keyboard,
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
interface ClienteOption { id: string; name: string; cuit?: string; customer_type?: string }
interface LineaItem {
  _key: string; tipo_linea: TipoLinea; descripcion: string; inventory_id?: string | null
  cantidad: number; precio_unitario: number; descuento_linea: number
  costo_unitario: number; currency: 'ARS' | 'USD'
  inv_sale_price?: number; inv_cost_price?: number
  inv_mayorista_price?: number | null; applied_price_type?: 'minorista' | 'mayorista' | 'manual'
  no_mayorista_warning?: boolean
}
interface PagoLinea {
  _key: string; payment_method: MedioPago; payment_provider: string
  amount: string; commission_rate: number
}

// ─── Config ───────────────────────────────────────────────────────────────────

const TIPO_CONFIG: Record<TipoComprobante, { label: string; short: string; color: string; bg: string; border: string; fiscal: boolean }> = {
  factura_a:    { label: 'Factura A',       short: 'FAC A', color: '#818cf8', bg: 'rgba(99,102,241,0.12)',  border: 'rgba(99,102,241,0.4)',  fiscal: true },
  factura_c:    { label: 'Factura C',       short: 'FAC C', color: '#34d399', bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.4)',  fiscal: true },
  nota_credito: { label: 'Nota de Crédito', short: 'N.CRÉ', color: '#f87171', bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.4)',   fiscal: true },
  remito:       { label: 'Remito',          short: 'REMITO',color: '#fbbf24', bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.4)',  fiscal: false },
}
const TIPO_LINEA_ICONS: Record<TipoLinea, React.ElementType> = {
  producto: Package, repuesto: Wrench, servicio: Tag, otro: Tag,
}
const CONDICIONES = ['Consumidor Final','Responsable Inscripto','Monotributo','Exento','Responsable No Inscripto']

const emptyLinea = (): LineaItem => ({
  _key: Math.random().toString(36).slice(2),
  tipo_linea: 'producto', descripcion: '', cantidad: 1,
  precio_unitario: 0, descuento_linea: 0, costo_unitario: 0, currency: 'ARS',
})

const F = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
const fmtARS = (n: number) => '$' + Math.round(n).toLocaleString('es-AR')

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  isOpen: boolean; onClose: () => void; onCreado?: () => void
  tipoInicial?: TipoComprobante; puntoVentaInicial?: string; condicionFiscalInicial?: string
  initialItems?: { descripcion: string; cantidad: number; precio_unitario: number; currency?: 'ARS'|'USD'; inventory_id?: string; costo_unitario?: number; tipo_linea?: TipoLinea }[]
  initialClienteId?: string; usarPrecioMayorista?: boolean; skipFinanceEntry?: boolean
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ComprobanteProModal({
  isOpen, onClose, onCreado,
  tipoInicial, puntoVentaInicial, condicionFiscalInicial,
  initialItems, initialClienteId,
  usarPrecioMayorista = false, skipFinanceEntry = false,
}: Props) {
  const { businessId, user } = useAuth()
  const { isOpen: cajaIsOpen, cajaId } = useCaja()
  const { flatMethods } = usePaymentCommissions()

  // ── Encabezado ────────────────────────────────────────────────────────────
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

  // ── Ítems ─────────────────────────────────────────────────────────────────
  const [lineas, setLineas] = useState<LineaItem[]>([emptyLinea()])

  // ── Spotlight search (POS-style add product) ──────────────────────────────
  const [spotQ, setSpotQ]           = useState('')
  const [spotResults, setSpotResults] = useState<InventoryResult[]>([])
  const [spotLoading, setSpotLoading] = useState(false)
  const [spotOpen, setSpotOpen]     = useState(false)
  const spotRef   = useRef<HTMLInputElement>(null)
  const spotTimer = useRef<ReturnType<typeof setTimeout>>()

  // ── Inline line search ────────────────────────────────────────────────────
  const [activeSearchIdx, setActiveSearchIdx] = useState<number | null>(null)
  const [lineResults, setLineResults]   = useState<InventoryResult[]>([])
  const [lineSearchLoading, setLineSearchLoading] = useState(false)
  const lineTimer = useRef<ReturnType<typeof setTimeout>>()
  const dropdownRefs = useRef<(HTMLDivElement | null)[]>([])

  // ── Mayorista ────────────────────────────────────────────────────────────
  const selectedCliente = useMemo(() => clientes.find(c => c.id === clienteId) ?? null, [clientes, clienteId])
  const esClienteMayorista = useMemo(() => usarPrecioMayorista || isWholesaleCustomer(selectedCliente), [usarPrecioMayorista, selectedCliente])
  const [showRecalcPrompt, setShowRecalcPrompt] = useState(false)
  const prevClienteIdRef = useRef<string>('')

  // ── Pago ─────────────────────────────────────────────────────────────────
  const [pagos, setPagos] = useState<PagoLinea[]>([])

  // ── Submit ───────────────────────────────────────────────────────────────
  const [submitting, setSubmitting]   = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState(false)
  const [arcaWarning, setArcaWarning] = useState<string | null>(null)

  // ── Draft / close protection ──────────────────────────────────────────────
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
      const disc   = (l.descuento_linea || 0) / 100
      const raw    = l.cantidad * l.precio_unitario
      const net    = raw * (1 - disc)
      const inARS  = l.currency === 'USD' ? net * exchangeRate : net
      subtotal    += inARS
      descuento   += l.currency === 'USD' ? raw * disc * exchangeRate : raw * disc
      costo       += (l.costo_unitario || 0) * l.cantidad * (l.currency === 'USD' ? exchangeRate : 1)
    }
    iva = tipo === 'factura_a' ? subtotal * 0.21 : 0
    const total = subtotal + iva
    const totalPagado  = pagos.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
    const totalOriginal = pagos.reduce((s, p) => s + (parseFloat((p as any)._original_amount ?? p.amount) || 0), 0)
    const saldo       = Math.max(0, total - totalOriginal)
    const totalRecargo = Math.max(0, totalPagado - totalOriginal)
    const ganancia    = total - costo
    const margenPct   = total > 0 ? (ganancia / total) * 100 : 0
    return { subtotal, iva, total, descuento, costo, ganancia, margenPct, totalPagado, saldo, totalRecargo }
  }, [lineas, tipo, exchangeRate, pagos])

  // ── handleSubmit (useCallback so keyboard shortcut can reference it) ──────
  const handleSubmit = useCallback(async () => {
    const validLines = lineas.filter(l => l.descripcion.trim() && l.cantidad > 0 && l.precio_unitario >= 0)
    if (validLines.length === 0) { setSubmitError('Agregá al menos un ítem'); return }
    if (!businessId) { setSubmitError('Error: negocio no identificado'); return }
    if (!cajaIsOpen && !skipFinanceEntry) {
      setSubmitError('No hay caja abierta. Abrí caja antes de emitir comprobantes.'); return
    }
    const pagosConMonto = pagos.filter(p => parseFloat(p.amount) > 0)
    if (pagos.length > 0 && pagosConMonto.length === 0) {
      setSubmitError('Ingresá el monto del cobro o quitá el método seleccionado'); return
    }
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
    if (!result.success) {
      setSubmitError(result.error || 'Error al crear el comprobante')
      setSubmitting(false); return
    }
    if (result.arcaError) setArcaWarning(result.arcaError)

    // Limpiar draft al guardar exitosamente
    try { localStorage.removeItem(DRAFT_KEY) } catch {}
    setSubmitSuccess(true)

    if (pagosConMonto.length > 0) {
      setTimeout(() => { onCreado?.(); onClose() }, 1400)
    }
    setSubmitting(false)
  }, [lineas, businessId, cajaIsOpen, skipFinanceEntry, pagos, tipo, puntoVenta, condicion, clienteId, observaciones, exchangeRate, emitirEnArca, user, cajaId, onCreado, onClose, DRAFT_KEY])

  // ── Effects ───────────────────────────────────────────────────────────────

  // Reset al abrir
  useEffect(() => {
    if (!isOpen) return
    setTipo(tipoInicial ?? 'factura_c')
    setPuntoVenta(puntoVentaInicial ?? '0001')
    setCondicion(condicionFiscalInicial ?? 'Consumidor Final')
    setClienteId(initialClienteId ?? '')
    setClienteQuery(''); setObservaciones('')
    setEmitirEnArca(false); setSubmitError(null)
    setSubmitSuccess(false); setArcaWarning(null)
    setPagos([]); setSpotQ(''); setSpotResults([]); setSpotOpen(false)
    setActiveSearchIdx(null); setLineResults([])
    setShowCloseConfirm(false); setShowRecalcPrompt(false)

    if (initialItems && initialItems.length > 0) {
      setLineas(initialItems.map(i => ({
        _key: Math.random().toString(36).slice(2),
        tipo_linea: (i.tipo_linea ?? 'producto') as TipoLinea,
        descripcion: i.descripcion, cantidad: i.cantidad,
        precio_unitario: i.precio_unitario, descuento_linea: 0,
        costo_unitario: i.costo_unitario ?? 0,
        currency: (i.currency ?? 'ARS') as 'ARS' | 'USD',
        inventory_id: i.inventory_id,
      })))
    } else {
      setLineas([emptyLinea()])
      // Verificar draft solo si no hay ítems pre-cargados
      if (!initialClienteId) {
        try {
          const raw = localStorage.getItem(DRAFT_KEY)
          if (raw) {
            const parsed = JSON.parse(raw) as { data: object; savedAt: string }
            if (parsed?.data && (parsed.data as any).lineas?.some?.((l: LineaItem) => l.descripcion?.trim())) {
              setDraftInfo(parsed)
            }
          }
        } catch (err) {
          console.warn('[CPM_DRAFT_ERROR]', err)
          try { localStorage.removeItem(DRAFT_KEY) } catch {}
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // Auto-cargar punto de venta
  useEffect(() => {
    if (!isOpen || !businessId || puntoVentaInicial) return
    supabase.from('sales_points').select('punto_venta').eq('business_id', businessId)
      .eq('is_active', true).order('created_at', { ascending: true }).limit(1).maybeSingle()
      .then(({ data }) => { if (data?.punto_venta) setPuntoVenta(String(data.punto_venta).padStart(4, '0')) })
  }, [isOpen, businessId, puntoVentaInicial])

  // Cargar clientes
  useEffect(() => {
    if (!isOpen || !businessId) return
    supabase.from('customers').select('id, name, customer_type')
      .eq('business_id', businessId).order('name')
      .then(({ data }) => setClientes((data || []) as ClienteOption[]))
  }, [isOpen, businessId])

  // Cargar tipo de cambio
  useEffect(() => {
    if (!isOpen) return
    currencyService.getCurrentExchangeRate('USD', 'ARS')
      .then(r => setExchangeRate(r || 1)).catch(() => setExchangeRate(1))
  }, [isOpen])

  // Recalc prompt al cambiar cliente
  useEffect(() => {
    const prev = prevClienteIdRef.current
    if (!prev || prev === clienteId) { prevClienteIdRef.current = clienteId; return }
    prevClienteIdRef.current = clienteId
    if (!lineas.some(l => l.inventory_id)) return
    const wasW = isWholesaleCustomer(clientes.find(c => c.id === prev) ?? null)
    const nowW = isWholesaleCustomer(clientes.find(c => c.id === clienteId) ?? null)
    if (wasW !== nowW) setShowRecalcPrompt(true)
  }, [clienteId, clientes, lineas])

  // Cerrar dropdowns al clickear afuera
  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (clienteWrapperRef.current && !clienteWrapperRef.current.contains(e.target as Node))
        setClienteOpen(false)
      if (activeSearchIdx !== null) {
        const ref = dropdownRefs.current[activeSearchIdx]
        if (ref && !ref.contains(e.target as Node)) { setActiveSearchIdx(null); setLineResults([]) }
      }
      if (spotOpen && spotRef.current && !spotRef.current.closest('[data-spot]')?.contains(e.target as Node))
        setSpotOpen(false)
    }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [activeSearchIdx, spotOpen])

  // Auto-save draft
  useEffect(() => {
    if (!isOpen || !hasContent) return
    const t = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          data: { tipo, puntoVenta, condicion, clienteId, clienteQuery, lineas, pagos, observaciones, exchangeRate },
          savedAt: new Date().toISOString(),
        }))
      } catch {}
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
      if (e.key === 'Escape') {
        if (hasContent) setShowCloseConfirm(true); else onClose(); return
      }
      if (e.key === 'F4') { e.preventDefault(); void handleSubmit(); return }
      if (e.key === 'F2') { e.preventDefault(); clienteInputRef.current?.focus(); return }
      if (e.key === 'F5' || (e.ctrlKey && (e.key === 'b' || e.key === 'B'))) {
        e.preventDefault(); spotRef.current?.focus(); return
      }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [isOpen, hasContent, onClose, handleSubmit])

  // ── Search helpers ────────────────────────────────────────────────────────

  const runInventorySearch = useCallback(async (q: string, onResult: (r: InventoryResult[]) => void, setLoad: (v: boolean) => void) => {
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

  const handleSpotChange = (q: string) => {
    setSpotQ(q)
    clearTimeout(spotTimer.current)
    if (q.length < 2) { setSpotResults([]); setSpotOpen(false); return }
    spotTimer.current = setTimeout(() => {
      void runInventorySearch(q, (r) => { setSpotResults(r); setSpotOpen(r.length > 0 || q.length >= 2) }, setSpotLoading)
    }, 200)
  }

  const selectFromSpotlight = (inv: InventoryResult) => {
    const customer = esClienteMayorista ? { customer_type: 'mayorista' } : { customer_type: 'minorista' }
    const pr = getProductPriceForCustomer({ sale_price: inv.sale_price, precio_mayorista: inv.precio_mayorista }, customer)
    const desc = [inv.name, inv.variant_name].filter(Boolean).join(' — ') + (inv.code ? ` [${inv.code}]` : '')
    const populated: Partial<LineaItem> = {
      descripcion: desc, precio_unitario: pr.price, costo_unitario: Number(inv.cost_price) || 0,
      inventory_id: inv.id, inv_sale_price: Number(inv.sale_price),
      inv_mayorista_price: inv.precio_mayorista != null ? Number(inv.precio_mayorista) : null,
      applied_price_type: pr.priceType as 'minorista' | 'mayorista', no_mayorista_warning: pr.fallback,
    }
    setLineas(prev => {
      const emptyIdx = prev.findIndex(l => !l.descripcion.trim())
      if (emptyIdx >= 0) return prev.map((l, i) => i === emptyIdx ? { ...l, ...populated } : l)
      return [...prev, { ...emptyLinea(), ...populated }]
    })
    setSpotQ(''); setSpotResults([]); setSpotOpen(false)
    setTimeout(() => spotRef.current?.focus(), 50)
  }

  const handleLineDescChange = (idx: number, val: string) => {
    const l = lineas[idx]
    setLineas(prev => prev.map((r, i) => i === idx ? { ...r, descripcion: val, inventory_id: val !== l.descripcion ? undefined : r.inventory_id } : r))
    setActiveSearchIdx(idx)
    clearTimeout(lineTimer.current)
    lineTimer.current = setTimeout(() => {
      void runInventorySearch(val, setLineResults, setLineSearchLoading)
    }, 250)
  }

  const selectInventoryItem = (idx: number, inv: InventoryResult) => {
    const customer = esClienteMayorista ? { customer_type: 'mayorista' } : { customer_type: 'minorista' }
    const pr = getProductPriceForCustomer({ sale_price: inv.sale_price, precio_mayorista: inv.precio_mayorista }, customer)
    const desc = [inv.name, inv.variant_name].filter(Boolean).join(' — ') + (inv.code ? ` [${inv.code}]` : '')
    const l = lineas[idx]
    setLineas(prev => prev.map((r, i) => i === idx ? {
      ...r, descripcion: desc, precio_unitario: pr.price, costo_unitario: Number(inv.cost_price) || 0,
      currency: 'ARS', inventory_id: inv.id, inv_sale_price: Number(inv.sale_price),
      inv_mayorista_price: inv.precio_mayorista != null ? Number(inv.precio_mayorista) : null,
      applied_price_type: pr.priceType as 'minorista' | 'mayorista', no_mayorista_warning: pr.fallback,
    } : r))
    setActiveSearchIdx(null); setLineResults([])
  }

  // ── Payment helpers ───────────────────────────────────────────────────────

  const toggleMetodo = (metodo: FlatPaymentMethod) => {
    const pmKey = (metodo.id === 'efectivo' || metodo.id === 'transferencia') ? metodo.id as MedioPago : 'otro' as MedioPago
    const optionId = metodo.group_id ? metodo.id : null
    const exists = pagos.find(p => p.payment_method === pmKey && (p as any)._option_id === optionId)
    if (exists) {
      setPagos(prev => prev.filter(p => !((p as any)._option_id === optionId && p.payment_method === pmKey)))
    } else {
      const saldo = totales.total - pagos.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0)
      const base = Math.round(Math.max(0, saldo))
      const withSurcharge = metodo.charge_mode === 'customer' && metodo.percentage > 0
        ? Math.round(base * (1 + metodo.percentage / 100)) : base
      setPagos(prev => [...prev, {
        _key: Math.random().toString(36).slice(2),
        payment_method: pmKey, payment_provider: (metodo.group_name !== 'Efectivo' && metodo.group_name !== 'Transferencia') ? metodo.group_name : '',
        amount: String(withSurcharge), commission_rate: metodo.percentage / 100,
        _option_id: optionId, _option_label: metodo.label, _color: metodo.color,
        _original_amount: String(base),
      } as any])
    }
  }

  const handleAddCC = () => {
    const s = totales.saldo
    if (s <= 0) return
    setPagos(prev => [...prev.filter(p => p.payment_method !== 'cuenta_corriente'), {
      _key: Math.random().toString(36).slice(2),
      payment_method: 'cuenta_corriente' as MedioPago, payment_provider: '',
      amount: String(Math.round(s)), commission_rate: 0,
      _option_label: 'Cuenta Corriente', _color: '#818cf8', _original_amount: String(Math.round(s)),
    } as any])
  }

  const handleRecalcPrices = (useWholesale: boolean) => {
    setLineas(prev => prev.map(l => {
      if (!l.inventory_id) return l
      const r = getProductPriceForCustomer(l, useWholesale ? { customer_type: 'mayorista' } : { customer_type: 'minorista' })
      return { ...l, precio_unitario: r.price, applied_price_type: r.priceType as 'minorista' | 'mayorista', no_mayorista_warning: r.fallback }
    }))
    setShowRecalcPrompt(false)
  }

  // ── Close guard ───────────────────────────────────────────────────────────
  const tryClose = useCallback(() => {
    if (hasContent && !submitSuccess) setShowCloseConfirm(true); else onClose()
  }, [hasContent, submitSuccess, onClose])

  const discardAndClose = useCallback(() => {
    try { localStorage.removeItem(DRAFT_KEY) } catch {}
    setShowCloseConfirm(false); onClose()
  }, [DRAFT_KEY, onClose])

  const saveDraftAndClose = useCallback(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ data: { tipo, puntoVenta, condicion, clienteId, lineas, pagos, observaciones }, savedAt: new Date().toISOString() })) } catch {}
    setShowCloseConfirm(false); onClose()
  }, [DRAFT_KEY, tipo, puntoVenta, condicion, clienteId, lineas, pagos, observaciones, onClose])

  // ── Prod form modal ───────────────────────────────────────────────────────
  const [showPFM, setShowPFM]             = useState(false)
  const [pfmLineIdx, setPfmLineIdx]       = useState<number | null>(null)
  const [pfmInitialName, setPfmInitialName] = useState('')

  // ── Render guard ──────────────────────────────────────────────────────────
  if (!isOpen) return null

  // ── Styles ────────────────────────────────────────────────────────────────
  const tc = TIPO_CONFIG[tipo]
  const inputS: React.CSSProperties = {
    width: '100%', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem',
    color: '#f0f4ff', fontSize: '0.82rem', outline: 'none', fontFamily: F,
  }
  const inputSm: React.CSSProperties = { ...inputS, padding: '0.375rem 0.5rem', fontSize: '0.8rem' }

  // Helpers
  const filledLineas = lineas.filter(l => l.descripcion.trim())
  const vuelto = totales.totalPagado > totales.total ? totales.totalPagado - totales.total : 0

  // ── JSX ───────────────────────────────────────────────────────────────────
  return (
    <>
    {/* ── MAIN MODAL ──────────────────────────────────────────────────── */}
    <div
      onClick={e => { if (e.target === e.currentTarget) tryClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.82)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.5rem', fontFamily: F }}
    >
      <div style={{ background: '#0a1628', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '1.25rem', width: '100%', maxWidth: '1300px', height: '96vh', display: 'flex', flexDirection: 'column', boxShadow: '0 40px 100px rgba(0,0,0,0.9)', overflow: 'hidden' }}>

        {/* ── HEADER ────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 1.25rem', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0, background: '#0d1a30', flexWrap: 'wrap' }}>
          {/* Tipo selector */}
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
            {(Object.entries(TIPO_CONFIG) as [TipoComprobante, typeof tc][]).map(([k, cfg]) => (
              <button key={k} onClick={() => setTipo(k)} style={{ padding: '0.3rem 0.7rem', borderRadius: '0.5rem', border: `1px solid ${k === tipo ? cfg.border : 'rgba(255,255,255,0.08)'}`, background: k === tipo ? cfg.bg : 'transparent', color: k === tipo ? cfg.color : '#475569', fontSize: '0.75rem', fontWeight: k === tipo ? 700 : 500, cursor: 'pointer', transition: 'all 0.1s', fontFamily: F }}>
                {cfg.short}
              </button>
            ))}
          </div>

          {/* PV + TC */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginLeft: '0.5rem' }}>
            <span style={{ fontSize: '0.72rem', color: '#475569', fontWeight: 600 }}>PV</span>
            <input value={puntoVenta} onChange={e => setPuntoVenta(e.target.value)} style={{ width: '4.5rem', padding: '0.3rem 0.5rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.375rem', color: '#94a3b8', fontSize: '0.8rem', outline: 'none', textAlign: 'center', fontFamily: F }} />
            <DollarSign size={13} color="#475569" />
            <input value={exchangeRate} onChange={e => setExchangeRate(parseFloat(e.target.value) || 1)} type="number" style={{ width: '5rem', padding: '0.3rem 0.5rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.375rem', color: '#94a3b8', fontSize: '0.8rem', outline: 'none', textAlign: 'right', fontFamily: F }} />
          </div>

          {/* Shortcuts hint */}
          <span style={{ fontSize: '0.65rem', color: '#1e3a5f', marginLeft: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <Keyboard size={11} /> F4 cobrar · F2 cliente · Ctrl+B producto · Esc cerrar
          </span>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {submitSuccess && <span style={{ fontSize: '0.75rem', color: '#22c55e', display: 'flex', alignItems: 'center', gap: '0.25rem' }}><CheckCircle2 size={14} /> Creado</span>}
            <button onClick={tryClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem', display: 'flex', alignItems: 'center' }}>
              <X size={18} />
            </button>
          </div>
        </div>

        {/* ── BODY: 2 COLUMNS ───────────────────────────────────────────── */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* ── LEFT COLUMN ─────────────────────────────────────────────── */}
          <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.875rem', borderRight: '1px solid rgba(255,255,255,0.06)' }}>

            {/* CLIENTE */}
            <div ref={clienteWrapperRef} style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                <User size={13} color="#475569" />
                <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Cliente</span>
                {esClienteMayorista && (
                  <span style={{ fontSize: '0.62rem', fontWeight: 800, padding: '0.1rem 0.4rem', borderRadius: '9999px', background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }}>MAYORISTA</span>
                )}
                {clienteId && (
                  <button onClick={() => { setClienteId(''); setClienteQuery('') }} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.2rem', fontFamily: F }}>
                    <X size={11} /> Quitar
                  </button>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <User size={13} style={{ position: 'absolute', left: '0.625rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                <input
                  ref={clienteInputRef}
                  style={{ ...inputS, paddingLeft: '2rem' }}
                  placeholder="Buscar cliente por nombre... (F2)"
                  value={clienteQuery}
                  onChange={e => { setClienteQuery(e.target.value); setClienteOpen(true); if (!e.target.value) setClienteId('') }}
                  onFocus={() => setClienteOpen(true)}
                />
              </div>
              {clienteOpen && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200, background: '#0d1a30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.625rem', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', maxHeight: 220, overflowY: 'auto', marginTop: '0.2rem' }}>
                  {clientes
                    .filter(c => !clienteQuery || c.name.toLowerCase().includes(clienteQuery.toLowerCase()))
                    .slice(0, 20)
                    .map(c => (
                      <button key={c.id} onMouseDown={() => { setClienteId(c.id); setClienteQuery(c.name); setClienteOpen(false) }}
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0.5rem 0.875rem', background: c.id === clienteId ? 'rgba(99,102,241,0.12)' : 'none', border: 'none', cursor: 'pointer', color: '#f0f4ff', fontSize: '0.83rem', textAlign: 'left', fontFamily: F }}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                        onMouseLeave={e => e.currentTarget.style.background = c.id === clienteId ? 'rgba(99,102,241,0.12)' : 'none'}>
                        <span>{c.name}</span>
                        {c.customer_type === 'mayorista' && <span style={{ fontSize: '0.62rem', color: '#818cf8', fontWeight: 700 }}>MAYORISTA</span>}
                      </button>
                    ))
                  }
                  {clientes.filter(c => !clienteQuery || c.name.toLowerCase().includes(clienteQuery.toLowerCase())).length === 0 && (
                    <div style={{ padding: '0.75rem', color: '#475569', fontSize: '0.8rem' }}>Sin resultados</div>
                  )}
                </div>
              )}
              {/* Recalc prompt */}
              {showRecalcPrompt && (
                <div style={{ marginTop: '0.5rem', padding: '0.625rem 0.875rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.78rem', color: '#f59e0b', flex: 1 }}>Cambiaste el tipo de cliente. ¿Recalcular precios?</span>
                  <button onClick={() => handleRecalcPrices(esClienteMayorista)} style={{ padding: '0.25rem 0.75rem', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: '0.375rem', color: '#f59e0b', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}>Recalcular</button>
                  <button onClick={() => setShowRecalcPrompt(false)} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '0.75rem', fontFamily: F }}>No</button>
                </div>
              )}
            </div>

            {/* SPOTLIGHT PRODUCT SEARCH */}
            <div data-spot="1">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                <Search size={13} color="#475569" />
                <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Agregar producto (Ctrl+B)</span>
              </div>
              <div style={{ position: 'relative' }}>
                <Search size={16} style={{ position: 'absolute', left: '0.875rem', top: '50%', transform: 'translateY(-50%)', color: '#334155', pointerEvents: 'none' }} />
                {spotLoading && <Loader2 size={14} style={{ position: 'absolute', right: '0.875rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', animation: 'spin 0.8s linear infinite' }} />}
                <input
                  ref={spotRef}
                  value={spotQ}
                  onChange={e => handleSpotChange(e.target.value)}
                  onFocus={() => spotQ.length >= 2 && setSpotOpen(true)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && spotResults.length > 0) { e.preventDefault(); selectFromSpotlight(spotResults[0]) }
                    if (e.key === 'Escape') { setSpotQ(''); setSpotResults([]); setSpotOpen(false) }
                  }}
                  placeholder="Buscar por nombre, SKU, código de barras... Enter para agregar primero"
                  style={{ ...inputS, paddingLeft: '2.5rem', paddingRight: '2.5rem', fontSize: '0.9rem', padding: '0.75rem 2.5rem 0.75rem 2.5rem', border: `1px solid rgba(255,255,255,${spotQ ? '0.15' : '0.08'})`, background: spotQ ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)' }}
                />
                {spotOpen && spotQ.length >= 2 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200, background: '#0d1a30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.75rem', boxShadow: '0 12px 40px rgba(0,0,0,0.6)', overflow: 'hidden', marginTop: '0.25rem' }}>
                    {spotResults.length === 0 && !spotLoading && (
                      <div style={{ padding: '0.875rem 1rem', color: '#334155', fontSize: '0.82rem' }}>
                        Sin resultados para "{spotQ}"
                        <button onMouseDown={() => { setPfmInitialName(spotQ); setShowPFM(true); setSpotOpen(false) }}
                          style={{ marginLeft: '0.75rem', color: '#818cf8', fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.82rem', fontFamily: F }}>
                          + Crear producto completo
                        </button>
                      </div>
                    )}
                    {spotResults.map((inv, i) => (
                      <button key={inv.id} onMouseDown={() => selectFromSpotlight(inv)}
                        style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', padding: '0.625rem 1rem', background: i === 0 ? 'rgba(99,102,241,0.06)' : 'none', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', textAlign: 'left', fontFamily: F }}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.1)'}
                        onMouseLeave={e => e.currentTarget.style.background = i === 0 ? 'rgba(99,102,241,0.06)' : 'none'}>
                        <Package size={14} color="#475569" style={{ flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: '#f0f4ff', fontSize: '0.85rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {inv.name}{inv.variant_name ? ` — ${inv.variant_name}` : ''}
                          </div>
                          {inv.code && <div style={{ color: '#334155', fontSize: '0.72rem' }}>#{inv.code} · {inv.category}</div>}
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ color: '#818cf8', fontWeight: 700, fontSize: '0.875rem' }}>{fmtARS(esClienteMayorista && inv.precio_mayorista ? inv.precio_mayorista : inv.sale_price)}</div>
                          <div style={{ color: inv.stock_quantity > 0 ? '#22c55e' : '#ef4444', fontSize: '0.7rem' }}>
                            {inv.stock_quantity > 0 ? `${inv.stock_quantity} stock` : 'Sin stock'}
                          </div>
                        </div>
                        {i === 0 && <span style={{ fontSize: '0.62rem', color: '#475569', background: 'rgba(255,255,255,0.05)', padding: '0.1rem 0.35rem', borderRadius: '0.25rem', flexShrink: 0 }}>Enter</span>}
                      </button>
                    ))}
                    {spotResults.length > 0 && (
                      <button onMouseDown={() => { setPfmInitialName(spotQ); setShowPFM(true); setSpotOpen(false) }}
                        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', padding: '0.5rem 1rem', background: 'rgba(99,102,241,0.06)', border: 'none', borderTop: '1px solid rgba(255,255,255,0.06)', color: '#818cf8', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
                        <Plus size={12} /> Crear producto completo: "{spotQ}"
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ITEMS TABLE */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Ítems ({lineas.length})</span>
                <button onClick={() => setLineas(p => [...p, emptyLinea()])} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.25rem 0.625rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.375rem', color: '#64748b', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                  <Plus size={11} /> Agregar fila
                </button>
              </div>

              {/* Header row */}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 28px', gap: '0.25rem', padding: '0 0.25rem 0.3rem', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: '0.375rem' }}>
                {['Descripción','Cant.','Precio','Desc.%','Subtotal',''].map(h => (
                  <span key={h} style={{ fontSize: '0.62rem', color: '#334155', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: h === 'Cant.' || h === 'Precio' || h === 'Desc.%' || h === 'Subtotal' ? 'right' : 'left' }}>{h}</span>
                ))}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                {lineas.map((l, idx) => {
                  const LineIcon = TIPO_LINEA_ICONS[l.tipo_linea]
                  const subtotalLine = l.cantidad * l.precio_unitario * (1 - (l.descuento_linea || 0) / 100) * (l.currency === 'USD' ? exchangeRate : 1)
                  return (
                    <div key={l._key} style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.06)', overflow: 'visible' }}>
                      {/* Main row */}
                      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 28px', gap: '0.25rem', padding: '0.375rem 0.375rem', alignItems: 'center' }}>
                        {/* Description */}
                        <div ref={el => { dropdownRefs.current[idx] = el }} style={{ position: 'relative' }}>
                          <input
                            style={{ ...inputSm, paddingLeft: '0.5rem', background: 'transparent', border: '1px solid transparent' }}
                            value={l.descripcion}
                            onChange={e => handleLineDescChange(idx, e.target.value)}
                            onFocus={() => { if (lineResults.length > 0 && l.descripcion.trim()) setActiveSearchIdx(idx) }}
                            placeholder={`Ítem ${idx + 1}...`}
                          />
                          {/* Inline search dropdown */}
                          {activeSearchIdx === idx && (lineResults.length > 0 || lineSearchLoading) && (
                            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 300, background: '#0d1a30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', overflow: 'hidden', marginTop: '0.15rem' }}>
                              {lineSearchLoading ? (
                                <div style={{ padding: '0.5rem 0.75rem', color: '#475569', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}><Loader2 size={12} style={{ animation: 'spin 0.8s linear infinite' }} /> Buscando...</div>
                              ) : lineResults.map(inv => (
                                <button key={inv.id} onMouseDown={() => selectInventoryItem(idx, inv)}
                                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0.5rem 0.75rem', background: 'none', border: 'none', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.04)', textAlign: 'left', fontFamily: F }}
                                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                                  onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                                  <span style={{ color: '#f0f4ff', fontSize: '0.8rem' }}>{inv.name}{inv.variant_name ? ` — ${inv.variant_name}` : ''}</span>
                                  <span style={{ color: '#818cf8', fontSize: '0.78rem', fontWeight: 700 }}>{fmtARS(esClienteMayorista && inv.precio_mayorista ? inv.precio_mayorista : inv.sale_price)}</span>
                                </button>
                              ))}
                              <button onMouseDown={() => { setPfmInitialName(l.descripcion); setPfmLineIdx(idx); setShowPFM(true); setActiveSearchIdx(null); setLineResults([]) }}
                                style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', width: '100%', padding: '0.4rem 0.75rem', background: 'rgba(99,102,241,0.06)', border: 'none', color: '#818cf8', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
                                <Plus size={11} /> Crear producto completo
                              </button>
                            </div>
                          )}
                        </div>
                        {/* Cantidad */}
                        <input type="number" min="0.01" step="1" value={l.cantidad}
                          onChange={e => setLineas(prev => prev.map((r, i) => i === idx ? { ...r, cantidad: parseFloat(e.target.value) || 1 } : r))}
                          style={{ ...inputSm, textAlign: 'right' }} />
                        {/* Precio */}
                        <input type="number" min="0" value={l.precio_unitario}
                          onChange={e => setLineas(prev => prev.map((r, i) => i === idx ? { ...r, precio_unitario: parseFloat(e.target.value) || 0, applied_price_type: 'manual' } : r))}
                          style={{ ...inputSm, textAlign: 'right' }} />
                        {/* Descuento */}
                        <input type="number" min="0" max="100" value={l.descuento_linea || ''}
                          onChange={e => setLineas(prev => prev.map((r, i) => i === idx ? { ...r, descuento_linea: parseFloat(e.target.value) || 0 } : r))}
                          placeholder="0"
                          style={{ ...inputSm, textAlign: 'right' }} />
                        {/* Subtotal */}
                        <span style={{ color: '#f0f4ff', fontSize: '0.8rem', fontWeight: 600, textAlign: 'right', paddingRight: '0.25rem' }}>{fmtARS(subtotalLine)}</span>
                        {/* Delete */}
                        <button onClick={() => lineas.length > 1 && setLineas(p => p.filter(r => r._key !== l._key))}
                          disabled={lineas.length === 1}
                          style={{ background: 'none', border: 'none', cursor: lineas.length === 1 ? 'not-allowed' : 'pointer', color: '#ef4444', opacity: lineas.length === 1 ? 0.2 : 0.6, padding: '0.2rem', display: 'flex', alignItems: 'center' }}>
                          <X size={13} />
                        </button>
                      </div>
                      {/* Badges row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0 0.375rem 0.3rem', flexWrap: 'wrap' }}>
                        {/* Tipo select */}
                        <select value={l.tipo_linea} onChange={e => setLineas(prev => prev.map((r, i) => i === idx ? { ...r, tipo_linea: e.target.value as TipoLinea } : r))}
                          style={{ padding: '0.15rem 0.4rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.375rem', color: '#475569', fontSize: '0.68rem', cursor: 'pointer', outline: 'none', fontFamily: F }}>
                          {(['producto','repuesto','servicio','otro'] as TipoLinea[]).map(t => (
                            <option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>
                          ))}
                        </select>
                        {/* Currency toggle */}
                        <button onClick={() => setLineas(prev => prev.map((r, i) => i === idx ? { ...r, currency: r.currency === 'ARS' ? 'USD' : 'ARS' } : r))}
                          style={{ padding: '0.15rem 0.4rem', background: l.currency === 'USD' ? 'rgba(34,197,94,0.1)' : 'rgba(255,255,255,0.04)', border: `1px solid ${l.currency === 'USD' ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '0.375rem', color: l.currency === 'USD' ? '#22c55e' : '#475569', fontSize: '0.68rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
                          {l.currency}
                        </button>
                        {l.applied_price_type === 'mayorista' && <span style={{ fontSize: '0.62rem', color: '#818cf8', background: 'rgba(99,102,241,0.1)', padding: '0.1rem 0.35rem', borderRadius: '0.25rem' }}>Mayorista</span>}
                        {l.no_mayorista_warning && <span style={{ fontSize: '0.62rem', color: '#f59e0b' }}>⚠ Sin precio mayorista</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* CONDICION + ARCA + OBSERVACIONES */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingTop: '0.25rem', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={condicion} onChange={e => setCondicion(e.target.value)} style={{ ...inputSm, width: 'auto', flex: 1 }}>
                  {CONDICIONES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                {TIPO_CONFIG[tipo].fiscal && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', color: '#64748b', fontSize: '0.78rem', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: F }}>
                    <input type="checkbox" checked={emitirEnArca} onChange={e => setEmitirEnArca(e.target.checked)} style={{ cursor: 'pointer' }} />
                    Emitir en ARCA
                  </label>
                )}
              </div>
              <textarea value={observaciones} onChange={e => setObservaciones(e.target.value)}
                placeholder="Observaciones (opcional)..."
                rows={2}
                style={{ ...inputS, resize: 'vertical', fontSize: '0.78rem', minHeight: 44 }} />
            </div>

          </div>

          {/* ── RIGHT COLUMN ─────────────────────────────────────────────── */}
          <div style={{ width: 380, display: 'flex', flexDirection: 'column', background: '#080f1c', flexShrink: 0 }}>

            {/* RESUMEN ÍTEMS */}
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)', overflowY: 'auto', maxHeight: '25%' }}>
              <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#1e3a5f', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: '0.375rem' }}>Resumen</span>
              {filledLineas.length === 0 ? (
                <div style={{ color: '#1e3a5f', fontSize: '0.78rem', textAlign: 'center', padding: '0.75rem 0' }}>Sin ítems todavía</div>
              ) : filledLineas.map(l => {
                const sub = l.cantidad * l.precio_unitario * (1 - (l.descuento_linea || 0) / 100) * (l.currency === 'USD' ? exchangeRate : 1)
                return (
                  <div key={l._key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.25rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)', alignItems: 'baseline' }}>
                    <span style={{ color: '#64748b', fontSize: '0.78rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {l.cantidad > 1 && <span style={{ color: '#475569', marginRight: '0.25rem' }}>{l.cantidad}×</span>}
                      {l.descripcion}
                    </span>
                    <span style={{ color: '#94a3b8', fontSize: '0.78rem', fontWeight: 600, flexShrink: 0 }}>{fmtARS(sub)}</span>
                  </div>
                )
              })}
            </div>

            {/* TOTALES */}
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
              {totales.descuento > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span style={{ color: '#475569', fontSize: '0.78rem' }}>Subtotal</span>
                  <span style={{ color: '#475569', fontSize: '0.78rem' }}>{fmtARS(totales.subtotal + totales.descuento)}</span>
                </div>
              )}
              {totales.descuento > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span style={{ color: '#22c55e', fontSize: '0.78rem' }}>Descuentos</span>
                  <span style={{ color: '#22c55e', fontSize: '0.78rem' }}>-{fmtARS(totales.descuento)}</span>
                </div>
              )}
              {totales.iva > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span style={{ color: '#475569', fontSize: '0.78rem' }}>IVA 21%</span>
                  <span style={{ color: '#475569', fontSize: '0.78rem' }}>{fmtARS(totales.iva)}</span>
                </div>
              )}
              {totales.totalRecargo > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span style={{ color: '#f59e0b', fontSize: '0.78rem' }}>Recargo tarjeta</span>
                  <span style={{ color: '#f59e0b', fontSize: '0.78rem' }}>+{fmtARS(totales.totalRecargo)}</span>
                </div>
              )}
              {/* TOTAL GRANDE */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '0.375rem', paddingTop: '0.375rem', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                <span style={{ color: '#94a3b8', fontSize: '0.875rem', fontWeight: 600 }}>Total</span>
                <span style={{ color: '#f0f4ff', fontSize: '1.9rem', fontWeight: 900, letterSpacing: '-0.03em' }}>{fmtARS(totales.total)}</span>
              </div>
              {/* Ganancia estimada */}
              {totales.costo > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem' }}>
                  <span style={{ color: '#1e3a5f', fontSize: '0.72rem' }}>Ganancia est.</span>
                  <span style={{ color: totales.ganancia > 0 ? '#22c55e' : '#ef4444', fontSize: '0.72rem', fontWeight: 600 }}>
                    {fmtARS(totales.ganancia)} ({totales.margenPct.toFixed(0)}%)
                  </span>
                </div>
              )}
            </div>

            {/* MÉTODOS DE PAGO */}
            <div style={{ padding: '0.875rem 1rem', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#1e3a5f', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Método de cobro</span>

              {/* Método buttons grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.3rem' }}>
                {flatMethods.map(m => {
                  const optionId = m.group_id ? m.id : null
                  const pmKey = (m.id === 'efectivo' || m.id === 'transferencia') ? m.id : 'otro'
                  const active = !!pagos.find(p => p.payment_method === pmKey && (p as any)._option_id === optionId)
                  return (
                    <button key={m.id} onClick={() => toggleMetodo(m)}
                      style={{ padding: '0.4rem 0.25rem', borderRadius: '0.5rem', border: `1px solid ${active ? (m.color || 'rgba(99,102,241,0.5)') : 'rgba(255,255,255,0.07)'}`, background: active ? `${m.color}22` : 'rgba(255,255,255,0.02)', color: active ? m.color || '#818cf8' : '#475569', fontSize: '0.7rem', fontWeight: active ? 700 : 500, cursor: 'pointer', transition: 'all 0.1s', textAlign: 'center', fontFamily: F, lineHeight: 1.2 }}>
                      {m.short_label || m.label}
                      {m.percentage > 0 && <span style={{ display: 'block', fontSize: '0.6rem', opacity: 0.7 }}>+{m.percentage}%</span>}
                    </button>
                  )
                })}
              </div>

              {/* Payment lines */}
              {pagos.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  {pagos.map(p => (
                    <div key={p._key} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.5rem', background: 'rgba(255,255,255,0.03)', borderRadius: '0.5rem', border: `1px solid ${(p as any)._color || 'rgba(255,255,255,0.07)'}33` }}>
                      <span style={{ flex: 1, fontSize: '0.78rem', color: (p as any)._color || '#94a3b8', fontWeight: 600 }}>
                        {(p as any)._option_label || p.payment_method}
                      </span>
                      <span style={{ color: '#334155', fontSize: '0.72rem' }}>$</span>
                      <input type="number" min="0" value={p.amount}
                        onChange={e => setPagos(prev => prev.map(pp => pp._key === p._key ? { ...pp, amount: e.target.value } : pp))}
                        style={{ width: '5.5rem', textAlign: 'right', padding: '0.25rem 0.4rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.375rem', color: '#f0f4ff', fontSize: '0.8rem', fontWeight: 700, outline: 'none', fontFamily: F }} />
                      <button onClick={() => setPagos(prev => prev.filter(pp => pp._key !== p._key))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.15rem', display: 'flex', alignItems: 'center' }}>
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* CC + Saldo / Vuelto */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {clienteId && totales.saldo > 0 && !pagos.find(p => p.payment_method === 'cuenta_corriente') && (
                  <button onClick={handleAddCC}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.4rem 0.625rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '0.5rem', color: '#818cf8', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                    <span><Wallet size={12} style={{ marginRight: '0.25rem', verticalAlign: 'middle' }} />Enviar a cuenta corriente</span>
                    <span>{fmtARS(totales.saldo)}</span>
                  </button>
                )}
                {pagos.length > 0 && (
                  <div style={{ padding: '0.5rem 0.25rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    {totales.saldo > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: '0.78rem', color: '#f59e0b', fontWeight: 600 }}>Saldo pendiente</span>
                        <span style={{ fontSize: '0.78rem', color: '#f59e0b', fontWeight: 700 }}>{fmtARS(totales.saldo)}</span>
                      </div>
                    )}
                    {vuelto > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: '0.78rem', color: '#22c55e', fontWeight: 600 }}>Vuelto</span>
                        <span style={{ fontSize: '0.78rem', color: '#22c55e', fontWeight: 800 }}>{fmtARS(vuelto)}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* FOOTER: COBRAR */}
            <div style={{ padding: '0.875rem 1rem', borderTop: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
              {!cajaIsOpen && !skipFinanceEntry && (
                <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.5rem', padding: '0.5rem 0.625rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '0.5rem' }}>
                  <AlertCircle size={13} color="#f87171" style={{ flexShrink: 0 }} />
                  <span style={{ color: '#f87171', fontSize: '0.72rem', fontWeight: 600 }}>Caja cerrada</span>
                </div>
              )}
              {arcaWarning && (
                <div style={{ marginBottom: '0.5rem', padding: '0.5rem 0.625rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '0.5rem' }}>
                  <span style={{ color: '#f59e0b', fontSize: '0.72rem' }}>{arcaWarning}</span>
                </div>
              )}
              {submitError && (
                <div style={{ marginBottom: '0.5rem', padding: '0.5rem 0.625rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '0.5rem' }}>
                  <span style={{ color: '#f87171', fontSize: '0.72rem' }}>{formatDisplayMessage(submitError)}</span>
                </div>
              )}
              <button
                onClick={() => void handleSubmit()}
                disabled={submitting || submitSuccess}
                style={{
                  width: '100%', padding: '0.875rem 1rem', borderRadius: '0.75rem', border: 'none',
                  background: submitSuccess ? 'rgba(34,197,94,0.15)' : submitting ? 'rgba(99,102,241,0.4)' : 'linear-gradient(135deg,#6366f1,#4f46e5)',
                  color: submitSuccess ? '#22c55e' : '#fff', fontSize: '1rem', fontWeight: 800,
                  cursor: submitting || submitSuccess ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', fontFamily: F,
                  transition: 'all 0.15s',
                }}
              >
                {submitting ? (
                  <><RefreshCw size={16} style={{ animation: 'spin 0.8s linear infinite' }} /> Procesando...</>
                ) : submitSuccess ? (
                  <><CheckCircle2 size={16} /> Comprobante creado</>
                ) : (
                  <><Zap size={16} /> Cobrar {totales.total > 0 ? fmtARS(totales.total) : ''} <span style={{ opacity: 0.6, fontSize: '0.72rem', fontWeight: 500 }}>F4</span></>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>

    {/* ── ProductFormModal ──────────────────────────────────────────────── */}
    <ProductFormModal
      isOpen={showPFM}
      onClose={() => { setShowPFM(false); setPfmLineIdx(null) }}
      onCreated={(product: InventoryItemFull) => {
        if (pfmLineIdx !== null) {
          selectInventoryItem(pfmLineIdx, {
            id: product.id, code: product.code ?? '', name: product.name,
            variant_name: undefined, category: product.category ?? '',
            stock_quantity: product.stock_quantity, cost_price: product.cost_price,
            sale_price: product.sale_price, has_variants: false,
          })
        } else {
          // Viene del spotlight: agregar como nueva línea
          const pr = getProductPriceForCustomer({ sale_price: product.sale_price, precio_mayorista: (product as any).wholesale_price_ars ?? null }, esClienteMayorista ? { customer_type: 'mayorista' } : { customer_type: 'minorista' })
          setLineas(prev => {
            const emptyIdx = prev.findIndex(l => !l.descripcion.trim())
            const newL: Partial<LineaItem> = { descripcion: product.name, precio_unitario: pr.price, costo_unitario: product.cost_price, inventory_id: product.id, applied_price_type: pr.priceType as 'minorista' | 'mayorista' }
            if (emptyIdx >= 0) return prev.map((l, i) => i === emptyIdx ? { ...l, ...newL } : l)
            return [...prev, { ...emptyLinea(), ...newL }]
          })
        }
        setShowPFM(false); setPfmLineIdx(null)
      }}
      initialName={pfmInitialName}
      registerStock={false}
      sourceType="manual"
    />

    {/* ── CLOSE CONFIRM ────────────────────────────────────────────────── */}
    {showCloseConfirm && (
      <div style={{ position: 'fixed', inset: 0, zIndex: 10001, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', fontFamily: F }}>
        <div style={{ background: '#0d1a30', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '1rem', width: '100%', maxWidth: '380px', overflow: 'hidden' }}>
          <div style={{ padding: '1.5rem 1.5rem 1rem' }}>
            <div style={{ width: 40, height: 40, borderRadius: '0.75rem', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem' }}>
              <AlertCircle size={20} color="#f59e0b" />
            </div>
            <h3 style={{ margin: '0 0 0.375rem', color: '#f1f5f9', fontSize: '1rem', fontWeight: 800 }}>Cambios sin guardar</h3>
            <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem' }}>Hay ítems en el comprobante que se perderán si cerrás.</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem 1.5rem 1.25rem' }}>
            <button onClick={() => setShowCloseConfirm(false)} style={{ width: '100%', padding: '0.625rem', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', border: 'none', borderRadius: '0.75rem', color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>
              Seguir editando
            </button>
            <button onClick={saveDraftAndClose} style={{ width: '100%', padding: '0.625rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '0.75rem', color: '#818cf8', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>
              Guardar borrador y cerrar
            </button>
            <button onClick={discardAndClose} style={{ width: '100%', padding: '0.625rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.75rem', color: '#475569', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>
              Descartar y cerrar
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── DRAFT RESTORE ────────────────────────────────────────────────── */}
    {draftInfo && (
      <div style={{ position: 'fixed', inset: 0, zIndex: 10001, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', fontFamily: F }}>
        <div style={{ background: '#0d1a30', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '1rem', width: '100%', maxWidth: '380px', overflow: 'hidden' }}>
          <div style={{ padding: '1.5rem 1.5rem 1rem' }}>
            <div style={{ width: 40, height: 40, borderRadius: '0.75rem', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem' }}>
              <CheckCircle2 size={20} color="#22c55e" />
            </div>
            <h3 style={{ margin: '0 0 0.375rem', color: '#f1f5f9', fontSize: '1rem', fontWeight: 800 }}>Borrador encontrado</h3>
            <p style={{ margin: 0, color: '#64748b', fontSize: '0.875rem' }}>
              Hay un comprobante sin finalizar guardado
              {draftInfo.savedAt ? ` (${new Date(draftInfo.savedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })})` : ''}.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem 1.5rem 1.25rem' }}>
            <button onClick={() => {
              const d = draftInfo.data as any
              if (d.tipo) setTipo(d.tipo)
              if (d.puntoVenta) setPuntoVenta(d.puntoVenta)
              if (d.condicion) setCondicion(d.condicion)
              if (d.clienteId) { setClienteId(d.clienteId); setClienteQuery(d.clienteQuery || '') }
              if (d.lineas) setLineas(d.lineas)
              if (d.pagos) setPagos(d.pagos)
              if (d.observaciones) setObservaciones(d.observaciones)
              setDraftInfo(null)
            }} style={{ width: '100%', padding: '0.625rem', background: 'linear-gradient(135deg,#6366f1,#4f46e5)', border: 'none', borderRadius: '0.75rem', color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>
              Restaurar borrador
            </button>
            <button onClick={() => { try { localStorage.removeItem(DRAFT_KEY) } catch {} setDraftInfo(null) }}
              style={{ width: '100%', padding: '0.625rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.75rem', color: '#475569', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>
              Empezar de cero
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
