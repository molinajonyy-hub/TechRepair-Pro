import { useState, useEffect } from 'react'
import {
  MessageCircle, Save, RefreshCw, ToggleLeft, ToggleRight,
  Eye, EyeOff, ChevronDown, ChevronUp, Zap, CheckCircle, AlertTriangle, RotateCcw,
  Key, ExternalLink
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import {
  whatsappService,
  WhatsAppSettings as WSettings,
  WhatsAppTemplate,
  DEFAULT_TEMPLATES,
  interpolateTemplate,
} from '../../services/whatsappService'

// ---- Variables disponibles para mostrar en la UI ----
const AVAILABLE_VARS = [
  '{nombre}', '{apellido}', '{cliente}', '{marca}', '{modelo}',
  '{equipo}', '{estado}', '{precio}', '{anticipo}', '{saldo}',
  '{numero_orden}', '{local}', '{direccion}', '{whatsapp}',
  '{instagram}', '{horario}', '{fecha}',
]

// ---- Datos de ejemplo para la vista previa ----
const PREVIEW_VARS = {
  nombre: 'Juan',
  apellido: 'García',
  cliente: 'Juan García',
  marca: 'Samsung',
  modelo: 'Galaxy S22',
  equipo: 'Celular',
  estado: 'Listo para retirar',
  precio: '$35.000',
  anticipo: '$10.000',
  saldo: '$25.000',
  numero_orden: 'ABC12345',
  local: 'TechRepair Pro',
  direccion: 'Av. Corrientes 1234, CABA',
  whatsapp: '+54 11 1234-5678',
  instagram: '@techrepair.pro',
  horario: 'Lun a Vie 9 a 18hs',
  fecha: new Date().toLocaleDateString('es-AR'),
}

// ---- Toggle switch ----
function ToggleSwitch({
  checked, onChange, label, description, color = '#25d366'
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  description?: string
  color?: string
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '1rem', padding: '0.875rem 1rem',
        backgroundColor: checked ? `${color}08` : 'rgba(15,23,42,0.4)',
        border: `1px solid ${checked ? `${color}25` : 'rgba(51,65,85,0.3)'}`,
        borderRadius: '0.75rem', cursor: 'pointer', transition: 'all 0.2s'
      }}
      onClick={() => onChange(!checked)}
    >
      <div>
        <p style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.9rem', margin: 0 }}>{label}</p>
        {description && (
          <p style={{ color: '#64748b', fontSize: '0.78rem', margin: '0.15rem 0 0 0' }}>{description}</p>
        )}
      </div>
      {checked
        ? <ToggleRight size={28} color={color} style={{ flexShrink: 0 }} />
        : <ToggleLeft  size={28} color="#475569" style={{ flexShrink: 0 }} />
      }
    </div>
  )
}

