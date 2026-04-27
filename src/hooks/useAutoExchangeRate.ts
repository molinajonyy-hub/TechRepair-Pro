import { useEffect } from 'react'
import { useAuth } from './useAuth'
import { supabase } from '../lib/supabase'
import { currencyService } from '../services/currencyService'
import { exchangeRateService } from '../services/exchangeRateService'

/**
 * Runs once per session on mount. If business settings have auto_update_rate=true
 * and the last update is older than rate_update_frequency_hours, silently fetches
 * the blue dollar and saves it.
 */
export function useAutoExchangeRate() {
  const { businessId } = useAuth()

  useEffect(() => {
    if (!businessId) return
    let cancelled = false

    async function maybeUpdate() {
      try {
        const settings = await currencyService.getBusinessSettings()
        if (!settings?.auto_update_rate) return

        const freqHours = settings.rate_update_frequency_hours ?? 24

        // Get last updated_at for this business's USD/ARS rate
        const { data: rateRow } = await supabase
          .from('exchange_rates')
          .select('updated_at')
          .eq('business_id', businessId)
          .eq('base_currency', 'USD')
          .eq('target_currency', 'ARS')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (rateRow?.updated_at) {
          const lastUpdate = new Date(rateRow.updated_at)
          const ageHours = (Date.now() - lastUpdate.getTime()) / 3_600_000
          if (ageHours < freqHours) return // still fresh
        }

        if (cancelled) return

        const source = (settings.dolar_source as 'nacional' | 'cordoba') ?? 'nacional'
        const newRate = await exchangeRateService.getDolarRate(source)
        if (!newRate || cancelled) return

        await currencyService.upsertExchangeRate({
          business_id: businessId!,
          base_currency: 'USD',
          target_currency: 'ARS',
          rate: newRate,
          is_manual: false,
          source: source === 'cordoba' ? 'infodolar-cordoba' : 'bluelytics',
        })
      } catch (err) {
        // Silent — auto-update failure should never interrupt the user
        console.warn('[autoExchangeRate] update failed:', err)
      }
    }

    maybeUpdate()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId])
}
