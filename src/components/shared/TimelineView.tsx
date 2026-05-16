/**
 * TimelineView — extracto cronológico premium y reutilizable.
 *
 * Reemplaza las tablas planas de movimientos con una vista visual
 * tipo Stripe/Linear: línea vertical, iconos de evento, tiempo relativo,
 * badges de monto y saldo running.
 *
 * Uso:
 *   <TimelineView events={events} loading={loading} emptyTitle="Sin movimientos" />
 */
import { memo, useMemo } from 'react'
import {
  ArrowUpRight, ArrowDownRight, Package, ShoppingCart, RotateCcw,
  SlidersHorizontal, FileText, TruckIcon, RefreshCw, ClipboardList, Wrench as WrenchIcon,
  type LucideIcon,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

export type TimelineEventType =
  | 'payment'        // pago recibido / realizado
  | 'debt'           // deuda generada
  | 'sale'           // venta
  | 'purchase'       // compra proveedor
  | 'stock_in'       // ingreso stock
  | 'stock_out'      // salida stock
  | 'adjustment'     // ajuste manual
  | 'cancellation'   // anulación / reverso
  | 'credit_note'    // nota de crédito
  | 'status'         // cambio de estado
  | 'note'           // nota interna
  | 'order_usage'    // uso en orden de servicio
  | 'return'         // devolución

export interface TimelineEvent {
  id:           string
  date:         string     // ISO — puede ser date o datetime
  type:         TimelineEventType
  title:        string
  subtitle?:    string
  amount?:      number     // monto del movimiento
  amountSign?:  '+' | '-' // fuerza signo visual
  balance?:     number     // saldo running_total después del movimiento
  currency?:    'ARS' | 'USD'
  user?:        string     // quién lo hizo
  reference?:   string     // número de comprobante, orden, etc.
  badge?:       string     // etiqueta extra (p.ej. "Parcial", "Pendiente")
  badgeColor?:  string
  note?:        string
}

// ─── Config visual por tipo ───────────────────────────────────────────────────

interface EventMeta {
  icon:   LucideIcon
  color:  string
  bg:     string
  label:  string
}

const EVENT_META: Record<TimelineEventType, EventMeta> = {
  payment:     { icon: ArrowDownRight, color: '#34d399', bg: 'rgba(52,211,153,0.12)',  label: 'Pago'         },
  debt:        { icon: ArrowUpRight,   color: '#f87171', bg: 'rgba(248,113,113,0.12)', label: 'Deuda'        },
  sale:        { icon: ShoppingCart,   color: '#818cf8', bg: 'rgba(129,140,248,0.12)', label: 'Venta'        },
  purchase:    { icon: TruckIcon,      color: '#fbbf24', bg: 'rgba(251,191,36,0.12)',  label: 'Compra'       },
  stock_in:    { icon: Package,        color: '#22c55e', bg: 'rgba(34,197,94,0.12)',   label: 'Ingreso'      },
  stock_out:   { icon: Package,        color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   label: 'Salida'       },
  adjustment:  { icon: SlidersHorizontal, color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', label: 'Ajuste'   },
  cancellation:{ icon: RotateCcw,     color: '#f87171', bg: 'rgba(248,113,113,0.12)', label: 'Anulación'    },
  credit_note: { icon: FileText,       color: '#60a5fa', bg: 'rgba(96,165,250,0.12)',  label: 'Nota crédito' },
  status:      { icon: RefreshCw,     color: '#a78bfa', bg: 'rgba(167,139,250,0.12)', label: 'Estado'       },
  note:        { icon: ClipboardList, color: '#64748b', bg: 'rgba(100,116,139,0.12)', label: 'Nota'         },
  order_usage: { icon: WrenchIcon,      color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  label: 'Uso en orden' },
  return:      { icon: RotateCcw,     color: '#34d399', bg: 'rgba(52,211,153,0.12)',  label: 'Devolución'   },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────


const fmtARS  = (n: number) => `$${Math.abs(Math.round(n)).toLocaleString('es-AR')}`
const fmtUSD  = (n: number) => `USD ${Math.abs(n).toFixed(2)}`

function relativeTime(isoDate: string): string {
  const now  = Date.now()
  const then = new Date(isoDate).getTime()
  const diff = now - then
  const min  = Math.floor(diff / 60_000)
  if (min < 2)   return 'Ahora'
  if (min < 60)  return `Hace ${min} min`
  const hs = Math.floor(min / 60)
  if (hs < 24)   return `Hace ${hs} h`
  const days = Math.floor(hs / 24)
  if (days === 1)  return 'Ayer'
  if (days < 7)    return `Hace ${days} días`
  if (days < 30)   return `Hace ${Math.floor(days / 7)} sem`
  if (days < 365)  return `Hace ${Math.floor(days / 30)} meses`
  return `Hace ${Math.floor(days / 365)} años`
}

function fmtAbsDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ─── EventRow ────────────────────────────────────────────────────────────────

interface EventRowProps {
  event:    TimelineEvent
  isLast:   boolean
}

const EventRow = memo(function EventRow({ event, isLast }: EventRowProps) {
  const meta     = EVENT_META[event.type] ?? EVENT_META.adjustment
  const Icon     = meta.icon
  const fmtAmt   = event.currency === 'USD' ? fmtUSD : fmtARS
  const relTime  = relativeTime(event.date)
  const absDate  = fmtAbsDate(event.date)

  const amtColor = event.amountSign === '+'
    ? '#34d399'
    : event.amountSign === '-'
    ? '#f87171'
    : event.amount != null
    ? (event.amount >= 0 ? '#34d399' : '#f87171')
    : undefined

  return (
    <div style={{ display: 'flex', gap: '0.875rem', position: 'relative', paddingBottom: isLast ? 0 : '1rem' }}>
      {/* Vertical line */}
      {!isLast && (
        <div style={{ position: 'absolute', left: '1.25rem', top: '2.25rem', width: 1, bottom: 0, background: 'linear-gradient(to bottom, rgba(255,255,255,0.06), transparent)', zIndex: 0 }} />
      )}

      {/* Icon dot */}
      <div style={{ flexShrink: 0, width: 40, height: 40, borderRadius: '50%', background: meta.bg, border: `1.5px solid ${meta.color}28`, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 1, marginTop: '0.125rem' }}>
        <Icon size={16} color={meta.color} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, paddingTop: '0.125rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem' }}>
          <div style={{ minWidth: 0 }}>
            {/* Title row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' as const }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.3 }}>
                {event.title}
              </span>
              {event.badge && (
                <span style={{ fontSize: '0.63rem', fontWeight: 700, padding: '0.1rem 0.4rem', borderRadius: '0.25rem', background: `${event.badgeColor ?? meta.color}18`, color: event.badgeColor ?? meta.color, textTransform: 'uppercase' as const, letterSpacing: '0.04em', flexShrink: 0 }}>
                  {event.badge}
                </span>
              )}
              {event.reference && (
                <span style={{ fontSize: '0.68rem', color: '#475569', fontFamily: 'monospace', flexShrink: 0 }}>
                  #{event.reference}
                </span>
              )}
            </div>

            {/* Subtitle */}
            {event.subtitle && (
              <p style={{ margin: '0.15rem 0 0', fontSize: '0.73rem', color: '#475569', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, maxWidth: 260 }}>
                {event.subtitle}
              </p>
            )}

            {/* Meta row: user + note */}
            {(event.user || event.note) && (
              <p style={{ margin: '0.2rem 0 0', fontSize: '0.68rem', color: '#334155', display: 'flex', gap: '0.4rem', alignItems: 'center' as const }}>
                {event.user && <span>· {event.user}</span>}
                {event.note && <span style={{ color: '#475569', fontStyle: 'italic' }}>"{event.note}"</span>}
              </p>
            )}
          </div>

          {/* Right side: amount + balance + time */}
          <div style={{ flexShrink: 0, textAlign: 'right' }}>
            {event.amount != null && (
              <div style={{ fontSize: '0.875rem', fontWeight: 800, fontFamily: 'monospace', color: amtColor ?? meta.color, letterSpacing: '-0.01em' }}>
                {event.amountSign === '+' ? '+' : event.amountSign === '-' ? '−' : event.amount < 0 ? '−' : ''}
                {fmtAmt(event.amount)}
              </div>
            )}
            {event.balance != null && (
              <div style={{ fontSize: '0.68rem', color: '#475569', fontFamily: 'monospace', marginTop: '0.1rem' }}>
                Saldo {fmtARS(event.balance)}
              </div>
            )}
            <div style={{ fontSize: '0.65rem', color: '#334155', marginTop: '0.15rem' }} title={absDate}>
              {relTime}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})

// ─── Skeleton ────────────────────────────────────────────────────────────────

function TimelineSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.25rem 0' }}>
      {[1, 2, 3, 4].map(i => (
        <div key={i} style={{ display: 'flex', gap: '0.875rem', opacity: 1 - i * 0.18 }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', flexShrink: 0 }} />
          <div style={{ flex: 1, paddingTop: '0.25rem' }}>
            <div style={{ height: 12, width: '55%', borderRadius: 6, background: 'rgba(255,255,255,0.05)', marginBottom: '0.4rem' }} />
            <div style={{ height: 10, width: '35%', borderRadius: 6, background: 'rgba(255,255,255,0.03)' }} />
          </div>
          <div style={{ flexShrink: 0, textAlign: 'right', paddingTop: '0.25rem' }}>
            <div style={{ height: 14, width: 64, borderRadius: 6, background: 'rgba(255,255,255,0.05)', marginBottom: '0.3rem' }} />
            <div style={{ height: 10, width: 40, borderRadius: 6, background: 'rgba(255,255,255,0.03)' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Group by date ─────────────────────────────────────────────────────────

function groupByDate(events: TimelineEvent[]): { label: string; events: TimelineEvent[] }[] {
  const map = new Map<string, TimelineEvent[]>()
  for (const ev of events) {
    const key = ev.date.slice(0, 10)
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(ev)
  }
  return Array.from(map.entries()).map(([key, evs]) => ({
    label: (() => {
      const today = new Date().toISOString().slice(0, 10)
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
      if (key === today)     return 'Hoy'
      if (key === yesterday) return 'Ayer'
      return new Date(key + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    })(),
    events: evs,
  }))
}

// ─── Main component ───────────────────────────────────────────────────────────

export interface TimelineViewProps {
  events:        TimelineEvent[]
  loading?:      boolean
  emptyTitle?:   string
  emptyDesc?:    string
  groupByDates?: boolean  // default true
  maxHeight?:    string   // default 'none'
  compact?:      boolean  // reduce padding para paneles laterales
}

export function TimelineView({
  events,
  loading = false,
  emptyTitle = 'Sin actividad',
  emptyDesc  = 'Los movimientos aparecerán aquí.',
  groupByDates = true,
  maxHeight = 'none',
  compact = false,
}: TimelineViewProps) {
  const sorted = useMemo(
    () => [...events].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [events]
  )

  const groups = useMemo(
    () => groupByDates ? groupByDate(sorted) : [{ label: '', events: sorted }],
    [sorted, groupByDates]
  )

  const pad = compact ? '0.875rem 1rem' : '1rem 1.25rem'

  if (loading) {
    return (
      <div style={{ padding: pad }}>
        <TimelineSkeleton />
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div style={{ padding: '2rem 1.25rem', textAlign: 'center' as const, color: '#475569' }}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 0.875rem' }}>
          <ClipboardList size={20} color="#334155" />
        </div>
        <p style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{emptyTitle}</p>
        <p style={{ margin: '0.3rem 0 0', fontSize: '0.73rem', color: '#334155' }}>{emptyDesc}</p>
      </div>
    )
  }

  return (
    <div style={{ overflowY: 'auto' as const, maxHeight }}>
      {groups.map((group, gi) => (
        <div key={gi}>
          {groupByDates && group.label && (
            <div style={{ padding: compact ? '0.625rem 1rem 0.375rem' : '0.75rem 1.25rem 0.375rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>{group.label}</span>
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.04)' }} />
            </div>
          )}
          <div style={{ padding: compact ? '0 1rem 0.5rem' : '0 1.25rem 0.75rem' }}>
            {group.events.map((ev, idx) => (
              <EventRow
                key={ev.id}
                event={ev}
                isLast={idx === group.events.length - 1}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
