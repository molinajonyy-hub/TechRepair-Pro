import { useRef, useState } from 'react'
import {
  Save, RefreshCw, Eye, EyeOff, Upload, Trash2,
  CheckCircle, RotateCcw, Printer, FileText, MapPin,
  MessageSquare, Image, ToggleLeft, ToggleRight,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { uploadBusinessLogo } from '../../lib/storageSetup'
import { useOrderPrintSettings, DEFAULT_CONDITIONS, OrderPrintSettings as OrderPrintSettingsType } from '../../hooks/useOrderPrintSettings'
import { ServiceOrderPrint, ServiceOrderData } from '../print/ServiceOrderPrint'

// ─── Sample order for preview ─────────────────────────────────────────────────

const SAMPLE_ORDER: ServiceOrderData = {
  id: 'abc12345-0000-0000-0000-000000000000',
  created_at: new Date().toISOString(),
  status: 'in_repair',
  technician: 'Juan Técnico',
  customer: { name: 'María García', phone: '11 4567-8901', dni: '30.123.456', email: 'maria@email.com', address: 'Calle Falsa 123' },
  device: { type: 'Celular', brand: 'Apple', model: 'iPhone 14 Pro', color: 'Negro espacial', imei: '352345678901234', serial: 'F4GT56XXXXX', password: '1234', accessories: 'Cargador, funda', aesthetic_condition: 'Pantalla rayada' },
  reported_issue: 'No enciende después de caída. Pantalla no responde al tacto.',
  diagnosis: 'Conector de carga dañado y batería defectuosa.',
  labor: 'Cambio de batería y conector de carga.',
  observations: 'Se avisa al cliente antes de proceder.',
  estimated_total: 25000,
}

// ─── Helper components ────────────────────────────────────────────────────────

const Toggle = ({ value, onChange, label, sublabel }: { value: boolean; onChange: (v: boolean) => void; label: string; sublabel?: string }) => (
  <div
    onClick={() => onChange(!value)}
    style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '8px 10px', borderRadius: '6px', backgroundColor: value ? 'rgba(99,102,241,0.06)' : 'transparent', transition: 'background 0.15s' }}
  >
    {value
      ? <ToggleRight size={20} style={{ color: '#6366f1', flexShrink: 0 }} />
      : <ToggleLeft size={20} style={{ color: '#64748b', flexShrink: 0 }} />}
    <div>
      <div style={{ fontSize: '0.875rem', color: '#e2e8f0', fontWeight: 500 }}>{label}</div>
      {sublabel && <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{sublabel}</div>}
    </div>
  </div>
)

