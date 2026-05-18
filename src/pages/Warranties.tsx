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
import { sanitizeFilenamePart } from '../lib/printFilename'
import { suppliersService, Supplier } from '../services/suppliersService'
import { WarrantyFormModal } from '../components/warranties/WarrantyFormModal'
import { WarrantyDetailModal } from '../components/warranties/WarrantyDetailModal'
import { WarrantyPrintLayout } from '../components/warranties/WarrantyPrintLayout'

// ─── Helpers ──────────────────────────────────────────────────────────────────

import { fmtDate as _fmtDateUtil } from '../utils/dateUtils'
function fmtDate(iso?: string | null): string {
  if (!iso) return '-'
  try { return _fmtDateUtil(iso) } catch { return iso }
}

type FilterStatus = 'all' | WarrantyStatus

const STATUS_BADGE: Record<WarrantyStatus, { cls: string; label: string }> = {
  active:        { cls: 'badge-success', label: 'Vigente'    },
  expiring_soon: { cls: 'badge-warning', label: 'Por vencer' },
  expired:       { cls: 'badge-error',   label: 'Vencida'    },
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
      `<title>${sanitizeFilenamePart(printSettings.nombre_comercial || 'Garantia')}-Garantia-${printingWarranty.number}</title></head>` +
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
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon green"><ShieldCheck size={22} /></div>
          <div>
            <h1 className="page-hdr-title">Garantías</h1>
            <p className="page-hdr-subtitle">Gestiona las garantías entregadas a clientes</p>
          </div>
        </div>
        <div className="page-hdr-right">
          <button onClick={openCreate} className="btn btn-primary btn-sm btn-lift">
            <Plus size={16} />
            Nueva garantía
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
        {[
          { label: 'Total',                value: counts.total,   color: 'var(--accent-primary)' },
          { label: 'Vigentes',             value: counts.active,  color: '#22c55e'  },
          { label: 'Por vencer (≤7 días)', value: counts.soon,    color: '#eab308'  },
          { label: 'Vencidas',             value: counts.expired, color: '#ef4444'  },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <div className="stat-card-label">{s.label}</div>
            <div className="stat-card-value" style={{ color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div className="filter-bar" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', alignItems: 'end', marginBottom: '1rem' }}>
        <div style={{ gridColumn: 'span 2', minWidth: 0, position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
          <input
            type="text"
            placeholder="Buscar por cliente, modelo, IMEI, número…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="form-control"
            style={{ paddingLeft: '2.25rem' }}
          />
        </div>

        <FilterSelect
          label="Estado"
          value={filterStatus}
          onChange={(v) => setFilterStatus(v as FilterStatus)}
          options={[
            { value: 'all',           label: 'Todos'      },
            { value: 'active',        label: 'Vigente'    },
            { value: 'expiring_soon', label: 'Por vencer' },
            { value: 'expired',       label: 'Vencida'    },
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
            className="form-control"
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
            className="form-control"
          />
        </div>

        {hasActiveFilters && (
          <button onClick={clearFilters} className="btn btn-ghost btn-sm" style={{ height: '40px' }}>
            <FilterIcon size={14} /> Limpiar
          </button>
        )}
      </div>

      {error && (
        <div className="alert-inline alert-error" style={{ marginBottom: '1rem' }}>
          {error}{' '}
          <button onClick={() => refresh()} className="btn btn-ghost btn-sm" style={{ marginLeft: '0.375rem', color: 'inherit', textDecoration: 'underline', padding: 0 }}>
            Reintentar
          </button>
        </div>
      )}

      {/* Tabla */}
      <div className="surface-raised table-wrap" style={{ overflow: 'auto' }}>
        <table className="data-table" style={{ minWidth: '1100px' }}>
          <thead>
            <tr>
              <th>Número</th>
              <th>Fecha</th>
              <th>Cliente</th>
              <th>Modelo</th>
              <th>IMEI</th>
              <th>Condición</th>
              <th>Días</th>
              <th>Vencimiento</th>
              <th>Estado</th>
              <th>Usuario</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr className="empty-row">
                <td colSpan={11}>
                  {hasActiveFilters
                    ? <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-subtle)', fontSize: '0.875rem' }}>No se encontraron garantías con los filtros seleccionados.</div>
                    : <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-subtle)', fontSize: '0.875rem' }}>Aún no hay garantías. Creá la primera con el botón "Nueva garantía".</div>}
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
                <tr key={w.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(w)}>
                  <td><span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>{w.number}</span></td>
                  <td>{fmtDate(w.issue_date)}</td>
                  <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{w.customer_name || '-'}</td>
                  <td>{w.phone_model || '-'}</td>
                  <td className="body-sm">{w.imei || w.serial_number || '-'}</td>
                  <td>
                    <span className={w.equipment_status === 'new' ? 'badge badge-info' : 'badge badge-warning'} style={{ borderRadius: '4px' }}>
                      {w.equipment_status === 'new' ? 'Nuevo' : 'Usado'}
                    </span>
                  </td>
                  <td>{w.warranty_days}</td>
                  <td>
                    {fmtDate(expiryDate)}
                    {status !== 'expired' && (
                      <div className="body-sm">{daysRemaining} día{daysRemaining === 1 ? '' : 's'}</div>
                    )}
                  </td>
                  <td><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                  <td className="body-sm">{w.attended_by_name || '-'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
                      <button title="Ver detalle" onClick={() => openDetail(w)} className="icon-btn"><Eye size={14} /></button>
                      <button title="Imprimir" onClick={() => setPrintingWarranty(w)} className="icon-btn"><Printer size={14} /></button>
                      <button title="Editar" onClick={() => openEdit(w)} className="icon-btn icon-btn-primary"><Pencil size={14} /></button>
                      <button title="Duplicar" onClick={() => openDuplicate(w)} className="icon-btn icon-btn-violet"><CopyIcon size={14} /></button>
                      <button title="Eliminar" onClick={() => handleDelete(w)} className="icon-btn icon-btn-danger">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
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
      <div className="label-caps" style={{ marginBottom: '0.3rem' }}>{label}</div>
      <select className="form-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
      </select>
    </div>
  )
}

