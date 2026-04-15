/**
 * ComprobantePrintSettings
 * Panel de configuración para la plantilla de comprobantes.
 * Incluye preview en tiempo real del aspecto final del comprobante.
 */

import { useRef, useState, type ChangeEvent, type ElementType, type ReactNode } from 'react'
import {
  Save, Upload, Trash2, CheckCircle, Eye, EyeOff,
  Image, Building2, MessageSquare, ToggleLeft, ToggleRight,
  Phone,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { uploadBusinessLogo } from '../../lib/storageSetup'
import {
  useOrderPrintSettings,
  OrderPrintSettings as OPS,
} from '../../hooks/useOrderPrintSettings'
import { ComprobanteDocumento } from '../comprobantes/ComprobanteDocumento'
import type { Comprobante, ComprobanteItem } from '../../hooks/useComprobantes'

// ─── Sample data for preview ──────────────────────────────────────────────────

const SAMPLE_COMPROBANTE: Comprobante = {
  id: 'preview-00000000-0000-0000-0000-000000000000',
  order_id: null,
  customer_id: null,
  tipo: 'factura_c',
  numero: '00000001',
  punto_venta: '0001',
  fecha: new Date().toISOString(),
  subtotal: 32500,
  impuestos: 0,
  total: 32500,
  estado: 'emitido',
  cae: null,
  cae_vencimiento: null,
  afip_response: null,
  condicion_fiscal: 'Consumidor Final',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const SAMPLE_ITEMS: ComprobanteItem[] = [
  { id: '1', comprobante_id: 'preview', descripcion: 'Diagnóstico y reparación', cantidad: 1, precio_unitario: 15000, subtotal: 15000, orden: 1 },
  { id: '2', comprobante_id: 'preview', descripcion: 'Cambio de pantalla', cantidad: 1, precio_unitario: 12500, subtotal: 12500, orden: 2 },
  { id: '3', comprobante_id: 'preview', descripcion: 'Mano de obra', cantidad: 1, precio_unitario: 5000, subtotal: 5000, orden: 3 },
]

const SAMPLE_CLIENTE = { id: 'cl-preview', name: 'María García', cuit: '20-30123456-9', condicion_fiscal: 'Consumidor Final' }
const SAMPLE_ORDEN = { id: 'ord-preview', order_number: 'ORD-2026-001' }

// ─── Helper components ────────────────────────────────────────────────────────

const Toggle = ({ value, onChange, label, sub }: {
  value: boolean; onChange: (v: boolean) => void; label: string; sub?: string
}) => (
  <div
    onClick={() => onChange(!value)}
    style={{
      display: 'flex', alignItems: 'center', gap: '0.625rem',
      padding: '0.5rem 0.625rem', borderRadius: 8, cursor: 'pointer',
      background: value ? 'var(--accent-primary-subtle)' : 'transparent',
      transition: 'background 0.15s',
    }}
  >
    {value
      ? <ToggleRight size={20} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
      : <ToggleLeft size={20} style={{ color: 'var(--text-subtle)', flexShrink: 0 }} />}
    <div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 500, margin: 0 }}>{label}</p>
      {sub && <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0.1rem 0 0' }}>{sub}</p>}
    </div>
  </div>
)

const Field = ({ label, value, onChange, placeholder, multiline }: {
  label: string; value: string; onChange: (v: string) => void
  placeholder?: string; multiline?: boolean
}) => (
  <div style={{ marginBottom: '0.75rem' }}>
    <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.3rem', fontWeight: 500 }}>
      {label}
    </label>
    {multiline ? (
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        style={{
          width: '100%', padding: '0.5rem 0.75rem',
          background: 'var(--input-bg)', border: '1px solid var(--input-border)',
          borderRadius: 'var(--radius-md)', color: 'var(--text-primary)',
          fontSize: '0.875rem', outline: 'none', resize: 'vertical',
          boxSizing: 'border-box', fontFamily: 'inherit',
        }}
      />
    ) : (
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%', padding: '0.5rem 0.75rem',
          background: 'var(--input-bg)', border: '1px solid var(--input-border)',
          borderRadius: 'var(--radius-md)', color: 'var(--text-primary)',
          fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box',
        }}
      />
    )}
  </div>
)

