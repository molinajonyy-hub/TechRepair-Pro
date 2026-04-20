import React, { useState } from 'react'
import { Phone, Building2, Key, Calendar, Wifi, WifiOff } from 'lucide-react'
import type { WhatsAppConnection } from '../../services/whatsappCloudService'

// ──────────────────────────────────────────────────────────────
// Props
// ──────────────────────────────────────────────────────────────

interface WhatsAppConnectionCardProps {
  connection: WhatsAppConnection | null
  onDisconnect: () => void
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

/** Trunca un ID largo mostrando inicio y fin */
function truncateId(id: string, visibleChars = 8): string {
  if (!id || id.length <= visibleChars * 2 + 3) return id
  return `${id.slice(0, visibleChars)}…${id.slice(-visibleChars)}`
}

/** Formatea una fecha ISO en español */
function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleDateString('es-AR', {
      day:   '2-digit',
      month: 'long',
      year:  'numeric',
    })
  } catch {
    return isoString
  }
}

// ──────────────────────────────────────────────────────────────
// Sub-componente: fila de dato
// ──────────────────────────────────────────────────────────────

interface InfoRowProps {
  icon: React.ReactNode
  label: string
  value: string
  mono?: boolean
}

function InfoRow({ icon, label, value, mono = false }: InfoRowProps) {
  return (
    <div
      style={{
        display:      'flex',
        alignItems:   'flex-start',
        gap:          12,
        padding:      '10px 0',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      }}
    >
      <div
        style={{
          display:         'flex',
          alignItems:      'center',
          justifyContent:  'center',
          width:           32,
          height:          32,
          borderRadius:    8,
          backgroundColor: 'rgba(37,211,102,0.1)',
          flexShrink:      0,
          color:           '#25D366',
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize:   11,
            fontWeight: 500,
            color:      'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            marginBottom: 3,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize:   14,
            fontWeight: mono ? 400 : 500,
            color:      'var(--text-primary)',
            fontFamily: mono ? 'monospace' : 'inherit',
            overflow:   'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={value}
        >
          {value}
        </div>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Estado vacío
// ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      style={{
        backgroundColor: 'var(--bg-card, #0b1120)',
        border:          '1px solid var(--border-color, rgba(255,255,255,0.06))',
        borderRadius:    12,
        padding:         32,
        textAlign:       'center',
      }}
    >
      <div
        style={{
          display:         'flex',
          alignItems:      'center',
          justifyContent:  'center',
          width:           56,
          height:          56,
          borderRadius:    '50%',
          backgroundColor: 'rgba(37,211,102,0.08)',
          margin:          '0 auto 16px',
        }}
      >
        <WifiOff size={24} color="rgba(37,211,102,0.5)" />
      </div>

      <h3
        style={{
          fontSize:    16,
          fontWeight:  600,
          color:       'var(--text-primary)',
          marginBottom: 8,
        }}
      >
        Sin cuenta conectada
      </h3>

      <p
        style={{
          fontSize:   13,
          color:      'var(--text-secondary)',
          lineHeight: 1.6,
          maxWidth:   420,
          margin:     '0 auto 16px',
        }}
      >
        <strong style={{ color: 'var(--text-primary)' }}>WhatsApp Business</strong> te permite
        enviar mensajes automáticos a tus clientes cuando cambia el estado de su orden de reparación.
        Los mensajes se envían directamente desde tu número de WhatsApp Business usando la API
        oficial de Meta.
      </p>

      <div
        style={{
          display:         'inline-flex',
          alignItems:      'center',
          gap:             8,
          padding:         '8px 14px',
          borderRadius:    8,
          backgroundColor: 'rgba(255,255,255,0.04)',
          border:          '1px solid rgba(255,255,255,0.08)',
          fontSize:        12,
          color:           'var(--text-muted)',
        }}
      >
        <Wifi size={13} />
        Conectá tu cuenta usando el botón de la izquierda
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Componente principal
// ──────────────────────────────────────────────────────────────

export function WhatsAppConnectionCard({
  connection,
  onDisconnect,
}: WhatsAppConnectionCardProps) {
  const [confirmingDisconnect] = useState(false)

  if (!connection) {
    return <EmptyState />
  }

  const handleDisconnectClick = () => {
    // Pedimos confirmación antes de desconectar
    const confirmed = window.confirm(
      '¿Estás seguro de que querés desconectar tu cuenta de WhatsApp Business?\n\n' +
      'Los mensajes automáticos dejarán de enviarse hasta que vuelvas a conectar.'
    )
    if (confirmed) {
      onDisconnect()
    }
  }

  return (
    <div
      style={{
        backgroundColor: 'var(--bg-card, #0b1120)',
        border:          '1px solid var(--border-color, rgba(255,255,255,0.06))',
        borderRadius:    12,
        overflow:        'hidden',
      }}
    >
      {/* Header de la card */}
      <div
        style={{
          display:         'flex',
          alignItems:      'center',
          justifyContent:  'space-between',
          padding:         '16px 20px',
          borderBottom:    '1px solid rgba(255,255,255,0.06)',
          backgroundColor: 'rgba(37,211,102,0.04)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              display:         'flex',
              alignItems:      'center',
              justifyContent:  'center',
              width:           36,
              height:          36,
              borderRadius:    9,
              backgroundColor: 'rgba(37,211,102,0.15)',
            }}
          >
            <Wifi size={18} color="#25D366" />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
              Cuenta conectada
            </div>
            <div style={{ fontSize: 12, color: '#25D366', marginTop: 1 }}>
              WhatsApp Business Cloud API
            </div>
          </div>
        </div>

        {/* Botón desconectar */}
        <button
          onClick={handleDisconnectClick}
          disabled={confirmingDisconnect}
          style={{
            display:         'inline-flex',
            alignItems:      'center',
            gap:             6,
            padding:         '7px 14px',
            borderRadius:    7,
            border:          '1px solid rgba(239,68,68,0.3)',
            backgroundColor: 'rgba(239,68,68,0.08)',
            color:           '#ef4444',
            fontSize:        13,
            fontWeight:      500,
            cursor:          'pointer',
            transition:      'all 0.2s ease',
          }}
          onMouseEnter={e => {
            const btn = e.currentTarget
            btn.style.backgroundColor = 'rgba(239,68,68,0.15)'
            btn.style.borderColor     = 'rgba(239,68,68,0.5)'
          }}
          onMouseLeave={e => {
            const btn = e.currentTarget
            btn.style.backgroundColor = 'rgba(239,68,68,0.08)'
            btn.style.borderColor     = 'rgba(239,68,68,0.3)'
          }}
        >
          <WifiOff size={14} />
          Desconectar
        </button>
      </div>

      {/* Cuerpo con los datos de la conexión */}
      <div style={{ padding: '4px 20px 16px' }}>
        <InfoRow
          icon={<Building2 size={16} />}
          label="Nombre de cuenta"
          value={connection.connected_account_name || '—'}
        />
        <InfoRow
          icon={<Phone size={16} />}
          label="Número de teléfono"
          value={connection.business_phone_number || '—'}
        />
        <InfoRow
          icon={<Key size={16} />}
          label="WABA ID"
          value={truncateId(connection.waba_id)}
          mono
        />
        <InfoRow
          icon={<Key size={16} />}
          label="Phone Number ID"
          value={truncateId(connection.phone_number_id)}
          mono
        />
        <div style={{ borderBottom: 'none' }}>
          <InfoRow
            icon={<Calendar size={16} />}
            label="Conectado el"
            value={formatDate(connection.created_at)}
          />
        </div>
      </div>
    </div>
  )
}

export default WhatsAppConnectionCard
