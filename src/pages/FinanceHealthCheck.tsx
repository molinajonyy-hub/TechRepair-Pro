import { useState, useCallback, useMemo } from 'react'
import {
  RefreshCw, ShieldCheck, AlertTriangle, AlertCircle, Info, ChevronDown, ChevronRight,
  Copy, CheckCircle2, Lock, HelpCircle,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { runHealthCheck } from '../services/financeHealthService'
import {
  groupChecks, fmtARS, GLOBAL_CATEGORIES,
  type HealthResult, type HealthCheck, type CheckResult, type CheckGroup,
} from '../lib/financeHealth'

// ─── Presentación de resultados ───────────────────────────────────────────────
// info NO es warning: es comportamiento esperado o deuda legacy explicada.
// Color + icono + etiqueta textual: nunca se depende sólo del color.

// Tokens reales de src/index.css: cada familia tiene -light (fondo) y -border.
// Se redefinen en el bloque light, así que light/dark funcionan solos.
// El rojo del proyecto es --error (--danger no existe).
const RESULT_CFG: Record<CheckResult, {
  color: string; bg: string; border: string; label: string; icon: typeof Info
}> = {
  pass: { color: 'var(--success)', bg: 'var(--success-subtle)', border: 'var(--success-border)', label: 'OK', icon: CheckCircle2 },
  fail: { color: 'var(--error)', bg: 'var(--error-light)', border: 'var(--error-border)', label: 'Problema', icon: AlertCircle },
  warn: { color: 'var(--warning)', bg: 'var(--warning-light)', border: 'var(--warning-border)', label: 'Revisar', icon: AlertTriangle },
  info: { color: 'var(--info)', bg: 'var(--info-subtle)', border: 'var(--info-border)', label: 'Informativo', icon: Info },
}

function ResultBadge({ result, unrecognized }: { result: CheckResult; unrecognized?: boolean }) {
  const cfg = RESULT_CFG[result]
  const Icon = cfg.icon
  return (
    <span
      data-testid={`result-badge-${result}`}
      title={unrecognized ? 'La base devolvió un valor que esta versión no reconoce: requiere revisión' : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
        padding: '0.2rem 0.6rem', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700,
        color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}`, whiteSpace: 'nowrap',
      }}
    >
      <Icon size={11} aria-hidden />
      {unrecognized ? 'Revisar' : cfg.label}
    </span>
  )
}

function SummaryCard({ icon, label, value, color, testId, sub }: {
  icon: React.ReactNode; label: string; value: string | number; color: string; testId: string; sub?: string
}) {
  return (
    <div style={{
      background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)',
      borderRadius: 'var(--radius-lg)', padding: '1.25rem',
      display: 'flex', alignItems: 'center', gap: '1rem',
    }} data-testid={testId}>
      <div style={{
        width: 44, height: 44, borderRadius: 'var(--radius-md)', background: color + '1a',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <span style={{ color }}>{icon}</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '1.5rem', fontWeight: 800, color, lineHeight: 1.1, wordBreak: 'break-word' }}>{value}</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>{label}</div>
        {sub && <div style={{ fontSize: '0.68rem', color: 'var(--text-subtle)', marginTop: '0.15rem' }}>{sub}</div>}
      </div>
    </div>
  )
}

// ─── Detalles: compacto y seguro, nunca un JSON crudo enorme ─────────────────

const DETAIL_LABELS: Record<string, string> = {
  business_id: 'Negocio', comprobante_id: 'Comprobante', numero: 'Número', fecha: 'Fecha',
  period_date: 'Período', periodo: 'Período', total: 'Total', monto: 'Monto',
  amount_ars: 'Monto', count: 'Cantidad', cantidad: 'Cantidad', entidad: 'Entidad',
  semantica: 'Semántica', politica: 'Política', tipo: 'Tipo', motivo: 'Motivo',
  remediacion: 'Recomendación', omitidos: 'Checks omitidos', regla: 'Regla', pg_temp: 'Nota',
}
const PRIORIDAD = Object.keys(DETAIL_LABELS)

/** Aplana un valor a texto legible y acotado. Nunca vuelca un objeto gigante. */
function valorLegible(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'sí' : 'no'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.length <= 5 ? v.map(valorLegible).join(', ') : `${v.length} elementos`
  return '(ver vista técnica)'
}

function DetailsView({ details, rows }: { details: Record<string, unknown>; rows: Record<string, unknown>[] }) {
  const [tecnico, setTecnico] = useState(false)
  const entradas = Object.entries(details).filter(([, v]) => v !== null && v !== undefined && v !== '')
  const ordenadas = [...entradas].sort(([a], [b]) => {
    const ia = PRIORIDAD.indexOf(a), ib = PRIORIDAD.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  const hayEstructurasRaras = entradas.some(([, v]) => typeof v === 'object' && v !== null && !Array.isArray(v))

  if (!ordenadas.length && !rows.length) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {ordenadas.length > 0 && (
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 0.75rem', margin: 0, fontSize: '0.78rem' }}>
          {ordenadas.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt style={{ color: 'var(--text-subtle)', fontWeight: 600 }}>{DETAIL_LABELS[k] ?? k}</dt>
              <dd style={{ margin: 0, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{valorLegible(v)}</dd>
            </div>
          ))}
        </dl>
      )}

      {rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-subtle)', margin: 0, fontWeight: 600 }}>
            Registros afectados ({rows.length}):
          </p>
          {rows.slice(0, 10).map((row, i) => (
            <div key={i} style={{
              background: 'var(--bg-hover)', borderRadius: 'var(--radius-sm)',
              padding: '0.5rem 0.75rem', fontSize: '0.75rem', color: 'var(--text-secondary)',
              wordBreak: 'break-word',
            }}>
              {Object.entries(row).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
                <span key={k} style={{ marginRight: '0.875rem' }}>
                  <span style={{ color: 'var(--text-subtle)' }}>{DETAIL_LABELS[k] ?? k}:</span>{' '}
                  <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{valorLegible(v)}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      {hayEstructurasRaras && (
        <div>
          <button
            onClick={() => setTecnico(t => !t)}
            aria-expanded={tecnico}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              color: 'var(--text-subtle)', fontSize: '0.72rem', textDecoration: 'underline',
            }}
          >
            {tecnico ? 'Ocultar' : 'Ver'} vista técnica
          </button>
          {tecnico && (
            <pre style={{
              marginTop: '0.375rem', maxHeight: 200, overflow: 'auto',
              background: 'var(--bg-hover)', borderRadius: 'var(--radius-sm)',
              padding: '0.5rem', fontSize: '0.7rem', color: 'var(--text-secondary)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {JSON.stringify(details, null, 1).slice(0, 2000)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Fila de check ───────────────────────────────────────────────────────────

function CheckRow({ check }: { check: HealthCheck }) {
  const [expanded, setExpanded] = useState(false)
  const cfg = RESULT_CFG[check.result]
  const hayDetalle = (check.rows?.length ?? 0) > 0 || Object.keys(check.details ?? {}).length > 0

  return (
    <div
      data-testid="finance-health-check-row"
      data-check-id={check.check_id}
      data-result={check.result}
      style={{
        border: `1px solid ${check.result === 'pass' ? 'var(--border-color)' : cfg.border}`,
        borderRadius: 'var(--radius-md)',
        background: check.result === 'pass' ? 'var(--bg-card-solid)' : cfg.bg,
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => hayDetalle && setExpanded(e => !e)}
        aria-expanded={hayDetalle ? expanded : undefined}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '0.75rem',
          padding: '0.75rem 0.875rem', background: 'none', border: 'none',
          cursor: hayDetalle ? 'pointer' : 'default', textAlign: 'left',
        }}
      >
        <ResultBadge result={check.result} unrecognized={check.unrecognized} />
        <span style={{ flex: 1, fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)' }}>
          {check.title}
        </span>
        {check.amount_ars !== 0 && (
          <span style={{ fontSize: '0.78rem', fontWeight: 700, color: cfg.color, whiteSpace: 'nowrap' }}>
            {fmtARS(check.amount_ars)}
          </span>
        )}
        {check.count > 0 && (
          <span style={{
            minWidth: 26, height: 21, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: '9999px', background: cfg.bg, color: cfg.color,
            border: `1px solid ${cfg.border}`, fontSize: '0.72rem', fontWeight: 800,
          }}>
            {check.count}
          </span>
        )}
        {hayDetalle && (
          <span style={{ color: 'var(--text-subtle)', flexShrink: 0 }}>
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </span>
        )}
      </button>

      <div style={{ padding: '0 0.875rem 0.75rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
        {check.message}
      </div>

      {expanded && hayDetalle && (
        <div style={{ borderTop: `1px solid ${cfg.border}`, padding: '0.75rem 0.875rem' }}>
          <DetailsView details={check.details} rows={check.rows} />
        </div>
      )}
    </div>
  )
}

// ─── Grupo por categoría ─────────────────────────────────────────────────────

function CategoryGroup({ group }: { group: CheckGroup }) {
  // Un grupo con problemas arranca abierto: nunca se oculta un crítico de entrada.
  const [open, setOpen] = useState(group.status === 'fail' || group.status === 'warn')
  const cfg = RESULT_CFG[group.status]

  return (
    <section
      data-testid="finance-health-category"
      data-category={group.category}
      data-status={group.status}
      style={{
        border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)',
        background: 'var(--bg-card-solid)', overflow: 'hidden',
      }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '0.75rem',
          padding: '0.875rem 1rem', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ color: 'var(--text-subtle)', flexShrink: 0 }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <span
          data-testid="finance-health-category-label"
          style={{ flex: 1, fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)' }}
        >
          {group.label}
        </span>

        {group.amountAtRisk > 0 && (
          <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--error)', whiteSpace: 'nowrap' }}>
            {fmtARS(group.amountAtRisk)}
          </span>
        )}

        <span style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {group.failCount > 0 && <Pill n={group.failCount} result="fail" />}
          {group.warnCount > 0 && <Pill n={group.warnCount} result="warn" />}
          {group.infoCount > 0 && <Pill n={group.infoCount} result="info" />}
          {group.failCount === 0 && group.warnCount === 0 && group.infoCount === 0 && (
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: cfg.color }}>
              {group.passCount} OK
            </span>
          )}
        </span>

        <span style={{ fontSize: '0.7rem', color: 'var(--text-subtle)', whiteSpace: 'nowrap' }}>
          {group.checks.length} {group.checks.length === 1 ? 'check' : 'checks'}
        </span>
      </button>

      {open && (
        <div style={{ padding: '0 0.75rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {group.checks.map(c => <CheckRow key={c.check_id} check={c} />)}
        </div>
      )}
    </section>
  )
}

function Pill({ n, result }: { n: number; result: CheckResult }) {
  const cfg = RESULT_CFG[result]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.2rem', padding: '0.1rem 0.45rem',
      borderRadius: '9999px', fontSize: '0.7rem', fontWeight: 800,
      color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}`,
    }}>
      {n} {cfg.label}
    </span>
  )
}

