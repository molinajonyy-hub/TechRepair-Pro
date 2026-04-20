import { useState } from 'react'
import { Mail, Send, CheckCircle, Bell } from 'lucide-react'
import { notificationService } from '../../services/notifications'

interface NotificationCardProps {
  orderId: string
  customerEmail?: string
  customerName: string
  currentStatus: string
}

const statusOptions = [
  { value: 'new', label: 'Nueva', notify: false },
  { value: 'diagnosis', label: 'Diagnóstico', notify: false },
  { value: 'repair', label: 'En Reparación', notify: true },
  { value: 'ready_delivery', label: 'Listo para Entregar', notify: true },
  { value: 'completed', label: 'Completada', notify: true },
  { value: 'cancelled', label: 'Cancelada', notify: true }
]

export function NotificationCard({ 
  orderId, 
  customerEmail, 
  customerName, 
  currentStatus 
}: NotificationCardProps) {
  const [selectedStatus, setSelectedStatus] = useState(currentStatus)
  const [customMessage, setCustomMessage] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [lastSent, setLastSent] = useState<string | null>(null)
  const [error, setError] = useState('')

  const handleSendNotification = async () => {
    if (!customerEmail) {
      setError('El cliente no tiene email registrado')
      return
    }

    setIsSending(true)
    setError('')

    try {
      const template = notificationService.generateStatusMessage(
        selectedStatus, 
        orderId, 
        customerName
      )

      const success = await notificationService.sendStatusChangeEmail({
        to: customerEmail,
        subject: template.subject,
        body: customMessage || template.body,
        orderId,
        customerName,
        status: selectedStatus
      })

      if (success) {
        setLastSent(selectedStatus)
        setCustomMessage('')
      } else {
        setError('Error al enviar la notificación')
      }
    } catch (err: any) {
      setError(err.message || 'Error al enviar')
    } finally {
      setIsSending(false)
    }
  }

  const shouldNotify = statusOptions.find(s => s.value === selectedStatus)?.notify

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Bell size={18} color="#6366f1" />
        <h3 className="card-title">Notificar al Cliente</h3>
      </div>
      
      <div className="card-body">
        {!customerEmail && (
          <div style={{
            padding: '0.75rem 1rem',
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            borderRadius: '0.5rem',
            color: '#f59e0b',
            marginBottom: '1rem',
            fontSize: '0.875rem'
          }}>
            ⚠️ El cliente no tiene email registrado. No se pueden enviar notificaciones.
          </div>
        )}

        {lastSent && (
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
            Notificación enviada correctamente
          </div>
        )}

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

        <div style={{ marginBottom: '1rem' }}>
          <label className="form-label">Estado para notificar</label>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="form-select"
            disabled={!customerEmail}
          >
            {statusOptions.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label} {status.notify ? '(recomendado)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label className="form-label">
            Mensaje personalizado (opcional)
          </label>
          <textarea
            value={customMessage}
            onChange={(e) => setCustomMessage(e.target.value)}
            placeholder="Dejá en blanco para usar el mensaje automático..."
            className="form-control"
            rows={3}
            disabled={!customerEmail}
          />
        </div>

        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          padding: '0.75rem',
          backgroundColor: '#1e293b',
          borderRadius: '0.5rem',
          marginBottom: '1rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Mail size={16} color="#64748b" />
            <span style={{ fontSize: '0.875rem', color: '#a0aec0' }}>
              {customerEmail || 'Sin email'}
            </span>
          </div>
          {shouldNotify && (
            <span style={{ 
              fontSize: '0.75rem', 
              color: '#6366f1',
              backgroundColor: 'rgba(99, 102, 241, 0.1)',
              padding: '0.25rem 0.5rem',
              borderRadius: '0.25rem'
            }}>
              Se recomienda notificar
            </span>
          )}
        </div>

        <button
          onClick={handleSendNotification}
          disabled={isSending || !customerEmail}
          className="btn btn-primary"
          style={{ width: '100%' }}
        >
          {isSending ? (
            <>
              <span className="spinner-border spinner-border-sm" style={{ marginRight: '0.5rem' }}></span>
              Enviando...
            </>
          ) : (
            <>
              <Send size={18} style={{ marginRight: '0.5rem' }} />
              Enviar Notificación
            </>
          )}
        </button>
      </div>
    </div>
  )
}
