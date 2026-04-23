import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import logoSvg from '../assets/logo.svg';

/**
 * Página de callback OAuth de Mercado Pago.
 * MP redirige aquí con ?code=...&state=... tras la autorización.
 * Llama a la Edge Function mp-oauth con action=callback,
 * guarda los tokens y redirige a Configuración > Cobros.
 */
export function MpCallback() {
  const [searchParams] = useSearchParams();
  const { businessId } = useAuth();

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Conectando con Mercado Pago...');

  useEffect(() => {
    const code  = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      setStatus('error');
      setMessage('Autorización cancelada o rechazada por Mercado Pago.');
      setTimeout(() => { window.location.href = '/settings'; }, 3000);
      return;
    }

    if (!code || !state) {
      setStatus('error');
      setMessage('Parámetros inválidos en la URL de callback.');
      setTimeout(() => { window.location.href = '/settings'; }, 3000);
      return;
    }

    // Extraer business_id del state (lo pusimos al generar la URL)
    let bizId = businessId;
    try {
      const decoded = JSON.parse(atob(state));
      if (decoded.business_id) bizId = decoded.business_id;
    } catch { /* usar businessId del contexto */ }

    supabase.functions
      .invoke('mp-oauth', {
        body: { action: 'callback', code, state, business_id: bizId },
      })
      .then(({ data, error: fnError }) => {
        if (fnError || data?.error) {
          setStatus('error');
          setMessage(fnError?.message ?? data?.error ?? 'Error al conectar con Mercado Pago.');
          setTimeout(() => { window.location.href = '/settings?tab=pagos'; }, 4000);
        } else {
          setStatus('success');
          setMessage('¡Mercado Pago conectado correctamente!');
          setTimeout(() => { window.location.href = '/settings?tab=pagos'; }, 2000);
        }
      })
      .catch(err => {
        setStatus('error');
        setMessage(err?.message ?? 'Error inesperado.');
        setTimeout(() => { window.location.href = '/settings?tab=pagos'; }, 4000);
      });
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundColor: '#060d1a',
    }}>
      <div style={{
        backgroundColor: '#0b1120',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '1rem',
        padding: '2.5rem',
        textAlign: 'center',
        maxWidth: '420px',
        width: '100%',
        margin: '1rem',
      }}>
        {/* Logos: TechRepair + MP */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: '0.75rem', margin: '0 auto 1.5rem',
        }}>
          <img
            src={logoSvg}
            alt="TechRepair Pro"
            style={{ width: '3.5rem', height: '3.5rem', borderRadius: '0.875rem' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <div style={{ width: '1.5rem', height: '2px', background: 'rgba(255,255,255,0.15)', borderRadius: '2px' }} />
            <div style={{ width: '1.5rem', height: '2px', background: 'rgba(255,255,255,0.15)', borderRadius: '2px' }} />
          </div>
          <div style={{
            width: '3.5rem', height: '3.5rem', borderRadius: '0.875rem',
            background: 'linear-gradient(135deg, #009ee3, #00bcff)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.5rem',
          }}>💳</div>
        </div>

        {status === 'loading' && (
          <>
            <Loader2 size={32} style={{ color: '#6366f1', animation: 'spin 1s linear infinite', marginBottom: '1rem' }} />
            <h2 style={{ color: '#f1f5f9', fontSize: '1.125rem', fontWeight: 700, margin: '0 0 0.5rem' }}>
              Conectando con Mercado Pago
            </h2>
            <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>{message}</p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle2 size={40} style={{ color: '#34d399', marginBottom: '1rem' }} />
            <h2 style={{ color: '#f1f5f9', fontSize: '1.125rem', fontWeight: 700, margin: '0 0 0.5rem' }}>
              ¡Listo!
            </h2>
            <p style={{ color: '#34d399', fontSize: '0.875rem', margin: '0 0 1rem' }}>{message}</p>
            <p style={{ color: '#475569', fontSize: '0.8rem', margin: 0 }}>
              Redirigiendo a Configuración...
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <AlertCircle size={40} style={{ color: '#f87171', marginBottom: '1rem' }} />
            <h2 style={{ color: '#f1f5f9', fontSize: '1.125rem', fontWeight: 700, margin: '0 0 0.5rem' }}>
              Error de conexión
            </h2>
            <p style={{ color: '#f87171', fontSize: '0.875rem', margin: '0 0 1rem' }}>{message}</p>
            <p style={{ color: '#475569', fontSize: '0.8rem', margin: 0 }}>
              Redirigiendo a Configuración...
            </p>
          </>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
