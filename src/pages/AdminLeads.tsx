import { useState, useEffect, useCallback } from 'react'
import { Search, RefreshCw, MessageCircle, Mail, StickyNote } from 'lucide-react'
import { supabase } from '../lib/supabase'

type LeadStatus = 'nuevo' | 'contactado' | 'convertido' | 'descartado'

type Lead = {
  id: string
  name: string
  email: string
  business_name: string | null
  message: string | null
  notes: string | null
  status: LeadStatus
  source: string
  created_at: string
}

const STATUS_CONFIG: Record<LeadStatus, { label: string; color: string; bg: string }> = {
  nuevo:       { label: 'Nuevo',       color: '#818cf8', bg: 'rgba(99,102,241,0.12)'  },
  contactado:  { label: 'Contactado',  color: '#fbbf24', bg: 'rgba(251,191,36,0.12)'  },
  convertido:  { label: 'Convertido',  color: '#22c55e', bg: 'rgba(34,197,94,0.12)'   },
  descartado:  { label: 'Descartado',  color: '#475569', bg: 'rgba(71,85,105,0.12)'   },
}

const F = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

export function AdminLeads() {
  const [leads, setLeads]           = useState<Lead[]>([])
  const [loading, setLoading]       = useState(true)
  const [search, setSearch]         = useState('')
  const [filterStatus, setFilter]   = useState<LeadStatus | 'all'>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editNotes, setEditNotes]   = useState<{ id: string; text: string } | null>(null)
  const [savingNotes, setSavingNotes] = useState(false)

  const loadLeads = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('contact_leads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500)
    setLeads((data || []) as Lead[])
    setLoading(false)
  }, [])

  useEffect(() => { loadLeads() }, [loadLeads])

  const updateStatus = async (id: string, status: LeadStatus) => {
    await supabase.from('contact_leads').update({ status }).eq('id', id)
    setLeads(prev => prev.map(l => l.id === id ? { ...l, status } : l))
  }

  const saveNotes = async () => {
    if (!editNotes) return
    setSavingNotes(true)
    await supabase.from('contact_leads').update({ notes: editNotes.text || null }).eq('id', editNotes.id)
    setLeads(prev => prev.map(l => l.id === editNotes.id ? { ...l, notes: editNotes.text || null } : l))
    setSavingNotes(false)
    setEditNotes(null)
  }

  const filtered = leads.filter(l => {
    if (filterStatus !== 'all' && l.status !== filterStatus) return false
    if (!search) return true
    const s = search.toLowerCase()
    return (
      l.name.toLowerCase().includes(s) ||
      l.email.toLowerCase().includes(s) ||
      (l.business_name || '').toLowerCase().includes(s) ||
      (l.message || '').toLowerCase().includes(s)
    )
  })

  const stats = {
    total:      leads.length,
    nuevo:      leads.filter(l => l.status === 'nuevo').length,
    contactado: leads.filter(l => l.status === 'contactado').length,
    convertido: leads.filter(l => l.status === 'convertido').length,
    descartado: leads.filter(l => l.status === 'descartado').length,
  }

  return (
    <div style={{ padding: '2rem', fontFamily: F, maxWidth: '1100px', margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f1f5f9', fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.03em' }}>
            Leads de contacto
          </h1>
          <p style={{ margin: '0.25rem 0 0', color: '#475569', fontSize: '0.85rem' }}>
            Formulario de contacto de la landing pública
          </p>
        </div>
        <button
          onClick={loadLeads}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 1rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.625rem', color: '#94a3b8', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer' }}
        >
          <RefreshCw size={14} /> Actualizar
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.75rem', marginBottom: '1.75rem' }}>
        {[
          { label: 'Total', value: stats.total,      color: '#94a3b8' },
          { label: 'Nuevos', value: stats.nuevo,      color: '#818cf8' },
          { label: 'Contactados', value: stats.contactado, color: '#fbbf24' },
          { label: 'Convertidos', value: stats.convertido, color: '#22c55e' },
          { label: 'Descartados', value: stats.descartado, color: '#475569' },
        ].map(s => (
          <div key={s.label} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.75rem', padding: '0.875rem 1rem' }}>
            <div style={{ color: s.color, fontSize: '1.5rem', fontWeight: 800 }}>{s.value}</div>
            <div style={{ color: '#475569', fontSize: '0.75rem', fontWeight: 600, marginTop: '0.125rem' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1', minWidth: '200px' }}>
          <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
          <input
            type="text"
            placeholder="Buscar por nombre, email, negocio..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box', paddingLeft: '2.25rem', paddingRight: '0.875rem',
              paddingTop: '0.625rem', paddingBottom: '0.625rem',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '0.625rem', color: '#f1f5f9', fontSize: '0.85rem', fontFamily: F, outline: 'none',
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.375rem' }}>
          {(['all', 'nuevo', 'contactado', 'convertido', 'descartado'] as const).map(s => {
            const isActive = filterStatus === s
            const cfg = s === 'all' ? null : STATUS_CONFIG[s]
            return (
              <button
                key={s}
                onClick={() => setFilter(s)}
                style={{
                  padding: '0.5rem 0.875rem',
                  borderRadius: '0.625rem',
                  border: '1px solid ' + (isActive && cfg ? cfg.color + '55' : 'rgba(255,255,255,0.08)'),
                  background: isActive && cfg ? cfg.bg : isActive ? 'rgba(255,255,255,0.07)' : 'transparent',
                  color: isActive && cfg ? cfg.color : isActive ? '#f1f5f9' : '#475569',
                  fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: F,
                }}
              >
                {s === 'all' ? 'Todos' : STATUS_CONFIG[s].label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: '#475569' }}>Cargando leads...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: '#334155', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '1rem' }}>
          {leads.length === 0 ? 'Todavía no hay leads. Cuando alguien complete el formulario de la landing, aparecerá aquí.' : 'No hay leads que coincidan con el filtro.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {filtered.map(lead => {
            const cfg = STATUS_CONFIG[lead.status]
            const isExpanded = expandedId === lead.id
            const isEditingNotes = editNotes?.id === lead.id

            return (
              <div
                key={lead.id}
                style={{
                  background: 'rgba(255,255,255,0.025)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '0.875rem',
                  overflow: 'hidden',
                  transition: 'border-color 0.15s',
                }}
              >
                {/* Main row */}
                <div
                  style={{ display: 'grid', gridTemplateColumns: '2fr 2.5fr 1.5fr 1fr auto', gap: '1rem', padding: '0.875rem 1.125rem', alignItems: 'center', cursor: 'pointer' }}
                  onClick={() => setExpandedId(isExpanded ? null : lead.id)}
                >
                  {/* Name + business */}
                  <div>
                    <div style={{ color: '#f1f5f9', fontWeight: 700, fontSize: '0.875rem' }}>{lead.name}</div>
                    {lead.business_name && (
                      <div style={{ color: '#475569', fontSize: '0.75rem', marginTop: '0.125rem' }}>{lead.business_name}</div>
                    )}
                  </div>

                  {/* Email */}
                  <div style={{ color: '#64748b', fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {lead.email}
                  </div>

                  {/* Date */}
                  <div style={{ color: '#334155', fontSize: '0.78rem' }}>
                    {new Date(lead.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </div>

                  {/* Status selector */}
                  <select
                    value={lead.status}
                    onChange={e => { e.stopPropagation(); updateStatus(lead.id, e.target.value as LeadStatus) }}
                    onClick={e => e.stopPropagation()}
                    style={{
                      padding: '0.3rem 0.5rem',
                      background: cfg.bg,
                      border: '1px solid ' + cfg.color + '55',
                      borderRadius: '0.5rem',
                      color: cfg.color,
                      fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', fontFamily: F, outline: 'none',
                    }}
                  >
                    {(Object.entries(STATUS_CONFIG) as [LeadStatus, typeof STATUS_CONFIG[LeadStatus]][]).map(([v, c]) => (
                      <option key={v} value={v} style={{ background: '#0f172a', color: c.color }}>{c.label}</option>
                    ))}
                  </select>

                  {/* Quick actions */}
                  <div style={{ display: 'flex', gap: '0.375rem' }} onClick={e => e.stopPropagation()}>
                    <a
                      href={`https://wa.me/${lead.email.replace('@', '')}?text=Hola%20${encodeURIComponent(lead.name)}%2C%20te%20contactamos%20desde%20TechRepair%20Pro`}
                      title="WhatsApp (abrí manualmente)"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '0.5rem', background: 'rgba(37,211,102,0.1)', border: '1px solid rgba(37,211,102,0.2)', color: '#25d366', textDecoration: 'none' }}
                    >
                      <MessageCircle size={13} />
                    </a>
                    <a
                      href={`mailto:${lead.email}?subject=TechRepair Pro - Tu consulta&body=Hola ${encodeURIComponent(lead.name)},%0D%0A%0D%0AGracias por contactarnos.`}
                      title="Enviar email"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '0.5rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', color: '#818cf8', textDecoration: 'none' }}
                    >
                      <Mail size={13} />
                    </a>
                  </div>
                </div>

                {/* Expanded: message + notes */}
                {isExpanded && (
                  <div style={{ padding: '0 1.125rem 1rem', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    {lead.message && (
                      <div style={{ marginTop: '0.875rem' }}>
                        <div style={{ color: '#475569', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>
                          Mensaje
                        </div>
                        <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.85rem', lineHeight: 1.65, background: 'rgba(255,255,255,0.025)', borderRadius: '0.625rem', padding: '0.75rem 1rem' }}>
                          {lead.message}
                        </p>
                      </div>
                    )}

                    {/* Notes */}
                    <div style={{ marginTop: '0.875rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                        <StickyNote size={12} color="#475569" />
                        <span style={{ color: '#475569', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Notas internas</span>
                      </div>
                      {isEditingNotes ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          <textarea
                            value={editNotes.text}
                            onChange={e => setEditNotes({ id: lead.id, text: e.target.value })}
                            rows={3}
                            autoFocus
                            style={{ width: '100%', boxSizing: 'border-box', padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: '0.625rem', color: '#f1f5f9', fontSize: '0.82rem', fontFamily: F, outline: 'none', resize: 'vertical' }}
                          />
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button
                              onClick={saveNotes}
                              disabled={savingNotes}
                              style={{ padding: '0.4rem 0.875rem', background: 'linear-gradient(135deg, #6366f1, #4f46e5)', border: 'none', borderRadius: '0.5rem', color: '#fff', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}
                            >
                              {savingNotes ? 'Guardando...' : 'Guardar'}
                            </button>
                            <button
                              onClick={() => setEditNotes(null)}
                              style={{ padding: '0.4rem 0.875rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.5rem', color: '#64748b', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: F }}
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          onClick={() => setEditNotes({ id: lead.id, text: lead.notes || '' })}
                          style={{ cursor: 'pointer', padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.08)', borderRadius: '0.625rem', color: lead.notes ? '#64748b' : '#334155', fontSize: '0.82rem', lineHeight: 1.6, minHeight: '2.5rem' }}
                        >
                          {lead.notes || 'Click para agregar notas internas...'}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {filtered.length > 0 && (
        <p style={{ textAlign: 'center', color: '#1e293b', fontSize: '0.75rem', marginTop: '1.5rem' }}>
          Mostrando {filtered.length} de {leads.length} lead{leads.length !== 1 ? 's' : ''}
        </p>
      )}
    </div>
  )
}
