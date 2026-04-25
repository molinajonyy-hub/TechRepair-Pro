import { useState, useEffect } from 'react';
import { ArrowRight, Loader2, ChevronLeft } from 'lucide-react';
import { CloseButton } from '../ui/CloseButton';
import { AppleEmoji } from '../ui/AppleEmoji';
import { TipoComprobante } from '../../hooks/useComprobantes';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';

const ComprobantesIcon = ({ size = 20, color = '#ffffff' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
    <polyline points="10 9 9 9 8 9"/>
  </svg>
);

interface ModalGenerarComprobanteProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerar: (data: {
    tipo: TipoComprobante;
    puntoVenta: string;
    condicionFiscal: string;
    cuit?: string;
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

interface TipoConfig {
  label: string;
  tag: string;
  emoji: string;
  description: string;
  detail: string;
  color: string;
  colorRgb: string;
  borderColor: string;
  glowColor: string;
  gradientFrom: string;
  gradientTo: string;
  requiereCuit: boolean;
  cuitWarning?: string;
}

const tiposConfig: Record<TipoComprobante, TipoConfig> = {
  factura_a: {
    label: 'Factura A',
    tag: 'Resp. Inscripto',
    emoji: '🏢',
    description: 'Para empresas o Responsables Inscriptos',
    detail: 'Discrimina IVA. Requiere CUIT del receptor.',
    color: '#60a5fa',
    colorRgb: '96, 165, 250',
    borderColor: 'rgba(59, 130, 246, 0.35)',
    glowColor: 'rgba(59, 130, 246, 0.2)',
    gradientFrom: 'rgba(59, 130, 246, 0.12)',
    gradientTo: 'rgba(59, 130, 246, 0.03)',
    requiereCuit: true,
    cuitWarning: 'Este tipo de comprobante requiere el CUIT del cliente. Podés ingresarlo en el siguiente paso.',
  },
  factura_c: {
    label: 'Factura C',
    tag: 'Consumidor Final',
    emoji: '🧾',
    description: 'Para consumidores finales o monotributistas',
    detail: 'Sin IVA discriminado. No requiere CUIT.',
    color: '#34d399',
    colorRgb: '52, 211, 153',
    borderColor: 'rgba(16, 185, 129, 0.35)',
    glowColor: 'rgba(16, 185, 129, 0.2)',
    gradientFrom: 'rgba(16, 185, 129, 0.12)',
    gradientTo: 'rgba(16, 185, 129, 0.03)',
    requiereCuit: false,
  },
  remito: {
    label: 'Remito',
    tag: 'Transporte',
    emoji: '📦',
    description: 'Documento de transporte de mercadería',
    detail: 'No afecta contabilidad fiscal. Sin IVA.',
    color: '#fbbf24',
    colorRgb: '251, 191, 36',
    borderColor: 'rgba(245, 158, 11, 0.35)',
    glowColor: 'rgba(245, 158, 11, 0.2)',
    gradientFrom: 'rgba(245, 158, 11, 0.12)',
    gradientTo: 'rgba(245, 158, 11, 0.03)',
    requiereCuit: false,
  },
  nota_credito: {
    label: 'Nota de Crédito',
    tag: 'Devolución',
    emoji: '💳',
    description: 'Para reversión o devolución de comprobantes',
    detail: 'Cancela total o parcialmente una factura anterior.',
    color: '#f87171',
    colorRgb: '248, 113, 113',
    borderColor: 'rgba(239, 68, 68, 0.35)',
    glowColor: 'rgba(239, 68, 68, 0.2)',
    gradientFrom: 'rgba(239, 68, 68, 0.12)',
    gradientTo: 'rgba(239, 68, 68, 0.03)',
    requiereCuit: true,
    cuitWarning: 'Una Nota de Crédito requiere el CUIT del cliente. Podés ingresarlo en el siguiente paso.',
  }
};

const condicionesFiscales = [
  'Consumidor Final',
  'Responsable Inscripto',
  'Monotributo',
  'Exento',
  'Responsable No Inscripto',
];

export function ModalGenerarComprobante({
  isOpen,
  onClose,
  onGenerar,
  orderData,
  loading = false
}: ModalGenerarComprobanteProps) {
  const { businessId } = useAuth();
  const [step, setStep] = useState(1);
  const [tipo, setTipo] = useState<TipoComprobante | null>(null);
  const [puntoVenta, setPuntoVenta] = useState('0001');
  const [condicionFiscal, setCondicionFiscal] = useState('Consumidor Final');
  const [cuit, setCuit] = useState('');

  // Cargar punto de venta configurado en Settings > ARCA
  useEffect(() => {
    if (!isOpen || !businessId) return;
    supabase
      .from('sales_points')
      .select('punto_venta')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.punto_venta) {
          setPuntoVenta(String(data.punto_venta).padStart(4, '0'));
        }
      });
  }, [isOpen, businessId]);

  // Resetear al cerrar
  useEffect(() => {
    if (!isOpen) {
      setStep(1);
      setTipo(null);
      setPuntoVenta('0001');
      setCondicionFiscal('Consumidor Final');
      setCuit('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleTipoSelect = (selected: TipoComprobante) => {
    setTipo(selected);
    if (selected === 'factura_a' || selected === 'nota_credito') {
      setCondicionFiscal('Responsable Inscripto');
    } else {
      setCondicionFiscal('Consumidor Final');
    }
    setStep(2);
  };

  const handleGenerar = () => {
    if (!tipo) return;
    onGenerar({ tipo, puntoVenta, condicionFiscal, cuit: cuit || undefined });
  };

  const tipoConfig = tipo ? tiposConfig[tipo] : null;

  // Si el tipo requiere CUIT y el cliente no tiene uno (o no hay orderData), pedir CUIT en step 2
  const clienteCuit = orderData?.customerCuit;
  const needsCuitInput = tipo && tiposConfig[tipo].requiereCuit && !clienteCuit;
  const canGenerate = !needsCuitInput || cuit.trim().length >= 11;

  // ── formato CUIT xx-xxxxxxxx-x ──
  const formatCuit = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 11);
    if (digits.length <= 2) return digits;
    if (digits.length <= 10) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
    return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
  };

  const inputBase: React.CSSProperties = {
    width: '100%',
    padding: '0.875rem 1.125rem',
    background: 'rgba(15, 23, 42, 0.7)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '0.75rem',
    color: '#ffffff',
    fontSize: '1rem',
    outline: 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s',
    boxSizing: 'border-box',
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(16px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 50,
      padding: '1.5rem',
      animation: 'mgc-fadeIn 0.2s ease',
    }}>
      <div style={{
        background: 'linear-gradient(160deg, #0d1526 0%, #111827 60%, #0f1d35 100%)',
        borderRadius: '1.5rem',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 40px 80px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.04)',
        width: '100%',
        maxWidth: step === 1 ? '900px' : '560px',
        maxHeight: '92vh',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        animation: 'mgc-slideUp 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)',
        transition: 'max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      }}>

        {/* ── Header ── */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '1.5rem 2rem',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: 'rgba(13,21,38,0.95)',
          backdropFilter: 'blur(20px)',
          borderRadius: '1.5rem 1.5rem 0 0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            {/* Step back arrow on step 2 */}
            {step === 2 && (
              <button
                onClick={() => setStep(1)}
                disabled={loading}
                style={{
                  width: '2.25rem', height: '2.25rem',
                  borderRadius: '0.625rem',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.15s',
                  flexShrink: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#94a3b8'; }}
              >
                <ChevronLeft size={18} />
              </button>
            )}

            {/* Icon */}
            <div style={{
              width: '2.75rem', height: '2.75rem',
              borderRadius: '0.875rem',
              background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 20px rgba(79,70,229,0.4), inset 0 1px 0 rgba(255,255,255,0.15)',
              flexShrink: 0,
            }}>
              <ComprobantesIcon size={20} color="#ffffff" />
            </div>

            <div>
              <h2 style={{
                fontSize: '1.125rem',
                fontWeight: 700,
                color: '#f1f5f9',
                margin: 0,
                letterSpacing: '-0.02em',
              }}>
                {step === 1 ? 'Generar Comprobante' : `Configurar · ${tipoConfig?.label}`}
              </h2>
              <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '0.2rem 0 0 0' }}>
                {step === 1
                  ? 'Seleccioná el tipo de comprobante a emitir'
                  : 'Completá los datos y generá el comprobante'}
              </p>
            </div>
          </div>

          {/* Step indicator + close */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '0.375rem' }}>
              {[1, 2].map(s => (
                <div key={s} style={{
                  width: s === step ? '1.5rem' : '0.5rem',
                  height: '0.375rem',
                  borderRadius: '999px',
                  background: s === step ? '#6366f1' : 'rgba(255,255,255,0.12)',
                  transition: 'width 0.3s, background 0.3s',
                }} />
              ))}
            </div>
            <CloseButton onClick={onClose} disabled={loading} />
          </div>
        </div>

        {/* ══════════════════════════════ STEP 1 ══════════════════════════════ */}
        {step === 1 && (
          <div style={{ padding: '2rem' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '1rem',
            }}>
              {(Object.keys(tiposConfig) as TipoComprobante[]).map((tipoKey) => {
                const cfg = tiposConfig[tipoKey];
                return (
                  <button
                    key={tipoKey}
                    onClick={() => handleTipoSelect(tipoKey)}
                    style={{
                      position: 'relative',
                      padding: '1.5rem',
                      borderRadius: '1.125rem',
                      border: `1.5px solid rgba(255,255,255,0.08)`,
                      background: 'rgba(255,255,255,0.025)',
                      textAlign: 'left',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '1rem',
                      transition: 'all 0.2s cubic-bezier(0.4,0,0.2,1)',
                      overflow: 'hidden',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.background = cfg.gradientFrom;
                      e.currentTarget.style.borderColor = cfg.borderColor;
                      e.currentTarget.style.transform = 'translateY(-3px)';
                      e.currentTarget.style.boxShadow = `0 16px 40px rgba(0,0,0,0.4), 0 0 40px ${cfg.glowColor}`;
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.025)';
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
                      e.currentTarget.style.transform = 'translateY(0)';
                      e.currentTarget.style.boxShadow = 'none';
                    }}
                  >
                    {/* Subtle glow orb */}
                    <div style={{
                      position: 'absolute',
                      top: '-30%', right: '-10%',
                      width: '120px', height: '120px',
                      borderRadius: '50%',
                      background: `radial-gradient(circle, ${cfg.glowColor} 0%, transparent 70%)`,
                      pointerEvents: 'none',
                    }} />

                    {/* Top row: emoji + tag */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem' }}>
                      <div style={{
                        width: '3.5rem', height: '3.5rem',
                        borderRadius: '1rem',
                        background: `linear-gradient(135deg, ${cfg.gradientFrom}, ${cfg.gradientTo})`,
                        border: `1px solid ${cfg.borderColor}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        boxShadow: `0 0 24px ${cfg.glowColor}`,
                        flexShrink: 0,
                      }}>
                        <AppleEmoji emoji={cfg.emoji} size={30} />
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.375rem' }}>
                        {/* Type tag pill */}
                        <span style={{
                          fontSize: '0.7rem',
                          fontWeight: 600,
                          color: cfg.color,
                          background: `rgba(${cfg.colorRgb}, 0.12)`,
                          border: `1px solid rgba(${cfg.colorRgb}, 0.25)`,
                          padding: '0.2rem 0.6rem',
                          borderRadius: '999px',
                          letterSpacing: '0.03em',
                          whiteSpace: 'nowrap',
                        }}>
                          {cfg.tag}
                        </span>
                        {/* CUIT warning badge — info, NOT blocking */}
                        {cfg.requiereCuit && (
                          <span style={{
                            fontSize: '0.65rem',
                            fontWeight: 500,
                            color: '#f59e0b',
                            background: 'rgba(245,158,11,0.1)',
                            border: '1px solid rgba(245,158,11,0.2)',
                            padding: '0.15rem 0.5rem',
                            borderRadius: '999px',
                            display: 'flex', alignItems: 'center', gap: '0.3rem',
                            whiteSpace: 'nowrap',
                          }}>
                            <AppleEmoji emoji="⚠️" size={11} />
                            Requiere CUIT
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Label + description */}
                    <div>
                      <h3 style={{
                        fontSize: '1.0625rem',
                        fontWeight: 700,
                        color: '#f1f5f9',
                        margin: '0 0 0.375rem 0',
                        letterSpacing: '-0.02em',
                      }}>
                        {cfg.label}
                      </h3>
                      <p style={{ fontSize: '0.8125rem', color: '#64748b', margin: 0, lineHeight: 1.5 }}>
                        {cfg.description}
                      </p>
                      <p style={{ fontSize: '0.75rem', color: '#475569', margin: '0.25rem 0 0 0', lineHeight: 1.4 }}>
                        {cfg.detail}
                      </p>
                    </div>

                    {/* Arrow indicator */}
                    <div style={{
                      position: 'absolute',
                      bottom: '1.25rem', right: '1.25rem',
                      width: '1.75rem', height: '1.75rem',
                      borderRadius: '50%',
                      background: `rgba(${cfg.colorRgb}, 0.15)`,
                      border: `1px solid rgba(${cfg.colorRgb}, 0.25)`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <ArrowRight size={13} style={{ color: cfg.color }} />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ══════════════════════════════ STEP 2 ══════════════════════════════ */}
        {step === 2 && tipoConfig && tipo && (
          <div style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

            {/* Tipo seleccionado — resumen visual */}
            <div style={{
              padding: '1.25rem 1.5rem',
              background: tipoConfig.gradientFrom,
              border: `1px solid ${tipoConfig.borderColor}`,
              borderRadius: '1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              boxShadow: `0 0 30px ${tipoConfig.glowColor}`,
            }}>
              <div style={{
                width: '3rem', height: '3rem',
                borderRadius: '0.875rem',
                background: `linear-gradient(135deg, ${tipoConfig.gradientFrom}, transparent)`,
                border: `1px solid ${tipoConfig.borderColor}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <AppleEmoji emoji={tipoConfig.emoji} size={26} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.75rem', color: tipoConfig.color, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '0.2rem' }}>
                  Tipo seleccionado
                </div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
                  {tipoConfig.label}
                </div>
                <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.1rem' }}>
                  {tipoConfig.description}
                </div>
              </div>
              <span style={{
                fontSize: '0.7rem', fontWeight: 600,
                color: tipoConfig.color,
                background: `rgba(${tipoConfig.colorRgb}, 0.12)`,
                border: `1px solid rgba(${tipoConfig.colorRgb}, 0.25)`,
                padding: '0.25rem 0.75rem',
                borderRadius: '999px',
                flexShrink: 0,
              }}>
                {tipoConfig.tag}
              </span>
            </div>

            {/* Datos del cliente (solo cuando viene de una orden) */}
            {orderData && (
              <div style={{
                padding: '1.125rem 1.375rem',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '0.875rem',
              }}>
                <div style={{ fontSize: '0.7rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.625rem' }}>
                  Cliente
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <AppleEmoji emoji="👥" size={20} />
                  <div>
                    <div style={{ fontSize: '0.9375rem', fontWeight: 600, color: '#f1f5f9' }}>{orderData.customerName}</div>
                    {clienteCuit && (
                      <div style={{ fontSize: '0.8125rem', color: '#475569', marginTop: '0.1rem' }}>
                        CUIT: <span style={{ fontFamily: 'monospace', color: '#64748b' }}>{clienteCuit}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* CUIT input — solo si el tipo lo requiere y el cliente no lo tiene */}
            {needsCuitInput && (
              <div style={{
                padding: '1.25rem 1.375rem',
                background: 'rgba(245,158,11,0.06)',
                border: '1px solid rgba(245,158,11,0.2)',
                borderRadius: '0.875rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', marginBottom: '1rem' }}>
                  <AppleEmoji emoji="⚠️" size={16} style={{ marginTop: '1px', flexShrink: 0 }} />
                  <p style={{ fontSize: '0.8125rem', color: '#f59e0b', margin: 0, lineHeight: 1.5 }}>
                    {tipoConfig.cuitWarning}
                  </p>
                </div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
                  CUIT del cliente
                </label>
                <input
                  type="text"
                  value={cuit}
                  onChange={e => setCuit(formatCuit(e.target.value))}
                  placeholder="20-12345678-9"
                  maxLength={13}
                  style={{ ...inputBase, fontFamily: 'monospace', fontSize: '1.0625rem', letterSpacing: '0.05em', maxWidth: '220px' }}
                  onFocus={e => { e.currentTarget.style.borderColor = '#f59e0b'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(245,158,11,0.15)'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.boxShadow = 'none'; }}
                />
                <p style={{ fontSize: '0.75rem', color: '#475569', margin: '0.5rem 0 0 0' }}>
                  11 dígitos sin guiones. Ej: 20-12345678-9
                </p>
              </div>
            )}

            {/* Punto de Venta */}
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.625rem' }}>
                Punto de Venta
              </label>
              <input
                type="text"
                value={puntoVenta}
                onChange={e => setPuntoVenta(e.target.value.replace(/\D/g, '').slice(0, 5))}
                placeholder="0001"
                maxLength={5}
                style={{ ...inputBase, fontFamily: 'monospace', fontSize: '1.0625rem', maxWidth: '160px' }}
                onFocus={e => { e.currentTarget.style.borderColor = '#6366f1'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.15)'; }}
                onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.boxShadow = 'none'; }}
              />
              <p style={{ fontSize: '0.75rem', color: '#475569', margin: '0.5rem 0 0 0' }}>Punto de venta habilitado en AFIP</p>
            </div>

            {/* Condición Fiscal */}
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.625rem' }}>
                Condición Fiscal del Cliente
              </label>
              <select
                value={condicionFiscal}
                onChange={e => setCondicionFiscal(e.target.value)}
                style={{ ...inputBase }}
                onFocus={e => { e.currentTarget.style.borderColor = '#6366f1'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.15)'; }}
                onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.boxShadow = 'none'; }}
              >
                {condicionesFiscales.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Items de la orden (solo si viene de orden) */}
            {orderData && orderData.items.length > 0 && (
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.625rem' }}>
                  Items · {orderData.items.length}
                </label>
                <div style={{
                  maxHeight: '10rem',
                  overflowY: 'auto',
                  borderRadius: '0.75rem',
                  border: '1px solid rgba(255,255,255,0.06)',
                  background: 'rgba(255,255,255,0.02)',
                  padding: '0.5rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.375rem',
                }}>
                  {orderData.items.map((item, i) => (
                    <div key={i} style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '0.625rem 0.875rem',
                      background: 'rgba(255,255,255,0.03)',
                      borderRadius: '0.5rem',
                      fontSize: '0.8125rem',
                    }}>
                      <span style={{ color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {item.descripcion}
                      </span>
                      <span style={{ color: '#475569', fontFamily: 'monospace', fontWeight: 500, marginLeft: '1rem', flexShrink: 0 }}>
                        {item.cantidad} × ${item.precio.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Total (solo si viene de orden) */}
            {orderData && (
              <div style={{
                padding: '1.25rem 1.5rem',
                background: 'linear-gradient(135deg, rgba(79,70,229,0.15), rgba(124,58,237,0.1))',
                border: '1px solid rgba(99,102,241,0.25)',
                borderRadius: '1rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                boxShadow: '0 0 30px rgba(79,70,229,0.1)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                  <AppleEmoji emoji="💰" size={20} />
                  <span style={{ color: '#94a3b8', fontSize: '0.9375rem', fontWeight: 500 }}>Total estimado</span>
                </div>
                <div>
                  <span style={{ fontSize: '1.625rem', fontWeight: 800, color: '#fff', fontFamily: 'monospace', letterSpacing: '-0.03em' }}>
                    ${orderData.total?.toFixed(2) ?? '—'}
                  </span>
                  {tipo === 'factura_a' && (
                    <div style={{ fontSize: '0.75rem', color: '#64748b', textAlign: 'right', marginTop: '0.2rem' }}>
                      IVA: ${((orderData.total || 0) * 0.21).toFixed(2)}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Botones ── */}
            <div style={{ display: 'flex', gap: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: '0.25rem' }}>
              <button
                onClick={handleGenerar}
                disabled={loading || !canGenerate}
                style={{
                  flex: 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  gap: '0.625rem',
                  padding: '0.875rem 1.5rem',
                  background: canGenerate
                    ? 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 60%, #8b5cf6 100%)'
                    : 'rgba(255,255,255,0.04)',
                  border: 'none',
                  color: canGenerate ? '#fff' : '#475569',
                  borderRadius: '0.75rem',
                  cursor: (loading || !canGenerate) ? 'not-allowed' : 'pointer',
                  fontWeight: 700,
                  fontSize: '0.9375rem',
                  letterSpacing: '-0.01em',
                  boxShadow: canGenerate ? '0 0 0 1px rgba(255,255,255,0.1), 0 8px 24px rgba(79,70,229,0.4)' : 'none',
                  transition: 'all 0.2s',
                  opacity: loading ? 0.7 : 1,
                }}
                onMouseEnter={e => { if (!loading && canGenerate) { e.currentTarget.style.background = 'linear-gradient(135deg, #4338ca 0%, #6d28d9 60%, #7c3aed 100%)'; e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.15), 0 12px 32px rgba(79,70,229,0.5)'; } }}
                onMouseLeave={e => { e.currentTarget.style.background = canGenerate ? 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 60%, #8b5cf6 100%)' : 'rgba(255,255,255,0.04)'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = canGenerate ? '0 0 0 1px rgba(255,255,255,0.1), 0 8px 24px rgba(79,70,229,0.4)' : 'none'; }}
              >
                {loading ? (
                  <><Loader2 size={18} style={{ animation: 'mgc-spin 1s linear infinite' }} /> Generando...</>
                ) : (
                  <><AppleEmoji emoji="🧾" size={18} /> Generar {tipoConfig.label}</>
                )}
              </button>
            </div>

            {/* Hint si falta CUIT */}
            {needsCuitInput && !canGenerate && (
              <p style={{ fontSize: '0.75rem', color: '#f59e0b', textAlign: 'center', margin: '-0.75rem 0 0 0' }}>
                Ingresá el CUIT del cliente para continuar
              </p>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes mgc-fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes mgc-slideUp { from { opacity: 0; transform: scale(0.96) translateY(16px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        @keyframes mgc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
