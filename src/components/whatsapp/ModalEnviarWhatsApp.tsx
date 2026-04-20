import { useState, useEffect } from 'react'
import {
  MessageCircle, Copy, ExternalLink, Phone, CheckCircle,
  AlertTriangle, Send, Edit3
} from 'lucide-react'
import { CloseButton } from '../ui/CloseButton'
import { useAuth } from '../../contexts/AuthContext'
import {
  whatsappService,
  interpolateTemplate,
  buildOrderVars,
  generateWhatsAppLink,
  STATUS_TO_TEMPLATE_KEY,
  WhatsAppSettings,
  WhatsAppTemplate,
} from '../../services/whatsappService'
import { OrderStatus } from '../../types/orderStatus'

interface ModalEnviarWhatsAppProps {
  isOpen: boolean
  onClose: () => void
  order: any // Orden completa con customer, device, etc.
}

export function ModalEnviarWhatsApp({ isOpen, onClose, order }: ModalEnviarWhatsAppProps) {
  const { businessId } = useAuth()

  const [settings, setSettings] = useState<WhatsAppSettings | null>(null)
  const [template, setTemplate] = useState<WhatsAppTemplate | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const phone = order?.customer?.phone || ''
  const statusKey = order?.status ? STATUS_TO_TEMPLATE_KEY[order.status as OrderStatus] : ''

  useEffect(() => {
    if (!isOpen || !businessId) return
    loadData()
  }, [isOpen, businessId, order?.status])

  const loadData = async () => {
    if (!businessId) return
    setLoading(true)
    setError('')
    setSent(false)
    setCopied(false)
    try {
      const [cfg, templates] = await Promise.all([
        whatsappService.getSettings(businessId),
        whatsappService.getTemplates(businessId),
      ])
      setSettings(cfg)

      const tpl = templates.find(t => t.status_key === statusKey) || null
      setTemplate(tpl)

      if (tpl && cfg) {
        const vars = buildOrderVars(order, cfg)
        let msg = interpolateTemplate(tpl.message_template, vars)
        if (cfg.closing_message) {
          const closing = interpolateTemplate(cfg.closing_message, vars)
          msg = `${msg}\n\n${closing}`
        }
        setMessage(msg)
      } else if (cfg) {
        // No hay plantilla, generar mensaje genérico
        const vars = buildOrderVars(order, cfg)
        setMessage(
          `Hola ${vars.nombre || 'cliente'},\nTe contactamos desde ${vars.local || 'nuestro taller'} sobre tu orden #${vars.numero_orden}.`
        )
      }
    } catch (err: any) {
      setError('No se pudo cargar la configuración de WhatsApp.')
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
      setTimeout(() => setCopied(false), 3000)
      if (businessId && phone) {
        await whatsappService.logCopy(businessId, phone, message, {
          order_id:    order?.id,
          customer_id: order?.customer_id || order?.customer?.id,
          status_key:  statusKey,
        })
      }
    } catch {
      setError('No se pudo copiar al portapapeles.')
    }
  }

  const handleOpenWhatsApp = async () => {
    if (!businessId) return
    if (!phone) {
      setError('El cliente no tiene número de teléfono cargado.')
      return
    }
    const result = await whatsappService.sendManual(businessId, phone, message, {
      order_id:    order?.id,
      customer_id: order?.customer_id || order?.customer?.id,
      status_key:  statusKey,
    })
    if (result.success) {
      setSent(true)
      setTimeout(() => setSent(false), 4000)
    } else {
      setError('No se pudo abrir WhatsApp. Intentá copiar el mensaje manualmente.')
    }
  }

  if (!isOpen) return null

  return (
    <div style={{
      position: 'fixed', inset: 0,
      backgroundColor: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: '1rem'
    }}>
      <div style={{
        backgroundColor: '#0f0f14',
        borderRadius: '1rem',
        border: '1px solid rgba(51,65,85,0.5)',
        width: '100%', maxWidth: '560px',
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.6)'
      }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid rgba(51,65,85,0.4)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{
              width: '2.5rem', height: '2.5rem', borderRadius: '0.75rem',
              backgroundColor: 'rgba(37,211,102,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <MessageCircle size={20} color="#25d366" />
            </div>
            <div>
              <h2 style={{ color: '#fff', fontWeight: 700, fontSize: '1.125rem', margin: 0 }}>
                Enviar por WhatsApp
              </h2>
              <p style={{ color: '#64748b', fontSize: '0.8rem', margin: 0, marginTop: '0.1rem' }}>
                Orden #{(order?.id || '').slice(0, 8).toUpperCase()}
              </p>
            </div>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
              Cargando plantilla...
            </div>
          ) : (
            <>
              {/* Destinatario */}
              <div style={{
                padding: '0.875rem 1rem',
                backgroundColor: 'rgba(15,23,42,0.6)',
                borderRadius: '0.75rem',
                border: '1px solid rgba(51,65,85,0.3)',
                display: 'flex', alignItems: 'center', gap: '0.75rem'
              }}>
                <Phone size={16} color="#25d366" />
                <div>
                  <p style={{ color: '#94a3b8', fontSize: '0.75rem', margin: 0 }}>Destinatario</p>
                  <p style={{ color: '#fff', fontWeight: 600, margin: 0, marginTop: '0.1rem' }}>
                    {order?.customer?.name || 'Sin nombre'}
                  </p>
                </div>
                <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  {phone ? (
                    <span style={{
                      fontSize: '0.875rem', color: '#25d366', fontWeight: 500,
                      backgroundColor: 'rgba(37,211,102,0.1)',
                      padding: '0.25rem 0.625rem', borderRadius: '999px'
                    }}>
                      {phone}
                    </span>
                  ) : (
                    <span style={{
                      fontSize: '0.8rem', color: '#f59e0b',
                      backgroundColor: 'rgba(245,158,11,0.1)',
                      padding: '0.25rem 0.625rem', borderRadius: '999px'
                    }}>
                      Sin teléfono
                    </span>
                  )}
                </div>
              </div>

              {/* Sin teléfono */}
              {!phone && (
                <div style={{
                  padding: '0.875rem 1rem', borderRadius: '0.75rem',
                  backgroundColor: 'rgba(245,158,11,0.08)',
                  border: '1px solid rgba(245,158,11,0.3)',
                  display: 'flex', gap: '0.75rem', alignItems: 'flex-start'
                }}>
                  <AlertTriangle size={16} color="#f59e0b" style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                  <p style={{ color: '#f59e0b', fontSize: '0.875rem', margin: 0 }}>
                    Este cliente no tiene número de teléfono cargado. Podés editarlo desde la ficha del cliente antes de enviar.
                  </p>
                </div>
              )}

              {/* Editor de mensaje */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <Edit3 size={14} color="#94a3b8" />
                  <label style={{ color: '#94a3b8', fontSize: '0.8rem', fontWeight: 500 }}>
                    Mensaje — podés editarlo antes de enviar
                  </label>
                </div>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  rows={9}
                  style={{
                    width: '100%', padding: '0.875rem',
                    backgroundColor: 'rgba(15,23,42,0.5)',
                    border: '1px solid rgba(51,65,85,0.5)',
                    borderRadius: '0.75rem',
                    color: '#e2e8f0', fontSize: '0.875rem',
                    lineHeight: 1.6, resize: 'vertical',
                    outline: 'none', fontFamily: 'inherit',
                    boxSizing: 'border-box'
                  }}
                />
                <p style={{ color: '#475569', fontSize: '0.75rem', marginTop: '0.375rem' }}>
                  {message.length} caracteres
                </p>
              </div>

              {/* Preview del link */}
              {phone && (
                <div style={{
                  padding: '0.625rem 0.875rem', borderRadius: '0.5rem',
                  backgroundColor: 'rgba(37,211,102,0.05)',
                  border: '1px solid rgba(37,211,102,0.15)',
                  fontSize: '0.75rem', color: '#475569',
                  wordBreak: 'break-all'
                }}>
                  <span style={{ color: '#25d366' }}>wa.me →</span>{' '}
                  {generateWhatsAppLink(phone, message).slice(0, 60)}...
                </div>
              )}

              {/* Error */}
              {error && (
                <div style={{
                  padding: '0.75rem 1rem', borderRadius: '0.75rem',
                  backgroundColor: 'rgba(220,38,38,0.08)',
                  border: '1px solid rgba(220,38,38,0.3)',
                  color: '#dc2626', fontSize: '0.875rem'
                }}>
                  {error}
                </div>
              )}

              {/* Éxito */}
              {sent && (
                <div style={{
                  padding: '0.75rem 1rem', borderRadius: '0.75rem',
                  backgroundColor: 'rgba(16,185,129,0.08)',
                  border: '1px solid rgba(16,185,129,0.3)',
                  display: 'flex', gap: '0.5rem', alignItems: 'center',
                  color: '#10b981', fontSize: '0.875rem'
                }}>
                  <CheckCircle size={16} />
                  WhatsApp abierto correctamente. El mensaje fue registrado.
                </div>
              )}

              {copied && (
                <div style={{
                  padding: '0.75rem 1rem', borderRadius: '0.75rem',
                  backgroundColor: 'rgba(99,102,241,0.08)',
                  border: '1px solid rgba(99,102,241,0.3)',
                  display: 'flex', gap: '0.5rem', alignItems: 'center',
                  color: '#818cf8', fontSize: '0.875rem'
                }}>
                  <CheckCircle size={16} />
                  Mensaje copiado al portapapeles.
                </div>
              )}

              {/* Botones de acción */}
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button
                  onClick={handleCopy}
                  style={{
                    flex: 1, padding: '0.75rem',
                    backgroundColor: 'rgba(99,102,241,0.1)',
                    border: '1px solid rgba(99,102,241,0.3)',
                    borderRadius: '0.75rem', color: '#818cf8',
                    fontSize: '0.875rem', fontWeight: 600,
                    cursor: 'pointer', display: 'flex',
                    alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.2)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.1)')}
                >
                  <Copy size={16} />
                  Copiar
                </button>

                <button
                  onClick={handleOpenWhatsApp}
                  disabled={!phone}
                  style={{
                    flex: 2, padding: '0.75rem',
                    backgroundColor: phone ? '#25d366' : 'rgba(51,65,85,0.3)',
                    border: 'none', borderRadius: '0.75rem',
                    color: phone ? '#fff' : '#475569',
                    fontSize: '0.875rem', fontWeight: 700,
                    cursor: phone ? 'pointer' : 'not-allowed',
                    display: 'flex', alignItems: 'center',
                    justifyContent: 'center', gap: '0.5rem',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={e => { if (phone) e.currentTarget.style.backgroundColor = '#1da851' }}
                  onMouseLeave={e => { if (phone) e.currentTarget.style.backgroundColor = '#25d366' }}
                >
                  <ExternalLink size={16} />
                  Abrir WhatsApp
                </button>
              </div>

              <p style={{ color: '#475569', fontSize: '0.75rem', textAlign: 'center', margin: 0 }}>
                Se abrirá WhatsApp en una nueva pestaña con el mensaje precargado.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
