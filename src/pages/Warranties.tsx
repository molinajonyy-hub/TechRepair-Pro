import { useEffect, useMemo, useRef, useState } from 'react'
import { smartSearch } from '../utils/searchUtils'
import {
  Plus,
  Search,
  ShieldCheck,
  RefreshCw,
  Pencil,
  Trash2,
  Printer,
  Copy as CopyIcon,
  Eye,
  Calendar,
  Filter as FilterIcon,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import {
  Warranty,
  WarrantyInput,
  WarrantyStatus,
  computeWarrantyStatus,
  useWarranties,
} from '../hooks/useWarranties'
import { useOrderPrintSettings } from '../hooks/useOrderPrintSettings'
import { suppliersService, Supplier } from '../services/suppliersService'
import { WarrantyFormModal } from '../components/warranties/WarrantyFormModal'
import { WarrantyDetailModal } from '../components/warranties/WarrantyDetailModal'
import { WarrantyPrintLayout } from '../components/warranties/WarrantyPrintLayout'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso?: string | null): string {
  if (!iso) return '-'
  try {
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso)
    return d.toLocaleDateString('es-AR')
  } catch {
    return iso
  }
}

type FilterStatus = 'all' | WarrantyStatus

// Paleta para badges de estado
const STATUS_BADGE: Record<
  WarrantyStatus,
  { bg: string; color: string; border: string; label: string }
> = {
  active: {
    bg: 'rgba(34,197,94,0.15)',
    color: '#86efac',
    border: 'rgba(34,197,94,0.35)',
    label: '🟢 Vigente',
  },
  expiring_soon: {
    bg: 'rgba(234,179,8,0.15)',
    color: '#fde68a',
    border: 'rgba(234,179,8,0.35)',
    label: '🟡 Por vencer',
  },
  expired: {
    bg: 'rgba(239,68,68,0.15)',
    color: '#fca5a5',
    border: 'rgba(239,68,68,0.35)',
    label: '🔴 Vencida',
  },
}

// ─── Página ──────────────────────────────────────────────────────────────────

