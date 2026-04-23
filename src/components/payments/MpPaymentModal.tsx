/**
 * MpPaymentModal — Cobro integrado con Mercado Pago por local
 *
 * Detecta automáticamente:
 *  - Si el negocio tiene MP conectado
 *  - El local activo (predeterminado = true)
 *  - La configuración MP del local (store_id, pos_id, terminal_id)
 *  - Los canales disponibles (QR / Point)
 *
 * Ofrece:
 *  - Calculadora precio lista / neto deseado
 *  - Creación de orden QR o Point vía Edge Function
 *  - Cobro manual MP (registro directo)
 */
import { useState, useEffect, useMemo } from 'react';
import {
  Zap, Loader2, AlertCircle, CheckCircle2, X,
  Smartphone, CreditCard, Wallet, Calculator,
  Building2, MapPin, DollarSign, Percent,
  ExternalLink, RefreshCw, ArrowRight,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  calculateChargeFromTargetNet,
  calculateNetFromGross,
  fmtARS, fmtPct,
  ChargeResult,
} from '../../services/paymentCalculator';
import logoSvg from '../../assets/logo.svg';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LocalMpConfig {
  id: string;
  nombre: string;
  numero: number;
  mp_enabled: boolean;
  mp_store_id: string | null;
  mp_pos_id: string | null;
  mp_terminal_id: string | null;
  mp_terminal_mode: string;
  mp_channel_qr: boolean;
  mp_channel_point: boolean;
  mp_fee_percent: number;
  mp_fee_fixed: number;
  mp_vat_percent: number;
}

