import {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import {
  X, FileText, Receipt, ChevronDown,
  Loader2, Plus, Zap, Package, Search, DollarSign,
  Wrench, Tag, Percent,
  AlertCircle, CheckCircle2,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { CloseButton } from '../ui/CloseButton';
import { currencyService } from '../../services/currencyService';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import {
  comprobanteService,
  TipoComprobante, TipoLinea, MedioPago,
  ComprobantePago, CrearComprobanteInput,
} from '../../services/comprobanteService';
import { MpPaymentModal } from '../payments/MpPaymentModal';

// ─── Sub-types ────────────────────────────────────────────────────────────────

interface InventoryResult {
  id: string;
  code: string;
  name: string;
  category: string;
  stock_quantity: number;
  cost_price: number;
  sale_price: number;
  precio_mayorista?: number | null;
  base_price?: number | null;
  base_currency?: string | null;
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
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ModalCrearComprobante({
  isOpen, onClose, onCreado,
  tipoInicial, puntoVentaInicial, condicionFiscalInicial,
  initialItems, initialClienteId,
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
    if (q.length < 1) { setSearchResults([]); return; }
    setSearchLoading(true);
    try {
      const { data } = await supabase
        .from('inventory')
        .select('id, code, name, category, stock_quantity, cost_price, sale_price, precio_mayorista, base_price, base_currency')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .or(`name.ilike.%${q}%,code.ilike.%${q}%,category.ilike.%${q}%`)
        .order('stock_quantity', { ascending: false })
        .limit(10);
      setSearchResults((data || []) as InventoryResult[]);
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

  // Cliente mayorista: se usa para auto-aplicar precios mayoristas en items
  const clienteMayorista = clientes.find(c => c.id === clienteId)
  const isClienteMayorista = clienteMayorista?.customer_type === 'mayorista'

  // ── Línea helpers ─────────────────────────────────────────────────────────────
  const updateLinea = (key: string, updates: Partial<LineaItem>) => {
    setLineas(prev => prev.map(l => l._key === key ? { ...l, ...updates } : l));
  };

  const selectInventoryItem = (idx: number, inv: InventoryResult) => {
    const l    = lineas[idx];
    const cost = Number(inv.cost_price) || 0;
    const priceUSD = inv.base_currency === 'USD' && inv.base_price ? Number(inv.base_price) : null;
    const useMayorista = isClienteMayorista && inv.precio_mayorista != null
    const precioFinal = useMayorista ? Number(inv.precio_mayorista) : (Number(inv.sale_price) || 0)
    updateLinea(l._key, {
      descripcion:     inv.name + (inv.code ? ` [${inv.code}]` : ''),
      precio_unitario: precioFinal,
      costo_unitario:  cost,
      currency:        'ARS',
      inventory_id:    inv.id,
      inv_sale_price:  Number(inv.sale_price),
      inv_cost_price:  cost,
      inv_price_usd:   priceUSD,
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
      business_id: businessId,
      created_by:  user?.id,
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
                              <span style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                {c.name}
                                {c.customer_type === 'mayorista' && (
                                  <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '9999px', background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.35)', color: '#a5b4fc' }}>
                                    MAYORISTA
                                  </span>
                                )}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {isClienteMayorista && (
                      <p style={{ margin: '0.375rem 0 0', fontSize: '0.72rem', color: '#a5b4fc', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                        🏬 Cliente mayorista — se aplicarán precios mayoristas automáticamente
                      </p>
                    )}
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

                {/* Header de columnas */}
                <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 70px 80px 60px 90px 80px 32px', gap: '0.375rem', paddingBottom: '0.375rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  {['Tipo', 'Descripción / Producto', 'Cant.', 'Precio', 'Desc%', 'Costo unit.', 'Subtotal', ''].map(h => (
                    <span key={h} style={{ fontSize: '0.65rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</span>
                  ))}
                </div>

                {lineas.map((l, idx) => {
                  const disc    = (l.descuento_linea || 0) / 100;
                  const raw     = l.cantidad * l.precio_unitario;
                  const lineARS = l.currency === 'USD' ? raw * (1 - disc) * exchangeRate : raw * (1 - disc);
                  return (
                    <div
                      key={l._key}
                      style={{ display: 'grid', gridTemplateColumns: '90px 1fr 70px 80px 60px 90px 80px 32px', gap: '0.375rem', alignItems: 'center' }}
                    >
                      {/* Tipo línea */}
                      <div style={{ position: 'relative' }}>
                        <select
                          value={l.tipo_linea}
                          onChange={e => updateLinea(l._key, { tipo_linea: e.target.value as TipoLinea })}
                          style={{ ...inputS, padding: '0.4rem 0.5rem', fontSize: '0.75rem', paddingRight: '1.25rem' }}
                        >
                          {(Object.keys(TIPO_LINEA_CONFIG) as TipoLinea[]).map(t => (
                            <option key={t} value={t}>{TIPO_LINEA_CONFIG[t].label}</option>
                          ))}
                        </select>
                      </div>

                      {/* Descripción con búsqueda */}
                      <div ref={el => { dropdownRefs.current[idx] = el; }} style={{ position: 'relative' }}>
                        <div style={{ position: 'relative' }}>
                          <Search size={12} style={{ position: 'absolute', left: '0.5rem', top: '50%', transform: 'translateY(-50%)', color: l.inventory_id ? '#10b981' : '#475569', pointerEvents: 'none' }} />
                          <input
                            type="text"
                            value={l.descripcion}
                            onChange={e => handleDescChange(idx, e.target.value)}
                            onFocus={() => { setActiveSearchIdx(idx); if (l.descripcion.length >= 1) searchInventory(l.descripcion); }}
                            placeholder="Buscar producto o escribir..."
                            style={{ ...inputS, paddingLeft: '1.625rem', fontSize: '0.8rem', padding: '0.4rem 0.5rem 0.4rem 1.625rem', border: `1px solid ${l.inventory_id ? 'rgba(16,185,129,0.4)' : 'rgba(255,255,255,0.1)'}` }}
                          />
                        </div>

                        {/* Dropdown de búsqueda */}
                        {activeSearchIdx === idx && (searchResults.length > 0 || searchLoading) && (
                          <div style={{
                            position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                            minWidth: '360px', maxWidth: '520px',
                            backgroundColor: '#0b1120',
                            border: '1px solid rgba(99,102,241,0.3)',
                            borderRadius: '0.75rem', zIndex: 200,
                            maxHeight: '300px', overflowY: 'auto',
                            boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
                          }}>
                            {searchLoading ? (
                              <div style={{ padding: '1rem', color: '#64748b', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Buscando...
                              </div>
                            ) : searchResults.map(inv => (
                              <button
                                key={inv.id}
                                onClick={() => selectInventoryItem(idx, inv)}
                                style={{ width: '100%', textAlign: 'left', padding: '0.625rem 0.875rem', background: 'none', border: 'none', borderBottom: '1px solid rgba(51,65,85,0.2)', color: '#f1f5f9', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}
                                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.08)')}
                                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                              >
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {inv.name}
                                  </div>
                                  <div style={{ fontSize: '0.7rem', color: '#64748b', display: 'flex', gap: '0.5rem', marginTop: '0.1rem' }}>
                                    {inv.code && <span>#{inv.code}</span>}
                                    <span>{inv.category}</span>
                                    <span style={{ color: inv.stock_quantity <= 3 ? '#f59e0b' : '#10b981' }}>
                                      Stock: {inv.stock_quantity}
                                    </span>
                                  </div>
                                </div>
                                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                                  {isClienteMayorista && inv.precio_mayorista != null ? (
                                    <>
                                      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#a5b4fc', fontFamily: 'monospace' }}>
                                        {fmtARS(Number(inv.precio_mayorista))}
                                      </div>
                                      <div style={{ fontSize: '0.65rem', color: '#475569', fontFamily: 'monospace', textDecoration: 'line-through' }}>
                                        {fmtARS(Number(inv.sale_price))}
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#34d399', fontFamily: 'monospace' }}>
                                        {fmtARS(Number(inv.sale_price))}
                                      </div>
                                      {isClienteMayorista && !inv.precio_mayorista && (
                                        <div style={{ fontSize: '0.65rem', color: '#f59e0b' }}>sin precio may.</div>
                                      )}
                                    </>
                                  )}
                                  {inv.base_currency === 'USD' && inv.base_price && !isClienteMayorista && (
                                    <div style={{ fontSize: '0.7rem', color: '#60a5fa', fontFamily: 'monospace' }}>
                                      USD {Number(inv.base_price).toFixed(2)}
                                    </div>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Cantidad */}
                      <input
                        type="number" value={l.cantidad} min="0.01" step="0.01"
                        onChange={e => updateLinea(l._key, { cantidad: Number(e.target.value) || 0 })}
                        style={{ ...inputS, padding: '0.4rem 0.5rem', textAlign: 'center', fontFamily: 'monospace', fontSize: '0.8rem' }}
                      />

                      {/* Precio */}
                      <div style={{ position: 'relative' }}>
                        <input
                          type="number" value={l.precio_unitario} min="0" step="0.01"
                          onChange={e => updateLinea(l._key, { precio_unitario: Number(e.target.value) || 0 })}
                          style={{ ...inputS, padding: '0.4rem 0.5rem', textAlign: 'right', fontFamily: 'monospace', fontSize: '0.8rem' }}
                        />
                        {/* Toggle ARS/USD */}
                        <div style={{
                          position: 'absolute', bottom: '-1.25rem', left: 0, right: 0,
                          display: 'flex', justifyContent: 'center', gap: '0.25rem',
                        }}>
                          {(['ARS','USD'] as const).map(c => (
                            <button
                              key={c}
                              onClick={() => {
                                if (c === l.currency) return;
                                const newPrice = c === 'USD' && l.inv_price_usd != null
                                  ? l.inv_price_usd
                                  : c === 'ARS' && l.inv_sale_price != null
                                    ? l.inv_sale_price
                                    : l.precio_unitario;
                                updateLinea(l._key, { currency: c, precio_unitario: newPrice });
                              }}
                              style={{
                                padding: '0.1rem 0.3rem',
                                backgroundColor: l.currency === c ? (c === 'USD' ? 'rgba(96,165,250,0.2)' : 'rgba(52,211,153,0.15)') : 'transparent',
                                border: `1px solid ${l.currency === c ? (c === 'USD' ? 'rgba(96,165,250,0.4)' : 'rgba(52,211,153,0.35)') : 'rgba(255,255,255,0.06)'}`,
                                borderRadius: '0.2rem',
                                color: l.currency === c ? (c === 'USD' ? '#60a5fa' : '#34d399') : '#475569',
                                fontSize: '0.6rem', fontWeight: 700, cursor: 'pointer',
                              }}
                            >{c}</button>
                          ))}
                        </div>
                      </div>

                      {/* Descuento % */}
                      <div style={{ position: 'relative' }}>
                        <Percent size={10} style={{ position: 'absolute', left: '0.4rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                        <input
                          type="number" value={l.descuento_linea || ''} min="0" max="100" step="0.1"
                          placeholder="0"
                          onChange={e => updateLinea(l._key, { descuento_linea: Math.min(100, Number(e.target.value) || 0) })}
                          style={{ ...inputS, padding: '0.4rem 0.5rem 0.4rem 1.2rem', textAlign: 'right', fontFamily: 'monospace', fontSize: '0.8rem' }}
                        />
                      </div>

                      {/* Costo */}
                      <input
                        type="number" value={l.costo_unitario || ''} min="0" step="0.01"
                        placeholder="0"
                        onChange={e => updateLinea(l._key, { costo_unitario: Number(e.target.value) || 0 })}
                        style={{ ...inputS, padding: '0.4rem 0.5rem', textAlign: 'right', fontFamily: 'monospace', fontSize: '0.8rem', color: '#94a3b8' }}
                      />

                      {/* Subtotal */}
                      <div style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 600, color: '#34d399', paddingRight: '0.25rem' }}>
                        {fmtARS(lineARS)}
                      </div>

                      {/* Eliminar */}
                      <button
                        onClick={() => setLineas(prev => prev.length > 1 ? prev.filter(x => x._key !== l._key) : prev)}
                        disabled={lineas.length === 1}
                        style={{ background: 'none', border: 'none', color: '#475569', cursor: lineas.length > 1 ? 'pointer' : 'not-allowed', opacity: lineas.length > 1 ? 1 : 0.3, padding: '0.25rem', borderRadius: '0.25rem', display: 'flex' }}
                        onMouseEnter={e => { if (lineas.length > 1) e.currentTarget.style.color = '#f87171'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = '#475569'; }}
                      >
                        <X size={14} />
                      </button>
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
                        El comprobante se enviará a AFIP para obtener CAE. Si ARCA falla, el comprobante se guardará como borrador.
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
