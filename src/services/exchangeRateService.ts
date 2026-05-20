export type DolarSource = 'nacional' | 'cordoba'

/** Compra y venta explícitos de InfoDolar Córdoba. */
export interface CordobaRateDetail {
  compra: number
  venta: number
  /** Siempre 'venta' — nunca se usa compra ni promedio para productos. */
  mode: 'venta'
  /** Estrategia de parseo que tuvo éxito (útil para debugging). */
  strategy: string
}

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

/**
 * Convierte precio en formato argentino a número.
 * Soporta: "1.425,00" → 1425 | "1425" → 1425 | "1.394" → 1394
 */
function parseArgPrice(s: string): number | null {
  const clean = s.replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.')
  const n = parseFloat(clean)
  return isFinite(n) && n >= 500 && n <= 9999 ? n : null
}

/** Regex para precio en formato argentino (sep miles con punto, decimal con coma). */
const PRICE_RE = /\b(\d{1,2}[.]\d{3}(?:[,]\d{1,2})?|\d{3,4}(?:[,]\d{1,2})?)\b/g

/**
 * Parser dedicado para infodolar.com/cotizacion-dolar-provincia-cordoba.aspx
 *
 * Intenta 4 estrategias en orden descendente de especificidad.
 * SIEMPRE retorna compra Y venta por separado — nunca promedio.
 * Retorna null si no puede determinar el valor de venta con certeza.
 */
function extractInfoDolarCordobaRates(html: string): CordobaRateDetail | null {
  // ── Estrategia 1: JSON embebido (algunos .aspx embeben datos como JSON) ──────
  const jsonMatch = html.match(
    /"compra"\s*:\s*["']?([\d.,]+)["']?[^}]{0,100}"venta"\s*:\s*["']?([\d.,]+)/i
  )
  if (jsonMatch) {
    const compra = parseArgPrice(jsonMatch[1])
    const venta  = parseArgPrice(jsonMatch[2])
    if (compra && venta && venta > compra)
      return { compra, venta, mode: 'venta', strategy: 'json-embedded' }
  }

  // ── Estrategia 2: Fila de tabla HTML con "blue" o "informal" ────────────────
  // Patrón: <tr> ... "blue"/"informal" ... <td>compra</td> <td>venta</td>
  const tableRowRe = /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*?(?:blue|informal)(?:(?!<\/tr>)[\s\S])*?<\/tr>/gi
  let rowMatch: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((rowMatch = tableRowRe.exec(html)) !== null) {
    const row = rowMatch[0]
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(c => stripHtml(c[1]).trim())
    const prices = cells.map(c => parseArgPrice(c)).filter((p): p is number => p !== null)
    if (prices.length >= 2) {
      const sorted = [...prices].sort((a, b) => a - b)
      const compra = sorted[0]
      const venta  = sorted[sorted.length - 1]
      if (venta > compra)
        return { compra, venta, mode: 'venta', strategy: 'html-table-row' }
    }
  }

  // ── Estrategia 3: HTML crudo — buscar "Compra ... precio ... Venta ... precio" ─
  // InfoDolar.com frecuentemente pone: Compra $1.419 Venta $1.450 cerca de "Blue"
  const compraVentaRe =
    /compra[^]*?(\$?\s*\d{1,2}[.]\d{3}(?:[,]\d{1,2})?|\$?\s*\d{3,4}(?:[,]\d{1,2})?)[^]*?venta[^]*?(\$?\s*\d{1,2}[.]\d{3}(?:[,]\d{1,2})?|\$?\s*\d{3,4}(?:[,]\d{1,2})?)/i
  const cvMatch = html.match(compraVentaRe)
  if (cvMatch) {
    const compra = parseArgPrice(cvMatch[1])
    const venta  = parseArgPrice(cvMatch[2])
    if (compra && venta && venta > compra)
      return { compra, venta, mode: 'venta', strategy: 'html-compra-venta-labels' }
  }

  // ── Estrategia 4: Texto plano — sección "blue"/"informal" + dos precios ──────
  const text = stripHtml(html)
  const blueIdx = text.search(/\b(?:blue|informal|dolar blue|dólar blue)\b/i)
  if (blueIdx !== -1) {
    const seg = text.slice(Math.max(0, blueIdx - 30), blueIdx + 600)

    // Intentar encontrar labels "Compra" y "Venta" explícitos en el segmento
    const compraLabelIdx = seg.search(/compra/i)
    const ventaLabelIdx  = seg.search(/venta/i)

    if (compraLabelIdx !== -1 && ventaLabelIdx !== -1) {
      const afterCompra = seg.slice(compraLabelIdx, compraLabelIdx + 120)
      const afterVenta  = seg.slice(ventaLabelIdx,  ventaLabelIdx  + 120)
      const compraM = afterCompra.match(PRICE_RE)
      const ventaM  = afterVenta.match(PRICE_RE)
      const compra  = compraM ? parseArgPrice(compraM[0]) : null
      const venta   = ventaM  ? parseArgPrice(ventaM[0])  : null
      if (compra && venta && venta > compra)
        return { compra, venta, mode: 'venta', strategy: 'text-explicit-labels' }
    }

    // Sin labels explícitos: extraer todos los precios del segmento, asumir menor=compra mayor=venta
    const allMatches = [...seg.matchAll(PRICE_RE)]
    const prices: number[] = []
    for (const m of allMatches) {
      const p = parseArgPrice(m[1])
      if (p) prices.push(p)
    }
    // Deduplicar y ordenar
    const unique = [...new Set(prices)].sort((a, b) => a - b)
    if (unique.length >= 2) {
      const compra = unique[0]
      const venta  = unique[unique.length - 1]
      // Solo aceptar si la diferencia es razonable (hasta 5% entre compra y venta)
      if (venta / compra <= 1.05)
        return { compra, venta, mode: 'venta', strategy: 'text-min-max' }
    }
  }

  return null
}

