import { useState, useEffect, useRef, useCallback } from 'react';
import { X, FileText, Receipt, RotateCcw, CreditCard, ChevronRight, Loader2, Plus, Zap, Package, Search, DollarSign, RefreshCw } from 'lucide-react';
import { currencyService } from '../../services/currencyService';
import { TipoComprobante } from '../../hooks/useComprobantes';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';

interface InventoryResult {
  id: string;
  code: string;
  name: string;
  category: string;
  stock_quantity: number;
  sale_price: number;
  base_price?: number | null;   // precio en USD cuando base_currency='USD'
  base_currency?: string | null;
}

interface ClienteOption {
  id: string;
  name: string;
}

interface ModalCrearComprobanteProps {
  isOpen: boolean;
  onClose: () => void;
  onCrear: (data: {
    tipo: TipoComprobante;
    puntoVenta: string;
    condicionFiscal: string;
    clienteId: string | null;
    exchangeRate: number;
    items: {
      descripcion: string;
      cantidad: number;
      precio_unitario: number;
      currency: 'ARS' | 'USD';
      exchange_rate: number;
      inventory_id?: string;
    }[];
    esElectronica?: boolean;
  }) => void;
  loading?: boolean;
}

const tiposConfig: Record<TipoComprobante, { 
  label: string; 
  description: string; 
  icon: React.ElementType; 
  color: string;
  bgColor: string;
  borderColor: string;
  requiereCuit: boolean;
}> = {
  factura_a: {
    label: 'Factura A',
    description: 'Con IVA discriminado. Para Responsables Inscriptos.',
    icon: Receipt,
    color: '#6366f1',
    bgColor: 'rgba(99, 102, 241, 0.1)',
    borderColor: 'rgba(99, 102, 241, 0.3)',
    requiereCuit: true
  },
  factura_c: {
    label: 'Factura C',
    description: 'Sin IVA discriminado. Para Consumidor Final.',
    icon: FileText,
    color: '#10b981',
    bgColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
    requiereCuit: false
  },
  remito: {
    label: 'Remito',
    description: 'Documento de transporte. No afecta contabilidad.',
    icon: CreditCard,
    color: '#f59e0b',
    bgColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: 'rgba(245, 158, 11, 0.3)',
    requiereCuit: false
  },
  nota_credito: {
    label: 'Nota de Crédito',
    description: 'Para reversión o devolución.',
    icon: RotateCcw,
    color: '#ef4444',
    bgColor: 'rgba(239, 68, 68, 0.1)',
    borderColor: 'rgba(239, 68, 68, 0.3)',
    requiereCuit: true
  }
};

const condicionesFiscales = [
  'Responsable Inscripto',
  'Monotributo',
  'Exento',
  'Consumidor Final',
  'Responsable No Inscripto'
];

