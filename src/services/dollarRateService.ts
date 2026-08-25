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
import {
  type DolarSource as ConfiguredSource,
  DOLAR_SOURCES,
  normalizeDolarSource,
  normalizeRateSourceTag,
  type RateSourceTag,
} from '../lib/dollar/quoteSource';

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

// ─── Source labels ────────────────────────────────────────────────────────────

export const DOLLAR_SOURCE_LABELS: Record<DollarSource, string> = {
  INFODOLAR_CORDOBA: 'InfoDolar Córdoba',
  AMBITO_NACIONAL:   'Ámbito Nacional',
  DOLARAPI:          'DolarAPI',
  DB_CACHE:          'Último valor guardado',
  MANUAL:            'Manual',
};

// ─── Display helper ───────────────────────────────────────────────────────────

/**
 * Normaliza un DollarRateResult para display en el Dashboard.
 *
 * Reglas:
 * - mainValue = sellPrice (precio de VENTA — siempre el valor a mostrar grande)
 * - secondaryLabel = "compra $X" solo si buyPrice existe, es válido y es MENOR que sellPrice
 *   (nunca mostrar compra como valor principal, nunca duplicar si son iguales)
 * - Si por algún bug sellPrice < buyPrice (datos invertidos), intercambiarlos
 */
export interface DisplayRate {
  mainValue:      number
  mainLabel:      'Venta'
  secondaryLabel: string | null
  sourceLabel:    string
  mode:           'venta'
}

export function getDisplayExchangeRate(rate: DollarRateResult): DisplayRate {
  let sell = rate.sellPrice;
  let buy  = rate.buyPrice ?? 0;

  // Defensive: si los datos llegaron invertidos (sell < buy), corregir en display
  if (buy > 0 && buy > sell) {
    [sell, buy] = [buy, sell];
  }

  const secondaryLabel =
    buy > 0 && buy < sell
      ? `compra $${Math.round(buy).toLocaleString('es-AR')}`
      : null;

  return {
    mainValue:      sell,
    mainLabel:      'Venta',
    secondaryLabel,
    sourceLabel:    DOLLAR_SOURCE_LABELS[rate.source] ?? rate.source,
    mode:           'venta',
  };
}

interface CacheEntry {
  result: DollarRateResult;
  ts: number;
}

// ─── Cache en módulo (evita llamadas repetidas) ───────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos
const cache = new Map<string, CacheEntry>();

/**
 * La clave incluye la FUENTE configurada.
 *
 * Con `dollar:${businessId}` a secas, cambiar de Córdoba a Nacional servía
 * hasta 15 minutos el valor de la fuente anterior, etiquetado con la nueva.
 * La fuente es parte de la identidad del dato cacheado, no un atributo.
 */
function cacheKey(businessId: string, source: ConfiguredSource) { return `dollar:${businessId}:${source}`; }
function isFresh(entry: CacheEntry) { return Date.now() - entry.ts < CACHE_TTL_MS; }
function setCache(businessId: string, source: ConfiguredSource, result: DollarRateResult) {
  cache.set(cacheKey(businessId, source), { result, ts: Date.now() });
}
function getFreshCache(businessId: string, source: ConfiguredSource): DollarRateResult | null {
  const entry = cache.get(cacheKey(businessId, source));
  return entry && isFresh(entry) ? entry.result : null;
}

/** Invalida el caché de TODAS las fuentes del negocio. */
export function clearDollarCache(businessId: string) {
  for (const source of Object.keys(DOLAR_SOURCES) as ConfiguredSource[]) {
    cache.delete(cacheKey(businessId, source));
  }
}

// ─── Mapeo entre la fuente configurada y el vocabulario de display ────────────

const DISPLAY_SOURCE_BY_CONFIG: Record<ConfiguredSource, DollarSource> = {
  cordoba:  'INFODOLAR_CORDOBA',
  nacional: 'AMBITO_NACIONAL',
};

/** Tag canónico que se persiste en `exchange_rates.source`. */
function rateTagFor(source: ConfiguredSource): RateSourceTag {
  return DOLAR_SOURCES[source].rateSourceTag;
}

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

// ─── Edge Function URLs ───────────────────────────────────────────────────────

function getSupabaseUrl(): string {
  return (import.meta.env.VITE_SUPABASE_URL as string) ?? '';
}
function getAnonKey(): string {
  return (import.meta.env.VITE_SUPABASE_ANON_KEY as string) ?? '';
}

