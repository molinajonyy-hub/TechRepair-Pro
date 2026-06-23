/**
 * AdminSubscriptions.tsx — Internal admin panel for subscription management
 *
 * Only accessible to users with role = 'owner' | 'admin'
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Search, RefreshCw, CheckCircle, Clock,
  ChevronUp, Loader2, Eye, Zap, Ban
} from 'lucide-react'
import {
  adminListSubscriptions,
  adminGetEvents,
  adminActivateBusiness,
  adminSuspendBusiness,
  adminChangePlan,
  adminExtendTrial,
  getPlatformAdminRole,
  formatSubscriptionPrice,
} from '../services/subscriptionService'
import {
  STATUS_LABELS,
  STATUS_COLORS,
  PAYMENT_STATUS_COLORS,
  PAYMENT_STATUS_LABELS,
  PLANS,
  type SubscriptionStatus,
  type SubscriptionPlan,
} from '../types/subscription'

type AdminBiz = {
  business_id: string
  business_name: string
  subscription_status: SubscriptionStatus
  subscription_plan: string | null
  access_source: string | null
  mp_preapproval_id: string | null
  mp_payer_email: string | null
  current_period_end: string | null
  grace_until: string | null
  last_payment_status: string | null
  last_webhook_at: string | null
  trial_ends_at: string | null
  override_expires_at: string | null
  created_at: string
  total_payments: number
  last_paid_at?: string | null
  total_revenue: number
}

// How the business obtained access — distinguishes a real MP payment from a
// manual/grandfathered grant. NEVER render a manual grant as "paid".
function AccessSourceBadge({ source, hasMp }: { source: string | null; hasMp: boolean }) {
  const cfg: Record<string, { label: string; color: string }> = {
    mercado_pago:         { label: 'Mercado Pago', color: '#34d399' },
    trial:                { label: 'Trial',         color: '#60a5fa' },
    manual_grandfathered: { label: 'Legacy manual', color: '#fbbf24' },
    admin_override:       { label: 'Override admin', color: '#a78bfa' },
  }
  const key = source ?? (hasMp ? 'mercado_pago' : '')
  const c = cfg[key] ?? { label: 'Sin clasificar', color: '#94a3b8' }
  return (
    <span className="badge" style={{ background: c.color + '20', color: c.color, fontSize: '0.7rem' }}>
      {c.label}
    </span>
  )
}

function StatusBadge({ status }: { status: SubscriptionStatus }) {
  return (
    <span className="badge" style={{
      background: STATUS_COLORS[status] + '20', color: STATUS_COLORS[status],
    }}>
      {STATUS_LABELS[status]}
    </span>
  )
}

export function AdminSubscriptions() {
  const [platformRole, setPlatformRole] = useState<string | null>(null)
  const [businesses, setBusinesses] = useState<AdminBiz[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [events, setEvents] = useState<Record<string, any[]>>({})
  const [loadingEvents, setLoadingEvents] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [activatePlan, setActivatePlan] = useState<SubscriptionPlan>('basico')

  // Platform-admin authorization is server-side (RPC). The business "owner/admin"
  // role does NOT grant access here. billing_admin/super_admin can write.
  useEffect(() => { getPlatformAdminRole().then(setPlatformRole) }, [])
  const canWrite = platformRole === 'billing_admin' || platformRole === 'super_admin'

  // Prompt for a mandatory reason (audited server-side).
  function askReason(label: string): string | null {
    const r = window.prompt(`${label}\n\nMotivo (obligatorio, queda auditado):`)?.trim()
    if (!r || r.length < 4) { if (r !== null) alert('El motivo es obligatorio (mín. 4 caracteres).'); return null }
    return r
  }
  const [changePlanTarget, setChangePlanTarget] = useState<{ id: string; current: string } | null>(null)
  const [changePlanValue, setChangePlanValue] = useState<SubscriptionPlan>('pro')
  const [trialExtendDays, setTrialExtendDays] = useState(14)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const data = await adminListSubscriptions(query || undefined)
      setBusinesses(data as AdminBiz[])
    } catch (err: any) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => { load() }, [load])

  async function loadEvents(businessId: string) {
    if (events[businessId]) return
    setLoadingEvents(businessId)
    try {
      const data = await adminGetEvents(businessId)
      setEvents(prev => ({ ...prev, [businessId]: data }))
    } catch (err) {
      console.error(err)
    } finally {
      setLoadingEvents(null)
    }
  }

  function toggleExpand(id: string) {
    const next = expandedId === id ? null : id
    setExpandedId(next)
    if (next) loadEvents(next)
  }

  async function handleActivate(businessId: string) {
    if (!canWrite) return
    const reason = askReason(`Activar manualmente como Plan ${activatePlan} (override admin)`)
    if (!reason) return
    setActionLoading(businessId + '_activate')
    try {
      await adminActivateBusiness(businessId, activatePlan, reason)
      await load()
    } catch (err: any) { alert(err.message) }
    finally { setActionLoading(null) }
  }

  async function handleSuspend(businessId: string) {
    if (!canWrite) return
    const reason = askReason('Suspender este negocio')
    if (!reason) return
    setActionLoading(businessId + '_suspend')
    try {
      await adminSuspendBusiness(businessId, reason)
      await load()
    } catch (err: any) { alert(err.message) }
    finally { setActionLoading(null) }
  }

  async function handleChangePlan() {
    if (!canWrite || !changePlanTarget) return
    const reason = askReason(`Cambiar plan a ${changePlanValue}`)
    if (!reason) return
    setActionLoading(changePlanTarget.id + '_plan')
    try {
      await adminChangePlan(changePlanTarget.id, changePlanValue, reason)
      setChangePlanTarget(null)
      await load()
    } catch (err: any) { alert(err.message) }
    finally { setActionLoading(null) }
  }

  async function handleExtendTrial(businessId: string) {
    if (!canWrite) return
    const reason = askReason(`Extender trial ${trialExtendDays} días`)
    if (!reason) return
    setActionLoading(businessId + '_trial')
    try {
      await adminExtendTrial(businessId, trialExtendDays, reason)
      await load()
    } catch (err: any) { alert(err.message) }
    finally { setActionLoading(null) }
  }

  // Stats summary
  const stats = {
    total: businesses.length,
    active: businesses.filter(b => b.subscription_status === 'active').length,
    trialing: businesses.filter(b => b.subscription_status === 'trialing').length,
    pastDue: businesses.filter(b => b.subscription_status === 'past_due').length,
    suspended: businesses.filter(b => ['suspended', 'canceled'].includes(b.subscription_status)).length,
    revenue: businesses.reduce((s, b) => s + (b.total_revenue || 0), 0),
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div>
            <h1 className="page-hdr-title">Panel de Suscripciones</h1>
            <p className="page-hdr-subtitle">Gestión interna — solo administradores</p>
          </div>
        </div>
        <div className="page-hdr-right">
          <button onClick={load} style={ghostBtn}>
            <RefreshCw size={16} />
            Actualizar
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem', marginBottom: '1.75rem' }}>
        <StatCard label="Total" value={stats.total} color="var(--text-primary)" />
        <StatCard label="Activas" value={stats.active} color="#34d399" />
        <StatCard label="En prueba" value={stats.trialing} color="#60a5fa" />
        <StatCard label="Vencidas" value={stats.pastDue} color="#fbbf24" />
        <StatCard label="Suspendidas" value={stats.suspended} color="#f87171" />
        <StatCard label="Revenue total" value={formatSubscriptionPrice(stats.revenue)} color="#a78bfa" />
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: '1.5rem' }}>
        <Search size={16} style={{ position: 'absolute', left: '0.875rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()}
          placeholder="Buscar por nombre de negocio..."
          className="form-control"
          style={{ paddingLeft: '2.5rem' }}
        />
      </div>

      {/* Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            <Loader2 size={24} style={{ animation: 'tr-spin 1s linear infinite' }} />
          </div>
        ) : businesses.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            No se encontraron negocios.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  {['Negocio', 'Estado', 'Plan', 'Vencimiento', 'Último pago', 'Revenue', 'Acciones', ''].map(h => (
                    <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {businesses.map(b => (
                  <>
                    <tr key={b.business_id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={tdS}>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>{b.business_name}</div>
                        {b.mp_payer_email && <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{b.mp_payer_email}</div>}
                      </td>
                      <td style={tdS}><StatusBadge status={b.subscription_status} /></td>
                      <td style={tdS}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                          <span>{PLANS.find(p => p.id === b.subscription_plan)?.name || b.subscription_plan || '—'}</span>
                          <AccessSourceBadge source={b.access_source} hasMp={!!b.mp_preapproval_id} />
                        </div>
                      </td>
                      <td style={tdS}>
                        {b.current_period_end
                          ? new Date(b.current_period_end).toLocaleDateString('es-AR')
                          : b.trial_ends_at
                            ? `Prueba: ${new Date(b.trial_ends_at).toLocaleDateString('es-AR')}`
                            : 'â€"'}
                      </td>
                      <td style={tdS}>
                        {b.last_payment_status ? (
                          <span style={{
                            padding: '0.15rem 0.5rem', borderRadius: '0.5rem', fontSize: '0.75rem', fontWeight: 600,
                            background: (PAYMENT_STATUS_COLORS as Record<string,string>)[b.last_payment_status] + '20',
                            color: (PAYMENT_STATUS_COLORS as Record<string,string>)[b.last_payment_status],
                          }}>
                            {(PAYMENT_STATUS_LABELS as Record<string,string>)[b.last_payment_status] || b.last_payment_status}
                          </span>
                        ) : 'â€"'}
                      </td>
                      <td style={tdS}>{formatSubscriptionPrice(b.total_revenue)}</td>
                      <td style={tdS}>
                        {canWrite && (
                          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {/* Activate */}
                            <div style={{ display: 'flex', gap: '0.25rem' }}>
                              <select
                                value={activatePlan}
                                onChange={e => setActivatePlan(e.target.value as SubscriptionPlan)}
                                style={{ ...selectStyle, fontSize: '0.75rem', padding: '0.25rem 0.4rem' }}
                              >
                                {PLANS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                              </select>
                              <button
                                onClick={() => handleActivate(b.business_id)}
                                disabled={actionLoading === b.business_id + '_activate'}
                                style={miniBtn('#34d399')}
                                title="Activar manualmente"
                              >
                                {actionLoading === b.business_id + '_activate'
                                  ? <Loader2 size={13} style={{ animation: 'tr-spin 1s linear infinite' }} />
                                  : <Zap size={13} />}
                              </button>
                            </div>
                            {/* Suspend */}
                            <button
                              onClick={() => handleSuspend(b.business_id)}
                              disabled={actionLoading === b.business_id + '_suspend'}
                              style={miniBtn('#f87171')}
                              title="Suspender"
                            >
                              {actionLoading === b.business_id + '_suspend'
                                ? <Loader2 size={13} style={{ animation: 'tr-spin 1s linear infinite' }} />
                                : <Ban size={13} />}
                            </button>
                            {/* Change plan */}
                            <button
                              onClick={() => { setChangePlanTarget({ id: b.business_id, current: b.subscription_plan ?? '' }); setChangePlanValue((b.subscription_plan as SubscriptionPlan) ?? 'pro') }}
                              style={miniBtn('#818cf8')}
                              title="Cambiar plan"
                              data-testid={`admin-change-plan-${b.business_id}`}
                            >
                              <Clock size={13} />
                            </button>
                            {/* Extend trial */}
                            <button
                              onClick={() => handleExtendTrial(b.business_id)}
                              disabled={actionLoading === b.business_id + '_trial'}
                              style={miniBtn('#fbbf24')}
                              title={`Extender trial ${trialExtendDays} días`}
                            >
                              {actionLoading === b.business_id + '_trial'
                                ? <Loader2 size={13} style={{ animation: 'tr-spin 1s linear infinite' }} />
                                : <RefreshCw size={13} />}
                            </button>
                          </div>
                        )}
                      </td>
                      <td style={tdS}>
                        <button
                          onClick={() => toggleExpand(b.business_id)}
                          style={{ ...ghostBtn, padding: '0.3rem 0.5rem', fontSize: '0.75rem' }}
                        >
                          {expandedId === b.business_id ? <ChevronUp size={14} /> : <Eye size={14} />}
                        </button>
                      </td>
                    </tr>

                    {/* Expanded row: events */}
                    {expandedId === b.business_id && (
                      <tr key={b.business_id + '_expanded'}>
                        <td colSpan={8} style={{ padding: '1rem 1.5rem', background: 'rgba(255,255,255,0.02)' }}>
                          <h4 style={{ color: 'var(--text-primary)', margin: '0 0 0.75rem', fontSize: '0.875rem' }}>
                            Webhooks / Eventos
                          </h4>
                          {loadingEvents === b.business_id ? (
                            <Loader2 size={16} style={{ animation: 'tr-spin 1s linear infinite', color: 'var(--text-muted)' }} />
                          ) : (events[b.business_id] || []).length === 0 ? (
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>Sin eventos registrados.</p>
                          ) : (
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                              <thead>
                                <tr>
                                  {['Fecha', 'Tipo', 'ID Externo', 'Procesado', 'Error'].map(h => (
                                    <th key={h} style={{ textAlign: 'left', padding: '0.3rem 0.5rem', color: 'var(--text-muted)' }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {(events[b.business_id] || []).map((ev: any) => (
                                  <tr key={ev.id}>
                                    <td style={{ padding: '0.3rem 0.5rem', color: 'var(--text-muted)' }}>{new Date(ev.created_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                                    <td style={{ padding: '0.3rem 0.5rem', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{ev.event_type}</td>
                                    <td style={{ padding: '0.3rem 0.5rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{ev.external_id || 'â€"'}</td>
                                    <td style={{ padding: '0.3rem 0.5rem' }}>
                                      {ev.processed
                                        ? <CheckCircle size={14} color="#34d399" />
                                        : <Clock size={14} color="#fbbf24" />}
                                    </td>
                                    <td style={{ padding: '0.3rem 0.5rem', color: '#f87171', fontSize: '0.75rem' }}>{ev.error_message || 'â€"'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Modal: cambiar plan ─────────────────────────────────────────── */}
      {changePlanTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
          onClick={() => setChangePlanTarget(null)}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: '1rem', padding: '1.75rem', width: 340, display: 'flex', flexDirection: 'column', gap: '1rem' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              Cambiar plan
            </h3>
            <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              Plan actual: <strong>{changePlanTarget.current || 'sin plan'}</strong>
            </p>
            <select
              value={changePlanValue}
              onChange={e => setChangePlanValue(e.target.value as SubscriptionPlan)}
              data-testid="admin-plan-select"
              style={{ ...selectStyle, width: '100%' }}
            >
              {PLANS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div style={{ display: 'flex', gap: '0.625rem' }}>
              <button onClick={() => setChangePlanTarget(null)} style={{ flex: 1, padding: '0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-subtle)', borderRadius: '0.5rem', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.82rem' }}>
                Cancelar
              </button>
              <button
                onClick={handleChangePlan}
                disabled={actionLoading === changePlanTarget.id + '_plan'}
                data-testid="admin-plan-confirm"
                style={{ flex: 2, padding: '0.625rem', background: '#6366f1', border: 'none', borderRadius: '0.5rem', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: '0.82rem' }}
              >
                {actionLoading === changePlanTarget.id + '_plan' ? 'Guardando…' : 'Confirmar cambio'}
              </button>
            </div>
            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '0.875rem' }}>
              <p style={{ margin: '0 0 0.5rem', fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Extender trial</p>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input type="number" min={1} max={365} value={trialExtendDays} onChange={e => setTrialExtendDays(Number(e.target.value))} style={{ ...selectStyle, width: 70 }} />
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>días</span>
                <button onClick={() => { handleExtendTrial(changePlanTarget.id); setChangePlanTarget(null) }} style={{ flex: 1, padding: '0.5rem', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '0.5rem', color: '#fbbf24', fontWeight: 600, cursor: 'pointer', fontSize: '0.78rem' }}>
                  Extender
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="stat-card">
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-value" style={{ color }}>{value}</div>
    </div>
  )
}

const tdS: React.CSSProperties = { padding: '0.875rem 1rem', verticalAlign: 'top' }

const ghostBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
  padding: '0.5rem 0.875rem', borderRadius: '0.625rem',
  border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.04)',
  color: 'var(--text-secondary)', fontSize: '0.8rem', cursor: 'pointer',
}

const selectStyle: React.CSSProperties = {
  background: 'var(--input-bg)', border: '1px solid var(--input-border)',
  borderRadius: '0.375rem', color: 'var(--text-primary)',
  padding: '0.35rem 0.5rem', fontSize: '0.8rem', outline: 'none',
}

const miniBtn = (color: string): React.CSSProperties => ({
  padding: '0.3rem', borderRadius: '0.375rem',
  border: `1px solid ${color}40`, background: `${color}12`,
  color, cursor: 'pointer', display: 'flex', alignItems: 'center',
})
