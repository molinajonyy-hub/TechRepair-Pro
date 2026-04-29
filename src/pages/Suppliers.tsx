import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  Truck, Plus, Search, Edit2, Trash2, Eye, ChevronLeft,
  Phone, Mail, MapPin, AlertCircle,
  CheckCircle, Clock, X, Package, CreditCard, MessageCircle,
  FileText, TrendingUp, ShoppingCart, Banknote, RefreshCw,
  ExternalLink, ChevronDown,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { smartSearch, buildSupabaseQuery } from '../utils/searchUtils'
import suppliersService, {
  type Supplier, type SupplierWithStats,
  type SupplierPurchase, type SupplierPurchaseItem,
  type SupplierPayment, type AccountMovement,
} from '../services/suppliersService'

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = ['Repuestos', 'Accesorios', 'Equipos usados', 'Herramientas', 'Insumos', 'Servicios', 'Mayorista', 'Electrónica', 'Otro']
const FISCAL_CONDITIONS = ['Responsable Inscripto', 'Monotributista', 'Exento', 'Consumidor Final', 'No categorizado']
const PAYMENT_METHODS = ['efectivo', 'transferencia', 'mercado_pago', 'tarjeta', 'dolares', 'cheque', 'otro']
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  efectivo: 'Efectivo', transferencia: 'Transferencia', mercado_pago: 'Mercado Pago',
  tarjeta: 'Tarjeta', dolares: 'Dólares', cheque: 'Cheque', otro: 'Otro',
}

// ─── Style helpers ────────────────────────────────────────────────────────────

const cardS: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '0.875rem', padding: '1.25rem',
}
const inputS: React.CSSProperties = {
  width: '100%', padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem',
  color: '#e2e8f0', fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box',
}
const labelS: React.CSSProperties = {
  display: 'block', fontSize: '0.72rem', fontWeight: 600,
  color: '#64748b', marginBottom: '0.375rem', textTransform: 'uppercase', letterSpacing: '0.05em',
}
const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
  padding: '0.5rem 1rem', background: 'linear-gradient(135deg,#6366f1,#4f46e5)',
  border: 'none', borderRadius: '0.5rem', color: '#fff', fontWeight: 600,
  fontSize: '0.8rem', cursor: 'pointer',
}
const btnSecondary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
  padding: '0.5rem 1rem', background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.12)', borderRadius: '0.5rem',
  color: '#94a3b8', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer',
}
const btnGhost: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  borderRadius: '0.375rem', padding: '0.35rem', display: 'inline-flex', alignItems: 'center',
}

const fmtARS = (n: number) => '$' + Math.round(n).toLocaleString('es-AR')
const fmtDate = (d: string | null) => {
  if (!d) return '—'
  return new Date(d + 'T12:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' })
}
const daysSince = (d: string | null) => {
  if (!d) return null
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000)
}

function StatusBadge({ status }: { status: 'pending' | 'partial' | 'paid' }) {
  const map = {
    pending: { label: 'Pendiente', bg: 'rgba(239,68,68,0.15)', color: '#ef4444', border: 'rgba(239,68,68,0.3)' },
    partial: { label: 'Parcial', bg: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: 'rgba(245,158,11,0.3)' },
    paid: { label: 'Pagada', bg: 'rgba(34,197,94,0.15)', color: '#22c55e', border: 'rgba(34,197,94,0.3)' },
  }
  const s = map[status]
  return (
    <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: '9999px', background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>
      {s.label}
    </span>
  )
}

// ─── Modal Overlay ────────────────────────────────────────────────────────────

function ModalOverlay({ onClose, children, maxWidth = '640px' }: { onClose: () => void; children: React.ReactNode; maxWidth?: string }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: '#0d1a30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '1.25rem', width: '100%', maxWidth, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 32px 64px rgba(0,0,0,0.6)' }}>
        {children}
      </div>
    </div>
  )
}

function ModalHeader({ title, subtitle, icon, onClose }: { title: string; subtitle?: string; icon?: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, background: '#0d1a30', zIndex: 1, borderRadius: '1.25rem 1.25rem 0 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        {icon && <div style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</div>}
        <div>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#f0f4ff' }}>{title}</h2>
          {subtitle && <p style={{ margin: 0, fontSize: '0.72rem', color: '#64748b' }}>{subtitle}</p>}
        </div>
      </div>
      <button onClick={onClose} style={{ ...btnGhost, color: '#64748b' }}><X size={16} /></button>
    </div>
  )
}

// ─── Modal: Crear / Editar proveedor ─────────────────────────────────────────

interface ModalSupplierFormProps {
  onClose: () => void
  onSaved: () => void
  editing?: SupplierWithStats | null
  businessId: string
  userId: string
}

