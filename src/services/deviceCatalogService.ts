/**
 * deviceCatalogService — fuente única para marcas y modelos de dispositivos.
 *
 * Todas las funciones usan la RPC ensure_brand_and_model / get_or_create_brand /
 * get_or_create_model para garantizar:
 *   - deduplicación case-insensitive (normalización en DB)
 *   - RLS por business_id
 *   - manejo de concurrencia (ON CONFLICT DO NOTHING)
 *
 * El catálogo es persistente y reutilizable entre órdenes.
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

function isValidName(s: string): boolean {
  const lower = s.trim().toLowerCase()
  return lower.length > 0 && !['null', 'undefined', 'n/a', '-', ' '].includes(lower)
}

async function getBusinessId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from('profiles')
    .select('business_id')
    .eq('user_id', user.id)
    .single()
  return data?.business_id ?? null
}

// ─── Read ──────────────────────────────────────────────────────────────────────

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
    console.warn('[deviceCatalogService] getBrands error', error.message)
    return []
  }
  return (data as BrandItem[]) ?? []
}

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
    console.warn('[deviceCatalogService] getModels error', error.message)
    return []
  }
  return (data as ModelItem[]) ?? []
}

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
 * Ensures a brand exists in the catalog.
 * Deduplication by normalized name (lower+trim) happens server-side.
 * Returns the brand UUID.
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
    console.warn('[deviceCatalogService] ensureBrand error', error.message)
    return null
  }
  return data as string
}

/**
 * Ensures a model exists under a brand.
 * Returns the model UUID.
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
    console.warn('[deviceCatalogService] ensureModel error', error.message)
    return null
  }
  return data as string
}

/**
 * Ensures both brand and model exist in one atomic call.
 * Returns { brandId, modelId } or null if brand/model name is invalid.
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
    console.warn('[deviceCatalogService] ensureBrandAndModel error', error.message)
    return null
  }

  const result = data as { brand_id: string; model_id: string } | null
  if (!result?.brand_id || !result?.model_id) return null
  return { brandId: result.brand_id, modelId: result.model_id }
}
