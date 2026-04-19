export type DolarSource = 'nacional' | 'cordoba'

// ── Helpers de parseo ─────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseArgPrice(s: string): number | null {
  const clean = s.replace(/[$\s.]/g, '').replace(',', '.')
  const n = parseFloat(clean)
  return isFinite(n) && n >= 500 && n <= 9999 ? n : null
}

function extractBlueVenta(html: string): number | null {
  const text = stripHtml(html)

  // Buscar la sección "blue" y tomar el mayor precio (venta > compra)
  const idx = text.search(/\bblue\b/i)
  if (idx !== -1) {
    const seg = text.slice(idx, idx + 700)
    const matches = [...seg.matchAll(/\b(\d{3,5}(?:[.,]\d{0,3})?)\b/g)]
    const prices: number[] = []
    for (const m of matches) {
      const p = parseArgPrice(m[1])
      if (p) prices.push(p)
    }
    if (prices.length >= 2) return Math.max(...prices) // venta es el más alto
    if (prices.length === 1) return prices[0]
  }

  // Fallback: "venta" cerca de "blue" en el HTML crudo
  const raw = html.match(/blue[^]*?venta[^$]*?(\$?\s*[\d.,]+)/i)
  if (raw) {
    const p = parseArgPrice(raw[1])
    if (p) return p
  }

  return null
}

// ── Servicio ──────────────────────────────────────────────────────────────────

export const exchangeRateService = {
  /**
   * Dólar Blue Nacional — Bluelytics API (CORS-friendly, JSON directo)
   */
  async getDolarBlueNacional(): Promise<number | null> {
    try {
      const res = await fetch('https://api.bluelytics.com.ar/v2/latest')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      return data.blue?.value_sell ?? null
    } catch (err) {
      console.error('[exchangeRate] Nacional:', err)
      return null
    }
  },

  /**
   * Dólar Blue Córdoba — infodolar.com via proxy CORS (sin Edge Function)
   * Usa allorigins.win como proxy, parsea el HTML del lado del cliente.
   * Estrategia 2: dolarapi.com como fallback si falla el scraping.
   */
  async getDolarBlueCordoba(): Promise<number | null> {
    // ── Intento 1: scraping de infodolar.com via proxy CORS ──────────────────
    try {
      const target = 'https://www.infodolar.com/cotizacion-dolar-provincia-cordoba.aspx'
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(target)}`

      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error('proxy HTTP ' + res.status)

      const json = await res.json()
      const html: string = json.contents ?? ''

      if (!html) throw new Error('respuesta vacía del proxy')

      const rate = extractBlueVenta(html)
      if (rate) {
        console.log('[exchangeRate] Córdoba via infodolar.com:', rate)
        return rate
      }
      throw new Error('No se pudo extraer el precio del HTML')
    } catch (err) {
      console.warn('[exchangeRate] infodolar.com falló, usando fallback nacional:', err)
    }

    // ── Fallback: Bluelytics (blue nacional como aproximación) ───────────────
    return this.getDolarBlueNacional()
  },

  /**
   * Obtener tasa según fuente configurada por el negocio
   */
  async getDolarRate(source: DolarSource = 'nacional'): Promise<number | null> {
    return source === 'cordoba'
      ? this.getDolarBlueCordoba()
      : this.getDolarBlueNacional()
  },

  /** @deprecated usa getDolarRate(source) */
  async getAmbitoDolarRate(): Promise<number | null> {
    return this.getDolarBlueNacional()
  },

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
