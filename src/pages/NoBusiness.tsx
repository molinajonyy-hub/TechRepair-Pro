import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, RefreshCw, Building2, Plus, Loader2, ArrowRight } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';

export function NoBusiness() {
  const { user, refreshProfile, setProfileLoadingDisabled, signOut, businessId, loading: authLoading, profileLoading } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [showCreateBusiness, setShowCreateBusiness] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');

  // Si el usuario ya tiene negocio → dashboard. Si no → wizard de onboarding.
  useEffect(() => {
    if (authLoading || profileLoading) return
    if (businessId) {
      navigate('/dashboard', { replace: true })
    } else if (user) {
      navigate('/onboarding', { replace: true })
    }
  }, [businessId, authLoading, profileLoading, user, navigate]);

  const handleRefresh = async () => {
    setLoading(true);
    setError('');

    try {
      await refreshProfile();
    } finally {
      setLoading(false);
    }
  };

  const resolveAuthenticatedEmail = async () => {
    if (user?.email) {
      return user.email;
    }

    const {
      data: { session: currentSession },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError) {
      throw new Error(sessionError.message);
    }

    if (currentSession?.user?.email) {
      return currentSession.user.email;
    }

    const {
      data: { user: currentUser },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError) {
      throw new Error(userError.message);
    }

    return currentUser?.email ?? null;
  };

  const handleCreateBusiness = async () => {
    if (!businessName.trim()) {
      setError('Por favor ingresa el nombre del negocio');
      return;
    }

    let userEmail: string | null = null;

    try {
      userEmail = await resolveAuthenticatedEmail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo validar la sesion');
      return;
    }

    if (!userEmail) {
      setError('Tu sesion no esta activa. Volve a iniciar sesion y despues crea tu negocio.');
      return;
    }

    setLoading(true);
    setError('');
    setProfileLoadingDisabled(true);

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const isAuthLockError = (value: unknown) => {
      if (!(value instanceof Error)) {
        return false;
      }

      const message = value.message.toLowerCase();
      return message.includes('auth-token') || message.includes('stole it');
    };

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const { error: rpcError } = await supabase.rpc('bootstrap_owner_profile', {
            p_user_email: userEmail,
            p_business_name: businessName.trim(),
            p_full_name: fullName.trim() || null,
          });

          if (rpcError) {
            throw new Error(rpcError.message);
          }

          setProfileLoadingDisabled(false);
          await sleep(500);
          await refreshProfile();
          navigate('/dashboard', { replace: true });
          return;
        } catch (err) {
          if (isAuthLockError(err) && attempt < 2) {
            await sleep(300);
            continue;
          }

          throw err;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear negocio. Por favor intenta nuevamente.');
    } finally {
      setProfileLoadingDisabled(false);
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    setLoading(true);
    setError('');

    try {
      await signOut();
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cerrar sesión');
    } finally {
      setLoading(false);
    }
  };

  // Don't render if still loading or if user has business
  if (authLoading || profileLoading || businessId) {
    return null;
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--auth-bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Background effects */}
      <div
        style={{
          position: 'fixed',
          top: '-10%',
          right: '-5%',
          width: '400px',
          height: '400px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, var(--accent-primary-light) 0%, transparent 70%)',
          filter: 'blur(80px)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'fixed',
          bottom: '-10%',
          left: '-5%',
          width: '350px',
          height: '350px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, var(--success-light) 0%, transparent 70%)',
          filter: 'blur(80px)',
          pointerEvents: 'none',
        }}
      />

      {/* Main Card */}
      <div
        style={{
          maxWidth: '500px',
          width: '100%',
          backgroundColor: 'var(--bg-card)',
          backdropFilter: 'blur(20px)',
          borderRadius: '1rem',
          border: '1px solid var(--border-color)',
          boxShadow: 'var(--shadow-xl)',
          padding: '2.5rem'
        }}
      >
        {!showCreateBusiness ? (
          <>
            {/* Header */}
            <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
              <div
                style={{
                  width: '72px',
                  height: '72px',
                  borderRadius: '1.25rem',
                  background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 1.25rem',
                  boxShadow: '0 10px 30px -10px rgba(99, 102, 241, 0.5)',
                }}
              >
                <Building2 size={36} color="#ffffff" strokeWidth={2} />
              </div>
              <h1 style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem', letterSpacing: '-0.025em' }}>
                Creá tu negocio para empezar
              </h1>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', fontWeight: 400, lineHeight: 1.6 }}>
                Para usar el sistema, necesitás vincular tu cuenta a un negocio. Podés crear uno nuevo o aceptar una invitación.
              </p>
            </div>

            {/* Error Message */}
            {error && (
              <div
                style={{
                  padding: '1rem',
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '0.75rem',
                  color: 'var(--error)',
                  fontSize: '0.875rem',
                  marginBottom: '1.5rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
                role="alert"
              >
                {error}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <button
                onClick={() => setShowCreateBusiness(true)}
                disabled={loading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.75rem',
                  padding: '1rem 1.5rem',
                  background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%)',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.75rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  fontSize: '1rem',
                  fontWeight: 600,
                  transition: 'all 0.2s',
                  boxShadow: '0 4px 12px rgba(99, 102, 241, 0.4)',
                  opacity: loading ? 0.7 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!loading) {
                    e.currentTarget.style.transform = 'translateY(-1px)';
                    e.currentTarget.style.boxShadow = '0 6px 16px rgba(99, 102, 241, 0.5)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(99, 102, 241, 0.4)';
                }}
              >
                <Plus size={20} />
                Crear mi negocio
              </button>

              <button
                onClick={() => navigate('/accept-invite')}
                disabled={loading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.75rem',
                  padding: '1rem 1.5rem',
                  backgroundColor: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  borderRadius: '0.75rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  fontSize: '1rem',
                  fontWeight: 500,
                  transition: 'all 0.2s',
                  opacity: loading ? 0.7 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!loading) {
                    e.currentTarget.style.backgroundColor = 'var(--hover-bg)';
                    e.currentTarget.style.borderColor = 'var(--border-strong)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)';
                  e.currentTarget.style.borderColor = 'var(--border-color)';
                }}
              >
                <Mail size={20} />
                Aceptar invitación
              </button>

              <button
                onClick={handleRefresh}
                disabled={loading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  padding: '0.75rem 1rem',
                  backgroundColor: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  fontSize: '0.875rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  fontWeight: 500,
                  opacity: loading ? 0.5 : 1,
                  transition: 'color 0.2s',
                }}
                onMouseEnter={(e) => {
                  if (!loading) {
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--text-muted)';
                }}
              >
                <RefreshCw size={16} className={loading ? 'spin' : ''} />
                {loading ? 'Verificando...' : 'Verificar estado'}
              </button>
            </div>

            {/* Footer */}
            <div style={{ textAlign: 'center', marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-color)' }}>
              <button
                onClick={handleSignOut}
                disabled={loading}
                style={{
                  backgroundColor: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  fontSize: '0.875rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  opacity: loading ? 0.5 : 1,
                  textDecoration: 'none',
                  transition: 'color 0.2s',
                  fontWeight: 500,
                }}
                onMouseEnter={(e) => {
                  if (!loading) {
                    e.currentTarget.style.color = 'var(--text-primary)';
                    e.currentTarget.style.textDecoration = 'underline';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--text-muted)';
                  e.currentTarget.style.textDecoration = 'none';
                }}
              >
                Cerrar sesión
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Create Business Form */}
            <div style={{ marginBottom: '2rem' }}>
              <button
                onClick={() => setShowCreateBusiness(false)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  backgroundColor: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                  padding: 0,
                  marginBottom: '1.5rem',
                  transition: 'color 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'var(--text-primary)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--text-muted)';
                }}
              >
                <ArrowRight size={16} style={{ transform: 'rotate(180deg)' }} />
                Volver
              </button>

              <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
                Creá tu negocio
              </h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', marginBottom: '1.5rem' }}>
                Ingresa los datos básicos para comenzar a usar el sistema.
              </p>
            </div>

            {/* Error Message */}
            {error && (
              <div
                style={{
                  padding: '1rem',
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '0.75rem',
                  color: 'var(--error)',
                  fontSize: '0.875rem',
                  marginBottom: '1.5rem',
                }}
                role="alert"
              >
                {error}
              </div>
            )}

            {/* Business Name Field */}
            <div style={{ marginBottom: '1.25rem' }}>
              <label 
                htmlFor="businessName"
                style={{ 
                  display: 'block', 
                  fontSize: '0.875rem', 
                  color: 'var(--text-secondary)', 
                  marginBottom: '0.5rem', 
                  fontWeight: 500 
                }}
              >
                Nombre del negocio *
              </label>
              <input
                id="businessName"
                type="text"
                value={businessName}
                onChange={(e) => {
                  setBusinessName(e.target.value);
                  if (error) setError('');
                }}
                placeholder="Ej: TechRepair Center"
                disabled={loading}
                autoFocus
                style={{
                  width: '100%',
                  padding: '0.875rem 1rem',
                  backgroundColor: 'var(--input-bg)',
                  border: '1px solid var(--input-border)',
                  borderRadius: '0.75rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.9375rem',
                  outline: 'none',
                  transition: 'all 0.2s',
                  opacity: loading ? 0.6 : 1,
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--input-focus-border)';
                  e.target.style.boxShadow = '0 0 0 3px var(--accent-primary-light)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'var(--input-border)';
                  e.target.style.boxShadow = 'var(--shadow-sm)';
                }}
              />
            </div>

            {/* Full Name Field */}
            <div style={{ marginBottom: '2rem' }}>
              <label 
                htmlFor="fullName"
                style={{ 
                  display: 'block', 
                  fontSize: '0.875rem', 
                  color: 'var(--text-secondary)', 
                  marginBottom: '0.5rem', 
                  fontWeight: 500 
                }}
              >
                Tu nombre (opcional)
              </label>
              <input
                id="fullName"
                type="text"
                value={fullName}
                onChange={(e) => {
                  setFullName(e.target.value);
                  if (error) setError('');
                }}
                placeholder="Ej: Juan Pérez"
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '0.875rem 1rem',
                  backgroundColor: 'var(--input-bg)',
                  border: '1px solid var(--input-border)',
                  borderRadius: '0.75rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.9375rem',
                  outline: 'none',
                  transition: 'all 0.2s',
                  opacity: loading ? 0.6 : 1,
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--input-focus-border)';
                  e.target.style.boxShadow = '0 0 0 3px var(--accent-primary-light)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'var(--input-border)';
                  e.target.style.boxShadow = 'var(--shadow-sm)';
                }}
              />
            </div>

            {/* Submit Button */}
            <button
              onClick={handleCreateBusiness}
              disabled={loading}
              style={{
                width: '100%',
                padding: '1rem 1.5rem',
                background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%)',
                border: 'none',
                color: '#ffffff',
                borderRadius: '0.75rem',
                cursor: loading ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                fontSize: '1rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                opacity: loading ? 0.7 : 1,
                transition: 'all 0.2s',
                boxShadow: '0 4px 12px rgba(99, 102, 241, 0.4)',
              }}
              onMouseEnter={(e) => {
                if (!loading) {
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 6px 16px rgba(99, 102, 241, 0.5)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = '0 4px 12px rgba(99, 102, 241, 0.4)';
              }}
            >
              {loading ? (
                <>
                  <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
                  Creando negocio...
                </>
              ) : (
                'Crear mi negocio'
              )}
            </button>
          </>
        )}
      </div>

      {/* Add spin animation */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .spin {
          animation: spin 1s linear infinite;
        }
      `}</style>
    </div>
  );
}
