import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { getSubscription, getPayments } from '../services/subscriptionService'
import {
  type BusinessSubscription,
  type Payment,
  type SubscriptionStatus,
  type AccessLevel,
  getAccessLevel,
  isAccessAllowed,
} from '../types/subscription'

export interface UseSubscriptionReturn {
  subscription: BusinessSubscription | null
  payments: Payment[]
  loading: boolean
  error: string | null
  accessLevel: AccessLevel
  isAllowed: boolean
  isTrial: boolean
  isActive: boolean
  isPastDue: boolean
  isSuspended: boolean
  isCanceled: boolean
  daysUntilTrialEnd: number | null
  daysUntilGraceEnd: number | null
  daysUntilPeriodEnd: number | null
  refresh: () => Promise<void>
}

function daysBetween(from: string | null | undefined): number | null {
  if (!from) return null
  try {
    const diff = new Date(from).getTime() - new Date().getTime()
    return Math.ceil(diff / (1000 * 60 * 60 * 24))
  } catch {
    return null
  }
}

export function useSubscription(): UseSubscriptionReturn {
  const { businessId } = useAuth()

  // ── Default to NOT loading and NOT blocked ──────────────────
  // This prevents the app from showing blank while subscription loads.
  // We optimistically allow access (trialing) and only block when we have
  // CONFIRMED data from the server saying the account is suspended/canceled.
  const [subscription, setSubscription] = useState<BusinessSubscription | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(false) // ← starts FALSE (not true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!businessId) {
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      setError(null)
      const [sub, pays] = await Promise.all([
        getSubscription(businessId),
        getPayments(businessId),
      ])
      setSubscription(sub)
      setPayments(pays ?? [])
    } catch (err: any) {
      // Don't block the app — subscription errors are non-critical
      console.error('[useSubscription] Load error:', err)
      setError(err?.message ?? 'Error cargando suscripción')
      // Leave subscription as null → status resolves to 'trialing' (safe default)
    } finally {
      setLoading(false)
    }
  }, [businessId])

  useEffect(() => {
    load()

    if (!businessId) return

    // Real-time: react to webhook-triggered DB changes
    let channel: ReturnType<typeof supabase.channel> | null = null
    try {
      channel = supabase
        .channel(`subscription:${businessId}`)
        .on(
          'postgres_changes',
          {
            event:  'UPDATE',
            schema: 'public',
            table:  'businesses',
            filter: `id=eq.${businessId}`,
          },
          () => { load() }
        )
        .on(
          'postgres_changes',
          {
            event:  'INSERT',
            schema: 'public',
            table:  'payments',
            filter: `business_id=eq.${businessId}`,
          },
          () => { load() }
        )
        .subscribe()
    } catch (e) {
      console.warn('[useSubscription] Could not set up realtime channel:', e)
    }

    return () => {
      try { channel?.unsubscribe() } catch { /* ignore */ }
    }
  }, [businessId, load])

  // ── Status resolution ───────────────────────────────────────
  // When subscription is null (not yet loaded, or migration not run):
  // → default to 'trialing' so the app stays accessible.
  // We only hard-block (suspended/canceled) when we have EXPLICIT confirmed data.
  const rawStatus = subscription?.subscription_status as SubscriptionStatus | undefined
  const status: SubscriptionStatus = rawStatus ?? 'trialing'

  const accessLevel = getAccessLevel(status)

  return {
    subscription,
    payments,
    loading,
    error,
    accessLevel,
    isAllowed:    isAccessAllowed(status),
    isTrial:      status === 'trialing',
    isActive:     status === 'active',
    isPastDue:    status === 'past_due',
    // Only true when we have confirmed data AND status is suspended/canceled
    isSuspended:  subscription !== null && status === 'suspended',
    isCanceled:   subscription !== null && status === 'canceled',
    daysUntilTrialEnd:  daysBetween(subscription?.trial_ends_at),
    daysUntilGraceEnd:  daysBetween(subscription?.grace_until),
    daysUntilPeriodEnd: daysBetween(subscription?.current_period_end),
    refresh: load,
  }
}
