import { useState } from 'react'
import { CheckCircle, Loader2, AlertTriangle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import {
  OrderStatus,
  STATUS_CONFIG,
  getAllowedTransitions,
  validateTransition,
  recordStatusChange,
  getTransitionDescription
} from '../../types/orderStatus'
import { whatsappService } from '../../services/whatsappService'
import { useAuth } from '../../contexts/AuthContext'

interface StatusChangeProps {
  orderId: string
  currentStatus: OrderStatus
  order: any // La orden completa para validaciones
  onStatusChange: () => void
}

export function StatusChange({ orderId, currentStatus, order, onStatusChange }: StatusChangeProps) {
  const { businessId } = useAuth()
  const [selectedStatus, setSelectedStatus] = useState<OrderStatus | ''>('')
  const [isUpdating, setIsUpdating] = useState(false)
  const [error, setError] = useState('')
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [success, setSuccess] = useState(false)
  const [notes, setNotes] = useState('')
  const [whatsappSent, setWhatsappSent] = useState(false)

  // Obtener transiciones permitidas desde el estado actual
  const allowedTransitions = getAllowedTransitions(currentStatus)
  
  // Solo mostrar estados permitidos en el selector
  const availableStatuses = allowedTransitions.map(status => ({
    value: status,
    ...STATUS_CONFIG[status]
  }))

  const handleStatusSelect = (status: OrderStatus) => {
    setSelectedStatus(status)
    setError('')
    setSuccess(false)
    
    // Validar inmediatamente para mostrar errores
    if (status) {
      const result = validateTransition(currentStatus, status, order)
      setValidationErrors(result.errors)
    }
  }

  const handleUpdate = async () => {
    if (!selectedStatus || selectedStatus === currentStatus) return

    setIsUpdating(true)
    setError('')
    setSuccess(false)

    try {
      // 1. Validar la transición con todas las reglas de negocio
      const validation = validateTransition(currentStatus, selectedStatus, order)
      if (!validation.valid) {
        setValidationErrors(validation.errors)
        setIsUpdating(false)
        return
      }

      // 2. Actualizar el estado de la orden
      const { error: updateError } = await supabase
        .from('orders')
        .update({ 
          status: selectedStatus, 
          updated_at: new Date().toISOString() 
        })
        .eq('id', orderId)

      if (updateError) throw updateError

      // 3. Registrar en el historial
      const userId = 'system' // En producción: obtener del auth context
      
      await recordStatusChange(supabase, {
        order_id: orderId,
        from_status: currentStatus,
        to_status: selectedStatus,
        changed_by: userId,
        notes: notes || getTransitionDescription(currentStatus, selectedStatus)
      })

      // Crear notificación del cambio de estado
      try {
        await supabase.from('notifications').insert({
          type: 'status_change',
          title: `Estado de orden actualizado`,
          message: `${STATUS_CONFIG[currentStatus].label} → ${STATUS_CONFIG[selectedStatus].label}${notes ? `: ${notes}` : ''}`,
          order_id: orderId,
          customer_id: order.customer_id || order.customer?.id || null,
          is_read: false,
          metadata: {
            from_status: currentStatus,
            to_status: selectedStatus,
            changed_by: userId,
            notes: notes || null,
          }
        })
      } catch {
        // Notificación no crítica — no interrumpir el flujo principal
      }

      setSuccess(true)
      setSelectedStatus('')
      setNotes('')
      onStatusChange() // Recargar datos

      // Auto-envío WhatsApp (si está configurado)
      if (businessId) {
        const updatedOrder = { ...order, status: selectedStatus }
        whatsappService.handleAutoSend(businessId, updatedOrder, selectedStatus)
          .then(result => {
            if (result.sent) setWhatsappSent(true)
          })
          .catch(() => { /* silencioso, no interrumpir el flujo */ })
      }

      setTimeout(() => {
        setSuccess(false)
        setWhatsappSent(false)
      }, 4000)
    } catch (err: any) {
      setError(err.message || 'Error al actualizar estado')
    } finally {
      setIsUpdating(false)
    }
  }

  // Si no hay transiciones permitidas, mostrar mensaje
  if (availableStatuses.length === 0) {
    return (
      <div className="card" style={{ marginBottom: '1.5rem', backgroundColor: 'rgba(16, 185, 129, 0.05)' }}>
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <CheckCircle size={24} color="#10b981" />
          <div>
            <h4 style={{ color: '#f8fafc', margin: 0 }}>Orden Finalizada</h4>
            <p style={{ color: '#a0aec0', margin: '0.25rem 0 0 0', fontSize: '0.875rem' }}>
              Estado actual: {STATUS_CONFIG[currentStatus].label}. No se permiten más cambios.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <div style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: STATUS_CONFIG[currentStatus].color
        }} />
        <h3 className="card-title">Cambiar Estado</h3>
        <span style={{ 
          fontSize: '0.75rem', 
          color: '#64748b',
          marginLeft: 'auto'
        }}>
          Actual: {STATUS_CONFIG[currentStatus].label}
        </span>
      </div>
      
      <div className="card-body">
        {/* Error general */}
        {error && (
          <div style={{
            padding: '0.75rem 1rem',
            backgroundColor: 'rgba(220, 38, 38, 0.1)',
            border: '1px solid rgba(220, 38, 38, 0.3)',
            borderRadius: '0.5rem',
            color: '#dc2626',
            marginBottom: '1rem',
            fontSize: '0.875rem'
          }}>
            {error}
          </div>
        )}

        {/* Errores de validación */}
        {validationErrors.length > 0 && (
          <div style={{
            padding: '0.75rem 1rem',
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            borderRadius: '0.5rem',
            color: '#f59e0b',
            marginBottom: '1rem',
            fontSize: '0.875rem'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <AlertTriangle size={16} />
              <strong>No se puede cambiar el estado:</strong>
            </div>
            <ul style={{ margin: 0, paddingLeft: '1.5rem' }}>
              {validationErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Éxito */}
        {success && (
          <div style={{
            padding: '0.75rem 1rem',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            borderRadius: '0.5rem',
            color: '#10b981',
            marginBottom: '0.5rem',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <CheckCircle size={16} />
            Estado actualizado correctamente
          </div>
        )}

        {/* WhatsApp enviado automáticamente */}
        {whatsappSent && (
          <div style={{
            padding: '0.625rem 1rem',
            backgroundColor: 'rgba(37,211,102,0.08)',
            border: '1px solid rgba(37,211,102,0.25)',
            borderRadius: '0.5rem',
            color: '#25d366',
            marginBottom: '1rem',
            fontSize: '0.825rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <span style={{ fontSize: '1rem' }}>💬</span>
            WhatsApp abierto automáticamente
          </div>
        )}

        {/* Selector de estados permitidos */}
        <div style={{ marginBottom: '1rem' }}>
          <label className="form-label">Nuevo Estado</label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {availableStatuses.map((status) => (
              <button
                key={status.value}
                onClick={() => handleStatusSelect(status.value)}
                disabled={isUpdating}
                style={{
                  padding: '0.5rem 1rem',
                  borderRadius: '0.375rem',
                  border: 'none',
                  backgroundColor: selectedStatus === status.value ? status.color : '#1e293b',
                  color: selectedStatus === status.value ? '#0a0e1a' : '#a0aec0',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  boxShadow: selectedStatus === status.value ? `0 0 0 2px ${status.color}40` : 'none'
                }}
              >
                {status.label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.5rem' }}>
            Solo se muestran los estados permitidos desde "{STATUS_CONFIG[currentStatus].label}"
          </p>
        </div>

        {/* Notas del cambio */}
        {selectedStatus && (
          <div style={{ marginBottom: '1rem' }}>
            <label className="form-label">Notas (opcional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={`Motivo del cambio a "${STATUS_CONFIG[selectedStatus].label}"...`}
              className="form-control"
              rows={2}
              disabled={isUpdating}
            />
          </div>
        )}

        {/* Botón de actualizar */}
        <button
          onClick={handleUpdate}
          disabled={isUpdating || !selectedStatus || validationErrors.length > 0}
          className="btn btn-primary"
          style={{ width: '100%' }}
        >
          {isUpdating ? (
            <>
              <Loader2 size={16} style={{ marginRight: '0.5rem', animation: 'spin 1s linear infinite' }} />
              Actualizando...
            </>
          ) : (
            'Confirmar Cambio de Estado'
          )}
        </button>
      </div>
      
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
