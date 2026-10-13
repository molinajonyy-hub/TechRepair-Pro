import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Ban, CheckCircle2, CircleAlert, Link2, Mail, MailWarning, RefreshCw, TimerOff, UserRoundPlus, Users } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { invitationsService, InvitationError, type InvitationErrorCode } from '../services/invitationsService';
import {
  acceptInviteePath,
  clearInviteToken,
  peekInviteToken,
  stashInviteToken,
} from '../lib/pendingInvite';
import { invitationTokenFromInput } from '../lib/invitationLink';
import { logger } from '../lib/logger';
import {
  AuthFlowShell, AuthFlowLoading, AuthFlowActions,
  AuthFlowPrimaryButton, AuthFlowSecondaryButton, AuthFlowTextButton,
  type AuthFlowTone,
} from '../components/auth/AuthFlowShell';
import { AuthFlowAlert, AuthFlowTextField } from '../components/auth/AuthFlowFields';

/**
 * P0-P2 — Aceptación de una invitación.
 *
 * Funciona para usuario nuevo y para usuario existente, y es la ÚNICA pantalla
 * del camino de invitación. Reglas que la gobiernan:
 *
 *  · NUNCA llama a `provision_my_business()`. Un invitado no es un owner nuevo;
 *    crear un tenant propio acá es justamente lo que genera negocios huérfanos.
 *    El servidor además lo bloquea con INVITATION_PENDING, pero el frontend no
 *    debe ni intentarlo.
 *  · El único dato que manda es el token. Identidad, correo, negocio y rol los
 *    deriva el servidor.
 *  · Ningún error de SQL llega a la pantalla: `invitationsService` traduce a
 *    mensajes semánticos antes de salir.
 *
 * BETA-UX-1G — la pantalla usa el shell del embudo y cada rechazo tiene salida:
 *  · un fallo que no es del enlace (red, servidor) ofrece «Reintentar» con el
 *    MISMO enlace. Antes mostraba un campo para pegar un «token» que el invitado
 *    no tiene a mano: está dentro del enlace del correo;
 *  · «esta invitación es para otro correo» dice con qué cuenta se entró y ofrece
 *    cambiarla sin perder el enlace. Antes la única acción era «Volver al inicio»;
 *  · sin enlace, se pide el ENLACE del correo (pegado entero) en vez de un token.
 * La autoridad no cambió: aceptar sigue siendo una sola RPC con sólo el token.
 */

type Estado =
  | { fase: 'cargando' }
  | { fase: 'sin-token' }
  | { fase: 'necesita-login'; token: string }
  | { fase: 'confirmando-correo' }
  | { fase: 'listo-para-aceptar'; token: string }
  | { fase: 'aceptando' }
  | { fase: 'ok'; yaEraMiembro: boolean }
  | { fase: 'error'; codigo: InvitationErrorCode | null; mensaje: string; token: string };

/**
 * Rechazos definitivos: el enlace no va a mejorar por reintentar. Se limpia el
 * token guardado para que el usuario no quede en un bucle al recargar.
 */
const RECHAZOS_DEFINITIVOS: ReadonlySet<InvitationErrorCode> = new Set<InvitationErrorCode>([
  'INVITATION_NOT_FOUND', 'INVITATION_EXPIRED', 'INVITATION_CANCELLED',
  'INVITATION_EMAIL_MISMATCH', 'INVITATION_ALREADY_USED',
  'ALREADY_MEMBER_OF_ANOTHER_BUSINESS',
]);

interface Presentacion {
  titulo: string;
  tono: AuthFlowTone;
  icono: ReactNode;
}

const ERROR_GENERICO: Presentacion = {
  titulo: 'No pudimos sumarte al equipo', tono: 'danger', icono: <CircleAlert size={26} />,
};