// ─── Página ──────────────────────────────────────────────────────────────────

export function FinanceHealthCheck() {
  const { businessId } = useAuth()
  const [result, setResult] = useState<HealthResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [verDiagnostico, setVerDiagnostico] = useState(false)

  const runCheck = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    setError(null)
    try {
      // Se piden siempre los globales: la BASE decide si los devuelve (owner).
      // Ocultar la UI no autoriza; si no corresponde, la RPC los omite y avisa.
      const r = await runHealthCheck({ businessId, includeGlobal: true })
      setResult(r)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error al ejecutar auditoría')
    } finally {
      setLoading(false)
    }
  }, [businessId])

  const { negocio, plataforma } = useMemo(() => {
    const todos = groupChecks(result?.checks ?? [])
    return {
      negocio: todos.filter(g => !GLOBAL_CATEGORIES.has(g.category)),
      plataforma: todos.filter(g => GLOBAL_CATEGORIES.has(g.category)),
    }
  }, [result])

  const copyReport = () => {
    if (!result) return
    const lines: string[] = [
      `Auditoría financiera — ${new Date(result.checked_at).toLocaleString('es-AR')}`,
      `Estado: ${result.overall_status.toUpperCase()}  (${result.health_version})`,
      `Problemas: ${result.critical_count} · Advertencias: ${result.warning_count} · Informativos: ${result.info_count}`,
      result.amount_at_risk > 0 ? `Monto potencialmente afectado: ${fmtARS(result.amount_at_risk)}` : '',
      '',
      ...negocio.flatMap(g => [
        `── ${g.label}`,
        ...g.checks.map(c => `   [${c.result.toUpperCase().padEnd(4)}] ${c.title}${c.count ? ` — ${c.count}` : ''}${c.amount_ars ? ` — ${fmtARS(c.amount_ars)}` : ''}`),
      ]),
    ].filter(Boolean)
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const estado = result?.overall_status
  const estadoCfg = estado ? RESULT_CFG[estado === 'fail' ? 'fail' : estado === 'warn' ? 'warn' : 'pass'] : null

  return (
    <div className="page-shell" data-testid="finance-health-page" data-health-version={result?.health_version}>
      {/* ── Header ── */}
      <div className="page-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div className="stat-icon" style={{ background: 'var(--info-subtle)', border: '1px solid var(--info-border)' }}>
            <ShieldCheck size={20} style={{ color: 'var(--info)' }} />
          </div>
          <div>
            <h1 className="page-title">Auditoría financiera</h1>
            <p className="page-subtitle">
              Integridad económica, períodos, anulaciones, caja y aislamiento
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {result && (
            <button className="btn-secondary" onClick={copyReport} data-testid="finance-health-copy">
              {copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          )}
          <button
            className="btn-primary" onClick={runCheck} disabled={loading || !businessId}
            data-testid="finance-health-run"
          >
            <RefreshCw size={15} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
            {loading ? 'Analizando…' : 'Ejecutar auditoría'}
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" data-testid="finance-health-error" style={{
          background: 'var(--error-light)', border: '1px solid var(--error-border)',
          borderRadius: 'var(--radius-md)', padding: '0.875rem 1rem', color: 'var(--error)',
          display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem',
        }}>
          <AlertCircle size={16} aria-hidden /> {error}
        </div>
      )}

      {!result && !loading && !error && (
        <div data-testid="finance-health-empty" style={{
          textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-muted)',
        }}>
          <ShieldCheck size={40} style={{ color: 'var(--text-subtle)', marginBottom: '0.75rem' }} />
          <p>Ejecutá la auditoría para revisar la salud financiera del negocio.</p>
        </div>
      )}

      {result && (
        <>
          {/* ── Resumen ── */}
          <div style={{
            display: 'grid', gap: '0.875rem', marginBottom: '1.25rem',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          }} data-testid="finance-health-summary">
            <SummaryCard
              testId="summary-critical" icon={<AlertCircle size={20} />} color="var(--error)"
              value={result.critical_count}
              label={result.critical_count === 1 ? 'problema financiero' : 'problemas financieros'}
            />
            {result.amount_at_risk > 0 && (
              <SummaryCard
                testId="summary-amount" icon={<AlertTriangle size={20} />} color="var(--error)"
                value={fmtARS(result.amount_at_risk)}
                label="monto potencialmente afectado"
                sub="No es una pérdida confirmada"
              />
            )}
            <SummaryCard
              testId="summary-warning" icon={<AlertTriangle size={20} />} color="var(--warning)"
              value={result.warning_count}
              label={result.warning_count === 1 ? 'advertencia' : 'advertencias'}
            />
            <SummaryCard
              testId="summary-info" icon={<Info size={20} />} color="var(--info)"
              value={result.info_count}
              label={result.info_count === 1 ? 'observación informativa' : 'observaciones informativas'}
            />
          </div>

          {/* ── Estado general ── */}
          {estadoCfg && (
            <div data-testid="finance-health-overall" data-overall={estado} style={{
              display: 'flex', alignItems: 'center', gap: '0.625rem',
              padding: '0.75rem 1rem', marginBottom: '1.25rem',
              borderRadius: 'var(--radius-md)', background: estadoCfg.bg,
              border: `1px solid ${estadoCfg.border}`, color: estadoCfg.color, fontWeight: 700,
              fontSize: '0.9rem',
            }}>
              <estadoCfg.icon size={17} aria-hidden />
              {estado === 'fail' ? 'Se encontraron problemas que requieren acción'
                : estado === 'warn' ? 'Hay observaciones para revisar'
                  : 'Sin problemas detectados'}
              <span style={{ marginLeft: 'auto', fontWeight: 500, fontSize: '0.75rem', color: 'var(--text-subtle)' }}>
                {result.checks_total} checks · {result.duration_ms} ms
              </span>
            </div>
          )}

          {/* ── Salud financiera del comercio, por categoría ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }} data-testid="finance-health-groups">
            {negocio.map(g => <CategoryGroup key={g.category} group={g} />)}
          </div>

          {/* ── Seguridad de plataforma: separada de la salud del comercio ── */}
          {plataforma.length > 0 && (
            <div style={{ marginTop: '1.75rem' }} data-testid="finance-health-platform">
              <h2 style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-secondary)',
                margin: '0 0 0.25rem',
              }}>
                <Lock size={15} aria-hidden /> Seguridad de plataforma
              </h2>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-subtle)', margin: '0 0 0.75rem' }}>
                Diagnóstico técnico de la plataforma. No afecta la salud financiera de este negocio.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {plataforma.map(g => <CategoryGroup key={g.category} group={g} />)}
              </div>
            </div>
          )}

          {/* ── Información del diagnóstico ── */}
          <div style={{ marginTop: '1.75rem' }} data-testid="finance-health-diagnostic">
            <button
              onClick={() => setVerDiagnostico(v => !v)}
              aria-expanded={verDiagnostico}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'none',
                border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--text-subtle)', fontSize: '0.78rem',
              }}
            >
              <HelpCircle size={14} aria-hidden />
              Información del diagnóstico
              {verDiagnostico ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>

            {result.health_version === 'legacy_v1' && (
              <p data-testid="legacy-warning" style={{
                marginTop: '0.5rem', fontSize: '0.78rem', color: 'var(--warning)',
                display: 'flex', alignItems: 'center', gap: '0.4rem',
              }}>
                <AlertTriangle size={14} aria-hidden />
                Diagnóstico en modo compatibilidad (health_version = legacy_v1): faltan migraciones de M7.
              </p>
            )}

            {verDiagnostico && (
              <div style={{
                marginTop: '0.625rem', padding: '0.875rem 1rem',
                background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)', fontSize: '0.78rem', color: 'var(--text-muted)',
                display: 'flex', flexDirection: 'column', gap: '0.5rem',
              }}>
                <div><strong>Versión:</strong> {result.version} · <strong>Origen:</strong> {result.health_version}</div>
                <div><strong>Ejecutado:</strong> {new Date(result.checked_at).toLocaleString('es-AR')} · {result.duration_ms} ms</div>
                {Object.keys(result.schema_state).length > 0 && (
                  <div>
                    <strong>Estado del esquema:</strong>{' '}
                    {Object.entries(result.schema_state)
                      .map(([k, v]) => `${k}: ${v ? 'sí' : 'no'}`).join(' · ')}
                  </div>
                )}
                {result.semantics.credit_note && (
                  <div><strong>Notas de crédito:</strong> {result.semantics.credit_note}</div>
                )}
                {result.semantics.legacy_debt && (
                  <div><strong>Deuda legacy:</strong> {result.semantics.legacy_debt}</div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default FinanceHealthCheck
