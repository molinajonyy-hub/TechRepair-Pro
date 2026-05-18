import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Building2,
  MapPin,
  FileText,
  Settings as SettingsIcon,
  Shield,
  Server,
  Bell,
  Save,
  Plus,
  Trash2,
  Edit,
  CheckCircle,
  XCircle,
  X,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Printer,

} from 'lucide-react'
import { OrderPrintSettings } from '../components/settings/OrderPrintSettings'
import { ComprobantePrintSettings } from '../components/settings/ComprobantePrintSettings'
import { PaymentMethodSettings } from '../components/payments/PaymentMethodSettings'
import { CommissionSettings } from '../components/settings/CommissionSettings'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import ArcaService from '../services/arcaService'
import { uploadBusinessLogo } from '../lib/storageSetup'

type TabType = 'datos' | 'puntos' | 'arca' | 'preferencias' | 'seguridad' | 'orden' | 'comprobante' | 'pagos' | 'comisiones'

interface BusinessSettings {
  id?: string
  business_id?: string
  nombre_comercial: string
  razon_social: string
  cuit: string
  condicion_iva: string
  domicilio_fiscal: string
  localidad: string
  provincia: string
  codigo_postal: string
  telefono: string
  email: string
  logo_url?: string
  moneda_predeterminada: string
  formato_fecha: string
  iva_por_defecto: number
  numeracion_comprobantes: string
  observaciones_comprobantes: string
  stock_negativo: boolean
  alertas_bajo_stock: boolean
  categoria_cliente_defecto: string
  tipo_comprobante_defecto: string
}

interface SalesPoint {
  id?: string
  business_id?: string
  numero: number
  nombre: string
  sucursal: string
  domicilio: string
  condicion_fiscal: string
  activo: boolean
  predeterminado: boolean
  tipo_emision: 'manual' | 'electronica' | 'ambas'
}

interface ArcaConfig {
  id?: string
  business_id?: string
  cuit: string
  razon_social?: string
  ambiente: 'homologacion' | 'produccion'
  punto_venta: number
  web_service: string
  cert_file?: string
  private_key?: string
  pfx_file?: string
  pfx_password?: string
  alias?: string
  expires_at?: string
  estado_conexion: string
  ultima_sincronizacion?: string
  ultimo_error?: string
}

// ─── Mayorista Toggle ─────────────────────────────────────────────────────────

function MayoristaToggle() {
  const { businessId } = useAuth()
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!businessId) return
    supabase.from('business_settings').select('mayorista_enabled').eq('business_id', businessId).maybeSingle()
      .then(({ data }) => {
        setEnabled(data?.mayorista_enabled !== false) // true por defecto
        setLoading(false)
      })
  }, [businessId])

  const toggle = async () => {
    if (!businessId || saving) return
    setSaving(true)
    const newVal = !enabled
    await supabase.from('business_settings').update({ mayorista_enabled: newVal }).eq('business_id', businessId)
    setEnabled(newVal)
    setSaving(false)
  }

  if (loading) return null

  return (
    <div style={{ background: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.875rem', padding: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#f1f5f9', marginBottom: '0.25rem' }}>
            Módulo Mayorista
          </div>
          <div style={{ fontSize: '0.8rem', color: '#64748b', lineHeight: 1.5 }}>
            Habilita la sección Mayorista en el menú lateral, permite gestionar precios mayoristas en el inventario y crear comprobantes con precios especiales.
          </div>
        </div>
        <button type="button" onClick={toggle} disabled={saving}
          style={{ width: 44, height: 24, borderRadius: 12, background: enabled ? '#6366f1' : 'rgba(255,255,255,0.12)', position: 'relative', border: 'none', cursor: 'pointer', flexShrink: 0, marginLeft: '1.5rem', transition: 'background 0.2s', opacity: saving ? 0.6 : 1 }}>
          <div style={{ position: 'absolute', top: 2, left: enabled ? 22 : 2, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
        </button>
      </div>
      {!enabled && (
        <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '0.5rem', fontSize: '0.75rem', color: '#f59e0b' }}>
          El módulo está desactivado. El menú "Mayorista" no será visible.
        </div>
      )}
    </div>
  )
}

