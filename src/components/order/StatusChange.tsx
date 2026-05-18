import { useState, useRef } from 'react'
import { CheckCircle, Loader2, MessageSquare, AlertTriangle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import {
  OrderStatus,
  STATUS_CONFIG,
  STATUS_ORDER,
  recordStatusChange,
} from '../../types/orderStatus'
import { whatsappService } from '../../services/whatsappService'
import { useAuth } from '../../contexts/AuthContext'

interface StatusChangeProps {
  orderId: string
  currentStatus: OrderStatus
  order: any
  onStatusChange: () => void
}

export function StatusChange({ orderId, currentStatus, order, onStatusChange }: StatusChangeProps) {
  const { businessId, user } = useAuth()
  const [selectedStatus, setSelectedStatus] = useState<OrderStatus | ''>('')
  const [isUpdating, setIsUpdating] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [notes, setNotes] = useState('')
  const [whatsappSent, setWhatsappSent] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const currentConfig = STATUS_CONFIG[currentStatus]

  const handleUpdate = async () => {
    if (!selectedStatus || selectedStatus === currentStatus) return

    if (selectedStatus === 'cancelled' && !confirmCancel) {
      setConfirmCancel(true)
      return
    }

    // Confirmar al reabrir una orden completada
    if (currentStatus === 'completed' && selectedStatus !== 'cancelled') {
      if (!window.confirm(`¿Reabrir esta orden y cambiarla a "${STATUS_CONFIG[selectedStatus].label}"? La orden estaba completada.`)) return
    }

    setIsUpdating(true)
    setError('')
    setSuccess(false)

    try {
      const { error: updateError } = await supabase
        .from('orders')
        .update({ status: selectedStatus, updated_at: new Date().toISOString() })
        .eq('id', orderId)

      if (updateError) throw updateError

      await recordStatusChange(supabase, {
        order_id: orderId,
        from_status: currentStatus,
        to_status: selectedStatus,
        changed_by: user?.id ?? null,
        notes: notes || undefined,
        business_id: businessId!,
      })

      try {
        await supabase.from('notifications').insert({
          type: 'status_change',
          title: 'Estado de orden actualizado',
          message: `${STATUS_CONFIG[currentStatus].label} → ${STATUS_CONFIG[selectedStatus].label}${notes ? `: ${notes}` : ''}`,
          order_id: orderId,
          customer_id: order.customer_id || order.customer?.id || null,
          is_read: false,
          metadata: { from_status: currentStatus, to_status: selectedStatus, changed_by: user?.id },
        })
      } catch { /* silencioso */ }

      setSuccess(true)
      setSelectedStatus('')
      setNotes('')
      setConfirmCancel(false)
      onStatusChange()

      if (businessId) {
        whatsappService
          .handleAutoSend(businessId, { ...order, status: selectedStatus }, selectedStatus)
          .then(result => { if (result.sent) setWhatsappSent(true) })
          .catch(() => {})
      }

      if (successTimerRef.current) clearTimeout(successTimerRef.current)
      successTimerRef.current = setTimeout(() => {
        setSuccess(false)
        setWhatsappSent(false)
      }, 4000)
    } catch (err: any) {
      setError(err.message || 'Error al actualizar el estado')
      setConfirmCancel(false)
    } finally {
      setIsUpdating(false)
    }
  }

  const otherStatuses = STATUS_ORDER.filter(s => s !== currentStatus)

  return (
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      {/* Estado actual */}
      <div style={{
        padding: '1rem 1.25rem',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', alignItems: 'center', gap: '0.75rem',
      }}>
        <div style={{
          width: '10px', height: '10px', borderRadius: '50%',
          backgroundColor: currentConfig.color,
          boxShadow: `0 0 8px ${currentConfig.color}80`,
          flexShrink: 0,
        }} />
        <div style={{ flex: 1 }}>
          <span style={{ fontSize: '0.7rem', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
            Estado actual
          </span>
          <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#f1f5f9' }}>
            {currentConfig.label}
          </div>
        </div>
      </div>

      <div style={{ padding: '1rem 1.25rem' }}>
        {error && (
          <div style={{
            padding: '0.625rem 0.875rem', backgroundColor: 'rgba(220,38,38,0.1)',
            border: '1px solid rgba(220,38,38,0.3)', borderRadius: '0.5rem',
            color: '#f87171', marginBottom: '0.875rem', fontSize: '0.83rem',
          }}>
            {error}
          </div>
        )}

        {success && (
          <div style={{
            padding: '0.625rem 0.875rem', backgroundColor: 'rgba(16,185,129,0.1)',
            border: '1px solid rgba(16,185,129,0.25)', borderRadius: '0.5rem',
            color: '#34d399', marginBottom: '0.875rem', fontSize: '0.83rem',
            display: 'flex', alignItems: 'center', gap: '0.5rem',
          }}>
            <CheckCircle size={14} />
            Estado actualizado
            {whatsappSent && <span style={{ color: '#4ade80' }}>· WhatsApp enviado 💬</span>}
          </div>
        )}

        {/* Selector libre */}
        <label style={{ fontSize: '0.72rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: '0.5rem' }}>
          Cambiar a
        </label>
        <select
          value={selectedStatus}
          onChange={e => { setSelectedStatus(e.target.value as OrderStatus | ''); setConfirmCancel(false) }}
          disabled={isUpdating}
          style={{
            width: '100%', padding: '0.625rem 0.875rem',
            background: 'rgba(255,255,255,0.05)',
            border: `1px solid ${selectedStatus ? STATUS_CONFIG[selectedStatus as OrderStatus]?.color + '60' : 'rgba(255,255,255,0.1)'}`,
            borderRadius: '0.625rem', color: selectedStatus ? '#f1f5f9' : '#64748b',
            fontSize: '0.9rem', fontWeight: selectedStatus ? 600 : 400,
            marginBottom: '0.75rem', cursor: 'pointer', outline: 'none',
          }}
        >
          <option value="">Seleccionar estado...</option>
          {otherStatuses.map(s => (
            <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>
          ))}
        </select>

        {/* Nota */}
        {selectedStatus && (
          <div style={{ marginBottom: '0.875rem' }}>
            <label style={{
              display: 'flex', alignItems: 'center', gap: '0.35rem',
              fontSize: '0.72rem', color: '#475569', fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.4rem',
            }}>
              <MessageSquare size={11} /> Nota (opcional)
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Comentario sobre este cambio..."
              className="form-control"
              rows={2}
              disabled={isUpdating}
              style={{ fontSize: '0.85rem', resize: 'none' }}
            />
          </div>
        )}

        {/* Confirmación cancelar */}
        {confirmCancel && (
          <div style={{
            padding: '0.625rem 0.875rem', marginBottom: '0.875rem',
            backgroundColor: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.3)',
            borderRadius: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem',
          }}>
            <AlertTriangle size={14} style={{ color: '#f87171', flexShrink: 0 }} />
            <span style={{ fontSize: '0.83rem', color: '#f87171' }}>
              ¿Confirmar cancelación? Hacé clic de nuevo para confirmar.
            </span>
          </div>
        )}

        <button
          onClick={handleUpdate}
          disabled={isUpdating || !selectedStatus || selectedStatus === currentStatus}
          style={{
            width: '100%', padding: '0.75rem',
            background: !selectedStatus || selectedStatus === currentStatus
              ? 'rgba(255,255,255,0.05)'
              : confirmCancel
              ? 'linear-gradient(135deg,#b91c1c,#dc2626)'
              : selectedStatus
              ? `linear-gradient(135deg, ${STATUS_CONFIG[selectedStatus as OrderStatus]?.color}, ${STATUS_CONFIG[selectedStatus as OrderStatus]?.color}bb)`
              : 'rgba(255,255,255,0.05)',
            border: 'none',
            color: selectedStatus && selectedStatus !== currentStatus ? '#fff' : '#475569',
            borderRadius: '0.625rem',
            cursor: !selectedStatus || isUpdating || selectedStatus === currentStatus ? 'not-allowed' : 'pointer',
            fontWeight: 600, fontSize: '0.875rem',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
            transition: 'all 0.15s',
          }}
        >
          {isUpdating
            ? <><Loader2 size={15} style={{ animation: 'tr-spin 1s linear infinite' }} /> Guardando...</>
            : !selectedStatus || selectedStatus === currentStatus
            ? 'Seleccioná un estado'
            : confirmCancel
            ? <><AlertTriangle size={15} /> Confirmar cancelación</>
            : `Cambiar a "${STATUS_CONFIG[selectedStatus as OrderStatus]?.label}"`
          }
        </button>
      </div>
    </div>
  )
}
