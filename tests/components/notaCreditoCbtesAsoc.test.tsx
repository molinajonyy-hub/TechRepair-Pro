import { beforeEach, describe, expect, it, vi } from 'vitest'

const supabaseMock = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: supabaseMock,
}))

vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../src/services/arcaService', () => ({
  default: {},
}))

const requireFeatureMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../src/utils/requireFeature', () => ({
  requireFeature: requireFeatureMock,
}))

const { default: comprobanteService } = await import('../../src/services/comprobanteService')

const ORIGINAL_ID = '00000000-0000-0000-0000-000000000045'
const NC_ID = '00000000-0000-0000-0000-000000000046'
const BUSINESS_ID = '00000000-0000-0000-0000-0000000000b0'
const USER_ID = '00000000-0000-0000-0000-0000000000a0'

function updateBuilder() {
  const builder = {
    update: vi.fn(),
    eq: vi.fn(),
  }
  builder.update.mockReturnValue(builder)
  builder.eq.mockReturnValue(builder)
  return builder
}

beforeEach(() => {
  vi.restoreAllMocks()
  supabaseMock.rpc.mockReset()
  supabaseMock.from.mockReset()
  supabaseMock.from.mockImplementation(() => updateBuilder())
  requireFeatureMock.mockReset()
  requireFeatureMock.mockResolvedValue(undefined)
})

const ITEM = {
  descripcion: 'Servicio',
  cantidad: 1,
  precio_unitario: 100,
}

