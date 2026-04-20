import { useState, useRef, useEffect } from 'react'
import { Bell, Check, ArrowRight, Loader2 } from 'lucide-react'
import { useNotifications } from '../../hooks/useNotifications'
import { STATUS_CONFIG } from '../../types/orderStatus'
import { Link } from 'react-router-dom'

export function NotificationsDropdown() {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const { notifications, unreadCount, loading, markAsRead, markAllAsRead } = useNotifications()

  // Cerrar al hacer click fuera
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'status_change':
        return <ArrowRight size={16} color="#6366f1" />
      case 'payment_received':
        return <Check size={16} color="#10b981" />
      default:
        return <Bell size={16} color="#a0aec0" />
    }
  }

  const formatTime = (date: string) => {
    const now = new Date()
    const notifDate = new Date(date)
    const diffMs = now.getTime() - notifDate.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Ahora'
    if (diffMins < 60) return `${diffMins} min`
    if (diffHours < 24) return `${diffHours} h`
    if (diffDays < 7) return `${diffDays} d`
    return notifDate.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
  }

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      {/* Botón del campanita */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          position: 'relative',
          padding: '0.5rem',
          backgroundColor: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: '#a0aec0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <Bell size={20} />
        
        {/* Badge de no leídas */}
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: '0',
              right: '0',
              width: '18px',
              height: '18px',
              backgroundColor: '#dc2626',
              color: '#fff',
              fontSize: '0.625rem',
              fontWeight: 600,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 0.5rem)',
            right: '0',
            width: '380px',
            maxHeight: '480px',
            backgroundColor: '#1e293b',
            border: '1px solid #374151',
            borderRadius: '0.75rem',
            boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.3)',
            zIndex: 1000,
            overflow: 'hidden'
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '1rem',
              borderBottom: '1px solid #374151'
            }}
          >
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#f8fafc' }}>
              Notificaciones
            </h3>
            {unreadCount > 0 && (
              <button
                onClick={markAllAsRead}
                style={{
                  fontSize: '0.75rem',
                  color: '#6366f1',
                  backgroundColor: 'transparent',
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                Marcar todo como leído
              </button>
            )}
          </div>

          {/* Lista */}
          <div style={{ maxHeight: '360px', overflowY: 'auto' }}>
            {loading ? (
              <div style={{ padding: '2rem', textAlign: 'center' }}>
                <Loader2 size={24} color="#6366f1" style={{ animation: 'spin 1s linear infinite' }} />
              </div>
            ) : notifications.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
                <Bell size={32} style={{ marginBottom: '0.5rem', opacity: 0.5 }} />
                <p style={{ margin: 0 }}>No hay notificaciones</p>
              </div>
            ) : (
              notifications.map((notification) => (
                <div
                  key={notification.id}
                  onClick={() => {
                    if (!notification.is_read) {
                      markAsRead(notification.id)
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    padding: '1rem',
                    borderBottom: '1px solid #374151',
                    backgroundColor: notification.is_read ? 'transparent' : 'rgba(99, 102, 241, 0.1)',
                    cursor: 'pointer',
                    transition: 'background-color 0.2s'
                  }}
                >
                  {/* Icono */}
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      backgroundColor: notification.is_read ? '#1e293b' : '#6366f120',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0
                    }}
                  >
                    {getNotificationIcon(notification.type)}
                  </div>

                  {/* Contenido */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <p
                        style={{
                          margin: 0,
                          fontWeight: notification.is_read ? 400 : 600,
                          color: '#f8fafc',
                          fontSize: '0.875rem',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {notification.title}
                      </p>
                      {!notification.is_read && (
                        <span
                          style={{
                            width: '6px',
                            height: '6px',
                            backgroundColor: '#6366f1',
                            borderRadius: '50%',
                            flexShrink: 0
                          }}
                        />
                      )}
                    </div>

                    {notification.message && (
                      <p
                        style={{
                          margin: '0.25rem 0 0 0',
                          fontSize: '0.75rem',
                          color: '#a0aec0',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical'
                        }}
                      >
                        {notification.message}
                      </p>
                    )}

                    {/* Estado de la orden si aplica */}
                    {notification.metadata?.to_status && (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          marginTop: '0.5rem',
                          padding: '0.125rem 0.5rem',
                          backgroundColor: `${STATUS_CONFIG[notification.metadata.to_status as keyof typeof STATUS_CONFIG]?.color || '#64748b'}20`,
                          color: STATUS_CONFIG[notification.metadata.to_status as keyof typeof STATUS_CONFIG]?.color || '#64748b',
                          fontSize: '0.625rem',
                          fontWeight: 500,
                          borderRadius: '0.25rem',
                          textTransform: 'uppercase'
                        }}
                      >
                        {STATUS_CONFIG[notification.metadata.to_status as keyof typeof STATUS_CONFIG]?.label || notification.metadata.to_status}
                      </span>
                    )}

                    <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.625rem', color: '#64748b' }}>
                      {formatTime(notification.created_at)}
                    </p>
                  </div>

                  {/* Link a la orden */}
                  {notification.order_id && (
                    <Link
                      to={`/orders/${notification.order_id}`}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        padding: '0.25rem',
                        color: '#64748b',
                        borderRadius: '0.25rem',
                        flexShrink: 0
                      }}
                      title="Ver orden"
                    >
                      <ArrowRight size={16} />
                    </Link>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div
            style={{
              padding: '0.75rem',
              borderTop: '1px solid #374151',
              textAlign: 'center'
            }}
          >
            <Link
              to="/notifications"
              onClick={() => setIsOpen(false)}
              style={{
                fontSize: '0.875rem',
                color: '#6366f1',
                textDecoration: 'none'
              }}
            >
              Ver todas las notificaciones
            </Link>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
