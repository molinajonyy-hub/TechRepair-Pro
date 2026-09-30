import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Building2, Plus, AlertTriangle, Mail, Lock, LogOut } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { provisionMyBusiness } from '../services/provisioningService';
import { peekInviteToken, acceptInviteePath } from '../lib/pendingInvite';
import { logger } from '../lib/logger';
import { CONTACTO_SOPORTE } from '../config/contacto';
import {
  AuthFlowShell, AuthFlowLoading, AuthFlowForm, AuthFlowField, AuthFlowError,
  AuthFlowActions, AuthFlowPrimaryButton, AuthFlowSecondaryButton, AuthFlowTextButton,
} from '../components/auth/AuthFlowShell';

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
 *
 * PRE-BETA-3A-1a — sólo cambió la capa visual: marco, tarjeta y botones vienen
 * de AuthFlowShell. Los estados, el ORDEN de las ramas, los handlers y los
 * `data-testid` son los mismos.
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

  // ── Espera: no se decide nada todavía ────────────────────────────────────
  if (esperando) {
    return <AuthFlowLoading label="Cargando tu negocio..." testId="no-business-loading" />;
  }

  // ── D. Perfil desactivado: estado TERMINAL (PRE-BETA-2D) ─────────────────
  // Antes caía en la rama C y decía «puede ser un problema de conexión» con un
  // Reintentar que nunca iba a funcionar. La cuenta existe y el negocio
  // también: lo que falta es que alguien con autoridad la vuelva a habilitar.
  // Va ANTES de la invitación: un usuario desactivado no sale de este estado
  // aceptando otra cosa ni creando un negocio. La autoridad sigue siendo el
  // servidor (`is_active` + RLS); esta pantalla sólo lo explica.
  if (authState === 'AUTH_ERROR' && profileErrorKind === 'inactive') {
    return (
      <AuthFlowShell
        cardTestId="no-business-inactive"
        align="center"
        tone="warning"
        icon={<Lock size={26} />}
        title="Tu acceso a este negocio está desactivado"
        description={
          <>
            <p>Un administrador del negocio desactivó tu usuario. Si creés que es un error, pedile que te vuelva a habilitar.</p>
            <p>
              Si sos el titular del negocio, escribinos a{' '}
              <a href={`mailto:${CONTACTO_SOPORTE}`}>{CONTACTO_SOPORTE}</a>.
            </p>
          </>
        }
      >
        <AuthFlowPrimaryButton
          data-testid="no-business-inactive-salir"
          onClick={() => void handleSignOut()}
          disabled={loading}
          leftIcon={<LogOut size={16} />}
        >
          Cerrar sesión
        </AuthFlowPrimaryButton>
      </AuthFlowShell>
    );
  }

  // ── A. Invitación vigente ────────────────────────────────────────────────
  if (invitacionPendiente) {
    const token = peekInviteToken();
    return (
      <AuthFlowShell
        cardTestId="no-business-invitation"
        align="center"
        icon={<Mail size={26} />}
        title="Tenés una invitación pendiente"
        description="Te invitaron a un negocio existente. Aceptala para entrar a ese equipo en vez de crear uno nuevo."
      >
        <AuthFlowActions layout="stack">
          <AuthFlowPrimaryButton
            data-testid="no-business-aceptar-invitacion"
            onClick={() => navigate(token ? acceptInviteePath(token) : '/accept-invite')}
          >
            Aceptar la invitación
          </AuthFlowPrimaryButton>
          <AuthFlowTextButton onClick={() => setInvitacionPendiente(false)}>
            No es para mí, quiero crear mi propio negocio
          </AuthFlowTextButton>
        </AuthFlowActions>
      </AuthFlowShell>
    );
  }

  // ── C. Estado inconsistente: reintentar, NUNCA crear ─────────────────────
  if (authState === 'AUTH_ERROR') {
    const esVinculo = profileErrorKind === 'link_failed';
    return (
      <AuthFlowShell
        cardTestId="no-business-error"
        align="center"
        tone="warning"
        icon={<AlertTriangle size={26} />}
        title="No pudimos cargar tu negocio"
        description={esVinculo
          ? 'Tu cuenta existe pero no pudimos vincularla a su negocio. Escribinos y lo resolvemos.'
          : 'Puede ser un problema de conexión. Probá de nuevo en unos segundos.'}
      >
        {/* A propósito NO se ofrece «crear negocio» acá: no sabemos si el usuario
            ya tiene uno, y crear otro sería duplicar su tenant. */}
        <AuthFlowActions layout="stack">
          <AuthFlowPrimaryButton
            data-testid="no-business-reintentar"
            onClick={() => void handleRefresh()}
            loading={loading}
            leftIcon={<RefreshCw size={16} />}
          >
            Reintentar
          </AuthFlowPrimaryButton>
          <AuthFlowTextButton onClick={() => void handleSignOut()}>
            Cerrar sesión
          </AuthFlowTextButton>
        </AuthFlowActions>
      </AuthFlowShell>
    );
  }

  // ── B. Owner sin negocio: alta EXPLÍCITA ─────────────────────────────────
  return (
    <AuthFlowShell
      cardTestId="no-business-create"
      align="center"
      icon={<Building2 size={26} />}
      title="Creá tu taller"
      description={user?.email
        ? <>Tu cuenta <strong>{user.email}</strong> todavía no tiene un negocio.</>
        : 'Tu cuenta todavía no tiene un negocio.'}
    >
      <AuthFlowForm>
        <AuthFlowField label="Nombre del negocio" htmlFor="no-business-name">
          <input
            id="no-business-name"
            data-testid="no-business-name"
            className="form-control"
            autoFocus
            autoComplete="organization"
            value={businessName}
            onChange={e => setBusinessName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void handleCreateBusiness()}
            placeholder="Ej: Tecno Reparaciones"
          />
        </AuthFlowField>

        {error && <AuthFlowError testId="no-business-error">{error}</AuthFlowError>}

        <AuthFlowPrimaryButton
          data-testid="no-business-crear"
          onClick={() => void handleCreateBusiness()}
          loading={loading}
          leftIcon={<Plus size={16} />}
        >
          {loading ? 'Creando...' : 'Crear mi taller'}
        </AuthFlowPrimaryButton>

        <AuthFlowActions layout="pair">
          <AuthFlowSecondaryButton onClick={() => void handleRefresh()} disabled={loading}>
            Actualizar
          </AuthFlowSecondaryButton>
          <AuthFlowSecondaryButton onClick={() => navigate('/accept-invite')}>
            Tengo una invitación
          </AuthFlowSecondaryButton>
        </AuthFlowActions>

        <AuthFlowTextButton onClick={() => void handleSignOut()}>
          Cerrar sesión
        </AuthFlowTextButton>
      </AuthFlowForm>
    </AuthFlowShell>
  );
}
