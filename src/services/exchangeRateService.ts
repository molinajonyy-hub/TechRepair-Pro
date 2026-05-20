export type DolarSource = 'nacional' | 'cordoba'

/** Compra y venta explícitos de InfoDolar Córdoba. */
export interface CordobaRateDetail {
  compra: number
  venta: number
  /** Siempre 'venta' — nunca promedio ni compra. */
  mode: 'venta'
  strategy: string
  fetchedAt?: string
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

function parseArgPrice(s: string): number | null {
  const clean = s.replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.')
  const n = parseFloat(clean)
  return isFinite(n) && n >= 500 && n <= 9999 ? n : null
}

const PRICE_RE = /\b(\d{1,2}[.]\d{3}(?:[,]\d{1,2})?|\d{3,4}(?:[,]\d{1,2})?)\b/g

/**
 * Parser para infodolar.com HTML — 4 estrategias en orden de especificidad.
 * Retorna compra Y venta explícitos, nunca promedio.
 * Usado tanto en el frontend (fallback proxy) como en la Edge Function.
 */
function extractInfoDolarCordobaRates(html: string): CordobaRateDetail | null {
  // Estrategia 1: JSON embebido
  const jsonMatch = html.match(
    /"compra"\s*:\s*["']?([\d.,]+)["']?[^}]{0,100}"venta"\s*:\s*["']?([\d.,]+)/i
  )
  if (jsonMatch) {
    const compra = parseArgPrice(jsonMatch[1])
    const venta  = parseArgPrice(jsonMatch[2])
    if (compra && venta && venta > compra)
      return { compra, venta, mode: 'venta', strategy: 'json-embedded' }
  }

  // Estrategia 2: Fila de tabla HTML con "blue" o "informal"
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
      const compra = sorted[0], venta = sorted[sorted.length - 1]
      if (venta > compra) return { compra, venta, mode: 'venta', strategy: 'html-table-row' }
    }
  }

  // Estrategia 3: Etiquetas compra/venta en HTML crudo
  const cvMatch = html.match(
    /compra[^]*?(\$?\s*\d{1,2}[.]\d{3}(?:[,]\d{1,2})?|\$?\s*\d{3,4}(?:[,]\d{1,2})?)[^]*?venta[^]*?(\$?\s*\d{1,2}[.]\d{3}(?:[,]\d{1,2})?|\$?\s*\d{3,4}(?:[,]\d{1,2})?)/i
  )
  if (cvMatch) {
    const compra = parseArgPrice(cvMatch[1])
    const venta  = parseArgPrice(cvMatch[2])
    if (compra && venta && venta > compra)
      return { compra, venta, mode: 'venta', strategy: 'html-compra-venta-labels' }
  }

  // Estrategia 4: Texto plano — sección blue/informal
  const text = stripHtml(html)
  const blueIdx = text.search(/\b(?:blue|informal|dolar blue|dólar blue)\b/i)
  if (blueIdx !== -1) {
    const seg = text.slice(Math.max(0, blueIdx - 30), blueIdx + 600)
    const compraLabelIdx = seg.search(/compra/i)
    const ventaLabelIdx  = seg.search(/venta/i)
    if (compraLabelIdx !== -1 && ventaLabelIdx !== -1) {
      const compraM = seg.slice(compraLabelIdx, compraLabelIdx + 120).match(PRICE_RE)
      const ventaM  = seg.slice(ventaLabelIdx,  ventaLabelIdx  + 120).match(PRICE_RE)
      const compra  = compraM ? parseArgPrice(compraM[0]) : null
      const venta   = ventaM  ? parseArgPrice(ventaM[0])  : null
      if (compra && venta && venta > compra)
        return { compra, venta, mode: 'venta', strategy: 'text-explicit-labels' }
    }
    const allMatches = [...seg.matchAll(PRICE_RE)]
    const prices: number[] = []
    for (const m of allMatches) { const p = parseArgPrice(m[1]); if (p) prices.push(p) }
    const unique = [...new Set(prices)].sort((a, b) => a - b)
    if (unique.length >= 2) {
      const compra = unique[0], venta = unique[unique.length - 1]
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
    for (const m of matches) { const p = parseArgPrice(m[1]); if (p) prices.push(p) }
    if (prices.length >= 2) return Math.max(...prices)
    if (prices.length === 1) return prices[0]
  }
  const raw = html.match(/blue[^]*?venta[^<]{0,200}?(\$?\s*[\d.]+,\d{2})/i)
  if (raw) { const p = parseArgPrice(raw[1]); if (p) return p }
  return null
}

// ── Fetch con timeout y retry ─────────────────────────────────────────────────

interface FetchRetryOptions {
  timeoutMs: number
  retries: number
  retryDelayMs: number
  requestInit?: RequestInit
}

async function fetchWithTimeoutAndRetry(url: string, opts: FetchRetryOptions): Promise<Response> {
  const { timeoutMs, retries, retryDelayMs, requestInit } = opts
  let lastError: Error = new Error('fetch failed')
  const total = retries + 1

  for (let attempt = 1; attempt <= total; attempt++) {
    const t0 = Date.now()
    try {
      console.log(`[fetchRetry] attempt ${attempt}/${total} timeout=${timeoutMs}ms`)
      const res = await fetch(url, { ...requestInit, signal: AbortSignal.timeout(timeoutMs) })
      console.log(`[fetchRetry] attempt ${attempt} OK in ${Date.now() - t0}ms status=${res.status}`)
      return res
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err))
      lastError = e
      const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError'
      const isNetwork = e.name === 'TypeError' || e.message.includes('Failed to fetch')
      console.warn(`[fetchRetry] attempt ${attempt} failed (${e.name}): ${e.message} after ${Date.now() - t0}ms`)
      if (attempt < total && (isTimeout || isNetwork)) {
        await new Promise(r => setTimeout(r, retryDelayMs))
        continue
      }
      break
    }
  }
  throw lastError
}

