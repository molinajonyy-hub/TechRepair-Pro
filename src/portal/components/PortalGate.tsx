import type { ReactNode } from 'react'
import { RefreshCw, RotateCw } from 'lucide-react'
import { usePortal } from '../contexts/PortalContext'
import { hardReload } from '../../hooks/useUpdateDetector'
import {
  PORTAL_ERROR_MESSAGE, suggestsHardReload,
  type PortalLoadErrorReason,
} from '../portalPublicContract'
import { PT, PortalButton } from './PortalLayout'

// ─── Estados terminales del portal, resueltos en el SHELL ────────────────────
//
// Antes vivían dentro de PortalEntry, así que sólo se veían en la ruta índice:
// entrar directo a /catalogo con un slug inexistente renderizaba el catálogo
// con `business` en null. Y, sobre todo, no existía el estado de ERROR: un 42501
// —la respuesta esperada de un bundle viejo después del lockdown de FASE 2— se
// leía como «Portal no disponible», que es falso (el portal existe; lo viejo es
// el cliente) y no ofrecía ninguna salida.
//
// El gate NO intercepta el loading: cada página ya tiene su propio manejo
// (PortalLogin deshabilita el botón, PortalEntry muestra el spinner) y
// centralizarlo acá cambiaría esa UX sin necesidad.

function PortalScreen({ children }: { children: ReactNode }) {
  return (
    <div
      data-theme="light"
      style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: PT.bg, fontFamily: PT.font, color: PT.text,
        flexDirection: 'column', gap: '1rem', padding: '2rem', textAlign: 'center',
      }}
    >
      {children}
    </div>
  )
}

/** Slug inexistente o portal apagado. No es un fallo: es la respuesta. */
export function PortalUnavailableScreen() {
  return (
    <PortalScreen>
      <div data-testid="portal-unavailable" style={{ display: 'contents' }}>
        <div style={{ fontSize: '3rem' }}>🔒</div>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: PT.text, margin: 0 }}>
          Portal no disponible
        </h1>
        <p style={{ color: PT.textSub, margin: 0 }}>Este portal no existe o no está habilitado.</p>
      </div>
    </PortalScreen>
  )
}

/**
 * Fallo terminal de carga.
 *
 * El texto sale SIEMPRE de PORTAL_ERROR_MESSAGE, un mapa cerrado: nunca se
 * interpola `error.message`, así que ni un nombre de tabla ni un fragmento de
 * SQL pueden llegar a la pantalla. `data-reason` queda para los tests y para
 * soporte; es un enum, no el mensaje del servidor.
 */
export function PortalErrorScreen({
  reason, onRetry, retrying = false,
}: {
  reason: PortalLoadErrorReason
  onRetry: () => void
  retrying?: boolean
}) {
  const ofreceRecarga = suggestsHardReload(reason)

  return (
    <PortalScreen>
      <div data-testid="portal-error" data-reason={reason} style={{ display: 'contents' }}>
        <div style={{ fontSize: '3rem' }}>⚠️</div>
        <h1 style={{ fontSize: '1.375rem', fontWeight: 700, color: PT.text, margin: 0 }}>
          No pudimos cargar el portal
        </h1>
        <p data-testid="portal-error-message" style={{ color: PT.textSub, margin: 0, maxWidth: 420 }}>
          {PORTAL_ERROR_MESSAGE[reason]}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', width: '100%', maxWidth: 280, marginTop: '0.5rem' }}>
          {/* «Actualizar» sólo cuando el diagnóstico es un bundle viejo (42501).
              Con la red caída, recargar da una pantalla en blanco. */}
          {ofreceRecarga && (
            <PortalButton onClick={hardReload}>
              <RefreshCw size={16} />
              Actualizar
            </PortalButton>
          )}
          <PortalButton
            onClick={onRetry}
            loading={retrying}
            variant={ofreceRecarga ? 'ghost' : 'primary'}
          >
            <RotateCw size={16} />
            Reintentar
          </PortalButton>
        </div>
      </div>
    </PortalScreen>
  )
}

/**
 * Corta el árbol del portal antes de las rutas cuando el negocio no se pudo
 * resolver. Ningún estado terminal puede quedarse en spinner.
 */
export function PortalGate({ children }: { children: ReactNode }) {
  const { notFound, loadError, retryBusiness, bizLoading } = usePortal()

  // El error gana sobre notFound: si la carga falló, no sabemos si el portal
  // existe, y afirmar que no existe sería inventar.
  if (loadError) {
    return <PortalErrorScreen reason={loadError} onRetry={retryBusiness} retrying={bizLoading} />
  }
  if (notFound) return <PortalUnavailableScreen />

  return <>{children}</>
}
