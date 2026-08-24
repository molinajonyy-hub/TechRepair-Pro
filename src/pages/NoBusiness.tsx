import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Building2, Plus, Loader2, AlertTriangle, Mail } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { provisionMyBusiness } from '../services/provisioningService';
import { peekInviteToken, acceptInviteePath } from '../lib/pendingInvite';
import { logger } from '../lib/logger';

/**
 * P0-P4 — Recovery explícito para un usuario autenticado y confirmado que
 * REALMENTE no tiene negocio.
 *
 * ── EL BUG QUE CIERRA ────────────────────────────────────────────────────────
 * Esta pantalla tenía, arriba de todo, un `useEffect` que redirigía sin
 * condiciones: con negocio a /dashboard, sin negocio a /onboarding. O sea que
 * TODA la UI de recuperación de abajo era código muerto — nadie la vio nunca —
 * y cualquiera sin negocio terminaba en el wizard de owner, incluido un invitado
 * que sólo tenía que aceptar su invitación.
 *
 * Ahora la pantalla tiene UNA responsabilidad y no redirige por su cuenta salvo
 * cuando el estado dejó de corresponderle.
 *
 * ── LAS TRES SALIDAS ─────────────────────────────────────────────────────────
 *   A. invitación vigente  -> continuar el flujo de invitación (NO crear tenant)
 *   B. owner sin negocio   -> acción EXPLÍCITA «Crear mi taller»
 *   C. estado inconsistente-> reintentar; NUNCA ofrecer crear un tenant
 *
 * La diferencia entre B y C es la que evita fabricar negocios duplicados a
 * partir de un corte de red: `authState === 'AUTH_ERROR'` significa «no pudimos
 * averiguar si tenés negocio», no «no tenés».
 */
