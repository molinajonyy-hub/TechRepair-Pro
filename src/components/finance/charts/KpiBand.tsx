import type { ReactNode } from 'react'
import { TrendingUp, Wallet, Percent, Banknote, Package } from 'lucide-react'
import { colors, radius, fontSize } from '../../../lib/tokens'
import {
  buildDelta, formatARS, formatPercent, AUSENTE,
  type DeltaInfo, type DeltaSemantics,
} from '../../../lib/finance/chartsL1Presentation'
import type { FinanceChartsL1 } from '../../../services/financeChartsService'

// ─── Charts L1 — banda de KPI (§6) ───────────────────────────────────────────
//
// Regla de color: NO se pinta verde sólo porque un número subió.
//   · resultado / ingresos / cobros → más es mejor
//   · capital en stock              → NEUTRAL siempre
//
// Un inventario que crece no es automáticamente bueno (puede ser mercadería
// que no rota) ni uno que baja es automáticamente malo (puede ser una decisión
// deliberada). Sin evidencia adicional, no se opina.

const TONE_COLOR: Record<string, string> = {
  good: 'var(--success)',
  bad: 'var(--error)',
  neutral: 'var(--text-subtle)',
}

interface KpiProps {
  label: string
  value: string
  icon: ReactNode
  accent: string
  delta?: DeltaInfo
  /** Texto alternativo cuando la métrica no admite comparación. */
  note?: string
  testId?: string
}

function Kpi({ label, value, icon, accent, delta, note, testId }: KpiProps) {
  const deltaText = delta?.available ? delta.label : note ?? delta?.label
  const deltaColor = delta?.available ? TONE_COLOR[delta.tone] : colors.text.muted

  return (
    <div
      data-testid={testId}
      style={{
        background: 'var(--bg-card-solid)',
        border: `1px solid ${colors.border.default}`,
        borderRadius: radius.md,
        padding: '0.85rem 0.95rem',
        display: 'flex', gap: '0.7rem', alignItems: 'flex-start', minWidth: 0,
      }}
    >
      <div aria-hidden="true" style={{
        width: 32, height: 32, flexShrink: 0, borderRadius: radius.sm,
        background: `${accent}1f`, color: accent,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{icon}</div>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.04em',
          textTransform: 'uppercase', color: colors.text.muted, marginBottom: '0.15rem',
        }}>{label}</div>
        {/* El importe NUNCA se parte: "$ 1.941.000,0 / 0" es ilegible y parece
            un bug. En vez de romper el número, se achica la tipografía cuando el
            valor es largo y se deja que la tarjeta lo recorte con ellipsis si
            aun así no entra. El valor completo sigue accesible por `title`. */}
        <div
          title={value}
          style={{
            fontSize: value.length > 15 ? fontSize.base : value.length > 12 ? fontSize.md : fontSize.lg,
            fontWeight: 800, color: colors.text.primary,
            fontVariantNumeric: 'tabular-nums', lineHeight: 1.15,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >{value}</div>
        {deltaText && (
          <div style={{ fontSize: '0.66rem', color: deltaColor, marginTop: '0.2rem', lineHeight: 1.3 }}>
            {deltaText}
          </div>
        )}
      </div>
    </div>
  )
}

export interface KpiBandProps {
  data: FinanceChartsL1 | null
  loading: boolean
}

export function KpiBand({ data, loading }: KpiBandProps) {
  const grid: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: '0.75rem',
  }

  if (loading || !data) {
    return (
      <div style={grid} data-testid="charts-l1-kpi-band" aria-busy="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} aria-hidden="true" style={{
            height: 78, borderRadius: radius.md, background: colors.bg.card,
            animation: 'pulse 1.4s ease-in-out infinite',
          }} />
        ))}
      </div>
    )
  }

  const { summary, comparison, inventory_capital: cap } = data
  const cmpOk = comparison.available

  const d = (cur: number | null, prev: number | null, sem: DeltaSemantics) =>
    buildDelta(cur, prev, sem, cmpOk)

  return (
    <div style={grid} data-testid="charts-l1-kpi-band">
      <Kpi
        testId="kpi-net-sales"
        label="Ingresos netos"
        value={formatARS(summary.net_sales)}
        icon={<TrendingUp size={15} />}
        accent="#6366f1"
        delta={d(summary.net_sales, comparison.net_sales, 'positive')}
      />
      <Kpi
        testId="kpi-operating-result"
        label="Resultado operativo"
        value={formatARS(summary.operating_result)}
        icon={<Wallet size={15} />}
        accent={summary.operating_result >= 0 ? '#10b981' : '#ef4444'}
        delta={d(summary.operating_result, comparison.operating_result, 'positive')}
      />
      <Kpi
        testId="kpi-margin"
        label="Margen"
        value={summary.margin_pct === null ? AUSENTE : formatPercent(summary.margin_pct, { ya100: true })}
        icon={<Percent size={15} />}
        accent="#38bdf8"
        delta={d(summary.margin_pct, comparison.margin_pct, 'positive')}
        note={summary.margin_pct === null ? 'Sin ventas en el período' : undefined}
      />
      <Kpi
        testId="kpi-collections"
        label="Cobros"
        value={formatARS(summary.collections)}
        icon={<Banknote size={15} />}
        accent="#10b981"
        delta={d(summary.collections, comparison.collections, 'positive')}
      />
      {/* Capital en stock: SIN flecha de bien/mal. Es una foto del presente,
          no una variación del período, y su movimiento no tiene signo moral. */}
      <Kpi
        testId="kpi-inventory-capital"
        label="Capital en stock"
        value={formatARS(cap.inventory_at_cost)}
        icon={<Package size={15} />}
        accent="#a78bfa"
        note="Mercadería valuada a costo vigente"
      />
    </div>
  )
}
