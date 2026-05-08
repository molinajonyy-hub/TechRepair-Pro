import { useState, useEffect, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Search, ShoppingCart, Plus, LogOut } from 'lucide-react'
import { usePortal } from '../contexts/PortalContext'
import { usePortalCart } from '../hooks/usePortalCart'
import { getCatalog } from '../services/portalService'
import { logoutCustomer } from '../services/portalService'
import { PortalLayout, PortalCard, PT } from '../components/PortalLayout'
import type { PortalProduct } from '../types'

function fmtARS(n: number) {
  return '$' + Math.round(n).toLocaleString('es-AR')
}

function ProductCardItem({
  product, onAdd,
}: {
  product: PortalProduct
  onAdd: (p: PortalProduct) => void
}) {
  const price = (product.precio_mayorista ?? 0) > 0
    ? product.precio_mayorista!
    : product.sale_price

  const savings = product.sale_price > price ? product.sale_price - price : 0
  const savingsPct = product.sale_price > 0 ? Math.round((savings / product.sale_price) * 100) : 0

  return (
    <div style={{
      background: PT.surface, borderRadius: PT.radiusLg,
      boxShadow: PT.shadow, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header with category */}
      <div style={{ padding: '0.875rem 1rem 0.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
          <div style={{ flex: 1 }}>
            <p style={{ margin: '0 0 0.2rem', fontSize: '0.72rem', color: PT.textSub, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {product.category}
            </p>
            <p style={{ margin: 0, fontWeight: 600, fontSize: '0.95rem', color: PT.text, lineHeight: 1.3 }}>
              {product.name}
            </p>
            {product.code && (
              <p style={{ margin: '0.2rem 0 0', fontSize: '0.72rem', color: PT.textSub, fontFamily: 'monospace' }}>
                SKU {product.code}
              </p>
            )}
          </div>
          {product.stock_quantity <= 5 && (
            <span style={{ flexShrink: 0, padding: '0.15rem 0.5rem', borderRadius: '99px', background: `${PT.warning}20`, color: PT.warning, fontSize: '0.7rem', fontWeight: 700 }}>
              Quedan {product.stock_quantity}
            </span>
          )}
        </div>
      </div>

      {/* Price + add button */}
      <div style={{ padding: '0.5rem 1rem 0.875rem', borderTop: `1px solid ${PT.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
        <div>
          <div style={{ fontSize: '1.25rem', fontWeight: 800, color: PT.text, letterSpacing: '-0.02em', fontFamily: 'monospace' }}>
            {fmtARS(price)}
          </div>
          {savings > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
              <span style={{ fontSize: '0.78rem', color: PT.textSub, textDecoration: 'line-through' }}>
                {fmtARS(product.sale_price)}
              </span>
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: PT.success, background: `${PT.success}15`, padding: '0.1rem 0.35rem', borderRadius: '4px' }}>
                -{savingsPct}%
              </span>
            </div>
          )}
        </div>
        <button
          onClick={() => onAdd(product)}
          style={{
            width: 44, height: 44, borderRadius: '50%',
            background: PT.primary, border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', flexShrink: 0,
            boxShadow: `0 2px 8px ${PT.primary}40`,
          }}
        >
          <Plus size={22} color="#fff" />
        </button>
      </div>
    </div>
  )
}

export function PortalCatalog() {
  const { slug } = useParams<{ slug: string }>()
  const { business, customer, setCustomer } = usePortal()
  const navigate = useNavigate()
  const { addItem, itemCount } = usePortalCart(business?.id || '')

  const [products, setProducts] = useState<PortalProduct[]>([])
  const [loading,  setLoading]  = useState(true)
  const [search,   setSearch]   = useState('')
  const [category, setCategory] = useState('all')
  const [toast,    setToast]    = useState('')

  useEffect(() => {
    if (!business) return
    getCatalog(business.id)
      .then(ps => { setProducts(ps); setLoading(false) })
      .catch(() => setLoading(false))
  }, [business])

  const categories = useMemo(() => {
    const set = new Set(products.map(p => p.category))
    return ['all', ...Array.from(set).sort()]
  }, [products])

  const filtered = useMemo(() => {
    let list = products
    if (category !== 'all') list = list.filter(p => p.category === category)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.code || '').toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      )
    }
    return list
  }, [products, category, search])

  const handleAdd = (p: PortalProduct) => {
    const price = (p.precio_mayorista ?? 0) > 0 ? p.precio_mayorista! : p.sale_price
    addItem({
      inventoryItemId: p.id,
      productName:     p.name,
      productCode:     p.code,
      unitPrice:       price,
      quantity:        1,
      stock:           p.stock_quantity,
    })
    setToast(`${p.name.substring(0, 30)} agregado`)
    setTimeout(() => setToast(''), 2000)
  }

  const handleLogout = async () => {
    await logoutCustomer()
    setCustomer(null)
    navigate(`/mayorista/${slug}/login`)
  }

  return (
    <PortalLayout showCart showBack={false}>
      {/* Greeting */}
      <div style={{ padding: '1rem 1rem 0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <p style={{ margin: 0, fontSize: '0.8rem', color: PT.textSub }}>Hola,</p>
          <p style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: PT.text }}>
            {customer?.business_name || customer?.name}
          </p>
        </div>
        <button onClick={handleLogout} style={{ background: 'none', border: 'none', cursor: 'pointer', color: PT.textSub, display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem' }}>
          <LogOut size={15} /> Salir
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: '0 1rem 0.75rem' }}>
        <div style={{ position: 'relative' }}>
          <Search size={16} style={{ position: 'absolute', left: '0.875rem', top: '50%', transform: 'translateY(-50%)', color: PT.textSub, pointerEvents: 'none' }} />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Buscar producto, SKU..."
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '0.75rem 1rem 0.75rem 2.5rem',
              background: PT.surface, border: `1px solid ${PT.border}`,
              borderRadius: PT.radius, color: PT.text,
              fontFamily: PT.font, fontSize: '1rem', outline: 'none',
            }}
          />
        </div>
      </div>

      {/* Category pills */}
      <div style={{ padding: '0 1rem 1rem', overflowX: 'auto', display: 'flex', gap: '0.5rem', scrollbarWidth: 'none' }}>
        {categories.map(c => (
          <button key={c} onClick={() => setCategory(c)}
            style={{
              flexShrink: 0, padding: '0.4rem 0.875rem', borderRadius: '99px',
              background: category === c ? PT.primary : PT.surface,
              color: category === c ? '#fff' : PT.textSub,
              border: `1px solid ${category === c ? PT.primary : PT.border}`,
              fontFamily: PT.font, fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
              transition: 'all 0.15s',
            }}>
            {c === 'all' ? 'Todo' : c}
          </button>
        ))}
      </div>

      {/* Products */}
      <div style={{ padding: '0 1rem' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', border: `3px solid ${PT.primary}`, borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : filtered.length === 0 ? (
          <PortalCard style={{ padding: '3rem', textAlign: 'center' }}>
            <p style={{ color: PT.textSub, margin: 0 }}>
              {products.length === 0 ? 'El catálogo estará disponible próximamente.' : 'Sin resultados para esa búsqueda.'}
            </p>
          </PortalCard>
        ) : (
          <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {filtered.map(p => (
              <ProductCardItem key={p.id} product={p} onAdd={handleAdd} />
            ))}
          </div>
        )}
      </div>

      {/* Cart FAB when items */}
      {itemCount > 0 && (
        <div style={{ position: 'fixed', bottom: '1.5rem', left: '50%', transform: 'translateX(-50%)', zIndex: 200 }}>
          <button
            onClick={() => navigate(`/mayorista/${slug}/carrito`)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              padding: '0.875rem 1.75rem',
              background: PT.primary, color: '#fff', border: 'none',
              borderRadius: '99px', cursor: 'pointer',
              fontFamily: PT.font, fontSize: '1rem', fontWeight: 700,
              boxShadow: `0 8px 24px ${PT.primary}50`,
            }}
          >
            <ShoppingCart size={20} />
            Ver pedido · {itemCount} {itemCount === 1 ? 'item' : 'items'}
          </button>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: itemCount > 0 ? '5.5rem' : '1.5rem', left: '50%', transform: 'translateX(-50%)',
          background: '#1c1c1e', color: '#fff', padding: '0.625rem 1.25rem',
          borderRadius: '99px', fontSize: '0.85rem', fontWeight: 500,
          boxShadow: PT.shadowMd, zIndex: 300, whiteSpace: 'nowrap',
          animation: 'fadeIn 0.2s',
        }}>
          ✓ {toast}
        </div>
      )}
      <style>{`@keyframes fadeIn { from { opacity:0; transform: translateX(-50%) translateY(8px); } to { opacity:1; transform: translateX(-50%) translateY(0); } }`}</style>
    </PortalLayout>
  )
}
