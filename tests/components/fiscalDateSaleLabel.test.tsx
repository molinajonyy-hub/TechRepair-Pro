// FISCAL DATE ARGENTINA (Part 1): the document surfaces show `comprobante.fecha`
// for what it is — the SALE date, on Argentina's civil calendar — and never call
// it "Fecha de emisión" while the fiscal date accepted by ARCA is not persisted.
// Fixtures mirror 0010-00000175 / 0010-00000176 (sold 10/09, issued 11/09) with
// fake CAE values.
import { describe, test, expect } from 'vitest'
import { render } from '@testing-library/react'

import { ComprobanteDocumento } from '../../src/components/comprobantes/ComprobanteDocumento'
import { ComprobantePrintLayout } from '../../src/components/comprobantes/ComprobantePrintLayout'
import { arcaFiscalDate } from '../../src/lib/fiscalCalendar'

const PERFIL = {
  nombre_comercial: 'Mi Negocio', domicilio_fiscal: '', orden_whatsapp: '',
  orden_instagram: '', orden_email_visible: '', email: '',
  comp_mostrar_agradecimiento: false, comp_mensaje_agradecimiento: '',
  comp_mostrar_notas: false, comp_notas: '',
} as never

const EMITIDA = {
  tipo: 'factura_c', impuestos: 0, condicion_fiscal: 'Consumidor Final',
  currency: 'ARS', exchange_rate: 1, punto_venta: '0010', tipo_comprobante_fiscal: '11',
  estado: 'emitido', estado_fiscal: 'emitido', cae_vencimiento: '2026-09-21',
}

const FIXTURES = [
  {
    nombre: 'like 175', issuedAt: '2026-09-11T12:43:35-03:00',
    comprobante: {
      ...EMITIDA, id: 'fixture-175', numero: '0010-00759259', numero_fiscal: '0010-00000175',
      cae: '00000000000175', total: 20000, subtotal: 20000, total_cobrado: 20000,
      fecha: '2026-09-10T22:25:32.952Z',
    },
  },
  {
    nombre: 'like 176', issuedAt: '2026-09-11T12:44:08-03:00',
    comprobante: {
      ...EMITIDA, id: 'fixture-176', numero: '0010-00759258', numero_fiscal: '0010-00000176',
      cae: '00000000000176', total: 21000, subtotal: 21000, total_cobrado: 21000,
      fecha: '2026-09-10T15:15:49.422Z',
    },
  },
  {
    // Sold at 22:30 ART: the UTC calendar is already 11/09, the sale day is not.
    nombre: 'sale after 21:00 ART', issuedAt: '2026-09-11T12:00:00-03:00',
    comprobante: {
      ...EMITIDA, id: 'fixture-late', numero: '0010-00759300', numero_fiscal: '0010-00000900',
      cae: '00000000000900', total: 5000, subtotal: 5000, total_cobrado: 5000,
      fecha: '2026-09-11T01:30:00.000Z',
    },
  },
]

const props = (c: unknown) => ({
  comprobante: c as never, items: [], cliente: null, orden: null, profile: PERFIL,
})

describe('sale date vs fiscal issue date on the document surfaces', () => {
  for (const { nombre, issuedAt, comprobante } of FIXTURES) {
    test(`${nombre}: the screen document shows the sale date, labelled as such`, () => {
      const { container } = render(<ComprobanteDocumento {...props(comprobante)} />)
      const text = container.textContent ?? ''
      expect(text).toContain('Fecha de venta')
      expect(text).toContain('10/09/2026')
      expect(text).not.toMatch(/Fecha de emisi/)
      expect(text).not.toContain('11/09/2026') // no guessed fiscal date
    })

    test(`${nombre}: the printed sheet shows the sale date, labelled as such`, () => {
      const { container } = render(<ComprobantePrintLayout {...props(comprobante)} />)
      const text = container.textContent ?? ''
      expect(text).toContain('Fecha de venta')
      expect(text).toContain('10/09/2026')
      expect(text).not.toMatch(/Fecha de emisi/)
      expect(text).not.toContain('11/09/2026')
    })

    test(`${nombre}: its delayed issuance goes to ARCA with the issuance civil day`, () => {
      expect(arcaFiscalDate(new Date(issuedAt))).toBe('20260911')
      expect(arcaFiscalDate(new Date(comprobante.fecha))).toBe('20260910')
    })
  }
})
