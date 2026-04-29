// ─── AppBadge ─────────────────────────────────────────────────────────────────

export type BadgeVariant =
  | 'success' | 'error' | 'warning' | 'info' | 'primary'
  | 'neutral' | 'cyan' | 'ready' | 'cancelled' | 'pending'
  | 'paid' | 'active' | 'in-progress' | 'diagnosis'

interface AppBadgeProps {
  children: React.ReactNode
  variant?: BadgeVariant
  noDot?: boolean
  className?: string
}

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  success:     'badge-success',
  error:       'badge-error',
  warning:     'badge-warning',
  info:        'badge-info',
  primary:     'badge-primary',
  neutral:     'badge-neutral',
  cyan:        'badge-cyan',
  ready:       'badge-success',
  cancelled:   'badge-error',
  pending:     'badge-warning',
  paid:        'badge-success',
  active:      'badge-success',
  'in-progress': 'badge-primary',
  diagnosis:   'badge-info',
}

export function AppBadge({ children, variant = 'neutral', noDot = false, className = '' }: AppBadgeProps) {
  return (
    <span className={`badge ${VARIANT_CLASS[variant]} ${noDot ? 'badge-no-dot' : ''} ${className}`}>
      {children}
    </span>
  )
}

// ─── AppStatusBadge — mapea strings de estado a variante + label ──────────────

// Estados de órdenes
const ORDER_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  received:          { label: 'Recibida',           variant: 'info' },
  diagnosis:         { label: 'En diagnóstico',     variant: 'diagnosis' },
  repair:            { label: 'En reparación',      variant: 'in-progress' },
  waiting_parts:     { label: 'Esp. repuesto',      variant: 'warning' },
  ready:             { label: 'Lista para retirar', variant: 'ready' },
  delivered:         { label: 'Entregada',          variant: 'success' },
  cancelled:         { label: 'Cancelada',          variant: 'cancelled' },
  // aliases en inglés/español usados en la DB
  new:               { label: 'Nueva',              variant: 'info' },
  pending:           { label: 'Pendiente',          variant: 'warning' },
  in_progress:       { label: 'En progreso',        variant: 'in-progress' },
  completed:         { label: 'Completada',         variant: 'success' },
  in_repair:         { label: 'En reparación',      variant: 'in-progress' },
  waiting_for_parts: { label: 'Esp. repuesto',      variant: 'warning' },
  listo:             { label: 'Lista',              variant: 'ready' },
  entregado:         { label: 'Entregada',          variant: 'success' },
}

// Estados de comprobantes
const COMPROBANTE_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  draft:     { label: 'Borrador',  variant: 'neutral' },
  borrador:  { label: 'Borrador',  variant: 'neutral' },
  issued:    { label: 'Emitido',   variant: 'success' },
  emitido:   { label: 'Emitido',   variant: 'success' },
  cancelled: { label: 'Anulado',   variant: 'error' },
  anulado:   { label: 'Anulado',   variant: 'error' },
  pending:   { label: 'Pendiente', variant: 'warning' },
  // estado_comercial
  pagado:    { label: 'Pagado',    variant: 'success' },
  paid:      { label: 'Pagado',    variant: 'success' },
  parcial:   { label: 'Parcial',   variant: 'cyan' },
  partial:   { label: 'Parcial',   variant: 'cyan' },
  pendiente: { label: 'Pendiente', variant: 'warning' },
}

// Estados de pagos
const PAYMENT_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  paid:     { label: 'Pagado',    variant: 'success' },
  pagado:   { label: 'Pagado',    variant: 'success' },
  partial:  { label: 'Parcial',   variant: 'warning' },
  parcial:  { label: 'Parcial',   variant: 'warning' },
  pending:  { label: 'Pendiente', variant: 'pending' },
  pendiente:{ label: 'Pendiente', variant: 'pending' },
  overdue:  { label: 'Vencido',   variant: 'error' },
  vencido:  { label: 'Vencido',   variant: 'error' },
}

// Stock
const STOCK_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  available:  { label: 'Disponible',  variant: 'success' },
  low_stock:  { label: 'Bajo stock',  variant: 'warning' },
  no_stock:   { label: 'Sin stock',   variant: 'error' },
  out_of_stock:{ label: 'Sin stock',  variant: 'error' },
}

type StatusType = 'order' | 'comprobante' | 'payment' | 'stock' | 'auto'

interface AppStatusBadgeProps {
  status: string
  type?: StatusType
  fallback?: string
  noDot?: boolean
}

const ALL_MAPS = { ...ORDER_STATUS, ...COMPROBANTE_STATUS, ...PAYMENT_STATUS, ...STOCK_STATUS }
const TYPE_MAPS: Record<Exclude<StatusType, 'auto'>, Record<string, { label: string; variant: BadgeVariant }>> = {
  order:       ORDER_STATUS,
  comprobante: COMPROBANTE_STATUS,
  payment:     PAYMENT_STATUS,
  stock:       STOCK_STATUS,
}

export function AppStatusBadge({ status, type = 'auto', fallback, noDot = false }: AppStatusBadgeProps) {
  const map  = type === 'auto' ? ALL_MAPS : TYPE_MAPS[type]
  const def  = map[status?.toLowerCase()]
  const label   = def?.label   ?? fallback ?? status
  const variant = def?.variant ?? 'neutral'
  return <AppBadge variant={variant} noDot={noDot}>{label}</AppBadge>
}
