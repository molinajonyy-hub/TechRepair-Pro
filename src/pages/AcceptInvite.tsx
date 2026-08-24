import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { invitationsService, InvitationError } from '../services/invitationsService';
import {
  acceptInviteePath,
  clearInviteToken,
  peekInviteToken,
  stashInviteToken,
} from '../lib/pendingInvite';
import { logger } from '../lib/logger';

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
 */

type Estado =
  | { fase: 'cargando' }
  | { fase: 'sin-token' }
  | { fase: 'necesita-login'; token: string }
  | { fase: 'confirmando-correo' }
  | { fase: 'listo-para-aceptar'; token: string }
  | { fase: 'aceptando' }
  | { fase: 'ok'; yaEraMiembro: boolean }
  | { fase: 'error'; mensaje: string; puedeReintentar: boolean };

export function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { isAuthenticated, emailConfirmed, loading: authLoading, refreshProfile } = useAuth();

  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' });
  const [tokenManual, setTokenManual] = useState('');

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
      const esSemantico = err instanceof InvitationError;

      // Los rechazos definitivos no se reintentan: el token no va a mejorar. Se
      // limpia el stash para que el usuario no quede en un bucle al recargar.
      const definitivo =
        esSemantico &&
        ['INVITATION_NOT_FOUND', 'INVITATION_EXPIRED', 'INVITATION_CANCELLED',
         'INVITATION_EMAIL_MISMATCH', 'INVITATION_ALREADY_USED',
         'ALREADY_MEMBER_OF_ANOTHER_BUSINESS'].includes(err.code);

      if (definitivo) clearInviteToken();
      if (!esSemantico) logger.error('AUTH', 'Fallo inesperado al aceptar la invitación', err);

      setEstado({
        fase: 'error',
        mensaje: esSemantico ? err.message : 'No se pudo aceptar la invitación. Intentá nuevamente.',
        puedeReintentar: !definitivo,
      });
      yaIntentado.current = false;
    }
  }, [navigate, refreshProfile]);

  // Con sesión y token válidos se acepta sola: el usuario ya expresó su
  // intención al abrir el enlace, no hace falta un segundo click.
  useEffect(() => {
    if (estado.fase === 'listo-para-aceptar') void aceptar(estado.token);
  }, [estado, aceptar]);

  const contenedor = (hijo: React.ReactNode) => (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', padding: '1rem' }}>
      <div className="surface-raised" style={{ width: '100%', maxWidth: '420px', padding: '2rem', borderRadius: '1rem' }}>
        {hijo}
      </div>
    </div>
  );

  const icono = (color: string, fondo: string, borde: string, hijo: React.ReactNode) => (
    <div style={{ width: 76, height: 76, background: fondo, border: `2px solid ${borde}`, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem', color }}>
      {hijo}
    </div>
  );

  if (estado.fase === 'cargando' || estado.fase === 'necesita-login' || estado.fase === 'aceptando') {
    return contenedor(
      <div style={{ textAlign: 'center' }}>
        {icono('var(--accent-primary)', 'var(--accent-primary-subtle)', 'transparent',
          <Loader2 size={32} className="spin" style={{ animation: 'spin 1s linear infinite' }} />)}
        <p style={{ color: 'var(--text-muted)' }}>
          {estado.fase === 'aceptando' ? 'Sumándote al negocio...' : 'Verificando la invitación...'}
        </p>
      </div>
    );
  }

  if (estado.fase === 'confirmando-correo') {
    return contenedor(
      <div style={{ textAlign: 'center' }}>
        {icono('#fbbf24', 'rgba(251,191,36,0.12)', 'rgba(251,191,36,0.35)', <Mail size={32} />)}
        <h2 style={{ fontSize: '1.35rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
          Confirmá tu correo
        </h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
          Te enviamos un enlace de verificación. Cuando lo confirmes, volvé a abrir el link de la
          invitación y te sumamos al equipo.
        </p>
        <button onClick={() => navigate('/verificar-email')} className="btn btn-primary btn-lift" style={{ width: '100%', justifyContent: 'center' }}>
          Ir a verificar mi correo
        </button>
      </div>
    );
  }

  if (estado.fase === 'ok') {
    return contenedor(
      <div style={{ textAlign: 'center' }}>
        {icono('#34d399', 'rgba(52,211,153,0.15)', 'rgba(52,211,153,0.35)', <CheckCircle size={36} />)}
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
          {estado.yaEraMiembro ? 'Ya sos parte del equipo' : 'Invitación aceptada'}
        </h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>
          Ya quedaste asociado al negocio.
        </p>
        <p style={{ color: 'var(--text-subtle)', fontSize: '0.875rem' }}>Entrando...</p>
      </div>
    );
  }

  // 'sin-token' y 'error' comparten el formulario manual: en los dos casos lo
  // que puede destrabar al usuario es pegar el token correcto.
  const mensajeError = estado.fase === 'error' ? estado.mensaje : '';
  const permiteManual = estado.fase === 'sin-token' || (estado.fase === 'error' && estado.puedeReintentar);

  return contenedor(
    <>
      <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
        {icono(
          estado.fase === 'error' ? '#f87171' : 'var(--accent-primary)',
          estado.fase === 'error' ? 'rgba(248,113,113,0.12)' : 'var(--accent-primary-subtle)',
          estado.fase === 'error' ? 'rgba(248,113,113,0.35)' : 'transparent',
          estado.fase === 'error' ? <AlertCircle size={32} /> : <Mail size={32} />
        )}
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
          {estado.fase === 'error' ? 'No pudimos sumarte' : 'Aceptar invitación'}
        </h2>
        <p style={{ color: 'var(--text-muted)' }}>
          {estado.fase === 'error'
            ? mensajeError
            : 'Si abriste el link desde el mail, el token se completa solo.'}
        </p>
      </div>

      {permiteManual && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const t = tokenManual.trim();
            if (!t) return;
            stashInviteToken(t);
            yaIntentado.current = false;
            setEstado({ fase: 'listo-para-aceptar', token: t });
          }}
        >
          <div style={{ marginBottom: '1.25rem' }}>
            <label className="label-caps">Token de invitación</label>
            <input
              type="text"
              value={tokenManual}
              onChange={(e) => setTokenManual(e.target.value)}
              placeholder="Pegá acá el token o abrí el link del mail"
              className="form-control"
            />
          </div>
          <button
            type="submit"
            disabled={!tokenManual.trim()}
            className="btn btn-primary btn-lift"
            style={{ width: '100%', justifyContent: 'center', opacity: tokenManual.trim() ? 1 : 0.55 }}
          >
            Aceptar invitación
          </button>
        </form>
      )}

      <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
        <button onClick={() => navigate(isAuthenticated ? '/dashboard' : '/login')} className="btn btn-ghost btn-sm">
          {isAuthenticated ? 'Volver al inicio' : 'Volver al login'}
        </button>
      </div>
    </>
  );
}
