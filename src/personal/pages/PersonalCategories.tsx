import { useState, useEffect } from 'react'
import { Plus, Pencil, X } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { personalService, type PersonalCategory } from '../services/personalService'
import { PageContainer, PrimaryBtn, PersonalInput, showToast } from '../components/ui'
import { PersonalBottomSheet } from '../components/PersonalBottomSheet'

const PRESET_COLORS = [
  '#34d399', '#60a5fa', '#818cf8', '#f87171', '#fbbf24',
  '#fb923c', '#a78bfa', '#4ade80', '#38bdf8', '#f472b6', '#94a3b8',
]

const TABS = ['expense', 'income'] as const
type TabType = typeof TABS[number]

interface FormState {
  name: string
  type: TabType
  icon: string
  color: string
}

const EMPTY_FORM = (type: TabType): FormState => ({ name: '', type, icon: '📁', color: '#818cf8' })

export function PersonalCategories() {
  const { user } = useAuth()
  const [categories, setCategories] = useState<PersonalCategory[]>([])
  const [loading,    setLoading]    = useState(true)
  const [tab,        setTab]        = useState<TabType>('expense')
  const [sheetOpen,  setSheetOpen]  = useState(false)
  const [editing,    setEditing]    = useState<PersonalCategory | null>(null)
  const [form,       setForm]       = useState<FormState>(EMPTY_FORM('expense'))
  const [saving,     setSaving]     = useState(false)

  const load = async () => {
    if (!user) return
    setLoading(true)
    try {
      await personalService.ensureDefaultCategories(user.id)
      setCategories(await personalService.getCategories(user.id))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM(tab))
    setSheetOpen(true)
  }

  const openEdit = (cat: PersonalCategory) => {
    setEditing(cat)
    setForm({ name: cat.name, type: cat.type as TabType, icon: cat.icon, color: cat.color })
    setSheetOpen(true)
  }

  const closeSheet = () => { setSheetOpen(false); setEditing(null) }

  const handleSave = async () => {
    if (!user || !form.name.trim()) return
    setSaving(true)
    try {
      if (editing) {
        await personalService.updateCategory(editing.id, { name: form.name.trim(), icon: form.icon, color: form.color })
        showToast({ message: 'Categoría actualizada', type: 'success' })
      } else {
        await personalService.createCategory(user.id, { name: form.name.trim(), type: form.type, icon: form.icon, color: form.color })
        showToast({ message: 'Categoría creada', type: 'success' })
      }
      closeSheet()
      void load()
    } catch {
      showToast({ message: 'Error al guardar la categoría', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const handleDeactivate = async (cat: PersonalCategory) => {
    try {
      await personalService.updateCategory(cat.id, { is_active: false })
      showToast({ message: 'Categoría desactivada', type: 'success' })
      void load()
    } catch {
      showToast({ message: 'Error al desactivar', type: 'error' })
    }
  }

  const visible = categories.filter(c => c.type === tab && c.is_active)

  return (
    <PageContainer>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.25rem 0' }}>
        <span style={{ fontWeight: 800, fontSize: '1.125rem', color: '#f0f4ff' }}>Categorías</span>
        <button
          onClick={openCreate}
          style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '0.625rem', padding: '0.375rem 0.75rem', color: '#34d399', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer' }}
        >
          <Plus size={14} /> Nueva
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.375rem' }}>
        {(['expense', 'income'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '0.625rem', borderRadius: '0.75rem', fontWeight: 700, fontSize: '0.8125rem', cursor: 'pointer',
              background: tab === t ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
              border: tab === t ? '1px solid rgba(99,102,241,0.3)' : '1px solid rgba(255,255,255,0.06)',
              color: tab === t ? '#818cf8' : '#475569',
              transition: 'all 0.12s',
            }}
          >
            {t === 'expense' ? 'Gastos' : 'Ingresos'}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          {[1,2,3,4].map(i => <div key={i} style={{ height: 52, borderRadius: '0.75rem', background: 'rgba(255,255,255,0.03)' }} />)}
        </div>
      ) : visible.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem 1rem' }}>
          <p style={{ fontSize: '0.875rem', color: '#334155', marginBottom: '1rem' }}>
            No hay categorías de {tab === 'expense' ? 'gastos' : 'ingresos'} aún.
          </p>
          <button onClick={openCreate} style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '0.5rem', padding: '0.5rem 1rem', fontSize: '0.8rem', fontWeight: 700, color: '#34d399', cursor: 'pointer' }}>
            Crear la primera
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          {visible.map(cat => (
            <div
              key={cat.id}
              style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.875rem', padding: '0.75rem 1rem' }}
            >
              <div style={{ width: 36, height: 36, borderRadius: '0.625rem', background: `${cat.color}18`, border: `1px solid ${cat.color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem', flexShrink: 0 }}>
                {cat.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '0.875rem', color: '#f0f4ff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {cat.name}
                </div>
                {cat.is_default && (
                  <div style={{ fontSize: '0.62rem', color: '#334155', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Por defecto</div>
                )}
              </div>
              {!cat.is_default && (
                <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
                  <button
                    onClick={() => openEdit(cat)}
                    style={{ background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.15)', borderRadius: '0.5rem', padding: '0.375rem', cursor: 'pointer', color: '#818cf8', display: 'flex', alignItems: 'center' }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => handleDeactivate(cat)}
                    style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: '0.5rem', padding: '0.375rem', cursor: 'pointer', color: '#f87171', display: 'flex', alignItems: 'center' }}
                    title="Desactivar categoría"
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit sheet */}
      <PersonalBottomSheet
        open={sheetOpen}
        title={editing ? 'Editar categoría' : 'Nueva categoría'}
        onClose={closeSheet}
        footer={
          <PrimaryBtn onClick={handleSave} disabled={!form.name.trim() || saving} fullWidth>
            {saving ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear categoría'}
          </PrimaryBtn>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.125rem', padding: '0.25rem 0' }}>

          {/* Name */}
          <PersonalInput
            label="Nombre"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Ej: Supermercado"
          />

          {/* Icon */}
          <PersonalInput
            label="Ícono (emoji)"
            value={form.icon}
            onChange={e => setForm(f => ({ ...f, icon: e.target.value || '📁' }))}
            placeholder="📁"
          />

          {/* Color picker */}
          <div>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>Color</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {PRESET_COLORS.map(color => (
                <button
                  key={color}
                  onClick={() => setForm(f => ({ ...f, color }))}
                  style={{
                    width: 28, height: 28, borderRadius: '50%', background: color, border: form.color === color ? `3px solid #f0f4ff` : '2px solid transparent',
                    cursor: 'pointer', flexShrink: 0,
                  }}
                />
              ))}
            </div>
          </div>

          {/* Type (only when creating) */}
          {!editing && (
            <div>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>Tipo</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.375rem' }}>
                {(['expense', 'income'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setForm(f => ({ ...f, type: t }))}
                    style={{
                      padding: '0.5rem', borderRadius: '0.625rem', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer',
                      background: form.type === t ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                      border: form.type === t ? '1px solid rgba(99,102,241,0.3)' : '1px solid rgba(255,255,255,0.06)',
                      color: form.type === t ? '#818cf8' : '#475569',
                    }}
                  >
                    {t === 'expense' ? 'Gasto' : 'Ingreso'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Preview */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem', padding: '0.75rem 1rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: '0.625rem', background: `${form.color}18`, border: `1px solid ${form.color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem' }}>
              {form.icon || '📁'}
            </div>
            <span style={{ fontWeight: 700, fontSize: '0.875rem', color: '#f0f4ff' }}>{form.name || 'Vista previa'}</span>
          </div>

        </div>
      </PersonalBottomSheet>

    </PageContainer>
  )
}
