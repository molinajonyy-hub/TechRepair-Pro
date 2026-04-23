/**
 * MpPlatformSetup — Wizard para configurar las credenciales de la plataforma MP.
 * Solo visible para el owner/admin del negocio.
 * Guía paso a paso para crear la app en MP y configurar los secrets en Supabase.
 */
import { useState } from 'react';
import {
  CheckCircle2, Copy, ExternalLink, ChevronRight,
  AlertCircle, Terminal, Globe, Key, Zap,
} from 'lucide-react';
import logoSvg from '../../assets/logo.svg';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  supabaseProjectRef: string;   // ej. vrdxxmjzxhfgqlnxmbwx
  appUrl: string;               // URL de producción en Vercel
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MpPlatformSetup({ supabaseProjectRef, appUrl }: Props) {
  const [step, setStep] = useState(1);
  const [copied, setCopied] = useState<string | null>(null);

  const redirectUri = `${appUrl}/mp/callback`;
  const supabaseSecretsUrl = `https://supabase.com/dashboard/project/${supabaseProjectRef}/settings/edge-functions`;
  const mpDevUrl = 'https://www.mercadopago.com.ar/developers/panel/app';

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const inputS: React.CSSProperties = {
    width: '100%', padding: '0.5rem 0.875rem',
    backgroundColor: '#060d1a',
    border: '1px solid rgba(51,65,85,0.6)',
    borderRadius: '0.375rem', color: '#f1f5f9',
    fontSize: '0.8rem', fontFamily: 'monospace',
    outline: 'none', boxSizing: 'border-box',
  };

  const STEPS = [
    { n: 1, title: 'Crear aplicación en MP' },
    { n: 2, title: 'Configurar URL de callback' },
    { n: 3, title: 'Copiar credenciales' },
    { n: 4, title: 'Configurar secrets en Supabase' },
  ];

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(251,191,36,0.06), rgba(245,158,11,0.03))',
      border: '1px solid rgba(251,191,36,0.25)',
      borderRadius: '1rem',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '1.25rem 1.5rem',
        borderBottom: '1px solid rgba(251,191,36,0.15)',
        display: 'flex', alignItems: 'center', gap: '0.75rem',
      }}>
        <AlertCircle size={18} style={{ color: '#fbbf24', flexShrink: 0 }} />
        <div>
          <div style={{ fontWeight: 700, color: '#fde68a', fontSize: '0.95rem' }}>
            Configuración pendiente — Credenciales de Mercado Pago
          </div>
          <div style={{ fontSize: '0.8rem', color: '#92400e', marginTop: '0.125rem' }}>
            Completá estos 4 pasos una sola vez. Después todos los negocios podrán conectar su cuenta sin hacer nada técnico.
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ display: 'flex', padding: '1rem 1.5rem', gap: '0.5rem', alignItems: 'center', overflowX: 'auto' }}>
        {STEPS.map((s, i) => (
          <div key={s.n} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
            <button
              onClick={() => setStep(s.n)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.375rem 0.75rem',
                borderRadius: '9999px',
                border: `1px solid ${step === s.n ? '#fbbf24' : step > s.n ? 'rgba(52,211,153,0.4)' : 'rgba(255,255,255,0.08)'}`,
                backgroundColor: step === s.n ? 'rgba(251,191,36,0.15)' : step > s.n ? 'rgba(52,211,153,0.08)' : 'transparent',
                color: step === s.n ? '#fbbf24' : step > s.n ? '#34d399' : '#475569',
                fontSize: '0.75rem', fontWeight: step === s.n ? 700 : 500,
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {step > s.n ? <CheckCircle2 size={13} /> : <span style={{ fontWeight: 800 }}>{s.n}</span>}
              {s.title}
            </button>
            {i < STEPS.length - 1 && <ChevronRight size={13} style={{ color: '#334155', flexShrink: 0 }} />}
          </div>
        ))}
      </div>

      {/* Contenido del paso */}
      <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.125rem' }}>

        {/* ── PASO 1 ── */}
        {step === 1 && (
          <>
            <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '1rem', fontWeight: 700 }}>
              Paso 1 — Creá tu aplicación en el panel de desarrolladores de MP
            </h3>
            <p style={{ margin: 0, fontSize: '0.875rem', color: '#94a3b8', lineHeight: 1.7 }}>
              Esta app es la identidad de <strong style={{ color: '#f1f5f9' }}>TechRepair Pro</strong> en Mercado Pago.
              Cuando tus clientes autoricen, van a ver el nombre y logo de tu aplicación en vez del Joker.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              {[
                { n: 1, text: 'Andá al Panel de Desarrolladores de Mercado Pago', link: mpDevUrl },
                { n: 2, text: 'Iniciá sesión con la cuenta de MP de tu negocio' },
                { n: 3, text: 'Hacé click en "Crear aplicación"' },
                { n: 4, text: 'Poné nombre (ej. "TechRepair Pro") y subí tu logo' },
                { n: 5, text: 'En "¿Usás código de autorización con PKCE?" → No' },
                { n: 6, text: 'Guardá la aplicación' },
              ].map(item => (
                <div key={item.n} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                  <div style={{
                    minWidth: '1.375rem', height: '1.375rem', borderRadius: '50%',
                    background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.35)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.7rem', fontWeight: 700, color: '#fbbf24', flexShrink: 0, marginTop: '0.1rem',
                  }}>{item.n}</div>
                  <div style={{ fontSize: '0.875rem', color: '#cbd5e1', lineHeight: 1.5 }}>
                    {item.text}
                    {item.link && (
                      <a
                        href={item.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ marginLeft: '0.5rem', color: '#60a5fa', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem' }}
                      >
                        Abrir <ExternalLink size={11} />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <a
              href={mpDevUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.625rem 1.25rem',
                background: 'linear-gradient(135deg, #009ee3, #00bcff)',
                borderRadius: '0.5rem', color: '#fff',
                fontWeight: 600, fontSize: '0.875rem', textDecoration: 'none',
                width: 'fit-content',
              }}
            >
              <ExternalLink size={15} />
              Abrir Panel de Desarrolladores MP
            </a>
          </>
        )}

        {/* ── PASO 2 ── */}
        {step === 2 && (
          <>
            <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '1rem', fontWeight: 700 }}>
              Paso 2 — Configurá la URL de redireccionamiento en tu app de MP
            </h3>
            <p style={{ margin: 0, fontSize: '0.875rem', color: '#94a3b8', lineHeight: 1.7 }}>
              Dentro de la app que acabás de crear, buscá la sección <strong style={{ color: '#f1f5f9' }}>
              "Agregar URL de redireccionamiento"</strong> (OAuth → Redirect URI) y pegá esta URL exacta:
            </p>

            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.75rem 1rem',
              backgroundColor: '#060d1a',
              border: '1px solid rgba(96,165,250,0.3)',
              borderRadius: '0.5rem',
            }}>
              <Globe size={14} style={{ color: '#60a5fa', flexShrink: 0 }} />
              <code style={{ flex: 1, fontSize: '0.8rem', color: '#60a5fa', wordBreak: 'break-all' }}>
                {redirectUri}
              </code>
              <button
                onClick={() => copy(redirectUri, 'uri')}
                style={{ background: 'none', border: 'none', color: copied === 'uri' ? '#34d399' : '#475569', cursor: 'pointer', flexShrink: 0, display: 'flex', padding: '0.25rem' }}
              >
                {copied === 'uri' ? <CheckCircle2 size={15} /> : <Copy size={15} />}
              </button>
            </div>

            <div style={{ padding: '0.875rem 1rem', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '0.5rem', fontSize: '0.8rem', color: '#fde68a' }}>
              <strong>Importante:</strong> La URL debe ser exactamente esa. Si tu dominio de producción cambia, volvé a actualizar este campo en el panel de MP.
            </div>
          </>
        )}

        {/* ── PASO 3 ── */}
        {step === 3 && (
          <>
            <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '1rem', fontWeight: 700 }}>
              Paso 3 — Copiá las credenciales de tu app
            </h3>
            <p style={{ margin: 0, fontSize: '0.875rem', color: '#94a3b8', lineHeight: 1.7 }}>
              En el panel de tu app en MP vas a encontrar estos datos. Los necesitás en el Paso 4.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              {[
                { key: 'APP_ID',        label: 'App ID',        example: '1234567890123456', desc: 'Número largo que identifica tu app' },
                { key: 'CLIENT_ID',     label: 'Client ID',     example: '1234567890123456', desc: 'Igual al App ID en la mayoría de los casos' },
                { key: 'CLIENT_SECRET', label: 'Client Secret', example: 'xxxxxxxxxxxxxxxxxxxxxx', desc: 'Clave secreta — no la compartas' },
              ].map(item => (
                <div key={item.key} style={{ padding: '0.875rem 1rem', background: '#060d1a', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                    <Key size={13} style={{ color: '#fbbf24' }} />
                    <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#f1f5f9' }}>{item.label}</span>
                    <span style={{ fontSize: '0.7rem', color: '#475569' }}>— {item.desc}</span>
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#475569' }}>
                    ej: <span style={{ color: '#64748b' }}>{item.example}</span>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: '0.8rem', color: '#64748b', display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <AlertCircle size={13} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
              El Client Secret solo se muestra una vez. Si lo perdés, podés regenerarlo desde el panel de MP.
            </div>
          </>
        )}

        {/* ── PASO 4 ── */}
        {step === 4 && (
          <>
            <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '1rem', fontWeight: 700 }}>
              Paso 4 — Configurá los secrets en Supabase
            </h3>
            <p style={{ margin: 0, fontSize: '0.875rem', color: '#94a3b8', lineHeight: 1.7 }}>
              Los secrets de las Edge Functions se configuran desde el dashboard de Supabase.
              Nunca se exponen en el código ni en el navegador.
            </p>

            <a
              href={supabaseSecretsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.625rem 1.25rem',
                background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)',
                borderRadius: '0.5rem', color: '#818cf8',
                fontWeight: 600, fontSize: '0.875rem', textDecoration: 'none', width: 'fit-content',
              }}
            >
              <ExternalLink size={15} />
              Abrir Secrets de Supabase
            </a>

            <p style={{ margin: 0, fontSize: '0.875rem', color: '#94a3b8' }}>
              Una vez dentro, hacé click en <strong style={{ color: '#f1f5f9' }}>"Add new secret"</strong> y cargá estos 5 valores:
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {[
                { name: 'MP_APP_ID',        value: '← App ID del Paso 3',        required: true },
                { name: 'MP_CLIENT_ID',     value: '← Client ID del Paso 3',     required: true },
                { name: 'MP_CLIENT_SECRET', value: '← Client Secret del Paso 3', required: true },
                { name: 'MP_REDIRECT_URI',  value: redirectUri,                   required: true, copiable: true },
                { name: 'MP_ENCRYPT_KEY',   value: '← 32 caracteres aleatorios (contraseña para cifrar tokens)', required: true },
                { name: 'APP_URL',          value: appUrl,                        required: false, copiable: true },
              ].map(s => (
                <div key={s.name} style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.5rem 0.75rem',
                  backgroundColor: '#060d1a',
                  border: `1px solid ${s.required ? 'rgba(251,191,36,0.2)' : 'rgba(255,255,255,0.06)'}`,
                  borderRadius: '0.375rem',
                }}>
                  <code style={{ fontSize: '0.78rem', color: '#fbbf24', minWidth: '200px', flexShrink: 0 }}>
                    {s.name}
                  </code>
                  <span style={{ fontSize: '0.75rem', color: '#64748b', flex: 1 }}>=</span>
                  <span style={{ fontSize: '0.75rem', color: s.copiable ? '#60a5fa' : '#475569', flex: 3, wordBreak: 'break-all' }}>
                    {s.value}
                  </span>
                  {s.copiable && (
                    <button
                      onClick={() => copy(s.value, s.name)}
                      style={{ background: 'none', border: 'none', color: copied === s.name ? '#34d399' : '#475569', cursor: 'pointer', display: 'flex', padding: '0.25rem', flexShrink: 0 }}
                    >
                      {copied === s.name ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Tip clave de cifrado */}
            <div style={{ padding: '0.875rem 1rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '0.5rem' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#818cf8', marginBottom: '0.375rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                <Terminal size={13} /> Tip — Generar MP_ENCRYPT_KEY
              </div>
              <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: '#64748b', lineHeight: 1.5 }}>
                Podés usar este comando en la terminal para generar 32 caracteres seguros:
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <code style={{ flex: 1, fontSize: '0.75rem', color: '#a78bfa', backgroundColor: '#060d1a', padding: '0.375rem 0.625rem', borderRadius: '0.25rem', wordBreak: 'break-all' }}>
                  openssl rand -base64 32 | tr -d '=/+' | cut -c1-32
                </code>
                <button
                  onClick={() => copy("openssl rand -base64 32 | tr -d '=/+' | cut -c1-32", 'keycmd')}
                  style={{ background: 'none', border: 'none', color: copied === 'keycmd' ? '#34d399' : '#475569', cursor: 'pointer', display: 'flex', padding: '0.25rem', flexShrink: 0 }}
                >
                  {copied === 'keycmd' ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                </button>
              </div>
            </div>

            <div style={{ padding: '1rem', background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '0.5rem', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
              <CheckCircle2 size={16} style={{ color: '#34d399', flexShrink: 0, marginTop: '0.1rem' }} />
              <div>
                <div style={{ fontSize: '0.875rem', fontWeight: 700, color: '#34d399', marginBottom: '0.25rem' }}>
                  Una vez configurados los secrets, recargá esta página
                </div>
                <div style={{ fontSize: '0.8rem', color: '#475569', lineHeight: 1.5 }}>
                  Después hacé click en "Conectar Mercado Pago" y vas a ver el nombre y logo de <strong style={{ color: '#94a3b8' }}>tu aplicación</strong> en la pantalla de autorización de MP — sin jokers.
                </div>
              </div>
            </div>
          </>
        )}

      </div>

      {/* Footer con navegación entre pasos */}
      <div style={{
        padding: '1rem 1.5rem',
        borderTop: '1px solid rgba(255,255,255,0.05)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <button
          onClick={() => setStep(s => Math.max(1, s - 1))}
          disabled={step === 1}
          style={{
            padding: '0.5rem 1rem', background: 'transparent',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '0.375rem', color: '#64748b',
            cursor: step === 1 ? 'not-allowed' : 'pointer', fontSize: '0.8rem',
            opacity: step === 1 ? 0.4 : 1,
          }}
        >
          ← Anterior
        </button>

        <span style={{ fontSize: '0.75rem', color: '#475569' }}>
          Paso {step} de {STEPS.length}
        </span>

        {step < STEPS.length ? (
          <button
            onClick={() => setStep(s => Math.min(STEPS.length, s + 1))}
            style={{
              padding: '0.5rem 1rem',
              background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.3)',
              borderRadius: '0.375rem', color: '#fbbf24',
              cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: '0.375rem',
            }}
          >
            Siguiente <ChevronRight size={14} />
          </button>
        ) : (
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.5rem 1rem',
              background: 'linear-gradient(135deg, #009ee3, #00bcff)',
              border: 'none', borderRadius: '0.375rem', color: '#fff',
              cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: '0.375rem',
            }}
          >
            <Zap size={14} /> Verificar configuración
          </button>
        )}
      </div>
    </div>
  );
}
