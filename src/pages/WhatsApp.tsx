import React, { useState } from 'react'
import {
  MessageSquare,
  Save,
  RefreshCw,
  Loader2,
  AlertTriangle,
  ToggleLeft,
  ToggleRight,
  Send,
  ExternalLink,
  Info,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useWhatsAppConnection } from '../hooks/useWhatsAppConnection'
import { WhatsAppStatusBadge } from '../components/whatsapp/WhatsAppStatusBadge'
import { WhatsAppConnectButton } from '../components/whatsapp/WhatsAppConnectButton'
import { WhatsAppConnectionCard } from '../components/whatsapp/WhatsAppConnectionCard'
import { WhatsAppTestMessageModal } from '../components/whatsapp/WhatsAppTestMessageModal'
import type { WhatsAppAutomationSettings } from '../services/whatsappCloudService'

// ──────────────────────────────────────────────────────────────
// Tipos locales
// ──────────────────────────────────────────────────────────────

type AutomationToggleKey =
  | 'enabled'
  | 'send_on_received'
  | 'send_on_diagnosis'
  | 'send_on_repair'
  | 'send_on_ready'
  | 'send_on_delivered'

interface AutomationToggleItem {
  key: AutomationToggleKey
  label: string
  description: string
}

// ──────────────────────────────────────────────────────────────
// Configuración de los toggles de automatización
// ──────────────────────────────────────────────────────────────

const AUTOMATION_TOGGLES: AutomationToggleItem[] = [
  {
    key:         'enabled',
    label:       'Automatización activa',
    description: 'Habilita o deshabilita todos los mensajes automáticos',
  },
  {
    key:         'send_on_received',
    label:       'Al recibir el equipo',
    description: 'Envía un mensaje cuando se crea la orden y se recibe el equipo',
  },
  {
    key:         'send_on_diagnosis',
    label:       'Al iniciar diagnóstico',
    description: 'Notifica al cliente cuando el equipo entra en revisión',
  },
  {
    key:         'send_on_repair',
    label:       'Al iniciar reparación',
    description: 'Avisa cuando el técnico comienza a reparar el equipo',
  },
  {
    key:         'send_on_ready',
    label:       'Listo para retirar',
    description: 'Notifica cuando el equipo está reparado y disponible para buscar',
  },
  {
    key:         'send_on_delivered',
    label:       'Al entregar el equipo',
    description: 'Envía un mensaje de cierre cuando el cliente retira el equipo',
  },
]

// ──────────────────────────────────────────────────────────────
// Valores por defecto para la configuración de automatización
// ──────────────────────────────────────────────────────────────

const DEFAULT_AUTOMATION: Pick<
  WhatsAppAutomationSettings,
  | 'enabled'
  | 'send_on_received'
  | 'send_on_diagnosis'
  | 'send_on_repair'
  | 'send_on_ready'
  | 'send_on_delivered'
> = {
  enabled:          false,
  send_on_received: false,
  send_on_diagnosis: false,
  send_on_repair:   false,
  send_on_ready:    true,   // por defecto solo se avisa cuando está listo
  send_on_delivered: false,
}

// ──────────────────────────────────────────────────────────────
// Sub-componente: Toggle de configuración
// ──────────────────────────────────────────────────────────────

interface ToggleRowProps {
  item: AutomationToggleItem
  checked: boolean
  disabled?: boolean
  onChange: (key: AutomationToggleKey, value: boolean) => void
}

function ToggleRow({ item, checked, disabled = false, onChange }: ToggleRowProps) {
  return (
    <div
      style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        padding:        '14px 0',
        borderBottom:   '1px solid rgba(255,255,255,0.05)',
        opacity:        disabled ? 0.5 : 1,
        transition:     'opacity 0.2s',
      }}
    >
      <div style={{ flex: 1, paddingRight: 16 }}>
        <div
          style={{
            fontSize:   14,
            fontWeight: 500,
            color:      'var(--text-primary)',
            marginBottom: 3,
          }}
        >
          {item.label}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
          {item.description}
        </div>
      </div>

      <button
        onClick={() => !disabled && onChange(item.key, !checked)}
        disabled={disabled}
        style={{
          background: 'none',
          border:     'none',
          cursor:     disabled ? 'not-allowed' : 'pointer',
          padding:    0,
          color:      checked ? '#25D366' : 'rgba(255,255,255,0.25)',
          transition: 'color 0.2s',
          flexShrink: 0,
        }}
        aria-label={checked ? 'Desactivar' : 'Activar'}
        title={checked ? 'Desactivar' : 'Activar'}
      >
        {checked ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
      </button>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Skeleton de carga
// ──────────────────────────────────────────────────────────────

function SkeletonBlock({ width = '100%', height = 16, borderRadius = 6, mb = 0 }: {
  width?: string | number
  height?: number
  borderRadius?: number
  mb?: number
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius,
        marginBottom:    mb,
        backgroundColor: 'rgba(255,255,255,0.06)',
        animation:       'skeleton-shimmer 1.5s ease-in-out infinite',
      }}
    />
  )
}

