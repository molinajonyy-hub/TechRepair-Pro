import { useState } from 'react'
import { Plus, Trash2, ChevronDown, ChevronUp, Check, X, Percent, Loader2, RefreshCw, Power } from 'lucide-react'
import { usePaymentCommissions, type CommissionGroup, type CommissionOption } from '../../hooks/usePaymentCommissions'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CHARGE_MODE_LABELS = {
  none:     { label: 'Sin recargo',           color: '#34d399' },
  customer: { label: 'Recargo al cliente',    color: '#f59e0b' },
  business: { label: 'Lo absorbe el negocio', color: '#818cf8' },
} as const

const inputS: React.CSSProperties = {
  padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem',
  color: 'var(--text-primary)', fontSize: '0.875rem', outline: 'none',
  width: '100%', boxSizing: 'border-box' as const,
}
const labelS: React.CSSProperties = {
  fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-subtle)',
  textTransform: 'uppercase' as const, letterSpacing: '0.05em', display: 'block', marginBottom: '0.3rem',
}

// ─── OptionRow ────────────────────────────────────────────────────────────────

function OptionRow({ option, onUpdate, onDelete }: {
  option: CommissionOption
  onUpdate: (id: string, u: Partial<CommissionOption>) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(option.name)
  const [pct, setPct] = useState(String(option.percentage))
  const [mode, setMode] = useState<CommissionOption['charge_mode']>(option.charge_mode)

  const save = () => {
    const pctNum = parseFloat(pct.replace(',', '.'))
    if (isNaN(pctNum)) return
    onUpdate(option.id, { name, percentage: pctNum, charge_mode: mode })
    setEditing(false)
  }

  const modeInfo = CHARGE_MODE_LABELS[option.charge_mode]

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.5rem',
      padding: '0.5rem 0.75rem',
      background: option.is_active ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.01)',
      borderRadius: '0.5rem',
      border: `1px solid ${option.is_active ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)'}`,
      opacity: option.is_active ? 1 : 0.55,
      flexWrap: 'wrap' as const, rowGap: '0.375rem',
    }}>
      {editing ? (
        <>
          <input style={{ ...inputS, width: 120, fontSize: '0.8rem', flex: '0 0 120px' }} value={name} onChange={e => setName(e.target.value)} placeholder="Nombre" />
          <div style={{ position: 'relative', flex: '0 0 80px' }}>
            <input style={{ ...inputS, paddingRight: '1.5rem', fontSize: '0.8rem', textAlign: 'right' }}
              value={pct} onChange={e => setPct(e.target.value)} placeholder="0" />
            <Percent size={10} style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-subtle)', pointerEvents: 'none' }} />
          </div>
          <select style={{ ...inputS, flex: '1 1 160px', fontSize: '0.75rem' }} value={mode} onChange={e => setMode(e.target.value as any)}>
            {Object.entries(CHARGE_MODE_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button onClick={save} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#22c55e', padding: '0.25rem' }}><Check size={14} /></button>
          <button onClick={() => setEditing(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: '0.25rem' }}><X size={14} /></button>
        </>
      ) : (
        <>
          <span style={{ flex: 1, fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', minWidth: 80 }}>{option.name}</span>
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#f59e0b', fontFamily: 'monospace', minWidth: 44, textAlign: 'right' }}>
            {option.percentage > 0 ? `${option.percentage}%` : '—'}
          </span>
          <span style={{
            fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.4rem', borderRadius: '9999px',
            background: `${modeInfo.color}15`, color: modeInfo.color, border: `1px solid ${modeInfo.color}30`,
            whiteSpace: 'nowrap' as const,
          }}>
            {modeInfo.label}
          </span>
          <button onClick={() => onUpdate(option.id, { is_active: !option.is_active })}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: option.is_active ? '#22c55e' : '#475569', padding: '0.2rem' }}
            title={option.is_active ? 'Desactivar' : 'Activar'}><Power size={13} /></button>
          <button onClick={() => setEditing(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-subtle)', padding: '0.2rem', fontSize: '0.72rem', fontWeight: 600 }}>
            Editar
          </button>
          <button onClick={() => { if (confirm(`¿Eliminar "${option.name}"?`)) onDelete(option.id) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: '0.2rem' }}>
            <Trash2 size={13} />
          </button>
        </>
      )}
    </div>
  )
}

// ─── AddOptionForm ────────────────────────────────────────────────────────────