describe('checkout genérico — gates fiscales antes de RPC', () => {
  it('rechaza nota_credito y obliga a partir del comprobante original', async () => {
    const result = await comprobanteService.crear({
      tipo: 'nota_credito',
      business_id: BUSINESS_ID,
      emitir_en_arca: true,
      es_fiscal: false,
      items: [ITEM],
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/comprobante fiscal original/i)
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
    expect(supabaseMock.from).not.toHaveBeenCalled()
  })

  it('rechaza emitir_en_arca=true para remito aunque el caller fuerce es_fiscal', async () => {
    const result = await comprobanteService.crear({
      tipo: 'remito',
      business_id: BUSINESS_ID,
      emitir_en_arca: true,
      es_fiscal: true,
      items: [ITEM],
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no fiscal no puede emitirse en ARCA/i)
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })

  it('persiste es_fiscal desde factura_c aunque el caller intente false', async () => {
    supabaseMock.rpc.mockResolvedValue({
      data: { status: 'created', comprobante_id: NC_ID },
      error: null,
    })
    vi.spyOn(comprobanteService, 'getById').mockResolvedValue({
      id: NC_ID,
      tipo: 'factura_c',
    } as any)

    const result = await comprobanteService.crear({
      tipo: 'factura_c',
      business_id: BUSINESS_ID,
      emitir_en_arca: false,
      es_fiscal: false,
      items: [ITEM],
    })

    expect(result.success).toBe(true)
    const checkoutCall = supabaseMock.rpc.mock.calls.find(
      ([name]) => name === 'create_comprobante_checkout_atomic',
    )
    expect(checkoutCall).toBeTruthy()
    expect(checkoutCall?.[1].p_payload).toEqual(expect.objectContaining({
      tipo: 'factura_c',
      es_fiscal: true,
      emitir_en_arca: false,
    }))
  })
})

describe('crearNotaCredito — CbtesAsoc canónico antes del borrador', () => {
  it('falla antes de create_credit_note_from_comprobante si falta CbteTipo en una identidad no derivable', async () => {
    vi.spyOn(comprobanteService, 'getById').mockResolvedValue({
      id: ORIGINAL_ID,
      tipo: 'nota_credito',
      numero_fiscal: '0010-00000045',
      tipo_comprobante_fiscal: null,
    } as any)

    const result = await comprobanteService.crearNotaCredito({
      originalComprobanteId: ORIGINAL_ID,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      // El guard es obligatorio aun cuando hoy no se pida emitir en ARCA.
      emitirEnArca: false,
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/identidad fiscal A\/B\/C completa/i)
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
    expect(supabaseMock.from).not.toHaveBeenCalled()
  })

  it('rechaza una NC como comprobante original aunque tenga identidad completa', async () => {
    vi.spyOn(comprobanteService, 'getById').mockResolvedValue({
      id: ORIGINAL_ID,
      tipo: 'nota_credito',
      numero_fiscal: '0010-00000045',
      tipo_comprobante_fiscal: '13',
    } as any)

    const result = await comprobanteService.crearNotaCredito({
      originalComprobanteId: ORIGINAL_ID,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emitirEnArca: true,
    })

    expect(result.success).toBe(false)
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })

  it('falla cerrado para Factura A antes de crear borrador o reclamar ARCA', async () => {
    vi.spyOn(comprobanteService, 'getById').mockResolvedValue({
      id: ORIGINAL_ID,
      tipo: 'factura_a',
      numero_fiscal: '0010-00000045',
      tipo_comprobante_fiscal: '1',
    } as any)
    const claim = vi.spyOn(comprobanteService, '_claimYEmitirArca')

    const result = await comprobanteService.crearNotaCredito({
      originalComprobanteId: ORIGINAL_ID,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emitirEnArca: true,
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/A\/B todavía no está soportada/i)
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
  })

  it('delega la emisión inmediata a emitir() para no duplicar claim/CbtesAsoc/finalización', async () => {
    const original = {
      id: ORIGINAL_ID,
      tipo: 'factura_c',
      numero_fiscal: '0010-00000045',
      tipo_comprobante_fiscal: '11',
      // Deliberadamente distinto: nunca puede filtrarse al CbtesAsoc.
      punto_venta: '0007',
      condicion_fiscal: 'Consumidor Final',
    }
    const notaCredito = { id: NC_ID, tipo: 'nota_credito' }

    vi.spyOn(comprobanteService, 'getById')
      .mockResolvedValueOnce(original as any)
      .mockResolvedValueOnce(notaCredito as any)
    const emitir = vi.spyOn(comprobanteService, 'emitir').mockResolvedValue({
      success: false,
      error: 'emisión simulada bloqueada después de inspeccionar el payload',
      alreadyInProgress: true,
    })
    supabaseMock.rpc.mockResolvedValue({
      data: {
        success: true,
        nc_id: NC_ID,
        nc_tipo_fiscal: 13,
        total: 12500,
        original_numero: '0010-00000045',
      },
      error: null,
    })

    const result = await comprobanteService.crearNotaCredito({
      originalComprobanteId: ORIGINAL_ID,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emitirEnArca: true,
    })

    expect(result.success).toBe(true)
    expect(supabaseMock.rpc).toHaveBeenCalledTimes(1)
    expect(supabaseMock.rpc).toHaveBeenCalledWith(
      'create_credit_note_from_comprobante',
      { p_comprobante_id: ORIGINAL_ID },
    )
    expect(emitir).toHaveBeenCalledTimes(1)
    expect(emitir).toHaveBeenCalledWith(NC_ID, BUSINESS_ID, USER_ID, true)
  })
})

describe('emitir — separación estricta entre fiscal ARCA y remito local', () => {
  it('un remito local se emite por issue_remito_atomic y no por UPDATE directo', async () => {
    vi.spyOn(comprobanteService, 'getById').mockResolvedValue({
      id: NC_ID, tipo: 'remito', estado: 'borrador', estado_fiscal: 'no_fiscal', items: [],
    } as any)
    supabaseMock.rpc.mockResolvedValue({ data: { ok: true, replay: false }, error: null })

    const result = await comprobanteService.emitir(NC_ID, BUSINESS_ID, USER_ID, false)

    expect(result).toEqual({ success: true })
    expect(supabaseMock.rpc).toHaveBeenCalledTimes(1)
    expect(supabaseMock.rpc).toHaveBeenCalledWith('issue_remito_atomic', {
      p_comprobante_id: NC_ID,
      p_business_id: BUSINESS_ID,
    })
    expect(supabaseMock.from).not.toHaveBeenCalled()
  })

  it('una Factura C con emitirArcaAhora=false falla sin UPDATE local', async () => {
    vi.spyOn(comprobanteService, 'getById').mockResolvedValue({
      id: NC_ID, tipo: 'factura_c', estado: 'borrador', estado_fiscal: 'pendiente_emision',
    } as any)

    const result = await comprobanteService.emitir(NC_ID, BUSINESS_ID, USER_ID, false)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/sólo puede emitirse mediante ARCA/i)
    expect(supabaseMock.from).not.toHaveBeenCalled()
  })

  it('un remito con emitirArcaAhora=true falla antes de feature, claim o UPDATE', async () => {
    vi.spyOn(comprobanteService, 'getById').mockResolvedValue({
      id: NC_ID, tipo: 'remito', estado: 'borrador', estado_fiscal: 'no_fiscal',
    } as any)
    const claim = vi.spyOn(comprobanteService, '_claimYEmitirArca')

    const result = await comprobanteService.emitir(NC_ID, BUSINESS_ID, USER_ID, true)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no fiscal no puede emitirse en ARCA/i)
    expect(requireFeatureMock).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
    expect(supabaseMock.from).not.toHaveBeenCalled()
  })

  it('NC-C diferida envía CbtesAsoc exacto y finaliza original + reversa tras CAE', async () => {
    const nc = {
      id: NC_ID,
      tipo: 'nota_credito',
      tipo_comprobante_fiscal: '13',
      comprobante_original_id: ORIGINAL_ID,
      estado: 'borrador',
      estado_fiscal: 'pendiente_emision',
      subtotal: 12500,
      total: 12500,
    }
    const original = {
      id: ORIGINAL_ID,
      tipo: 'factura_c',
      numero_fiscal: '0010-00000045',
      tipo_comprobante_fiscal: '11',
      condicion_fiscal: 'Consumidor Final',
    }
    vi.spyOn(comprobanteService, 'getById')
      .mockResolvedValueOnce(nc as any)
      .mockResolvedValueOnce(original as any)
    const claim = vi.spyOn(comprobanteService, '_claimYEmitirArca').mockResolvedValue({
      success: true,
      cae: '86249909766646',
    })
    const finalizar = vi.spyOn(comprobanteService, '_finalizarNotaCreditoAutorizada')
      .mockResolvedValue({ success: true })

    const result = await comprobanteService.emitir(NC_ID, BUSINESS_ID, USER_ID, true)

    expect(result).toEqual({ success: true, cae: '86249909766646' })
    expect(claim).toHaveBeenCalledWith(BUSINESS_ID, NC_ID, expect.objectContaining({
      tipo_comprobante: 13,
      cbte_asoc_tipo: 11,
      cbte_asoc_pto_vta: 10,
      cbte_asoc_nro: 45,
    }))
    expect(finalizar).toHaveBeenCalledWith(NC_ID)
  })

  it('CAE confirmado + finalización local fallida conserva success/CAE y queda recuperable', async () => {
    vi.spyOn(comprobanteService, 'getById')
      .mockResolvedValueOnce({
        id: NC_ID,
        tipo: 'nota_credito',
        tipo_comprobante_fiscal: '13',
        comprobante_original_id: ORIGINAL_ID,
        estado: 'borrador',
        subtotal: 12500,
        total: 12500,
      } as any)
      .mockResolvedValueOnce({
        id: ORIGINAL_ID,
        tipo: 'factura_c',
        numero_fiscal: '0010-00000045',
        tipo_comprobante_fiscal: '11',
      } as any)
    vi.spyOn(comprobanteService, '_claimYEmitirArca').mockResolvedValue({
      success: true,
      cae: '86249909766646',
      finalizationPending: true,
    })
    const finalizar = vi.spyOn(comprobanteService, '_finalizarNotaCreditoAutorizada')
      .mockResolvedValue({
        success: false,
        error: 'CAE autorizado; finalización local pendiente',
      })

    const result = await comprobanteService.emitir(NC_ID, BUSINESS_ID, USER_ID, true)

    expect(finalizar).toHaveBeenCalledWith(NC_ID)
    expect(result).toEqual({
      success: true,
      cae: '86249909766646',
      error: 'CAE autorizado; finalización local pendiente',
      finalizationPending: true,
    })
  })

  it('NC ya autorizada reintenta finalización idempotente sin volver a reclamar ARCA', async () => {
    vi.spyOn(comprobanteService, 'getById')
      .mockResolvedValueOnce({
        id: NC_ID,
        tipo: 'nota_credito',
        tipo_comprobante_fiscal: '13',
        comprobante_original_id: ORIGINAL_ID,
        estado: 'emitido',
        estado_fiscal: 'emitido',
        cae: '86249909766646',
      } as any)
      .mockResolvedValueOnce({
        id: ORIGINAL_ID,
        tipo: 'factura_c',
        numero_fiscal: '0010-00000045',
        tipo_comprobante_fiscal: '11',
      } as any)
    const claim = vi.spyOn(comprobanteService, '_claimYEmitirArca')
    const finalizar = vi.spyOn(comprobanteService, '_finalizarNotaCreditoAutorizada')
      .mockResolvedValue({ success: true })

    const result = await comprobanteService.emitir(NC_ID, BUSINESS_ID, USER_ID, true)

    expect(result).toEqual({ success: true, cae: '86249909766646' })
    expect(finalizar).toHaveBeenCalledWith(NC_ID)
    expect(claim).not.toHaveBeenCalled()
  })

  it('NC-A pendiente falla antes de feature y claim porque el payload A aún no existe', async () => {
    vi.spyOn(comprobanteService, 'getById')
      .mockResolvedValueOnce({
        id: NC_ID,
        tipo: 'nota_credito',
        tipo_comprobante_fiscal: '3',
        comprobante_original_id: ORIGINAL_ID,
        estado: 'borrador',
      } as any)
      .mockResolvedValueOnce({
        id: ORIGINAL_ID,
        tipo: 'factura_a',
        numero_fiscal: '0010-00000045',
        tipo_comprobante_fiscal: '1',
      } as any)
    const claim = vi.spyOn(comprobanteService, '_claimYEmitirArca')

    const result = await comprobanteService.emitir(NC_ID, BUSINESS_ID, USER_ID, true)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/A\/B todavía no está soportada/i)
    expect(requireFeatureMock).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
  })
})

describe('_finalizarNotaCreditoAutorizada — retry idempotente', () => {
  it('puede repetirse y recuperarse de una reversa pendiente sin duplicar identidad', async () => {
    supabaseMock.rpc
      .mockResolvedValueOnce({ data: { ok: false, error_code: 'TEMP' }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, replay: true }, error: null })

    const primero = await comprobanteService._finalizarNotaCreditoAutorizada(NC_ID)
    const segundo = await comprobanteService._finalizarNotaCreditoAutorizada(NC_ID)

    expect(primero.success).toBe(false)
    expect(segundo.success).toBe(true)
    expect(supabaseMock.from).not.toHaveBeenCalled()
    expect(supabaseMock.rpc).toHaveBeenCalledTimes(2)
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(
      1, 'create_credit_note_finance_reversal', { p_nc_id: NC_ID },
    )
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(
      2, 'create_credit_note_finance_reversal', { p_nc_id: NC_ID },
    )
  })
})
