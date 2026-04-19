export type DolarSource = 'nacional' | 'cordoba'

export const exchangeRateService = {
  /**
   * Dólar Blue Nacional — API de Bluelytics (CORS-friendly)
   */
  async getDolarBlueNacional(): Promise<number | null> {
    try {
      const response = await fetch('https://api.bluelytics.com.ar/v2/latest')
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const data = await response.json()
      const rate = data.blue?.value_sell
      return rate ?? null
    } catch (error) {
      console.error('[exchangeRate] Error obteniendo dólar blue nacional:', error)
      return null
    }
  },

  /**
   * Dólar Blue Córdoba — via Supabase Edge Function (scraping server-side de infodolar.com)
   */
  async getDolarBlueCordoba(): Promise<number | null> {
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
      const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string
      if (!supabaseUrl || !supabaseKey) throw new Error('Variables de Supabase no configuradas')

      const response = await fetch(`${supabaseUrl}/functions/v1/get-dolar-cordoba`, {
        headers: {
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) throw new Error('HTTP ' + response.status)
      const data = await response.json()
      if (data.error) throw new Error(data.error)
      return data.rate ?? null
    } catch (error) {
      console.error('[exchangeRate] Error obteniendo dólar blue Córdoba:', error)
      return null
    }
  },

  /**
   * Obtener tasa según fuente configurada
   */
  async getDolarRate(source: DolarSource = 'nacional'): Promise<number | null> {
    if (source === 'cordoba') {
      const rate = await this.getDolarBlueCordoba()
      if (rate) return rate
      // Fallback al nacional si falla Córdoba
      console.warn('[exchangeRate] Falló Córdoba, usando nacional como fallback')
      return this.getDolarBlueNacional()
    }
    return this.getDolarBlueNacional()
  },

  /** @deprecated usa getDolarRate(source) */
  async getAmbitoDolarRate(): Promise<number | null> {
    return this.getDolarBlueNacional()
  },

  /**
   * Formatear fecha de actualización
   */
  formatLastUpdate(date: Date): string {
    return date.toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  },
}
