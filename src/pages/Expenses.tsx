import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { formatDisplayMessage } from '../utils/formatMessage'
import {
  Plus, Receipt, AlertTriangle, Calendar,
  Check, X, ChevronDown, ShoppingBag,
  Wallet, Banknote, CheckCircle, Truck, RefreshCw,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useCaja } from '../contexts/CajaContext'
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
import { purchasePayloadHash, resolvePurchaseKey } from '../utils/purchaseIdempotency'
import { financeErrorMessage } from '../lib/financeErrors'
import { ProductFormModalSafe as ProductFormModal } from '../components/products/ProductFormModal'
import type { InventoryItem } from '../hooks/useInventory'

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
import { fmtDateFull as fmtDate } from '../utils/dateUtils'
const today = () => new Date().toISOString().split('T')[0]
const firstDayOfMonth = () => { const d = new Date(); d.setDate(1); return d.toISOString().split('T')[0] }
const mkItem = (): LineItem => ({ _id: crypto.randomUUID(), inventory_id: null, product_name: '', cantidad: '1', costo_unitario: '' })

const PAYMENT_METHOD_LABELS: Record<string, { label: string; color: string }> = {
  efectivo:      { label: 'Efectivo',      color: '#22c55e' },
  transferencia: { label: 'Transferencia', color: '#60a5fa' },
  tarjeta:       { label: 'Tarjeta',       color: '#f59e0b' },
}

// ─── Module-level styles ──────────────────────────────────────────────────────
// (migrated to CSS classes — kept only what's still needed inline)

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
      <p className="label-caps" style={{ marginBottom: 0, color: 'var(--accent-primary)' }}>Nuevo proveedor</p>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '0.75rem' }}>
        <div>
          <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Nombre *</label>
          <input className="form-control" value={name} onChange={e => setName(e.target.value)} placeholder="Nombre del proveedor" autoFocus onKeyDown={e => e.key === 'Enter' && handleCreate()} />
        </div>
        <div>
          <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Teléfono</label>
          <input className="form-control" value={phone} onChange={e => setPhone(e.target.value)} placeholder="351-xxx-xxxx" />
        </div>
        <div>
          <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Email</label>
          <input className="form-control" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="opcional" />
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
  onOpenProductForm: (name: string, itemId: string) => void
}

