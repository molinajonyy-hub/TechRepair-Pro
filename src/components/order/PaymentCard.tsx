import { useState } from 'react'
import { DollarSign, Plus, Trash2, Loader2, AlertCircle, CheckCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'

type Currency = 'ARS' | 'USD'

interface Payment {
  id: string
  amount: number
  currency?: Currency
  payment_method: string
  reference_number?: string
  notes?: string
  payment_date: string
}

interface PaymentCardProps {
  orderId: string
  payments: Payment[]
  totalCost: number
  exchangeRate?: number
  onPaymentsChange: () => void
}

const paymentMethods = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'credit_card', label: 'Tarjeta de Crédito' },
  { value: 'debit_card', label: 'Tarjeta de Débito' },
  { value: 'transfer', label: 'Transferencia' },
  { value: 'other', label: 'Otro' }
]

const fmtARS = (v: number) =>
  `$${v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtUSD = (v: number) =>
  `USD ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function PaymentCard({ orderId, payments, totalCost, exchangeRate = 1, onPaymentsChange }: PaymentCardProps) {
  const { businessId, user } = useAuth()
  const [isAdding, setIsAdding] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [formData, setFormData] = useState({
    amount: '',
    currency: 'ARS' as Currency,
    payment_method: 'cash',
    reference_number: '',
    notes: ''
  })

  // Totals by currency
  const totalPaidARS = payments
    .filter(p => (p.currency || 'ARS') === 'ARS')
    .reduce((sum, p) => sum + (p.amount || 0), 0)
  const totalPaidUSD = payments
    .filter(p => p.currency === 'USD')
    .reduce((sum, p) => sum + (p.amount || 0), 0)

  // Equivalent total paid in ARS
  const totalPaidEquivARS = totalPaidARS + totalPaidUSD * exchangeRate
  const balancePending = totalCost - totalPaidEquivARS

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    setError('')
    setSuccess('')

    try {
      const amount = parseFloat(formData.amount)
      if (isNaN(amount) || amount <= 0) {
        throw new Error('El monto debe ser mayor a 0')
      }
      if (formData.currency === 'USD' && (!exchangeRate || exchangeRate <= 1)) {
        throw new Error('No hay tipo de cambio disponible para pagos en USD')
      }

      // M6: pago de orden por RPC atómica e idempotente (crea order_payments;
      // el trigger crea 1 FM + 1 BFE mirror con USD correcto). Sin insert directo.
      const { data, error: rpcError } = await supabase.rpc('create_order_payment_atomic', {
        p_business_id:     businessId,
        p_order_id:        orderId,
        p_amount:          amount,
        p_payment_method:  formData.payment_method,
        p_currency:        formData.currency,
        p_exchange_rate:   formData.currency === 'USD' ? exchangeRate : 1,
        p_user_id:         user?.id,
        p_notes:           formData.notes || null,
        p_date:            null,
        p_idempotency_key: crypto.randomUUID(),
      })
      if (rpcError) throw rpcError
      const res = data as { ok: boolean; error?: string; message?: string } | null
      if (res?.error === 'IDEMPOTENCY_CONFLICT') { setError(res.message || 'Solicitud en conflicto'); setIsSubmitting(false); return }
      if (!res?.ok) throw new Error(res?.error || 'Error al registrar el pago')

      setSuccess('Pago registrado correctamente')
      setFormData({ amount: '', currency: 'ARS', payment_method: 'cash', reference_number: '', notes: '' })
      setIsAdding(false)
      onPaymentsChange()
      setTimeout(() => setSuccess(''), 3000)
    } catch (err: any) {
      setError(err.message || 'Error al registrar pago')
    } finally {
      setIsSubmitting(false)
    }
  }

  // M6: reverso append-only (nunca DELETE). Crea FM/BFE compensatorios en la
  // caja abierta actual; pide motivo; maneja IDEMPOTENCY_CONFLICT.
  const handleReverse = async (paymentId: string) => {
    const motivo = window.prompt('Motivo del reverso del pago (obligatorio):')
    if (!motivo || !motivo.trim()) return
    try {
      const { data, error: rpcError } = await supabase.rpc('reverse_order_payment_atomic', {
        p_business_id:     businessId,
        p_order_payment_id: paymentId,
        p_reason:          motivo.trim(),
        p_user_id:         user?.id,
        p_idempotency_key: crypto.randomUUID(),
      })
      if (rpcError) throw rpcError
      const res = data as { ok: boolean; error?: string; message?: string } | null
      if (res?.error === 'IDEMPOTENCY_CONFLICT') { setError(res.message || 'Solicitud en conflicto'); return }
      if (!res?.ok) throw new Error(res?.error || 'No se pudo reversar el pago')
      onPaymentsChange()
    } catch (err: any) {
      setError(err.message || 'Error al reversar el pago')
    }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <DollarSign size={20} color="#10b981" />
          <h3 className="card-title">Pagos</h3>
        </div>
        <button
          onClick={() => setIsAdding(!isAdding)}
          className="btn btn-sm btn-primary"
        >
          <Plus size={16} />
          {isAdding ? 'Cancelar' : 'Agregar Pago'}
        </button>
      </div>

      <div className="card-body">
        {/* Resumen financiero */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '0.75rem',
          marginBottom: '1.5rem',
          padding: '1rem',
          backgroundColor: '#1e293b',
          borderRadius: '0.5rem'
        }}>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Total Orden</p>
            <p style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc', margin: '0.25rem 0 0 0' }}>
              {fmtARS(totalCost)}
            </p>
          </div>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Saldo Pendiente</p>
            <p style={{
              fontSize: '1.1rem',
              fontWeight: 600,
              color: balancePending > 0.01 ? '#f59e0b' : '#10b981',
              margin: '0.25rem 0 0 0'
            }}>
              {fmtARS(Math.max(0, balancePending))}
            </p>
          </div>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Pagado ARS</p>
            <p style={{ fontSize: '1rem', fontWeight: 600, color: '#34d399', margin: '0.25rem 0 0 0' }}>
              {fmtARS(totalPaidARS)}
            </p>
          </div>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Pagado USD</p>
            <p style={{ fontSize: '1rem', fontWeight: 600, color: '#60a5fa', margin: '0.25rem 0 0 0' }}>
              {fmtUSD(totalPaidUSD)}
            </p>
          </div>
        </div>

        {error && (
          <div style={{
            padding: '0.75rem 1rem',
            backgroundColor: 'rgba(220, 38, 38, 0.1)',
            border: '1px solid rgba(220, 38, 38, 0.3)',
            borderRadius: '0.5rem',
            color: '#dc2626',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        {success && (
          <div style={{
            padding: '0.75rem 1rem',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            borderRadius: '0.5rem',
            color: '#10b981',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <CheckCircle size={16} />
            {success}
          </div>
        )}

        {/* Formulario */}
        {isAdding && (
          <form onSubmit={handleSubmit} style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
            {/* Currency selector */}
            <div style={{ marginBottom: '1rem' }}>
              <label className="form-label">Moneda</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {(['ARS', 'USD'] as Currency[]).map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setFormData({ ...formData, currency: c })}
                    style={{
                      flex: 1,
                      padding: '0.5rem',
                      borderRadius: '0.375rem',
                      border: `2px solid ${formData.currency === c
                        ? (c === 'USD' ? '#60a5fa' : '#34d399')
                        : 'rgba(255,255,255,0.1)'}`,
                      backgroundColor: formData.currency === c
                        ? (c === 'USD' ? 'rgba(59,130,246,0.15)' : 'rgba(16,185,129,0.1)')
                        : 'transparent',
                      color: formData.currency === c
                        ? (c === 'USD' ? '#60a5fa' : '#34d399')
                        : '#64748b',
                      fontWeight: 700,
                      fontSize: '0.875rem',
                      cursor: 'pointer',
                      letterSpacing: '0.05em',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    {c === 'ARS' ? '$ ARS' : 'USD $'}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label className="form-label">
                  Monto ({formData.currency})
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={formData.amount}
                  onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                  className="form-control"
                  placeholder="0.00"
                  required
                />
              </div>
              <div>
                <label className="form-label">Método de Pago</label>
                <select
                  value={formData.payment_method}
                  onChange={(e) => setFormData({ ...formData, payment_method: e.target.value })}
                  className="form-select"
                  required
                >
                  {paymentMethods.map(method => (
                    <option key={method.value} value={method.value}>{method.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label className="form-label">Número de Referencia (opcional)</label>
              <input
                type="text"
                value={formData.reference_number}
                onChange={(e) => setFormData({ ...formData, reference_number: e.target.value })}
                className="form-control"
                placeholder="Número de ticket, transferencia, etc."
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label className="form-label">Notas (opcional)</label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                className="form-control"
                rows={2}
                placeholder="Observaciones sobre el pago..."
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting}
              style={{ width: '100%' }}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} style={{ marginRight: '0.5rem', animation: 'tr-spin 1s linear infinite' }} />
                  Guardando...
                </>
              ) : (
                'Guardar Pago'
              )}
            </button>
          </form>
        )}

        {/* Lista de pagos */}
        {payments.length === 0 ? (
          <p style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>
            No hay pagos registrados.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {payments.map((payment) => {
              const currency = payment.currency || 'ARS'
              return (
                <div
                  key={payment.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.75rem 1rem',
                    backgroundColor: '#1e293b',
                    borderRadius: '0.5rem',
                    borderLeft: `3px solid ${currency === 'USD' ? '#60a5fa' : '#34d399'}`
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{
                        fontSize: '0.65rem',
                        fontWeight: 700,
                        padding: '0.1rem 0.4rem',
                        borderRadius: '0.25rem',
                        backgroundColor: currency === 'USD' ? 'rgba(59,130,246,0.2)' : 'rgba(16,185,129,0.15)',
                        color: currency === 'USD' ? '#60a5fa' : '#34d399',
                        letterSpacing: '0.05em'
                      }}>
                        {currency}
                      </span>
                      <p style={{ fontWeight: 600, color: '#f8fafc', margin: 0 }}>
                        {currency === 'USD' ? fmtUSD(payment.amount) : fmtARS(payment.amount)}
                      </p>
                    </div>
                    <p style={{ fontSize: '0.75rem', color: '#64748b', margin: '0.25rem 0 0 0' }}>
                      {paymentMethods.find(m => m.value === payment.payment_method)?.label || payment.payment_method}
                      {payment.reference_number && ` - Ref: ${payment.reference_number}`}
                    </p>
                    {payment.notes && (
                      <p style={{ fontSize: '0.75rem', color: '#a0aec0', margin: '0.25rem 0 0 0' }}>
                        {payment.notes}
                      </p>
                    )}
                    <p style={{ fontSize: '0.75rem', color: '#64748b', margin: '0.25rem 0 0 0' }}>
                      {new Date(payment.payment_date).toLocaleString('es-AR')}
                    </p>
                  </div>
                  <button
                    onClick={() => handleReverse(payment.id)}
                    className="btn btn-sm btn-outline"
                    style={{ color: '#dc2626' }}
                    title="Reversar/anular pago"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
