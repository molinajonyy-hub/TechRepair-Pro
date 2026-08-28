import React, { createContext, useContext, useState, useCallback, useRef } from 'react'
import { useAppWakeUp, type AppStatus, emitWakeUp } from '../hooks/useAppWakeUp'
import { supabase } from '../lib/supabase'
import { probeSession } from '../lib/sessionSignal'
import { useAuth } from './AuthContext'
import { forcePrefetch } from '../services/refreshCriticalData'

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE-SESSION-1A — Este provider informa CONECTIVIDAD, no autenticación.
//
// Ya no navega a /login ni anuncia «Tu sesión venció». La pérdida real de sesión
// tiene un solo dueño —auth-js → AuthContext → ProtectedRoute— y cuando ocurre,
// ProtectedRoute desmonta MainLayout, que es quien monta este provider. Un
// segundo redirect desde acá sólo podía competir con el canónico: mientras el
// usuario siguiera autenticado, /login lo rebotaba de vuelta al dashboard.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Toast mínimo ─────────────────────────────────────────────────────────────

interface Toast { id: number; message: string; type: 'info' | 'success' | 'error' | 'warning' }

let toastId = 0

// ─── Context ──────────────────────────────────────────────────────────────────

interface SystemStatusContextValue {
  status: AppStatus
  lastRefresh: Date | null
  toasts: Toast[]
  triggerRefresh: () => void
  dismissToast: (id: number) => void
}

const SystemStatusContext = createContext<SystemStatusContextValue>({
  status: 'online',
  lastRefresh: null,
  toasts: [],
  triggerRefresh: () => {},
  dismissToast: () => {},
})

export const useSystemStatus = () => useContext(SystemStatusContext)

// ─── Provider ─────────────────────────────────────────────────────────────────

export function SystemStatusProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AppStatus>('online')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const refreshRef = useRef<() => void>(() => {})
  const { businessId } = useAuth()

  const addToast = useCallback((message: string, type: Toast['type'] = 'info', duration = 3500) => {
    const id = ++toastId
    setToasts(prev => [...prev.slice(-3), { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const handleWakeUp = useCallback(async () => {
    addToast('Actualizando datos del sistema…', 'info', 2500)
    setLastRefresh(new Date())
    if (businessId) forcePrefetch(businessId)
  }, [addToast, businessId])

  const handleStatusChange = useCallback((s: AppStatus) => {
    setStatus(s)
    if (s === 'online' && status !== 'online') {
      addToast('Sistema actualizado', 'success', 2500)
    }
    if (s === 'offline') {
      addToast('Sin conexión. Mostrando datos guardados.', 'warning', 5000)
    }
    if (s === 'reconnecting') {
      addToast('Reconectando…', 'info', 3000)
    }
  }, [addToast, status])

  useAppWakeUp({
    onWakeUp: handleWakeUp,
    onStatusChange: handleStatusChange,
  })

  // Reconexión manual (botón «Reconectar»): revalidar y refrescar datos.
  //
  // MOBILE-SESSION-1A — Tenía el MISMO defecto que el wake-up: sin señal,
  // `getSession()` fallaba, el `refreshSession()` de rescate fallaba también y
  // el botón terminaba mandando al login. Tocar «Reconectar» sin conexión es
  // justamente lo que hace un técnico con señal débil.
  const manualRefresh = useCallback(async () => {
    setStatus('updating')
    addToast('Reconectando sistema…', 'info', 2000)

    const probe = await probeSession(() => supabase.auth.getSession())

    if (probe.kind === 'unreachable') {
      setStatus('reconnecting')
      addToast('Sin conexión. Reintentá cuando vuelva la señal.', 'warning', 4000)
      return
    }

    if (probe.kind === 'absent') {
      // Terminal, y ya lo está resolviendo ProtectedRoute. Acá no se navega.
      setStatus('session_expired')
      return
    }

    setStatus('online')
    setLastRefresh(new Date())
    if (businessId) forcePrefetch(businessId)
    emitWakeUp()
    addToast('Sistema reconectado correctamente', 'success', 3000)
  }, [addToast, businessId])

  refreshRef.current = manualRefresh

  return (
    <SystemStatusContext.Provider value={{ status, lastRefresh, toasts, triggerRefresh: manualRefresh, dismissToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </SystemStatusContext.Provider>
  )
}

// ─── Toast container ──────────────────────────────────────────────────────────

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null
  const colors: Record<Toast['type'], { bg: string; border: string; color: string }> = {
    info:    { bg: 'rgba(99,102,241,0.15)',  border: 'rgba(99,102,241,0.4)',  color: '#c7d2fe' },
    success: { bg: 'rgba(34,197,94,0.12)',   border: 'rgba(34,197,94,0.4)',   color: '#86efac' },
    error:   { bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.4)',   color: '#fca5a5' },
    warning: { bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.4)',  color: '#fcd34d' },
  }
  return (
    <div style={{ position: 'fixed', bottom: '1.5rem', right: '1.5rem', zIndex: 99999, display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 360 }}>
      {toasts.map(t => {
        const c = colors[t.type]
        return (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.75rem 1rem', borderRadius: '0.75rem', background: c.bg, border: `1px solid ${c.border}`, backdropFilter: 'blur(12px)', boxShadow: '0 4px 16px rgba(0,0,0,0.35)', animation: 'slideIn 0.2s ease' }}>
            <span style={{ color: c.color, fontSize: '0.8rem', fontWeight: 600 }}>{t.message}</span>
            <button onClick={() => onDismiss(t.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: c.color, opacity: 0.6, padding: '0.1rem', flexShrink: 0, lineHeight: 1 }}>✕</button>
          </div>
        )
      })}
      <style>{`@keyframes slideIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }`}</style>
    </div>
  )
}
