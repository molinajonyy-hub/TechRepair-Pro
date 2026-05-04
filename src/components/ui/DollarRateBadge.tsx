/**
 * DollarRateBadge — muestra la cotización del dólar blue con fuente y hora.
 * Usa dollarRateService para obtener el valor con fallback automático.
 */
import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, AlertTriangle, Clock, MapPin, Globe, Wrench } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import {
  getCurrentDollarRate,
  refreshDollarRate,
  type DollarRateResult,
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
  /** 'compact' solo muestra el número y fuente en una línea */
  variant?: 'compact' | 'full'
  /** Si true, auto-refresca al montar */
  autoRefresh?: boolean
  className?: string
}

export function DollarRateBadge({ variant = 'compact', autoRefresh = false, className = '' }: DollarRateBadgeProps) {
  const { businessId } = useAuth()
  const [rate, setRate]       = useState<DollarRateResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [, setTick]           = useState(0) // fuerza re-render para el timeAgo

  const load = useCallback(async (force = false) => {
    if (!businessId) return
    setLoading(true)
    try {
      const result = force
        ? await refreshDollarRate(businessId, true)
        : await getCurrentDollarRate(businessId)
      setRate(result)
    } finally {
      setLoading(false)
    }
  }, [businessId])

  useEffect(() => {
    if (autoRefresh) { load(true) } else { load(false) }
    // Actualizar el timeAgo cada minuto
    const t = setInterval(() => setTick(n => n + 1), 60_000)
    return () => clearInterval(t)
  }, [load, autoRefresh])

  if (!rate && !loading) return null

  const srcInfo = rate ? SOURCE_INFO[rate.source] : null
  const fmtRate = rate ? `$${rate.sellPrice.toLocaleString('es-AR', { maximumFractionDigits: 0 })}` : '...'

  // ── Compact ──────────────────────────────────────────────────────────────────
  if (variant === 'compact') {
    return (
      <div className={`dollar-rate-badge ${className}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
        {rate?.warning && (
          <AlertTriangle size={13} style={{ color: '#f59e0b', flexShrink: 0 }} aria-label={rate.warning} />
        )}
        {rate?.isStale && !rate.warning && (
          <AlertTriangle size={13} style={{ color: '#f59e0b', flexShrink: 0 }} aria-label="Usando último valor guardado" />
        )}
        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: srcInfo?.color ?? 'var(--text-secondary)' }}>
          USD {fmtRate}
        </span>
        {srcInfo && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.68rem', color: 'var(--text-subtle)' }}>
            {srcInfo.icon} {rate?.source === 'INFODOLAR_CORDOBA' ? 'Cba.' : srcInfo.label}
          </span>
        )}
        <button
          onClick={() => load(true)}
          disabled={loading}
          title="Actualizar cotización"
          style={{ background: 'none', border: 'none', cursor: loading ? 'default' : 'pointer', padding: '0.1rem', color: 'var(--text-subtle)', display: 'inline-flex', alignItems: 'center' }}
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
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
          onClick={() => load(true)}
          disabled={loading}
          style={{ background: 'none', border: 'none', cursor: loading ? 'default' : 'pointer', color: 'var(--text-subtle)', padding: '0.2rem', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.72rem' }}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {!loading && 'Actualizar'}
        </button>
      </div>

      {/* Valor */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
        <span style={{ fontSize: '1.75rem', fontWeight: 800, color: srcInfo?.color ?? 'var(--text-primary)', letterSpacing: '-0.03em' }}>
          {fmtRate}
        </span>
        {rate?.buyPrice ? (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-subtle)' }}>
            compra ${rate.buyPrice.toLocaleString('es-AR', { maximumFractionDigits: 0 })}
          </span>
        ) : null}
      </div>

      {/* Fuente y hora */}
      {rate && srcInfo && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--text-subtle)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', color: srcInfo.color }}>
            {srcInfo.icon} {srcInfo.label}
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
