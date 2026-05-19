import { useState } from 'react'
import { Smartphone, Copy, Check, Wallet, ExternalLink } from 'lucide-react'

const APP_URL = typeof window !== 'undefined'
  ? `${window.location.origin}/personal`
  : 'https://techrepairpro.app/personal'

/** QR code via free API — no extra dependency. */
function QRCode({ url }: { url: string }) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&color=34d399&bgcolor=071018&margin=0&data=${encodeURIComponent(url)}`
  return (
    <div
      data-testid="miguita-bridge-qr"
      style={{ width: 180, height: 180, borderRadius: '1rem', overflow: 'hidden', border: '2px solid rgba(52,211,153,0.3)', flexShrink: 0 }}
    >
      <img src={qrUrl} alt="QR Mi Guita" width={180} height={180} style={{ display: 'block' }} />
    </div>
  )
}

export function MiGuitaBridge() {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(APP_URL)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const el = document.createElement('textarea')
      el.value = APP_URL
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div
      data-testid="miguita-bridge-page"
      style={{
        minHeight: '100dvh',
        background: '#071018',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem 1rem',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div style={{ width: '100%', maxWidth: 520 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', marginBottom: '2rem' }}>
          <div style={{ width: 52, height: 52, borderRadius: '1rem', background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Wallet size={24} color="#34d399" />
          </div>
          <div>
            <div style={{ fontWeight: 900, fontSize: '1.5rem', color: '#f0f4ff', letterSpacing: '-0.03em' }}>Mi Guita</div>
            <div style={{ fontSize: '0.8rem', color: '#475569' }}>by TechRepair Pro</div>
          </div>
        </div>

        {/* Main card */}
        <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '1.5rem', padding: '1.75rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.75rem' }}>
            <Smartphone size={18} color="#818cf8" />
            <span style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f0f4ff' }}>Mi Guita es una app para el celular</span>
          </div>
          <p style={{ fontSize: '0.875rem', color: '#475569', lineHeight: 1.6, margin: '0 0 1.5rem' }}>
            Está diseñada para usarse desde tu smartphone. Abrila desde el celular, iniciá sesión y agregala a la pantalla de inicio para tenerla siempre a mano.
          </p>

          {/* QR + URL */}
          <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <QRCode url={APP_URL} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.72rem', color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>Escaneá con tu celular</div>
              <div style={{ fontFamily: 'monospace', fontSize: '0.8125rem', color: '#34d399', background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '0.625rem', padding: '0.5rem 0.75rem', wordBreak: 'break-all', marginBottom: '0.875rem' }}>
                {APP_URL}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  data-testid="miguita-bridge-copy-link"
                  onClick={handleCopy}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', borderRadius: '0.625rem', background: copied ? 'rgba(52,211,153,0.15)' : 'rgba(255,255,255,0.05)', border: `1px solid ${copied ? 'rgba(52,211,153,0.4)' : 'rgba(255,255,255,0.1)'}`, color: copied ? '#34d399' : '#94a3b8', fontWeight: 600, fontSize: '0.8125rem', cursor: 'pointer', minHeight: 36 }}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? '¡Copiado!' : 'Copiar link'}
                </button>
                <a
                  data-testid="miguita-bridge-open-mobile"
                  href="/personal"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.875rem', borderRadius: '0.625rem', background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.2)', color: '#818cf8', fontWeight: 600, fontSize: '0.8125rem', cursor: 'pointer', textDecoration: 'none', minHeight: 36 }}
                >
                  <ExternalLink size={13} /> Abrir igual
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Install steps */}
        <div
          data-testid="miguita-bridge-install-steps"
          style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '1.25rem', padding: '1.25rem' }}
        >
          <div style={{ fontWeight: 700, fontSize: '0.875rem', color: '#f0f4ff', marginBottom: '1rem' }}>Cómo instalar como app</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>iPhone / iOS</div>
              {['Abrí el link desde Safari.', 'Tocá el botón Compartir (□↑).', 'Elegí "Agregar a inicio".', 'Abrí Mi Guita desde el icono.'].map((step, i) => (
                <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.375rem', fontSize: '0.8125rem', color: '#475569' }}>
                  <span style={{ color: '#818cf8', fontWeight: 700, flexShrink: 0 }}>{i + 1}.</span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>Android / Chrome</div>
              {['Abrí el link desde Chrome.', 'Tocá el menú ⋮.', 'Elegí "Instalar app" o "Agregar a inicio".', 'Abrí Mi Guita desde el icono.'].map((step, i) => (
                <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.375rem', fontSize: '0.8125rem', color: '#475569' }}>
                  <span style={{ color: '#34d399', fontWeight: 700, flexShrink: 0 }}>{i + 1}.</span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginTop: '1.5rem', textAlign: 'center', fontSize: '0.75rem', color: '#1e3a5f' }}>
          TechRepair Pro · Mi Guita es personal — tu privacidad está protegida por user_id
        </div>
      </div>
    </div>
  )
}
