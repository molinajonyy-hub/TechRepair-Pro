/**
 * WhatsAppPreviewModal — modal genérico de preview y envío de WhatsApp.
 *
 * Funciona para cualquier contexto: orden, cliente, comprobante, garantía.
 * Carga templates del negocio, permite elegir plantilla, EDITAR el teléfono y
 * el mensaje, y enviar por Cloud API (si hay conexión activa) o abrir
 * WhatsApp (Desktop / Web / wa.me) como fallback.
 *
 * Estados honestos: "abrir WhatsApp" NO confirma envío — sólo el envío por API
 * confirmado muestra "Enviado por API".
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { MessageCircle, Copy, ExternalLink, Check, AlertTriangle, X, RefreshCw, ChevronDown, Pencil } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { getConnection } from '../../services/whatsappCloudService'
import {
  whatsappService,
  interpolateTemplate,
  buildWhatsAppDesktopUrl,
  buildWhatsAppWebUrl,
  buildWhatsAppUniversalUrl,
  openWhatsAppDesktop,
  isMobileDevice,
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
  /** Phone number (raw, will be normalized; editable in the modal) */
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

type SendStatus = 'idle' | 'sending' | 'sent_api' | 'fallback_opened' | 'desktop_opened' | 'web_opened' | 'copied' | 'error'

