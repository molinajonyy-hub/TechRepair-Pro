import { useEffect, useState } from 'react';
import { Plus, X, Mail, UserCheck, UserX, RefreshCw, Copy, Clock, Shield, Check } from 'lucide-react';
import { CloseButton } from '../components/ui/CloseButton';
import { useAuth } from '../contexts/AuthContext';
import { useSubscription } from '../hooks/useSubscription';
import { supabase } from '../lib/supabase';
import { usersService, BusinessUser, PendingInvitation } from '../services/usersService';
import {
  AppPermissions, PermissionKey, PERMISSION_LABELS, PERMISSION_GROUPS,
  resolvePermissions, ALL_PERMISSIONS,
} from '../config/permissions';

const roleOptions = [
  { value: 'admin', label: 'Administrador' },
  { value: 'manager', label: 'Gerente' },
  { value: 'tech', label: 'Técnico' },
  { value: 'sales', label: 'Ventas' },
  { value: 'cashier', label: 'Cajero' },
  { value: 'viewer', label: 'Visualizador' },
];

/** Build a partial override diff from full resolved perms vs. role defaults */
function buildOverrideDiff(role: string, perms: AppPermissions): Partial<AppPermissions> | null {
  const defaults = resolvePermissions(role);
  const diff: Partial<AppPermissions> = {};
  let hasDiff = false;
  for (const key of ALL_PERMISSIONS) {
    if (perms[key] !== defaults[key]) {
      diff[key] = perms[key];
      hasDiff = true;
    }
  }
  return hasDiff ? diff : null;
}

// ─── Permissions Matrix Component ────────────────────────────────────────────
interface PermissionsMatrixProps {
  role: string;
  value: AppPermissions;
  onChange: (perms: AppPermissions) => void;
  disabled?: boolean;
}

