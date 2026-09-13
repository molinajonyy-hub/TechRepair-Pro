import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Loader2, Server, ShieldAlert } from 'lucide-react'
import { colors, radius } from '../../lib/tokens'
import { describeArcaStatus, type ArcaSelfServiceStatus, type ArcaTone } from '../../lib/arcaStatus'

/**
 * ARCA Self-Service Phase 1 — tarjeta de estado de la integración.
 *
 * Presentación pura del read model canónico (get_arca_selfservice_status): no lee
 * tablas, no calcula vencimientos ni decide permisos. `actions` es un slot para
 * acciones ya existentes que la página decide mostrar (p. ej. probar conexión).
 */

const TONE: Record<ArcaTone, { fg: string; bg: string; border: string }> = {
  success: { fg: colors.success, bg: colors.successBg, border: colors.successBorder },
  warning: { fg: colors.warning, bg: colors.warningBg, border: colors.warningBorder },
  danger:  { fg: colors.error,   bg: colors.errorBg,   border: colors.errorBorder },
  accent:  { fg: colors.indigo,  bg: colors.indigoBg,  border: colors.indigoBorder },
  neutral: { fg: colors.text.secondary, bg: colors.bg.card, border: colors.border.default },
}

const TONE_ICON: Record<ArcaTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  warning: Clock,
  danger: ShieldAlert,
  accent: Clock,
  neutral: Server,
}

interface ArcaStatusCardProps {
  status: ArcaSelfServiceStatus | null
  loading: boolean
  /** true si la lectura falló o el payload no respetó el contrato. */
  failed: boolean
  actions?: ReactNode
}

const shell = {
  background: colors.bg.surface,
  border: `1px solid ${colors.border.default}`,
  borderRadius: radius.lg,
  padding: '1.25rem 1.5rem',
} as const

export function ArcaStatusCard({ status, loading, failed, actions }: ArcaStatusCardProps) {
  if (loading && !status) {
    return (
      <section data-testid="arca-status-loading" aria-busy="true" style={{ ...shell, display: 'flex', alignItems: 'center', gap: '0.75rem', color: colors.text.secondary }}>
        <Loader2 size={18} style={{ animation: 'tr-spin 1s linear infinite' }} aria-hidden />
        <span style={{ fontSize: '0.875rem' }}>Leyendo el estado de ARCA…</span>
      </section>
    )
  }

  if (!status) {
    return (
      <section data-testid="arca-status-error" role="alert" style={{ ...shell, display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
        <AlertTriangle size={18} style={{ color: colors.warning, flexShrink: 0, marginTop: 2 }} aria-hidden />
        <div>
          <p style={{ margin: 0, color: colors.text.primary, fontWeight: 600, fontSize: '0.9rem' }}>
            No se pudo leer el estado de ARCA
          </p>
          <p style={{ margin: '0.25rem 0 0', color: colors.text.secondary, fontSize: '0.825rem', lineHeight: 1.5 }}>
            {failed ? 'Volvé a intentar en unos minutos. La emisión de comprobantes no se modifica.' : 'Sin datos.'}
          </p>
        </div>
      </section>
    )
  }

  const view = describeArcaStatus(status)
  const tone = TONE[view.tone]
  const Icon = TONE_ICON[view.tone]

  return (
    <section data-testid="arca-status-card" data-arca-status={status.status} aria-labelledby="arca-status-title" style={shell}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.875rem' }}>
        <span aria-hidden style={{
          width: 40, height: 40, borderRadius: radius.md, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: tone.bg, border: `1px solid ${tone.border}`, color: tone.fg,
        }}>
          <Icon size={20} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <p id="arca-status-title" className="label-caps" style={{ margin: 0 }}>ARCA</p>
          <p data-testid="arca-status-headline" style={{ margin: '0.125rem 0 0', color: tone.fg === colors.text.secondary ? colors.text.primary : tone.fg, fontWeight: 700, fontSize: '1.05rem' }}>
            {view.headline}
          </p>
          <p data-testid="arca-status-detail" style={{ margin: '0.25rem 0 0', color: colors.text.secondary, fontSize: '0.85rem', lineHeight: 1.5 }}>
            {view.detail}
          </p>
        </div>
      </div>

      {view.empty && status.available && (
        <div data-testid="arca-status-empty" style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: `1px solid ${colors.border.subtle}` }}>
          {status.status === 'not_configured' && (
            <p style={{ margin: 0, color: colors.text.primary, fontWeight: 600, fontSize: '0.9rem' }}>
              ARCA todavía no está configurado
            </p>
          )}
          <p data-testid="arca-status-empty-hint" style={{ margin: '0.25rem 0 0', color: colors.text.secondary, fontSize: '0.825rem', lineHeight: 1.5 }}>
            {status.can_manage
              ? 'Próximamente vas a poder configurarlo desde acá con un asistente guiado, sin cargar archivos técnicos.'
              : 'Pedile al dueño o a un administrador del negocio que configure la integración.'}
          </p>
        </div>
      )}

      {view.rows.length > 0 && (
        <dl data-testid="arca-status-rows" style={{
          margin: '1rem 0 0', paddingTop: '1rem', borderTop: `1px solid ${colors.border.subtle}`,
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.875rem 1.25rem',
        }}>
          {view.rows.map((row) => (
            <div key={row.key} data-testid={`arca-status-row-${row.key}`} style={{ minWidth: 0 }}>
              <dt style={{ color: colors.text.subtle, fontSize: '0.75rem', fontWeight: 500 }}>{row.label}</dt>
              <dd style={{
                margin: '0.125rem 0 0', fontSize: '0.9rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                color: row.tone && row.tone !== 'neutral' ? TONE[row.tone].fg : colors.text.primary,
                overflowWrap: 'anywhere',
              }}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {view.notices.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '1rem 0 0', padding: 0, display: 'grid', gap: '0.5rem' }}>
          {view.notices.map((notice) => {
            const t = TONE[notice.tone]
            return (
              <li key={notice.key} data-testid={`arca-status-notice-${notice.key}`} style={{
                display: 'flex', gap: '0.5rem', alignItems: 'flex-start', padding: '0.625rem 0.75rem',
                background: t.bg, border: `1px solid ${t.border}`, borderRadius: radius.md,
                color: colors.text.primary, fontSize: '0.825rem', lineHeight: 1.5,
              }}>
                <AlertTriangle size={15} style={{ color: t.fg, flexShrink: 0, marginTop: 3 }} aria-hidden />
                <span>{notice.text}</span>
              </li>
            )
          })}
        </ul>
      )}

      {actions && <div style={{ marginTop: '1rem' }}>{actions}</div>}
    </section>
  )
}