const FieldGroup = ({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) => (
  <div style={{ marginBottom: '1.5rem' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.875rem' }}>
      <div style={{ width: '28px', height: '28px', borderRadius: '6px', backgroundColor: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={14} style={{ color: '#6366f1' }} />
      </div>
      <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: '#ffffff', margin: 0 }}>{title}</h3>
    </div>
    {children}
  </div>
)

const InputField = ({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) => (
  <div style={{ marginBottom: '0.75rem' }}>
    <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>{label}</label>
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{ width: '100%', padding: '0.5rem 0.75rem', backgroundColor: 'rgba(15,23,42,0.8)', border: '1px solid rgba(51,65,85,0.6)', borderRadius: '0.375rem', color: '#f1f5f9', fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }}
    />
  </div>
)

// ─── Main Component ───────────────────────────────────────────────────────────

export function OrderPrintSettings() {
  const { businessId } = useAuth()
  const { settings, loading, saving, savedOk, error, saveSettings, updateLocal } = useOrderPrintSettings(businessId)
  const [showPreview, setShowPreview] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleSave = async () => {
    try {
      // Solo guardamos los campos específicos de la orden impresa
      // (los campos base del negocio los gestiona el panel de Configuración General)
      await saveSettings({
        orden_whatsapp: settings.orden_whatsapp,
        orden_instagram: settings.orden_instagram,
        orden_email_visible: settings.orden_email_visible,
        orden_sitio_web: settings.orden_sitio_web,
        orden_mensaje_agradecimiento: settings.orden_mensaje_agradecimiento,
        orden_condiciones: settings.orden_condiciones,
        orden_condiciones_activo: settings.orden_condiciones_activo,
        orden_condiciones_en: settings.orden_condiciones_en,
        orden_mostrar_logo: settings.orden_mostrar_logo,
        orden_mostrar_direccion: settings.orden_mostrar_direccion,
        orden_mostrar_whatsapp: settings.orden_mostrar_whatsapp,
        orden_mostrar_instagram: settings.orden_mostrar_instagram,
        orden_mostrar_email: settings.orden_mostrar_email,
        orden_mostrar_sitio_web: settings.orden_mostrar_sitio_web,
        orden_mostrar_agradecimiento: settings.orden_mostrar_agradecimiento,
        orden_mostrar_condiciones: settings.orden_mostrar_condiciones,
      })
    } catch {
      // error shown via hook
    }
  }

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0] || !businessId) return
    const file = e.target.files[0]
    try {
      setUploadingLogo(true)
      const url = await uploadBusinessLogo(file, businessId)
      await supabase.from('business_settings').update({ logo_url: url }).eq('business_id', businessId)
      updateLocal({ logo_url: url ?? undefined })
    } catch (err: any) {
      console.error('Error uploading logo:', err)
    } finally {
      setUploadingLogo(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleLogoDelete = async () => {
    if (!businessId) return
    if (!confirm('¿Eliminar el logo actual?')) return
    try {
      await supabase.from('business_settings').update({ logo_url: null }).eq('business_id', businessId)
      updateLocal({ logo_url: null })
    } catch (err) {
      console.error('Error deleting logo:', err)
    }
  }

  const upd = (key: keyof OrderPrintSettingsType, value: unknown) =>
    updateLocal({ [key]: value } as Partial<OrderPrintSettingsType>)

  if (loading) {
    return <div style={{ padding: '2rem', color: '#94a3b8', textAlign: 'center' }}>Cargando configuración...</div>
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: showPreview ? '1fr 1fr' : '1fr', gap: '1.5rem', alignItems: 'start' }}>
      {/* ── Panel de configuración ── */}
      <div>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '8px', backgroundColor: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Printer size={18} style={{ color: '#6366f1' }} />
            </div>
            <div>
              <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#ffffff', margin: 0 }}>Orden de Servicio Impresa</h2>
              <p style={{ fontSize: '0.8rem', color: '#64748b', margin: 0 }}>Personalización de la hoja A4 dividida en dos copias</p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => setShowPreview(v => !v)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 0.875rem', backgroundColor: showPreview ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: showPreview ? '#818cf8' : '#94a3b8', borderRadius: '0.5rem', cursor: 'pointer', fontSize: '0.8125rem' }}
            >
              <Eye size={14} /> Vista previa
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem', background: savedOk ? '#059669' : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)', border: 'none', color: '#ffffff', borderRadius: '0.625rem', cursor: saving ? 'not-allowed' : 'pointer', fontSize: '0.8125rem', fontWeight: 600, opacity: saving ? 0.7 : 1, boxShadow: savedOk ? 'none' : '0 4px 12px rgba(99,102,241,0.35)' }}
            >
              {saving ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> : savedOk ? <CheckCircle size={14} /> : <Save size={14} />}
              {saving ? 'Guardando…' : savedOk ? 'Guardado' : 'Guardar'}
            </button>
          </div>
        </div>

        {error && (
          <div style={{ padding: '0.75rem', backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '6px', color: '#ef4444', fontSize: '0.8125rem', marginBottom: '1rem' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>

          {/* 1. LOGO */}
          <FieldGroup title="Logo del Local" icon={Image}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '12px', backgroundColor: '#0f1829', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)', marginBottom: '0.75rem' }}>
              {settings.logo_url ? (
                <img src={settings.logo_url} alt="Logo" style={{ width: '80px', height: '50px', objectFit: 'contain', borderRadius: '4px', backgroundColor: '#fff', padding: '4px' }} />
              ) : (
                <div style={{ width: '80px', height: '50px', backgroundColor: 'rgba(15,23,42,0.8)', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Image size={20} style={{ color: '#475569' }} />
                </div>
              )}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                  {settings.logo_url ? 'Logo actual' : 'Sin logo configurado'}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingLogo}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.75rem', background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)', border: 'none', color: '#fff', borderRadius: '0.625rem', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, boxShadow: '0 4px 12px rgba(99,102,241,0.35)' }}
                  >
                    <Upload size={12} /> {uploadingLogo ? 'Subiendo…' : settings.logo_url ? 'Cambiar' : 'Subir logo'}
                  </button>
                  {settings.logo_url && (
                    <button
                      onClick={handleLogoDelete}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.75rem', backgroundColor: 'transparent', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', borderRadius: '0.375rem', cursor: 'pointer', fontSize: '0.75rem' }}
                    >
                      <Trash2 size={12} /> Eliminar
                    </button>
                  )}
                </div>
              </div>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleLogoUpload} style={{ display: 'none' }} />
            <Toggle value={settings.orden_mostrar_logo} onChange={v => upd('orden_mostrar_logo', v)} label="Mostrar logo en la orden" sublabel="Aparece en el encabezado de ambas copias" />
          </FieldGroup>

          {/* 2. DATOS DEL LOCAL */}
          <FieldGroup title="Datos del Local en la Orden" icon={MapPin}>
            <InputField label="WhatsApp" value={settings.orden_whatsapp} onChange={v => upd('orden_whatsapp', v)} placeholder="+54 9 11 1234-5678" />
            <InputField label="Instagram" value={settings.orden_instagram} onChange={v => upd('orden_instagram', v)} placeholder="@tunegocio" />
            <InputField label="Email (opcional)" value={settings.orden_email_visible} onChange={v => upd('orden_email_visible', v)} placeholder="contacto@tunegocio.com" type="email" />
            <InputField label="Sitio web (opcional)" value={settings.orden_sitio_web} onChange={v => upd('orden_sitio_web', v)} placeholder="www.tunegocio.com" />
          </FieldGroup>

          {/* 3. MENSAJE DE AGRADECIMIENTO */}
          <FieldGroup title="Mensaje de Agradecimiento" icon={MessageSquare}>
            <div style={{ marginBottom: '0.75rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>Texto del mensaje</label>
              <input
                type="text"
                value={settings.orden_mensaje_agradecimiento}
                onChange={e => upd('orden_mensaje_agradecimiento', e.target.value)}
                placeholder="Gracias por confiar en nosotros"
                style={{ width: '100%', padding: '0.5rem 0.75rem', backgroundColor: 'rgba(15,23,42,0.8)', border: '1px solid rgba(51,65,85,0.6)', borderRadius: '0.375rem', color: '#f1f5f9', fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }}
              />
              <div style={{ marginTop: '0.25rem', fontSize: '0.75rem', color: '#64748b' }}>Se muestra en el pie de la copia del cliente</div>
            </div>
            <Toggle value={settings.orden_mostrar_agradecimiento} onChange={v => upd('orden_mostrar_agradecimiento', v)} label="Mostrar mensaje de agradecimiento" />
          </FieldGroup>

          {/* 4. CONDICIONES DEL SERVICIO */}
          <FieldGroup title="Condiciones del Servicio" icon={FileText}>
            <div style={{ marginBottom: '0.75rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>Texto de las condiciones</label>
              <textarea
                value={settings.orden_condiciones}
                onChange={e => upd('orden_condiciones', e.target.value)}
                rows={5}
                style={{ width: '100%', padding: '0.625rem 0.75rem', backgroundColor: 'rgba(15,23,42,0.8)', border: '1px solid rgba(51,65,85,0.6)', borderRadius: '0.375rem', color: '#f1f5f9', fontSize: '0.8125rem', outline: 'none', resize: 'vertical', lineHeight: '1.5', boxSizing: 'border-box' }}
              />
              <button
                onClick={() => upd('orden_condiciones', DEFAULT_CONDITIONS)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginTop: '0.375rem', padding: '0.25rem 0.625rem', backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8', borderRadius: '0.5rem', cursor: 'pointer', fontSize: '0.75rem' }}
              >
                <RotateCcw size={11} /> Restaurar texto por defecto
              </button>
            </div>
            <Toggle value={settings.orden_condiciones_activo} onChange={v => upd('orden_condiciones_activo', v)} label="Activar condiciones del servicio" />
            <div style={{ marginTop: '0.625rem', marginBottom: '0.25rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.375rem' }}>Mostrar en</label>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {([['ambas', 'Ambas copias'], ['local', 'Solo copia local'], ['cliente', 'Solo copia cliente']] as const).map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => upd('orden_condiciones_en', val)}
                    style={{ padding: '0.375rem 0.875rem', background: settings.orden_condiciones_en === val ? 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' : 'rgba(255,255,255,0.05)', border: settings.orden_condiciones_en === val ? 'none' : '1px solid rgba(255,255,255,0.08)', color: settings.orden_condiciones_en === val ? '#fff' : '#94a3b8', borderRadius: '0.5rem', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 500 }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </FieldGroup>

          {/* 5. VISIBILIDAD */}
          <FieldGroup title="Opciones de Visibilidad" icon={EyeOff}>
            <div style={{ padding: '8px', backgroundColor: '#0f1829', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
              <Toggle value={settings.orden_mostrar_logo} onChange={v => upd('orden_mostrar_logo', v)} label="Logo" sublabel="Encabezado de ambas copias" />
              <Toggle value={settings.orden_mostrar_direccion} onChange={v => upd('orden_mostrar_direccion', v)} label="Dirección" sublabel="Pie de la copia cliente" />
              <Toggle value={settings.orden_mostrar_whatsapp} onChange={v => upd('orden_mostrar_whatsapp', v)} label="WhatsApp" sublabel="Pie de la copia cliente" />
              <Toggle value={settings.orden_mostrar_instagram} onChange={v => upd('orden_mostrar_instagram', v)} label="Instagram" sublabel="Pie de la copia cliente" />
              <Toggle value={settings.orden_mostrar_email} onChange={v => upd('orden_mostrar_email', v)} label="Email" sublabel="Pie de la copia cliente" />
              <Toggle value={settings.orden_mostrar_sitio_web} onChange={v => upd('orden_mostrar_sitio_web', v)} label="Sitio web" sublabel="Pie de la copia cliente" />
              <Toggle value={settings.orden_mostrar_agradecimiento} onChange={v => upd('orden_mostrar_agradecimiento', v)} label="Mensaje de agradecimiento" sublabel="Pie de la copia cliente" />
              <Toggle value={settings.orden_mostrar_condiciones} onChange={v => upd('orden_mostrar_condiciones', v)} label="Condiciones del servicio" sublabel="Según configuración de ubicación" />
            </div>
          </FieldGroup>
        </div>

        {/* Save footer */}
        <div style={{ paddingTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 1.5rem', background: savedOk ? '#059669' : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)', border: 'none', color: '#ffffff', borderRadius: '0.625rem', cursor: saving ? 'not-allowed' : 'pointer', fontSize: '0.875rem', fontWeight: 600, opacity: saving ? 0.7 : 1, boxShadow: savedOk ? 'none' : '0 4px 12px rgba(99,102,241,0.35)' }}
          >
            {saving ? <RefreshCw size={15} /> : savedOk ? <CheckCircle size={15} /> : <Save size={15} />}
            {saving ? 'Guardando…' : savedOk ? '¡Guardado!' : 'Guardar cambios'}
          </button>
        </div>
      </div>

      {/* ── Vista previa ── */}
      {showPreview && (
        <div style={{ position: 'sticky', top: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: '#ffffff', margin: 0 }}>Vista previa en tiempo real</h3>
            <button onClick={() => setShowPreview(false)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: '2px' }}>
              <EyeOff size={14} />
            </button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '8px', textAlign: 'center' }}>
            Datos de ejemplo — escala reducida
          </div>
          {/* Preview: outer = dimensiones visuales, inner = A4 a escala 0.5 */}
          <div style={{
            position: 'relative',
            width: '397px',   /* 794 × 0.5 */
            height: '562px',  /* 1123 × 0.5 */
            overflow: 'hidden',
            borderRadius: '6px',
            border: '1px solid rgba(255,255,255,0.06)',
            margin: '0 auto',
          }}>
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '794px',
              transformOrigin: 'top left',
              transform: 'scale(0.5)',
            }}>
              <ServiceOrderPrint order={SAMPLE_ORDER} printSettings={settings} previewMode />
            </div>
          </div>
          <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#64748b', textAlign: 'center' }}>
            Guardá los cambios para que se apliquen en las órdenes impresas
          </div>
        </div>
      )}
    </div>
  )
}