function ModalSupplierForm({ onClose, onSaved, editing, businessId, userId }: ModalSupplierFormProps) {
  const blank = {
    name: '', business_name: '', tax_id: '', fiscal_condition: '',
    phone: '', whatsapp: '', email: '', address: '', city: '',
    province: '', country: 'Argentina', category: '',
    contact_name: '', delivery_days: '', payment_method_preferred: '',
    bank_alias: '', bank_cbu: '', website: '', internal_notes: '',
    active: true,
  }
  const [form, setForm] = useState<typeof blank>(editing ? { ...blank, ...editing } : blank)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [section, setSection] = useState<'principal' | 'comercial'>('principal')

  const set = (k: string, v: any) => setForm(p => ({ ...p, [k]: v }))

  const handleSave = async () => {
    if (!form.name.trim()) { setError('El nombre es obligatorio'); return }
    setSaving(true); setError('')
    try {
      if (editing) {
        await suppliersService.updateSupplier(editing.id, form, businessId)
      } else {
        await suppliersService.createSupplier({ ...form, business_id: businessId }, businessId, userId)
      }
      onSaved()
    } catch (e: any) {
      setError(e.message || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  const Field = ({ label, name, type = 'text', placeholder = '', required = false }: { label: string; name: string; type?: string; placeholder?: string; required?: boolean }) => (
    <div>
      <label style={labelS}>{label}{required && ' *'}</label>
      <input style={inputS} type={type} value={(form as any)[name] || ''} placeholder={placeholder}
        onChange={e => set(name, e.target.value)} />
    </div>
  )

  const SelectField = ({ label, name, options }: { label: string; name: string; options: string[] }) => (
    <div>
      <label style={labelS}>{label}</label>
      <select style={{ ...inputS }} value={(form as any)[name] || ''} onChange={e => set(name, e.target.value)}>
        <option value="">— Seleccionar —</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )

  return (
    <ModalOverlay onClose={onClose} maxWidth="700px">
      <ModalHeader title={editing ? 'Editar proveedor' : 'Nuevo proveedor'} subtitle="Datos del proveedor" icon={<Truck size={18} style={{ color: '#818cf8' }} />} onClose={onClose} />

      {/* Tabs internos */}
      <div style={{ display: 'flex', gap: '0.25rem', padding: '1rem 1.5rem 0', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        {(['principal', 'comercial'] as const).map(s => (
          <button key={s} onClick={() => setSection(s)} style={{ padding: '0.5rem 1rem', borderRadius: '0.5rem 0.5rem 0 0', border: 'none', background: section === s ? 'rgba(99,102,241,0.15)' : 'transparent', color: section === s ? '#818cf8' : '#64748b', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer' }}>
            {s === 'principal' ? 'Datos principales' : 'Datos comerciales'}
          </button>
        ))}
      </div>

      <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {section === 'principal' ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <Field label="Nombre comercial" name="name" required placeholder="Ej: Distribuidora Norte" />
              <Field label="Razón social" name="business_name" placeholder="Ej: Norte SA" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <Field label="CUIT / DNI" name="tax_id" placeholder="20-12345678-9" />
              <SelectField label="Condición fiscal" name="fiscal_condition" options={FISCAL_CONDITIONS} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <Field label="Teléfono" name="phone" placeholder="+54 9 351 123 4567" />
              <Field label="WhatsApp" name="whatsapp" placeholder="+54 9 351 123 4567" />
            </div>
            <Field label="Email" name="email" type="email" placeholder="proveedor@email.com" />
            <Field label="Dirección" name="address" placeholder="Av. Ejemplo 1234" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
              <Field label="Ciudad" name="city" />
              <Field label="Provincia" name="province" />
              <Field label="País" name="country" />
            </div>
            <div>
              <label style={labelS}>Estado</label>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                {[true, false].map(v => (
                  <label key={String(v)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', color: '#94a3b8', fontSize: '0.875rem' }}>
                    <input type="radio" checked={form.active === v} onChange={() => set('active', v)} />
                    {v ? 'Activo' : 'Inactivo'}
                  </label>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <SelectField label="Rubro / Categoría" name="category" options={CATEGORIES} />
              <Field label="Nombre del contacto" name="contact_name" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <Field label="Días habituales de entrega" name="delivery_days" placeholder="Ej: Lunes y jueves" />
              <SelectField label="Método de pago preferido" name="payment_method_preferred" options={PAYMENT_METHODS.map(m => PAYMENT_METHOD_LABELS[m] || m)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <Field label="Alias bancario" name="bank_alias" placeholder="proveedor.alias" />
              <Field label="CBU" name="bank_cbu" placeholder="0000000000000000000000" />
            </div>
            <Field label="Web / Instagram / Catálogo" name="website" placeholder="https://..." />
            <div>
              <label style={labelS}>Notas internas</label>
              <textarea style={{ ...inputS, minHeight: 80, resize: 'vertical' as const }}
                value={form.internal_notes || ''} onChange={e => set('internal_notes', e.target.value)}
                placeholder="Observaciones internas, condiciones, advertencias..." />
            </div>
          </>
        )}
      </div>

      {error && <p style={{ margin: '0 1.5rem', color: '#ef4444', fontSize: '0.8rem' }}>{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
        <button style={btnSecondary} onClick={onClose}>Cancelar</button>
        <button style={btnPrimary} onClick={handleSave} disabled={saving}>
          {saving ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle size={14} />}
          {saving ? 'Guardando...' : editing ? 'Guardar cambios' : 'Crear proveedor'}
        </button>
      </div>
    </ModalOverlay>
  )
}

// ─── Modal: Nueva Compra ──────────────────────────────────────────────────────

interface PurchaseItemRow {
  _key: string
  inventory_id: string | null
  product_name: string
  quantity: number
  unit_cost: number
  searchQ: string
  searchResults: any[]
}

interface ModalNuevaCompraProps {
  onClose: () => void
  onSaved: () => void
  supplier: SupplierWithStats
  businessId: string
  userId: string
}

function ModalNuevaCompra({ onClose, onSaved, supplier, businessId, userId }: ModalNuevaCompraProps) {
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().split('T')[0])
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('efectivo')
  const [paidAmount, setPaidAmount] = useState(0)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<PurchaseItemRow[]>([newRow()])
  const searchTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  function newRow(): PurchaseItemRow {
    return { _key: crypto.randomUUID(), inventory_id: null, product_name: '', quantity: 1, unit_cost: 0, searchQ: '', searchResults: [] }
  }

  const totalAmount = rows.reduce((s, r) => s + r.quantity * r.unit_cost, 0)
  const pendingAmount = Math.max(0, totalAmount - paidAmount)

  const updateRow = (key: string, updates: Partial<PurchaseItemRow>) =>
    setRows(prev => prev.map(r => r._key === key ? { ...r, ...updates } : r))

  const searchProduct = useCallback((key: string, q: string) => {
    updateRow(key, { searchQ: q, product_name: q, inventory_id: null })
    clearTimeout(searchTimers.current[key])
    if (q.trim().length < 2) { updateRow(key, { searchResults: [] }); return }
    searchTimers.current[key] = setTimeout(async () => {
      const dbQ = buildSupabaseQuery(q)
      const { data } = await supabase
        .from('inventory').select('id, name, variant_name, code, cost_price, stock_quantity')
        .eq('business_id', businessId).eq('is_active', true)
        .not('has_variants', 'is', true)
        .or(`name.ilike.${dbQ},code.ilike.${dbQ}`)
        .limit(8)
      updateRow(key, { searchResults: data || [] })
    }, 200)
  }, [businessId])

  const selectProduct = (key: string, prod: any) => {
    const name = prod.variant_name ? `${prod.name} — ${prod.variant_name}` : prod.name
    updateRow(key, {
      inventory_id: prod.id, product_name: name,
      unit_cost: prod.cost_price || 0, searchQ: name, searchResults: [],
    })
  }

  const handleSave = async () => {
    const validRows = rows.filter(r => r.product_name.trim() && r.quantity > 0)
    if (validRows.length === 0) { setError('Agregá al menos un producto'); return }
    if (totalAmount <= 0) { setError('El total debe ser mayor a 0'); return }
    setSaving(true); setError('')
    try {
      await suppliersService.createPurchase(
        { supplier_id: supplier.id, purchase_date: purchaseDate, invoice_number: invoiceNumber, total_amount: totalAmount, paid_amount: paidAmount, payment_method: paymentMethod, notes, items: validRows.map(r => ({ inventory_id: r.inventory_id, product_name: r.product_name, quantity: r.quantity, unit_cost: r.unit_cost })) },
        businessId, userId, supplier.name
      )
      onSaved()
    } catch (e: any) {
      setError(e.message || 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalOverlay onClose={onClose} maxWidth="780px">
      <ModalHeader title="Nueva compra" subtitle={`Registrar compra a ${supplier.name}`} icon={<ShoppingCart size={18} style={{ color: '#818cf8' }} />} onClose={onClose} />

      <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

        {/* Encabezado de compra */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={labelS}>Fecha de compra</label>
            <input style={inputS} type="date" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} />
          </div>
          <div>
            <label style={labelS}>Nro. de factura / remito</label>
            <input style={inputS} type="text" value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} placeholder="Ej: A-0001-00123" />
          </div>
          <div>
            <label style={labelS}>Método de pago</label>
            <select style={inputS} value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
              {PAYMENT_METHODS.map(m => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
            </select>
          </div>
        </div>

        {/* Items */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <label style={{ ...labelS, margin: 0 }}>Productos comprados</label>
            <button style={{ ...btnSecondary, fontSize: '0.72rem', padding: '0.25rem 0.625rem' }} onClick={() => setRows(p => [...p, newRow()])}>
              <Plus size={11} /> Agregar fila
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {/* Header */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 110px 32px', gap: '0.5rem', padding: '0 0.25rem' }}>
              {['Producto', 'Cant.', 'Costo unit.', ''].map(h => (
                <span key={h} style={{ fontSize: '0.65rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase' }}>{h}</span>
              ))}
            </div>

            {rows.map(row => (
              <div key={row._key} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 110px 32px', gap: '0.5rem', alignItems: 'center' }}>
                <div style={{ position: 'relative' }}>
                  <input style={inputS} value={row.searchQ}
                    onChange={e => searchProduct(row._key, e.target.value)}
                    placeholder="Buscar o escribir producto..." />
                  {row.searchResults.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, background: '#0d1a30', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '0.5rem', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', marginTop: '0.2rem' }}>
                      {row.searchResults.map((p: any) => (
                        <button key={p.id} type="button" onClick={() => selectProduct(row._key, p)}
                          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0.5rem 0.75rem', background: 'none', border: 'none', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.05)', textAlign: 'left' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                          <span style={{ color: '#e2e8f0', fontSize: '0.83rem' }}>{p.name}{p.variant_name ? ` — ${p.variant_name}` : ''}</span>
                          <span style={{ color: '#475569', fontSize: '0.72rem', flexShrink: 0, marginLeft: '0.5rem' }}>stock: {p.stock_quantity}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input style={{ ...inputS, textAlign: 'center' }} type="number" min={1} value={row.quantity}
                  onChange={e => updateRow(row._key, { quantity: +e.target.value || 1 })} />
                <input style={{ ...inputS, textAlign: 'right' }} type="number" min={0} value={row.unit_cost || ''}
                  onChange={e => updateRow(row._key, { unit_cost: +e.target.value || 0 })}
                  placeholder="$ costo" />
                <button style={{ ...btnGhost, color: '#ef4444' }} onClick={() => rows.length > 1 && setRows(p => p.filter(r => r._key !== row._key))} disabled={rows.length === 1}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Total + Pago */}
        <div style={{ ...cardS, background: 'rgba(99,102,241,0.06)', borderColor: 'rgba(99,102,241,0.2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Total de compra</span>
            <span style={{ fontSize: '1.5rem', fontWeight: 800, color: '#818cf8' }}>{fmtARS(totalAmount)}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label style={labelS}>Monto pagado ahora</label>
              <input style={{ ...inputS, fontSize: '1rem', fontWeight: 700 }} type="number" min={0} max={totalAmount}
                value={paidAmount || ''} onChange={e => setPaidAmount(Math.min(totalAmount, +e.target.value || 0))}
                placeholder="$ pagado" />
            </div>
            <div>
              <label style={labelS}>Saldo pendiente</label>
              <div style={{ ...inputS, color: pendingAmount > 0 ? '#f59e0b' : '#22c55e', fontWeight: 700, fontSize: '1rem', display: 'flex', alignItems: 'center' }}>
                {fmtARS(pendingAmount)}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
            <button style={{ flex: 1, padding: '0.5rem', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.375rem', background: paidAmount <= 0 ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.04)', color: paidAmount <= 0 ? '#ef4444' : '#64748b', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}
              onClick={() => setPaidAmount(0)}>Queda pendiente</button>
            <button style={{ flex: 1, padding: '0.5rem', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.375rem', background: paidAmount > 0 && paidAmount < totalAmount ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.04)', color: paidAmount > 0 && paidAmount < totalAmount ? '#f59e0b' : '#64748b', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}
              onClick={() => setPaidAmount(Math.round(totalAmount / 2))}>Pago parcial</button>
            <button style={{ flex: 1, padding: '0.5rem', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.375rem', background: paidAmount >= totalAmount && totalAmount > 0 ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.04)', color: paidAmount >= totalAmount && totalAmount > 0 ? '#22c55e' : '#64748b', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}
              onClick={() => setPaidAmount(totalAmount)}>Pago completo</button>
          </div>
        </div>

        {/* Notas */}
        <div>
          <label style={labelS}>Notas</label>
          <textarea style={{ ...inputS, minHeight: 64, resize: 'vertical' as const }} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Observaciones de la compra..." />
        </div>
      </div>

      {error && <p style={{ margin: '0 1.5rem', color: '#ef4444', fontSize: '0.8rem' }}>{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
        <button style={btnSecondary} onClick={onClose}>Cancelar</button>
        <button style={btnPrimary} onClick={handleSave} disabled={saving}>
          {saving ? <RefreshCw size={14} className="animate-spin" /> : <ShoppingCart size={14} />}
          {saving ? 'Guardando...' : 'Registrar compra'}
        </button>
      </div>
    </ModalOverlay>
  )
}

// ─── Modal: Registrar Pago ────────────────────────────────────────────────────

interface ModalRegistrarPagoProps {
  onClose: () => void
  onSaved: () => void
  supplier: SupplierWithStats
  purchases: SupplierPurchase[]
  businessId: string
  userId: string
  defaultPurchaseId?: string | null
}

function ModalRegistrarPago({ onClose, onSaved, supplier, purchases, businessId, userId, defaultPurchaseId }: ModalRegistrarPagoProps) {
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0])
  const [amount, setAmount] = useState(0)
  const [method, setMethod] = useState('efectivo')
  const [purchaseId, setPurchaseId] = useState<string>(defaultPurchaseId || '')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const pendingPurchases = purchases.filter(p => p.payment_status !== 'paid')

  const handleSave = async () => {
    if (amount <= 0) { setError('El monto debe ser mayor a 0'); return }
    setSaving(true); setError('')
    try {
      await suppliersService.createPayment(
        { supplier_id: supplier.id, purchase_id: purchaseId || null, payment_date: paymentDate, amount, payment_method: method, notes },
        businessId, userId, supplier.name
      )
      onSaved()
    } catch (e: any) {
      setError(e.message || 'Error al registrar pago')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalOverlay onClose={onClose} maxWidth="520px">
      <ModalHeader title="Registrar pago" subtitle={`Pago a ${supplier.name}`} icon={<Banknote size={18} style={{ color: '#22c55e' }} />} onClose={onClose} />

      <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ ...cardS, background: 'rgba(239,68,68,0.06)', borderColor: 'rgba(239,68,68,0.2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Saldo pendiente con proveedor</span>
          <span style={{ fontSize: '1.25rem', fontWeight: 800, color: '#ef4444' }}>{fmtARS(supplier.pending_amount)}</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={labelS}>Fecha</label>
            <input style={inputS} type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
          </div>
          <div>
            <label style={labelS}>Método de pago</label>
            <select style={inputS} value={method} onChange={e => setMethod(e.target.value)}>
              {PAYMENT_METHODS.map(m => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label style={labelS}>Monto *</label>
          <input style={{ ...inputS, fontSize: '1.25rem', fontWeight: 700, textAlign: 'right' }} type="number" min={0}
            value={amount || ''} onChange={e => setAmount(+e.target.value || 0)} placeholder="$ 0" />
        </div>

        {pendingPurchases.length > 0 && (
          <div>
            <label style={labelS}>Compra asociada (opcional)</label>
            <select style={inputS} value={purchaseId} onChange={e => setPurchaseId(e.target.value)}>
              <option value="">— Sin vincular a compra —</option>
              {pendingPurchases.map(p => (
                <option key={p.id} value={p.id}>
                  {fmtDate(p.purchase_date)}{p.invoice_number ? ` #${p.invoice_number}` : ''} — Saldo: {fmtARS(p.pending_amount)}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label style={labelS}>Notas</label>
          <textarea style={{ ...inputS, minHeight: 64, resize: 'vertical' as const }} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Observaciones del pago..." />
        </div>
      </div>

      {error && <p style={{ margin: '0 1.5rem', color: '#ef4444', fontSize: '0.8rem' }}>{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
        <button style={btnSecondary} onClick={onClose}>Cancelar</button>
        <button style={{ ...btnPrimary, background: 'linear-gradient(135deg,#22c55e,#16a34a)' }} onClick={handleSave} disabled={saving}>
          {saving ? <RefreshCw size={14} className="animate-spin" /> : <Banknote size={14} />}
          {saving ? 'Guardando...' : 'Registrar pago'}
        </button>
      </div>
    </ModalOverlay>
  )
}

// ─── Modal: Ver compra ────────────────────────────────────────────────────────

function ModalVerCompra({ purchase, onClose }: { purchase: SupplierPurchase; onClose: () => void }) {
  return (
    <ModalOverlay onClose={onClose} maxWidth="620px">
      <ModalHeader title={`Compra${purchase.invoice_number ? ' #' + purchase.invoice_number : ''}`} subtitle={fmtDate(purchase.purchase_date)} icon={<FileText size={18} style={{ color: '#818cf8' }} />} onClose={onClose} />

      <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {/* Items */}
        <div>
          <label style={labelS}>Productos</label>
          <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                  {['Producto', 'Cant.', 'Costo unit.', 'Subtotal'].map(h => (
                    <th key={h} style={{ padding: '0.625rem 0.75rem', fontSize: '0.68rem', color: '#64748b', fontWeight: 700, textAlign: h === 'Producto' ? 'left' : 'right', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(purchase.items || []).map(item => (
                  <tr key={item.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '0.625rem 0.75rem', color: '#e2e8f0', fontSize: '0.875rem' }}>
                      {item.product_name}
                      {item.inventory_id && <span style={{ fontSize: '0.65rem', color: '#6366f1', marginLeft: '0.375rem' }}>• inventario</span>}
                    </td>
                    <td style={{ padding: '0.625rem 0.75rem', color: '#94a3b8', textAlign: 'right', fontSize: '0.875rem' }}>{item.quantity}</td>
                    <td style={{ padding: '0.625rem 0.75rem', color: '#94a3b8', textAlign: 'right', fontSize: '0.875rem' }}>{fmtARS(item.unit_cost)}</td>
                    <td style={{ padding: '0.625rem 0.75rem', color: '#f0f4ff', textAlign: 'right', fontWeight: 600, fontSize: '0.875rem' }}>{fmtARS(item.quantity * item.unit_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Resumen de pago */}
        <div style={{ ...cardS }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '0.72rem', color: '#64748b', marginBottom: '0.25rem' }}>TOTAL</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#f0f4ff' }}>{fmtARS(purchase.total_amount)}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '0.72rem', color: '#64748b', marginBottom: '0.25rem' }}>PAGADO</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#22c55e' }}>{fmtARS(purchase.paid_amount)}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '0.72rem', color: '#64748b', marginBottom: '0.25rem' }}>PENDIENTE</div>
              <div style={{ fontSize: '1.2rem', fontWeight: 800, color: purchase.pending_amount > 0 ? '#f59e0b' : '#22c55e' }}>{fmtARS(purchase.pending_amount)}</div>
            </div>
          </div>
          <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#64748b', fontSize: '0.8rem' }}>Método: {PAYMENT_METHOD_LABELS[purchase.payment_method || ''] || purchase.payment_method || '—'}</span>
            <StatusBadge status={purchase.payment_status} />
          </div>
        </div>

        {purchase.notes && (
          <div style={{ ...cardS }}>
            <label style={labelS}>Notas</label>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.875rem' }}>{purchase.notes}</p>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
        <button style={btnSecondary} onClick={onClose}>Cerrar</button>
      </div>
    </ModalOverlay>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

type FilterKey = 'all' | 'active' | 'inactive' | 'with_debt' | 'no_debt'
type SortKey = 'name' | 'total_purchases' | 'pending_amount' | 'last_purchase_date'
type TabKey = 'compras' | 'cuenta' | 'pagos' | 'notas'

export function Suppliers() {
  const { businessId, user } = useAuth()

  // ── Vista ──
  const [view, setView] = useState<'list' | 'detail'>('list')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // ── Datos lista ──
  const [suppliers, setSuppliers] = useState<SupplierWithStats[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState<FilterKey>('all')
  const [sortBy, setSortBy] = useState<SortKey>('name')

  // ── Datos detalle ──
  const [detailSupplier, setDetailSupplier] = useState<SupplierWithStats | null>(null)
  const [purchases, setPurchases] = useState<SupplierPurchase[]>([])
  const [payments, setPayments] = useState<SupplierPayment[]>([])
  const [movements, setMovements] = useState<AccountMovement[]>([])
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [activeTab, setActiveTab] = useState<TabKey>('compras')

  // ── Modals ──
  const [showModalSupplier, setShowModalSupplier] = useState(false)
  const [showModalPurchase, setShowModalPurchase] = useState(false)
  const [showModalPayment, setShowModalPayment] = useState(false)
  const [viewingPurchase, setViewingPurchase] = useState<SupplierPurchase | null>(null)
  const [editingSupplier, setEditingSupplier] = useState<SupplierWithStats | null>(null)
  const [defaultPurchaseId, setDefaultPurchaseId] = useState<string | null>(null)

  // ── Carga lista ──
  const loadList = useCallback(async () => {
    if (!businessId) return
    setLoadingList(true)
    try {
      const data = await suppliersService.getSuppliersWithStats(businessId)
      setSuppliers(data)
    } catch (e) { console.error(e) }
    finally { setLoadingList(false) }
  }, [businessId])

  useEffect(() => { loadList() }, [loadList])

  // ── Carga detalle ──
  const loadDetail = useCallback(async (id: string) => {
    if (!businessId) return
    setLoadingDetail(true)
    try {
      const [s, purch, pays, movs] = await Promise.all([
        suppliersService.getSuppliersWithStats(businessId).then(list => list.find(x => x.id === id) || null),
        suppliersService.getPurchases(id, businessId),
        suppliersService.getPayments(id, businessId),
        suppliersService.getAccountMovements(id, businessId),
      ])
      setDetailSupplier(s)
      setPurchases(purch)
      setPayments(pays)
      setMovements(movs)
    } catch (e) { console.error(e) }
    finally { setLoadingDetail(false) }
  }, [businessId])

  const openDetail = (id: string) => {
    setSelectedId(id)
    setView('detail')
    setActiveTab('compras')
    loadDetail(id)
  }

  const backToList = () => {
    setView('list')
    setSelectedId(null)
    setDetailSupplier(null)
  }

  const refreshDetail = () => {
    if (selectedId) loadDetail(selectedId)
    loadList()
  }

  // ── Filtrado y orden lista ──
  const filtered = useMemo(() => {
    let list = [...suppliers]

    if (filterStatus === 'active') list = list.filter(s => s.active)
    if (filterStatus === 'inactive') list = list.filter(s => !s.active)
    if (filterStatus === 'with_debt') list = list.filter(s => s.pending_amount > 0)
    if (filterStatus === 'no_debt') list = list.filter(s => s.pending_amount <= 0)

    if (searchTerm.trim()) {
      list = smartSearch(list, searchTerm, [
        { getValue: s => s.name, weight: 3 },
        { getValue: s => s.business_name, weight: 2 },
        { getValue: s => s.tax_id, weight: 2 },
        { getValue: s => s.phone },
        { getValue: s => s.whatsapp },
        { getValue: s => s.email },
        { getValue: s => s.city },
        { getValue: s => s.category },
        { getValue: s => s.contact_name },
      ])
    }

    if (!searchTerm.trim()) {
      list.sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name)
        if (sortBy === 'total_purchases') return b.total_purchases - a.total_purchases
        if (sortBy === 'pending_amount') return b.pending_amount - a.pending_amount
        if (sortBy === 'last_purchase_date') {
          if (!a.last_purchase_date) return 1
          if (!b.last_purchase_date) return -1
          return b.last_purchase_date.localeCompare(a.last_purchase_date)
        }
        return 0
      })
    }

    return list
  }, [suppliers, searchTerm, filterStatus, sortBy])

  // ── Stats lista ──
  const totalDeuda = suppliers.filter(s => s.active).reduce((sum, s) => sum + s.pending_amount, 0)
  const totalVolumen = suppliers.filter(s => s.active).reduce((sum, s) => sum + s.total_purchases, 0)
  const conDeuda = suppliers.filter(s => s.pending_amount > 0).length

  const handleToggleActive = async (s: SupplierWithStats) => {
    if (!businessId) return
    try {
      await suppliersService.toggleActive(s.id, businessId, !s.active)
      await loadList()
    } catch (e: any) { alert(e.message) }
  }

  const handleDelete = async (s: SupplierWithStats) => {
    if (!confirm(`¿Eliminar a ${s.name}? Esta acción es irreversible.`)) return
    if (!businessId) return
    try {
      await suppliersService.deleteSupplier(s.id, businessId)
      await loadList()
    } catch (e: any) { alert('No se puede eliminar: ' + e.message) }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: LIST
  // ─────────────────────────────────────────────────────────────────────────────

  if (view === 'list') return (
    <div className="page-shell">
      {/* Encabezado */}
      <div className="page-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div style={{ width: 40, height: 40, borderRadius: '0.75rem', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Truck size={20} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 className="page-title">Proveedores</h1>
            <p className="page-subtitle">{suppliers.length} proveedores registrados</p>
          </div>
        </div>
        <button style={btnPrimary} onClick={() => { setEditingSupplier(null); setShowModalSupplier(true) }}>
          <Plus size={15} /> Nuevo proveedor
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.25rem' }}>
        {[
          { label: 'Total proveedores', value: suppliers.filter(s => s.active).length, color: '#818cf8', icon: <Truck size={16} /> },
          { label: 'Con deuda pendiente', value: conDeuda, color: '#f59e0b', icon: <AlertCircle size={16} />, suffix: conDeuda > 0 ? `(${fmtARS(totalDeuda)})` : '' },
          { label: 'Volumen total comprado', value: fmtARS(totalVolumen), color: '#22c55e', icon: <TrendingUp size={16} />, isARS: true },
        ].map((stat, i) => (
          <div key={i} style={cardS}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', color: stat.color }}>
              {stat.icon}
              <span style={{ fontSize: '0.72rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>{stat.label}</span>
            </div>
            <div style={{ fontSize: '1.4rem', fontWeight: 800, color: stat.color }}>
              {stat.isARS ? stat.value : stat.value}
            </div>
            {stat.suffix && <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}>{stat.suffix}</div>}
          </div>
        ))}
      </div>

      {/* Buscador + filtros */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
          <input style={{ ...inputS, paddingLeft: '2.25rem' }} placeholder="Buscar por nombre, CUIT, rubro, ciudad, teléfono..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
          {([
            { key: 'all', label: 'Todos' },
            { key: 'active', label: 'Activos' },
            { key: 'inactive', label: 'Inactivos' },
            { key: 'with_debt', label: 'Con deuda' },
            { key: 'no_debt', label: 'Sin deuda' },
          ] as { key: FilterKey; label: string }[]).map(f => (
            <button key={f.key} onClick={() => setFilterStatus(f.key)}
              style={{ padding: '0.4rem 0.75rem', border: `1px solid ${filterStatus === f.key ? '#6366f1' : 'rgba(255,255,255,0.1)'}`, borderRadius: '0.5rem', background: filterStatus === f.key ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)', color: filterStatus === f.key ? '#818cf8' : '#64748b', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}>
              {f.label}
            </button>
          ))}
          <select style={{ ...inputS, width: 'auto', fontSize: '0.75rem', padding: '0.4rem 0.625rem' }} value={sortBy} onChange={e => setSortBy(e.target.value as SortKey)}>
            <option value="name">A-Z</option>
            <option value="total_purchases">Mayor volumen</option>
            <option value="pending_amount">Mayor deuda</option>
            <option value="last_purchase_date">Compra reciente</option>
          </select>
        </div>
      </div>

      {/* Tabla */}
      {loadingList ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}><RefreshCw className="animate-spin" size={28} style={{ color: '#6366f1' }} /></div>
      ) : (
        <div style={{ ...cardS, padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {['Proveedor', 'Rubro', 'Contacto', 'Total comprado', 'Saldo pendiente', 'Última compra', 'Estado', ''].map(h => (
                  <th key={h} style={{ padding: '0.75rem 1rem', fontSize: '0.68rem', color: '#475569', fontWeight: 700, textAlign: ['Total comprado', 'Saldo pendiente'].includes(h) ? 'right' : 'left', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: '3rem', color: '#475569' }}>
                  {searchTerm ? `Sin resultados para "${searchTerm}"` : 'No hay proveedores registrados'}
                </td></tr>
              )}
              {filtered.map(s => {
                const days = daysSince(s.last_purchase_date)
                return (
                  <tr key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', transition: 'background 0.1s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <td style={{ padding: '0.875rem 1rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                        <div style={{ width: 32, height: 32, borderRadius: '0.5rem', background: 'rgba(99,102,241,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Truck size={14} style={{ color: '#818cf8' }} />
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '0.875rem' }}>{s.name}</div>
                          {s.business_name && <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{s.business_name}</div>}
                          {s.tax_id && <div style={{ fontSize: '0.68rem', color: '#475569' }}>CUIT: {s.tax_id}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '0.875rem 1rem' }}>
                      {s.category ? (
                        <span style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem', borderRadius: '9999px', background: 'rgba(99,102,241,0.12)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.2)' }}>{s.category}</span>
                      ) : <span style={{ color: '#475569', fontSize: '0.8rem' }}>—</span>}
                    </td>
                    <td style={{ padding: '0.875rem 1rem' }}>
                      <div style={{ fontSize: '0.8rem', color: '#94a3b8', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                        {s.phone && <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><Phone size={11} />{s.phone}</span>}
                        {s.email && <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><Mail size={11} />{s.email}</span>}
                        {s.city && <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><MapPin size={11} />{s.city}</span>}
                      </div>
                    </td>
                    <td style={{ padding: '0.875rem 1rem', textAlign: 'right' }}>
                      <div style={{ fontWeight: 700, color: '#e2e8f0', fontSize: '0.9rem' }}>{fmtARS(s.total_purchases)}</div>
                      <div style={{ fontSize: '0.7rem', color: '#475569' }}>{s.purchases_count} compra{s.purchases_count !== 1 ? 's' : ''}</div>
                    </td>
                    <td style={{ padding: '0.875rem 1rem', textAlign: 'right' }}>
                      {s.pending_amount > 0 ? (
                        <div style={{ fontWeight: 700, color: '#f59e0b', fontSize: '0.9rem' }}>{fmtARS(s.pending_amount)}</div>
                      ) : (
                        <span style={{ fontSize: '0.8rem', color: '#22c55e', display: 'flex', alignItems: 'center', gap: '0.3rem', justifyContent: 'flex-end' }}><CheckCircle size={12} /> Al día</span>
                      )}
                    </td>
                    <td style={{ padding: '0.875rem 1rem' }}>
                      <div style={{ fontSize: '0.8rem', color: days !== null && days > 30 ? '#f59e0b' : '#94a3b8' }}>
                        {fmtDate(s.last_purchase_date)}
                        {days !== null && days > 30 && <div style={{ fontSize: '0.68rem', color: '#f59e0b' }}>hace {days} días</div>}
                      </div>
                    </td>
                    <td style={{ padding: '0.875rem 1rem' }}>
                      <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '0.2rem 0.5rem', borderRadius: '9999px', background: s.active ? 'rgba(34,197,94,0.12)' : 'rgba(100,116,139,0.12)', color: s.active ? '#22c55e' : '#64748b', border: `1px solid ${s.active ? 'rgba(34,197,94,0.25)' : 'rgba(100,116,139,0.25)'}` }}>
                        {s.active ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td style={{ padding: '0.875rem 0.75rem' }}>
                      <div style={{ display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
                        <button style={{ ...btnGhost, color: '#818cf8' }} title="Ver detalle" onClick={() => openDetail(s.id)}><Eye size={15} /></button>
                        <button style={{ ...btnGhost, color: '#64748b' }} title="Editar" onClick={() => { setEditingSupplier(s); setShowModalSupplier(true) }}><Edit2 size={15} /></button>
                        <button style={{ ...btnGhost, color: s.active ? '#64748b' : '#22c55e' }} title={s.active ? 'Desactivar' : 'Activar'} onClick={() => handleToggleActive(s)}>
                          {s.active ? <X size={15} /> : <CheckCircle size={15} />}
                        </button>
                        <button style={{ ...btnGhost, color: '#ef4444' }} title="Eliminar" onClick={() => handleDelete(s)}><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals */}
      {showModalSupplier && (
        <ModalSupplierForm
          onClose={() => { setShowModalSupplier(false); setEditingSupplier(null) }}
          onSaved={() => { setShowModalSupplier(false); setEditingSupplier(null); loadList() }}
          editing={editingSupplier}
          businessId={businessId || ''}
          userId={user?.id || ''}
        />
      )}
    </div>
  )

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER: DETAIL
  // ─────────────────────────────────────────────────────────────────────────────

  const s = detailSupplier

  if (loadingDetail || !s) return (
    <div className="page-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
      <RefreshCw className="animate-spin" size={32} style={{ color: '#6366f1' }} />
    </div>
  )

  const days = daysSince(s.last_purchase_date)
  const hasBigDebt = s.pending_amount > 50000
  const noRecentPurchase = days !== null && days > 30
  const mostBoughtProduct = (() => {
    const freq: Record<string, number> = {}
    purchases.forEach(p => (p.items || []).forEach(i => { freq[i.product_name] = (freq[i.product_name] || 0) + i.quantity }))
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1])
    return sorted[0]?.[0] || null
  })()

  const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'compras', label: 'Compras', icon: <ShoppingCart size={14} /> },
    { key: 'cuenta', label: 'Cuenta corriente', icon: <CreditCard size={14} /> },
    { key: 'pagos', label: 'Pagos', icon: <Banknote size={14} /> },
    { key: 'notas', label: 'Notas', icon: <FileText size={14} /> },
  ]

  return (
    <div className="page-shell">
      {/* Encabezado detalle */}
      <div style={{ marginBottom: '1.25rem' }}>
        <button style={{ ...btnGhost, color: '#64748b', marginBottom: '0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }} onClick={backToList}>
          <ChevronLeft size={16} /> Volver a proveedores
        </button>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ width: 52, height: 52, borderRadius: '0.875rem', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Truck size={24} style={{ color: '#818cf8' }} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
                <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 800, color: '#f0f4ff' }}>{s.name}</h1>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '0.2rem 0.625rem', borderRadius: '9999px', background: s.active ? 'rgba(34,197,94,0.12)' : 'rgba(100,116,139,0.12)', color: s.active ? '#22c55e' : '#64748b', border: `1px solid ${s.active ? 'rgba(34,197,94,0.25)' : 'rgba(100,116,139,0.25)'}` }}>
                  {s.active ? 'Activo' : 'Inactivo'}
                </span>
                {s.category && (
                  <span style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem', borderRadius: '9999px', background: 'rgba(99,102,241,0.1)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.2)' }}>{s.category}</span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                {s.phone && <span style={{ fontSize: '0.8rem', color: '#64748b', display: 'flex', alignItems: 'center', gap: '0.3rem' }}><Phone size={11} />{s.phone}</span>}
                {s.city && <span style={{ fontSize: '0.8rem', color: '#64748b', display: 'flex', alignItems: 'center', gap: '0.3rem' }}><MapPin size={11} />{s.city}</span>}
                {s.tax_id && <span style={{ fontSize: '0.8rem', color: '#64748b' }}>CUIT: {s.tax_id}</span>}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {(s.whatsapp || s.phone) && (
              <a href={`https://wa.me/${(s.whatsapp || s.phone || '').replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer"
                style={{ ...btnSecondary, textDecoration: 'none', color: '#22c55e', borderColor: 'rgba(34,197,94,0.3)' }}>
                <MessageCircle size={14} /> WhatsApp
              </a>
            )}
            <button style={btnSecondary} onClick={() => { setEditingSupplier(s); setShowModalSupplier(true) }}>
              <Edit2 size={14} /> Editar
            </button>
            <button style={{ ...btnSecondary, color: '#22c55e', borderColor: 'rgba(34,197,94,0.3)' }} onClick={() => { setDefaultPurchaseId(null); setShowModalPayment(true) }}>
              <Banknote size={14} /> Registrar pago
            </button>
            <button style={btnPrimary} onClick={() => setShowModalPurchase(true)}>
              <Plus size={14} /> Nueva compra
            </button>
          </div>
        </div>
      </div>

      {/* Alertas */}
      {(hasBigDebt || noRecentPurchase || !s.active) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.25rem' }}>
          {hasBigDebt && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', borderRadius: '0.625rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
              <AlertCircle size={16} style={{ color: '#ef4444', flexShrink: 0 }} />
              <span style={{ color: '#fca5a5', fontSize: '0.875rem' }}>Este proveedor tiene <strong>{fmtARS(s.pending_amount)}</strong> pendientes de pago.</span>
            </div>
          )}
          {noRecentPurchase && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', borderRadius: '0.625rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
              <Clock size={16} style={{ color: '#f59e0b', flexShrink: 0 }} />
              <span style={{ color: '#fcd34d', fontSize: '0.875rem' }}>La última compra fue hace <strong>{days} días</strong> ({fmtDate(s.last_purchase_date)}).</span>
            </div>
          )}
          {!s.active && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', borderRadius: '0.625rem', background: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.25)' }}>
              <AlertCircle size={16} style={{ color: '#64748b', flexShrink: 0 }} />
              <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Este proveedor está <strong>inactivo</strong>.</span>
            </div>
          )}
        </div>
      )}

      {/* Cards resumen */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
        {[
          { label: 'Total comprado', value: fmtARS(s.total_purchases), color: '#818cf8', icon: <TrendingUp size={16} /> },
          { label: 'Total pagado', value: fmtARS(s.total_paid), color: '#22c55e', icon: <CheckCircle size={16} /> },
          { label: 'Saldo pendiente', value: fmtARS(s.pending_amount), color: s.pending_amount > 0 ? '#f59e0b' : '#22c55e', icon: <AlertCircle size={16} /> },
          { label: 'Compras', value: s.purchases_count, color: '#38bdf8', icon: <ShoppingCart size={16} /> },
        ].map((c, i) => (
          <div key={i} style={cardS}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', color: c.color }}>{c.icon}<span style={{ fontSize: '0.68rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase' }}>{c.label}</span></div>
            <div style={{ fontSize: '1.3rem', fontWeight: 800, color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
        <div style={cardS}>
          <div style={{ fontSize: '0.68rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', marginBottom: '0.375rem' }}>Última compra</div>
          <div style={{ fontWeight: 700, color: '#e2e8f0' }}>{fmtDate(s.last_purchase_date)}</div>
        </div>
        <div style={cardS}>
          <div style={{ fontSize: '0.68rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', marginBottom: '0.375rem' }}>Producto más comprado</div>
          <div style={{ fontWeight: 700, color: '#e2e8f0', fontSize: '0.875rem' }}>{mostBoughtProduct || '—'}</div>
        </div>
        <div style={cardS}>
          <div style={{ fontSize: '0.68rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', marginBottom: '0.375rem' }}>Promedio por compra</div>
          <div style={{ fontWeight: 700, color: '#e2e8f0' }}>{s.purchases_count > 0 ? fmtARS(s.total_purchases / s.purchases_count) : '—'}</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: '1.25rem' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.625rem 1rem', border: 'none', borderBottom: `2px solid ${activeTab === t.key ? '#6366f1' : 'transparent'}`, background: 'none', color: activeTab === t.key ? '#818cf8' : '#64748b', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s', borderRadius: '0.375rem 0.375rem 0 0' }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Compras */}
      {activeTab === 'compras' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
            <button style={btnPrimary} onClick={() => setShowModalPurchase(true)}>
              <Plus size={13} /> Nueva compra
            </button>
          </div>
          {purchases.length === 0 ? (
            <div style={{ ...cardS, textAlign: 'center', padding: '3rem', color: '#475569' }}>
              <ShoppingCart size={32} style={{ marginBottom: '0.75rem', opacity: 0.3 }} />
              <p>No hay compras registradas a este proveedor.</p>
              <button style={{ ...btnPrimary, marginTop: '0.75rem' }} onClick={() => setShowModalPurchase(true)}><Plus size={13} /> Registrar primera compra</button>
            </div>
          ) : (
            <div style={{ ...cardS, padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                    {['Fecha', 'Factura', 'Productos', 'Total', 'Pagado', 'Pendiente', 'Método', 'Estado', ''].map(h => (
                      <th key={h} style={{ padding: '0.625rem 0.875rem', fontSize: '0.65rem', color: '#475569', fontWeight: 700, textAlign: ['Total','Pagado','Pendiente'].includes(h) ? 'right' : 'left', textTransform: 'uppercase' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {purchases.map(p => (
                    <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      <td style={{ padding: '0.75rem 0.875rem', color: '#94a3b8', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{fmtDate(p.purchase_date)}</td>
                      <td style={{ padding: '0.75rem 0.875rem', color: '#e2e8f0', fontSize: '0.8rem', fontWeight: 600 }}>{p.invoice_number || '—'}</td>
                      <td style={{ padding: '0.75rem 0.875rem', color: '#94a3b8', fontSize: '0.75rem' }}>
                        {(p.items || []).slice(0, 2).map(i => i.product_name).join(', ')}
                        {(p.items?.length || 0) > 2 && ` +${(p.items?.length || 0) - 2} más`}
                        {(p.items?.length || 0) === 0 && '—'}
                      </td>
                      <td style={{ padding: '0.75rem 0.875rem', textAlign: 'right', fontWeight: 700, color: '#e2e8f0', fontSize: '0.875rem' }}>{fmtARS(p.total_amount)}</td>
                      <td style={{ padding: '0.75rem 0.875rem', textAlign: 'right', color: '#22c55e', fontSize: '0.875rem' }}>{fmtARS(p.paid_amount)}</td>
                      <td style={{ padding: '0.75rem 0.875rem', textAlign: 'right', color: p.pending_amount > 0 ? '#f59e0b' : '#22c55e', fontSize: '0.875rem', fontWeight: p.pending_amount > 0 ? 700 : 400 }}>{fmtARS(p.pending_amount)}</td>
                      <td style={{ padding: '0.75rem 0.875rem', color: '#64748b', fontSize: '0.75rem' }}>{PAYMENT_METHOD_LABELS[p.payment_method || ''] || p.payment_method || '—'}</td>
                      <td style={{ padding: '0.75rem 0.875rem' }}><StatusBadge status={p.payment_status} /></td>
                      <td style={{ padding: '0.75rem 0.625rem' }}>
                        <div style={{ display: 'flex', gap: '0.25rem' }}>
                          <button style={{ ...btnGhost, color: '#818cf8' }} title="Ver detalle" onClick={() => setViewingPurchase(p)}><Eye size={14} /></button>
                          {p.payment_status !== 'paid' && (
                            <button style={{ ...btnGhost, color: '#22c55e' }} title="Registrar pago" onClick={() => { setDefaultPurchaseId(p.id); setShowModalPayment(true) }}><Banknote size={14} /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab: Cuenta corriente */}
      {activeTab === 'cuenta' && (
        <div>
          {movements.length === 0 ? (
            <div style={{ ...cardS, textAlign: 'center', padding: '3rem', color: '#475569' }}>
              <CreditCard size={32} style={{ marginBottom: '0.75rem', opacity: 0.3 }} />
              <p>No hay movimientos en la cuenta corriente.</p>
            </div>
          ) : (
            <div style={{ ...cardS, padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                    {['Fecha', 'Tipo', 'Descripción', 'Debe', 'Haber', 'Saldo'].map(h => (
                      <th key={h} style={{ padding: '0.625rem 0.875rem', fontSize: '0.65rem', color: '#475569', fontWeight: 700, textAlign: ['Debe','Haber','Saldo'].includes(h) ? 'right' : 'left', textTransform: 'uppercase' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {movements.map(m => (
                    <tr key={m.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '0.625rem 0.875rem', color: '#94a3b8', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{fmtDate(m.movement_date)}</td>
                      <td style={{ padding: '0.625rem 0.875rem' }}>
                        <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '0.15rem 0.4rem', borderRadius: '0.25rem', background: m.type === 'purchase' ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)', color: m.type === 'purchase' ? '#ef4444' : '#22c55e' }}>
                          {m.type === 'purchase' ? 'Compra' : m.type === 'payment' ? 'Pago' : m.type === 'adjustment' ? 'Ajuste' : 'Nota créd.'}
                        </span>
                      </td>
                      <td style={{ padding: '0.625rem 0.875rem', color: '#e2e8f0', fontSize: '0.8rem' }}>{m.description}</td>
                      <td style={{ padding: '0.625rem 0.875rem', textAlign: 'right', color: m.debit > 0 ? '#ef4444' : '#334155', fontWeight: m.debit > 0 ? 700 : 400, fontSize: '0.875rem' }}>
                        {m.debit > 0 ? fmtARS(m.debit) : '—'}
                      </td>
                      <td style={{ padding: '0.625rem 0.875rem', textAlign: 'right', color: m.credit > 0 ? '#22c55e' : '#334155', fontWeight: m.credit > 0 ? 700 : 400, fontSize: '0.875rem' }}>
                        {m.credit > 0 ? fmtARS(m.credit) : '—'}
                      </td>
                      <td style={{ padding: '0.625rem 0.875rem', textAlign: 'right', fontWeight: 700, color: m.balance_after > 0 ? '#f59e0b' : '#22c55e', fontSize: '0.875rem' }}>
                        {fmtARS(m.balance_after)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ background: 'rgba(255,255,255,0.04)', borderTop: '2px solid rgba(255,255,255,0.1)' }}>
                    <td colSpan={4} style={{ padding: '0.75rem 0.875rem', fontWeight: 700, color: '#94a3b8', fontSize: '0.8rem' }}>Saldo actual</td>
                    <td colSpan={2} style={{ padding: '0.75rem 0.875rem', textAlign: 'right', fontWeight: 800, fontSize: '1rem', color: s.pending_amount > 0 ? '#f59e0b' : '#22c55e' }}>
                      {fmtARS(s.pending_amount)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab: Pagos */}
      {activeTab === 'pagos' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
            <button style={{ ...btnPrimary, background: 'linear-gradient(135deg,#22c55e,#16a34a)' }} onClick={() => { setDefaultPurchaseId(null); setShowModalPayment(true) }}>
              <Plus size={13} /> Registrar pago
            </button>
          </div>
          {payments.length === 0 ? (
            <div style={{ ...cardS, textAlign: 'center', padding: '3rem', color: '#475569' }}>
              <Banknote size={32} style={{ marginBottom: '0.75rem', opacity: 0.3 }} />
              <p>No hay pagos registrados a este proveedor.</p>
            </div>
          ) : (
            <div style={{ ...cardS, padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                    {['Fecha', 'Monto', 'Método', 'Notas'].map(h => (
                      <th key={h} style={{ padding: '0.625rem 0.875rem', fontSize: '0.65rem', color: '#475569', fontWeight: 700, textAlign: h === 'Monto' ? 'right' : 'left', textTransform: 'uppercase' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '0.75rem 0.875rem', color: '#94a3b8', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{fmtDate(p.payment_date)}</td>
                      <td style={{ padding: '0.75rem 0.875rem', textAlign: 'right', fontWeight: 700, color: '#22c55e', fontSize: '1rem' }}>{fmtARS(p.amount)}</td>
                      <td style={{ padding: '0.75rem 0.875rem', color: '#94a3b8', fontSize: '0.8rem' }}>{PAYMENT_METHOD_LABELS[p.payment_method] || p.payment_method}</td>
                      <td style={{ padding: '0.75rem 0.875rem', color: '#64748b', fontSize: '0.8rem' }}>{p.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab: Notas */}
      {activeTab === 'notas' && (
        <div>
          <NoteEditor supplier={s} businessId={businessId || ''} onSaved={refreshDetail} />
        </div>
      )}

      {/* Modals en detalle */}
      {showModalSupplier && (
        <ModalSupplierForm onClose={() => { setShowModalSupplier(false); setEditingSupplier(null) }}
          onSaved={() => { setShowModalSupplier(false); setEditingSupplier(null); refreshDetail() }}
          editing={editingSupplier} businessId={businessId || ''} userId={user?.id || ''} />
      )}
      {showModalPurchase && (
        <ModalNuevaCompra onClose={() => setShowModalPurchase(false)}
          onSaved={() => { setShowModalPurchase(false); refreshDetail() }}
          supplier={s} businessId={businessId || ''} userId={user?.id || ''} />
      )}
      {showModalPayment && (
        <ModalRegistrarPago onClose={() => { setShowModalPayment(false); setDefaultPurchaseId(null) }}
          onSaved={() => { setShowModalPayment(false); setDefaultPurchaseId(null); refreshDetail() }}
          supplier={s} purchases={purchases} businessId={businessId || ''} userId={user?.id || ''}
          defaultPurchaseId={defaultPurchaseId} />
      )}
      {viewingPurchase && (
        <ModalVerCompra purchase={viewingPurchase} onClose={() => setViewingPurchase(null)} />
      )}
    </div>
  )
}

// ─── Inline note editor ───────────────────────────────────────────────────────

function NoteEditor({ supplier, businessId, onSaved }: { supplier: SupplierWithStats; businessId: string; onSaved: () => void }) {
  const [notes, setNotes] = useState(supplier.internal_notes || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await suppliersService.updateSupplier(supplier.id, { internal_notes: notes }, businessId)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      onSaved()
    } catch (e: any) { alert(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div style={cardS}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <label style={labelS}>Notas internas del proveedor</label>
        <button style={{ ...btnPrimary, fontSize: '0.75rem', padding: '0.375rem 0.75rem' }} onClick={handleSave} disabled={saving}>
          {saved ? <><CheckCircle size={13} /> Guardado</> : saving ? 'Guardando...' : 'Guardar notas'}
        </button>
      </div>
      <textarea style={{ ...inputS, minHeight: 200, resize: 'vertical' as const, fontSize: '0.875rem', lineHeight: 1.6 }}
        value={notes} onChange={e => setNotes(e.target.value)}
        placeholder={'Ej:\n• Entrega rápido en menos de 48hs\n• Tiene buenos precios en pantallas\n• No comprar baterías, fallaron varias\n• Pide seña para pedidos grandes'} />
      <p style={{ margin: '0.5rem 0 0', fontSize: '0.72rem', color: '#475569' }}>Estas notas son solo internas y no se muestran al proveedor.</p>
    </div>
  )
}