// ---- Card expandible por plantilla ----
function TemplateCard({
  template,
  settings,
  onChange,
}: {
  template: WhatsAppTemplate
  settings: WSettings
  onChange: (t: WhatsAppTemplate) => void
}) {
  const [open, setOpen] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  const previewMessage = interpolateTemplate(
    template.message_template,
    { ...PREVIEW_VARS, local: settings.business_name || PREVIEW_VARS.local }
  )

  return (
    <div style={{
      border: `1px solid ${template.is_active ? 'rgba(51,65,85,0.4)' : 'rgba(51,65,85,0.2)'}`,
      borderRadius: '0.75rem',
      backgroundColor: template.is_active ? 'rgba(15,23,42,0.5)' : 'rgba(15,23,42,0.2)',
      overflow: 'hidden',
      transition: 'all 0.2s'
    }}>
      {/* Header del card */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          padding: '0.875rem 1rem', cursor: 'pointer',
          userSelect: 'none'
        }}
        onClick={() => setOpen(v => !v)}
      >
        {/* Color indicator */}
        <div style={{
          width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
          backgroundColor: template.is_active ? '#25d366' : '#475569',
          boxShadow: template.is_active ? '0 0 6px #25d36660' : 'none'
        }} />

        <div style={{ flex: 1 }}>
          <p style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.875rem', margin: 0 }}>
            {template.status_label}
          </p>
          {!open && (
            <p style={{
              color: '#475569', fontSize: '0.75rem', margin: '0.1rem 0 0 0',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              maxWidth: '360px'
            }}>
              {template.message_template.split('\n')[0]}
            </p>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexShrink: 0 }}>
          {template.auto_send && (
            <span style={{
              display: 'flex', alignItems: 'center', gap: '0.25rem',
              fontSize: '0.7rem', fontWeight: 600, color: '#25d366',
              backgroundColor: 'rgba(37,211,102,0.12)',
              padding: '0.15rem 0.45rem', borderRadius: '999px'
            }}>
              <Zap size={10} /> Auto
            </span>
          )}
          <button
            onClick={e => { e.stopPropagation(); onChange({ ...template, is_active: !template.is_active }) }}
            style={{
              fontSize: '0.72rem', fontWeight: 600,
              color: template.is_active ? '#25d366' : '#64748b',
              backgroundColor: template.is_active ? 'rgba(37,211,102,0.1)' : 'rgba(100,116,139,0.1)',
              border: `1px solid ${template.is_active ? 'rgba(37,211,102,0.25)' : 'rgba(100,116,139,0.2)'}`,
              borderRadius: '999px', padding: '0.2rem 0.5rem', cursor: 'pointer'
            }}
          >
            {template.is_active ? 'Activo' : 'Inactivo'}
          </button>
          {open ? <ChevronUp size={16} color="#64748b" /> : <ChevronDown size={16} color="#64748b" />}
        </div>
      </div>

      {/* Cuerpo expandible */}
      {open && (
        <div style={{ padding: '0 1rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <div style={{ height: '1px', backgroundColor: 'rgba(51,65,85,0.3)' }} />

          {/* Toggle auto-envío */}
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              padding: '0.625rem 0.875rem',
              backgroundColor: template.auto_send ? 'rgba(37,211,102,0.06)' : 'rgba(15,23,42,0.4)',
              border: `1px solid ${template.auto_send ? 'rgba(37,211,102,0.2)' : 'rgba(51,65,85,0.3)'}`,
              borderRadius: '0.625rem', cursor: 'pointer'
            }}
            onClick={() => onChange({ ...template, auto_send: !template.auto_send })}
          >
            <Zap size={14} color={template.auto_send ? '#25d366' : '#475569'} />
            <div style={{ flex: 1 }}>
              <p style={{ color: '#e2e8f0', fontSize: '0.825rem', fontWeight: 600, margin: 0 }}>
                Envío automático
              </p>
              <p style={{ color: '#64748b', fontSize: '0.75rem', margin: 0 }}>
                Al cambiar la orden a este estado, se abre WhatsApp automáticamente
              </p>
            </div>
            {template.auto_send
              ? <ToggleRight size={22} color="#25d366" />
              : <ToggleLeft  size={22} color="#475569" />
            }
          </div>

          {/* Editor */}
          <div>
            <label style={{ color: '#94a3b8', fontSize: '0.78rem', fontWeight: 500, display: 'block', marginBottom: '0.4rem' }}>
              Mensaje
            </label>
            <textarea
              value={template.message_template}
              onChange={e => onChange({ ...template, message_template: e.target.value })}
              rows={6}
              style={{
                width: '100%', padding: '0.75rem',
                backgroundColor: 'rgba(11,18,32,0.8)',
                border: '1px solid rgba(51,65,85,0.5)',
                borderRadius: '0.625rem', color: '#e2e8f0',
                fontSize: '0.8rem', lineHeight: 1.65,
                resize: 'vertical', outline: 'none',
                fontFamily: 'inherit', boxSizing: 'border-box'
              }}
            />
          </div>

          {/* Vista previa */}
          <button
            onClick={() => setShowPreview(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              background: 'transparent', border: 'none',
              color: '#6366f1', fontSize: '0.8rem', cursor: 'pointer',
              padding: '0.25rem 0', fontWeight: 500
            }}
          >
            {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}
            {showPreview ? 'Ocultar' : 'Ver'} vista previa
          </button>

          {showPreview && (
            <div style={{
              padding: '0.875rem',
              backgroundColor: 'rgba(37,211,102,0.04)',
              border: '1px solid rgba(37,211,102,0.12)',
              borderRadius: '0.625rem'
            }}>
              <p style={{ color: '#25d366', fontSize: '0.72rem', fontWeight: 600, margin: '0 0 0.5rem 0', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Vista previa con datos de ejemplo
              </p>
              <p style={{
                color: '#e2e8f0', fontSize: '0.825rem', lineHeight: 1.6,
                whiteSpace: 'pre-wrap', margin: 0
              }}>
                {previewMessage}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================
// COMPONENTE PRINCIPAL
// ============================================

export function WhatsAppSettings() {
  const { businessId } = useAuth()

  const [settings, setSettings] = useState<WSettings>({
    enabled: false,
    auto_send_enabled: false,
    business_name: '',
    business_address: '',
    business_whatsapp: '',
    business_instagram: '',
    business_hours: '',
    closing_message: 'Saludos, {local}.\nWhatsApp: {whatsapp}\nInstagram: {instagram}',
  })

  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([...DEFAULT_TEMPLATES])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    if (businessId) load()
  }, [businessId])

  const load = async () => {
    if (!businessId) return
    setLoading(true)
    try {
      const [cfg, tpls] = await Promise.all([
        whatsappService.getSettings(businessId),
        whatsappService.getTemplates(businessId),
      ])
      setSettings(cfg)
      setTemplates(tpls)
    } catch {
      setError('Error al cargar la configuración de WhatsApp.')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!businessId) return
    setSaving(true)
    setError('')
    try {
      await whatsappService.saveSettings(businessId, settings)
      await whatsappService.saveAllTemplates(businessId, templates)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      setError(err?.message || 'Error al guardar la configuración.')
    } finally {
      setSaving(false)
    }
  }

  const handleResetTemplates = async () => {
    if (!businessId) return
    setSaving(true)
    try {
      await whatsappService.resetTemplates(businessId)
      const tpls = await whatsappService.getTemplates(businessId)
      setTemplates(tpls)
      setConfirmReset(false)
    } catch (err: any) {
      setError(err?.message || 'Error al restaurar plantillas.')
    } finally {
      setSaving(false)
    }
  }

  const updateTemplate = (updated: WhatsAppTemplate) => {
    setTemplates(prev => prev.map(t =>
      t.status_key === updated.status_key ? updated : t
    ))
  }

  const sectionStyle = {
    backgroundColor: 'rgba(15,23,42,0.4)',
    border: '1px solid rgba(51,65,85,0.3)',
    borderRadius: '0.875rem',
    padding: '1.5rem',
    marginBottom: '1.5rem'
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '0.75rem 1rem',
    backgroundColor: 'rgba(11,18,32,0.6)',
    border: '1px solid rgba(51,65,85,0.5)',
    borderRadius: '0.625rem', color: '#e2e8f0',
    fontSize: '0.875rem', outline: 'none',
    boxSizing: 'border-box'
  }

  const labelStyle: React.CSSProperties = {
    display: 'block', color: '#94a3b8',
    fontSize: '0.8rem', fontWeight: 500,
    marginBottom: '0.4rem'
  }

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
        Cargando configuración de WhatsApp...
      </div>
    )
  }

  return (
    <div style={{ maxWidth: '720px' }}>

      {/* ---- Encabezado ---- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', marginBottom: '2rem' }}>
        <div style={{
          width: '3rem', height: '3rem', borderRadius: '0.875rem',
          backgroundColor: 'rgba(37,211,102,0.12)',
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <MessageCircle size={22} color="#25d366" />
        </div>
        <div>
          <h2 style={{ color: '#fff', fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
            WhatsApp / Mensajes Automáticos
          </h2>
          <p style={{ color: '#64748b', fontSize: '0.875rem', margin: '0.2rem 0 0 0' }}>
            Configurá los mensajes que se envían a tus clientes por WhatsApp
          </p>
        </div>
      </div>

      {/* ---- Estado general ---- */}
      <div style={sectionStyle}>
        <h3 style={{ color: '#fff', fontSize: '1rem', fontWeight: 600, margin: '0 0 1rem 0' }}>
          Estado general
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <ToggleSwitch
            checked={settings.enabled}
            onChange={v => setSettings(s => ({ ...s, enabled: v }))}
            label="Integración WhatsApp activada"
            description="Habilita los botones de envío manual desde cada orden"
          />
          <ToggleSwitch
            checked={settings.auto_send_enabled}
            onChange={v => setSettings(s => ({ ...s, auto_send_enabled: v }))}
            label="Envío automático al cambiar estado"
            description="Abre WhatsApp automáticamente cuando una orden cambia de estado (requiere que cada plantilla tenga activado 'Auto')"
            color="#6366f1"
          />
        </div>

        {!settings.enabled && (
          <div style={{
            marginTop: '1rem', padding: '0.75rem 1rem', borderRadius: '0.625rem',
            backgroundColor: 'rgba(245,158,11,0.06)',
            border: '1px solid rgba(245,158,11,0.2)',
            display: 'flex', gap: '0.625rem', alignItems: 'center'
          }}>
            <AlertTriangle size={15} color="#f59e0b" style={{ flexShrink: 0 }} />
            <p style={{ color: '#f59e0b', fontSize: '0.8rem', margin: 0 }}>
              La integración está deshabilitada. Activala para poder enviar mensajes desde las órdenes.
            </p>
          </div>
        )}
      </div>

      {/* ---- API WhatsApp Business Cloud ---- */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.25rem' }}>
          <Key size={16} color="#25d366" />
          <h3 style={{ color: '#fff', fontSize: '1rem', fontWeight: 600, margin: 0 }}>
            API WhatsApp Business
          </h3>
        </div>
        <p style={{ color: '#64748b', fontSize: '0.8rem', margin: '0 0 1rem 0' }}>
          El envío oficial por Cloud API (modo silencioso, sin abrir el navegador) se conecta
          desde la sección <strong style={{ color: '#94a3b8' }}>WhatsApp</strong> del menú, con el
          inicio de sesión seguro de Meta. Las credenciales se guardan cifradas del lado del
          servidor; por seguridad ya no se cargan tokens manualmente acá.
        </p>
        <div style={{
          padding: '0.75rem 1rem', borderRadius: '0.625rem',
          backgroundColor: 'rgba(99,102,241,0.06)',
          border: '1px solid rgba(99,102,241,0.2)',
          fontSize: '0.8rem', color: '#94a3b8', display: 'flex', gap: '0.625rem', alignItems: 'flex-start'
        }}>
          <ExternalLink size={14} color="#818cf8" style={{ flexShrink: 0, marginTop: '0.15rem' }} />
          <span>
            Sin una conexión activa, los mensajes usan el modo <strong style={{ color: '#94a3b8' }}>wa.me / WhatsApp Web / Desktop</strong>:
            abren WhatsApp con el mensaje preparado para que lo revises y envíes vos.
          </span>
        </div>
      </div>

      {/* ---- Datos del negocio ---- */}
      <div style={sectionStyle}>
        <h3 style={{ color: '#fff', fontSize: '1rem', fontWeight: 600, margin: '0 0 0.25rem 0' }}>
          Datos del negocio para los mensajes
        </h3>
        <p style={{ color: '#64748b', fontSize: '0.8rem', margin: '0 0 1.25rem 0' }}>
          Estos valores reemplazan las variables <code style={{ color: '#818cf8' }}>{'{local}'}</code>, <code style={{ color: '#818cf8' }}>{'{direccion}'}</code>, etc.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={labelStyle}>Nombre del local</label>
            <input style={inputStyle} value={settings.business_name}
              onChange={e => setSettings(s => ({ ...s, business_name: e.target.value }))}
              placeholder="TechRepair Pro" />
          </div>
          <div>
            <label style={labelStyle}>Teléfono / WhatsApp</label>
            <input style={inputStyle} value={settings.business_whatsapp}
              onChange={e => setSettings(s => ({ ...s, business_whatsapp: e.target.value }))}
              placeholder="+54 11 1234-5678" />
          </div>
          <div>
            <label style={labelStyle}>Instagram</label>
            <input style={inputStyle} value={settings.business_instagram}
              onChange={e => setSettings(s => ({ ...s, business_instagram: e.target.value }))}
              placeholder="@tulocal" />
          </div>
          <div>
            <label style={labelStyle}>Horario de atención</label>
            <input style={inputStyle} value={settings.business_hours}
              onChange={e => setSettings(s => ({ ...s, business_hours: e.target.value }))}
              placeholder="Lun a Vie 9 a 18hs" />
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <label style={labelStyle}>Dirección</label>
            <input style={inputStyle} value={settings.business_address}
              onChange={e => setSettings(s => ({ ...s, business_address: e.target.value }))}
              placeholder="Av. Corrientes 1234, CABA" />
          </div>
        </div>
      </div>

      {/* ---- Firma / cierre ---- */}
      <div style={sectionStyle}>
        <h3 style={{ color: '#fff', fontSize: '1rem', fontWeight: 600, margin: '0 0 0.25rem 0' }}>
          Firma / mensaje de cierre
        </h3>
        <p style={{ color: '#64748b', fontSize: '0.8rem', margin: '0 0 1rem 0' }}>
          Se agrega al final de cada mensaje. Dejalo vacío si no querés firma automática.
        </p>
        <textarea
          value={settings.closing_message}
          onChange={e => setSettings(s => ({ ...s, closing_message: e.target.value }))}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
          placeholder={'Saludos, {local}.\nWhatsApp: {whatsapp}'}
        />
      </div>

      {/* ---- Variables disponibles ---- */}
      <div style={{ ...sectionStyle, marginBottom: '1.5rem' }}>
        <h3 style={{ color: '#fff', fontSize: '1rem', fontWeight: 600, margin: '0 0 0.75rem 0' }}>
          Variables disponibles
        </h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
          {AVAILABLE_VARS.map(v => (
            <code
              key={v}
              style={{
                backgroundColor: 'rgba(99,102,241,0.1)',
                color: '#818cf8', fontSize: '0.78rem',
                padding: '0.2rem 0.55rem', borderRadius: '999px',
                border: '1px solid rgba(99,102,241,0.2)',
                cursor: 'default'
              }}
            >
              {v}
            </code>
          ))}
        </div>
        <p style={{ color: '#475569', fontSize: '0.75rem', margin: '0.75rem 0 0 0' }}>
          Usalas en cualquier plantilla. Si el dato no existe, la variable se reemplaza por espacio vacío.
        </p>
      </div>

      {/* ---- Plantillas por estado ---- */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <div>
            <h3 style={{ color: '#fff', fontSize: '1rem', fontWeight: 600, margin: 0 }}>
              Plantillas por estado de orden
            </h3>
            <p style={{ color: '#64748b', fontSize: '0.8rem', margin: '0.2rem 0 0 0' }}>
              Cada estado tiene su propio mensaje. Hacé clic en uno para editarlo.
            </p>
          </div>
          <button
            onClick={() => setConfirmReset(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              fontSize: '0.78rem', color: '#64748b',
              backgroundColor: 'rgba(100,116,139,0.1)',
              border: '1px solid rgba(100,116,139,0.2)',
              borderRadius: '0.5rem', padding: '0.4rem 0.75rem',
              cursor: 'pointer'
            }}
          >
            <RotateCcw size={12} />
            Restaurar
          </button>
        </div>

        {confirmReset && (
          <div style={{
            padding: '0.875rem 1rem', borderRadius: '0.75rem',
            backgroundColor: 'rgba(220,38,38,0.06)',
            border: '1px solid rgba(220,38,38,0.25)',
            marginBottom: '1rem',
            display: 'flex', alignItems: 'center', gap: '1rem'
          }}>
            <AlertTriangle size={16} color="#dc2626" style={{ flexShrink: 0 }} />
            <p style={{ color: '#f87171', fontSize: '0.85rem', margin: 0, flex: 1 }}>
              ¿Restaurar todas las plantillas a los textos por defecto? Se perderán los cambios actuales.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => setConfirmReset(false)}
                style={{ fontSize: '0.8rem', color: '#94a3b8', background: 'transparent', border: 'none', cursor: 'pointer' }}
              >
                Cancelar
              </button>
              <button
                onClick={handleResetTemplates}
                style={{
                  fontSize: '0.8rem', fontWeight: 600, color: '#fff',
                  backgroundColor: '#dc2626', border: 'none',
                  borderRadius: '0.4rem', padding: '0.35rem 0.75rem', cursor: 'pointer'
                }}
              >
                Restaurar
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {templates.map(t => (
            <TemplateCard
              key={t.status_key}
              template={t}
              settings={settings}
              onChange={updateTemplate}
            />
          ))}
        </div>
      </div>

      {/* ---- Feedback de guardado ---- */}
      {error && (
        <div style={{
          padding: '0.875rem 1rem', borderRadius: '0.75rem',
          backgroundColor: 'rgba(220,38,38,0.08)',
          border: '1px solid rgba(220,38,38,0.3)',
          color: '#dc2626', fontSize: '0.875rem', marginBottom: '1rem'
        }}>
          {error}
        </div>
      )}
      {saved && (
        <div style={{
          padding: '0.875rem 1rem', borderRadius: '0.75rem',
          backgroundColor: 'rgba(16,185,129,0.08)',
          border: '1px solid rgba(16,185,129,0.25)',
          display: 'flex', gap: '0.5rem', alignItems: 'center',
          color: '#10b981', fontSize: '0.875rem', marginBottom: '1rem'
        }}>
          <CheckCircle size={16} />
          Configuración guardada correctamente.
        </div>
      )}

      {/* ---- Botón guardar ---- */}
      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.625rem',
          padding: '0.875rem 2rem',
          backgroundColor: saving ? '#374151' : '#25d366',
          border: 'none', borderRadius: '0.75rem',
          color: '#fff', fontWeight: 700, fontSize: '0.95rem',
          cursor: saving ? 'not-allowed' : 'pointer',
          transition: 'all 0.2s'
        }}
        onMouseEnter={e => { if (!saving) e.currentTarget.style.backgroundColor = '#1da851' }}
        onMouseLeave={e => { if (!saving) e.currentTarget.style.backgroundColor = '#25d366' }}
      >
        {saving
          ? <><RefreshCw size={17} style={{ animation: 'tr-spin 1s linear infinite' }} /> Guardando...</>
          : <><Save size={17} /> Guardar configuración</>
        }
      </button>
    </div>
  )
}
