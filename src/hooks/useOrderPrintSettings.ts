import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export interface OrderPrintSettings {
  // Datos del negocio (existentes en business_settings)
  nombre_comercial: string
  razon_social: string
  domicilio_fiscal: string
  telefono: string
  email: string
  localidad: string
  provincia: string
  cuit?: string | null
  logo_url?: string | null

  // Campos nuevos específicos para la orden impresa
  orden_whatsapp: string
  orden_instagram: string
  orden_email_visible: string
  orden_sitio_web: string
  orden_mensaje_agradecimiento: string
  orden_condiciones: string
  orden_condiciones_activo: boolean
  orden_condiciones_en: 'cliente' | 'local' | 'ambas'

  // Switches de visibilidad (orden)
  orden_mostrar_logo: boolean
  orden_mostrar_direccion: boolean
  orden_mostrar_whatsapp: boolean
  orden_mostrar_instagram: boolean
  orden_mostrar_email: boolean
  orden_mostrar_sitio_web: boolean
  orden_mostrar_agradecimiento: boolean
  orden_mostrar_condiciones: boolean

  // ── Comprobante print settings ──────────────────────────────
  comp_mensaje_agradecimiento: string
  comp_notas: string
  comp_mostrar_logo: boolean
  comp_mostrar_direccion: boolean
  comp_mostrar_whatsapp: boolean
  comp_mostrar_instagram: boolean
  comp_mostrar_email: boolean
  comp_mostrar_agradecimiento: boolean
  comp_mostrar_notas: boolean
}

export const DEFAULT_CONDITIONS =
  'El cliente autoriza la revisión del equipo. El local no se responsabiliza por pérdida de datos o información almacenada en el dispositivo.\nEl retiro se realiza con la presentación de este comprobante. Los equipos no retirados dentro de los 60 días corridos desde la fecha de ingreso serán considerados abandonados.\nEl presupuesto aprobado tiene validez de 30 días.'

export const DEFAULT_THANK_YOU = 'Gracias por confiar en nosotros'

export const DEFAULT_PRINT_SETTINGS: OrderPrintSettings = {
  nombre_comercial: 'Mi Negocio',
  razon_social: '',
  domicilio_fiscal: '',
  telefono: '',
  email: '',
  localidad: '',
  provincia: '',
  logo_url: null,
  orden_whatsapp: '',
  orden_instagram: '',
  orden_email_visible: '',
  orden_sitio_web: '',
  orden_mensaje_agradecimiento: DEFAULT_THANK_YOU,
  orden_condiciones: DEFAULT_CONDITIONS,
  orden_condiciones_activo: true,
  orden_condiciones_en: 'ambas',
  orden_mostrar_logo: true,
  orden_mostrar_direccion: true,
  orden_mostrar_whatsapp: true,
  orden_mostrar_instagram: true,
  orden_mostrar_email: false,
  orden_mostrar_sitio_web: false,
  orden_mostrar_agradecimiento: true,
  orden_mostrar_condiciones: true,
  // Comprobante
  comp_mensaje_agradecimiento: 'Gracias por su compra',
  comp_notas: '',
  comp_mostrar_logo: true,
  comp_mostrar_direccion: true,
  comp_mostrar_whatsapp: true,
  comp_mostrar_instagram: false,
  comp_mostrar_email: false,
  comp_mostrar_agradecimiento: true,
  comp_mostrar_notas: false,
}

export function useOrderPrintSettings(businessId?: string | null) {
  const [settings, setSettings] = useState<OrderPrintSettings>(DEFAULT_PRINT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)

  useEffect(() => {
    if (businessId) {
      loadSettings()
    } else {
      setLoading(false)
    }
  }, [businessId])

  const loadSettings = async () => {
    try {
      setLoading(true)
      setError(null)

      const { data, error: dbError } = await supabase
        .from('business_settings')
        .select('*')
        .eq('business_id', businessId)
        .single()

      if (dbError) throw dbError

      if (data) {
        setSettings({
          nombre_comercial: data.nombre_comercial || '',
          razon_social: data.razon_social || '',
          domicilio_fiscal: data.domicilio_fiscal || '',
          telefono: data.telefono || '',
          email: data.email || '',
          localidad: data.localidad || '',
          provincia: data.provincia || '',
          logo_url: data.logo_url ?? null,

          orden_whatsapp: data.orden_whatsapp || '',
          orden_instagram: data.orden_instagram || '',
          orden_email_visible: data.orden_email_visible || data.email || '',
          orden_sitio_web: data.orden_sitio_web || '',
          orden_mensaje_agradecimiento: data.orden_mensaje_agradecimiento || DEFAULT_THANK_YOU,
          orden_condiciones: data.orden_condiciones || DEFAULT_CONDITIONS,
          orden_condiciones_activo: data.orden_condiciones_activo ?? true,
          orden_condiciones_en: data.orden_condiciones_en || 'ambas',

          orden_mostrar_logo: data.orden_mostrar_logo ?? true,
          orden_mostrar_direccion: data.orden_mostrar_direccion ?? true,
          orden_mostrar_whatsapp: data.orden_mostrar_whatsapp ?? true,
          orden_mostrar_instagram: data.orden_mostrar_instagram ?? true,
          orden_mostrar_email: data.orden_mostrar_email ?? false,
          orden_mostrar_sitio_web: data.orden_mostrar_sitio_web ?? false,
          orden_mostrar_agradecimiento: data.orden_mostrar_agradecimiento ?? true,
          orden_mostrar_condiciones: data.orden_mostrar_condiciones ?? true,
          // Comprobante
          comp_mensaje_agradecimiento: data.comp_mensaje_agradecimiento || 'Gracias por su compra',
          comp_notas: data.comp_notas || '',
          comp_mostrar_logo: data.comp_mostrar_logo ?? true,
          comp_mostrar_direccion: data.comp_mostrar_direccion ?? true,
          comp_mostrar_whatsapp: data.comp_mostrar_whatsapp ?? true,
          comp_mostrar_instagram: data.comp_mostrar_instagram ?? false,
          comp_mostrar_email: data.comp_mostrar_email ?? false,
          comp_mostrar_agradecimiento: data.comp_mostrar_agradecimiento ?? true,
          comp_mostrar_notas: data.comp_mostrar_notas ?? false,
        })
      }
    } catch (err) {
      console.error('Error loading order print settings:', err)
      setError('Error al cargar configuración de impresión')
    } finally {
      setLoading(false)
    }
  }

  const saveSettings = async (updates: Partial<OrderPrintSettings>) => {
    if (!businessId) return
    try {
      setSaving(true)
      setError(null)

      const { error: dbError } = await supabase
        .from('business_settings')
        .update(updates)
        .eq('business_id', businessId)

      if (dbError) throw dbError

      setSettings(prev => ({ ...prev, ...updates }))
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 2500)
    } catch (err: any) {
      const msg = err?.message || err?.details || JSON.stringify(err)
      console.error('Error saving order print settings:', msg, err)
      setError(`Error al guardar configuración: ${msg}`)
      throw err
    } finally {
      setSaving(false)
    }
  }

  const updateLocal = (updates: Partial<OrderPrintSettings>) => {
    setSettings(prev => ({ ...prev, ...updates }))
  }

  return {
    settings,
    loading,
    saving,
    savedOk,
    error,
    saveSettings,
    updateLocal,
    refresh: loadSettings,
  }
}
