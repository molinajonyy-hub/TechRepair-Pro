/**
 * DollarRateBadge — muestra la cotización del dólar blue con fuente y hora.
 *
 * BETA-UX-1F: el componente ya no pide la cotización por su cuenta. La lee de
 * `useDollarRate`, que la comparte entre todos los que la muestran: la variante
 * compacta vive en la barra superior (escritorio) y en la fila de utilidades
 * (mobile), las dos montadas a la vez, y entre las dos hacen UNA lectura.
 */
import { useState, useEffect } from 'react'
import { RefreshCw, AlertTriangle, Clock, MapPin, Globe, Wrench } from 'lucide-react'
import { useDollarRate } from '../../hooks/useDollarRate'
import {
  getDisplayExchangeRate,
  type DollarSource,
} from '../../services/dollarRateService'

// ─── Config de fuentes ────────────────────────────────────────────────────────

const SOURCE_INFO: Record<DollarSource, { label: string; icon: React.ReactNode; color: string }> = {
  INFODOLAR_CORDOBA: { label: 'InfoDolar Córdoba',  icon: <MapPin  size={11} />, color: '#22c55e' },
  AMBITO_NACIONAL:   { label: 'Ámbito Nacional',    icon: <Globe   size={11} />, color: '#38bdf8' },
  DOLARAPI:          { label: 'DolarAPI',            icon: <Globe   size={11} />, color: '#38bdf8' },
  DB_CACHE:          { label: 'Último valor guardado', icon: <Clock size={11} />, color: '#f59e0b' },
  MANUAL:            { label: 'Manual',              icon: <Wrench  size={11} />, color: '#818cf8' },
}

function timeAgo(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000)
  if (secs < 60) return 'hace un momento'
  if (secs < 3600) return `hace ${Math.floor(secs / 60)} min`
  if (secs < 86400) return `hace ${Math.floor(secs / 3600)} h`
  return date.toLocaleDateString('es-AR')
}

// ─── Componente ───────────────────────────────────────────────────────────────

interface DollarRateBadgeProps {
  /** 'compact': chip «USD $1.556» para barras. 'full': tarjeta con fuente y hora. */
  variant?: 'compact' | 'full'
  className?: string
}

export function DollarRateBadge({ variant = 'compact', className = '' }: DollarRateBadgeProps) {
  const { rate, loading, refresh } = useDollarRate()
  const [, setTick] = useState(0) // fuerza re-render para el timeAgo

  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  if (!rate && !loading) return null

  // Usar getDisplayExchangeRate para normalizar sell/buy
  // (defiende contra datos invertidos y garantiza que el valor principal sea siempre venta)
  const display   = rate ? getDisplayExchangeRate(rate) : null
  const srcInfo   = rate ? SOURCE_INFO[rate.source] : null
  const fmtMain   = display ? `$${display.mainValue.toLocaleString('es-AR', { maximumFractionDigits: 0 })}` : '...'

  // ── Compact ──────────────────────────────────────────────────────────────────
  // Sólo tokens de tema: el chip se lee igual en claro y en oscuro. La fuente y
  // la antigüedad no ocupan lugar en la barra: van en el título del chip, y un
  // valor que no es de ahora se marca con un ícono, no sólo con un color.
  if (variant === 'compact') {
    const aviso = rate?.warning ?? (rate?.isStale ? 'Usando el último valor guardado' : null)
    const detalle = ['Dólar blue, venta', display?.sourceLabel, rate ? timeAgo(rate.fetchedAt) : null]
      .filter(Boolean).join(' · ')
    return (
      <div
        className={`shell-chip shell-chip--dollar dollar-rate-badge ${className}`.trim()}
        data-testid="shell-dollar-chip"
        role="group"
        aria-label={display ? `Dólar blue, venta: ${fmtMain}` : 'Dólar blue, venta'}
        title={aviso ? `${detalle}. ${aviso}` : detalle}
      >
        {aviso && (
          <AlertTriangle size={13} className="shell-chip__warn" role="img" aria-label={aviso} />
        )}
        <span className="shell-chip__meta shell-chip__unit">USD</span>
        <span className="shell-chip__label shell-chip__value">{fmtMain}</span>
        <button
          type="button"
          className="shell-chip__refresh"
          onClick={() => { void refresh() }}
          disabled={loading}
          aria-label="Actualizar cotización del dólar"
          title="Actualizar cotización"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
        </button>
      </div>
    )
  }

  // ── Full ─────────────────────────────────────────────────────────────────────
  return (
    <div className={className} style={{
      padding: '0.875rem 1rem',
      background: rate?.warning
        ? 'rgba(245,158,11,0.07)'
        : rate?.isStale
          ? 'rgba(245,158,11,0.06)'
          : 'rgba(255,255,255,0.03)',
      border: `1px solid ${rate?.warning || rate?.isStale ? 'rgba(245,158,11,0.25)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 'var(--radius-lg)',
      display: 'flex', flexDirection: 'column', gap: '0.5rem',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Dólar Blue — Venta
          </span>
        </div>
        <button
          onClick={() => { void refresh() }}
          disabled={loading}
          style={{ background: 'none', border: 'none', cursor: loading ? 'default' : 'pointer', color: 'var(--text-subtle)', padding: '0.2rem', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.72rem' }}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {!loading && 'Actualizar'}
        </button>
      </div>

      {/* Valor principal — siempre precio de VENTA */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
        <span style={{ fontSize: '1.75rem', fontWeight: 800, color: srcInfo?.color ?? 'var(--text-primary)', letterSpacing: '-0.03em' }}>
          {loading ? '...' : fmtMain}
        </span>
        {/* Subtexto: compra $X, solo si es distinto al precio de venta */}
        {display?.secondaryLabel && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-subtle)' }}>
            {display.secondaryLabel}
          </span>
        )}
      </div>

      {/* Fuente y hora */}
      {rate && srcInfo && display && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--text-subtle)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', color: srcInfo.color }}>
            {srcInfo.icon} {display.sourceLabel}
          </span>
          <span>·</span>
          <span>{timeAgo(rate.fetchedAt)}</span>
        </div>
      )}

      {/* Alertas */}
      {rate?.warning && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 'var(--radius-md)', fontSize: '0.75rem', color: '#fcd34d' }}>
          <AlertTriangle size={13} style={{ flexShrink: 0 }} />
          {rate.warning}
        </div>
      )}
      {rate?.isStale && !rate.warning && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 'var(--radius-md)', fontSize: '0.75rem', color: '#fcd34d' }}>
          <AlertTriangle size={13} style={{ flexShrink: 0 }} />
          Cotización temporal. Sin conexión a la fuente — usando último valor guardado.
        </div>
      )}
    </div>
  )
}
