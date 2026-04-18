import { useState, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import {
  getEmbeddedSignupConfig,
  handleEmbeddedSignupCallback,
} from '../../services/whatsappCloudService'

// ──────────────────────────────────────────────────────────────
// Tipos globales para el SDK de Facebook
// ──────────────────────────────────────────────────────────────

declare global {
  interface Window {
    FB: {
      init: (params: {
        appId: string
        cookie: boolean
        xfbml: boolean
        version: string
      }) => void
      login: (
        callback: (response: FacebookAuthResponse) => void,
        options: {
          config_id: string
          response_type: string
          override_default_response_type: boolean
          extras: {
            setup: Record<string, unknown>
            featureType: string
            sessionInfoVersion: string
          }
        }
      ) => void
    }
    fbAsyncInit?: () => void
  }
}

interface FacebookAuthResponse {
  status: 'connected' | 'not_authorized' | 'unknown'
  authResponse?: {
    code?: string
    accessToken?: string
    grantedScopes?: string
    userID?: string
  }
}

// ──────────────────────────────────────────────────────────────
// Props
// ──────────────────────────────────────────────────────────────

interface WhatsAppConnectButtonProps {
  businessId: string
  /** Si ya existe una conexión previa (muestra "Reconectar") */
  hasConnection: boolean
  /** Se llama cuando la conexión se establece con éxito */
  onSuccess: () => void
  /** Se llama si hay un error, con el mensaje de error */
  onError: (message: string) => void
  disabled?: boolean
}

// ──────────────────────────────────────────────────────────────
// Helper: carga el SDK de Facebook dinámicamente
// ──────────────────────────────────────────────────────────────

function loadFacebookSDK(appId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Si ya está cargado, solo inicializamos
    if (window.FB) {
      resolve()
      return
    }

    // Evitamos cargar el script dos veces
    if (document.getElementById('facebook-jssdk')) {
      // El script ya está en el DOM pero FB aún no está listo — esperamos
      const wait = () => {
        if (window.FB) {
          resolve()
        } else {
          setTimeout(wait, 100)
        }
      }
      wait()
      return
    }

    // Configuramos el callback de inicialización antes de cargar el script
    window.fbAsyncInit = () => {
      window.FB.init({
        appId,
        cookie:  true,
        xfbml:   true,
        version: 'v19.0',
      })
      resolve()
    }

    // Inyectamos el script del SDK de Facebook en español de Latinoamérica
    const script = document.createElement('script')
    script.id    = 'facebook-jssdk'
    script.src   = 'https://connect.facebook.net/es_LA/sdk.js'
    script.async = true
    script.defer = true
    script.onerror = () => reject(new Error('No se pudo cargar el SDK de Facebook'))
    document.head.appendChild(script)
  })
}

// ──────────────────────────────────────────────────────────────
// Componente principal
// ──────────────────────────────────────────────────────────────

export function WhatsAppConnectButton({
  businessId,
  hasConnection,
  onSuccess,
  onError,
  disabled = false,
}: WhatsAppConnectButtonProps) {
  const [loading, setLoading] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  const handleConnect = useCallback(async () => {
    if (loading || disabled) return

    setLoading(true)

    try {
      // 1. Obtener configuración de la edge function (app_id y config_id de Meta)
      const { app_id, config_id } = await getEmbeddedSignupConfig()

      // 2. Cargar el SDK de Facebook si no está disponible aún
      await loadFacebookSDK(app_id)

      if (!window.FB) {
        throw new Error('El SDK de Facebook no está disponible')
      }

      // TODO: En producción, los waba_id y phone_number_id vienen del evento
      // window.addEventListener('message', ...) que Meta dispara durante el flujo.
      //
      // Ejemplo de listener:
      //
      // window.addEventListener('message', (event) => {
      //   if (event.origin !== 'https://www.facebook.com') return
      //   try {
      //     const data = JSON.parse(event.data)
      //     if (data.type === 'WA_EMBEDDED_SIGNUP') {
      //       // data.data contiene: waba_id, phone_number_id, etc.
      //       const { waba_id, phone_number_id } = data.data
      //       // Guardar para usar en el callback de FB.login
      //     }
      //   } catch { /* ignorar mensajes que no son JSON */ }
      // })
      //
      // Por ahora usamos valores del authResponse como fallback temporal.

      // 3. Abrir el flujo de Embedded Signup con FB.login
      await new Promise<void>((resolve, reject) => {
        window.FB.login(
          async (response: FacebookAuthResponse) => {
            try {
              if (response.status !== 'connected' || !response.authResponse?.code) {
                // El usuario canceló el flujo o hubo un error de autorización
                reject(new Error('El usuario canceló el proceso de conexión con Meta'))
                return
              }

              const code          = response.authResponse.code!
              // En producción estos valores llegan por el evento 'message' de Meta.
              // Aquí extraemos un fallback del scope si estuvieran disponibles.
              const wabaId        = ''  // Se completa desde el event listener en producción
              const phoneNumberId = ''  // Se completa desde el event listener en producción

              // 4. Llamar al backend para intercambiar el código y guardar la conexión
              const result = await handleEmbeddedSignupCallback(
                businessId,
                code,
                wabaId,
                phoneNumberId
              )

              if (!result.success) {
                reject(new Error(result.error || 'Error al procesar la conexión con Meta'))
                return
              }

              resolve()
            } catch (err) {
              reject(err)
            }
          },
          {
            config_id,
            response_type:                  'code',
            override_default_response_type: true,
            extras: {
              setup:              {},
              featureType:        '',
              sessionInfoVersion: '3',
            },
          }
        )
      })

      // 5. Notificamos éxito al componente padre
      onSuccess()
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : 'Ocurrió un error al conectar con WhatsApp'
      console.error('Error en flujo Embedded Signup:', err)
      onError(message)
    } finally {
      setLoading(false)
    }
  }, [loading, disabled, businessId, onSuccess, onError])

  const label = hasConnection ? 'Reconectar WhatsApp' : 'Conectar WhatsApp'

  return (
    <button
      onClick={handleConnect}
      disabled={disabled || loading}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        display:        'inline-flex',
        alignItems:     'center',
        gap:            10,
        padding:        '11px 20px',
        borderRadius:   8,
        border:         'none',
        cursor:         disabled || loading ? 'not-allowed' : 'pointer',
        fontSize:       14,
        fontWeight:     600,
        letterSpacing:  0.3,
        color:          '#ffffff',
        backgroundColor: disabled || loading
          ? 'rgba(37,211,102,0.45)'
          : isHovered
          ? '#1db954'
          : '#25D366',
        transition:     'background-color 0.2s ease, opacity 0.2s ease',
        opacity:        disabled ? 0.6 : 1,
        width:          '100%',
        justifyContent: 'center',
        boxShadow:      isHovered && !disabled && !loading
          ? '0 4px 16px rgba(37,211,102,0.35)'
          : 'none',
      }}
      title={label}
    >
      {loading ? (
        <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
      ) : (
        /* Ícono "f" de Facebook estilizado */
        <span
          style={{
            display:        'inline-flex',
            alignItems:     'center',
            justifyContent: 'center',
            width:          20,
            height:         20,
            borderRadius:   4,
            backgroundColor: 'rgba(0,0,0,0.2)',
            fontSize:       13,
            fontWeight:     900,
            fontFamily:     'Georgia, serif',
            lineHeight:     1,
            flexShrink:     0,
          }}
        >
          f
        </span>
      )}

      <span>{loading ? 'Conectando con Meta…' : label}</span>

      {/* Animación para el spinner */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </button>
  )
}

export default WhatsAppConnectButton
