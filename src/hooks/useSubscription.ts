import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { getSubscription, getPayments } from '../services/subscriptionService'

// ─── Cache de suscripción (TTL 45s, stale-while-revalidate) ──────────────────
interface CacheEntry {
  subscription: import('../types/subscription').BusinessSubscription | null
  payments:     import('../types/subscription').Payment[]
  fetchedAt:    number
}
const CACHE_TTL_MS = 45_000
const _cache = new Map<string, CacheEntry>()
import {
  type BusinessSubscription,
  type Payment,
  type SubscriptionStatus,
  type AccessLevel,
  getAccessLevel,
  isAccessAllowed,
} from '../types/subscription'
import {
  type PlanId,
  type PlanFeature,
  type PlanFeatureSet,
  PLAN_FEATURES,
  TRIAL_FEATURES,
} from '../config/planFeatures'

export interface UseSubscriptionReturn {
  subscription:  BusinessSubscription | null
  payments:      Payment[]
  loading:       boolean
  error:         string | null
  accessLevel:   AccessLevel
  isAllowed:     boolean
  isTrial:       boolean
  isActive:      boolean
  isPastDue:     boolean
  isSuspended:   boolean
  isCanceled:    boolean
  // ── Plan-level feature control ──
  currentPlan:   PlanId | null
  planFeatures:  PlanFeatureSet
  isBasic:       boolean
  isPro:         boolean
  isFull:        boolean
  maxUsers:      number
  hasFeature:    (feature: PlanFeature) => boolean
  // ──────────────────────────────
  daysUntilTrialEnd:  number | null
  daysUntilGraceEnd:  number | null
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
  const cached = businessId ? _cache.get(businessId) : undefined
  const [subscription, setSubscription] = useState<BusinessSubscription | null>(cached?.subscription ?? null)
  const [payments, setPayments] = useState<Payment[]>(cached?.payments ?? [])
  const [loading, setLoading] = useState(!cached) // false si hay cache
  const [error, setError] = useState<string | null>(null)
  const revalidating = useRef(false)

  const load = useCallback(async (background = false) => {
    if (!businessId) { setLoading(false); return }

    // Stale-while-revalidate: si hay cache válida, no bloquear UI
    const entry = _cache.get(businessId)
    const isFresh = entry && (Date.now() - entry.fetchedAt < CACHE_TTL_MS)
    if (isFresh && background) return           // ya está fresco
    if (isFresh && !background) {               // usar cache inmediatamente
      setSubscription(entry.subscription)
      setPayments(entry.payments)
      setLoading(false)
      // revalidar en background igual
      if (revalidating.current) return
      revalidating.current = true
      load(true).finally(() => { revalidating.current = false })
      return
    }

    if (!background) setLoading(true)
    try {
      setError(null)
      const [sub, pays] = await Promise.all([
        getSubscription(businessId),
        getPayments(businessId),
      ])
      _cache.set(businessId, { subscription: sub, payments: pays ?? [], fetchedAt: Date.now() })
      setSubscription(sub)
      setPayments(pays ?? [])
    } catch (err: any) {
      console.error('[useSubscription] Load error:', err)
      setError(err?.message ?? 'Error cargando suscripción')
    } finally {
      if (!background) setLoading(false)
    }
  }, [businessId])

  const refresh = useCallback(async () => {
    if (businessId) _cache.delete(businessId) // invalidar cache antes del refresh manual
    await load()
  }, [businessId, load])

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
      try {
        if (channel) supabase.removeChannel(channel)
      } catch { /* ignore */ }
    }
  }, [businessId, load])

  // ── Status resolution ───────────────────────────────────────
  // When subscription is null (not yet loaded, or migration not run):
  // → default to 'trialing' so the app stays accessible.
  // We only hard-block (suspended/canceled) when we have EXPLICIT confirmed data.
  const rawStatus = subscription?.subscription_status as SubscriptionStatus | undefined
  const status: SubscriptionStatus = rawStatus ?? 'trialing'
  const accessLevel = getAccessLevel(status)

  // ── Plan & feature resolution ────────────────────────────────
  const rawPlan = subscription?.subscription_plan as PlanId | undefined | null
  const currentPlan: PlanId | null = rawPlan ?? null

  // During trial → grant Pro features. No plan set → grant Pro as fallback.
  const planFeatures: PlanFeatureSet = status === 'trialing'
    ? TRIAL_FEATURES
    : currentPlan
      ? PLAN_FEATURES[currentPlan]
      : TRIAL_FEATURES

  const hasFeature = (feature: PlanFeature): boolean => {
    if (!isAccessAllowed(status)) return false
    return !!planFeatures[feature]
  }

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
    // Plan-level
    currentPlan,
    planFeatures,
    isBasic:  currentPlan === 'basico',
    isPro:    currentPlan === 'pro',
    isFull:   currentPlan === 'full',
    maxUsers: planFeatures.maxUsers,
    hasFeature,
    // Dates
    daysUntilTrialEnd:  daysBetween(subscription?.trial_ends_at),
    daysUntilGraceEnd:  daysBetween(subscription?.grace_until),
    daysUntilPeriodEnd: daysBetween(subscription?.current_period_end),
    refresh,
  }
}
