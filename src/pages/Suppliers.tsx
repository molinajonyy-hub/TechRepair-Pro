import { useState, useEffect, useMemo } from 'react'
import { Plus, Search, Truck, Phone, Mail, Trash2, RefreshCw } from 'lucide-react'
import { suppliersService, Supplier } from '../services/suppliersService'
import { useAuth } from '../contexts/AuthContext'
import { smartSearch } from '../utils/searchUtils'

export function Suppliers() {
  const { businessId, user } = useAuth()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [formData, setFormData] = useState({ name: '', address: '', phone: '', email: '' })
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (businessId) loadSuppliers()
    else { setSuppliers([]); setLoading(false) }
  }, [businessId])

  const filtered = useMemo(() =>
    smartSearch(suppliers, searchTerm, [
      { getValue: s => s.name,    weight: 2 },
      { getValue: s => s.email },
      { getValue: s => s.phone },
      { getValue: s => s.address },
    ]),
    [suppliers, searchTerm]
  )

  const loadSuppliers = async () => {
    if (!businessId) return
    try {
      const data = await suppliersService.getAllSuppliers(businessId)
      setSuppliers(data)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminás este proveedor?')) return
    try {
      await suppliersService.deactivateSupplier(id, businessId || '')
      await loadSuppliers()
    } catch { alert('Error al eliminar proveedor') }
  }

  const handleCreate = async () => {
    if (!formData.name.trim()) { alert('El nombre es requerido'); return }
    if (!businessId || !user?.id) return
    setCreating(true)
    try {
      await suppliersService.createSupplier({
        name: formData.name.trim(), address: formData.address.trim(),
        phone: formData.phone.trim(), email: formData.email.trim(),
        business_id: businessId, active: true,
      }, businessId, user.id)
      setShowModal(false)
      setFormData({ name: '', address: '', phone: '', email: '' })
      await loadSuppliers()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error desconocido'
      alert(`Error al crear proveedor: ${msg}`)
    } finally {
      setCreating(false)
    }
  }

  if (loading) {
    return (
      <div className="page-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <RefreshCw className="animate-spin" size={32} style={{ color: '#6366f1' }} />
      </div>
    )
  }

  return (
    <div className="page-shell">
      {/* ── Encabezado ── */}
      <div className="page-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div className="stat-icon" style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)' }}>
            <Truck size={20} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 className="page-title">Proveedores</h1>
            <p className="page-subtitle">Gestioná proveedores y sus contactos</p>
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          <Plus size={16} /> Nuevo Proveedor
        </button>
      </div>

      {/* ── Buscador ── */}
      <div className="filter-bar">
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-subtle)', pointerEvents: 'none' }} />
          <input
            type="text"
            className="form-control"
            placeholder="Buscar por nombre, email, teléfono o dirección..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ paddingLeft: '2.5rem' }}
          />
        </div>
      </div>

      {/* ── Tabla ── */}
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Proveedor</th>
              <th>Dirección</th>
              <th>Contacto</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-subtle)' }}>
                  {searchTerm ? `Sin resultados para "${searchTerm}"` : 'No hay proveedores registrados'}
                </td>
              </tr>
            )}
            {filtered.map(s => (
              <tr key={s.id}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                    <Truck size={15} style={{ color: '#818cf8', flexShrink: 0 }} />
                    <span style={{ fontWeight: 600 }}>{s.name}</span>
                    {!s.active && <span className="badge badge-error">Inactivo</span>}
                  </div>
                </td>
                <td style={{ color: 'var(--text-secondary)' }}>{s.address || '—'}</td>
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                      <Phone size={12} /> {s.phone || '—'}
                    </span>
                    <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                      <Mail size={12} /> {s.email || '—'}
                    </span>
                  </div>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(s.id)}>
                    <Trash2 size={14} style={{ color: 'var(--color-error)' }} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Modal Nuevo Proveedor ── */}
      {showModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowModal(false) }}>
          <div className="modal-content" style={{ maxWidth: '480px' }}>
            <div className="modal-header">
              <h2 className="modal-title">Nuevo Proveedor</h2>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {(['name','address','phone','email'] as const).map(field => (
                <div key={field}>
                  <label className="form-label">
                    {field === 'name' ? 'Nombre *' : field === 'address' ? 'Dirección' : field === 'phone' ? 'Teléfono' : 'Email'}
                  </label>
                  <input
                    type={field === 'email' ? 'email' : 'text'}
                    className="form-control"
                    value={formData[field]}
                    onChange={e => setFormData({ ...formData, [field]: e.target.value })}
                    placeholder={field === 'name' ? 'Nombre del proveedor' : undefined}
                    onKeyDown={field === 'email' ? e => { if (e.key === 'Enter') handleCreate() } : undefined}
                  />
                </div>
              ))}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>
                {creating ? 'Creando...' : 'Crear Proveedor'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
