// ─────────────────────────────────────────────────────────────────────────────
// P0 SEARCH — contrato de la query que el servicio canónico manda al servidor.
//
// El bug no estaba en cómo se ordenaban los resultados sino en QUÉ se pedía:
// un solo token, sin ORDER BY, con el tope aplicado sobre un universo mucho más
// grande que el relevante. Por eso estos tests aseveran la FORMA de la query,
// no sólo su salida: es lo único que impide que la regresión vuelva disfrazada.
//
// El cliente Supabase está mockeado y `setup.ts` prohíbe la red, así que lo que
// se mide es el contrato, no un backend.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'

interface QueryRegistrada {
  tabla: string
  select: string
  eq: Array<[string, unknown]>
  not: Array<[string, string, unknown]>
  or: string[]
  order: Array<[string, unknown]>
  limit: number | null
}

const estado = vi.hoisted(() => ({
  filas: [] as Array<Record<string, unknown>>,
  error: null as { message: string } | null,
  queries: [] as QueryRegistrada[],
}))

vi.mock('../../src/lib/supabase', () => {
  function construir(tabla: string) {
    const registro: QueryRegistrada = {
      tabla, select: '', eq: [], not: [], or: [], order: [], limit: null,
    }
    estado.queries.push(registro)

    const q: Record<string, unknown> = {
      select: (cols: string) => { registro.select = cols; return q },
      eq: (col: string, val: unknown) => { registro.eq.push([col, val]); return q },
      not: (col: string, op: string, val: unknown) => { registro.not.push([col, op, val]); return q },
      or: (filtro: string) => { registro.or.push(filtro); return q },
      order: (col: string, opts: unknown) => { registro.order.push([col, opts]); return q },
      abortSignal: () => q,
      limit: (n: number) => {
        registro.limit = n
        // El await sobre el query builder resuelve acá.
        return Promise.resolve(
          estado.error
            ? { data: null, error: estado.error }
            : { data: estado.filas, error: null },
        )
      },
    }
    return q
  }
  return { supabase: { from: (tabla: string) => construir(tabla) } }
})

const { searchSellableProducts } = await import('../../src/services/productSearchService')

const NEGOCIO = '00000000-0000-0000-0000-00000e2eb001'

function producto(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p1', code: 'SRCH-1', name: 'Funda Silicone iPhone 15 - Negro',
    variant_name: null, category: 'Fundas', subcategory: 'Negro',
    stock_quantity: 7, cost_price: 6000, sale_price: 12000,
    has_variants: false, parent_id: null, supplier_code: null, tipo: 'product',
    ...over,
  }
}

beforeEach(() => {
  estado.filas = []
  estado.error = null
  estado.queries = []
})

describe('searchSellableProducts — forma de la query', () => {
  it('REGRESIÓN P0: manda un filtro por CADA token, no sólo el más largo', async () => {
    estado.filas = [producto()]
    await searchSellableProducts({ businessId: NEGOCIO, query: 'funda silicone iphone 15 negro' })

    const q = estado.queries[0]
    // 5 tokens → 5 filtros .or() encadenados, que PostgREST combina con AND.
    expect(q.or).toHaveLength(5)
    expect(q.or[0]).toContain('name.ilike.%funda%')
    expect(q.or[4]).toContain('name.ilike.%negro%')
  })

  it('cada filtro cubre name, variant_name, code, subcategory y category', async () => {
    estado.filas = []
    await searchSellableProducts({ businessId: NEGOCIO, query: 'negro' })

    const filtro = estado.queries[0].or[0]
    for (const col of ['name', 'variant_name', 'code', 'subcategory', 'category']) {
      expect(filtro).toContain(`${col}.ilike.%negro%`)
    }
  })

  it('excluye al padre agrupador y a los inactivos', async () => {
    await searchSellableProducts({ businessId: NEGOCIO, query: 'funda' })

    const q = estado.queries[0]
    expect(q.not).toContainEqual(['has_variants', 'is', true])
    expect(q.eq).toContainEqual(['is_active', true])
  })

  it('siempre acota por business_id', async () => {
    await searchSellableProducts({ businessId: NEGOCIO, query: 'funda' })
    expect(estado.queries[0].eq).toContainEqual(['business_id', NEGOCIO])
  })

  it('REGRESIÓN P0: ordena de forma determinista', async () => {
    // Sin ORDER BY el truncado devuelve un subconjunto arbitrario y la misma
    // búsqueda puede dar distinto resultado en dos corridas seguidas.
    await searchSellableProducts({ businessId: NEGOCIO, query: 'funda' })

    const cols = estado.queries[0].order.map(([c]) => c)
    expect(cols).toEqual(['name', 'id'])
  })

  it('pide una fila de más para poder detectar truncado', async () => {
    await searchSellableProducts({ businessId: NEGOCIO, query: 'funda', limit: 10 })
    expect(estado.queries[0].limit).toBe(11)
  })

  it('filtra por tipo cuando se lo piden', async () => {
    await searchSellableProducts({ businessId: NEGOCIO, query: 'funda', tipo: 'service' })
    expect(estado.queries[0].eq).toContainEqual(['tipo', 'service'])
  })

  it('no consulta al servidor con menos de 2 caracteres', async () => {
    const res = await searchSellableProducts({ businessId: NEGOCIO, query: 'a' })
    expect(estado.queries).toHaveLength(0)
    expect(res.items).toEqual([])
    expect(res.status).toBe('ok')
  })

  it('no consulta al servidor sin businessId', async () => {
    const res = await searchSellableProducts({ businessId: null, query: 'funda silicone' })
    expect(estado.queries).toHaveLength(0)
    expect(res.status).toBe('ok')
  })

  it('no consulta cuando la query es sólo símbolos', async () => {
    const res = await searchSellableProducts({ businessId: NEGOCIO, query: '%%%%' })
    expect(estado.queries).toHaveLength(0)
    expect(res.items).toEqual([])
  })
})

