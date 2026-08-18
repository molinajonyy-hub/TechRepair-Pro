// ─────────────────────────────────────────────────────────────────────────────
// Las superficies REALES, renderizadas, con los dos comprobantes reales que
// dejó la reparación histórica del 2026-08-14.
//
// El test anterior (estadoSinAutorizacionFiscal) cubría el legacy en pantalla.
// El smoke productivo encontró lo que faltaba, y todo estaba en superficies que
// ese test no tocaba:
//
//   · ComprobantePrintLayout —la hoja que se lleva el cliente— decidía su sello
//     con `estado === 'emitido'`. Los 53 conservan ese estado comercial, así
//     que el papel salía con "● Emitido" mientras la pantalla ya decía
//     "Sin autorización fiscal".
//   · El #45, autorizado por ARCA, mostraba "Borrador" y el número equivocado.
//
// Por eso acá se renderiza también el print layout, y se prueban los dos casos.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { ComprobanteDocumento } from '../../src/components/comprobantes/ComprobanteDocumento'
import { ComprobantePrintLayout } from '../../src/components/comprobantes/ComprobantePrintLayout'
import { ComprobanteActions } from '../../src/components/comprobantes/ComprobanteActions'
import { ComprobanteHeader } from '../../src/components/comprobantes/ComprobanteHeader'

const PERFIL = {
  nombre_comercial: 'Mi Negocio', domicilio_fiscal: '', orden_whatsapp: '',
  orden_instagram: '', orden_email_visible: '', email: '',
  comp_mostrar_agradecimiento: false, comp_mensaje_agradecimiento: '',
  comp_mostrar_notas: false, comp_notas: '',
} as never

const BASE = {
  id: 'c1', tipo: 'factura_c', fecha: '2026-06-16T12:00:00Z',
  total: 35000, subtotal: 35000, impuestos: 0,
  condicion_fiscal: 'Consumidor Final', currency: 'ARS', exchange_rate: 1,
}

/** #45 — reconciliado con ARCA. Comercialmente sigue en borrador. */
const C45 = {
  ...BASE,
  numero: '0001-00759033', numero_fiscal: '0010-00000045', punto_venta: '0010',
  tipo_comprobante_fiscal: '11', cae: '86249909766646', cae_vencimiento: '2026-06-26',
  estado: 'borrador', estado_fiscal: 'emitido', total_cobrado: 0,
} as never

/** Uno de los 53 — ya sin vencimiento, como lo deja la migración complementaria. */
const LEGACY = {
  ...BASE,
  numero: '0001-00672017', numero_fiscal: null, punto_venta: '0001',
  cae: null, cae_vencimiento: null,
  estado: 'emitido', estado_fiscal: 'sin_autorizacion_fiscal', total_cobrado: 35000,
} as never

/** Borrador comercial que todavía no fue autorizado por ARCA. */
const BORRADOR_PENDIENTE = {
  ...BASE,
  numero: '0001-00760000', numero_fiscal: null, punto_venta: '0001',
  tipo_comprobante_fiscal: '11', cae: null, cae_vencimiento: null,
  estado: 'borrador', estado_fiscal: 'pendiente_emision', total_cobrado: 0,
} as never

/** El PV local diverge a propósito del que ARCA autorizó. */
const FISCAL_PV_DIVERGENTE = {
  ...C45,
  punto_venta: '0007',
} as never

const REMITO = {
  ...BASE,
  tipo: 'remito', numero: '0007-00000015', numero_fiscal: null, punto_venta: '0007',
  cae: null, cae_vencimiento: null,
  estado: 'borrador', estado_fiscal: 'no_fiscal', total_cobrado: 0,
} as never

const BANNER_BORRADOR = 'El comprobante en borrador no tiene validez fiscal hasta ser emitido en ARCA.'

const props = (c: never) => ({
  comprobante: c, items: [], cliente: null, orden: null, profile: PERFIL,
})