/** Título e ícono por rechazo. El detalle es el mensaje de `invitationsService`. */
const PRESENTACION_ERROR: Partial<Record<InvitationErrorCode, Presentacion>> = {
  INVITATION_EXPIRED: { titulo: 'La invitación venció', tono: 'warning', icono: <TimerOff size={26} /> },
  INVITATION_CANCELLED: { titulo: 'La invitación fue cancelada', tono: 'warning', icono: <Ban size={26} /> },
  INVITATION_NOT_FOUND: { titulo: 'No encontramos la invitación', tono: 'warning', icono: <Link2 size={26} /> },
  INVITATION_ALREADY_USED: { titulo: 'Esta invitación ya se usó', tono: 'warning', icono: <CheckCircle2 size={26} /> },
  INVITATION_NOT_PENDING: { titulo: 'Esta invitación ya no está disponible', tono: 'warning', icono: <Ban size={26} /> },
  INVITATION_EMAIL_MISMATCH: { titulo: 'Esta invitación es para otro correo', tono: 'warning', icono: <MailWarning size={26} /> },
  ALREADY_MEMBER_OF_ANOTHER_BUSINESS: { titulo: 'Tu cuenta ya está en otro negocio', tono: 'warning', icono: <Users size={26} /> },
  EMAIL_NOT_CONFIRMED: { titulo: 'Confirmá tu correo', tono: 'warning', icono: <Mail size={26} /> },
};

