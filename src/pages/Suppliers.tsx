import { useState, useEffect } from 'react'
import { Plus, Search, Truck, Phone, Mail, Edit, Trash2, RefreshCw } from 'lucide-react'
import { suppliersService, Supplier } from '../services/suppliersService'
import { useAuth } from '../contexts/AuthContext'

export function Suppliers() {
  const { businessId, user } = useAuth()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [filteredSuppliers, setFilteredSuppliers] = useState<Supplier[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    address: '',
    phone: '',
    email: ''
  })
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (businessId) {
      loadSuppliers()
      return
    }

    setSuppliers([])
    setFilteredSuppliers([])
    setLoading(false)
  }, [businessId])

  useEffect(() => {
    if (searchTerm) {
      const filtered = suppliers.filter(s => 
        s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.phone?.includes(searchTerm)
      )
      setFilteredSuppliers(filtered)
    } else {
      setFilteredSuppliers(suppliers)
    }
  }, [searchTerm, suppliers])

  const loadSuppliers = async () => {
    if (!businessId) {
      setSuppliers([])
      setFilteredSuppliers([])
      setLoading(false)
      return
    }

    try {
      const data = await suppliersService.getAllSuppliers(businessId)
      setSuppliers(data)
      setFilteredSuppliers(data)
    } catch (error) {
      console.error('Error loading suppliers:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (supplierId: string) => {
    if (!confirm('¿Estás seguro de eliminar este proveedor?')) return

    try {
      await suppliersService.deactivateSupplier(supplierId, businessId || '')
      await loadSuppliers()
    } catch (error) {
      console.error('Error deleting supplier:', error)
      alert('Error al eliminar proveedor')
    }
  }

  const handleCreate = async () => {
    if (!formData.name.trim()) {
      alert('El nombre del proveedor es requerido')
      return
    }

    if (!businessId || !user?.id) {
      alert('Error: No hay businessId o userId')
      return
    }

    setCreating(true)
    try {
      console.log('Creating supplier with:', {
        name: formData.name.trim(),
        address: formData.address.trim(),
        phone: formData.phone.trim(),
        email: formData.email.trim(),
        business_id: businessId,
        active: true
      })
      console.log('businessId:', businessId)
      console.log('userId:', user.id)

      await suppliersService.createSupplier({
        name: formData.name.trim(),
        address: formData.address.trim(),
        phone: formData.phone.trim(),
        email: formData.email.trim(),
        business_id: businessId,
        active: true
      }, businessId, user.id)
      setShowCreateModal(false)
      setFormData({
        name: '',
        address: '',
        phone: '',
        email: ''
      })
      await loadSuppliers()
    } catch (error) {
      console.error('Error creating supplier:', error)
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido'
      alert(`Error al crear proveedor: ${errorMessage}`)
    } finally {
      setCreating(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <RefreshCw className="animate-spin" size={32} style={{ color: '#6366f1' }} />
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
            <Truck size={22} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f8fafc' }}>Proveedores</h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#475569' }}>Gestiona proveedores y sus productos</p>
          </div>
        </div>
        <button onClick={() => setShowCreateModal(true)} style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          padding: '0.625rem 1.25rem',
          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
          border: 'none', color: '#ffffff', borderRadius: '0.625rem',
          cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem',
          boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
        }}>
          <Plus size={18} />
          Nuevo Proveedor
        </button>
      </div>

      <div style={{
        marginBottom: '1.5rem',
        padding: '1rem',
        backgroundColor: '#0f1829',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '0.75rem',
        display: 'flex',
        gap: '1rem',
        flexWrap: 'wrap'
      }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
          <Search size={18} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
          <input
            type="text"
            placeholder="Buscar proveedor..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '0.625rem 0.75rem 0.625rem 2.5rem',
              backgroundColor: 'rgba(15,23,42,0.8)',
              border: '1px solid rgba(51,65,85,0.6)',
              borderRadius: '0.5rem',
              color: '#f1f5f9',
              outline: 'none'
            }}
          />
        </div>
      </div>

      <div style={{
        backgroundColor: '#0f1829',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '0.75rem',
        overflow: 'hidden'
      }}>
        <div style={{ padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'left', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Proveedor
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'left', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Dirección
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'left', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Contacto
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'right', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredSuppliers.map((supplier) => (
                <tr key={supplier.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '1rem' }}>
                    <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <Truck size={16} style={{ color: '#4f46e5' }} />
                      <span style={{ color: '#ffffff' }}>{supplier.name}</span>
                      {!supplier.active && (
                        <span style={{ 
                          padding: '0.125rem 0.5rem', 
                          backgroundColor: 'rgba(239, 68, 68, 0.2)', 
                          color: '#f87171', 
                          borderRadius: '9999px', 
                          fontSize: '0.75rem' 
                        }}>
                          Inactivo
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: '1rem', color: '#94a3b8' }}>
                    {supplier.address || '-'}
                  </td>
                  <td style={{ padding: '1rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.875rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Phone size={14} /> {supplier.phone || '-'}
                      </span>
                      <span style={{ fontSize: '0.875rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Mail size={14} /> {supplier.email || '-'}
                      </span>
                    </div>
                  </td>
                  <td style={{ padding: '1rem', textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                      <button style={{
                        padding: '0.5rem',
                        backgroundColor: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: '0.375rem',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem'
                      }}>
                        <Edit size={16} style={{ color: '#94a3b8' }} />
                      </button>
                      <button
                        onClick={() => handleDelete(supplier.id)}
                        style={{
                          padding: '0.5rem',
                          backgroundColor: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          borderRadius: '0.375rem',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem'
                        }}
                      >
                        <Trash2 size={16} style={{ color: '#ef4444' }} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Supplier Modal */}
      {showCreateModal && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
          padding: '1rem'
        }}>
          <div style={{
            backgroundColor: '#0b1120',
            borderRadius: '1rem',
            border: '1px solid rgba(255,255,255,0.08)',
            width: '100%',
            maxWidth: '500px',
            padding: '1.5rem'
          }}>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#ffffff', marginBottom: '1.5rem' }}>
              Nuevo Proveedor
            </h2>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                Nombre *
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Nombre del proveedor"
                style={{
                  width: '100%',
                  padding: '0.625rem 0.875rem',
                  backgroundColor: 'rgba(15,23,42,0.8)',
                  border: '1px solid rgba(51,65,85,0.6)',
                  borderRadius: '0.5rem',
                  color: '#f1f5f9',
                  outline: 'none'
                }}
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                Dirección
              </label>
              <input
                type="text"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                placeholder="Dirección"
                style={{
                  width: '100%',
                  padding: '0.625rem 0.875rem',
                  backgroundColor: 'rgba(15,23,42,0.8)',
                  border: '1px solid rgba(51,65,85,0.6)',
                  borderRadius: '0.5rem',
                  color: '#f1f5f9',
                  outline: 'none'
                }}
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                Teléfono
              </label>
              <input
                type="text"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="Teléfono"
                style={{
                  width: '100%',
                  padding: '0.625rem 0.875rem',
                  backgroundColor: 'rgba(15,23,42,0.8)',
                  border: '1px solid rgba(51,65,85,0.6)',
                  borderRadius: '0.5rem',
                  color: '#f1f5f9',
                  outline: 'none'
                }}
              />
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                Email
              </label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="Email"
                style={{
                  width: '100%',
                  padding: '0.625rem 0.875rem',
                  backgroundColor: 'rgba(15,23,42,0.8)',
                  border: '1px solid rgba(51,65,85,0.6)',
                  borderRadius: '0.5rem',
                  color: '#f1f5f9',
                  outline: 'none'
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowCreateModal(false)}
                style={{
                  padding: '0.625rem 1.25rem',
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#94a3b8',
                  borderRadius: '0.625rem',
                  cursor: 'pointer',
                  fontWeight: 500
                }}
              >
                Cancelar
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                style={{
                  padding: '0.625rem 1.25rem',
                  background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.625rem',
                  cursor: creating ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                  boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
                  opacity: creating ? 0.5 : 1
                }}
              >
                {creating ? 'Creando...' : 'Crear Proveedor'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
