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
  icon: string // nombre del icono de lucide
  description: string
  isFinalState: boolean
  requiresAction: boolean
}

export const STATUS_CONFIG: Record<OrderStatus, StatusConfig> = {
  new: {
    label: 'Nueva',
    color: '#64748b',
    icon: 'AlertCircle',
    description: 'Orden recién creada',
    isFinalState: false,
    requiresAction: false
  },
  diagnosis: {
    label: 'Diagnóstico',
    color: '#06b6d4',
    icon: 'Stethoscope',
    description: 'Evaluando el dispositivo',
    isFinalState: false,
    requiresAction: true
  },
  waiting_approval: {
    label: 'Esperando Aprobación',
    color: '#f59e0b',
    icon: 'Clock',
    description: 'Esperando confirmación del cliente',
    isFinalState: false,
    requiresAction: true
  },
  repair: {
    label: 'En Reparación',
    color: '#6366f1',
    icon: 'Wrench',
    description: 'Reparación en curso',
    isFinalState: false,
    requiresAction: true
  },
  waiting_parts: {
    label: 'Esperando Repuestos',
    color: '#f59e0b',
    icon: 'Package',
    description: 'Esperando llegada de piezas',
    isFinalState: false,
    requiresAction: true
  },
  ready_delivery: {
    label: 'Listo para Entregar',
    color: '#10b981',
    icon: 'CheckCircle',
    description: 'Reparación completada',
    isFinalState: false,
    requiresAction: false
  },
  waiting_payment: {
    label: 'Esperando Pago',
    color: '#f59e0b',
    icon: 'DollarSign',
    description: 'Esperando pago del cliente',
    isFinalState: false,
    requiresAction: true
  },
  completed: {
    label: 'Completada',
    color: '#10b981',
    icon: 'CheckCircle',
    description: 'Orden finalizada y entregada',
    isFinalState: true,
    requiresAction: false
  },
  cancelled: {
    label: 'Cancelada',
    color: '#dc2626',
    icon: 'XCircle',
    description: 'Orden cancelada',
    isFinalState: true,
    requiresAction: false
  }
}

// ============================================
// REGLAS DE TRANSICIÓN
// ============================================

export interface TransitionRule {
  from: OrderStatus
  to: OrderStatus[]
  validations?: ValidationRule[]
}

export interface ValidationRule {
  type: 'no_pending_payment' | 'checklist_complete' | 'signature_required' | 'custom'
  message: string
  check: (order: any) => boolean
}

// Definir qué transiciones son válidas
export const VALID_TRANSITIONS: TransitionRule[] = [
  {
    from: 'new',
    to: ['diagnosis', 'cancelled']
  },
  {
    from: 'diagnosis',
    to: ['waiting_approval', 'repair', 'waiting_parts', 'cancelled']
  },
  {
    from: 'waiting_approval',
    to: ['repair', 'cancelled']
  },
  {
    from: 'repair',
    to: ['waiting_parts', 'ready_delivery', 'cancelled']
  },
  {
    from: 'waiting_parts',
    to: ['repair', 'cancelled']
  },
  {
    from: 'ready_delivery',
    to: ['waiting_payment', 'completed', 'cancelled'],
    validations: [
      {
        type: 'checklist_complete',
        message: 'Debe completarse el checklist final',
        check: (order) => order.checklist?.final_test_passed === true
      }
    ]
  },
  {
    from: 'waiting_payment',
    to: ['completed', 'cancelled']
  },
  {
    from: 'completed',
    to: [] // Estado final
  },
  {
    from: 'cancelled',
    to: [] // Estado final
  }
]

// ============================================
// FUNCIONES DE VALIDACIÓN
// ============================================

export function isValidTransition(from: OrderStatus, to: OrderStatus): boolean {
  const rule = VALID_TRANSITIONS.find(r => r.from === from)
  if (!rule) return false
  return rule.to.includes(to)
}

export function getAllowedTransitions(from: OrderStatus): OrderStatus[] {
  const rule = VALID_TRANSITIONS.find(r => r.from === from)
  return rule?.to || []
}

export function validateTransition(
  from: OrderStatus, 
  to: OrderStatus, 
  order: any
): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  
  // 1. Verificar si la transición existe
  if (!isValidTransition(from, to)) {
    errors.push(`No se puede cambiar de "${STATUS_CONFIG[from].label}" a "${STATUS_CONFIG[to].label}"`)
    return { valid: false, errors }
  }
  
  // 2. Verificar reglas específicas
  const rule = VALID_TRANSITIONS.find(r => r.from === from)
  if (rule?.validations) {
    for (const validation of rule.validations) {
      if (!validation.check(order)) {
        errors.push(validation.message)
      }
    }
  }
  
  // 3. Reglas de negocio específicas para "completed"
  if (to === 'completed') {
    // No debe tener saldo pendiente
    if (order.balance_pending > 0) {
      errors.push(`No se puede completar: hay saldo pendiente de $${order.balance_pending}`)
    }
    
    // Debe tener checklist final
    if (!order.checklist?.final_test_passed) {
      errors.push('No se puede completar: falta el checklist final de pruebas')
    }
    
    // Debe tener firma de retiro
    if (!order.checklist?.retirement_signature) {
      errors.push('No se puede completar: falta la firma de retiro del cliente')
    }
  }
  
  return { valid: errors.length === 0, errors }
}

// ============================================
// HISTORIAL DE ESTADOS
// ============================================

export interface StatusHistoryEntry {
  id?: string
  order_id: string
  from_status: OrderStatus
  to_status: OrderStatus
  changed_by?: string | null // user_id (created_by en BD)
  changed_by_name?: string
  notes?: string
  created_at?: string
  business_id: string
}

export async function recordStatusChange(
  supabase: any,
  entry: StatusHistoryEntry
): Promise<void> {
  // Esquema real de la tabla status_history:
  // id, order_id, status (nuevo estado), note, created_at, created_by, business_id
  const noteText = entry.notes
    || `${STATUS_CONFIG[entry.from_status].label} → ${STATUS_CONFIG[entry.to_status].label}`

  const { error } = await supabase
    .from('status_history')
    .insert({
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

// Obtener descripción de transición
export function getTransitionDescription(from: OrderStatus, to: OrderStatus): string {
  const fromLabel = STATUS_CONFIG[from].label
  const toLabel = STATUS_CONFIG[to].label
  return `Cambió de "${fromLabel}" a "${toLabel}"`
}
