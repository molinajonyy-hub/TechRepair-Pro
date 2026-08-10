import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { colors, fontSize } from '../../../lib/tokens'
import { useFinanceChartsL1 } from '../../../hooks/useFinanceChartsL1'
import { ChartCard, type CardState } from './ChartCard'
import { KpiBand } from './KpiBand'
import { ResultChart, resultSummaryText, OwnerWithdrawalsNote } from './ResultChart'
import {
  BillingVsCollectionsChart, billingSummaryText, BillingLegendNote,
} from './BillingVsCollectionsChart'
import { ResultWaterfall, waterfallSummaryText } from './ResultWaterfall'
import { PaymentMixChart, paymentMixSummaryText } from './PaymentMixChart'
import {
  AgingChart, PayablesDueBlock, receivablesSummaryText, payablesSummaryText,
} from './AgingCharts'
import {
  InventoryCapitalBlock, DeadStockContext, inventorySummaryText,
} from './InventoryCapitalBlock'
import { capitalCoverage } from '../../../lib/finance/chartsL1Presentation'
import type { ChartGranularity } from '../../../services/financeChartsService'

// ─── Charts L1 — orquestador ─────────────────────────────────────────────────
//
// Jerarquía (§20):
//   [ KPI ]
//   [ Resultado del negocio — ancho completo ]
//   [ Facturación vs cobros ] [ Cómo cobraste ]
//   [ Capital en stock / Reposición — bloque destacado ]
//   [ Cuentas por cobrar ] [ Deuda proveedores ]
//   [ Cómo se construyó tu resultado ]
//
// El selector de período y el panel M8 viven en FinanceDashboard: este bloque
// los recibe ya resueltos y no los duplica.
//
// Una tarjeta que falle NO tumba a las demás: el estado se resuelve por tarjeta
// a partir de un único payload.

export interface FinanceChartsL1Props {
  businessId: string
  periodStart: string
  periodEnd: string
  granularity?: ChartGranularity | 'auto'
  /** Valor inmovilizado que reportó la regla `dead_stock` de M8, si disparó. */
  deadStockValue?: number | null
}

const gridDos: React.CSSProperties = {
  display: 'grid',
  // En desktop, máximo dos secundarios por fila; en móvil, una sola columna.
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: '1rem',
}