const Section = ({ title, icon: Icon, children }: {
  title: string; icon: ElementType; children: ReactNode
}) => (
  <div style={{ marginBottom: '1.5rem' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.875rem', paddingBottom: '0.5rem', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{
        width: 28, height: 28, borderRadius: 8,
        background: 'var(--accent-primary-subtle)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={14} style={{ color: 'var(--accent-primary)' }} />
      </div>
      <h3 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>{title}</h3>
    </div>
    {children}
  </div>
)

// ─── Main component ───────────────────────────────────────────────────────────

export function ComprobantePrintSettings() {
  const { businessId } = useAuth()
  const {
    settings, loading, saving, savedOk, error,
    saveSettings, updateLocal,
  } = useOrderPrintSettings(businessId)

  const [showPreview, setShowPreview] = useState(true)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const upd = (key: keyof OPS, value: unknown) =>
    updateLocal({ [key]: value } as Partial<OPS>)

  const handleSave = async () => {
    try {
      await saveSettings({
        // Business identity (shared with order print)
        nombre_comercial:  settings.nombre_comercial,
        domicilio_fiscal:  settings.domicilio_fiscal,
        orden_whatsapp:    settings.orden_whatsapp,
        orden_instagram:   settings.orden_instagram,
        orden_email_visible: settings.orden_email_visible,
        // Comprobante-specific
        comp_mensaje_agradecimiento: settings.comp_mensaje_agradecimiento,
        comp_notas:                  settings.comp_notas,
        comp_mostrar_logo:           settings.comp_mostrar_logo,
        comp_mostrar_direccion:      settings.comp_mostrar_direccion,
        comp_mostrar_whatsapp:       settings.comp_mostrar_whatsapp,
        comp_mostrar_instagram:      settings.comp_mostrar_instagram,
        comp_mostrar_email:          settings.comp_mostrar_email,
        comp_mostrar_agradecimiento: settings.comp_mostrar_agradecimiento,
        comp_mostrar_notas:          settings.comp_mostrar_notas,
      })
    } catch { /* error shown via hook */ }
  }

  const handleLogoUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0] || !businessId) return
    try {
      setUploadingLogo(true)
      const url = await uploadBusinessLogo(e.target.files[0], businessId)
      await supabase.from('business_settings').update({ logo_url: url }).eq('business_id', businessId)
      updateLocal({ logo_url: url ?? undefined })
    } catch (err) {
      console.error('Error uploading logo:', err)
    } finally {
      setUploadingLogo(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleLogoDelete = async () => {
    if (!businessId || !confirm('¿Eliminar el logo actual?')) return
    try {
      await supabase.from('business_settings').update({ logo_url: null }).eq('business_id', businessId)
      updateLocal({ logo_url: null })
    } catch (err) {
      console.error('Error deleting logo:', err)
    }
  }

  if (loading) {
    return <p style={{ color: 'var(--text-muted)', padding: '2rem', textAlign: 'center' }}>Cargando configuración...</p>
  }

  return (
    <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>

      {/* ── Left panel: settings ── */}
      <div style={{ width: 320, flexShrink: 0 }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <div>
            <h2 style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '1rem', margin: 0 }}>
              Diseño del comprobante
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0.25rem 0 0' }}>
              Personalizá la plantilla de cada comprobante
            </p>
          </div>
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="btn btn-outline btn-sm"
            title={showPreview ? 'Ocultar preview' : 'Ver preview'}
          >
            {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}
            {showPreview ? 'Ocultar' : 'Preview'}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div style={{ padding: '0.625rem 0.875rem', background: 'var(--error-subtle)', border: '1px solid var(--error)', borderRadius: 'var(--radius-md)', color: 'var(--error)', fontSize: '0.8rem', marginBottom: '1rem' }}>
            {error}
          </div>
        )}

        {/* ── LOGO ── */}
        <Section title="Logo del negocio" icon={Image}>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleLogoUpload} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.875rem' }}>
            {/* Logo preview / placeholder */}
            <div style={{
              width: 64, height: 64, borderRadius: 12, flexShrink: 0,
              border: '2px dashed var(--border-strong)',
              background: 'var(--bg-surface)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden',
            }}>
              {settings.logo_url
                ? <img src={settings.logo_url} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 4 }} />
                : <Image size={22} style={{ color: 'var(--text-subtle)' }} />}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingLogo}
                className="btn btn-primary btn-sm"
              >
                <Upload size={13} />
                {uploadingLogo ? 'Subiendo...' : settings.logo_url ? 'Cambiar logo' : 'Subir logo'}
              </button>
              {settings.logo_url && (
                <button onClick={handleLogoDelete} className="btn btn-outline btn-sm" style={{ color: 'var(--error)', borderColor: 'var(--error)' }}>
                  <Trash2 size={13} /> Eliminar
                </button>
              )}
            </div>
          </div>
          <Toggle
            value={settings.comp_mostrar_logo}
            onChange={v => upd('comp_mostrar_logo', v)}
            label="Mostrar logo en el comprobante"
          />
        </Section>

        {/* ── IDENTITY ── */}
        <Section title="Datos del negocio" icon={Building2}>
          <Field
            label="Nombre del negocio"
            value={settings.nombre_comercial}
            onChange={v => upd('nombre_comercial', v)}
            placeholder="Ej: TechRepair Pro"
          />
          <Field
            label="Dirección"
            value={settings.domicilio_fiscal}
            onChange={v => upd('domicilio_fiscal', v)}
            placeholder="Ej: Av. Corrientes 1234, CABA"
          />
          <Toggle
            value={settings.comp_mostrar_direccion}
            onChange={v => upd('comp_mostrar_direccion', v)}
            label="Mostrar dirección"
          />
        </Section>

        {/* ── CONTACT ── */}
        <Section title="Información de contacto" icon={Phone}>
          <Field label="WhatsApp" value={settings.orden_whatsapp} onChange={v => upd('orden_whatsapp', v)} placeholder="+54 9 11 1234-5678" />
          <Toggle value={settings.comp_mostrar_whatsapp} onChange={v => upd('comp_mostrar_whatsapp', v)} label="Mostrar WhatsApp" />
          <div style={{ height: '0.75rem' }} />
          <Field label="Instagram" value={settings.orden_instagram} onChange={v => upd('orden_instagram', v)} placeholder="@tuNegocio" />
          <Toggle value={settings.comp_mostrar_instagram} onChange={v => upd('comp_mostrar_instagram', v)} label="Mostrar Instagram" />
          <div style={{ height: '0.75rem' }} />
          <Field label="Email visible" value={settings.orden_email_visible} onChange={v => upd('orden_email_visible', v)} placeholder="info@tunegocio.com" />
          <Toggle value={settings.comp_mostrar_email} onChange={v => upd('comp_mostrar_email', v)} label="Mostrar email" />
        </Section>

        {/* ── FOOTER MESSAGES ── */}
        <Section title="Pie del comprobante" icon={MessageSquare}>
          <Field
            label="Mensaje de agradecimiento"
            value={settings.comp_mensaje_agradecimiento}
            onChange={v => upd('comp_mensaje_agradecimiento', v)}
            placeholder="Gracias por su compra"
          />
          <Toggle
            value={settings.comp_mostrar_agradecimiento}
            onChange={v => upd('comp_mostrar_agradecimiento', v)}
            label="Mostrar mensaje de agradecimiento"
          />
          <div style={{ height: '0.875rem' }} />
          <Field
            label="Notas adicionales (opcional)"
            value={settings.comp_notas}
            onChange={v => upd('comp_notas', v)}
            placeholder="Ej: Los equipos deben retirarse dentro de los 60 días..."
            multiline
          />
          <Toggle
            value={settings.comp_mostrar_notas}
            onChange={v => upd('comp_mostrar_notas', v)}
            label="Mostrar notas en el comprobante"
          />
        </Section>

        {/* ── Save button ── */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', marginTop: '0.5rem' }}
        >
          {saving ? (
            <>
              <span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} />
              Guardando...
            </>
          ) : savedOk ? (
            <><CheckCircle size={15} /> ¡Guardado!</>
          ) : (
            <><Save size={15} /> Guardar cambios</>
          )}
        </button>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>

      {/* ── Right panel: live preview ── */}
      {showPreview && (
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            marginBottom: '0.875rem',
          }}>
            <Eye size={14} style={{ color: 'var(--accent-primary)' }} />
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: 600, margin: 0 }}>
              Vista previa — así se verá el comprobante
            </p>
            <span style={{
              fontSize: '0.68rem', padding: '0.125rem 0.5rem', borderRadius: 9999,
              background: 'var(--success-subtle)', color: 'var(--success)',
              border: '1px solid var(--success)', fontWeight: 600,
            }}>
              En tiempo real
            </span>
          </div>

          {/* Scale-down wrapper so preview fits without scrolling */}
          <div style={{ transformOrigin: 'top left', transform: 'scale(0.85)', width: '117.6%', pointerEvents: 'none', userSelect: 'none' }}>
            <ComprobanteDocumento
              comprobante={SAMPLE_COMPROBANTE}
              items={SAMPLE_ITEMS}
              cliente={SAMPLE_CLIENTE}
              orden={SAMPLE_ORDEN}
              profile={settings}
              editable={false}
            />
          </div>
        </div>
      )}
    </div>
  )
}
