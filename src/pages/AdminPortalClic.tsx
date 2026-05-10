import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Search, Star, Image as ImageIcon, X, Plus,
  Trash2, Upload, ExternalLink, CheckCircle2,
  Loader2, Tag, RefreshCw, AlertCircle,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import {
  getAdminProducts, upsertSettings, uploadProductImage, deleteProductImage,
  BADGE_LABELS,
  type AdminProduct, type ProductSettings, type PortalBadge,
} from '../services/portalAdminService'

// ─── Design tokens (iOS / TechRepair Pro) ─────────────────────────────────────

const S = {
  bg:       '#0a0f1e',
  surface:  '#0f1829',
  card:     '#111827',
  border:   'rgba(255,255,255,0.07)',
  borderActive: 'rgba(99,102,241,0.5)',
  text:     '#f1f5f9',
  textSub:  '#64748b',
  textMuted:'#334155',
  primary:  '#6366f1',
  primaryBg:'rgba(99,102,241,0.12)',
  success:  '#22c55e',
  warning:  '#f59e0b',
  danger:   '#ef4444',
  radius:   '14px',
  radiusSm: '8px',
  shadow:   '0 4px 24px rgba(0,0,0,0.35)',
  shadowSm: '0 2px 8px rgba(0,0,0,0.2)',
}

const fmtARS = (n: number) =>
  '$' + Math.round(n || 0).toLocaleString('es-AR')

// ─── iOS Toggle ───────────────────────────────────────────────────────────────