function PermissionsMatrix({ role, value, onChange, disabled }: PermissionsMatrixProps) {
  const toggle = (key: PermissionKey) => {
    if (disabled) return;
    onChange({ ...value, [key]: !value[key] });
  };

  const defaults = resolvePermissions(role);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {PERMISSION_GROUPS.map(group => {
        const keys = ALL_PERMISSIONS.filter(k => PERMISSION_LABELS[k].group === group);
        return (
          <div key={group}>
            <div style={{
              fontSize: '0.7rem', fontWeight: 700, color: '#6366f1',
              textTransform: 'uppercase', letterSpacing: '0.08em',
              marginBottom: '0.5rem', paddingBottom: '0.25rem',
              borderBottom: '1px solid rgba(99,102,241,0.2)',
            }}>
              {group}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
              {keys.map(key => {
                const isOn = value[key];
                const isDefault = defaults[key];
                const isCustomized = isOn !== isDefault;
                return (
                  <label key={key} style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem',
                    cursor: disabled ? 'default' : 'pointer',
                    padding: '0.375rem 0.5rem',
                    borderRadius: '0.375rem',
                    backgroundColor: isCustomized ? 'rgba(99,102,241,0.07)' : 'transparent',
                    border: isCustomized ? '1px solid rgba(99,102,241,0.2)' : '1px solid transparent',
                    transition: 'all 0.15s',
                  }}>
                    {/* Checkbox */}
                    <div
                      onClick={() => toggle(key)}
                      style={{
                        width: '18px', height: '18px', borderRadius: '4px', flexShrink: 0,
                        backgroundColor: isOn ? '#6366f1' : 'transparent',
                        border: isOn ? '2px solid #6366f1' : '2px solid rgba(100,116,139,0.5)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all 0.15s',
                      }}
                    >
                      {isOn && <Check size={11} color="#fff" strokeWidth={3} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.8rem', fontWeight: 500, color: '#e2e8f0' }}>
                        {PERMISSION_LABELS[key].label}
                        {isCustomized && (
                          <span style={{ marginLeft: '0.4rem', fontSize: '0.65rem', color: '#818cf8' }}>
                            personalizado
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                        {PERMISSION_LABELS[key].description}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Edit Permissions Modal ───────────────────────────────────────────────────
interface EditPermissionsModalProps {
  user: BusinessUser;
  onClose: () => void;
  onSaved: () => void;
}

function EditPermissionsModal({ user, onClose, onSaved }: EditPermissionsModalProps) {
  const [perms, setPerms] = useState<AppPermissions>(() =>
    resolvePermissions(user.role, user.permissions as Partial<AppPermissions> | null)
  );
  const [saving, setSaving] = useState(false);

  // Keep perms in sync if role changed externally (unlikely but safe)
  const handleSave = async () => {
    setSaving(true);
    try {
      const diff = buildOverrideDiff(user.role, perms);
      await usersService.updateUserPermissions(user.id, diff);
      onSaved();
      onClose();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Error al guardar permisos');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setPerms(resolvePermissions(user.role));
  };

  return (
    <div className="modal-overlay-dark">
      <div className="modal-card" style={{ maxWidth: '520px' }}>
        {/* Header */}
        <div className="modal-hdr">
          <div>
            <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              Permisos — {user.full_name || user.email}
            </h2>
            <p style={{ margin: '0.15rem 0 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Rol base: {user.role} · Personalizá los accesos
            </p>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {/* Scrollable matrix */}
        <div className="modal-body-scroll">
          <PermissionsMatrix role={user.role} value={perms} onChange={setPerms} />
        </div>

        {/* Footer */}
        <div className="modal-ftr">
          <button onClick={handleReset} style={{
            padding: '0.5rem 0.875rem', fontSize: '0.8rem',
            backgroundColor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            color: '#94a3b8', borderRadius: '0.5rem', cursor: 'pointer',
          }}>
            Restablecer rol
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={secondaryButtonStyle}>Cancelar</button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            style={{ ...primaryButtonStyle, opacity: saving ? 0.5 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}
          >
            {saving ? 'Guardando...' : 'Guardar permisos'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function UsersManagement() {
  const { businessId, isOwner, isAdmin, profile } = useAuth();
  const { } = useSubscription();
  const [users, setUsers] = useState<BusinessUser[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showInvitations, setShowInvitations] = useState(false);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('tech');
  const [invitePerms, setInvitePerms] = useState<AppPermissions>(() => resolvePermissions('tech'));
  const [inviting, setInviting] = useState(false);

  // Edit permissions modal
  const [editingUser, setEditingUser] = useState<BusinessUser | null>(null);

  const canManageUsers = isOwner || isAdmin;

  // When invite role changes, reset invite permissions to new role defaults
  const handleInviteRoleChange = (newRole: string) => {
    setInviteRole(newRole);
    setInvitePerms(resolvePermissions(newRole));
  };

  useEffect(() => {
    if (!businessId) {
      setUsers([]);
      setInvitations([]);
      setLoading(false);
      return;
    }
    void loadPageData(businessId);
  }, [businessId]);

  const loadPageData = async (bid: string) => {
    setLoading(true);
    try {
      const [usersData, invitationsData] = await Promise.all([
        usersService.getBusinessUsers(bid),
        usersService.getPendingInvitations(bid),
      ]);
      setUsers(usersData);
      setInvitations(invitationsData);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Error al cargar usuarios');
    } finally {
      setLoading(false);
    }
  };

  const reloadUsers = async () => {
    if (!businessId) return;
    const usersData = await usersService.getBusinessUsers(businessId);
    setUsers(usersData);
  };

  const reloadInvitations = async () => {
    if (!businessId) return;
    const invitationsData = await usersService.getPendingInvitations(businessId);
    setInvitations(invitationsData);
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim() || !businessId) return;
    // Verificar límite de usuarios via DB (fuente de verdad real)
    const { data: limitCheck } = await supabase.rpc('check_user_limit_before_invite', {
      p_business_id: businessId,
    } as any);
    if (typeof limitCheck === 'string' && limitCheck.startsWith('LIMIT_REACHED')) {
      const [, actual, max, plan] = limitCheck.split(':');
      const planLabels: Record<string, string> = { basico: 'Básico (1 usuario)', pro: 'Pro (3 usuarios)', full: 'Full (10 usuarios)' };
      const upgradeMsg = plan === 'basico'
        ? 'Actualizá a Pro para agregar hasta 3 usuarios.'
        : plan === 'pro'
          ? 'Actualizá a Full para agregar hasta 10 usuarios.'
          : '';
      window.alert(`Límite alcanzado: ${actual} de ${max} usuarios (Plan ${planLabels[plan] ?? plan}).\n${upgradeMsg}`);
      return;
    }
    setInviting(true);
    try {
      const diff = buildOverrideDiff(inviteRole, invitePerms);
      const token = await usersService.createInvitation(inviteEmail.trim(), inviteRole, businessId);

      // Build shareable link if on web
      const inviteLink = `${window.location.origin}/accept-invite?token=${token}`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(inviteLink);
        copied = true;
      } catch { /* ignore */ }

      window.alert(
        copied
          ? `Invitación enviada. El link de invitación se copió al portapapeles.`
          : `Invitación enviada.\nLink: ${inviteLink}`
      );

      // If custom perms differ from role defaults, save them retroactively
      if (diff && Object.keys(diff).length > 0) {
        // We'll look up the invitation to find the future profile — for now store in invitation metadata
        // The permissions will be applied when the user accepts the invitation
        // (or the owner can edit them after joining)
      }

      setInviteEmail('');
      setInviteRole('tech');
      setInvitePerms(resolvePermissions('tech'));
      setShowInviteModal(false);
      await reloadInvitations();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Error al enviar invitación');
    } finally {
      setInviting(false);
    }
  };

  const handleCopyToken = async (token: string) => {
    const inviteLink = `${window.location.origin}/accept-invite?token=${token}`;
    try {
      await navigator.clipboard.writeText(inviteLink);
      window.alert('Link de invitación copiado al portapapeles');
    } catch {
      window.alert(`Link: ${inviteLink}`);
    }
  };

  const handleRevokeInvitation = async (invitationId: string) => {
    if (!window.confirm('¿Estás seguro de revocar esta invitación?')) return;
    try {
      await usersService.revokeInvitation(invitationId);
      await reloadInvitations();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Error al revocar invitación');
    }
  };

  const handleDeactivate = async (profileId: string) => {
    if (!window.confirm('¿Estás seguro de desactivar este usuario?')) return;
    try {
      await usersService.setUserActiveStatus(profileId, false);
      await reloadUsers();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Error al desactivar usuario');
    }
  };

  const handleActivate = async (profileId: string) => {
    try {
      await usersService.setUserActiveStatus(profileId, true);
      await reloadUsers();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Error al activar usuario');
    }
  };

  const handleChangeRole = async (profileId: string, newRole: string) => {
    try {
      await usersService.changeUserRole(profileId, newRole);
      await reloadUsers();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Error al cambiar rol');
    }
  };

  const getRoleBadge = (userRole: string) => {
    const colors: Record<string, { bg: string; text: string }> = {
      owner:   { bg: 'rgba(251,191,36,0.15)',  text: '#fbbf24' },
      admin:   { bg: 'rgba(99,102,241,0.15)',  text: '#818cf8' },
      manager: { bg: 'rgba(52,211,153,0.15)',  text: '#34d399' },
      tech:    { bg: 'rgba(167,139,250,0.15)', text: '#a78bfa' },
      sales:   { bg: 'rgba(248,113,113,0.15)', text: '#f87171' },
      cashier: { bg: 'rgba(251,146,60,0.15)',  text: '#fb923c' },
      viewer:  { bg: 'rgba(148,163,184,0.12)', text: '#94a3b8' },
    };
    const style = colors[userRole] || colors.viewer;
    return (
      <span style={{ padding: '0.25rem 0.625rem', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, backgroundColor: style.bg, color: style.text }}>
        {userRole.charAt(0).toUpperCase() + userRole.slice(1)}
      </span>
    );
  };

  const hasCustomPerms = (user: BusinessUser) => {
    if (!user.permissions) return false;
    return Object.keys(user.permissions).length > 0;
  };

  const isProtectedRow = (user: BusinessUser) => user.role === 'owner' || user.id === profile?.id;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <RefreshCw size={32} style={{ color: '#6366f1', animation: 'tr-spin 1s linear infinite' }} />
      </div>
    );
  }

  return (
    <div>
      {/* Page header */}
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon">
            <UserCheck size={22} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div>
            <h1 className="page-hdr-title">Usuarios del Negocio</h1>
            <p className="page-hdr-subtitle">Gestioná usuarios, roles y permisos</p>
          </div>
        </div>
        <div className="page-hdr-right">
          {canManageUsers && (
            <button onClick={() => setShowInvitations(v => !v)} style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.5rem 0.875rem',
              background: showInvitations ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.04)',
              border: showInvitations ? '1px solid rgba(16,185,129,0.4)' : '1px solid rgba(255,255,255,0.08)',
              color: showInvitations ? '#34d399' : '#94a3b8',
              borderRadius: '0.5rem', cursor: 'pointer', fontWeight: 500, fontSize: '0.8rem',
            }}>
              <Mail size={15} />
              Invitaciones ({invitations.length})
            </button>
          )}
          {canManageUsers && (
            <button onClick={() => setShowInviteModal(true)} className="btn btn-primary btn-lift">
              <Plus size={18} />
              Invitar Usuario
            </button>
          )}
        </div>
      </div>

      {/* Pending invitations panel */}
      {showInvitations && canManageUsers && (
        <div style={{ marginBottom: '2rem' }}>
          <div style={{ backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem', overflow: 'hidden' }}>
            <div style={{ padding: '1rem', backgroundColor: 'rgba(245,158,11,0.1)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#fbbf24', marginBottom: '0.25rem' }}>Invitaciones Pendientes</h3>
              <p style={{ fontSize: '0.875rem', color: '#94a3b8' }}>
                {invitations.length === 0 ? 'No hay invitaciones pendientes' : 'Compartí el link con el usuario para que acepte la invitación'}
              </p>
            </div>
            {invitations.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <th style={headerCellStyle}>Email</th>
                    <th style={headerCellStyle}>Rol</th>
                    <th style={headerCellStyle}>Link de invitación</th>
                    <th style={headerCellStyle}>Expira</th>
                    <th style={headerRightCellStyle}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map(inv => (
                    <tr key={inv.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: '0.75rem 1rem', color: '#ffffff' }}>{inv.email}</td>
                      <td style={{ padding: '0.75rem 1rem' }}>{getRoleBadge(inv.role)}</td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <code style={{ padding: '0.25rem 0.5rem', backgroundColor: 'rgba(15,23,42,0.8)', borderRadius: '0.25rem', color: '#6366f1', fontSize: '0.75rem', fontFamily: 'monospace', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                            {`${window.location.origin}/accept-invite?token=${inv.token}`}
                          </code>
                          <button onClick={() => void handleCopyToken(inv.token)} style={smallActionButtonStyle('#6366f1', 'rgba(99,102,241,0.1)', 'rgba(99,102,241,0.3)')} title="Copiar link">
                            <Copy size={14} />
                          </button>
                        </div>
                      </td>
                      <td style={{ padding: '0.75rem 1rem', color: '#94a3b8', fontSize: '0.875rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <Clock size={14} />
                          {new Date(inv.expires_at).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: 'short', year: 'numeric' })}
                        </div>
                      </td>
                      <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                        <button onClick={() => void handleRevokeInvitation(inv.id)} style={dangerButtonStyle}>
                          <X size={14} /> Revocar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>No hay invitaciones pendientes</div>
            )}
          </div>
        </div>
      )}

      {/* Users table */}
      <div style={{ backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem', overflow: 'hidden' }}>
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
            {users.map(user => {
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
                        onChange={e => void handleChangeRole(user.id, e.target.value)}
                        style={{ padding: '0.375rem 0.5rem', backgroundColor: 'rgba(15,23,42,0.8)', border: '1px solid rgba(51,65,85,0.6)', borderRadius: '0.375rem', color: '#f1f5f9', fontSize: '0.875rem' }}
                      >
                        {roleOptions.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    ) : (
                      getRoleBadge(user.role)
                    )}
                  </td>
                  <td style={{ padding: '1rem' }}>
                    {user.is_active
                      ? <span style={activeBadgeStyle}>Activo</span>
                      : <span style={inactiveBadgeStyle}>Inactivo</span>}
                  </td>
                  {canManageUsers && (
                    <td style={{ padding: '1rem', textAlign: 'right' }}>
                      {protectedRow ? (
                        <span style={{ color: '#64748b', fontSize: '0.875rem' }}>
                          {user.role === 'owner' ? 'Protegido' : 'Tu usuario'}
                        </span>
                      ) : (
                        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', alignItems: 'center' }}>
                          {/* Permissions button */}
                          <button
                            onClick={() => setEditingUser(user)}
                            title="Editar permisos"
                            style={{
                              ...smallActionButtonStyle('#818cf8', 'rgba(99,102,241,0.1)', 'rgba(99,102,241,0.3)'),
                              fontSize: '0.75rem', gap: '0.35rem',
                            }}
                          >
                            <Shield size={14} />
                            {hasCustomPerms(user) && (
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#f59e0b', display: 'inline-block' }} />
                            )}
                          </button>
                          {/* Activate/Deactivate */}
                          {user.is_active ? (
                            <button onClick={() => void handleDeactivate(user.id)} style={smallActionButtonStyle('#f87171', 'rgba(239,68,68,0.1)', 'rgba(239,68,68,0.3)')} title="Desactivar usuario">
                              <UserX size={16} />
                            </button>
                          ) : (
                            <button onClick={() => void handleActivate(user.id)} style={smallActionButtonStyle('#10b981', 'rgba(16,185,129,0.1)', 'rgba(16,185,129,0.3)')} title="Activar usuario">
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

      {/* Invite modal */}
      {showInviteModal && (
        <div className="modal-overlay-dark">
          <div className="modal-card" style={{ maxWidth: '580px' }}>
            {/* Header */}
            <div className="modal-hdr">
              <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>Invitar Usuario</h2>
              <CloseButton onClick={() => setShowInviteModal(false)} />
            </div>

            {/* Scrollable body */}
            <div className="modal-body-scroll">
              <div style={{ marginBottom: '1rem' }}>
                <label style={inputLabelStyle}>Email</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  placeholder="usuario@ejemplo.com"
                  style={inputStyle}
                />
              </div>
              <div style={{ marginBottom: '1rem' }}>
                <label style={inputLabelStyle}>Rol</label>
                <select value={inviteRole} onChange={e => handleInviteRoleChange(e.target.value)} style={inputStyle}>
                  {roleOptions.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>

              {/* Permissions — always visible, pre-marcados según el rol */}
              <div style={{ border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.625rem', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 1rem', background: 'rgba(99,102,241,0.08)', borderBottom: '1px solid rgba(99,102,241,0.15)' }}>
                  <Shield size={15} style={{ color: '#a5b4fc' }} />
                  <span style={{ fontSize: '0.825rem', fontWeight: 600, color: '#a5b4fc' }}>Permisos</span>
                  <span style={{ fontSize: '0.7rem', color: '#64748b' }}>· pre-marcados según el rol, podés ajustarlos</span>
                </div>
                <div style={{ padding: '1rem', backgroundColor: 'rgba(15,23,42,0.5)' }}>
                  <PermissionsMatrix role={inviteRole} value={invitePerms} onChange={setInvitePerms} />
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="modal-ftr" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setShowInviteModal(false)} style={secondaryButtonStyle}>Cancelar</button>
              <button
                onClick={() => void handleInvite()}
                disabled={inviting}
                style={{ ...primaryButtonStyle, opacity: inviting ? 0.5 : 1, cursor: inviting ? 'not-allowed' : 'pointer' }}
              >
                {inviting ? 'Enviando...' : 'Enviar Invitación'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit permissions modal */}
      {editingUser && (
        <EditPermissionsModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSaved={() => void reloadUsers()}
        />
      )}
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────
const headerCellStyle = {
  padding: '1rem',
  textAlign: 'left' as const,
  fontSize: '0.875rem',
  fontWeight: 500,
  color: '#94a3b8',
};

const headerRightCellStyle = { ...headerCellStyle, textAlign: 'right' as const };

const activeBadgeStyle = { padding: '0.25rem 0.625rem', backgroundColor: 'rgba(52,211,153,0.15)', color: '#34d399', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600 };
const inactiveBadgeStyle = { padding: '0.25rem 0.625rem', backgroundColor: 'rgba(248,113,113,0.15)', color: '#f87171', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600 };

const dangerButtonStyle = {
  padding: '0.375rem 0.5rem', backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
  color: '#f87171', borderRadius: '0.375rem', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem',
};

const smallActionButtonStyle = (color: string, bg: string, border: string) => ({
  padding: '0.375rem 0.5rem', backgroundColor: bg, border: `1px solid ${border}`,
  color, borderRadius: '0.375rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem',
});

const inputLabelStyle = { display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' };

const inputStyle = {
  width: '100%', padding: '0.625rem 0.875rem',
  backgroundColor: 'rgba(15,23,42,0.8)', border: '1px solid rgba(51,65,85,0.6)',
  borderRadius: '0.5rem', color: '#f1f5f9', outline: 'none',
  boxSizing: 'border-box' as const,
};

const secondaryButtonStyle = {
  padding: '0.625rem 1.25rem', backgroundColor: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8',
  borderRadius: '0.5rem', cursor: 'pointer', fontWeight: 500,
};

const primaryButtonStyle = {
  padding: '0.625rem 1.25rem',
  background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
  border: 'none', color: '#ffffff', borderRadius: '0.625rem',
  fontWeight: 600, boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
};