export function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, isAuthenticated, emailConfirmed, loading: authLoading, refreshProfile, signOut } = useAuth();

  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' });
  const [enlaceManual, setEnlaceManual] = useState('');
  const [errorManual, setErrorManual] = useState('');
  const [saliendo, setSaliendo] = useState(false);

  // Una invitación se acepta UNA vez. Sin este guard, un re-render (o el
  // refresco de perfil que dispara el éxito) volvería a llamar a la RPC.
  const yaIntentado = useRef(false);

  // ── Resolución del token ──────────────────────────────────────────────────
  // Prioridad: el de la URL (recién llegado del enlace) y, si no hay, el que
  // quedó guardado antes de mandar al usuario a autenticarse.
  useEffect(() => {
    if (authLoading) return;

    const deUrl = (searchParams.get('token') || searchParams.get('invite') || '').trim();
    const token = deUrl || peekInviteToken() || '';

    if (!token) {
      setEstado({ fase: 'sin-token' });
      return;
    }

    // Se guarda SIEMPRE que se lo ve: si el usuario todavía tiene que pasar por
    // login, signup o la confirmación de correo, el token tiene que sobrevivir
    // ese rodeo. `stashInviteToken` tiene TTL y se consume al usarse.
    stashInviteToken(token);

    if (!isAuthenticated) {
      setEstado({ fase: 'necesita-login', token });
      return;
    }

    // Con Confirm Email ON un usuario sin confirmar no llega a tener sesión, así
    // que esto es defensa en profundidad — y le da un mensaje claro a quien caiga
    // acá por un estado intermedio en vez de un error del servidor.
    if (!emailConfirmed) {
      setEstado({ fase: 'confirmando-correo' });
      return;
    }

    setEstado({ fase: 'listo-para-aceptar', token });
  }, [authLoading, isAuthenticated, emailConfirmed, searchParams]);

  // ── Redirección a login preservando el token ──────────────────────────────
  // Se reusa el mecanismo que ya existe en la app (`?redirectTo=`, normalizado
  // por `sanitizeInternalPath` en Login/AuthCallback). No se inventa uno nuevo.
  useEffect(() => {
    if (estado.fase !== 'necesita-login') return;
    const destino = acceptInviteePath(estado.token);
    navigate(`/login?redirectTo=${encodeURIComponent(destino)}`, { replace: true });
  }, [estado, navigate]);

  // ── Aceptación ────────────────────────────────────────────────────────────
  const aceptar = useCallback(async (token: string) => {
    if (yaIntentado.current) return;
    yaIntentado.current = true;
    setEstado({ fase: 'aceptando' });

    try {
      const res = await invitationsService.acceptInvitation(token);

      // El token cumplió su función: se borra antes de cualquier navegación.
      clearInviteToken();

      // El perfil del usuario acaba de cambiar de negocio y de rol. Sin este
      // refresco, AuthContext seguiría con el estado previo (sin business) y el
      // guard rebotaría al usuario a /no-business apenas navegue.
      await refreshProfile();

      setEstado({ fase: 'ok', yaEraMiembro: res.status === 'ALREADY_MEMBER' });
      setTimeout(() => navigate('/dashboard', { replace: true }), 1500);
    } catch (err) {
      const codigo = err instanceof InvitationError ? err.code : null;

      if (codigo && RECHAZOS_DEFINITIVOS.has(codigo)) clearInviteToken();
      if (!codigo) logger.error('AUTH', 'Fallo inesperado al aceptar la invitación', err);

      setEstado({
        fase: 'error',
        codigo,
        mensaje: err instanceof InvitationError ? err.message : 'No se pudo aceptar la invitación. Intentá nuevamente.',
        // El token queda sólo en memoria de esta pantalla, para reintentar o
        // para cambiar de cuenta sin que el invitado tenga que volver al correo.
        token,
      });
      yaIntentado.current = false;
    }
  }, [navigate, refreshProfile]);

  // Con sesión y token válidos se acepta sola: el usuario ya expresó su
  // intención al abrir el enlace, no hace falta un segundo click.
  useEffect(() => {
    if (estado.fase === 'listo-para-aceptar') void aceptar(estado.token);
  }, [estado, aceptar]);

  /**
   * Cambiar de cuenta sin perder la invitación: se cierra la sesión (que limpia
   * el token guardado, como en cualquier logout) y el enlace viaja en el
   * `?redirectTo=` del login, igual que cuando se llega sin sesión.
   */
  const usarOtraCuenta = async (token: string) => {
    setSaliendo(true);
    try {
      await signOut();
    } catch (err) {
      logger.error('AUTH', 'No se pudo cerrar la sesión para cambiar de cuenta', err);
      setSaliendo(false);
      return;
    }
    navigate(`/login?redirectTo=${encodeURIComponent(acceptInviteePath(token))}`, { replace: true });
  };

  const enviarEnlaceManual = (e: FormEvent) => {
    e.preventDefault();
    const token = invitationTokenFromInput(enlaceManual);
    if (!token) {
      setErrorManual('Pegá el enlace completo del correo de invitación.');
      return;
    }
    setErrorManual('');
    stashInviteToken(token);
    yaIntentado.current = false;
    setEstado(isAuthenticated ? { fase: 'listo-para-aceptar', token } : { fase: 'necesita-login', token });
  };

  const irAlInicio = () => navigate(isAuthenticated ? '/dashboard' : '/login');
  const textoInicio = isAuthenticated ? 'Ir al inicio' : 'Ir a iniciar sesión';

  if (estado.fase === 'cargando' || estado.fase === 'necesita-login' || estado.fase === 'listo-para-aceptar' || estado.fase === 'aceptando') {
    return (
      <AuthFlowLoading
        pageTestId="accept-invite-page"
        estado={estado.fase}
        testId="accept-invite-loading"
        label={estado.fase === 'aceptando' || estado.fase === 'listo-para-aceptar' ? 'Sumándote al equipo…' : 'Verificando la invitación…'}
      />
    );
  }

  if (estado.fase === 'confirmando-correo') {
    return (
      <AuthFlowShell
        testId="accept-invite-page"
        estado={estado.fase}
        cardTestId="accept-invite-confirm-email"
        align="center"
        tone="warning"
        icon={<Mail size={26} />}
        title="Confirmá tu correo"
        description="Te enviamos un enlace de verificación. Cuando lo confirmes, te sumamos al equipo que te invitó."
      >
        <AuthFlowPrimaryButton onClick={() => navigate('/verificar-email')}>
          Ir a verificar mi correo
        </AuthFlowPrimaryButton>
      </AuthFlowShell>
    );
  }

  if (estado.fase === 'ok') {
    return (
      <AuthFlowShell
        testId="accept-invite-page"
        estado={estado.fase}
        cardTestId="accept-invite-ok"
        contentKey="ok"
        align="center"
        tone="success"
        icon={<CheckCircle2 size={26} />}
        title={estado.yaEraMiembro ? 'Ya sos parte del equipo' : 'Invitación aceptada'}
        description="Tu cuenta quedó asociada al negocio. Te llevamos al inicio…"
      >
        <AuthFlowPrimaryButton data-testid="accept-invite-continuar" onClick={() => navigate('/dashboard', { replace: true })}>
          Ir al inicio
        </AuthFlowPrimaryButton>
      </AuthFlowShell>
    );
  }

  if (estado.fase === 'error') {
    const { codigo, token } = estado;
    const presentacion = (codigo && PRESENTACION_ERROR[codigo]) || ERROR_GENERICO;
    const definitivo = Boolean(codigo && RECHAZOS_DEFINITIVOS.has(codigo));
    const otroCorreo = codigo === 'INVITATION_EMAIL_MISMATCH';

    return (
      <AuthFlowShell
        testId="accept-invite-page"
        estado={`error:${codigo ?? 'desconocido'}`}
        cardTestId="accept-invite-error"
        contentKey={`error:${codigo ?? 'desconocido'}`}
        align="center"
        tone={presentacion.tono}
        icon={presentacion.icono}
        title={presentacion.titulo}
        description={
          <>
            <p data-testid="accept-invite-error-message">{estado.mensaje}</p>
            {otroCorreo && user?.email && (
              <p data-testid="accept-invite-current-account">Entraste con <strong>{user.email}</strong>.</p>
            )}
          </>
        }
      >
        <AuthFlowActions layout="stack">
          {otroCorreo && (
            <AuthFlowPrimaryButton
              data-testid="accept-invite-switch-account"
              onClick={() => void usarOtraCuenta(token)}
              loading={saliendo}
              leftIcon={<UserRoundPlus aria-hidden="true" />}
            >
              {saliendo ? 'Cerrando sesión…' : 'Usar otra cuenta'}
            </AuthFlowPrimaryButton>
          )}
          {codigo === 'EMAIL_NOT_CONFIRMED' && (
            <AuthFlowPrimaryButton onClick={() => navigate('/verificar-email')}>
              Ir a verificar mi correo
            </AuthFlowPrimaryButton>
          )}
          {!definitivo && codigo !== 'EMAIL_NOT_CONFIRMED' && (
            <AuthFlowPrimaryButton
              data-testid="accept-invite-retry"
              onClick={() => setEstado({ fase: 'listo-para-aceptar', token })}
              leftIcon={<RefreshCw aria-hidden="true" />}
            >
              Reintentar
            </AuthFlowPrimaryButton>
          )}
          {otroCorreo
            ? <AuthFlowTextButton data-testid="accept-invite-home" onClick={irAlInicio} disabled={saliendo}>{textoInicio}</AuthFlowTextButton>
            : definitivo
              ? <AuthFlowPrimaryButton data-testid="accept-invite-home" onClick={irAlInicio}>{textoInicio}</AuthFlowPrimaryButton>
              : <AuthFlowSecondaryButton data-testid="accept-invite-home" onClick={irAlInicio}>{textoInicio}</AuthFlowSecondaryButton>}
        </AuthFlowActions>
      </AuthFlowShell>
    );
  }

  // 'sin-token': se llegó sin el enlace (la pantalla abierta a mano, o desde
  // «Tengo una invitación»). Lo que destraba es pegar el enlace del correo.
  return (
    <AuthFlowShell
      testId="accept-invite-page"
      estado={estado.fase}
      cardTestId="accept-invite-manual"
      icon={<Mail size={26} />}
      title="Sumate a un equipo"
      description="Abrí el enlace del correo de invitación. Si no se abrió solo, copialo del correo y pegalo acá."
    >
      <form onSubmit={enviarEnlaceManual} noValidate className="auth-flow__form">
        {!isAuthenticated && (
          <AuthFlowAlert tone="info" role="note">
            Después de pegarlo te vamos a pedir que inicies sesión o crees tu cuenta.
          </AuthFlowAlert>
        )}
        <AuthFlowTextField
          id="accept-invite-link"
          data-testid="accept-invite-link"
          errorTestId="accept-invite-link-error"
          label="Enlace de la invitación"
          icon={<Link2 />}
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Pegá el enlace del correo"
          value={enlaceManual}
          error={errorManual}
          onChange={e => { setEnlaceManual(e.target.value); setErrorManual(''); }}
        />
        <AuthFlowPrimaryButton type="submit" data-testid="accept-invite-submit">
          Continuar
        </AuthFlowPrimaryButton>
        <AuthFlowTextButton data-testid="accept-invite-home" onClick={irAlInicio}>
          {textoInicio}
        </AuthFlowTextButton>
      </form>
    </AuthFlowShell>
  );
}