function IOSToggle({ on, onChange, color = '#22c55e', size = 'md' }: { on: boolean; onChange: () => void; color?: string; size?: 'sm' | 'md' }) {
  const w = size === 'sm' ? 32 : 40
  const h = size === 'sm' ? 18 : 22
  const circle = size === 'sm' ? 14 : 18
  const pad = 2
  return (
    <button onClick={onChange} style={{ width: w, height: h, borderRadius: h, border: 'none', cursor: 'pointer', background: on ? color : 'rgba(255,255,255,0.1)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
      <span style={{ position: 'absolute', top: pad, left: on ? w - circle - pad : pad, width: circle, height: circle, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }} />
    </button>
  )
}

// ─── Badge picker ─────────────────────────────────────────────────────────────

const BADGE_COLORS: Record<string, string> = {
  nuevo: '#34d399', oferta: '#f87171',
  mas_vendido: '#818cf8', ultimas_unidades: '#f59e0b',
}

function BadgePill({ badge, onRemove }: { badge: string; onRemove: () => void }) {
  const color = BADGE_COLORS[badge] || '#64748b'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.2rem 0.625rem', borderRadius: '99px', background: `${color}18`, border: `1px solid ${color}40`, fontSize: '0.7rem', fontWeight: 700, color }}>
      {BADGE_LABELS[badge] || badge}
      <button onClick={onRemove} style={{ background: 'none', border: 'none', cursor: 'pointer', color, padding: 0, display: 'flex', alignItems: 'center' }}><X size={10} /></button>
    </span>
  )
}

// ─── Image uploader (admin) ───────────────────────────────────────────────────

function AdminImageUploader({
  settings, businessId, inventoryId, onUpdate,
}: { settings: ProductSettings; businessId: string; inventoryId: string; onUpdate: (s: Partial<ProductSettings>) => void }) {
  const [uploading, setUploading] = useState(false)
  const [err, setErr]   = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true); setErr('')
    const newUrls: string[] = []
    for (const file of Array.from(files)) {
      if (file.size > 10 * 1024 * 1024) { setErr(`${file.name} supera 10 MB`); continue }
      const { url, error } = await uploadProductImage(businessId, inventoryId, file)
      if (error) { setErr(error); continue }
      if (url) newUrls.push(url)
    }
    const gallery = [...settings.gallery_images, ...newUrls]
    const main    = settings.main_image_url || gallery[0] || null
    onUpdate({ main_image_url: main, gallery_images: gallery })
    setUploading(false)
  }

  const setMain = (url: string) => onUpdate({ main_image_url: url })

  const remove = async (url: string) => {
    await deleteProductImage(url)
    const gallery = settings.gallery_images.filter(u => u !== url)
    const main    = settings.main_image_url === url ? (gallery[0] || null) : settings.main_image_url
    onUpdate({ main_image_url: main, gallery_images: gallery })
  }

  const allImages = settings.main_image_url
    ? [settings.main_image_url, ...settings.gallery_images.filter(u => u !== settings.main_image_url)]
    : settings.gallery_images

  return (
    <div>
      <p style={{ margin: '0 0 0.625rem', fontSize: '0.72rem', fontWeight: 700, color: S.textSub, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Imágenes</p>

      {allImages.length > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          {allImages.map((url, i) => {
            const isMain = url === settings.main_image_url || (i === 0 && !settings.main_image_url)
            return (
              <div key={url} style={{ position: 'relative', width: 72, height: 72 }}>
                <img src={url} alt="" onClick={() => setMain(url)} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: S.radiusSm, border: isMain ? `2px solid ${S.primary}` : `2px solid ${S.border}`, cursor: 'pointer' }} />
                {isMain && <span style={{ position: 'absolute', bottom: 3, left: 3, background: S.primary, color: '#fff', fontSize: '0.5rem', fontWeight: 800, padding: '0.1rem 0.25rem', borderRadius: '0.2rem', lineHeight: 1.2 }}>PRINCIPAL</span>}
                <button onClick={() => remove(url)} style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: '50%', background: 'rgba(239,68,68,0.85)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Trash2 size={9} color="#fff" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple style={{ display: 'none' }} onChange={e => upload(e.target.files)} />
      <button onClick={() => fileRef.current?.click()} disabled={uploading} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.875rem', background: S.primaryBg, border: `1px dashed ${S.borderActive}`, borderRadius: S.radiusSm, color: S.primary, fontSize: '0.8rem', fontWeight: 600, cursor: uploading ? 'not-allowed' : 'pointer', opacity: uploading ? 0.7 : 1 }}>
        {uploading ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> : <Upload size={13} />}
        {uploading ? 'Subiendo...' : 'Subir imágenes'}
      </button>
      {err && <p style={{ margin: '0.375rem 0 0', fontSize: '0.72rem', color: S.danger }}>{err}</p>}
      <p style={{ margin: '0.375rem 0 0', fontSize: '0.68rem', color: S.textMuted }}>JPG / PNG / WebP hasta 10 MB. Cliqueá para marcar como principal.</p>
    </div>
  )
}

// ─── Edit drawer ──────────────────────────────────────────────────────────────

function EditDrawer({ product, businessId, onClose, onSaved }: { product: AdminProduct; businessId: string; onClose: () => void; onSaved: (p: Partial<ProductSettings>) => void }) {
  const [draft,   setDraft]   = useState<ProductSettings>({ ...product.settings })
  const [saving,  setSaving]  = useState(false)
  const [success, setSuccess] = useState(false)
  const [err,     setErr]     = useState('')
  const [newFeature, setNewFeature] = useState('')

  const set = <K extends keyof ProductSettings>(k: K, v: ProductSettings[K]) =>
    setDraft(p => ({ ...p, [k]: v }))

  const save = async () => {
    setSaving(true); setErr(''); setSuccess(false)
    const { error } = await upsertSettings(businessId, product.inventory_id, draft)
    setSaving(false)
    if (error) { setErr(error); return }
    setSuccess(true)
    setTimeout(() => { onSaved(draft); }, 700)
  }

  const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.05)', border: `1px solid ${S.border}`, borderRadius: S.radiusSm, color: S.text, fontSize: '0.875rem', outline: 'none' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: '0.72rem', fontWeight: 700, color: S.textSub, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.35rem' }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', display: 'flex', justifyContent: 'flex-end', zIndex: 9999 }} onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <div style={{ width: '100%', maxWidth: 520, background: S.surface, borderLeft: `1px solid ${S.border}`, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

        {/* Header */}
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: `1px solid ${S.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, background: S.surface, zIndex: 1 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: S.text }}>{product.name}</h2>
            <p style={{ margin: '0.125rem 0 0', fontSize: '0.75rem', color: S.textSub }}>{product.category}{product.code && ` · ${product.code}`}</p>
          </div>
          <button onClick={onClose} disabled={saving} style={{ background: 'none', border: 'none', cursor: 'pointer', color: S.textSub, padding: '0.25rem' }}>
            <X size={18} />
          </button>
        </div>

        {/* Inventory data (read-only) */}
        <div style={{ padding: '1rem 1.5rem', background: 'rgba(255,255,255,0.02)', borderBottom: `1px solid ${S.border}`, display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
          {[
            { label: 'Precio mayorista', value: product.precio_mayorista ? fmtARS(product.precio_mayorista) : '—', color: '#818cf8' },
            { label: 'Precio normal',    value: fmtARS(product.sale_price), color: S.textSub },
            { label: 'Stock',            value: String(product.stock_quantity), color: product.stock_quantity <= 5 ? S.warning : S.textSub },
          ].map(f => (
            <div key={f.label}>
              <div style={{ fontSize: '0.65rem', color: S.textMuted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{f.label}</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 700, fontFamily: 'monospace', color: f.color }}>{f.value}</div>
            </div>
          ))}
        </div>

        {/* Form */}
        <div style={{ flex: 1, padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {/* Publish controls */}
          <div style={{ background: S.card, borderRadius: S.radius, padding: '1rem', border: `1px solid ${S.border}`, display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
            <p style={{ margin: 0, fontSize: '0.7rem', fontWeight: 700, color: S.textSub, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Publicación</p>
            {[
              { key: 'is_visible' as const, label: 'Visible en el portal', desc: 'Los clientes pueden ver y comprar este producto', color: S.success },
              { key: 'is_featured' as const, label: 'Producto destacado', desc: 'Aparece primero en el catálogo', color: S.warning },
            ].map(row => (
              <div key={row.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.875rem', fontWeight: 600, color: S.text }}>{row.label}</div>
                  <div style={{ fontSize: '0.72rem', color: S.textSub, marginTop: '0.1rem' }}>{row.desc}</div>
                </div>
                <IOSToggle on={draft[row.key] as boolean} onChange={() => set(row.key, !draft[row.key])} color={row.color} />
              </div>
            ))}
          </div>

          {/* Badge */}
          <div style={{ background: S.card, borderRadius: S.radius, padding: '1rem', border: `1px solid ${S.border}` }}>
            <label style={lbl}>Etiqueta</label>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {draft.badge && (
                <BadgePill badge={draft.badge} onRemove={() => set('badge', null)} />
              )}
              {!draft.badge && (
                Object.entries(BADGE_LABELS).map(([val, label]) => (
                  <button key={val} onClick={() => set('badge', val as PortalBadge)}
                    style={{ padding: '0.2rem 0.625rem', borderRadius: '99px', background: `${BADGE_COLORS[val]}10`, border: `1px solid ${BADGE_COLORS[val]}35`, color: BADGE_COLORS[val], fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}>
                    {label}
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Images */}
          <div style={{ background: S.card, borderRadius: S.radius, padding: '1rem', border: `1px solid ${S.border}` }}>
            <AdminImageUploader settings={draft} businessId={businessId} inventoryId={product.inventory_id} onUpdate={patch => setDraft(p => ({ ...p, ...patch }))} />
          </div>

          {/* Descriptions */}
          <div style={{ background: S.card, borderRadius: S.radius, padding: '1rem', border: `1px solid ${S.border}`, display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
            <p style={{ margin: 0, fontSize: '0.7rem', fontWeight: 700, color: S.textSub, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Contenido</p>
            <div>
              <label style={lbl}>Descripción corta <span style={{ fontWeight: 400, textTransform: 'none', color: S.textMuted }}>(visible en la lista)</span></label>
              <textarea value={draft.short_description || ''} onChange={e => set('short_description', e.target.value || null)} rows={2} placeholder="Funda premium compatible con todos los modelos..." style={{ ...inp, resize: 'vertical' }} />
            </div>
            <div>
              <label style={lbl}>Descripción completa</label>
              <textarea value={draft.description || ''} onChange={e => set('description', e.target.value || null)} rows={4} placeholder="Descripción detallada del producto, materiales, instrucciones..." style={{ ...inp, resize: 'vertical' }} />
            </div>
          </div>

          {/* Features */}
          <div style={{ background: S.card, borderRadius: S.radius, padding: '1rem', border: `1px solid ${S.border}` }}>
            <label style={lbl}>Características destacadas</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', marginBottom: '0.5rem' }}>
              {draft.features.map((f, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: S.primary, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: '0.85rem', color: S.text }}>{f}</span>
                  <button onClick={() => set('features', draft.features.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: S.danger, padding: '0.1rem', flexShrink: 0 }}>
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '0.375rem' }}>
              <input value={newFeature} onChange={e => setNewFeature(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newFeature.trim()) { set('features', [...draft.features, newFeature.trim()]); setNewFeature('') } }} placeholder="Agregar característica..." style={{ ...inp, flex: 1 }} />
              <button onClick={() => { if (newFeature.trim()) { set('features', [...draft.features, newFeature.trim()]); setNewFeature('') } }} style={{ padding: '0.5rem 0.75rem', background: S.primaryBg, border: `1px solid ${S.borderActive}`, borderRadius: S.radiusSm, color: S.primary, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <Plus size={14} />
              </button>
            </div>
          </div>

          {/* Settings */}
          <div style={{ background: S.card, borderRadius: S.radius, padding: '1rem', border: `1px solid ${S.border}`, display: 'flex', gap: '0.875rem' }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Cantidad mínima</label>
              <input type="number" min="1" value={draft.min_quantity} onChange={e => set('min_quantity', parseInt(e.target.value) || 1)} style={{ ...inp, textAlign: 'center', fontFamily: 'monospace' }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Orden de aparición</label>
              <input type="number" min="0" value={draft.display_order} onChange={e => set('display_order', parseInt(e.target.value) || 0)} style={{ ...inp, textAlign: 'center', fontFamily: 'monospace' }} />
            </div>
          </div>

          {/* Notes */}
          <div style={{ background: S.card, borderRadius: S.radius, padding: '1rem', border: `1px solid ${S.border}` }}>
            <label style={lbl}>Notas internas <span style={{ fontWeight: 400, textTransform: 'none', color: S.textMuted }}>(no se muestran al cliente)</span></label>
            <textarea value={draft.internal_notes || ''} onChange={e => set('internal_notes', e.target.value || null)} rows={2} placeholder="Observaciones de administración..." style={{ ...inp, resize: 'vertical' }} />
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '1rem 1.5rem', borderTop: `1px solid ${S.border}`, display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', position: 'sticky', bottom: 0, background: S.surface }}>
          {err && <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.375rem', color: S.danger, fontSize: '0.8rem' }}><AlertCircle size={14} />{err}</div>}
          <button onClick={onClose} disabled={saving} style={{ padding: '0.625rem 1.125rem', background: 'rgba(255,255,255,0.05)', border: `1px solid ${S.border}`, borderRadius: S.radiusSm, color: S.textSub, fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer' }}>Cancelar</button>
          <button onClick={save} disabled={saving || success} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 1.375rem', background: success ? 'rgba(34,197,94,0.15)' : `linear-gradient(135deg,${S.primary},#8b5cf6)`, border: success ? '1px solid rgba(34,197,94,0.35)' : 'none', borderRadius: S.radiusSm, color: success ? '#34d399' : '#fff', fontSize: '0.875rem', fontWeight: 700, cursor: saving || success ? 'not-allowed' : 'pointer', opacity: saving ? 0.75 : 1 }}>
            {saving ? <><Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />Guardando...</> : success ? <><CheckCircle2 size={14} />Guardado</> : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Product card ─────────────────────────────────────────────────────────────

function ProductCard({ product, onEdit, onToggleVisible, onToggleFeatured }: {
  product: AdminProduct
  onEdit: () => void
  onToggleVisible: () => void
  onToggleFeatured: () => void
}) {
  const { settings } = product
  const hasImage    = !!settings.main_image_url
  const lowStock    = product.stock_quantity <= 5

  return (
    <div style={{ background: S.card, borderRadius: S.radius, border: `1px solid ${S.border}`, overflow: 'hidden', boxShadow: S.shadowSm, display: 'flex', flexDirection: 'column', transition: 'border-color 0.15s, box-shadow 0.15s' }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(99,102,241,0.3)'; (e.currentTarget as HTMLDivElement).style.boxShadow = S.shadow }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = S.border; (e.currentTarget as HTMLDivElement).style.boxShadow = S.shadowSm }}>

      {/* Image */}
      <div style={{ height: 160, background: hasImage ? 'transparent' : 'rgba(255,255,255,0.02)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
        {hasImage ? (
          <img src={settings.main_image_url!} alt={product.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
            <ImageIcon size={28} style={{ color: S.textMuted }} />
            <span style={{ fontSize: '0.7rem', color: S.textMuted }}>Sin imagen</span>
          </div>
        )}
        {settings.badge && (
          <span style={{ position: 'absolute', top: 8, left: 8, padding: '0.2rem 0.5rem', borderRadius: '99px', fontSize: '0.65rem', fontWeight: 800, background: `${BADGE_COLORS[settings.badge]}dd`, color: '#fff' }}>
            {BADGE_LABELS[settings.badge]}
          </span>
        )}
        {settings.is_featured && (
          <span style={{ position: 'absolute', top: 8, right: 8, width: 24, height: 24, borderRadius: '50%', background: 'rgba(245,158,11,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Star size={12} color="#fff" />
          </span>
        )}
      </div>

      {/* Content */}
      <div style={{ padding: '0.875rem', flex: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div>
          <p style={{ margin: '0 0 0.15rem', fontSize: '0.65rem', color: S.textSub, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{product.category}</p>
          <p style={{ margin: 0, fontSize: '0.9rem', fontWeight: 700, color: S.text, lineHeight: 1.3 }}>{product.name}</p>
          {product.code && <p style={{ margin: '0.1rem 0 0', fontSize: '0.68rem', color: S.textMuted, fontFamily: 'monospace' }}>{product.code}</p>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '1rem', color: '#818cf8' }}>
            {product.precio_mayorista ? fmtARS(product.precio_mayorista) : <span style={{ color: S.textMuted, fontSize: '0.78rem', fontWeight: 500 }}>Sin precio</span>}
          </span>
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: lowStock ? S.warning : S.textSub }}>
            Stock: {product.stock_quantity}
          </span>
        </div>

        {/* Toggles */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '0.5rem', borderTop: `1px solid ${S.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
              <IOSToggle on={settings.is_visible} onChange={onToggleVisible} color={S.success} size="sm" />
              <span style={{ fontSize: '0.7rem', color: settings.is_visible ? S.success : S.textMuted, fontWeight: 600 }}>
                {settings.is_visible ? 'Visible' : 'Oculto'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
              <IOSToggle on={settings.is_featured} onChange={onToggleFeatured} color={S.warning} size="sm" />
              <span style={{ fontSize: '0.7rem', color: settings.is_featured ? S.warning : S.textMuted, fontWeight: 600 }}>Dest.</span>
            </div>
          </div>
          <button onClick={onEdit} style={{ padding: '0.3rem 0.75rem', background: S.primaryBg, border: `1px solid rgba(99,102,241,0.25)`, borderRadius: S.radiusSm, color: S.primary, fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer' }}>
            Editar
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AdminPortalClic() {
  const { businessId } = useAuth()
  const [products, setProducts] = useState<AdminProduct[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [editing,  setEditing]  = useState<AdminProduct | null>(null)
  const [search,   setSearch]   = useState('')
  const [filter,   setFilter]   = useState<'all' | 'visible' | 'hidden' | 'featured' | 'no_image'>('all')
  const [catFilter, setCatFilter] = useState('')

  const load = useCallback(async () => {
    if (!businessId) return
    setLoading(true); setError('')
    try {
      const data = await getAdminProducts(businessId)
      setProducts(data)
    } catch (e: any) { setError(e.message || 'Error al cargar productos') }
    finally { setLoading(false) }
  }, [businessId])

  useEffect(() => { load() }, [load])

  const patchProduct = useCallback((inventoryId: string, patch: Partial<ProductSettings>) => {
    setProducts(prev => prev.map(p =>
      p.inventory_id === inventoryId
        ? { ...p, settings: { ...p.settings, ...patch } }
        : p
    ))
  }, [])

  const toggleField = async (p: AdminProduct, field: 'is_visible' | 'is_featured') => {
    const newVal = !p.settings[field]
    patchProduct(p.inventory_id, { [field]: newVal })
    await upsertSettings(businessId!, p.inventory_id, { [field]: newVal })
  }

  const cats = useMemo(() => [...new Set(products.map(p => p.category))].sort(), [products])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return products.filter(p => {
      if (q && !p.name.toLowerCase().includes(q) && !(p.code || '').toLowerCase().includes(q) && !p.category.toLowerCase().includes(q)) return false
      if (catFilter && p.category !== catFilter) return false
      if (filter === 'visible')  return p.settings.is_visible
      if (filter === 'hidden')   return !p.settings.is_visible
      if (filter === 'featured') return p.settings.is_featured
      if (filter === 'no_image') return !p.settings.main_image_url
      return true
    })
  }, [products, search, catFilter, filter])

  const stats = useMemo(() => ({
    total:    products.length,
    visible:  products.filter(p => p.settings.is_visible).length,
    featured: products.filter(p => p.settings.is_featured).length,
    noImage:  products.filter(p => !p.settings.main_image_url).length,
  }), [products])

  return (
    <div style={{ minHeight: '100vh', background: S.bg, color: S.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Header ── */}
      <div style={{ padding: '2rem 2rem 1.5rem', maxWidth: 1400, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.75rem' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 800, letterSpacing: '-0.03em', color: S.text }}>
              Portal Mayorista Clic
            </h1>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', color: S.textSub }}>
              Administrá la vidriera comercial de tu portal mayorista
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.625rem' }}>
            <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', background: 'rgba(255,255,255,0.05)', border: `1px solid ${S.border}`, borderRadius: S.radiusSm, color: S.textSub, fontSize: '0.8rem', cursor: 'pointer' }}>
              <RefreshCw size={13} /> Actualizar
            </button>
            <a href="/mayorista/clic" target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem', background: S.primaryBg, border: `1px solid rgba(99,102,241,0.3)`, borderRadius: S.radiusSm, color: S.primary, fontSize: '0.8rem', fontWeight: 700, textDecoration: 'none' }}>
              <ExternalLink size={13} /> Ver portal
            </a>
          </div>
        </div>

        {/* Stats strip */}
        <div style={{ display: 'flex', gap: '0.875rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
          {[
            { label: 'Productos',       value: stats.total,    color: S.textSub },
            { label: 'Visibles',        value: stats.visible,  color: S.success },
            { label: 'Destacados',      value: stats.featured, color: S.warning },
            { label: 'Sin imagen',      value: stats.noImage,  color: stats.noImage > 0 ? S.danger : S.textMuted },
          ].map(s => (
            <div key={s.label} style={{ padding: '0.75rem 1.125rem', background: S.card, borderRadius: S.radius, border: `1px solid ${S.border}`, display: 'flex', gap: '0.625rem', alignItems: 'baseline' }}>
              <span style={{ fontSize: '1.375rem', fontWeight: 800, fontFamily: 'monospace', color: s.color, letterSpacing: '-0.02em' }}>{s.value}</span>
              <span style={{ fontSize: '0.75rem', color: S.textSub, fontWeight: 600 }}>{s.label}</span>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: '0.625rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Search */}
          <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
            <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: S.textSub, pointerEvents: 'none' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre, SKU o categoría..." style={{ width: '100%', boxSizing: 'border-box', padding: '0.625rem 0.75rem 0.625rem 2.25rem', background: S.card, border: `1px solid ${S.border}`, borderRadius: S.radiusSm, color: S.text, fontSize: '0.875rem', outline: 'none' }} />
          </div>

          {/* Category */}
          {cats.length > 1 && (
            <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{ padding: '0.625rem 0.75rem', background: S.card, border: `1px solid ${S.border}`, borderRadius: S.radiusSm, color: S.textSub, fontSize: '0.8rem', outline: 'none', cursor: 'pointer' }}>
              <option value="">Todas las categorías</option>
              {cats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}

          {/* Quick filters */}
          <div style={{ display: 'flex', gap: '0.25rem', padding: '0.25rem', background: S.card, borderRadius: S.radius, border: `1px solid ${S.border}` }}>
            {([
              ['all',      'Todos'],
              ['visible',  'Visibles'],
              ['hidden',   'Ocultos'],
              ['featured', 'Destacados'],
              ['no_image', 'Sin imagen'],
            ] as const).map(([v, l]) => (
              <button key={v} onClick={() => setFilter(v)} style={{ padding: '0.35rem 0.75rem', borderRadius: '8px', border: 'none', background: filter === v ? S.primaryBg : 'transparent', color: filter === v ? S.primary : S.textSub, fontSize: '0.78rem', fontWeight: filter === v ? 700 : 500, cursor: 'pointer', transition: 'all 0.15s' }}>
                {l}
              </button>
            ))}
          </div>

          <span style={{ fontSize: '0.78rem', color: S.textMuted }}>{filtered.length} productos</span>
        </div>
      </div>

      {/* ── Grid ── */}
      <div style={{ padding: '0 2rem 3rem', maxWidth: 1400, margin: '0 auto' }}>
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.875rem 1rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: S.radius, color: S.danger, marginBottom: '1.5rem' }}>
            <AlertCircle size={16} /> {error}
          </div>
        )}

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '5rem' }}>
            <Loader2 size={32} style={{ animation: 'spin 1s linear infinite', color: S.primary }} />
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '5rem', textAlign: 'center', color: S.textSub }}>
            <Tag size={36} style={{ margin: '0 auto 1rem', display: 'block', opacity: 0.3 }} />
            <p style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Sin productos para mostrar</p>
            <p style={{ margin: '0.375rem 0 0', fontSize: '0.875rem', color: S.textMuted }}>Ajustá los filtros o el buscador</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '1rem' }}>
            {filtered.map(product => (
              <ProductCard
                key={product.inventory_id}
                product={product}
                onEdit={() => setEditing(product)}
                onToggleVisible={() => toggleField(product, 'is_visible')}
                onToggleFeatured={() => toggleField(product, 'is_featured')}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Edit drawer ── */}
      {editing && (
        <EditDrawer
          product={editing}
          businessId={businessId || ''}
          onClose={() => setEditing(null)}
          onSaved={patch => {
            patchProduct(editing.inventory_id, patch)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
