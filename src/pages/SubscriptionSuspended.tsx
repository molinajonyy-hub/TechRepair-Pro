/**
 * SubscriptionSuspended.tsx
 *
 * Full-screen wall shown when subscription_status = suspended | canceled.
 * Blocks access to the rest of the app.
 *
 * BETA-1 — «suspended» cubre dos historias: un trial que venció sin que nadie
 * pagara nada y una suscripción paga que dejó de cobrarse. La pantalla ya no
 * asume la segunda: `classifySubscriptionWall` las separa y el copy sale de
 * `describeSubscriptionWall`. Con el checkout apagado la salida es Ayuda.
 */
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { Clock, Lock, Zap, LogOut } from 'lucide-react'
import { useSubscription } from '../hooks/useSubscription'
import { useAuth } from '../contexts/AuthContext'
import { isBillingCheckoutEnabled } from '../config/betaBilling'
import { classifySubscriptionWall, describeSubscriptionWall } from '../lib/subscriptionWall'
import { SupportContactButton } from '../components/ui/SupportContactButton'

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

  const view = describeSubscriptionWall(kind, isBillingCheckoutEnabled())
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
        {view.primary === 'plans' && (
          <button
            onClick={() => navigate('/subscription/plans')}
            className="btn btn-primary btn-lift"
            style={{ justifyContent: 'center', padding: '0.875rem', fontSize: '1rem' }}
          >
            <Zap size={18} />
            {view.plansLabel}
          </button>
        )}

        {/* Ayuda — el CTA primario mientras el checkout está apagado; con el
            checkout prendido queda como alternativa debajo de Planes. */}
        <SupportContactButton
          data-testid="subscription-wall-help"
          className={view.primary === 'help' ? 'btn btn-primary btn-lift' : 'btn btn-ghost'}
          style={{ padding: '0.875rem', fontSize: view.primary === 'help' ? '1rem' : undefined }}
        />

        <button
          onClick={() => signOut()}
          className="btn btn-ghost"
          style={{ justifyContent: 'center', padding: '0.75rem' }}
        >
          <LogOut size={16} />
          Cerrar sesión
        </button>
      </div>

      {/* PRE-BETA-2D fijó acá el contacto canónico. BETA-1: la casilla legal no
          es un canal atendido, así que la línea ya no la ofrece como soporte —
          lleva a Ayuda, que `SubscriptionGuard` deja abierta con el negocio
          bloqueado. */}
      <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', maxWidth: 400 }} data-testid="subscription-suspended-soporte">
        ¿Necesitás otra cosa? Entrá a{' '}
        <Link
          to="/ayuda"
          // Enlace al final de la frase, con área táctil de 44px.
          style={{ color: 'var(--color-primary-light)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
        >
          Ayuda
        </Link>
      </p>
    </div>
  )
}
