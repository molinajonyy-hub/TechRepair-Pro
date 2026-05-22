/**
 * deviceCatalogService — fuente única para marcas y modelos de dispositivos.
 *
 * Persiste marcas/modelos por negocio (business_id-scoped).
 * Usa RPCs atómicas con deduplicación case-insensitive (normalized_name).
 * Combina datos de DB con fallbacks hardcodeados para garantizar UX incluso
 * cuando el catálogo del negocio está vacío o la DB falla.
 */
import { supabase } from '../lib/supabase'

export interface BrandItem {
  id:   string
  name: string
}

export interface ModelItem {
  id:       string
  name:     string
  brand_id: string
}

// ─── Fallbacks (siempre visibles aunque DB esté vacía) ────────────────────────

export const DEFAULT_BRANDS: string[] = [
  'Apple', 'Samsung', 'Xiaomi', 'Motorola', 'Huawei',
  'LG', 'Nokia', 'Sony', 'Lenovo', 'Asus',
  'OnePlus', 'Realme', 'Oppo', 'Vivo', 'Honor',
]

export const DEFAULT_MODELS_BY_BRAND: Record<string, string[]> = {
  'Apple':    ['iPhone 11', 'iPhone 12', 'iPhone 13', 'iPhone 14', 'iPhone 15', 'iPad Air', 'iPad Mini'],
  'Samsung':  ['Galaxy A14', 'Galaxy A34', 'Galaxy A54', 'Galaxy S21', 'Galaxy S22', 'Galaxy S23', 'Galaxy Tab A8'],
  'Xiaomi':   ['Redmi Note 11', 'Redmi Note 12', 'Redmi Note 13', 'Poco X5', 'Poco X6', 'Xiaomi 13'],
  'Motorola': ['Moto G54', 'Moto G84', 'Moto G200', 'Edge 40', 'Edge 50 Fusion'],
  'Huawei':   ['P30', 'P40 Lite', 'P50', 'Nova 9', 'MatePad'],
  'LG':       ['K52', 'Velvet', 'G8 ThinQ'],
  'Nokia':    ['G21', 'G42', 'C32', 'X30'],
  'Sony':     ['Xperia 10 IV', 'Xperia 10 V', 'Xperia 1 V'],
  'Lenovo':   ['Tab M10', 'Tab P11', 'IdeaPad 3'],
  'Asus':     ['Zenfone 9', 'Zenfone 10', 'ROG Phone 6'],
  'OnePlus':  ['Nord CE 3', 'Nord 3', '11', '12'],
  'Realme':   ['C55', 'GT 5', 'Narzo 60'],
  'Oppo':     ['Reno 10', 'A78', 'Find X6'],
  'Vivo':     ['Y35', 'V29', 'X90'],
  'Honor':    ['90', 'Magic 6 Lite', 'X9b'],
}

// ─── businessId helper ────────────────────────────────────────────────────────

async function getBusinessId(): Promise<string | null> {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    // Use the RPC that api.ts already uses — get_my_profile returns business_id
    const { data } = await supabase.rpc('get_my_profile')
    const profile = Array.isArray(data) ? data[0] : data
    return (profile as any)?.business_id ?? null
  } catch {
    return null
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

function isValidName(s: string): boolean {
  const lower = s.trim().toLowerCase()
  return lower.length > 0 && !['null', 'undefined', 'n/a', '-'].includes(lower)
}

// ─── Read ──────────────────────────────────────────────────────────────────────

/**
 * Returns brands from DB for the current business.
 * Returns empty array on error (caller combines with DEFAULT_BRANDS).
 */
export async function getBrands(): Promise<BrandItem[]> {
  const businessId = await getBusinessId()
  if (!businessId) return []

  const { data, error } = await supabase
    .from('brands')
    .select('id, name')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .order('name')

  if (error) {
    console.warn('[deviceCatalogService] getBrands error', error.code, error.message)
    return []
  }
  const result = (data as BrandItem[]) ?? []
  return result
}

/**
 * Returns models for a given brand UUID.
 * Returns empty array on error (caller combines with DEFAULT_MODELS_BY_BRAND).
 */
export async function getModels(brandId: string): Promise<ModelItem[]> {
  const businessId = await getBusinessId()
  if (!businessId) return []

  const { data, error } = await supabase
    .from('device_models')
    .select('id, name, brand_id')
    .eq('business_id', businessId)
    .eq('brand_id', brandId)
    .eq('is_active', true)
    .order('name')

  if (error) {
    console.warn('[deviceCatalogService] getModels error', error.code, error.message)
    return []
  }
  const result = (data as ModelItem[]) ?? []
  return result
}

/**
 * Find a brand by name (case-insensitive) for the current business.
 */
export async function getBrandByName(name: string): Promise<BrandItem | null> {
  const businessId = await getBusinessId()
  if (!businessId) return null
  const { data } = await supabase
    .from('brands')
    .select('id, name')
    .eq('business_id', businessId)
    .ilike('name', name.trim())
    .maybeSingle()
  return data as BrandItem | null
}

// ─── Write (ensure = find-or-create) ─────────────────────────────────────────

/**
 * Ensures a brand exists in the catalog for the current business.
 * Deduplication by normalized_name happens server-side.
 * Returns the brand UUID, or null on failure.
 */
export async function ensureBrand(name: string): Promise<string | null> {
  if (!isValidName(name)) return null
  const businessId = await getBusinessId()
  if (!businessId) return null

  const { data, error } = await supabase.rpc('get_or_create_brand', {
    p_name:        normalizeText(name),
    p_business_id: businessId,
  })

  if (error) {
    console.warn('[deviceCatalogService] ensureBrand error', error.code, error.message)
    return null
  }
  return data as string
}

/**
 * Ensures a model exists under a brand for the current business.
 * Returns the model UUID, or null on failure.
 */
export async function ensureModel(
  modelName: string,
  brandId:   string
): Promise<string | null> {
  if (!isValidName(modelName) || !brandId) return null
  const businessId = await getBusinessId()
  if (!businessId) return null

  const { data, error } = await supabase.rpc('get_or_create_model', {
    p_name:        normalizeText(modelName),
    p_brand_id:    brandId,
    p_business_id: businessId,
  })

  if (error) {
    console.warn('[deviceCatalogService] ensureModel error', error.code, error.message)
    return null
  }
  return data as string
}

/**
 * Ensures both brand and model exist in one atomic RPC call.
 * Returns { brandId, modelId } or null on failure.
 * Non-blocking: caller should handle null gracefully.
 */
export async function ensureBrandAndModel(
  brandName: string,
  modelName: string
): Promise<{ brandId: string; modelId: string } | null> {
  if (!isValidName(brandName) || !isValidName(modelName)) return null
  const businessId = await getBusinessId()
  if (!businessId) return null

  const { data, error } = await supabase.rpc('ensure_brand_and_model', {
    p_brand_name:  normalizeText(brandName),
    p_model_name:  normalizeText(modelName),
    p_business_id: businessId,
  })

  if (error) {
    console.warn('[deviceCatalogService] ensureBrandAndModel error', error.code, error.message)
    return null
  }

  const result = data as { brand_id: string; model_id: string } | null
  if (!result?.brand_id || !result?.model_id) return null
  return { brandId: result.brand_id, modelId: result.model_id }
}
