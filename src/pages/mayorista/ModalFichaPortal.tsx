import { useState, useRef } from 'react'
import {
  X, Upload, Trash2, Plus, CheckCircle2, AlertCircle,
  Loader2, Tag, Star,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import type { CatalogItem } from './catalogTypes'

// ─── Styles ───────────────────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '0.5rem 0.75rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '0.5rem', color: '#f1f5f9',
  fontSize: '0.875rem', outline: 'none',
}
const labelS: React.CSSProperties = {
  display: 'block', fontSize: '0.72rem', fontWeight: 700,
  color: '#94a3b8', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: '0.35rem',
}
const sectionS: React.CSSProperties = {
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: '0.625rem', padding: '1rem',
  display: 'flex', flexDirection: 'column', gap: '0.875rem',
}

// ─── Image uploader ───────────────────────────────────────────────────────────

function ImageUploader({
  businessId, itemId, currentImages, mainImage,
  onUpdate,
}: {
  businessId: string
  itemId: string
  currentImages: string[]
  mainImage: string | null
  onUpdate: (main: string | null, images: string[]) => void
}) {
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true); setErr('')
    const newUrls: string[] = []

    for (const file of Array.from(files)) {
      if (file.size > 5 * 1024 * 1024) { setErr(`${file.name} supera 5 MB`); continue }
      const ext  = file.name.split('.').pop()
      const path = `${businessId}/${itemId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
      const { error: upErr } = await supabase.storage.from('portal-images').upload(path, file, { upsert: true })
      if (upErr) { setErr(upErr.message); continue }
      const { data: { publicUrl } } = supabase.storage.from('portal-images').getPublicUrl(path)
      newUrls.push(publicUrl)
    }

    const combined = [...currentImages, ...newUrls]
    const newMain  = mainImage || combined[0] || null
    onUpdate(newMain, combined)
    setUploading(false)
  }

  const remove = (url: string) => {
    const next = currentImages.filter(u => u !== url)
    const newMain = mainImage === url ? (next[0] || null) : mainImage
    onUpdate(newMain, next)
  }

  const setMain = (url: string) => onUpdate(url, currentImages)

  const allImages = mainImage
    ? [mainImage, ...currentImages.filter(u => u !== mainImage)]
    : currentImages

  return (
    <div>
      <label style={labelS}>Imágenes del producto</label>

      {/* Image grid */}
      {allImages.length > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          {allImages.map((url, i) => {
            const isMain = url === mainImage || (i === 0 && !mainImage)
            return (
              <div key={url} style={{ position: 'relative', width: 80, height: 80 }}>
                <img
                  src={url} alt=""
                  style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: '0.5rem', border: isMain ? '2px solid #6366f1' : '2px solid rgba(255,255,255,0.08)', cursor: 'pointer' }}
                  onClick={() => setMain(url)}
                />
                {isMain && (
                  <span style={{ position: 'absolute', top: 3, left: 3, background: '#6366f1', color: '#fff', fontSize: '0.55rem', fontWeight: 800, padding: '0.1rem 0.3rem', borderRadius: '0.2rem' }}>
                    PRINCIPAL
                  </span>
                )}
                <button
                  onClick={() => remove(url)}
                  style={{ position: 'absolute', top: 3, right: 3, width: 20, height: 20, borderRadius: '50%', background: 'rgba(239,68,68,0.85)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Trash2 size={10} color="#fff" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Upload button */}
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple style={{ display: 'none' }} onChange={e => upload(e.target.files)} />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', background: 'rgba(99,102,241,0.1)', border: '1px dashed rgba(99,102,241,0.35)', borderRadius: '0.5rem', color: '#818cf8', fontSize: '0.82rem', fontWeight: 600, cursor: uploading ? 'not-allowed' : 'pointer', opacity: uploading ? 0.7 : 1 }}
      >
        {uploading ? <Loader2 size={14} style={{ animation: 'tr-spin 0.8s linear infinite' }} /> : <Upload size={14} />}
        {uploading ? 'Subiendo...' : 'Subir imágenes'}
      </button>
      <p style={{ margin: '0.375rem 0 0', fontSize: '0.7rem', color: '#334155' }}>
        JPG, PNG o WebP hasta 5 MB. Cliqueá una imagen para marcarla como principal.
      </p>
      {err && <p style={{ margin: '0.375rem 0 0', fontSize: '0.75rem', color: '#f87171' }}>{err}</p>}
    </div>
  )
}

// ─── Tags input ───────────────────────────────────────────────────────────────

function TagsInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState('')

  const add = () => {
    const t = input.trim().toLowerCase()
    if (t && !tags.includes(t)) onChange([...tags, t])
    setInput('')
  }

  return (
    <div>
      <label style={labelS}>Etiquetas</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: '0.5rem' }}>
        {tags.map(t => (
          <span key={t} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.2rem 0.6rem', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '99px', fontSize: '0.75rem', color: '#818cf8' }}>
            <Tag size={10} /> {t}
            <button onClick={() => onChange(tags.filter(x => x !== t))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: 0, display: 'flex', alignItems: 'center', marginLeft: '0.1rem' }}>
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
          placeholder="Ej: funda, iphone, silicona..."
          style={{ ...inputS, flex: 1 }}
        />
        <button onClick={add} style={{ padding: '0.5rem 0.75rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.5rem', color: '#818cf8', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
          <Plus size={14} />
        </button>
      </div>
      <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: '#334155' }}>Enter o coma para agregar</p>
    </div>
  )
}

// ─── Specs editor ─────────────────────────────────────────────────────────────

function SpecsEditor({ specs, onChange }: { specs: Record<string, string>; onChange: (s: Record<string, string>) => void }) {
  const entries = Object.entries(specs)

  const set = (key: string, val: string) => onChange({ ...specs, [key]: val })
  const remove = (key: string) => {
    const next = { ...specs }; delete next[key]; onChange(next)
  }
  const add = () => {
    const key = `Especificación ${entries.length + 1}`
    onChange({ ...specs, [key]: '' })
  }

  return (
    <div>
      <label style={labelS}>Especificaciones técnicas</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
            <input
              defaultValue={k}
              onBlur={e => {
                const newKey = e.target.value.trim()
                if (newKey && newKey !== k) { const next = { ...specs, [newKey]: v }; delete next[k]; onChange(next) }
              }}
              placeholder="Nombre"
              style={{ ...inputS, width: 140, flexShrink: 0 }}
            />
            <span style={{ color: '#334155' }}>:</span>
            <input
              value={v}
              onChange={e => set(k, e.target.value)}
              placeholder="Valor"
              style={{ ...inputS, flex: 1 }}
            />
            <button onClick={() => remove(k)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem', flexShrink: 0 }}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button onClick={add} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.4rem 0.75rem', background: 'transparent', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: '#475569', fontSize: '0.78rem', cursor: 'pointer', alignSelf: 'flex-start' }}>
          <Plus size={12} /> Agregar especificación
        </button>
      </div>
    </div>
  )
}

// ─── Main modal ───────────────────────────────────────────────────────────────

interface Props {
  item: CatalogItem
  businessId: string
  onClose: () => void
  onSaved: (updated: Partial<CatalogItem>) => void
}

export function ModalFichaPortal({ item, businessId, onClose, onSaved }: Props) {
  const [saving,  setSaving]  = useState(false)
  const [success, setSuccess] = useState(false)
  const [error,   setError]   = useState('')

  // Form state
  const [title,       setTitle]       = useState(item.portal_title || '')
  const [desc,        setDesc]        = useState(item.portal_description || '')
  const [descFull,    setDescFull]    = useState(item.portal_description_full || '')
  const [compat,      setCompat]      = useState(item.portal_compatibility || '')
  const [condition,   setCondition]   = useState(item.portal_condition || 'nuevo')
  const [warranty,    setWarranty]    = useState(item.portal_warranty || '')
  const [notes,       setNotes]       = useState(item.portal_notes || '')
  const [tags,        setTags]        = useState<string[]>(item.portal_tags || [])
  const [specs,       setSpecs]       = useState<Record<string, string>>(item.portal_specs || {})
  const [mainImage,   setMainImage]   = useState<string | null>(item.portal_main_image || null)
  const [images,      setImages]      = useState<string[]>(item.portal_images || [])
  const [sortOrder,   setSortOrder]   = useState(item.portal_sort_order ?? 0)

  const handleSave = async () => {
    setSaving(true); setError(''); setSuccess(false)
    const patch: Partial<CatalogItem> = {
      portal_title:            title.trim() || null,
      portal_description:      desc.trim() || null,
      portal_description_full: descFull.trim() || null,
      portal_compatibility:    compat.trim() || null,
      portal_condition:        condition,
      portal_warranty:         warranty.trim() || null,
      portal_notes:            notes.trim() || null,
      portal_tags:             tags.length > 0 ? tags : null,
      portal_specs:            Object.keys(specs).length > 0 ? specs : null,
      portal_main_image:       mainImage,
      portal_images:           images.length > 0 ? images : null,
      portal_sort_order:       sortOrder,
    }

    const { error: e } = await supabase
      .from('inventory')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', item.id)
      .eq('business_id', businessId)

    setSaving(false)
    if (e) { setError(e.message); return }
    setSuccess(true)
    setTimeout(() => { onSaved(patch); }, 800)
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div style={{ background: '#0d1a30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '1rem', width: '100%', maxWidth: 700, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 32px 64px rgba(0,0,0,0.6)' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.125rem 1.5rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: '0.5rem', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Star size={16} style={{ color: '#818cf8' }} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: '#f0f4ff' }}>Ficha portal</h2>
              <p style={{ margin: 0, fontSize: '0.72rem', color: '#475569' }}>{item.name}{item.code ? ` · ${item.code}` : ''}</p>
            </div>
          </div>
          <button onClick={onClose} disabled={saving} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem' }}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Título y orden */}
          <div style={sectionS}>
            <p style={{ margin: 0, fontSize: '0.7rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Identificación</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: '0.75rem' }}>
              <div>
                <label style={labelS}>Título en portal <span style={{ color: '#334155', fontWeight: 400, textTransform: 'none' }}>(si es distinto al nombre del sistema)</span></label>
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder={item.name} style={inputS} />
              </div>
              <div>
                <label style={labelS}>Orden</label>
                <input type="number" value={sortOrder} min={0} onChange={e => setSortOrder(parseInt(e.target.value) || 0)} style={{ ...inputS, textAlign: 'center', fontFamily: 'monospace' }} />
              </div>
            </div>
          </div>

          {/* Descripciones */}
          <div style={sectionS}>
            <p style={{ margin: 0, fontSize: '0.7rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Descripciones</p>
            <div>
              <label style={labelS}>Descripción corta <span style={{ color: '#334155', fontWeight: 400, textTransform: 'none' }}>(visible en la lista)</span></label>
              <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="Funda de silicona premium, compatible con todos los modelos..." style={{ ...inputS, resize: 'vertical' }} />
            </div>
            <div>
              <label style={labelS}>Descripción completa <span style={{ color: '#334155', fontWeight: 400, textTransform: 'none' }}>(detalle del producto)</span></label>
              <textarea value={descFull} onChange={e => setDescFull(e.target.value)} rows={4} placeholder="Descripción detallada: materiales, características, instrucciones de uso..." style={{ ...inputS, resize: 'vertical' }} />
            </div>
            <div>
              <label style={labelS}>Compatibilidad / Modelos</label>
              <input value={compat} onChange={e => setCompat(e.target.value)} placeholder="Ej: iPhone 13, 14, 15 · Samsung A53, A54..." style={inputS} />
            </div>
          </div>

          {/* Condición y garantía */}
          <div style={sectionS}>
            <p style={{ margin: 0, fontSize: '0.7rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Condición y garantía</p>
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '0.75rem' }}>
              <div>
                <label style={labelS}>Condición</label>
                <select value={condition} onChange={e => setCondition(e.target.value)} style={{ ...inputS, cursor: 'pointer' }}>
                  <option value="nuevo">Nuevo</option>
                  <option value="usado">Usado</option>
                  <option value="reacondicionado">Reacondicionado</option>
                </select>
              </div>
              <div>
                <label style={labelS}>Garantía</label>
                <input value={warranty} onChange={e => setWarranty(e.target.value)} placeholder="Ej: 6 meses de garantía contra defectos de fabricación" style={inputS} />
              </div>
            </div>
            <div>
              <label style={labelS}>Observaciones visibles para el cliente</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Ej: Los colores pueden variar según disponibilidad de stock." style={{ ...inputS, resize: 'vertical' }} />
            </div>
          </div>

          {/* Tags */}
          <div style={sectionS}>
            <TagsInput tags={tags} onChange={setTags} />
          </div>

          {/* Specs */}
          <div style={sectionS}>
            <SpecsEditor specs={specs} onChange={setSpecs} />
          </div>

          {/* Images */}
          <div style={sectionS}>
            <ImageUploader
              businessId={businessId}
              itemId={item.id}
              currentImages={images}
              mainImage={mainImage}
              onUpdate={(main, imgs) => { setMainImage(main); setImages(imgs) }}
            />
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', flexShrink: 0, background: '#0d1a30' }}>
          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flex: 1, color: '#f87171', fontSize: '0.8rem' }}>
              <AlertCircle size={14} /> {error}
            </div>
          )}
          <button onClick={onClose} disabled={saving} style={{ padding: '0.5rem 1rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.5rem', color: '#64748b', fontSize: '0.875rem', cursor: 'pointer', fontWeight: 600 }}>
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={saving || success}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1.25rem', background: success ? 'rgba(52,211,153,0.15)' : 'linear-gradient(135deg,#6366f1,#8b5cf6)', border: success ? '1px solid rgba(52,211,153,0.35)' : 'none', borderRadius: '0.5rem', color: success ? '#34d399' : '#fff', fontSize: '0.875rem', fontWeight: 600, cursor: saving || success ? 'not-allowed' : 'pointer', opacity: saving ? 0.75 : 1 }}
          >
            {saving ? <><Loader2 size={14} style={{ animation: 'tr-spin 0.8s linear infinite' }} /> Guardando...</> : success ? <><CheckCircle2 size={14} /> Guardado</> : 'Guardar ficha'}
          </button>
        </div>
      </div>
    </div>
  )
}