const acciones = (c: never) => ({
  comprobante: c,
  onEmitir: () => {}, onAnular: () => {},
  onDescargarPDF: () => {}, onImprimir: () => {},
  onCrearNotaCredito: () => {},
})

// ─── Caso A — legacy ─────────────────────────────────────────────────────────

describe('Caso A · registro histórico sin autorización fiscal', () => {

  test('el documento lo declara sin autorización y no muestra vencimiento', () => {
    render(<ComprobanteDocumento {...props(LEGACY)} />)
    expect(screen.getByText('Sin autorización fiscal')).toBeTruthy()
    expect(screen.queryByText('Venc. CAE')).toBeNull()
    expect(screen.queryByText('CAE')).toBeNull()
  })

  test('la HOJA IMPRESA no lo sella como emitido', () => {
    // Este es el que fallaba: el papel decía "● Emitido" por el estado comercial.
    const { container } = render(<ComprobantePrintLayout {...props(LEGACY)} />)
    const sello = container.querySelector('.cpl-estado')
    expect(sello?.textContent ?? '').not.toContain('Emitido')
    expect(sello?.textContent ?? '').toContain('Sin autorización fiscal')
    expect(container.textContent).not.toContain('autorizado por ARCA')
    expect(container.textContent).not.toContain('Venc. CAE')
  })

  test('el número impreso no queda sobre-prefijado', () => {
    const { container } = render(<ComprobantePrintLayout {...props(LEGACY)} />)
    const num = container.querySelector('.cpl-doc-num')?.textContent ?? ''
    expect(num).toBe('0001-00672017')
    expect(num).not.toBe('0001-000100672017')
  })

  test('no se ofrece ninguna acción fiscal', () => {
    render(<ComprobanteActions {...acciones(LEGACY)} />)
    expect(screen.queryByRole('button', { name: /emitir/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /nota de cr/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /anular/i })).toBeNull()
  })
})

// ─── Caso B — #45 ────────────────────────────────────────────────────────────

describe('Caso B · #45 reconciliado con ARCA', () => {

  test('el documento muestra la identidad fiscal, no el número interno', () => {
    render(<ComprobanteDocumento {...props(C45)} />)
    expect(screen.getByText('0010-00000045')).toBeTruthy()
    expect(screen.queryByText('0010-000100759033')).toBeNull()
    expect(screen.queryByText('0001-00759033')).toBeNull()
  })

  test('el documento NO lo llama borrador: ARCA lo autorizó', () => {
    render(<ComprobanteDocumento {...props(C45)} />)
    expect(screen.queryByText('Borrador')).toBeNull()
    expect(screen.getByText('Emitido')).toBeTruthy()
  })

  test('el vencimiento del CAE no retrocede un día', () => {
    render(<ComprobanteDocumento {...props(C45)} />)
    expect(screen.getByText('26/06/2026')).toBeTruthy()
    expect(screen.queryByText('25/06/2026')).toBeNull()
  })

  test('la hoja impresa lo sella como emitido, con su identidad y su CAE', () => {
    const { container } = render(<ComprobantePrintLayout {...props(C45)} />)
    expect(container.querySelector('.cpl-doc-num')?.textContent).toBe('0010-00000045')
    expect(container.querySelector('.cpl-estado')?.textContent).toContain('Emitido')
    expect(container.textContent).toContain('86249909766646')
    expect(container.textContent).toContain('26/06/2026')
    expect(container.textContent).not.toContain('25/06/2026')
  })

  test('NO se ofrece emitir un comprobante que ya tiene CAE', () => {
    // El backend hace no-op, pero la UI anunciaba "emitido correctamente".
    render(<ComprobanteActions {...acciones(C45)} />)
    expect(screen.queryByRole('button', { name: /emitir en arca/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /emitir/i })).toBeNull()
  })

  test('sí se ofrece la nota de crédito, que es la vía correcta', () => {
    render(<ComprobanteActions {...acciones(C45)} />)
    expect(screen.getByRole('button', { name: /nota de cr/i })).toBeTruthy()
  })

  test('Actions lo presenta como emitido y válido', () => {
    const { container } = render(<ComprobanteActions {...acciones(C45)} />)
    expect(screen.getByText('Emitido y válido')).toBeTruthy()
    expect(within(container).getByText('Validado por ARCA')).toBeTruthy()
    expect(within(container).queryByText(BANNER_BORRADOR)).toBeNull()
    expect(screen.queryByRole('button', { name: /reintentar/i })).toBeNull()
  })
})

