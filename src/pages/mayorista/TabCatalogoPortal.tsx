import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Search, Tag, Loader2,
  RefreshCw, Filter, ExternalLink, Edit2, AlertCircle,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { ModalFichaPortal } from './ModalFichaPortal'
import type { CatalogItem } from './catalogTypes'

// ─── Types / helpers ─────────────────────────────────────────────────────────

const fmtARS = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n || 0)

const BADGE = (label: string, color: string, bg: string) => (
  <span style={{ padding: '0.15rem 0.45rem', borderRadius: '0.25rem', fontSize: '0.62rem', fontWeight: 700, background: bg, color }}>{label}</span>
)

// ─── Toggle cell with auto-save ───────────────────────────────────────────────

function Toggle({
  value, onToggle, color = '#22c55e',
}: { value: boolean; onToggle: () => void; color?: string }) {
  return (
    <button
      onClick={onToggle}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
        background: value ? color : 'rgba(255,255,255,0.1)',
        position: 'relative', transition: 'background 0.2s', flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2,
        left: value ? 18 : 2,
        width: 16, height: 16, borderRadius: '50%',
        background: '#fff', transition: 'left 0.2s',
      }} />
    </button>
  )
}

// ─── Inline price editor ──────────────────────────────────────────────────────

function PriceCell({
  value, onSave, placeholder,
}: { value: number | null; onSave: (n: number | null) => Promise<void>; placeholder: string }) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(String(value ?? ''))
  const [saving,  setSaving]  = useState(false)

  const commit = async () => {
    const n = draft === '' ? null : parseFloat(draft) || 0
    if (n === value) { setEditing(false); return }
    setSaving(true)
    await onSave(n)
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        style={{ width: 90, padding: '0.25rem 0.5rem', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(99,102,241,0.5)', borderRadius: '0.375rem', color: '#818cf8', fontSize: '0.82rem', fontFamily: 'monospace', outline: 'none' }}
      />
    )
  }

  return (
    <button
      onClick={() => { setDraft(String(value ?? '')); setEditing(true) }}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: value ? '#818cf8' : '#334155', fontFamily: 'monospace', fontSize: '0.82rem', padding: '0.2rem 0.4rem', borderRadius: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
    >
      {saving ? <Loader2 size={11} style={{ animation: 'tr-spin 0.8s linear infinite' }} /> : <Edit2 size={11} style={{ opacity: 0.5 }} />}
      {value ? fmtARS(value) : <span style={{ color: '#334155' }}>{placeholder}</span>}
    </button>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  businessId: string
  portalSlug: string
}

export function TabCatalogoPortal({ businessId, portalSlug }: Props) {
  const [items,    setItems]    = useState<CatalogItem[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [search,   setSearch]   = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [visFilter, setVisFilter] = useState<'all' | 'visible' | 'hidden'>('all')
  const [badgeFilter, setBadgeFilter] = useState<'all' | 'featured' | 'new' | 'sale'>('all')
  const [editItem, setEditItem] = useState<CatalogItem | null>(null)
  const [saving,   setSaving]   = useState<string | null>(null) // item id being saved

  const load = useCallback(async () => {
    if (!businessId) return
    setLoading(true); setError('')
    const { data, error: e } = await supabase
      .from('inventory')
      .select(`
        id, code, name, category, subcategory,
        stock_quantity, min_stock, cost_price, sale_price,
        precio_mayorista, visible_in_wholesale, is_active,
        portal_title, portal_description, portal_description_full,
        portal_compatibility, portal_tags, portal_featured,
        portal_is_new, portal_on_sale, portal_sort_order,
        portal_condition, portal_warranty, portal_notes,
        portal_specs, portal_min_qty, portal_main_image, portal_images
      `)
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('portal_sort_order', { ascending: true })
      .order('name', { ascending: true })
    if (e) { setError(e.message); setLoading(false); return }
    setItems((data || []) as CatalogItem[])
    setLoading(false)
  }, [businessId])

  useEffect(() => { load() }, [load])

  // patch one item field locally + save to DB
  const patch = useCallback(async (id: string, changes: Partial<CatalogItem>) => {
    setSaving(id)
    setItems(prev => prev.map(i => i.id === id ? { ...i, ...changes } : i))
    const { error: e } = await supabase
      .from('inventory')
      .update({ ...changes, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('business_id', businessId)
    if (e) console.error('[TabCatalogoPortal] patch error:', e.message)
    setSaving(null)
  }, [businessId])

  const cats = useMemo(() => [...new Set(items.map(i => i.category))].sort(), [items])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return items.filter(i => {
      if (q && !(
        i.name.toLowerCase().includes(q) ||
        (i.code || '').toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q) ||
        (i.portal_title || '').toLowerCase().includes(q)
      )) return false
      if (catFilter && i.category !== catFilter) return false
      if (visFilter === 'visible' && !i.visible_in_wholesale) return false
      if (visFilter === 'hidden'  && i.visible_in_wholesale)  return false
      if (badgeFilter === 'featured' && !i.portal_featured) return false
      if (badgeFilter === 'new'      && !i.portal_is_new)   return false
      if (badgeFilter === 'sale'     && !i.portal_on_sale)  return false
      return true
    })
  }, [items, search, catFilter, visFilter, badgeFilter])

  const visCount = items.filter(i => i.visible_in_wholesale).length

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>

      {/* Stats + controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '1.25rem', fontSize: '0.82rem', color: '#64748b' }}>
          <span><strong style={{ color: '#818cf8' }}>{visCount}</strong> visibles · {items.length - visCount} ocultos · {items.length} total</span>
          <span style={{ color: '#334155' }}>|</span>
          <span><strong style={{ color: '#f59e0b' }}>{items.filter(i => i.portal_featured).length}</strong> destacados</span>
          <span><strong style={{ color: '#34d399' }}>{items.filter(i => i.portal_is_new).length}</strong> nuevos</span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.75rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#64748b', fontSize: '0.75rem', cursor: 'pointer' }}>
            <RefreshCw size={12} /> Actualizar
          </button>
          {portalSlug && (
            <a href={`/mayorista/${portalSlug}/catalogo`} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.375rem 0.75rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.5rem', color: '#818cf8', fontSize: '0.75rem', textDecoration: 'none', fontWeight: 600 }}>
              <ExternalLink size={12} /> Ver portal
            </a>
          )}
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.625rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Search */}
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={13} style={{ position: 'absolute', left: '0.625rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre, SKU, título portal..." style={{ width: '100%', boxSizing: 'border-box', padding: '0.4rem 0.75rem 0.4rem 2rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#f1f5f9', fontSize: '0.8rem', outline: 'none' }} />
        </div>

        {/* Category */}
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{ padding: '0.4rem 0.625rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#94a3b8', fontSize: '0.8rem', outline: 'none' }}>
          <option value="">Todas las categorías</option>
          {cats.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        {/* Visibility */}
        <div style={{ display: 'flex', gap: '0.2rem', background: 'rgba(255,255,255,0.03)', padding: '0.2rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.07)' }}>
          {([['all','Todos'],['visible','Visibles'],['hidden','Ocultos']] as const).map(([v,l]) => (
            <button key={v} onClick={() => setVisFilter(v)} style={{ padding: '0.25rem 0.6rem', borderRadius: '0.35rem', border: 'none', background: visFilter === v ? 'rgba(99,102,241,0.2)' : 'transparent', color: visFilter === v ? '#818cf8' : '#475569', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}>{l}</button>
          ))}
        </div>

        {/* Badge filter */}
        <div style={{ display: 'flex', gap: '0.2rem', background: 'rgba(255,255,255,0.03)', padding: '0.2rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.07)' }}>
          {([['all','Todos'],['featured','Destacados'],['new','Nuevos'],['sale','Ofertas']] as const).map(([v,l]) => (
            <button key={v} onClick={() => setBadgeFilter(v)} style={{ padding: '0.25rem 0.6rem', borderRadius: '0.35rem', border: 'none', background: badgeFilter === v ? 'rgba(245,158,11,0.18)' : 'transparent', color: badgeFilter === v ? '#f59e0b' : '#475569', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}>{l}</button>
          ))}
        </div>

        <span style={{ fontSize: '0.75rem', color: '#334155' }}>{filtered.length} productos</span>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 1rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '0.5rem', color: '#f87171', fontSize: '0.82rem', marginBottom: '1rem' }}>
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
          <Loader2 size={24} style={{ animation: 'tr-spin 1s linear infinite', color: '#6366f1' }} />
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: '0.75rem', border: '1px solid rgba(255,255,255,0.06)', color: '#475569' }}>
          Sin productos para mostrar.
        </div>
      ) : (
        <div style={{ background: '#111827', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.875rem', overflow: 'hidden', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {['Producto','Categoría','Stock','Precio normal','Precio mayorista','Min. qty','Visible','Destac.','Nuevo','Oferta','Badges','Ficha'].map((h, i) => (
                  <th key={h} style={{ padding: '0.5rem 0.75rem', textAlign: i >= 6 ? 'center' : 'left', color: '#334155', fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((item, idx) => {
                const isSaving = saving === item.id
                return (
                  <tr key={item.id} style={{ borderBottom: idx < filtered.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', background: isSaving ? 'rgba(99,102,241,0.04)' : 'transparent', transition: 'background 0.15s' }}>
                    {/* Product */}
                    <td style={{ padding: '0.625rem 0.75rem', maxWidth: 220 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                        {/* Thumbnail */}
                        {item.portal_main_image ? (
                          <img src={item.portal_main_image} alt="" style={{ width: 32, height: 32, borderRadius: '0.375rem', objectFit: 'cover', flexShrink: 0 }} />
                        ) : (
                          <div style={{ width: 32, height: 32, borderRadius: '0.375rem', background: 'rgba(255,255,255,0.05)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Filter size={12} style={{ color: '#334155' }} />
                          </div>
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.portal_title || item.name}</div>
                          {item.portal_title && item.portal_title !== item.name && (
                            <div style={{ fontSize: '0.68rem', color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
                          )}
                          {item.code && <div style={{ fontSize: '0.65rem', color: '#1e3a5f', fontFamily: 'monospace' }}>{item.code}</div>}
                        </div>
                      </div>
                    </td>

                    {/* Category */}
                    <td style={{ padding: '0.625rem 0.75rem', color: '#64748b', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{item.category}</td>

                    {/* Stock */}
                    <td style={{ padding: '0.625rem 0.75rem', fontFamily: 'monospace', fontSize: '0.82rem', color: item.stock_quantity <= (item.min_stock || 0) ? '#f59e0b' : '#94a3b8', whiteSpace: 'nowrap' }}>{item.stock_quantity}</td>

                    {/* Precio normal */}
                    <td style={{ padding: '0.625rem 0.75rem', fontFamily: 'monospace', fontSize: '0.78rem', color: '#475569', whiteSpace: 'nowrap' }}>{fmtARS(item.sale_price)}</td>

                    {/* Precio mayorista — inline editable */}
                    <td style={{ padding: '0.375rem 0.5rem', whiteSpace: 'nowrap' }}>
                      <PriceCell
                        value={item.precio_mayorista}
                        placeholder="Sin precio"
                        onSave={n => patch(item.id, { precio_mayorista: n })}
                      />
                    </td>

                    {/* Min qty — inline editable */}
                    <td style={{ padding: '0.375rem 0.5rem' }}>
                      <input
                        type="number" min="1" step="1"
                        value={item.portal_min_qty || 1}
                        onChange={e => patch(item.id, { portal_min_qty: parseInt(e.target.value) || 1 })}
                        style={{ width: 52, padding: '0.2rem 0.4rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.375rem', color: '#94a3b8', fontSize: '0.78rem', fontFamily: 'monospace', outline: 'none', textAlign: 'center' }}
                      />
                    </td>

                    {/* Visible */}
                    <td style={{ padding: '0.625rem 0.75rem', textAlign: 'center' }}>
                      <Toggle value={item.visible_in_wholesale} color="#22c55e" onToggle={() => patch(item.id, { visible_in_wholesale: !item.visible_in_wholesale })} />
                    </td>

                    {/* Destacado */}
                    <td style={{ padding: '0.625rem 0.75rem', textAlign: 'center' }}>
                      <Toggle value={item.portal_featured} color="#f59e0b" onToggle={() => patch(item.id, { portal_featured: !item.portal_featured })} />
                    </td>

                    {/* Nuevo */}
                    <td style={{ padding: '0.625rem 0.75rem', textAlign: 'center' }}>
                      <Toggle value={item.portal_is_new} color="#34d399" onToggle={() => patch(item.id, { portal_is_new: !item.portal_is_new })} />
                    </td>

                    {/* Oferta */}
                    <td style={{ padding: '0.625rem 0.75rem', textAlign: 'center' }}>
                      <Toggle value={item.portal_on_sale} color="#f87171" onToggle={() => patch(item.id, { portal_on_sale: !item.portal_on_sale })} />
                    </td>

                    {/* Badges summary */}
                    <td style={{ padding: '0.625rem 0.5rem' }}>
                      <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                        {item.portal_featured && BADGE('Dest.', '#f59e0b', 'rgba(245,158,11,0.12)')}
                        {item.portal_is_new   && BADGE('Nuevo', '#34d399', 'rgba(52,211,153,0.1)')}
                        {item.portal_on_sale  && BADGE('Oferta','#f87171','rgba(248,113,113,0.1)')}
                        {item.portal_tags && item.portal_tags.length > 0 && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: '0.15rem', padding: '0.1rem 0.35rem', borderRadius: '0.2rem', fontSize: '0.6rem', color: '#64748b', background: 'rgba(255,255,255,0.04)' }}>
                            <Tag size={9} /> {item.portal_tags.length}
                          </span>
                        )}
                        {item.portal_main_image && <span style={{ fontSize: '0.6rem', color: '#475569', padding: '0.1rem 0.25rem', background: 'rgba(255,255,255,0.03)', borderRadius: '0.2rem' }}>+img</span>}
                      </div>
                    </td>

                    {/* Edit ficha */}
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                      <button
                        onClick={() => setEditItem(item)}
                        style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.3rem 0.625rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.375rem', color: '#818cf8', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
                      >
                        <Edit2 size={11} /> Ficha
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Sort order hint */}
      <p style={{ margin: '0.75rem 0 0', fontSize: '0.72rem', color: '#1e3a5f' }}>
        Tocá el precio mayorista para editarlo. Los toggles guardan automáticamente. Usá "Ficha" para agregar imágenes, descripción y detalles del producto.
      </p>

      {/* Edit modal */}
      {editItem && (
        <ModalFichaPortal
          item={editItem}
          businessId={businessId}
          onClose={() => setEditItem(null)}
          onSaved={(updated) => {
            setItems(prev => prev.map(i => i.id === updated.id ? { ...i, ...updated } : i))
            setEditItem(null)
          }}
        />
      )}
    </div>
  )
}