function PageSkeleton() {
  return (
    <div style={{ padding: '32px 24px' }}>
      <style>{`
        @keyframes skeleton-shimmer {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.8; }
        }
      `}</style>
      <SkeletonBlock height={28} width={280} mb={8} />
      <SkeletonBlock height={14} width={400} mb={40} />
      <div style={{ display: 'flex', gap: 24 }}>
        <div style={{ flex: '0 0 33%' }}>
          <SkeletonBlock height={120} borderRadius={12} mb={16} />
          <SkeletonBlock height={48} borderRadius={8} />
        </div>
        <div style={{ flex: 1 }}>
          <SkeletonBlock height={200} borderRadius={12} />
        </div>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Página principal
// ──────────────────────────────────────────────────────────────

export default function WhatsAppPage() {
  const { businessId } = useAuth()

  const {
    connection,
    automationSettings,
    loading,
    error,
    refresh,
    disconnect,
    saveAutomationSettings,
  } = useWhatsAppConnection()

  // Estado local para los toggles (sincronizado con los datos del servidor)
  const [localAutomation, setLocalAutomation] = useState<typeof DEFAULT_AUTOMATION>(() => ({
    enabled:           automationSettings?.enabled          ?? DEFAULT_AUTOMATION.enabled,
    send_on_received:  automationSettings?.send_on_received  ?? DEFAULT_AUTOMATION.send_on_received,
    send_on_diagnosis: automationSettings?.send_on_diagnosis ?? DEFAULT_AUTOMATION.send_on_diagnosis,
    send_on_repair:    automationSettings?.send_on_repair    ?? DEFAULT_AUTOMATION.send_on_repair,
    send_on_ready:     automationSettings?.send_on_ready     ?? DEFAULT_AUTOMATION.send_on_ready,
    send_on_delivered: automationSettings?.send_on_delivered ?? DEFAULT_AUTOMATION.send_on_delivered,
  }))

  // Actualiza el estado local cuando llegan datos del servidor
  React.useEffect(() => {
    if (automationSettings) {
      setLocalAutomation({
        enabled:           automationSettings.enabled,
        send_on_received:  automationSettings.send_on_received,
        send_on_diagnosis: automationSettings.send_on_diagnosis,
        send_on_repair:    automationSettings.send_on_repair,
        send_on_ready:     automationSettings.send_on_ready,
        send_on_delivered: automationSettings.send_on_delivered,
      })
    }
  }, [automationSettings])

  const [savingAutomation, setSavingAutomation]     = useState(false)
  const [automationSaveMsg, setAutomationSaveMsg]   = useState<{
    type: 'success' | 'error'
    text: string
  } | null>(null)

  const [testModalOpen, setTestModalOpen]           = useState(false)
  const [connectError, setConnectError]             = useState<string | null>(null)
  const [connectSuccess, setConnectSuccess]         = useState<string | null>(null)

  // Maneja el cambio de un toggle de automatización
  const handleToggleChange = (key: AutomationToggleKey, value: boolean) => {
    setLocalAutomation(prev => ({ ...prev, [key]: value }))
  }

  // Guarda la configuración de automatización
  const handleSaveAutomation = async () => {
    setSavingAutomation(true)
    setAutomationSaveMsg(null)

    const result = await saveAutomationSettings(localAutomation)

    setSavingAutomation(false)
    if (result.success) {
      setAutomationSaveMsg({ type: 'success', text: 'Configuración guardada correctamente.' })
      setTimeout(() => setAutomationSaveMsg(null), 3000)
    } else {
      setAutomationSaveMsg({
        type: 'error',
        text: result.error || 'No se pudo guardar la configuración.',
      })
    }
  }

  // Maneja el click en desconectar
  const handleDisconnect = async () => {
    const result = await disconnect()
    if (!result.success) {
      setConnectError(result.error || 'Error al desconectar')
    }
  }

  // Éxito al conectar
  const handleConnectSuccess = () => {
    setConnectError(null)
    setConnectSuccess('¡Conexión establecida correctamente! Tu WhatsApp Business está listo.')
    refresh()
    setTimeout(() => setConnectSuccess(null), 5000)
  }

  // Error al conectar
  const handleConnectError = (message: string) => {
    setConnectError(message)
    setConnectSuccess(null)
  }

  // ────────────────────────────────
  // Estados de carga y error global
  // ────────────────────────────────

  if (loading) return <PageSkeleton />

  if (error) {
    return (
      <div
        style={{
          display:        'flex',
          flexDirection:  'column',
          alignItems:     'center',
          justifyContent: 'center',
          padding:        64,
          gap:            16,
          textAlign:      'center',
        }}
      >
        <AlertTriangle size={40} color="#f97316" />
        <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          Error al cargar WhatsApp
        </h2>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', maxWidth: 400, margin: 0 }}>
          {error}
        </p>
        <button
          onClick={refresh}
          style={{
            display:         'inline-flex',
            alignItems:      'center',
            gap:             8,
            padding:         '10px 20px',
            borderRadius:    8,
            border:          '1px solid rgba(255,255,255,0.12)',
            backgroundColor: 'rgba(255,255,255,0.05)',
            color:           'var(--text-primary)',
            fontSize:        14,
            cursor:          'pointer',
          }}
        >
          <RefreshCw size={15} />
          Reintentar
        </button>
      </div>
    )
  }

  // ────────────────────────────────
  // Render principal
  // ────────────────────────────────

  const isConnected = connection?.status === 'connected'

  return (
    <div
      style={{
        padding:         '32px 24px',
        maxWidth:        1100,
        margin:          '0 auto',
        color:           'var(--text-primary)',
      }}
    >
      {/* ── Header de la página ── */}
      <div
        style={{
          display:        'flex',
          alignItems:     'flex-start',
          justifyContent: 'space-between',
          marginBottom:   32,
          flexWrap:       'wrap',
          gap:            12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              display:         'flex',
              alignItems:      'center',
              justifyContent:  'center',
              width:           48,
              height:          48,
              borderRadius:    12,
              backgroundColor: 'rgba(37,211,102,0.12)',
              border:          '1px solid rgba(37,211,102,0.2)',
              flexShrink:      0,
            }}
          >
            <MessageSquare size={24} color="#25D366" />
          </div>
          <div>
            <h1
              style={{
                fontSize:   22,
                fontWeight: 700,
                color:      'var(--text-primary)',
                margin:     0,
              }}
            >
              WhatsApp Business
            </h1>
            <p
              style={{
                fontSize: 13,
                color:    'var(--text-secondary)',
                margin:   '4px 0 0',
              }}
            >
              Enviá mensajes automáticos a tus clientes usando la API oficial de Meta
            </p>
          </div>
        </div>

        <button
          onClick={refresh}
          style={{
            display:         'inline-flex',
            alignItems:      'center',
            gap:             7,
            padding:         '8px 14px',
            borderRadius:    8,
            border:          '1px solid rgba(255,255,255,0.1)',
            backgroundColor: 'rgba(255,255,255,0.04)',
            color:           'var(--text-secondary)',
            fontSize:        13,
            cursor:          'pointer',
            transition:      'all 0.2s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.08)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.04)' }}
          title="Actualizar datos"
        >
          <RefreshCw size={14} />
          Actualizar
        </button>
      </div>

      {/* ── Alertas globales de conexión ── */}
      {connectSuccess && (
        <div
          style={{
            display:         'flex',
            alignItems:      'center',
            gap:             10,
            padding:         '12px 16px',
            borderRadius:    8,
            marginBottom:    20,
            backgroundColor: 'rgba(34,197,94,0.1)',
            border:          '1px solid rgba(34,197,94,0.25)',
            fontSize:        14,
            color:           '#22c55e',
          }}
        >
          <MessageSquare size={16} style={{ flexShrink: 0 }} />
          {connectSuccess}
        </div>
      )}

      {connectError && (
        <div
          style={{
            display:         'flex',
            alignItems:      'flex-start',
            gap:             10,
            padding:         '12px 16px',
            borderRadius:    8,
            marginBottom:    20,
            backgroundColor: 'rgba(239,68,68,0.1)',
            border:          '1px solid rgba(239,68,68,0.25)',
            fontSize:        14,
            color:           '#ef4444',
          }}
        >
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{connectError}</span>
        </div>
      )}

      {/* ── Layout principal: columna izquierda + columna derecha ── */}
      <div
        style={{
          display:   'flex',
          gap:       24,
          alignItems: 'flex-start',
          flexWrap:  'wrap',
        }}
      >
        {/* ── Columna izquierda (1/3): estado + botón de conexión ── */}
        <div style={{ flex: '0 0 calc(33.333% - 12px)', minWidth: 240 }}>

          {/* Card de estado */}
          <div
            style={{
              backgroundColor: 'var(--bg-card, #0b1120)',
              border:          '1px solid var(--border-color, rgba(255,255,255,0.06))',
              borderRadius:    12,
              padding:         20,
              marginBottom:    16,
            }}
          >
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontSize:     11,
                  fontWeight:   600,
                  color:        'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.7,
                  marginBottom: 10,
                }}
              >
                Estado actual
              </div>
              <WhatsAppStatusBadge status={connection?.status ?? null} size="md" />
            </div>

            {/* Botón para conectar / reconectar */}
            {businessId && (
              <WhatsAppConnectButton
                businessId={businessId}
                hasConnection={!!connection}
                onSuccess={handleConnectSuccess}
                onError={handleConnectError}
              />
            )}
          </div>

          {/* Aviso sobre cargos de Meta */}
          <div
            style={{
              backgroundColor: 'rgba(251,191,36,0.06)',
              border:          '1px solid rgba(251,191,36,0.18)',
              borderRadius:    10,
              padding:         14,
              marginBottom:    16,
            }}
          >
            <div
              style={{
                display:      'flex',
                alignItems:   'flex-start',
                gap:          8,
                marginBottom: 8,
              }}
            >
              <Info size={14} color="#fbbf24" style={{ flexShrink: 0, marginTop: 1 }} />
              <span
                style={{
                  fontSize:   12,
                  fontWeight: 600,
                  color:      '#fbbf24',
                }}
              >
                Sobre los cargos de Meta
              </span>
            </div>
            <p
              style={{
                fontSize:   12,
                color:      'rgba(251,191,36,0.85)',
                lineHeight: 1.5,
                margin:     0,
              }}
            >
              El envío de mensajes a través de la API oficial de WhatsApp Business puede incurrir en
              cargos adicionales según las políticas de precios de Meta. Las conversaciones iniciadas
              por el negocio tienen un costo por mensaje.
            </p>
          </div>

          {/* Link a tutoriales */}
          <a
            href="#"
            style={{
              display:        'inline-flex',
              alignItems:     'center',
              gap:            7,
              fontSize:       13,
              color:          'var(--text-secondary)',
              textDecoration: 'none',
              padding:        '8px 0',
              transition:     'color 0.2s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-primary)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-secondary)' }}
          >
            <ExternalLink size={13} />
            Ver tutoriales de configuración
          </a>
        </div>

        {/* ── Columna derecha (2/3): card de conexión ── */}
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
          <WhatsAppConnectionCard
            connection={connection}
            onDisconnect={handleDisconnect}
          />
        </div>
      </div>

      {/* ── Sección de automatización ── */}
      <div style={{ marginTop: 32 }}>
        <div
          style={{
            backgroundColor: 'var(--bg-card, #0b1120)',
            border:          '1px solid var(--border-color, rgba(255,255,255,0.06))',
            borderRadius:    12,
            overflow:        'hidden',
          }}
        >
          {/* Header de la sección */}
          <div
            style={{
              display:         'flex',
              alignItems:      'center',
              justifyContent:  'space-between',
              padding:         '18px 24px',
              borderBottom:    '1px solid rgba(255,255,255,0.06)',
              flexWrap:        'wrap',
              gap:             12,
            }}
          >
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                Mensajes automáticos
              </h2>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                Configurá qué eventos disparan mensajes a tus clientes
              </p>
            </div>

            {/* Aviso si no hay conexión */}
            {!isConnected && (
              <div
                style={{
                  display:         'inline-flex',
                  alignItems:      'center',
                  gap:             7,
                  padding:         '6px 12px',
                  borderRadius:    7,
                  backgroundColor: 'rgba(251,191,36,0.08)',
                  border:          '1px solid rgba(251,191,36,0.2)',
                  fontSize:        12,
                  color:           '#fbbf24',
                }}
              >
                <AlertTriangle size={13} />
                Requiere una cuenta conectada
              </div>
            )}
          </div>

          {/* Toggles */}
          <div style={{ padding: '4px 24px 8px' }}>
            {AUTOMATION_TOGGLES.map((item) => (
              <ToggleRow
                key={item.key}
                item={item}
                checked={localAutomation[item.key]}
                disabled={!isConnected && item.key !== 'enabled'}
                onChange={handleToggleChange}
              />
            ))}
          </div>

          {/* Footer con botón guardar */}
          <div
            style={{
              display:         'flex',
              alignItems:      'center',
              justifyContent:  'space-between',
              padding:         '16px 24px',
              borderTop:       '1px solid rgba(255,255,255,0.06)',
              backgroundColor: 'rgba(255,255,255,0.02)',
              flexWrap:        'wrap',
              gap:             12,
            }}
          >
            {/* Mensaje de resultado del guardado */}
            <div style={{ flex: 1 }}>
              {automationSaveMsg && (
                <span
                  style={{
                    fontSize: 13,
                    color:    automationSaveMsg.type === 'success' ? '#22c55e' : '#ef4444',
                  }}
                >
                  {automationSaveMsg.text}
                </span>
              )}
            </div>

            <button
              onClick={() => void handleSaveAutomation()}
              disabled={savingAutomation}
              style={{
                display:         'inline-flex',
                alignItems:      'center',
                gap:             8,
                padding:         '10px 22px',
                borderRadius:    8,
                border:          'none',
                backgroundColor: savingAutomation ? 'rgba(99,102,241,0.4)' : '#6366f1',
                color:           '#fff',
                fontSize:        14,
                fontWeight:      600,
                cursor:          savingAutomation ? 'not-allowed' : 'pointer',
                transition:      'background-color 0.2s',
              }}
              onMouseEnter={e => {
                if (!savingAutomation)
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#4f46e5'
              }}
              onMouseLeave={e => {
                if (!savingAutomation)
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#6366f1'
              }}
            >
              {savingAutomation ? (
                <>
                  <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                  Guardando…
                </>
              ) : (
                <>
                  <Save size={15} />
                  Guardar configuración
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ── Sección inferior: botón de mensaje de prueba ── */}
      {isConnected && (
        <div
          style={{
            marginTop:       24,
            display:         'flex',
            alignItems:      'center',
            justifyContent:  'space-between',
            backgroundColor: 'var(--bg-card, #0b1120)',
            border:          '1px solid var(--border-color, rgba(255,255,255,0.06))',
            borderRadius:    12,
            padding:         '18px 24px',
            flexWrap:        'wrap',
            gap:             14,
          }}
        >
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              Verificar conexión
            </h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Enviá un mensaje de prueba para confirmar que la integración está funcionando
            </p>
          </div>

          <button
            onClick={() => setTestModalOpen(true)}
            style={{
              display:         'inline-flex',
              alignItems:      'center',
              gap:             8,
              padding:         '10px 20px',
              borderRadius:    8,
              border:          '1px solid rgba(37,211,102,0.3)',
              backgroundColor: 'rgba(37,211,102,0.08)',
              color:           '#25D366',
              fontSize:        14,
              fontWeight:      500,
              cursor:          'pointer',
              transition:      'all 0.2s',
              flexShrink:      0,
            }}
            onMouseEnter={e => {
              const btn = e.currentTarget as HTMLButtonElement
              btn.style.backgroundColor = 'rgba(37,211,102,0.15)'
              btn.style.borderColor     = 'rgba(37,211,102,0.5)'
            }}
            onMouseLeave={e => {
              const btn = e.currentTarget as HTMLButtonElement
              btn.style.backgroundColor = 'rgba(37,211,102,0.08)'
              btn.style.borderColor     = 'rgba(37,211,102,0.3)'
            }}
          >
            <Send size={15} />
            Enviar mensaje de prueba
          </button>
        </div>
      )}

      {/* ── Modal de mensaje de prueba ── */}
      {businessId && (
        <WhatsAppTestMessageModal
          businessId={businessId}
          isOpen={testModalOpen}
          onClose={() => setTestModalOpen(false)}
        />
      )}

      {/* Animaciones globales de la página */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
