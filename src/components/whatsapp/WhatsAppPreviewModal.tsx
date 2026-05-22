/**
 * WhatsAppPreviewModal — modal genérico de preview y envío de WhatsApp.
 *
 * Funciona para cualquier contexto: orden, cliente, comprobante, garantía.
 * Carga templates del negocio, permite seleccionar plantilla y editar el
 * mensaje antes de enviarlo por API o abrir wa.me como fallback.
 */
import { useState, useEffect, useCallback } from 'react'
import { MessageCircle, Copy, ExternalLink, Check, AlertTriangle, X, RefreshCw, ChevronDown } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import {
  whatsappService,
  interpolateTemplate,
  generateWhatsAppLink,
  normalizeWhatsAppPhone,
  WhatsAppVars,
  WhatsAppTemplate,
  WhatsAppSettings,
  DEFAULT_TEMPLATES,
} from '../../services/whatsappService'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WhatsAppPreviewModalProps {
  isOpen: boolean
  onClose: () => void
  /** Display name for the recipient (for UI only) */
  recipientName: string
  /** Phone number (raw, will be normalized) */
  phone: string | null | undefined
  /** Pre-select this template key on open */
  defaultTemplateKey?: string
  /** Variables to interpolate in the message */
  vars?: WhatsAppVars
  /** Context IDs for logging */
  context?: {
    orderId?: string
    customerId?: string
    comprobantId?: string
    warrantyId?: string
  }
}

// ─── Status chip ──────────────────────────────────────────────────────────────

type SendStatus = 'idle' | 'sending' | 'sent_api' | 'fallback_opened' | 'copied' | 'error'

