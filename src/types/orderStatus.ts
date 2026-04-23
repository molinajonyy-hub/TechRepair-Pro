// ============================================
// ESTADOS DE ORDEN - Fuente única de verdad
// ============================================

export type OrderStatus =
  | 'new'
  | 'diagnosis'
  | 'waiting_approval'
  | 'repair'
  | 'waiting_parts'
  | 'ready_delivery'
  | 'waiting_payment'
  | 'completed'
  | 'cancelled'

// Configuración visual de cada estado
export interface StatusConfig {
  label: string
  color: string
  icon: string
  description: string
  isFinalState: boolean
}

export const STATUS_CONFIG: Record<OrderStatus, StatusConfig> = {
  new: {
    label: 'Nueva',
    color: '#64748b',
    icon: 'AlertCircle',
    description: 'Orden recién creada',
    isFinalState: false,
  },
  diagnosis: {
    label: 'Diagnóstico',
    color: '#06b6d4',
    icon: 'Stethoscope',
    description: 'Evaluando el dispositivo',
    isFinalState: false,
  },
  waiting_approval: {
    label: 'Esperando Aprobación',
    color: '#f59e0b',
    icon: 'Clock',
    description: 'Esperando confirmación del cliente',
    isFinalState: false,
  },
  repair: {
    label: 'En Reparación',
    color: '#6366f1',
    icon: 'Wrench',
    description: 'Reparación en curso',
    isFinalState: false,
  },
  waiting_parts: {
    label: 'Esperando Repuestos',
    color: '#f59e0b',
    icon: 'Package',
    description: 'Esperando llegada de piezas',
    isFinalState: false,
  },
  ready_delivery: {
    label: 'Listo para Entregar',
    color: '#10b981',
    icon: 'CheckCircle',
    description: 'Reparación completada, pendiente de retiro',
    isFinalState: false,
  },
  waiting_payment: {
    label: 'Esperando Pago',
    color: '#f59e0b',
    icon: 'DollarSign',
    description: 'Esperando pago del cliente',
    isFinalState: false,
  },
  completed: {
    label: 'Completada',
    color: '#10b981',
    icon: 'CheckCircle',
    description: 'Orden finalizada y entregada',
    isFinalState: true,
  },
  cancelled: {
    label: 'Cancelada',
    color: '#dc2626',
    icon: 'XCircle',
    description: 'Orden cancelada',
    isFinalState: true,
  },
}

// Orden de visualización de los estados en el selector
export const STATUS_ORDER: OrderStatus[] = [
  'new',
  'diagnosis',
  'waiting_approval',
  'repair',
  'waiting_parts',
  'ready_delivery',
  'waiting_payment',
  'completed',
  'cancelled',
]

// ============================================
// LÓGICA DE TRANSICIONES — libre y directa
// ============================================

/**
 * Retorna todos los estados a los que se puede mover una orden,
 * excluyendo el estado actual y cualquier estado final previo
 * (una orden completada o cancelada no se puede mover).
 */
export function getAllowedTransitions(from: OrderStatus): OrderStatus[] {
  if (STATUS_CONFIG[from].isFinalState) return []
  return STATUS_ORDER.filter(s => s !== from)
}

/** Verifica si la transición es válida (solo bloquea estados finales) */
export function isValidTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (STATUS_CONFIG[from].isFinalState) return false
  return from !== to
}

/**
 * Valida si se puede realizar la transición.
 * Sin validaciones de checklist, firma ni saldo pendiente.
 * Solo se impide mover una orden que ya está en estado final.
 */
export function validateTransition(
  from: OrderStatus,
  to: OrderStatus,
  _order?: any,
): { valid: boolean; errors: string[] } {
  if (!isValidTransition(from, to)) {
    return {
      valid: false,
      errors: [`La orden ya está en estado final (${STATUS_CONFIG[from].label}) y no puede modificarse.`],
    }
  }
  return { valid: true, errors: [] }
}

// ============================================
// HISTORIAL DE ESTADOS
// ============================================

export interface StatusHistoryEntry {
  id?: string
  order_id: string
  from_status: OrderStatus
  to_status: OrderStatus
  changed_by?: string | null
  changed_by_name?: string
  notes?: string
  created_at?: string
  business_id: string
}

export async function recordStatusChange(
  supabase: any,
  entry: StatusHistoryEntry,
): Promise<void> {
  const noteText =
    entry.notes ||
    `${STATUS_CONFIG[entry.from_status].label} → ${STATUS_CONFIG[entry.to_status].label}`

  const { error } = await supabase.from('status_history').insert({
    order_id: entry.order_id,
    status: entry.to_status,
    note: noteText,
    created_by: entry.changed_by ?? null,
    business_id: entry.business_id,
    created_at: new Date().toISOString(),
  })

  if (error) {
    if (import.meta.env.DEV) console.warn('Error recording status change:', error)
    throw new Error('No se pudo registrar el cambio de estado')
  }
}

export function getTransitionDescription(from: OrderStatus, to: OrderStatus): string {
  return `Cambió de "${STATUS_CONFIG[from].label}" a "${STATUS_CONFIG[to].label}"`
}