// URL de la Edge Function Supabase (server-side, sin proxy, sin CORS)
const EDGE_FN_URL = 'https://vrdxxmjzxhfgqlnxmbwx.supabase.co/functions/v1/infodolar-cordoba'
const SUPABASE_ANON_KEY = (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_ANON_KEY ?? ''

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
   * Estrategia 1 (primaria): Edge Function Supabase (fetch server-side, sin proxy).
   * Estrategia 2 (fallback): allorigins.win proxy con 2 intentos y 15s timeout.
   *
   * SIEMPRE retorna venta. NUNCA usa promedio, compra ni fallback a nacional.
   * Si ambas estrategias fallan → retorna null → error visible en UI, no se actualizan precios.
   */
  async getDolarBlueCordobaDetail(): Promise<CordobaRateDetail | null> {
    // ── Estrategia 1: Edge Function (server-side, confiable) ──────────────────
    try {
      const t0 = Date.now()
      const res = await fetch(EDGE_FN_URL, {
        headers: {
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type':  'application/json',
        },
        signal: AbortSignal.timeout(20000),
      })
      const ms = Date.now() - t0
      const data = await res.json()

      if (!res.ok || data.error) {
        const code: string = data.code ?? 'unknown'
        if (code === 'timeout') throw new Error('No se pudo consultar InfoDolar Córdoba: la fuente tardó demasiado en responder. No se actualizaron precios.')
        if (code === 'parse')   throw new Error('No se pudo detectar el valor de venta de InfoDolar Córdoba. No se actualizaron precios.')
        throw new Error(data.error ?? `Edge Function HTTP ${res.status}`)
      }

      const detail: CordobaRateDetail = {
        compra:     data.compra,
        venta:      data.venta,
        mode:       'venta',
        strategy:   `edge:${data.strategy ?? 'unknown'}`,
        fetchedAt:  data.fetchedAt,
      }
      console.log(`[exchangeRate] Córdoba via EdgeFn (${ms}ms): compra=$${detail.compra} venta=$${detail.venta} → $${detail.venta}`)
      return detail
    } catch (edgeErr: unknown) {
      const msg = edgeErr instanceof Error ? edgeErr.message : String(edgeErr)
      // Si el error es sobre "no se pudo detectar" o timeout, propagarlo directamente
      if (msg.includes('No se pudo') || msg.includes('InfoDolar')) {
        console.error('[exchangeRate] Córdoba EdgeFn:', msg)
        throw edgeErr
      }
      console.warn('[exchangeRate] Córdoba EdgeFn falló, intentando proxy:', msg)
    }

    // ── Estrategia 2: Proxy allorigins.win con retry ──────────────────────────
    const target   = 'https://www.infodolar.com/cotizacion-dolar-provincia-cordoba.aspx'
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(target)}`

    try {
      const res = await fetchWithTimeoutAndRetry(proxyUrl, {
        timeoutMs:    15000,
        retries:      1,       // 2 intentos totales
        retryDelayMs: 800,
      })
      if (!res.ok) throw new Error(`proxy HTTP ${res.status}`)

      const json  = await res.json()
      const html: string = json.contents ?? ''
      if (!html) throw new Error('respuesta vacía del proxy')

      const detail = extractInfoDolarCordobaRates(html)
      if (detail) {
        console.log(`[exchangeRate] Córdoba via proxy (${detail.strategy}): compra=$${detail.compra} venta=$${detail.venta}`)
        return detail
      }

      const snippet = stripHtml(html).slice(0, 300)
      console.warn('[exchangeRate] Proxy: no se pudo parsear. Fragmento:', snippet)
      throw new Error('No se pudo detectar el valor de venta de InfoDolar Córdoba. No se actualizaron precios.')
    } catch (proxyErr: unknown) {
      const e = proxyErr instanceof Error ? proxyErr : new Error(String(proxyErr))
      const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError' || e.message.includes('timed out')
      const userMsg = isTimeout
        ? 'No se pudo consultar InfoDolar Córdoba: la fuente tardó demasiado en responder. No se actualizaron precios.'
        : e.message.includes('No se pudo') ? e.message
        : `Error al consultar InfoDolar Córdoba: ${e.message}`
      console.error('[exchangeRate] Proxy Córdoba falló:', e.message)
      throw new Error(userMsg)
    }
    // ⚠️ Sin fallback a dólar nacional. Si Córdoba falla → error visible en UI.
  },

  /**
   * Córdoba: retorna solo el precio de VENTA para aplicar a productos.
   */
  async getDolarBlueCordoba(): Promise<number | null> {
    try {
      const detail = await this.getDolarBlueCordobaDetail()
      return detail?.venta ?? null
    } catch {
      return null
    }
  },

  /** Obtener tasa según fuente configurada por el negocio. */
  async getDolarRate(source: DolarSource = 'nacional'): Promise<number | null> {
    return source === 'cordoba' ? this.getDolarBlueCordoba() : this.getDolarBlueNacional()
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

  // Exponer para tests unitarios
  _extractBlueVenta:                extractBlueVenta,
  _extractInfoDolarCordobaRates:    extractInfoDolarCordobaRates,
  _fetchWithTimeoutAndRetry:        fetchWithTimeoutAndRetry,
}
