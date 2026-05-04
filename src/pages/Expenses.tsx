import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Plus, Receipt, AlertTriangle, Calendar,
  Check, X, ChevronDown, ShoppingBag,
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
import { suppliersService, type CreatePurchaseInput } from '../services/suppliersService'

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
  tipo?: 'general' | 'factura'
  proveedor_id?: string | null
  invoice_number?: string | null
  supplier_purchase_id?: string | null
  supplier?: { name: string } | null
}

interface LineItem {
  _id: string
  inventory_id: string | null
  product_name: string
  cantidad: string
  costo_unitario: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtARS  = (n: number) => '$' + Math.round(n).toLocaleString('es-AR')
const fmtDate = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' })
const today = () => new Date().toISOString().split('T')[0]
const firstDayOfMonth = () => { const d = new Date(); d.setDate(1); return d.toISOString().split('T')[0] }
const mkItem = (): LineItem => ({ _id: crypto.randomUUID(), inventory_id: null, product_name: '', cantidad: '1', costo_unitario: '' })

const PAYMENT_METHOD_LABELS: Record<string, { label: string; color: string }> = {
  efectivo:      { label: 'Efectivo',      color: '#22c55e' },
  transferencia: { label: 'Transferencia', color: '#60a5fa' },
  tarjeta:       { label: 'Tarjeta',       color: '#f59e0b' },
}

// ─── Module-level styles (prevents sub-component remount bugs) ────────────────

const _inputBase: React.CSSProperties = {
  width: '100%', background: 'var(--input-bg)', border: '1px solid var(--input-border)',
  color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' as const,
}
const inputS: React.CSSProperties  = { ..._inputBase, padding: '0.625rem 0.875rem', fontSize: '0.875rem', borderRadius: 'var(--radius-md)' }
const inputSm: React.CSSProperties = { ..._inputBase, padding: '0.5rem 0.625rem', fontSize: '0.85rem', borderRadius: 'var(--radius-sm)' }
const labelS: React.CSSProperties  = {
  display: 'block', fontSize: '0.72rem', fontWeight: 600,
  color: 'var(--text-subtle)', marginBottom: '0.35rem',
  textTransform: 'uppercase' as const, letterSpacing: '0.05em',
}

// ─── QuickSupplierForm ────────────────────────────────────────────────────────

interface QuickSupplierFormProps {
  businessId: string
  userId: string
  onCreated: (s: { id: string; name: string }) => void
  onCancel: () => void
}

function QuickSupplierForm({ businessId, userId, onCreated, onCancel }: QuickSupplierFormProps) {
  const [name, setName]   = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr]     = useState('')

  const handleCreate = async () => {
    if (!name.trim()) { setErr('El nombre es obligatorio'); return }
    setSaving(true); setErr('')
    try {
      const { data, error } = await supabase
        .from('suppliers')
        .insert({ business_id: businessId, name: name.trim(), phone: phone || null, email: email || null, active: true, created_by: userId })
        .select().single()
      if (error) throw error
      onCreated({ id: data.id, name: data.name })
    } catch (e: any) { setErr(e.message || 'Error al crear') } finally { setSaving(false) }
  }

  return (
    <div style={{ padding: '0.875rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
      <p style={{ ...labelS, marginBottom: 0, color: 'var(--accent-primary)' }}>Nuevo proveedor</p>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '0.75rem' }}>
        <div>
          <label style={labelS}>Nombre *</label>
          <input style={inputS} value={name} onChange={e => setName(e.target.value)} placeholder="Nombre del proveedor" autoFocus onKeyDown={e => e.key === 'Enter' && handleCreate()} />
        </div>
        <div>
          <label style={labelS}>Teléfono</label>
          <input style={inputS} value={phone} onChange={e => setPhone(e.target.value)} placeholder="351-xxx-xxxx" />
        </div>
        <div>
          <label style={labelS}>Email</label>
          <input style={inputS} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="opcional" />
        </div>
      </div>
      {err && <p style={{ margin: 0, color: 'var(--error)', fontSize: '0.8rem' }}>{err}</p>}
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <AppButton variant="ghost" size="sm" onClick={onCancel}>Cancelar</AppButton>
        <AppButton variant="indigo" size="sm" loading={saving} onClick={handleCreate} leftIcon={<Check size={12} />}>
          Crear proveedor
        </AppButton>
      </div>
    </div>
  )
}

// ─── ItemRow ──────────────────────────────────────────────────────────────────

interface ItemRowProps {
  item: LineItem
  businessId: string
  onUpdate: (id: string, patch: Partial<LineItem>) => void
  onRemove: (id: string) => void
  isOnly: boolean
}