// ─── Obtener cotización via Edge Function ─────────────────────────────────────

/**
 * Para Córdoba: usa el edge function dedicado `infodolar-cordoba` que retorna
 * explícitamente { compra, venta, appliedRate, mode:'venta' }.
 * Esto evita el bug de fetch-dollar-rate donde compra y venta se confunden
 * porque la página puede mostrarlos en cualquier orden.
 *
 * Para nacional: usa fetch-dollar-rate con source='nacional' (Ámbito).
 */
async function fetchViaEdgeFunction(source: 'cordoba' | 'nacional', lastKnown: number): Promise<{
  sell: number; buy: number; source: DollarSource; province?: string; warning?: string;
} | null> {
  try {
    if (source === 'cordoba') {
      // Edge Function dedicada: retorna { compra, venta, appliedRate, mode:'venta' }
      const url  = `${getSupabaseUrl()}/functions/v1/infodolar-cordoba`;
      const key  = getAnonKey();
      const resp = await fetch(url, {
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
        signal: AbortSignal.timeout(22000),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data.error) return null;
      // appliedRate es siempre la VENTA (el precio a aplicar a productos)
      const sell = Number(data.appliedRate ?? data.venta);
      const buy  = Number(data.compra ?? 0);
      if (!isValidRate(sell)) return null;
      // Defensive: si por algún motivo sell < buy, intercambiar
      const realSell = Math.max(sell, buy);
      const realBuy  = Math.min(sell, buy);
      return { sell: realSell, buy: realBuy, source: 'INFODOLAR_CORDOBA', province: 'CORDOBA' };
    }

    // Nacional: usa fetch-dollar-rate con POST
    const resp = await fetch(`${getSupabaseUrl()}/functions/v1/fetch-dollar-rate`, {
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
  // Leer sell price de exchange_rates y buy price de dollar_rate_history en paralelo
  const [rateRes, histRes] = await Promise.all([
    supabase
      .from('exchange_rates')
      .select('rate, source, updated_at')
      .eq('business_id', businessId)
      .eq('base_currency', 'USD')
      .eq('target_currency', 'ARS')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('dollar_rate_history')
      .select('sell_price, buy_price')
      .eq('business_id', businessId)
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const data = rateRes.data;
  if (!data?.rate || !isValidRate(data.rate)) return null;

  // Buy price: tomarlo del historial si es válido y estrictamente MENOR que sell
  // (buy > sell indicaría datos invertidos — ignorar en ese caso)
  const histBuy = histRes.data?.buy_price ?? null;
  const buyPrice = (histBuy !== null && isValidRate(histBuy) && histBuy < data.rate)
    ? histBuy
    : undefined;

  // La columna acumuló grafías divergentes ('INFODOLAR_CORDOBA', 'bluelytics',
  // 'api'…). Se normaliza al leer en vez de castear a ciegas.
  const tag = normalizeRateSourceTag(data.source);
  const displaySource: DollarSource =
    tag === 'infodolar-cordoba' ? 'INFODOLAR_CORDOBA'
    : tag === 'bluelytics'      ? 'AMBITO_NACIONAL'
    : tag === 'dolarapi'        ? 'DOLARAPI'
    : tag === 'manual'          ? 'MANUAL'
    :                             'DB_CACHE';

  return {
    sellPrice: data.rate,
    buyPrice,
    source: displaySource,
    fetchedAt: new Date(data.updated_at),
    isStale: true,
  };
}

// ─── Guardar en DB ────────────────────────────────────────────────────────────

async function saveRateToDB(businessId: string, result: DollarRateResult, rateTag: RateSourceTag) {
  const now = new Date().toISOString();

  // Upsert en exchange_rates (valor actual).
  // `source` se persiste SIEMPRE con el tag canónico — antes escribía el enum
  // de display en mayúsculas, que ninguna consulta del frontend buscaba.
  await supabase.from('exchange_rates').upsert({
    business_id:     businessId,
    base_currency:   'USD',
    target_currency: 'ARS',
    rate:            result.sellPrice,
    is_manual:       result.source === 'MANUAL',
    source:          rateTag,
    updated_at:      now,
  }, { onConflict: 'business_id,base_currency,target_currency' });

  // Insert en historial (no overwrite)
  await supabase.from('dollar_rate_history').insert({
    business_id: businessId,
    sell_price:  result.sellPrice,
    buy_price:   result.buyPrice ?? null,
    source:      rateTag,
    province:    result.province ?? null,
    fetched_at:  now,
  });

  // Actualizar last_dollar_source en business_settings.
  // OJO: `last_dollar_source` es un registro de PROCEDENCIA del último valor
  // obtenido — NO es la fuente configurada. La configurada vive en
  // `dolar_source` y sólo la cambia el usuario.
  await supabase.from('business_settings').update({
    last_dollar_source:     rateTag,
    last_dollar_fetched_at: now,
  }).eq('business_id', businessId);
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Obtiene la cotización actual.
 * Si el caché está fresco (< 15 min), lo devuelve sin llamar a la API.
 */
export async function getCurrentDollarRate(businessId: string): Promise<DollarRateResult | null> {
  // El caché ya no se puede consultar sin saber la fuente: la fuente es parte
  // de la clave. refreshDollarRate(force=false) resuelve la fuente y luego
  // consulta el caché de ESA fuente.
  return refreshDollarRate(businessId, false);
}

/** Fuente configurada por el negocio, normalizada. */
async function resolveConfiguredSource(businessId: string): Promise<{ source: ConfiguredSource; autoUpdate: boolean }> {
  const { data: settings } = await supabase
    .from('business_settings')
    .select('dolar_source, auto_update_rate')
    .eq('business_id', businessId)
    .maybeSingle();

  // Sin fila de settings el negocio no configuró nada: se usan los defaults de
  // la COLUMNA ('nacional'), no un default propio del servicio.
  // Antes acá había `?? 'cordoba'`, así que un negocio nuevo cotizaba Córdoba
  // mientras la pantalla de Configuración mostraba Nacional seleccionada.
  return {
    source:     normalizeDolarSource(settings?.dolar_source).source,
    autoUpdate: settings?.auto_update_rate !== false,
  };
}

/**
 * Fuerza una actualización ignorando el caché.
 * @param businessId
 * @param force si false, respeta el TTL del caché
 */
export async function refreshDollarRate(businessId: string, force = true): Promise<DollarRateResult | null> {
  const { source, autoUpdate } = await resolveConfiguredSource(businessId);

  if (!force) {
    const cached = getFreshCache(businessId, source);
    if (cached) return cached;
  }

  // Si no usa auto-update, devolver valor de DB
  if (!autoUpdate) {
    const dbRate = await getLastDBRate(businessId);
    if (dbRate) { setCache(businessId, source, dbRate); return dbRate; }
    return null;
  }

  // Obtener último valor para validación de variación sospechosa
  const dbRate    = await getLastDBRate(businessId);
  const lastKnown = dbRate?.sellPrice ?? 0;

  // SOLO la fuente configurada. Antes, si la primaria fallaba se consultaba la
  // otra en silencio y su valor se guardaba y se mostraba como si fuera la
  // configurada: un negocio en Nacional terminaba con precios de Córdoba sin
  // que nada lo dijera.
  const raw = await fetchViaEdgeFunction(source, lastKnown);

  if (!raw || !isValidRate(raw.sell)) {
    // Degradación explícita: último valor conocido, marcado como stale y
    // conservando su timestamp y su procedencia real.
    if (dbRate) {
      const stale: DollarRateResult = {
        ...dbRate,
        isStale: true,
        warning: `No pudimos actualizar ${DOLAR_SOURCES[source].label}. Mostrando la última cotización válida.`,
      };
      setCache(businessId, source, stale);
      return stale;
    }
    return null;
  }

  const result: DollarRateResult = {
    sellPrice: raw.sell,
    buyPrice:  raw.buy,
    source:    DISPLAY_SOURCE_BY_CONFIG[source],
    province:  raw.province,
    fetchedAt: new Date(),
    isStale:   false,
    warning:   raw.warning,
  };

  // No guardar si hay variación sospechosa
  if (!raw.warning) {
    await saveRateToDB(businessId, result, rateTagFor(source));
  }

  setCache(businessId, source, result);
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
  await saveRateToDB(businessId, result, 'manual');
  // La cotización manual no pertenece a ninguna fuente externa: se invalida el
  // caché de todas para que la próxima lectura resuelva contra la DB.
  clearDollarCache(businessId);
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
