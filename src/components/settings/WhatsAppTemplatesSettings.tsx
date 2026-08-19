/**
 * WhatsAppTemplatesSettings — editor de plantillas de WhatsApp por negocio (W1).
 *
 * Reemplaza al huérfano `WhatsAppSettings.tsx`, que nunca estuvo montado y
 * además incluía una sección de Cloud API que ya vive en `/whatsapp`. Este
 * componente es deliberadamente chico y NO conoce el transporte oficial:
 * edita texto de plantillas y los datos del negocio que esas plantillas usan.
 *
 * RBAC: la edición exige `can('settings_sensitive')` — la misma clave canónica
 * que describe "cambiar datos del negocio e integraciones". Fail-closed: sin
 * ese permiso la pantalla se ve, pero en modo lectura.
 *
 * MULTITENANT: todo va contra `businessId` del AuthContext y la RLS de
 * `whatsapp_templates` / `whatsapp_settings` acota por negocio server-side.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  MessageCircle, Save, RefreshCw, Eye, EyeOff, Check,
  AlertTriangle, ChevronDown, ChevronRight, Lock,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { usePermissions } from '../../hooks/usePermissions'
import {
  whatsappService,
  WhatsAppTemplate,
  WhatsAppSettings as WSettings,
  DEFAULT_TEMPLATES,
  DEFAULT_SETTINGS,
} from '../../services/whatsappService'
import {
  WHATSAPP_VARIABLES,
  renderTemplate,
  resolveWhatsAppValues,
} from '../../services/whatsappTemplate'

/** Valores de muestra para la vista previa. Salen de la propia allowlist. */
const VALORES_EJEMPLO: Record<string, string> = Object.fromEntries(
  WHATSAPP_VARIABLES.map(v => [v.key, v.ejemplo]),
)

const CAMPOS_NEGOCIO: { key: keyof WSettings; label: string; placeholder: string }[] = [
  { key: 'business_name',      label: 'Nombre del negocio', placeholder: 'TechRepair Centro' },
  { key: 'business_address',   label: 'Dirección',          placeholder: 'San Martín 123' },
  { key: 'business_whatsapp',  label: 'WhatsApp',           placeholder: '351 7654321' },
  { key: 'business_instagram', label: 'Instagram',          placeholder: '@techrepair' },
  { key: 'business_hours',     label: 'Horario',            placeholder: 'Lun a Vie 9 a 18' },
]

