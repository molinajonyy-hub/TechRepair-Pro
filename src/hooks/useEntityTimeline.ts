/**
 * useEntityTimeline — carga y normaliza eventos de timeline para distintas entidades.
 *
 * Fuentes de datos:
 *  - 'customer_account'  → account_movements (CC cliente)
 *  - 'supplier_account'  → supplier_account_movements (CC proveedor)
 *  - 'inventory_item'    → inventory_movements (stock producto)
 *  - 'comprobante'       → comprobante_payments + estado changes
 *  - 'order'             → order_payments + order_items + task_history
 */
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import type { TimelineEvent, TimelineEventType } from '../components/shared/TimelineView'

// ─── Types ────────────────────────────────────────────────────────────────────

export type EntityKind =
  | 'customer_account'
  | 'supplier_account'
  | 'inventory_item'
  | 'comprobante'
  | 'order'

export interface UseEntityTimelineOptions {
  entityKind: EntityKind
  entityId:   string       // account_id, inventory_item_id, comprobante_id, order_id
  businessId: string
  limit?:     number       // default 100
  enabled?:   boolean      // default true
}

export interface UseEntityTimelineReturn {
  events:   TimelineEvent[]
  loading:  boolean
  error:    string | null
  refresh:  () => void
}

// ─── Normalizadores por entidad ───────────────────────────────────────────────

// Mapeo movement_type → TimelineEventType (inventory_movements)
const INV_TYPE_MAP: Record<string, TimelineEventType> = {
  in:           'stock_in',
  purchase:     'stock_in',
  out:          'stock_out',
  sale:         'stock_out',
  order_usage:  'order_usage',
  adjustment:   'adjustment',
  return:       'return',
  credit_note:  'credit_note',
  cancellation: 'cancellation',
}

// Mapeo movement type → TimelineEventType (account_movements CC cliente)
const ACCT_TYPE_MAP: Record<string, TimelineEventType> = {
  venta:    'debt',
  compra:   'purchase',
  pago:     'payment',
  ajuste:   'adjustment',
  apertura: 'adjustment',
}

// Mapeo type (supplier_account_movements) → TimelineEventType
const SUPP_TYPE_MAP: Record<string, TimelineEventType> = {
  purchase:    'purchase',
  payment:     'payment',
  adjustment:  'adjustment',
  credit_note: 'credit_note',
}

function fmtDate(iso: string) {
  return new Date(iso).toISOString()
}

// ─── Loaders ──────────────────────────────────────────────────────────────────

async function loadCustomerAccount(accountId: string, limit: number): Promise<TimelineEvent[]> {
  const { data, error } = await supabase
    .from('account_movements')
    .select('*')
    .eq('account_id', accountId)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error || !data) return []

  return data.map(m => {
    const type: TimelineEventType = ACCT_TYPE_MAP[m.type] ?? 'adjustment'
    const isDebit = m.debit > 0
    return {
      id:         m.id,
      date:       fmtDate(m.created_at || m.date),
      type,
      title:      m.description,
      amount:     isDebit ? m.debit : m.credit,
      amountSign: isDebit ? '-' : '+',
      balance:    m.balance_after,
      reference:  m.reference_id ? m.reference_id.slice(0, 8) : undefined,
      user:       undefined,
    } satisfies TimelineEvent
  })
}

async function loadSupplierAccount(supplierId: string, businessId: string, limit: number): Promise<TimelineEvent[]> {
  const { data, error } = await supabase
    .from('supplier_account_movements')
    .select('*')
    .eq('supplier_id', supplierId)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error || !data) return []

  return data.map(m => {
    const type: TimelineEventType = SUPP_TYPE_MAP[m.type] ?? 'adjustment'
    const isDebit = m.debit > 0
    return {
      id:         m.id,
      date:       fmtDate(m.created_at || m.movement_date),
      type,
      title:      m.description,
      amount:     isDebit ? m.debit : m.credit,
      amountSign: isDebit ? '-' : '+',
      balance:    m.balance_after,
    } satisfies TimelineEvent
  })
}

async function loadInventoryItem(itemId: string, businessId: string, limit: number): Promise<TimelineEvent[]> {
  const { data, error } = await supabase
    .from('inventory_movements')
    .select('*')
    .eq('inventory_item_id', itemId)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error || !data) return []

  return data.map(m => {
    const type: TimelineEventType = INV_TYPE_MAP[m.movement_type] ?? 'adjustment'
    const qty    = Math.abs(m.quantity)
    const isOut  = m.quantity < 0
    const labels: Record<string, string> = {
      in: `Ingresaron ${qty} unidades`,
      purchase: `Compra: +${qty} unidades`,
      out: `Salida: −${qty} unidades`,
      sale: `Venta: −${qty} unidades`,
      order_usage: `Uso en orden: −${qty} unidades`,
      adjustment: `Ajuste: ${m.quantity > 0 ? '+' : ''}${m.quantity} unidades`,
      return: `Devolución: +${qty} unidades`,
      cancellation: `Cancelación: +${qty} unidades`,
      credit_note: `Nota crédito: +${qty} unidades`,
    }

    return {
      id:       m.id,
      date:     fmtDate(m.created_at),
      type,
      title:    labels[m.movement_type] ?? `Movimiento: ${m.quantity > 0 ? '+' : ''}${m.quantity}`,
      subtitle: m.note || undefined,
      amount:   qty,
      amountSign: isOut ? '-' : '+',
      badge:    `Stock: ${m.new_stock}`,
      badgeColor: m.new_stock <= 0 ? '#ef4444' : m.new_stock <= 5 ? '#f59e0b' : '#22c55e',
      reference: m.reference_id ? m.reference_id.slice(0, 8) : undefined,
    } satisfies TimelineEvent
  })
}

