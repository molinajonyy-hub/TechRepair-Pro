import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, CheckCircle, XCircle } from 'lucide-react';
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
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#0a0e1a',
      padding: '1rem'
    }}>
      <div style={{
        backgroundColor: '#111827',
        borderRadius: '1rem',
        border: '1px solid rgba(255,255,255,0.05)',
        width: '100%',
        maxWidth: '400px',
        padding: '2rem'
      }}>
        {success ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: '80px',
              height: '80px',
              backgroundColor: '#10b981',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1.5rem'
            }}>
              <CheckCircle size={40} color="#ffffff" />
            </div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#ffffff', marginBottom: '0.5rem' }}>
              Invitación aceptada
            </h2>
            <p style={{ color: '#94a3b8', marginBottom: '1rem' }}>
              Ya quedaste asociado al negocio.
            </p>
            <p style={{ color: '#64748b', fontSize: '0.875rem' }}>
              Redirigiendo al login...
            </p>
          </div>
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
              <div style={{
                width: '80px',
                height: '80px',
                backgroundColor: '#6366f1',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 1.5rem'
              }}>
                <Mail size={40} color="#ffffff" />
              </div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#ffffff', marginBottom: '0.5rem' }}>
                Aceptar invitación
              </h2>
              <p style={{ color: '#94a3b8' }}>
                Si abriste el link desde el mail, el token se completa solo.
              </p>
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                  Token de invitación
                </label>
                <input
                  type="text"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Pegá acá el token o abrí el link del mail"
                  style={{
                    width: '100%',
                    padding: '0.75rem 1rem',
                    backgroundColor: '#1e293b',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '0.5rem',
                    color: '#ffffff',
                    fontSize: '1rem',
                    outline: 'none'
                  }}
                />
              </div>

              {error && (
                <div style={{
                  padding: '0.75rem 1rem',
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '0.5rem',
                  marginBottom: '1rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}>
                  <XCircle size={16} style={{ color: '#f87171' }} />
                  <span style={{ color: '#f87171', fontSize: '0.875rem' }}>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !token.trim()}
                style={{
                  width: '100%',
                  padding: '0.75rem 1.5rem',
                  backgroundColor: '#4f46e5',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.5rem',
                  cursor: loading || !token.trim() ? 'not-allowed' : 'pointer',
                  fontSize: '1rem',
                  fontWeight: 500,
                  opacity: loading || !token.trim() ? 0.5 : 1
                }}
              >
                {loading ? 'Procesando...' : 'Aceptar invitación'}
              </button>
            </form>

            <div style={{ marginTop: '2rem', textAlign: 'center' }}>
              <button
                onClick={() => navigate('/login')}
                style={{
                  padding: '0.5rem 1rem',
                  backgroundColor: 'transparent',
                  border: 'none',
                  color: '#64748b',
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                  textDecoration: 'underline'
                }}
              >
                Volver al login
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
