/**
 * WhatsAppPreviewModal — modal genérico de preview y apertura de WhatsApp.
 *
 * Funciona para cualquier contexto: orden, cliente, comprobante, garantía.
 * Carga templates del negocio, permite elegir plantilla, EDITAR el teléfono y
 * el mensaje, y abrir WhatsApp por handoff estándar wa.me.
 *
 * W1 — el mensaje lo arma `renderTemplate` (allowlist explícita) y, si queda
 * una variable sin resolver, se dice CUÁL y no se abre WhatsApp.
 *
 * DOS CAMINOS EN DESKTOP, Y POR QUÉ:
 * WhatsApp Web manda `Cross-Origin-Opener-Policy: same-origin`, así que una
 * pestaña suya NO se puede reutilizar desde acá (medido: el `WindowProxy` queda
 * severed y `closed` pasa a `true` con la pestaña abierta). Abrir una pestaña
 * por mensaje acumulaba pestañas sin remedio. Entonces:
 *  · primario   → app de escritorio por `whatsapp://`: no abre NINGUNA pestaña
 *                 y TechRepair se queda donde está;
 *  · secundario → WhatsApp Web navegando la MISMA pestaña. Back vuelve.
 * En móvil no cambia nada: `wa.me` y el sistema abre la app.
 *
 * Estados honestos: iniciar el handoff NO confirma envío. Sólo el envío por
 * Cloud API confirmado server-side muestra "Enviado por API"; ese camino es
 * preexistente y ajeno a W1 — sólo aparece si el negocio ya tiene conexión.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { MessageCircle, Copy, ExternalLink, Check, AlertTriangle, X, RefreshCw, ChevronDown, Pencil, Monitor } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { getConnection } from '../../services/whatsappCloudService'
import {
  whatsappService,
  isMobileDevice,
  normalizeWhatsAppPhone,
  WhatsAppVars,
  WhatsAppTemplate,
  WhatsAppSettings,
  DEFAULT_TEMPLATES,
} from '../../services/whatsappService'
import {
  renderTemplate,
  resolveWhatsAppValues,
  motivoDeBloqueo,
  getWhatsAppVariableSpec,
} from '../../services/whatsappTemplate'
import {
  buildHandoffUrl,
  buildAppUrl,
  abrirWhatsAppMovil,
  abrirAppDeEscritorio,
  irAWhatsAppWeb,
  EVENTO_APERTURA,
} from '../../services/whatsappHandoff'

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

type SendStatus = 'idle' | 'sending' | 'sent_api' | 'fallback_opened' | 'desktop_opened' | 'copied' | 'error'

/**
 * Ningún estado de este mapa dice "Enviado" salvo `sent_api`, que sólo se
 * alcanza con una confirmación real de la Cloud API.
 *
 * `desktop_opened` NO afirma que la app se haya abierto: no hay forma de
 * saberlo sin una heurística de foco/timeout que daría falsos negativos. Se
 * rotula como lo que efectivamente pasó — se le pasó el mensaje al sistema.
 */