function ItemRow({ item, businessId, onUpdate, onRemove, isOnly, onOpenProductForm }: ItemRowProps) {
  const [q, setQ]         = useState(item.product_name)
  const [results, setResults] = useState<any[]>([])
  const [open, setOpen]   = useState(false)

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
      setResults(data || [])
      setOpen(true)  // siempre abre — muestra resultados O botón "Crear"
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

  const cell: React.CSSProperties = { padding: '0.4375rem 0.375rem', verticalAlign: 'top' }

  return (
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
            <input className="form-control" value={q}
              onChange={e => { setQ(e.target.value); onUpdate(item._id, { product_name: e.target.value, inventory_id: null }) }}
              onFocus={() => q.length >= 2 && setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 200)}
              placeholder="Buscar producto..." />
            {open && q.trim().length >= 2 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 999, background: 'var(--bg-modal)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', width: '100%', minWidth: 240, boxShadow: 'var(--shadow-lg)', overflow: 'hidden' }}>
                {results.length === 0 && (
                  <div style={{ padding: '0.5rem 0.75rem', fontSize: '0.78rem', color: 'var(--text-subtle)' }}>
                    Sin resultados para "{q.trim()}"
                  </div>
                )}
                {results.map(r => (
                  <div key={r.id} onMouseDown={() => selectProduct(r)}
                    style={{ padding: '0.5rem 0.75rem', cursor: 'pointer', fontSize: '0.82rem', borderBottom: '1px solid var(--border-subtle)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <span style={{ fontWeight: 600 }}>{r.name}</span>
                    {r.cost_price > 0 && <span style={{ marginLeft: '0.5rem', fontSize: '0.72rem', color: 'var(--text-subtle)' }}>Costo: {fmtARS(r.cost_price)}</span>}
                  </div>
                ))}
                <div
                  onMouseDown={() => { setOpen(false); onOpenProductForm(q.trim(), item._id) }}
                  style={{ padding: '0.5rem 0.75rem', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700, color: 'var(--accent-primary)', background: 'rgba(99,102,241,0.06)', borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.12)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.06)')}
                >
                  <Plus size={11} /> Crear producto completo: "{q.trim()}"
                </div>
              </div>
            )}
          </div>
        )}
      </td>
      {/* Cantidad */}
      <td style={{ ...cell, width: 76 }}>
        <input className="form-control" style={{ textAlign: 'right' }} type="number" min="1" step="1"
          value={item.cantidad} onChange={e => onUpdate(item._id, { cantidad: e.target.value })} />
      </td>
      {/* Costo unit. */}
      <td style={{ ...cell, width: 120 }}>
        <input className="form-control" style={{ textAlign: 'right' }} type="number" min="0" step="1"
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
  const { isOpen: cajaIsOpen, cajaId } = useCaja()
  const [tipo, setTipo] = useState<'general' | 'factura'>('general')

  // Idempotency key estable por INTENTO de compra: se genera una vez y se
  // conserva ante reintentos (doble-click / timeout); se renueva sólo si el
  // usuario cambia un dato económico (hash local distinto) y se limpia al
  // completar con éxito. La validación autoritativa es server-side.
  const purchaseKeyRef = useRef<string | null>(null)
  const payloadHashRef = useRef<string | null>(null)
  // M7 7D.3: ídem para el gasto general (create_expense_with_finance).
  const gastoKeyRef  = useRef<string | null>(null)
  const gastoHashRef = useRef<string | null>(null)

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
  const [facPayState, setFacPayState]     = useState<'paid' | 'partial' | 'cc'>('paid')
  const [facPartialAmt, setFacPartialAmt] = useState('')
  const [facDescripcion, setFacDescripcion] = useState('')
  const [facNotas, setFacNotas]           = useState('')
  const [facFecha, setFacFecha]           = useState(today())
  const FAC_METHODS = [
    { id: 'efectivo',      short: 'Efec.',  color: '#22c55e' },
    { id: 'transferencia', short: 'Trans.', color: '#3b82f6' },
    { id: 'tarjeta',       short: 'Tarj.',  color: '#f59e0b' },
    { id: 'cheque',        short: 'Cheque', color: '#94a3b8' },
    { id: 'dolares',       short: 'USD',    color: '#22c55e' },
    { id: 'otro',          short: 'Otro',   color: '#64748b' },
  ]

  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  // ProductFormModal — abrir desde ItemRow al hacer "Crear producto completo"
  const [showProductFormModal, setShowProductFormModal] = useState(false)
  const [productFormItemId, setProductFormItemId]       = useState<string | null>(null)
  const [productFormInitialName, setProductFormInitialName] = useState('')

  const handleOpenProductForm = (name: string, itemId: string) => {
    setProductFormInitialName(name)
    setProductFormItemId(itemId)
    setShowProductFormModal(true)
  }

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
    if (saving) return   // M7 7D.3: guard de doble submit (faltaba en este flujo)
    const montoNum = parseFloat(monto.replace(',', '.'))
    if (!montoNum || montoNum <= 0) { setError('El monto es obligatorio'); return }
    if (!descripcion.trim()) { setError('La descripción es obligatoria'); return }
    if (!cajaIsOpen) { setError('No hay caja abierta. Abrí caja antes de registrar gastos.'); return }
    setSaving(true); setError('')
    try {
      const catKey = categoria.toLowerCase().split(' ')[0]
      const financeTypeMap: Record<string, string> = { inventario: 'variable_cost', sueldos: 'salary', impuestos: 'taxes' }
      const financeType = financeTypeMap[catKey] || 'fixed_cost_local'

      // M7 7D.3 — Key durable por INTENCIÓN de gasto, no por clic.
      //
      // El request_hash server-side (create_expense_with_finance) cubre:
      //   business_id, amount, currency, category_key, caja_id, economic_date,
      //   description.
      // Acá rotamos por un SUPERCONJUNTO de esos campos: agregamos método,
      // notas, finance_type y recurrencia. Rotar de más siempre es seguro (a lo
      // sumo se pierde un replay legítimo); rotar de menos NO lo es. En concreto:
      // el método NO entra en el hash del server, así que reusar la key tras
      // cambiar sólo el método devolvería un replay del gasto viejo —con el
      // método anterior— en vez de un conflicto visible. Incluirlo acá lo evita.
      const intent = [
        'operating_expense', businessId,
        montoNum.toFixed(2), 'ARS',
        (catKey || '').trim() || '∅',
        cajaId || '∅',
        fecha,
        (descripcion || '').trim(),
        metodo,                                   // no está en el hash del server
        financeType,
        (notas || '').trim(),
        recurrente ? `rec:${frecuencia}` : 'rec:∅',
      ].join('§')
      const { key } = resolvePurchaseKey(
        gastoKeyRef.current, gastoHashRef.current, intent, () => crypto.randomUUID(),
      )
      gastoKeyRef.current  = key
      gastoHashRef.current = intent

      // RPC atómica: crea BFE + expense + FM en una sola transacción.
      // Si cualquier insert falla, los 3 hacen rollback automático.
      const { data: rpcResult, error: rpcErr } = await supabase.rpc('create_expense_with_finance', {
        p_business_id:    businessId,
        p_user_id:        userId,
        p_description:    descripcion,
        p_category:       categoria,
        p_category_key:   catKey,
        p_finance_type:   financeType,
        p_amount:         montoNum,
        p_payment_method: metodo,
        p_date:           fecha,
        p_is_recurring:   recurrente,
        p_frequency:      recurrente ? frecuencia : null,
        p_notes:          notas || null,
        p_caja_id:        cajaId || null,
        p_idempotency_key: key,
      })
      if (rpcErr) throw rpcErr
      const result = rpcResult as { ok: boolean; error_code?: string; error?: string; message?: string } | null
      if (!result?.ok) {
        // Error tipado: se conserva la key salvo que la intención haya muerto.
        // Si el usuario corrige el payload, el hash cambia y la key rota sola.
        throw new Error(financeErrorMessage(result?.error_code, result?.message || result?.error))
      }
      // Éxito terminal: la intención terminó, la key se descarta.
      gastoKeyRef.current  = null
      gastoHashRef.current = null
      onSaved()
    } catch (e: any) { setError(e.message || 'Error al guardar') } finally { setSaving(false) }
  }

  // ── Save: Factura ──
  const handleSaveFactura = async () => {
    if (saving) return
    if (!supplierId) { setError(showNewSupplier ? 'Primero guardá el nuevo proveedor' : 'Seleccioná un proveedor'); return }
    const validItems = items.filter(it => it.product_name.trim() && (parseFloat(it.cantidad) || 0) > 0 && (parseFloat(it.costo_unitario) || 0) > 0)
    if (validItems.length === 0) { setError('Completá al menos un producto con nombre, cantidad y costo'); return }
    if (totalFactura <= 0) { setError('El total de la factura debe ser mayor a $0'); return }
    // Solo bloquear caja cuando hay movimiento de efectivo (paid o partial con monto > 0)
    if (!cajaIsOpen && facPaidAmount > 0) { setError('No hay caja abierta. Abrí caja antes de registrar facturas con pago inmediato.'); return }
    setSaving(true); setError('')
    try {
      const supplierName = suppliers.find(s => s.id === supplierId)?.name || 'Proveedor'
      const itemsPayload = validItems.map(it => ({
        inventory_id: it.inventory_id || null,
        product_name: it.product_name,
        quantity:     parseFloat(it.cantidad) || 1,
        unit_cost:    parseFloat(it.costo_unitario) || 0,
      }))
      // Idempotency key ligada al payload: si cambió cualquier dato económico
      // desde el último intento → key nueva; si es idéntico (reintento/doble
      // click) → conserva la key para replay seguro. Decisión determinística.
      const localHash = purchasePayloadHash({
        businessId, supplierId, supplierName, invoice: numFactura || '',
        date: facFecha, paymentMethod: facMetodo, totalArs: totalFactura, paidArs: facPaidAmount,
        items: itemsPayload,
      })
      const resolved = resolvePurchaseKey(purchaseKeyRef.current, payloadHashRef.current, localHash, () => crypto.randomUUID())
      purchaseKeyRef.current = resolved.key
      payloadHashRef.current = resolved.hash

      const input: CreatePurchaseInput = {
        supplier_id: supplierId,
        purchase_date: facFecha,
        invoice_number: numFactura || undefined,
        total_amount: totalFactura,
        paid_amount: facPaidAmount,
        payment_method: facMetodo,
        notes: facNotas || undefined,
        items: validItems.map(it => ({
          inventory_id: it.inventory_id || null,
          product_name: it.product_name,
          quantity: parseFloat(it.cantidad) || 1,
          unit_cost: parseFloat(it.costo_unitario) || 0,
        })),
      }
      const purchase = await suppliersService.createPurchase(input, businessId, userId, supplierName, purchaseKeyRef.current)
      // Registro documental en expenses (tipo='factura' → el trigger NO genera
      // FM/BFE). En un replay, la compra ya existe y el registro documental
      // también → NO lo insertamos de nuevo (evita duplicar la fila documental).
      if (!purchase.replay) {
        const desc = facDescripcion.trim() || `Factura ${supplierName}${numFactura ? ' #' + numFactura : ''}`
        await supabase.from('expenses').insert({
          description: desc, category: 'Proveedores', amount: totalFactura, amount_ars: totalFactura,
          date: facFecha, business_id: businessId, payment_method: facMetodo, currency: 'ARS',
          exchange_rate: 1, notes: facNotas || null, created_by: userId,
          tipo: 'factura', proveedor_id: supplierId,
          supplier_purchase_id: purchase.id, invoice_number: numFactura || null,
        })
      }
      purchaseKeyRef.current = null   // éxito → la próxima compra usa otra key
      payloadHashRef.current = null
      onSaved()
    } catch (e: any) {
      // Conflicto de idempotencia: la key ya se usó con OTROS datos. No es éxito,
      // no cerramos ni limpiamos; invalidamos la key para que un próximo envío
      // EXPLÍCITO del usuario arranque una operación nueva (sin auto-retry).
      if ((e as { code?: string })?.code === 'IDEMPOTENCY_CONFLICT') {
        purchaseKeyRef.current = null
        payloadHashRef.current = null
      }
      setError(e.message || 'Error al guardar')
    } finally { setSaving(false) }
  }

  const facPaidAmount = facPayState === 'paid' ? totalFactura : facPayState === 'cc' ? 0 : (parseFloat(facPartialAmt) || 0)
  const facPendingAmount = Math.max(0, totalFactura - facPaidAmount)

  const handleSave = () => tipo === 'general' ? handleSaveGeneral() : handleSaveFactura()
  const modalMaxW  = tipo === 'factura' ? 1100 : 560

  return (
    <>
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

        {/* Barra superior: caja alert + tipo selector */}
        <div style={{ padding: '0.75rem 1.25rem', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '0.375rem', padding: '0.2rem', background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)' }}>
            {(['general', 'factura'] as const).map(t => (
              <button key={t} onClick={() => { setTipo(t); setError('') }}
                style={{ padding: '0.375rem 1rem', borderRadius: 'var(--radius-md)', background: tipo === t ? (t === 'factura' ? 'var(--accent-primary)' : 'var(--error)') : 'transparent', color: tipo === t ? 'white' : 'var(--text-secondary)', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.375rem', transition: 'all 0.15s' }}>
                {t === 'general' ? <><Receipt size={13} /> General</> : <><ShoppingBag size={13} /> Factura de proveedor</>}
              </button>
            ))}
          </div>
          {!cajaIsOpen && (
            <div style={{ display: 'flex', gap: '0.375rem', padding: '0.375rem 0.75rem', background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 'var(--radius-md)', alignItems: 'center' }}>
              <AlertTriangle size={13} style={{ color: '#f87171', flexShrink: 0 }} />
              <span style={{ fontSize: '0.75rem', color: '#f87171', fontWeight: 600 }}>Caja cerrada</span>
            </div>
          )}
        </div>

        {/* Body — columna única (General) ó dos columnas (Factura) */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

          {/* ══ GENERAL — columna única scrollable ═══════════════════════════════ */}
          {tipo === 'general' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Monto *</label>
                <input data-testid="expense-amount-input" className="form-control" style={{ fontSize: '1.5rem', fontWeight: 800, textAlign: 'right', color: 'var(--error)' }}
                  type="number" min="0" step="1" value={monto} onChange={e => setMonto(e.target.value)} placeholder="$ 0" autoFocus />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Categoría *</label>
                  <select className="form-control" value={categoria} onChange={e => setCategoria(e.target.value)}>
                    {categories.filter(c => c.is_active).map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Método de pago</label>
                  <select data-testid="expense-payment-method-select" className="form-control" value={metodo} onChange={e => setMetodo(e.target.value)}>
                    <option value="efectivo">Efectivo</option>
                    <option value="transferencia">Transferencia</option>
                    <option value="tarjeta">Tarjeta</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Descripción *</label>
                <input data-testid="expense-description-input" className="form-control" type="text" value={descripcion} onChange={e => setDescripcion(e.target.value)} placeholder="¿En qué se gastó?" />
              </div>
              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Fecha</label>
                <input className="form-control" type="date" value={fecha} onChange={e => setFecha(e.target.value)} />
              </div>
              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Notas (opcional)</label>
                <textarea className="form-control" style={{ minHeight: 60, resize: 'vertical' as const }} value={notas} onChange={e => setNotas(e.target.value)} placeholder="Información adicional..." />
              </div>
              <div style={{ padding: '0.875rem 1rem', background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={recurrente} onChange={e => setRecurrente(e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--accent-primary)', cursor: 'pointer' }} />
                  <span style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Gasto recurrente</span>
                </label>
                {recurrente && (
                  <div>
                    <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Frecuencia</label>
                    <select className="form-control" value={frecuencia} onChange={e => setFrecuencia(e.target.value)}>
                      <option value="mensual">Mensual</option>
                      <option value="semanal">Semanal</option>
                    </select>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ══ FACTURA — dos columnas POS ════════════════════════════════════════ */}
          {tipo === 'factura' && (
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

              {/* ── IZQUIERDA: proveedor + meta + items + notas ── */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '0.875rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.875rem', borderRight: '2px solid rgba(255,255,255,0.06)' }}>

                {/* Proveedor */}
                <div>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Proveedor</label>
                  <select className="form-control"
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
                    <QuickSupplierForm businessId={businessId} userId={userId}
                      onCreated={s => { setSuppliers(prev => [...prev, s].sort((a, b) => a.name.localeCompare(b.name))); setSupplierId(s.id); setShowNewSupplier(false) }}
                      onCancel={() => setShowNewSupplier(false)} />
                  )}
                </div>

                {/* N° Factura + Fecha */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.625rem' }}>
                  <div>
                    <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>N° Factura (opcional)</label>
                    <input className="form-control" value={numFactura} onChange={e => setNumFactura(e.target.value)} placeholder="A-0001-00012345" />
                  </div>
                  <div>
                    <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Fecha</label>
                    <input className="form-control" type="date" value={facFecha} onChange={e => setFacFecha(e.target.value)} />
                  </div>
                </div>

                {/* Descripción */}
                <div>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Descripción (se auto-genera)</label>
                  <input className="form-control" value={facDescripcion} onChange={e => setFacDescripcion(e.target.value)}
                    placeholder={`Factura ${suppliers.find(s => s.id === supplierId)?.name || 'proveedor'}${numFactura ? ' #' + numFactura : ''}`} />
                </div>

                {/* Productos — cards premium */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                      Productos ({items.filter(it => it.product_name).length})
                    </span>
                    <button onClick={() => setItems(prev => [...prev, mkItem()])}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.25rem 0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.375rem', color: '#475569', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}>
                      <Plus size={11} /> Agregar fila
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                    {items.map(it => (
                      <ItemRow key={it._id} item={it} businessId={businessId} onUpdate={updateItem} onRemove={removeItem} isOnly={items.length === 1} onOpenProductForm={handleOpenProductForm} />
                    ))}
                  </div>
                </div>

                {/* Notas */}
                <div>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.35rem' }}>Notas internas</label>
                  <textarea className="form-control" style={{ minHeight: 52, resize: 'vertical' as const }} value={facNotas} onChange={e => setFacNotas(e.target.value)} placeholder="Condiciones, observaciones..." />
                </div>
              </div>

              {/* ── DERECHA: panel financiero sticky ── */}
              <div style={{ width: 380, display: 'flex', flexDirection: 'column', background: '#07101f', flexShrink: 0 }}>

                {/* Supplier info */}
                <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Truck size={14} color="#818cf8" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ color: '#f1f5f9', fontWeight: 700, fontSize: '0.875rem' }}>
                        {suppliers.find(s => s.id === supplierId)?.name ?? 'Sin proveedor seleccionado'}
                      </div>
                      {!supplierId && <div style={{ color: 'var(--text-subtle)', fontSize: '0.68rem' }}>Seleccioná uno de la izquierda</div>}
                    </div>
                  </div>
                </div>

                {/* TOTAL grande */}
                <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
                  <div style={{ color: 'var(--text-tertiary)', fontSize: '0.72rem', fontWeight: 600, marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Total de compra</div>
                  <div style={{ color: totalFactura > 0 ? '#f0f4ff' : 'var(--text-subtle)', fontSize: '2.25rem', fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1, transition: 'color 0.2s' }}>
                    {totalFactura > 0 ? fmtARS(totalFactura) : '$0'}
                  </div>
                  {totalFactura === 0 && <div style={{ color: 'var(--text-subtle)', fontSize: '0.7rem', marginTop: '0.2rem' }}>Agregá productos para ver el total</div>}
                </div>

                {/* ESTADO + MÉTODOS + RESUMEN */}
                <div style={{ padding: '0.875rem 1rem', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>

                  {/* Estado de pago */}
                  <div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.3rem' }}>Estado de pago</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.3rem' }}>
                      {([
                        { key: 'cc' as const,      label: 'A CC',    sub: 'Todo a deber', icon: <Wallet size={12} />,      color: '#818cf8', bg: 'rgba(99,102,241,0.12)',  border: 'rgba(99,102,241,0.4)'  },
                        { key: 'partial' as const,  label: 'Parcial', sub: 'Paga algo hoy',icon: <Banknote size={12} />,     color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',  border: 'rgba(245,158,11,0.35)' },
                        { key: 'paid' as const,     label: 'Pagado',  sub: 'Saldado hoy',  icon: <CheckCircle size={12} />, color: '#22c55e', bg: 'rgba(34,197,94,0.1)',   border: 'rgba(34,197,94,0.35)'  },
                      ]).map(opt => (
                        <button key={opt.key} onClick={() => setFacPayState(opt.key)}
                          style={{ padding: '0.5rem 0.25rem', borderRadius: '0.5rem', border: `1px solid ${facPayState === opt.key ? opt.border : 'rgba(255,255,255,0.07)'}`, background: facPayState === opt.key ? opt.bg : 'rgba(255,255,255,0.02)', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.15rem', transition: 'all 0.1s' }}>
                          <span style={{ color: facPayState === opt.key ? opt.color : 'var(--text-muted)' }}>{opt.icon}</span>
                          <span style={{ color: facPayState === opt.key ? opt.color : 'var(--text-muted)', fontSize: '0.72rem', fontWeight: facPayState === opt.key ? 800 : 500 }}>{opt.label}</span>
                          <span style={{ color: facPayState === opt.key ? opt.color : 'var(--text-subtle)', fontSize: '0.6rem', opacity: 0.8 }}>{opt.sub}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Grid de métodos */}
                  <div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.3rem' }}>Método de pago</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.3rem' }}>
                      {FAC_METHODS.map(m => {
                        const active = facMetodo === m.id
                        return (
                          <button key={m.id} onClick={() => setFacMetodo(m.id)}
                            style={{ padding: '0.4rem 0.25rem', borderRadius: '0.5rem', border: `1px solid ${active ? m.color + '80' : 'rgba(255,255,255,0.06)'}`, background: active ? m.color + '20' : 'rgba(255,255,255,0.02)', color: active ? m.color : 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: active ? 700 : 500, cursor: 'pointer', transition: 'all 0.1s', textAlign: 'center' }}
                            onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                            onMouseLeave={e => { e.currentTarget.style.background = active ? m.color + '20' : 'rgba(255,255,255,0.02)' }}>
                            {m.short}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Input monto parcial */}
                  {facPayState === 'partial' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                      <div>
                        <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', fontWeight: 700, textTransform: 'uppercase', marginBottom: '0.25rem' }}>Pagado ahora</div>
                        <input type="number" min="0" max={totalFactura} value={facPartialAmt}
                          onChange={e => setFacPartialAmt(e.target.value)}
                          placeholder="$"
                          style={{ width: '100%', padding: '0.5rem 0.625rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: '#f0f4ff', fontSize: '0.9rem', fontWeight: 700, outline: 'none', boxSizing: 'border-box' as const }} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.6rem', color: '#818cf8', fontWeight: 700, textTransform: 'uppercase', marginBottom: '0.25rem' }}>Va a CC</div>
                        <div style={{ padding: '0.5rem 0.625rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.5rem', color: '#818cf8', fontSize: '0.9rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                          <Wallet size={13} color="#818cf8" /> {fmtARS(facPendingAmount)}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Resumen financiero */}
                  <div style={{ background: 'rgba(0,0,0,0.25)', borderRadius: '0.625rem', padding: '0.625rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.225rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '0.2rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', fontWeight: 600 }}>Total factura</span>
                      <span style={{ fontSize: '0.72rem', color: totalFactura > 0 ? '#94a3b8' : 'var(--text-subtle)', fontWeight: 700 }}>{fmtARS(totalFactura)}</span>
                    </div>
                    {totalFactura === 0 ? (
                      <div style={{ color: 'var(--text-subtle)', fontSize: '0.7rem', fontStyle: 'italic', padding: '0.2rem 0' }}>El resumen aparecerá al agregar productos</div>
                    ) : (
                      <>
                        {facPaidAmount > 0 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Pagado ({FAC_METHODS.find(m => m.id === facMetodo)?.short ?? facMetodo})</span>
                            <span style={{ fontSize: '0.75rem', color: '#22c55e', fontWeight: 700 }}>{fmtARS(facPaidAmount)}</span>
                          </div>
                        )}
                        {facPendingAmount > 0 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.78rem', color: '#818cf8', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                              <Wallet size={12} /> Cuenta Corriente
                            </span>
                            <span style={{ fontSize: '0.9rem', color: '#818cf8', fontWeight: 900 }}>{fmtARS(facPendingAmount)}</span>
                          </div>
                        )}
                        {facPendingAmount <= 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: '#22c55e', fontSize: '0.75rem', fontWeight: 700 }}>
                            <CheckCircle size={12} /> Factura saldada completamente
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* Footer del panel: error + guardar */}
                <div style={{ padding: '0.875rem 1rem', borderTop: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
                  {error && (
                    <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.5rem', padding: '0.5rem 0.625rem', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)', borderRadius: '0.5rem' }}>
                      <AlertTriangle size={13} color="#f87171" style={{ flexShrink: 0 }} />
                      <span style={{ color: '#f87171', fontSize: '0.72rem' }}>{formatDisplayMessage(error)}</span>
                    </div>
                  )}
                  <button onClick={handleSave} disabled={saving}
                    style={{ width: '100%', padding: '0.875rem', borderRadius: '0.75rem', border: 'none', background: saving ? 'rgba(99,102,241,0.4)' : 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff', fontSize: '0.9375rem', fontWeight: 800, cursor: saving ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', boxShadow: saving ? 'none' : '0 4px 20px rgba(99,102,241,0.4)', transition: 'all 0.15s' }}>
                    {saving ? <><RefreshCw size={15} style={{ animation: 'tr-spin 0.8s linear infinite' }} /> Registrando...</> : <><ShoppingBag size={15} /> {totalFactura > 0 ? `Registrar ${fmtARS(totalFactura)}` : 'Registrar factura'}</>}
                  </button>
                  <button onClick={onClose} style={{ width: '100%', marginTop: '0.375rem', padding: '0.375rem', background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '0.78rem', cursor: 'pointer' }}>
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          )}

          {tipo === 'general' && error && <div role="alert" data-testid="expense-error-message" style={{ padding: '0 1.5rem 0.75rem' }}><p style={{ margin: 0, color: 'var(--error)', fontSize: '0.8rem', fontWeight: 600 }}>{formatDisplayMessage(error)}</p></div>}
        </div>

        {/* Footer — solo para gasto general */}
        {tipo === 'general' && (
        <div style={{ flexShrink: 0, padding: '1rem 1.5rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.75rem', background: 'var(--bg-modal)', borderRadius: '0 0 var(--radius-2xl) var(--radius-2xl)' }}>
          <AppButton variant="secondary" onClick={onClose}>Cancelar</AppButton>
          <AppButton data-testid="expense-save-button" variant="red" onClick={handleSave} loading={saving} leftIcon={<Receipt size={14} />}>
            Registrar gasto
          </AppButton>
        </div>
        )}
      </div>
    </div>

    {/* ProductFormModal — registerStock=false: el stock se suma al registrar la factura */}
    <ProductFormModal
      isOpen={showProductFormModal}
      onClose={() => { setShowProductFormModal(false); setProductFormItemId(null) }}
      onCreated={(product: InventoryItem) => {
        if (productFormItemId) {
          updateItem(productFormItemId, {
            inventory_id:   product.id,
            product_name:   product.name,
            costo_unitario: product.cost_price ? String(Math.round(product.cost_price)) : '',
          })
        }
        setShowProductFormModal(false)
        setProductFormItemId(null)
      }}
      initialName={productFormInitialName}
      registerStock={false}
      sourceType="supplier_invoice"
    />
    </>
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
  // M7 7D: key durable por INTENCIÓN de reverso de gasto (no por clic).
  const reverseKeyRef  = useRef<string | null>(null)
  const reverseHashRef = useRef<string | null>(null)

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
            <AppButton data-testid="expense-new-button" variant="red" size="sm" leftIcon={<AddIcon size={14} />} onClick={() => setShowModal(true)}>Nuevo Gasto</AppButton>
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
                        <AppIconButton icon={<DeleteIcon size={13} />} label={isFactura ? 'Factura — revertir desde Proveedores' : 'Reversar gasto'} size="xs" variant="danger"
                          onClick={async () => {
                            // Facturas de proveedor: bloqueadas acá (append-only en su módulo).
                            if (isFactura) { alert('Esta factura pertenece a una compra/proveedor. Corregila desde Proveedores o mediante un reverso específico.'); return }
                            // Reverso append-only vía RPC: NO se borra la fila, se crean asientos
                            // compensatorios (BFE + FM) que dejan P&L y caja en cero.
                            const motivo = window.prompt('Motivo del reverso del gasto (obligatorio):')
                            if (!motivo || !motivo.trim()) return
                            try {
                              // M7 7D: una key por INTENCIÓN. Si la respuesta se pierde y el
                              // usuario reintenta el mismo reverso, la misma key devuelve replay
                              // en vez de una segunda reversa. Rota sola si cambia gasto o motivo.
                              const intent = `reverse_expense§${businessId}§${e.id}§${motivo.trim()}`
                              const { key } = resolvePurchaseKey(
                                reverseKeyRef.current, reverseHashRef.current, intent, () => crypto.randomUUID(),
                              )
                              reverseKeyRef.current = key
                              reverseHashRef.current = intent

                              const { data, error } = await supabase.rpc('reverse_operating_expense_atomic', {
                                p_business_id: businessId, p_expense_id: e.id, p_reason: motivo.trim(),
                                p_user_id: user?.id, p_idempotency_key: key,
                              })
                              if (error) throw error
                              const res = data as { ok: boolean; error?: string; message?: string } | null
                              if (res?.error === 'IDEMPOTENCY_CONFLICT') { alert(res.message || 'La solicitud ya fue utilizada con datos diferentes.'); return }
                              if (!res?.ok) throw new Error(res?.error || 'No se pudo reversar el gasto')
                              reverseKeyRef.current = null   // éxito terminal: se descarta
                              reverseHashRef.current = null
                              loadExpenses()
                            } catch (err: any) { alert(err.message || 'Error al reversar el gasto') }
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
