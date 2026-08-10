import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Package, Info } from 'lucide-react'
import { colors, radius, fontSize } from '../../../lib/tokens'
import {
  CHART_COLORS, formatARS, formatNumber, formatPercent, formatAxisARS,
  replenishmentText, fxNote, capitalCoverage,
} from '../../../lib/finance/chartsL1Presentation'
import { FinanceTooltip } from './FinanceTooltip'
import type { InventoryCapital, InventoryFlows } from '../../../services/financeChartsService'

// ─── §13 / §15 / §16 / §21 — Capital en stock y reposición ───────────────────
//
// DENOMINACIÓN CANÓNICA: "Capital en stock". Nunca "capital total", "patrimonio"
// ni "capital invertido total": la métrica representa EXCLUSIVAMENTE inventario.
//
// Dos cosas separadas a propósito, porque sus bases de costo no son homogéneas:
//   1. VALUACIÓN ACTUAL  — stock de hoy al costo vigente registrado.
//   2. FLUJOS DEL PERÍODO — compras a costo snapshot vs consumo a COGS devengado.
//
// NO hay puente contable (stock inicial + compras - consumo = stock final):
// no existe costo histórico por producto y por día, y valuar stock pasado al
// costo de hoy produciría una variación patrimonial falsa. La RPC lo declara
// con bridge_available=false y acá se respeta.

export interface InventoryCapitalBlockProps {
  capital: InventoryCapital
  flows: InventoryFlows
}

export function InventoryCapitalBlock({ capital, flows }: InventoryCapitalBlockProps) {
  const cobertura = capitalCoverage(capital)
  const fx = fxNote(capital)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }} data-testid="inventory-capital-block">

      {/* ── Valuación actual ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.85rem' }}>
        <div aria-hidden="true" style={{
          width: 40, height: 40, flexShrink: 0, borderRadius: radius.md,
          background: 'rgba(167,139,250,0.14)', color: '#a78bfa',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Package size={19} /></div>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: '1.5rem', fontWeight: 800, color: colors.text.primary,
            fontVariantNumeric: 'tabular-nums', lineHeight: 1.1, overflowWrap: 'anywhere',
          }} data-testid="inventory-capital-value">
            {formatARS(capital.inventory_at_cost)}
          </div>
          <p style={{ margin: '0.2rem 0 0', fontSize: fontSize.sm, color: colors.text.muted, lineHeight: 1.45 }}>
            Mercadería disponible valuada a costo vigente.
          </p>
        </div>
      </div>

      {/* La nota de cobertura NO se repite acá: cuando la valuación es parcial
          la tarjeta entra en estado `incomplete` y su carcasa ya la muestra una
          sola vez (con el detalle de unidades incluido). Duplicarla hacía que el
          mismo aviso apareciera dos veces en la misma tarjeta.
          Cuando la cobertura es total y no hay estado `incomplete`, la nota
          informativa se muestra igual acá abajo. */}
      {cobertura.text && !cobertura.incomplete && (
        <div role="note" style={{
          display: 'flex', gap: '0.5rem', alignItems: 'flex-start',
          padding: '0.5rem 0.65rem', borderRadius: radius.sm,
          background: colors.bg.card,
          border: `1px solid ${colors.border.subtle}`,
        }}>
          <Info size={13} style={{ color: colors.text.muted, flexShrink: 0, marginTop: 2 }} />
          <span style={{ fontSize: fontSize.xs, color: colors.text.secondary, lineHeight: 1.4 }}>
            {cobertura.text}
          </span>
        </div>
      )}

      {/* ── Reposición del período ── */}
      <div style={{ borderTop: `1px solid ${colors.border.subtle}`, paddingTop: '0.9rem' }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.55rem',
        }}>
          <span style={{
            fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.04em',
            textTransform: 'uppercase', color: colors.text.muted,
          }}>Reposición del período</span>
          <span style={{
            fontSize: fontSize.xl, fontWeight: 800, color: colors.text.primary,
            fontVariantNumeric: 'tabular-nums',
          }} data-testid="replenishment-value">
            {flows.replenishment_pct === null
              ? 'Sin consumo comparable'
              : formatPercent(flows.replenishment_pct, { ya100: true })}
          </span>
        </div>

        <ReplenishmentBars flows={flows} />

        <p style={{
          margin: '0.6rem 0 0', fontSize: fontSize.sm, color: colors.text.secondary, lineHeight: 1.45,
        }} data-testid="replenishment-text">
          {replenishmentText(flows)}
        </p>
      </div>

      {/* ── Otros flujos: nunca mezclados con compras ── */}
      {(flows.adjustments_units > 0 || flows.returns_units > 0 || flows.cancellations_units > 0) && (
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {flows.returns_units > 0 && (
            <FlowChip label="Devoluciones" value={`${formatNumber(flows.returns_units, 0)} u.`} />
          )}
          {flows.adjustments_units > 0 && (
            <FlowChip label="Ajustes" value={`${formatNumber(flows.adjustments_units, 0)} u.`} />
          )}
          {flows.cancellations_units > 0 && (
            <FlowChip label="Cancelaciones" value={`${formatNumber(flows.cancellations_units, 0)} u.`} />
          )}
        </div>
      )}

      {/* ── Nota FX (§21) ── */}
      {fx && (
        <p style={{ margin: 0, fontSize: fontSize.xs, color: colors.text.muted, lineHeight: 1.45 }}>
          {fx}
        </p>
      )}
    </div>
  )
}

