/**
 * featureAnalyticsService — Consultas de analytics sobre blocked_feature_attempts.
 * Muestra qué features se intentan más → qué upgrades tienen más potencial.
 */

import { supabase } from '../lib/supabase'

export interface FeatureAttemptStat {
  feature:      string
  attempts:     number
  unique_users: number
  current_plan: string | null
  last_attempt: string
}

/** Top features bloqueadas del negocio, ordenadas por intentos. */
export async function getBlockedFeatureStats(
  businessId: string,
  days = 30,
): Promise<FeatureAttemptStat[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const { data, error } = await supabase
    .from('blocked_feature_attempts')
    .select('feature, user_id, current_plan, created_at')
    .eq('business_id', businessId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })

  if (error || !data) return []

  const byFeature = new Map<string, { attempts: number; users: Set<string>; plan: string | null; last: string }>()
  for (const row of data) {
    const key = row.feature
    if (!byFeature.has(key)) byFeature.set(key, { attempts: 0, users: new Set(), plan: row.current_plan, last: row.created_at })
    const entry = byFeature.get(key)!
    entry.attempts++
    if (row.user_id) entry.users.add(row.user_id)
    if (row.created_at > entry.last) entry.last = row.created_at
  }

  return Array.from(byFeature.entries())
    .map(([feature, e]) => ({
      feature,
      attempts:     e.attempts,
      unique_users: e.users.size,
      current_plan: e.plan,
      last_attempt: e.last,
    }))
    .sort((a, b) => b.attempts - a.attempts)
}
