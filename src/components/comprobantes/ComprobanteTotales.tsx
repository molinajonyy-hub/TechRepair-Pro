import { TipoComprobante } from '../../hooks/useComprobantes';

interface ComprobanteTotalesProps {
  subtotal: number;
  impuestos: number;
  total: number;
  tipo: TipoComprobante;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value);
}

export function ComprobanteTotales({ subtotal, impuestos, total, tipo }: ComprobanteTotalesProps) {
  const showIva = tipo === 'factura_a';
  const esNotaCredito = tipo === 'nota_credito';
  const sign = esNotaCredito ? '- ' : '';

  return (
    <div style={{ padding: '1.25rem 1.5rem', display: 'flex', justifyContent: 'flex-end', background: 'var(--bg-card)' }}>
      <div style={{ width: 280 }}>
        <p style={{ fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--text-subtle)', marginBottom: '0.75rem', marginTop: 0 }}>
          Resumen de importes
        </p>

        {/* Subtotal row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.375rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Subtotal</span>
          <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: '0.875rem' }}>
            {sign}{formatCurrency(subtotal)}
          </span>
        </div>

        {/* IVA row (Factura A only) */}
        {showIva && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.375rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              IVA 21%{' '}
              <span style={{ color: 'var(--text-subtle)', fontSize: '0.75rem' }}>(Resp. Inscripto)</span>
            </span>
            <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: '0.875rem' }}>
              {sign}{formatCurrency(impuestos)}
            </span>
          </div>
        )}

        {/* Note for non-Factura A */}
        {tipo === 'factura_c' && (
          <p style={{ color: 'var(--text-subtle)', fontSize: '0.72rem', fontStyle: 'italic', padding: '0.375rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
            IVA incluido en el precio (Consumidor Final)
          </p>
        )}
        {tipo === 'remito' && (
          <p style={{ color: 'var(--text-subtle)', fontSize: '0.72rem', fontStyle: 'italic', padding: '0.375rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
            Remito — sin impuestos
          </p>
        )}

        {/* Total highlight */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: '0.75rem', padding: '1rem',
          borderRadius: 'var(--radius-md)',
          background: esNotaCredito ? 'var(--error-subtle)' : 'var(--accent-primary-subtle)',
          border: `1px solid ${esNotaCredito ? 'var(--error)' : 'var(--accent-primary-light)'}`,
        }}>
          <div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', margin: 0 }}>
              {esNotaCredito ? 'Total a devolver' : 'Total a pagar'}
            </p>
            <p style={{ color: 'var(--text-subtle)', fontSize: '0.68rem', margin: '0.125rem 0 0' }}>
              Pesos Argentinos (ARS)
            </p>
          </div>
          <span style={{
            fontFamily: 'monospace', fontWeight: 800, fontSize: '1.5rem',
            color: esNotaCredito ? 'var(--error)' : 'var(--text-primary)',
          }}>
            {sign}{formatCurrency(total)}
          </span>
        </div>
      </div>
    </div>
  );
}
