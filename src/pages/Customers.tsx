import { useEffect, useMemo, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Search, Eye, Phone, Mail, Users, Download, Upload, Pencil, Trash2, Loader2 } from 'lucide-react'
import { CloseButton } from '../components/ui/CloseButton'
import { customersService, ordersService } from '../services/api'
import { useLoading } from '../contexts/LoadingContext'
import { ModalImportExcel } from '../components/ModalImportExcel'
import { ExcelService, ExcelRow } from '../services/excelService'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

type CustomerSummary = {
  id: string
  name: string
  phone?: string
  email?: string
}

type CustomerStats = {
  orders: number
  total: number
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
  const [orders, setOrders] = useState<any[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showImportModal, setShowImportModal] = useState(false)
  const { showLoading, hideLoading } = useLoading()

  // ── Editar cliente ───────────────────────────────────────────
  const [editingCustomer, setEditingCustomer] = useState<any | null>(null)
  const [editForm, setEditForm] = useState({ name: '', phone: '', email: '', address: '', notes: '', customer_type: 'minorista' as 'minorista' | 'mayorista' })
  const [editLoading, setEditLoading] = useState(false)
  const [editError, setEditError] = useState('')

  const openEdit = (customer: CustomerSummary) => {
    setEditingCustomer(customer)
    setEditForm({
      name: customer.name || '',
      phone: (customer as any).phone || '',
      email: customer.email || '',
      address: (customer as any).address || '',
      notes: (customer as any).notes || '',
      customer_type: (customer as any).customer_type || 'minorista',
    })
    setEditError('')
  }

  const handleEditSave = async () => {
    if (!editingCustomer) return
    if (!editForm.name.trim()) { setEditError('El nombre es obligatorio'); return }
    setEditLoading(true)
    setEditError('')
    try {
      await customersService.update(editingCustomer.id, {
        name: editForm.name.trim(),
        phone: editForm.phone.trim(),
        email: editForm.email.trim(),
        address: editForm.address.trim(),
        notes: editForm.notes.trim(),
        customer_type: editForm.customer_type,
      } as any)
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
        // Solo traer order_id y customer_id: query liviana para estadísticas
        supabase
          .from('orders')
          .select('id, customer_id, total_cost, amount_paid')
          .eq('business_id', businessId)
          .limit(2000),
      ])

      if (customersResult.status === 'rejected') {
        throw customersResult.reason
      }

      setCustomers((customersResult.value || []) as CustomerSummary[])

      if (ordersCountResult.status === 'fulfilled') {
        setOrders(ordersCountResult.value.data || [])
      } else {
        console.error('Error loading customer stats:', ordersCountResult.reason)
        setOrders([])
      }
    } catch (err: any) {
      setError(err.message || 'Error al cargar clientes')
    }
  }

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

      ExcelService.exportToExcel(exportData, 'clientes', 'Clientes')
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

  const handleDownloadTemplate = () => {
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

    ExcelService.createTemplate(headers, 'plantilla_clientes', exampleData)
  }


  const filteredCustomers = useMemo(() => {
    const normalizedQuery = debouncedSearch.trim().toLowerCase()

    if (!normalizedQuery) {
      return customers
    }

    return customers.filter((customer) =>
      [customer.name, customer.phone, customer.email]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedQuery))
    )
  }, [customers, searchTerm])

  const customerStats = useMemo(() => {
    return orders.reduce<Record<string, CustomerStats>>((stats, order) => {
      const customerId = order.customer?.id

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
      <div style={{ padding: '2rem' }}>
        <h1 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#ffffff', marginBottom: '1rem' }}>
          Clientes
        </h1>
        <div style={{ padding: '1.5rem', backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: '0.75rem' }}>
          <p style={{ color: '#f87171', marginBottom: '1rem' }}>Error al cargar clientes: {error}</p>
          <button onClick={() => void loadCustomers()} className="btn btn-outline">
            Reintentar
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '0.75rem',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.2))',
            border: '1px solid rgba(99,102,241,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
          }}>
            <Users size={22} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f8fafc' }}>Clientes</h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#475569' }}>Gestiona la base de datos de clientes</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button onClick={handleDownloadTemplate} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.5rem 0.875rem',
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            color: '#94a3b8', borderRadius: '0.5rem', cursor: 'pointer', fontWeight: 500, fontSize: '0.8rem'
          }}>
            <Download size={15} />
            Plantilla
          </button>
          <button onClick={handleExportCustomers} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.5rem 0.875rem',
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            color: '#94a3b8', borderRadius: '0.5rem', cursor: 'pointer', fontWeight: 500, fontSize: '0.8rem'
          }}>
            <Download size={15} />
            Exportar
          </button>
          <button onClick={() => setShowImportModal(true)} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.5rem 0.875rem',
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            color: '#94a3b8', borderRadius: '0.5rem', cursor: 'pointer', fontWeight: 500, fontSize: '0.8rem'
          }}>
            <Upload size={15} />
            Importar
          </button>
          <Link to="/customers/new" style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.625rem 1.25rem',
            background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
            border: 'none', color: '#ffffff', borderRadius: '0.625rem',
            cursor: 'pointer', fontWeight: 600, textDecoration: 'none',
            boxShadow: '0 4px 12px rgba(99,102,241,0.35)', fontSize: '0.875rem'
          }}>
            <Plus size={18} />
            Nuevo Cliente
          </Link>
        </div>
      </div>

      <div
        style={{
          marginBottom: '1.5rem',
          padding: '1rem',
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.75rem',
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
          <Search size={18} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
          <input
            type="text"
            placeholder="Buscar cliente..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '0.625rem 0.75rem 0.625rem 2.5rem',
              backgroundColor: 'rgba(15,23,42,0.8)',
              border: '1px solid rgba(51,65,85,0.6)',
              borderRadius: '0.5rem',
              color: '#f1f5f9',
              outline: 'none',
            }}
          />
        </div>
      </div>

      <div
        style={{
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.75rem',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>
                  Cliente
                </th>
                <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>
                  Contacto
                </th>
                <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>
                  Ordenes
                </th>
                <th style={{ padding: '1rem', textAlign: 'right', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>
                  Total
                </th>
                <th style={{ padding: '1rem', textAlign: 'right', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredCustomers.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    {customers.length === 0 ? (
                      <div style={{ padding: '4rem 2rem', textAlign: 'center' }}>
                        <div style={{
                          width: '64px',
                          height: '64px',
                          borderRadius: '50%',
                          backgroundColor: 'rgba(15,23,42,0.8)',
                          margin: '0 auto 1.5rem',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}>
                          <Users size={32} style={{ color: '#64748b' }} />
                        </div>
                        <h3 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#ffffff', marginBottom: '0.5rem' }}>
                          Todavía no tenés clientes
                        </h3>
                        <p style={{ color: '#94a3b8', fontSize: '0.9375rem', marginBottom: '1.5rem', maxWidth: '400px', margin: '0 auto 1.5rem' }}>
                          Comenzá agregando tu primer cliente para empezar a gestionar sus reparaciones.
                        </p>
                        <Link
                          to="/customers/new"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            padding: '0.75rem 1.5rem',
                            background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                            border: 'none',
                            color: '#ffffff',
                            borderRadius: '0.625rem',
                            cursor: 'pointer',
                            fontWeight: 600,
                            textDecoration: 'none',
                            fontSize: '0.875rem',
                            boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
                          }}
                        >
                          <Plus size={16} />
                          Crear Primer Cliente
                        </Link>
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
                        <p>No se encontraron clientes para "{searchTerm}"</p>
                      </div>
                    )}
                  </td>
                </tr>
              ) : (
                filteredCustomers.map((customer) => {
                  const stats = customerStats[customer.id] || { orders: 0, total: 0 }

                  return (
                    <tr key={customer.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <Link to={`/customers/${customer.id}`} style={{ color: '#818cf8', fontWeight: 500, textDecoration: 'none' }}>
                            {customer.name}
                          </Link>
                          {(customer as any).customer_type === 'mayorista' && (
                            <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.1rem 0.45rem', borderRadius: '9999px', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.35)', color: '#a5b4fc', whiteSpace: 'nowrap' }}>
                              MAYORISTA
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          <span style={{ fontSize: '0.875rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <Phone size={14} /> {customer.phone || 'Sin telefono'}
                          </span>
                          <span style={{ fontSize: '0.875rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <Mail size={14} /> {customer.email || 'Sin email'}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '1rem', color: '#94a3b8' }}>
                        {stats.orders}
                      </td>
                      <td style={{ padding: '1rem', textAlign: 'right', fontWeight: 600, color: '#ffffff' }}>
                        {formatCurrency(stats.total)}
                      </td>
                      <td style={{ padding: '1rem', textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                          <Link
                            to={`/customers/${customer.id}`}
                            title="Ver detalle"
                            style={{
                              padding: '0.5rem',
                              backgroundColor: 'rgba(255,255,255,0.05)',
                              border: '1px solid rgba(255,255,255,0.08)',
                              borderRadius: '0.375rem',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              textDecoration: 'none',
                            }}
                          >
                            <Eye size={16} style={{ color: '#94a3b8' }} />
                          </Link>
                          <button
                            title="Editar cliente"
                            onClick={() => openEdit(customer)}
                            style={{
                              padding: '0.5rem',
                              backgroundColor: 'rgba(99,102,241,0.08)',
                              border: '1px solid rgba(99,102,241,0.2)',
                              borderRadius: '0.375rem',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                            }}
                          >
                            <Pencil size={16} style={{ color: '#818cf8' }} />
                          </button>
                          <button
                            title="Eliminar cliente"
                            onClick={() => { setDeletingCustomer(customer); setDeleteError('') }}
                            style={{
                              padding: '0.5rem',
                              backgroundColor: 'rgba(248,113,113,0.08)',
                              border: '1px solid rgba(248,113,113,0.2)',
                              borderRadius: '0.375rem',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                            }}
                          >
                            <Trash2 size={16} style={{ color: '#f87171' }} />
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
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1100,
          background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
        }} onClick={() => setEditingCustomer(null)}>
          <div style={{
            background: '#0f1829', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '1rem', padding: '1.75rem', width: '100%', maxWidth: 480,
            boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h2 style={{ margin: 0, color: '#f8fafc', fontSize: '1.125rem', fontWeight: 700 }}>Editar Cliente</h2>
              <CloseButton onClick={() => setEditingCustomer(null)} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {[
                { label: 'Nombre *', key: 'name', placeholder: 'Nombre y apellido' },
                { label: 'Teléfono', key: 'phone', placeholder: 'Ej: 5493512345678' },
                { label: 'Email', key: 'email', placeholder: 'correo@ejemplo.com' },
                { label: 'Dirección', key: 'address', placeholder: 'Av. Corrientes 1234, CABA' },
                { label: 'Notas', key: 'notes', placeholder: 'Observaciones...' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8', display: 'block', marginBottom: '0.375rem' }}>{f.label}</label>
                  <input
                    type="text"
                    value={(editForm as any)[f.key]}
                    onChange={e => setEditForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    style={{
                      width: '100%', padding: '0.625rem 0.875rem', boxSizing: 'border-box',
                      background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(51,65,85,0.6)',
                      borderRadius: '0.5rem', color: '#f1f5f9', fontSize: '0.9rem', outline: 'none',
                    }}
                  />
                </div>
              ))}
            </div>

            {/* Tipo de cliente */}
            <div style={{ marginTop: '0.5rem' }}>
              <label style={{ fontSize: '0.8rem', color: '#94a3b8', display: 'block', marginBottom: '0.375rem' }}>Tipo de cliente</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {(['minorista', 'mayorista'] as const).map(tipo => (
                  <button key={tipo} type="button" onClick={() => setEditForm(prev => ({ ...prev, customer_type: tipo }))}
                    style={{ flex: 1, padding: '0.625rem', borderRadius: '0.5rem', border: `2px solid ${editForm.customer_type === tipo ? tipo === 'mayorista' ? 'rgba(99,102,241,0.5)' : 'rgba(34,197,94,0.4)' : 'rgba(255,255,255,0.08)'}`, background: editForm.customer_type === tipo ? tipo === 'mayorista' ? 'rgba(99,102,241,0.15)' : 'rgba(34,197,94,0.1)' : 'rgba(255,255,255,0.03)', color: editForm.customer_type === tipo ? tipo === 'mayorista' ? '#c7d2fe' : '#4ade80' : '#64748b', fontWeight: editForm.customer_type === tipo ? 700 : 400, fontSize: '0.85rem', cursor: 'pointer', textTransform: 'capitalize' }}>
                    {tipo === 'mayorista' ? '🏬 Mayorista' : '👤 Minorista'}
                  </button>
                ))}
              </div>
              {editForm.customer_type === 'mayorista' && (
                <p style={{ margin: '0.35rem 0 0', fontSize: '0.72rem', color: '#818cf8' }}>
                  Se usarán precios mayoristas automáticamente al cobrarle
                </p>
              )}
            </div>

            {editError && (
              <p style={{ color: '#f87171', fontSize: '0.85rem', marginTop: '0.75rem', marginBottom: 0 }}>{editError}</p>
            )}

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
              <button onClick={() => setEditingCustomer(null)} style={{
                flex: 1, padding: '0.75rem', borderRadius: '0.5rem', cursor: 'pointer',
                background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8', fontWeight: 500,
              }}>Cancelar</button>
              <button onClick={handleEditSave} disabled={editLoading} style={{
                flex: 1, padding: '0.75rem', borderRadius: '0.5rem', cursor: 'pointer',
                background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', border: 'none',
                color: '#fff', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                opacity: editLoading ? 0.7 : 1,
              }}>
                {editLoading ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                {editLoading ? 'Guardando...' : 'Guardar cambios'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Confirmar Eliminación ──────────────────────── */}
      {deletingCustomer && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1100,
          background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
        }} onClick={() => setDeletingCustomer(null)}>
          <div style={{
            background: '#0f1829', border: '1px solid rgba(248,113,113,0.2)',
            borderRadius: '1rem', padding: '1.75rem', width: '100%', maxWidth: 420,
            boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%', margin: '0 auto 1rem',
                background: 'rgba(248,113,113,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Trash2 size={24} color="#f87171" />
              </div>
              <h2 style={{ margin: '0 0 0.5rem', color: '#f8fafc', fontSize: '1.1rem', fontWeight: 700 }}>
                ¿Eliminar cliente?
              </h2>
              <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.9rem' }}>
                Se eliminará a <strong style={{ color: '#f1f5f9' }}>{deletingCustomer.name}</strong> permanentemente.
                Esta acción no se puede deshacer.
              </p>
            </div>

            {deleteError && (
              <p style={{ color: '#f87171', fontSize: '0.85rem', textAlign: 'center', marginBottom: '1rem' }}>{deleteError}</p>
            )}

            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button onClick={() => setDeletingCustomer(null)} style={{
                flex: 1, padding: '0.75rem', borderRadius: '0.5rem', cursor: 'pointer',
                background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8', fontWeight: 500,
              }}>Cancelar</button>
              <button onClick={handleDeleteConfirm} disabled={deleteLoading} style={{
                flex: 1, padding: '0.75rem', borderRadius: '0.5rem', cursor: 'pointer',
                background: '#ef4444', border: 'none', color: '#fff', fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                opacity: deleteLoading ? 0.7 : 1,
              }}>
                {deleteLoading ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                {deleteLoading ? 'Eliminando...' : 'Sí, eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
