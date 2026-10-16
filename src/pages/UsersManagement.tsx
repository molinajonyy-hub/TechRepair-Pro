import { useEffect, useRef, useState } from 'react';
import { Plus, X, Mail, UserCheck, UserX, RefreshCw, Copy, Clock, Shield, Check, Send } from 'lucide-react';
import { CloseButton } from '../components/ui/CloseButton';
import { useAuth } from '../contexts/AuthContext';
import { useSubscription } from '../hooks/useSubscription';
import { supabase } from '../lib/supabase';
import { invitationUrl } from '../lib/invitationLink';
import { usersService, BusinessUser } from '../services/usersService';
import { invitationsService, InvitationError, type Invitation } from '../services/invitationsService';
import { showToast } from '../utils/toast';
import {
  AppPermissions, PermissionKey, PERMISSION_LABELS, PERMISSION_GROUPS,
  resolvePermissions, ALL_PERMISSIONS, CONFIGURABLE_PERMISSIONS,
} from '../config/permissions';
import { hasAutomaticWholesaleAccess } from '../lib/permissions/wholesalePermissions';
import { accentCta, colors } from '../lib/tokens';
import { AppModal, OverflowMenu } from '../ui';

/**
 * `showToast` arma el mensaje con innerHTML. Un correo es texto que escribió una
 * persona (y la DB admite `<` o `"` en la parte local): se escapa antes de
 * mostrarlo. Nunca se interpola sin escapar.
 */
const textoSeguro = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const roleOptions = [
  { value: 'admin', label: 'Administrador' },
  { value: 'manager', label: 'Gerente' },
  { value: 'tech', label: 'Técnico' },
  { value: 'sales', label: 'Ventas' },
  { value: 'cashier', label: 'Cajero' },
  { value: 'viewer', label: 'Visualizador' },
];

/**
 * PRE-BETA-3A-2 — `wholesale` no se configura para owner/admin: su acceso a
 * Mayorista es automático (autoridad central), así que un override sería letra
 * muerta en la UI.
 */
function isLockedPermission(role: string, key: PermissionKey): boolean {
  return key === 'wholesale' && hasAutomaticWholesaleAccess(role);
}