export function NoBusiness() {
  const {
    user, authState, profileErrorKind, refreshProfile, signOut,
  } = useAuth();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [error, setError] = useState('');
  const [invitacionPendiente, setInvitacionPendiente] = useState(false);

  // Sólo se navega cuando este estado YA no corresponde a esta pantalla. No hay
  // redirect «por las dudas»: los estados de espera se quedan quietos.
  useEffect(() => {
    if (authState === 'AUTHENTICATED_WITH_BUSINESS') {
      navigate('/dashboard', { replace: true });
      return;
    }
    if (authState === 'UNAUTHENTICATED') {
      navigate('/login', { replace: true });
      return;
    }
    if (authState === 'EMAIL_UNCONFIRMED') {
      navigate('/verificar-email', { replace: true });
    }
  }, [authState, navigate]);

  // Si quedó un token de invitación guardado, la salida correcta es aceptarla,
  // no crear un tenant propio. El servidor también lo bloquea
  // (INVITATION_PENDING), pero es mejor ofrecer el camino bueno que dejarlo
  // chocar contra un error.
  useEffect(() => {
    setInvitacionPendiente(!!peekInviteToken());
  }, []);

  const esperando =
    authState === 'AUTH_LOADING' || authState === 'AUTHENTICATED_PROFILE_LOADING';

  const handleRefresh = async () => {
    setLoading(true);
    setError('');
    try {
      await refreshProfile();
    } finally {
      setLoading(false);
    }
  };

  const handleCreateBusiness = async () => {
    if (!businessName.trim()) {
      setError('Poné el nombre de tu negocio para continuar.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      // ÚNICA llamada a la autoridad de provisioning en todo el frontend
      // productivo, y sólo detrás de un click explícito del usuario.
      const res = await provisionMyBusiness(businessName);

      if (res.status === 'invitation_pending') {
        setInvitacionPendiente(true);
        setError('Tenés una invitación pendiente a un negocio. Aceptala para entrar a ese equipo en vez de crear uno nuevo.');
        return;
      }
      if (res.status === 'email_not_confirmed') {
        setError('Confirmá tu correo antes de crear el negocio.');
        return;
      }

      await refreshProfile();
      // El negocio recién creado se llama como lo escribió el usuario, pero
      // todavía no tiene rubro ni contacto: el destino es la configuración.
      navigate('/onboarding', { replace: true });
    } catch (err) {
      logger.error('AUTH', 'No se pudo crear el negocio desde recovery', err);
      setError(err instanceof Error ? err.message : 'No se pudo crear el negocio. Intentá nuevamente.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    setLoading(true);
    try {
      await signOut();
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cerrar sesión');
    } finally {
      setLoading(false);
    }
  };

  const card: React.CSSProperties = {
    width: '100%', maxWidth: 460,
    background: 'var(--auth-card-bg)', border: '1px solid var(--border-color)',
    borderRadius: 22, padding: '2.25rem',
    boxShadow: '0 4px 6px rgba(0,0,0,0.1), 0 24px 48px rgba(0,0,0,0.2)',
  };

  const shell = (hijo: React.ReactNode) => (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--auth-bg)', padding: '1.25rem' }}>
      <div style={card}>{hijo}</div>
    </div>
  );

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '12px 15px', fontSize: '0.95rem',
    background: 'var(--input-bg)', border: '1.5px solid var(--input-border)',
    borderRadius: 12, color: 'var(--text-primary)',
  };

  const primaryStyle: React.CSSProperties = {
    width: '100%', padding: '14px',
    background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
    border: 'none', borderRadius: 12, color: '#fff', fontWeight: 700, fontSize: '0.95rem',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
  };

  // ── Espera: no se decide nada todavía ────────────────────────────────────
  if (esperando) {
    return shell(
      <div data-testid="no-business-loading" style={{ textAlign: 'center', padding: '1rem 0' }}>
        <Loader2 size={32} style={{ color: '#6366f1', animation: 'tr-spin 0.8s linear infinite' }} />
        <p style={{ marginTop: '1rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>Cargando tu negocio...</p>
        <style>{`@keyframes tr-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ── A. Invitación vigente ────────────────────────────────────────────────
  if (invitacionPendiente) {
    const token = peekInviteToken();
    return shell(
      <div data-testid="no-business-invitation" style={{ textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(99,102,241,0.12)', border: '2px solid rgba(99,102,241,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.25rem' }}>
          <Mail size={28} style={{ color: '#818cf8' }} />
        </div>
        <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.35rem', fontWeight: 800, color: 'var(--text-primary)' }}>
          Tenés una invitación pendiente
        </h1>
        <p style={{ margin: '0 0 1.5rem', color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6 }}>
          Te invitaron a un negocio existente. Aceptala para entrar a ese equipo en vez de crear uno nuevo.
        </p>
        <button
          data-testid="no-business-aceptar-invitacion"
          onClick={() => navigate(token ? acceptInviteePath(token) : '/accept-invite')}
          style={primaryStyle}
        >
          Aceptar la invitación
        </button>
        <button onClick={() => setInvitacionPendiente(false)} style={{ marginTop: '0.875rem', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.8rem', cursor: 'pointer' }}>
          No es para mí, quiero crear mi propio negocio
        </button>
      </div>
    );
  }

  // ── C. Estado inconsistente: reintentar, NUNCA crear ─────────────────────
  if (authState === 'AUTH_ERROR') {
    const esVinculo = profileErrorKind === 'link_failed';
    return shell(
      <div data-testid="no-business-error" style={{ textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(251,191,36,0.12)', border: '2px solid rgba(251,191,36,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.25rem' }}>
          <AlertTriangle size={28} style={{ color: '#fbbf24' }} />
        </div>
        <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.35rem', fontWeight: 800, color: 'var(--text-primary)' }}>
          No pudimos cargar tu negocio
        </h1>
        <p style={{ margin: '0 0 1.5rem', color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6 }}>
          {esVinculo
            ? 'Tu cuenta existe pero no pudimos vincularla a su negocio. Escribinos y lo resolvemos.'
            : 'Puede ser un problema de conexión. Probá de nuevo en unos segundos.'}
        </p>
        {/* A propósito NO se ofrece «crear negocio» acá: no sabemos si el usuario
            ya tiene uno, y crear otro sería duplicar su tenant. */}
        <button data-testid="no-business-reintentar" onClick={() => void handleRefresh()} disabled={loading} style={{ ...primaryStyle, opacity: loading ? 0.6 : 1 }}>
          {loading ? <Loader2 size={16} style={{ animation: 'tr-spin 0.8s linear infinite' }} /> : <RefreshCw size={16} />}
          Reintentar
        </button>
        <style>{`@keyframes tr-spin { to { transform: rotate(360deg); } }`}</style>
        <button onClick={() => void handleSignOut()} style={{ marginTop: '0.875rem', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.8rem', cursor: 'pointer' }}>
          Cerrar sesión
        </button>
      </div>
    );
  }

  // ── B. Owner sin negocio: alta EXPLÍCITA ─────────────────────────────────
  return shell(
    <div data-testid="no-business-create">
      <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(99,102,241,0.12)', border: '2px solid rgba(99,102,241,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.25rem' }}>
          <Building2 size={28} style={{ color: '#818cf8' }} />
        </div>
        <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>
          Creá tu taller
        </h1>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6 }}>
          {user?.email
            ? <>Tu cuenta <strong style={{ color: 'var(--text-primary)' }}>{user.email}</strong> todavía no tiene un negocio.</>
            : 'Tu cuenta todavía no tiene un negocio.'}
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <label style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
            Nombre del negocio
          </label>
          <input
            data-testid="no-business-name"
            autoFocus
            value={businessName}
            onChange={e => setBusinessName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void handleCreateBusiness()}
            placeholder="Ej: Tecno Reparaciones"
            style={inputStyle}
          />
        </div>

        {error && (
          <p data-testid="no-business-error" role="alert" style={{ margin: 0, color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>
        )}

        <button
          data-testid="no-business-crear"
          onClick={() => void handleCreateBusiness()}
          disabled={loading}
          style={{ ...primaryStyle, opacity: loading ? 0.6 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
        >
          {loading
            ? <Loader2 size={16} style={{ animation: 'tr-spin 0.8s linear infinite' }} />
            : <Plus size={16} />}
          {loading ? 'Creando...' : 'Crear mi taller'}
        </button>
        <style>{`@keyframes tr-spin { to { transform: rotate(360deg); } }`}</style>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem' }}>
          <button onClick={() => void handleRefresh()} disabled={loading} style={{ flex: 1, padding: '10px', background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 10, color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer' }}>
            Actualizar
          </button>
          <button onClick={() => navigate('/accept-invite')} style={{ flex: 1, padding: '10px', background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 10, color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer' }}>
            Tengo una invitación
          </button>
        </div>

        <button onClick={() => void handleSignOut()} style={{ background: 'none', border: 'none', color: 'var(--text-subtle)', fontSize: '0.78rem', cursor: 'pointer', marginTop: '0.25rem' }}>
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
