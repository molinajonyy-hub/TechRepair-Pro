import React, { createContext, useContext, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppWakeUp, type AppStatus, emitWakeUp } from '../hooks/useAppWakeUp'
import { supabase } from '../lib/supabase'

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
  const navigate = useNavigate()
  const refreshRef = useRef<() => void>(() => {})

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
  }, [addToast])

  const handleSessionExpired = useCallback(() => {
    addToast('Tu sesión venció. Redirigiendo al login…', 'error', 4000)
    setTimeout(() => navigate('/login'), 2000)
  }, [addToast, navigate])

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
    onSessionExpired: handleSessionExpired,
    onStatusChange: handleStatusChange,
  })

  // Manual reconnect: refresh session + emit wake-up
  const manualRefresh = useCallback(async () => {
    setStatus('updating')
    addToast('Reconectando sistema…', 'info', 2000)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        const { error } = await supabase.auth.refreshSession()
        if (error) { handleSessionExpired(); return }
      }
      setStatus('online')
      setLastRefresh(new Date())
      emitWakeUp()
      addToast('Sistema reconectado correctamente', 'success', 3000)
    } catch {
      setStatus('reconnecting')
      addToast('No se pudo reconectar. Verificá tu conexión.', 'error', 4000)
    }
  }, [addToast, handleSessionExpired])

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