const STATUS_UI: Record<SendStatus, { label: string; color: string } | null> = {
  idle:             null,
  sending:          { label: 'Enviando…', color: '#818cf8' },
  sent_api:         { label: 'Enviado por API', color: '#22c55e' },
  fallback_opened:  { label: 'WhatsApp abierto', color: '#22c55e' },
  desktop_opened:   { label: 'Abriendo WhatsApp Desktop…', color: '#22c55e' },
  copied:           { label: 'Mensaje copiado', color: '#60a5fa' },
  error:            { label: 'No se pudo abrir', color: '#f87171' },
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
  /** Claves de la allowlist que la plantilla activa resolvió con datos reales. */
  const [varsUsadas, setVarsUsadas] = useState<{ key: string; valor: string }[]>([])
  /** Variables de PERFIL del negocio sin cargar: degradan el mensaje, no lo bloquean. */
  const [perfilIncompleto, setPerfilIncompleto] = useState<string[]>([])

  const dialogRef       = useRef<HTMLDivElement>(null)
  const textareaRef     = useRef<HTMLTextAreaElement>(null)
  const previousFocus   = useRef<HTMLElement | null>(null)

  const isMobile    = isMobileDevice()
  const phoneResult = normalizeWhatsAppPhone(phoneInput)

  /**
   * Camino por defecto de la plataforma: en desktop `web.whatsapp.com/send`
   * (nunca la intermedia de api.whatsapp.com), en móvil `wa.me`.
   *
   * Ambos se recalculan sobre el mensaje FINAL — el que el usuario ve en el
   * textarea — así que la vista previa y lo que recibe WhatsApp son el mismo
   * string, por los dos caminos.
   */
  const handoff = useMemo(
    () => buildHandoffUrl(phoneInput, message, isMobile),
    [phoneInput, message, isMobile],
  )
  /** App de escritorio (`whatsapp://`). Mismo mensaje, otra vía de entrega. */
  const handoffApp = useMemo(() => buildAppUrl(phoneInput, message), [phoneInput, message])
  /** Variables sin resolver en el mensaje final (incluye lo tipeado a mano). */
  const bloqueo = useMemo(() => motivoDeBloqueo(message), [message])

  /**
   * Huella por CONTENIDO de `vars`.
   *
   * Los llamadores pasan un objeto literal inline, así que su identidad cambia
   * en cada render del padre. Con `vars` en las dependencias, el efecto que
   * arma el mensaje se volvía a disparar por cualquier re-render y pisaba el
   * textarea. Eso importa más ahora: cuando falta una variable, editar el
   * mensaje a mano es justamente la vía para desbloquear la apertura, y esa
   * edición se perdía. Con la huella el efecto corre sólo si los datos
   * cambiaron de verdad.
   */
  const varsKey = JSON.stringify(vars)

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
      fecha:    new Date().toLocaleDateString('es-AR'),
      ...vars,
    }
    // `renderTemplate` es determinista y no conoce alias: la política de
    // fallback vive en `resolveWhatsAppValues`, testeable por separado.
    const valores = resolveWhatsAppValues(mergedVars as Record<string, string | null | undefined>)

    const cuerpo = renderTemplate(tpl.message_template, valores)
    let msg = cuerpo.text
    let usadas = cuerpo.resueltas
    let incompletas = cuerpo.incompletas
    if (settings.closing_message?.trim()) {
      const cierre = renderTemplate(settings.closing_message, valores)
      msg = `${msg}\n\n${cierre.text}`
      usadas = [...new Set([...usadas, ...cierre.resueltas])]
      incompletas = [...new Set([...incompletas, ...cierre.incompletas])]
    }

    setMessage(msg)
    setVarsUsadas(usadas.map(key => ({ key, valor: valores[key] ?? '' })))
    setPerfilIncompleto(incompletas)
    setStatus('idle')
    setErrorMsg('')
    // `varsKey` es la huella por contenido de `vars` — ver su definición arriba.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, templates, settings, varsKey, recipientName])

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

  /**
   * Registra que TechRepair INICIÓ el handoff con el mensaje preparado.
   * `opened` significa "handoff iniciado", no que el mensaje se haya abierto y
   * mucho menos enviado. NO se escribe `sent`/`delivered`/`read` jamás.
   *
   * Devuelve la promesa porque el camino de WhatsApp Web navega la pestaña
   * actual: si no se espera, el request se cancela al salir de la página.
   */
  const logOpen = (): Promise<void> => {
    if (!businessId) return Promise.resolve()
    return whatsappService.logMessage(businessId, {
      order_id:    context.orderId,
      customer_id: context.customerId,
      phone:       phoneInput || '',
      status_key:  selectedKey,
      message,
      send_mode:   'manual',
      send_result: EVENTO_APERTURA,
    })
  }

  /**
   * DESKTOP · primario. `whatsapp://` se lo lleva el sistema a la app: no abre
   * ninguna pestaña y TechRepair se queda donde está. No se detecta si la app
   * existe — si no pasa nada, la UI ya ofrece WhatsApp Web al lado.
   */
  const handleAbrirApp = () => {
    if (bloqueo) { setStatus('error'); setErrorMsg(bloqueo); return }
    if (!handoffApp.ok) { setStatus('error'); setErrorMsg(handoffApp.error); return }

    const apertura = abrirAppDeEscritorio(handoffApp.url)
    if (!apertura.abierto) { setStatus('error'); setErrorMsg(apertura.error); return }
    setStatus('desktop_opened')
    void logOpen()
  }

  /**
   * DESKTOP · secundario. WhatsApp Web en la MISMA pestaña.
   *
   * No se usa `window.open`: una pestaña de WhatsApp Web es imposible de
   * reutilizar después (COOP same-origin), así que abrir una por mensaje
   * acumulaba pestañas. Navegar la actual es la única forma determinista de no
   * acumular; el Back del navegador vuelve a TechRepair.
   *
   * El log se ESPERA antes de navegar: al salir de la página el request en
   * vuelo se cancela y el handoff quedaría sin registro.
   */
  const handleIrAWhatsAppWeb = async () => {
    if (bloqueo) { setStatus('error'); setErrorMsg(bloqueo); return }
    if (!handoff.ok) { setStatus('error'); setErrorMsg(handoff.error); return }

    try { await logOpen() } catch { /* el registro no puede bloquear el handoff */ }

    const apertura = irAWhatsAppWeb(handoff.url)
    if (!apertura.abierto) { setStatus('error'); setErrorMsg(apertura.error) }
  }

  /** MÓVIL · acción única. `wa.me` y el sistema abre la app nativa. */
  const handleAbrirEnMovil = () => {
    if (bloqueo) { setStatus('error'); setErrorMsg(bloqueo); return }
    if (!handoff.ok) { setStatus('error'); setErrorMsg(handoff.error); return }

    const apertura = abrirWhatsAppMovil(handoff.url)
    if (!apertura.abierto) { setStatus('error'); setErrorMsg(apertura.error); return }
    setStatus('fallback_opened')
    void logOpen()
  }

  const handleSendApi = async () => {
    if (!cloudConnected || !businessId) {
      // Sin Cloud API no debería llegarse acá (el botón no se renderiza), pero
      // si pasa, se cae al camino estándar de la plataforma.
      isMobile ? handleAbrirEnMovil() : handleAbrirApp()
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
  // Fail-closed: sin teléfono resoluble, sin mensaje, o con una variable sin
  // resolver, no se abre nada. `bloqueo` ya explica cuál falta.
  const canSend = phoneResult.valid && message.trim().length > 0 && !bloqueo

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

              {/* Variables utilizadas — qué datos reales entraron en el mensaje */}
              {varsUsadas.length > 0 && (
                <div data-testid="whatsapp-vars-usadas">
                  <span style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>
                    Variables utilizadas
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                    {varsUsadas.map(v => (
                      <span
                        key={v.key}
                        title={`{${v.key}} → ${v.valor}`}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.7rem', padding: '0.2rem 0.5rem', borderRadius: '999px', background: 'rgba(37,211,102,0.08)', border: '1px solid rgba(37,211,102,0.18)', color: 'var(--text-secondary)', maxWidth: '100%' }}
                      >
                        <span style={{ color: '#25d366', fontWeight: 700 }}>
                          {getWhatsAppVariableSpec(v.key)?.label ?? v.key}
                        </span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>{v.valor}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Perfil del negocio incompleto — degrada el mensaje, NO lo bloquea */}
              {!bloqueo && perfilIncompleto.length > 0 && (
                <p
                  data-testid="whatsapp-perfil-incompleto"
                  style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-subtle)', lineHeight: 1.5 }}
                >
                  El mensaje queda con huecos porque falta{' '}
                  {perfilIncompleto.map(k => getWhatsAppVariableSpec(k)?.label ?? k).join(', ').toLowerCase()}.
                  Podés completarlo en Configuración → WhatsApp, o editar el texto acá.
                </p>
              )}

              {/* Variable sin resolver — se nombra y se bloquea la apertura */}
              {bloqueo && (
                <div
                  data-testid="whatsapp-variables-faltantes"
                  style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', padding: '0.625rem 0.875rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.28)', borderRadius: 'var(--radius-sm)' }}
                >
                  <AlertTriangle size={14} style={{ color: '#fbbf24', flexShrink: 0, marginTop: 2 }} />
                  <span style={{ fontSize: '0.8rem', color: '#fcd34d', lineHeight: 1.5 }}>{bloqueo}</span>
                </div>
              )}

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
              {status === 'fallback_opened' && (
                <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-subtle)', lineHeight: 1.5 }}>
                  Se abrió WhatsApp con el mensaje preparado. Todavía tenés que tocar “Enviar” allá: TechRepair no puede confirmar que el mensaje haya llegado.
                </p>
              )}

              {/* App de escritorio: no se puede saber si existe, así que no se afirma. */}
              {status === 'desktop_opened' && (
                <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-subtle)', lineHeight: 1.5 }}>
                  Le pasamos el mensaje a WhatsApp Desktop. Si no se abrió nada, no tenés la aplicación instalada:
                  usá <strong>WhatsApp Web</strong>. Y recordá que TechRepair no puede confirmar que el mensaje haya llegado.
                </p>
              )}

              {/* Fallback notice when opening failed */}
              {status === 'error' && (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                  Podés copiar el mensaje y pegarlo en WhatsApp a mano.
                </div>
              )}

              {/* Desktop: cómo elegir. Sin prometer nada que no se pueda cumplir. */}
              {!isMobile && !loading && (
                <p data-testid="whatsapp-ayuda-desktop" style={{ margin: 0, fontSize: '0.68rem', color: 'var(--text-subtle)', lineHeight: 1.5 }}>
                  Recomendado: <strong>WhatsApp Desktop</strong> mantiene TechRepair abierto.
                  Si no tenés la aplicación instalada, usá <strong>WhatsApp Web</strong>, que se abre en esta misma pestaña
                  (con el botón Atrás volvés).
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

          {/* DESKTOP · secundario — WhatsApp Web en la MISMA pestaña */}
          {!apiEnabled && !isMobile && (
            <button
              data-testid="whatsapp-fallback-button"
              onClick={handleIrAWhatsAppWeb}
              disabled={!canSend}
              className="btn btn-ghost btn-sm"
              style={{ color: '#25d366', borderColor: canSend ? 'rgba(37,211,102,0.3)' : undefined }}
              title={canSend
                ? 'Abre WhatsApp Web en esta misma pestaña. Con el botón Atrás volvés a TechRepair.'
                : (bloqueo ?? phoneResult.error)}
            >
              <ExternalLink size={13} />
              Usar WhatsApp Web
            </button>
          )}

          {/* DESKTOP · primario — app instalada, sin pestañas de por medio */}
          {!apiEnabled && !isMobile && (
            <button
              data-testid="whatsapp-send-api-button"
              onClick={handleAbrirApp}
              disabled={!canSend}
              className="btn btn-sm"
              style={{ background: canSend ? '#25d366' : undefined, border: 'none', color: canSend ? '#fff' : undefined }}
              title={canSend
                ? 'Abre la app de WhatsApp instalada. TechRepair se queda abierto.'
                : (bloqueo ?? (handoffApp.ok ? undefined : handoffApp.error))}
            >
              <Monitor size={13} />
              Abrir en WhatsApp Desktop
            </button>
          )}

          {/* MÓVIL · acción única — wa.me y el sistema abre la app */}
          {!apiEnabled && isMobile && (
            <button
              data-testid="whatsapp-send-api-button"
              onClick={handleAbrirEnMovil}
              disabled={!canSend}
              className="btn btn-sm"
              style={{ background: canSend ? '#25d366' : undefined, border: 'none', color: canSend ? '#fff' : undefined }}
              title={canSend
                ? 'Abrir WhatsApp con el mensaje preparado'
                : (bloqueo ?? (handoff.ok ? undefined : handoff.error))}
            >
              <MessageCircle size={13} />
              Abrir WhatsApp
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
