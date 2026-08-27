import { useEffect, useMemo, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Search, Eye, Phone, Mail, Users, Download, Upload, Pencil, Trash2, Loader2, X } from 'lucide-react'
import { smartSearch } from '../utils/searchUtils'
import { CloseButton } from '../components/ui/CloseButton'
import { EmptyState } from '../components/ui/EmptyState'
import { customersService } from '../services/api'
import { useLoading } from '../contexts/LoadingContext'
import { ModalImportExcel } from '../components/ModalImportExcel'
import { ExcelService, ExcelRow } from '../services/excelService'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useRefreshOnWakeUp } from '../hooks/useAppWakeUp'
import {
  CUSTOMER_TYPES,
  DOCUMENT_TYPES,
  documentSearchTokens,
  firstCustomerCoreError,
  useCustomerCore,
  type CustomerCoreRecord,
} from '../features/customer-core'

// `customersService.getAll()` hace `select('*')`: la fila trae estos campos.
// Declararlos evita hidratar el formulario de edición desde un `any` y perder
// silenciosamente razón social, documento o persona de contacto.
type CustomerSummary = CustomerCoreRecord & {
  id: string
  name: string
  phone?: string
  email?: string
}

type CustomerStats = {
  orders: number
  total: number
}

/**
 * Fila de orden que alimenta las estadísticas de la lista.
 *
 * Está tipada a propósito: mientras el estado era `any[]`, leer una relación
 * embebida inexistente (`order.customer?.id`) compilaba sin queja y rompía el
 * cálculo en silencio. Con este tipo, ese error es de compilación.
 */
type CustomerStatsOrderRow = {
  id: string
  customer_id: string | null
  total_cost: number | null
  estimated_total: number | null
}

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0)

