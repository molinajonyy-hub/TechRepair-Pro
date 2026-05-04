import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Plus, Receipt, AlertTriangle, Calendar,
  Check, X, ChevronDown,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { smartSearch } from '../utils/searchUtils'
import {
  AppButton, AppIconButton, AppPageHeader, AppSectionHeader,
  AppToolbar, AppSearchInput, AppEmptyState, AppLoadingState,
} from '../ui'
import {
  ExpenseReceiptIcon, AddIcon, DeleteIcon, EditIcon,
  RefreshIcon, AlertIcon,
} from '../ui/icons'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExpenseCategory {
  id: string
  name: string
  color: string
  monthly_limit: number | null
  is_active: boolean
  sort_order: number
}

interface Expense {
  id: string
  description: string
  category: string
  amount: number
  amount_ars: number
  date: string
  payment_method: string
  is_recurring: boolean
  frequency: string | null
  notes: string | null
  created_by: string | null
  business_id: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtARS  = (n: number) => '$' + Math.round(n).toLocaleString('es-AR')
const fmtDate = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' })

const PAYMENT_METHOD_LABELS: Record<string, { label: string; color: string }> = {
  efectivo:      { label: 'Efectivo',      color: '#22c55e' },
  transferencia: { label: 'Transferencia', color: '#60a5fa' },
  tarjeta:       { label: 'Tarjeta',       color: '#f59e0b' },
}

const today = () => new Date().toISOString().split('T')[0]
const firstDayOfMonth = () => {
  const d = new Date(); d.setDate(1)
  return d.toISOString().split('T')[0]
}

// ─── Modal Nuevo Gasto (inline liviano) ──────────────────────────────────────

interface NewExpenseModalProps {
  categories: ExpenseCategory[]
  businessId: string
  userId: string
  onSaved: () => void
  onClose: () => void
}

function NewExpenseModal({ categories, businessId, userId, onSaved, onClose }: NewExpenseModalProps) {
  const [monto, setMonto]         = useState('')
  const [categoria, setCategoria] = useState(categories[0]?.name || '')
  const [metodo, setMetodo]       = useState('efectivo')
  const [descripcion, setDescripcion] = useState('')
  const [fecha, setFecha]         = useState(today())
  const [recurrente, setRecurrente] = useState(false)
  const [frecuencia, setFrecuencia] = useState('mensual')
  const [notas, setNotas]         = useState('')
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')

  const handleSave = async () => {
    const montoNum = parseFloat(monto.replace(',', '.'))
    if (!montoNum || montoNum <= 0) { setError('El monto es obligatorio'); return }
    if (!descripcion.trim()) { setError('La descripción es obligatoria'); return }

    setSaving(true); setError('')
    try {
      const catKey = categoria.toLowerCase().split(' ')[0]
      const financeTypeMap: Record<string, string> = {
        inventario: 'variable_cost', sueldos: 'salary', impuestos: 'taxes',
      }
      const financeType = financeTypeMap[catKey] || 'fixed_cost_local'

      // 1. business_finance_entries
      const { data: bfe, error: bfeErr } = await supabase
        .from('business_finance_entries')
        .insert({
          business_id: businessId, date: fecha,
          type: financeType, category: catKey,
          description: descripcion,
          amount: montoNum, currency: 'ARS', amount_ars: montoNum, exchange_rate: 1,
          payment_method: metodo, source: 'expense', created_by: userId,
        }).select('id').single()
      if (bfeErr) throw bfeErr

      // 2. expenses
      await supabase.from('expenses').insert({
        description: descripcion, category: categoria,
        amount: montoNum, amount_ars: montoNum, date: fecha,
        business_id: businessId, payment_method: metodo,
        currency: 'ARS', exchange_rate: 1,
        is_recurring: recurrente, frequency: recurrente ? frecuencia : null,
        notes: notas || null, finance_entry_id: bfe?.id || null, created_by: userId,
      })

      // 3. Caja si es efectivo
      if (metodo === 'efectivo') {
        await supabase.from('financial_movements').insert({
          business_id: businessId, date: fecha, type: 'expense',
          currency: 'ARS', amount: montoNum, amount_ars: montoNum, exchange_rate: 1,
          description: descripcion, source: 'expense',
          reference_id: bfe?.id || null, created_by: userId,
        })
      }

      onSaved()
    } catch (e: any) {
      setError(e.message || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  const inputS: React.CSSProperties = {
    width: '100%', padding: '0.625rem 0.875rem',
    background: 'var(--input-bg)', border: '1px solid var(--input-border)',
    borderRadius: 'var(--radius-md)', color: 'var(--text-primary)',
    fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' as const,
  }
  const labelS: React.CSSProperties = {
    display: 'block', fontSize: '0.72rem', fontWeight: 600,
    color: 'var(--text-subtle)', marginBottom: '0.35rem',
    textTransform: 'uppercase' as const, letterSpacing: '0.05em',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-modal)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-2xl)', width: '100%', maxWidth: 560, display: 'flex', flexDirection: 'column', maxHeight: '90vh', boxShadow: 'var(--shadow-xl)' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-md)', background: 'var(--error-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--error)' }}>
              <Receipt size={18} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>Nuevo Gasto</h2>
              <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text-subtle)' }}>Registrar egreso del negocio</p>
            </div>
          </div>
          <AppButton variant="ghost" size="sm" onClick={onClose}><X size={16} /></AppButton>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Monto */}
          <div>
            <label style={labelS}>Monto *</label>
            <input style={{ ...inputS, fontSize: '1.5rem', fontWeight: 800, textAlign: 'right', color: 'var(--error)' }}
              type="number" min="0" step="1" value={monto}
              onChange={e => setMonto(e.target.value)} placeholder="$ 0" autoFocus />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label style={labelS}>Categoría *</label>
              <select style={{ ...inputS }} value={categoria} onChange={e => setCategoria(e.target.value)}>
                {categories.filter(c => c.is_active).map(c => (
                  <option key={c.id} value={c.name}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelS}>Método de pago</label>
              <select style={{ ...inputS }} value={metodo} onChange={e => setMetodo(e.target.value)}>
                <option value="efectivo">Efectivo</option>
                <option value="transferencia">Transferencia</option>
                <option value="tarjeta">Tarjeta</option>
              </select>
            </div>
          </div>

          <div>
            <label style={labelS}>Descripción *</label>
            <input style={inputS} type="text" value={descripcion}
              onChange={e => setDescripcion(e.target.value)} placeholder="¿En qué se gastó?" />
          </div>

          <div>
            <label style={labelS}>Fecha</label>
            <input style={inputS} type="date" value={fecha} onChange={e => setFecha(e.target.value)} />
          </div>

          <div>
            <label style={labelS}>Notas (opcional)</label>
            <textarea style={{ ...inputS, minHeight: 60, resize: 'vertical' as const }}
              value={notas} onChange={e => setNotas(e.target.value)}
              placeholder="Información adicional..." />
          </div>

          {/* Recurrente */}
          <div style={{ padding: '0.875rem 1rem', background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={recurrente} onChange={e => setRecurrente(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: 'var(--accent-primary)', cursor: 'pointer' }} />
              <span style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Gasto recurrente</span>
            </label>
            {recurrente && (
              <div>
                <label style={labelS}>Frecuencia</label>
                <select style={{ ...inputS }} value={frecuencia} onChange={e => setFrecuencia(e.target.value)}>
                  <option value="mensual">Mensual</option>
                  <option value="semanal">Semanal</option>
                </select>
              </div>
            )}
          </div>

          {error && <p style={{ margin: 0, color: 'var(--error)', fontSize: '0.8rem' }}>{error}</p>}
        </div>

        {/* Footer */}
        <div style={{ flexShrink: 0, padding: '1rem 1.5rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', background: 'var(--bg-modal)', borderRadius: '0 0 var(--radius-2xl) var(--radius-2xl)' }}>
          <AppButton variant="secondary" onClick={onClose}>Cancelar</AppButton>
          <AppButton variant="red" onClick={handleSave} loading={saving} leftIcon={<Receipt size={14} />}>
            Registrar gasto
          </AppButton>
        </div>
      </div>
    </div>
  )
}

// ─── Modal Categorías ─────────────────────────────────────────────────────────

function CategoriesManager({ categories, onChanged, businessId }: {
  categories: ExpenseCategory[]; onChanged: () => void; businessId: string
}) {
  const [adding, setAdding]   = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#6366f1')
  const [newLimit, setNewLimit] = useState('')
  const [editId, setEditId]   = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('#6366f1')
  const [editLimit, setEditLimit] = useState('')

  const create = async () => {
    if (!newName.trim()) return
    const maxOrder = Math.max(0, ...categories.map(c => c.sort_order)) + 1
    await supabase.from('expense_categories').insert({
      business_id: businessId, name: newName.trim(), color: newColor,
      monthly_limit: newLimit ? parseFloat(newLimit) : null, sort_order: maxOrder,
    })
    setNewName(''); setNewColor('#6366f1'); setNewLimit(''); setAdding(false)
    onChanged()
  }

  const update = async (id: string) => {
    await supabase.from('expense_categories').update({
      name: editName, color: editColor,
      monthly_limit: editLimit ? parseFloat(editLimit) : null,
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    setEditId(null); onChanged()
  }

  const toggleActive = async (cat: ExpenseCategory) => {
    await supabase.from('expense_categories').update({ is_active: !cat.is_active }).eq('id', cat.id)
    onChanged()
  }

  const remove = async (id: string) => {
    if (!confirm('¿Eliminar esta categoría?')) return
    await supabase.from('expense_categories').delete().eq('id', id)
    onChanged()
  }

  const inputS: React.CSSProperties = {
    padding: '0.4rem 0.625rem', background: 'var(--input-bg)', border: '1px solid var(--input-border)',
    borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: '0.8rem', outline: 'none', width: '100%', boxSizing: 'border-box' as const,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {categories.map(cat => (
        <div key={cat.id} style={{
          display: 'flex', alignItems: 'center', gap: '0.625rem',
          padding: '0.625rem 0.875rem',
          background: cat.is_active ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.01)',
          border: `1px solid ${cat.is_active ? 'var(--border-color)' : 'var(--border-subtle)'}`,
          borderRadius: 'var(--radius-md)', opacity: cat.is_active ? 1 : 0.55,
        }}>
          {editId === cat.id ? (
            <>
              <input style={{ ...inputS, width: '36px', height: '32px', padding: '2px', cursor: 'pointer', border: 'none', background: 'none' }}
                type="color" value={editColor} onChange={e => setEditColor(e.target.value)} />
              <input style={{ ...inputS, flex: 1 }} value={editName} onChange={e => setEditName(e.target.value)} placeholder="Nombre" />
              <input style={{ ...inputS, width: '90px' }} type="number" value={editLimit} onChange={e => setEditLimit(e.target.value)} placeholder="Límite $" />
              <AppIconButton icon={<Check size={13} />} label="Guardar" size="xs" variant="success" onClick={() => update(cat.id)} />
              <AppIconButton icon={<X size={13} />} label="Cancelar" size="xs" onClick={() => setEditId(null)} />
            </>
          ) : (
            <>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: cat.color, flexShrink: 0 }} />
              <span style={{ flex: 1, fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>{cat.name}</span>
              {cat.monthly_limit && (
                <span style={{ fontSize: '0.72rem', color: 'var(--text-subtle)' }}>
                  límite: {fmtARS(cat.monthly_limit)}/mes
                </span>
              )}
              <AppIconButton icon={<EditIcon size={13} />} label="Editar" size="xs" onClick={() => { setEditId(cat.id); setEditName(cat.name); setEditColor(cat.color); setEditLimit(cat.monthly_limit ? String(cat.monthly_limit) : '') }} />
              <AppIconButton icon={cat.is_active ? <X size={13} /> : <Check size={13} />} label={cat.is_active ? 'Desactivar' : 'Activar'} size="xs" onClick={() => toggleActive(cat)} />
              <AppIconButton icon={<DeleteIcon size={13} />} label="Eliminar" size="xs" variant="danger" onClick={() => remove(cat.id)} />
            </>
          )}
        </div>
      ))}

      {adding ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 'var(--radius-md)', flexWrap: 'wrap' as const }}>
          <input type="color" value={newColor} onChange={e => setNewColor(e.target.value)}
            style={{ width: 32, height: 32, padding: '2px', border: 'none', background: 'none', cursor: 'pointer' }} />
          <input style={{ ...inputS, flex: '1 1 120px' }} value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nombre de categoría" autoFocus onKeyDown={e => e.key === 'Enter' && create()} />
          <input style={{ ...inputS, flex: '0 0 100px' }} type="number" value={newLimit} onChange={e => setNewLimit(e.target.value)} placeholder="Límite $/mes" />
          <AppButton variant="indigo" size="sm" onClick={create}><Check size={12} /> Crear</AppButton>
          <AppButton variant="ghost" size="sm" onClick={() => setAdding(false)}><X size={12} /></AppButton>
        </div>
      ) : (
        <button onClick={() => setAdding(true)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', background: 'transparent', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-subtle)', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', width: '100%', justifyContent: 'center' }}>
          <Plus size={13} /> Agregar categoría
        </button>
      )}
    </div>
  )
}

// ─── Página principal ─────────────────────────────────────────────────────────

const ALERT_THRESHOLD = 50_000

export function Expenses() {
  const { businessId, user } = useAuth()

  const [expenses, setExpenses]           = useState<Expense[]>([])
  const [categories, setCategories]       = useState<ExpenseCategory[]>([])
  const [loading, setLoading]             = useState(true)
  const [showModal, setShowModal]         = useState(false)
  const [showCategories, setShowCategories] = useState(false)

  // ── Filtros ──
  const [searchTerm, setSearchTerm]   = useState('')
  const [filterCat, setFilterCat]     = useState('all')
  const [filterMethod, setFilterMethod] = useState('all')
  const [dateFrom, setDateFrom]       = useState(firstDayOfMonth())
  const [dateTo, setDateTo]           = useState(today())

  const loadCategories = useCallback(async () => {
    if (!businessId) return
    await supabase.rpc('seed_expense_categories', { p_business_id: businessId }).then(() => {})
    const { data } = await supabase.from('expense_categories').select('*').eq('business_id', businessId).order('sort_order')
    setCategories((data || []) as ExpenseCategory[])
  }, [businessId])

  const loadExpenses = useCallback(async () => {
    if (!businessId) return
    setLoading(true)
    try {
      const { data } = await supabase
        .from('expenses')
        .select('*')
        .eq('business_id', businessId)
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .order('date', { ascending: false })
      setExpenses((data || []) as Expense[])
    } finally { setLoading(false) }
  }, [businessId, dateFrom, dateTo])

  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { loadExpenses() }, [loadExpenses])

  // ── Filtrado local ──
  const filtered = useMemo(() => {
    let list = [...expenses]
    if (filterCat !== 'all')    list = list.filter(e => e.category === filterCat)
    if (filterMethod !== 'all') list = list.filter(e => e.payment_method === filterMethod)
    if (searchTerm.trim()) {
      list = smartSearch(list, searchTerm, [
        { getValue: e => e.description, weight: 3 },
        { getValue: e => e.category, weight: 2 },
        { getValue: e => e.notes },
      ]) as Expense[]
    }
    return list
  }, [expenses, filterCat, filterMethod, searchTerm])

  // ── Stats ──
  const todayStr = today()
  const totalHoy = expenses.filter(e => e.date === todayStr).reduce((s, e) => s + (e.amount || 0), 0)
  const totalMes  = expenses.reduce((s, e) => s + (e.amount || 0), 0)
  const alerts    = expenses.filter(e => (e.amount || 0) >= ALERT_THRESHOLD)

  // Alertas de límite mensual por categoría
  const catAlerts = useMemo(() => {
    const msgs: string[] = []
    categories.forEach(cat => {
      if (!cat.monthly_limit) return
      const spent = expenses.filter(e => e.category === cat.name).reduce((s, e) => s + (e.amount || 0), 0)
      if (spent > cat.monthly_limit) {
        msgs.push(`${cat.name}: ${fmtARS(spent)} de límite ${fmtARS(cat.monthly_limit)}`)
      }
    })
    return msgs
  }, [expenses, categories])

  const allAlerts = [...alerts.map(e => `Gasto alto: ${e.description} — ${fmtARS(e.amount)}`), ...catAlerts]

  return (
    <div className="page-shell">
      {/* Header */}
      <AppPageHeader
        icon={<ExpenseReceiptIcon size={20} />}
        iconColor="var(--error-subtle)"
        title="Gastos"
        description="Control de egresos y gastos del negocio"
        actions={
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <AppButton variant="ghost" size="sm" leftIcon={<RefreshIcon size={14} />} onClick={() => { loadExpenses(); loadCategories() }}>
              Actualizar
            </AppButton>
            <AppButton variant="secondary" size="sm" leftIcon={<ChevronDown size={14} />}
              onClick={() => setShowCategories(v => !v)}>
              Categorías
            </AppButton>
            <AppButton variant="red" size="sm" leftIcon={<AddIcon size={14} />} onClick={() => setShowModal(true)}>
              Nuevo Gasto
            </AppButton>
          </div>
        }
      />

      {/* Alertas */}
      {allAlerts.length > 0 && (
        <div style={{ marginBottom: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          {allAlerts.slice(0, 3).map((msg, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 1rem', borderRadius: 'var(--radius-md)', background: 'var(--warning-subtle)', border: '1px solid var(--warning-border)', fontSize: '0.8rem', color: 'var(--warning)' }}>
              <AlertTriangle size={14} style={{ flexShrink: 0 }} /> {msg}
            </div>
          ))}
        </div>
      )}

      {/* Stats cards */}
      <div className="stats-grid" style={{ marginBottom: '1.25rem' }}>
        {[
          { label: 'Gastado hoy', value: fmtARS(totalHoy), color: 'var(--error)', icon: <ExpenseReceiptIcon size={18} /> },
          { label: 'Gastado este mes', value: fmtARS(totalMes), color: 'var(--warning)', icon: <Calendar size={18} /> },
          { label: 'Alertas activas', value: allAlerts.length, color: allAlerts.length > 0 ? 'var(--warning)' : 'var(--success)', icon: <AlertIcon size={18} /> },
        ].map((s, i) => (
          <div key={i} className="stat-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="stat-card-label">{s.label}</div>
              <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-md)', background: `${s.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: s.color }}>{s.icon}</div>
            </div>
            <div className="stat-card-value" style={{ color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Categorías manager */}
      {showCategories && (
        <div className="card" style={{ padding: '1.25rem', marginBottom: '1.25rem' }}>
          <AppSectionHeader title="Categorías de gastos" description="Agregá, editá o eliminá categorías" actions={
            <AppButton variant="ghost" size="sm" onClick={() => setShowCategories(false)}><X size={14} /></AppButton>
          } />
          <CategoriesManager categories={categories} businessId={businessId || ''} onChanged={loadCategories} />
        </div>
      )}

      {/* Filtros */}
      <AppToolbar style={{ marginBottom: '1rem' }}>
        <AppSearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Buscar por descripción, categoría..." />

        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' as const, alignItems: 'center' }}>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="form-control" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.375rem 0.625rem' }} />
          <span style={{ color: 'var(--text-subtle)', fontSize: '0.8rem' }}>hasta</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="form-control" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.375rem 0.625rem' }} />
        </div>

        <select className="form-select" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.375rem 0.625rem' }}
          value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="all">Todas las categorías</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>

        <select className="form-select" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.375rem 0.625rem' }}
          value={filterMethod} onChange={e => setFilterMethod(e.target.value)}>
          <option value="all">Todos los métodos</option>
          <option value="efectivo">Efectivo</option>
          <option value="transferencia">Transferencia</option>
          <option value="tarjeta">Tarjeta</option>
        </select>
      </AppToolbar>

      {/* Tabla */}
      {loading ? (
        <AppLoadingState rows={5} />
      ) : filtered.length === 0 ? (
        <div className="card">
          <AppEmptyState
            icon={<Receipt size={28} />}
            title="Sin gastos en este período"
            description="Registrá tu primer gasto para comenzar a controlar los egresos."
            action={{ label: 'Nuevo Gasto', icon: <AddIcon size={14} />, onClick: () => setShowModal(true), variant: 'red' }}
          />
        </div>
      ) : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table table-clickable">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Descripción</th>
                <th>Categoría</th>
                <th style={{ textAlign: 'right' }}>Monto</th>
                <th>Método</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(e => {
                const isHigh  = e.amount >= ALERT_THRESHOLD
                const pmInfo  = PAYMENT_METHOD_LABELS[e.payment_method || 'efectivo'] || PAYMENT_METHOD_LABELS.efectivo
                const catInfo = categories.find(c => c.name === e.category)
                return (
                  <tr key={e.id}>
                    <td style={{ color: 'var(--text-subtle)', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                      {fmtDate(e.date)}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>
                        {e.description}
                        {e.is_recurring && (
                          <span style={{ marginLeft: '0.375rem', fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '9999px', background: 'var(--info-subtle)', color: 'var(--info)', border: '1px solid var(--info-border)' }}>
                            {e.frequency}
                          </span>
                        )}
                      </div>
                      {e.notes && <div style={{ fontSize: '0.72rem', color: 'var(--text-subtle)' }}>{e.notes}</div>}
                    </td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', fontWeight: 600 }}>
                        {catInfo && <span style={{ width: 8, height: 8, borderRadius: '50%', background: catInfo.color, display: 'inline-block' }} />}
                        {e.category}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 800, color: isHigh ? 'var(--error)' : 'var(--text-primary)', fontSize: '0.9375rem' }}>
                      {fmtARS(e.amount)}
                      {isHigh && <AlertTriangle size={12} style={{ marginLeft: '0.3rem', color: 'var(--error)' }} />}
                    </td>
                    <td>
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: pmInfo.color }}>
                        {pmInfo.label}
                      </span>
                    </td>
                    <td>
                      {e.payment_method === 'efectivo'
                        ? <span className="badge badge-success badge-no-dot">Impacta caja</span>
                        : <span className="badge badge-info badge-no-dot">Finanzas</span>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <AppIconButton icon={<DeleteIcon size={13} />} label="Eliminar gasto" size="xs" variant="danger"
                          onClick={async () => {
                            if (!confirm('¿Eliminar este gasto?')) return
                            await supabase.from('expenses').delete().eq('id', e.id)
                            loadExpenses()
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: 'rgba(255,255,255,0.03)', borderTop: '2px solid var(--border-color)' }}>
                <td colSpan={3} style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                  {filtered.length} gastos
                </td>
                <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontWeight: 800, fontSize: '1rem', color: 'var(--error)' }}>
                  {fmtARS(filtered.reduce((s, e) => s + (e.amount || 0), 0))}
                </td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Modal */}
      {showModal && businessId && (
        <NewExpenseModal
          categories={categories}
          businessId={businessId}
          userId={user?.id || ''}
          onSaved={() => { setShowModal(false); loadExpenses() }}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  )
}