function AddOptionForm({ onAdd, onCancel }: {
  onAdd: (name: string, pct: number, mode: CommissionOption['charge_mode']) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [pct, setPct] = useState('')
  const [mode, setMode] = useState<CommissionOption['charge_mode']>('customer')

  const submit = () => {
    if (!name.trim()) return
    onAdd(name.trim(), parseFloat(pct.replace(',', '.')) || 0, mode)
    setName(''); setPct('')
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.5rem', background: 'rgba(99,102,241,0.06)', borderRadius: '0.5rem', border: '1px solid rgba(99,102,241,0.2)', marginTop: '0.375rem', flexWrap: 'wrap' as const }}>
      <input style={{ ...inputS, flex: '1 1 120px', fontSize: '0.8rem' }} value={name}
        onChange={e => setName(e.target.value)} placeholder="Nombre (ej: 3 cuotas)" autoFocus
        onKeyDown={e => e.key === 'Enter' && submit()} />
      <div style={{ position: 'relative', flex: '0 0 80px' }}>
        <input style={{ ...inputS, paddingRight: '1.5rem', fontSize: '0.8rem', textAlign: 'right' }}
          value={pct} onChange={e => setPct(e.target.value)} placeholder="%" />
        <Percent size={10} style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-subtle)', pointerEvents: 'none' }} />
      </div>
      <select style={{ ...inputS, flex: '1 1 160px', fontSize: '0.75rem' }} value={mode} onChange={e => setMode(e.target.value as any)}>
        {Object.entries(CHARGE_MODE_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </select>
      <button onClick={submit} className="btn btn-xs btn-fill-indigo"><Check size={12} /> Agregar</button>
      <button onClick={onCancel} className="btn btn-xs btn-ghost"><X size={12} /></button>
    </div>
  )
}

// ─── GroupCard ────────────────────────────────────────────────────────────────

function GroupCard({ group, onUpdateGroup, onDeleteGroup, onUpdateOption, onDeleteOption, onCreateOption }: {
  group: CommissionGroup
  onUpdateGroup: (id: string, u: Partial<CommissionGroup>) => void
  onDeleteGroup: (id: string) => void
  onUpdateOption: (id: string, u: Partial<CommissionOption>) => void
  onDeleteOption: (id: string) => void
  onCreateOption: (groupId: string, name: string, pct: number, mode: CommissionOption['charge_mode']) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(group.name)
  const [colorDraft, setColorDraft] = useState(group.color)
  const [addingOption, setAddingOption] = useState(false)

  return (
    <div style={{
      background: 'var(--bg-card-solid)',
      border: `1px solid ${group.is_active ? group.color + '35' : 'rgba(255,255,255,0.06)'}`,
      borderRadius: '0.875rem', overflow: 'hidden',
      opacity: group.is_active ? 1 : 0.65,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.875rem 1rem', borderBottom: expanded ? '1px solid rgba(255,255,255,0.06)' : 'none', background: 'rgba(255,255,255,0.02)' }}>
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: group.color, flexShrink: 0 }} />

        {editingName ? (
          <div style={{ flex: 1, display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' as const }}>
            <input style={{ ...inputS, fontSize: '0.875rem', fontWeight: 700, flex: '1 1 120px' }}
              value={nameDraft} onChange={e => setNameDraft(e.target.value)} autoFocus />
            <input type="color" value={colorDraft} onChange={e => setColorDraft(e.target.value)}
              style={{ width: 32, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer', borderRadius: 6, flexShrink: 0 }} />
            <button onClick={() => { onUpdateGroup(group.id, { name: nameDraft, color: colorDraft }); setEditingName(false) }}
              className="btn btn-xs btn-fill-indigo"><Check size={12} /></button>
            <button onClick={() => setEditingName(false)} className="btn btn-xs btn-ghost"><X size={12} /></button>
          </div>
        ) : (
          <span style={{ flex: 1, fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.9rem', cursor: 'pointer' }}
            onClick={() => setEditingName(true)} title="Click para editar nombre">
            {group.name}
          </span>
        )}

        <span style={{ fontSize: '0.7rem', color: 'var(--text-subtle)', flexShrink: 0 }}>{group.options.length} opciones</span>

        <button onClick={() => onUpdateGroup(group.id, { is_active: !group.is_active })}
          style={{ width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', background: group.is_active ? '#22c55e' : '#334155', position: 'relative', flexShrink: 0, transition: 'background 0.2s' }}
          title={group.is_active ? 'Desactivar' : 'Activar'}>
          <span style={{ position: 'absolute', top: 2, left: group.is_active ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
        </button>

        <button onClick={() => setExpanded(v => !v)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-subtle)', padding: '0.2rem' }}>
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>

        <button onClick={() => { if (confirm(`¿Eliminar el grupo "${group.name}" y todas sus opciones?`)) onDeleteGroup(group.id) }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: '0.2rem' }} title="Eliminar grupo">
          <Trash2 size={14} />
        </button>
      </div>

      {/* Opciones */}
      {expanded && (
        <div style={{ padding: '0.75rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          {group.options.length === 0 && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-subtle)', textAlign: 'center', padding: '0.75rem', margin: 0 }}>
              Sin opciones. Agregá una abajo.
            </p>
          )}
          {group.options.map(opt => (
            <OptionRow key={opt.id} option={opt} onUpdate={onUpdateOption} onDelete={onDeleteOption} />
          ))}

          {addingOption ? (
            <AddOptionForm
              onAdd={(name, pct, mode) => { onCreateOption(group.id, name, pct, mode); setAddingOption(false) }}
              onCancel={() => setAddingOption(false)}
            />
          ) : (
            <button onClick={() => setAddingOption(true)}
              style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '0.375rem', background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.15)', borderRadius: '0.5rem', padding: '0.375rem 0.75rem', color: 'var(--text-subtle)', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
              <Plus size={12} /> Agregar opción
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── CommissionSettings (principal) ──────────────────────────────────────────

export function CommissionSettings() {
  const { groups, loading, reload, createGroup, updateGroup, deleteGroup, createOption, updateOption, deleteOption } = usePaymentCommissions()
  const [addingGroup, setAddingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupColor, setNewGroupColor] = useState('#6366f1')

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return
    await createGroup(newGroupName.trim(), newGroupColor)
    setNewGroupName(''); setNewGroupColor('#6366f1'); setAddingGroup(false)
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '2rem', color: 'var(--text-subtle)' }}>
      <Loader2 size={18} className="animate-spin" /> Cargando comisiones...
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Encabezado */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <h3 style={{ margin: '0 0 0.375rem', fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            Medios de cobro y comisiones
          </h3>
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-subtle)', lineHeight: 1.5 }}>
            Configurá todos tus medios de cobro con sus porcentajes. Los activos aparecen en Nuevo Comprobante.
          </p>
        </div>
        <button onClick={reload} className="btn btn-sm btn-ghost" title="Recargar"><RefreshCw size={13} /></button>
      </div>

      {/* Fijos */}
      <div style={{ padding: '0.875rem 1rem', background: 'rgba(52,211,153,0.05)', border: '1px solid rgba(52,211,153,0.15)', borderRadius: '0.75rem', fontSize: '0.8rem', color: 'var(--text-subtle)' }}>
        <strong style={{ color: 'var(--text-secondary)' }}>Efectivo</strong> y{' '}
        <strong style={{ color: 'var(--text-secondary)' }}>Transferencia</strong> siempre disponibles sin recargo.
      </div>

      {/* Grupos */}
      {groups.map(g => (
        <GroupCard key={g.id} group={g}
          onUpdateGroup={updateGroup} onDeleteGroup={deleteGroup}
          onUpdateOption={updateOption} onDeleteOption={deleteOption}
          onCreateOption={createOption}
        />
      ))}

      {/* Agregar grupo */}
      {addingGroup ? (
        <div style={{ padding: '1rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <h4 style={{ margin: 0, fontSize: '0.875rem', fontWeight: 700, color: 'var(--text-primary)' }}>Nuevo medio de cobro</h4>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={labelS}>Nombre</label>
              <input style={inputS} value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
                placeholder="Ej: Banco Nación, Ualá, BBVA..." autoFocus
                onKeyDown={e => { if (e.key === 'Enter') handleCreateGroup() }} />
            </div>
            <div>
              <label style={labelS}>Color</label>
              <input type="color" value={newGroupColor} onChange={e => setNewGroupColor(e.target.value)}
                style={{ width: 44, height: 38, padding: 2, border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', background: 'rgba(255,255,255,0.05)', cursor: 'pointer', display: 'block' }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={handleCreateGroup} className="btn btn-sm btn-fill-indigo"><Check size={13} /> Crear grupo</button>
            <button onClick={() => setAddingGroup(false)} className="btn btn-sm btn-ghost"><X size={13} /> Cancelar</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAddingGroup(true)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 1rem', background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.15)', borderRadius: '0.875rem', color: 'var(--text-subtle)', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', width: '100%', justifyContent: 'center' }}>
          <Plus size={16} /> Agregar medio de cobro
        </button>
      )}
    </div>
  )
}
