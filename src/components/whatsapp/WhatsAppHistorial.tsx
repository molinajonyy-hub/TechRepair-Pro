import { useState, useEffect } from 'react'
import { MessageCircle, Clock, User, Zap, CheckCircle, Copy, ExternalLink, XCircle, RefreshCw } from 'lucide-react'
import { whatsappService, WhatsAppLog } from '../../services/whatsappService'

interface WhatsAppHistorialProps {
  orderId: string
}

const RESULT_CONFIG = {
  opened:  { label: 'Enviado',  color: '#25d366', icon: ExternalLink },
  copied:  { label: 'Copiado',  color: '#6366f1', icon: Copy },
  failed:  { label: 'Error',    color: '#dc2626', icon: XCircle },
  skipped: { label: 'Omitido', color: '#64748b', icon: XCircle },
}

const MODE_CONFIG = {
  manual: { label: 'Manual',    color: '#818cf8', icon: User },
  auto:   { label: 'Automático', color: '#25d366', icon: Zap },
}

export function WhatsAppHistorial({ orderId }: WhatsAppHistorialProps) {
  const [logs, setLogs] = useState<WhatsAppLog[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    load()
  }, [orderId])

  const load = async () => {
    setLoading(true)
    try {
      const data = await whatsappService.getLogs(orderId)
      setLogs(data)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      backgroundColor: '#0f172a',
      borderRadius: '0.75rem',
      border: '1px solid rgba(51,65,85,0.4)',
      overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '1rem 1.25rem',
        borderBottom: '1px solid rgba(51,65,85,0.4)',
        backgroundColor: 'rgba(15,23,42,0.5)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
          <MessageCircle size={18} color="#25d366" />
          <h3 style={{ color: '#fff', fontWeight: 600, fontSize: '0.95rem', margin: 0 }}>
            Historial WhatsApp
          </h3>
          {logs.length > 0 && (
            <span style={{
              backgroundColor: 'rgba(37,211,102,0.15)',
              color: '#25d366', fontSize: '0.75rem',
              padding: '0.15rem 0.5rem', borderRadius: '999px', fontWeight: 600
            }}>
              {logs.length}
            </span>
          )}
        </div>
        <button
          onClick={load}
          style={{
            padding: '0.35rem', background: 'transparent', border: 'none',
            color: '#64748b', cursor: 'pointer', borderRadius: '0.4rem',
            display: 'flex', alignItems: 'center'
          }}
          title="Actualizar"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      <div style={{ padding: '1rem' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '1.5rem', color: '#475569', fontSize: '0.875rem' }}>
            Cargando historial...
          </div>
        ) : logs.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '2rem',
            color: '#475569', fontSize: '0.875rem'
          }}>
            <MessageCircle size={32} style={{ opacity: 0.3, marginBottom: '0.75rem' }} />
            <p style={{ margin: 0 }}>Aún no se enviaron mensajes por WhatsApp en esta orden.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            {logs.map((log, i) => {
              const resultCfg = RESULT_CONFIG[log.send_result] || RESULT_CONFIG.opened
              const modeCfg   = MODE_CONFIG[log.send_mode]    || MODE_CONFIG.manual
              const ResultIcon = resultCfg.icon
              const ModeIcon   = modeCfg.icon

              return (
                <div key={log.id || i} style={{
                  padding: '0.875rem 1rem',
                  backgroundColor: 'rgba(15,23,42,0.6)',
                  borderRadius: '0.625rem',
                  border: '1px solid rgba(51,65,85,0.25)',
                }}>
                  {/* Fila superior: estado + modo + hora */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    {/* Result badge */}
                    <span style={{
                      display: 'flex', alignItems: 'center', gap: '0.3rem',
                      fontSize: '0.75rem', fontWeight: 600,
                      color: resultCfg.color,
                      backgroundColor: `${resultCfg.color}18`,
                      padding: '0.2rem 0.5rem', borderRadius: '999px'
                    }}>
                      <ResultIcon size={11} />
                      {resultCfg.label}
                    </span>

                    {/* Mode badge */}
                    <span style={{
                      display: 'flex', alignItems: 'center', gap: '0.3rem',
                      fontSize: '0.75rem', fontWeight: 500,
                      color: modeCfg.color,
                      backgroundColor: `${modeCfg.color}15`,
                      padding: '0.2rem 0.5rem', borderRadius: '999px'
                    }}>
                      <ModeIcon size={11} />
                      {modeCfg.label}
                    </span>

                    {log.status_key && (
                      <span style={{
                        fontSize: '0.72rem', color: '#475569',
                        backgroundColor: 'rgba(71,85,105,0.15)',
                        padding: '0.15rem 0.45rem', borderRadius: '999px'
                      }}>
                        {log.status_key.replace('_', ' ')}
                      </span>
                    )}

                    {/* Hora */}
                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.3rem', color: '#475569', fontSize: '0.72rem' }}>
                      <Clock size={11} />
                      {log.created_at
                        ? new Date(log.created_at).toLocaleString('es-AR', {
                            day: '2-digit', month: '2-digit', year: '2-digit',
                            hour: '2-digit', minute: '2-digit'
                          })
                        : '—'
                      }
                    </div>
                  </div>

                  {/* Número */}
                  {log.phone && (
                    <p style={{ color: '#94a3b8', fontSize: '0.8rem', margin: '0 0 0.4rem 0' }}>
                      📱 {log.phone}
                    </p>
                  )}

                  {/* Mensaje preview */}
                  <div style={{
                    backgroundColor: 'rgba(37,211,102,0.05)',
                    border: '1px solid rgba(37,211,102,0.1)',
                    borderRadius: '0.5rem',
                    padding: '0.625rem 0.75rem',
                    fontSize: '0.8rem', color: '#94a3b8',
                    lineHeight: 1.5, whiteSpace: 'pre-wrap',
                    maxHeight: '80px', overflow: 'hidden',
                    position: 'relative'
                  }}>
                    {log.message}
                    <div style={{
                      position: 'absolute', bottom: 0, left: 0, right: 0,
                      height: '2rem',
                      background: 'linear-gradient(transparent, rgba(15,23,42,0.9))'
                    }} />
                  </div>

                  {/* Error message */}
                  {log.error_message && (
                    <p style={{ color: '#dc2626', fontSize: '0.75rem', margin: '0.35rem 0 0 0' }}>
                      ⚠ {log.error_message}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
