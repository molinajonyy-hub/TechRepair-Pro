/**
 * SubscriptionSuspended.tsx
 *
 * Full-screen wall shown when subscription_status = suspended | canceled.
 * Blocks access to the rest of the app.
 *
 * BETA-1 — «suspended» cubre dos historias: un trial que venció sin que nadie
 * pagara nada y una suscripción paga que dejó de cobrarse. La pantalla ya no
 * asume la segunda: `classifySubscriptionWall` las separa y el copy sale de
 * `describeSubscriptionWall`. La salida no cambió: el CTA primario va a Planes
 * (y de ahí al checkout). Ayuda es el secundario.
 */
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { Clock, LifeBuoy, Lock, Zap, LogOut } from 'lucide-react'
import { useSubscription } from '../hooks/useSubscription'
import { useAuth } from '../contexts/AuthContext'
import { classifySubscriptionWall, describeSubscriptionWall } from '../lib/subscriptionWall'

const TONE = {
  info:    { color: 'var(--accent-primary)', bg: 'var(--accent-primary-subtle)', badge: 'badge badge-info' },
  danger:  { color: '#f87171',               bg: 'rgba(248,113,113,0.12)',       badge: 'badge badge-error' },
  neutral: { color: '#94a3b8',               bg: 'rgba(148,163,184,0.12)',       badge: 'badge badge-neutral' },
} as const

export function SubscriptionSuspended() {
  const navigate = useNavigate()
  const { signOut } = useAuth()
  const { subscription, loading, isSuspended, isCanceled } = useSubscription()

  // El estado EFECTIVO (con el rescate por override) lo resuelve el hook; el
  // resto del snapshot es el que ya trae `getSubscription`.
  const kind = classifySubscriptionWall({
    ...subscription,
    subscription_status: isCanceled ? 'canceled' : isSuspended ? 'suspended' : null,
  })

  // Sin datos todavía: no adelantar un motivo (antes mostraba «falta de pago»
  // mientras cargaba).
  if (loading && !subscription) return null

  // Trial vigente, activa o en gracia: esta pantalla no es para ese negocio.
  if (kind === 'none') return <Navigate to="/dashboard" replace />

  const view = describeSubscriptionWall(kind)
  const tone = TONE[view.tone]
  const Icon = kind === 'trial_ended' ? Clock : Lock

  return (
    <div
      data-testid="subscription-wall"
      data-wall-kind={kind}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: '100vh', background: 'var(--app-shell-bg)',
        flexDirection: 'column', gap: '2rem', padding: '2rem', textAlign: 'center',
      }}
    >
      {/* Icon */}
      <div style={{
        width: 96, height: 96, borderRadius: '50%',
        background: tone.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={44} color={tone.color} aria-hidden="true" />
      </div>

      {/* Title */}
      <div style={{ maxWidth: 500 }}>
        <h1 style={{ color: 'var(--text-primary)', margin: '0 0 1rem', fontSize: '1.75rem', fontWeight: 700 }}>
          {view.title}
        </h1>
        <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '1rem', lineHeight: 1.6 }}>
          {view.description}
        </p>
      </div>

      {/* Status badge */}
      <span className={tone.badge} style={{ fontSize: '0.875rem', padding: '0.375rem 0.875rem' }}>
        {view.badge}
      </span>

      {/* Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', width: '100%', maxWidth: 320 }}>
        <button
          onClick={() => navigate('/subscription/plans')}
          className="btn btn-primary btn-lift"
          style={{ justifyContent: 'center', padding: '0.875rem', fontSize: '1rem' }}
        >
          <Zap size={18} />
          {view.plansLabel}
        </button>

        {/* PRE-BETA-2D fijó acá el contacto de soporte (y este testid). BETA-1:
            la casilla legal no es un canal atendido, así que en vez del mailto
            lleva a Ayuda, que `SubscriptionGuard` deja abierta con el negocio
            bloqueado. Es el secundario: activar un plan no pasa por soporte. */}
        <div data-testid="subscription-suspended-soporte" style={{ display: 'flex' }}>
          <Link
            to="/ayuda"
            className="btn btn-ghost"
            style={{ flex: 1, justifyContent: 'center', padding: '0.75rem', minHeight: 44 }}
          >
            <LifeBuoy size={16} aria-hidden="true" />
            Necesito ayuda
          </Link>
        </div>

        <button
          onClick={() => signOut()}
          className="btn btn-ghost"
          style={{ justifyContent: 'center', padding: '0.75rem' }}
        >
          <LogOut size={16} />
          Cerrar sesión
        </button>
      </div>
    </div>
  )
}
