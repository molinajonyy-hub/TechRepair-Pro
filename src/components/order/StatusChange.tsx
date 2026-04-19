import { useState, useEffect, useRef } from 'react'
import { CheckCircle, Loader2, AlertTriangle, ArrowRight, MessageSquare } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import {
  OrderStatus,
  STATUS_CONFIG,
  getAllowedTransitions,
  validateTransition,
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

// Descripciones de qué significa cada estado para el técnico
const STATUS_DESCRIPTIONS: Partial<Record<OrderStatus, string>> = {
  diagnosis:        'Estás evaluando el dispositivo para determinar qué tiene',
  waiting_approval: 'Esperás que el cliente apruebe el presupuesto',
  repair:           'La reparación está en curso',
  waiting_parts:    'Falta que lleguen los repuestos necesarios',
  ready_delivery:   'El equipo está reparado y listo para ser retirado',
  waiting_payment:  'El cliente todavía no pagó',
  completed:        'La orden se cerró, el equipo fue entregado y cobrado',
  cancelled:        'La orden fue cancelada',
}

export function StatusChange({ orderId, currentStatus, order, onStatusChange }: StatusChangeProps) {
  const { businessId, user } = useAuth()
  const [selectedStatus, setSelectedStatus] = useState<OrderStatus | ''>('')
  const [isUpdating, setIsUpdating] = useState(false)
  const [error, setError] = useState('')
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [success, setSuccess] = useState(false)
  const [notes, setNotes] = useState('')
  const [whatsappSent, setWhatsappSent] = useState(false)
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => { if (successTimerRef.current) clearTimeout(successTimerRef.current) }
  }, [])

  const allowedTransitions = getAllowedTransitions(currentStatus)
  const availableStatuses = allowedTransitions.map(status => ({
    value: status,
    ...STATUS_CONFIG[status],
  }))

  const handleStatusSelect = (status: OrderStatus) => {
    setSelectedStatus(status)
    setError('')
    setSuccess(false)
    const result = validateTransition(currentStatus, status, order)
    setValidationErrors(result.errors)
  }

  const handleUpdate = async () => {
    if (!selectedStatus || selectedStatus === currentStatus) return
    setIsUpdating(true)
    setError('')
    setSuccess(false)

    try {
      const validation = validateTransition(currentStatus, selectedStatus, order)
      if (!validation.valid) {
        setValidationErrors(validation.errors)
        return
      }

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

      // Notificación (no crítica)
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
      onStatusChange()

      if (businessId) {
        whatsappService.handleAutoSend(businessId, { ...order, status: selectedStatus }, selectedStatus)
          .then(result => { if (result.sent) setWhatsappSent(true) })
          .catch(() => {})
      }

      if (successTimerRef.current) clearTimeout(successTimerRef.current)
      successTimerRef.current = setTimeout(() => {
        setSuccess(false)
        setWhatsappSent(false)
      }, 4000)
    } catch (err: any) {
      setError(err.message || 'Error al actualizar estado')
    } finally {
      setIsUpdating(false)
    }
  }

  const currentConfig = STATUS_CONFIG[currentStatus]

  if (availableStatuses.length === 0) {
    return (
      <div className="card" style={{ marginBottom: '1.5rem', border: `1px solid ${currentConfig.color}30`, backgroundColor: `${currentConfig.color}08` }}>
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '50%', backgroundColor: `${currentConfig.color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <CheckCircle size={22} style={{ color: currentConfig.color }} />
          </div>
          <div>
            <h4 style={{ color: '#f8fafc', margin: 0, fontSize: '0.9375rem' }}>Orden finalizada</h4>
            <p style={{ color: '#64748b', margin: '0.2rem 0 0', fontSize: '0.8125rem' }}>
              {STATUS_DESCRIPTIONS[currentStatus] || `Estado: ${currentConfig.label}`}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      {/* Header con estado actual */}
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
          {STATUS_DESCRIPTIONS[currentStatus] && (
            <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.1rem' }}>
              {STATUS_DESCRIPTIONS[currentStatus]}
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: '1.25rem' }}>
        {/* Mensajes de estado */}
        {error && (
          <div style={{ padding: '0.75rem 1rem', backgroundColor: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: '0.5rem', color: '#f87171', marginBottom: '1rem', fontSize: '0.85rem' }}>
            {error}
          </div>
        )}

        {validationErrors.length > 0 && (
          <div style={{ padding: '0.75rem 1rem', backgroundColor: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '0.5rem', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#fbbf24', marginBottom: '0.5rem', fontSize: '0.85rem', fontWeight: 600 }}>
              <AlertTriangle size={15} />
              Requisitos pendientes:
            </div>
            <ul style={{ margin: 0, paddingLeft: '1.25rem', color: '#f59e0b', fontSize: '0.8125rem' }}>
              {validationErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}

        {success && (
          <div style={{ padding: '0.75rem 1rem', backgroundColor: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '0.5rem', color: '#34d399', marginBottom: '1rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <CheckCircle size={15} />
            Estado actualizado correctamente
            {whatsappSent && <span style={{ marginLeft: '0.5rem', color: '#4ade80' }}>· WhatsApp enviado 💬</span>}
          </div>
        )}

        {/* Selector de estados — cards visuales */}
        <p style={{ fontSize: '0.75rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 0.75rem' }}>
          Mover a
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
          {availableStatuses.map(status => {
            const isSelected = selectedStatus === status.value
            const isCancel = status.value === 'cancelled'
            return (
              <button
                key={status.value}
                onClick={() => handleStatusSelect(status.value)}
                disabled={isUpdating}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.75rem 1rem',
                  borderRadius: '0.625rem',
                  border: isSelected
                    ? `2px solid ${status.color}`
                    : '1px solid rgba(255,255,255,0.07)',
                  backgroundColor: isSelected
                    ? `${status.color}15`
                    : 'rgba(255,255,255,0.03)',
                  cursor: isUpdating ? 'not-allowed' : 'pointer',
                  textAlign: 'left', width: '100%',
                  transition: 'all 0.15s',
                  opacity: isUpdating ? 0.6 : 1,
                }}
              >
                {/* Dot */}
                <div style={{
                  width: '10px', height: '10px', borderRadius: '50%',
                  backgroundColor: isSelected ? status.color : 'rgba(255,255,255,0.15)',
                  flexShrink: 0,
                  boxShadow: isSelected ? `0 0 8px ${status.color}80` : 'none',
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.875rem', fontWeight: isSelected ? 600 : 500, color: isSelected ? '#f1f5f9' : '#94a3b8' }}>
                    {status.label}
                  </div>
                  {STATUS_DESCRIPTIONS[status.value] && (
                    <div style={{ fontSize: '0.75rem', color: isSelected ? '#64748b' : '#334155', marginTop: '0.1rem' }}>
                      {STATUS_DESCRIPTIONS[status.value]}
                    </div>
                  )}
                </div>
                {isSelected && <ArrowRight size={15} style={{ color: status.color, flexShrink: 0 }} />}
                {isCancel && !isSelected && (
                  <span style={{ fontSize: '0.65rem', color: '#dc2626', backgroundColor: 'rgba(220,38,38,0.1)', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>
                    irreversible
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Nota opcional — solo si hay estado seleccionado */}
        {selectedStatus && (
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
              <MessageSquare size={12} />
              Nota (opcional)
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Agregá un comentario sobre este cambio..."
              className="form-control"
              rows={2}
              disabled={isUpdating}
              style={{ fontSize: '0.875rem', resize: 'none' }}
            />
          </div>
        )}

        {/* Botón confirmar */}
        <button
          onClick={handleUpdate}
          disabled={isUpdating || !selectedStatus || validationErrors.length > 0}
          style={{
            width: '100%', padding: '0.75rem',
            background: selectedStatus && validationErrors.length === 0
              ? `linear-gradient(135deg, ${STATUS_CONFIG[selectedStatus as OrderStatus]?.color ?? '#6366f1'}, ${STATUS_CONFIG[selectedStatus as OrderStatus]?.color ?? '#8b5cf6'}cc)`
              : 'rgba(255,255,255,0.05)',
            border: 'none',
            color: selectedStatus && validationErrors.length === 0 ? '#fff' : '#475569',
            borderRadius: '0.625rem', cursor: !selectedStatus || isUpdating ? 'not-allowed' : 'pointer',
            fontWeight: 600, fontSize: '0.875rem',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
            transition: 'all 0.2s', opacity: isUpdating ? 0.7 : 1,
          }}
        >
          {isUpdating ? (
            <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Guardando...</>
          ) : selectedStatus ? (
            <>
              <ArrowRight size={16} />
              Cambiar a "{STATUS_CONFIG[selectedStatus as OrderStatus]?.label}"
            </>
          ) : (
            'Seleccioná un estado'
          )}
        </button>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
