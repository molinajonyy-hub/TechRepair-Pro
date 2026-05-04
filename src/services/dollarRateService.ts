/**
 * dollarRateService — Cotización del dólar blue para TechRepair Pro
 *
 * Cadena de prioridad:
 *  1. Edge Function → InfoDolar Córdoba (venta)
 *  2. Edge Function → Ámbito nacional (venta)
 *  3. Edge Function → DolarAPI
 *  4. Último valor válido en DB
 *  5. Error controlado
 *
 * REGLA: siempre usa precio de VENTA del dólar blue.
 */
import { supabase } from '../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DollarSource = 'INFODOLAR_CORDOBA' | 'AMBITO_NACIONAL' | 'DOLARAPI' | 'DB_CACHE' | 'MANUAL';

export interface DollarRateResult {
  sellPrice: number;
  buyPrice?: number;
  source: DollarSource;
  province?: string | null;
  fetchedAt: Date;
  isStale?: boolean;
  warning?: string;
}

interface CacheEntry {
  result: DollarRateResult;
  ts: number;
}

// ─── Cache en módulo (evita llamadas repetidas) ───────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos
const cache = new Map<string, CacheEntry>();

function cacheKey(businessId: string) { return `dollar:${businessId}`; }
function isFresh(entry: CacheEntry) { return Date.now() - entry.ts < CACHE_TTL_MS; }
function setCache(businessId: string, result: DollarRateResult) {
  cache.set(cacheKey(businessId), { result, ts: Date.now() });
}
function getCache(businessId: string): DollarRateResult | null {
  const entry = cache.get(cacheKey(businessId));
  return entry ? entry.result : null;
}
export function clearDollarCache(businessId: string) { cache.delete(cacheKey(businessId)); }

// ─── parseARSNumber ───────────────────────────────────────────────────────────

/**
 * Convierte strings de precios argentinos a número:
 * '$ 1.420,00' → 1420  |  '1.420,00' → 1420  |  '1420.00' → 1420
 */
export function parseARSNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return isNaN(value) ? null : value;

  const s = String(value).replace(/\$/g, '').replace(/\s/g, '').trim();
  // Formato AR: '1.420,00' → quitar punto de miles, coma → punto decimal
  const hasCommaDecimal = s.includes(',');
  const cleaned = hasCommaDecimal
    ? s.replace(/\./g, '').replace(',', '.')
    : s.replace(/,/g, '');

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function isValidRate(r: number | null): r is number {
  return r !== null && r > 500 && r < 10_000;
}

// ─── Edge Function URL ────────────────────────────────────────────────────────

function getEdgeFunctionUrl(): string {
  const url = import.meta.env.VITE_SUPABASE_URL as string ?? '';
  return `${url}/functions/v1/fetch-dollar-rate`;
}

// ─── Obtener cotización via Edge Function ─────────────────────────────────────

async function fetchViaEdgeFunction(source: 'cordoba' | 'nacional', lastKnown: number): Promise<{
  sell: number; buy: number; source: DollarSource; province?: string; warning?: string;
} | null> {
  try {
    const resp = await fetch(getEdgeFunctionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, lastKnown }),
    });

    if (!resp.ok) return null;
    const data = await resp.json();

    if (data.error) return null;

    return {
      sell:     data.sell,
      buy:      data.buy ?? 0,
      source:   data.source as DollarSource,
      province: data.province ?? null,
      warning:  data.warning ?? undefined,
    };
  } catch {
    return null;
  }
}

// ─── Último valor válido en DB ────────────────────────────────────────────────

async function getLastDBRate(businessId: string): Promise<DollarRateResult | null> {
  const { data } = await supabase
    .from('exchange_rates')
    .select('rate, source, updated_at')
    .eq('business_id', businessId)
    .eq('base_currency', 'USD')
    .eq('target_currency', 'ARS')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.rate || !isValidRate(data.rate)) return null;

  return {
    sellPrice: data.rate,
    source: (data.source as DollarSource) ?? 'DB_CACHE',
    fetchedAt: new Date(data.updated_at),
    isStale: true,
  };
}

// ─── Guardar en DB ────────────────────────────────────────────────────────────

