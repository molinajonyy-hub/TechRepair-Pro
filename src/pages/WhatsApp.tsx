import { useState, useEffect } from 'react'
import {
  MessageSquare,
  Save,
  Loader2,
  CheckCircle2,
  XCircle,
  Unplug,
  Send,
  Info,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import {
  getConnection,
  getAutomationSettings,
  saveAutomationSettings,
  disconnectWhatsApp,
  sendTestMessage,
  type WhatsAppConnection,
} from '../services/whatsappCloudService'

// ──────────────────────────────────────────────────────────────
// Tipos locales
// ──────────────────────────────────────────────────────────────

type AutomationKey =
  | 'enabled'
  | 'send_on_received'
  | 'send_on_diagnosis'
  | 'send_on_repair'
  | 'send_on_ready'
  | 'send_on_delivered'

const AUTOMATION_ITEMS: { key: AutomationKey; label: string; description: string }[] = [
  { key: 'enabled',          label: 'Automatización activa',   description: 'Habilita o deshabilita todos los mensajes automáticos' },
  { key: 'send_on_received', label: 'Al recibir el equipo',    description: 'Mensaje cuando se crea la orden y se recibe el equipo' },
  { key: 'send_on_diagnosis',label: 'Al iniciar diagnóstico',  description: 'Notifica al cliente cuando el equipo entra en revisión' },
  { key: 'send_on_repair',   label: 'Al iniciar reparación',   description: 'Avisa cuando el técnico comienza a reparar el equipo' },
  { key: 'send_on_ready',    label: 'Listo para retirar',      description: 'Notifica cuando el equipo está reparado y disponible' },
  { key: 'send_on_delivered',label: 'Al entregar el equipo',   description: 'Mensaje de cierre cuando el cliente retira el equipo' },
]

const DEFAULT_AUTOMATION = {
  enabled: false,
  send_on_received: false,
  send_on_diagnosis: false,
  send_on_repair: false,
  send_on_ready: true,
  send_on_delivered: false,
}

/** Enmascara un teléfono dejando sólo los últimos 4 dígitos visibles. */
function maskPhone(phone?: string | null): string {
  const digits = (phone || '').replace(/\D/g, '')
  if (digits.length < 4) return 'Cuenta conectada'
  return '•••• ' + digits.slice(-4)
}

// ──────────────────────────────────────────────────────────────
// Toggle row
// ──────────────────────────────────────────────────────────────

function ToggleRow({
  label, description, checked, disabled, onChange,
}: {
  label: string; description: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 0', borderBottom: '1px solid rgba(255,255,255,0.05)',
      opacity: disabled ? 0.45 : 1, transition: 'opacity 0.2s',
    }}>
      <div style={{ flex: 1, paddingRight: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 3 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{description}</div>
      </div>
      <button
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        style={{
          width: 44, height: 24, borderRadius: 12, border: 'none', cursor: disabled ? 'default' : 'pointer',
          background: checked ? 'var(--accent-primary)' : 'rgba(255,255,255,0.12)',
          position: 'relative', transition: 'background 0.2s', flexShrink: 0,
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: checked ? 23 : 3, width: 18, height: 18,
          borderRadius: '50%', background: '#fff', transition: 'left 0.2s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
      </button>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Página principal
// ──────────────────────────────────────────────────────────────

export default function WhatsApp() {
  const { profile } = useAuth()
  const businessId = profile?.business_id

  const [loading, setLoading] = useState(true)

  // Conexión Cloud API activa (el token vive sólo server-side en whatsapp_connections).
  const [connection, setConnection] = useState<WhatsAppConnection | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  // Automatizaciones
  const [automation, setAutomation] = useState<typeof DEFAULT_AUTOMATION>(DEFAULT_AUTOMATION)
  const [savingAuto, setSavingAuto]         = useState(false)
  const [autoSaved, setAutoSaved]           = useState(false)

  // Mensaje de prueba
  const [testPhone, setTestPhone]           = useState('')
  const [sendingTest, setSendingTest]       = useState(false)
  const [testResult, setTestResult]         = useState<{ ok: boolean; msg: string } | null>(null)

  // ── Carga inicial ──────────────────────────────────────────

  useEffect(() => {
    if (!businessId) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId])

  async function load() {
    setLoading(true)
    const [conn, auto] = await Promise.all([
      getConnection(businessId!),
      getAutomationSettings(businessId!),
    ])
    setConnection(conn)
    if (auto) {
      setAutomation({
        enabled:           auto.enabled,
        send_on_received:  auto.send_on_received,
        send_on_diagnosis: auto.send_on_diagnosis,
        send_on_repair:    auto.send_on_repair,
        send_on_ready:     auto.send_on_ready,
        send_on_delivered: auto.send_on_delivered,
      })
    }
    setLoading(false)
  }

  // ── Desconectar ───────────────────────────────────────────

  async function handleDisconnect() {
    if (!confirm('¿Desconectar WhatsApp? Los mensajes automáticos dejarán de enviarse.')) return
    setDisconnecting(true)
    await disconnectWhatsApp(businessId!)
    setConnection(null)
    setDisconnecting(false)
  }

  // ── Guardar automatizaciones ──────────────────────────────

  async function handleSaveAutomation() {
    setSavingAuto(true)
    await saveAutomationSettings(businessId!, automation)
    setSavingAuto(false)
    setAutoSaved(true)
    setTimeout(() => setAutoSaved(false), 3000)
  }

  // ── Enviar mensaje de prueba ──────────────────────────────

  async function handleSendTest() {
    if (!testPhone.trim()) return
    setSendingTest(true)
    setTestResult(null)
    const res = await sendTestMessage(businessId!, testPhone.trim())
    setTestResult({ ok: res.success, msg: res.error || '¡Mensaje enviado correctamente!' })
    setSendingTest(false)
  }

  // ── Render ────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
        <Loader2 size={28} style={{ color: 'var(--accent-primary)', animation: 'tr-spin 1s linear infinite' }} />
      </div>
    )
  }

  const isConnected = !!connection
  const connectedDate = connection?.created_at
    ? new Date(connection.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' })
    : null

  return (
    <div style={{ maxWidth: 780, margin: '0 auto', padding: '2rem 1.5rem' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: '2rem' }}>
        <div style={{
          width: 48, height: 48, borderRadius: '0.75rem',
          background: 'linear-gradient(135deg, #25D366 0%, #128C7E 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 12px rgba(37,211,102,0.35)',
        }}>
          <MessageSquare size={24} color="#fff" />
        </div>
        <div>
          <h1 style={{ fontSize: '1.375rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            WhatsApp Business
          </h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', margin: '2px 0 0' }}>
            Comunicación con tus clientes por WhatsApp
          </p>
        </div>
      </div>

      {/* ── Panel: Conectado (API oficial) ── */}
      {isConnected && (
        <div style={{
          background: 'rgba(37,211,102,0.07)', border: '1px solid rgba(37,211,102,0.25)',
          borderRadius: '0.75rem', padding: '1.25rem 1.5rem', marginBottom: '1.5rem',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <CheckCircle2 size={20} color="#25D366" />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#25D366' }}>API oficial conectada</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                {connection!.connected_account_name || 'Cuenta WhatsApp'} · {maskPhone(connection!.business_phone_number)}
                {connectedDate && <> · Conectada el {connectedDate}</>}
              </div>
            </div>
          </div>
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 8,
              background: 'transparent', border: '1px solid rgba(255,255,255,0.15)',
              color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            }}
          >
            {disconnecting ? <Loader2 size={14} style={{ animation: 'tr-spin 1s linear infinite' }} /> : <Unplug size={14} />}
            Desconectar
          </button>
        </div>
      )}

      {/* ── Panel: Estado sin conexión oficial (honesto, sin pedir credenciales) ── */}
      {!isConnected && (
        <div style={{
          background: 'var(--bg-card, rgba(255,255,255,0.03))',
          border: '1px solid var(--border-color)',
          borderRadius: '0.75rem', padding: '1.5rem', marginBottom: '1.5rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '0.75rem' }}>
            <span style={{
              fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6,
              background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', color: '#f59e0b',
            }}>
              API oficial no conectada
            </span>
          </div>

          <div style={{
            background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
            borderRadius: 8, padding: '0.875rem 1rem',
            display: 'flex', gap: 10,
          }}>
            <Info size={16} color="var(--accent-primary)" style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 13, color: 'var(--text-secondary, var(--text-muted))', lineHeight: 1.6 }}>
              Los mensajes por WhatsApp <strong style={{ color: 'var(--text-primary)' }}>siguen funcionando</strong> sin
              conexión oficial: desde <strong>Clientes</strong>, <strong>Órdenes</strong> y <strong>Comprobantes</strong> podés
              abrir WhatsApp Web o Desktop con el mensaje ya preparado.<br /><br />
              La conexión automática con Meta todavía no está disponible. Podés seguir usando WhatsApp Web o Desktop desde
              clientes, órdenes y comprobantes.
            </div>
          </div>
        </div>
      )}

      {/* ── Panel: Mensaje de prueba (solo si conectado) ── */}
      {isConnected && (
        <div style={{
          background: 'var(--bg-card, rgba(255,255,255,0.03))',
          border: '1px solid var(--border-color)',
          borderRadius: '0.75rem', padding: '1.25rem 1.5rem', marginBottom: '1.5rem',
        }}>
          <h2 style={{ fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 0.75rem' }}>
            Enviar mensaje de prueba
          </h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 1rem' }}>
            Verificá que la conexión funcione enviando el template "hello_world" al número que indiques.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <input
              type="tel"
              placeholder="+5491112345678"
              value={testPhone}
              onChange={e => setTestPhone(e.target.value)}
              style={{
                flex: 1, minWidth: 200,
                padding: '9px 12px', borderRadius: 8, fontSize: 14,
                background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)',
                color: 'var(--text-primary)', outline: 'none',
              }}
            />
            <button
              onClick={handleSendTest}
              disabled={sendingTest || !testPhone.trim()}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '9px 18px', borderRadius: 8, border: 'none',
                background: 'var(--accent-primary)', color: '#fff',
                cursor: sendingTest || !testPhone.trim() ? 'not-allowed' : 'pointer',
                fontSize: 14, fontWeight: 500, opacity: !testPhone.trim() ? 0.5 : 1,
              }}
            >
              {sendingTest
                ? <Loader2 size={15} style={{ animation: 'tr-spin 1s linear infinite' }} />
                : <Send size={15} />}
              Enviar prueba
            </button>
          </div>
          {testResult && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginTop: 10,
              padding: '9px 14px', borderRadius: 8, fontSize: 13,
              background: testResult.ok ? 'rgba(37,211,102,0.1)' : 'rgba(239,68,68,0.1)',
              border: `1px solid ${testResult.ok ? 'rgba(37,211,102,0.3)' : 'rgba(239,68,68,0.3)'}`,
              color: testResult.ok ? '#25D366' : '#f87171',
            }}>
              {testResult.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              {testResult.msg}
            </div>
          )}
        </div>
      )}

      {/* ── Panel: Automatizaciones ── */}
      <div style={{
        background: 'var(--bg-card, rgba(255,255,255,0.03))',
        border: '1px solid var(--border-color)',
        borderRadius: '0.75rem', padding: '1.25rem 1.5rem',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2 style={{ fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              Mensajes automáticos
            </h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '3px 0 0' }}>
              Configurá qué eventos disparan mensajes a tus clientes
            </p>
          </div>
          {!isConnected && (
            <span style={{
              fontSize: 12, fontWeight: 500, padding: '4px 10px', borderRadius: 6,
              background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
              color: '#f59e0b',
            }}>
              Requiere API oficial conectada
            </span>
          )}
        </div>

        {AUTOMATION_ITEMS.map(item => (
          <ToggleRow
            key={item.key}
            label={item.label}
            description={item.description}
            checked={automation[item.key]}
            disabled={!isConnected && item.key !== 'enabled'}
            onChange={v => setAutomation(prev => ({ ...prev, [item.key]: v }))}
          />
        ))}

        <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSaveAutomation}
            disabled={savingAuto || !isConnected}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '9px 18px', borderRadius: 8, border: 'none',
              background: !isConnected ? 'rgba(255,255,255,0.08)' : 'var(--accent-primary)',
              color: '#fff', cursor: !isConnected ? 'not-allowed' : 'pointer',
              fontSize: 14, fontWeight: 500, opacity: !isConnected ? 0.5 : 1,
            }}
          >
            {savingAuto
              ? <Loader2 size={15} style={{ animation: 'tr-spin 1s linear infinite' }} />
              : <Save size={15} />}
            Guardar configuración
          </button>
          {autoSaved && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#25D366' }}>
              <CheckCircle2 size={15} /> Guardado
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
