import { useState, useEffect, useRef } from 'react'
import { 
  DollarSign, 
  Plus, 
  Trash2, 
  Package, 
  TrendingUp, 
  AlertCircle, 
  CheckCircle, 
  Clock,
  Receipt,
  Loader2,
  ArrowDownCircle,
  ArrowUpCircle,
  MinusCircle
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { currencyService } from '../../services/currencyService'

// Estados de repuestos
const PART_STATUSES = {
  pending: { label: 'Pendiente', color: '#64748b', icon: Clock },
  reserved: { label: 'Reservado', color: '#f59e0b', icon: MinusCircle },
  used: { label: 'Usado', color: '#6366f1', icon: CheckCircle },
  sold: { label: 'Vendido', color: '#10b981', icon: ArrowDownCircle },
  returned: { label: 'Devuelto', color: '#dc2626', icon: ArrowUpCircle }
}

interface OrderPart {
  id: string
  name: string
  description?: string
  part_number?: string
  internal_cost: number
  sale_price: number
  quantity: number
  margin_amount: number
  margin_percentage: number
  status: keyof typeof PART_STATUSES
  deduct_from_inventory: boolean
  notes?: string
  added_at: string
}

interface Payment {
  id: string
  amount: number
  payment_method: string
  is_down_payment: boolean
  payment_status: string
  receipt_number?: string
  receipt_url?: string
  due_date?: string
  payment_date: string
  notes?: string
}

interface OrderCostManagementProps {
  orderId: string
  laborCost: number
  totalQuoted: number
  onDataChange: () => void
}

export function OrderCostManagement({ orderId, laborCost, totalQuoted, onDataChange }: OrderCostManagementProps) {
  const { businessId, user } = useAuth()
  const exchangeRateRef = useRef<number>(1)
  const [parts, setParts] = useState<OrderPart[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  
  // Form states
  const [showAddPart, setShowAddPart] = useState(false)
  const [showAddPayment, setShowAddPayment] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  
  const [partForm, setPartForm] = useState({
    name: '',
    description: '',
    part_number: '',
    internal_cost: '',
    sale_price: '',
    quantity: '1',
    status: 'pending' as keyof typeof PART_STATUSES,
    deduct_from_inventory: true,
    notes: ''
  })
  
  const [paymentForm, setPaymentForm] = useState({
    amount: '',
    payment_method: 'cash',
    is_down_payment: false,
    receipt_number: '',
    due_date: '',
    notes: ''
  })

  useEffect(() => {
    loadData()
    currencyService.getCurrentExchangeRate('USD', 'ARS').then(r => { exchangeRateRef.current = r || 1 }).catch(() => {})
  }, [orderId])

  async function loadData() {
    try {
      setLoading(true)
      
      // Cargar repuestos
      const { data: partsData, error: partsError } = await supabase
        .from('order_parts')
        .select('*')
        .eq('order_id', orderId)
        .order('added_at', { ascending: false })
      
      if (partsError) throw partsError
      setParts(partsData || [])
      
      // Cargar pagos
      const { data: paymentsData, error: paymentsError } = await supabase
        .from('order_payments')
        .select('*')
        .eq('order_id', orderId)
        .order('payment_date', { ascending: false })
      
      if (paymentsError) throw paymentsError
      setPayments(paymentsData || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Cálculos financieros
  const partsInternalCost = parts
    .filter(p => ['used', 'sold'].includes(p.status))
    .reduce((sum, p) => sum + (p.internal_cost * p.quantity), 0)
  
  const partsSaleTotal = parts
    .filter(p => ['used', 'sold'].includes(p.status))
    .reduce((sum, p) => sum + (p.sale_price * p.quantity), 0)
  
  const partsProfit = partsSaleTotal - partsInternalCost
  
  const totalCost = laborCost + partsInternalCost
  const totalPaid = payments
    .filter(p => p.payment_status === 'completed')
    .reduce((sum, p) => sum + p.amount, 0)
  const balancePending = totalQuoted - totalPaid
  const grossProfit = totalQuoted - totalCost
  const profitMargin = totalQuoted > 0 ? ((grossProfit / totalQuoted) * 100).toFixed(1) : '0'

  const handleAddPart = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    setError('')
    
    try {
      const { error: insertError } = await supabase
        .from('order_parts')
        .insert({
          order_id: orderId,
          name: partForm.name,
          description: partForm.description || null,
          internal_cost: parseFloat(partForm.internal_cost) || 0,
          sale_price: parseFloat(partForm.sale_price) || 0,
          quantity: parseInt(partForm.quantity) || 1,
          status: partForm.status,
          deduct_from_inventory: partForm.deduct_from_inventory,
          notes: partForm.notes || null
        })
      
      if (insertError) throw insertError
      
      setShowAddPart(false)
      setPartForm({
        name: '',
        description: '',
        part_number: '',
        internal_cost: '',
        sale_price: '',
        quantity: '1',
        status: 'pending',
        deduct_from_inventory: true,
        notes: ''
      })
      await loadData()
      onDataChange()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleAddPayment = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    setError('')
    
    try {
      const paymentAmount = parseFloat(paymentForm.amount) || 0
      const { data: paymentData, error: insertError } = await supabase
        .from('order_payments')
        .insert({
          order_id: orderId,
          amount: paymentAmount,
          payment_method: paymentForm.payment_method,
          is_down_payment: paymentForm.is_down_payment,
          receipt_number: paymentForm.receipt_number || null,
          due_date: paymentForm.due_date || null,
          notes: paymentForm.notes || null,
          payment_status: 'completed',
          payment_date: new Date().toISOString()
        })
        .select('id')
        .single()

      if (insertError) throw insertError

      // Registrar en financial_movements para Caja / Tesorería
      if (businessId) {
        const rate = exchangeRateRef.current
        await supabase.from('financial_movements').insert({
          business_id: businessId,
          type: 'income',
          currency: 'ARS',
          amount: paymentAmount,
          exchange_rate: rate,
          amount_ars: paymentAmount,
          source: 'payment',
          source_id: paymentData?.id ?? null,
          description: `Pago orden`,
          date: new Date().toISOString().split('T')[0],
          created_by: user?.id ?? null
        })
      }
      
      setShowAddPayment(false)
      setPaymentForm({
        amount: '',
        payment_method: 'cash',
        is_down_payment: false,
        receipt_number: '',
        due_date: '',
        notes: ''
      })
      await loadData()
      onDataChange()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const updatePartStatus = async (partId: string, newStatus: string) => {
    try {
      const { error } = await supabase
        .from('order_parts')
        .update({ status: newStatus })
        .eq('id', partId)
      
      if (error) throw error
      await loadData()
      onDataChange()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const deletePart = async (partId: string) => {
    if (!confirm('¿Eliminar este repuesto?')) return
    
    try {
      const { error } = await supabase
        .from('order_parts')
        .delete()
        .eq('id', partId)
      
      if (error) throw error
      await loadData()
      onDataChange()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const deletePayment = async (paymentId: string) => {
    if (!confirm('¿Eliminar este pago?')) return
    
    try {
      const { error } = await supabase
        .from('order_payments')
        .delete()
        .eq('id', paymentId)
      
      if (error) throw error
      await loadData()
      onDataChange()
    } catch (err: any) {
      setError(err.message)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {error && (
        <div style={{
          padding: '0.75rem',
          backgroundColor: 'rgba(220, 38, 38, 0.1)',
          borderRadius: '0.5rem',
          color: '#dc2626',
          fontSize: '0.875rem'
        }}>
          <AlertCircle size={16} style={{ display: 'inline', marginRight: '0.5rem' }} />
          {error}
        </div>
      )}

      {/* RESUMEN FINANCIERO */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <TrendingUp size={18} color="#10b981" />
            Rentabilidad de la Orden
          </h3>
        </div>
        <div className="card-body">
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', 
            gap: '1rem' 
          }}>
            {/* Costos */}
            <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
              <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Mano de Obra</p>
              <p style={{ fontSize: '1.25rem', fontWeight: 600, color: '#f8fafc', margin: '0.25rem 0' }}>
                ${laborCost.toLocaleString()}
              </p>
            </div>
            
            <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
              <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Costo Repuestos</p>
              <p style={{ fontSize: '1.25rem', fontWeight: 600, color: '#f8fafc', margin: '0.25rem 0' }}>
                ${partsInternalCost.toLocaleString()}
              </p>
              <p style={{ fontSize: '0.625rem', color: '#64748b', margin: 0 }}>
                {parts.filter(p => ['used', 'sold'].includes(p.status)).length} items
              </p>
            </div>

            <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
              <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Costo Total</p>
              <p style={{ fontSize: '1.25rem', fontWeight: 600, color: '#f59e0b', margin: '0.25rem 0' }}>
                ${totalCost.toLocaleString()}
              </p>
            </div>

            {/* Ingresos */}
            <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
              <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Precio Venta Repuestos</p>
              <p style={{ fontSize: '1.25rem', fontWeight: 600, color: '#6366f1', margin: '0.25rem 0' }}>
                ${partsSaleTotal.toLocaleString()}
              </p>
              <p style={{ fontSize: '0.625rem', color: '#10b981', margin: 0 }}>
                +${partsProfit.toLocaleString()} margen
              </p>
            </div>

            <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
              <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Precio Total Cotizado</p>
              <p style={{ fontSize: '1.25rem', fontWeight: 600, color: '#6366f1', margin: '0.25rem 0' }}>
                ${totalQuoted.toLocaleString()}
              </p>
            </div>

            {/* Ganancia */}
            <div style={{ padding: '1rem', backgroundColor: grossProfit >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(220, 38, 38, 0.1)', borderRadius: '0.5rem' }}>
              <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Ganancia Bruta</p>
              <p style={{ 
                fontSize: '1.5rem', 
                fontWeight: 700, 
                color: grossProfit >= 0 ? '#10b981' : '#dc2626', 
                margin: '0.25rem 0' 
              }}>
                ${grossProfit.toLocaleString()}
              </p>
              <p style={{ fontSize: '0.75rem', color: grossProfit >= 0 ? '#10b981' : '#dc2626', margin: 0 }}>
                {profitMargin}% margen
              </p>
            </div>

            {/* Pagos */}
            <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
              <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Total Pagado</p>
              <p style={{ fontSize: '1.25rem', fontWeight: 600, color: '#10b981', margin: '0.25rem 0' }}>
                ${totalPaid.toLocaleString()}
              </p>
            </div>

            <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
              <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Saldo Pendiente</p>
              <p style={{ 
                fontSize: '1.25rem', 
                fontWeight: 600, 
                color: balancePending > 0 ? '#f59e0b' : '#10b981', 
                margin: '0.25rem 0' 
              }}>
                ${balancePending.toLocaleString()}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* REPUESTOS */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Package size={18} color="#6366f1" />
            Repuestos ({parts.length})
          </h3>
          <button 
            onClick={() => setShowAddPart(!showAddPart)}
            className="btn btn-sm btn-primary"
          >
            <Plus size={16} />
            {showAddPart ? 'Cancelar' : 'Agregar Repuesto'}
          </button>
        </div>
        
        <div className="card-body">
          {/* Formulario agregar repuesto */}
          {showAddPart && (
            <form onSubmit={handleAddPart} style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label className="form-label">Nombre del Repuesto *</label>
                  <input
                    type="text"
                    value={partForm.name}
                    onChange={(e) => setPartForm({ ...partForm, name: e.target.value })}
                    className="form-control"
                    placeholder="Ej: Pantalla iPhone 13 Pro"
                    required
                  />
                </div>
                <div>
                  <label className="form-label">Número de Parte</label>
                  <input
                    type="text"
                    value={partForm.part_number || ''}
                    onChange={(e) => setPartForm({ ...partForm, part_number: e.target.value })}
                    className="form-control"
                    placeholder="SKU o código"
                  />
                </div>
              </div>
              
              <div style={{ marginBottom: '1rem' }}>
                <label className="form-label">Descripción</label>
                <input
                  type="text"
                  value={partForm.description}
                  onChange={(e) => setPartForm({ ...partForm, description: e.target.value })}
                  className="form-control"
                  placeholder="Descripción adicional..."
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label className="form-label">Costo Interno *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={partForm.internal_cost}
                    onChange={(e) => setPartForm({ ...partForm, internal_cost: e.target.value })}
                    className="form-control"
                    placeholder="0.00"
                    required
                  />
                </div>
                <div>
                  <label className="form-label">Precio Venta *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={partForm.sale_price}
                    onChange={(e) => setPartForm({ ...partForm, sale_price: e.target.value })}
                    className="form-control"
                    placeholder="0.00"
                    required
                  />
                </div>
                <div>
                  <label className="form-label">Cantidad</label>
                  <input
                    type="number"
                    min="1"
                    value={partForm.quantity}
                    onChange={(e) => setPartForm({ ...partForm, quantity: e.target.value })}
                    className="form-control"
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label className="form-label">Estado</label>
                  <select
                    value={partForm.status}
                    onChange={(e) => setPartForm({ ...partForm, status: e.target.value as any })}
                    className="form-select"
                  >
                    {Object.entries(PART_STATUSES).map(([value, config]) => (
                      <option key={value} value={value}>{config.label}</option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', paddingTop: '1.5rem' }}>
                  <input
                    type="checkbox"
                    id="deduct_inventory"
                    checked={partForm.deduct_from_inventory}
                    onChange={(e) => setPartForm({ ...partForm, deduct_from_inventory: e.target.checked })}
                  />
                  <label htmlFor="deduct_inventory" style={{ fontSize: '0.875rem', color: '#a0aec0' }}>
                    Descontar del inventario
                  </label>
                </div>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label className="form-label">Notas</label>
                <textarea
                  value={partForm.notes}
                  onChange={(e) => setPartForm({ ...partForm, notes: e.target.value })}
                  className="form-control"
                  rows={2}
                  placeholder="Notas internas..."
                />
              </div>

              {/* Preview de margen */}
              {partForm.internal_cost && partForm.sale_price && (
                <div style={{ 
                  marginBottom: '1rem', 
                  padding: '0.75rem', 
                  backgroundColor: 'rgba(99, 102, 241, 0.1)', 
                  borderRadius: '0.5rem' 
                }}>
                  <p style={{ fontSize: '0.875rem', color: '#a0aec0', margin: 0 }}>
                    Margen estimado:{' '}
                    <span style={{ color: '#6366f1', fontWeight: 600 }}>
                      ${((parseFloat(partForm.sale_price) - parseFloat(partForm.internal_cost)) * parseInt(partForm.quantity || '1')).toFixed(2)}
                    </span>
                    {' '}(
                    {((parseFloat(partForm.sale_price) - parseFloat(partForm.internal_cost)) / parseFloat(partForm.internal_cost) * 100).toFixed(1)}%
                    )
                  </p>
                </div>
              )}

              <button type="submit" className="btn btn-primary" disabled={isSubmitting} style={{ width: '100%' }}>
                {isSubmitting ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Guardando...</> : 'Agregar Repuesto'}
              </button>
            </form>
          )}

          {/* Tabla de repuestos */}
          {parts.length === 0 ? (
            <p style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>
              No hay repuestos agregados
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: '0.875rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #374151' }}>
                    <th style={{ textAlign: 'left', padding: '0.75rem', color: '#64748b' }}>Repuesto</th>
                    <th style={{ textAlign: 'right', padding: '0.75rem', color: '#64748b' }}>Costo</th>
                    <th style={{ textAlign: 'right', padding: '0.75rem', color: '#64748b' }}>Venta</th>
                    <th style={{ textAlign: 'right', padding: '0.75rem', color: '#64748b' }}>Margen</th>
                    <th style={{ textAlign: 'center', padding: '0.75rem', color: '#64748b' }}>Estado</th>
                    <th style={{ textAlign: 'center', padding: '0.75rem', color: '#64748b' }}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {parts.map((part) => {
                    const StatusConfig = PART_STATUSES[part.status]
                    return (
                      <tr key={part.id} style={{ borderBottom: '1px solid #374151' }}>
                        <td style={{ padding: '0.75rem' }}>
                          <p style={{ color: '#f8fafc', fontWeight: 500, margin: 0 }}>{part.name}</p>
                          <p style={{ color: '#64748b', fontSize: '0.75rem', margin: 0 }}>
                            Qty: {part.quantity} {part.part_number && `• ${part.part_number}`}
                          </p>
                        </td>
                        <td style={{ textAlign: 'right', padding: '0.75rem', color: '#a0aec0' }}>
                          ${part.internal_cost.toLocaleString()}
                        </td>
                        <td style={{ textAlign: 'right', padding: '0.75rem', color: '#a0aec0' }}>
                          ${part.sale_price.toLocaleString()}
                        </td>
                        <td style={{ textAlign: 'right', padding: '0.75rem' }}>
                          <span style={{ color: '#10b981', fontSize: '0.75rem' }}>
                            +${part.margin_amount.toLocaleString()}
                          </span>
                          <br />
                          <span style={{ color: '#64748b', fontSize: '0.625rem' }}>
                            {part.margin_percentage}%
                          </span>
                        </td>
                        <td style={{ textAlign: 'center', padding: '0.75rem' }}>
                          <select
                            value={part.status}
                            onChange={(e) => updatePartStatus(part.id, e.target.value)}
                            style={{
                              padding: '0.25rem 0.5rem',
                              backgroundColor: `${StatusConfig.color}20`,
                              color: StatusConfig.color,
                              border: `1px solid ${StatusConfig.color}`,
                              borderRadius: '0.25rem',
                              fontSize: '0.75rem',
                              cursor: 'pointer'
                            }}
                          >
                            {Object.entries(PART_STATUSES).map(([value, config]) => (
                              <option key={value} value={value}>{config.label}</option>
                            ))}
                          </select>
                        </td>
                        <td style={{ textAlign: 'center', padding: '0.75rem' }}>
                          <button
                            onClick={() => deletePart(part.id)}
                            style={{ 
                              backgroundColor: 'transparent', 
                              border: 'none', 
                              color: '#dc2626',
                              cursor: 'pointer' 
                            }}
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* PAGOS */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <DollarSign size={18} color="#10b981" />
            Pagos ({payments.filter(p => p.payment_status === 'completed').length})
          </h3>
          <button 
            onClick={() => setShowAddPayment(!showAddPayment)}
            className="btn btn-sm btn-primary"
          >
            <Plus size={16} />
            {showAddPayment ? 'Cancelar' : 'Registrar Pago'}
          </button>
        </div>
        
        <div className="card-body">
          {/* Formulario agregar pago */}
          {showAddPayment && (
            <form onSubmit={handleAddPayment} style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label className="form-label">Monto *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={paymentForm.amount}
                    onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                    className="form-control"
                    placeholder="0.00"
                    required
                  />
                </div>
                <div>
                  <label className="form-label">Método de Pago</label>
                  <select
                    value={paymentForm.payment_method}
                    onChange={(e) => setPaymentForm({ ...paymentForm, payment_method: e.target.value })}
                    className="form-select"
                  >
                    <option value="cash">Efectivo</option>
                    <option value="credit_card">Tarjeta de Crédito</option>
                    <option value="debit_card">Tarjeta de Débito</option>
                    <option value="transfer">Transferencia</option>
                    <option value="mercadopago">Mercado Pago</option>
                    <option value="check">Cheque</option>
                    <option value="other">Otro</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label className="form-label">N° Comprobante</label>
                  <input
                    type="text"
                    value={paymentForm.receipt_number}
                    onChange={(e) => setPaymentForm({ ...paymentForm, receipt_number: e.target.value })}
                    className="form-control"
                    placeholder="Ticket, factura, etc."
                  />
                </div>
                <div>
                  <label className="form-label">Fecha de Cobro (si aplica)</label>
                  <input
                    type="date"
                    value={paymentForm.due_date}
                    onChange={(e) => setPaymentForm({ ...paymentForm, due_date: e.target.value })}
                    className="form-control"
                  />
                </div>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label className="form-label">Notas</label>
                <textarea
                  value={paymentForm.notes}
                  onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })}
                  className="form-control"
                  rows={2}
                  placeholder="Observaciones sobre el pago..."
                />
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={paymentForm.is_down_payment}
                    onChange={(e) => setPaymentForm({ ...paymentForm, is_down_payment: e.target.checked })}
                  />
                  <span style={{ fontSize: '0.875rem', color: '#a0aec0' }}>Es un anticipo/seña</span>
                </label>
              </div>

              <button type="submit" className="btn btn-primary" disabled={isSubmitting} style={{ width: '100%' }}>
                {isSubmitting ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Guardando...</> : 'Registrar Pago'}
              </button>
            </form>
          )}

          {/* Lista de pagos */}
          {payments.filter(p => p.payment_status === 'completed').length === 0 ? (
            <p style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>
              No hay pagos registrados
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {payments
                .filter(p => p.payment_status === 'completed')
                .map((payment) => (
                  <div 
                    key={payment.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.75rem 1rem',
                      backgroundColor: payment.is_down_payment ? 'rgba(245, 158, 11, 0.1)' : '#1e293b',
                      borderRadius: '0.5rem',
                      border: payment.is_down_payment ? '1px solid rgba(245, 158, 11, 0.3)' : 'none'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '50%',
                        backgroundColor: payment.is_down_payment ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.2)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>
                        {payment.is_down_payment ? <Receipt size={16} color="#f59e0b" /> : <DollarSign size={16} color="#10b981" />}
                      </div>
                      <div>
                        <p style={{ color: '#f8fafc', fontWeight: 600, margin: 0 }}>
                          ${payment.amount.toLocaleString()}
                          {payment.is_down_payment && <span style={{ fontSize: '0.625rem', color: '#f59e0b', marginLeft: '0.5rem' }}>(ANTICIPO)</span>}
                        </p>
                        <p style={{ color: '#64748b', fontSize: '0.75rem', margin: 0 }}>
                          {payment.payment_method} • {new Date(payment.payment_date).toLocaleDateString('es-ES')}
                          {payment.receipt_number && ` • ${payment.receipt_number}`}
                        </p>
                        {payment.notes && (
                          <p style={{ color: '#a0aec0', fontSize: '0.75rem', margin: '0.25rem 0 0 0' }}>
                            {payment.notes}
                          </p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => deletePayment(payment.id)}
                      style={{ backgroundColor: 'transparent', border: 'none', color: '#dc2626', cursor: 'pointer' }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
