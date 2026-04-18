import React, { useState, useEffect, useRef } from 'react'
import { X, Send, CheckCircle, AlertCircle, Loader2, Phone } from 'lucide-react'
import { sendTestMessage } from '../../services/whatsappCloudService'

// ──────────────────────────────────────────────────────────────
// Props
// ──────────────────────────────────────────────────────────────

interface WhatsAppTestMessageModalProps {
  businessId: string
  isOpen: boolean
  onClose: () => void
}

// ──────────────────────────────────────────────────────────────
// Componente
// ──────────────────────────────────────────────────────────────

export function WhatsAppTestMessageModal({
  businessId,
  isOpen,
  onClose,
}: WhatsAppTestMessageModalProps) {
  const [phone, setPhone] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Enfocar el input cuando se abre el modal
  useEffect(() => {
    if (isOpen) {
      setPhone('')
      setResult(null)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
    // Limpiar timer al desmontar
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleSend = async () => {
    const trimmedPhone = phone.trim()
    if (!trimmedPhone) {
      setResult({ type: 'error', message: 'Por favor ingresá un número de teléfono.' })
      return
    }

    setSending(true)
    setResult(null)

    try {
      const response = await sendTestMessage(businessId, trimmedPhone)

      if (response.success) {
        setResult({
          type:    'success',
          message: `¡Mensaje de prueba enviado correctamente! ID: ${response.message_id || 'N/D'}`,
        })
        // Cierra el modal automáticamente a los 2 segundos tras el éxito
        closeTimerRef.current = setTimeout(() => {
          onClose()
        }, 2000)
      } else {
        setResult({
          type:    'error',
          message: response.error || 'No se pudo enviar el mensaje. Verificá la conexión.',
        })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error desconocido al enviar'
      setResult({ type: 'error', message: msg })
    } finally {
      setSending(false)
    }
  }

  // Enviar con Enter
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !sending) {
      void handleSend()
    }
  }

  return (
    <>
      {/* Overlay oscuro */}
      <div
        onClick={onClose}
        style={{
          position:        'fixed',
          inset:           0,
          backgroundColor: 'rgba(0,0,0,0.7)',
          zIndex:          1000,
          backdropFilter:  'blur(4px)',
        }}
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="test-modal-title"
        style={{
          position:        'fixed',
          top:             '50%',
          left:            '50%',
          transform:       'translate(-50%, -50%)',
          zIndex:          1001,
          width:           '100%',
          maxWidth:        440,
          backgroundColor: '#0b1120',
          border:          '1px solid rgba(255,255,255,0.1)',
          borderRadius:    14,
          boxShadow:       '0 24px 64px rgba(0,0,0,0.6)',
          padding:         28,
        }}
      >
        {/* Header */}
        <div
          style={{
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'space-between',
            marginBottom:   24,
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
                backgroundColor: 'rgba(37,211,102,0.12)',
              }}
            >
              <Send size={17} color="#25D366" />
            </div>
            <div>
              <h2
                id="test-modal-title"
                style={{
                  fontSize:   16,
                  fontWeight: 600,
                  color:      'var(--text-primary)',
                  margin:     0,
                }}
              >
                Mensaje de prueba
              </h2>
              <p
                style={{
                  fontSize: 12,
                  color:    'var(--text-muted)',
                  margin:   '2px 0 0',
                }}
              >
                Verificá que tu conexión funciona correctamente
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              display:         'flex',
              alignItems:      'center',
              justifyContent:  'center',
              width:           32,
              height:          32,
              borderRadius:    8,
              border:          'none',
              backgroundColor: 'rgba(255,255,255,0.06)',
              color:           'var(--text-muted)',
              cursor:          'pointer',
              transition:      'background-color 0.2s',
              flexShrink:      0,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.1)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.06)' }}
            aria-label="Cerrar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Campo de teléfono */}
        <div style={{ marginBottom: 20 }}>
          <label
            htmlFor="test-phone"
            style={{
              display:      'block',
              fontSize:     12,
              fontWeight:   500,
              color:        'var(--text-secondary)',
              marginBottom: 8,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            Número de destino
          </label>

          <div style={{ position: 'relative' }}>
            <Phone
              size={16}
              style={{
                position:  'absolute',
                left:      12,
                top:       '50%',
                transform: 'translateY(-50%)',
                color:     'var(--text-muted)',
                pointerEvents: 'none',
              }}
            />
            <input
              ref={inputRef}
              id="test-phone"
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="+54 9 11 1234-5678"
              disabled={sending}
              style={{
                width:           '100%',
                padding:         '11px 12px 11px 38px',
                borderRadius:    8,
                border:          '1px solid rgba(255,255,255,0.12)',
                backgroundColor: 'rgba(255,255,255,0.04)',
                color:           'var(--text-primary)',
                fontSize:        14,
                outline:         'none',
                boxSizing:       'border-box',
                transition:      'border-color 0.2s',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'rgba(37,211,102,0.5)' }}
              onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)' }}
            />
          </div>

          <p
            style={{
              fontSize: 11,
              color:    'var(--text-muted)',
              margin:   '6px 0 0',
            }}
          >
            Sugerencia: incluí el prefijo internacional, ej. <strong>+54 9 11…</strong> para Argentina
          </p>
        </div>

        {/* Resultado inline */}
        {result && (
          <div
            style={{
              display:         'flex',
              alignItems:      'flex-start',
              gap:             10,
              padding:         '12px 14px',
              borderRadius:    8,
              marginBottom:    20,
              backgroundColor: result.type === 'success'
                ? 'rgba(34,197,94,0.1)'
                : 'rgba(239,68,68,0.1)',
              border: `1px solid ${result.type === 'success'
                ? 'rgba(34,197,94,0.25)'
                : 'rgba(239,68,68,0.25)'}`,
            }}
          >
            {result.type === 'success' ? (
              <CheckCircle size={16} color="#22c55e" style={{ flexShrink: 0, marginTop: 1 }} />
            ) : (
              <AlertCircle size={16} color="#ef4444" style={{ flexShrink: 0, marginTop: 1 }} />
            )}
            <span
              style={{
                fontSize:   13,
                color:      result.type === 'success' ? '#22c55e' : '#ef4444',
                lineHeight: 1.5,
              }}
            >
              {result.message}
            </span>
          </div>
        )}

        {/* Botones */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onClose}
            style={{
              flex:            1,
              padding:         '10px 0',
              borderRadius:    8,
              border:          '1px solid rgba(255,255,255,0.12)',
              backgroundColor: 'rgba(255,255,255,0.04)',
              color:           'var(--text-secondary)',
              fontSize:        14,
              fontWeight:      500,
              cursor:          'pointer',
              transition:      'all 0.2s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.08)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.04)' }}
          >
            Cancelar
          </button>

          <button
            onClick={() => void handleSend()}
            disabled={sending || !phone.trim()}
            style={{
              flex:            2,
              display:         'inline-flex',
              alignItems:      'center',
              justifyContent:  'center',
              gap:             8,
              padding:         '10px 0',
              borderRadius:    8,
              border:          'none',
              backgroundColor: sending || !phone.trim()
                ? 'rgba(37,211,102,0.35)'
                : '#25D366',
              color:           '#fff',
              fontSize:        14,
              fontWeight:      600,
              cursor:          sending || !phone.trim() ? 'not-allowed' : 'pointer',
              transition:      'all 0.2s',
            }}
          >
            {sending ? (
              <>
                <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                Enviando…
              </>
            ) : (
              <>
                <Send size={15} />
                Enviar mensaje de prueba
              </>
            )}
          </button>
        </div>

        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    </>
  )
}

export default WhatsAppTestMessageModal
