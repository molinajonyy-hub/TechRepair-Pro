import { useState, useEffect, useMemo } from 'react';
import {
  Wallet, CreditCard, Building2, Smartphone, Zap,
  Calculator, ChevronRight, Loader2, CheckCircle2,
  AlertCircle, DollarSign, Percent, ArrowRight,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { paymentButtonService } from '../../services/paymentButtonService';
import {
  PaymentButton,
  calculateChargeFromTargetNet,
  calculateNetFromGross,
  ruleFromButton,
  formatFeeLabel,
  isIntegrated,
  fmtARS,
  fmtPct,
} from '../../services/paymentCalculator';
import { supabase } from '../../lib/supabase';

// ─── Icons por tipo de pago ───────────────────────────────────────────────────

const TYPE_ICONS: Record<string, React.ElementType> = {
  cash:     Wallet,
  transfer: Building2,
  debit:    CreditCard,
  credit:   CreditCard,
  qr:       Smartphone,
  wallet:   Smartphone,
  other:    Wallet,
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  comprobanteId: string;
  totalBruto: number;
  saldoPendiente: number;
  onPaymentRegistered?: () => void;
}

// ─── Calculadora ─────────────────────────────────────────────────────────────

interface CalculatorState {
  button: PaymentButton;
  mode: 'list' | 'net';
  netInput: string;      // modo neto: cuánto quiero recibir
  grossInput: string;    // modo lista: monto a cobrar (pre-cargado con saldo)
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PaymentButtonsPanel({
  comprobanteId,
  totalBruto,
  saldoPendiente,
  onPaymentRegistered,
}: Props) {
  const { businessId, user } = useAuth();

  const [buttons, setButtons]         = useState<PaymentButton[]>([]);
  const [loading, setLoading]         = useState(true);
  const [calc, setCalc]               = useState<CalculatorState | null>(null);
  const [submitting, setSubmitting]   = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitOk, setSubmitOk]       = useState(false);
  const [mpStatus, setMpStatus]       = useState<{ connected: boolean; active?: boolean } | null>(null);

  // Cargar botones y estado MP
  useEffect(() => {
    if (!businessId) return;
    setLoading(true);
    Promise.all([
      paymentButtonService.getActive(businessId),
      checkMpStatus(businessId),
    ]).then(([btns, mp]) => {
      setButtons(btns);
      setMpStatus(mp);
    }).catch(console.error)
      .finally(() => setLoading(false));
  }, [businessId]);

  async function checkMpStatus(bId: string) {
    try {
      const { data } = await supabase.functions.invoke('mp-oauth', {
        body: { action: 'status', business_id: bId },
      });
      return data;
    } catch { return null; }
  }

  // Cálculo en tiempo real
  const calcResult = useMemo(() => {
    if (!calc) return null;
    const rule = ruleFromButton(calc.button);
    if (calc.mode === 'net') {
      const neto = parseFloat(calc.netInput) || 0;
      if (neto <= 0) return null;
      return calculateChargeFromTargetNet(neto, rule);
    } else {
      const gross = parseFloat(calc.grossInput) || saldoPendiente;
      return calculateNetFromGross(gross, rule);
    }
  }, [calc, saldoPendiente]);

  // ── Abrir calculadora ─────────────────────────────────────────────────────
  const openCalc = (btn: PaymentButton) => {
    setCalc({
      button:     btn,
      mode:       'list',
      netInput:   '',
      grossInput: String(saldoPendiente.toFixed(2)),
    });
    setSubmitError(null);
    setSubmitOk(false);
  };

  // ── Cobrar ───────────────────────────────────────────────────────────────
  const handlePay = async () => {
    if (!calc || !calcResult || !businessId) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const btn   = calc.button;
      const gross = calcResult.charge_amount;

      if (isIntegrated(btn)) {
        // Cobro integrado vía Edge Function
        const action =
          btn.integration_kind === 'mp_qr'   ? 'create_qr'
        : btn.integration_kind === 'mp_point'? 'create_point'
        : 'create_qr';

        const { data, error: invErr } = await supabase.functions.invoke('mp-payments', {
          body: {
            action,
            business_id:    businessId,
            comprobante_id: comprobanteId,
            button_id:      btn.id,
            amount:         gross,
            description:    `Comprobante ${comprobanteId.slice(0, 8)}`,
          },
        });
        if (invErr) throw new Error(invErr.message);
        if (data?.error) throw new Error(data.error);

        // Si es QR, mostrar link de pago
        if (data?.init_point) {
          window.open(data.init_point, '_blank');
        }

        setSubmitOk(true);
      } else {
        // Cobro manual
        const { data, error: invErr } = await supabase.functions.invoke('mp-payments', {
          body: {
            action:          'create_manual',
            business_id:     businessId,
            comprobante_id:  comprobanteId,
            button_id:       btn.id,
            amount:          gross,
            currency:        'ARS',
          },
        });
        if (invErr) throw new Error(invErr.message);
        if (data?.error) throw new Error(data.error);

        setSubmitOk(true);
        setTimeout(() => {
          setCalc(null);
          setSubmitOk(false);
          onPaymentRegistered?.();
        }, 1600);
      }
    } catch (err: any) {
      setSubmitError(err.message || 'Error al procesar el cobro');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
        <Loader2 size={20} style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }

  if (buttons.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '1.5rem', color: '#475569', fontSize: '0.85rem' }}>
        Sin métodos de pago configurados.{' '}
        <a href="/configuracion/pagos" style={{ color: '#818cf8', textDecoration: 'underline' }}>
          Configurar
        </a>
      </div>
    );
  }

  const inputS: React.CSSProperties = {
    width: '100%', padding: '0.625rem 0.875rem',
    backgroundColor: 'rgba(15,23,42,0.8)',
    border: '1px solid rgba(51,65,85,0.6)',
    borderRadius: '0.5rem', color: '#f1f5f9',
    fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>

      {/* Saldo pendiente */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
        <span style={{ fontSize: '0.8rem', color: '#64748b' }}>Saldo a cobrar</span>
        <span style={{
          fontSize: '1.125rem', fontWeight: 700,
          color: saldoPendiente > 0.01 ? '#f59e0b' : '#34d399',
          fontFamily: 'monospace',
        }}>
          {fmtARS(saldoPendiente)}
        </span>
      </div>

      {/* Grid de botones */}
      {!calc && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.5rem' }}>
          {buttons.map(btn => {
            const Icon   = TYPE_ICONS[btn.payment_type] ?? Wallet;
            const feeStr = formatFeeLabel(btn);
            const hasInteg = isIntegrated(btn);
            const mpNeeded = hasInteg && btn.provider === 'mercadopago' && !mpStatus?.connected;

            return (
              <button
                key={btn.id}
                onClick={() => openCalc(btn)}
                disabled={mpNeeded}
                style={{
                  position:        'relative',
                  padding:         '0.875rem',
                  borderRadius:    '0.75rem',
                  border:          `2px solid ${mpNeeded ? 'rgba(255,255,255,0.05)' : btn.color + '44'}`,
                  backgroundColor: mpNeeded ? 'rgba(255,255,255,0.03)' : btn.color + '15',
                  color:           mpNeeded ? '#475569' : btn.color,
                  cursor:          mpNeeded ? 'not-allowed' : 'pointer',
                  textAlign:       'left',
                  transition:      'all 0.15s',
                  opacity:         mpNeeded ? 0.5 : 1,
                }}
                onMouseEnter={e => {
                  if (!mpNeeded) e.currentTarget.style.backgroundColor = btn.color + '25';
                }}
                onMouseLeave={e => {
                  if (!mpNeeded) e.currentTarget.style.backgroundColor = btn.color + '15';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                  <Icon size={16} />
                  {hasInteg && <Zap size={10} style={{ color: '#fbbf24' }} />}
                </div>
                <div style={{ fontSize: '0.8rem', fontWeight: 700, lineHeight: 1.2, marginBottom: '0.25rem' }}>
                  {btn.name}
                </div>
                <div style={{ fontSize: '0.65rem', color: mpNeeded ? '#475569' : btn.color + 'cc', fontWeight: 500 }}>
                  {mpNeeded ? 'Conectar MP' : feeStr}
                </div>
                {mpNeeded && (
                  <div style={{
                    position: 'absolute', top: '0.375rem', right: '0.375rem',
                    fontSize: '0.6rem', color: '#f87171', fontWeight: 600,
                  }}>⚠</div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Calculadora ── */}
      {calc && (
        <div style={{
          backgroundColor: '#0b1120',
          border: `2px solid ${calc.button.color}44`,
          borderRadius: '0.875rem',
          padding: '1.25rem',
          display: 'flex', flexDirection: 'column', gap: '1rem',
        }}>
          {/* Header calculadora */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
              <div style={{
                width: '2rem', height: '2rem', borderRadius: '0.5rem',
                backgroundColor: calc.button.color + '25',
                border: `1px solid ${calc.button.color}44`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Calculator size={14} style={{ color: calc.button.color }} />
              </div>
              <div>
                <div style={{ fontSize: '0.875rem', fontWeight: 700, color: '#f1f5f9' }}>
                  {calc.button.name}
                </div>
                <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                  {calc.button.provider} · {formatFeeLabel(calc.button)}
                  {calc.button.vat_percent > 0 && ` · IVA s/comisión ${fmtPct(calc.button.vat_percent)}`}
                </div>
              </div>
            </div>
            <button
              onClick={() => setCalc(null)}
              style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '1.125rem' }}
            >
              ×
            </button>
          </div>

          {/* Modo de cálculo */}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {(['list', 'net'] as const).map(m => (
              <button
                key={m}
                onClick={() => setCalc(p => p ? { ...p, mode: m } : p)}
                style={{
                  flex: 1, padding: '0.5rem',
                  borderRadius: '0.375rem',
                  border: `2px solid ${calc.mode === m ? calc.button.color : 'rgba(255,255,255,0.08)'}`,
                  backgroundColor: calc.mode === m ? calc.button.color + '20' : 'transparent',
                  color: calc.mode === m ? calc.button.color : '#64748b',
                  fontWeight: 600, fontSize: '0.75rem', cursor: 'pointer',
                }}
              >
                {m === 'list' ? 'Precio de lista' : 'Neto deseado'}
              </button>
            ))}
          </div>

          {/* Input según modo */}
          {calc.mode === 'list' ? (
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>
                Monto a cobrar al cliente
              </label>
              <div style={{ position: 'relative' }}>
                <DollarSign size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                <input
                  type="number" value={calc.grossInput} min="0" step="0.01"
                  onChange={e => setCalc(p => p ? { ...p, grossInput: e.target.value } : p)}
                  style={{ ...inputS, paddingLeft: '2rem', fontFamily: 'monospace', fontSize: '1rem' }}
                />
              </div>
            </div>
          ) : (
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.375rem', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>
                Neto que quiero recibir
              </label>
              <div style={{ position: 'relative' }}>
                <Percent size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                <input
                  type="number" value={calc.netInput} min="0" step="0.01"
                  placeholder={String(saldoPendiente.toFixed(2))}
                  onChange={e => setCalc(p => p ? { ...p, netInput: e.target.value } : p)}
                  style={{ ...inputS, paddingLeft: '2rem', fontFamily: 'monospace', fontSize: '1rem' }}
                />
              </div>
            </div>
          )}

          {/* Resultado del cálculo */}
          {calcResult && (
            <div style={{
              backgroundColor: '#0f1829',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '0.625rem',
              padding: '0.875rem',
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {[
                  { label: 'Total base',         val: totalBruto,                color: '#94a3b8' },
                  { label: 'Cobrar al cliente',   val: calcResult.charge_amount,  color: '#f1f5f9', big: true },
                  { label: 'Comisión estimada',   val: calcResult.fee_amount,     color: '#f59e0b', negative: true },
                  calc.button.vat_percent > 0 && { label: '  IVA s/comisión',    val: calcResult.vat_on_fee, color: '#64748b', negative: true },
                  { label: 'Neto a recibir',      val: calcResult.net_amount,     color: '#34d399', big: true },
                ].filter(Boolean).map((row: any) => (
                  <div key={row.label} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    ...(row.big ? { borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.375rem', marginTop: '0.125rem' } : {}),
                  }}>
                    <span style={{ fontSize: '0.8rem', color: '#64748b' }}>{row.label}</span>
                    <span style={{
                      fontFamily: 'monospace',
                      fontWeight: row.big ? 700 : 500,
                      fontSize: row.big ? '1rem' : '0.875rem',
                      color: row.color,
                    }}>
                      {row.negative ? '−' : ''}{fmtARS(row.val)}
                    </span>
                  </div>
                ))}

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
                  <span style={{ fontSize: '0.7rem', color: '#475569' }}>
                    Tasa efectiva: {fmtPct(calcResult.effective_rate)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Errores */}
          {submitError && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.625rem 0.875rem',
              backgroundColor: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: '0.5rem', color: '#fca5a5', fontSize: '0.8rem',
            }}>
              <AlertCircle size={14} />
              {submitError}
            </div>
          )}

          {submitOk && !isIntegrated(calc.button) && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.625rem 0.875rem',
              backgroundColor: 'rgba(52,211,153,0.1)',
              border: '1px solid rgba(52,211,153,0.3)',
              borderRadius: '0.5rem', color: '#34d399', fontSize: '0.8rem',
            }}>
              <CheckCircle2 size={14} />
              Cobro registrado correctamente
            </div>
          )}

          {submitOk && isIntegrated(calc.button) && (
            <div style={{
              padding: '0.75rem', backgroundColor: 'rgba(99,102,241,0.1)',
              border: '1px solid rgba(99,102,241,0.3)', borderRadius: '0.5rem',
              fontSize: '0.8rem', color: '#818cf8',
            }}>
              Orden creada en Mercado Pago. Esperando confirmación de pago via webhook.
            </div>
          )}

          {/* Acciones */}
          {!submitOk && calcResult && (
            <div style={{ display: 'flex', gap: '0.625rem' }}>
              <button
                onClick={() => setCalc(null)}
                style={{
                  padding: '0.625rem 1rem', color: '#94a3b8',
                  backgroundColor: 'transparent',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '0.5rem', cursor: 'pointer', fontSize: '0.8rem',
                }}
              >
                Cancelar
              </button>

              <button
                onClick={handlePay}
                disabled={submitting}
                style={{
                  flex: 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                  padding: '0.625rem 1rem',
                  backgroundColor: submitting ? calc.button.color + '80' : calc.button.color,
                  border: 'none', color: '#fff',
                  borderRadius: '0.5rem', cursor: submitting ? 'not-allowed' : 'pointer',
                  fontWeight: 600, fontSize: '0.8rem',
                  transition: 'opacity 0.15s',
                }}
              >
                {submitting ? (
                  <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Procesando...</>
                ) : isIntegrated(calc.button) ? (
                  <><Zap size={14} /> Crear orden {fmtARS(calcResult.charge_amount)}</>
                ) : (
                  <><CheckCircle2 size={14} /> Registrar cobro {fmtARS(calcResult.charge_amount)}</>
                )}
              </button>
            </div>
          )}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
