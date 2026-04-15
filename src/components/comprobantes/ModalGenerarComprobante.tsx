import { useState } from 'react';
import { X, FileText, Receipt, RotateCcw, Truck, ArrowRight, Loader2, Sparkles } from 'lucide-react';
import { TipoComprobante } from '../../hooks/useComprobantes';

interface ModalGenerarComprobanteProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerar: (data: {
    tipo: TipoComprobante;
    puntoVenta: string;
    condicionFiscal: string;
  }) => void;
  orderData?: {
    orderId: string;
    customerId: string;
    customerName: string;
    customerCuit?: string;
    total: number;
    items: {
      descripcion: string;
      cantidad: number;
      precio: number;
      inventory_id?: string;
    }[];
  } | null;
  loading?: boolean;
}

const tiposConfig: Record<TipoComprobante, {
  label: string;
  description: string;
  icon: React.ElementType;
  color: string;
  bgColor: string;
  borderColor: string;
  glowColor: string;
  gradientFrom: string;
  gradientTo: string;
  requiereCuit: boolean;
}> = {
  factura_a: {
    label: 'Factura A',
    description: 'Para Responsables Inscriptos. Discrimina IVA.',
    icon: Receipt,
    color: '#60a5fa',
    bgColor: 'rgba(59, 130, 246, 0.12)',
    borderColor: 'rgba(59, 130, 246, 0.3)',
    glowColor: 'rgba(59, 130, 246, 0.25)',
    gradientFrom: 'rgba(59, 130, 246, 0.2)',
    gradientTo: 'rgba(96, 165, 250, 0.05)',
    requiereCuit: true
  },
  factura_c: {
    label: 'Factura C',
    description: 'Para Consumidor Final. Sin IVA discriminado.',
    icon: FileText,
    color: '#34d399',
    bgColor: 'rgba(16, 185, 129, 0.12)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
    glowColor: 'rgba(16, 185, 129, 0.25)',
    gradientFrom: 'rgba(16, 185, 129, 0.2)',
    gradientTo: 'rgba(52, 211, 153, 0.05)',
    requiereCuit: false
  },
  remito: {
    label: 'Remito',
    description: 'Documento de transporte. No afecta contabilidad.',
    icon: Truck,
    color: '#fbbf24',
    bgColor: 'rgba(245, 158, 11, 0.12)',
    borderColor: 'rgba(245, 158, 11, 0.3)',
    glowColor: 'rgba(245, 158, 11, 0.25)',
    gradientFrom: 'rgba(245, 158, 11, 0.2)',
    gradientTo: 'rgba(251, 191, 36, 0.05)',
    requiereCuit: false
  },
  nota_credito: {
    label: 'Nota de Crédito',
    description: 'Para reversión o devolución de comprobantes.',
    icon: RotateCcw,
    color: '#f87171',
    bgColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'rgba(239, 68, 68, 0.3)',
    glowColor: 'rgba(239, 68, 68, 0.25)',
    gradientFrom: 'rgba(239, 68, 68, 0.2)',
    gradientTo: 'rgba(248, 113, 113, 0.05)',
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

export function ModalGenerarComprobante({
  isOpen,
  onClose,
  onGenerar,
  orderData,
  loading = false
}: ModalGenerarComprobanteProps) {
  const [step, setStep] = useState(1);
  const [tipo, setTipo] = useState<TipoComprobante>('factura_c');
  const [puntoVenta, setPuntoVenta] = useState('0001');
  const [condicionFiscal, setCondicionFiscal] = useState('Consumidor Final');

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

  const handleGenerar = () => {
    onGenerar({
      tipo,
      puntoVenta,
      condicionFiscal
    });
  };

  const tipoConfig = tiposConfig[tipo];
  const tieneCuit = orderData?.customerCuit && orderData.customerCuit.length > 0;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'radial-gradient(circle at center, rgba(0, 0, 0, 0.6) 0%, rgba(0, 0, 0, 0.85) 100%)',
      backdropFilter: 'blur(12px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 50,
      padding: '2rem',
      animation: 'fadeIn 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
    }}>
      <div style={{
        background: 'linear-gradient(145deg, rgba(15, 23, 42, 0.98) 0%, rgba(30, 41, 59, 0.95) 100%)',
        backdropFilter: 'blur(24px)',
        borderRadius: '1.5rem',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: `
          0 0 0 1px rgba(255,255,255,0.05),
          0 30px 60px -15px rgba(0, 0, 0, 0.6),
          0 0 0 0 rgba(79, 70, 229, 0)
        `,
        width: '100%',
        maxWidth: '960px',
        maxHeight: '90vh',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        animation: 'scaleIn 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '2rem 2.5rem',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, transparent 100%)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
          backdropFilter: 'blur(20px)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
            <div style={{
              width: '3rem',
              height: '3rem',
              borderRadius: '0.875rem',
              background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #8b5cf6 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: `
                0 0 0 1px rgba(255,255,255,0.1),
                0 8px 24px rgba(79, 70, 229, 0.4),
                inset 0 1px 0 rgba(255,255,255,0.2)
              `,
              position: 'relative'
            }}>
              <div style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '0.875rem',
                background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.2) 0%, transparent 50%)'
              }} />
              <Sparkles size={22} style={{ color: '#ffffff', position: 'relative', zIndex: 1 }} />
            </div>
            <div>
              <h2 style={{
                fontSize: '1.5rem',
                fontWeight: 700,
                color: '#ffffff',
                margin: 0,
                letterSpacing: '-0.03em',
                textShadow: '0 0 30px rgba(255,255,255,0.1)'
              }}>
                {step === 1 ? 'Generar Comprobante' : 'Configurar Comprobante'}
              </h2>
              <p style={{
                fontSize: '0.875rem',
                color: '#94a3b8',
                margin: '0.375rem 0 0 0',
                fontWeight: 400,
                letterSpacing: '0.01em'
              }}>
                {step === 1 
                  ? 'Selecciona el tipo de comprobante a emitir'
                  : `Punto de venta ${puntoVenta} • ${tipoConfig.label}`
                }
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            style={{
              width: '2.75rem',
              height: '2.75rem',
              borderRadius: '0.75rem',
              background: 'linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#94a3b8',
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
              position: 'relative',
              overflow: 'hidden'
            }}
            onMouseEnter={(e) => {
              if (!loading) {
                e.currentTarget.style.background = 'linear-gradient(145deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)';
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)';
                e.currentTarget.style.color = '#ffffff';
                e.currentTarget.style.transform = 'scale(1.08) rotate(90deg)';
                e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.3)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
              e.currentTarget.style.color = '#94a3b8';
              e.currentTarget.style.transform = 'scale(1) rotate(0deg)';
              e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
            }}
          >
            <X size={20} style={{ position: 'relative', zIndex: 1 }} />
          </button>
        </div>

        {/* Step 1: Selección de Tipo */}
        {step === 1 && (
          <div style={{ padding: '2.5rem' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
              gap: '1.25rem'
            }}>
              {(Object.keys(tiposConfig) as TipoComprobante[]).map((tipoKey) => {
                const config = tiposConfig[tipoKey];
                const Icon = config.icon;
                const puedeSeleccionar = !config.requiereCuit || tieneCuit;
                const isSelected = tipo === tipoKey;

                return (
                  <button
                    key={tipoKey}
                    onClick={() => puedeSeleccionar && handleTipoSelect(tipoKey)}
                    disabled={!puedeSeleccionar}
                    style={{
                      position: 'relative',
                      padding: '1.75rem',
                      borderRadius: '1.25rem',
                      border: '2px solid',
                      background: isSelected 
                        ? `linear-gradient(145deg, ${config.gradientFrom} 0%, ${config.gradientTo} 100%)`
                        : 'linear-gradient(145deg, rgba(15, 23, 42, 0.8) 0%, rgba(30, 41, 59, 0.6) 100%)',
                      borderColor: isSelected ? config.borderColor : 'rgba(255,255,255,0.08)',
                      textAlign: 'left',
                      transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
                      cursor: puedeSeleccionar ? 'pointer' : 'not-allowed',
                      opacity: puedeSeleccionar ? 1 : 0.35,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '1.25rem',
                      backdropFilter: 'blur(12px)',
                      boxShadow: isSelected 
                        ? `
                          0 0 0 1px ${config.borderColor},
                          0 0 60px ${config.glowColor},
                          0 8px 32px rgba(0,0,0,0.4),
                          inset 0 1px 0 rgba(255,255,255,0.1)
                        `
                        : `
                          0 2px 8px rgba(0,0,0,0.3),
                          inset 0 1px 0 rgba(255,255,255,0.05)
                        `
                    }}
                    onMouseEnter={(e) => {
                      if (puedeSeleccionar && !isSelected) {
                        e.currentTarget.style.background = 'linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)';
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)';
                        e.currentTarget.style.transform = 'translateY(-4px) scale(1.02)';
                        e.currentTarget.style.boxShadow = `
                          0 12px 40px rgba(0,0,0,0.5),
                          0 0 0 1px rgba(255,255,255,0.1),
                          inset 0 1px 0 rgba(255,255,255,0.1)
                        `;
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.background = 'linear-gradient(145deg, rgba(15, 23, 42, 0.8) 0%, rgba(30, 41, 59, 0.6) 100%)';
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
                        e.currentTarget.style.transform = 'translateY(0) scale(1)';
                        e.currentTarget.style.boxShadow = `
                          0 2px 8px rgba(0,0,0,0.3),
                          inset 0 1px 0 rgba(255,255,255,0.05)
                        `;
                      }
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1.25rem' }}>
                      <div style={{
                        width: '3.25rem',
                        height: '3.25rem',
                        borderRadius: '0.875rem',
                        background: `linear-gradient(135deg, ${config.gradientFrom} 0%, ${config.gradientTo} 100%)`,
                        border: `1px solid ${config.borderColor}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        boxShadow: `
                          0 0 30px ${config.glowColor},
                          inset 0 1px 0 rgba(255,255,255,0.2)
                        `,
                        position: 'relative'
                      }}>
                        <div style={{
                          position: 'absolute',
                          inset: 0,
                          borderRadius: '0.875rem',
                          background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.2) 0%, transparent 60%)'
                        }} />
                        <Icon size={24} style={{ color: config.color, position: 'relative', zIndex: 1 }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <h3 style={{ 
                          fontSize: '1.125rem', 
                          fontWeight: 600, 
                          color: '#ffffff', 
                          margin: 0,
                          letterSpacing: '-0.03em',
                          textShadow: '0 0 20px rgba(255,255,255,0.1)'
                        }}>
                          {config.label}
                        </h3>
                        <p style={{ 
                          fontSize: '0.875rem', 
                          color: '#94a3b8', 
                          margin: '0.625rem 0 0 0',
                          lineHeight: 1.6,
                          fontWeight: 400
                        }}>
                          {config.description}
                        </p>
                      </div>
                      {isSelected && (
                        <div style={{
                          position: 'absolute',
                          top: '1.5rem',
                          right: '1.5rem',
                          width: '1.75rem',
                          height: '1.75rem',
                          borderRadius: '50%',
                          background: `linear-gradient(135deg, ${config.color} 0%, ${config.borderColor} 100%)`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          boxShadow: `
                            0 0 20px ${config.glowColor},
                            0 0 0 2px rgba(255,255,255,0.1)
                          `,
                          animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
                        }}>
                          <ArrowRight size={16} style={{ color: '#ffffff', strokeWidth: 3 }} />
                        </div>
                      )}
                    </div>
                    {!puedeSeleccionar && (
                      <div style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.625rem 1rem',
                        background: 'linear-gradient(145deg, rgba(245, 158, 11, 0.15) 0%, rgba(245, 158, 11, 0.05) 100%)',
                        border: '1px solid rgba(245, 158, 11, 0.25)',
                        borderRadius: '0.625rem',
                        alignSelf: 'flex-start',
                        width: 'fit-content',
                        backdropFilter: 'blur(8px)'
                      }}>
                        <span style={{ 
                          fontSize: '0.8125rem', 
                          color: '#fbbf24', 
                          margin: 0,
                          fontWeight: 500,
                          letterSpacing: '0.01em'
                        }}>
                          Requiere CUIT del cliente
                        </span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 2: Configuración */}
        {step === 2 && (
          <div style={{ padding: '2.5rem', display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
            {/* Info del cliente */}
            <div style={{
              padding: '1.5rem',
              background: 'linear-gradient(145deg, rgba(15, 23, 42, 0.7) 0%, rgba(30, 41, 59, 0.5) 100%)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '1rem',
              backdropFilter: 'blur(12px)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)'
            }}>
              <h4 style={{ 
                fontSize: '0.8125rem', 
                fontWeight: 500, 
                color: '#94a3b8', 
                margin: '0 0 0.875rem 0',
                textTransform: 'uppercase',
                letterSpacing: '0.08em'
              }}>
                Cliente
              </h4>
              <p style={{ color: '#ffffff', fontWeight: 600, margin: 0, fontSize: '1.0625rem', letterSpacing: '-0.01em' }}>
                {orderData?.customerName}
              </p>
              {orderData?.customerCuit && (
                <p style={{ fontSize: '0.875rem', color: '#64748b', margin: '0.5rem 0 0 0' }}>
                  CUIT: {orderData.customerCuit}
                </p>
              )}
            </div>

            {/* Punto de Venta */}
            <div>
              <label style={{ 
                display: 'block', 
                fontSize: '0.8125rem', 
                fontWeight: 500, 
                color: '#94a3b8', 
                marginBottom: '0.75rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em'
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
                  maxWidth: '200px',
                  padding: '0.875rem 1.125rem',
                  background: 'linear-gradient(145deg, rgba(15, 23, 42, 0.7) 0%, rgba(30, 41, 59, 0.5) 100%)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '0.75rem',
                  color: '#ffffff',
                  fontFamily: 'monospace',
                  fontSize: '1.0625rem',
                  outline: 'none',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                  backdropFilter: 'blur(12px)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)'
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = '#4f46e5';
                  e.currentTarget.style.boxShadow = '0 0 0 3px rgba(79, 70, 229, 0.15), 0 0 20px rgba(79, 70, 229, 0.2)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
                  e.currentTarget.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.05)';
                }}
              />
              <p style={{ 
                fontSize: '0.8125rem', 
                color: '#64748b', 
                marginTop: '0.625rem',
                margin: '0.625rem 0 0 0'
              }}>
                Número de punto de venta habilitado en AFIP
              </p>
            </div>

            {/* Condición Fiscal */}
            <div>
              <label style={{ 
                display: 'block', 
                fontSize: '0.8125rem', 
                fontWeight: 500, 
                color: '#94a3b8', 
                marginBottom: '0.75rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em'
              }}>
                Condición Fiscal del Cliente
              </label>
              <select
                value={condicionFiscal}
                onChange={(e) => setCondicionFiscal(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.875rem 1.125rem',
                  background: 'linear-gradient(145deg, rgba(15, 23, 42, 0.7) 0%, rgba(30, 41, 59, 0.5) 100%)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '0.75rem',
                  color: '#ffffff',
                  fontSize: '1rem',
                  outline: 'none',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                  backdropFilter: 'blur(12px)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)'
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = '#4f46e5';
                  e.currentTarget.style.boxShadow = '0 0 0 3px rgba(79, 70, 229, 0.15), 0 0 20px rgba(79, 70, 229, 0.2)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
                  e.currentTarget.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.05)';
                }}
              >
                {condicionesFiscales.map((cond) => (
                  <option key={cond} value={cond}>{cond}</option>
                ))}
              </select>
            </div>

            {/* Resumen de items */}
            <div>
              <label style={{ 
                display: 'block', 
                fontSize: '0.8125rem', 
                fontWeight: 500, 
                color: '#94a3b8', 
                marginBottom: '0.75rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em'
              }}>
                Items a incluir ({orderData?.items.length || 0})
              </label>
              <div style={{
                maxHeight: '11rem',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.625rem',
                background: 'linear-gradient(145deg, rgba(15, 23, 42, 0.5) 0%, rgba(30, 41, 59, 0.3) 100%)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '0.75rem',
                padding: '1rem',
                backdropFilter: 'blur(8px)'
              }}>
                {orderData?.items.map((item, index) => (
                  <div key={index} style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '0.75rem 1rem',
                    background: 'linear-gradient(145deg, rgba(15, 23, 42, 0.7) 0%, rgba(30, 41, 59, 0.5) 100%)',
                    borderRadius: '0.625rem',
                    fontSize: '0.875rem',
                    border: '1px solid rgba(255,255,255,0.05)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)'
                  }}>
                    <span style={{ color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.descripcion}
                    </span>
                    <span style={{ color: '#64748b', fontFamily: 'monospace', fontWeight: 500 }}>
                      {item.cantidad} x ${item.precio.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Total estimado */}
            <div style={{
              padding: '1.5rem',
              background: 'linear-gradient(135deg, rgba(79, 70, 229, 0.2) 0%, rgba(124, 58, 237, 0.15) 50%, rgba(139, 92, 246, 0.1) 100%)',
              border: '1px solid rgba(79, 70, 229, 0.35)',
              borderRadius: '1rem',
              backdropFilter: 'blur(12px)',
              boxShadow: `
                0 0 30px rgba(79, 70, 229, 0.15),
                inset 0 1px 0 rgba(255,255,255,0.1)
              `,
              position: 'relative',
              overflow: 'hidden'
            }}>
              <div style={{
                position: 'absolute',
                inset: 0,
                background: 'radial-gradient(circle at 20% 50%, rgba(79, 70, 229, 0.1) 0%, transparent 50%)'
              }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative', zIndex: 1 }}>
                <span style={{ color: '#94a3b8', fontSize: '1rem', fontWeight: 500 }}>Total estimado:</span>
                <span style={{ 
                  fontSize: '1.625rem', 
                  fontWeight: 700, 
                  color: '#ffffff', 
                  fontFamily: 'monospace',
                  letterSpacing: '-0.03em',
                  textShadow: '0 0 30px rgba(79, 70, 229, 0.3)'
                }}>
                  ${orderData?.total.toFixed(2)}
                </span>
              </div>
              {tipo === 'factura_a' && (
                <p style={{ 
                  fontSize: '0.875rem', 
                  color: '#64748b', 
                  marginTop: '0.75rem',
                  margin: '0.75rem 0 0 0',
                  position: 'relative',
                  zIndex: 1
                }}>
                  IVA incluido: ${((orderData?.total || 0) * 0.21).toFixed(2)}
                </p>
              )}
            </div>

            {/* Botones */}
            <div style={{ 
              display: 'flex', 
              gap: '1rem', 
              paddingTop: '1.75rem',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              marginTop: '0.75rem'
            }}>
              <button
                onClick={() => setStep(1)}
                disabled={loading}
                style={{
                  padding: '0.875rem 1.5rem',
                  background: 'linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: '#94a3b8',
                  borderRadius: '0.75rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                  fontWeight: 500,
                  fontSize: '1rem',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
                }}
                onMouseEnter={(e) => {
                  if (!loading) {
                    e.currentTarget.style.background = 'linear-gradient(145deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.04) 100%)';
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)';
                    e.currentTarget.style.color = '#ffffff';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)';
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                  e.currentTarget.style.color = '#94a3b8';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                Volver
              </button>
              <button
                onClick={handleGenerar}
                disabled={loading}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.75rem',
                  padding: '0.875rem 2rem',
                  background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #8b5cf6 100%)',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.75rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                  fontWeight: 600,
                  fontSize: '1rem',
                  boxShadow: `
                    0 0 0 1px rgba(255,255,255,0.1),
                    0 8px 24px rgba(79, 70, 229, 0.4),
                    inset 0 1px 0 rgba(255,255,255,0.2)
                  `,
                  letterSpacing: '-0.01em',
                  position: 'relative',
                  overflow: 'hidden'
                }}
                onMouseEnter={(e) => {
                  if (!loading) {
                    e.currentTarget.style.background = 'linear-gradient(135deg, #4338ca 0%, #6d28d9 50%, #7c3aed 100%)';
                    e.currentTarget.style.boxShadow = `
                      0 0 0 1px rgba(255,255,255,0.15),
                      0 12px 32px rgba(79, 70, 229, 0.5),
                      inset 0 1px 0 rgba(255,255,255,0.3)
                    `;
                    e.currentTarget.style.transform = 'translateY(-2px)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #8b5cf6 100%)';
                  e.currentTarget.style.boxShadow = `
                    0 0 0 1px rgba(255,255,255,0.1),
                    0 8px 24px rgba(79, 70, 229, 0.4),
                    inset 0 1px 0 rgba(255,255,255,0.2)
                  `;
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                {loading ? (
                  <>
                    <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
                    Generando...
                  </>
                ) : (
                  <>
                    <Receipt size={20} />
                    Generar Comprobante
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
      
      <style>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        
        @keyframes scaleIn {
          from {
            opacity: 0;
            transform: scale(0.95) translateY(10px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
        
        @keyframes pulse {
          0%, 100% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.85;
            transform: scale(1.05);
          }
        }
      `}</style>
    </div>
  );
}
