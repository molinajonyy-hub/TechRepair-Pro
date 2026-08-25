import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Parseo de números argentinos ─────────────────────────────────────────────
function parseARSNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const s = String(value).replace(/\$/g, '').replace(/\s/g, '').trim();
  const hasCommaDecimal = s.includes(',');
  const cleaned = hasCommaDecimal
    ? s.replace(/\./g, '').replace(',', '.')
    : s.replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function isValid(rate: number | null): boolean {
  return rate !== null && rate > 500 && rate < 10000;
}

/**
 * Dado dos precios de una fila buy/sell (en cualquier orden),
 * retorna siempre { sell: max, buy: min }.
 * InfoDolar Córdoba a veces muestra Venta primero, Compra segundo.
 * Usar Math.max/min garantiza que sell siempre sea el precio mayor (venta).
 */
function assignSellBuy(p1: number | null, p2: number | null): { sell: number; buy: number } | null {
  if (p1 !== null && p2 !== null && isValid(Math.max(p1, p2))) {
    return { sell: Math.max(p1, p2), buy: Math.min(p1, p2) };
  }
  if (p1 !== null && isValid(p1)) return { sell: p1, buy: 0 };
  if (p2 !== null && isValid(p2)) return { sell: p2, buy: 0 };
  return null;
}

// ── InfoDolar Córdoba (HTML scraping) ────────────────────────────────────
async function fetchInfoDolarCordoba(): Promise<{ sell: number; buy: number; source: string; province: string } | null> {
  try {
    const resp = await fetch(
      'https://www.infodolar.com/cotizacion-dolar-provincia-cordoba.aspx',
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TechRepairBot/1.0)' },
        signal: AbortSignal.timeout(15000) }
    );
    if (!resp.ok) return null;
    const html = await resp.text();

    // Estrategia 1: fila con "Blue" o "Informal" + dos <td> con precios
    // IMPORTANTE: usar Math.max para sell, Math.min para buy
    // porque infodolar.com puede mostrar Venta|Compra en cualquier orden.
    const blueRowMatch = html.match(
      /(?:blue|informal)[^<]{0,50}<\/td>[^<]*<td[^>]*>([\d.,]+)<\/td>[^<]*<td[^>]*>([\d.,]+)<\/td>/i
    );
    if (blueRowMatch) {
      const p1 = parseARSNumber(blueRowMatch[1]);
      const p2 = parseARSNumber(blueRowMatch[2]);
      const sb = assignSellBuy(p1, p2);
      if (sb) return { ...sb, source: 'INFODOLAR_CORDOBA', province: 'CORDOBA' };
    }

    // Estrategia 2: regex amplio buscando dos números grandes tras "blue"
    const blueSection = html.match(
      /blue[\s\S]{0,300}?(\d{1,2}[.,]\d{3}(?:[.,]\d{2})?)[\s\S]{0,50}?(\d{1,2}[.,]\d{3}(?:[.,]\d{2})?)/i
    );
    if (blueSection) {
      const p1 = parseARSNumber(blueSection[1]);
      const p2 = parseARSNumber(blueSection[2]);
      const sb = assignSellBuy(p1, p2);
      if (sb) return { ...sb, source: 'INFODOLAR_CORDOBA', province: 'CORDOBA' };
    }

    // Estrategia 3: etiquetas compra/venta explícitas en texto (más robusta)
    const compraMatch = html.match(/compra[^\d]{0,30}([\d.,]{4,10})/i);
    const ventaMatch  = html.match(/venta[^\d]{0,30}([\d.,]{4,10})/i);
    if (compraMatch && ventaMatch) {
      const compra = parseARSNumber(compraMatch[1]);
      const venta  = parseARSNumber(ventaMatch[1]);
      if (isValid(venta) && venta !== null) {
        return { sell: venta, buy: compra ?? 0, source: 'INFODOLAR_CORDOBA', province: 'CORDOBA' };
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ── Ámbito JSON API ────────────────────────────────────────────────────
async function fetchAmbitoBlue(): Promise<{ sell: number; buy: number; source: string } | null> {
  try {
    const resp = await fetch('https://mercados.ambito.com/dolar/informal/variacion');
    if (!resp.ok) return null;
    const data = await resp.json();
    const sell = parseARSNumber(String(data.venta));
    const buy  = parseARSNumber(String(data.compra));
    if (isValid(sell)) return { sell: sell!, buy: buy || 0, source: 'AMBITO_NACIONAL' };
    return null;
  } catch {
    return null;
  }
}

// ── DolarAPI fallback ────────────────────────────────────────────────────
async function fetchDolarAPI(): Promise<{ sell: number; buy: number; source: string } | null> {
  try {
    const resp = await fetch('https://dolarapi.com/v1/dolares/blue');
    if (!resp.ok) return null;
    const data = await resp.json();
    const sell = typeof data.venta === 'number' ? data.venta : parseARSNumber(String(data.venta));
    const buy  = typeof data.compra === 'number' ? data.compra : parseARSNumber(String(data.compra));
    if (isValid(sell)) return { sell: sell!, buy: buy || 0, source: 'DOLARAPI' };
    return null;
  } catch {
    return null;
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const preferCordoba = body.source !== 'nacional';
    const lastKnown: number | null = body.lastKnown ?? null;

    let result: { sell: number; buy?: number; source: string; province?: string } | null = null;

    // 1. InfoDolar Córdoba
    if (preferCordoba) {
      result = await fetchInfoDolarCordoba();
    }

    // 2. Ámbito nacional
    if (!result) {
      result = await fetchAmbitoBlue();
    }

    // 3. DolarAPI
    if (!result) {
      result = await fetchDolarAPI();
    }

    if (!result) {
      return new Response(
        JSON.stringify({ error: 'No se pudo obtener cotización', lastKnown }),
        { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // Validación de variación sospechosa (>15%)
    if (lastKnown && lastKnown > 0) {
      const variation = Math.abs((result.sell - lastKnown) / lastKnown);
      if (variation > 0.15) {
        return new Response(
          JSON.stringify({
            warning: 'variation_suspicious',
            message: `Variación del ${(variation * 100).toFixed(1)}% detectada. Revisar antes de aplicar.`,
            newRate: result.sell,
            lastKnown,
            source: result.source,
          }),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(
      JSON.stringify({ sell: result.sell, buy: result.buy ?? 0, source: result.source, province: result.province ?? null }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