export function ModalCrearComprobante({
  isOpen,
  onClose,
  onCrear,
  loading = false
}: ModalCrearComprobanteProps) {
  const { businessId } = useAuth();
  const [step, setStep] = useState(1);
  const [tipo, setTipo] = useState<TipoComprobante>('factura_c');
  const [puntoVenta, setPuntoVenta] = useState('0001');
  const [condicionFiscal, setCondicionFiscal] = useState('Consumidor Final');
  const [clienteId, setClienteId] = useState('');
  const [clientes, setClientes] = useState<ClienteOption[]>([]);
  const [loadingClientes, setLoadingClientes] = useState(false);
  const [exchangeRate, setExchangeRate] = useState(1);
  const [loadingRate, setLoadingRate] = useState(false);
  const [items, setItems] = useState<{
    descripcion: string;
    cantidad: number;
    precio_unitario: number;
    currency: 'ARS' | 'USD';
    inventory_id?: string;
    // precios originales del inventario para el toggle ARS↔USD
    inv_sale_price?: number;
    inv_price_usd?: number | null;
  }[]>([
    { descripcion: '', cantidad: 1, precio_unitario: 0, currency: 'ARS' }
  ]);
  const [esElectronica, setEsElectronica] = useState(false);

  // Inventory search state
  const [searchResults, setSearchResults] = useState<InventoryResult[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState<number | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const dropdownRefs = useRef<(HTMLDivElement | null)[]>([]);

  const searchInventory = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    try {
      const { data } = await supabase
        .from('inventory')
        .select('id, code, name, category, stock_quantity, sale_price, base_price, base_currency')
        .eq('is_active', true)
        .or(`name.ilike.%${query}%,code.ilike.%${query}%,category.ilike.%${query}%`)
        .gt('stock_quantity', 0)
        .order('name')
        .limit(8);
      setSearchResults((data as InventoryResult[]) ?? []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  const handleDescripcionChange = (index: number, value: string) => {
    actualizarItem(index, 'descripcion', value);
    // Remove inventory link if user edits text manually
    if (items[index].inventory_id) {
      const newItems = [...items];
      newItems[index] = { ...newItems[index], inventory_id: undefined };
      setItems(newItems);
    }
    setActiveSearchIndex(index);

    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => searchInventory(value), 300);
  };

  const selectInventoryItem = (itemIndex: number, inv: InventoryResult) => {
    const salePrice = Number(inv.sale_price) || 0;
    // base_price es el precio en USD cuando base_currency='USD'
    const priceUsd = inv.base_currency === 'USD' && inv.base_price != null && Number(inv.base_price) > 0
      ? Number(inv.base_price)
      : null;
    // Moneda por defecto: USD si el producto es en USD y tiene base_price, ARS si no
    const defaultCurrency: 'ARS' | 'USD' = priceUsd != null ? 'USD' : 'ARS';
    const defaultPrice = defaultCurrency === 'USD' ? priceUsd! : salePrice;
    const newItems = [...items];
    newItems[itemIndex] = {
      ...newItems[itemIndex],
      descripcion: `${inv.name} (${inv.code})`,
      precio_unitario: defaultPrice,
      currency: defaultCurrency,
      inventory_id: inv.id,
      inv_sale_price: salePrice,
      inv_price_usd: priceUsd,
    };
    setItems(newItems);
    setActiveSearchIndex(null);
    setSearchResults([]);
  };

  const toggleItemCurrency = (index: number) => {
    const item = items[index];
    const newCurrency: 'ARS' | 'USD' = item.currency === 'USD' ? 'ARS' : 'USD';
    let newPrice = item.precio_unitario;
    if (item.inventory_id) {
      // Si viene del inventario, usar el precio correspondiente
      if (newCurrency === 'USD' && item.inv_price_usd != null) {
        newPrice = item.inv_price_usd;
      } else if (newCurrency === 'ARS' && item.inv_sale_price != null) {
        newPrice = item.inv_sale_price;
      }
      // Si no tiene precio para esa moneda, mantener el precio actual
    }
    const newItems = [...items];
    newItems[index] = { ...newItems[index], currency: newCurrency, precio_unitario: newPrice };
    setItems(newItems);
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (activeSearchIndex !== null) {
        const ref = dropdownRefs.current[activeSearchIndex];
        if (ref && !ref.contains(e.target as Node)) {
          setActiveSearchIndex(null);
          setSearchResults([]);
        }
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [activeSearchIndex]);

  // Load customers from Supabase
  useEffect(() => {
    if (!isOpen || !businessId) return;
    setLoadingClientes(true);
    supabase
      .from('customers')
      .select('id, name')
      .eq('business_id', businessId)
      .order('name')
      .then(({ data }) => {
        setClientes((data as ClienteOption[]) ?? []);
      })
      .finally(() => setLoadingClientes(false));
  }, [isOpen, businessId]);

  // Load exchange rate when modal opens
  useEffect(() => {
    if (!isOpen) return;
    setLoadingRate(true);
    currencyService.getCurrentExchangeRate('USD', 'ARS')
      .then(rate => setExchangeRate(rate || 1))
      .catch(() => setExchangeRate(1))
      .finally(() => setLoadingRate(false));
  }, [isOpen]);

  if (!isOpen) return null;

  const handleTipoSelect = (selected: TipoComprobante) => {
    setTipo(selected);
    
    if (selected === 'factura_a') {
      setCondicionFiscal('Responsable Inscripto');
    } else if (selected === 'factura_c') {
      setCondicionFiscal('Consumidor Final');
    }
    
    setStep(2);
  };

  const handleCrear = () => {
    const validItems = items.filter(item => item.descripcion.trim() && item.precio_unitario > 0);

    if (validItems.length === 0) {
      alert('Debes agregar al menos un item válido');
      return;
    }

    if (esElectronica && (tipo !== 'factura_a' && tipo !== 'factura_c')) {
      alert('Solo las facturas pueden emitirse electrónicamente');
      return;
    }

    onCrear({
      tipo,
      puntoVenta,
      condicionFiscal,
      clienteId: clienteId.trim() || null,
      exchangeRate,
      items: validItems.map(item => ({
        ...item,
        currency: item.currency || 'ARS',
        exchange_rate: exchangeRate,
      })),
      esElectronica
    });
  };

  const agregarItem = () => {
    setItems([...items, { descripcion: '', cantidad: 1, precio_unitario: 0, currency: 'ARS' }]);
  };

  const actualizarItem = (index: number, field: string, value: string | number) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], [field]: value };
    setItems(newItems);
  };

  const eliminarItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const calcularTotales = () => {
    let subtotalARS = 0;
    let subtotalUSD = 0;
    let hasARS = false;
    let hasUSD = false;
    for (const item of items) {
      const lineTotal = item.cantidad * item.precio_unitario;
      if ((item.currency || 'ARS') === 'USD') {
        subtotalUSD += lineTotal;
        // Solo convertir a ARS para el equivalente, no mezclar en el subtotal ARS puro
        hasUSD = true;
      } else {
        subtotalARS += lineTotal;
        hasARS = true;
      }
    }
    // Equivalente total en ARS (para validar cobertura)
    const totalEquivARS = subtotalARS + subtotalUSD * exchangeRate;
    const ivaARS = tipo === 'factura_a' ? subtotalARS * 0.21 : 0;
    const ivaUSD = tipo === 'factura_a' ? subtotalUSD * 0.21 : 0;
    return {
      subtotalARS,
      subtotalUSD,
      ivaARS,
      ivaUSD,
      totalARS: subtotalARS + ivaARS,
      totalUSD: subtotalUSD + ivaUSD,
      totalEquivARS: totalEquivARS + (tipo === 'factura_a' ? totalEquivARS * 0.21 : 0),
      hasARS,
      hasUSD,
      mixed: hasARS && hasUSD,
    };
  };

  const totales = calcularTotales();
  const fmtARS = (v: number) => `$${v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtUSD = (v: number) => `USD ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundColor: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 50,
      padding: '1rem'
    }}>
      <div style={{
        backgroundColor: '#0b1120',
        borderRadius: '1rem',
        border: '1px solid rgba(255,255,255,0.08)',
        width: '100%',
        maxWidth: '672px',
        maxHeight: '90vh',
        overflowY: 'auto',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '1.5rem',
          borderBottom: '1px solid rgba(255,255,255,0.08)'
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
              <div style={{
                width: '0.5rem',
                height: '0.5rem',
                borderRadius: '50%',
                backgroundColor: '#6366f1',
                animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
              }} />
              <span style={{
                fontSize: '0.75rem',
                color: '#818cf8',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                fontWeight: 500
              }}>
                {step === 1 ? 'Paso 1 de 2' : 'Paso 2 de 2'}
              </span>
            </div>
            <h2 style={{
              fontSize: '1.5rem',
              fontWeight: 700,
              color: '#f1f5f9',
              margin: 0
            }}>
              {step === 1 ? 'Crear Comprobante' : 'Configurar Detalles'}
            </h2>
            <p style={{
              fontSize: '0.875rem',
              color: '#64748b',
              marginTop: '0.25rem'
            }}>
              {step === 1 
                ? 'Selecciona el tipo de comprobante'
                : `Configurando ${tiposConfig[tipo].label} - PV ${puntoVenta}`
              }
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            style={{
              padding: '0.5rem',
              backgroundColor: 'transparent',
              border: 'none',
              color: '#64748b',
              borderRadius: '0.75rem',
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'all 0.3s ease'
            }}
            onMouseEnter={(e) => {
              if (!loading) {
                e.currentTarget.style.color = '#f1f5f9';
                e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#64748b';
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            <X style={{ width: '1.25rem', height: '1.25rem' }} />
          </button>
        </div>

        {/* Step 1: Selección de Tipo */}
        {step === 1 && (
          <div style={{ padding: '1.5rem' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '1rem'
            }}>
              {(Object.keys(tiposConfig) as TipoComprobante[]).map((tipoKey) => {
                const config = tiposConfig[tipoKey];
                const Icon = config.icon;
                const isSelected = tipo === tipoKey;

                return (
                  <button
                    key={tipoKey}
                    onClick={() => handleTipoSelect(tipoKey)}
                    style={{
                      position: 'relative',
                      padding: '1.25rem',
                      borderRadius: '1rem',
                      border: '2px solid',
                      backgroundColor: isSelected ? config.bgColor : 'rgba(11, 17, 32, 0.6)',
                      borderColor: isSelected ? config.borderColor : 'rgba(255,255,255,0.08)',
                      textAlign: 'left',
                      transition: 'all 0.3s ease',
                      cursor: 'pointer',
                      overflow: 'hidden'
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.backgroundColor = 'rgba(15, 23, 42, 0.8)';
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.backgroundColor = 'rgba(11, 17, 32, 0.6)';
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
                      }
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
                      <div style={{
                        width: '3rem',
                        height: '3rem',
                        borderRadius: '0.75rem',
                        backgroundColor: config.color,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.3)'
                      }}>
                        <Icon style={{ width: '1.5rem', height: '1.5rem', color: '#ffffff' }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <h3 style={{
                          fontSize: '1.125rem',
                          fontWeight: 700,
                          color: '#f1f5f9',
                          margin: 0
                        }}>
                          {config.label}
                        </h3>
                        <p style={{
                          fontSize: '0.875rem',
                          color: '#64748b',
                          marginTop: '0.25rem',
                          lineHeight: 1.5
                        }}>
                          {config.description}
                        </p>
                      </div>
                      {isSelected && (
                        <div style={{
                          position: 'absolute',
                          top: 0,
                          right: 0,
                          width: '2rem',
                          height: '2rem',
                          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                          borderBottomLeftRadius: '1rem',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}>
                          <ChevronRight style={{ width: '1rem', height: '1rem', color: '#ffffff' }} />
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 2: Configuración */}
        {step === 2 && (
          <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Cliente */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: '#94a3b8',
                textTransform: 'uppercase' as const,
                letterSpacing: '0.04em',
                marginBottom: '0.5rem'
              }}>
                Cliente
              </label>
              <select
                value={clienteId}
                onChange={(e) => setClienteId(e.target.value)}
                disabled={loadingClientes}
                style={{
                  width: '100%',
                  padding: '0.75rem 1rem',
                  backgroundColor: 'rgba(15,23,42,0.8)',
                  border: '1px solid rgba(51,65,85,0.6)',
                  borderRadius: '0.5rem',
                  color: clienteId ? '#f1f5f9' : '#64748b',
                  outline: 'none'
                }}
              >
                <option value="">Consumidor Final (predeterminado)</option>
                {clientes.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            {/* Punto de Venta */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: '#94a3b8',
                textTransform: 'uppercase' as const,
                letterSpacing: '0.04em',
                marginBottom: '0.5rem'
              }}>
                Punto de Venta
              </label>
              <input
                type="text"
                value={puntoVenta}
                onChange={(e) => setPuntoVenta(e.target.value.replace(/\D/g, '').slice(0, 5))}
                placeholder="0001"
                maxLength={5}
                style={{
                  width: '100%',
                  maxWidth: '192px',
                  padding: '0.75rem 1rem',
                  backgroundColor: 'rgba(15,23,42,0.8)',
                  border: '1px solid rgba(51,65,85,0.6)',
                  borderRadius: '0.5rem',
                  color: '#f1f5f9',
                  fontFamily: 'monospace',
                  fontSize: '1.125rem',
                  letterSpacing: '0.05em',
                  outline: 'none'
                }}
              />
              <p style={{
                fontSize: '0.75rem',
                color: '#64748b',
                marginTop: '0.5rem'
              }}>
                Número de punto de venta habilitado en AFIP
              </p>
            </div>

            {/* Condición Fiscal */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: '#94a3b8',
                textTransform: 'uppercase' as const,
                letterSpacing: '0.04em',
                marginBottom: '0.5rem'
              }}>
                Condición Fiscal del Cliente
              </label>
              <select
                value={condicionFiscal}
                onChange={(e) => setCondicionFiscal(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.75rem 1rem',
                  backgroundColor: 'rgba(15,23,42,0.8)',
                  border: '1px solid rgba(51,65,85,0.6)',
                  borderRadius: '0.5rem',
                  color: '#f1f5f9',
                  outline: 'none'
                }}
              >
                {condicionesFiscales.map((cond) => (
                  <option key={cond} value={cond}>{cond}</option>
                ))}
              </select>
            </div>

            {/* Emisión Electrónica */}
            {(tipo === 'factura_a' || tipo === 'factura_c') && (
              <div style={{
                padding: '1rem',
                borderRadius: '0.75rem',
                backgroundColor: 'rgba(99, 102, 241, 0.05)',
                border: '1px solid rgba(99, 102, 241, 0.2)'
              }}>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  cursor: 'pointer'
                }}>
              <input
                type="checkbox"
                checked={esElectronica}
                onChange={(e) => setEsElectronica(e.target.checked)}
                style={{
                  width: '1.25rem',
                  height: '1.25rem',
                  cursor: 'pointer',
                  accentColor: '#6366f1'
                }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <Zap style={{ width: '1rem', height: '1rem', color: '#818cf8' }} />
                  <span style={{ fontSize: '0.875rem', color: '#f1f5f9', fontWeight: 600 }}>
                    Emitir electrónicamente via ARCA
                  </span>
                </div>
                <p style={{
                  fontSize: '0.75rem',
                  color: '#64748b',
                  margin: 0,
                  marginLeft: '1.5rem'
                }}>
                  El comprobante se enviará a AFIP para obtener CAE
                </p>
              </div>
            </label>
              </div>
            )}

            {/* Items */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <label style={{
                  display: 'block',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  color: '#94a3b8',
                  textTransform: 'uppercase' as const,
                  letterSpacing: '0.04em'
                }}>
                  Items <span style={{ color: '#818cf8' }}>*</span>
                </label>
                <button
                  onClick={agregarItem}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.375rem',
                    padding: '0.375rem 0.75rem',
                    backgroundColor: 'rgba(99, 102, 241, 0.1)',
                    border: '1px solid rgba(99, 102, 241, 0.3)',
                    color: '#818cf8',
                    borderRadius: '0.5rem',
                    fontSize: '0.875rem',
                    cursor: 'pointer',
                    transition: 'all 0.3s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'rgba(99, 102, 241, 0.2)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'rgba(99, 102, 241, 0.1)';
                  }}
                >
                  <Plus style={{ width: '1rem', height: '1rem' }} />
                  Agregar Item
                </button>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {items.map((item, index) => (
                  <div key={index} style={{
                    display: 'flex',
                    gap: '0.5rem',
                    alignItems: 'center',
                    padding: '0.5rem',
                    borderRadius: '0.75rem',
                    backgroundColor: '#0f1829',
                    border: '1px solid rgba(255,255,255,0.06)'
                  }}>
                    {/* Description with inventory search */}
                    <div
                      ref={el => { dropdownRefs.current[index] = el; }}
                      style={{ flex: 1, position: 'relative' }}
                    >
                      <div style={{ position: 'relative' }}>
                        <Search style={{
                          position: 'absolute',
                          left: '0.5rem',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          width: '0.875rem',
                          height: '0.875rem',
                          color: item.inventory_id ? '#10b981' : '#475569',
                          pointerEvents: 'none'
                        }} />
                        <input
                          type="text"
                          value={item.descripcion}
                          onChange={(e) => handleDescripcionChange(index, e.target.value)}
                          onFocus={() => {
                            if (item.descripcion.length >= 2) {
                              setActiveSearchIndex(index);
                              searchInventory(item.descripcion);
                            }
                          }}
                          placeholder="Buscar producto o escribir..."
                          style={{
                            width: '100%',
                            padding: '0.5rem 0.75rem 0.5rem 1.75rem',
                            backgroundColor: 'transparent',
                            border: `1px solid ${item.inventory_id ? 'rgba(16, 185, 129, 0.4)' : 'rgba(51,65,85,0.6)'}`,
                            borderRadius: '0.5rem',
                            color: '#f1f5f9',
                            fontSize: '0.875rem',
                            outline: 'none'
                          }}
                        />
                        {item.inventory_id && (
                          <Package style={{
                            position: 'absolute',
                            right: '0.5rem',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            width: '0.875rem',
                            height: '0.875rem',
                            color: '#10b981',
                            pointerEvents: 'none'
                          }} />
                        )}
                      </div>

                      {/* Search dropdown */}
                      {activeSearchIndex === index && (searchResults.length > 0 || searchLoading) && (
                        <div style={{
                          position: 'absolute',
                          top: 'calc(100% + 4px)',
                          left: 0,
                          right: 0,
                          backgroundColor: '#0b1120',
                          border: '1px solid rgba(99, 102, 241, 0.3)',
                          borderRadius: '0.75rem',
                          zIndex: 100,
                          maxHeight: '240px',
                          overflowY: 'auto',
                          boxShadow: '0 20px 40px rgba(0,0,0,0.5)'
                        }}>
                          {searchLoading ? (
                            <div style={{
                              padding: '1rem',
                              textAlign: 'center',
                              color: '#64748b',
                              fontSize: '0.8rem',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '0.5rem'
                            }}>
                              <Loader2 style={{ width: '0.875rem', height: '0.875rem', animation: 'spin 1s linear infinite' }} />
                              Buscando...
                            </div>
                          ) : (
                            searchResults.map((inv) => (
                              <button
                                key={inv.id}
                                onClick={() => selectInventoryItem(index, inv)}
                                style={{
                                  width: '100%',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  padding: '0.625rem 0.75rem',
                                  backgroundColor: 'transparent',
                                  border: 'none',
                                  borderBottom: '1px solid rgba(51, 65, 85, 0.2)',
                                  color: '#f1f5f9',
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  transition: 'background-color 0.15s ease'
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.backgroundColor = 'rgba(99, 102, 241, 0.1)';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.backgroundColor = 'transparent';
                                }}
                              >
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{
                                    fontSize: '0.8rem',
                                    fontWeight: 500,
                                    color: '#e2e8f0',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                  }}>
                                    {inv.name}
                                  </div>
                                  <div style={{
                                    fontSize: '0.7rem',
                                    color: '#64748b',
                                    marginTop: '0.125rem',
                                    display: 'flex',
                                    gap: '0.5rem'
                                  }}>
                                    <span>#{inv.code}</span>
                                    <span>{inv.category}</span>
                                    <span style={{
                                      color: inv.stock_quantity <= 3 ? '#f59e0b' : '#10b981'
                                    }}>
                                      Stock: {inv.stock_quantity}
                                    </span>
                                  </div>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginLeft: '0.75rem', gap: '0.1rem' }}>
                                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#34d399', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                                    ${Number(inv.sale_price).toLocaleString('es-AR')}
                                  </span>
                                  {inv.base_currency === 'USD' && inv.base_price != null && Number(inv.base_price) > 0 && (
                                    <span style={{ fontSize: '0.7rem', fontWeight: 500, color: '#60a5fa', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                                      USD {Number(inv.base_price).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                    </span>
                                  )}
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>

                    <input
                      type="number"
                      value={item.cantidad}
                      onChange={(e) => actualizarItem(index, 'cantidad', Number(e.target.value))}
                      placeholder="Cant."
                      min="0.01"
                      step="0.01"
                      style={{
                        width: '72px',
                        padding: '0.5rem 0.75rem',
                        backgroundColor: 'transparent',
                        border: '1px solid rgba(51,65,85,0.6)',
                        borderRadius: '0.5rem',
                        color: '#f1f5f9',
                        fontSize: '0.875rem',
                        textAlign: 'center',
                        outline: 'none'
                      }}
                    />
                    {/* Currency toggle — dos botones ARS / USD */}
                    {(() => {
                      const hasInvUSD = item.inventory_id ? item.inv_price_usd != null : true;
                      const isARS = (item.currency || 'ARS') === 'ARS';
                      return (
                        <div style={{ display: 'flex', borderRadius: '0.5rem', overflow: 'hidden', border: '1px solid rgba(51,65,85,0.5)', flexShrink: 0 }}>
                          <button
                            type="button"
                            onClick={() => { if (!isARS) toggleItemCurrency(index); }}
                            title="Cobrar en pesos ARS"
                            style={{
                              padding: '0.4rem 0.5rem',
                              backgroundColor: isARS ? 'rgba(16,185,129,0.2)' : 'transparent',
                              border: 'none',
                              borderRight: '1px solid rgba(51,65,85,0.5)',
                              color: isARS ? '#34d399' : '#475569',
                              fontSize: '0.65rem',
                              fontWeight: 700,
                              cursor: isARS ? 'default' : 'pointer',
                              letterSpacing: '0.03em'
                            }}
                          >ARS</button>
                          <button
                            type="button"
                            onClick={() => { if (isARS && hasInvUSD) toggleItemCurrency(index); }}
                            title={hasInvUSD ? 'Cobrar en dólares USD' : 'Sin precio USD en inventario'}
                            style={{
                              padding: '0.4rem 0.5rem',
                              backgroundColor: !isARS ? 'rgba(59,130,246,0.2)' : 'transparent',
                              border: 'none',
                              color: !isARS ? '#60a5fa' : hasInvUSD ? '#475569' : '#334155',
                              fontSize: '0.65rem',
                              fontWeight: 700,
                              cursor: isARS && hasInvUSD ? 'pointer' : isARS ? 'not-allowed' : 'default',
                              letterSpacing: '0.03em',
                              opacity: isARS && !hasInvUSD ? 0.4 : 1
                            }}
                          >USD</button>
                        </div>
                      );
                    })()}
                    <input
                      type="number"
                      value={item.precio_unitario}
                      onChange={(e) => actualizarItem(index, 'precio_unitario', Number(e.target.value))}
                      placeholder="0.00"
                      min="0"
                      step="0.01"
                      style={{
                        width: '100px',
                        padding: '0.5rem 0.75rem',
                        backgroundColor: 'transparent',
                        border: '1px solid rgba(51,65,85,0.6)',
                        borderRadius: '0.5rem',
                        color: '#f1f5f9',
                        fontSize: '0.875rem',
                        textAlign: 'right',
                        fontFamily: 'monospace',
                        outline: 'none'
                      }}
                    />
                    <button
                      onClick={() => eliminarItem(index)}
                      disabled={items.length === 1}
                      style={{
                        padding: '0.5rem',
                        backgroundColor: 'transparent',
                        border: 'none',
                        color: '#64748b',
                        borderRadius: '0.5rem',
                        cursor: items.length === 1 ? 'not-allowed' : 'pointer',
                        transition: 'all 0.3s ease',
                        opacity: items.length === 1 ? 0.3 : 1
                      }}
                      onMouseEnter={(e) => {
                        if (items.length > 1) {
                          e.currentTarget.style.color = '#f87171';
                          e.currentTarget.style.backgroundColor = 'rgba(248, 113, 113, 0.1)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = '#64748b';
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                    >
                      <X style={{ width: '1rem', height: '1rem' }} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Tipo de cambio */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.75rem 1rem',
              borderRadius: '0.75rem',
              backgroundColor: 'rgba(59,130,246,0.07)',
              border: '1px solid rgba(59,130,246,0.2)'
            }}>
              <DollarSign size={16} style={{ color: '#60a5fa', flexShrink: 0 }} />
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', flex: 1 }}>Tipo de cambio USD/ARS</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="number"
                  value={exchangeRate}
                  min="1"
                  step="0.01"
                  onChange={(e) => setExchangeRate(Number(e.target.value) || 1)}
                  style={{
                    width: '100px',
                    padding: '0.375rem 0.5rem',
                    backgroundColor: 'rgba(15,23,42,0.8)',
                    border: '1px solid rgba(59,130,246,0.3)',
                    borderRadius: '0.375rem',
                    color: '#60a5fa',
                    fontSize: '0.875rem',
                    fontFamily: 'monospace',
                    textAlign: 'right',
                    outline: 'none'
                  }}
                />
                {loadingRate && <RefreshCw size={14} style={{ color: '#60a5fa', animation: 'spin 1s linear infinite' }} />}
              </div>
            </div>

            {/* Totales Card */}
            <div style={{
              position: 'relative',
              padding: '1.25rem',
              borderRadius: '0.75rem',
              backgroundColor: '#0f1829',
              border: '1px solid rgba(255,255,255,0.06)',
              overflow: 'hidden'
            }}>
              <h4 style={{
                fontSize: '0.875rem',
                fontWeight: 700,
                color: '#f1f5f9',
                marginBottom: '1rem'
              }}>
                Resumen del Comprobante
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {/* Subtotales — solo mostrar monedas usadas */}
                {totales.hasARS && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.875rem' }}>
                    <span style={{ color: '#64748b' }}>Subtotal ARS</span>
                    <span style={{ color: '#34d399', fontFamily: 'monospace' }}>{fmtARS(totales.subtotalARS)}</span>
                  </div>
                )}
                {totales.hasUSD && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.875rem' }}>
                    <span style={{ color: '#64748b' }}>Subtotal USD</span>
                    <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{fmtUSD(totales.subtotalUSD)}</span>
                  </div>
                )}

                {/* IVA solo para factura_a */}
                {tipo === 'factura_a' && totales.hasARS && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.875rem' }}>
                    <span style={{ color: '#64748b' }}>IVA 21% ARS</span>
                    <span style={{ color: '#818cf8', fontFamily: 'monospace' }}>{fmtARS(totales.ivaARS)}</span>
                  </div>
                )}
                {tipo === 'factura_a' && totales.hasUSD && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.875rem' }}>
                    <span style={{ color: '#64748b' }}>IVA 21% USD</span>
                    <span style={{ color: '#818cf8', fontFamily: 'monospace' }}>{fmtUSD(totales.ivaUSD)}</span>
                  </div>
                )}

                {/* Totales finales */}
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {totales.hasARS && !totales.mixed && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#94a3b8', fontWeight: 600 }}>Total</span>
                      <span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#34d399', fontFamily: 'monospace' }}>
                        {fmtARS(totales.totalARS)}
                      </span>
                    </div>
                  )}
                  {totales.hasUSD && !totales.mixed && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#94a3b8', fontWeight: 600 }}>Total</span>
                      <span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#60a5fa', fontFamily: 'monospace' }}>
                        {fmtUSD(totales.totalUSD)}
                      </span>
                    </div>
                  )}
                  {/* Mixto: mostrar ambos + equivalente */}
                  {totales.mixed && (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.875rem' }}>
                        <span style={{ color: '#94a3b8', fontWeight: 500 }}>Total ARS</span>
                        <span style={{ fontWeight: 700, color: '#34d399', fontFamily: 'monospace' }}>{fmtARS(totales.totalARS)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.875rem' }}>
                        <span style={{ color: '#94a3b8', fontWeight: 500 }}>Total USD</span>
                        <span style={{ fontWeight: 700, color: '#60a5fa', fontFamily: 'monospace' }}>{fmtUSD(totales.totalUSD)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.375rem', borderTop: '1px dashed rgba(255,255,255,0.06)' }}>
                        <span style={{ color: '#94a3b8', fontWeight: 600, fontSize: '0.875rem' }}>Equivalente ARS</span>
                        <span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#818cf8', fontFamily: 'monospace' }}>
                          {fmtARS(totales.totalEquivARS)}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Botones */}
            <div style={{ display: 'flex', gap: '0.75rem', paddingTop: '0.5rem' }}>
              <button
                onClick={() => setStep(1)}
                disabled={loading}
                style={{
                  padding: '0.75rem 1.25rem',
                  color: '#94a3b8',
                  backgroundColor: 'transparent',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '0.625rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  transition: 'all 0.3s ease',
                  fontSize: '0.875rem',
                  opacity: loading ? 0.5 : 1
                }}
                onMouseEnter={(e) => {
                  if (!loading) {
                    e.currentTarget.style.color = '#f1f5f9';
                    e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = '#94a3b8';
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                Volver
              </button>
              <button
                onClick={handleCrear}
                disabled={loading}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  padding: '0.75rem 1.5rem',
                  background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.625rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  transition: 'all 0.3s ease',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
                  opacity: loading ? 0.5 : 1
                }}
                onMouseEnter={(e) => {
                  if (!loading) {
                    e.currentTarget.style.background = 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)'; // darker hover
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)';
                }}
              >
                {loading ? (
                  <>
                    <Loader2 style={{ width: '1.25rem', height: '1.25rem', animation: 'spin 1s linear infinite' }} />
                    Creando...
                  </>
                ) : (
                  <>
                    <Receipt style={{ width: '1.25rem', height: '1.25rem' }} />
                    Crear Comprobante
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
      
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