export function Warranties() {
  const { businessId } = useAuth()
  const {
    items,
    loading,
    error,
    refresh,
    addWarranty,
    updateWarranty,
    deleteWarranty,
  } = useWarranties()
  const { settings: printSettings } = useOrderPrintSettings(businessId)

  // ── Suppliers para filtro
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  useEffect(() => {
    if (!businessId) return
    let cancelled = false
    suppliersService
      .getActiveSuppliers(businessId)
      .then((data) => {
        if (!cancelled) setSuppliers(data || [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [businessId])

  // ── Filtros
  const [search, setSearch] = useState('')
  const [filterSupplier, setFilterSupplier] = useState<string>('')
  const [filterUser, setFilterUser] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')
  const [filterDateFrom, setFilterDateFrom] = useState<string>('')
  const [filterDateTo, setFilterDateTo] = useState<string>('')

  // ── Usuarios distintos presentes en las garantías (para select)
  const distinctUsers = useMemo(() => {
    const s = new Set<string>()
    items.forEach((w) => {
      if (w.attended_by_name) s.add(w.attended_by_name)
    })
    return Array.from(s).sort((a, b) => a.localeCompare(b))
  }, [items])

  const filtered = useMemo(() => {
    // Primero aplicamos smartSearch con fuzzy matching sobre texto
    const textFiltered = search.trim()
      ? smartSearch(items, search, [
          { getValue: w => w.number,          weight: 2 },
          { getValue: w => w.customer_name,   weight: 2 },
          { getValue: w => w.phone_model,     weight: 1.5 },
          { getValue: w => w.imei },
          { getValue: w => w.serial_number },
          { getValue: w => w.customer_dni },
          { getValue: w => w.customer_phone },
        ])
      : items

    // Luego aplicamos el resto de los filtros (proveedor, técnico, fechas, estado)
    return textFiltered.filter((w) => {
      if (filterSupplier && w.supplier_id !== filterSupplier) return false
      if (filterUser && w.attended_by_name !== filterUser) return false
      if (filterDateFrom && w.issue_date < filterDateFrom) return false
      if (filterDateTo && w.issue_date > filterDateTo) return false
      if (filterStatus !== 'all') {
        const s = computeWarrantyStatus(w.issue_date, w.warranty_days).status
        if (s !== filterStatus) return false
      }
      return true
    })
  }, [items, search, filterSupplier, filterUser, filterStatus, filterDateFrom, filterDateTo])

  const clearFilters = () => {
    setSearch('')
    setFilterSupplier('')
    setFilterUser('')
    setFilterStatus('all')
    setFilterDateFrom('')
    setFilterDateTo('')
  }

  const hasActiveFilters =
    !!search ||
    !!filterSupplier ||
    !!filterUser ||
    filterStatus !== 'all' ||
    !!filterDateFrom ||
    !!filterDateTo

  // ── Modales
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Warranty | null>(null)
  const [prefill, setPrefill] = useState<Warranty | null>(null) // para "duplicar"

  const [detailOpen, setDetailOpen] = useState(false)
  const [detailWarranty, setDetailWarranty] = useState<Warranty | null>(null)

  // ── Impresión directa — window.open() en lugar de react-to-print (más rápido, PDF más liviano)
  const [printingWarranty, setPrintingWarranty] = useState<Warranty | null>(null)
  const printRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!printingWarranty || !printRef.current) return
    const html = printRef.current.innerHTML
    const win = window.open('', '_blank')
    if (!win) { setPrintingWarranty(null); return }
    win.document.write(
      `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">` +
      `<title>Garantia-${printingWarranty.number}</title></head>` +
      `<body style="margin:0;padding:0">${html}</body></html>`
    )
    win.document.close()
    // Esperar imágenes antes de imprimir
    win.addEventListener('load', () => { win.print(); win.close() }, { once: true })
    // Fallback si ya cargó
    setTimeout(() => { if (!win.closed) { win.print(); win.close() } }, 800)
    setPrintingWarranty(null)
  }, [printingWarranty])

  // ── Acciones
  const openCreate = () => {
    setEditing(null)
    setPrefill(null)
    setFormOpen(true)
  }

  const openEdit = (w: Warranty) => {
    setEditing(w)
    setPrefill(null)
    setDetailOpen(false)
    setFormOpen(true)
  }

  const openDuplicate = (w: Warranty) => {
    // creamos una nueva garantía basada en w (sin number, sin fechas)
    setEditing(null)
    const base: Warranty = {
      ...w,
      id: '',
      number: '',
      issue_date: new Date().toISOString().slice(0, 10),
    }
    setPrefill(base)
    setDetailOpen(false)
    setFormOpen(true)
  }

  const openDetail = (w: Warranty) => {
    setDetailWarranty(w)
    setDetailOpen(true)
  }

  const handleSave = async (input: WarrantyInput) => {
    if (editing) {
      await updateWarranty(editing.id, input as Partial<Warranty>)
    } else {
      await addWarranty(input)
    }
  }

  const handleSaveAndPrint = async (input: WarrantyInput) => {
    let warranty: Warranty | undefined | void
    if (editing) {
      await updateWarranty(editing.id, input as Partial<Warranty>)
      warranty = { ...editing, ...(input as any) } as Warranty
    } else {
      warranty = await addWarranty(input)
    }
    if (warranty && (warranty as Warranty).id) {
      setPrintingWarranty(warranty as Warranty)
    }
  }

  const handleDelete = async (w: Warranty) => {
    if (!confirm(`¿Eliminar la garantía ${w.number}? Esta acción se puede revertir desde DB.`)) return
    try {
      await deleteWarranty(w.id)
      if (detailWarranty?.id === w.id) {
        setDetailOpen(false)
        setDetailWarranty(null)
      }
    } catch (err: any) {
      alert(err?.message || 'No se pudo eliminar la garantía')
    }
  }

  // contadores rápidos para header (debe ir ANTES del early return para no romper
  // el orden de hooks entre renders — React error #310).
  const counts = useMemo(() => {
    let a = 0
    let s = 0
    let e = 0
    items.forEach((w) => {
      const st = computeWarrantyStatus(w.issue_date, w.warranty_days).status
      if (st === 'active') a++
      else if (st === 'expiring_soon') s++
      else e++
    })
    return { active: a, soon: s, expired: e, total: items.length }
  }, [items])

  // ── Estado inicial de carga
  if (loading && items.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <RefreshCw className="animate-spin" size={32} style={{ color: '#6366f1' }} />
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div
        style={{
          marginBottom: '1.5rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '0.75rem',
              background: 'linear-gradient(135deg, rgba(34,197,94,0.2), rgba(99,102,241,0.2))',
              border: '1px solid rgba(34,197,94,0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <ShieldCheck size={22} style={{ color: '#86efac' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f8fafc' }}>
              Garantías
            </h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#64748b' }}>
              Gestiona las garantías entregadas a clientes
            </p>
          </div>
        </div>

        <button
          onClick={openCreate}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.625rem 1.25rem',
            background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
            border: 'none',
            color: '#ffffff',
            borderRadius: '0.625rem',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: '0.875rem',
            boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
          }}
        >
          <Plus size={18} />
          Nueva garantía
        </button>
      </div>

      {/* Stats row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '0.75rem',
          marginBottom: '1rem',
        }}
      >
        <StatCard label="Total" value={counts.total} accent="#818cf8" />
        <StatCard label="Vigentes" value={counts.active} accent="#22c55e" />
        <StatCard label="Por vencer (≤7 días)" value={counts.soon} accent="#eab308" />
        <StatCard label="Vencidas" value={counts.expired} accent="#ef4444" />
      </div>

      {/* Filtros */}
      <div
        style={{
          marginBottom: '1rem',
          padding: '1rem',
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.75rem',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '0.75rem',
          alignItems: 'end',
        }}
      >
        <div style={{ gridColumn: 'span 2', minWidth: 0, position: 'relative' }}>
          <Search
            size={18}
            style={{
              position: 'absolute',
              left: '0.75rem',
              top: '50%',
              transform: 'translateY(-50%)',
              color: '#64748b',
            }}
          />
          <input
            type="text"
            placeholder="Buscar por cliente, modelo, IMEI, número…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '0.625rem 0.75rem 0.625rem 2.5rem',
              backgroundColor: 'rgba(15,23,42,0.8)',
              border: '1px solid rgba(51,65,85,0.6)',
              borderRadius: '0.5rem',
              color: '#f1f5f9',
              outline: 'none',
              fontSize: '0.875rem',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <FilterSelect
          label="Estado"
          value={filterStatus}
          onChange={(v) => setFilterStatus(v as FilterStatus)}
          options={[
            { value: 'all', label: 'Todos' },
            { value: 'active', label: '🟢 Vigente' },
            { value: 'expiring_soon', label: '🟡 Por vencer' },
            { value: 'expired', label: '🔴 Vencida' },
          ]}
        />

        <FilterSelect
          label="Proveedor"
          value={filterSupplier}
          onChange={setFilterSupplier}
          options={[{ value: '', label: 'Todos' }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]}
        />

        <FilterSelect
          label="Usuario"
          value={filterUser}
          onChange={setFilterUser}
          options={[{ value: '', label: 'Todos' }, ...distinctUsers.map((u) => ({ value: u, label: u }))]}
        />

        <div>
          <div
            style={{
              fontSize: '0.72rem',
              color: '#94a3b8',
              marginBottom: '0.3rem',
              fontWeight: 500,
              letterSpacing: '0.02em',
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
            }}
          >
            <Calendar size={12} />
            Desde
          </div>
          <input
            type="date"
            value={filterDateFrom}
            onChange={(e) => setFilterDateFrom(e.target.value)}
            style={filterInputStyle}
          />
        </div>
        <div>
          <div
            style={{
              fontSize: '0.72rem',
              color: '#94a3b8',
              marginBottom: '0.3rem',
              fontWeight: 500,
              letterSpacing: '0.02em',
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
            }}
          >
            <Calendar size={12} />
            Hasta
          </div>
          <input
            type="date"
            value={filterDateTo}
            onChange={(e) => setFilterDateTo(e.target.value)}
            style={filterInputStyle}
          />
        </div>

        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            style={{
              padding: '0.55rem 0.9rem',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#94a3b8',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: '0.8125rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              justifyContent: 'center',
              height: '40px',
            }}
          >
            <FilterIcon size={14} />
            Limpiar
          </button>
        )}
      </div>

      {error && (
        <div
          style={{
            marginBottom: '1rem',
            padding: '0.75rem 1rem',
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#fca5a5',
            borderRadius: '0.5rem',
            fontSize: '0.875rem',
          }}
        >
          {error}{' '}
          <button
            onClick={() => refresh()}
            style={{
              marginLeft: '0.5rem',
              background: 'transparent',
              color: '#fca5a5',
              textDecoration: 'underline',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Reintentar
          </button>
        </div>
      )}

      {/* Tabla */}
      <div
        style={{
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.75rem',
          overflow: 'auto',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1100px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <Th>Número</Th>
              <Th>Fecha</Th>
              <Th>Cliente</Th>
              <Th>Modelo</Th>
              <Th>IMEI</Th>
              <Th>Condición</Th>
              <Th>Días</Th>
              <Th>Vencimiento</Th>
              <Th>Estado</Th>
              <Th>Usuario</Th>
              <Th align="right">Acciones</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={11}
                  style={{
                    padding: '3rem 1rem',
                    textAlign: 'center',
                    color: '#64748b',
                    fontSize: '0.875rem',
                  }}
                >
                  {hasActiveFilters
                    ? 'No se encontraron garantías con los filtros seleccionados.'
                    : 'Aún no hay garantías. Creá la primera con el botón “Nueva garantía”.'}
                </td>
              </tr>
            )}
            {filtered.map((w) => {
              const { status, expiryDate, daysRemaining } = computeWarrantyStatus(
                w.issue_date,
                w.warranty_days
              )
              const badge = STATUS_BADGE[status]
              return (
                <tr
                  key={w.id}
                  style={{
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    cursor: 'pointer',
                  }}
                  onClick={() => openDetail(w)}
                >
                  <Td>
                    <span style={{ color: '#a5b4fc', fontWeight: 600 }}>{w.number}</span>
                  </Td>
                  <Td>{fmtDate(w.issue_date)}</Td>
                  <Td strong>{w.customer_name || '-'}</Td>
                  <Td>{w.phone_model || '-'}</Td>
                  <Td muted>{w.imei || w.serial_number || '-'}</Td>
                  <Td>
                    <span
                      style={{
                        padding: '0.15rem 0.5rem',
                        fontSize: '0.72rem',
                        borderRadius: '4px',
                        background:
                          w.equipment_status === 'new'
                            ? 'rgba(99,102,241,0.15)'
                            : 'rgba(234,179,8,0.15)',
                        color: w.equipment_status === 'new' ? '#a5b4fc' : '#fde68a',
                      }}
                    >
                      {w.equipment_status === 'new' ? 'Nuevo' : 'Usado'}
                    </span>
                  </Td>
                  <Td>{w.warranty_days}</Td>
                  <Td>
                    {fmtDate(expiryDate)}
                    {status !== 'expired' && (
                      <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                        {daysRemaining} día{daysRemaining === 1 ? '' : 's'}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <span
                      style={{
                        padding: '0.2rem 0.55rem',
                        fontSize: '0.72rem',
                        fontWeight: 600,
                        borderRadius: '999px',
                        background: badge.bg,
                        color: badge.color,
                        border: `1px solid ${badge.border}`,
                      }}
                    >
                      {badge.label}
                    </span>
                  </Td>
                  <Td muted>{w.attended_by_name || '-'}</Td>
                  <Td align="right">
                    <div
                      style={{ display: 'flex', gap: '0.35rem', justifyContent: 'flex-end' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <IconBtn title="Ver detalle" onClick={() => openDetail(w)}>
                        <Eye size={14} />
                      </IconBtn>
                      <IconBtn title="Imprimir" onClick={() => setPrintingWarranty(w)}>
                        <Printer size={14} />
                      </IconBtn>
                      <IconBtn title="Editar" onClick={() => openEdit(w)}>
                        <Pencil size={14} />
                      </IconBtn>
                      <IconBtn title="Duplicar" onClick={() => openDuplicate(w)}>
                        <CopyIcon size={14} />
                      </IconBtn>
                      <IconBtn title="Eliminar" danger onClick={() => handleDelete(w)}>
                        <Trash2 size={14} />
                      </IconBtn>
                    </div>
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Modales */}
      <WarrantyFormModal
        open={formOpen}
        onClose={() => {
          setFormOpen(false)
          setEditing(null)
          setPrefill(null)
        }}
        onSave={handleSave}
        onSaveAndPrint={handleSaveAndPrint}
        editing={editing}
        prefill={prefill}
      />

      <WarrantyDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        warranty={detailWarranty}
        settings={printSettings}
        onEdit={(w) => openEdit(w)}
        onDuplicate={(w) => openDuplicate(w)}
        onDelete={(w) => handleDelete(w)}
      />

      {/* Print layout oculto para Printer-btn de la tabla */}
      {printingWarranty && (
        <div style={{ position: 'fixed', left: '-10000px', top: 0 }}>
          <WarrantyPrintLayout
            ref={printRef}
            warranty={printingWarranty}
            settings={printSettings}
            duplicate
          />
        </div>
      )}
    </div>
  )
}

// ─── Sub componentes UI de la página ─────────────────────────────────────────

const filterInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  backgroundColor: 'rgba(15,23,42,0.8)',
  border: '1px solid rgba(51,65,85,0.6)',
  borderRadius: '0.5rem',
  color: '#f1f5f9',
  outline: 'none',
  fontSize: '0.875rem',
  boxSizing: 'border-box',
  height: '40px',
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <div>
      <div
        style={{
          fontSize: '0.72rem',
          color: '#94a3b8',
          marginBottom: '0.3rem',
          fontWeight: 500,
          letterSpacing: '0.02em',
        }}
      >
        {label}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={filterInputStyle}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function StatCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div
      style={{
        padding: '0.9rem 1rem',
        backgroundColor: '#0f1829',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '0.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <span style={{ color: '#94a3b8', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
      <span style={{ color: '#f1f5f9', fontSize: '1.5rem', fontWeight: 700 }}>{value}</span>
    </div>
  )
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode
  align?: 'left' | 'right'
}) {
  return (
    <th
      style={{
        padding: '0.8rem 1rem',
        textAlign: align,
        fontSize: '0.78rem',
        fontWeight: 500,
        color: '#94a3b8',
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  align = 'left',
  strong = false,
  muted = false,
}: {
  children: React.ReactNode
  align?: 'left' | 'right'
  strong?: boolean
  muted?: boolean
}) {
  return (
    <td
      style={{
        padding: '0.85rem 1rem',
        textAlign: align,
        color: muted ? '#94a3b8' : '#e2e8f0',
        fontWeight: strong ? 600 : 400,
        fontSize: '0.875rem',
        verticalAlign: 'middle',
      }}
    >
      {children}
    </td>
  )
}

function IconBtn({
  children,
  title,
  onClick,
  danger = false,
}: {
  children: React.ReactNode
  title: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        padding: '0.4rem',
        width: '30px',
        height: '30px',
        backgroundColor: danger ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.05)',
        border: danger ? '1px solid rgba(239,68,68,0.25)' : '1px solid rgba(255,255,255,0.08)',
        borderRadius: '0.375rem',
        cursor: 'pointer',
        color: danger ? '#f87171' : '#cbd5e1',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </button>
  )
}