export default function FinanceChartsL1({
  businessId, periodStart, periodEnd, granularity = 'auto', deadStockValue = null,
}: FinanceChartsL1Props) {
  const { data, status, error, stale, refresh } = useFinanceChartsL1({
    businessId, periodStart, periodEnd, granularity,
  })

  // Estado base compartido por todas las tarjetas. Cada una puede endurecerlo
  // (p. ej. a `empty` si su propia sección no tiene datos) pero nunca ablandarlo.
  const base: CardState =
    status === 'loading' ? 'loading'
    : status === 'restricted' ? 'restricted'
    : status === 'unavailable' ? 'unavailable'
    : stale ? 'stale'
    : 'available'

  const cargando = status === 'loading' || status === 'idle'

  /** Degrada a `empty` cuando la sección puntual no tiene nada que mostrar. */
  const withEmpty = (vacio: boolean): CardState =>
    base === 'available' || base === 'stale' ? (vacio ? 'empty' : base) : base

  const g = data?.period.granularity ?? 'day'
  const cobertura = capitalCoverage(data?.inventory_capital)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }} data-testid="finance-charts-l1">

      {/* ── KPI ── */}
      <KpiBand data={data} loading={cargando} />

      {/* ── Resultado del negocio (ancho completo) ── */}
      <ChartCard
        testId="card-result"
        title="Resultado del negocio"
        subtitle="¿Estoy ganando?"
        summary={data ? resultSummaryText(data.summary) : undefined}
        state={withEmpty(!data?.pnl_series.length)}
        error={error}
        onRetry={refresh}
        stale={stale}
        height={280}
        footer={data ? <OwnerWithdrawalsNote amount={data.summary.owner_withdrawals} /> : undefined}
      >
        {data && <ResultChart series={data.pnl_series} granularity={g} summary={data.summary} />}
      </ChartCard>

      {/* ── Facturación vs cobros · Cómo cobraste ── */}
      <div style={gridDos}>
        <ChartCard
          testId="card-billing"
          title="Facturación vs cobros"
          subtitle="¿Estoy vendiendo pero no cobrando?"
          summary={data ? billingSummaryText(data.summary) : undefined}
          state={withEmpty(!data?.billing_vs_collections.length)}
          error={error}
          onRetry={refresh}
          stale={stale}
          height={240}
          footer={<BillingLegendNote />}
        >
          {data && <BillingVsCollectionsChart series={data.billing_vs_collections} granularity={g} />}
        </ChartCard>

        <ChartCard
          testId="card-payment-mix"
          title="Cómo cobraste"
          subtitle="¿Cómo entra el dinero?"
          summary={data ? paymentMixSummaryText(data.payment_mix) : undefined}
          state={withEmpty(!data?.payment_mix.some(m => m.amount > 0))}
          error={error}
          onRetry={refresh}
          stale={stale}
          height={200}
        >
          {data && <PaymentMixChart mix={data.payment_mix} />}
        </ChartCard>
      </div>

      {/* ── Capital en stock — bloque destacado, pero por debajo de Resultado ── */}
      <ChartCard
        testId="card-inventory-capital"
        title="Capital en stock"
        subtitle="¿Cuánto capital tengo puesto en mercadería?"
        summary={data ? inventorySummaryText(data.inventory_capital, data.inventory_flows) : undefined}
        state={
          base === 'available' || base === 'stale'
            ? (cobertura.incomplete ? 'incomplete' : base)
            : base
        }
        incompleteNote={cobertura.text ?? undefined}
        error={error}
        onRetry={refresh}
        stale={stale}
        height={260}
        footer={
          data
            ? <DeadStockContext capital={data.inventory_capital} deadValue={deadStockValue} />
            : undefined
        }
      >
        {data && (
          <InventoryCapitalBlock capital={data.inventory_capital} flows={data.inventory_flows} />
        )}
      </ChartCard>

      {/* ── Cartera ── */}
      <div style={gridDos}>
        <ChartCard
          testId="card-receivables"
          title="Cuentas por cobrar"
          subtitle="¿Cuánto me deben y desde cuándo?"
          summary={data ? receivablesSummaryText(data.receivables_aging) : undefined}
          state={withEmpty(!data?.receivables_aging.buckets.length)}
          error={error}
          onRetry={refresh}
          stale={stale}
          height={190}
          action={
            <Link to="/cuentas" className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}>
              Ver cuentas corrientes <ChevronRight size={12} />
            </Link>
          }
        >
          {data && (
            <AgingChart
              section={data.receivables_aging}
              documentLabel={{ one: 'Comprobante', many: 'Comprobantes' }}
            />
          )}
        </ChartCard>

        <ChartCard
          testId="card-payables"
          title="Deuda con proveedores"
          subtitle="¿Cuánto debo?"
          summary={data ? payablesSummaryText(data.payables_aging) : undefined}
          state={withEmpty(!data?.payables_aging.buckets.length)}
          error={error}
          onRetry={refresh}
          stale={stale}
          height={190}
          footer={data ? <PayablesDueBlock due={data.payables_due} /> : undefined}
          action={
            <Link to="/suppliers" className="btn btn-ghost btn-sm" style={{ flexShrink: 0 }}>
              Ver proveedores <ChevronRight size={12} />
            </Link>
          }
        >
          {data && (
            <AgingChart
              section={data.payables_aging}
              documentLabel={{ one: 'Compra', many: 'Compras' }}
            />
          )}
        </ChartCard>
      </div>

      {/* ── Waterfall ── */}
      <ChartCard
        testId="card-waterfall"
        title="Cómo se construyó tu resultado"
        subtitle="¿Qué se está comiendo mi ganancia?"
        summary={data ? waterfallSummaryText(data.summary) : undefined}
        state={withEmpty(!data?.waterfall.length)}
        error={error}
        onRetry={refresh}
        stale={stale}
        height={280}
        footer={
          data && data.summary.owner_withdrawals > 0
            ? <OwnerWithdrawalsNote amount={data.summary.owner_withdrawals} />
            : undefined
        }
      >
        {data && <ResultWaterfall steps={data.waterfall} />}
      </ChartCard>

      {/* ── Nota de alcance ── */}
      <p style={{ margin: 0, fontSize: fontSize.xs, color: colors.text.muted, lineHeight: 1.5 }}>
        Los importes se calculan sobre el período seleccionado, salvo cuentas por cobrar,
        deuda con proveedores y capital en stock, que reflejan el estado actual.
      </p>
    </div>
  )
}
