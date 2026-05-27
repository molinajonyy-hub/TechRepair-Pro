import { TipoComprobante } from '../../hooks/useComprobantes';
import { getComprobanteDisplayStatus } from '../../utils/comprobanteStatus';

interface ComprobanteHeaderProps {
  tipo: TipoComprobante;
  numero: string | null;
  estado: 'borrador' | 'emitido' | 'anulado';
  puntoVenta: string;
  estadoFiscal?: string | null;
  cae?: string | null;
  totalCobrado?: number | null;
}

const TIPO_CONFIG: Record<TipoComprobante, {
  label: string;
  docLabel: string;
  letra: string;
  color: string;
  bg: string;
  border: string;
}> = {
  factura_a: {
    label: 'FACTURA A',
    docLabel: 'FACTURA',
    letra: 'A',
    color: '#3b82f6',
    bg: 'rgba(59,130,246,0.10)',
    border: 'rgba(59,130,246,0.35)',
  },
  factura_c: {
    label: 'FACTURA C',
    docLabel: 'FACTURA',
    letra: 'C',
    color: '#8b5cf6',
    bg: 'rgba(139,92,246,0.10)',
    border: 'rgba(139,92,246,0.35)',
  },
  remito: {
    label: 'REMITO',
    docLabel: 'REMITO',
    letra: 'R',
    color: '#10b981',
    bg: 'rgba(16,185,129,0.10)',
    border: 'rgba(16,185,129,0.35)',
  },
  nota_credito: {
    label: 'NOTA DE CRÉDITO',
    docLabel: 'NOTA DE\nCRÉDITO',
    letra: 'NC',
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.10)',
    border: 'rgba(245,158,11,0.35)',
  },
};

const ESTADO_CONFIG: Record<string, { label: string; dotColor: string; badgeBg: string; badgeColor: string; badgeBorder: string }> = {
  borrador: {
    label: 'Borrador',
    dotColor: 'var(--text-subtle)',
    badgeBg: 'var(--bg-surface)',
    badgeColor: 'var(--text-secondary)',
    badgeBorder: 'var(--border-color)',
  },
  cobrado_pendiente_arca: {
    label: 'Cobrado / Pendiente ARCA',
    dotColor: '#60a5fa',
    badgeBg: 'rgba(96,165,250,0.1)',
    badgeColor: '#60a5fa',
    badgeBorder: 'rgba(96,165,250,0.4)',
  },
  emitido_arca: {
    label: 'Emitido ARCA',
    dotColor: 'var(--success)',
    badgeBg: 'var(--success-subtle)',
    badgeColor: 'var(--success)',
    badgeBorder: 'var(--success)',
  },
  error_arca: {
    label: 'Error ARCA',
    dotColor: 'var(--error)',
    badgeBg: 'var(--error-subtle)',
    badgeColor: 'var(--error)',
    badgeBorder: 'var(--error)',
  },
  anulado: {
    label: 'Anulado',
    dotColor: 'var(--error)',
    badgeBg: 'var(--error-subtle)',
    badgeColor: 'var(--error)',
    badgeBorder: 'var(--error)',
  },
};

function padPV(pv: string) {
  return pv.replace(/\D/g, '').padStart(4, '0');
}

function formatNumero(numero: string | null, puntoVenta: string) {
  const pv = padPV(puntoVenta);
  if (!numero) return `${pv}---------`;
  const num = numero.replace(/\D/g, '').padStart(8, '0');
  return `${pv}-${num}`;
}

export function ComprobanteHeader({ tipo, numero, estado, puntoVenta, estadoFiscal, cae, totalCobrado }: ComprobanteHeaderProps) {
  const cfg = TIPO_CONFIG[tipo] ?? TIPO_CONFIG.factura_c;
  const displayStatus = getComprobanteDisplayStatus({ estado, estado_fiscal: estadoFiscal, cae, total_cobrado: totalCobrado })
  const est = ESTADO_CONFIG[displayStatus.key] ?? ESTADO_CONFIG.borrador;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto 1fr',
      alignItems: 'center',
      gap: '1.5rem',
      padding: '1.5rem',
      background: 'var(--bg-tertiary)',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Subtle watermark letter */}
      <div style={{
        position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)',
        fontSize: '9rem', fontWeight: 900, lineHeight: 1, color: cfg.color,
        opacity: 0.04, pointerEvents: 'none', userSelect: 'none', fontFamily: 'monospace',
      }}>
        {cfg.letra}
      </div>

      {/* Left — Company */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          boxShadow: '0 4px 12px rgba(99,102,241,0.30)',
        }}>
          <span style={{ color: '#fff', fontWeight: 900, fontSize: '1rem', fontFamily: 'monospace' }}>T</span>
        </div>
        <div>
          <p style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '1rem', margin: 0, lineHeight: 1.2 }}>TechRepair</p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', margin: '0.125rem 0 0' }}>Servicio Técnico</p>
        </div>
      </div>

      {/* Center — Argentine-style document type box */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
        <p style={{
          fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.18em',
          textTransform: 'uppercase', color: 'var(--text-subtle)', margin: 0,
        }}>
          {cfg.docLabel.split('\n')[0]}
          {cfg.docLabel.includes('\n') && <><br />{cfg.docLabel.split('\n')[1]}</>}
        </p>
        <div style={{
          width: 64, height: 64, borderRadius: 12,
          border: `2px solid ${cfg.border}`,
          background: cfg.bg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{ fontSize: '2rem', fontWeight: 900, color: cfg.color, fontFamily: 'monospace', lineHeight: 1 }}>
            {cfg.letra}
          </span>
        </div>
        <p style={{ fontSize: '0.6rem', color: 'var(--text-subtle)', margin: 0 }}>Código de tipo</p>
      </div>

      {/* Right — Number, PV, status */}
      <div style={{ textAlign: 'right' }}>
        <p style={{ fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text-subtle)', margin: '0 0 0.25rem' }}>
          Comprobante N°
        </p>
        <p style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '1.25rem', color: cfg.color, margin: 0, letterSpacing: '0.05em' }}>
          {formatNumero(numero, puntoVenta)}
        </p>
        <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: '0.25rem 0 0.75rem' }}>
          Pto. Venta {padPV(puntoVenta)}
        </p>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
          padding: '0.25rem 0.75rem', borderRadius: 9999,
          background: est.badgeBg,
          border: `1px solid ${est.badgeBorder}`,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: est.dotColor,
            display: 'inline-block',
            ...(displayStatus.key === 'emitido_arca' ? { boxShadow: `0 0 4px ${est.dotColor}` } : {}),
          }} />
          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: est.badgeColor }}>{est.label}</span>
        </div>
      </div>
    </div>
  );
}
