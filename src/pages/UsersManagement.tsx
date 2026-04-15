import { useEffect, useState } from 'react';
import { Plus, Mail, UserCheck, UserX, RefreshCw, Copy, X, Clock } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { usersService, BusinessUser, PendingInvitation } from '../services/usersService';

const roleOptions = [
  { value: 'admin', label: 'Administrador' },
  { value: 'manager', label: 'Gerente' },
  { value: 'tech', label: 'Técnico' },
  { value: 'sales', label: 'Ventas' },
  { value: 'cashier', label: 'Cajero' },
  { value: 'viewer', label: 'Visualizador' },
];

export function UsersManagement() {
  const { businessId, isOwner, isAdmin, profile } = useAuth();
  const [users, setUsers] = useState<BusinessUser[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('tech');
  const [inviting, setInviting] = useState(false);
  const [showInvitations, setShowInvitations] = useState(false);

  const canManageUsers = isOwner || isAdmin;

  useEffect(() => {
    if (!businessId) {
      setUsers([]);
      setInvitations([]);
      setLoading(false);
      return;
    }

    void loadPageData(businessId);
  }, [businessId]);

  const loadPageData = async (currentBusinessId: string) => {
    setLoading(true);

    try {
      const [usersData, invitationsData] = await Promise.all([
        usersService.getBusinessUsers(currentBusinessId),
        usersService.getPendingInvitations(currentBusinessId),
      ]);

      setUsers(usersData);
      setInvitations(invitationsData);
    } catch (error) {
      console.error('Error loading users page:', error);
      window.alert(error instanceof Error ? error.message : 'Error al cargar usuarios');
    } finally {
      setLoading(false);
    }
  };

  const reloadUsers = async () => {
    if (!businessId) {
      return;
    }

    const usersData = await usersService.getBusinessUsers(businessId);
    setUsers(usersData);
  };

  const reloadInvitations = async () => {
    if (!businessId) {
      return;
    }

    const invitationsData = await usersService.getPendingInvitations(businessId);
    setInvitations(invitationsData);
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim() || !businessId) {
      return;
    }

    setInviting(true);

    try {
      const token = await usersService.createInvitation(inviteEmail.trim(), inviteRole, businessId);
      let copied = false;

      try {
        await navigator.clipboard.writeText(token);
        copied = true;
      } catch {
        copied = false;
      }

      window.alert(
        copied
          ? 'Invitacion enviada. El token se copio al portapapeles.'
          : `Invitacion enviada. Token: ${token}`
      );
      setInviteEmail('');
      setInviteRole('tech');
      setShowInviteModal(false);
      await reloadInvitations();
    } catch (error) {
      console.error('Error inviting user:', error);
      window.alert(error instanceof Error ? error.message : 'Error al enviar invitacion');
    } finally {
      setInviting(false);
    }
  };

  const handleCopyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      window.alert('Token copiado al portapapeles');
    } catch {
      window.alert('No se pudo copiar el token');
    }
  };

  const handleRevokeInvitation = async (invitationId: string) => {
    if (!window.confirm('Estas seguro de revocar esta invitacion?')) {
      return;
    }

    try {
      await usersService.revokeInvitation(invitationId);
      await reloadInvitations();
    } catch (error) {
      console.error('Error revoking invitation:', error);
      window.alert(error instanceof Error ? error.message : 'Error al revocar invitacion');
    }
  };

  const handleDeactivate = async (profileId: string) => {
    if (!window.confirm('Estas seguro de desactivar este usuario?')) {
      return;
    }

    try {
      await usersService.setUserActiveStatus(profileId, false);
      await reloadUsers();
    } catch (error) {
      console.error('Error deactivating user:', error);
      window.alert(error instanceof Error ? error.message : 'Error al desactivar usuario');
    }
  };

  const handleActivate = async (profileId: string) => {
    try {
      await usersService.setUserActiveStatus(profileId, true);
      await reloadUsers();
    } catch (error) {
      console.error('Error activating user:', error);
      window.alert(error instanceof Error ? error.message : 'Error al activar usuario');
    }
  };

  const handleChangeRole = async (profileId: string, newRole: string) => {
    try {
      await usersService.changeUserRole(profileId, newRole);
      await reloadUsers();
    } catch (error) {
      console.error('Error changing role:', error);
      window.alert(error instanceof Error ? error.message : 'Error al cambiar rol');
    }
  };

  const getRoleBadge = (userRole: string) => {
    const colors: Record<string, { bg: string; text: string }> = {
      owner: { bg: '#fef3c7', text: '#92400e' },
      admin: { bg: '#dbeafe', text: '#1e40af' },
      manager: { bg: '#d1fae5', text: '#065f46' },
      tech: { bg: '#f3e8ff', text: '#6b21a8' },
      sales: { bg: '#fce7f3', text: '#9d174d' },
      cashier: { bg: '#ffedd5', text: '#9a3412' },
      viewer: { bg: '#f1f5f9', text: '#475569' },
    };

    const style = colors[userRole] || colors.viewer;

    return (
      <span
        style={{
          padding: '0.25rem 0.625rem',
          borderRadius: '9999px',
          fontSize: '0.75rem',
          fontWeight: 500,
          ...style,
        }}
      >
        {userRole.charAt(0).toUpperCase() + userRole.slice(1)}
      </span>
    );
  };

  const isProtectedRow = (user: BusinessUser) => user.role === 'owner' || user.id === profile?.id;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <RefreshCw className="animate-spin" size={32} style={{ color: '#6366f1' }} />
      </div>
    );
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
            <UserCheck size={22} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f8fafc' }}>Usuarios del Negocio</h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#475569' }}>Gestiona los usuarios y roles de tu negocio</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {canManageUsers && (
            <button onClick={() => setShowInvitations((current) => !current)} style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.5rem 0.875rem',
              background: showInvitations ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.04)',
              border: showInvitations ? '1px solid rgba(16,185,129,0.4)' : '1px solid rgba(255,255,255,0.08)',
              color: showInvitations ? '#34d399' : '#94a3b8',
              borderRadius: '0.5rem', cursor: 'pointer', fontWeight: 500, fontSize: '0.8rem'
            }}>
              <Mail size={15} />
              Invitaciones ({invitations.length})
            </button>
          )}
          {canManageUsers && (
            <button onClick={() => setShowInviteModal(true)} style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.625rem 1.25rem',
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              border: 'none', color: '#ffffff', borderRadius: '0.625rem',
              cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem',
              boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
            }}>
              <Plus size={18} />
              Invitar Usuario
            </button>
          )}
        </div>
      </div>

      {showInvitations && canManageUsers && (
        <div style={{ marginBottom: '2rem' }}>
          <div
            style={{
              backgroundColor: '#0f1829',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '0.75rem',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '1rem',
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#fbbf24', marginBottom: '0.25rem' }}>
                Invitaciones Pendientes
              </h3>
              <p style={{ fontSize: '0.875rem', color: '#94a3b8' }}>
                {invitations.length === 0
                  ? 'No hay invitaciones pendientes'
                  : 'Comparte el token con el usuario para que pueda aceptar la invitacion'}
              </p>
            </div>

            {invitations.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <th style={headerCellStyle}>Email</th>
                    <th style={headerCellStyle}>Rol</th>
                    <th style={headerCellStyle}>Token</th>
                    <th style={headerCellStyle}>Expira</th>
                    <th style={headerRightCellStyle}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => (
                    <tr key={invitation.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: '0.75rem 1rem', color: '#ffffff' }}>{invitation.email}</td>
                      <td style={{ padding: '0.75rem 1rem' }}>{getRoleBadge(invitation.role)}</td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <code
                            style={{
                              padding: '0.25rem 0.5rem',
                              backgroundColor: 'rgba(15,23,42,0.8)',
                              borderRadius: '0.25rem',
                              color: '#6366f1',
                              fontSize: '0.875rem',
                              fontFamily: 'monospace',
                              wordBreak: 'break-all',
                            }}
                          >
                            {invitation.token}
                          </code>
                          <button
                            onClick={() => void handleCopyToken(invitation.token)}
                            style={smallActionButtonStyle('#6366f1', 'rgba(99, 102, 241, 0.1)', 'rgba(99, 102, 241, 0.3)')}
                            title="Copiar token"
                          >
                            <Copy size={14} />
                          </button>
                        </div>
                      </td>
                      <td style={{ padding: '0.75rem 1rem', color: '#94a3b8', fontSize: '0.875rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <Clock size={14} />
                          {new Date(invitation.expires_at).toLocaleDateString()}
                        </div>
                      </td>
                      <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                        <button
                          onClick={() => void handleRevokeInvitation(invitation.id)}
                          style={dangerButtonStyle}
                        >
                          <X size={14} />
                          Revocar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
                No hay invitaciones pendientes
              </div>
            )}
          </div>
        </div>
      )}

      <div
        style={{
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.75rem',
          overflow: 'hidden',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <th style={headerCellStyle}>Usuario</th>
              <th style={headerCellStyle}>Email</th>
              <th style={headerCellStyle}>Rol</th>
              <th style={headerCellStyle}>Estado</th>
              {canManageUsers && <th style={headerRightCellStyle}>Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const protectedRow = isProtectedRow(user);

              return (
                <tr key={user.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <td style={{ padding: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#ffffff' }}>
                      <UserCheck size={16} style={{ color: '#6366f1' }} />
                      <span>{user.full_name || 'Sin nombre'}</span>
                    </div>
                  </td>
                  <td style={{ padding: '1rem', color: '#94a3b8' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Mail size={14} style={{ color: '#64748b' }} />
                      {user.email || '-'}
                    </div>
                  </td>
                  <td style={{ padding: '1rem' }}>
                    {canManageUsers && !protectedRow ? (
                      <select
                        value={user.role}
                        onChange={(e) => void handleChangeRole(user.id, e.target.value)}
                        style={{
                          padding: '0.375rem 0.5rem',
                          backgroundColor: 'rgba(15,23,42,0.8)',
                          border: '1px solid rgba(51,65,85,0.6)',
                          borderRadius: '0.375rem',
                          color: '#f1f5f9',
                          fontSize: '0.875rem',
                        }}
                      >
                        {roleOptions.map((role) => (
                          <option key={role.value} value={role.value}>
                            {role.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      getRoleBadge(user.role)
                    )}
                  </td>
                  <td style={{ padding: '1rem' }}>
                    {user.is_active ? (
                      <span style={activeBadgeStyle}>Activo</span>
                    ) : (
                      <span style={inactiveBadgeStyle}>Inactivo</span>
                    )}
                  </td>
                  {canManageUsers && (
                    <td style={{ padding: '1rem', textAlign: 'right' }}>
                      {protectedRow ? (
                        <span style={{ color: '#64748b', fontSize: '0.875rem' }}>
                          {user.role === 'owner' ? 'Protegido' : 'Tu usuario'}
                        </span>
                      ) : (
                        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                          {user.is_active ? (
                            <button
                              onClick={() => void handleDeactivate(user.id)}
                              style={smallActionButtonStyle('#f87171', 'rgba(239, 68, 68, 0.1)', 'rgba(239, 68, 68, 0.3)')}
                              title="Desactivar usuario"
                            >
                              <UserX size={16} />
                            </button>
                          ) : (
                            <button
                              onClick={() => void handleActivate(user.id)}
                              style={smallActionButtonStyle('#10b981', 'rgba(16, 185, 129, 0.1)', 'rgba(16, 185, 129, 0.3)')}
                              title="Activar usuario"
                            >
                              <UserCheck size={16} />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showInviteModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            padding: '1rem',
          }}
        >
          <div
            style={{
              backgroundColor: '#0b1120',
              borderRadius: '1rem',
              border: '1px solid rgba(255,255,255,0.08)',
              width: '100%',
              maxWidth: '500px',
              padding: '1.5rem',
            }}
          >
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#ffffff', marginBottom: '1.5rem' }}>
              Invitar Usuario
            </h2>

            <div style={{ marginBottom: '1rem' }}>
              <label style={inputLabelStyle}>Email</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="usuario@ejemplo.com"
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={inputLabelStyle}>Rol</label>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                style={inputStyle}
              >
                {roleOptions.map((role) => (
                  <option key={role.value} value={role.value}>
                    {role.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowInviteModal(false)}
                style={secondaryButtonStyle}
              >
                Cancelar
              </button>
              <button
                onClick={() => void handleInvite()}
                disabled={inviting}
                style={{
                  ...primaryButtonStyle,
                  opacity: inviting ? 0.5 : 1,
                  cursor: inviting ? 'not-allowed' : 'pointer',
                }}
              >
                {inviting ? 'Enviando...' : 'Enviar Invitacion'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const headerCellStyle = {
  padding: '1rem',
  textAlign: 'left' as const,
  fontSize: '0.875rem',
  fontWeight: 500,
  color: '#94a3b8',
};

const headerRightCellStyle = {
  ...headerCellStyle,
  textAlign: 'right' as const,
};

const activeBadgeStyle = {
  padding: '0.25rem 0.625rem',
  backgroundColor: '#d1fae5',
  color: '#065f46',
  borderRadius: '9999px',
  fontSize: '0.75rem',
  fontWeight: 500,
};

const inactiveBadgeStyle = {
  padding: '0.25rem 0.625rem',
  backgroundColor: '#fee2e2',
  color: '#991b1b',
  borderRadius: '9999px',
  fontSize: '0.75rem',
  fontWeight: 500,
};

const dangerButtonStyle = {
  padding: '0.375rem 0.5rem',
  backgroundColor: 'rgba(239, 68, 68, 0.1)',
  border: '1px solid rgba(239, 68, 68, 0.3)',
  color: '#f87171',
  borderRadius: '0.375rem',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontSize: '0.875rem',
};

const smallActionButtonStyle = (color: string, backgroundColor: string, borderColor: string) => ({
  padding: '0.375rem 0.5rem',
  backgroundColor,
  border: `1px solid ${borderColor}`,
  color,
  borderRadius: '0.375rem',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
});

const inputLabelStyle = {
  display: 'block',
  fontSize: '0.875rem',
  color: '#94a3b8',
  marginBottom: '0.5rem',
};

const inputStyle = {
  width: '100%',
  padding: '0.625rem 0.875rem',
  backgroundColor: 'rgba(15,23,42,0.8)',
  border: '1px solid rgba(51,65,85,0.6)',
  borderRadius: '0.5rem',
  color: '#f1f5f9',
  outline: 'none',
};

const secondaryButtonStyle = {
  padding: '0.625rem 1.25rem',
  backgroundColor: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  color: '#94a3b8',
  borderRadius: '0.5rem',
  cursor: 'pointer',
  fontWeight: 500,
};

const primaryButtonStyle = {
  padding: '0.625rem 1.25rem',
  background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
  border: 'none',
  color: '#ffffff',
  borderRadius: '0.625rem',
  fontWeight: 600,
  boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
};