function FlowChip({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{
        fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.04em',
        fontWeight: 700, color: colors.text.muted,
      }}>{label}</div>
      <div style={{
        fontSize: fontSize.sm, fontWeight: 700, color: colors.text.secondary,
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
    </div>
  )
}

/**
 * Compras vs consumo, lado a lado. NO es un waterfall: no se afirma ninguna
 * igualdad contable entre estas dos barras, porque no comparten base de costo
 * con la valuación del stock.
 */
function ReplenishmentBars({ flows }: { flows: InventoryFlows }) {
  const data = [
    { key: 'purchases', label: 'Compras', amount: flows.purchases_cost, color: CHART_COLORS.result },
    { key: 'consumption', label: 'Consumo', amount: flows.consumption_cost, color: CHART_COLORS.cogs },
  ]
  if (data.every(d => !Number.isFinite(d.amount) || d.amount === 0)) {
    return (
      <p style={{ margin: 0, fontSize: fontSize.sm, color: colors.text.muted }}>
        No hubo compras ni consumo de inventario en el período.
      </p>
    )
  }

  return (
    <div style={{ width: '100%', height: 120 }} data-testid="chart-replenishment">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" horizontal={false} />
          <XAxis type="number" tickFormatter={formatAxisARS}
                 tick={{ fontSize: 10, fill: 'var(--text-subtle)' }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" width={74}
                 tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: 'var(--bg-hover)', opacity: 0.45 }}
            content={(props) => {
              const p = props as { active?: boolean; payload?: { payload?: typeof data[number] }[] }
              if (!p.active || !p.payload?.length) return null
              const d = p.payload[0]?.payload
              if (!d) return null
              return (
                <FinanceTooltip
                  title={d.label}
                  rows={[{ label: 'Importe', value: formatARS(d.amount) }]}
                  note={d.key === 'purchases'
                    ? 'Entradas por compra, al costo registrado en el movimiento.'
                    : 'Costo de la mercadería consumida por la operación (COGS devengado).'}
                />
              )
            }}
          />
          <Bar dataKey="amount" radius={[0, 3, 3, 0]} maxBarSize={26}>
            {data.map(d => <Cell key={d.key} fill={d.color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Resumen textual accesible (§31). */
export function inventorySummaryText(capital: InventoryCapital, flows: InventoryFlows): string {
  const base =
    `Actualmente hay ${formatARS(capital.inventory_at_cost)} de mercadería valuada a costo vigente, ` +
    `sobre ${formatNumber(capital.products_valued, 0)} de ${formatNumber(capital.products_total, 0)} ` +
    `productos con costo cargado.`
  if (flows.replenishment_pct === null) {
    return `${base} En el período no hubo consumo comparable para calcular la reposición.`
  }
  return (
    `${base} En el período las compras fueron ${formatARS(flows.purchases_cost)} y el consumo ` +
    `${formatARS(flows.consumption_cost)}, una reposición del ` +
    `${formatPercent(flows.replenishment_pct, { ya100: true })}.`
  )
}

/**
 * Contexto de capital inmovilizado (§18). Se muestra SÓLO si comparte
 * denominador con la regla `dead_stock` de M8; la regla NO se recalcula acá.
 */
export function DeadStockContext({
  capital, deadValue,
}: { capital: InventoryCapital; deadValue: number | null }) {
  if (deadValue === null || !Number.isFinite(deadValue) || deadValue <= 0) return null
  const base = capital.inventory_at_cost_valued
  if (base <= 0) return null
  const share = (deadValue / base) * 100

  return (
    <p style={{ margin: 0, fontSize: fontSize.xs, color: colors.text.muted, lineHeight: 1.45 }}
       data-testid="dead-stock-context">
      De ese total, <strong style={{ color: colors.text.secondary }}>{formatARS(deadValue)}</strong>
      {' '}({formatPercent(share, { ya100: true })}) no registra ventas ni consumo en el plazo observado.
    </p>
  )
}
