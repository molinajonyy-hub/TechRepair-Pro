import { useState, useEffect } from 'react'
import {
  MessageSquare,
  Save,
  Loader2,
  CheckCircle2,
  XCircle,
  Unplug,
  ExternalLink,
  Eye,
  EyeOff,
  Send,
  Info,
  Phone,
  Key,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import {
  getConnection,
  getAutomationSettings,
  saveAutomationSettings,
  disconnectWhatsApp,
  saveManualConnection,
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

  // Estado de carga general
  const [loading, setLoading] = useState(true)

  // Conexión activa
  const [connection, setConnection] = useState<WhatsAppConnection | null>(null)

  // Formulario de conexión manual
  const [phoneNumberId, setPhoneNumberId]   = useState('')
  const [accessToken, setAccessToken]       = useState('')
  const [accountName, setAccountName]       = useState('')
  const [showToken, setShowToken]           = useState(false)
  const [saving, setSaving]                 = useState(false)
  const [saveError, setSaveError]           = useState<string | null>(null)

  // Desconexión
  const [disconnecting, setDisconnecting]   = useState(false)

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

  // ── Guardar conexión manual ───────────────────────────────

  async function handleConnect() {
    if (!phoneNumberId.trim() || !accessToken.trim()) {
      setSaveError('Completá el Phone Number ID y el Access Token.')
      return
    }
    setSaving(true)
    setSaveError(null)
    const result = await saveManualConnection(businessId!, {
      phone_number_id:        phoneNumberId.trim(),
      access_token:           accessToken.trim(),
      connected_account_name: accountName.trim() || 'Mi cuenta WhatsApp',
    })
    if (result.success) {
      setPhoneNumberId('')
      setAccessToken('')
      setAccountName('')
      await load()
    } else {
      setSaveError(result.error || 'Error al guardar la conexión.')
    }
    setSaving(false)
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
            Enviá mensajes automáticos a tus clientes usando la API oficial de Meta
          </p>
        </div>
      </div>

      {/* ── Panel: Conectado ── */}
      {isConnected && (
        <div style={{
          background: 'rgba(37,211,102,0.07)', border: '1px solid rgba(37,211,102,0.25)',
          borderRadius: '0.75rem', padding: '1.25rem 1.5rem', marginBottom: '1.5rem',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <CheckCircle2 size={20} color="#25D366" />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#25D366' }}>Conectado</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                {connection.connected_account_name || 'Cuenta WhatsApp'} · {connection.business_phone_number || connection.phone_number_id}
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

      {/* ── Panel: Formulario de conexión ── */}
      {!isConnected && (
        <div style={{
          background: 'var(--bg-card, rgba(255,255,255,0.03))',
          border: '1px solid var(--border-color)',
          borderRadius: '0.75rem', padding: '1.5rem', marginBottom: '1.5rem',
        }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 0.25rem' }}>
            Conectar WhatsApp Business API
          </h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 1.25rem' }}>
            Ingresá tus credenciales de la API oficial de Meta. Las encontrás en{' '}
            <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--accent-primary)', textDecoration: 'none' }}>
              Meta for Developers <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
            </a>
          </p>

          {/* Instrucciones */}
          <div style={{
            background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
            borderRadius: 8, padding: '0.875rem 1rem', marginBottom: '1.25rem',
            display: 'flex', gap: 10,
          }}>
            <Info size={16} color="var(--accent-primary)" style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 13, color: 'var(--text-secondary, var(--text-muted))', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--text-primary)' }}>¿Dónde conseguir estos datos?</strong><br />
              1. Entrá a <strong>Meta for Developers</strong> → seleccioná tu app → <strong>WhatsApp → Configuración de API</strong><br />
              2. En "Número de teléfono", copiá el <strong>Phone Number ID</strong> (número largo)<br />
              3. Generá un <strong>Token de acceso permanente</strong> desde la misma pantalla o desde System Users
            </div>
          </div>

          {/* Campo: Nombre de cuenta */}
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-secondary, var(--text-muted))', marginBottom: 6 }}>
              Nombre de cuenta <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(opcional)</span>
            </label>
            <input
              type="text"
              placeholder="Ej: TechRepair WhatsApp"
              value={accountName}
              onChange={e => setAccountName(e.target.value)}
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '9px 12px', borderRadius: 8, fontSize: 14,
                background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)',
                color: 'var(--text-primary)', outline: 'none',
              }}
            />
          </div>

          {/* Campo: Phone Number ID */}
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, color: 'var(--text-secondary, var(--text-muted))', marginBottom: 6 }}>
              <Phone size={13} /> Phone Number ID <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>
            </label>
            <input
              type="text"
              placeholder="Ej: 123456789012345"
              value={phoneNumberId}
              onChange={e => setPhoneNumberId(e.target.value)}
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '9px 12px', borderRadius: 8, fontSize: 14,
                background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)',
                color: 'var(--text-primary)', outline: 'none', fontFamily: 'monospace',
              }}
            />
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              ID numérico del número de teléfono en Meta Business (no el número de teléfono en sí)
            </p>
          </div>

          {/* Campo: Access Token */}
          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, color: 'var(--text-secondary, var(--text-muted))', marginBottom: 6 }}>
              <Key size={13} /> Access Token <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>
            </label>
            <div style={{ position: 'relative' }}>
              <input
                type={showToken ? 'text' : 'password'}
                placeholder="EAAxxxxxxxxxx..."
                value={accessToken}
                onChange={e => setAccessToken(e.target.value)}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '9px 40px 9px 12px', borderRadius: 8, fontSize: 14,
                  background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)', outline: 'none', fontFamily: 'monospace',
                }}
              />
              <button
                type="button"
                onClick={() => setShowToken(v => !v)}
                style={{
                  position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0,
                }}
              >
                {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Token de acceso permanente. Nunca lo compartas con nadie.
            </p>
          </div>

          {saveError && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 8, padding: '10px 14px', marginBottom: '1rem', fontSize: 13, color: '#f87171',
            }}>
              <XCircle size={15} /> {saveError}
            </div>
          )}

          <button
            onClick={handleConnect}
            disabled={saving || !phoneNumberId.trim() || !accessToken.trim()}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 20px', borderRadius: 8, border: 'none',
              background: (!phoneNumberId.trim() || !accessToken.trim())
                ? 'rgba(255,255,255,0.1)'
                : 'linear-gradient(135deg, #25D366 0%, #128C7E 100%)',
              color: '#fff', cursor: (!phoneNumberId.trim() || !accessToken.trim()) ? 'not-allowed' : 'pointer',
              fontSize: 14, fontWeight: 600, transition: 'all 0.2s',
            }}
          >
            {saving
              ? <><Loader2 size={16} style={{ animation: 'tr-spin 1s linear infinite' }} /> Guardando...</>
              : <><Save size={16} /> Conectar WhatsApp</>
            }
          </button>
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
              Requiere cuenta conectada
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
