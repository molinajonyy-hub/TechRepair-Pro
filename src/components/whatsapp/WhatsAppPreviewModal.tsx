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
 * DESKTOP — UNA acción cuando se puede, varias cuando hay que elegir:
 * WhatsApp Web manda `Cross-Origin-Opener-Policy: same-origin`, así que una
 * pestaña suya NO se puede reutilizar desde una página normal (medido: el
 * `WindowProxy` queda severed y `closed` pasa a `true` con la pestaña abierta).
 * Quien SÍ puede es el TechRepair WhatsApp Companion, porque la navegación la
 * ejecuta Chrome vía Tabs API. Entonces:
 *  · con Companion → UN botón, "Abrir WhatsApp". TechRepair se queda abierto y
 *                    WhatsApp Web usa siempre la misma pestaña;
 *  · sin Companion → instalarlo, o app de escritorio (`whatsapp://`, no abre
 *                    pestaña), o WhatsApp Web en una pestaña NUEVA, avisada.
 * En móvil no cambia nada: `wa.me` y el sistema abre la app. El Companion no se
 * consulta ni se ofrece en móvil.
 *
 * Estados honestos: iniciar el handoff NO confirma envío. Sólo el envío por
 * Cloud API confirmado server-side muestra "Enviado por API"; ese camino es
 * preexistente y ajeno a W1 — sólo aparece si el negocio ya tiene conexión.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { MessageCircle, Copy, ExternalLink, Check, AlertTriangle, X, RefreshCw, ChevronDown, Pencil, Monitor, Puzzle } from 'lucide-react'
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
  abrirWhatsAppWebEnNuevaPestana,
  EVENTO_APERTURA,
} from '../../services/whatsappHandoff'
import {
  consultarCompanion,
  abrirEnCompanion,
  companionInstallUrl,
} from '../../services/whatsappCompanion'

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
 * Descubrimiento del Companion. Cuatro estados, no dos:
 *
 *  · `buscando`      — dura lo que tarda Chrome en contestar. Medido: 1-2 ms con
 *                      el worker caliente, 78 ms recién arrancado, y ~1 ms para
 *                      concluir una ausencia (llega por `lastError`, no por
 *                      timeout). En la práctica no es un estado visible.
 *  · `disponible`    — está y puede trabajar.
 *  · `sin_acceso`    — ESTÁ INSTALADA pero Chrome le retiró el acceso a
 *                      WhatsApp Web («Al hacer clic»). Se arregla en dos clics;
 *                      confundirlo con «no instalada» mandaría a la persona a
 *                      instalar algo que ya tiene.
 *  · `ausente`       — no está, o no se puede saber. Se ofrecen los fallbacks.
 *
 * El caso «no contestó a tiempo» se trata como `disponible` a propósito: el
 * clic en el botón es la autoridad final, y si la apertura falla el estado se
 * corrige solo. Al revés —dar por ausente algo que tardó— la persona ve los
 * fallbacks teniendo la extensión, y no tiene forma de descubrir el error.
 */
type EstadoCompanion = 'buscando' | 'disponible' | 'sin_acceso' | 'ausente'

/**
 * El único mensaje del flujo que pide una acción concreta en otra pantalla.
 * Dice DÓNDE, porque «revisá los permisos» no le sirve a nadie.
 */
