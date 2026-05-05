import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Search, Plus, X, ChevronRight, AlertTriangle, CheckCircle2, TrendingUp,
  TrendingDown, User, Building2, DollarSign, RefreshCw, Filter,
  CreditCard, ArrowUpRight, ArrowDownRight, FileText, Edit2, Loader2,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  AppButton, AppIconButton, AppPageHeader, AppSearchInput,
  AppEmptyState, AppLoadingState,
} from '../ui'
import { AddIcon, DeleteIcon } from '../ui/icons'
import {
  cuentasService,
  getAccountStatus,
  type Account,
  type AccountMovement,
  type AccountType,
  type MovementType,
} from '../services/cuentasService'

// ─── Types ────────────────────────────────────────────────────────────────────

interface EntityOption { id: string; name: string; phone?: string | null }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtARS  = (n: number) => '$' + Math.abs(Math.round(n)).toLocaleString('es-AR')
const fmtDate = (d: string) => new Date(d + (d.includes('T') ? '' : 'T12:00:00')).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: '2-digit' })
const today   = () => new Date().toISOString().split('T')[0]

const STATUS_META = {
  al_dia:  { label: 'Al día',   color: '#34d399', bg: 'rgba(52,211,153,0.10)',  border: 'rgba(52,211,153,0.25)'  },
  deuda:   { label: 'En deuda', color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.25)' },
  a_favor: { label: 'A favor',  color: '#60a5fa', bg: 'rgba(96,165,250,0.10)',  border: 'rgba(96,165,250,0.25)'  },
}

const MOV_META: Record<MovementType, { label: string; color: string }> = {
  venta:    { label: 'Venta',    color: '#34d399' },
  compra:   { label: 'Compra',   color: '#f87171' },
  gasto:    { label: 'Gasto',    color: '#fb923c' },
  pago:     { label: 'Pago',     color: '#60a5fa' },
  ajuste:   { label: 'Ajuste',   color: '#a78bfa' },
  apertura: { label: 'Apertura', color: '#94a3b8' },
}

// ─── MovementModal ────────────────────────────────────────────────────────────

type ModalMode = 'pago' | 'deuda' | 'ajuste'

interface MovementModalProps {
  mode: ModalMode
  account: Account
  businessId: string
  userId: string
  onSaved: () => void
  onClose: () => void
}