/** Parser original para Bluelytics (Blue Nacional) — no modificar. */
function extractBlueVenta(html: string): number | null {
  const text = stripHtml(html)

  const idx = text.search(/\bblue\b/i)
  if (idx !== -1) {
    const seg = text.slice(idx, idx + 700)
    const matches = [...seg.matchAll(PRICE_RE)]
    const prices: number[] = []
    for (const m of matches) {
      const p = parseArgPrice(m[1])
      if (p) prices.push(p)
    }
    if (prices.length >= 2) return Math.max(...prices)
    if (prices.length === 1) return prices[0]
  }

  const raw = html.match(/blue[^]*?venta[^<]{0,200}?(\$?\s*[\d.]+,\d{2})/i)
  if (raw) {
    const p = parseArgPrice(raw[1])
    if (p) return p
  }

  return null
}

// ── Servicio ──────────────────────────────────────────────────────────────────

export const exchangeRateService = {
  /**
   * Dólar Blue Nacional — Bluelytics API (CORS-friendly, JSON directo).
   * NO modificar — funciona correctamente.
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
   * InfoDolar Córdoba — devuelve compra Y venta explícitos.
   *
   * SIEMPRE usa el valor de VENTA para productos.
   * Si no puede determinar la venta con certeza, retorna null (NO usa fallback ni promedio).
   */
  async getDolarBlueCordobaDetail(): Promise<CordobaRateDetail | null> {
    try {
      const target   = 'https://www.infodolar.com/cotizacion-dolar-provincia-cordoba.aspx'
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(target)}`

      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) })
      if (!res.ok) throw new Error('proxy HTTP ' + res.status)

      const json = await res.json()
      const html: string = json.contents ?? ''
      if (!html) throw new Error('respuesta vacía del proxy')

      const detail = extractInfoDolarCordobaRates(html)
      if (detail) {
        console.log(
          `[exchangeRate] Córdoba via infodolar.com (${detail.strategy}):`,
          `compra=$${detail.compra} venta=$${detail.venta} → aplicando $${detail.venta}`
        )
        return detail
      }

      // Diagnóstico: mostrar fragmento del HTML para facilitar debugging futuro
      const snippet = stripHtml(html).slice(0, 400)
      console.warn('[exchangeRate] InfoDolar Córdoba: no se pudo parsear. Fragmento:', snippet)
      throw new Error('No se pudo detectar el valor de venta de InfoDolar Córdoba')
    } catch (err) {
      console.error('[exchangeRate] InfoDolar Córdoba falló:', err)
      return null
    }
    // ⚠️ NO hay fallback a Bluelytics nacional. Si Córdoba falla → retorna null → error visible.
    // Esto evita pisar precios con cotización incorrecta (promedio nacional ≠ venta Córdoba).
  },

  /**
   * Córdoba: retorna solo el precio de VENTA para aplicar a productos.
   * Retorna null si no puede obtener la venta con certeza.
   */
  async getDolarBlueCordoba(): Promise<number | null> {
    const detail = await this.getDolarBlueCordobaDetail()
    return detail?.venta ?? null
  },

  /**
   * Obtener tasa según fuente configurada por el negocio.
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
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  },

  // Exponer extractBlueVenta para tests unitarios
  _extractBlueVenta: extractBlueVenta,
  _extractInfoDolarCordobaRates: extractInfoDolarCordobaRates,
}
