/**
 * SubscriptionGuard
 *
 * Redirects suspended/canceled businesses to the reactivation screen.
 *
 * Key design decisions:
 * - NEVER blocks access while loading (optimistic rendering)
 * - NEVER blocks if subscription data is null (migration may not be run yet)
 * - ONLY blocks when we have CONFIRMED server data → status suspended | canceled
 * - All /subscription/* and /settings paths are always accessible
 */
import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useSubscription } from '../../hooks/useSubscription'

// Paths that bypass the guard entirely
const ALLOWED_PATHS = ['/subscription', '/settings']

interface Props { children: React.ReactNode }

// ── Inner component — hooks called unconditionally at top level ──
function GuardInner({ children }: Props) {
  const navigate    = useNavigate()
  const location    = useLocation()
  const { isSuspended, isCanceled, loading } = useSubscription()

  const isExempt = ALLOWED_PATHS.some(p => location.pathname.startsWith(p))

  useEffect(() => {
    if (loading || isExempt) return
    if (isSuspended || isCanceled) {
      navigate('/subscription/suspended', { replace: true })
    }
  }, [isSuspended, isCanceled, loading, isExempt, navigate])

  // While loading → render children (never flash blank)
  if (loading || isExempt) return <>{children}</>

  // Confirmed hard-blocked → hide while redirect fires
  if (isSuspended || isCanceled) return null

  return <>{children}</>
}

// ── Public export — catches errors so subscription bugs can't black-screen the app ──
export function SubscriptionGuard({ children }: Props) {
  try {
    return <GuardInner>{children}</GuardInner>
  } catch (e) {
    // If anything in the guard crashes, fail open (show content)
    console.error('[SubscriptionGuard] Error:', e)
    return <>{children}</>
  }
}