function MovementModal({ mode, account, businessId, userId, onSaved, onClose }: MovementModalProps) {
  const [amount, setAmount]   = useState('')
  const [desc, setDesc]       = useState('')
  const [date, setDate]       = useState(today())
  const [isCredit, setIsCredit] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState('')

  const titles: Record<ModalMode, string> = { pago: 'Registrar pago', deuda: 'Registrar deuda', ajuste: 'Ajuste manual' }
  const colors: Record<ModalMode, string> = { pago: '#60a5fa', deuda: '#f87171', ajuste: '#a78bfa' }

  const handleSave = async () => {
    const amt = parseFloat(amount.replace(',', '.'))
    if (!amt || amt <= 0) { setErr('El monto debe ser mayor a 0'); return }
    if (!desc.trim()) { setErr('La descripción es obligatoria'); return }
    setSaving(true); setErr('')
    try {
      if (mode === 'pago')  await cuentasService.registerPayment(businessId, account.id, amt, desc.trim(), userId)
      if (mode === 'deuda') await cuentasService.registerDebt(businessId, account.id, amt, desc.trim(), userId)
      if (mode === 'ajuste') await cuentasService.addAdjustment(businessId, account.id, amt, isCredit, desc.trim(), userId)
      onSaved()
    } catch (e: any) { setErr(e.message || 'Error al guardar') }
    finally { setSaving(false) }
  }

  const inputS: React.CSSProperties = { width: '100%', padding: '0.5625rem 0.875rem', background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' as const }
  const labelS: React.CSSProperties = { display: 'block', fontSize: '0.72rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.35rem', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-modal)', border: `1px solid ${colors[mode]}33`, borderRadius: 'var(--radius-2xl)', width: '100%', maxWidth: 440, boxShadow: 'var(--shadow-xl)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid var(--border-subtle)' }}>
          <div>
            <h2 style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: '1rem' }}>{titles[mode]}</h2>
            <p style={{ margin: '0.15rem 0 0', fontSize: '0.75rem', color: '#475569' }}>{account.entity_name}</p>
          </div>
          <AppButton variant="ghost" size="sm" onClick={onClose}><X size={15} /></AppButton>
        </div>

        <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={labelS}>Monto *</label>
            <input style={{ ...inputS, fontSize: '1.5rem', fontWeight: 800, textAlign: 'right', color: colors[mode] }}
              type="number" min="0.01" step="0.01" value={amount}
              onChange={e => setAmount(e.target.value)} placeholder="$ 0" autoFocus />
          </div>

          {mode === 'ajuste' && (
            <div>
              <label style={labelS}>Tipo de ajuste</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {[{ v: true, l: 'Acreedor (reduce deuda)', c: '#34d399' }, { v: false, l: 'Deudor (agrega deuda)', c: '#f87171' }].map(o => (
                  <button key={String(o.v)} type="button" onClick={() => setIsCredit(o.v)}
                    style={{ flex: 1, padding: '0.5rem 0.5rem', borderRadius: 'var(--radius-md)', border: `2px solid ${isCredit === o.v ? o.c : 'rgba(255,255,255,0.08)'}`, background: isCredit === o.v ? `${o.c}22` : 'transparent', color: isCredit === o.v ? o.c : '#475569', fontWeight: 600, fontSize: '0.75rem', cursor: 'pointer' }}>
                    {o.l}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label style={labelS}>Descripción *</label>
            <input style={inputS} type="text" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Motivo o referencia..." />
          </div>

          <div>
            <label style={labelS}>Fecha</label>
            <input style={inputS} type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>

          {err && <p style={{ margin: 0, color: 'var(--error)', fontSize: '0.8rem', fontWeight: 600 }}>{err}</p>}
        </div>

        <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', background: 'var(--bg-modal)', borderRadius: '0 0 var(--radius-2xl) var(--radius-2xl)' }}>
          <AppButton variant="secondary" onClick={onClose}>Cancelar</AppButton>
          <AppButton variant="indigo" loading={saving} onClick={handleSave} leftIcon={mode === 'pago' ? <ArrowDownRight size={14} /> : mode === 'deuda' ? <ArrowUpRight size={14} /> : <Edit2 size={14} />}>
            Guardar
          </AppButton>
        </div>
      </div>
    </div>
  )
}

// ─── NewAccountModal ──────────────────────────────────────────────────────────

interface NewAccountModalProps {
  activeTab: AccountType
  businessId: string
  onCreated: (a: Account) => void
  onClose: () => void
}

function NewAccountModal({ activeTab, businessId, onCreated, onClose }: NewAccountModalProps) {
  const [entities, setEntities] = useState<EntityOption[]>([])
  const [entityId, setEntityId] = useState('')
  const [creditLimit, setCreditLimit] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState('')

  useEffect(() => {
    const table = activeTab === 'cliente' ? 'customers' : 'suppliers'
    supabase.from(table).select('id, name, phone').eq('business_id', businessId).order('name')
      .then(({ data }) => { setEntities((data || []).map((e: any) => ({ id: e.id, name: e.name, phone: e.phone }))); setLoading(false) })
  }, [activeTab, businessId])

  const handleCreate = async () => {
    if (!entityId) { setErr('Seleccioná un ' + (activeTab === 'cliente' ? 'cliente' : 'proveedor')); return }
    const entity = entities.find(e => e.id === entityId)
    if (!entity) return
    setSaving(true); setErr('')
    try {
      const acc = await cuentasService.getOrCreate(businessId, activeTab, entityId, entity.name, entity.phone)
      if (creditLimit) await cuentasService.updateAccount(acc.id, { credit_limit: parseFloat(creditLimit) || null })
      onCreated({ ...acc, credit_limit: parseFloat(creditLimit) || null })
    } catch (e: any) { setErr(e.message || 'Error al crear cuenta') }
    finally { setSaving(false) }
  }

  const inputS: React.CSSProperties = { width: '100%', padding: '0.5625rem 0.875rem', background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' as const }
  const labelS: React.CSSProperties = { display: 'block', fontSize: '0.72rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.35rem', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-modal)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-2xl)', width: '100%', maxWidth: 420, boxShadow: 'var(--shadow-xl)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid var(--border-subtle)' }}>
          <h2 style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: '1rem' }}>
            Nueva cuenta — {activeTab === 'cliente' ? 'Cliente' : 'Proveedor'}
          </h2>
          <AppButton variant="ghost" size="sm" onClick={onClose}><X size={15} /></AppButton>
        </div>
        <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {loading ? <AppLoadingState rows={3} /> : (
            <>
              <div>
                <label style={labelS}>{activeTab === 'cliente' ? 'Cliente' : 'Proveedor'} *</label>
                <select style={inputS} value={entityId} onChange={e => setEntityId(e.target.value)}>
                  <option value="">— Seleccioná —</option>
                  {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
              <div>
                <label style={labelS}>Límite de crédito (opcional)</label>
                <input style={inputS} type="number" min="0" step="1" value={creditLimit}
                  onChange={e => setCreditLimit(e.target.value)} placeholder="Sin límite" />
              </div>
            </>
          )}
          {err && <p style={{ margin: 0, color: 'var(--error)', fontSize: '0.8rem' }}>{err}</p>}
        </div>
        <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', borderRadius: '0 0 var(--radius-2xl) var(--radius-2xl)' }}>
          <AppButton variant="secondary" onClick={onClose}>Cancelar</AppButton>
          <AppButton variant="indigo" loading={saving} onClick={handleCreate} leftIcon={<Plus size={14} />}>Agregar cuenta</AppButton>
        </div>
      </div>
    </div>
  )
}

// ─── AccountDetail ────────────────────────────────────────────────────────────

interface AccountDetailProps {
  account: Account
  businessId: string
  userId: string
  onClose: () => void
  onRefreshList: () => void
}

function AccountDetail({ account, businessId, userId, onClose, onRefreshList }: AccountDetailProps) {
  const [movements, setMovements] = useState<AccountMovement[]>([])
  const [loading, setLoading]     = useState(true)
  const [localBalance, setLocalBalance] = useState(account.balance)
  const [modal, setModal]         = useState<ModalMode | null>(null)

  const status = getAccountStatus(localBalance)
  const sm     = STATUS_META[status]

  const loadMovements = useCallback(async () => {
    setLoading(true)
    const movs = await cuentasService.getMovements(account.id, 200)
    setMovements(movs)
    // Refresh balance from DB
    const fresh = await cuentasService.getAccount(account.id)
    if (fresh) setLocalBalance(fresh.balance)
    setLoading(false)
  }, [account.id])

  useEffect(() => { loadMovements() }, [loadMovements])

  const handleMovSaved = async () => {
    setModal(null)
    await loadMovements()
    onRefreshList()
  }

  const balanceDisplay = () => {
    if (Math.abs(localBalance) < 0.01) return { text: '$0', color: '#34d399' }
    if (localBalance > 0) return { text: fmtARS(localBalance), color: '#f87171' }
    return { text: fmtARS(localBalance), color: '#60a5fa' }
  }
  const bal = balanceDisplay()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '1.25rem', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.875rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: 40, height: 40, borderRadius: '0.625rem', background: account.type === 'cliente' ? 'rgba(99,102,241,0.12)' : 'rgba(251,191,36,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {account.type === 'cliente' ? <User size={18} style={{ color: '#818cf8' }} /> : <Building2 size={18} style={{ color: '#fbbf24' }} />}
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{account.entity_name}</h3>
              {account.entity_phone && <p style={{ margin: '0.1rem 0 0', fontSize: '0.75rem', color: '#475569' }}>{account.entity_phone}</p>}
            </div>
          </div>
          <AppIconButton icon={<X size={14} />} label="Cerrar" size="xs" onClick={onClose} />
        </div>

        {/* Balance destacado */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.875rem 1rem', background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,255,255,0.05)', marginBottom: '0.875rem' }}>
          <div>
            <div style={{ fontSize: '0.7rem', color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem' }}>Saldo actual</div>
            <div style={{ fontSize: '1.625rem', fontWeight: 800, fontFamily: 'monospace', color: bal.color, letterSpacing: '-0.02em' }}>{bal.text}</div>
          </div>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '0.25rem 0.625rem', borderRadius: '9999px', background: sm.bg, color: sm.color, border: `1px solid ${sm.border}` }}>
            {sm.label}
          </span>
        </div>

        {/* Acciones */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' as const }}>
          <AppButton variant="indigo" size="sm" leftIcon={<ArrowDownRight size={13} />} onClick={() => setModal('pago')}>Registrar pago</AppButton>
          <AppButton variant="red" size="sm" leftIcon={<ArrowUpRight size={13} />} onClick={() => setModal('deuda')}>Registrar deuda</AppButton>
          <AppButton variant="ghost" size="sm" leftIcon={<Edit2 size={13} />} onClick={() => setModal('ajuste')}>Ajuste</AppButton>
          <AppButton variant="ghost" size="sm" leftIcon={<RefreshCw size={13} />} onClick={loadMovements}>Actualizar</AppButton>
        </div>
      </div>

      {/* Extracto */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: '1.25rem' }}><AppLoadingState rows={5} /></div>
        ) : movements.length === 0 ? (
          <AppEmptyState icon={<FileText size={24} />} title="Sin movimientos" description="Registrá el primer movimiento para este cliente." />
        ) : (
          <div style={{ overflowX: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.02)', position: 'sticky', top: 0 }}>
                  {['Fecha', 'Tipo', 'Descripción', 'Debe', 'Haber', 'Saldo'].map((h, i) => (
                    <th key={h} style={{ padding: '0.5rem 0.75rem', textAlign: i >= 3 ? 'right' : 'left', color: '#334155', fontWeight: 700, fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.05)', whiteSpace: 'nowrap' as const }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {movements.map(mov => {
                  const mm  = MOV_META[mov.type] || MOV_META.ajuste
                  const balS = getAccountStatus(mov.balance_after)
                  return (
                    <tr key={mov.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      <td style={{ padding: '0.5625rem 0.75rem', color: '#475569', whiteSpace: 'nowrap' as const }}>{fmtDate(mov.date)}</td>
                      <td style={{ padding: '0.5625rem 0.75rem', whiteSpace: 'nowrap' as const }}>
                        <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '0.1rem 0.4rem', borderRadius: '0.25rem', background: `${mm.color}18`, color: mm.color }}>{mm.label}</span>
                      </td>
                      <td style={{ padding: '0.5625rem 0.75rem', color: 'var(--text-secondary)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{mov.description}</td>
                      <td style={{ padding: '0.5625rem 0.75rem', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: mov.debit > 0 ? '#f87171' : '#1e3a5f' }}>
                        {mov.debit > 0 ? fmtARS(mov.debit) : '—'}
                      </td>
                      <td style={{ padding: '0.5625rem 0.75rem', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: mov.credit > 0 ? '#34d399' : '#1e3a5f' }}>
                        {mov.credit > 0 ? fmtARS(mov.credit) : '—'}
                      </td>
                      <td style={{ padding: '0.5625rem 0.75rem', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: STATUS_META[balS].color, whiteSpace: 'nowrap' as const }}>
                        {Math.abs(mov.balance_after) < 0.01 ? '$0' : fmtARS(mov.balance_after)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Movement modals */}
      {modal && (
        <MovementModal mode={modal} account={{ ...account, balance: localBalance }} businessId={businessId} userId={userId}
          onSaved={handleMovSaved} onClose={() => setModal(null)} />
      )}
    </div>
  )
}

// ─── CuentasCorrientes (main page) ────────────────────────────────────────────

export function CuentasCorrientes() {
  const { businessId, user } = useAuth()

  const [accounts, setAccounts]       = useState<Account[]>([])
  const [loading, setLoading]         = useState(true)
  const [activeTab, setActiveTab]     = useState<AccountType>('cliente')
  const [searchQ, setSearchQ]         = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'deuda' | 'al_dia' | 'a_favor'>('all')
  const [selectedId, setSelectedId]   = useState<string | null>(null)
  const [showNewModal, setShowNewModal] = useState(false)

  // ── Data loading ───────────────────────────────────────────────────────────

  const loadAccounts = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    const list = await cuentasService.getAccounts(businessId, activeTab, searchQ || undefined, filterStatus)
    setAccounts(list)
    setLoading(false)
  }, [businessId, activeTab, searchQ, filterStatus])

  useEffect(() => { loadAccounts() }, [loadAccounts])

  // ── Computed ───────────────────────────────────────────────────────────────

  const selectedAccount = useMemo(() => accounts.find(a => a.id === selectedId) || null, [accounts, selectedId])

  const stats = useMemo(() => {
    const deuda   = accounts.filter(a => getAccountStatus(a.balance) === 'deuda')
    const aFavor  = accounts.filter(a => getAccountStatus(a.balance) === 'a_favor')
    return {
      totalDeuda:  deuda.reduce((s, a) => s + a.balance, 0),
      totalFavor:  Math.abs(aFavor.reduce((s, a) => s + a.balance, 0)),
      countDeuda:  deuda.length,
      countFavor:  aFavor.length,
    }
  }, [accounts])

  // ── Render ─────────────────────────────────────────────────────────────────

  const tabBtn = (t: AccountType, label: string, icon: React.ReactNode) => (
    <button key={t} onClick={() => { setActiveTab(t); setSelectedId(null) }}
      style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1.125rem', borderRadius: 'var(--radius-md)', border: `1px solid ${activeTab === t ? 'var(--accent-primary-light)' : 'transparent'}`, background: activeTab === t ? 'var(--accent-primary-subtle)' : 'transparent', color: activeTab === t ? 'var(--accent-primary)' : '#475569', fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', transition: 'all 0.15s' }}>
      {icon} {label}
    </button>
  )

  return (
    <div className="page-shell">
      <AppPageHeader
        icon={<CreditCard size={20} />}
        iconColor="var(--accent-primary-subtle)"
        title="Cuentas Corrientes"
        description="Ledger contable de clientes y proveedores"
        actions={
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <AppButton variant="ghost" size="sm" leftIcon={<RefreshCw size={14} />} onClick={loadAccounts}>Actualizar</AppButton>
            <AppButton variant="indigo" size="sm" leftIcon={<AddIcon size={14} />} onClick={() => setShowNewModal(true)}>Nueva cuenta</AppButton>
          </div>
        }
      />

      {/* Stats strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.875rem', marginBottom: '1.25rem' }}>
        {[
          { label: activeTab === 'cliente' ? 'Clientes en deuda' : 'Proveedores con deuda', value: stats.countDeuda, amount: stats.totalDeuda, color: '#f87171', icon: <TrendingDown size={16} /> },
          { label: activeTab === 'cliente' ? 'Clientes a favor' : 'Proveedores a favor', value: stats.countFavor, amount: stats.totalFavor, color: '#60a5fa', icon: <TrendingUp size={16} /> },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <div className="stat-card-label">{s.label}</div>
              <div style={{ width: 32, height: 32, borderRadius: 'var(--radius-md)', background: `${s.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: s.color }}>{s.icon}</div>
            </div>
            <div className="stat-card-value" style={{ color: s.color }}>{fmtARS(s.amount)}</div>
            <div style={{ fontSize: '0.72rem', color: '#334155', marginTop: '0.2rem' }}>{s.value} cuenta{s.value !== 1 ? 's' : ''}</div>
          </div>
        ))}
      </div>

      {/* Tabs + filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' as const }}>
        <div style={{ display: 'flex', gap: '0.25rem', padding: '0.25rem', background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)' }}>
          {tabBtn('cliente',    'Clientes',    <User     size={14} />)}
          {tabBtn('proveedor',  'Proveedores', <Building2 size={14} />)}
        </div>

        <div style={{ flex: 1, minWidth: 200 }}>
          <AppSearchInput value={searchQ} onChange={setSearchQ} placeholder={`Buscar ${activeTab}...`} />
        </div>

        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}
          className="form-select" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.375rem 0.625rem' }}>
          <option value="all">Todos los estados</option>
          <option value="deuda">En deuda</option>
          <option value="al_dia">Al día</option>
          <option value="a_favor">A favor</option>
        </select>
      </div>

      {/* Content: list + detail panel */}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>

        {/* Account list */}
        <div style={{ flex: selectedAccount ? '0 0 360px' : '1', minWidth: 0, transition: 'flex 0.2s' }}>
          {loading ? (
            <AppLoadingState rows={6} />
          ) : accounts.length === 0 ? (
            <div className="card">
              <AppEmptyState
                icon={<CreditCard size={28} />}
                title={`Sin cuentas de ${activeTab}s`}
                description={`Agregá un ${activeTab} para empezar a registrar movimientos.`}
                action={{ label: `Agregar ${activeTab}`, icon: <AddIcon size={14} />, onClick: () => setShowNewModal(true), variant: 'indigo' }}
              />
            </div>
          ) : (
            <div className="card table-wrap" style={{ padding: 0 }}>
              <table className="table table-clickable">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    {!selectedAccount && <th>Tipo</th>}
                    <th style={{ textAlign: 'right' }}>Saldo</th>
                    <th>Estado</th>
                    {!selectedAccount && <th>Actualizado</th>}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(acc => {
                    const status = getAccountStatus(acc.balance)
                    const sm     = STATUS_META[status]
                    const isSelected = selectedId === acc.id
                    const bal    = Math.abs(acc.balance) < 0.01 ? '$0' : fmtARS(acc.balance)
                    return (
                      <tr key={acc.id} onClick={() => setSelectedId(p => p === acc.id ? null : acc.id)}
                        style={{ background: isSelected ? 'var(--bg-hover)' : 'transparent' }}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <div style={{ width: 28, height: 28, borderRadius: '50%', background: acc.type === 'cliente' ? 'rgba(99,102,241,0.15)' : 'rgba(251,191,36,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              {acc.type === 'cliente' ? <User size={13} style={{ color: '#818cf8' }} /> : <Building2 size={13} style={{ color: '#fbbf24' }} />}
                            </div>
                            <span style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)' }}>{acc.entity_name}</span>
                          </div>
                        </td>
                        {!selectedAccount && (
                          <td style={{ fontSize: '0.78rem', color: '#475569', textTransform: 'capitalize' as const }}>{acc.type}</td>
                        )}
                        <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, fontSize: '0.9rem', color: sm.color }}>{bal}</td>
                        <td>
                          <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: '9999px', background: sm.bg, color: sm.color, border: `1px solid ${sm.border}` }}>
                            {sm.label}
                          </span>
                        </td>
                        {!selectedAccount && (
                          <td style={{ fontSize: '0.75rem', color: '#334155' }}>
                            {fmtDate(acc.updated_at)}
                          </td>
                        )}
                        <td>
                          <ChevronRight size={13} style={{ color: isSelected ? 'var(--accent-primary)' : '#1e3a5f', transform: isSelected ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background: 'rgba(255,255,255,0.02)', borderTop: '2px solid var(--border-color)' }}>
                    <td colSpan={selectedAccount ? 1 : 2} style={{ padding: '0.75rem 1rem', fontWeight: 700, color: '#475569', fontSize: '0.78rem' }}>
                      {accounts.length} cuenta{accounts.length !== 1 ? 's' : ''}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontWeight: 800, fontFamily: 'monospace', color: stats.totalDeuda > 0 ? '#f87171' : '#34d399' }}>
                      {fmtARS(accounts.reduce((s, a) => s + a.balance, 0))}
                    </td>
                    <td colSpan={selectedAccount ? 2 : 3} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedAccount && (
          <div className="card animate-fade-in" style={{ flex: 1, minWidth: 0, padding: 0, overflow: 'hidden', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <AccountDetail
              account={selectedAccount}
              businessId={businessId || ''}
              userId={user?.id || ''}
              onClose={() => setSelectedId(null)}
              onRefreshList={loadAccounts}
            />
          </div>
        )}
      </div>

      {/* New account modal */}
      {showNewModal && (
        <NewAccountModal
          activeTab={activeTab}
          businessId={businessId || ''}
          onCreated={acc => { setAccounts(prev => [acc, ...prev.filter(a => a.id !== acc.id)].sort((a, b) => a.entity_name.localeCompare(b.entity_name))); setShowNewModal(false); setSelectedId(acc.id) }}
          onClose={() => setShowNewModal(false)}
        />
      )}
    </div>
  )
}
