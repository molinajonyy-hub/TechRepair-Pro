import {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import {
  X, FileText, Receipt, ChevronDown,
  Loader2, Plus, Zap, Package, Search, DollarSign,
  Wrench, Tag, Percent,
  AlertCircle, CheckCircle2,
  ChevronLeft, ChevronRight, Wallet,
} from 'lucide-react';
import { CloseButton } from '../ui/CloseButton';
import { currencyService } from '../../services/currencyService';
import { smartSearch, buildSupabaseQuery, highlightParts } from '../../utils/searchUtils';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import {
  comprobanteService,
  TipoComprobante, TipoLinea, MedioPago,
  ComprobantePago, CrearComprobanteInput,
} from '../../services/comprobanteService';
import { MpPaymentModal } from '../payments/MpPaymentModal';
import { usePaymentCommissions, type FlatPaymentMethod } from '../../hooks/usePaymentCommissions';

// ─── Sub-types ────────────────────────────────────────────────────────────────

interface InventoryResult {
  id: string;
  code: string;
  name: string;
  variant_name?: string | null;
  category: string;
  stock_quantity: number;
  cost_price: number;
  sale_price: number;
  precio_mayorista?: number | null;
  base_price?: number | null;
  base_currency?: string | null;
  has_variants?: boolean | null;
}

interface ClienteOption { id: string; name: string; cuit?: string; customer_type?: string }

interface LineaItem {
  _key: string;
  tipo_linea: TipoLinea;
  descripcion: string;
  inventory_id?: string | null;
  cantidad: number;
  precio_unitario: number;
  descuento_linea: number;     // %
  costo_unitario: number;
  currency: 'ARS' | 'USD';
  inv_sale_price?: number;
  inv_cost_price?: number;
  inv_price_usd?: number | null;
  inv_mayorista_price?: number | null;
}

interface PagoLinea {
  _key: string;
  payment_method: MedioPago;
  payment_provider: string;
  amount: string;
  commission_rate: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const TIPO_CONFIG: Record<TipoComprobante, { label: string; color: string; bg: string; border: string; fiscal: boolean }> = {
  factura_a:    { label: 'Factura A',         color: '#818cf8', bg: 'rgba(99,102,241,0.1)',  border: 'rgba(99,102,241,0.35)',  fiscal: true },
  factura_c:    { label: 'Factura C',         color: '#34d399', bg: 'rgba(52,211,153,0.1)',  border: 'rgba(52,211,153,0.35)',  fiscal: true },
  nota_credito: { label: 'Nota de Crédito',   color: '#f87171', bg: 'rgba(239,68,68,0.1)',   border: 'rgba(239,68,68,0.35)',   fiscal: true },
  remito:       { label: 'Remito',            color: '#fbbf24', bg: 'rgba(245,158,11,0.1)',  border: 'rgba(245,158,11,0.35)',  fiscal: false },
};

const TIPO_LINEA_CONFIG: Record<TipoLinea, { label: string; icon: React.ElementType; color: string }> = {
  producto:  { label: 'Producto',  icon: Package, color: '#818cf8' },
  repuesto:  { label: 'Repuesto',  icon: Wrench,  color: '#f59e0b' },
  servicio:  { label: 'Servicio',  icon: Tag,     color: '#34d399' },
  otro:      { label: 'Otro',      icon: Tag,     color: '#94a3b8' },
};

const CONDICIONES_FISCALES = [
  'Consumidor Final', 'Responsable Inscripto', 'Monotributo',
  'Exento', 'Responsable No Inscripto',
];

// METODOS_COBRO eliminado — ahora se usan métodos dinámicos desde usePaymentCommissions

const emptyLinea = (): LineaItem => ({
  _key: Math.random().toString(36).slice(2),
  tipo_linea:      'producto',
  descripcion:     '',
  cantidad:        1,
  precio_unitario: 0,
  descuento_linea: 0,
  costo_unitario:  0,
  currency:        'ARS',
});

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreado?: () => void;
  tipoInicial?: TipoComprobante;
  puntoVentaInicial?: string;
  condicionFiscalInicial?: string;
  initialItems?: { descripcion: string; cantidad: number; precio_unitario: number; currency?: 'ARS'|'USD'; inventory_id?: string }[];
  initialClienteId?: string;
  /** Si true, al seleccionar productos del inventario usa precio_mayorista (sin mostrar etiquetas) */
  usarPrecioMayorista?: boolean;
  /**
   * Si true, comprobanteService NO crea entradas en finanzas ni en financial_movements.
   * Usar cuando el comprobante se genera DESDE un cobro (ModalCobro) que ya registró el movimiento.
   */
  skipFinanceEntry?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ModalCrearComprobante({
  isOpen, onClose, onCreado,
  tipoInicial, puntoVentaInicial, condicionFiscalInicial,
  initialItems, initialClienteId,
  usarPrecioMayorista = false,
  skipFinanceEntry = false,
}: Props) {
  const { businessId, user } = useAuth();
  const [step, setStep] = useState<'config' | 'items' | 'emitir'>('config');

  // ── Encabezado ───────────────────────────────────────────────────────────────
  const [tipo, setTipo]               = useState<TipoComprobante>(tipoInicial ?? 'factura_c');
  const [puntoVenta, setPuntoVenta]   = useState(puntoVentaInicial ?? '0001');
  const [condicion, setCondicion]     = useState(condicionFiscalInicial ?? 'Consumidor Final');
  const [clienteId, setClienteId]     = useState(initialClienteId ?? '');
  const [clienteQuery, setClienteQuery] = useState('');
  const [clientes, setClientes]       = useState<ClienteOption[]>([]);
  const [clienteOpen, setClienteOpen] = useState(false);
  const [observaciones, setObservaciones] = useState('');
  const [exchangeRate, setExchangeRate]   = useState(1);

  // ── Ítems ────────────────────────────────────────────────────────────────────
  const [lineas, setLineas] = useState<LineaItem[]>([emptyLinea()]);
  const [searchResults, setSearchResults]   = useState<InventoryResult[]>([]);
  const [activeSearchIdx, setActiveSearchIdx] = useState<number | null>(null);
  const [searchLoading, setSearchLoading]   = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  const dropdownRefs = useRef<(HTMLDivElement | null)[]>([]);

  // ── Comisiones dinámicas ──────────────────────────────────────────────────────
  const { flatMethods } = usePaymentCommissions();

  // ── Pago ─────────────────────────────────────────────────────────────────────
  const [pagos, setPagos]           = useState<PagoLinea[]>([]);

  // ── Fiscal ───────────────────────────────────────────────────────────────────
  const [emitirEnArca, setEmitirEnArca] = useState(false);

  // ── Estado global ────────────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [arcaWarning, setArcaWarning] = useState<string | null>(null);
  // Modal de cobro MP (se abre cuando el comprobante ya fue creado)
  const [showMpModal, setShowMpModal]         = useState(false);
  const [createdComprobanteId, setCreatedComprobanteId] = useState<string | null>(null);

  const clienteWrapperRef = useRef<HTMLDivElement>(null);

  // ── Reset al abrir ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    setStep('config');
    setTipo(tipoInicial ?? 'factura_c');
    setPuntoVenta(puntoVentaInicial ?? '0001');
    setCondicion(condicionFiscalInicial ?? 'Consumidor Final');
    setClienteId(initialClienteId ?? '');
    setClienteQuery('');
    setObservaciones('');
    setEmitirEnArca(false);
    setSubmitError(null);
    setSubmitSuccess(false);
    setArcaWarning(null);
    setPagos([]);

    if (initialItems && initialItems.length > 0) {
      setLineas(initialItems.map(i => ({
        _key: Math.random().toString(36).slice(2),
        tipo_linea: 'producto' as TipoLinea,
        descripcion: i.descripcion,
        cantidad: i.cantidad,
        precio_unitario: i.precio_unitario,
        descuento_linea: 0,
        costo_unitario: 0,
        currency: (i.currency ?? 'ARS') as 'ARS'|'USD',
        inventory_id: i.inventory_id,
      })));
    } else {
      setLineas([emptyLinea()]);
    }
  }, [isOpen]);

  // ── Auto-cargar punto de venta si no se pasó uno explícito ──────────────────
  useEffect(() => {
    if (!isOpen || !businessId || puntoVentaInicial) return
    supabase
      .from('sales_points')
      .select('punto_venta')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.punto_venta) setPuntoVenta(String(data.punto_venta).padStart(4, '0'))
      })
  }, [isOpen, businessId, puntoVentaInicial])

  // ── Cargar clientes ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen || !businessId) return;
    supabase.from('customers').select('id, name, customer_type')
      .eq('business_id', businessId).order('name')
      .then(({ data }) => setClientes((data || []) as ClienteOption[]));
  }, [isOpen, businessId]);

  // ── Cargar tipo de cambio ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    currencyService.getCurrentExchangeRate('USD', 'ARS')
      .then(r => setExchangeRate(r || 1))
      .catch(() => setExchangeRate(1));
  }, [isOpen]);

  // ── Close dropdown on outside click ──────────────────────────────────────────
  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (clienteWrapperRef.current && !clienteWrapperRef.current.contains(e.target as Node))
        setClienteOpen(false);
      if (activeSearchIdx !== null) {
        const ref = dropdownRefs.current[activeSearchIdx];
        if (ref && !ref.contains(e.target as Node)) {
          setActiveSearchIdx(null);
          setSearchResults([]);
        }
      }
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, [activeSearchIdx]);

  // ── Búsqueda de inventario ─────────────────────────────────────────────────────
  const searchInventory = useCallback(async (q: string) => {
    // Mínimo 2 chars para evitar queries demasiado amplias (bug 13)
    if (q.length < 2) { setSearchResults([]); return; }
    setSearchLoading(true);
    try {
      // Usa el token más largo para la query DB (más selectivo), luego smartSearch client-side
      const dbQ = buildSupabaseQuery(q);
      const { data } = await supabase
        .from('inventory')
        .select('id, code, name, variant_name, category, stock_quantity, cost_price, sale_price, precio_mayorista, base_price, base_currency, has_variants')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .not('has_variants', 'is', true)
        .or(`name.ilike.${dbQ},variant_name.ilike.${dbQ},code.ilike.${dbQ},category.ilike.${dbQ}`)
        .limit(40);

      // Reordena por relevancia con fuzzy matching
      const sorted = smartSearch(
        (data || []) as InventoryResult[],
        q,
        [
          { getValue: inv => inv.name,         weight: 2   },
          { getValue: inv => inv.variant_name,  weight: 1.5 },
          { getValue: inv => inv.code,          weight: 1.5 },
          { getValue: inv => inv.category,      weight: 0.8 },
        ]
      );
      setSearchResults(sorted.slice(0, 12));
    } finally {
      setSearchLoading(false);
    }
  }, [businessId]);

  // ── Totales calculados ────────────────────────────────────────────────────────
  const totales = useMemo(() => {
    let subtotal = 0, iva = 0, costo = 0, descuento = 0;
    for (const l of lineas) {
      const disc = (l.descuento_linea || 0) / 100;
      const raw  = l.cantidad * l.precio_unitario;
      const net  = raw * (1 - disc);
      const inARS = l.currency === 'USD' ? net * exchangeRate : net;
      subtotal    += inARS;
      descuento   += l.currency === 'USD' ? raw * disc * exchangeRate : raw * disc;
      costo       += (l.costo_unitario || 0) * l.cantidad * (l.currency === 'USD' ? exchangeRate : 1);
    }
    iva = tipo === 'factura_a' ? subtotal * 0.21 : 0;
    const total = subtotal + iva;

    // Comisiones de pagos registrados
    let totalComision = 0;
    const totalPagado = pagos.reduce((s, p) => {
      const amt = parseFloat(p.amount) || 0;
      totalComision += amt * (p.commission_rate || 0);
      return s + amt;
    }, 0);

    const totalNeto = total - totalComision;
    const saldo     = Math.max(0, total - totalPagado);

    return { subtotal, iva, total, descuento, costo, totalNeto, totalComision, totalPagado, saldo };
  }, [lineas, tipo, exchangeRate, pagos]);

  if (!isOpen) return null;

  // ── Pago helpers ──────────────────────────────────────────────────────────────
  const toggleMetodoCobro = (metodo: FlatPaymentMethod) => {
    // Para métodos fijos usamos el id como payment_method; para dinámicos usamos 'otro'
    const pmKey = (metodo.id === 'efectivo' || metodo.id === 'transferencia')
      ? metodo.id as MedioPago
      : 'otro' as MedioPago;
    // Identificar por combinación de payment_method + option_id para soportar múltiples tarjetas
    const optionId = metodo.group_id ? metodo.id : null;
    const exists = pagos.find(p =>
      p.payment_method === pmKey && (p as any)._option_id === optionId
    );
    if (exists) {
      setPagos(prev => prev.filter(p => !((p as any)._option_id === optionId && p.payment_method === pmKey)));
    } else {
      const saldo = totales.total - pagos.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
      // Si es recargo al cliente: el monto base sube por el porcentaje
      const baseAmount = metodo.charge_mode === 'customer' && metodo.percentage > 0
        ? Math.round(Math.max(0, saldo) * (1 + metodo.percentage / 100))
        : Math.round(Math.max(0, saldo));
      setPagos(prev => [...prev, {
        _key:             Math.random().toString(36).slice(2),
        payment_method:   pmKey,
        payment_provider: metodo.group_name !== 'Efectivo' && metodo.group_name !== 'Transferencia'
          ? metodo.group_name : '',
        amount:           String(baseAmount),
        commission_rate:  metodo.percentage / 100,
        // Campos extra (cast a any para no cambiar el tipo PagoLinea existente)
        _option_id:       optionId,
        _option_label:    metodo.label,
        _charge_mode:     metodo.charge_mode,
        _color:           metodo.color,
      } as any]);
    }
  };

  const updatePagoAmount = (key: string, val: string) =>
    setPagos(prev => prev.map(p => p._key === key ? { ...p, amount: val } : p));

  // ── Línea helpers ─────────────────────────────────────────────────────────────
  const updateLinea = (key: string, updates: Partial<LineaItem>) => {
    setLineas(prev => prev.map(l => l._key === key ? { ...l, ...updates } : l));
  };

  const selectInventoryItem = (idx: number, inv: InventoryResult) => {
    const l    = lineas[idx];
    const cost = Number(inv.cost_price) || 0;
    const priceUSD = inv.base_currency === 'USD' && inv.base_price ? Number(inv.base_price) : null;
    const useMayorista = usarPrecioMayorista && inv.precio_mayorista != null
    const precioFinal = useMayorista ? Number(inv.precio_mayorista) : (Number(inv.sale_price) || 0)
    const desc = [inv.name, inv.variant_name].filter(Boolean).join(' — ') + (inv.code ? ` [${inv.code}]` : '')
    updateLinea(l._key, {
      descripcion:          desc,
      precio_unitario:      precioFinal,
      costo_unitario:       cost,
      currency:             'ARS',
      inventory_id:         inv.id,
      inv_sale_price:       Number(inv.sale_price),
      inv_cost_price:       cost,
      inv_price_usd:        priceUSD,
      inv_mayorista_price:  inv.precio_mayorista != null ? Number(inv.precio_mayorista) : null,
    });
    setActiveSearchIdx(null);
    setSearchResults([]);
  };

  const handleDescChange = (idx: number, val: string) => {
    const l = lineas[idx];
    updateLinea(l._key, { descripcion: val, inventory_id: val !== l.descripcion ? undefined : l.inventory_id });
    setActiveSearchIdx(idx);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => searchInventory(val), 250);
  };

  // ── Submit ────────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    const validLines = lineas.filter(l => l.descripcion.trim() && l.cantidad > 0 && l.precio_unitario >= 0);
    if (validLines.length === 0) {
      setSubmitError('Agregá al menos un ítem con descripción y cantidad');
      return;
    }
    if (!businessId) { setSubmitError('Error: negocio no identificado'); return; }
    // Si se seleccionó un método de cobro pero el monto es 0, advertir
    const pagosConMonto = pagos.filter(p => parseFloat(p.amount) > 0);
    if (pagos.length > 0 && pagosConMonto.length === 0) {
      setSubmitError('Ingresá el monto del cobro o quitá el método seleccionado');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setArcaWarning(null);

    const input: CrearComprobanteInput = {
      tipo,
      punto_venta:      puntoVenta,
      condicion_fiscal: condicion,
      customer_id:      clienteId || null,
      observaciones,
      exchange_rate:    exchangeRate,
      es_fiscal:        TIPO_CONFIG[tipo].fiscal,
      emitir_en_arca:   emitirEnArca,
      items: validLines.map(l => ({
        descripcion:     l.descripcion,
        tipo_linea:      l.tipo_linea,
        cantidad:        l.cantidad,
        precio_unitario: l.precio_unitario,
        descuento_linea: l.descuento_linea || 0,
        costo_unitario:  l.costo_unitario || 0,
        currency:        l.currency,
        exchange_rate:   l.currency === 'USD' ? exchangeRate : 1,
        inventory_id:    l.inventory_id || null,
      })),
      pagos: pagos
        .filter(p => parseFloat(p.amount) > 0)
        .map(p => ({
          payment_method:   p.payment_method,
          payment_provider: p.payment_provider || undefined,
          amount:           parseFloat(p.amount) || 0,
          currency:         'ARS',
          commission_rate:  p.commission_rate,
        }) as ComprobantePago),
      business_id:         businessId,
      created_by:          user?.id,
      skip_finance_entry:  skipFinanceEntry,
    };

    const result = await comprobanteService.crear(input);

    if (!result.success) {
      setSubmitError(result.error || 'Error al crear el comprobante');
      setSubmitting(false);
      return;
    }

    if (result.arcaError) {
      setArcaWarning(result.arcaError);
    }

    // Guardar el ID del comprobante creado para el modal MP
    if (result.comprobante?.id) {
      setCreatedComprobanteId(result.comprobante.id);
    }

    setSubmitSuccess(true);
    // Si no tiene pagos registrados, no cerrar — dejar que el usuario cobre con MP
    if (pagos.filter(p => parseFloat(p.amount) > 0).length > 0) {
      setTimeout(() => {
        onCreado?.();
        onClose();
      }, 1800);
    }

    setSubmitting(false);
  };

  // ── Styles ────────────────────────────────────────────────────────────────────
  const inputS: React.CSSProperties = {
    width: '100%', padding: '0.5rem 0.75rem',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '0.5rem', color: '#f0f4ff',
    fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box',
  };
  const labelS: React.CSSProperties = {
    display: 'block', fontSize: '0.75rem', fontWeight: 600,
    color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em',
    marginBottom: '0.4rem',
  };
  const blockS: React.CSSProperties = {
    backgroundColor: '#0f1829',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '0.75rem', padding: '1.25rem',
    display: 'flex', flexDirection: 'column', gap: '1rem',
  };
  const fmtARS = (v: number) => `$${v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const cfgTipo = TIPO_CONFIG[tipo];

  return (
    <>
      <div
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9998, padding: '1rem',
        }}
        onClick={e => { if (e.target === e.currentTarget && !submitting) onClose(); }}
      >
        <div style={{
          background: '#0d1a30',
          borderRadius: '1.25rem',
          border: '1px solid rgba(255,255,255,0.1)',
          width: '100%', maxWidth: '600px',
          maxHeight: '92vh', overflowY: 'auto',
          boxShadow: '0 32px 64px rgba(0,0,0,0.6)',
        }}>

          {/* ── Header ── */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '1.25rem 1.5rem 1rem',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            position: 'sticky', top: 0, background: '#0d1a30', zIndex: 1,
            borderRadius: '1.25rem 1.25rem 0 0',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
              <div style={{
                width: 36, height: 36, borderRadius: '0.625rem',
                backgroundColor: cfgTipo.bg, border: `1px solid ${cfgTipo.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Receipt size={16} style={{ color: cfgTipo.color }} />
              </div>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#f0f4ff' }}>
                  Nuevo Comprobante
                </h2>
                <p style={{ margin: 0, fontSize: '0.72rem', color: '#64748b' }}>
                  {step === 'config' ? 'Tipo y cliente' : step === 'items' ? `${cfgTipo.label} · Ítems` : `${cfgTipo.label} · Emitir`}
                </p>
              </div>
            </div>
            <CloseButton onClick={onClose} disabled={submitting} />
          </div>

          {/* ══════════════════════════════════════
               STEP: CONFIG
              ══════════════════════════════════════ */}
          {step === 'config' && (
            <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

              {/* BLOQUE 1 · ENCABEZADO */}
              <div style={blockS}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <FileText size={14} style={{ color: '#818cf8' }} />
                  <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    Encabezado
                  </span>
                </div>

                {/* Tipo de comprobante */}
                <div>
                  <label style={labelS}>Tipo de comprobante</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {(Object.keys(TIPO_CONFIG) as TipoComprobante[]).map(t => {
                      const c = TIPO_CONFIG[t];
                      const sel = tipo === t;
                      return (
                        <button
                          key={t}
                          onClick={() => {
                            setTipo(t);
                            if (t === 'factura_a') setCondicion('Responsable Inscripto');
                            else if (t === 'factura_c' || t === 'remito') setCondicion('Consumidor Final');
                          }}
                          style={{
                            padding: '0.4rem 0.875rem',
                            borderRadius: '0.5rem',
                            border: `2px solid ${sel ? c.border : 'rgba(255,255,255,0.08)'}`,
                            backgroundColor: sel ? c.bg : 'transparent',
                            color: sel ? c.color : '#64748b',
                            fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer',
                            transition: 'all 0.15s',
                          }}
                        >
                          {c.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Cliente + PV + TC */}
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '0.875rem' }}>
                  {/* Cliente */}
                  <div ref={clienteWrapperRef}>
                    <label style={labelS}>Cliente</label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type="text"
                        value={clienteQuery}
                        onChange={e => {
                          setClienteQuery(e.target.value);
                          setClienteId('');
                          setClienteOpen(true);
                        }}
                        onFocus={() => setClienteOpen(true)}
                        placeholder="Consumidor Final"
                        style={inputS}
                      />
                      <ChevronDown size={14} style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                      {clienteOpen && (
                        <div style={{
                          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
                          backgroundColor: '#0b1120', border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: '0.5rem', zIndex: 999,
                          maxHeight: '200px', overflowY: 'auto',
                          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                        }}>
                          <button
                            onClick={() => { setClienteId(''); setClienteQuery(''); setClienteOpen(false); }}
                            style={{ width: '100%', textAlign: 'left', padding: '0.625rem 1rem', background: 'none', border: 'none', color: '#94a3b8', fontSize: '0.8rem', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                          >
                            Consumidor Final
                          </button>
                          {clientes.filter(c => c.name.toLowerCase().includes(clienteQuery.toLowerCase())).map(c => (
                            <button
                              key={c.id}
                              onClick={() => { setClienteId(c.id); setClienteQuery(c.name); setClienteOpen(false); }}
                              style={{ width: '100%', textAlign: 'left', padding: '0.625rem 1rem', background: 'none', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.03)', color: '#f1f5f9', fontSize: '0.8rem', cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.04)')}
                              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                            >
                              {c.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Punto de venta */}
                  <div>
                    <label style={labelS}>Punto de venta</label>
                    <input
                      type="text"
                      value={puntoVenta}
                      onChange={e => setPuntoVenta(e.target.value.replace(/\D/g, '').slice(0, 5))}
                      placeholder="0001"
                      style={{ ...inputS, fontFamily: 'monospace', textAlign: 'center' }}
                    />
                  </div>

                  {/* Tipo de cambio */}
                  <div>
                    <label style={labelS}>TC USD/ARS</label>
                    <div style={{ position: 'relative' }}>
                      <DollarSign size={13} style={{ position: 'absolute', left: '0.625rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                      <input
                        type="number" value={exchangeRate} min="1" step="0.01"
                        onChange={e => setExchangeRate(Number(e.target.value) || 1)}
                        style={{ ...inputS, paddingLeft: '1.875rem', fontFamily: 'monospace' }}
                      />
                    </div>
                  </div>
                </div>

                {/* Condición fiscal + Observaciones */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.875rem' }}>
                  <div>
                    <label style={labelS}>Condición fiscal del cliente</label>
                    <select value={condicion} onChange={e => setCondicion(e.target.value)} style={inputS}>
                      {CONDICIONES_FISCALES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelS}>Observaciones</label>
                    <input
                      type="text" value={observaciones}
                      onChange={e => setObservaciones(e.target.value)}
                      placeholder="Nota o referencia interna..."
                      style={inputS}
                    />
                  </div>
                </div>
              </div>

              {/* Botón continuar */}
              <button
                onClick={() => setStep('items')}
                style={{
                  width: '100%', padding: '0.875rem',
                  background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                  border: 'none', borderRadius: '0.75rem',
                  color: '#fff', fontWeight: 700, fontSize: '0.9375rem', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                  boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
                }}
              >
                Continuar a ítems <ChevronRight size={18} />
              </button>
            </div>
          )}

          {/* ══════════════════════════════════════
               STEP: ITEMS
              ══════════════════════════════════════ */}
          {step === 'items' && (
            <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

              {/* Badge resumen config */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0.5rem 0.875rem',
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '0.625rem',
              }}>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                  {cfgTipo.label} · {clienteQuery || 'Consumidor Final'} · PV {puntoVenta}
                </span>
                <button
                  onClick={() => setStep('config')}
                  style={{ background: 'none', border: 'none', color: '#818cf8', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}
                >
                  editar
                </button>
              </div>

              {/* BLOQUE 2 · ÍTEMS */}
              <div style={blockS}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Package size={14} style={{ color: '#f59e0b' }} />
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                      Ítems
                    </span>
                  </div>
                  <button
                    onClick={() => setLineas(prev => [...prev, emptyLinea()])}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.375rem',
                      padding: '0.35rem 0.75rem',
                      backgroundColor: 'rgba(99,102,241,0.12)',
                      border: '1px solid rgba(99,102,241,0.3)',
                      borderRadius: '0.375rem', color: '#818cf8',
                      fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    <Plus size={12} /> Agregar ítem
                  </button>
                </div>

                {lineas.map((l, idx) => {
                  const disc    = (l.descuento_linea || 0) / 100;
                  const raw     = l.cantidad * l.precio_unitario;
                  const lineARS = l.currency === 'USD' ? raw * (1 - disc) * exchangeRate : raw * (1 - disc);
                  return (
                    <div key={l._key} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.625rem', padding: '0.625rem' }}>

                      {/* Fila 1: tipo + descripción + eliminar */}
                      <div style={{ display: 'grid', gridTemplateColumns: '82px 1fr 30px', gap: '0.375rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <select
                          value={l.tipo_linea}
                          onChange={e => updateLinea(l._key, { tipo_linea: e.target.value as TipoLinea })}
                          style={{ ...inputS, padding: '0.375rem 0.375rem', fontSize: '0.72rem' }}
                        >
                          {(Object.keys(TIPO_LINEA_CONFIG) as TipoLinea[]).map(t => (
                            <option key={t} value={t}>{TIPO_LINEA_CONFIG[t].label}</option>
                          ))}
                        </select>

                        {/* Descripción con búsqueda */}
                        <div ref={el => { dropdownRefs.current[idx] = el; }} style={{ position: 'relative' }}>
                          <Search size={13} style={{ position: 'absolute', left: '0.625rem', top: '50%', transform: 'translateY(-50%)', color: l.inventory_id ? '#10b981' : '#475569', pointerEvents: 'none' }} />
                          <input
                            type="text"
                            value={l.descripcion}
                            onChange={e => handleDescChange(idx, e.target.value)}
                            onFocus={() => { setActiveSearchIdx(idx); if (l.descripcion.length >= 1) searchInventory(l.descripcion); }}
                            placeholder="Buscar producto o escribir concepto..."
                            style={{ ...inputS, paddingLeft: '2rem', fontSize: '0.875rem', border: `1px solid ${l.inventory_id ? 'rgba(16,185,129,0.4)' : 'rgba(255,255,255,0.1)'}` }}
                          />
                          {/* Dropdown de búsqueda */}
                          {activeSearchIdx === idx && (searchResults.length > 0 || searchLoading) && (
                            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: '-92px', right: '-34px', minWidth: '340px', backgroundColor: '#0d1a30', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '0.75rem', zIndex: 200, maxHeight: '320px', overflowY: 'auto', boxShadow: '0 20px 40px rgba(0,0,0,0.6)' }}>
                              {searchLoading ? (
                                <div style={{ padding: '1rem', color: '#64748b', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                  <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Buscando...
                                </div>
                              ) : searchResults.map(inv => {
                                const currentQuery = lineas[idx]?.descripcion ?? '';
                                const nameParts = highlightParts(inv.name, currentQuery);
                                const variantParts = inv.variant_name ? highlightParts(inv.variant_name, currentQuery) : null;
                                return (
                                <button key={inv.id} onClick={() => selectInventoryItem(idx, inv)}
                                  style={{ width: '100%', textAlign: 'left', padding: '0.625rem 0.875rem', background: 'none', border: 'none', borderBottom: '1px solid rgba(51,65,85,0.2)', color: '#f1f5f9', cursor: 'pointer', display: 'block' }}
                                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.08)')}
                                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}>
                                  {/* Nombre completo en ancho total — sin truncar */}
                                  <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#e2e8f0', lineHeight: 1.4, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                                    {nameParts.map((p, i) => (
                                      <span key={i} style={p.highlight ? { color: '#818cf8', fontWeight: 800 } : undefined}>{p.text}</span>
                                    ))}
                                    {/* Variante inline junto al nombre */}
                                    {variantParts && (
                                      <span style={{ marginLeft: '0.375rem', fontSize: '0.78rem', fontWeight: 600, background: 'rgba(99,102,241,0.18)', border: '1px solid rgba(99,102,241,0.35)', color: '#a5b4fc', borderRadius: '0.3rem', padding: '0.05rem 0.35rem' }}>
                                        {variantParts.map((p, i) => (
                                          <span key={i} style={p.highlight ? { color: '#c7d2fe', fontWeight: 800 } : undefined}>{p.text}</span>
                                        ))}
                                      </span>
                                    )}
                                  </div>
                                  {/* Meta + precio en la misma fila */}
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.2rem', flexWrap: 'wrap', gap: '0.25rem' }}>
                                    <div style={{ fontSize: '0.7rem', color: '#64748b', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                      {inv.code && <span style={{ fontFamily: 'monospace' }}>#{inv.code}</span>}
                                      <span>{inv.category}</span>
                                      <span style={{ color: inv.stock_quantity <= 3 ? '#f59e0b' : '#10b981' }}>Stock: {inv.stock_quantity}</span>
                                    </div>
                                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#34d399', fontFamily: 'monospace', flexShrink: 0 }}>
                                      {usarPrecioMayorista && inv.precio_mayorista != null
                                        ? fmtARS(Number(inv.precio_mayorista))
                                        : fmtARS(Number(inv.sale_price))}
                                      {inv.base_currency === 'USD' && inv.base_price && (
                                        <span style={{ fontSize: '0.7rem', color: '#60a5fa', marginLeft: '0.375rem' }}>USD {Number(inv.base_price).toFixed(2)}</span>
                                      )}
                                    </div>
                                  </div>
                                </button>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <button onClick={() => lineas.length > 1 && setLineas(prev => prev.filter(x => x._key !== l._key))}
                          disabled={lineas.length === 1}
                          style={{ background: 'none', border: 'none', cursor: lineas.length > 1 ? 'pointer' : 'default', color: lineas.length > 1 ? '#ef4444' : '#334155', padding: '0.25rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <X size={14} />
                        </button>
                      </div>

                      {/* Fila 2: cant + precio + ARS/USD + desc% + subtotal */}
                      <div style={{ display: 'grid', gridTemplateColumns: '64px 110px auto 80px 1fr', gap: '0.375rem', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontSize: '0.6rem', color: '#475569', marginBottom: '0.15rem' }}>Cant.</div>
                          <input type="number" value={l.cantidad} min="0.01" step="0.01"
                            onChange={e => updateLinea(l._key, { cantidad: Number(e.target.value) || 0 })}
                            style={{ ...inputS, padding: '0.375rem', textAlign: 'center', fontFamily: 'monospace', fontSize: '0.82rem' }} />
                        </div>

                        {/* Precio */}
                        <div>
                          <div style={{ fontSize: '0.6rem', color: '#475569', marginBottom: '0.15rem' }}>
                            Precio unit. {l.currency === 'USD' && exchangeRate > 1 && (
                              <span style={{ color: '#60a5fa' }}> = {fmtARS(Math.round(l.precio_unitario * exchangeRate))}</span>
                            )}
                          </div>
                          <input type="number" value={l.precio_unitario} min="0" step={l.currency === 'USD' ? '0.01' : '1'}
                            onChange={e => updateLinea(l._key, { precio_unitario: Number(e.target.value) || 0 })}
                            style={{ ...inputS, padding: '0.375rem', textAlign: 'right', fontFamily: 'monospace', fontSize: '0.82rem', borderColor: l.currency === 'USD' ? 'rgba(96,165,250,0.4)' : undefined }} />
                        </div>

                        {/* Toggle ARS/USD */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', alignSelf: 'flex-end', paddingBottom: '0.1rem' }}>
                          {(['ARS','USD'] as const).map(c => (
                            <button key={c} onClick={() => {
                              if (c === l.currency) return;
                              let newPrice: number;
                              if (c === 'USD') {
                                // ARS → USD
                                newPrice = l.inv_price_usd != null ? l.inv_price_usd
                                  : exchangeRate > 1 ? parseFloat((l.precio_unitario / exchangeRate).toFixed(2))
                                  : l.precio_unitario;
                              } else {
                                // USD → ARS
                                newPrice = l.inv_sale_price != null ? l.inv_sale_price
                                  : exchangeRate > 1 ? Math.round(l.precio_unitario * exchangeRate)
                                  : l.precio_unitario;
                              }
                              updateLinea(l._key, { currency: c, precio_unitario: newPrice });
                            }} style={{ padding: '0.1rem 0.3rem', backgroundColor: l.currency === c ? (c === 'USD' ? 'rgba(96,165,250,0.2)' : 'rgba(52,211,153,0.15)') : 'transparent', border: `1px solid ${l.currency === c ? (c === 'USD' ? 'rgba(96,165,250,0.4)' : 'rgba(52,211,153,0.35)') : 'rgba(255,255,255,0.06)'}`, borderRadius: '0.2rem', color: l.currency === c ? (c === 'USD' ? '#60a5fa' : '#34d399') : '#475569', fontSize: '0.6rem', fontWeight: 700, cursor: 'pointer' }}>
                              {c}
                            </button>
                          ))}
                        </div>

                        {/* Desc% */}
                        <div>
                          <div style={{ fontSize: '0.6rem', color: '#475569', marginBottom: '0.15rem' }}>Desc%</div>
                          <div style={{ position: 'relative' }}>
                            <Percent size={9} style={{ position: 'absolute', left: '0.35rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                            <input type="number" value={l.descuento_linea || ''} min="0" max="100" step="0.1" placeholder="0"
                              onChange={e => updateLinea(l._key, { descuento_linea: Math.min(100, Number(e.target.value) || 0) })}
                              style={{ ...inputS, padding: '0.375rem 0.25rem 0.375rem 1.1rem', textAlign: 'right', fontFamily: 'monospace', fontSize: '0.78rem' }} />
                          </div>
                        </div>

                        {/* Subtotal */}
                        <div style={{ textAlign: 'right', alignSelf: 'flex-end', paddingBottom: '0.1rem' }}>
                          <div style={{ fontSize: '0.6rem', color: '#475569', marginBottom: '0.15rem' }}>Subtotal</div>
                          <div style={{ fontFamily: 'monospace', fontSize: '0.875rem', fontWeight: 700, color: '#34d399' }}>{fmtARS(lineARS)}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Totales resumen (sin sección pagos) */}
              <div style={{ ...blockS, borderColor: 'rgba(99,102,241,0.2)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {[
                    { label: 'Subtotal', val: totales.subtotal, color: '#94a3b8' },
                    totales.descuento > 0 && { label: 'Descuentos', val: -totales.descuento, color: '#34d399' },
                    tipo === 'factura_a' && { label: 'IVA 21%', val: totales.iva, color: '#818cf8' },
                  ].filter(Boolean).map((row: any) => (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                      <span style={{ color: '#64748b' }}>{row.label}</span>
                      <span style={{ fontFamily: 'monospace', color: row.color }}>{fmtARS(Math.abs(row.val))}</span>
                    </div>
                  ))}
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.625rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, color: '#f1f5f9' }}>Total</span>
                    <span style={{ fontSize: '1.625rem', fontWeight: 800, color: '#34d399', fontFamily: 'monospace' }}>{fmtARS(totales.total)}</span>
                  </div>
                </div>
              </div>

              {/* Botones navegación */}
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button
                  onClick={() => setStep('config')}
                  style={{
                    padding: '0.75rem 1rem', borderRadius: '0.75rem',
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                    color: '#64748b', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.85rem',
                  }}
                >
                  <ChevronLeft size={16} /> Volver
                </button>
                <button
                  onClick={() => {
                    const valid = lineas.filter(l => l.descripcion.trim() && l.cantidad > 0);
                    if (valid.length === 0) {
                      setSubmitError('Agregá al menos un ítem con descripción y cantidad');
                      return;
                    }
                    setSubmitError(null);
                    setStep('emitir');
                  }}
                  style={{
                    flex: 1, padding: '0.875rem', borderRadius: '0.75rem',
                    background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                    border: 'none', color: '#fff', fontWeight: 700, fontSize: '0.9375rem', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                    boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
                  }}
                >
                  Ver resumen <ChevronRight size={18} />
                </button>
              </div>

              {submitError && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', padding: '0.875rem 1rem', backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '0.5rem' }}>
                  <AlertCircle size={16} style={{ color: '#f87171', flexShrink: 0, marginTop: '0.1rem' }} />
                  <span style={{ color: '#fca5a5', fontSize: '0.875rem' }}>{submitError}</span>
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════
               STEP: EMITIR
              ══════════════════════════════════════ */}
          {step === 'emitir' && (
            <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

              {/* Resumen de ítems */}
              <div style={{ ...blockS, borderColor: 'rgba(99,102,241,0.2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Receipt size={14} style={{ color: '#6366f1' }} />
                  <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    Resumen
                  </span>
                </div>

                {/* Lista de ítems */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                  {lineas.filter(l => l.descripcion.trim() && l.cantidad > 0).map(l => {
                    const disc = (l.descuento_linea || 0) / 100;
                    const raw = l.cantidad * l.precio_unitario;
                    const lineARS = l.currency === 'USD' ? raw * (1 - disc) * exchangeRate : raw * (1 - disc);
                    return (
                      <div key={l._key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                        <span style={{ color: '#94a3b8' }}>
                          {l.cantidad}× {l.descripcion}
                          {l.descuento_linea > 0 && <span style={{ color: '#34d399', marginLeft: '0.375rem' }}>−{l.descuento_linea}%</span>}
                        </span>
                        <span style={{ fontFamily: 'monospace', color: '#f1f5f9', fontWeight: 600 }}>{fmtARS(lineARS)}</span>
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.75rem' }}>
                  {[
                    { label: 'Subtotal', val: totales.subtotal, color: '#94a3b8' },
                    totales.descuento > 0 && { label: 'Descuentos', val: -totales.descuento, color: '#34d399' },
                    tipo === 'factura_a' && { label: 'IVA 21%', val: totales.iva, color: '#818cf8' },
                  ].filter(Boolean).map((row: any) => (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                      <span style={{ color: '#64748b' }}>{row.label}</span>
                      <span style={{ fontFamily: 'monospace', color: row.color }}>{fmtARS(Math.abs(row.val))}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, color: '#f1f5f9' }}>Total</span>
                    <span style={{ fontSize: '1.625rem', fontWeight: 800, color: '#34d399', fontFamily: 'monospace' }}>{fmtARS(totales.total)}</span>
                  </div>
                </div>
              </div>

              {/* BLOQUE COBRO */}
              <div style={blockS}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Wallet size={14} style={{ color: '#34d399' }} />
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                      Cobro
                    </span>
                  </div>
                  <span style={{ fontSize: '0.72rem', color: '#475569' }}>
                    {pagos.length === 0 ? 'Seleccioná el método' : fmtARS(totales.total) + ' a cobrar'}
                  </span>
                </div>

                {/* Métodos dinámicos desde Configuración > Comisiones */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0.5rem' }}>
                  {flatMethods.map(m => {
                    const optionId = m.group_id ? m.id : null;
                    const pmKey = (m.id === 'efectivo' || m.id === 'transferencia') ? m.id : 'otro';
                    const activo = pagos.some(p =>
                      p.payment_method === pmKey && (p as any)._option_id === optionId
                    );
                    const subText = m.percentage > 0
                      ? (m.charge_mode === 'customer' ? `+${m.percentage}% cliente` : `${m.percentage}% negocio`)
                      : 'Sin recargo';
                    return (
                      <button key={m.id} onClick={() => toggleMetodoCobro(m)}
                        style={{
                          padding: '0.625rem 0.375rem',
                          borderRadius: '0.625rem',
                          border: `2px solid ${activo ? m.color : 'rgba(255,255,255,0.07)'}`,
                          backgroundColor: activo ? `${m.color}18` : 'rgba(255,255,255,0.03)',
                          color: activo ? m.color : '#64748b',
                          cursor: 'pointer', transition: 'all 0.15s',
                          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem', textAlign: 'center',
                        }}
                      >
                        <span style={{ fontSize: '0.78rem', fontWeight: 700, lineHeight: 1.25 }}>{m.group_name}</span>
                        {m.group_id && <span style={{ fontSize: '0.68rem', fontWeight: 600, opacity: 0.9, lineHeight: 1.2 }}>{m.short_label}</span>}
                        <span style={{ fontSize: '0.6rem', color: activo ? m.color : '#475569', opacity: 0.85 }}>{subText}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Monto + resumen cuando hay método seleccionado */}
                {pagos.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                    {pagos.map(p => {
                      const pa = p as any;
                      const metColor = pa._color || '#94a3b8';
                      const metLabel = pa._option_label || p.payment_method;
                      const amt = parseFloat(p.amount) || 0;
                      const comm = amt * (p.commission_rate || 0);
                      const chargeMode: string = pa._charge_mode || 'none';
                      return (
                        <div key={p._key} style={{
                          display: 'flex', alignItems: 'center', gap: '0.5rem',
                          padding: '0.5rem 0.625rem',
                          background: `${metColor}12`,
                          border: `1px solid ${metColor}30`,
                          borderRadius: '0.5rem',
                        }}>
                          <span style={{ fontSize: '0.8rem', color: metColor, fontWeight: 700, flex: 1 }}>
                            {metLabel}
                          </span>
                          <input
                            type="number" min="0" step="1"
                            value={p.amount}
                            onChange={e => updatePagoAmount(p._key, e.target.value)}
                            style={{ ...inputS, width: '110px', padding: '0.3rem 0.5rem', textAlign: 'right', fontFamily: 'monospace', fontSize: '0.85rem', fontWeight: 700 }}
                          />
                          <button
                            onClick={() => setPagos(prev => prev.filter(x => x._key !== p._key))}
                            style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '0.1rem', flexShrink: 0 }}
                          >
                            <X size={13} />
                          </button>
                          {comm > 0 && chargeMode === 'customer' && (
                            <span style={{ fontSize: '0.68rem', color: '#f59e0b', whiteSpace: 'nowrap' }}>
                              +{fmtARS(comm)} recargo
                            </span>
                          )}
                          {comm > 0 && chargeMode === 'business' && (
                            <span style={{ fontSize: '0.68rem', color: '#818cf8', whiteSpace: 'nowrap' }}>
                              −{fmtARS(comm)} absorbe negocio
                            </span>
                          )}
                        </div>
                      );
                    })}

                    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                        {totales.totalComision > 0 && (
                          <span style={{ fontSize: '0.75rem', color: '#f59e0b' }}>
                            Comisión: −{fmtARS(totales.totalComision)}
                          </span>
                        )}
                        {totales.saldo > 1 && (
                          <span style={{ fontSize: '0.75rem', color: '#f87171' }}>
                            Saldo pendiente: {fmtARS(totales.saldo)}
                          </span>
                        )}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '0.7rem', color: '#64748b' }}>Neto a recibir</div>
                        <div style={{ fontFamily: 'monospace', fontSize: '1.1rem', fontWeight: 800, color: '#34d399' }}>
                          {fmtARS(totales.totalNeto)}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* BLOQUE 4 · FISCAL (si aplica) */}
              {TIPO_CONFIG[tipo].fiscal && (
                <div style={blockS}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Zap size={14} style={{ color: '#818cf8' }} />
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                      Emisión Fiscal
                    </span>
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox" checked={emitirEnArca}
                      onChange={e => setEmitirEnArca(e.target.checked)}
                      style={{ width: '1.125rem', height: '1.125rem', accentColor: '#6366f1', cursor: 'pointer' }}
                    />
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Zap size={13} style={{ color: '#818cf8' }} />
                        <span style={{ fontSize: '0.875rem', color: '#f1f5f9', fontWeight: 600 }}>
                          Emitir electrónicamente vía ARCA
                        </span>
                      </div>
                      <p style={{ fontSize: '0.75rem', color: '#64748b', margin: '0.2rem 0 0 0' }}>
                        Solo si tenés ARCA configurado. Si ARCA no responde (máx. 20 seg.), el comprobante se guarda igual como borrador — podés emitirlo después.
                      </p>
                    </div>
                  </label>
                </div>
              )}

              {/* Errores y warnings */}
              {submitError && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', padding: '0.875rem 1rem', backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '0.5rem' }}>
                  <AlertCircle size={16} style={{ color: '#f87171', flexShrink: 0, marginTop: '0.1rem' }} />
                  <span style={{ color: '#fca5a5', fontSize: '0.875rem' }}>{submitError}</span>
                </div>
              )}

              {arcaWarning && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', padding: '0.875rem 1rem', backgroundColor: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '0.5rem' }}>
                  <AlertCircle size={16} style={{ color: '#fbbf24', flexShrink: 0, marginTop: '0.1rem' }} />
                  <div>
                    <div style={{ color: '#fde68a', fontSize: '0.875rem', fontWeight: 600 }}>Advertencia ARCA</div>
                    <div style={{ color: '#fcd34d', fontSize: '0.8rem', marginTop: '0.125rem' }}>{arcaWarning}</div>
                    <div style={{ color: '#92400e', fontSize: '0.75rem', marginTop: '0.25rem' }}>El comprobante se guardó como borrador.</div>
                  </div>
                </div>
              )}

              {submitSuccess && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.875rem 1rem', backgroundColor: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: '0.5rem' }}>
                  <CheckCircle2 size={18} style={{ color: '#34d399' }} />
                  <div>
                    <div style={{ color: '#34d399', fontWeight: 600, fontSize: '0.875rem' }}>¡Comprobante creado correctamente!</div>
                    {arcaWarning && <div style={{ color: '#6ee7b7', fontSize: '0.8rem' }}>Guardado como borrador (verificar estado fiscal).</div>}
                  </div>
                </div>
              )}

              {/* Botón Cobrar con Mercado Pago (post-creación) */}
              {createdComprobanteId && (
                <button
                  onClick={() => setShowMpModal(true)}
                  style={{
                    width: '100%', padding: '0.75rem',
                    background: 'linear-gradient(135deg, #009ee3, #00bcff)',
                    border: 'none', borderRadius: '0.625rem',
                    color: '#fff', fontWeight: 700, fontSize: '0.875rem',
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                    boxShadow: '0 4px 16px rgba(0,158,227,0.35)',
                  }}
                >
                  <Zap size={15} />
                  Cobrar con Mercado Pago
                </button>
              )}

              {/* Botones navegación y submit */}
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button
                  onClick={() => setStep('items')}
                  disabled={submitting}
                  style={{
                    padding: '0.75rem 1rem', borderRadius: '0.75rem',
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                    color: '#64748b', cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.5 : 1,
                    display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.85rem',
                  }}
                >
                  <ChevronLeft size={16} /> Volver
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={submitting || submitSuccess}
                  style={{
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                    padding: '0.75rem 1.5rem',
                    background: submitSuccess
                      ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                      : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                    border: 'none', color: '#fff',
                    borderRadius: '0.625rem',
                    cursor: submitting || submitSuccess ? 'not-allowed' : 'pointer',
                    fontSize: '0.875rem', fontWeight: 600,
                    boxShadow: `0 4px 12px ${submitSuccess ? 'rgba(16,185,129,0.35)' : 'rgba(99,102,241,0.35)'}`,
                    opacity: submitting ? 0.8 : 1,
                  }}
                >
                  {submitting ? (
                    <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> {emitirEnArca ? 'Emitiendo en ARCA...' : 'Creando...'}</>
                  ) : submitSuccess ? (
                    <><CheckCircle2 size={16} /> ¡Creado!</>
                  ) : (
                    <><Receipt size={16} /> {emitirEnArca ? 'Emitir en ARCA' : 'Crear Comprobante'}</>
                  )}
                </button>
              </div>
            </div>
          )}

        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      {/* Modal de cobro con Mercado Pago — disponible tras crear el comprobante */}
      {createdComprobanteId && (
        <MpPaymentModal
          isOpen={showMpModal}
          onClose={() => setShowMpModal(false)}
          comprobanteId={createdComprobanteId}
          totalBruto={totales.total}
          saldoPendiente={totales.total - totales.totalPagado}
          onPagoRegistrado={() => {
            setShowMpModal(false);
            onCreado?.();
            onClose();
          }}
        />
      )}
    </>
  );
}
