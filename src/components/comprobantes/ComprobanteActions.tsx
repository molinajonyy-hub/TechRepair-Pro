import { useState } from 'react';
import {
  Send,
  Download,
  RotateCcw,
  Printer,
  AlertTriangle,
  CheckCircle,
  X,
  Shield,
  Clock,
  Ban,
  FileText,
} from 'lucide-react';
import { Comprobante } from '../../hooks/useComprobantes';

interface ComprobanteActionsProps {
  comprobante: Comprobante;
  onEmitir: () => void;
  onAnular: (motivo: string) => void;
  onDescargarPDF: () => void;
  onImprimir: () => void;
  onCrearNotaCredito?: () => void;
  emitiendo?: boolean;
  pdfLoading?: boolean;
}

export function ComprobanteActions({
  comprobante,
  onEmitir,
  onAnular,
  onDescargarPDF,
  onImprimir,
  onCrearNotaCredito,
  emitiendo = false,
  pdfLoading = false,
}: ComprobanteActionsProps) {
  const [showAnularModal, setShowAnularModal] = useState(false);
  const [motivoAnulacion, setMotivoAnulacion] = useState('');
  const [emitirConfirm, setEmitirConfirm] = useState(false);

  const esBorrador = comprobante.estado === 'borrador';
  const esEmitido = comprobante.estado === 'emitido' || !!comprobante.cae;
  const esAnulado = comprobante.estado === 'anulado';
  const esPendienteConciliacion = esBorrador && comprobante.estado_fiscal === 'pendiente_conciliacion';
  const esCobradoPendienteArca = esBorrador && !esPendienteConciliacion && (comprobante.total_cobrado || 0) > 0 && !comprobante.cae && comprobante.estado_fiscal !== 'emitido';

  const handleEmitirClick = () => {
    if (!emitirConfirm) {
      setEmitirConfirm(true);
      setTimeout(() => setEmitirConfirm(false), 4000);
    } else {
      onEmitir();
      setEmitirConfirm(false);
    }
  };

  // Status colors
  const statusColor = esAnulado ? 'var(--error)' : esEmitido ? 'var(--success)' : esPendienteConciliacion ? '#a78bfa' : esCobradoPendienteArca ? '#60a5fa' : 'var(--warning)';
  const statusBg = esAnulado ? 'var(--error-subtle)' : esEmitido ? 'var(--success-subtle)' : esPendienteConciliacion ? 'rgba(167,139,250,0.1)' : esCobradoPendienteArca ? 'rgba(96,165,250,0.1)' : 'var(--warning-light)';
  const statusBorder = esAnulado ? 'var(--error)' : esEmitido ? 'var(--success)' : esPendienteConciliacion ? 'rgba(167,139,250,0.4)' : esCobradoPendienteArca ? 'rgba(96,165,250,0.4)' : 'var(--warning)';
  const statusLabel = esAnulado ? 'Comprobante anulado' : esEmitido ? 'Emitido y válido' : esPendienteConciliacion ? 'Pendiente de verificación' : esCobradoPendienteArca ? 'Cobrado / Pendiente ARCA' : 'Pendiente de emisión';
  const statusSub = esAnulado
    ? 'Sin validez fiscal'
    : esEmitido
    ? comprobante.cae ? `CAE: ${comprobante.cae.slice(0, 12)}…` : 'Autorizado por AFIP'
    : esPendienteConciliacion
    ? 'ARCA podría haberlo recibido — no reintentar manualmente'
    : esCobradoPendienteArca
    ? 'Cobro registrado · sin emisión fiscal'
    : 'Debe emitirse en AFIP';
  const StatusIcon = esAnulado ? Ban : esEmitido ? Shield : esPendienteConciliacion ? AlertTriangle : esCobradoPendienteArca ? CheckCircle : Clock;

  return (
    <>
      <div className="card" style={{ overflow: 'hidden' }}>
        {/* Status header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          padding: '1rem', background: statusBg,
          borderBottom: `1px solid ${statusBorder}`,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10, flexShrink: 0,
            background: statusBg, border: `1px solid ${statusBorder}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <StatusIcon size={16} style={{ color: statusColor }} />
          </div>
          <div>
            <p style={{ color: statusColor, fontSize: '0.8rem', fontWeight: 600, margin: 0 }}>
              {statusLabel}
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.72rem', margin: '0.125rem 0 0' }}>
              {statusSub}
            </p>
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ padding: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>

          {/* Emitir AFIP */}
          {esBorrador && (
            <button
              onClick={handleEmitirClick}
              disabled={emitiendo}
              className={emitirConfirm ? 'btn' : 'btn btn-primary'}
              style={emitirConfirm ? {
                background: 'var(--success)', color: '#fff', width: '100%',
                justifyContent: 'center', opacity: emitiendo ? 0.7 : 1,
              } : { width: '100%', justifyContent: 'center', opacity: emitiendo ? 0.7 : 1 }}
            >
              {emitiendo ? (
                <>
                  <span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'tr-spin 0.8s linear infinite' }} />
                  Emitiendo...
                </>
              ) : emitirConfirm ? (
                <><CheckCircle size={15} /> Confirmar emisión</>
              ) : (
                <><Send size={15} /> Emitir en AFIP</>
              )}
            </button>
          )}

          {/* Descargar PDF */}
          {esEmitido && (
            <button onClick={onDescargarPDF} className="btn btn-outline" disabled={pdfLoading} style={{ width: '100%', justifyContent: 'center' }}>
              <Download size={15} /> {pdfLoading ? 'Generando...' : 'Descargar PDF'}
            </button>
          )}

          {/* Imprimir */}
          <button onClick={onImprimir} className="btn btn-outline" style={{ width: '100%', justifyContent: 'center' }}>
            <Printer size={15} /> Imprimir
          </button>

          {/* Nota de crédito */}
          {esEmitido && ['factura_a','factura_c'].includes(comprobante.tipo) && onCrearNotaCredito && (
            <button
              onClick={onCrearNotaCredito}
              className="btn btn-outline"
              style={{ width: '100%', justifyContent: 'center' }}
              title="Crear una nota de crédito vinculada a este comprobante"
            >
              <FileText size={15} /> Nota de crédito
            </button>
          )}

          {/* Anular — solo si NUNCA fue autorizado por ARCA. Un comprobante con
              CAE no puede anularse cambiando estado local (regla fiscal); para
              eso está el botón "Nota de crédito" de arriba. */}
          {esEmitido && !comprobante.cae && (
            <button
              onClick={() => setShowAnularModal(true)}
              className="btn"
              style={{
                width: '100%', justifyContent: 'center',
                color: 'var(--error)', background: 'var(--error-subtle)',
                border: '1px solid var(--error)',
              }}
            >
              <RotateCcw size={15} /> Anular comprobante
            </button>
          )}
        </div>

        {/* Info banners */}
        {esBorrador && (
          <div style={{ padding: '0 0.875rem 0.875rem' }}>
            <div style={{
              display: 'flex', gap: '0.5rem', padding: '0.625rem',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--warning-light)', border: '1px solid var(--warning)',
            }}>
              <AlertTriangle size={13} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 2 }} />
              <p style={{ color: 'var(--warning)', fontSize: '0.72rem', lineHeight: 1.4, margin: 0 }}>
                El comprobante en borrador no tiene validez fiscal hasta ser emitido en AFIP.
              </p>
            </div>
          </div>
        )}

        {comprobante.cae && (
          <div style={{ padding: '0 0.875rem 0.875rem' }}>
            <div style={{
              display: 'flex', gap: '0.5rem', padding: '0.625rem',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--success-subtle)', border: '1px solid var(--success)',
            }}>
              <Shield size={13} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 2 }} />
              <div>
                <p style={{ color: 'var(--success)', fontSize: '0.72rem', fontWeight: 600, margin: 0 }}>Validado por AFIP</p>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.68rem', fontFamily: 'monospace', wordBreak: 'break-all', margin: '0.125rem 0 0' }}>
                  {comprobante.cae}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Modal de anulación */}
      {showAnularModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 9999, padding: '1rem',
        }}>
          <div className="card" style={{ maxWidth: 440, width: '100%', padding: '1.5rem', boxShadow: 'var(--shadow-xl)' }}>
            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                background: 'var(--error-subtle)', border: '1px solid var(--error)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <AlertTriangle size={18} style={{ color: 'var(--error)' }} />
              </div>
              <div style={{ flex: 1 }}>
                <h3 style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '1rem', margin: 0 }}>
                  Anular comprobante
                </h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0.125rem 0 0' }}>
                  Esta acción no se puede deshacer
                </p>
              </div>
              <button
                onClick={() => { setShowAnularModal(false); setMotivoAnulacion(''); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0.25rem', borderRadius: 6 }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Textarea */}
            <label style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
              Motivo de anulación <span style={{ color: 'var(--error)' }}>*</span>
            </label>
            <textarea
              value={motivoAnulacion}
              onChange={e => setMotivoAnulacion(e.target.value)}
              placeholder="Ej: Error en datos del cliente, duplicado, etc."
              rows={3}
              autoFocus
              style={{
                width: '100%', padding: '0.625rem 0.75rem',
                background: 'var(--input-bg)', border: '1px solid var(--input-border)',
                borderRadius: 'var(--radius-md)', color: 'var(--text-primary)',
                fontSize: '0.875rem', resize: 'none', outline: 'none',
                boxSizing: 'border-box', marginBottom: '1rem',
              }}
              onFocus={e => (e.target.style.borderColor = 'var(--error)')}
              onBlur={e => (e.target.style.borderColor = 'var(--input-border)')}
            />

            {/* Warning note */}
            <div style={{
              padding: '0.625rem 0.75rem', borderRadius: 'var(--radius-sm)',
              background: 'var(--warning-light)', border: '1px solid var(--warning)',
              marginBottom: '1.25rem',
            }}>
              <p style={{ color: 'var(--warning)', fontSize: '0.75rem', margin: 0, lineHeight: 1.5 }}>
                <strong>Nota:</strong> Si el comprobante tiene CAE, deberás generar una Nota de Crédito en AFIP para compensarlo.
              </p>
            </div>

            {/* Buttons */}
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                onClick={() => { setShowAnularModal(false); setMotivoAnulacion(''); }}
                className="btn btn-outline"
                style={{ flex: 1, justifyContent: 'center' }}
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  if (motivoAnulacion.trim()) {
                    onAnular(motivoAnulacion);
                    setShowAnularModal(false);
                    setMotivoAnulacion('');
                  }
                }}
                disabled={!motivoAnulacion.trim()}
                className="btn"
                style={{
                  flex: 1, justifyContent: 'center',
                  background: motivoAnulacion.trim() ? 'var(--error)' : 'var(--error-subtle)',
                  color: '#fff', border: '1px solid var(--error)',
                  opacity: motivoAnulacion.trim() ? 1 : 0.6,
                  cursor: motivoAnulacion.trim() ? 'pointer' : 'not-allowed',
                }}
              >
                Confirmar anulación
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
