/**
 * portalAdminService — Administrador visual del Portal Mayorista Clic
 *
 * Lee datos base de `inventory` (nombre, precio, stock) y combina con
 * `clic_wholesale_product_settings` para la configuración editorial.
 */

import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export type PortalBadge = 'nuevo' | 'oferta' | 'mas_vendido' | 'ultimas_unidades' | null

export interface ProductSettings {
  id:               string | null   // null si no existe aún en la tabla
  inventory_id:     string
  main_image_url:   string | null
  gallery_images:   string[]
  short_description: string | null
  description:       string | null
  features:          string[]
  is_visible:        boolean
  is_featured:       boolean
  badge:             PortalBadge
  min_quantity:      number
  display_order:     number
  internal_notes:    string | null
}

export interface AdminProduct {
  // Desde inventory (solo lectura)
  inventory_id:    string
  code:            string | null
  name:            string
  category:        string
  stock_quantity:  number
  sale_price:      number
  precio_mayorista: number | null
  cost_price:      number
  // Desde clic_wholesale_product_settings (editable)
  settings:        ProductSettings
}

export const BADGE_LABELS: Record<string, string> = {
  nuevo:           'Nuevo',
  oferta:          'Oferta',
  mas_vendido:     'Más vendido',
  ultimas_unidades:'Últimas unidades',
}

const emptySettings = (inventoryId: string): ProductSettings => ({
  id: null, inventory_id: inventoryId,
  main_image_url: null, gallery_images: [],
  short_description: null, description: null, features: [],
  is_visible: false, is_featured: false, badge: null,
  min_quantity: 1, display_order: 0, internal_notes: null,
})

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function getAdminProducts(businessId: string): Promise<AdminProduct[]> {
  const [invRes, settingsRes] = await Promise.all([
    supabase
      .from('inventory')
      .select('id, code, name, category, stock_quantity, sale_price, precio_mayorista, cost_price')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('category')
      .order('name'),

    supabase
      .from('clic_wholesale_product_settings')
      .select('*')
      .eq('business_id', businessId),
  ])

  const settingsMap = new Map(
    (settingsRes.data || []).map((s: any) => [s.inventory_id as string, s])
  )

  return (invRes.data || []).map((inv: any): AdminProduct => {
    const s = settingsMap.get(inv.id) as any | undefined
    const settings: ProductSettings = s ? {
      id:               s.id,
      inventory_id:     inv.id,
      main_image_url:   s.main_image_url   || null,
      gallery_images:   s.gallery_images   || [],
      short_description: s.short_description || null,
      description:       s.description      || null,
      features:          s.features         || [],
      is_visible:        s.is_visible       ?? false,
      is_featured:       s.is_featured      ?? false,
      badge:             s.badge            || null,
      min_quantity:      s.min_quantity     ?? 1,
      display_order:     s.display_order    ?? 0,
      internal_notes:    s.internal_notes   || null,
    } : emptySettings(inv.id)

    return {
      inventory_id:    inv.id,
      code:            inv.code            || null,
      name:            inv.name,
      category:        inv.category,
      stock_quantity:  inv.stock_quantity,
      sale_price:      inv.sale_price,
      precio_mayorista: inv.precio_mayorista ?? null,
      cost_price:      inv.cost_price,
      settings,
    }
  })
}

export async function upsertSettings(
  businessId: string,
  inventoryId: string,
  patch: Partial<ProductSettings>,
): Promise<{ error: string | null }> {
  const payload = {
    business_id:       businessId,
    inventory_id:      inventoryId,
    ...(patch.main_image_url   !== undefined && { main_image_url:   patch.main_image_url }),
    ...(patch.gallery_images   !== undefined && { gallery_images:   patch.gallery_images }),
    ...(patch.short_description !== undefined && { short_description: patch.short_description }),
    ...(patch.description      !== undefined && { description:      patch.description }),
    ...(patch.features         !== undefined && { features:         patch.features }),
    ...(patch.is_visible       !== undefined && { is_visible:       patch.is_visible }),
    ...(patch.is_featured      !== undefined && { is_featured:      patch.is_featured }),
    ...(patch.badge            !== undefined && { badge:            patch.badge }),
    ...(patch.min_quantity     !== undefined && { min_quantity:     patch.min_quantity }),
    ...(patch.display_order    !== undefined && { display_order:    patch.display_order }),
    ...(patch.internal_notes   !== undefined && { internal_notes:   patch.internal_notes }),
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabase
    .from('clic_wholesale_product_settings')
    .upsert(payload, { onConflict: 'business_id,inventory_id' })

  return { error: error?.message || null }
}

// ─── Image upload ─────────────────────────────────────────────────────────────

const BUCKET = 'clic-wholesale-products'

export async function uploadProductImage(
  businessId: string,
  inventoryId: string,
  file: File,
): Promise<{ url: string | null; error: string | null }> {
  const ext  = file.name.split('.').pop() || 'jpg'
  const path = `${businessId}/${inventoryId}/${Date.now()}.${ext}`

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: true })

  if (upErr) return { url: null, error: upErr.message }

  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return { url: publicUrl, error: null }
}

export async function deleteProductImage(url: string): Promise<void> {
  // Extraer path relativo del bucket de la URL pública
  const match = url.match(/clic-wholesale-products\/(.+)$/)
  if (!match) return
  await supabase.storage.from(BUCKET).remove([match[1]])
}

// ─── Portal catalog (usado por el portal público) ─────────────────────────────

/** Retorna productos visibles para el portal, combinando inventory + settings */
export async function getPortalCatalogFromSettings(businessId: string) {
  const { data } = await supabase
    .from('clic_wholesale_product_settings')
    .select(`
      inventory_id, main_image_url, gallery_images, short_description,
      description, features, is_featured, badge, min_quantity, display_order,
      inventory:inventory!inner(id, name, code, category, stock_quantity, sale_price, precio_mayorista)
    `)
    .eq('business_id', businessId)
    .eq('is_visible', true)
    .gt('inventory.stock_quantity', 0)
    .order('display_order')
  return data || []
}
