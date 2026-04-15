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
      <div style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <h1 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#ffffff' }}>
            Usuarios
          </h1>
          <button style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.625rem 1.25rem',
            backgroundColor: '#4f46e5',
            border: 'none',
            color: '#ffffff',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            fontWeight: 500
          }}>
            <Plus size={18} />
            Nuevo Usuario
          </button>
        </div>
        <p style={{ color: '#94a3b8' }}>
          Gestiona usuarios y permisos del sistema
        </p>
      </div>

      <div style={{
        backgroundColor: '#111827',
        border: '1px solid rgba(255,255,255,0.05)',
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
                  Usuario
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'left', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Email
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'left', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Rol
                </th>
                <th style={{ 
                  padding: '1rem', 
                  textAlign: 'left', 
                  fontSize: '0.875rem', 
                  fontWeight: 500, 
                  color: '#94a3b8' 
                }}>
                  Estado
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
              {users.map((user) => (
                <tr key={user.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{
                        width: '2rem',
                        height: '2rem',
                        borderRadius: '50%',
                        backgroundColor: '#4f46e5',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        color: '#ffffff'
                      }}>
                        {user.name.split(' ').map(n => n[0]).join('')}
                      </div>
                      <span style={{ fontWeight: 500, color: '#ffffff' }}>{user.name}</span>
                    </div>
                  </td>
                  <td style={{ padding: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Mail size={14} style={{ color: '#64748b' }} />
                      <span style={{ color: '#94a3b8' }}>{user.email}</span>
                    </div>
                  </td>
                  <td style={{ padding: '1rem' }}>
                    <span style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: '0.5rem',
                      fontSize: '0.875rem',
                      color: '#94a3b8'
                    }}>
                      <Shield size={14} style={{ color: '#4f46e5' }} />
                      {roleLabels[user.role]}
                    </span>
                  </td>
                  <td style={{ padding: '1rem' }}>
                    {user.active ? (
                      <span style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.25rem 0.75rem',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        color: '#34d399',
                        borderRadius: '9999px',
                        fontSize: '0.75rem',
                        fontWeight: 500
                      }}>
                        <CheckCircle size={12} />
                        Activo
                      </span>
                    ) : (
                      <span style={{
                        padding: '0.25rem 0.75rem',
                        backgroundColor: 'rgba(148, 163, 184, 0.1)',
                        color: '#94a3b8',
                        borderRadius: '9999px',
                        fontSize: '0.75rem',
                        fontWeight: 500
                      }}>
                        Inactivo
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '1rem', textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                      <button style={{
                        padding: '0.5rem',
                        backgroundColor: '#111827',
                        border: '1px solid rgba(255,255,255,0.05)',
                        borderRadius: '0.375rem',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem'
                      }}>
                        <Edit size={16} style={{ color: '#94a3b8' }} />
                      </button>
                      <button style={{
                        padding: '0.5rem',
                        backgroundColor: '#111827',
                        border: '1px solid rgba(255,255,255,0.05)',
                        borderRadius: '0.375rem',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem'
                      }}>
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
    </div>
  )
}
