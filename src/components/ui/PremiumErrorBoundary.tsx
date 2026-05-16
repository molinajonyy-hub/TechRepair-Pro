/**
 * PremiumErrorBoundary — Error Boundary global con UI premium.
 *
 * Atrapa crashes de React en el subárbol que envuelve, evitando que
 * un error local destruya toda la app. Muestra un fallback con:
 * - mensaje contextual
 * - botón de retry (re-mount del subárbol)
 * - botón de reload completo
 * - detalle técnico colapsable (solo dev)
 * - logging al buffer de errores
 *
 * Uso básico (wraps toda la app):
 *   <PremiumErrorBoundary>
 *     <AppContent />
 *   </PremiumErrorBoundary>
 *
 * Uso localizado (wraps un modal/componente crítico):
 *   <PremiumErrorBoundary context="ComprobanteProModal" compact>
 *     <ComprobanteProModal ... />
 *   </PremiumErrorBoundary>
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logger } from '../../lib/logger'

// ─── Props y State ────────────────────────────────────────────────────────────

interface Props {
  children:    ReactNode
  /** Nombre del contexto para mejor diagnóstico */
  context?:    string
  /** Fallback compacto para errores dentro de modales */
  compact?:    boolean
  /** JSX personalizado de fallback (reemplaza el default) */
  fallback?:   (reset: () => void) => ReactNode
}

interface State {
  hasError:   boolean
  error:      Error | null
  errorInfo:  ErrorInfo | null
  retryCount: number
}

// ─── Componente ───────────────────────────────────────────────────────────────

export class PremiumErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError:   false,
    error:      null,
    errorInfo:  null,
    retryCount: 0,
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const ctx = (this.props.context ?? 'GENERAL') as any
    logger.error(ctx, `React crash: ${error.message}`, { error, componentStack: errorInfo.componentStack })
    this.setState({ errorInfo })
  }

  reset = () => {
    this.setState(prev => ({
      hasError:   false,
      error:      null,
      errorInfo:  null,
      retryCount: prev.retryCount + 1,
    }))
  }

  render() {
    const { hasError, error, errorInfo, retryCount } = this.state
    const { children, context, compact, fallback } = this.props

    if (!hasError) {
      return <>{children}</>
    }

    if (fallback) {
      return <>{fallback(this.reset)}</>
    }

    if (compact) {
      return <CompactFallback error={error} onRetry={this.reset} />
    }

    return (
      <FullFallback
        error={error}
        errorInfo={errorInfo}
        context={context}
        retryCount={retryCount}
        onRetry={this.reset}
      />
    )
  }
}

// ─── Fallback compacto — para modales / paneles ───────────────────────────────

function CompactFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  return (
    <div style={{
      padding: '1.5rem', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: '0.875rem',
      background: 'rgba(239,68,68,0.06)', borderRadius: '0.875rem',
      border: '1px solid rgba(239,68,68,0.2)', margin: '0.75rem',
    }}>
      <div style={{ fontSize: '1.5rem', lineHeight: 1 }}>⚠</div>
      <div style={{ textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 700, color: '#f87171' }}>
          Algo salió mal
        </p>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#475569' }}>
          {error?.message ?? 'Error inesperado'}
        </p>
      </div>
      <button
        onClick={onRetry}
        style={{
          padding: '0.4rem 1rem', borderRadius: '9999px',
          background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
          color: '#f87171', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer',
        }}
      >
        Reintentar
      </button>
    </div>
  )
}

// ─── Fallback completo — para crashes globales ────────────────────────────────

interface FullFallbackProps {
  error:      Error | null
  errorInfo:  ErrorInfo | null
  context?:   string
  retryCount: number
  onRetry:    () => void
}

function FullFallback({ error, errorInfo, context, retryCount, onRetry }: FullFallbackProps) {
  const isDev = import.meta.env.DEV

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: '#071018', fontFamily: "'Inter',-apple-system,sans-serif",
      padding: '1.5rem', zIndex: 99999,
    }}>
      <div style={{
        width: '100%', maxWidth: 480, background: '#0a1628',
        border: '1px solid rgba(239,68,68,0.2)', borderRadius: '1.25rem',
        padding: '2rem', boxShadow: '0 40px 80px rgba(0,0,0,0.8)',
      }}>
        {/* Icono */}
        <div style={{
          width: 56, height: 56, borderRadius: '50%', margin: '0 auto 1.25rem',
          background: 'rgba(239,68,68,0.1)', border: '1.5px solid rgba(239,68,68,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '1.5rem', lineHeight: 1,
        }}>⚠</div>

        {/* Mensaje */}
        <h2 style={{ margin: '0 0 0.5rem', textAlign: 'center', color: '#f8fafc', fontSize: '1.125rem', fontWeight: 800 }}>
          Algo salió mal
        </h2>
        <p style={{ margin: '0 0 1.5rem', textAlign: 'center', color: '#475569', fontSize: '0.875rem', lineHeight: 1.6 }}>
          Ocurrió un error inesperado
          {context ? ` en ${context}` : ''}.
          {retryCount > 0 && ` (intento ${retryCount})`}
        </p>

        {/* Acciones */}
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
          <button
            onClick={onRetry}
            style={{
              flex: 1, padding: '0.75rem', borderRadius: '0.75rem', border: 'none',
              background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff',
              fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
            }}
          >
            Reintentar
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              flex: 1, padding: '0.75rem', borderRadius: '0.75rem',
              border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)',
              color: '#94a3b8', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
            }}
          >
            Recargar página
          </button>
        </div>

        {/* Detalle técnico (solo dev) */}
        {isDev && error && (
          <details style={{ marginTop: '0.75rem' }}>
            <summary style={{
              fontSize: '0.72rem', color: '#334155', cursor: 'pointer',
              fontFamily: 'monospace', userSelect: 'none',
            }}>
              Detalle técnico ↓
            </summary>
            <div style={{
              marginTop: '0.625rem', padding: '0.75rem', borderRadius: '0.5rem',
              background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.06)',
              maxHeight: 240, overflowY: 'auto',
            }}>
              <pre style={{ margin: 0, fontSize: '0.65rem', color: '#f87171', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {error.message}
                {'\n\n'}
                {errorInfo?.componentStack}
              </pre>
            </div>
          </details>
        )}
      </div>
    </div>
  )
}