const COPY_SIN_ACCESO =
  'TechRepair Companion está instalado, pero Chrome no le permite acceder a WhatsApp Web. ' +
  'En chrome://extensions → TechRepair Companion → Detalles → Acceso al sitio, elegí ' +
  '“En web.whatsapp.com”.'

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
  // Vale para el Companion y para el móvil: en los dos casos se abrió WhatsApp
  // con el mensaje preparado, y en ninguno se puede afirmar que se haya enviado.
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
  /** ¿Está el Companion? Sólo se consulta en desktop, y sólo sin Cloud API. */
  const [companion, setCompanion] = useState<EstadoCompanion>('buscando')
  /**
   * Una apertura falló y no se sabe por qué.
   *
   * No alcanza con mostrar el error: si el Companion sigue figurando como
   * disponible, la única acción en pantalla es la que acaba de fallar y la
   * persona queda sin salida. Esto destraba las alternativas sin afirmar que la
   * extensión no está — que es lo que no se sabe.
   */
  const [aperturaFallo, setAperturaFallo] = useState(false)

  const dialogRef       = useRef<HTMLDivElement>(null)
  const textareaRef     = useRef<HTMLTextAreaElement>(null)
  const previousFocus   = useRef<HTMLElement | null>(null)

  const isMobile    = isMobileDevice()
  const phoneResult = normalizeWhatsAppPhone(phoneInput)
  /** Sólo se ofrece instalar si hay una URL configurada. No se inventa una. */
  const urlInstalacion = companionInstallUrl()

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

  // ── ¿Está el Companion? ────────────────────────────────────────────────────
  //
  // En MÓVIL no se consulta ni se ofrece: ahí `wa.me` entrega el mensaje a la
  // app nativa, que es mejor que cualquier cosa que pueda hacer una extensión.
  // Con Cloud API tampoco, porque ese camino tiene prioridad y no toca pestañas.
  useEffect(() => {
    if (!isOpen || isMobile || cloudConnected) { setCompanion('ausente'); return }
    let vigente = true
    setCompanion('buscando')
    void consultarCompanion().then(r => {
      if (!vigente) return
      // `indeterminado` (no contestó a tiempo) se toma como disponible: el clic
      // decide. Ver el comentario de EstadoCompanion.
      if (r.estado === 'ausente') setCompanion('ausente')
      else if (r.estado === 'sin_acceso') setCompanion('sin_acceso')
      else setCompanion('disponible')
    })
    return () => { vigente = false }
  }, [isOpen, isMobile, cloudConnected])

  // ── Sync editable phone + reset transient state when (re)opened ─────────────
  useEffect(() => {
    if (isOpen) {
      setPhoneInput(phone ?? '')
      setEditingPhone(false)
      setStatus('idle')
      setErrorMsg('')
      setAperturaFallo(false)
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
   * DESKTOP · primario CUANDO EL COMPANION ESTÁ. Una sola acción.
   *
   * La extensión encuentra o crea UNA pestaña de WhatsApp Web y la navega al
   * chat. TechRepair no se mueve. Se le manda `{ type, phone, text }` y nada
   * más: la URL la arma la extensión.
   *
   * `tabs.update` recrea el documento de WhatsApp Web, así que hay un par de
   * segundos de carga del otro lado. Eso NO es un error y no se rotula como
   * tal; tampoco se hace polling para "confirmar" que el chat cargó.
   */
  const handleAbrirConCompanion = async () => {
    if (bloqueo) { setStatus('error'); setErrorMsg(bloqueo); return }
    if (!phoneResult.valid) { setStatus('error'); setErrorMsg(phoneResult.error ?? 'Teléfono inválido'); return }

    setStatus('sending')
    const r = await abrirEnCompanion(phoneInput, message)

    if (!r.ok) {
      // El OPEN es la autoridad: su veredicto corrige lo que haya concluido el
      // descubrimiento, en vez de dejar la UI pegada a una conclusión vieja.
      if (r.estado === 'sin_acceso') {
        setCompanion('sin_acceso')
        setStatus('error')
        setErrorMsg(COPY_SIN_ACCESO)
        return
      }
      if (r.estado === 'ausente') setCompanion('ausente')
      // Cualquier otro fallo: no se sabe qué pasó, pero la persona necesita
      // poder mandar el mensaje igual.
      setAperturaFallo(true)
      setStatus('error')
      setErrorMsg('No se pudo abrir WhatsApp. Probá con la aplicación de escritorio o copiá el mensaje.')
      return
    }

    // Si el descubrimiento había dudado, el éxito lo zanja.
    setCompanion('disponible')
    setAperturaFallo(false)
    setStatus('fallback_opened')
    // `opened` se registra SÓLO acá: después de un OPEN que respondió ok. Antes
    // de eso no hubo handoff, y registrarlo diría algo que no pasó.
    void logOpen()
  }

  /**
   * DESKTOP · fallback SIN Companion. WhatsApp Web en una pestaña NUEVA.
   *
   * Se avisa que abre una pestaña, y no se promete que se reutilice: contra
   * WhatsApp Web eso es imposible sin la extensión (COOP same-origin, medido).
   * TechRepair NO se navega: sacar al usuario de su trabajo era peor.
   */
  const handleAbrirWebEnNuevaPestana = () => {
    if (bloqueo) { setStatus('error'); setErrorMsg(bloqueo); return }
    if (!handoff.ok) { setStatus('error'); setErrorMsg(handoff.error); return }

    const apertura = abrirWhatsAppWebEnNuevaPestana(handoff.url)
    if (!apertura.abierto) { setStatus('error'); setErrorMsg(apertura.error); return }
    setStatus('fallback_opened')
    void logOpen()
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
  /**
   * Hay que ofrecer alternativas. Cubre los dos casos en que el Companion no
   * puede resolverlo solo: cuando no está, y cuando está pero Chrome le retiró
   * el acceso al sitio.
   */
  const sinCompanionOperativo =
    companion === 'ausente' || companion === 'sin_acceso' || aperturaFallo
  // Fail-closed: sin teléfono resoluble, sin mensaje, o con una variable sin
  // resolver, no se abre nada. `bloqueo` ya explica cuál falta.
  const canSend = phoneResult.valid && message.trim().length > 0 && !bloqueo

  /**
   * PORTAL a `document.body`. Mismo patrón que `AllocationModal` y los modales
   * de `personal/`; no es una preferencia de estilo, arregla un bug medido.
   *
   * Las páginas se envuelven en `.animate-fade-in`, y esa clase anima
   * `transform: translateY(8px) → translateY(0)` con `forwards`: la matriz
   * identidad queda aplicada para siempre. Un `transform` —aunque sea la
   * identidad— crea un CONTEXTO DE APILAMIENTO, y eso rompía dos cosas a la vez:
   *
   *   · `z-index: 9999` sólo competía DENTRO de ese contexto. Hacia afuera el
   *     contenedor vale `auto`, así que `.top-header` (z-index 30) pintaba por
   *     encima de todo el subárbol y tapaba el encabezado del modal. Medido a
   *     1280×800 mientras se preparaba la captura del Chrome Web Store.
   *   · un ancestro transformado además pasa a ser el bloque contenedor de
   *     `position: fixed`, así que `inset: 0` cubría ese contenedor y no el
   *     viewport, y el modal quedaba descentrado.
   *
   * Subirle el z-index no habría servido: el problema es el contexto, no el
   * número. Sacándolo del subárbol, el overlay vuelve a medirse contra el
   * viewport y a competir en el contexto raíz.
   */
  return createPortal(
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

              {/* Desktop: qué va a pasar. Sin prometer nada que no se pueda cumplir. */}
              {!isMobile && !loading && !apiEnabled && (companion === 'disponible' || companion === 'buscando') && (
                <p data-testid="whatsapp-ayuda-desktop" style={{ margin: 0, fontSize: '0.68rem', color: 'var(--text-subtle)', lineHeight: 1.5 }}>
                  WhatsApp Web conectado con TechRepair.
                </p>
              )}

              {/*
                Instalada pero sin acceso al sitio. Es un estado propio porque
                la salida es distinta: no hay que instalar nada, hay que
                habilitar un permiso. Se dice dónde.
              */}
              {!isMobile && !loading && !apiEnabled && companion === 'sin_acceso' && (
                <div
                  data-testid="whatsapp-sin-acceso"
                  style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', padding: '0.625rem 0.875rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.28)', borderRadius: 'var(--radius-sm)' }}
                >
                  <AlertTriangle size={14} style={{ color: '#fbbf24', flexShrink: 0, marginTop: 2 }} />
                  <span style={{ fontSize: '0.78rem', color: '#fcd34d', lineHeight: 1.55 }}>
                    {COPY_SIN_ACCESO}
                  </span>
                </div>
              )}

              {!isMobile && !loading && !apiEnabled && companion === 'ausente' && (
                <p data-testid="whatsapp-ayuda-desktop" style={{ margin: 0, fontSize: '0.68rem', color: 'var(--text-subtle)', lineHeight: 1.5 }}>
                  Recomendado: <strong>WhatsApp Desktop</strong> mantiene TechRepair abierto y no abre pestañas.
                  Si no tenés la aplicación, <strong>WhatsApp Web abrirá una nueva pestaña</strong>.
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

          {/* DESKTOP · sin Companion — instalarlo. Sólo si hay URL configurada. */}
          {!apiEnabled && !isMobile && companion === 'ausente' && urlInstalacion && (
            <a
              data-testid="whatsapp-install-companion"
              href={urlInstalacion}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-sm"
              title="Con el complemento instalado, WhatsApp Web usa una sola pestaña."
            >
              <Puzzle size={13} />
              Instalar complemento
            </a>
          )}

          {/*
            Alternativas. Se muestran sin Companion y TAMBIÉN cuando está pero
            Chrome le retiró el acceso: en ese estado el mensaje explica cómo
            habilitarlo, pero nadie tiene por qué pelearse con los permisos de
            Chrome para poder mandar un mensaje ahora.
          */}
          {!apiEnabled && !isMobile && sinCompanionOperativo && (
            <button
              data-testid="whatsapp-fallback-button"
              onClick={handleAbrirWebEnNuevaPestana}
              disabled={!canSend}
              className="btn btn-ghost btn-sm"
              style={{ color: '#25d366', borderColor: canSend ? 'rgba(37,211,102,0.3)' : undefined }}
              title={canSend
                ? 'WhatsApp Web abrirá una nueva pestaña.'
                : (bloqueo ?? phoneResult.error)}
            >
              <ExternalLink size={13} />
              Usar WhatsApp Web
            </button>
          )}

          {/* La app instalada: es el único camino que no toca ninguna pestaña. */}
          {!apiEnabled && !isMobile && sinCompanionOperativo && (
            <button
              data-testid="whatsapp-desktop-app-button"
              onClick={handleAbrirApp}
              disabled={!canSend}
              className={companion === 'ausente' ? 'btn btn-sm' : 'btn btn-ghost btn-sm'}
              style={companion === 'ausente'
                ? { background: canSend ? '#25d366' : undefined, border: 'none', color: canSend ? '#fff' : undefined }
                : { color: '#25d366', borderColor: canSend ? 'rgba(37,211,102,0.3)' : undefined }}
              title={canSend
                ? 'Abre la app de WhatsApp instalada. TechRepair se queda abierto.'
                : (bloqueo ?? (handoffApp.ok ? undefined : handoffApp.error))}
            >
              <Monitor size={13} />
              Abrir en WhatsApp Desktop
            </button>
          )}

          {/*
            EL primario. Con el Companion operativo es la única acción (§18).
            En `sin_acceso` se conserva a propósito: si la persona acaba de
            habilitar el permiso, un clic alcanza — sin cerrar y reabrir el
            modal — porque el OPEN es la autoridad final y corrige el estado.
          */}
          {!apiEnabled && !isMobile && companion !== 'ausente' && (
            <button
              data-testid="whatsapp-companion-button"
              onClick={handleAbrirConCompanion}
              disabled={!canSend || companion === 'buscando' || status === 'sending'}
              className="btn btn-sm"
              style={{ background: canSend ? '#25d366' : undefined, border: 'none', color: canSend ? '#fff' : undefined }}
              title={canSend
                ? 'Abre el chat en WhatsApp Web. TechRepair se queda abierto.'
                : (bloqueo ?? phoneResult.error)}
            >
              {status === 'sending'
                ? <><RefreshCw size={13} className="animate-spin" /> Abriendo…</>
                : <><MessageCircle size={13} /> Abrir WhatsApp</>}
            </button>
          )}

          {/* MÓVIL · acción única — wa.me y el sistema abre la app */}
          {!apiEnabled && isMobile && (
            <button
              data-testid="whatsapp-mobile-button"
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
    </div>,
    document.body,
  )
}
