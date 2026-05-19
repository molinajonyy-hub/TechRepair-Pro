/** Shared micro-components for Mi Guita. Mobile-first, dark theme. */
import { Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { useEffect, useRef } from 'react'

// ── Token ─────────────────────────────────────────────────────────────────────
// Minimum font size for iOS: 16px prevents auto-zoom on input focus
const INPUT_FONT_SIZE = '1rem'   // 16px

// ── Money formatting ────────────────────────────────────────────────────────

export const fmtMoney = (n: number | string, currency = 'ARS') =>
  new Intl.NumberFormat('es-AR', {
    style: 'currency', currency,
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(Number(n) || 0)

export const fmtMoneyCompact = (n: number | string): string => {
  const num = Number(n) || 0
  const abs = Math.abs(num)
  const sign = num < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}k`
  return `${sign}$${abs.toFixed(0)}`
}

// ── Toast ─────────────────────────────────────────────────────────────────────

export interface ToastOptions {
  message: string
  type?: 'success' | 'error'
  duration?: number
}

let _toastFn: ((opts: ToastOptions) => void) | null = null

export function showToast(opts: ToastOptions) {
  _toastFn?.(opts)
}

export function ToastProvider() {
  const [items, setItems] = React.useState<Array<ToastOptions & { id: number }>>([])
  const counter = useRef(0)

  useEffect(() => {
    _toastFn = (opts) => {
      const id = ++counter.current
      setItems(prev => [...prev, { ...opts, id }])
      setTimeout(() => {
        setItems(prev => prev.filter(t => t.id !== id))
      }, opts.duration ?? 3000)
    }
    return () => { _toastFn = null }
  }, [])

  return (
    <div style={{ position: 'fixed', bottom: '6rem', left: '50%', transform: 'translateX(-50%)', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '0.5rem', pointerEvents: 'none', width: '90%', maxWidth: 360 }}>
      {items.map(t => (
        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.75rem 1rem', borderRadius: '0.875rem', background: t.type === 'error' ? 'rgba(248,113,113,0.18)' : 'rgba(52,211,153,0.18)', border: `1px solid ${t.type === 'error' ? 'rgba(248,113,113,0.4)' : 'rgba(52,211,153,0.4)'}`, boxShadow: '0 4px 24px rgba(0,0,0,0.4)', backdropFilter: 'blur(12px)', animation: 'personal-slideup 0.22s ease' }}>
          {t.type === 'error'
            ? <XCircle size={16} color="#f87171" style={{ flexShrink: 0 }} />
            : <CheckCircle2 size={16} color="#34d399" style={{ flexShrink: 0 }} />}
          <span style={{ color: t.type === 'error' ? '#fca5a5' : '#a7f3d0', fontWeight: 600, fontSize: '0.875rem' }}>{t.message}</span>
        </div>
      ))}
      <style>{`
        @keyframes personal-slideup {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}

// React must be imported for ToastProvider JSX
import React from 'react'

// ── Summary card ────────────────────────────────────────────────────────────

interface SummaryCardProps {
  label: string
  value: string
  sub?: string
  color?: string
  accent?: string
  icon?: React.ReactNode
  testId?: string
}

export function SummaryCard({ label, value, sub, color = '#34d399', accent = 'rgba(52,211,153,0.08)', icon, testId }: SummaryCardProps) {
  return (
    <div data-testid={testId} style={{ background: accent, border: `1px solid ${color}25`, borderRadius: '1rem', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '0.7rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
        {icon && <span style={{ color: '#334155' }}>{icon}</span>}
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 900, color, letterSpacing: '-0.03em', lineHeight: 1, fontFamily: 'monospace' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.72rem', color: '#334155' }}>{sub}</div>}
    </div>
  )
}

// ── Section header ──────────────────────────────────────────────────────────

export function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 1rem', marginBottom: '0.5rem', marginTop: '0.25rem' }}>
      <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{title}</span>
      {action}
    </div>
  )
}

// ── Transaction row ─────────────────────────────────────────────────────────

export function TxRow({ icon, label, sub, amount, type, onClick, testId }: {
  icon?: React.ReactNode; label: string; sub?: string
  amount: number; type: 'income' | 'expense' | 'transfer'
  onClick?: () => void; testId?: string
}) {
  const color = type === 'income' ? '#34d399' : type === 'expense' ? '#f87171' : '#60a5fa'
  const sign  = type === 'income' ? '+' : type === 'expense' ? '−' : '↔'
  return (
    <div data-testid={testId}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', padding: '0.75rem 1rem', cursor: onClick ? 'pointer' : 'default', borderBottom: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.1s' }}
      onPointerEnter={e => { if (onClick) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.025)' }}
      onPointerLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >
      <div style={{ width: 38, height: 38, borderRadius: '0.75rem', background: `${color}18`, border: `1px solid ${color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color }}>
        {icon || <span style={{ fontSize: '1rem' }}>·</span>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#f0f4ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
        {sub && <div style={{ fontSize: '0.72rem', color: '#334155', marginTop: '0.1rem' }}>{sub}</div>}
      </div>
      <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '0.9375rem', color, flexShrink: 0 }}>
        {sign}{fmtMoneyCompact(Math.abs(amount))}
      </div>
    </div>
  )
}

// ── Empty state ─────────────────────────────────────────────────────────────

export function EmptyPersonal({ icon, title, description, cta, onCta, testId }: {
  icon: React.ReactNode; title: string; description: string
  cta?: string; onCta?: () => void; testId?: string
}) {
  return (
    <div data-testid={testId} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '3rem 1.5rem', textAlign: 'center', gap: '0.75rem' }}>
      <div style={{ width: 56, height: 56, borderRadius: '1rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#334155', marginBottom: '0.25rem' }}>
        {icon}
      </div>
      <div style={{ fontWeight: 700, color: '#94a3b8', fontSize: '0.9375rem' }}>{title}</div>
      <div style={{ color: '#334155', fontSize: '0.8rem', lineHeight: 1.5 }}>{description}</div>
      {cta && onCta && (
        <button onClick={onCta} style={{ marginTop: '0.5rem', padding: '0.625rem 1.25rem', background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: '0.75rem', color: '#34d399', fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', minHeight: 44 }}>
          {cta}
        </button>
      )}
    </div>
  )
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

export function PersonalLoading() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '3rem', gap: '0.75rem', color: '#334155' }}>
      <Loader2 size={28} style={{ animation: 'tr-spin 0.8s linear infinite', color: '#34d399' }} />
      <span style={{ fontSize: '0.8rem' }}>Cargando...</span>
    </div>
  )
}

// ── Skeleton card ─────────────────────────────────────────────────────────────

export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '1rem', overflow: 'hidden' }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.875rem 1rem', borderBottom: i < rows - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
          <div style={{ width: 36, height: 36, borderRadius: '0.75rem', background: 'rgba(255,255,255,0.05)', animation: 'skeleton-pulse 1.5s ease infinite' }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            <div style={{ height: 12, width: '60%', borderRadius: 4, background: 'rgba(255,255,255,0.05)', animation: 'skeleton-pulse 1.5s ease infinite' }} />
            <div style={{ height: 10, width: '40%', borderRadius: 4, background: 'rgba(255,255,255,0.04)', animation: 'skeleton-pulse 1.5s ease infinite 0.2s' }} />
          </div>
          <div style={{ height: 14, width: 64, borderRadius: 4, background: 'rgba(255,255,255,0.05)', animation: 'skeleton-pulse 1.5s ease infinite 0.1s' }} />
        </div>
      ))}
      <style>{`
        @keyframes skeleton-pulse { 0%,100%{opacity:0.5} 50%{opacity:1} }
      `}</style>
    </div>
  )
}

// ── Page container ───────────────────────────────────────────────────────────

export function PageContainer({ children, style, testId }: { children: React.ReactNode; style?: React.CSSProperties; testId?: string }) {
  return (
    <div data-testid={testId} style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem', ...style }}>
      {children}
    </div>
  )
}

// ── Primary action button ─────────────────────────────────────────────────────

export function PrimaryBtn({ children, onClick, disabled, loading, fullWidth = false, testId }: {
  children: React.ReactNode; onClick?: () => void
  disabled?: boolean; loading?: boolean; fullWidth?: boolean; testId?: string
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick} disabled={disabled || loading}
      style={{
        width: fullWidth ? '100%' : undefined,
        minHeight: 48, // comfortable tap target
        padding: '0.875rem 1.5rem',
        background: disabled || loading ? 'rgba(52,211,153,0.08)' : 'rgba(52,211,153,0.18)',
        border: `1px solid rgba(52,211,153,${disabled || loading ? '0.15' : '0.4'})`,
        borderRadius: '0.875rem', color: '#34d399',
        fontWeight: 800, fontSize: INPUT_FONT_SIZE, cursor: disabled || loading ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
        transition: 'all 0.15s', opacity: disabled ? 0.5 : 1,
      }}
    >
      {loading && <Loader2 size={16} style={{ animation: 'tr-spin 0.8s linear infinite' }} />}
      {children}
    </button>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────────

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '1rem', overflow: 'hidden', ...style }}>
      {children}
    </div>
  )
}

// ── Input (16px min to prevent iOS zoom) ──────────────────────────────────────

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string; error?: string; testId?: string
}
export function PersonalInput({ label, error, style, testId, ...props }: InputProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      {label && <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</label>}
      <input
        data-testid={testId}
        {...props}
        style={{
          width: '100%', padding: '0.75rem', boxSizing: 'border-box',
          background: 'rgba(255,255,255,0.04)',
          border: `1px solid ${error ? 'rgba(248,113,113,0.5)' : 'rgba(255,255,255,0.08)'}`,
          borderRadius: '0.75rem', color: '#f0f4ff',
          fontSize: INPUT_FONT_SIZE, // 16px — prevents iOS zoom!
          outline: 'none',
          minHeight: 44, // comfortable tap target
          ...style,
        }}
        onFocus={e => (e.currentTarget.style.borderColor = error ? 'rgba(248,113,113,0.7)' : 'rgba(52,211,153,0.4)')}
        onBlur={e => (e.currentTarget.style.borderColor = error ? 'rgba(248,113,113,0.5)' : 'rgba(255,255,255,0.08)')}
      />
      {error && <span style={{ fontSize: '0.72rem', color: '#f87171' }}>{error}</span>}
    </div>
  )
}

// ── Select (16px min for iOS) ──────────────────────────────────────────────────

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string; testId?: string
}
export function PersonalSelect({ label, children, style, testId, ...props }: SelectProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      {label && <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</label>}
      <select
        data-testid={testId}
        {...props}
        style={{
          width: '100%', padding: '0.75rem', boxSizing: 'border-box',
          background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '0.75rem', color: '#f0f4ff',
          fontSize: INPUT_FONT_SIZE, // 16px — prevents iOS zoom!
          outline: 'none', cursor: 'pointer',
          minHeight: 44,
          ...style,
        }}
      >
        {children}
      </select>
    </div>
  )
}
