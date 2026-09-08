import { STATUS_CONFIG, type OrderStatus, type StatusConfig } from '../types/orderStatus'

/** Read payload, not the input to recordStatusChange. Production stores
 * status/note; older clients may provide an explicit from/to transition. */
export interface OrderHistoryRecord {
  id?: string
  status?: string | null
  note?: string | null
  from_status?: string | null
  to_status?: string | null
  notes?: string | null
  created_at?: string | null
}

type HistoryStatusDisplay = Pick<StatusConfig, 'label' | 'color'>

/** Presentation only: never normalizes a status or authorizes a transition. */
function statusDisplay(status: string | null | undefined): HistoryStatusDisplay {
  if (typeof status === 'string' && Object.prototype.hasOwnProperty.call(STATUS_CONFIG, status)) {
    return STATUS_CONFIG[status as OrderStatus]
  }
  return {
    label: status ? `Estado desconocido (${status})` : 'Estado desconocido',
    color: '#64748b',
  }
}

export function getOrderHistoryDisplay(entry: OrderHistoryRecord) {
  return {
    // A snapshot does not prove a previous status. Do not infer it from the
    // next row or parse free-text notes as a transition.
    from: 'from_status' in entry ? statusDisplay(entry.from_status) : null,
    to: statusDisplay('status' in entry ? entry.status : entry.to_status),
    note: 'note' in entry ? entry.note : entry.notes,
  }
}