const STATUS_UI: Record<SendStatus, { label: string; color: string } | null> = {
  idle:             null,
  sending:          { label: 'Enviando…', color: '#818cf8' },
  sent_api:         { label: 'Enviado por API', color: '#22c55e' },
  fallback_opened:  { label: 'WhatsApp abierto', color: '#22c55e' },
  desktop_opened:   { label: 'WhatsApp Desktop abierto', color: '#22c55e' },
  web_opened:       { label: 'WhatsApp Web abierto', color: '#22c55e' },
  copied:           { label: 'Mensaje copiado', color: '#60a5fa' },
  error:            { label: 'No se pudo enviar', color: '#f87171' },
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
  const [cloudConnected, setCloudConnected] = useState(false)
  const [phoneInput, setPhoneInput] = useState(phone ?? '')
  const [editingPhone, setEditingPhone] = useState(false)

  const dialogRef       = useRef<HTMLDivElement>(null)
  const textareaRef     = useRef<HTMLTextAreaElement>(null)
  const previousFocus   = useRef<HTMLElement | null>(null)

  const isMobile    = isMobileDevice()
  const phoneResult = normalizeWhatsAppPhone(phoneInput)
  const desktopUrl  = phoneResult.valid ? buildWhatsAppDesktopUrl(phoneInput, message) : ''
  const webUrl      = phoneResult.valid ? buildWhatsAppWebUrl(phoneInput, message) : ''
  const mobileUrl   = phoneResult.valid ? buildWhatsAppUniversalUrl(phoneInput, message) : ''

  // ── Load settings + templates + cloud connection ───────────────────────────
  const loadData = useCallback(async () => {
    if (!businessId || !isOpen) return
    setLoading(true)
    try {
      const [cfg, tpls, conn] = await Promise.all([
        whatsappService.getSettings(businessId),
        whatsappService.getTemplates(businessId),
        getConnection(businessId),
      ])
      setSettings(cfg)
      setTemplates(tpls.length ? tpls : DEFAULT_TEMPLATES.map(t => ({ ...t })))
      setCloudConnected(!!conn?.phone_number_id)
    } catch { /* silencioso */ }
    finally { setLoading(false) }
  }, [businessId, isOpen])

  useEffect(() => { void loadData() }, [loadData])

  // ── Sync editable phone + reset transient state when (re)opened ─────────────
  useEffect(() => {
    if (isOpen) {
      setPhoneInput(phone ?? '')
      setEditingPhone(false)
      setStatus('idle')
      setErrorMsg('')
      setSelectedKey(defaultTemplateKey)
    }
  }, [isOpen, phone, defaultTemplateKey])

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

  // ── Accessibility: Escape to close, focus trap-lite, focus restore ──────────
  useEffect(() => {
    if (!isOpen) return
    previousFocus.current = document.activeElement as HTMLElement | null
    // Foco inicial al cuerpo del diálogo
    const focusTimer = setTimeout(() => {
      textareaRef.current?.focus()
    }, 0)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown, true)
      previousFocus.current?.focus?.()
    }
  }, [isOpen, onClose])

  // ── Actions ───────────────────────────────────────────────────────────────
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message)
      setStatus('copied')
      if (businessId) {
        void whatsappService.logCopy(businessId, phoneInput || '', message, {
          order_id:    context.orderId,
          customer_id: context.customerId,
          status_key:  selectedKey,
        })
      }
    } catch { setStatus('error'); setErrorMsg('No se pudo copiar') }
  }

  const logOpen = (result: 'opened') => {
    if (!businessId) return
    void whatsappService.logMessage(businessId, {
      order_id:    context.orderId,
      customer_id: context.customerId,
      phone:       phoneInput || '',
      status_key:  selectedKey,
      message,
      send_mode:   'manual',
      send_result: result,
    })
  }

  // whatsapp:// — abre WhatsApp Desktop sin pestaña nueva; silencioso si no instalado
  const handleOpenDesktop = () => {
    if (!desktopUrl) return
    openWhatsAppDesktop(desktopUrl)
    setStatus('desktop_opened')
    logOpen('opened')
  }

  // web.whatsapp.com — detecta bloqueo de popup
  const handleOpenWeb = () => {
    if (!webUrl) return
    const win = window.open(webUrl, '_blank', 'noopener,noreferrer')
    if (!win) {
      setStatus('error')
      setErrorMsg('El navegador bloqueó la ventana. Copiá el mensaje o permití pop-ups para este sitio.')
      return
    }
    setStatus('web_opened')
    logOpen('opened')
  }

  // wa.me — mobile: abre la app nativa; detecta bloqueo de popup
  const handleOpenMobile = () => {
    if (!mobileUrl) return
    const win = window.open(mobileUrl, '_blank', 'noopener,noreferrer')
    if (!win) {
      setStatus('error')
      setErrorMsg('No se pudo abrir WhatsApp. Copiá el mensaje e intentá manualmente.')
      return
    }
    setStatus('fallback_opened')
    logOpen('opened')
  }

  const handleSendApi = async () => {
    if (!cloudConnected || !businessId) {
      isMobile ? handleOpenMobile() : handleOpenDesktop()
      return
    }
    setStatus('sending')
    const result = await whatsappService.sendViaAPI(
      businessId, phoneInput || '', message,
      { order_id: context.orderId, customer_id: context.customerId, status_key: selectedKey }
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
  const apiEnabled = cloudConnected
  const canSend = phoneResult.valid && message.trim().length > 0

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      data-testid="whatsapp-preview-modal"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Enviar WhatsApp a ${recipientName}`}
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: '1rem', width: '100%', maxWidth: 580, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >

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
          <button onClick={onClose} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0.25rem', display: 'flex' }}>
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
              {/* Phone editor / warning */}
              <div>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>
                  <span>Teléfono</span>
                  {!editingPhone && (
                    <button
                      data-testid="whatsapp-edit-phone"
                      onClick={() => setEditingPhone(true)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#818cf8', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.72rem', fontWeight: 700, textTransform: 'none' }}
                    >
                      <Pencil size={11} /> Editar
                    </button>
                  )}
                </label>
                {editingPhone ? (
                  <input
                    data-testid="whatsapp-phone-input"
                    value={phoneInput}
                    onChange={e => setPhoneInput(e.target.value)}
                    placeholder="Ej: 351 15 1234567"
                    className="form-control"
                    inputMode="tel"
                    autoFocus
                  />
                ) : (
                  <div
                    style={{ fontSize: '0.85rem', color: phoneResult.valid ? 'var(--text-primary)' : '#f87171', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                  >
                    {phoneResult.valid
                      ? <>+{phoneResult.normalized} <span style={{ color: 'var(--text-subtle)', fontSize: '0.72rem' }}>({phoneInput})</span></>
                      : (phoneInput ? `Número inválido: ${phoneInput}` : 'Sin teléfono registrado')}
                  </div>
                )}
              </div>

              {!phoneResult.valid && !editingPhone && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.625rem 0.875rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 'var(--radius-sm)' }}>
                  <AlertTriangle size={14} style={{ color: '#f87171', flexShrink: 0 }} />
                  <span style={{ fontSize: '0.8rem', color: '#fca5a5' }}>
                    {phoneInput ? 'El número no es válido. Tocá “Editar” para corregirlo.' : 'Este contacto no tiene teléfono. Podés ingresarlo con “Editar” o copiar el mensaje.'}
                  </span>
                </div>
              )}

              {/* Template selector */}
              <div>
                <label htmlFor="wa-template-select" style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>
                  Plantilla
                </label>
                <div style={{ position: 'relative' }}>
                  <select
                    id="wa-template-select"
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
                <label htmlFor="wa-message" style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>
                  Mensaje (editable)
                </label>
                <textarea
                  id="wa-message"
                  ref={textareaRef}
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
                    : status === 'sent_api'
                    ? <Check size={13} />
                    : <ExternalLink size={13} />}
                  {statusUi.label}
                  {status === 'error' && errorMsg && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> — {errorMsg}</span>}
                </div>
              )}

              {/* Honest reminder: opening WhatsApp ≠ message sent */}
              {(status === 'fallback_opened' || status === 'desktop_opened' || status === 'web_opened') && (
                <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-subtle)', lineHeight: 1.5 }}>
                  Se abrió WhatsApp con el mensaje preparado. Recordá que abrir WhatsApp no confirma que el mensaje haya sido enviado.
                </p>
              )}

              {/* Fallback notice when API failed */}
              {status === 'error' && (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                  Usá los botones de abajo para enviar manualmente o copiar el mensaje.
                </div>
              )}

              {/* Desktop hint */}
              {!isMobile && !loading && (
                <p style={{ margin: 0, fontSize: '0.68rem', color: 'var(--text-subtle)', lineHeight: 1.5 }}>
                  Para evitar pestañas nuevas, usá <strong>WhatsApp Desktop</strong>. WhatsApp Web puede abrir una pestaña nueva según el navegador.
                </p>
              )}
            </>
          )}
        </div>

        {/* ── Footer actions ── */}
        <div style={{ padding: '0.875rem 1.25rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>

          {/* Copy — siempre disponible */}
          <button
            data-testid="whatsapp-copy-button"
            onClick={handleCopy}
            disabled={!message.trim()}
            className="btn btn-ghost btn-sm"
            title="Copiar mensaje al portapapeles"
          >
            {status === 'copied' ? <Check size={13} /> : <Copy size={13} />}
            {status === 'copied' ? 'Copiado' : 'Copiar mensaje'}
          </button>

          {/* API — cuando hay conexión Cloud API activa, toma prioridad */}
          {apiEnabled && (
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
          )}

          {/* Mobile: un solo botón wa.me */}
          {!apiEnabled && isMobile && (
            <button
              data-testid="whatsapp-send-api-button"
              onClick={handleOpenMobile}
              disabled={!canSend}
              className="btn btn-sm"
              style={{ background: canSend ? '#25d366' : undefined, border: 'none', color: canSend ? '#fff' : undefined }}
              title={canSend ? 'Abrir WhatsApp en tu dispositivo' : phoneResult.error}
            >
              <MessageCircle size={13} />
              Abrir en WhatsApp
            </button>
          )}

          {/* Desktop: botón secundario WhatsApp Web */}
          {!apiEnabled && !isMobile && (
            <button
              data-testid="whatsapp-fallback-button"
              onClick={handleOpenWeb}
              disabled={!canSend}
              className="btn btn-ghost btn-sm"
              style={{ color: '#25d366', borderColor: canSend ? 'rgba(37,211,102,0.3)' : undefined }}
              title={canSend ? 'Abrir WhatsApp Web en el navegador (puede abrir pestaña nueva)' : phoneResult.error}
            >
              <ExternalLink size={13} />
              WhatsApp Web
            </button>
          )}

          {/* Desktop: botón principal WhatsApp Desktop (protocolo whatsapp://) */}
          {!apiEnabled && !isMobile && (
            <button
              data-testid="whatsapp-send-api-button"
              onClick={handleOpenDesktop}
              disabled={!canSend}
              className="btn btn-sm"
              style={{ background: canSend ? '#25d366' : undefined, border: 'none', color: canSend ? '#fff' : undefined }}
              title={canSend ? 'Abre WhatsApp Desktop si está instalado (sin pestaña nueva)' : phoneResult.error}
            >
              <MessageCircle size={13} />
              WhatsApp Desktop
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
