import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, CheckCircle, AlertCircle } from 'lucide-react';
import { usersService } from '../services/usersService';

export function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const tokenFromUrl = searchParams.get('token') || searchParams.get('invite') || '';
    if (tokenFromUrl) {
      setToken(tokenFromUrl);
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await usersService.acceptInvitation(token.trim());
      setSuccess(true);
      setTimeout(() => {
        navigate('/login');
      }, 2000);
    } catch (_err) {
      setError('Token inválido o expirado. Verificá el enlace de invitación.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', padding: '1rem' }}>
      <div className="surface-raised" style={{ width: '100%', maxWidth: '400px', padding: '2rem', borderRadius: '1rem' }}>
        {success ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ width: 80, height: 80, background: 'rgba(52,211,153,0.15)', border: '2px solid rgba(52,211,153,0.35)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
              <CheckCircle size={36} style={{ color: '#34d399' }} />
            </div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
              Invitación aceptada
            </h2>
            <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>
              Ya quedaste asociado al negocio.
            </p>
            <p style={{ color: 'var(--text-subtle)', fontSize: '0.875rem' }}>
              Redirigiendo al login...
            </p>
          </div>
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
              <div style={{ width: 72, height: 72, background: 'var(--accent-primary-subtle)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.25rem' }}>
                <Mail size={32} style={{ color: 'var(--accent-primary)' }} />
              </div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
                Aceptar invitación
              </h2>
              <p style={{ color: 'var(--text-muted)' }}>
                Si abriste el link desde el mail, el token se completa solo.
              </p>
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: '1.25rem' }}>
                <label className="label-caps">Token de invitación</label>
                <input
                  type="text"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Pegá acá el token o abrí el link del mail"
                  className="form-control"
                />
              </div>

              {error && (
                <div className="alert-inline alert-error" style={{ marginBottom: '1rem' }}>
                  <AlertCircle size={15} style={{ flexShrink: 0 }} />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !token.trim()}
                className="btn btn-primary btn-lift"
                style={{ width: '100%', justifyContent: 'center', opacity: loading || !token.trim() ? 0.55 : 1 }}
              >
                {loading ? 'Procesando...' : 'Aceptar invitación'}
              </button>
            </form>

            <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
              <button onClick={() => navigate('/login')} className="btn btn-ghost btn-sm">
                Volver al login
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
