/**
 * Fuente única de lectura de clientes para los selectores de la app.
 *
 * ORDERS-V2-0 — dejó de ser exclusiva del POS. `CustomerPicker` (recepción de
 * órdenes) la consume tal cual, en lugar de la tercera implementación que había
 * en Nueva Orden: `customersService.getAll()` traía la tabla entera al browser
 * y filtraba en memoria.
 *
 * El nombre del módulo todavía dice `pos` por compatibilidad; renombrarlo
 * mueve archivos del POS y no aporta comportamiento, así que queda como
 * seguimiento aparte. La autoridad es esta, se llame como se llame.
 */
import { supabase } from '../lib/supabase'
import { documentSearchTokens } from '../features/customer-core/document'
import { normalizeText, smartSearch } from '../utils/searchUtils'
import {
  POS_CUSTOMER_MIN_QUERY_LENGTH,
  buildPosCustomerSearchTerms,
  buildPosCustomerTokenOrFilter,
} from '../lib/posCustomerSearchQuery'

export interface PosCustomerOption {
  id: string
  name: string
  customer_type?: string | null
  phone?: string | null
  document?: string | null
}

export interface PosCustomerSearchResult {
  status: 'ok' | 'error'
  items: PosCustomerOption[]
  truncated: boolean
  error?: string
}

export interface PosCustomerSearchOptions {
  businessId: string | null | undefined
  query: string
  limit?: number
  signal?: AbortSignal
  /**
   * Orden del listado SIN búsqueda. Con términos manda siempre el ranking de
   * `smartSearch`, así que esto sólo decide qué se ve al abrir el selector.
   *
   * `name` (default) es el comportamiento histórico del POS y no cambia.
   * `recent` lo pide la recepción de órdenes: al abrir Nueva Orden, los
   * últimos clientes cargados son mejores candidatos que los alfabéticos.
   */
  orderBy?: 'name' | 'recent'
}

export const POS_CUSTOMER_RESULT_LIMIT = 25

const COLUMNS = 'id,name,customer_type,phone,document'

function searchablePhone(phone: string | null | undefined): string {
  if (!phone) return ''
  return `${phone} ${phone.replace(/[^a-zA-Z0-9]/g, '')}`
}

export async function searchPosCustomers(
  options: PosCustomerSearchOptions,
): Promise<PosCustomerSearchResult> {
  const { businessId, query, limit = POS_CUSTOMER_RESULT_LIMIT, signal, orderBy = 'name' } = options

  if (!businessId) return { status: 'ok', items: [], truncated: false }

  const normalized = normalizeText(query)
  if (normalized && normalized.length < POS_CUSTOMER_MIN_QUERY_LENGTH) {
    return { status: 'ok', items: [], truncated: false }
  }

  const terms = buildPosCustomerSearchTerms(query)
  if (normalized && terms.length === 0) {
    return { status: 'ok', items: [], truncated: false }
  }

  let request = supabase
    .from('customers')
    .select(COLUMNS)
    // businessId proviene exclusivamente de useAuth; RLS vuelve a imponer el
    // mismo tenant en el servidor.
    .eq('business_id', businessId)

  for (const term of terms) {
    const filter = buildPosCustomerTokenOrFilter(term)
    if (filter) request = request.or(filter)
  }

  // `id` desempata siempre: sin un orden total, dos páginas del mismo listado
  // pueden devolver la misma fila dos veces.
  request = orderBy === 'recent'
    ? request.order('created_at', { ascending: false }).order('id', { ascending: true })
    : request.order('name', { ascending: true }).order('id', { ascending: true })
  request = request.limit(limit + 1)
  if (signal) request = request.abortSignal(signal)

  const { data, error } = await request
  if (error) {
    return { status: 'error', items: [], truncated: false, error: error.message }
  }

  const rows = (data ?? []) as unknown as PosCustomerOption[]
  const truncated = rows.length > limit
  const bounded = rows.slice(0, limit)

  if (terms.length === 0) {
    return { status: 'ok', items: bounded, truncated }
  }

  const rankingQuery = terms.join(' ')
  const ranked = smartSearch(bounded, rankingQuery, [
    { getValue: customer => customer.name, weight: 3 },
    { getValue: customer => searchablePhone(customer.phone), weight: 5 },
    {
      getValue: customer => documentSearchTokens(customer.document).join(' '),
      weight: 8,
    },
  ])

  return { status: 'ok', items: ranked, truncated }
}

export async function getPosCustomerById(
  businessId: string | null | undefined,
  customerId: string,
): Promise<PosCustomerOption | null> {
  if (!businessId || !customerId) return null

  const { data, error } = await supabase
    .from('customers')
    .select(COLUMNS)
    .eq('business_id', businessId)
    .eq('id', customerId)
    .maybeSingle()

  if (error) return null
  return (data as PosCustomerOption | null) ?? null
}
