import { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react'
import { TimelineView } from '../components/shared/TimelineView'
import { useEntityTimeline } from '../hooks/useEntityTimeline'
import {
  Truck, Plus, Search, Edit2, Trash2, Eye, ChevronLeft,
  Phone, Mail, MapPin, AlertCircle,
  CheckCircle, Clock, X, CreditCard, MessageCircle,
  FileText, TrendingUp, ShoppingCart, Banknote, RefreshCw, Wallet, Minus,
  Package, Settings2,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { smartSearch, buildSupabaseQuery } from '../utils/searchUtils'
import { ProductFormModalSafe as ProductFormModal } from '../components/products/ProductFormModal'
import type { InventoryItem } from '../hooks/useInventory'
import type { ProductVariant } from '../services/productService'
import suppliersService, {
  type SupplierWithStats,
  type SupplierPurchase,
  type SupplierPayment, type AccountMovement,
} from '../services/suppliersService'

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = ['Repuestos', 'Accesorios', 'Equipos usados', 'Herramientas', 'Insumos', 'Servicios', 'Mayorista', 'Electrónica', 'Otro']
const FISCAL_CONDITIONS = ['Responsable Inscripto', 'Monotributista', 'Exento', 'Consumidor Final', 'No categorizado']
const PAYMENT_METHODS = ['efectivo', 'transferencia', 'tarjeta', 'dolares', 'cheque', 'otro']
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  efectivo: 'Efectivo', transferencia: 'Transferencia',
  tarjeta: 'Tarjeta', dolares: 'Dólares', cheque: 'Cheque', otro: 'Otro',
}

// ─── Style helpers ────────────────────────────────────────────────────────────

// Alias CSS-in-JS mínimos — sólo donde no alcanza con className
const cardS: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)',
  borderRadius: '0.875rem', padding: '1.25rem',
}

const fmtARS = (n: number) => '$' + Math.round(n).toLocaleString('es-AR')
import { fmtDateFull as _fmtDateFull } from '../utils/dateUtils'
const fmtDate = (d: string | null) => d ? _fmtDateFull(d) : '—'
const daysSince = (d: string | null) => {
  if (!d) return null
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000)
}

function StatusBadge({ status }: { status: 'pending' | 'partial' | 'paid' }) {
  const map = {
    pending: { label: 'Pendiente', cls: 'badge-error' },
    partial: { label: 'Parcial',   cls: 'badge-warning' },
    paid:    { label: 'Pagada',    cls: 'badge-success' },
  }
  const { label, cls } = map[status]
  return <span className={`badge ${cls}`}>{label}</span>
}

// ─── Modal Overlay ────────────────────────────────────────────────────────────

function ModalOverlay({ onClose, children, maxWidth = '640px' }: { onClose: () => void; children: React.ReactNode; maxWidth?: string }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: '1.25rem', width: '100%', maxWidth, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-xl)' }}>
        {children}
      </div>
    </div>
  )
}

/** Área de contenido scrolleable — se usa dentro de ModalOverlay para que el header/footer queden fijos */
function ModalBody({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {children}
    </div>
  )
}

/** Footer fijo al fondo del modal */
function ModalFooter({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.5rem', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-card)', borderRadius: '0 0 1.25rem 1.25rem' }}>
      {children}
    </div>
  )
}

