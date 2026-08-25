import { useEffect } from 'react'
import { useAuth } from './useAuth'
import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'
import { currencyService } from '../services/currencyService'
import { exchangeRateService } from '../services/exchangeRateService'
import { DOLAR_SOURCES } from '../lib/dollar/quoteSource'

/**
 * Corre una vez por sesión al montar. Si el negocio tiene auto_update_rate=true
 * y la última actualización es más vieja que rate_update_frequency_hours,
 * obtiene la cotización de la fuente CONFIGURADA y la guarda.
 *
 * P0-DÓLAR: antes leía `settings.dolar_source` de una RPC que nunca devolvía la
 * columna, así que el `?? 'nacional'` ganaba siempre y la actualización
 * automática consultaba Bluelytics incluso con Córdoba configurado.
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

        // Última cotización guardada de este negocio (USD/ARS)
        const { data: rateRow } = await supabase
          .from('exchange_rates')
          .select('rate, updated_at')
          .eq('business_id', businessId)
          .eq('base_currency', 'USD')
          .eq('target_currency', 'ARS')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (rateRow?.updated_at) {
          const lastUpdate = new Date(rateRow.updated_at)
          const ageHours = (Date.now() - lastUpdate.getTime()) / 3_600_000
          if (ageHours < freqHours) return // sigue fresca
        }

        if (cancelled) return

        // `dolar_source` ya viene normalizada por currencyService.
        const source     = settings.dolar_source
        const descriptor = DOLAR_SOURCES[source]

        const outcome = await exchangeRateService.fetchQuote(source)
        if (cancelled) return

        if (!outcome.ok) {
          // Falla explícita y trazable. NUNCA se consulta la otra fuente ni se
          // reescriben precios con un valor arbitrario.
          logger.warn('INVENTORY', `Auto-cotización omitida (${descriptor.label}): ${outcome.reason}`, {
            businessId, source, reason: outcome.reason,
          })
          return
        }

        await currencyService.upsertExchangeRate({
          business_id:     businessId!,
          base_currency:   'USD',
          target_currency: 'ARS',
          rate:            outcome.sell,
          is_manual:       false,
          source:          descriptor.rateSourceTag,
        })

        // Sync idempotente: si la cotización no cambió, no reescribe precios.
        await currencyService.syncDollarizedProducts(
          businessId!,
          outcome.sell,
          rateRow?.rate != null ? Number(rateRow.rate) : null,
          descriptor.rateSourceTag,
        )
      } catch (err) {
        // Silencioso — un fallo de auto-update nunca debe interrumpir al usuario
        logger.warn('INVENTORY', 'Auto-cotización falló', err)
      }
    }

    maybeUpdate()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId])
}