export function WhatsAppTemplatesSettings() {
  const { businessId } = useAuth()
  const { can } = usePermissions()
  const puedeEditar = can('settings_sensitive')

  const [settings, setSettings]   = useState<WSettings>({ ...DEFAULT_SETTINGS })
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([])
  const [abierta, setAbierta]     = useState<string | null>(null)
  const [verPreview, setVerPreview] = useState(true)
  const [cargando, setCargando]   = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado]   = useState(false)
  const [error, setError]         = useState('')

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const cargar = useCallback(async () => {
    if (!businessId) return
    setCargando(true)
    try {
      const [cfg, tpls] = await Promise.all([
        whatsappService.getSettings(businessId),
        whatsappService.getTemplates(businessId),
      ])
      setSettings(cfg)
      setTemplates(tpls.length ? tpls : DEFAULT_TEMPLATES.map(t => ({ ...t })))
    } catch {
      setError('No pudimos cargar las plantillas. Reintentá en unos segundos.')
    } finally {
      setCargando(false)
    }
  }, [businessId])

  useEffect(() => { void cargar() }, [cargar])

  const actualizarPlantilla = (statusKey: string, texto: string) => {
    setTemplates(prev => prev.map(t =>
      t.status_key === statusKey ? { ...t, message_template: texto } : t,
    ))
    setGuardado(false)
  }

  const guardar = async () => {
    // Fail-closed: aunque la UI ya esté deshabilitada, no se emite la escritura.
    if (!businessId || !puedeEditar) return
    setGuardando(true); setError(''); setGuardado(false)
    try {
      await whatsappService.saveSettings(businessId, {
        enabled:            settings.enabled,
        auto_send_enabled:  settings.auto_send_enabled,
        business_name:      settings.business_name,
        business_address:   settings.business_address,
        business_whatsapp:  settings.business_whatsapp,
        business_instagram: settings.business_instagram,
        business_hours:     settings.business_hours,
        closing_message:    settings.closing_message,
      })
      await whatsappService.saveAllTemplates(businessId, templates)
      setGuardado(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron guardar los cambios.')
    } finally {
      setGuardando(false)
    }
  }

  /** Inserta `{clave}` en la posición del cursor de la plantilla abierta. */
  const insertarVariable = (clave: string) => {
    const el = textareaRef.current
    if (!el || !abierta || !puedeEditar) return
    const token = `{${clave}}`
    const inicio = el.selectionStart ?? el.value.length
    const fin    = el.selectionEnd   ?? el.value.length
    const texto  = el.value.slice(0, inicio) + token + el.value.slice(fin)
    actualizarPlantilla(abierta, texto)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(inicio + token.length, inicio + token.length)
    })
  }

  if (cargando) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3rem' }}>
        <RefreshCw size={20} className="animate-spin" style={{ color: '#818cf8' }} />
      </div>
    )
  }

  const valoresEjemplo = resolveWhatsAppValues(VALORES_EJEMPLO)

  return (
    <div data-testid="whatsapp-templates-settings" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

      {/* Encabezado + estado de permiso */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.35rem' }}>
          <MessageCircle size={17} style={{ color: '#25d366' }} />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            Plantillas de WhatsApp
          </h3>
        </div>
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>
          El texto que TechRepair prepara antes de abrir WhatsApp. Vos revisás y enviás desde WhatsApp:
          el sistema nunca envía por su cuenta.
        </p>
      </div>

      {!puedeEditar && (
        <div
          data-testid="whatsapp-templates-readonly"
          style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.625rem 0.875rem', background: 'rgba(148,163,184,0.10)', border: '1px solid rgba(148,163,184,0.25)', borderRadius: 'var(--radius-sm)' }}
        >
          <Lock size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Solo lectura. Para editar las plantillas necesitás permiso de configuración avanzada.
          </span>
        </div>
      )}

      {/* Datos del negocio que alimentan las variables de perfil */}
      <div>
        <span style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
          Datos que usan las plantillas
        </span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '0.625rem' }}>
          {CAMPOS_NEGOCIO.map(campo => (
            <label key={String(campo.key)} style={{ display: 'block' }}>
              <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                {campo.label}
              </span>
              <input
                data-testid={`whatsapp-settings-${String(campo.key)}`}
                className="form-control"
                value={(settings[campo.key] as string) ?? ''}
                placeholder={campo.placeholder}
                disabled={!puedeEditar}
                onChange={e => { setSettings(s => ({ ...s, [campo.key]: e.target.value })); setGuardado(false) }}
              />
            </label>
          ))}
        </div>
      </div>

      {/* Variables disponibles — la allowlist, no una lista paralela */}
      <div>
        <span style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
          Variables disponibles
        </span>
        <div data-testid="whatsapp-variables-disponibles" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
          {WHATSAPP_VARIABLES.map(v => (
            <button
              key={v.key}
              type="button"
              onClick={() => insertarVariable(v.key)}
              disabled={!puedeEditar || !abierta}
              title={abierta ? `${v.label} — insertar en la plantilla abierta` : `${v.label} — abrí una plantilla para insertarla`}
              style={{
                fontSize: '0.7rem', fontFamily: 'monospace', padding: '0.2rem 0.5rem',
                borderRadius: '999px', background: 'rgba(99,102,241,0.08)',
                border: '1px solid rgba(99,102,241,0.22)', color: 'var(--text-secondary)',
                cursor: puedeEditar && abierta ? 'pointer' : 'default',
                opacity: puedeEditar && abierta ? 1 : 0.55,
              }}
            >
              {`{${v.key}}`}
            </button>
          ))}
        </div>
        <p style={{ margin: '0.4rem 0 0', fontSize: '0.68rem', color: 'var(--text-subtle)', lineHeight: 1.5 }}>
          Cualquier otra <code>{'{palabra}'}</code> no se reemplaza y bloquea el envío hasta que la corrijas.
        </p>
      </div>

      {/* Lista de plantillas */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {templates.map(t => {
          const expandida = abierta === t.status_key
          const resultado = renderTemplate(t.message_template, valoresEjemplo)
          const tieneProblema = resultado.desconocidas.length > 0

          return (
            <div
              key={t.status_key}
              data-testid={`whatsapp-template-${t.status_key}`}
              style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--bg-card)' }}
            >
              <button
                type="button"
                onClick={() => setAbierta(expandida ? null : t.status_key)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', padding: '0.75rem 0.875rem', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
              >
                {expandida ? <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
                  {t.status_label}
                </span>
                {tieneProblema && <AlertTriangle size={13} style={{ color: '#fbbf24' }} />}
              </button>

              {expandida && (
                <div style={{ padding: '0 0.875rem 0.875rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                  <textarea
                    ref={textareaRef}
                    data-testid="whatsapp-template-editor"
                    className="form-control"
                    value={t.message_template}
                    disabled={!puedeEditar}
                    rows={6}
                    onChange={e => actualizarPlantilla(t.status_key, e.target.value)}
                    style={{ resize: 'vertical', fontSize: '0.82rem', lineHeight: 1.6 }}
                  />

                  {tieneProblema && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', fontSize: '0.75rem', color: '#fcd34d' }}>
                      <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>
                        Variables que no existen: {resultado.desconocidas.map(k => `{${k}}`).join(', ')}.
                        Se van a ver tal cual y no se va a poder abrir WhatsApp.
                      </span>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => setVerPreview(v => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'none', border: 'none', color: '#818cf8', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }}
                  >
                    {verPreview ? <EyeOff size={13} /> : <Eye size={13} />}
                    {verPreview ? 'Ocultar' : 'Ver'} vista previa
                  </button>

                  {verPreview && (
                    <div
                      data-testid="whatsapp-template-preview"
                      style={{ padding: '0.75rem 0.875rem', background: 'rgba(37,211,102,0.05)', border: '1px solid rgba(37,211,102,0.14)', borderRadius: 'var(--radius-sm)' }}
                    >
                      <span style={{ display: 'block', fontSize: '0.68rem', fontWeight: 700, color: '#25d366', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>
                        Vista previa con datos de ejemplo
                      </span>
                      <p style={{ margin: 0, fontSize: '0.82rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
                        {resultado.text}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: '#f87171' }}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <button
          data-testid="whatsapp-templates-save"
          onClick={guardar}
          disabled={!puedeEditar || guardando}
          className="btn btn-sm"
          style={{ background: puedeEditar ? '#25d366' : undefined, border: 'none', color: puedeEditar ? '#fff' : undefined }}
          title={puedeEditar ? undefined : 'Necesitás permiso de configuración avanzada'}
        >
          {guardando ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
          {guardando ? 'Guardando…' : 'Guardar plantillas'}
        </button>
        {guardado && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', color: '#22c55e', fontWeight: 600 }}>
            <Check size={13} /> Guardado
          </span>
        )}
      </div>
    </div>
  )
}
