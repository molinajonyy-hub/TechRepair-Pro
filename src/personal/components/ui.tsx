/** Shared micro-components for Mi Guita. Mobile-first, dark theme. */
import { Loader2 } from 'lucide-react'

const F = 'Inter, system-ui, sans-serif'

// ── Money formatting ────────────────────────────────────────────────────────

export const fmtMoney = (n: number, currency = 'ARS') =>
  new Intl.NumberFormat('es-AR', {
    style: 'currency', currency,
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n)

export const fmtMoneyCompact = (n: number): string => {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}k`
  return `${sign}$${abs.toFixed(0)}`
}

// ── Summary card ────────────────────────────────────────────────────────────

interface SummaryCardProps {
  label: string
  value: string
  sub?: string
  color?: string
  accent?: string
  icon?: React.ReactNode
}

export function SummaryCard({ label, value, sub, color = '#34d399', accent = 'rgba(52,211,153,0.08)', icon }: SummaryCardProps) {
  return (
    <div style={{
      background: accent, border: `1px solid ${color}25`,
      borderRadius: '1rem', padding: '1rem',
      display: 'flex', flexDirection: 'column', gap: '0.25rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '0.7rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
        {icon && <span style={{ color: '#334155' }}>{icon}</span>}
      </div>
      <div style={{ fontSize: '1.625rem', fontWeight: 900, color, letterSpacing: '-0.03em', lineHeight: 1, fontFamily: 'monospace' }}>
        {value}
      </div>
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

export function TxRow({ icon, label, sub, amount, type, onClick }: {
  icon?: React.ReactNode; label: string; sub?: string
  amount: number; type: 'income' | 'expense' | 'transfer'; onClick?: () => void
}) {
  const color = type === 'income' ? '#34d399' : type === 'expense' ? '#f87171' : '#60a5fa'
  const sign = type === 'income' ? '+' : type === 'expense' ? '−' : '↔'
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '0.875rem',
        padding: '0.75rem 1rem', cursor: onClick ? 'pointer' : 'default',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => { if (onClick) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.025)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >
      <div style={{
        width: 38, height: 38, borderRadius: '0.75rem',
        background: `${color}18`, border: `1px solid ${color}30`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, color,
      }}>
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

export function EmptyPersonal({ icon, title, description, cta, onCta }: {
  icon: React.ReactNode; title: string; description: string
  cta?: string; onCta?: () => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '3rem 1.5rem', textAlign: 'center', gap: '0.75rem' }}>
      <div style={{ width: 56, height: 56, borderRadius: '1rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#334155', marginBottom: '0.25rem' }}>
        {icon}
      </div>
      <div style={{ fontWeight: 700, color: '#94a3b8', fontSize: '0.9375rem' }}>{title}</div>
      <div style={{ color: '#334155', fontSize: '0.8rem', lineHeight: 1.5 }}>{description}</div>
      {cta && onCta && (
        <button onClick={onCta} style={{ marginTop: '0.5rem', padding: '0.625rem 1.25rem', background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: '0.75rem', color: '#34d399', fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>
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

// ── Page container ───────────────────────────────────────────────────────────

export function PageContainer({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem', ...style }}>
      {children}
    </div>
  )
}

// ── Primary action button ─────────────────────────────────────────────────────

export function PrimaryBtn({ children, onClick, disabled, loading, fullWidth = false }: {
  children: React.ReactNode; onClick?: () => void
  disabled?: boolean; loading?: boolean; fullWidth?: boolean
}) {
  return (
    <button
      onClick={onClick} disabled={disabled || loading}
      style={{
        width: fullWidth ? '100%' : undefined,
        padding: '0.875rem 1.5rem',
        background: disabled || loading ? 'rgba(52,211,153,0.08)' : 'rgba(52,211,153,0.18)',
        border: `1px solid rgba(52,211,153,${disabled || loading ? '0.15' : '0.4'})`,
        borderRadius: '0.875rem', color: '#34d399',
        fontWeight: 800, fontSize: '1rem', cursor: disabled || loading ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
        fontFamily: F, transition: 'all 0.15s',
        opacity: disabled ? 0.5 : 1,
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
    <div style={{
      background: 'rgba(255,255,255,0.025)',
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: '1rem', overflow: 'hidden',
      ...style,
    }}>
      {children}
    </div>
  )
}

// ── Input ─────────────────────────────────────────────────────────────────────

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string; error?: string
}
export function PersonalInput({ label, error, style, ...props }: InputProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      {label && <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</label>}
      <input
        {...props}
        style={{
          width: '100%', padding: '0.75rem', boxSizing: 'border-box',
          background: 'rgba(255,255,255,0.04)', border: `1px solid ${error ? 'rgba(248,113,113,0.5)' : 'rgba(255,255,255,0.08)'}`,
          borderRadius: '0.75rem', color: '#f0f4ff', fontSize: '1rem',
          outline: 'none', fontFamily: F,
          ...style,
        }}
        onFocus={e => (e.currentTarget.style.borderColor = error ? 'rgba(248,113,113,0.7)' : 'rgba(52,211,153,0.4)')}
        onBlur={e => (e.currentTarget.style.borderColor = error ? 'rgba(248,113,113,0.5)' : 'rgba(255,255,255,0.08)')}
      />
      {error && <span style={{ fontSize: '0.72rem', color: '#f87171' }}>{error}</span>}
    </div>
  )
}

// ── Select ────────────────────────────────────────────────────────────────────

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
}
export function PersonalSelect({ label, children, style, ...props }: SelectProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      {label && <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</label>}
      <select
        {...props}
        style={{
          width: '100%', padding: '0.75rem', boxSizing: 'border-box',
          background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '0.75rem', color: '#f0f4ff', fontSize: '1rem',
          outline: 'none', fontFamily: F, cursor: 'pointer',
          ...style,
        }}
      >
        {children}
      </select>
    </div>
  )
}