export function Customers() {
  const { businessId } = useAuth()
  const [searchTerm, setSearchTerm]     = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()
  const [customers, setCustomers] = useState<CustomerSummary[]>([])
  const [orders, setOrders] = useState<CustomerStatsOrderRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showImportModal, setShowImportModal] = useState(false)
  const { showLoading, hideLoading } = useLoading()

  // ── Editar cliente ───────────────────────────────────────────
  // Las reglas salen del customer core, igual que en las dos altas. Antes esta
  // pantalla no conocía razón social, persona de contacto ni documento, así que
  // podía dejar un mayorista SIN razón social — dato inválido que ninguna de
  // las altas permitía crear.
  const [editingCustomer, setEditingCustomer] = useState<any | null>(null)
  const { values: editForm, errors: editErrors, setField: setEditField, setCustomerType: setEditCustomerType, reset: resetEditForm, toUpdatePayload } =
    useCustomerCore({ mode: 'update' })
  const [editLoading, setEditLoading] = useState(false)
  const [editError, setEditError] = useState('')

  const openEdit = (customer: CustomerSummary) => {
    setEditingCustomer(customer)
    resetEditForm(customer)
    setEditError('')
  }

  const handleEditSave = async () => {
    if (!editingCustomer) return
    // El motivo ya se muestra al lado del campo que falla; el alerta de arriba
    // queda reservada para errores del servidor y no repite el mismo texto.
    if (firstCustomerCoreError(editErrors)) return
    setEditLoading(true)
    setEditError('')
    try {
      await customersService.update(editingCustomer.id, toUpdatePayload())
      setEditingCustomer(null)
      await loadCustomers()
    } catch (err: any) {
      setEditError(err.message || 'Error al guardar')
    } finally {
      setEditLoading(false)
    }
  }

  // ── Eliminar cliente ─────────────────────────────────────────
  const [deletingCustomer, setDeletingCustomer] = useState<CustomerSummary | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const handleDeleteConfirm = async () => {
    if (!deletingCustomer || !businessId) return
    setDeleteLoading(true)
    setDeleteError('')
    try {
      // Siempre filtrar por business_id para evitar eliminación cruzada entre negocios
      const { error } = await supabase
        .from('customers')
        .delete()
        .eq('id', deletingCustomer.id)
        .eq('business_id', businessId)
      if (error) throw error
      setDeletingCustomer(null)
      await loadCustomers()
    } catch (err: any) {
      setDeleteError(err.message || 'Error al eliminar')
    } finally {
      setDeleteLoading(false)
    }
  }

  useEffect(() => {
    void loadCustomers()
  }, [])

  // Debounce 300ms para el buscador — evita re-render en cada keystroke
  useEffect(() => {
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setDebouncedSearch(searchTerm), 300)
    return () => clearTimeout(searchTimer.current)
  }, [searchTerm])

  const loadCustomers = async () => {
    try {
      setError(null)

      // Cargar clientes con un conteo de órdenes embebido — evita traer todas las órdenes
      const [customersResult, ordersCountResult] = await Promise.allSettled([
        customersService.getAll(),
        // Query liviana para estadísticas. `estimated_total` es obligatorio:
        // el valor de una orden es `total_cost` cuando es positivo y si no el
        // presupuesto estimado. Sin traerlo, toda orden aún sin costo final
        // sumaba 0 aunque tuviera presupuesto.
        supabase
          .from('orders')
          .select('id, customer_id, total_cost, estimated_total')
          .eq('business_id', businessId)
          .limit(2000),
      ])

      if (customersResult.status === 'rejected') {
        throw customersResult.reason
      }

      setCustomers((customersResult.value || []) as CustomerSummary[])

      if (ordersCountResult.status === 'fulfilled') {
        setOrders((ordersCountResult.value.data || []) as CustomerStatsOrderRow[])
      } else {
        console.error('Error loading customer stats:', ordersCountResult.reason)
        setOrders([])
      }
    } catch (err: any) {
      setError(err.message || 'Error al cargar clientes')
    }
  }

  useRefreshOnWakeUp(loadCustomers)

  const handleExportCustomers = async () => {
    try {
      // Obtener datos completos de clientes
      const { data: fullCustomers } = await supabase
        .from('customers')
        .select('*')
        .eq('business_id', businessId)

      const exportData = (fullCustomers || []).map((customer: any) => ({
        'Nombre y apellido': customer.name,
        'Teléfono': customer.phone || '',
        'Email': customer.email || '',
        'Documento': customer.document || '',
        'Dirección': customer.address || '',
        'Ciudad': customer.city || '',
        'Observaciones': customer.notes || '',
        'Fecha de alta': customer.created_at || '',
        'Estado': customer.active ? 'Activo' : 'Inactivo'
      }))

      await ExcelService.exportToExcel(exportData, 'clientes', 'Clientes')
      alert('Clientes exportados exitosamente')
    } catch (error) {
      alert('Error al exportar clientes: ' + (error instanceof Error ? error.message : 'Error desconocido'))
    }
  }

  const handleImportCustomers = async (data: ExcelRow[]) => {
    showLoading('Importando clientes...')
    let created = 0
    let updated = 0

    try {
      for (const row of data) {
        const phone = row['Teléfono'] || row['telefono'] || row['phone']
        const email = row['Email'] || row['email']
        const document = row['Documento'] || row['documento'] || row['document']

        // Buscar si existe por teléfono, email o documento
        const { data: existingCustomer } = await supabase
          .from('customers')
          .select('*')
          .or(`phone.eq.${phone},email.eq.${email},document.eq.${document}`)
          .eq('business_id', businessId)
          .limit(1)
          .maybeSingle()

        const customerData = {
          name: row['Nombre y apellido'] || row['nombre'] || row['name'] || '',
          phone: phone || '',
          email: email || '',
          document: document || '',
          address: row['Dirección'] || row['direccion'] || row['address'] || '',
          city: row['Ciudad'] || row['ciudad'] || row['city'] || '',
          notes: row['Observaciones'] || row['observaciones'] || row['notes'] || '',
          active: row['Estado'] === 'Activo' || row['estado'] === 'activo' || true,
          business_id: businessId
        }

        if (existingCustomer) {
          await supabase
            .from('customers')
            .update(customerData)
            .eq('id', existingCustomer.id)
          updated++
        } else {
          await supabase
            .from('customers')
            .insert([customerData])
          created++
        }
      }

      loadCustomers()
      return { created, updated }
    } catch (error) {
      console.error('Error importando clientes:', error)
      throw error
    } finally {
      hideLoading()
    }
  }

  const handleDownloadTemplate = async () => {
    const headers = [
      'Nombre y apellido',
      'Teléfono',
      'Email',
      'Documento',
      'Dirección',
      'Ciudad',
      'Observaciones',
      'Fecha de alta',
      'Estado'
    ]

    const exampleData = [{
      'Nombre y apellido': 'Juan Pérez',
      'Teléfono': '5493512345678',
      'Email': 'juan.perez@email.com',
      'Documento': '12345678',
      'Dirección': 'Av. Corrientes 1234',
      'Ciudad': 'Buenos Aires',
      'Observaciones': 'Cliente frecuente',
      'Fecha de alta': '2024-01-15',
      'Estado': 'Activo'
    }]

    await ExcelService.createTemplate(headers, 'plantilla_clientes', exampleData)
  }


  const filteredCustomers = useMemo(() => {
    return smartSearch(customers, debouncedSearch, [
      { getValue: c => c.name,                    weight: 3 },
      { getValue: c => (c as any).phone,           weight: 3 },
      { getValue: c => c.email,                   weight: 2 },
      // Todas las representaciones del documento: conviven filas canónicas
      // (`DNI 30123456`) con históricas (`DNI: 30.123.456`) y este lote no las
      // migra, así que se busca con y sin separadores.
      { getValue: c => documentSearchTokens((c as any).document).join(' '), weight: 3 },
      { getValue: c => (c as any).address,         weight: 1 },
      { getValue: c => (c as any).city,            weight: 1 },
      { getValue: c => (c as any).notes,           weight: 0.5 },
      { getValue: c => (c as any).customer_type,   weight: 1 },
    ])
  }, [customers, debouncedSearch])

  const customerStats = useMemo(() => {
    return orders.reduce<Record<string, CustomerStats>>((stats, order) => {
      // La query trae `customer_id` plano, NO una relación embebida. Leer
      // `order.customer?.id` daba siempre undefined y descartaba TODAS las
      // órdenes, así que cada cliente mostraba 0 órdenes y $0.
      const customerId = order.customer_id

      if (!customerId) {
        return stats
      }

      const currentStats = stats[customerId] || { orders: 0, total: 0 }
      const total =
        typeof order.total_cost === 'number' && order.total_cost > 0
          ? order.total_cost
          : order.estimated_total || 0

      stats[customerId] = {
        orders: currentStats.orders + 1,
        total: currentStats.total + total,
      }

      return stats
    }, {})
  }, [orders])

  if (error) {
    return (
      <div>
        <div className="page-hdr">
          <div className="page-hdr-left">
            <div className="page-hdr-icon"><Users size={22} /></div>
            <div><h1 className="page-hdr-title">Clientes</h1></div>
          </div>
        </div>
        <div className="alert-inline alert-error" style={{ marginBottom: '1rem' }}>{error}</div>
        <button onClick={() => void loadCustomers()} className="btn btn-ghost btn-sm">Reintentar</button>
      </div>
    )
  }

  return (
    <div>
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon"><Users size={22} /></div>
          <div>
            <h1 className="page-hdr-title">Clientes</h1>
            <p className="page-hdr-subtitle">Gestiona la base de datos de clientes</p>
          </div>
        </div>
        <div className="page-hdr-right">
          <button onClick={handleDownloadTemplate} className="btn btn-ghost btn-sm"><Download size={15} />Plantilla</button>
          <button onClick={handleExportCustomers} className="btn btn-ghost btn-sm"><Download size={15} />Exportar</button>
          <button onClick={() => setShowImportModal(true)} className="btn btn-ghost btn-sm"><Upload size={15} />Importar</button>
          <Link to="/customers/new" data-testid="customers-new-button" className="btn btn-primary btn-sm btn-lift" style={{ textDecoration: 'none' }}>
            <Plus size={16} />Nuevo Cliente
          </Link>
        </div>
      </div>

      <div className="filter-bar">
        <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
          <Search size={15} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
          <input
            type="text"
            data-testid="customers-search-input"
            placeholder="Buscar por nombre, teléfono, email..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="form-control"
            style={{ paddingLeft: '2.25rem', paddingRight: searchTerm ? '2rem' : undefined }}
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="icon-btn" aria-label="Limpiar"
              style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', width: 22, height: 22 }}>
              <X size={12} />
            </button>
          )}
        </div>
        {debouncedSearch && (
          <span className="body-sm" style={{ whiteSpace: 'nowrap', alignSelf: 'center' }}>
            {filteredCustomers.length} resultado{filteredCustomers.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="surface-raised" style={{ overflow: 'hidden' }}>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Contacto</th>
                <th>Órdenes</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th style={{ textAlign: 'right' }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filteredCustomers.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan={5}>
                    {customers.length === 0 ? (
                      <EmptyState
                        icon={Users}
                        title="Todavía no tenés clientes"
                        description="Comenzá agregando tu primer cliente para gestionar sus reparaciones."
                      />
                    ) : (
                      <EmptyState
                        icon={Search}
                        title={`Sin resultados para "${searchTerm}"`}
                        description="Probá con otro nombre, teléfono o email"
                        action={{ label: 'Limpiar búsqueda', onClick: () => setSearchTerm('') }}
                      />
                    )}
                  </td>
                </tr>
              ) : (
                filteredCustomers.map((customer) => {
                  const stats = customerStats[customer.id] || { orders: 0, total: 0 }

                  return (
                    <tr key={customer.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <Link to={`/customers/${customer.id}`} style={{ color: 'var(--accent-primary)', fontWeight: 600, textDecoration: 'none' }}>
                            {customer.name}
                          </Link>
                          {(customer as any).customer_type === 'mayorista' && (
                            <span className="badge badge-info" style={{ fontSize: '0.62rem' }}>MAYORISTA</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <span className="body-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <Phone size={13} /> {customer.phone || <span style={{ opacity: 0.5 }}>Sin teléfono</span>}
                          </span>
                          <span className="body-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <Mail size={13} /> {customer.email || <span style={{ opacity: 0.5 }}>Sin email</span>}
                          </span>
                        </div>
                      </td>
                      <td>{stats.orders}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {formatCurrency(stats.total)}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.375rem', justifyContent: 'flex-end' }}>
                          <Link to={`/customers/${customer.id}`} className="icon-btn" title="Ver detalle" style={{ textDecoration: 'none' }}>
                            <Eye size={15} />
                          </Link>
                          <button onClick={() => openEdit(customer)} className="icon-btn icon-btn-primary" title="Editar cliente">
                            <Pencil size={15} />
                          </button>
                          <button onClick={() => { setDeletingCustomer(customer); setDeleteError('') }} className="icon-btn icon-btn-danger" title="Eliminar cliente">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal Importar Excel */}
      <ModalImportExcel
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImport={handleImportCustomers}
        title="Importar Clientes"
        requiredColumns={[]}
        downloadTemplate={handleDownloadTemplate}
      />

      {/* ── Modal Editar Cliente ─────────────────────────────── */}
      {editingCustomer && (
        <div className="modal-overlay-dark" onClick={() => setEditingCustomer(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-hdr">
              <h2>Editar Cliente</h2>
              <CloseButton onClick={() => setEditingCustomer(null)} />
            </div>
            <div className="modal-body-scroll">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
                {([
                  { label: 'Nombre *', key: 'name', placeholder: 'Nombre y apellido' },
                  { label: 'Teléfono', key: 'phone', placeholder: 'Ej: 5493512345678' },
                  { label: 'Email', key: 'email', placeholder: 'correo@ejemplo.com' },
                  { label: 'Dirección', key: 'address', placeholder: 'Av. Corrientes 1234, CABA' },
                  { label: 'Notas', key: 'notes', placeholder: 'Observaciones...' },
                ] as const).map(f => (
                  <div key={f.key}>
                    <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>{f.label}</label>
                    <input
                      type="text"
                      data-testid={`customer-edit-${f.key}-input`}
                      value={editForm[f.key]}
                      onChange={e => setEditField(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      className="form-control"
                    />
                  </div>
                ))}
                {/* DNI / CUIT — la edición no lo conocía y no había forma de
                    corregir un documento sin volver a dar de alta al cliente. */}
                <div>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>DNI / CUIT</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <div className="seg-field">
                      {DOCUMENT_TYPES.map(t => (
                        <button
                          key={t}
                          type="button"
                          className="seg-field-option"
                          data-testid={`customer-edit-document-type-${t}`}
                          aria-pressed={editForm.documentType === t}
                          onClick={() => setEditField('documentType', t)}
                        >
                          {t.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      data-testid="customer-edit-document-input"
                      value={editForm.document}
                      onChange={e => setEditField('document', e.target.value)}
                      placeholder={editForm.documentType === 'dni' ? 'Ej: 30.123.456' : 'Ej: 20-30123456-7'}
                      className="form-control"
                      style={{ flex: 1 }}
                    />
                  </div>
                </div>
                <div>
                  <label className="label-caps" style={{ display: 'block', marginBottom: '0.5rem' }}>Tipo de cliente</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {CUSTOMER_TYPES.map(tipo => (
                      <button key={tipo} type="button"
                        data-testid={`customer-edit-type-${tipo}`}
                        aria-pressed={editForm.customerType === tipo}
                        onClick={() => setEditCustomerType(tipo)}
                        style={{ flex: 1, padding: '0.625rem', borderRadius: '0.5rem', cursor: 'pointer', fontSize: '0.85rem', fontWeight: editForm.customerType === tipo ? 700 : 400,
                          border: `2px solid ${editForm.customerType === tipo ? tipo === 'mayorista' ? 'rgba(99,102,241,0.5)' : 'rgba(34,197,94,0.4)' : 'rgba(255,255,255,0.08)'}`,
                          background: editForm.customerType === tipo ? tipo === 'mayorista' ? 'rgba(99,102,241,0.12)' : 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.03)',
                          color: editForm.customerType === tipo ? tipo === 'mayorista' ? '#c7d2fe' : '#4ade80' : 'var(--text-muted)',
                        }}>
                        {tipo === 'mayorista' ? 'Mayorista' : 'Minorista'}
                      </button>
                    ))}
                  </div>
                  {editForm.customerType === 'mayorista' && (
                    <>
                      <div style={{ marginTop: '0.875rem' }}>
                        <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Razón social *</label>
                        <input
                          type="text"
                          data-testid="customer-edit-business-name-input"
                          value={editForm.businessName}
                          onChange={e => setEditField('businessName', e.target.value)}
                          aria-invalid={Boolean(editErrors.businessName)}
                          placeholder="Nombre fiscal de la empresa"
                          className="form-control"
                        />
                        {editErrors.businessName && (
                          <p className="body-sm" role="alert" style={{ margin: '0.35rem 0 0', color: 'var(--danger, #f87171)' }}>
                            {editErrors.businessName}
                          </p>
                        )}
                      </div>
                      <div style={{ marginTop: '0.875rem' }}>
                        <label className="label-caps" style={{ display: 'block', marginBottom: '0.375rem' }}>Persona de contacto</label>
                        <input
                          type="text"
                          data-testid="customer-edit-contact-person-input"
                          value={editForm.contactPerson}
                          onChange={e => setEditField('contactPerson', e.target.value)}
                          className="form-control"
                        />
                      </div>
                      <p className="body-sm" style={{ margin: '0.35rem 0 0', color: 'var(--accent-primary)' }}>
                        Se usarán precios mayoristas automáticamente al cobrarle
                      </p>
                    </>
                  )}
                </div>
                {editError && <div className="alert-inline alert-error">{editError}</div>}
              </div>
            </div>
            <div className="modal-ftr">
              <button onClick={() => setEditingCustomer(null)} className="btn btn-ghost">Cancelar</button>
              <button
                onClick={handleEditSave}
                data-testid="customer-edit-save-button"
                disabled={editLoading || Object.keys(editErrors).length > 0}
                className="btn btn-primary btn-lift"
              >
                {editLoading ? <><Loader2 size={15} style={{ animation: 'tr-spin 1s linear infinite' }} /> Guardando...</> : 'Guardar cambios'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Confirmar Eliminación ──────────────────────── */}
      {deletingCustomer && (
        <div className="modal-overlay-dark" onClick={() => setDeletingCustomer(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-hdr">
              <h3>Eliminar cliente</h3>
              <CloseButton onClick={() => setDeletingCustomer(null)} />
            </div>
            <div className="modal-body-scroll">
              <p className="body-md" style={{ marginBottom: '0.5rem' }}>
                Se eliminará a <strong style={{ color: 'var(--text-primary)' }}>{deletingCustomer.name}</strong> permanentemente.
              </p>
              <p className="body-sm">Esta acción no se puede deshacer.</p>
              {deleteError && <div className="alert-inline alert-error" style={{ marginTop: '0.75rem' }}>{deleteError}</div>}
            </div>
            <div className="modal-ftr">
              <button onClick={() => setDeletingCustomer(null)} className="btn btn-ghost">Cancelar</button>
              <button onClick={handleDeleteConfirm} disabled={deleteLoading} className="btn btn-danger btn-lift">
                {deleteLoading ? <><Loader2 size={14} style={{ animation: 'tr-spin 1s linear infinite' }} /> Eliminando...</> : <><Trash2 size={14} /> Sí, eliminar</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
