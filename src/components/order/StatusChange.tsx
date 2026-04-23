import { useState, useRef } from 'react'
import { CheckCircle, Loader2, ArrowRight, MessageSquare, AlertTriangle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import {
  OrderStatus,
  STATUS_CONFIG,
  getAllowedTransitions,
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

const STATUS_DESCRIPTIONS: Partial<Record<OrderStatus, string>> = {
  new:              'Orden recién creada, aún sin procesar',
  diagnosis:        'Evaluando el dispositivo para determinar qué tiene',
  waiting_approval: 'Esperando que el cliente apruebe el presupuesto',
  repair:           'La reparación está en curso',
  waiting_parts:    'Falta que lleguen los repuestos necesarios',
  ready_delivery:   'El equipo está listo para ser retirado',
  waiting_payment:  'El cliente todavía no realizó el pago',
  completed:        'La orden se cerró — equipo entregado',
  cancelled:        'La orden fue cancelada',
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

  const allowedStatuses = getAllowedTransitions(currentStatus)
  const currentConfig = STATUS_CONFIG[currentStatus]

  // Orden no modificable (estado final)
  if (allowedStatuses.length === 0) {
    return (
      <div className="card" style={{
        marginBottom: '1.5rem',
        border: `1px solid ${currentConfig.color}30`,
        backgroundColor: `${currentConfig.color}08`,
      }}>
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{
            width: '40px', height: '40px', borderRadius: '50%',
            backgroundColor: `${currentConfig.color}20`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <CheckCircle size={22} style={{ color: currentConfig.color }} />
          </div>
          <div>
            <h4 style={{ color: '#f8fafc', margin: 0, fontSize: '0.9375rem' }}>
              Orden {currentConfig.label.toLowerCase()}
            </h4>
            <p style={{ color: '#64748b', margin: '0.2rem 0 0', fontSize: '0.8125rem' }}>
              {STATUS_DESCRIPTIONS[currentStatus] || currentConfig.description}
            </p>
          </div>
        </div>
      </div>
    )
  }

  const handleStatusSelect = (status: OrderStatus) => {
    if (status === selectedStatus) {
      setSelectedStatus('')
      setConfirmCancel(false)
      return
    }
    setSelectedStatus(status)
    setError('')
    setSuccess(false)
    setConfirmCancel(false)
  }

  const handleUpdate = async () => {
    if (!selectedStatus || selectedStatus === currentStatus) return

    // Confirmación extra solo para cancelar
    if (selectedStatus === 'cancelled' && !confirmCancel) {
      setConfirmCancel(true)
      return
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

      // Notificación interna (no crítica)
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

  const selectedConfig = selectedStatus ? STATUS_CONFIG[selectedStatus] : null

  return (
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      {/* Header — estado actual */}
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
        {/* Mensaje de error */}
        {error && (
          <div style={{
            padding: '0.75rem 1rem',
            backgroundColor: 'rgba(220,38,38,0.1)',
            border: '1px solid rgba(220,38,38,0.3)',
            borderRadius: '0.5rem', color: '#f87171',
            marginBottom: '1rem', fontSize: '0.85rem',
          }}>
            {error}
          </div>
        )}

        {/* Mensaje de éxito */}
        {success && (
          <div style={{
            padding: '0.75rem 1rem',
            backgroundColor: 'rgba(16,185,129,0.1)',
            border: '1px solid rgba(16,185,129,0.25)',
            borderRadius: '0.5rem', color: '#34d399',
            marginBottom: '1rem', fontSize: '0.85rem',
            display: 'flex', alignItems: 'center', gap: '0.5rem',
          }}>
            <CheckCircle size={15} />
            Estado actualizado correctamente
            {whatsappSent && <span style={{ marginLeft: '0.5rem', color: '#4ade80' }}>· WhatsApp enviado 💬</span>}
          </div>
        )}

        {/* Label */}
        <p style={{
          fontSize: '0.75rem', color: '#475569', fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 0.75rem',
        }}>
          Cambiar estado
        </p>

        {/* Grilla de estados */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '1rem' }}>
          {allowedStatuses.map(status => {
            const cfg = STATUS_CONFIG[status]
            const isSelected = selectedStatus === status
            const isCancel = status === 'cancelled'
            const isCompleted = status === 'completed'

            return (
              <button
                key={status}
                onClick={() => handleStatusSelect(status)}
                disabled={isUpdating}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.7rem 1rem',
                  borderRadius: '0.625rem',
                  border: isSelected
                    ? `2px solid ${cfg.color}`
                    : `1px solid ${isCancel ? 'rgba(220,38,38,0.15)' : 'rgba(255,255,255,0.07)'}`,
                  backgroundColor: isSelected
                    ? `${cfg.color}18`
                    : isCancel
                    ? 'rgba(220,38,38,0.04)'
                    : 'rgba(255,255,255,0.03)',
                  cursor: isUpdating ? 'not-allowed' : 'pointer',
                  textAlign: 'left', width: '100%',
                  transition: 'all 0.15s',
                  opacity: isUpdating ? 0.6 : 1,
                }}
              >
                {/* Dot */}
                <div style={{
                  width: '9px', height: '9px', borderRadius: '50%',
                  backgroundColor: isSelected ? cfg.color : 'rgba(255,255,255,0.15)',
                  flexShrink: 0,
                  boxShadow: isSelected ? `0 0 8px ${cfg.color}80` : 'none',
                  transition: 'all 0.15s',
                }} />

                <div style={{ flex: 1 }}>
                  <div style={{
                    fontSize: '0.875rem',
                    fontWeight: isSelected ? 700 : 500,
                    color: isSelected ? '#f1f5f9' : isCancel ? '#f87171' : '#94a3b8',
                  }}>
                    {cfg.label}
                  </div>
                  {STATUS_DESCRIPTIONS[status] && (
                    <div style={{
                      fontSize: '0.73rem',
                      color: isSelected ? '#64748b' : '#334155',
                      marginTop: '0.1rem',
                    }}>
                      {STATUS_DESCRIPTIONS[status]}
                    </div>
                  )}
                </div>

                {/* Badges de estado especial */}
                {isCompleted && !isSelected && (
                  <span style={{
                    fontSize: '0.65rem', color: '#10b981',
                    backgroundColor: 'rgba(16,185,129,0.1)',
                    padding: '0.1rem 0.5rem', borderRadius: '3px', flexShrink: 0,
                  }}>
                    finaliza
                  </span>
                )}
                {isCancel && !isSelected && (
                  <span style={{
                    fontSize: '0.65rem', color: '#dc2626',
                    backgroundColor: 'rgba(220,38,38,0.1)',
                    padding: '0.1rem 0.5rem', borderRadius: '3px', flexShrink: 0,
                  }}>
                    irreversible
                  </span>
                )}
                {isSelected && <ArrowRight size={15} style={{ color: cfg.color, flexShrink: 0 }} />}
              </button>
            )
          })}
        </div>

        {/* Nota opcional */}
        {selectedStatus && (
          <div style={{ marginBottom: '1rem' }}>
            <label style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              fontSize: '0.75rem', color: '#475569', fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem',
            }}>
              <MessageSquare size={12} />
              Nota (opcional)
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Comentario sobre este cambio de estado..."
              className="form-control"
              rows={2}
              disabled={isUpdating}
              style={{ fontSize: '0.875rem', resize: 'none' }}
            />
          </div>
        )}

        {/* Confirmación extra para cancelar */}
        {confirmCancel && selectedStatus === 'cancelled' && (
          <div style={{
            padding: '0.75rem 1rem', marginBottom: '1rem',
            backgroundColor: 'rgba(220,38,38,0.08)',
            border: '1px solid rgba(220,38,38,0.3)',
            borderRadius: '0.5rem',
            display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
          }}>
            <AlertTriangle size={15} style={{ color: '#f87171', flexShrink: 0, marginTop: '0.1rem' }} />
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#f87171', marginBottom: '0.2rem' }}>
                ¿Confirmar cancelación?
              </div>
              <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                Esta acción no se puede deshacer. Hacé clic en "Cancelar orden" para confirmar.
              </div>
            </div>
          </div>
        )}

        {/* Botón confirmar */}
        <button
          onClick={handleUpdate}
          disabled={isUpdating || !selectedStatus}
          style={{
            width: '100%', padding: '0.75rem',
            background: !selectedStatus
              ? 'rgba(255,255,255,0.05)'
              : confirmCancel
              ? 'linear-gradient(135deg,#b91c1c,#dc2626)'
              : `linear-gradient(135deg, ${selectedConfig?.color ?? '#6366f1'}, ${selectedConfig?.color ?? '#8b5cf6'}cc)`,
            border: 'none',
            color: selectedStatus ? '#fff' : '#475569',
            borderRadius: '0.625rem',
            cursor: !selectedStatus || isUpdating ? 'not-allowed' : 'pointer',
            fontWeight: 600, fontSize: '0.875rem',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
            transition: 'all 0.2s', opacity: isUpdating ? 0.7 : 1,
          }}
        >
          {isUpdating ? (
            <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Guardando...</>
          ) : !selectedStatus ? (
            'Seleccioná un estado'
          ) : confirmCancel ? (
            <><AlertTriangle size={16} /> Cancelar orden</>
          ) : (
            <><ArrowRight size={16} /> Cambiar a "{selectedConfig?.label}"</>
          )}
        </button>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
