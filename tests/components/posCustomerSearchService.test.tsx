import { beforeEach, describe, expect, it, vi } from 'vitest'

interface CustomerRow {
  id: string
  business_id: string
  name: string
  phone: string | null
  document: string | null
  customer_type: string
}

interface RecordedQuery {
  table: string
  select: string
  eq: Array<[string, unknown]>
  or: string[]
  order: string[]
  limit: number | null
}

const state = vi.hoisted(() => ({
  rows: [] as CustomerRow[],
  queries: [] as RecordedQuery[],
  error: null as { message: string } | null,
}))

function ilike(value: string | null, pattern: string): boolean {
  if (value === null) return false
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i')
  return regex.test(value)
}

function matchesOr(row: CustomerRow, filter: string): boolean {
  return filter.split(',').some(clause => {
    const match = /^(name|phone|document)\.ilike\.(.*)$/.exec(clause)
    return !!match && ilike(row[match[1] as 'name' | 'phone' | 'document'], match[2])
  })
}

vi.mock('../../src/lib/supabase', () => {
  function buildQuery(table: string) {
    const recorded: RecordedQuery = { table, select: '', eq: [], or: [], order: [], limit: null }
    state.queries.push(recorded)

    const resolve = () => {
      if (state.error) return { data: null, error: state.error }
      let rows = [...state.rows]
      for (const [column, value] of recorded.eq) {
        rows = rows.filter(row => row[column as keyof CustomerRow] === value)
      }
      for (const filter of recorded.or) rows = rows.filter(row => matchesOr(row, filter))
      rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      return { data: rows.slice(0, recorded.limit ?? rows.length), error: null }
    }

    const query: Record<string, unknown> = {
      select: (columns: string) => { recorded.select = columns; return query },
      eq: (column: string, value: unknown) => { recorded.eq.push([column, value]); return query },
      or: (filter: string) => { recorded.or.push(filter); return query },
      order: (column: string) => { recorded.order.push(column); return query },
      abortSignal: () => query,
      limit: (limit: number) => {
        recorded.limit = limit
        return Promise.resolve(resolve())
      },
      maybeSingle: () => {
        const result = resolve()
        return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error })
      },
    }
    return query
  }

  return { supabase: { from: (table: string) => buildQuery(table) } }
})

const { POS_CUSTOMER_RESULT_LIMIT, getPosCustomerById, searchPosCustomers } =
  await import('../../src/services/posCustomerSearchService')

const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'

function customer(index: number, overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: `customer-${String(index).padStart(3, '0')}`,
    business_id: TENANT_A,
    name: `Cliente ${String(index).padStart(3, '0')}`,
    phone: null,
    document: null,
    customer_type: 'minorista',
    ...overrides,
  }
}

beforeEach(() => {
  state.rows = []
  state.queries = []
  state.error = null
})

describe('searchPosCustomers', () => {
  it('carga una lista inicial acotada, no un universo fijo de 300', async () => {
    state.rows = Array.from({ length: 350 }, (_, index) => customer(index + 1))
    const result = await searchPosCustomers({ businessId: TENANT_A, query: '' })

    expect(result.items).toHaveLength(POS_CUSTOMER_RESULT_LIMIT)
    expect(state.queries[0].limit).toBe(POS_CUSTOMER_RESULT_LIMIT + 1)
    expect(state.queries[0].or).toHaveLength(0)
  })

  it('encuentra por nombre un cliente posterior a la fila 300', async () => {
    const target = customer(325, { name: 'Objetivo Beta Lejano' })
    state.rows = Array.from({ length: 350 }, (_, index) => customer(index + 1))
    state.rows[324] = target

    const result = await searchPosCustomers({ businessId: TENANT_A, query: 'Objetivo Beta' })

    expect(result.items.map(item => item.id)).toContain(target.id)
    expect(state.queries[0].or).toHaveLength(2)
  })

  it.each([
    ['DNI 30123456', 'DNI: 30.123.456'],
    ['30.123.456', 'DNI 30123456'],
    ['CUIT 20-30123456-7', '20301234567'],
  ])('encuentra %s contra el formato guardado %s', async (query, stored) => {
    const target = customer(325, { name: 'Documento Objetivo', document: stored })
    state.rows = Array.from({ length: 350 }, (_, index) => customer(index + 1))
    state.rows[324] = target

    const result = await searchPosCustomers({ businessId: TENANT_A, query })
    expect(result.items.map(item => item.id)).toContain(target.id)
  })

  it('busca teléfono con o sin separadores', async () => {
    state.rows = [customer(1, { phone: '+54 11 4567-8901' })]
    const result = await searchPosCustomers({ businessId: TENANT_A, query: '541145678901' })
    expect(result.items).toHaveLength(1)
  })

  it('aísla todas las consultas al tenant autenticado', async () => {
    state.rows = [
      customer(1, { business_id: TENANT_A, name: 'Cliente Compartido' }),
      customer(2, { business_id: TENANT_B, name: 'Cliente Compartido' }),
    ]
    const result = await searchPosCustomers({ businessId: TENANT_A, query: 'Cliente Compartido' })

    expect(result.items.map(item => item.id)).toEqual(['customer-001'])
    expect(state.queries[0].eq).toContainEqual(['business_id', TENANT_A])
  })

  it('recupera una selección previa por id dentro del mismo tenant', async () => {
    state.rows = [
      customer(325, { business_id: TENANT_A }),
      customer(325, { business_id: TENANT_B, name: 'Otro tenant' }),
    ]
    const result = await getPosCustomerById(TENANT_A, 'customer-325')

    expect(result?.name).toBe('Cliente 325')
    expect(state.queries[0].eq).toContainEqual(['business_id', TENANT_A])
    expect(state.queries[0].eq).toContainEqual(['id', 'customer-325'])
  })

  it('distingue un error del backend de cero resultados', async () => {
    state.error = { message: 'network down' }
    const result = await searchPosCustomers({ businessId: TENANT_A, query: 'Cliente' })
    expect(result.status).toBe('error')
    expect(result.error).toBe('network down')
  })

  it('no consulta sin tenant ni con una sola letra', async () => {
    await searchPosCustomers({ businessId: null, query: 'Cliente' })
    await searchPosCustomers({ businessId: TENANT_A, query: 'a' })
    expect(state.queries).toHaveLength(0)
  })
})