function ItemRow({ item, businessId, onUpdate, onRemove, isOnly }: ItemRowProps) {
  const [q, setQ]             = useState(item.product_name)
  const [results, setResults] = useState<any[]>([])
  const [open, setOpen]       = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCost, setNewCost] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [newCat, setNewCat]   = useState('General')
  const [savingProd, setSavingProd] = useState(false)
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    if (item.inventory_id || q.length < 2) { setResults([]); setOpen(false); return }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('inventory')
        .select('id, name, cost_price')
        .eq('business_id', businessId)
        .ilike('name', `%${q}%`)
        .not('has_variants', 'is', true)
        .limit(8)
      const list = data || []
      setResults(list)
      setOpen(list.length > 0)
    }, 280)
    return () => clearTimeout(t)
  }, [q, businessId, item.inventory_id])

  const selectProduct = (p: any) => {
    setQ(p.name); setOpen(false); setResults([])
    onUpdate(item._id, { inventory_id: p.id, product_name: p.name, costo_unitario: p.cost_price ? String(Math.round(p.cost_price)) : item.costo_unitario })
  }

  const clearProduct = () => {
    setQ(''); setOpen(false)
    onUpdate(item._id, { inventory_id: null, product_name: '' })
  }

  const handleCreateProduct = async () => {
    if (!newName.trim()) return
    setSavingProd(true)
    try {
      const { data: np, error } = await supabase.from('inventory')
        .insert({ business_id: businessId, name: newName.trim(), cost_price: parseFloat(newCost) || 0, sale_price: parseFloat(newPrice) || parseFloat(newCost) || 0, category: newCat || 'General', stock_quantity: 0, updated_at: new Date().toISOString() })
        .select().single()
      if (error) throw error
      setFeedback(`"${np.name}" creado`)
      setTimeout(() => setFeedback(''), 4000)
      setCreating(false); setNewName(''); setNewCost(''); setNewPrice(''); setNewCat('General')
      setQ(np.name)
      onUpdate(item._id, { inventory_id: np.id, product_name: np.name, costo_unitario: newCost || '' })
    } catch (e: any) { console.error(e) } finally { setSavingProd(false) }
  }

  const cell: React.CSSProperties = { padding: '0.4375rem 0.375rem', verticalAlign: 'top' }

  return (
    <>
      <tr>
        {/* Producto */}
        <td style={{ ...cell, minWidth: 220, position: 'relative' }}>
          {item.inventory_id ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.4rem 0.625rem', background: 'rgba(99,102,241,0.07)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(99,102,241,0.18)' }}>
              <span style={{ flex: 1, fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>{item.product_name}</span>
              <button onClick={clearProduct} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-subtle)', padding: 0, display: 'flex', alignItems: 'center' }}>
                <X size={12} />
              </button>
            </div>
          ) : (
            <div style={{ position: 'relative' }}>
              <input style={inputSm} value={q}
                onChange={e => { setQ(e.target.value); onUpdate(item._id, { product_name: e.target.value, inventory_id: null }) }}
                onFocus={() => results.length > 0 && setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 180)}
                placeholder="Buscar producto..." />
              {open && results.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 999, background: 'var(--bg-modal)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', width: '100%', minWidth: 240, boxShadow: 'var(--shadow-lg)', maxHeight: 180, overflowY: 'auto' }}>
                  {results.map(r => (
                    <div key={r.id} onMouseDown={() => selectProduct(r)}
                      style={{ padding: '0.5rem 0.75rem', cursor: 'pointer', fontSize: '0.82rem', borderBottom: '1px solid var(--border-subtle)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <span style={{ fontWeight: 600 }}>{r.name}</span>
                      {r.cost_price > 0 && <span style={{ marginLeft: '0.5rem', fontSize: '0.72rem', color: 'var(--text-subtle)' }}>Costo: {fmtARS(r.cost_price)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {!item.inventory_id && !creating && (
            <button onClick={() => { setCreating(true); setNewName(q) }}
              style={{ marginTop: '0.25rem', fontSize: '0.72rem', color: 'var(--accent-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: '0.1rem 0', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
              <Plus size={10} /> Crear producto
            </button>
          )}
          {feedback && (
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
              <Check size={10} /> {feedback}
            </p>
          )}
        </td>
        {/* Cantidad */}
        <td style={{ ...cell, width: 76 }}>
          <input style={{ ...inputSm, textAlign: 'right' }} type="number" min="0.01" step="1"
            value={item.cantidad} onChange={e => onUpdate(item._id, { cantidad: e.target.value })} />
        </td>
        {/* Costo unit. */}
        <td style={{ ...cell, width: 120 }}>
          <input style={{ ...inputSm, textAlign: 'right' }} type="number" min="0" step="1"
            value={item.costo_unitario} onChange={e => onUpdate(item._id, { costo_unitario: e.target.value })} placeholder="$ 0" />
        </td>
        {/* Subtotal */}
        <td style={{ ...cell, width: 120, textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.9rem', paddingRight: '0.5rem', verticalAlign: 'middle' }}>
          {fmtARS((parseFloat(item.cantidad) || 0) * (parseFloat(item.costo_unitario) || 0))}
        </td>
        {/* Eliminar */}
        <td style={{ ...cell, width: 36, verticalAlign: 'middle' }}>
          <button onClick={() => onRemove(item._id)} disabled={isOnly}
            style={{ background: 'none', border: 'none', cursor: isOnly ? 'not-allowed' : 'pointer', color: 'var(--error)', padding: '0.25rem', display: 'flex', alignItems: 'center', opacity: isOnly ? 0.3 : 1 }}>
            <X size={14} />
          </button>
        </td>
      </tr>

      {/* Inline create product form */}
      {creating && (
        <tr>
          <td colSpan={5} style={{ padding: '0.375rem 0.375rem 0.75rem' }}>
            <div style={{ padding: '0.75rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              <p style={{ ...labelS, marginBottom: 0, color: 'var(--accent-primary)' }}>Crear producto nuevo</p>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: '0.5rem' }}>
                <input style={inputSm} value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nombre *" autoFocus onKeyDown={e => e.key === 'Enter' && handleCreateProduct()} />
                <input style={inputSm} type="number" value={newCost} onChange={e => setNewCost(e.target.value)} placeholder="Costo $" />
                <input style={inputSm} type="number" value={newPrice} onChange={e => setNewPrice(e.target.value)} placeholder="Precio venta" />
                <input style={inputSm} value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="Categoría" />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <AppButton variant="ghost" size="xs" onClick={() => setCreating(false)}>Cancelar</AppButton>
                <AppButton variant="indigo" size="xs" loading={savingProd} onClick={handleCreateProduct} leftIcon={<Check size={11} />}>
                  Guardar producto
                </AppButton>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ─── NewExpenseModal ──────────────────────────────────────────────────────────

interface NewExpenseModalProps {
  categories: ExpenseCategory[]
  businessId: string
  userId: string
  onSaved: () => void
  onClose: () => void
}

function NewExpenseModal({ categories, businessId, userId, onSaved, onClose }: NewExpenseModalProps) {
  const [tipo, setTipo] = useState<'general' | 'factura'>('general')

  // ── General state ──
  const [monto, setMonto]             = useState('')
  const [categoria, setCategoria]     = useState(categories[0]?.name || '')
  const [metodo, setMetodo]           = useState('efectivo')
  const [descripcion, setDescripcion] = useState('')
  const [fecha, setFecha]             = useState(today())
  const [recurrente, setRecurrente]   = useState(false)
  const [frecuencia, setFrecuencia]   = useState('mensual')
  const [notas, setNotas]             = useState('')

  // ── Factura state ──
  const [suppliers, setSuppliers]         = useState<{ id: string; name: string }[]>([])
  const [supplierId, setSupplierId]       = useState('')
  const [showNewSupplier, setShowNewSupplier] = useState(false)
  const [items, setItems]                 = useState<LineItem[]>([mkItem()])
  const [numFactura, setNumFactura]       = useState('')
  const [facMetodo, setFacMetodo]         = useState('efectivo')
  const [facDescripcion, setFacDescripcion] = useState('')
  const [facNotas, setFacNotas]           = useState('')
  const [facFecha, setFacFecha]           = useState(today())

  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const totalFactura = items.reduce((s, it) => s + (parseFloat(it.cantidad) || 0) * (parseFloat(it.costo_unitario) || 0), 0)

  useEffect(() => {
    suppliersService.getActiveSuppliers(businessId).then(list =>
      setSuppliers(list.map(s => ({ id: s.id, name: s.name })))
    )
  }, [businessId])

  const updateItem = useCallback((id: string, patch: Partial<LineItem>) => {
    setItems(prev => prev.map(it => it._id === id ? { ...it, ...patch } : it))
  }, [])
  const removeItem = useCallback((id: string) => {
    setItems(prev => prev.length > 1 ? prev.filter(it => it._id !== id) : prev)
  }, [])

  // ── Save: General ──
  const handleSaveGeneral = async () => {
    const montoNum = parseFloat(monto.replace(',', '.'))
    if (!montoNum || montoNum <= 0) { setError('El monto es obligatorio'); return }
    if (!descripcion.trim()) { setError('La descripción es obligatoria'); return }
    setSaving(true); setError('')
    try {
      const catKey = categoria.toLowerCase().split(' ')[0]
      const financeTypeMap: Record<string, string> = { inventario: 'variable_cost', sueldos: 'salary', impuestos: 'taxes' }
      const financeType = financeTypeMap[catKey] || 'fixed_cost_local'
      const { data: bfe, error: bfeErr } = await supabase.from('business_finance_entries').insert({
        business_id: businessId, date: fecha, type: financeType, category: catKey,
        description: descripcion, amount: montoNum, currency: 'ARS', amount_ars: montoNum,
        exchange_rate: 1, payment_method: metodo, source: 'expense', created_by: userId,
      }).select('id').single()
      if (bfeErr) throw bfeErr
      await supabase.from('expenses').insert({
        description: descripcion, category: categoria, amount: montoNum, amount_ars: montoNum,
        date: fecha, business_id: businessId, payment_method: metodo, currency: 'ARS',
        exchange_rate: 1, is_recurring: recurrente, frequency: recurrente ? frecuencia : null,
        notes: notas || null, finance_entry_id: bfe?.id || null, created_by: userId, tipo: 'general',
      })
      if (metodo === 'efectivo') {
        await supabase.from('financial_movements').insert({
          business_id: businessId, date: fecha, type: 'expense', currency: 'ARS',
          amount: montoNum, amount_ars: montoNum, exchange_rate: 1,
          description: descripcion, source: 'expense', reference_id: bfe?.id || null, created_by: userId,
        })
      }
      onSaved()
    } catch (e: any) { setError(e.message || 'Error al guardar') } finally { setSaving(false) }
  }

  // ── Save: Factura ──
  const handleSaveFactura = async () => {
    if (!supplierId) { setError(showNewSupplier ? 'Primero guardá el nuevo proveedor' : 'Seleccioná un proveedor'); return }
    const validItems = items.filter(it => it.product_name.trim() && (parseFloat(it.cantidad) || 0) > 0 && (parseFloat(it.costo_unitario) || 0) > 0)
    if (validItems.length === 0) { setError('Completá al menos un producto con nombre, cantidad y costo'); return }
    if (totalFactura <= 0) { setError('El total de la factura debe ser mayor a $0'); return }
    setSaving(true); setError('')
    try {
      const supplierName = suppliers.find(s => s.id === supplierId)?.name || 'Proveedor'
      const input: CreatePurchaseInput = {
        supplier_id: supplierId,
        purchase_date: facFecha,
        invoice_number: numFactura || undefined,
        total_amount: totalFactura,
        paid_amount: totalFactura,
        payment_method: facMetodo,
        notes: facNotas || undefined,
        items: validItems.map(it => ({
          inventory_id: it.inventory_id || null,
          product_name: it.product_name,
          quantity: parseFloat(it.cantidad) || 1,
          unit_cost: parseFloat(it.costo_unitario) || 0,
        })),
      }
      const purchase = await suppliersService.createPurchase(input, businessId, userId, supplierName)
      const desc = facDescripcion.trim() || `Factura ${supplierName}${numFactura ? ' #' + numFactura : ''}`
      await supabase.from('expenses').insert({
        description: desc, category: 'Proveedores', amount: totalFactura, amount_ars: totalFactura,
        date: facFecha, business_id: businessId, payment_method: facMetodo, currency: 'ARS',
        exchange_rate: 1, notes: facNotas || null, created_by: userId,
        tipo: 'factura', proveedor_id: supplierId,
        supplier_purchase_id: purchase.id, invoice_number: numFactura || null,
      })
      onSaved()
    } catch (e: any) { setError(e.message || 'Error al guardar') } finally { setSaving(false) }
  }

  const handleSave = () => tipo === 'general' ? handleSaveGeneral() : handleSaveFactura()
  const modalMaxW  = tipo === 'factura' ? 900 : 560

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-modal)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-2xl)', width: '100%', maxWidth: modalMaxW, display: 'flex', flexDirection: 'column', maxHeight: '92vh', boxShadow: 'var(--shadow-xl)', transition: 'max-width 0.2s' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-md)', background: tipo === 'factura' ? 'rgba(99,102,241,0.12)' : 'var(--error-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: tipo === 'factura' ? 'var(--accent-primary)' : 'var(--error)' }}>
              {tipo === 'factura' ? <ShoppingBag size={18} /> : <Receipt size={18} />}
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {tipo === 'factura' ? 'Factura de proveedor' : 'Nuevo Gasto'}
              </h2>
              <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text-subtle)' }}>
                {tipo === 'factura' ? 'Carga de factura con impacto en stock y finanzas' : 'Registrar egreso del negocio'}
              </p>
            </div>
          </div>
          <AppButton variant="ghost" size="sm" onClick={onClose}><X size={16} /></AppButton>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

          {/* Tipo selector */}
          <div style={{ display: 'flex', gap: '0.375rem', padding: '0.25rem', background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', width: 'fit-content' }}>
            {(['general', 'factura'] as const).map(t => (
              <button key={t} onClick={() => { setTipo(t); setError('') }}
                style={{ padding: '0.5rem 1.25rem', borderRadius: 'var(--radius-md)', background: tipo === t ? (t === 'factura' ? 'var(--accent-primary)' : 'var(--error)') : 'transparent', color: tipo === t ? 'white' : 'var(--text-secondary)', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.375rem', transition: 'all 0.15s' }}>
                {t === 'general' ? <><Receipt size={14} /> General</> : <><ShoppingBag size={14} /> Factura de proveedor</>}
              </button>
            ))}
          </div>

          {/* ══ GENERAL ══════════════════════════════════════════════════════════ */}
          {tipo === 'general' && (
            <>
              <div>
                <label style={labelS}>Monto *</label>
                <input style={{ ...inputS, fontSize: '1.5rem', fontWeight: 800, textAlign: 'right', color: 'var(--error)' }}
                  type="number" min="0" step="1" value={monto} onChange={e => setMonto(e.target.value)} placeholder="$ 0" autoFocus />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                  <label style={labelS}>Categoría *</label>
                  <select style={inputS} value={categoria} onChange={e => setCategoria(e.target.value)}>
                    {categories.filter(c => c.is_active).map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelS}>Método de pago</label>
                  <select style={inputS} value={metodo} onChange={e => setMetodo(e.target.value)}>
                    <option value="efectivo">Efectivo</option>
                    <option value="transferencia">Transferencia</option>
                    <option value="tarjeta">Tarjeta</option>
                  </select>
                </div>
              </div>
              <div>
                <label style={labelS}>Descripción *</label>
                <input style={inputS} type="text" value={descripcion} onChange={e => setDescripcion(e.target.value)} placeholder="¿En qué se gastó?" />
              </div>
              <div>
                <label style={labelS}>Fecha</label>
                <input style={inputS} type="date" value={fecha} onChange={e => setFecha(e.target.value)} />
              </div>
              <div>
                <label style={labelS}>Notas (opcional)</label>
                <textarea style={{ ...inputS, minHeight: 60, resize: 'vertical' as const }} value={notas} onChange={e => setNotas(e.target.value)} placeholder="Información adicional..." />
              </div>
              <div style={{ padding: '0.875rem 1rem', background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={recurrente} onChange={e => setRecurrente(e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--accent-primary)', cursor: 'pointer' }} />
                  <span style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Gasto recurrente</span>
                </label>
                {recurrente && (
                  <div>
                    <label style={labelS}>Frecuencia</label>
                    <select style={inputS} value={frecuencia} onChange={e => setFrecuencia(e.target.value)}>
                      <option value="mensual">Mensual</option>
                      <option value="semanal">Semanal</option>
                    </select>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ══ FACTURA ══════════════════════════════════════════════════════════ */}
          {tipo === 'factura' && (
            <>
              {/* Proveedor */}
              <div style={{ padding: '1rem', background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)' }}>
                <p style={{ ...labelS, marginBottom: '0.625rem' }}>Proveedor</p>
                <select style={inputS}
                  value={showNewSupplier ? '__new__' : supplierId}
                  onChange={e => {
                    if (e.target.value === '__new__') { setShowNewSupplier(true); setSupplierId('') }
                    else { setShowNewSupplier(false); setSupplierId(e.target.value) }
                  }}>
                  <option value="">— Seleccioná un proveedor —</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  <option value="__new__">+ Nuevo proveedor...</option>
                </select>
                {showNewSupplier && (
                  <QuickSupplierForm
                    businessId={businessId}
                    userId={userId}
                    onCreated={s => {
                      setSuppliers(prev => [...prev, s].sort((a, b) => a.name.localeCompare(b.name)))
                      setSupplierId(s.id)
                      setShowNewSupplier(false)
                    }}
                    onCancel={() => setShowNewSupplier(false)}
                  />
                )}
              </div>

              {/* Datos de la factura */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
                <div>
                  <label style={labelS}>N° Factura (opcional)</label>
                  <input style={inputS} value={numFactura} onChange={e => setNumFactura(e.target.value)} placeholder="Ej: A-0001-00012345" />
                </div>
                <div>
                  <label style={labelS}>Fecha</label>
                  <input style={inputS} type="date" value={facFecha} onChange={e => setFacFecha(e.target.value)} />
                </div>
                <div>
                  <label style={labelS}>Método de pago</label>
                  <select style={inputS} value={facMetodo} onChange={e => setFacMetodo(e.target.value)}>
                    <option value="efectivo">Efectivo</option>
                    <option value="transferencia">Transferencia</option>
                    <option value="tarjeta">Tarjeta</option>
                  </select>
                </div>
              </div>

              <div>
                <label style={labelS}>Descripción (opcional — se auto-genera)</label>
                <input style={inputS} value={facDescripcion} onChange={e => setFacDescripcion(e.target.value)}
                  placeholder={`Factura ${suppliers.find(s => s.id === supplierId)?.name || 'proveedor'}${numFactura ? ' #' + numFactura : ''}`} />
              </div>

              {/* Tabla de productos */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <p style={{ ...labelS, marginBottom: 0 }}>Productos / artículos</p>
                  <AppButton variant="ghost" size="xs" leftIcon={<Plus size={11} />} onClick={() => setItems(prev => [...prev, mkItem()])}>
                    Agregar fila
                  </AppButton>
                </div>
                <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid var(--border-subtle)' }}>
                        <th style={{ padding: '0.5rem 0.5rem', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left' }}>Producto</th>
                        <th style={{ padding: '0.5rem 0.375rem', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'right', width: 76 }}>Cant.</th>
                        <th style={{ padding: '0.5rem 0.375rem', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'right', width: 120 }}>Costo unit.</th>
                        <th style={{ padding: '0.5rem 0.375rem', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'right', width: 120 }}>Subtotal</th>
                        <th style={{ width: 36 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(it => (
                        <ItemRow key={it._id} item={it} businessId={businessId} onUpdate={updateItem} onRemove={removeItem} isOnly={items.length === 1} />
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: '2px solid var(--border-color)', background: 'rgba(255,255,255,0.03)' }}>
                        <td colSpan={3} style={{ padding: '0.75rem 0.5rem', fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          Total factura ({items.filter(it => it.product_name).length} producto{items.filter(it => it.product_name).length !== 1 ? 's' : ''})
                        </td>
                        <td style={{ padding: '0.75rem 0.5rem', textAlign: 'right', fontWeight: 800, fontSize: '1.1rem', color: totalFactura > 0 ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                          {fmtARS(totalFactura)}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              <div>
                <label style={labelS}>Notas internas (opcional)</label>
                <textarea style={{ ...inputS, minHeight: 56, resize: 'vertical' as const }} value={facNotas} onChange={e => setFacNotas(e.target.value)} placeholder="Condiciones, observaciones..." />
              </div>
            </>
          )}

          {error && <p style={{ margin: 0, color: 'var(--error)', fontSize: '0.8rem', fontWeight: 600 }}>{error}</p>}
        </div>

        {/* Footer */}
        <div style={{ flexShrink: 0, padding: '1rem 1.5rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', background: 'var(--bg-modal)', borderRadius: '0 0 var(--radius-2xl) var(--radius-2xl)' }}>
          {tipo === 'factura' && totalFactura > 0 && (
            <span style={{ fontSize: '0.8rem', color: 'var(--text-subtle)' }}>
              Se actualizará el stock y se registrará en Proveedores
            </span>
          )}
          {tipo === 'general' && <span />}
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <AppButton variant="secondary" onClick={onClose}>Cancelar</AppButton>
            {tipo === 'general' ? (
              <AppButton variant="red" onClick={handleSave} loading={saving} leftIcon={<Receipt size={14} />}>
                Registrar gasto
              </AppButton>
            ) : (
              <AppButton variant="indigo" onClick={handleSave} loading={saving} leftIcon={<ShoppingBag size={14} />}>
                Registrar factura {totalFactura > 0 && `— ${fmtARS(totalFactura)}`}
              </AppButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── CategoriesManager ────────────────────────────────────────────────────────

function CategoriesManager({ categories, onChanged, businessId }: {
  categories: ExpenseCategory[]; onChanged: () => void; businessId: string
}) {
  const [adding, setAdding]     = useState(false)
  const [newName, setNewName]   = useState('')
  const [newColor, setNewColor] = useState('#6366f1')
  const [newLimit, setNewLimit] = useState('')
  const [editId, setEditId]     = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('#6366f1')
  const [editLimit, setEditLimit] = useState('')

  const create = async () => {
    if (!newName.trim()) return
    const maxOrder = Math.max(0, ...categories.map(c => c.sort_order)) + 1
    await supabase.from('expense_categories').insert({ business_id: businessId, name: newName.trim(), color: newColor, monthly_limit: newLimit ? parseFloat(newLimit) : null, sort_order: maxOrder })
    setNewName(''); setNewColor('#6366f1'); setNewLimit(''); setAdding(false); onChanged()
  }

  const update = async (id: string) => {
    await supabase.from('expense_categories').update({ name: editName, color: editColor, monthly_limit: editLimit ? parseFloat(editLimit) : null, updated_at: new Date().toISOString() }).eq('id', id)
    setEditId(null); onChanged()
  }

  const toggleActive = async (cat: ExpenseCategory) => {
    await supabase.from('expense_categories').update({ is_active: !cat.is_active }).eq('id', cat.id); onChanged()
  }

  const remove = async (id: string) => {
    if (!confirm('¿Eliminar esta categoría?')) return
    await supabase.from('expense_categories').delete().eq('id', id); onChanged()
  }

  const sm: React.CSSProperties = { padding: '0.4rem 0.625rem', background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: '0.8rem', outline: 'none', width: '100%', boxSizing: 'border-box' as const }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {categories.map(cat => (
        <div key={cat.id} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.625rem 0.875rem', background: cat.is_active ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.01)', border: `1px solid ${cat.is_active ? 'var(--border-color)' : 'var(--border-subtle)'}`, borderRadius: 'var(--radius-md)', opacity: cat.is_active ? 1 : 0.55 }}>
          {editId === cat.id ? (
            <>
              <input style={{ ...sm, width: '36px', height: '32px', padding: '2px', cursor: 'pointer', border: 'none', background: 'none' }} type="color" value={editColor} onChange={e => setEditColor(e.target.value)} />
              <input style={{ ...sm, flex: 1 }} value={editName} onChange={e => setEditName(e.target.value)} placeholder="Nombre" />
              <input style={{ ...sm, width: '90px' }} type="number" value={editLimit} onChange={e => setEditLimit(e.target.value)} placeholder="Límite $" />
              <AppIconButton icon={<Check size={13} />} label="Guardar" size="xs" variant="success" onClick={() => update(cat.id)} />
              <AppIconButton icon={<X size={13} />} label="Cancelar" size="xs" onClick={() => setEditId(null)} />
            </>
          ) : (
            <>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: cat.color, flexShrink: 0 }} />
              <span style={{ flex: 1, fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>{cat.name}</span>
              {cat.monthly_limit && <span style={{ fontSize: '0.72rem', color: 'var(--text-subtle)' }}>límite: {fmtARS(cat.monthly_limit)}/mes</span>}
              <AppIconButton icon={<EditIcon size={13} />} label="Editar" size="xs" onClick={() => { setEditId(cat.id); setEditName(cat.name); setEditColor(cat.color); setEditLimit(cat.monthly_limit ? String(cat.monthly_limit) : '') }} />
              <AppIconButton icon={cat.is_active ? <X size={13} /> : <Check size={13} />} label={cat.is_active ? 'Desactivar' : 'Activar'} size="xs" onClick={() => toggleActive(cat)} />
              <AppIconButton icon={<DeleteIcon size={13} />} label="Eliminar" size="xs" variant="danger" onClick={() => remove(cat.id)} />
            </>
          )}
        </div>
      ))}
      {adding ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 'var(--radius-md)', flexWrap: 'wrap' as const }}>
          <input type="color" value={newColor} onChange={e => setNewColor(e.target.value)} style={{ width: 32, height: 32, padding: '2px', border: 'none', background: 'none', cursor: 'pointer' }} />
          <input style={{ ...sm, flex: '1 1 120px' }} value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nombre de categoría" autoFocus onKeyDown={e => e.key === 'Enter' && create()} />
          <input style={{ ...sm, flex: '0 0 100px' }} type="number" value={newLimit} onChange={e => setNewLimit(e.target.value)} placeholder="Límite $/mes" />
          <AppButton variant="indigo" size="sm" onClick={create}><Check size={12} /> Crear</AppButton>
          <AppButton variant="ghost" size="sm" onClick={() => setAdding(false)}><X size={12} /></AppButton>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', background: 'transparent', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-subtle)', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', width: '100%', justifyContent: 'center' }}>
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

  const [expenses, setExpenses]     = useState<Expense[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [loading, setLoading]       = useState(true)
  const [showModal, setShowModal]   = useState(false)
  const [showCategories, setShowCategories] = useState(false)

  const [searchTerm, setSearchTerm]     = useState('')
  const [filterCat, setFilterCat]       = useState('all')
  const [filterMethod, setFilterMethod] = useState('all')
  const [filterTipo, setFilterTipo]     = useState('all')
  const [dateFrom, setDateFrom]         = useState(firstDayOfMonth())
  const [dateTo, setDateTo]             = useState(today())

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
        .select('*, supplier:suppliers!proveedor_id(name)')
        .eq('business_id', businessId)
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .order('date', { ascending: false })
      setExpenses((data || []) as Expense[])
    } finally { setLoading(false) }
  }, [businessId, dateFrom, dateTo])

  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { loadExpenses() }, [loadExpenses])

  const filtered = useMemo(() => {
    let list = [...expenses]
    if (filterCat !== 'all')    list = list.filter(e => e.category === filterCat)
    if (filterMethod !== 'all') list = list.filter(e => e.payment_method === filterMethod)
    if (filterTipo !== 'all')   list = list.filter(e => (e.tipo || 'general') === filterTipo)
    if (searchTerm.trim()) {
      list = smartSearch(list, searchTerm, [
        { getValue: e => e.description, weight: 3 },
        { getValue: e => e.category, weight: 2 },
        { getValue: (e: Expense) => e.supplier?.name || '', weight: 2 },
        { getValue: e => e.notes },
      ]) as Expense[]
    }
    return list
  }, [expenses, filterCat, filterMethod, filterTipo, searchTerm])

  const todayStr  = today()
  const totalHoy  = expenses.filter(e => e.date === todayStr).reduce((s, e) => s + (e.amount || 0), 0)
  const totalMes  = expenses.reduce((s, e) => s + (e.amount || 0), 0)
  const alerts    = expenses.filter(e => (e.amount || 0) >= ALERT_THRESHOLD)

  const catAlerts = useMemo(() => {
    const msgs: string[] = []
    categories.forEach(cat => {
      if (!cat.monthly_limit) return
      const spent = expenses.filter(e => e.category === cat.name).reduce((s, e) => s + (e.amount || 0), 0)
      if (spent > cat.monthly_limit) msgs.push(`${cat.name}: ${fmtARS(spent)} de límite ${fmtARS(cat.monthly_limit)}`)
    })
    return msgs
  }, [expenses, categories])

  const allAlerts = [...alerts.map(e => `Gasto alto: ${e.description} — ${fmtARS(e.amount)}`), ...catAlerts]

  return (
    <div className="page-shell">
      <AppPageHeader
        icon={<ExpenseReceiptIcon size={20} />}
        iconColor="var(--error-subtle)"
        title="Gastos"
        description="Control de egresos, facturas y compras del negocio"
        actions={
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <AppButton variant="ghost" size="sm" leftIcon={<RefreshIcon size={14} />} onClick={() => { loadExpenses(); loadCategories() }}>Actualizar</AppButton>
            <AppButton variant="secondary" size="sm" leftIcon={<ChevronDown size={14} />} onClick={() => setShowCategories(v => !v)}>Categorías</AppButton>
            <AppButton variant="red" size="sm" leftIcon={<AddIcon size={14} />} onClick={() => setShowModal(true)}>Nuevo Gasto</AppButton>
          </div>
        }
      />

      {allAlerts.length > 0 && (
        <div style={{ marginBottom: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          {allAlerts.slice(0, 3).map((msg, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 1rem', borderRadius: 'var(--radius-md)', background: 'var(--warning-subtle)', border: '1px solid var(--warning-border)', fontSize: '0.8rem', color: 'var(--warning)' }}>
              <AlertTriangle size={14} style={{ flexShrink: 0 }} /> {msg}
            </div>
          ))}
        </div>
      )}

      <div className="stats-grid" style={{ marginBottom: '1.25rem' }}>
        {[
          { label: 'Gastado hoy',       value: fmtARS(totalHoy),        color: 'var(--error)',   icon: <ExpenseReceiptIcon size={18} /> },
          { label: 'Gastado este mes',  value: fmtARS(totalMes),        color: 'var(--warning)', icon: <Calendar size={18} /> },
          { label: 'Alertas activas',   value: allAlerts.length,        color: allAlerts.length > 0 ? 'var(--warning)' : 'var(--success)', icon: <AlertIcon size={18} /> },
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

      {showCategories && (
        <div className="card" style={{ padding: '1.25rem', marginBottom: '1.25rem' }}>
          <AppSectionHeader title="Categorías de gastos" description="Agregá, editá o eliminá categorías"
            actions={<AppButton variant="ghost" size="sm" onClick={() => setShowCategories(false)}><X size={14} /></AppButton>} />
          <CategoriesManager categories={categories} businessId={businessId || ''} onChanged={loadCategories} />
        </div>
      )}

      <AppToolbar style={{ marginBottom: '1rem' }}>
        <AppSearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Buscar por descripción, proveedor, categoría..." />
        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' as const, alignItems: 'center' }}>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="form-control" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.375rem 0.625rem' }} />
          <span style={{ color: 'var(--text-subtle)', fontSize: '0.8rem' }}>hasta</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="form-control" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.375rem 0.625rem' }} />
        </div>
        <select className="form-select" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.375rem 0.625rem' }} value={filterTipo} onChange={e => setFilterTipo(e.target.value)}>
          <option value="all">Todos los tipos</option>
          <option value="general">General</option>
          <option value="factura">Facturas</option>
        </select>
        <select className="form-select" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.375rem 0.625rem' }} value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="all">Todas las categorías</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <select className="form-select" style={{ width: 'auto', fontSize: '0.8rem', padding: '0.375rem 0.625rem' }} value={filterMethod} onChange={e => setFilterMethod(e.target.value)}>
          <option value="all">Todos los métodos</option>
          <option value="efectivo">Efectivo</option>
          <option value="transferencia">Transferencia</option>
          <option value="tarjeta">Tarjeta</option>
        </select>
      </AppToolbar>

      {loading ? (
        <AppLoadingState rows={5} />
      ) : filtered.length === 0 ? (
        <div className="card">
          <AppEmptyState
            icon={<Receipt size={28} />}
            title="Sin gastos en este período"
            description="Registrá tu primer gasto o cargá una factura de proveedor."
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
                <th>Tipo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map(e => {
                const isHigh   = e.amount >= ALERT_THRESHOLD
                const pmInfo   = PAYMENT_METHOD_LABELS[e.payment_method || 'efectivo'] || PAYMENT_METHOD_LABELS.efectivo
                const catInfo  = categories.find(c => c.name === e.category)
                const isFactura = e.tipo === 'factura'
                return (
                  <tr key={e.id}>
                    <td style={{ color: 'var(--text-subtle)', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{fmtDate(e.date)}</td>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem' }}>
                        {e.description}
                        {e.is_recurring && (
                          <span style={{ marginLeft: '0.375rem', fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.35rem', borderRadius: '9999px', background: 'var(--info-subtle)', color: 'var(--info)', border: '1px solid var(--info-border)' }}>
                            {e.frequency}
                          </span>
                        )}
                      </div>
                      {isFactura && e.supplier?.name && (
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-subtle)', display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.125rem' }}>
                          <ShoppingBag size={10} />
                          {e.supplier.name}
                          {e.invoice_number && <span style={{ color: 'var(--text-muted)' }}>— #{e.invoice_number}</span>}
                        </div>
                      )}
                      {!isFactura && e.notes && <div style={{ fontSize: '0.72rem', color: 'var(--text-subtle)' }}>{e.notes}</div>}
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
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: pmInfo.color }}>{pmInfo.label}</span>
                    </td>
                    <td>
                      {isFactura
                        ? <span className="badge badge-primary badge-no-dot">Factura</span>
                        : e.payment_method === 'efectivo'
                          ? <span className="badge badge-success badge-no-dot">Impacta caja</span>
                          : <span className="badge badge-info badge-no-dot">Finanzas</span>
                      }
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
                  {filtered.length} gasto{filtered.length !== 1 ? 's' : ''} · {filtered.filter(e => e.tipo === 'factura').length} factura{filtered.filter(e => e.tipo === 'factura').length !== 1 ? 's' : ''}
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