async function loadComprobante(comprobanteId: string, businessId: string, limit: number): Promise<TimelineEvent[]> {
  // Cargar pagos del comprobante
  const { data: pagos } = await supabase
    .from('comprobante_payments')
    .select('*')
    .eq('comprobante_id', comprobanteId)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(limit)

  const events: TimelineEvent[] = []

  // Cargar el comprobante mismo para la creación
  const { data: comp } = await supabase
    .from('comprobantes')
    .select('id, numero, number, total_ars, estado, status, estado_comercial, created_at')
    .eq('id', comprobanteId)
    .maybeSingle()

  if (comp) {
    events.push({
      id:       `comp-create-${comp.id}`,
      date:     fmtDate(comp.created_at),
      type:     'sale',
      title:    `Comprobante creado`,
      subtitle: `Total ${comp.total_ars ? '$' + Math.round(comp.total_ars).toLocaleString('es-AR') : ''}`,
      badge:    comp.estado === 'emitido' || comp.status === 'issued' ? 'Emitido' : 'Borrador',
      badgeColor: comp.estado === 'emitido' ? '#818cf8' : '#94a3b8',
      reference: comp.numero || comp.number || comp.id.slice(0, 8),
    })
  }

  for (const p of pagos || []) {
    const METODO: Record<string, string> = {
      efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta_debito: 'Débito',
      tarjeta_credito: 'Crédito', qr: 'QR', cuenta_corriente: 'Cuenta Corriente',
      mixto: 'Mixto', otro: 'Otro',
    }
    events.push({
      id:         p.id,
      date:       fmtDate(p.created_at),
      type:       p.payment_method === 'cuenta_corriente' ? 'debt' : 'payment',
      title:      `Pago ${METODO[p.payment_method] ?? p.payment_method}`,
      subtitle:   p.commission_amount > 0 ? `Comisión: $${Math.round(p.commission_amount).toLocaleString('es-AR')}` : undefined,
      amount:     p.amount_ars,
      amountSign: '+',
      currency:   p.currency as 'ARS' | 'USD',
    })
  }

  return events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

async function loadOrder(orderId: string, businessId: string, limit: number): Promise<TimelineEvent[]> {
  const [paymentsRes, historyRes] = await Promise.all([
    supabase
      .from('order_payments')
      .select('*')
      .eq('order_id', orderId)
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(Math.floor(limit / 2)),
    supabase
      .from('task_history')
      .select('*')
      .eq('task_id', orderId)
      .order('created_at', { ascending: false })
      .limit(Math.ceil(limit / 2)),
  ])

  const events: TimelineEvent[] = []

  for (const p of paymentsRes.data || []) {
    events.push({
      id:         p.id,
      date:       fmtDate(p.created_at || p.payment_date),
      type:       'payment',
      title:      `Pago: ${p.payment_method}`,
      amount:     p.amount,
      amountSign: '+',
      currency:   (p.currency ?? 'ARS') as 'ARS' | 'USD',
    })
  }

  for (const h of historyRes.data || []) {
    events.push({
      id:         h.id,
      date:       fmtDate(h.created_at),
      type:       h.action === 'status_changed' ? 'status' : 'note',
      title:      h.action === 'status_changed'
        ? `Estado: ${h.old_value ?? '?'} → ${h.new_value}`
        : h.action === 'reassigned'
        ? `Reasignado`
        : `${h.action}`,
      subtitle:   h.new_value && h.action !== 'status_changed' ? String(h.new_value) : undefined,
    })
  }

  return events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useEntityTimeline({
  entityKind,
  entityId,
  businessId,
  limit   = 100,
  enabled = true,
}: UseEntityTimelineOptions): UseEntityTimelineReturn {
  const [events,  setEvents]  = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!enabled || !entityId || !businessId) return
    setLoading(true)
    setError(null)
    try {
      let result: TimelineEvent[] = []
      switch (entityKind) {
        case 'customer_account':
          result = await loadCustomerAccount(entityId, limit)
          break
        case 'supplier_account':
          result = await loadSupplierAccount(entityId, businessId, limit)
          break
        case 'inventory_item':
          result = await loadInventoryItem(entityId, businessId, limit)
          break
        case 'comprobante':
          result = await loadComprobante(entityId, businessId, limit)
          break
        case 'order':
          result = await loadOrder(entityId, businessId, limit)
          break
      }
      setEvents(result)
    } catch (e: any) {
      setError(e?.message ?? 'Error cargando timeline')
    } finally {
      setLoading(false)
    }
  }, [entityKind, entityId, businessId, limit, enabled])

  useEffect(() => { load() }, [load])

  return { events, loading, error, refresh: load }
}
