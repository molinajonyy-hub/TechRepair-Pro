import { corsHeaders } from '../_shared/cors.ts'

/**
 * Edge Function: get-dolar-cordoba
 * Obtiene el valor de VENTA del dólar blue de Córdoba desde infodolar.com
 * Se ejecuta server-side (sin restricciones CORS).
 */

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseArgentinePrice(str: string): number | null {
  // Soporta formatos: 1.250,00 | 1250 | 1,250.00 | $1.250
  const clean = str.replace(/[$\s]/g, '').trim()

  // Formato argentino: punto como separador de miles, coma como decimal
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(clean)) {
    return parseFloat(clean.replace(/\./g, '').replace(',', '.'))
  }
  // Solo número entero
  if (/^\d{3,5}$/.test(clean)) {
    return parseFloat(clean)
  }
  // Formato USA: coma como miles, punto como decimal
  if (/^\d{1,3}(,\d{3})*(\.\d{1,2})?$/.test(clean)) {
    return parseFloat(clean.replace(/,/g, ''))
  }
  return null
}

function extractBlueVenta(html: string): number | null {
  const text = stripHtml(html)

  // ── Estrategia 1: Buscar "Blue" seguido de dos precios (compra y venta)
  // La venta es el segundo número (más alto) que aparece después de "blue"
  const blueIdx = text.search(/\bblue\b/i)
  if (blueIdx !== -1) {
    const segment = text.slice(blueIdx, blueIdx + 600)

    // Extraer todos los candidatos de precio en ese segmento
    const priceMatches = [...segment.matchAll(/\b(\d{3,5}(?:[.,]\d{0,3})?)\b/g)]
    const prices: number[] = []

    for (const m of priceMatches) {
      const p = parseArgentinePrice(m[1])
      if (p !== null && p >= 500 && p <= 9999) {
        prices.push(p)
      }
    }

    if (prices.length >= 2) {
      // Venta siempre es la más alta entre compra y venta del blue
      return Math.max(...prices)
    }
    if (prices.length === 1) {
      return prices[0]
    }
  }

  // ── Estrategia 2: "venta" cerca de "blue" en el HTML crudo (antes del strip)
  const rawBlueMatch = html.match(/blue[^]*?venta[^$]*?(\$?\s*[\d.,]+)/i)
  if (rawBlueMatch) {
    const p = parseArgentinePrice(rawBlueMatch[1])
    if (p && p >= 500 && p <= 9999) return p
  }

  // ── Estrategia 3: Buscar etiquetas data-* o value específicos del sitio
  const dataPatterns = [
    /data-venta[^>]*>\s*([\d.,]+)/i,
    /class="[^"]*venta[^"]*"[^>]*>\s*([\d.,]+)/i,
    /id="[^"]*blue[^"]*venta[^"]*"[^>]*>\s*([\d.,]+)/i,
  ]
  for (const p of dataPatterns) {
    const m = html.match(p)
    if (m) {
      const val = parseArgentinePrice(m[1])
      if (val && val >= 500 && val <= 9999) return val
    }
  }

  return null
}

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = 'https://www.infodolar.com/cotizacion-dolar-provincia-cordoba.aspx'

    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9',
        'Cache-Control': 'no-cache',
      },
    })

    if (!res.ok) {
      throw new Error(`infodolar.com respondió con HTTP ${res.status}`)
    }

    const html = await res.text()
    const rate = extractBlueVenta(html)

    if (!rate) {
      // Debug: devolver fragmento del HTML para diagnosticar el parser
      const snippet = stripHtml(html).slice(0, 800)
      throw new Error(`No se pudo extraer el precio. Fragmento: ${snippet}`)
    }

    return new Response(
      JSON.stringify({
        rate,
        source: 'infodolar-cordoba',
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[get-dolar-cordoba]', message)
    return new Response(
      JSON.stringify({ error: message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})
