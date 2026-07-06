import { Link } from 'react-router-dom'
import { BarChart3, ArrowRight } from 'lucide-react'

// Ruta /finance/reports DEPRECADA. El "Panel Financiero" legacy calculaba el P&L
// desde business_finance_entries crudo (modelo viejo, contaminado por
// compras/pagos a proveedor/retiros). Bajo el modelo canónico de Etapa 1 esa
// pantalla quedó obsoleta: la rentabilidad, caja y posición viven en /finance
// (FinanceDashboard v2, vistas canónicas). Se conserva la ruta para bookmarks,
// sin resucitar el P&L viejo y sin crashear.
export const FINANCE_CANONICAL_ROUTE = '/finance'

export function FinanceReportsNotice() {
  return (
    <div style={{ padding: '1.5rem', maxWidth: '640px', margin: '0 auto' }}>
      <div
        data-testid="finance-reports-deprecated"
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
          gap: '1rem', padding: '2.5rem 1.75rem', marginTop: '2rem',
          background: 'rgba(99,102,241,0.06)',
          border: '1px solid rgba(99,102,241,0.25)',
          borderRadius: '1rem',
        }}
      >
        <div style={{
          width: '56px', height: '56px', borderRadius: '0.875rem',
          background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <BarChart3 size={26} style={{ color: '#818cf8' }} />
        </div>
        <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>
          Actualizamos el análisis financiero
        </h1>
        <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6, maxWidth: '460px' }}>
          Actualizamos el análisis financiero para usar el nuevo modelo contable. Ahora podés ver
          rentabilidad, caja y posición financiera desde el panel de Finanzas.
        </p>
        <Link
          to={FINANCE_CANONICAL_ROUTE}
          className="btn btn-primary btn-lift"
          data-testid="finance-reports-cta"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}
        >
          Ir al panel de Finanzas <ArrowRight size={15} />
        </Link>
      </div>
    </div>
  )
}
