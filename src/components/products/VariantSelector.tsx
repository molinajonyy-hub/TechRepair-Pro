/**
 * VariantSelector — selector visual de variante para comprobantes, órdenes y mayorista.
 *
 * Carga las variantes de un producto desde product_variants y las muestra
 * como cards modernas con indicadores de stock. Compatible con la arquitectura
 * de stock por variante implementada en productService.
 */
import { useState, useEffect } from 'react'
import { X, Package } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import type { ProductVariant } from '../../services/productService'

const F = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

// ─── Stock indicator ──────────────────────────────────────────────────────────

function stockLevel(stock: number, minStock: number): 'normal' | 'low' | 'out' {
  if (stock <= 0) return 'out'
  if (stock <= minStock) return 'low'
  return 'normal'
}

const STOCK_COLORS = {
  normal: { color: '#22c55e', bg: 'rgba(34,197,94,0.1)',  label: '' },
  low:    { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', label: 'Stock bajo' },
  out:    { color: '#ef4444', bg: 'rgba(239,68,68,0.1)',  label: 'Sin stock' },
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  isOpen:      boolean
  productId:   string
  productName: string
  businessId:  string
  onSelect:    (variant: ProductVariant, inventoryItemId: string) => void
  onClose:     () => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export function VariantSelector({ isOpen, productId, productName, businessId, onSelect, onClose }: Props) {
  const [variants, setVariants] = useState<ProductVariant[]>([])
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    if (!isOpen || !productId) return
    setLoading(true)
    supabase
      .from('product_variants')
      .select('*')
      .eq('product_id', productId)
      .eq('business_id', businessId)
      .eq('active', true)
      .order('sort_order')
      .then(({ data }) => { setVariants((data || []) as ProductVariant[]); setLoading(false) })
  }, [isOpen, productId, businessId])

  if (!isOpen) return null

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', fontFamily: F }}
    >
      <div style={{ background: '#0a1628', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '1.25rem', width: '100%', maxWidth: '520px', boxShadow: '0 40px 96px rgba(0,0,0,0.8)' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.125rem 1.5rem', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <Package size={16} color="#818cf8" />
            <div>
              <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '0.9375rem', fontWeight: 800, letterSpacing: '-0.02em' }}>Seleccionar variante</h3>
              <p style={{ margin: 0, color: '#334155', fontSize: '0.75rem' }}>{productName}</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569' }}>
            <X size={18} />
          </button>
        </div>

        {/* Variants grid */}
        <div style={{ padding: '1rem 1.25rem', maxHeight: '480px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {loading ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#334155', fontSize: '0.85rem' }}>Cargando variantes...</div>
          ) : variants.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#334155', fontSize: '0.85rem' }}>No hay variantes disponibles.</div>
          ) : variants.map(v => {
            const level = stockLevel(v.stock, v.min_stock)
            const sc    = STOCK_COLORS[level]
            const attrs = Object.entries(v.attributes || {})

            return (
              <button
                key={v.id}
                type="button"
                disabled={level === 'out'}
                onClick={() => v.inventory_item_id && onSelect(v, v.inventory_item_id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.875rem',
                  padding: '0.875rem 1rem',
                  background: level === 'out' ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${v.is_default ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.07)'}`,
                  borderLeft: `3px solid ${sc.color}`,
                  borderRadius: '0.75rem',
                  cursor: level === 'out' ? 'not-allowed' : 'pointer',
                  opacity: level === 'out' ? 0.45 : 1,
                  textAlign: 'left', transition: 'all 0.15s',
                }}
                onMouseEnter={e => { if (level !== 'out') e.currentTarget.style.background = 'rgba(99,102,241,0.07)' }}
                onMouseLeave={e => { e.currentTarget.style.background = level === 'out' ? 'rgba(255,255,255,0.01)' : 'rgba(255,255,255,0.03)' }}
              >
                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
                    <span style={{ color: '#f1f5f9', fontWeight: 700, fontSize: '0.875rem' }}>{v.name}</span>
                    {v.is_default && (
                      <span style={{ fontSize: '0.62rem', fontWeight: 800, padding: '0.1rem 0.45rem', borderRadius: '999px', background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }}>
                        DEFAULT
                      </span>
                    )}
                  </div>
                  {attrs.length > 0 && (
                    <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                      {attrs.map(([k, val]) => (
                        <span key={k} style={{ fontSize: '0.68rem', padding: '0.1rem 0.45rem', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', color: '#64748b', border: '1px solid rgba(255,255,255,0.08)' }}>
                          {k}: {val}
                        </span>
                      ))}
                    </div>
                  )}
                  {v.sku && <p style={{ margin: '0.2rem 0 0', color: '#334155', fontSize: '0.68rem' }}>SKU: {v.sku}</p>}
                </div>

                {/* Price + Stock */}
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ color: '#818cf8', fontWeight: 800, fontSize: '0.9375rem' }}>
                    ${(v.sale_price_ars).toLocaleString('es-AR')}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', justifyContent: 'flex-end', marginTop: '0.2rem' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: sc.color, flexShrink: 0 }} />
                    <span style={{ color: sc.color, fontSize: '0.72rem', fontWeight: 600 }}>
                      {level === 'out' ? 'Sin stock' : level === 'low' ? `${v.stock} (bajo)` : `${v.stock} en stock`}
                    </span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