/** Build a partial override diff from full resolved perms vs. role defaults */
function buildOverrideDiff(role: string, perms: AppPermissions): Partial<AppPermissions> | null {
  const defaults = resolvePermissions(role);
  const diff: Partial<AppPermissions> = {};
  let hasDiff = false;
  for (const key of ALL_PERMISSIONS) {
    // Un override heredado sobre una clave bloqueada se descarta al guardar.
    if (isLockedPermission(role, key)) continue;
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
    if (disabled || isLockedPermission(role, key)) return;
    onChange({ ...value, [key]: !value[key] });
  };

  const defaults = resolvePermissions(role);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {PERMISSION_GROUPS.map(group => {
        // P0-P6: la matriz sólo ofrece capacidades CONFIGURABLES. `Mi Guita`
        // queda fuera a propósito: está cerrado para la beta y su acceso interno
        // se decide por `system_admins`, server-side. Si el owner pudiera
        // tildarlo acá, se lo habilitaría a su equipo y la decisión de producto
        // sería letra muerta.
        const keys = CONFIGURABLE_PERMISSIONS.filter(k => PERMISSION_LABELS[k].group === group);
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
                const locked = isLockedPermission(role, key);
                const isOn = locked ? true : value[key];
                const isDefault = defaults[key];
                const isCustomized = !locked && isOn !== isDefault;
                return (
                  <label key={key} className="perm-toggle" style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem',
                    cursor: disabled || locked ? 'default' : 'pointer',
                    padding: '0.375rem 0.5rem',
                    borderRadius: '0.375rem',
                    backgroundColor: isCustomized ? 'rgba(99,102,241,0.07)' : 'transparent',
                    border: isCustomized ? '1px solid rgba(99,102,241,0.2)' : '1px solid transparent',
                    transition: 'all 0.15s',
                  }}>
                    {/* BETA-UX-3 (ronda 2): un checkbox de verdad. El cuadro de abajo
                        era un <div onClick>: con el teclado no se podía tildar ni
                        destildar nada. El input queda oculto a la vista y el cuadro
                        pinta su estado (y su foco). Bloqueado = deshabilitado. */}
                    <input
                      type="checkbox"
                      className="perm-toggle__input"
                      checked={isOn}
                      disabled={disabled || locked}
                      onChange={() => toggle(key)}
                    />
                    <span
                      className="perm-toggle__box"
                      aria-hidden="true"
                      style={{
                        width: '18px', height: '18px', borderRadius: '4px', flexShrink: 0,
                        backgroundColor: isOn ? '#6366f1' : 'transparent',
                        border: isOn ? '2px solid #6366f1' : '2px solid rgba(100,116,139,0.5)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all 0.15s',
                      }}
                    >
                      {isOn && <Check size={11} color="#fff" strokeWidth={3} />}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.8rem', fontWeight: 500, color: '#e2e8f0' }}>
                        {PERMISSION_LABELS[key].label}
                        {isCustomized && (
                          <span style={{ marginLeft: '0.4rem', fontSize: '0.65rem', color: '#818cf8' }}>
                            personalizado
                          </span>
                        )}
                        {locked && (
                          <span data-testid={`permission-locked-${key}`} style={{ marginLeft: '0.4rem', fontSize: '0.65rem', color: colors.text.muted }}>
                            automático para este rol
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

  // BETA-UX-3 (ronda 2): el diálogo compartido (`AppModal`). El de antes era un
  // overlay armado a mano: sin `role="dialog"`, el foco quedaba en la fila de
  // atrás, Escape no cerraba y Tab salía del diálogo. Mismo contenido y acciones.
  return (
    <AppModal
      isOpen
      onClose={onClose}
      title={`Permisos — ${user.full_name || user.email}`}
      subtitle={`Rol base: ${user.role} · Personalizá los accesos`}
      icon={<Shield size={18} aria-hidden="true" />}
      size="md"
      footer={(
        <div className="users-perms-footer">
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
      )}
    >
      <PermissionsMatrix role={user.role} value={perms} onChange={setPerms} />
    </AppModal>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function UsersManagement() {
  const { businessId, isOwner, isAdmin, profile } = useAuth();
  const { } = useSubscription();
  const [users, setUsers] = useState<BusinessUser[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showInvitations, setShowInvitations] = useState(false);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('tech');
  const [invitePerms, setInvitePerms] = useState<AppPermissions>(() => resolvePermissions('tech'));
  const [inviting, setInviting] = useState(false);

  // PRE-BETA-2F — reenvío por fila. El ref corta el doble click antes de que el
  // estado alcance a re-renderizar el botón deshabilitado.
  const [resending, setResending] = useState<ReadonlySet<string>>(() => new Set());
  const resendEnCurso = useRef<Set<string>>(new Set());

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
        invitationsService.listPendingInvitations(bid),
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
    const invitationsData = await invitationsService.listPendingInvitations(businessId);
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
      // P0-P2: no se manda `businessId`. El servidor lo deriva de auth.uid();
      // un business_id de entrada nunca es autorización.
      // PRE-BETA-2F: la invitación la crea la MISMA RPC canónica (vía la capa de
      // entrega) y el correo sale solo. Crear y enviar son resultados distintos.
      const { invitation: invitacion, delivery } =
        await invitationsService.createAndSendInvitation(inviteEmail.trim(), inviteRole);

      // La RPC es idempotente: si ya había una invitación pendiente para ese
      // correo devuelve ESA, con el mismo token. Se detecta comparando contra la
      // lista que ya teníamos para decírselo al usuario en vez de simular un
      // envío nuevo.
      const yaExistia = invitations.some(inv => inv.id === invitacion.id);
      const destinatario = textoSeguro(invitacion.email);

      if (delivery.status === 'failed') {
        showToast(
          'La invitación quedó creada, pero no pudimos enviar el correo. Podés reenviarlo o copiar el link.',
          'warning',
          7000,
        );
      } else if (yaExistia) {
        showToast(
          `Ya había una invitación pendiente para ${destinatario}. Si no le llegó el correo, usá «Reenviar correo».`,
          'info',
          6000,
        );
      } else {
        showToast(`Invitación enviada a ${destinatario}.`, 'success');
      }

      setInviteEmail('');
      setInviteRole('tech');
      setInvitePerms(resolvePermissions('tech'));
      setShowInviteModal(false);
      setShowInvitations(true);
      await reloadInvitations();
    } catch (error) {
      // `InvitationError.message` YA es texto de UI. Nunca sale un SQLSTATE ni un
      // `function gen_random_bytes(integer) does not exist` a la pantalla.
      showToast(
        error instanceof InvitationError ? error.message : 'No se pudo crear la invitación. Intentá nuevamente.',
        'error',
      );
    } finally {
      setInviting(false);
    }
  };

  const handleCopyToken = async (token: string) => {
    // Misma fuente que el enlace del correo: nunca el origen de la pestaña.
    const inviteLink = invitationUrl(token);
    try {
      await navigator.clipboard.writeText(inviteLink);
      showToast('Link de invitación copiado al portapapeles', 'success');
    } catch {
      showToast('No pudimos copiar automáticamente. Copiá el link desde la tabla.', 'warning');
    }
  };

  const handleResendEmail = async (invitationId: string) => {
    if (resendEnCurso.current.has(invitationId)) return;
    resendEnCurso.current.add(invitationId);
    setResending(prev => new Set(prev).add(invitationId));
    try {
      // Sólo viaja el id: destinatario y token los resuelve el servidor desde la fila.
      const delivery = await invitationsService.resendInvitationEmail(invitationId);
      if (delivery.status === 'sent') {
        showToast('Invitación reenviada.', 'success');
      } else {
        showToast('No pudimos reenviar el correo. El link sigue disponible.', 'warning', 6000);
      }
    } catch (error) {
      // Vencida, cancelada, ya usada o de otro negocio: el link tampoco sirve, así
      // que se muestra el motivo y se refresca la lista.
      showToast(
        error instanceof InvitationError ? error.message : 'No pudimos reenviar el correo. El link sigue disponible.',
        'error',
      );
      await reloadInvitations().catch(() => { /* la lista se recarga en la próxima acción */ });
    } finally {
      resendEnCurso.current.delete(invitationId);
      setResending(prev => {
        const next = new Set(prev);
        next.delete(invitationId);
        return next;
      });
    }
  };

  const handleRevokeInvitation = async (invitationId: string) => {
    if (!window.confirm('¿Estás seguro de cancelar esta invitación?')) return;
    try {
      // `cancelled`, no `revoked`: son los estados que admite el CHECK de la
      // tabla. Y va por RPC porque `authenticated` no tiene UPDATE directo.
      await invitationsService.cancelInvitation(invitationId);
      showToast('Invitación cancelada', 'success');
      await reloadInvitations();
    } catch (error) {
      showToast(
        error instanceof InvitationError ? error.message : 'No se pudo cancelar la invitación.',
        'error',
      );
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
      {/* Encabezado de la sección. BETA-UX-3: se dibuja dentro de Configuración (`SettingsShell`, que tiene el h1): el título de acá es el de la sección. */}
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon">
            <UserCheck size={22} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div>
            <h2 className="page-hdr-title">Usuarios del Negocio</h2>
            <p className="page-hdr-subtitle">Gestioná usuarios, roles y permisos</p>
          </div>
        </div>
        <div className="page-hdr-right">
          {canManageUsers && (
            <button onClick={() => setShowInvitations(v => !v)} data-testid="invitations-toggle" aria-expanded={showInvitations} style={{
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
            // BETA-UX-1E: `btn-primary-aa` — sobre el gradiente de `.btn-primary`
            // (índigo → cyan) el texto blanco no llega a AA.
            <button onClick={() => setShowInviteModal(true)} data-testid="invite-open" className="btn btn-primary btn-primary-aa btn-lift">
              <Plus size={18} />
              Invitar Usuario
            </button>
          )}
        </div>
      </div>

      {/* Pending invitations panel */}
      {showInvitations && canManageUsers && (
        <div style={{ marginBottom: '2rem' }}>
          {/* BETA-UX-3: scroll horizontal en vez de recorte — dentro de Configuración la columna es más angosta y la tabla perdía las acciones. */}
          <div style={{ backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem', overflowX: 'auto' }}>
            <div style={{ padding: '1rem', backgroundColor: 'rgba(245,158,11,0.1)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#fbbf24', marginBottom: '0.25rem' }}>Invitaciones Pendientes</h3>
              <p style={{ fontSize: '0.875rem', color: '#94a3b8' }}>
                {invitations.length === 0
                  ? 'No hay invitaciones pendientes'
                  : 'Le enviamos el enlace por correo. Si no le llegó, reenvialo o copiá el link y compartilo a mano.'}
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
                  {invitations.map(inv => {
                    const reenviando = resending.has(inv.id);
                    return (
                    <tr key={inv.id} data-testid="pending-invitation-row" data-invitation-id={inv.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: '0.75rem 1rem', color: '#ffffff' }}>{inv.email}</td>
                      <td style={{ padding: '0.75rem 1rem' }}>{getRoleBadge(inv.role)}</td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <code data-testid="invitation-link" style={{ padding: '0.25rem 0.5rem', backgroundColor: 'rgba(15,23,42,0.8)', borderRadius: '0.25rem', color: '#6366f1', fontSize: '0.75rem', fontFamily: 'monospace', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                            {invitationUrl(inv.token)}
                          </code>
                          <button onClick={() => void handleCopyToken(inv.token)} data-testid="invitation-copy" style={smallActionButtonStyle('#6366f1', 'rgba(99,102,241,0.1)', 'rgba(99,102,241,0.3)')} title="Copiar link" aria-label="Copiar link de invitación">
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
                        <div style={{ display: 'inline-flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          <button
                            onClick={() => void handleResendEmail(inv.id)}
                            disabled={reenviando}
                            aria-busy={reenviando}
                            data-testid="invitation-resend"
                            style={{
                              ...smallActionButtonStyle('#818cf8', 'rgba(99,102,241,0.1)', 'rgba(99,102,241,0.3)'),
                              display: 'inline-flex', fontSize: '0.875rem',
                              opacity: reenviando ? 0.55 : 1, cursor: reenviando ? 'not-allowed' : 'pointer',
                            }}
                          >
                            <Send size={14} /> {reenviando ? 'Reenviando...' : 'Reenviar correo'}
                          </button>
                          <button onClick={() => void handleRevokeInvitation(inv.id)} data-testid="invitation-cancel" style={dangerButtonStyle}>
                            <X size={14} /> Cancelar
                          </button>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>No hay invitaciones pendientes</div>
            )}
          </div>
        </div>
      )}

      {/* Users table — BETA-UX-3 (ronda 2).
          Dentro de Configuración la columna de la sección mide 428 px a 1024 de
          ancho y 684 a 1280: la tabla de cinco columnas dejaba Estado y Acciones
          detrás de un scroll horizontal. Ahora:
            · Usuario y email van en una sola columna (el email debajo).
            · «Permisos» es un botón con nombre (la tarea principal de la fila).
            · Activar/Desactivar viven en el menú de la fila (`OverflowMenu`, el
              mismo de Clientes y Órdenes): lo destructivo, en un menú deliberado.
            · Si la tabla tiene menos de 640 px (container query sobre ella, no
              sobre la ventana), cada fila pasa a ser una ficha de dos renglones.
          Los roles ARIA explícitos conservan la semántica de tabla aunque el CSS
          cambie el `display` de filas y celdas. */}
      <div className="users-table" data-testid="users-table-wrap">
        <table className="users-table__table" role="table" aria-label="Usuarios del negocio">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Usuario</th>
              <th role="columnheader" scope="col">Rol</th>
              <th role="columnheader" scope="col">Estado</th>
              {canManageUsers && <th role="columnheader" scope="col" className="users-table__actions-hdr">Acciones</th>}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {users.map(user => {
              const protectedRow = isProtectedRow(user);
              const nombre = user.full_name || user.email || 'Sin nombre';
              const personalizados = hasCustomPerms(user);
              return (
                <tr key={user.id} role="row" className="users-table__row" data-testid="users-row">
                  <td role="cell" className="users-table__user">
                    <div className="users-table__identity">
                      <UserCheck size={16} className="users-table__avatar" aria-hidden="true" />
                      <div className="users-table__identity-text">
                        <span className="users-table__name">{user.full_name || 'Sin nombre'}</span>
                        <span className="users-table__email">
                          <Mail size={13} aria-hidden="true" />
                          <span>{user.email || '-'}</span>
                        </span>
                      </div>
                    </div>
                  </td>
                  <td role="cell" className="users-table__role">
                    {canManageUsers && !protectedRow ? (
                      <select
                        value={user.role}
                        onChange={e => void handleChangeRole(user.id, e.target.value)}
                        aria-label={`Rol de ${nombre}`}
                        className="users-table__role-select"
                        data-testid="user-role-select"
                      >
                        {roleOptions.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    ) : (
                      getRoleBadge(user.role)
                    )}
                  </td>
                  <td role="cell" className="users-table__status">
                    {user.is_active
                      ? <span style={activeBadgeStyle}>Activo</span>
                      : <span style={inactiveBadgeStyle}>Inactivo</span>}
                  </td>
                  {canManageUsers && (
                    <td role="cell" className="users-table__actions">
                      {protectedRow ? (
                        <span className="users-table__protected">
                          {user.role === 'owner' ? 'Protegido' : 'Tu usuario'}
                        </span>
                      ) : (
                        <div className="users-table__actions-row">
                          <button
                            type="button"
                            onClick={() => setEditingUser(user)}
                            title="Editar permisos"
                            aria-label={`Editar permisos de ${nombre}${personalizados ? ' (personalizados)' : ''}`}
                            className="btn btn-secondary users-table__permissions"
                            data-testid="user-permissions"
                          >
                            <Shield size={15} aria-hidden="true" />
                            <span>Permisos</span>
                            {personalizados && <span className="users-table__custom-dot" aria-hidden="true" />}
                          </button>
                          <OverflowMenu
                            label={`Más acciones de ${nombre}`}
                            testId="user-row-menu"
                            className="users-table__menu"
                            actions={[
                              user.is_active
                                ? { label: 'Desactivar usuario', icon: <UserX size={16} aria-hidden="true" />, destructive: true, onSelect: () => void handleDeactivate(user.id) }
                                : { label: 'Activar usuario', icon: <UserCheck size={16} aria-hidden="true" />, onSelect: () => void handleActivate(user.id) },
                            ]}
                          />
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
                  aria-label="Email del usuario a invitar"
                  data-testid="invite-email"
                  style={inputStyle}
                />
              </div>
              <div style={{ marginBottom: '1rem' }}>
                <label style={inputLabelStyle}>Rol</label>
                <select value={inviteRole} onChange={e => handleInviteRoleChange(e.target.value)} aria-label="Rol del usuario a invitar" data-testid="invite-role" style={inputStyle}>
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
                aria-busy={inviting}
                data-testid="invite-submit"
                style={{ ...primaryButtonStyle, opacity: inviting ? 0.5 : 1, cursor: inviting ? 'not-allowed' : 'pointer' }}
              >
                {inviting ? 'Enviando invitación...' : 'Enviar Invitación'}
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

// BETA-UX-1E: con `color: '#ffffff'` en línea el tema claro lo remapeaba a
// texto oscuro sobre índigo. Texto y fondo salen de `accentCta` (ver tokens).
const primaryButtonStyle = {
  padding: '0.625rem 1.25rem',
  background: accentCta.background,
  border: 'none', color: accentCta.text, borderRadius: '0.625rem',
  fontWeight: 600, boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
};