function ModalHeader({ title, subtitle, icon, onClose }: { title: string; subtitle?: string; icon?: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem 1rem', borderBottom: '1px solid var(--border-subtle)', position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 1, borderRadius: '1.25rem 1.25rem 0 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        {icon && <div style={{ width: 36, height: 36, borderRadius: '0.625rem', background: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</div>}
        <div>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</h2>
          {subtitle && <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text-muted)' }}>{subtitle}</p>}
        </div>
      </div>
      <button onClick={onClose} className="icon-btn" aria-label="Cerrar"><X size={16} /></button>
    </div>
  )
}

// ─── Form field helpers (definidos fuera para evitar remount en cada keystroke) ─

function SField({ form, set, label, name, type = 'text', placeholder = '', required = false }: {
  form: Record<string, any>; set: (k: string, v: any) => void
  label: string; name: string; type?: string; placeholder?: string; required?: boolean
}) {
  return (
    <div>
      <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>{label}{required && ' *'}</label>
      <input className="form-control" type={type} value={form[name] || ''} placeholder={placeholder}
        onChange={e => set(name, e.target.value)} />
    </div>
  )
}

function SSelect({ form, set, label, name, options }: {
  form: Record<string, any>; set: (k: string, v: any) => void
  label: string; name: string; options: string[]
}) {
  return (
    <div>
      <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>{label}</label>
      <select className="form-select" value={form[name] || ''} onChange={e => set(name, e.target.value)}>
        <option value="">— Seleccionar —</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
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

  const set = useCallback((k: string, v: any) => setForm(p => ({ ...p, [k]: v })), [])

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

  // SField y SSelect están definidos fuera del componente para evitar remount en cada keystroke

  return (
    <ModalOverlay onClose={onClose} maxWidth="700px">
      <ModalHeader title={editing ? 'Editar proveedor' : 'Nuevo proveedor'} subtitle="Datos del proveedor" icon={<Truck size={18} style={{ color: '#818cf8' }} />} onClose={onClose} />

      {/* Tabs internos */}
      <div style={{ display: 'flex', gap: '0.25rem', padding: '1rem 1.5rem 0', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        {(['principal', 'comercial'] as const).map(s => (
          <button key={s} onClick={() => setSection(s)} style={{ padding: '0.5rem 1rem', borderRadius: '0.5rem 0.5rem 0 0', border: 'none', background: section === s ? 'rgba(99,102,241,0.15)' : 'transparent', color: section === s ? '#818cf8' : '#64748b', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer' }}>
            {s === 'principal' ? 'Datos principales' : 'Datos comerciales'}
          </button>
        ))}
      </div>

      <ModalBody>
        {section === 'principal' ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <SField form={form} set={set} label="Nombre comercial" name="name" required placeholder="Ej: Distribuidora Norte" />
              <SField form={form} set={set} label="Razón social" name="business_name" placeholder="Ej: Norte SA" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <SField form={form} set={set} label="CUIT / DNI" name="tax_id" placeholder="20-12345678-9" />
              <SSelect form={form} set={set} label="Condición fiscal" name="fiscal_condition" options={FISCAL_CONDITIONS} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <SField form={form} set={set} label="Teléfono" name="phone" placeholder="+54 9 351 123 4567" />
              <SField form={form} set={set} label="WhatsApp" name="whatsapp" placeholder="+54 9 351 123 4567" />
            </div>
            <SField form={form} set={set} label="Email" name="email" type="email" placeholder="proveedor@email.com" />
            <SField form={form} set={set} label="Dirección" name="address" placeholder="Av. Ejemplo 1234" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
              <SField form={form} set={set} label="Ciudad" name="city" />
              <SField form={form} set={set} label="Provincia" name="province" />
              <SField form={form} set={set} label="País" name="country" />
            </div>
            <div>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Estado</label>
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
              <SSelect form={form} set={set} label="Rubro / Categoría" name="category" options={CATEGORIES} />
              <SField form={form} set={set} label="Nombre del contacto" name="contact_name" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <SField form={form} set={set} label="Días habituales de entrega" name="delivery_days" placeholder="Ej: Lunes y jueves" />
              <SSelect form={form} set={set} label="Método de pago preferido" name="payment_method_preferred" options={PAYMENT_METHODS.map(m => PAYMENT_METHOD_LABELS[m] || m)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <SField form={form} set={set} label="Alias bancario" name="bank_alias" placeholder="proveedor.alias" />
              <SField form={form} set={set} label="CBU" name="bank_cbu" placeholder="0000000000000000000000" />
            </div>
            <SField form={form} set={set} label="Web / Instagram / Catálogo" name="website" placeholder="https://..." />
            <div>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Notas internas</label>
              <textarea className="form-control" style={{ minHeight: 80, resize: 'vertical' as const }}
                value={form.internal_notes || ''} onChange={e => set('internal_notes', e.target.value)}
                placeholder="Observaciones internas, condiciones, advertencias..." />
            </div>
          </>
        )}
        {error && <p style={{ margin: 0, color: '#ef4444', fontSize: '0.8rem' }}>{error}</p>}
      </ModalBody>

      <ModalFooter>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary btn-lift" onClick={handleSave} disabled={saving}>
          {saving ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle size={14} />}
          {saving ? 'Guardando...' : editing ? 'Guardar cambios' : 'Crear proveedor'}
        </button>
      </ModalFooter>
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
  const [showProductForm, setShowProductForm] = useState(false)
  const [productFormRowKey, setProductFormRowKey] = useState<string | null>(null)

  function newRow(): PurchaseItemRow {
    return { _key: crypto.randomUUID(), inventory_id: null, product_name: '', quantity: 1, unit_cost: 0, searchQ: '', searchResults: [] }
  }

  const totalAmount = rows.reduce((s, r) => s + r.quantity * r.unit_cost, 0)
  const pendingAmount = Math.max(0, totalAmount - paidAmount)
  // Métodos del grid visual (no cambia lógica de guardado)
  const PROV_METHODS = [
    { id: 'efectivo',      label: 'Efectivo',      short: 'Efec.',    color: '#22c55e' },
    { id: 'transferencia', label: 'Transferencia', short: 'Trans.',   color: '#3b82f6' },
    { id: 'tarjeta',       label: 'Tarjeta',       short: 'Tarj.',    color: '#f59e0b' },
    { id: 'cheque',        label: 'Cheque',        short: 'Cheque',   color: '#94a3b8' },
    { id: 'dolares',       label: 'Dólares',       short: 'USD',      color: '#22c55e' },
    { id: 'otro',          label: 'Otro',          short: 'Otro',     color: '#64748b' },
  ]

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

  const F = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
  const iS: React.CSSProperties = { width: '100%', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: '#f0f4ff', fontSize: '0.82rem', outline: 'none', fontFamily: F, boxSizing: 'border-box' as const }
  const lS: React.CSSProperties = { display: 'block', fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-tertiary)', marginBottom: '0.3rem', textTransform: 'uppercase' as const, letterSpacing: '0.06em' }

  return (
    <>
    {/* ── MODAL DOS COLUMNAS — misma filosofía que ComprobanteProModal ── */}
    <div onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.82)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.5rem', fontFamily: F }}>
      <div style={{ background: '#0a1628', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '1.25rem', width: '100%', maxWidth: '1080px', height: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 40px 100px rgba(0,0,0,0.9)', overflow: 'hidden' }}>

        {/* HEADER */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1.25rem', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0, background: 'linear-gradient(180deg,#0f1f3d 0%,#0a1628 100%)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: 34, height: 34, borderRadius: '0.5rem', background: 'rgba(99,102,241,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <ShoppingCart size={16} color="#818cf8" />
            </div>
            <div>
              <div style={{ color: '#f1f5f9', fontWeight: 800, fontSize: '0.9375rem', letterSpacing: '-0.02em' }}>Nueva compra</div>
              <div style={{ color: 'var(--text-subtle)', fontSize: '0.72rem', marginTop: '0.05rem' }}>Registrar factura a {supplier.name}</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', cursor: 'pointer', color: 'var(--text-muted)', padding: '0.375rem', borderRadius: '0.5rem', display: 'flex', alignItems: 'center', transition: 'all 0.1s' }}>
            <X size={16} />
          </button>
        </div>

        {/* BODY: 2 COLUMNAS */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* ── IZQUIERDA: meta + productos + notas ── */}
          <div style={{ flex: 1, overflow: 'auto', padding: '0.875rem 1.125rem', display: 'flex', flexDirection: 'column', gap: '0.875rem', borderRight: '2px solid rgba(255,255,255,0.06)' }}>

            {/* Fecha + Nro. Factura */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.625rem' }}>
              <div>
                <label style={lS}>Fecha de compra</label>
                <input style={iS} type="date" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} />
              </div>
              <div>
                <label style={lS}>N° Factura / remito</label>
                <input style={iS} value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} placeholder="A-0001-00123" />
              </div>
            </div>

            {/* PRODUCTOS — cards premium */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  Productos ({rows.filter(r => r.product_name.trim()).length})
                </span>
                <button onClick={() => setRows(p => [...p, newRow()])}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.25rem 0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.375rem', color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                  <Plus size={11} /> Agregar fila
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {rows.map(row => {
                  const subtotal = row.quantity * row.unit_cost
                  return (
                    <div key={row._key}
                      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.75rem', padding: '0.625rem 0.875rem', display: 'flex', alignItems: 'center', gap: '0.625rem', transition: 'border-color 0.12s' }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(99,102,241,0.2)')}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}>
                      {/* Icono */}
                      <div style={{ width: 32, height: 32, borderRadius: '0.5rem', background: 'rgba(99,102,241,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <ShoppingCart size={14} color="var(--text-muted)" />
                      </div>
                      {/* Search */}
                      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                        <input value={row.searchQ}
                          onChange={e => searchProduct(row._key, e.target.value)}
                          placeholder="Buscar o escribir producto..."
                          style={{ width: '100%', background: 'none', border: 'none', outline: 'none', color: '#f0f4ff', fontSize: '0.875rem', fontWeight: 600, fontFamily: F, padding: 0 }} />
                        {row.inventory_id && <div style={{ fontSize: '0.68rem', color: 'var(--accent-primary)', marginTop: '0.1rem' }}>Vinculado al inventario</div>}
                        {(row.searchResults.length > 0 || (row.searchQ.trim().length >= 2 && !row.inventory_id)) && (
                          <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 200, background: '#0c1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.625rem', boxShadow: '0 12px 40px rgba(0,0,0,0.7)', overflow: 'hidden' }}>
                            {row.searchResults.length === 0 && (
                              <div style={{ padding: '0.625rem 0.875rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>Sin resultados para "{row.searchQ.trim()}"</div>
                            )}
                            {row.searchResults.map((p: any) => (
                              <button key={p.id} onMouseDown={() => selectProduct(row._key, p)}
                                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0.5rem 0.875rem', background: 'none', border: 'none', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.04)', textAlign: 'left', fontFamily: F }}
                                onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.08)'}
                                onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                                <span style={{ color: '#f0f4ff', fontSize: '0.83rem' }}>{p.name}{p.variant_name ? ` — ${p.variant_name}` : ''}</span>
                                <span style={{ color: 'var(--text-subtle)', fontSize: '0.72rem', flexShrink: 0, marginLeft: '0.5rem' }}>stock: {p.stock_quantity}</span>
                              </button>
                            ))}
                            <button onMouseDown={() => { setProductFormRowKey(row._key); setShowProductForm(true); updateRow(row._key, { searchResults: [] }) }}
                              style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', width: '100%', padding: '0.45rem 0.875rem', background: 'rgba(99,102,241,0.07)', border: 'none', cursor: 'pointer', color: '#818cf8', fontSize: '0.75rem', fontWeight: 700, fontFamily: F, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                              <Plus size={11} /> Crear producto completo: "{row.searchQ.trim()}"
                            </button>
                          </div>
                        )}
                      </div>
                      {/* Qty +/- */}
                      <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', overflow: 'hidden', flexShrink: 0 }}>
                        <button onClick={() => updateRow(row._key, { quantity: Math.max(1, row.quantity - 1) })}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem 0.375rem', display: 'flex', alignItems: 'center', fontFamily: F }}>
                          <Minus size={11} />
                        </button>
                        <input type="number" min={1} value={row.quantity}
                          onChange={e => updateRow(row._key, { quantity: +e.target.value || 1 })}
                          style={{ width: '2.5rem', textAlign: 'center', background: 'none', border: 'none', outline: 'none', color: '#f0f4ff', fontSize: '0.82rem', fontWeight: 700, fontFamily: F, padding: '0.25rem 0' }} />
                        <button onClick={() => updateRow(row._key, { quantity: row.quantity + 1 })}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem 0.375rem', display: 'flex', alignItems: 'center', fontFamily: F }}>
                          <Plus size={11} />
                        </button>
                      </div>
                      {/* Costo unit. */}
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <span style={{ position: 'absolute', left: '0.4rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '0.68rem' }}>$</span>
                        <input type="number" min={0} value={row.unit_cost || ''}
                          onChange={e => updateRow(row._key, { unit_cost: +e.target.value || 0 })}
                          placeholder="0"
                          style={{ width: '6rem', paddingLeft: '1rem', paddingRight: '0.4rem', paddingTop: '0.3rem', paddingBottom: '0.3rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#f0f4ff', fontSize: '0.82rem', fontWeight: 600, outline: 'none', textAlign: 'right', fontFamily: F }} />
                      </div>
                      {/* Subtotal */}
                      <div style={{ textAlign: 'right', minWidth: '5rem', flexShrink: 0 }}>
                        <div style={{ color: '#f0f4ff', fontSize: '0.875rem', fontWeight: 800 }}>{fmtARS(subtotal)}</div>
                      </div>
                      {/* Delete */}
                      <button onClick={() => rows.length > 1 && setRows(p => p.filter(r => r._key !== row._key))} disabled={rows.length === 1}
                        style={{ background: 'none', border: 'none', cursor: rows.length === 1 ? 'not-allowed' : 'pointer', color: '#ef4444', opacity: rows.length === 1 ? 0.2 : 0.5, padding: '0.2rem', display: 'flex', alignItems: 'center', flexShrink: 0, transition: 'opacity 0.1s' }}
                        onMouseEnter={e => { if (rows.length > 1) e.currentTarget.style.opacity = '1' }}
                        onMouseLeave={e => { e.currentTarget.style.opacity = rows.length === 1 ? '0.2' : '0.5' }}>
                        <X size={13} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Notas */}
            <div>
              <label style={lS}>Notas</label>
              <textarea style={{ ...iS, minHeight: 60, resize: 'vertical' as const }} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Observaciones de la compra..." />
            </div>
          </div>

          {/* ── DERECHA: panel financiero sticky ── */}
          <div style={{ width: 380, display: 'flex', flexDirection: 'column', background: '#07101f', flexShrink: 0 }}>

            {/* Supplier badge */}
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Truck size={16} color="#818cf8" />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#f1f5f9', fontWeight: 700, fontSize: '0.9rem' }}>{supplier.name}</div>
                  {supplier.pending_amount > 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.72rem', color: '#f59e0b', marginTop: '0.1rem' }}>
                      <Wallet size={11} /> Deuda previa: {fmtARS(supplier.pending_amount)}
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.72rem', color: '#22c55e', marginTop: '0.1rem', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                      <CheckCircle size={11} /> Sin deuda pendiente
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* TOTAL grande — siempre visible */}
            <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
              <div style={{ color: '#334155', fontSize: '0.72rem', fontWeight: 600, marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Total de compra</div>
              <div style={{ color: totalAmount > 0 ? '#f0f4ff' : '#1e3a5f', fontSize: '2.25rem', fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1, transition: 'color 0.2s' }}>
                {totalAmount > 0 ? fmtARS(totalAmount) : '$0'}
              </div>
              {totalAmount === 0 && (
                <div style={{ color: '#1e3a5f', fontSize: '0.72rem', marginTop: '0.3rem' }}>Agregá productos para ver el total</div>
              )}
            </div>

            {/* ESTADO + MÉTODOS + RESUMEN */}
            <div style={{ padding: '0.875rem 1rem', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>

              {/* 3 estados de pago */}
              <div>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.375rem' }}>Estado de pago</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.3rem' }}>
                  {[
                    { label: 'A CC', sub: 'Todo a deber', icon: <Wallet size={12} />, value: 0 as number, color: '#818cf8', bg: 'rgba(99,102,241,0.12)', border: 'rgba(99,102,241,0.4)', active: paidAmount <= 0 },
                    { label: 'Parcial', sub: 'Paga algo hoy', icon: <Banknote size={12} />, value: -1 as number, color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.35)', active: paidAmount > 0 && paidAmount < totalAmount },
                    { label: 'Pagado', sub: 'Factura saldada', icon: <CheckCircle size={12} />, value: totalAmount, color: '#22c55e', bg: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.35)', active: paidAmount >= totalAmount && totalAmount > 0 },
                  ].map(opt => (
                    <button key={opt.label}
                      onClick={() => opt.value === -1 ? setPaidAmount(Math.round(totalAmount / 2)) : setPaidAmount(opt.value as number)}
                      style={{ padding: '0.5rem 0.25rem', borderRadius: '0.5rem', border: `1px solid ${opt.active ? opt.border : 'rgba(255,255,255,0.07)'}`, background: opt.active ? opt.bg : 'rgba(255,255,255,0.02)', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.15rem', transition: 'all 0.1s', fontFamily: F }}>
                      <span style={{ color: opt.active ? opt.color : 'var(--text-muted)' }}>{opt.icon}</span>
                      <span style={{ color: opt.active ? opt.color : 'var(--text-muted)', fontSize: '0.72rem', fontWeight: opt.active ? 800 : 500 }}>{opt.label}</span>
                      <span style={{ color: opt.active ? opt.color : 'var(--text-subtle)', fontSize: '0.6rem', opacity: 0.8 }}>{opt.sub}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Métodos de pago — grid premium */}
              <div>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.3rem' }}>Método de pago</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.3rem' }}>
                  {PROV_METHODS.map(m => {
                    const active = paymentMethod === m.id
                    return (
                      <button key={m.id} onClick={() => setPaymentMethod(m.id)}
                        style={{ padding: '0.4rem 0.25rem', borderRadius: '0.5rem', border: `1px solid ${active ? m.color + '80' : 'rgba(255,255,255,0.06)'}`, background: active ? m.color + '20' : 'rgba(255,255,255,0.02)', color: active ? m.color : 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: active ? 700 : 500, cursor: 'pointer', transition: 'all 0.1s', textAlign: 'center', fontFamily: F }}
                        onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = active ? m.color + '20' : 'rgba(255,255,255,0.02)' }}>
                        {m.short}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Input monto — solo en pago parcial */}
              {paidAmount > 0 && paidAmount < totalAmount && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  <div>
                    <label style={{ ...lS, marginBottom: '0.25rem' }}>Pagado ahora</label>
                    <input style={{ ...iS, fontSize: '0.95rem', fontWeight: 700 }} type="number" min={0} max={totalAmount}
                      value={paidAmount || ''} onChange={e => setPaidAmount(Math.min(totalAmount, +e.target.value || 0))} placeholder="$" />
                  </div>
                  <div>
                    <label style={{ ...lS, color: '#818cf8', marginBottom: '0.25rem' }}>Va a CC</label>
                    <div style={{ ...iS, color: '#818cf8', fontWeight: 800, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'rgba(99,102,241,0.06)', borderColor: 'rgba(99,102,241,0.25)' }}>
                      <Wallet size={13} color="#818cf8" /> {fmtARS(pendingAmount)}
                    </div>
                  </div>
                </div>
              )}

              {/* Resumen financiero — siempre visible */}
              <div style={{ background: 'rgba(0,0,0,0.25)', borderRadius: '0.625rem', padding: '0.625rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.225rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '0.2rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', fontWeight: 600 }}>Total factura</span>
                  <span style={{ fontSize: '0.72rem', color: totalAmount > 0 ? '#94a3b8' : 'var(--text-subtle)', fontWeight: 700 }}>{fmtARS(totalAmount)}</span>
                </div>
                {totalAmount === 0 ? (
                  <div style={{ color: 'var(--text-subtle)', fontSize: '0.72rem', padding: '0.25rem 0', fontStyle: 'italic' }}>
                    El resumen aparecerá al agregar productos
                  </div>
                ) : (
                  <>
                    {paidAmount > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Pagado ({PROV_METHODS.find(m => m.id === paymentMethod)?.label ?? paymentMethod})</span>
                        <span style={{ fontSize: '0.75rem', color: '#22c55e', fontWeight: 700 }}>{fmtARS(paidAmount)}</span>
                      </div>
                    )}
                    {pendingAmount > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.15rem' }}>
                        <span style={{ fontSize: '0.78rem', color: '#818cf8', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <Wallet size={12} /> CC {supplier.name}
                        </span>
                        <span style={{ fontSize: '0.9rem', color: '#818cf8', fontWeight: 900 }}>{fmtARS(pendingAmount)}</span>
                      </div>
                    )}
                    {pendingAmount <= 0 && totalAmount > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: '#22c55e', fontSize: '0.75rem', fontWeight: 700 }}>
                        <CheckCircle size={12} /> Factura saldada completamente
                      </div>
                    )}
                    {pendingAmount > 0 && supplier.pending_amount > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '0.2rem', borderTop: '1px solid rgba(245,158,11,0.15)', marginTop: '0.1rem' }}>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Nueva deuda con {supplier.name}</span>
                        <span style={{ fontSize: '0.8rem', color: '#f59e0b', fontWeight: 900 }}>{fmtARS(supplier.pending_amount + pendingAmount)}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* FOOTER: error + botón registrar */}
            <div style={{ padding: '0.875rem 1rem', borderTop: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
              {error && (
                <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.5rem', padding: '0.5rem 0.625rem', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)', borderRadius: '0.5rem' }}>
                  <AlertCircle size={13} color="#f87171" style={{ flexShrink: 0 }} />
                  <span style={{ color: '#f87171', fontSize: '0.72rem' }}>{error}</span>
                </div>
              )}
              <button onClick={handleSave} disabled={saving}
                style={{ width: '100%', padding: '0.875rem 1rem', borderRadius: '0.75rem', border: 'none', background: saving ? 'rgba(99,102,241,0.4)' : 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontSize: '0.9375rem', fontWeight: 800, cursor: saving ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', fontFamily: F, boxShadow: saving ? 'none' : '0 4px 20px rgba(99,102,241,0.4)', transition: 'all 0.15s' }}>
                {saving ? (
                  <><RefreshCw size={15} style={{ animation: 'tr-spin 0.8s linear infinite' }} /> Registrando...</>
                ) : (
                  <><ShoppingCart size={15} /> {totalAmount > 0 ? `Registrar ${fmtARS(totalAmount)}` : 'Registrar compra'}</>
                )}
              </button>
              <button onClick={onClose} style={{ width: '100%', marginTop: '0.375rem', padding: '0.375rem', background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '0.78rem', cursor: 'pointer', fontFamily: F }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    {/* ProductFormModal — crear producto completo desde factura de proveedor
        registerStock=false: el stock se suma al registrar la compra en handleSave */}
    <ProductFormModal
      isOpen={showProductForm}
      onClose={() => { setShowProductForm(false); setProductFormRowKey(null) }}
      onCreated={(product: InventoryItem) => {
        if (productFormRowKey) {
          selectProduct(productFormRowKey, {
            id: product.id, name: product.name, variant_name: undefined,
            cost_price: product.cost_price, stock_quantity: product.stock_quantity,
          })
        }
        setShowProductForm(false); setProductFormRowKey(null)
      }}
      onVariantSelected={(variantInventory: InventoryItem, variantMeta: ProductVariant) => {
        if (productFormRowKey) {
          selectProduct(productFormRowKey, {
            id: variantInventory.id,
            name: variantInventory.name,
            variant_name: variantMeta.name,
            cost_price: variantMeta.cost_price_ars,
            stock_quantity: variantMeta.stock,
          })
        }
        setShowProductForm(false); setProductFormRowKey(null)
      }}
      initialName={productFormRowKey ? (rows.find(r => r._key === productFormRowKey)?.searchQ ?? '') : ''}
      initialCost={productFormRowKey ? (rows.find(r => r._key === productFormRowKey)?.unit_cost || undefined) : undefined}
      initialQuantity={productFormRowKey ? (rows.find(r => r._key === productFormRowKey)?.quantity ?? 1) : 1}
      supplierId={supplier.id}
      supplierName={supplier.name}
      registerStock={false}
      sourceType="supplier_invoice"
    />
    </>
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

      <ModalBody>
        <div style={{ ...cardS, background: 'rgba(239,68,68,0.06)', borderColor: 'rgba(239,68,68,0.2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Saldo pendiente con proveedor</span>
          <span style={{ fontSize: '1.25rem', fontWeight: 800, color: '#ef4444' }}>{fmtARS(supplier.pending_amount)}</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Fecha</label>
            <input className="form-control" type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Método de pago</label>
            <select className="form-control" value={method} onChange={e => setMethod(e.target.value)}>
              {PAYMENT_METHODS.map(m => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Monto *</label>
          <input className="form-control" style={{ fontSize: '1.25rem', fontWeight: 700, textAlign: 'right' }} type="number" min={0}
            value={amount || ''} onChange={e => setAmount(+e.target.value || 0)} placeholder="$ 0" />
        </div>

        {pendingPurchases.length > 0 && (
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Compra asociada (opcional)</label>
            <select className="form-control" value={purchaseId} onChange={e => setPurchaseId(e.target.value)}>
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
          <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Notas</label>
          <textarea className="form-control" style={{ minHeight: 64, resize: 'vertical' as const }} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Observaciones del pago..." />
        </div>
        {error && <p style={{ margin: 0, color: '#ef4444', fontSize: '0.8rem' }}>{error}</p>}
      </ModalBody>

      <ModalFooter>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-success btn-lift" onClick={handleSave} disabled={saving}>
          {saving ? <RefreshCw size={14} style={{ animation: 'tr-spin 1s linear infinite' }} /> : <Banknote size={14} />}
          {saving ? 'Guardando...' : 'Registrar pago'}
        </button>
      </ModalFooter>
    </ModalOverlay>
  )
}

// ─── Modal: Ver compra ────────────────────────────────────────────────────────

function ModalVerCompra({ purchase, onClose }: { purchase: SupplierPurchase; onClose: () => void }) {
  return (
    <ModalOverlay onClose={onClose} maxWidth="620px">
      <ModalHeader title={`Compra${purchase.invoice_number ? ' #' + purchase.invoice_number : ''}`} subtitle={fmtDate(purchase.purchase_date)} icon={<FileText size={18} style={{ color: '#818cf8' }} />} onClose={onClose} />

      <ModalBody>
        {/* Items */}
        <div>
          <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Productos</label>
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
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Notas</label>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.875rem' }}>{purchase.notes}</p>
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        <button className="btn btn-ghost" onClick={onClose}>Cerrar</button>
      </ModalFooter>
    </ModalOverlay>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

type FilterKey = 'all' | 'active' | 'inactive' | 'with_debt' | 'no_debt'
type SortKey = 'name' | 'total_purchases' | 'pending_amount' | 'last_purchase_date'
type TabKey = 'compras' | 'cuenta' | 'pagos' | 'notas' | 'productos' | 'datos'

// ─── SupplierTimeline ─────────────────────────────────────────────────────────

const SupplierTimeline = memo(function SupplierTimeline({
  supplierId, businessId, refreshTick,
}: { supplierId: string; businessId: string; refreshTick: number }) {
  const { events, loading } = useEntityTimeline({
    entityKind: 'supplier_account',
    entityId:   supplierId,
    businessId,
    limit:      200,
    enabled:    !!supplierId && !!businessId,
  })
  void refreshTick
  return (
    <TimelineView
      events={events}
      loading={loading}
      emptyTitle="Sin movimientos"
      emptyDesc="Las compras y pagos a este proveedor aparecerán aquí."
      compact
    />
  )
})

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
  const [deletePurchaseError, setDeletePurchaseError] = useState<string | null>(null)
  // Datos tab inline-edit
  const [editForm, setEditForm] = useState<Partial<SupplierWithStats>>({})

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
    setDeletePurchaseError(null)
    loadDetail(id)
  }

  const handleDeletePurchase = async (p: SupplierPurchase) => {
    if (!businessId || !user?.id) return
    if (!confirm(`¿Eliminar compra${p.invoice_number ? ' #' + p.invoice_number : ''}?`)) return
    setDeletePurchaseError(null)
    try {
      const result = await suppliersService.deletePurchaseSafe(p.id, businessId, user.id)
      if (result.blocked) {
        setDeletePurchaseError(result.message || 'No se puede eliminar una compra pagada.')
        return
      }
      refreshDetail()
    } catch (e: any) {
      setDeletePurchaseError(e.message || 'Error al eliminar compra')
    }
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
    <div className="page-shell" data-testid="suppliers-page">
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
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-ghost" data-testid="supplier-new-invoice-button" onClick={() => { /* shortcut: open purchase modal without a supplier — handled from detail */ }}>
            <FileText size={15} /> Nueva factura
          </button>
          <button className="btn btn-primary btn-lift" onClick={() => { setEditingSupplier(null); setShowModalSupplier(true) }}>
            <Plus size={15} /> Nuevo proveedor
          </button>
        </div>
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
          <input className="form-control" style={{ paddingLeft: '2.25rem' }} placeholder="Buscar por nombre, CUIT, rubro, ciudad, teléfono..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
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
          <select className="form-select" style={{ width: 'auto', fontSize: '0.75rem' }} value={sortBy} onChange={e => setSortBy(e.target.value as SortKey)}>
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
                void days  // used below
                return (
                  <tr key={s.id} data-testid="supplier-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', transition: 'background 0.1s' }}
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
                        <button className="icon-btn icon-btn-primary" title="Ver detalle" onClick={() => openDetail(s.id)}><Eye size={15} /></button>
                        <button className="icon-btn icon-btn-violet" title="Editar" onClick={() => { setEditingSupplier(s); setShowModalSupplier(true) }}><Edit2 size={15} /></button>
                        <button className={`icon-btn ${s.active ? '' : 'icon-btn-primary'}`} title={s.active ? 'Desactivar' : 'Activar'} onClick={() => handleToggleActive(s)}>
                          {s.active ? <X size={15} /> : <CheckCircle size={15} />}
                        </button>
                        <button className="icon-btn icon-btn-danger" title="Eliminar" onClick={() => handleDelete(s)}><Trash2 size={15} /></button>
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
    { key: 'compras',   label: 'Compras',          icon: <ShoppingCart size={14} /> },
    { key: 'pagos',     label: 'Pagos',             icon: <Banknote size={14} /> },
    { key: 'cuenta',    label: 'CC',                icon: <CreditCard size={14} /> },
    { key: 'productos', label: 'Productos',         icon: <Package size={14} /> },
    { key: 'datos',     label: 'Datos',             icon: <Settings2 size={14} /> },
    { key: 'notas',     label: 'Notas',             icon: <FileText size={14} /> },
  ]

  // Productos tab: aggregate items across all purchases
  const productosMap = useMemo(() => {
    const map: Record<string, { name: string; qty: number; totalCost: number; purchases: number; inventoryId?: string | null }> = {}
    purchases.forEach(p => (p.items || []).forEach(i => {
      const key = i.inventory_id || i.product_name
      if (!map[key]) map[key] = { name: i.product_name, qty: 0, totalCost: 0, purchases: 0, inventoryId: i.inventory_id }
      map[key].qty       += i.quantity
      map[key].totalCost += i.subtotal
      map[key].purchases += 1
    }))
    return Object.values(map).sort((a, b) => b.qty - a.qty)
  }, [purchases])

  return (
    <div className="page-shell" data-testid="supplier-detail">
      {/* Encabezado detalle */}
      <div style={{ marginBottom: '1.25rem' }}>
        <button className="btn btn-ghost btn-sm" style={{ marginBottom: '0.75rem' }} onClick={backToList}>
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
                className="btn btn-ghost btn-sm" style={{ textDecoration: 'none', color: '#22c55e' }}>
                <MessageCircle size={14} /> WhatsApp
              </a>
            )}
            <button className="btn btn-ghost" onClick={() => { setEditingSupplier(s); setShowModalSupplier(true) }}>
              <Edit2 size={14} /> Editar
            </button>
            <button className="btn btn-ghost btn-sm" style={{ color: '#22c55e' }} onClick={() => { setDefaultPurchaseId(null); setShowModalPayment(true) }}>
              <Banknote size={14} /> Registrar pago
            </button>
            <button className="btn btn-primary btn-lift" onClick={() => setShowModalPurchase(true)}>
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
      <div data-testid="supplier-summary" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
        {[
          { label: 'Total comprado',  value: fmtARS(s.total_purchases), color: '#818cf8', icon: <TrendingUp size={16} /> },
          { label: 'Total pagado',    value: fmtARS(s.total_paid),      color: '#22c55e', icon: <CheckCircle size={16} /> },
          { label: 'Saldo pendiente', value: fmtARS(s.pending_amount),  color: s.pending_amount > 0 ? '#f59e0b' : '#22c55e', icon: <AlertCircle size={16} />, testId: 'supplier-balance' },
          { label: 'Compras',         value: s.purchases_count,         color: '#38bdf8', icon: <ShoppingCart size={16} /> },
        ].map((c, i) => (
          <div key={i} style={cardS} data-testid={c.testId}>
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
      <div className="tabs" style={{ marginBottom: '1.25rem' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`tab tab-sm${activeTab === t.key ? ' tab-active' : ''}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Compras */}
      {activeTab === 'compras' && (
        <div data-testid="supplier-invoices-tab">
          {deletePurchaseError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', borderRadius: '0.625rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', marginBottom: '0.75rem' }}>
              <AlertCircle size={15} style={{ color: '#ef4444', flexShrink: 0 }} />
              <span style={{ color: '#fca5a5', fontSize: '0.875rem', flex: 1 }}>{deletePurchaseError}</span>
              <button className="icon-btn" style={{ flexShrink: 0 }} onClick={() => setDeletePurchaseError(null)}><X size={13} /></button>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
            <button className="btn btn-primary btn-lift" data-testid="supplier-new-invoice-button" onClick={() => setShowModalPurchase(true)}>
              <Plus size={13} /> Nueva compra
            </button>
          </div>
          {purchases.length === 0 ? (
            <div style={{ ...cardS, textAlign: 'center', padding: '3rem', color: '#475569' }}>
              <ShoppingCart size={32} style={{ marginBottom: '0.75rem', opacity: 0.3 }} />
              <p>No hay compras registradas a este proveedor.</p>
              <button className="btn btn-primary btn-sm btn-lift" style={{ marginTop: '0.75rem' }} onClick={() => setShowModalPurchase(true)}><Plus size={13} /> Registrar primera compra</button>
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
                      <td style={{ padding: '0.75rem 0.875rem' }} data-testid="supplier-payment-status"><StatusBadge status={p.payment_status} /></td>
                      <td style={{ padding: '0.75rem 0.625rem' }}>
                        <div style={{ display: 'flex', gap: '0.25rem' }}>
                          <button className="icon-btn icon-btn-primary" title="Ver detalle" onClick={() => setViewingPurchase(p)}><Eye size={14} /></button>
                          {p.payment_status !== 'paid' && (
                            <button className="icon-btn" style={{ color: '#22c55e' }} title="Registrar pago" onClick={() => { setDefaultPurchaseId(p.id); setShowModalPayment(true) }}><Banknote size={14} /></button>
                          )}
                          <button className="icon-btn icon-btn-danger" title={p.paid_amount > 0 ? 'No se puede eliminar (tiene pagos)' : 'Eliminar compra'} onClick={() => handleDeletePurchase(p)} style={{ opacity: p.paid_amount > 0 ? 0.4 : 1 }}><Trash2 size={14} /></button>
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

      {/* Tab: Cuenta corriente — Timeline premium */}
      {activeTab === 'cuenta' && (
        <div style={{ ...cardS, padding: 0, overflow: 'hidden' }}>
          {/* Saldo total sticky */}
          <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.02)' }}>
            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Saldo proveedor</span>
            <span style={{ fontSize: '1.125rem', fontWeight: 800, fontFamily: 'monospace', color: s.pending_amount > 0.01 ? '#f59e0b' : '#34d399' }}>
              {s.pending_amount > 0.01 ? `$${Math.round(s.pending_amount).toLocaleString('es-AR')} a pagar` : 'Al día'}
            </span>
          </div>
          <SupplierTimeline supplierId={s.id} businessId={businessId!} refreshTick={movements.length} />
        </div>
      )}

      {/* Tab: Pagos */}
      {activeTab === 'pagos' && (
        <div data-testid="supplier-payments-tab">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
            <button className="btn btn-success btn-lift" onClick={() => { setDefaultPurchaseId(null); setShowModalPayment(true) }}>
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

      {/* Tab: Productos */}
      {activeTab === 'productos' && (
        <div data-testid="supplier-products-tab">
          {productosMap.length === 0 ? (
            <div style={{ ...cardS, textAlign: 'center', padding: '3rem', color: '#475569' }}>
              <Package size={32} style={{ marginBottom: '0.75rem', opacity: 0.3 }} />
              <p>Sin productos registrados para este proveedor.</p>
            </div>
          ) : (
            <div style={{ ...cardS, padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                    {['Producto', 'En inventario', 'Cant. total', 'Compras', 'Costo total promedio'].map(h => (
                      <th key={h} style={{ padding: '0.625rem 0.875rem', fontSize: '0.65rem', color: '#475569', fontWeight: 700, textAlign: ['Cant. total','Compras','Costo total promedio'].includes(h) ? 'right' : 'left', textTransform: 'uppercase' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {productosMap.map((prod, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <td style={{ padding: '0.75rem 0.875rem', color: '#e2e8f0', fontSize: '0.875rem', fontWeight: 600 }}>{prod.name}</td>
                      <td style={{ padding: '0.75rem 0.875rem' }}>
                        {prod.inventoryId
                          ? <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.4rem', borderRadius: '0.25rem', background: 'rgba(99,102,241,0.12)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.2)' }}>✓ inventario</span>
                          : <span style={{ fontSize: '0.65rem', color: '#475569' }}>—</span>}
                      </td>
                      <td style={{ padding: '0.75rem 0.875rem', textAlign: 'right', color: '#94a3b8', fontSize: '0.875rem' }}>{prod.qty}</td>
                      <td style={{ padding: '0.75rem 0.875rem', textAlign: 'right', color: '#64748b', fontSize: '0.875rem' }}>{prod.purchases}</td>
                      <td style={{ padding: '0.75rem 0.875rem', textAlign: 'right', fontWeight: 600, color: '#e2e8f0', fontSize: '0.875rem' }}>{fmtARS(prod.totalCost / prod.purchases)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab: Datos — inline edit */}
      {activeTab === 'datos' && (
        <DatosTab
          supplier={s}
          businessId={businessId || ''}
          editForm={editForm}
          setEditForm={setEditForm}
          onSaved={() => { refreshDetail(); setActiveTab('compras') }}
        />
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
        <div data-testid="supplier-invoice-modal">
          <ModalNuevaCompra onClose={() => setShowModalPurchase(false)}
            onSaved={() => { setShowModalPurchase(false); refreshDetail() }}
            supplier={s} businessId={businessId || ''} userId={user?.id || ''} />
        </div>
      )}
      {showModalPayment && (
        <div data-testid="supplier-payment-modal">
          <ModalRegistrarPago onClose={() => { setShowModalPayment(false); setDefaultPurchaseId(null) }}
            onSaved={() => { setShowModalPayment(false); setDefaultPurchaseId(null); refreshDetail() }}
            supplier={s} purchases={purchases} businessId={businessId || ''} userId={user?.id || ''}
            defaultPurchaseId={defaultPurchaseId} />
        </div>
      )}
      {viewingPurchase && (
        <ModalVerCompra purchase={viewingPurchase} onClose={() => setViewingPurchase(null)} />
      )}
    </div>
  )
}

// ─── Datos tab — inline supplier editor ──────────────────────────────────────

function DatosTab({
  supplier, businessId, editForm, setEditForm, onSaved,
}: {
  supplier: SupplierWithStats
  businessId: string
  editForm: Partial<SupplierWithStats>
  setEditForm: React.Dispatch<React.SetStateAction<Partial<SupplierWithStats>>>
  onSaved: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  const [saved, setSaved]   = useState(false)

  // Initialise form from supplier on first render / supplier change
  const [initialised, setInitialised] = useState(false)
  useEffect(() => {
    if (!initialised) {
      setEditForm({
        name: supplier.name, business_name: supplier.business_name,
        tax_id: supplier.tax_id, fiscal_condition: supplier.fiscal_condition,
        phone: supplier.phone, whatsapp: supplier.whatsapp,
        email: supplier.email, address: supplier.address,
        city: supplier.city, province: supplier.province,
        category: supplier.category, contact_name: supplier.contact_name,
        delivery_days: supplier.delivery_days,
        payment_method_preferred: supplier.payment_method_preferred,
        bank_alias: supplier.bank_alias, bank_cbu: supplier.bank_cbu,
        website: supplier.website,
        active: supplier.active,
      })
      setInitialised(true)
    }
  }, [supplier, initialised, setEditForm])

  const set = (k: string, v: string | boolean) => setEditForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    if (!editForm.name?.trim()) { setError('El nombre es obligatorio'); return }
    setSaving(true); setError('')
    try {
      await suppliersService.updateSupplier(supplier.id, editForm, businessId)
      setSaved(true)
      setTimeout(() => { setSaved(false); onSaved() }, 800)
    } catch (e: any) {
      setError(e.message || 'Error al guardar')
    } finally { setSaving(false) }
  }

  const f = editForm

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }} data-testid="supplier-datos-tab">
      <div style={cardS}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '0.875rem', fontWeight: 700, color: '#f0f4ff' }}>Datos principales</h3>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.8rem', color: '#94a3b8' }}>
              <input type="checkbox" checked={f.active ?? true} onChange={e => set('active', e.target.checked)} />
              Activo
            </label>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Nombre *</label>
            <input className="form-control" value={f.name || ''} onChange={e => set('name', e.target.value)} />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Razón social</label>
            <input className="form-control" value={f.business_name || ''} onChange={e => set('business_name', e.target.value)} />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>CUIT / DNI</label>
            <input className="form-control" value={f.tax_id || ''} onChange={e => set('tax_id', e.target.value)} />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Condición fiscal</label>
            <select className="form-control" value={f.fiscal_condition || ''} onChange={e => set('fiscal_condition', e.target.value)}>
              <option value="">— Seleccionar —</option>
              {FISCAL_CONDITIONS.map(fc => <option key={fc} value={fc}>{fc}</option>)}
            </select>
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Teléfono</label>
            <input className="form-control" value={f.phone || ''} onChange={e => set('phone', e.target.value)} />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>WhatsApp</label>
            <input className="form-control" value={f.whatsapp || ''} onChange={e => set('whatsapp', e.target.value)} />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Email</label>
            <input className="form-control" type="email" value={f.email || ''} onChange={e => set('email', e.target.value)} />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Categoría</label>
            <select className="form-control" value={f.category || ''} onChange={e => set('category', e.target.value)}>
              <option value="">— Sin categoría —</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Dirección</label>
            <input className="form-control" value={f.address || ''} onChange={e => set('address', e.target.value)} />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Ciudad</label>
            <input className="form-control" value={f.city || ''} onChange={e => set('city', e.target.value)} />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Provincia</label>
            <input className="form-control" value={f.province || ''} onChange={e => set('province', e.target.value)} />
          </div>
        </div>
      </div>

      <div style={cardS}>
        <h3 style={{ margin: '0 0 1rem', fontSize: '0.875rem', fontWeight: 700, color: '#f0f4ff' }}>Datos comerciales</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Contacto</label>
            <input className="form-control" value={f.contact_name || ''} onChange={e => set('contact_name', e.target.value)} />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Días de entrega</label>
            <input className="form-control" value={f.delivery_days || ''} onChange={e => set('delivery_days', e.target.value)} placeholder="ej: 3-5 días hábiles" />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Método de pago preferido</label>
            <select className="form-control" value={f.payment_method_preferred || ''} onChange={e => set('payment_method_preferred', e.target.value)}>
              <option value="">— Sin preferencia —</option>
              {PAYMENT_METHODS.map(m => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
            </select>
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Alias / CVU</label>
            <input className="form-control" value={f.bank_alias || ''} onChange={e => set('bank_alias', e.target.value)} />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>CBU</label>
            <input className="form-control" value={f.bank_cbu || ''} onChange={e => set('bank_cbu', e.target.value)} />
          </div>
          <div>
            <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Sitio web</label>
            <input className="form-control" value={f.website || ''} onChange={e => set('website', e.target.value)} placeholder="https://..." />
          </div>
        </div>
      </div>

      {error && <p style={{ margin: 0, color: '#ef4444', fontSize: '0.8rem' }}>{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
        <button className="btn btn-primary btn-lift" onClick={handleSave} disabled={saving}>
          {saved ? <><CheckCircle size={14} /> Guardado</> : saving ? 'Guardando...' : <><Settings2 size={14} /> Guardar cambios</>}
        </button>
      </div>
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
        <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Notas internas del proveedor</label>
        <button className="btn btn-primary btn-sm btn-lift" onClick={handleSave} disabled={saving}>
          {saved ? <><CheckCircle size={13} /> Guardado</> : saving ? 'Guardando...' : 'Guardar notas'}
        </button>
      </div>
      <textarea className="form-control" style={{ minHeight: 200, resize: 'vertical' as const, fontSize: '0.875rem', lineHeight: 1.6 }}
        value={notes} onChange={e => setNotes(e.target.value)}
        placeholder={'Ej:\n• Entrega rápido en menos de 48hs\n• Tiene buenos precios en pantallas\n• No comprar baterías, fallaron varias\n• Pide seña para pedidos grandes'} />
      <p style={{ margin: '0.5rem 0 0', fontSize: '0.72rem', color: '#475569' }}>Estas notas son solo internas y no se muestran al proveedor.</p>
    </div>
  )
}