type Canal = 'qr' | 'point' | 'manual';
type Modo  = 'lista' | 'neto';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  comprobanteId: string;
  totalBruto: number;
  saldoPendiente: number;
  onPagoRegistrado?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MpPaymentModal({
  isOpen, onClose,
  comprobanteId, totalBruto, saldoPendiente,
  onPagoRegistrado,
}: Props) {
  const { businessId, user } = useAuth();

  // Estado de conexión MP
  const [mpConnected, setMpConnected]   = useState<boolean | null>(null);
  // Local activo y su config MP
  const [local, setLocal]               = useState<LocalMpConfig | null>(null);
  // Estado general de carga
  const [loadingInit, setLoadingInit]   = useState(true);
  const [initError, setInitError]       = useState<string | null>(null);

  // Selecciones del usuario
  const [canal, setCanal]               = useState<Canal>('qr');
  const [modo,  setModo]                = useState<Modo>('lista');
  const [netoInput, setNetoInput]       = useState('');

  // Estado del cobro
  const [submitting, setSubmitting]     = useState(false);
  const [submitError, setSubmitError]   = useState<string | null>(null);
  const [result, setResult]             = useState<{
    success: boolean;
    init_point?: string;
    qr_data?: string;
    order_id?: string;
    message?: string;
  } | null>(null);

  // ── Cargar datos al abrir ───────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen || !businessId) return;
    setLoadingInit(true);
    setInitError(null);
    setResult(null);
    setSubmitError(null);

    Promise.all([
      // Estado MP conectado
      supabase
        .from('mp_accounts')
        .select('is_active, mp_user_id')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .maybeSingle(),

      // Local activo (predeterminado o primero activo)
      supabase.rpc('get_active_sales_point', { p_business_id: businessId }),
    ])
    .then(([mpRes, localRes]) => {
      setMpConnected(!!mpRes.data);

      if (localRes.data && localRes.data.length > 0) {
        setLocal(localRes.data[0] as LocalMpConfig);
        // Si el local tiene QR/Point, elegir canal disponible
        const l = localRes.data[0] as LocalMpConfig;
        if (!l.mp_channel_qr && l.mp_channel_point) setCanal('point');
      } else {
        setLocal(null);
      }
    })
    .catch(e => setInitError(e?.message ?? 'Error al cargar configuración'))
    .finally(() => setLoadingInit(false));
  }, [isOpen, businessId]);

  // ── Calculadora en tiempo real ──────────────────────────────────────────────
  const rule = useMemo(() => ({
    fee_percent:               local?.mp_fee_percent ?? 0.0099,
    fee_fixed:                 local?.mp_fee_fixed   ?? 0,
    vat_percent:               local?.mp_vat_percent ?? 0.21,
    installment_extra_percent: 0,
    absorbs_fee:               false,
    installments:              1,
  }), [local]);

  const calc: ChargeResult | null = useMemo(() => {
    if (modo === 'neto') {
      const neto = parseFloat(netoInput) || 0;
      if (neto <= 0) return null;
      return calculateChargeFromTargetNet(neto, rule);
    }
    return calculateNetFromGross(saldoPendiente, rule);
  }, [modo, netoInput, saldoPendiente, rule]);

  const montoACobrar = calc?.charge_amount ?? saldoPendiente;

  // ── Confirmar cobro ─────────────────────────────────────────────────────────
  const handleCobrar = async () => {
    if (!businessId || !calc) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const action = canal === 'point' ? 'create_point'
                   : canal === 'qr'    ? 'create_qr'
                   : 'create_manual';

      const body: Record<string, any> = {
        action,
        business_id:    businessId,
        comprobante_id: comprobanteId,
        amount:         montoACobrar,
        description:    `Comprobante ${comprobanteId.slice(0, 8)}`,
        local_id:       local?.id,
        store_id:       local?.mp_store_id,
        pos_id:         local?.mp_pos_id,
      };

      if (canal === 'point') {
        body.device_id = local?.mp_terminal_id;
      }

      const { data, error } = await supabase.functions.invoke('mp-payments', { body });

      if (error || data?.error) {
        throw new Error(error?.message ?? data?.error ?? 'Error al crear cobro');
      }

      setResult({
        success:    true,
        init_point: data?.init_point,
        qr_data:    data?.qr_data,
        order_id:   data?.order_id,
        message:    canal === 'manual'
          ? '¡Cobro manual registrado correctamente!'
          : canal === 'point'
          ? 'Solicitud enviada a la terminal Point'
          : 'Link de pago generado',
      });

      if (canal === 'qr' && data?.init_point) {
        window.open(data.init_point, '_blank');
      }

      if (canal === 'manual') {
        setTimeout(() => { onPagoRegistrado?.(); onClose(); }, 1800);
      }

    } catch (e: any) {
      setSubmitError(e?.message ?? 'Error inesperado');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  // ── Estilos ──────────────────────────────────────────────────────────────────
  const inputS: React.CSSProperties = {
    width: '100%', padding: '0.625rem 0.875rem',
    backgroundColor: 'rgba(15,23,42,0.8)',
    border: '1px solid rgba(51,65,85,0.6)',
    borderRadius: '0.5rem', color: '#f1f5f9',
    fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box',
  };

  const MP_BLUE = '#009ee3';

  return (
    <div style={{
      position: 'fixed', inset: 0,
      backgroundColor: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100, padding: '1rem',
    }}>
      <div style={{
        backgroundColor: '#0b1120',
        border: '1px solid rgba(0,158,227,0.2)',
        borderRadius: '1rem',
        width: '100%', maxWidth: '520px',
        boxShadow: `0 25px 50px -12px rgba(0,0,0,0.7), 0 0 0 1px rgba(0,158,227,0.1)`,
        overflow: 'hidden',
      }}>

        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1.125rem 1.375rem',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'linear-gradient(135deg, rgba(0,158,227,0.08), rgba(0,188,255,0.04))',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <img src={logoSvg} alt="TechRepair" style={{ width: '2rem', height: '2rem', borderRadius: '0.5rem' }} />
            <div style={{ width: '1.5rem', height: '1px', background: 'rgba(255,255,255,0.12)' }} />
            <div style={{
              width: '2rem', height: '2rem', borderRadius: '0.5rem',
              background: 'linear-gradient(135deg, #009ee3, #00bcff)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.875rem',
            }}>💳</div>
            <div>
              <div style={{ fontWeight: 700, color: '#f1f5f9', fontSize: '0.95rem' }}>
                Cobrar con Mercado Pago
              </div>
              <div style={{ fontSize: '0.72rem', color: '#475569' }}>
                Cobro integrado por local
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: '0.25rem', display: 'flex' }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '1.375rem', display: 'flex', flexDirection: 'column', gap: '1.125rem', maxHeight: '80vh', overflowY: 'auto' }}>

          {/* ── Loading ── */}
          {loadingInit && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '2rem', gap: '0.75rem' }}>
              <Loader2 size={20} style={{ color: MP_BLUE, animation: 'spin 1s linear infinite' }} />
              <span style={{ color: '#64748b', fontSize: '0.875rem' }}>Cargando configuración...</span>
            </div>
          )}

          {/* ── Error de init ── */}
          {!loadingInit && initError && (
            <div style={{ display: 'flex', gap: '0.625rem', padding: '0.875rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '0.625rem' }}>
              <AlertCircle size={16} style={{ color: '#f87171', flexShrink: 0 }} />
              <span style={{ color: '#fca5a5', fontSize: '0.875rem' }}>{initError}</span>
            </div>
          )}

          {/* ── MP no conectado ── */}
          {!loadingInit && !initError && mpConnected === false && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center', padding: '1.5rem', textAlign: 'center' }}>
              <div style={{
                width: '3.5rem', height: '3.5rem', borderRadius: '0.875rem',
                background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem',
              }}>⚠️</div>
              <div>
                <div style={{ fontWeight: 700, color: '#f1f5f9', marginBottom: '0.375rem' }}>
                  Mercado Pago no está conectado
                </div>
                <div style={{ fontSize: '0.85rem', color: '#64748b', lineHeight: 1.6 }}>
                  Conectá tu cuenta de Mercado Pago para habilitar cobros integrados desde el comprobante.
                </div>
              </div>
              <a
                href="/settings?tab=pagos"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.625rem 1.25rem',
                  background: `linear-gradient(135deg, ${MP_BLUE}, #00bcff)`,
                  borderRadius: '0.5rem', color: '#fff',
                  fontWeight: 600, fontSize: '0.875rem', textDecoration: 'none',
                }}
              >
                <ExternalLink size={14} /> Conectar Mercado Pago
              </a>
            </div>
          )}

          {/* ── Contenido principal (MP conectado) ── */}
          {!loadingInit && !initError && mpConnected === true && (

            <>
              {/* Local activo */}
              <div style={{
                padding: '0.875rem 1rem',
                background: 'rgba(0,158,227,0.06)',
                border: '1px solid rgba(0,158,227,0.2)',
                borderRadius: '0.625rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <MapPin size={13} style={{ color: MP_BLUE }} />
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Local activo
                  </span>
                </div>

                {local ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontWeight: 700, color: '#f1f5f9', fontSize: '0.9rem' }}>
                        {local.nombre || `PV ${local.numero}`}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#475569', marginTop: '0.2rem', display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
                        {local.mp_pos_id      && <span>POS ID: <code style={{ color: '#64748b' }}>{local.mp_pos_id}</code></span>}
                        {local.mp_terminal_id && <span>Terminal: <code style={{ color: '#64748b' }}>{local.mp_terminal_id}</code></span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', alignItems: 'flex-end' }}>
                      {local.mp_enabled
                        ? <span style={{ fontSize: '0.7rem', color: '#34d399', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)', padding: '0.15rem 0.5rem', borderRadius: '9999px', fontWeight: 600 }}>● MP Activo</span>
                        : <span style={{ fontSize: '0.7rem', color: '#f59e0b', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', padding: '0.15rem 0.5rem', borderRadius: '9999px', fontWeight: 600 }}>MP sin config</span>
                      }
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '0.85rem', color: '#f59e0b' }}>
                    ⚠️ Sin local activo configurado.{' '}
                    <a href="/settings" style={{ color: '#fbbf24' }}>Configurar en Puntos de Venta</a>
                  </div>
                )}
              </div>

              {/* Advertencia si local sin MP habilitado */}
              {local && !local.mp_enabled && (
                <div style={{ display: 'flex', gap: '0.625rem', padding: '0.75rem', background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '0.5rem' }}>
                  <AlertCircle size={14} style={{ color: '#fbbf24', flexShrink: 0, marginTop: '0.1rem' }} />
                  <div style={{ fontSize: '0.8rem', color: '#fde68a', lineHeight: 1.5 }}>
                    Este local no tiene Mercado Pago habilitado. Solo podés usar el <strong>cobro manual</strong>.
                    <br /><a href="/settings" style={{ color: '#fbbf24' }}>Activar MP en este local →</a>
                  </div>
                </div>
              )}

              {/* Canal */}
              {local && (
                <div>
                  <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                    Canal de cobro
                  </label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {[
                      { key: 'qr'     as Canal, label: 'QR',     icon: Smartphone,  available: local.mp_enabled && local.mp_channel_qr },
                      { key: 'point'  as Canal, label: 'Point',  icon: CreditCard,  available: local.mp_enabled && local.mp_channel_point && !!local.mp_terminal_id },
                      { key: 'manual' as Canal, label: 'Manual', icon: Wallet,       available: true },
                    ].map(c => {
                      const Icon = c.icon;
                      const sel  = canal === c.key;
                      return (
                        <button
                          key={c.key}
                          onClick={() => c.available && setCanal(c.key)}
                          disabled={!c.available}
                          style={{
                            flex: 1, padding: '0.625rem 0.5rem',
                            borderRadius: '0.5rem',
                            border: `2px solid ${sel ? MP_BLUE : 'rgba(255,255,255,0.08)'}`,
                            backgroundColor: sel ? 'rgba(0,158,227,0.12)' : 'transparent',
                            color: sel ? '#38bdf8' : c.available ? '#64748b' : '#334155',
                            cursor: c.available ? 'pointer' : 'not-allowed',
                            opacity: c.available ? 1 : 0.4,
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem',
                            transition: 'all 0.15s',
                          }}
                        >
                          <Icon size={16} />
                          <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>{c.label}</span>
                          {c.key === 'point' && !local.mp_terminal_id && (
                            <span style={{ fontSize: '0.6rem', color: '#475569' }}>Sin terminal</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Modo de cálculo */}
              {local && (
                <div>
                  <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                    Modo de cobro
                  </label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {[
                      { key: 'lista' as Modo, label: 'Precio de lista' },
                      { key: 'neto'  as Modo, label: 'Neto deseado' },
                    ].map(m => (
                      <button
                        key={m.key}
                        onClick={() => setModo(m.key)}
                        style={{
                          flex: 1, padding: '0.5rem',
                          borderRadius: '0.375rem',
                          border: `2px solid ${modo === m.key ? '#34d399' : 'rgba(255,255,255,0.08)'}`,
                          backgroundColor: modo === m.key ? 'rgba(52,211,153,0.1)' : 'transparent',
                          color: modo === m.key ? '#34d399' : '#64748b',
                          fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer',
                        }}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>

                  {modo === 'neto' && (
                    <div style={{ marginTop: '0.625rem', position: 'relative' }}>
                      <Percent size={13} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                      <input
                        type="number" value={netoInput} min="0" step="0.01"
                        placeholder={`Neto a recibir (ej. ${fmtARS(saldoPendiente * 0.99)})`}
                        onChange={e => setNetoInput(e.target.value)}
                        style={{ ...inputS, paddingLeft: '2rem' }}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Calculadora */}
              {local && calc && (
                <div style={{
                  padding: '1rem',
                  background: '#060d1a',
                  border: `1px solid rgba(0,158,227,0.2)`,
                  borderRadius: '0.625rem',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.75rem' }}>
                    <Calculator size={13} style={{ color: MP_BLUE }} />
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Cálculo estimado — {canal.toUpperCase()}
                    </span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    {[
                      { label: 'Saldo pendiente',     val: saldoPendiente,        color: '#94a3b8' },
                      { label: 'Cobrar al cliente',   val: calc.charge_amount,    color: '#f1f5f9', bold: true },
                      { label: `Comisión MP (${fmtPct(rule.fee_percent)})`, val: calc.fee_amount, color: '#f59e0b', neg: true },
                      rule.vat_percent > 0 && { label: `  IVA sobre comisión`, val: calc.vat_on_fee, color: '#64748b', neg: true },
                      { label: 'Neto a recibir',      val: calc.net_amount,       color: '#34d399', bold: true },
                    ].filter(Boolean).map((r: any) => (
                      <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: r.bold ? '0.85rem' : '0.8rem', color: '#64748b', ...(r.bold ? { borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.35rem', marginTop: '0.1rem', width: '100%' } : {}) }}>
                          {r.label}
                        </span>
                        <span style={{ fontFamily: 'monospace', fontWeight: r.bold ? 700 : 500, fontSize: r.bold ? '0.95rem' : '0.82rem', color: r.color, flexShrink: 0, marginLeft: '0.5rem' }}>
                          {r.neg ? '−' : ''}{fmtARS(r.val)}
                        </span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
                      <span style={{ fontSize: '0.68rem', color: '#334155' }}>
                        Tasa efectiva: {fmtPct(calc.effective_rate)} · estimado
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Resultado del cobro */}
              {result?.success && (
                <div style={{ padding: '1rem', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: '0.625rem' }}>
                  <div style={{ display: 'flex', gap: '0.625rem', alignItems: 'flex-start' }}>
                    <CheckCircle2 size={18} style={{ color: '#34d399', flexShrink: 0 }} />
                    <div>
                      <div style={{ fontWeight: 700, color: '#34d399', fontSize: '0.875rem', marginBottom: '0.25rem' }}>
                        {result.message}
                      </div>
                      {result.init_point && (
                        <a
                          href={result.init_point}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: '0.8rem', color: '#38bdf8', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                        >
                          <ExternalLink size={12} /> Abrir link de pago
                        </a>
                      )}
                      {canal !== 'manual' && (
                        <div style={{ fontSize: '0.78rem', color: '#475569', marginTop: '0.375rem' }}>
                          El comprobante se actualizará automáticamente cuando MP confirme el pago.
                        </div>
                      )}
                    </div>
                  </div>
                  {result.order_id && (
                    <button
                      onClick={() => { onPagoRegistrado?.(); onClose(); }}
                      style={{ marginTop: '0.75rem', width: '100%', padding: '0.5rem', background: 'rgba(52,211,153,0.15)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: '0.375rem', color: '#34d399', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}
                    >
                      Cerrar y esperar confirmación
                    </button>
                  )}
                </div>
              )}

              {/* Error del cobro */}
              {submitError && (
                <div style={{ display: 'flex', gap: '0.5rem', padding: '0.75rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '0.5rem' }}>
                  <AlertCircle size={14} style={{ color: '#f87171', flexShrink: 0 }} />
                  <span style={{ color: '#fca5a5', fontSize: '0.825rem' }}>{submitError}</span>
                </div>
              )}

              {/* Botón confirmar */}
              {local && !result?.success && (
                <button
                  onClick={handleCobrar}
                  disabled={submitting || !calc}
                  style={{
                    width: '100%', padding: '0.875rem',
                    background: submitting ? 'rgba(0,158,227,0.4)' : `linear-gradient(135deg, ${MP_BLUE}, #00bcff)`,
                    border: 'none', color: '#fff', borderRadius: '0.625rem',
                    cursor: submitting || !calc ? 'not-allowed' : 'pointer',
                    fontWeight: 700, fontSize: '0.9rem',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                    boxShadow: `0 4px 16px rgba(0,158,227,0.35)`,
                    transition: 'all 0.15s',
                  }}
                >
                  {submitting ? (
                    <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Procesando...</>
                  ) : canal === 'qr' ? (
                    <><Smartphone size={16} /> Generar QR — {calc ? fmtARS(calc.charge_amount) : '...'}</>
                  ) : canal === 'point' ? (
                    <><CreditCard size={16} /> Enviar a Terminal — {calc ? fmtARS(calc.charge_amount) : '...'}</>
                  ) : (
                    <><CheckCircle2 size={16} /> Registrar cobro manual — {calc ? fmtARS(calc.charge_amount) : '...'}</>
                  )}
                </button>
              )}
            </>
          )}

        </div>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
