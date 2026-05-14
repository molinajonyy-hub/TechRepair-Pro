import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'

interface CheckItem {
  id:      string
  label:   string
  path:    string
  done:    boolean
}

const STEPS: Omit<CheckItem, 'done'>[] = [
  { id: 'order',     label: 'Crear tu primera orden de reparación', path: '/orders/new' },
  { id: 'inventory', label: 'Agregar un producto al inventario',    path: '/inventory' },
  { id: 'customer',  label: 'Registrar tu primer cliente',          path: '/customers/new' },
  { id: 'cobro',     label: 'Hacer tu primer cobro',                path: '/comprobantes' },
  { id: 'logo',      label: 'Subir el logo del negocio',            path: '/settings' },
]

const STORAGE_KEY = (bizId: string) => `onboarding_done_${bizId}`

export function OnboardingChecklist() {
  const { businessId } = useAuth()
  const navigate = useNavigate()
  const [items, setItems] = useState<CheckItem[]>([])
  const [dismissed, setDismissed] = useState(false)
  const [newBusiness, setNewBusiness] = useState(false)

  useEffect(() => {
    if (!businessId) return
    // Mostrar solo si onboarding_completed = false o negocio tiene < 7 días
    supabase.from('businesses').select('onboarding_completed, created_at').eq('id', businessId).single()
      .then(({ data }) => {
        if (!data) return
        const ageMs   = Date.now() - new Date(data.created_at).getTime()
        const ageDays = ageMs / 86_400_000
        if (data.onboarding_completed && ageDays > 7) return  // ya completó y pasó una semana
        setNewBusiness(true)
        // Cargar progreso guardado
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY(businessId)) || '[]') as string[]
        setItems(STEPS.map(s => ({ ...s, done: saved.includes(s.id) })))
      })
  }, [businessId])

  if (!newBusiness || dismissed || !items.length) return null

  const done  = items.filter(i => i.done).length
  const total = items.length
  const pct   = Math.round((done / total) * 100)
  const allDone = done === total

  const toggle = (id: string) => {
    if (!businessId) return
    setItems(prev => {
      const next = prev.map(i => i.id === id ? { ...i, done: !i.done } : i)
      const doneIds = next.filter(i => i.done).map(i => i.id)
      localStorage.setItem(STORAGE_KEY(businessId), JSON.stringify(doneIds))
      return next
    })
  }

  return (
    <div style={{
      background: '#0f1829',
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: '1rem',
      padding: '1.25rem',
      marginBottom: '1.75rem',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.875rem' }}>
        <div>
          <p style={{ margin: 0, fontWeight: 700, color: '#f1f5f9', fontSize: '0.95rem' }}>
            {allDone ? '¡Completaste los primeros pasos!' : 'Primeros pasos'}
          </p>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: '#64748b' }}>
            {allDone ? 'Tu negocio está configurado.' : `${done} de ${total} completados`}
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#334155', fontSize: '1rem', padding: '0.25rem' }}
          aria-label="Cerrar"
        >✕</button>
      </div>

      {/* Progress bar */}
      <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginBottom: '1rem', overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          width: `${pct}%`,
          background: allDone ? '#22c55e' : '#6366f1',
          borderRadius: 2,
          transition: 'width 0.4s cubic-bezier(0.4,0,0.2,1)',
        }} />
      </div>

      {/* Steps */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
        {items.map(item => (
          <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button
              onClick={() => toggle(item.id)}
              style={{
                width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                background: item.done ? '#6366f1' : 'transparent',
                border: `1.5px solid ${item.done ? '#6366f1' : 'rgba(255,255,255,0.2)'}`,
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}
            >
              {item.done && (
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
            <button
              onClick={() => navigate(item.path)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                textAlign: 'left', padding: 0,
                color: item.done ? '#334155' : '#94a3b8',
                fontSize: '0.82rem',
                textDecoration: item.done ? 'line-through' : 'none',
                transition: 'color 0.15s',
              }}
              onMouseEnter={e => { if (!item.done) e.currentTarget.style.color = '#f1f5f9' }}
              onMouseLeave={e => { if (!item.done) e.currentTarget.style.color = '#94a3b8' }}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
