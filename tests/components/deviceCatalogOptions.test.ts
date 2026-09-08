import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), getUser: vi.fn() }))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
    auth: { getUser: mocks.getUser },
  },
}))

import {
  DEFAULT_BRANDS,
  loadBrandOptions,
  loadModelOptions,
  mergeCatalogNames,
} from '../../src/services/deviceCatalogService'

/** Builder mínimo del encadenado de supabase-js que usa el service. */
function table(rows: unknown[] | null, error: { code?: string; message: string } | null = null) {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'ilike', 'order']) {
    chain[method] = () => chain
  }
  chain.order = () => ({ data: rows, error })
  chain.maybeSingle = async () => ({ data: rows?.[0] ?? null, error })
  return chain
}

describe('ORDERS-V2-0 · opciones de catálogo de equipos', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'u1' } } })
    mocks.rpc.mockReset().mockResolvedValue({ data: { business_id: 'biz-a' }, error: null })
    mocks.from.mockReset()
  })

  describe('mergeCatalogNames', () => {
    it('pone primero el catálogo del negocio y agrega el fallback que falta', () => {
      expect(mergeCatalogNames(['Motorola', 'Vaio'], ['Apple', 'Motorola']))
        .toEqual(['Motorola', 'Vaio', 'Apple'])
    })

    it('deduplica sin distinguir mayúsculas y conserva la grafía del catálogo', () => {
      // El taller escribió «motorola»; la lista genérica trae «Motorola».
      // Gana la del taller, y no puede aparecer dos veces en el desplegable.
      expect(mergeCatalogNames(['motorola'], ['Motorola'])).toEqual(['motorola'])
    })

    it('descarta basura que no puede ser una marca', () => {
      expect(mergeCatalogNames(['  ', 'null', 'n/a', '-', 'Nokia'], [])).toEqual(['Nokia'])
    })

    it('normaliza espacios internos y de borde', () => {
      expect(mergeCatalogNames(['  Galaxy   A04e  '], [])).toEqual(['Galaxy A04e'])
    })
  })

  describe('loadBrandOptions', () => {
    it('combina las marcas persistidas con los fallbacks', async () => {
      mocks.from.mockReturnValue(table([{ id: 'b1', name: 'Vaio' }]))
      const brands = await loadBrandOptions()
      expect(brands[0]).toBe('Vaio')
      expect(brands).toEqual(expect.arrayContaining(DEFAULT_BRANDS))
    })

    it('degrada a los fallbacks cuando la DB falla — el alta nunca se bloquea', async () => {
      mocks.from.mockReturnValue(table(null, { code: '42501', message: 'denied' }))
      expect(await loadBrandOptions()).toEqual(DEFAULT_BRANDS)
    })

    it('degrada a los fallbacks sin sesión', async () => {
      mocks.getUser.mockResolvedValue({ data: { user: null } })
      expect(await loadBrandOptions()).toEqual(DEFAULT_BRANDS)
      expect(mocks.from).not.toHaveBeenCalled()
    })
  })

  describe('loadModelOptions', () => {
    it('devuelve modelos del catálogo antes que los genéricos de la marca', async () => {
      mocks.from.mockImplementation((name: string) =>
        name === 'brands'
          ? table([{ id: 'b1', name: 'Motorola' }])
          : table([{ id: 'm1', name: 'Moto G54', brand_id: 'b1' }]))
      const models = await loadModelOptions('Motorola')
      expect(models[0]).toBe('Moto G54')
      expect(models).toContain('Edge 40')
    })

    it('usa sólo el fallback cuando la marca todavía no está en el catálogo', async () => {
      mocks.from.mockReturnValue(table([]))
      // La marca se busca sin distinguir mayúsculas contra la lista genérica.
      expect(await loadModelOptions('apple')).toContain('iPhone 15')
    })

    it('no consulta ni sugiere nada con la marca vacía', async () => {
      expect(await loadModelOptions('   ')).toEqual([])
      expect(mocks.from).not.toHaveBeenCalled()
    })

    it('una marca desconocida no rompe: devuelve lista vacía, el campo sigue libre', async () => {
      mocks.from.mockReturnValue(table([]))
      expect(await loadModelOptions('Marca Rara')).toEqual([])
    })
  })
})
