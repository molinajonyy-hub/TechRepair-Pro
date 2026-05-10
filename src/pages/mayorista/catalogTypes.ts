export interface CatalogItem {
  id: string
  code: string | null
  name: string
  category: string
  subcategory: string | null
  stock_quantity: number
  min_stock: number
  cost_price: number
  sale_price: number
  precio_mayorista: number | null
  visible_in_wholesale: boolean
  is_active: boolean
  // Portal catalog fields
  portal_title: string | null
  portal_description: string | null
  portal_description_full: string | null
  portal_compatibility: string | null
  portal_tags: string[] | null
  portal_featured: boolean
  portal_is_new: boolean
  portal_on_sale: boolean
  portal_sort_order: number
  portal_condition: string
  portal_warranty: string | null
  portal_notes: string | null
  portal_specs: Record<string, string> | null
  portal_min_qty: number
  portal_main_image: string | null
  portal_images: string[] | null
}