export default function Settings() {
  const { businessId } = useAuth()
  const [searchParams]  = useSearchParams()
  const [activeTab, setActiveTab] = useState<TabType>(
    (searchParams.get('tab') as TabType) ?? 'datos'
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Datos generales
  const [businessSettings, setBusinessSettings] = useState<BusinessSettings>({
    nombre_comercial: '',
    razon_social: '',
    cuit: '',
    condicion_iva: 'Responsable Inscripto',
    domicilio_fiscal: '',
    localidad: '',
    provincia: '',
    codigo_postal: '',
    telefono: '',
    email: '',
    moneda_predeterminada: 'ARS',
    formato_fecha: 'DD/MM/YYYY',
    iva_por_defecto: 21,
    numeracion_comprobantes: '0001-00000001',
    observaciones_comprobantes: '',
    stock_negativo: false,
    alertas_bajo_stock: true,
    categoria_cliente_defecto: 'General',
    tipo_comprobante_defecto: 'Factura A'
  })

  // Puntos de venta
  const [salesPoints, setSalesPoints] = useState<SalesPoint[]>([])
  const [editingSalesPoint, setEditingSalesPoint] = useState<SalesPoint | null>(null)
  const [showSalesPointModal, setShowSalesPointModal] = useState(false)
  const [salesPointForm, setSalesPointForm] = useState<SalesPoint>({
    numero: 1,
    nombre: '',
    sucursal: '',
    domicilio: '',
    condicion_fiscal: 'Responsable Inscripto',
    activo: true,
    predeterminado: false,
    tipo_emision: 'manual'
  })

  // Configuración ARCA
  const [arcaConfig, setArcaConfig] = useState<ArcaConfig>({
    cuit: '',
    ambiente: 'homologacion',
    punto_venta: 1,
    web_service: 'wsfev1',
    alias: '',
    estado_conexion: 'desconectado'
  })
  const [testingConnection, setTestingConnection] = useState(false)
  const [syncingParameters, setSyncingParameters] = useState(false)
  const [generandoCSR, setGenerandoCSR] = useState(false)

  // Preferencias
  const [darkMode, setDarkMode] = useState(false)
  
  // Logo upload
  const [uploadingLogo, setUploadingLogo] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [businessId])

  const loadSettings = async () => {
    if (!businessId) return

    try {
      setLoading(true)

      // Cargar datos generales del negocio
      const { data: businessData } = await supabase
        .from('business_settings')
        .select('*')
        .eq('business_id', businessId)
        .single()

      if (businessData) {
        setBusinessSettings(businessData)
      }

      // Cargar puntos de venta (ignorar errores de permisos/tabla)
      try {
        const { data: pointsData, error: pointsError } = await supabase
          .from('sales_points')
          .select('*')
          .eq('business_id', businessId)

        if (!pointsError && pointsData) {
          setSalesPoints(pointsData)
        }
      } catch {
        // tabla no disponible aún
      }

      // Cargar configuración ARCA (ignorar errores de permisos/tabla)
      try {
        const { data: arcaData, error: arcaError } = await supabase
          .from('arca_config')
          .select('*')
          .eq('business_id', businessId)
          .single()

        if (!arcaError && arcaData) {
          setArcaConfig(arcaData)
        }
      } catch {
        // tabla no disponible aún
      }

    } catch (error) {
      console.error('Error loading settings:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveBusinessSettings = async () => {
    if (!businessId) return

    try {
      setSaving(true)

      // Extraemos solo los campos editables del negocio (sin id, business_id ni campos orden_*)
      const {
        id: _id,
        business_id: _bid,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ...fieldsToUpdate
      } = businessSettings as any

      const { error } = await supabase
        .from('business_settings')
        .upsert({ ...fieldsToUpdate, business_id: businessId }, { onConflict: 'business_id' })

      if (error) throw error

      alert('Configuración guardada exitosamente')
    } catch (err: any) {
      console.error('Error saving settings:', err)
      alert('Error al guardar la configuración: ' + (err?.message || JSON.stringify(err)))
    } finally {
      setSaving(false)
    }
  }

  const handleTestArcaConnection = async () => {
    if (!businessId) {
      alert('No hay negocio seleccionado')
      return
    }

    setTestingConnection(true)
    try {
      const result = await ArcaService.testConnection(businessId)
      
      if (result.success) {
        alert('✅ Conexión exitosa con ARCA\n\n' + 
              `Ambiente: ${result.details?.ambiente}\n` +
              `Puntos de venta: ${result.details?.puntosVenta?.join(', ') || 'N/A'}\n` +
              `Última sincronización: ${new Date(result.details?.ultimaSincronizacion || '').toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`)
        
        // Recargar configuración actualizada
        await loadSettings()
      } else {
        alert('❌ Error de conexión: ' + result.message)
      }
    } catch (error: any) {
      alert('❌ Error al probar conexión: ' + (error.message || 'Error desconocido'))
    } finally {
      setTestingConnection(false)
    }
  }

  const handleSyncParameters = async () => {
    if (!businessId) {
      alert('No hay negocio seleccionado')
      return
    }

    setSyncingParameters(true)
    try {
      const result = await ArcaService.sincronizarTodosParametros(businessId)
      
      if (result.success) {
        const detalles = []
        if (result.resultados?.tiposComprobante?.success) detalles.push('✓ Tipos de comprobante')
        if (result.resultados?.monedas?.success) detalles.push('✓ Monedas')
        if (result.resultados?.alicuotasIVA?.success) detalles.push('✓ Alícuotas IVA')
        
        alert('✅ Sincronización completada\n\n' + detalles.join('\n'))
      } else {
        alert('❌ Error al sincronizar: ' + result.error)
      }
    } catch (error: any) {
      alert('❌ Error al sincronizar: ' + (error.message || 'Error desconocido'))
    } finally {
      setSyncingParameters(false)
    }
  }

  const handleSaveArcaConfig = async () => {
    if (!businessId) return
    setSaving(true)
    try {
      const { data: existing } = await supabase
        .from('arca_config')
        .select('id')
        .eq('business_id', businessId)
        .maybeSingle()

      const payload: Record<string, any> = {
        business_id: businessId,
        cuit: arcaConfig.cuit || null,
        razon_social: arcaConfig.razon_social || null,
        ambiente: arcaConfig.ambiente,
        punto_venta: arcaConfig.punto_venta,
        web_service: arcaConfig.web_service || 'wsfev1',
        alias: arcaConfig.alias || null,
        cert_file: arcaConfig.cert_file?.trim() || null,
        // NO incluir private_key en el payload de guardar config:
        // la clave privada solo se actualiza al generar el CSR (generate-csr edge function).
        // Si se incluyera aquí, el estado stale de React pisaría la clave correcta en DB.
        expires_at: arcaConfig.expires_at || null,
        updated_at: new Date().toISOString(),
      }

      if (existing) {
        const { error } = await supabase
          .from('arca_config')
          .update(payload)
          .eq('business_id', businessId)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('arca_config')
          .insert({ ...payload, estado_conexion: 'desconectado' })
        if (error) throw error
      }

      alert('✅ Configuración ARCA guardada correctamente.')
    } catch (e: any) {
      alert('❌ Error al guardar: ' + (e.message || 'Error desconocido'))
    } finally {
      setSaving(false)
    }
  }

  const handleGenerarCSR = async () => {
    if (!businessId) return alert('No hay negocio seleccionado')
    const cuit = arcaConfig.cuit || businessSettings.cuit
    if (!cuit) return alert('Completá el CUIT emisor en la configuración de ARCA antes de generar el CSR.')
    const razon = businessSettings.razon_social || businessSettings.nombre_comercial
    if (!razon) return alert('Completá la Razón Social en los datos del negocio.')

    setGenerandoCSR(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Sin sesión activa')

      const res = await supabase.functions.invoke('generate-csr', {
        body: {
          business_id: businessId,
          razon_social: razon,
          cuit,
          provincia: businessSettings.provincia || 'Buenos Aires',
          localidad: businessSettings.localidad || '',
          email: businessSettings.email || '',
        },
      })

      if (res.error || !res.data?.success) {
        throw new Error(res.data?.error || res.error?.message || 'Error al generar CSR')
      }

      const csrPem: string = res.data.csr_pem

      // Descargar automáticamente
      const blob = new Blob([csrPem], { type: 'application/x-pem-file' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `csr_${cuit.replace(/\D/g, '')}_${new Date().toISOString().split('T')[0]}.csr`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      // Recargar arcaConfig desde DB para que la nueva clave privada quede en el estado
      // (si no se hace esto, "Guardar Configuración" pisa la nueva clave con la vieja)
      try {
        const { data: freshConfig } = await supabase
          .from('arca_config')
          .select('*')
          .eq('business_id', businessId)
          .single()
        if (freshConfig) setArcaConfig(freshConfig)
      } catch { /* ignorar */ }

      alert(
        '✅ CSR generado y descargado.\n\n' +
        'Pasos siguientes:\n' +
        '1. Ingresá a https://auth.afip.gob.ar/contribuyente con tu clave fiscal nivel 3.\n' +
        '2. Administrador de Relaciones → Crear Alias → Cargar el archivo .csr descargado.\n' +
        '3. AFIP te emitirá un certificado .crt — descargalo.\n' +
        '4. Volvé aquí y subí el certificado .crt en el campo "Certificado".'
      )
    } catch (e: any) {
      alert('❌ Error: ' + (e.message || 'Error desconocido al generar CSR'))
    } finally {
      setGenerandoCSR(false)
    }
  }

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0] || !businessId) return

    const file = e.target.files[0]

    try {
      setUploadingLogo(true)

      // Usar función que crea bucket automáticamente si no existe
      const publicUrl = await uploadBusinessLogo(file, businessId)

      // Actualizar business_settings con la URL del logo
      const { error: updateError } = await supabase
        .from('business_settings')
        .update({ logo_url: publicUrl })
        .eq('business_id', businessId)

      if (updateError) throw updateError

      // Actualizar estado local
      setBusinessSettings({ ...businessSettings, logo_url: publicUrl ?? undefined })

      alert('Logo actualizado exitosamente')
    } catch (error: any) {
      console.error('Error uploading logo:', error)
      alert('Error al subir el logo: ' + (error.message || 'Error desconocido'))
    } finally {
      setUploadingLogo(false)
    }
  }

  const handleLogoDelete = async () => {
    if (!businessId || !businessSettings.logo_url) return

    if (!confirm('¿Eliminar el logo actual?')) return

    try {
      setUploadingLogo(true)

      // Eliminar logo de business_settings
      const { error: updateError } = await supabase
        .from('business_settings')
        .update({ logo_url: null })
        .eq('business_id', businessId)

      if (updateError) throw updateError

      // Actualizar estado local
      setBusinessSettings({ ...businessSettings, logo_url: undefined })

      alert('Logo eliminado exitosamente')
    } catch (error: any) {
      console.error('Error deleting logo:', error)
      alert('Error al eliminar el logo: ' + (error.message || 'Error desconocido'))
    } finally {
      setUploadingLogo(false)
    }
  }

  const handleOpenSalesPointModal = (point?: SalesPoint) => {
    if (point) {
      setEditingSalesPoint(point)
      setSalesPointForm(point)
    } else {
      setEditingSalesPoint(null)
      setSalesPointForm({
        numero: salesPoints.length + 1,
        nombre: '',
        sucursal: '',
        domicilio: '',
        condicion_fiscal: 'Responsable Inscripto',
        activo: true,
        predeterminado: false,
        tipo_emision: 'manual'
      })
    }
    setShowSalesPointModal(true)
  }

  const handleCloseSalesPointModal = () => {
    setShowSalesPointModal(false)
    setEditingSalesPoint(null)
    setSalesPointForm({
      numero: 1,
      nombre: '',
      sucursal: '',
      domicilio: '',
      condicion_fiscal: 'Responsable Inscripto',
      activo: true,
      predeterminado: false,
      tipo_emision: 'manual'
    })
  }

  const handleSaveSalesPoint = async () => {
    if (!businessId) return

    try {
      if (editingSalesPoint) {
        // Actualizar
        const { error } = await supabase
          .from('sales_points')
          .update(salesPointForm)
          .eq('id', editingSalesPoint.id)

        if (error) {
          console.error('Error updating sales point:', error)
          alert(`Error al actualizar: ${error.message}\n\nAsegurate de ejecutar las migraciones SQL de sales_points en Supabase.`)
          return
        }
      } else {
        // Crear
        const { error } = await supabase
          .from('sales_points')
          .insert({
            ...salesPointForm,
            business_id: businessId
          })

        if (error) {
          console.error('Error creating sales point:', error)
          alert(`Error al crear: ${error.message}\n\nAsegurate de ejecutar las migraciones SQL de sales_points en Supabase.`)
          return
        }
      }

      await loadSettings()
      handleCloseSalesPointModal()
      alert(editingSalesPoint ? 'Punto de venta actualizado' : 'Punto de venta creado')
    } catch (error) {
      console.error('Error saving sales point:', error)
      alert('Error al guardar el punto de venta')
    }
  }

  const handleDeleteSalesPoint = async (point: SalesPoint) => {
    if (!confirm(`¿Eliminar el punto de venta "${point.nombre}"?`)) return

    try {
      const { error } = await supabase
        .from('sales_points')
        .delete()
        .eq('id', point.id)

      if (error) throw error

      await loadSettings()
      alert('Punto de venta eliminado')
    } catch (error) {
      console.error('Error deleting sales point:', error)
      alert('Error al eliminar el punto de venta')
    }
  }

  const tabs = [
    { id: 'datos' as TabType, label: 'Datos del Negocio', icon: Building2 },
    { id: 'puntos' as TabType, label: 'Puntos de Venta', icon: MapPin },
    { id: 'arca' as TabType, label: 'Integración ARCA', icon: Server },
    { id: 'preferencias' as TabType, label: 'Preferencias', icon: SettingsIcon },
    { id: 'seguridad' as TabType, label: 'Seguridad', icon: Shield },
    { id: 'orden' as TabType, label: 'Orden Impresa', icon: Printer },
    { id: 'comprobante' as TabType, label: 'Comprobantes', icon: FileText },
    { id: 'pagos' as TabType, label: 'Cobros y Pagos', icon: Shield },
    { id: 'comisiones' as TabType, label: 'Comisiones', icon: Bell },
  ]

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '4rem', color: 'var(--text-muted)', gap: '0.75rem' }}>
        <Loader2 size={22} style={{ animation: 'tr-spin 1s linear infinite' }} />
        Cargando configuración...
      </div>
    )
  }

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <div className="page-hdr">
          <div className="page-hdr-left">
            <div className="page-hdr-icon"><SettingsIcon size={22} /></div>
            <div>
              <h1 className="page-hdr-title">Configuración General</h1>
              <p className="page-hdr-subtitle">Administra los datos y preferencias del negocio</p>
            </div>
          </div>
        </div>

        {/* Tabs de navegación */}
        <div className="tabs" style={{ marginBottom: '2rem', flexWrap: 'wrap' }}>
          {tabs.map(tab => {
            const Icon = tab.icon
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`tab${activeTab === tab.id ? ' tab-active' : ''}`}>
                <Icon size={15} />
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* Contenido de las pestañas */}
        {activeTab === 'datos' && (
          <div className="surface-raised" style={{ padding: '2rem' }}>
            <h2 className="heading-md" style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Building2 size={22} style={{ color: 'var(--accent-primary)' }} />
              Datos Generales del Negocio
            </h2>

            {/* Sección de Logo */}
            <div style={{ marginBottom: '2rem', padding: '1.5rem', backgroundColor: '#0b1120', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.06)' }}>
              <h3 style={{ color: '#ffffff', fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                Logo del Negocio
              </h3>
              <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1rem' }}>
                El logo aparecerá en las órdenes de servicio y comprobantes impresos. Formatos aceptados: PNG, JPG, WEBP.
              </p>
              
              <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
                {businessSettings.logo_url ? (
                  <div style={{ position: 'relative' }}>
                    <img 
                      src={businessSettings.logo_url} 
                      alt="Logo del negocio" 
                      style={{
                        width: '150px',
                        height: '150px',
                        objectFit: 'contain',
                        backgroundColor: '#ffffff',
                        borderRadius: '0.5rem',
                        border: '1px solid rgba(51,65,85,0.6)'
                      }}
                    />
                    <button
                      onClick={handleLogoDelete}
                      disabled={uploadingLogo}
                      style={{
                        position: 'absolute',
                        top: '-8px',
                        right: '-8px',
                        width: '28px',
                        height: '28px',
                        borderRadius: '50%',
                        backgroundColor: '#ef4444',
                        border: '2px solid #0f1829',
                        color: '#ffffff',
                        cursor: uploadingLogo ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '14px',
                        fontWeight: 700
                      }}
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <div style={{
                    width: '150px',
                    height: '150px',
                    backgroundColor: 'rgba(15,23,42,0.8)',
                    borderRadius: '0.5rem',
                    border: '2px dashed rgba(51,65,85,0.6)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#64748b',
                    fontSize: '0.875rem'
                  }}>
                    Sin logo
                  </div>
                )}
                
                <div style={{ flex: 1 }}>
                  <input
                    type="file"
                    id="logo-upload"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={handleLogoUpload}
                    disabled={uploadingLogo}
                    style={{ display: 'none' }}
                  />
                  <label htmlFor="logo-upload" className="btn btn-primary btn-sm btn-lift" style={{ cursor: uploadingLogo ? 'not-allowed' : 'pointer' }}>
                    {uploadingLogo ? <Loader2 size={16} style={{ animation: 'tr-spin 1s linear infinite' }} /> : <Plus size={16} />}
                    {uploadingLogo ? 'Subiendo...' : businessSettings.logo_url ? 'Cambiar Logo' : 'Subir Logo'}
                  </label>
                  {businessSettings.logo_url && (
                    <button onClick={handleLogoDelete} disabled={uploadingLogo} className="btn btn-danger btn-sm" style={{ marginLeft: '0.5rem' }}>
                      <Trash2 size={16} />
                      Eliminar
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1.5rem' }}>
              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Nombre Comercial *</label>
                <input
                  type="text"
                  value={businessSettings.nombre_comercial}
                  onChange={(e) => setBusinessSettings({ ...businessSettings, nombre_comercial: e.target.value })}
                  className="form-control"
                />
              </div>

              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Razón Social *</label>
                <input
                  type="text"
                  value={businessSettings.razon_social}
                  onChange={(e) => setBusinessSettings({ ...businessSettings, razon_social: e.target.value })}
                  className="form-control"
                />
              </div>

              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>CUIT *</label>
                <input
                  type="text"
                  value={businessSettings.cuit}
                  onChange={(e) => setBusinessSettings({ ...businessSettings, cuit: e.target.value })}
                  placeholder="XX-XXXXXXXX-X"
                  className="form-control"
                />
              </div>

              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Condición frente al IVA *</label>
                <select
                  value={businessSettings.condicion_iva}
                  onChange={(e) => setBusinessSettings({ ...businessSettings, condicion_iva: e.target.value })}
                  className="form-control"
                >
                  <option value="Responsable Inscripto">Responsable Inscripto</option>
                  <option value="Responsable Monotributo">Responsable Monotributo</option>
                  <option value="Exento">Exento</option>
                  <option value="Monotributista Social">Monotributista Social</option>
                  <option value="Consumidor Final">Consumidor Final</option>
                </select>
              </div>

              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Domicilio Fiscal *</label>
                <input
                  type="text"
                  value={businessSettings.domicilio_fiscal}
                  onChange={(e) => setBusinessSettings({ ...businessSettings, domicilio_fiscal: e.target.value })}
                  className="form-control"
                />
              </div>

              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Localidad *</label>
                <input
                  type="text"
                  value={businessSettings.localidad}
                  onChange={(e) => setBusinessSettings({ ...businessSettings, localidad: e.target.value })}
                  className="form-control"
                />
              </div>

              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Provincia *</label>
                <input
                  type="text"
                  value={businessSettings.provincia}
                  onChange={(e) => setBusinessSettings({ ...businessSettings, provincia: e.target.value })}
                  className="form-control"
                />
              </div>

              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Código Postal *</label>
                <input
                  type="text"
                  value={businessSettings.codigo_postal}
                  onChange={(e) => setBusinessSettings({ ...businessSettings, codigo_postal: e.target.value })}
                  className="form-control"
                />
              </div>

              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Teléfono</label>
                <input
                  type="text"
                  value={businessSettings.telefono}
                  onChange={(e) => setBusinessSettings({ ...businessSettings, telefono: e.target.value })}
                  className="form-control"
                />
              </div>

              <div>
                <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Email</label>
                <input
                  type="email"
                  value={businessSettings.email}
                  onChange={(e) => setBusinessSettings({ ...businessSettings, email: e.target.value })}
                  className="form-control"
                />
              </div>
            </div>

            <div style={{ marginTop: '1.5rem' }}>
              <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Observaciones de Comprobantes</label>
              <textarea
                value={businessSettings.observaciones_comprobantes}
                onChange={(e) => setBusinessSettings({ ...businessSettings, observaciones_comprobantes: e.target.value })}
                style={{
                  width: '100%',
                  padding: '0.625rem 0.75rem',
                  backgroundColor: 'rgba(15,23,42,0.8)',
                  border: '1px solid rgba(51,65,85,0.6)',
                  borderRadius: '0.5rem',
                  color: '#f1f5f9',
                  outline: 'none',
                  minHeight: '80px'
                }}
                placeholder="Texto que aparecerá en los comprobantes..."
              />
            </div>

            <div style={{ marginTop: '2rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={handleSaveBusinessSettings}
                disabled={saving}
                className="btn btn-primary btn-lift"
              >
                <Save size={18} />
                {saving ? 'Guardando...' : 'Guardar Cambios'}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'puntos' && (
          <div className="surface-raised" style={{ padding: '2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h2 style={{ color: '#ffffff', fontSize: '1.25rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.75rem', margin: 0 }}>
                <MapPin size={24} style={{ color: '#6366f1' }} />
                Puntos de Venta
              </h2>
              <button
                onClick={() => handleOpenSalesPointModal()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.625rem 1.25rem',
                  background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.625rem',
                  cursor: 'pointer',
                  fontWeight: 600,
                  boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
                }}
              >
                <Plus size={18} />
                Nuevo Punto de Venta
              </button>
            </div>

            {salesPoints.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>
                <MapPin size={48} style={{ marginBottom: '1rem', opacity: 0.5 }} />
                <p>No hay puntos de venta configurados</p>
                <p style={{ fontSize: '0.875rem', marginTop: '0.5rem' }}>Agrega tu primer punto de venta para comenzar</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '1rem' }}>
                {salesPoints.map((point) => (
                  <div key={point.id} style={{ 
                    padding: '1.25rem', 
                    backgroundColor: '#0b1120',
                    borderRadius: '0.5rem',
                    border: '1px solid rgba(255,255,255,0.06)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                        <span style={{ color: '#ffffff', fontWeight: 600, fontSize: '1rem' }}>{point.nombre}</span>
                        <span style={{ 
                          padding: '0.25rem 0.75rem', 
                          backgroundColor: point.activo ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                          color: point.activo ? '#10b981' : '#ef4444',
                          borderRadius: '1rem',
                          fontSize: '0.75rem',
                          fontWeight: 500
                        }}>
                          {point.activo ? 'Activo' : 'Inactivo'}
                        </span>
                        {point.predeterminado && (
                          <span style={{ 
                            padding: '0.25rem 0.75rem', 
                            backgroundColor: 'rgba(99, 102, 241, 0.1)',
                            color: '#6366f1',
                            borderRadius: '1rem',
                            fontSize: '0.75rem',
                            fontWeight: 500
                          }}>
                            Predeterminado
                          </span>
                        )}
                      </div>
                      <p style={{ color: '#94a3b8', fontSize: '0.875rem', margin: 0 }}>
                        Punto de Venta: {point.numero} · Sucursal: {point.sucursal}
                      </p>
                      <p style={{ color: '#64748b', fontSize: '0.875rem', margin: '0.25rem 0 0 0' }}>
                        {point.domicilio}
                      </p>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        onClick={() => handleOpenSalesPointModal(point)}
                        style={{
                          padding: '0.5rem',
                          backgroundColor: 'rgba(99, 102, 241, 0.1)',
                          border: '1px solid rgba(99, 102, 241, 0.2)',
                          color: '#6366f1',
                          borderRadius: '0.375rem',
                          cursor: 'pointer'
                        }}
                      >
                        <Edit size={16} />
                      </button>
                      <button
                        onClick={() => handleDeleteSalesPoint(point)}
                        style={{
                          padding: '0.5rem',
                          backgroundColor: 'rgba(239, 68, 68, 0.1)',
                          border: '1px solid rgba(239, 68, 68, 0.2)',
                          color: '#ef4444',
                          borderRadius: '0.375rem',
                          cursor: 'pointer'
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'arca' && (
          <div className="surface-raised" style={{ padding: '2rem' }}>
            <h2 style={{ color: '#ffffff', fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Server size={24} style={{ color: '#6366f1' }} />
              Integración ARCA / AFIP
            </h2>

            {/* Banner de estado por etapa */}
            {arcaConfig.estado_conexion === 'csr_generado' && !arcaConfig.cert_file && (
              <div style={{ marginBottom: '1.5rem', padding: '1rem 1.25rem', backgroundColor: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.35)', borderRadius: '0.625rem' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                  <AlertTriangle size={18} style={{ color: '#fbbf24', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <p style={{ margin: '0 0 0.4rem', color: '#fbbf24', fontWeight: 700, fontSize: '0.9rem' }}>
                      CSR generado — completá el proceso antes de salir de esta pantalla
                    </p>
                    <p style={{ margin: 0, color: '#d1a740', fontSize: '0.82rem', lineHeight: 1.6 }}>
                      <strong>1.</strong> Subí el archivo <code style={{ background: 'rgba(0,0,0,0.3)', padding: '0 4px', borderRadius: 3 }}>.csr</code> descargado a AFIP → Administrador de Relaciones de Clave Fiscal → Crear alias.<br />
                      <strong>2.</strong> En AFIP, autorizá el alias para el servicio <strong>"Facturación Electrónica"</strong> (wsfe).<br />
                      <strong>3.</strong> Descargá el <code style={{ background: 'rgba(0,0,0,0.3)', padding: '0 4px', borderRadius: 3 }}>.crt</code> que AFIP te emite y pegalo en el campo de abajo.<br />
                      <strong>4.</strong> Hacé clic en <strong>"Guardar Configuración"</strong>.<br />
                      <strong style={{ color: '#f87171' }}>⚠️ No vuelvas a hacer clic en "Generar CSR" hasta terminar — genera una nueva clave y el certificado anterior quedará inválido.</strong>
                    </p>
                  </div>
                </div>
              </div>
            )}

            {arcaConfig.estado_conexion === 'error' && arcaConfig.ultimo_error && (
              <div style={{ marginBottom: '1.5rem', padding: '1rem 1.25rem', backgroundColor: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '0.625rem' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                  <XCircle size={18} style={{ color: '#f87171', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <p style={{ margin: '0 0 0.3rem', color: '#f87171', fontWeight: 700, fontSize: '0.875rem' }}>Error de conexión AFIP</p>
                    <p style={{ margin: 0, color: '#fca5a5', fontSize: '0.8rem', lineHeight: 1.5, fontFamily: 'monospace', wordBreak: 'break-word' }}>
                      {arcaConfig.ultimo_error}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {arcaConfig.estado_conexion === 'conectado' && (
              <div style={{ marginBottom: '1.5rem', padding: '0.875rem 1.25rem', backgroundColor: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: '0.625rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <CheckCircle size={18} style={{ color: '#34d399' }} />
                <p style={{ margin: 0, color: '#34d399', fontWeight: 600, fontSize: '0.875rem' }}>
                  Conexión activa con AFIP — podés emitir comprobantes electrónicos
                </p>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>
              {/* Panel izquierdo - Estado */}
              <div style={{ backgroundColor: '#0b1120', borderRadius: '0.5rem', padding: '1.5rem', border: '1px solid rgba(255,255,255,0.06)' }}>
                <h3 style={{ color: '#ffffff', fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>Estado de Conexión</h3>
                
                <div style={{ marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Estado:</span>
                    <span style={{ 
                      color: arcaConfig.estado_conexion === 'conectado' ? '#10b981' : '#ef4444',
                      fontWeight: 500,
                      fontSize: '0.875rem'
                    }}>
                      {arcaConfig.estado_conexion === 'conectado' ? 'Conectado' : 'Desconectado'}
                    </span>
                  </div>
                  {arcaConfig.estado_conexion === 'conectado' && <CheckCircle size={16} style={{ color: '#10b981' }} />}
                  {arcaConfig.estado_conexion !== 'conectado' && <XCircle size={16} style={{ color: '#ef4444' }} />}
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Ambiente:</span>
                  <span style={{ color: '#ffffff', fontWeight: 500, fontSize: '0.875rem', marginLeft: '0.5rem' }}>
                    {arcaConfig.ambiente === 'homologacion' ? 'Homologación' : 'Producción'}
                  </span>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Punto de Venta:</span>
                  <span style={{ color: '#ffffff', fontWeight: 500, fontSize: '0.875rem', marginLeft: '0.5rem' }}>
                    {arcaConfig.punto_venta}
                  </span>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Certificado:</span>
                  <span style={{ color: '#ffffff', fontWeight: 500, fontSize: '0.875rem', marginLeft: '0.5rem' }}>
                    {arcaConfig.cert_file ? '✓ Cargado' : 'No cargado'}
                  </span>
                </div>

                {arcaConfig.expires_at && (
                  <div style={{ marginBottom: '1rem' }}>
                    <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Vencimiento:</span>
                    <span style={{ color: '#ffffff', fontWeight: 500, fontSize: '0.875rem', marginLeft: '0.5rem' }}>
                      {new Date(arcaConfig.expires_at).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: 'short', year: 'numeric' })}
                    </span>
                  </div>
                )}

                {!arcaConfig.cert_file && !arcaConfig.pfx_file && (
                  <p style={{ fontSize: '0.75rem', color: '#f59e0b', margin: '0.5rem 0 0 0' }}>
                    ⚠️ Cargá un certificado .crt para probar la conexión
                  </p>
                )}
                <button
                  onClick={handleTestArcaConnection}
                  disabled={testingConnection || (!arcaConfig.cert_file && !arcaConfig.pfx_file)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.5rem',
                    padding: '0.75rem',
                    backgroundColor: (!arcaConfig.cert_file && !arcaConfig.pfx_file) ? '#374151' : testingConnection ? '#059669' : '#10b981',
                    border: 'none',
                    color: '#ffffff',
                    borderRadius: '0.5rem',
                    cursor: (testingConnection || (!arcaConfig.cert_file && !arcaConfig.pfx_file)) ? 'not-allowed' : 'pointer',
                    fontWeight: 500,
                    marginTop: '0.5rem',
                    opacity: (!arcaConfig.cert_file && !arcaConfig.pfx_file) ? 0.5 : testingConnection ? 0.8 : 1
                  }}
                >
                  {testingConnection ? <Loader2 size={18} className="spin" /> : <CheckCircle size={18} />}
                  {testingConnection ? 'Probando...' : 'Probar Conexión'}
                </button>
              </div>

              {/* Panel derecho - Configuración */}
              <div style={{ backgroundColor: '#0b1120', borderRadius: '0.5rem', padding: '1.5rem', border: '1px solid rgba(255,255,255,0.06)' }}>
                <h3 style={{ color: '#ffffff', fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>Configuración</h3>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
                  <div>
                    <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>CUIT Emisor *</label>
                    <input
                      type="text"
                      value={arcaConfig.cuit || ''}
                      onChange={(e) => setArcaConfig({ ...arcaConfig, cuit: e.target.value })}
                      placeholder="XX-XXXXXXXX-X"
                      className="form-control"
                    />
                  </div>

                  <div>
                    <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Ambiente *</label>
                    <select
                      value={arcaConfig.ambiente}
                      onChange={(e) => setArcaConfig({ ...arcaConfig, ambiente: e.target.value as 'homologacion' | 'produccion' })}
                      className="form-control"
                    >
                      <option value="homologacion">Homologación (Testing)</option>
                      <option value="produccion">Producción</option>
                    </select>
                  </div>

                  <div>
                    <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Punto de Venta *</label>
                    <input
                      type="number"
                      value={arcaConfig.punto_venta}
                      onChange={(e) => setArcaConfig({ ...arcaConfig, punto_venta: parseInt(e.target.value) || 1 })}
                      className="form-control"
                    />
                  </div>

                  <div>
                    <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Web Service</label>
                    <select
                      value={arcaConfig.web_service}
                      onChange={(e) => setArcaConfig({ ...arcaConfig, web_service: e.target.value })}
                      className="form-control"
                    >
                      <option value="wsfev1">WSFEv1 (Factura Electrónica)</option>
                      <option value="wsbfe">WSBFE (Bono Fiscal)</option>
                    </select>
                  </div>
                </div>

                <div style={{ marginTop: '1rem' }}>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Alias del Certificado</label>
                  <input
                    type="text"
                    value={arcaConfig.alias || ''}
                    onChange={(e) => setArcaConfig({ ...arcaConfig, alias: e.target.value })}
                    placeholder="Ej: Certificado Producción 2024"
                    className="form-control"
                  />
                </div>

                <div style={{ marginTop: '1.5rem', padding: '1rem', backgroundColor: 'rgba(99, 102, 241, 0.05)', borderRadius: '0.5rem', border: '1px solid rgba(99, 102, 241, 0.1)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <AlertTriangle size={16} style={{ color: '#f59e0b' }} />
                    <span style={{ color: '#f59e0b', fontWeight: 500, fontSize: '0.875rem' }}>Certificado Digital</span>
                  </div>
                  <p style={{ color: '#94a3b8', fontSize: '0.875rem', margin: '0 0 0.5rem 0' }}>
                    Generá un CSR (Certificate Signing Request) y presentalo ante AFIP para obtener tu certificado. Luego pegá el .crt en el campo de abajo.
                  </p>
                  {arcaConfig.cert_file && (
                    <p style={{ color: '#f87171', fontSize: '0.78rem', margin: '0 0 0.75rem 0', lineHeight: 1.5 }}>
                      ⚠️ <strong>Ya tenés un certificado cargado.</strong> Si generás un nuevo CSR, la clave privada cambia y el certificado actual queda inválido — tendrás que pedir uno nuevo a AFIP.
                    </p>
                  )}
                  {!arcaConfig.cert_file && (
                    <p style={{ color: '#64748b', fontSize: '0.78rem', margin: '0 0 0.75rem 0', lineHeight: 1.5 }}>
                      Una vez generado el CSR, <strong style={{ color: '#fbbf24' }}>no vuelvas a hacer clic aquí</strong> hasta haber completado todo el proceso con AFIP y guardado el .crt.
                    </p>
                  )}
                  <button
                    onClick={handleGenerarCSR}
                    disabled={generandoCSR}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                      padding: '0.5rem 1rem',
                      backgroundColor: generandoCSR ? 'rgba(99,102,241,0.5)' : 'rgba(99,102,241,0.15)',
                      border: '1px solid rgba(99,102,241,0.4)',
                      borderRadius: '0.5rem',
                      color: '#818cf8',
                      cursor: generandoCSR ? 'not-allowed' : 'pointer',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                    }}
                  >
                    {generandoCSR
                      ? <><Loader2 size={15} style={{ animation: 'tr-spin 1s linear infinite' }} /> Generando CSR...</>
                      : <><FileText size={15} /> Generar CSR para AFIP</>
                    }
                  </button>
                </div>

                {/* Campo certificado .crt */}
                <div style={{ marginTop: '1.25rem' }}>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>
                    Certificado (.crt) emitido por AFIP
                  </label>
                  <textarea
                    value={arcaConfig.cert_file || ''}
                    onChange={(e) => setArcaConfig({ ...arcaConfig, cert_file: e.target.value })}
                    placeholder={'-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----'}
                    rows={5}
                    style={{
                      width: '100%',
                      padding: '0.625rem 0.75rem',
                      backgroundColor: 'rgba(15,23,42,0.8)',
                      border: arcaConfig.cert_file ? '1px solid rgba(52,211,153,0.4)' : '1px solid rgba(51,65,85,0.6)',
                      borderRadius: '0.5rem',
                      color: '#f1f5f9',
                      outline: 'none',
                      fontFamily: 'monospace',
                      fontSize: '0.75rem',
                      resize: 'vertical',
                      boxSizing: 'border-box',
                    }}
                  />
                  <p style={{ margin: '0.3rem 0 0', fontSize: '0.75rem', color: '#64748b' }}>
                    Abrí el archivo .crt con el Bloc de Notas, seleccioná todo (Ctrl+A) y pegalo acá.
                    {arcaConfig.cert_file && <span style={{ color: '#34d399', marginLeft: '0.5rem' }}>✓ Certificado cargado</span>}
                  </p>
                </div>

                <div style={{ marginTop: '1.5rem', display: 'flex', gap: '1rem' }}>
                  <button
                    onClick={handleSaveArcaConfig}
                    disabled={saving}
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.5rem',
                      padding: '0.75rem',
                      background: saving ? 'rgba(99,102,241,0.5)' : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                      border: 'none',
                      color: '#ffffff',
                      borderRadius: '0.625rem',
                      cursor: saving ? 'not-allowed' : 'pointer',
                      fontWeight: 600,
                      boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
                    }}
                  >
                    {saving ? <Loader2 size={18} style={{ animation: 'tr-spin 1s linear infinite' }} /> : <Save size={18} />}
                    {saving ? 'Guardando...' : 'Guardar Configuración'}
                  </button>
                  <button
                    onClick={handleSyncParameters}
                    disabled={syncingParameters}
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.5rem',
                      padding: '0.75rem',
                      backgroundColor: syncingParameters ? '#059669' : '#10b981',
                      border: 'none',
                      color: '#ffffff',
                      borderRadius: '0.5rem',
                      cursor: syncingParameters ? 'not-allowed' : 'pointer',
                      fontWeight: 500,
                      opacity: syncingParameters ? 0.8 : 1
                    }}
                  >
                    {syncingParameters ? <Loader2 size={18} className="spin" /> : <RefreshCw size={18} />}
                    {syncingParameters ? 'Sincronizando...' : 'Sincronizar Parámetros'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'preferencias' && (
          <div className="surface-raised" style={{ padding: '2rem' }}>
            <h2 className="heading-md" style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <SettingsIcon size={24} style={{ color: '#6366f1' }} />
              Preferencias del Sistema
            </h2>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '2rem' }}>
              <div>
                <h3 style={{ color: '#ffffff', fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>Opciones Globales</h3>
                
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={businessSettings.stock_negativo}
                      onChange={(e) => setBusinessSettings({ ...businessSettings, stock_negativo: e.target.checked })}
                      style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: '0.875rem', color: '#e2e8f0', fontWeight: 500 }}>Permitir Stock Negativo</span>
                  </label>
                  <p style={{ fontSize: '0.75rem', color: '#94a3b8', margin: '0.5rem 0 0 0', marginLeft: '2.5rem' }}>
                    Permite vender productos incluso cuando no hay stock disponible
                  </p>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={businessSettings.alertas_bajo_stock}
                      onChange={(e) => setBusinessSettings({ ...businessSettings, alertas_bajo_stock: e.target.checked })}
                      style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: '0.875rem', color: '#e2e8f0', fontWeight: 500 }}>Activar Alertas de Bajo Stock</span>
                  </label>
                  <p style={{ fontSize: '0.75rem', color: '#94a3b8', margin: '0.5rem 0 0 0', marginLeft: '2.5rem' }}>
                    Muestra notificaciones cuando el stock de un producto es bajo
                  </p>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={darkMode}
                      onChange={(e) => setDarkMode(e.target.checked)}
                      style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: '0.875rem', color: '#e2e8f0', fontWeight: 500 }}>Modo Oscuro</span>
                  </label>
                  <p style={{ fontSize: '0.75rem', color: '#94a3b8', margin: '0.5rem 0 0 0', marginLeft: '2.5rem' }}>
                    Activa el tema oscuro en toda la aplicación
                  </p>
                </div>
              </div>

              <div>
                <h3 style={{ color: '#ffffff', fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>Valores por Defecto</h3>

                <div style={{ marginBottom: '1rem' }}>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Moneda Predeterminada</label>
                  <select
                    value={businessSettings.moneda_predeterminada}
                    onChange={(e) => setBusinessSettings({ ...businessSettings, moneda_predeterminada: e.target.value })}
                    className="form-control"
                  >
                    <option value="ARS">Pesos Argentinos (ARS)</option>
                    <option value="USD">Dólares (USD)</option>
                    <option value="EUR">Euros (EUR)</option>
                  </select>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Formato de Fecha</label>
                  <select
                    value={businessSettings.formato_fecha}
                    onChange={(e) => setBusinessSettings({ ...businessSettings, formato_fecha: e.target.value })}
                    className="form-control"
                  >
                    <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                    <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                    <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                  </select>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Porcentaje de IVA por Defecto</label>
                  <input
                    type="number"
                    value={businessSettings.iva_por_defecto}
                    onChange={(e) => setBusinessSettings({ ...businessSettings, iva_por_defecto: parseFloat(e.target.value) || 0 })}
                    className="form-control"
                  />
                </div>
              </div>
            </div>

            <div style={{ marginTop: '2rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={handleSaveBusinessSettings}
                disabled={saving}
                className="btn btn-primary btn-lift"
              >
                <Save size={18} />
                {saving ? 'Guardando...' : 'Guardar Cambios'}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'seguridad' && (
          <div className="surface-raised" style={{ padding: '2rem' }}>
            <h2 className="heading-md" style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Shield size={24} style={{ color: '#6366f1' }} />
              Seguridad y Permisos
            </h2>

            <div style={{ padding: '1.5rem', backgroundColor: '#0b1120', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                <Shield size={20} style={{ color: '#6366f1' }} />
                <span style={{ color: '#ffffff', fontWeight: 600, fontSize: '1rem' }}>Cifrado de Datos Sensibles</span>
              </div>
              <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1rem' }}>
                Los certificados digitales, claves privadas y contraseñas se almacenan cifrados en la base de datos.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <CheckCircle size={16} style={{ color: '#10b981' }} />
                <span style={{ color: '#10b981', fontSize: '0.875rem', fontWeight: 500 }}>Certificados cifrados con AES-256</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle size={16} style={{ color: '#10b981' }} />
                <span style={{ color: '#10b981', fontSize: '0.875rem', fontWeight: 500 }}>Acceso restringido a administradores</span>
              </div>
            </div>

            <div style={{ marginTop: '1.5rem', padding: '1.5rem', backgroundColor: '#0b1120', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                <Bell size={20} style={{ color: '#f59e0b' }} />
                <span style={{ color: '#ffffff', fontWeight: 600, fontSize: '1rem' }}>Alertas de Vencimiento</span>
              </div>
              <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1rem' }}>
                El sistema te notificará cuando un certificado digital esté por vencer.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <AlertTriangle size={16} style={{ color: '#f59e0b' }} />
                <span style={{ color: '#f59e0b', fontSize: '0.875rem', fontWeight: 500 }}>Alerta 30 días antes del vencimiento</span>
              </div>
            </div>

            <div style={{ marginTop: '1.5rem', padding: '1.5rem', backgroundColor: '#0b1120', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                <FileText size={20} style={{ color: '#6366f1' }} />
                <span style={{ color: '#ffffff', fontWeight: 600, fontSize: '1rem' }}>Auditoría</span>
              </div>
              <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1rem' }}>
                Todas las acciones de configuración se registran en el log de auditoría.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle size={16} style={{ color: '#10b981' }} />
                <span style={{ color: '#10b981', fontSize: '0.875rem', fontWeight: 500 }}>Log de acciones de configuración</span>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'orden' && (
          <div className="surface-raised" style={{ padding: '2rem' }}>
            <OrderPrintSettings />
          </div>
        )}

        {activeTab === 'comprobante' && (
          <div className="card" style={{ padding: '2rem' }}>
            <ComprobantePrintSettings />
          </div>
        )}

        {activeTab === 'pagos' && (
          <div style={{ maxWidth: '860px' }}>
            <div style={{ marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#f1f5f9', margin: 0 }}>
                Cobros y Pagos
              </h2>
              <p style={{ fontSize: '0.875rem', color: '#64748b', marginTop: '0.375rem' }}>
                Configurá los métodos de cobro que aparecen en cada comprobante.
              </p>
            </div>
            <PaymentMethodSettings />
          </div>
        )}

        {activeTab === 'comisiones' && (
          <div style={{ maxWidth: '680px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Toggle módulo mayorista */}
            <MayoristaToggle />
            <CommissionSettings />
          </div>
        )}

        {/* Modal para crear/editar punto de venta */}
        {showSalesPointModal && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem'
          }}>
            <div style={{
              backgroundColor: '#0b1220',
              borderRadius: '1rem',
              width: '100%',
              maxWidth: '500px',
              maxHeight: '90vh',
              overflow: 'auto',
              border: '1px solid rgba(255,255,255,0.06)'
            }}>
              <div style={{ padding: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ color: '#ffffff', margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>
                  {editingSalesPoint ? 'Editar Punto de Venta' : 'Nuevo Punto de Venta'}
                </h3>
                <button onClick={handleCloseSalesPointModal} style={{ backgroundColor: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '0.5rem' }}>
                  <X size={24} />
                </button>
              </div>

              <div style={{ padding: '1.5rem' }}>
                <div style={{ marginBottom: '1rem' }}>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Número *</label>
                  <input
                    type="number"
                    value={salesPointForm.numero}
                    onChange={(e) => setSalesPointForm({ ...salesPointForm, numero: parseInt(e.target.value) || 1 })}
                    className="form-control"
                  />
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Nombre *</label>
                  <input
                    type="text"
                    value={salesPointForm.nombre}
                    onChange={(e) => setSalesPointForm({ ...salesPointForm, nombre: e.target.value })}
                    placeholder="Ej: Sucursal Centro"
                    className="form-control"
                  />
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Sucursal *</label>
                  <input
                    type="text"
                    value={salesPointForm.sucursal}
                    onChange={(e) => setSalesPointForm({ ...salesPointForm, sucursal: e.target.value })}
                    placeholder="Ej: Centro"
                    className="form-control"
                  />
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Domicilio</label>
                  <input
                    type="text"
                    value={salesPointForm.domicilio}
                    onChange={(e) => setSalesPointForm({ ...salesPointForm, domicilio: e.target.value })}
                    placeholder="Dirección física"
                    className="form-control"
                  />
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Condición Fiscal</label>
                  <select
                    value={salesPointForm.condicion_fiscal}
                    onChange={(e) => setSalesPointForm({ ...salesPointForm, condicion_fiscal: e.target.value })}
                    className="form-control"
                  >
                    <option value="Responsable Inscripto">Responsable Inscripto</option>
                    <option value="Responsable Monotributo">Responsable Monotributo</option>
                    <option value="Exento">Exento</option>
                    <option value="Monotributista Social">Monotributista Social</option>
                    <option value="Consumidor Final">Consumidor Final</option>
                  </select>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Tipo de Emisión</label>
                  <select
                    value={salesPointForm.tipo_emision}
                    onChange={(e) => setSalesPointForm({ ...salesPointForm, tipo_emision: e.target.value as 'manual' | 'electronica' | 'ambas' })}
                    className="form-control"
                  >
                    <option value="manual">Manual</option>
                    <option value="electronica">Electrónica ARCA</option>
                    <option value="ambas">Ambas</option>
                  </select>
                </div>

                <div style={{ marginBottom: '1.5rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer', marginBottom: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={salesPointForm.activo}
                      onChange={(e) => setSalesPointForm({ ...salesPointForm, activo: e.target.checked })}
                      style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: '0.875rem', color: '#e2e8f0', fontWeight: 500 }}>Activo</span>
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={salesPointForm.predeterminado}
                      onChange={(e) => setSalesPointForm({ ...salesPointForm, predeterminado: e.target.checked })}
                      style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: '0.875rem', color: '#e2e8f0', fontWeight: 500 }}>Predeterminado</span>
                  </label>
                </div>

                <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                  <button
                    onClick={handleCloseSalesPointModal}
                    style={{
                      padding: '0.75rem 1.5rem',
                      backgroundColor: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: '#94a3b8',
                      borderRadius: '0.5rem',
                      cursor: 'pointer',
                      fontWeight: 500
                    }}
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleSaveSalesPoint}
                    style={{
                      padding: '0.75rem 1.5rem',
                      background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                      border: 'none',
                      color: '#ffffff',
                      borderRadius: '0.625rem',
                      cursor: 'pointer',
                      fontWeight: 600,
                      boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
                    }}
                  >
                    {editingSalesPoint ? 'Actualizar' : 'Crear'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
  )
}
