import { useState, useCallback } from 'react'
import { RefreshCw, ShieldCheck, AlertTriangle, AlertCircle, Info, ChevronDown, ChevronRight, Copy, CheckCircle2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

// ─── Types ────────────────────────────────────────────────────────────────────

type CheckStatus   = 'ok' | 'low' | 'warning' | 'critical'
type CheckSeverity = 'low' | 'warning' | 'critical'

interface HealthCheck {
  id:          string
  title:       string
  severity:    CheckSeverity
  status:      CheckStatus
  count:       number
  description: string
  rows:        Record<string, unknown>[]
}

interface HealthResult {
  ok:             boolean
  critical_count: number
  warning_count:  number
  low_count:      number
  total_issues:   number
  business_id:    string
  checked_at:     string
  checks:         HealthCheck[]
  error?:         string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SEV_CONFIG: Record<CheckStatus, {
  color: string; bg: string; border: string; label: string
}> = {
  ok:       { color: '#34d399', bg: 'rgba(52,211,153,0.1)',  border: 'rgba(52,211,153,0.25)',  label: 'OK'       },
  low:      { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', border: 'rgba(148,163,184,0.25)', label: 'Bajo'     },
  warning:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',  border: 'rgba(245,158,11,0.25)',  label: 'Atención' },
  critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.1)',   border: 'rgba(239,68,68,0.25)',   label: 'Crítico'  },
}

function StatusBadge({ status }: { status: CheckStatus }) {
  const cfg = SEV_CONFIG[status]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
      padding: '0.2rem 0.6rem', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 700,
      color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}`,
      whiteSpace: 'nowrap',
    }}>
      {status === 'ok' && <CheckCircle2 size={11} />}
      {status === 'critical' && <AlertCircle size={11} />}
      {status === 'warning' && <AlertTriangle size={11} />}
      {status === 'low' && <Info size={11} />}
      {cfg.label}
    </span>
  )
}

function SummaryCard({
  icon, label, value, color, testId,
}: { icon: React.ReactNode; label: string; value: number; color: string; testId: string }) {
  return (
    <div style={{
      background: 'var(--bg-card-solid)', border: '1px solid var(--border-color)',
      borderRadius: 'var(--radius-lg)', padding: '1.25rem',
      display: 'flex', alignItems: 'center', gap: '1rem',
    }} data-testid={testId}>
      <div style={{
        width: 44, height: 44, borderRadius: 'var(--radius-md)',
        background: color + '1a', display: 'flex', alignItems: 'center',
        justifyContent: 'center', flexShrink: 0,
      }}>
        <span style={{ color }}>{icon}</span>
      </div>
      <div>
        <div style={{ fontSize: '1.625rem', fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>{label}</div>
      </div>
    </div>
  )
}

function CheckRow({ check }: { check: HealthCheck }) {
  const [expanded, setExpanded] = useState(false)
  const cfg = SEV_CONFIG[check.status]
  const hasRows = check.rows && check.rows.length > 0

  return (
    <div
      style={{
        border: `1px solid ${check.status === 'ok' ? 'var(--border-color)' : cfg.border}`,
        borderRadius: 'var(--radius-md)',
        background: check.status === 'ok' ? 'var(--bg-card-solid)' : cfg.bg + '4d',
        overflow: 'hidden', transition: 'border-color 0.15s',
      }}
      data-testid="finance-health-check-row"
    >
      {/* Header */}
      <button
        onClick={() => hasRows && setExpanded(e => !e)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '0.875rem',
          padding: '0.875rem 1rem', background: 'none', border: 'none',
          cursor: hasRows ? 'pointer' : 'default', textAlign: 'left',
        }}
      >
        <StatusBadge status={check.status} />
        <span style={{ flex: 1, fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
          {check.title}
        </span>
        {check.count > 0 && (
          <span style={{
            minWidth: 28, height: 22, display: 'inline-flex', alignItems: 'center',
            justifyContent: 'center', borderRadius: '9999px',
            background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
            fontSize: '0.75rem', fontWeight: 800,
          }}>
            {check.count}
          </span>
        )}
        {hasRows && (
          <span style={{ color: 'var(--text-subtle)', flexShrink: 0 }}>
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </span>
        )}
      </button>

      {/* Description */}
      <div style={{ padding: '0 1rem 0.75rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
        {check.description}
      </div>

      {/* Expanded rows */}
      {expanded && hasRows && (
        <div style={{
          borderTop: `1px solid ${cfg.border}`,
          padding: '0.75rem 1rem',
          display: 'flex', flexDirection: 'column', gap: '0.375rem',
        }}>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-subtle)', margin: '0 0 0.5rem', fontWeight: 600 }}>
            Mostrando hasta 10 registros afectados:
          </p>
          {check.rows.map((row, i) => (
            <div key={i} style={{
              background: 'rgba(0,0,0,0.15)', borderRadius: 'var(--radius-sm)',
              padding: '0.5rem 0.75rem', fontSize: '0.78rem',
              fontFamily: 'monospace', color: 'var(--text-secondary)',
              wordBreak: 'break-all', overflowWrap: 'anywhere',
            }}>
              {Object.entries(row)
                .filter(([, v]) => v !== null && v !== undefined && v !== '')
                .map(([k, v]) => (
                  <span key={k} style={{ marginRight: '0.875rem' }}>
                    <span style={{ color: 'var(--text-subtle)' }}>{k}:</span>{' '}
                    <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                      {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                    </span>
                  </span>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function FinanceHealthCheck() {
  const { businessId } = useAuth()
  const [result,   setResult]   = useState<HealthResult | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [copied,   setCopied]   = useState(false)

  const runCheck = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    setError(null)
    try {
      const { data, error: rpcErr } = await supabase.rpc('finance_health_check', {
        p_business_id: businessId,
      })
      if (rpcErr) throw new Error(rpcErr.message)
      if (!data?.ok && data?.error) throw new Error(data.error)
      setResult(data as HealthResult)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error al ejecutar auditoría')
    } finally {
      setLoading(false)
    }
  }, [businessId])

  const copyReport = () => {
    if (!result) return
    const lines: string[] = [
      `Auditoría financiera — ${new Date(result.checked_at).toLocaleString('es-AR')}`,
      `Estado: ${result.ok ? 'SIN PROBLEMAS' : 'CON ISSUES'}`,
      `Críticos: ${result.critical_count}  |  Advertencias: ${result.warning_count}  |  Bajos: ${result.low_count}`,
      '',
      ...result.checks.map(c =>
        `[${c.status.toUpperCase().padEnd(8)}] ${c.title} — ${c.count === 0 ? 'OK' : `${c.count} issue(s)`}`
      ),
    ]
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const criticalChecks = result?.checks.filter(c => c.status === 'critical') ?? []
  const warningChecks  = result?.checks.filter(c => c.status === 'warning')  ?? []
  const lowChecks      = result?.checks.filter(c => c.status === 'low')      ?? []
  const okChecks       = result?.checks.filter(c => c.status === 'ok')       ?? []

  return (
    <div className="page-shell" data-testid="finance-health-page">

      {/* ── Header ── */}
      <div className="page-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div className="stat-icon" style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)' }}>
            <ShieldCheck size={20} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 className="page-title">Auditoría Financiera</h1>
            <p className="page-subtitle">
              {result
                ? `Última revisión: ${new Date(result.checked_at).toLocaleString('es-AR')}`
                : '16 checks de integridad financiera y fiscal'}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.625rem' }}>
          {result && (
            <button
              onClick={copyReport}
              className="btn btn-ghost btn-sm"
              title="Copiar reporte como texto"
            >
              {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          )}
          <button
            onClick={runCheck}
            disabled={loading}
            className="btn btn-primary"
            data-testid="finance-health-refresh"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Revisando...' : result ? 'Actualizar' : 'Ejecutar auditoría'}
          </button>
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="alert alert-error" style={{ marginBottom: '1.5rem' }}>
          {error}
        </div>
      )}

      {/* ── Empty state ── */}
      {!result && !loading && !error && (
        <div className="card" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
          <ShieldCheck size={44} style={{ color: '#818cf8', margin: '0 auto 1rem' }} />
          <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            Health-check financiero
          </h3>
          <p style={{ color: 'var(--text-secondary)', maxWidth: 460, margin: '0 auto 1.5rem' }}>
            Detecta inconsistencias en comprobantes, caja, finanzas y estado fiscal ARCA
            antes de que afecten reportes o AFIP.
          </p>
          <button onClick={runCheck} className="btn btn-primary">
            <RefreshCw size={15} /> Ejecutar auditoría
          </button>
        </div>
      )}

      {/* ── Loading ── */}
      {loading && !result && (
        <div className="card" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
          <RefreshCw size={32} className="animate-spin" style={{ color: '#818cf8', margin: '0 auto 1rem' }} />
          <p style={{ color: 'var(--text-secondary)' }}>Ejecutando 16 checks de integridad…</p>
        </div>
      )}

      {/* ── Results ── */}
      {result && (
        <>
          {/* Summary cards */}
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.75rem' }}
            data-testid="finance-health-summary"
          >
            <SummaryCard
              icon={<ShieldCheck size={20} />}
              label={result.ok ? 'Sin problemas' : 'Con issues'}
              value={result.total_issues}
              color={result.ok ? '#34d399' : result.critical_count > 0 ? '#ef4444' : '#f59e0b'}
              testId="finance-health-summary-total"
            />
            <SummaryCard
              icon={<AlertCircle size={20} />}
              label="Críticos"
              value={result.critical_count}
              color="#ef4444"
              testId="finance-health-critical-count"
            />
            <SummaryCard
              icon={<AlertTriangle size={20} />}
              label="Advertencias"
              value={result.warning_count}
              color="#f59e0b"
              testId="finance-health-warning-count"
            />
            <SummaryCard
              icon={<Info size={20} />}
              label="Bajos"
              value={result.low_count}
              color="#64748b"
              testId="finance-health-low-count"
            />
          </div>

          {/* Checks grouped by severity */}
          {criticalChecks.length > 0 && (
            <section style={{ marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#ef4444', marginBottom: '0.75rem' }}>
                🔴 Críticos ({criticalChecks.length})
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                {criticalChecks.map(c => <CheckRow key={c.id} check={c} />)}
              </div>
            </section>
          )}

          {warningChecks.length > 0 && (
            <section style={{ marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#f59e0b', marginBottom: '0.75rem' }}>
                🟡 Advertencias ({warningChecks.length})
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                {warningChecks.map(c => <CheckRow key={c.id} check={c} />)}
              </div>
            </section>
          )}

          {lowChecks.length > 0 && (
            <section style={{ marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', marginBottom: '0.75rem' }}>
                ⚪ Bajos ({lowChecks.length})
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                {lowChecks.map(c => <CheckRow key={c.id} check={c} />)}
              </div>
            </section>
          )}

          {okChecks.length > 0 && (
            <section>
              <h2 style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#34d399', marginBottom: '0.75rem' }}>
                ✅ Sin problemas ({okChecks.length})
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '0.5rem' }}>
                {okChecks.map(c => <CheckRow key={c.id} check={c} />)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