// ─── Que el arreglo no haya roto el caso sano ────────────────────────────────

describe('un borrador realmente no emitido conserva la advertencia fiscal', () => {
  test('muestra el banner y permite iniciar la emisión', () => {
    render(<ComprobanteActions {...acciones(BORRADOR_PENDIENTE)} />)
    expect(screen.getByText(BANNER_BORRADOR)).toBeTruthy()
    expect(screen.getByRole('button', { name: /emitir en arca/i })).toBeTruthy()
  })

  test('el documento lo rotula como interno y no imprime el PV local como fiscal', () => {
    const { container } = render(<ComprobantePrintLayout {...props(BORRADOR_PENDIENTE)} />)
    expect(container.textContent).toContain('N° interno · pendiente de emisión')
    expect(container.textContent).not.toContain('Pto. Venta 0001')
  })
})

describe('contrato de punto de venta visible', () => {
  test('un fiscal emitido muestra el PV de numero_fiscal, no el local', () => {
    const { container } = render(<ComprobantePrintLayout {...props(FISCAL_PV_DIVERGENTE)} />)
    expect(container.textContent).toContain('Pto. Venta 0010')
    expect(container.textContent).not.toContain('Pto. Venta 0007')

    const header = render(
      <ComprobanteHeader
        tipo="factura_c"
        numero="0007-00759033"
        numeroFiscal="0010-00000045"
        estado="borrador"
        puntoVenta="0007"
        estadoFiscal="emitido"
        cae="86249909766646"
      />,
    )
    expect(within(header.container).getByText('0010-00000045')).toBeTruthy()
    expect(within(header.container).getByText('Pto. Venta 0010')).toBeTruthy()
    expect(within(header.container).queryByText('Pto. Venta 0007')).toBeNull()
  })

  test('un remito conserva su número y su PV locales', () => {
    const { container } = render(<ComprobantePrintLayout {...props(REMITO)} />)
    expect(container.querySelector('.cpl-doc-num')?.textContent).toBe('0007-00000015')
    expect(container.textContent).toContain('Pto. Venta 0007')
    expect(container.textContent).not.toContain('pendiente de emisión')
  })
})

describe('un comprobante emitido normal sigue igual', () => {
  const SANO = {
    ...BASE,
    numero: '0010-00000098', numero_fiscal: '0010-00000098', punto_venta: '0010',
    tipo_comprobante_fiscal: '11', cae: '86294312345358', cae_vencimiento: '2026-07-15',
    estado: 'emitido', estado_fiscal: 'emitido', total_cobrado: 35000,
  } as never

  test('documento y hoja impresa lo sellan como emitido', () => {
    render(<ComprobanteDocumento {...props(SANO)} />)
    expect(screen.getByText('Emitido')).toBeTruthy()
    expect(screen.getByText('0010-00000098')).toBeTruthy()

    const { container } = render(<ComprobantePrintLayout {...props(SANO)} />)
    expect(container.querySelector('.cpl-estado')?.textContent).toContain('Emitido')
    expect(container.textContent).toContain('15/07/2026')
  })

  test('tampoco se le ofrece re-emitir', () => {
    render(<ComprobanteActions {...acciones(SANO)} />)
    expect(screen.queryByRole('button', { name: /emitir/i })).toBeNull()
  })
})