async function saveRateToDB(businessId: string, result: DollarRateResult) {
  const now = new Date().toISOString();

  // Upsert en exchange_rates (valor actual)
  await supabase.from('exchange_rates').upsert({
    business_id:     businessId,
    base_currency:   'USD',
    target_currency: 'ARS',
    rate:            result.sellPrice,
    is_manual:       result.source === 'MANUAL',
    source:          result.source,
    updated_at:      now,
  }, { onConflict: 'business_id,base_currency,target_currency' });

  // Insert en historial (no overwrite)
  await supabase.from('dollar_rate_history').insert({
    business_id: businessId,
    sell_price:  result.sellPrice,
    buy_price:   result.buyPrice ?? null,
    source:      result.source,
    province:    result.province ?? null,
    fetched_at:  now,
  });

  // Actualizar last_dollar_source en business_settings
  await supabase.from('business_settings').update({
    last_dollar_source:     result.source,
    last_dollar_fetched_at: now,
  }).eq('business_id', businessId);
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Obtiene la cotización actual.
 * Si el caché está fresco (< 15 min), lo devuelve sin llamar a la API.
 */
export async function getCurrentDollarRate(businessId: string): Promise<DollarRateResult | null> {
  const cached = getCache(businessId);
  if (cached) return cached;
  return refreshDollarRate(businessId, false);
}

/**
 * Fuerza una actualización ignorando el caché.
 * @param businessId
 * @param force si false, respeta el TTL del caché
 */
export async function refreshDollarRate(businessId: string, force = true): Promise<DollarRateResult | null> {
  if (!force) {
    const entry = cache.get(cacheKey(businessId));
    if (entry && isFresh(entry)) return entry.result;
  }

  // Leer configuración del negocio
  const { data: settings } = await supabase
    .from('business_settings')
    .select('dolar_source, auto_update_rate')
    .eq('business_id', businessId)
    .maybeSingle();

  const preferCordoba  = (settings?.dolar_source ?? 'cordoba') !== 'nacional';
  const autoUpdate     = settings?.auto_update_rate !== false;

  // Si no usa auto-update, devolver valor de DB
  if (!autoUpdate) {
    const dbRate = await getLastDBRate(businessId);
    if (dbRate) { setCache(businessId, dbRate); return dbRate; }
    return null;
  }

  // Obtener último valor para validación de variación sospechosa
  const dbRate    = await getLastDBRate(businessId);
  const lastKnown = dbRate?.sellPrice ?? 0;

  // Intentar edge function
  const primary  = preferCordoba ? 'cordoba' : 'nacional';
  const fallback = preferCordoba ? 'nacional' : 'cordoba';

  let raw = await fetchViaEdgeFunction(primary, lastKnown);
  if (!raw) raw = await fetchViaEdgeFunction(fallback, lastKnown);

  if (!raw || !isValidRate(raw.sell)) {
    // Usar último valor de DB como fallback
    if (dbRate) {
      const stale = { ...dbRate, isStale: true };
      setCache(businessId, stale);
      return stale;
    }
    return null;
  }

  const result: DollarRateResult = {
    sellPrice: raw.sell,
    buyPrice:  raw.buy,
    source:    raw.source,
    province:  raw.province,
    fetchedAt: new Date(),
    isStale:   false,
    warning:   raw.warning,
  };

  // No guardar si hay variación sospechosa
  if (!raw.warning) {
    await saveRateToDB(businessId, result);
  }

  setCache(businessId, result);
  return result;
}

/**
 * Fuerza una cotización manual (override del auto-update).
 */
export async function setManualDollarRate(businessId: string, sellPrice: number): Promise<DollarRateResult> {
  const result: DollarRateResult = {
    sellPrice,
    source:    'MANUAL',
    fetchedAt: new Date(),
    isStale:   false,
  };
  await saveRateToDB(businessId, result);
  setCache(businessId, result);
  return result;
}

/**
 * Actualiza todos los productos vinculados al dólar con la cotización actual.
 */
export async function refreshInventoryDollarPrices(businessId: string): Promise<{ updated: number; rate: number }> {
  const rateResult = await getCurrentDollarRate(businessId);
  if (!rateResult) return { updated: 0, rate: 0 };

  const rate = rateResult.sellPrice;

  const { data: products } = await supabase
    .from('inventory')
    .select('id, price_usd')
    .eq('business_id', businessId)
    .eq('linked_to_dolar', true)
    .not('price_usd', 'is', null);

  if (!products?.length) return { updated: 0, rate };

  let updated = 0;
  for (const p of products) {
    if (!p.price_usd) continue;
    const newPrice = Math.round(p.price_usd * rate);
    const { error } = await supabase.from('inventory')
      .update({ sale_price: newPrice, exchange_rate_used: rate, updated_at: new Date().toISOString() })
      .eq('id', p.id);
    if (!error) updated++;
  }

  return { updated, rate };
}