describe('searchSellableProducts — resultado', () => {
  it('devuelve los productos encontrados', async () => {
    estado.filas = [producto()]
    const res = await searchSellableProducts({ businessId: NEGOCIO, query: 'funda negro' })

    expect(res.status).toBe('ok')
    expect(res.items).toHaveLength(1)
    expect(res.items[0].id).toBe('p1')
    expect(res.truncated).toBe(false)
  })

  it('señaliza el truncado y recorta al límite pedido', async () => {
    // 3 filas devueltas con limit 2 → el servidor tenía más de las pedidas.
    estado.filas = [
      producto({ id: 'a', name: 'Funda Negro A' }),
      producto({ id: 'b', name: 'Funda Negro B' }),
      producto({ id: 'c', name: 'Funda Negro C' }),
    ]
    const res = await searchSellableProducts({ businessId: NEGOCIO, query: 'funda negro', limit: 2 })

    expect(res.truncated).toBe(true)
    expect(res.items).toHaveLength(2)
  })

  it('REGRESIÓN P0: un error del backend NO se disfraza de "sin resultados"', async () => {
    // Confundirlos hace que el cajero cargue el producto a mano y lo duplique.
    estado.error = { message: 'network down' }
    const res = await searchSellableProducts({ businessId: NEGOCIO, query: 'funda negro' })

    expect(res.status).toBe('error')
    expect(res.error).toBe('network down')
    expect(res.items).toEqual([])
  })

  it('encuentra la variante buscando por el nombre del padre', async () => {
    // Representación B: el hijo guarda el nombre del padre en `name`.
    estado.filas = [
      producto({ id: 'v1', name: 'Vidrio Templado iPhone 14', variant_name: 'Comun', subcategory: null }),
      producto({ id: 'v2', name: 'Vidrio Templado iPhone 14', variant_name: 'Privacidad', subcategory: null }),
    ]
    const res = await searchSellableProducts({ businessId: NEGOCIO, query: 'vidrio templado iphone 14' })

    expect(res.items.map(i => i.id).sort()).toEqual(['v1', 'v2'])
  })

  it('prioriza la coincidencia exacta de código sobre el resto', async () => {
    estado.filas = [
      producto({ id: 'otro', code: 'SRCH-FUN-IP15-VAR-02', name: 'Funda Silicone iPhone 15 - Azul' }),
      producto({ id: 'exacto', code: 'SRCH-FUN-IP15-VAR-01', name: 'Funda Silicone iPhone 15 - Negro' }),
    ]
    const res = await searchSellableProducts({ businessId: NEGOCIO, query: 'SRCH-FUN-IP15-VAR-01' })

    expect(res.items[0].id).toBe('exacto')
  })
})