const STATUS_UI: Record<SendStatus, { label: string; color: string } | null> = {
  idle:             null,
  sending:          { label: 'Enviando…', color: '#818cf8' },
  sent_api:         { label: '✓ Enviado por API', color: '#22c55e' },
  fallback_opened:  { label: '↗ WhatsApp abierto', color: '#22c55e' },
  copied:           { label: '✓ Mensaje copiado', color: '#60a5fa' },
  error:            { label: 'Error al enviar', color: '#f87171' },
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WhatsAppPreviewModal({
  isOpen, onClose,
  recipientName, phone,
  defaultTemplateKey = 'free_message',
  vars = {},
  context = {},
}: WhatsAppPreviewModalProps) {
  const { businessId } = useAuth()

  const [settings,   setSettings]   = useState<WhatsAppSettings | null>(null)
  const [templates,  setTemplates]  = useState<WhatsAppTemplate[]>([])
  const [loading,    setLoading]    = useState(true)
  const [selectedKey,setSelectedKey]= useState(defaultTemplateKey)
  const [message,    setMessage]    = useState('')
  const [status,     setStatus]     = useState<SendStatus>('idle')
  const [errorMsg,   setErrorMsg]   = useState('')

  const phoneResult = phone ? normalizeWhatsAppPhone(phone) : { normalized: '', valid: false, error: 'Sin teléfono' }
  const waLink = phoneResult.valid ? generateWhatsAppLink(phone!, message) : ''

  // ── Load settings + templates ──────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!businessId || !isOpen) return
    setLoading(true)
    try {
      const [cfg, tpls] = await Promise.all([
        whatsappService.getSettings(businessId),
        whatsappService.getTemplates(businessId),
      ])
      setSettings(cfg)
      setTemplates(tpls.length ? tpls : DEFAULT_TEMPLATES.map(t => ({ ...t })))
    } catch { /* silencioso */ }
    finally { setLoading(false) }
  }, [businessId, isOpen])

  useEffect(() => { void loadData() }, [loadData])

  // ── Rebuild message when template or vars change ───────────────────────────
  useEffect(() => {
    if (!settings) return
    const tpl = templates.find(t => t.status_key === selectedKey)
      ?? templates.find(t => t.status_key === 'free_message')
    if (!tpl) return

    const mergedVars: WhatsAppVars = {
      negocio:  settings.business_name    || '',
      local:    settings.business_name    || '',
      direccion:settings.business_address || '',
      whatsapp: settings.business_whatsapp   || '',
      instagram:settings.business_instagram  || '',
      horario:  settings.business_hours      || '',
      nombre:   recipientName.split(' ')[0] || recipientName,
      cliente:  recipientName,
      ...vars,
    }
    let msg = interpolateTemplate(tpl.message_template, mergedVars)
    if (settings.closing_message?.trim()) {
      msg = `${msg}\n\n${interpolateTemplate(settings.closing_message, mergedVars)}`
    }
    setMessage(msg)
    setStatus('idle')
    setErrorMsg('')
  }, [selectedKey, templates, settings, vars, recipientName])

  // ── Reset on close ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) { setStatus('idle'); setErrorMsg(''); setSelectedKey(defaultTemplateKey) }
  }, [isOpen, defaultTemplateKey])

  // ── Actions ───────────────────────────────────────────────────────────────
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message)
      setStatus('copied')
      if (businessId) {
        void whatsappService.logCopy(businessId, phone || '', message, {
          order_id:    context.orderId,
          customer_id: context.customerId,
          status_key:  selectedKey,
        })
      }
    } catch { setStatus('error'); setErrorMsg('No se pudo copiar') }
  }

  const handleOpenWaMe = async () => {
    if (!waLink) return
    window.open(waLink, '_blank', 'noopener,noreferrer')
    setStatus('fallback_opened')
    if (businessId) {
      void whatsappService.sendManual(businessId, phone || '', message, {
        order_id:    context.orderId,
        customer_id: context.customerId,
        status_key:  selectedKey,
      })
    }
  }

  const handleSendApi = async () => {
    if (!settings?.api_mode || !settings.phone_number_id || !settings.access_token || !businessId) {
      // Fallback to wa.me
      await handleOpenWaMe()
      return
    }
    setStatus('sending')
    const result = await whatsappService.sendViaAPI(
      businessId, phone || '', message,
      { order_id: context.orderId, customer_id: context.customerId, status_key: selectedKey },
      { phone_number_id: settings.phone_number_id, access_token: settings.access_token }
    )
    if (result.success) {
      setStatus('sent_api')
    } else {
      setStatus('error')
      setErrorMsg(result.error || 'Error al enviar por API')
    }
  }

  if (!isOpen) return null

  const statusUi = STATUS_UI[status]
  const apiEnabled = !!(settings?.api_mode && settings.phone_number_id && settings.access_token)
  const canSend = phoneResult.valid && message.trim().length > 0

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      data-testid="whatsapp-preview-modal"
    >
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: '1rem', width: '100%', maxWidth: 580, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* ── Header ── */}
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <div style={{ width: 34, height: 34, borderRadius: '0.5rem', background: 'rgba(37,211,102,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <MessageCircle size={16} style={{ color: '#25d366' }} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>Enviar por WhatsApp</h3>
              <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                {recipientName} · {phoneResult.valid ? `+${phoneResult.normalized}` : <span style={{ color: '#f87171' }}>{phoneResult.error}</span>}
              </p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0.25rem', display: 'flex' }}>
            <X size={15} />
          </button>
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>

          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
              <RefreshCw size={20} className="animate-spin" style={{ color: '#818cf8' }} />
            </div>
          ) : (
            <>
              {/* Phone warning */}
              {!phoneResult.valid && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.625rem 0.875rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 'var(--radius-sm)' }}>
                  <AlertTriangle size={14} style={{ color: '#f87171', flexShrink: 0 }} />
                  <span style={{ fontSize: '0.8rem', color: '#fca5a5' }}>
                    {phone ? `Número inválido: ${phone}` : 'Este contacto no tiene teléfono registrado.'}
                  </span>
                </div>
              )}

              {/* Template selector */}
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>
                  Plantilla
                </label>
                <div style={{ position: 'relative' }}>
                  <select
                    data-testid="whatsapp-template-select"
                    value={selectedKey}
                    onChange={e => setSelectedKey(e.target.value)}
                    className="form-control"
                    style={{ paddingRight: '2rem' }}
                  >
                    {templates.map(t => (
                      <option key={t.status_key} value={t.status_key}>{t.status_label}</option>
                    ))}
                  </select>
                  <ChevronDown size={13} style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
                </div>
              </div>

              {/* Message preview / editor */}
              <div>
                <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>
                  Mensaje (editable)
                </label>
                <textarea
                  data-testid="whatsapp-preview-textarea"
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  className="form-control"
                  style={{ minHeight: 160, resize: 'vertical', fontSize: '0.85rem', lineHeight: 1.6 }}
                />
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.68rem', color: 'var(--text-subtle)' }}>
                  {message.length} caracteres
                </p>
              </div>

              {/* Status */}
              {statusUi && (
                <div data-testid="whatsapp-send-status" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.82rem', color: statusUi.color, fontWeight: 600 }}>
                  {status === 'sending'
                    ? <RefreshCw size={13} className="animate-spin" />
                    : status === 'error'
                    ? <AlertTriangle size={13} />
                    : <Check size={13} />}
                  {statusUi.label}
                  {status === 'error' && errorMsg && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> — {errorMsg}</span>}
                </div>
              )}

              {/* Fallback notice when API failed */}
              {status === 'error' && (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                  No se pudo enviar por API. Podés abrir WhatsApp manualmente usando el botón de fallback.
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Footer actions ── */}
        <div style={{ padding: '0.875rem 1.25rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>

          {/* Copy */}
          <button
            data-testid="whatsapp-copy-button"
            onClick={handleCopy}
            disabled={!message.trim()}
            className="btn btn-ghost btn-sm"
            title="Copiar mensaje al portapapeles"
          >
            {status === 'copied' ? <Check size={13} /> : <Copy size={13} />}
            {status === 'copied' ? 'Copiado' : 'Copiar'}
          </button>

          {/* Fallback wa.me */}
          <button
            data-testid="whatsapp-fallback-button"
            onClick={handleOpenWaMe}
            disabled={!canSend}
            className="btn btn-ghost btn-sm"
            style={{ color: '#25d366', borderColor: canSend ? 'rgba(37,211,102,0.3)' : undefined }}
            title={canSend ? 'Abrir WhatsApp en el navegador' : phoneResult.error}
          >
            <ExternalLink size={13} />
            Abrir WhatsApp
          </button>

          {/* Send via API */}
          {apiEnabled ? (
            <button
              data-testid="whatsapp-send-api-button"
              onClick={handleSendApi}
              disabled={!canSend || status === 'sending'}
              className="btn btn-sm"
              style={{ background: '#25d366', border: 'none', color: '#fff' }}
            >
              {status === 'sending'
                ? <><RefreshCw size={13} className="animate-spin" /> Enviando…</>
                : <><MessageCircle size={13} /> Enviar por API</>}
            </button>
          ) : (
            <button
              data-testid="whatsapp-send-api-button"
              onClick={handleOpenWaMe}
              disabled={!canSend}
              className="btn btn-sm"
              style={{ background: canSend ? '#25d366' : undefined, border: 'none', color: canSend ? '#fff' : undefined }}
            >
              <MessageCircle size={13} />
              Enviar WhatsApp
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
