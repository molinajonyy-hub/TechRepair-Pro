import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CordobaRateDetail {
  compra: number;
  venta: number;
  appliedRate: number; // siempre = venta
  mode: "venta";
  source: "infodolar_cordoba";
  strategy: string;
  fetchedAt: string;
}

interface ErrorResponse {
  error: string;
  code: "timeout" | "network" | "parse" | "http";
}

// ── CORS ──────────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Parseo de precios argentinos ─────────────────────────────────────────────

function parseArgPrice(s: string): number | null {
  const clean = s.replace(/[$\s]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(clean);
  return isFinite(n) && n >= 500 && n <= 9999 ? n : null;
}

const PRICE_RE = /\b(\d{1,2}[.]\d{3}(?:[,]\d{1,2})?|\d{3,4}(?:[,]\d{1,2})?)\b/g;

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractInfoDolarCordobaRates(
  html: string
): Omit<CordobaRateDetail, "appliedRate" | "mode" | "source" | "fetchedAt"> | null {
  // Estrategia 1: JSON embebido
  const jsonMatch = html.match(
    /"compra"\s*:\s*["']?([\d.,]+)["']?[^}]{0,100}"venta"\s*:\s*["']?([\d.,]+)/i
  );
  if (jsonMatch) {
    const compra = parseArgPrice(jsonMatch[1]);
    const venta = parseArgPrice(jsonMatch[2]);
    if (compra && venta && venta > compra)
      return { compra, venta, strategy: "json-embedded" };
  }

  // Estrategia 2: Fila de tabla con blue/informal
  const tableRowRe =
    /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*?(?:blue|informal)(?:(?!<\/tr>)[\s\S])*?<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = tableRowRe.exec(html)) !== null) {
    const row = rowMatch[0];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      stripHtml(c[1]).trim()
    );
    const prices = cells
      .map((c) => parseArgPrice(c))
      .filter((p): p is number => p !== null);
    if (prices.length >= 2) {
      const sorted = [...prices].sort((a, b) => a - b);
      const compra = sorted[0];
      const venta = sorted[sorted.length - 1];
      if (venta > compra) return { compra, venta, strategy: "html-table-row" };
    }
  }

  // Estrategia 3: Etiquetas compra/venta en HTML crudo
  const cvMatch = html.match(
    /compra[^]*?(\$?\s*\d{1,2}[.]\d{3}(?:[,]\d{1,2})?|\$?\s*\d{3,4}(?:[,]\d{1,2})?)[^]*?venta[^]*?(\$?\s*\d{1,2}[.]\d{3}(?:[,]\d{1,2})?|\$?\s*\d{3,4}(?:[,]\d{1,2})?)/i
  );
  if (cvMatch) {
    const compra = parseArgPrice(cvMatch[1]);
    const venta = parseArgPrice(cvMatch[2]);
    if (compra && venta && venta > compra)
      return { compra, venta, strategy: "html-compra-venta-labels" };
  }

  // Estrategia 4: Texto plano — sección blue/informal
  const text = stripHtml(html);
  const blueIdx = text.search(/\b(?:blue|informal|dolar blue|dólar blue)\b/i);
  if (blueIdx !== -1) {
    const seg = text.slice(Math.max(0, blueIdx - 30), blueIdx + 600);
    const compraLabelIdx = seg.search(/compra/i);
    const ventaLabelIdx = seg.search(/venta/i);
    if (compraLabelIdx !== -1 && ventaLabelIdx !== -1) {
      const afterCompra = seg.slice(compraLabelIdx, compraLabelIdx + 120);
      const afterVenta = seg.slice(ventaLabelIdx, ventaLabelIdx + 120);
      const compraM = afterCompra.match(PRICE_RE);
      const ventaM = afterVenta.match(PRICE_RE);
      const compra = compraM ? parseArgPrice(compraM[0]) : null;
      const venta = ventaM ? parseArgPrice(ventaM[0]) : null;
      if (compra && venta && venta > compra)
        return { compra, venta, strategy: "text-explicit-labels" };
    }
    const allMatches = [...seg.matchAll(PRICE_RE)];
    const prices: number[] = [];
    for (const m of allMatches) {
      const p = parseArgPrice(m[1]);
      if (p) prices.push(p);
    }
    const unique = [...new Set(prices)].sort((a, b) => a - b);
    if (unique.length >= 2) {
      const compra = unique[0];
      const venta = unique[unique.length - 1];
      if (venta / compra <= 1.05)
        return { compra, venta, strategy: "text-min-max" };
    }
  }

  return null;
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  const t0 = Date.now();
  const target =
    "https://www.infodolar.com/cotizacion-dolar-provincia-cordoba.aspx";

  try {
    const res = await fetch(target, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; TechRepairPro/1.0; +https://techrepairpro.app)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "es-AR,es;q=0.9",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(15000),
    });

    const fetchMs = Date.now() - t0;

    if (!res.ok) {
      return json(
        { error: `InfoDolar respondió HTTP ${res.status}`, code: "http" } as ErrorResponse,
        502
      );
    }

    const html = await res.text();
    const parsed = extractInfoDolarCordobaRates(html);

    if (!parsed) {
      console.warn(
        `[infodolar-cordoba] parse failed after ${fetchMs}ms. HTML snippet:`,
        stripHtml(html).slice(0, 300)
      );
      return json(
        {
          error:
            "No se pudo detectar el valor de venta de InfoDolar Córdoba. No se actualizaron precios.",
          code: "parse",
        } as ErrorResponse,
        422
      );
    }

    const result: CordobaRateDetail = {
      compra: parsed.compra,
      venta: parsed.venta,
      appliedRate: parsed.venta, // SIEMPRE venta
      mode: "venta",
      source: "infodolar_cordoba",
      strategy: parsed.strategy,
      fetchedAt: new Date().toISOString(),
    };

    console.log(
      `[infodolar-cordoba] OK in ${fetchMs}ms | strategy=${result.strategy}`,
      `| compra=$${result.compra} venta=$${result.venta}`
    );

    return json(result);
  } catch (err: unknown) {
    const elapsed = Date.now() - t0;
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.message.includes("timed out"));
    const code = isTimeout ? "timeout" : "network";
    const message = isTimeout
      ? `No se pudo consultar InfoDolar Córdoba: la fuente tardó demasiado en responder (${elapsed}ms). No se actualizaron precios.`
      : `Error de red al consultar InfoDolar Córdoba: ${
          err instanceof Error ? err.message : String(err)
        }`;
    console.error(`[infodolar-cordoba] ${code} after ${elapsed}ms:`, err);
    return json({ error: message, code } as ErrorResponse, 503);
  }
});
