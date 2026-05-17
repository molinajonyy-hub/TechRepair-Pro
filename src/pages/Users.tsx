import { useState } from 'react'
import { Plus, Shield, Mail, Edit, Trash2, CheckCircle } from 'lucide-react'

const mockUsers = [
  { id: '1', name: 'Admin Principal', email: 'admin@techrepair.com', role: 'admin', active: true },
  { id: '2', name: 'Técnico A', email: 'tecnicoa@techrepair.com', role: 'technician', active: true },
  { id: '3', name: 'Técnico B', email: 'tecnicob@techrepair.com', role: 'technician', active: true },
  { id: '4', name: 'Recepcionista', email: 'recepcion@techrepair.com', role: 'receptionist', active: false },
]

const roleLabels: Record<string, string> = {
  admin: 'Administrador',
  technician: 'Técnico',
  receptionist: 'Recepcionista',
}

export function Users() {
  const [users] = useState(mockUsers)

  return (
    <div>
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon">
            <Shield size={22} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div>
            <h1 className="page-hdr-title">Usuarios</h1>
            <p className="page-hdr-subtitle">Gestiona usuarios y permisos del sistema</p>
          </div>
        </div>
        <div className="page-hdr-right">
          <button className="btn btn-primary btn-lift">
            <Plus size={16} /> Nuevo Usuario
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="label-caps">Usuario</th>
              <th className="label-caps">Email</th>
              <th className="label-caps">Rol</th>
              <th className="label-caps">Estado</th>
              <th className="label-caps" style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%',
                      background: 'var(--accent-primary-subtle)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.72rem', fontWeight: 700, color: 'var(--accent-primary)',
                      flexShrink: 0,
                    }}>
                      {user.name.split(' ').map(n => n[0]).join('')}
                    </div>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{user.name}</span>
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
                    <Mail size={14} style={{ color: 'var(--text-subtle)' }} />
                    {user.email}
                  </div>
                </td>
                <td>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                    <Shield size={13} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                    {roleLabels[user.role]}
                  </span>
                </td>
                <td>
                  {user.active
                    ? <span className="badge badge-success"><CheckCircle size={11} /> Activo</span>
                    : <span className="badge badge-neutral">Inactivo</span>
                  }
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div style={{ display: 'flex', gap: '0.375rem', justifyContent: 'flex-end' }}>
                    <button className="icon-btn icon-btn-violet" aria-label="Editar">
                      <Edit size={15} />
                    </button>
                    <button className="icon-btn icon-btn-danger" aria-label="Eliminar">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
