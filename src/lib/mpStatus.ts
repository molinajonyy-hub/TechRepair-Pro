/**
 * mpStatus.ts — Pure, framework-free helpers for Mercado Pago ↔ internal status.
 *
 * Centralizes the fragile string comparisons that were scattered across the
 * codebase (status === 'approved', status !== 'cancelled', etc.). No Vite/Deno
 * imports here so it is unit-testable under `node --test`.
 *
 * The server remains the source of truth for activation: these helpers only
 * normalize/derive — they NEVER decide a payment is real from a browser param.
 */

export type MpPaymentStatus =
  | 'approved' | 'pending' | 'in_process' | 'rejected'
  | 'cancelled' | 'refunded' | 'charged_back'

export type MpPreapprovalStatus = 'authorized' | 'paused' | 'cancelled' | 'pending'

export type InternalSubscriptionStatus =
  | 'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled' | 'pending_activation'

/** Normalize an arbitrary MP payment status string to a known value. */
export function normalizeMercadoPagoStatus(raw: string | null | undefined): MpPaymentStatus {
  const v = (raw ?? '').trim().toLowerCase()
  const allowed: MpPaymentStatus[] = ['approved', 'pending', 'in_process', 'rejected', 'cancelled', 'refunded', 'charged_back']
  return (allowed as string[]).includes(v) ? (v as MpPaymentStatus) : 'pending'
}

// BETA-MP: el mapeo «estado del preapproval → estado del negocio» NO vive en el
// cliente. Hay un único lugar que lo decide, del lado servidor:
// `supabase/functions/_shared/billing/preapproval.ts` (applyPreapprovalEvidence),
// que comparten el webhook y `reconcile`. Acá existía una copia que nadie usaba
// y que además mandaba `pending` a `pending_activation`.

/** Is the trial window expired? (true only when trialing AND past trial_ends_at). */
export function isTrialExpired(
  status: InternalSubscriptionStatus,
  trialEndsAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (status !== 'trialing') return false
  if (!trialEndsAt) return false
  const end = new Date(trialEndsAt).getTime()
  if (Number.isNaN(end)) return false
  return end < now.getTime()
}

/** Trial access = trialing AND not expired. */
export function hasTrialAccess(
  status: InternalSubscriptionStatus,
  trialEndsAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  return status === 'trialing' && !isTrialExpired(status, trialEndsAt, now)
}

/** Paid/active access (any access_source). Past due is grace, still allowed. */
export function hasActivePaidAccess(status: InternalSubscriptionStatus): boolean {
  return status === 'active' || status === 'past_due'
}

/**
 * Effective access decision combining status + trial expiry. Returns false for
 * suspended/canceled/pending_activation and for trials that have expired.
 */
export function isAccessEffective(
  status: InternalSubscriptionStatus,
  trialEndsAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (status === 'active' || status === 'past_due') return true
  if (status === 'trialing') return hasTrialAccess(status, trialEndsAt, now)
  return false
}
