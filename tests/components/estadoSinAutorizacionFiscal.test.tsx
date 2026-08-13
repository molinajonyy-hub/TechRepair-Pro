// ─────────────────────────────────────────────────────────────────────────────
// Estado historico `sin_autorizacion_fiscal` en las DOS superficies que lo
// muestran, renderizadas de verdad.
//
// Un test del helper no alcanza: ambos componentes tienen su PROPIO
// ESTADO_CONFIG con `?? ESTADO_CONFIG.borrador`, y ese fallback fue un bug real
// encontrado en el gate previo al merge:
//
//   · ComprobanteHeader indexaba por la clave del helper, que no existia en su
//     mapa -> caia a "Borrador".
//   · ComprobanteDocumento indexaba por `comprobante.estado`, el estado
//     COMERCIAL, ignorando el fiscal -> mostraba "Emitido".
//
// Los 53 registros reparados conservan estado='emitido' porque la venta ocurrio
// y se cobro. Por eso el caso de prueba usa esa combinacion exacta: es la que
// rompia.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { ComprobanteHeader } from '../../src/components/comprobantes/ComprobanteHeader'
import { ComprobanteDocumento } from '../../src/components/comprobantes/ComprobanteDocumento'
import {
  getComprobanteDisplayStatus,
  permiteAccionesDeEmision,
} from '../../src/utils/comprobanteStatus'

/** Como queda un registro reparado: venta emitida y cobrada, sin fiscal. */
const REPARADO = {
  estado: 'emitido' as const,
  estado_fiscal: 'sin_autorizacion_fiscal',
  cae: null,
  numero_fiscal: null,
  total_cobrado: 25000,
}

/** Etiquetas que NUNCA pueden aparecer para este estado. */
const PROHIBIDAS = ['Borrador', 'Emitido ARCA', 'Emitido', 'Pendiente', 'Error ARCA']

const PERFIL = {
  nombre_comercial: 'Mi Negocio', domicilio_fiscal: '', orden_whatsapp: '',
  orden_instagram: '', orden_email_visible: '', email: '',
} as never

const COMPROBANTE = {
  id: 'c1', tipo: 'factura_c', numero: '0001-00000123', numero_fiscal: null,
  punto_venta: '0001', cae: null, estado: 'emitido',
  estado_fiscal: 'sin_autorizacion_fiscal', fecha: '2026-05-14T12:00:00Z',
  total: 25000, subtotal: 25000, impuestos: 0, condicion_fiscal: 'Consumidor Final',
  total_cobrado: 25000, currency: 'ARS', exchange_rate: 1,
} as never

describe('sin_autorizacion_fiscal — representacion inequivoca', () => {

  test('el resolvedor canonico devuelve la clave correcta', () => {
    const s = getComprobanteDisplayStatus(REPARADO)
    expect(s.key).toBe('sin_autorizacion_fiscal')
    expect(s.label).toBe('Sin autorización fiscal')
  })

  test('ComprobanteHeader lo muestra sin caer a Borrador', () => {
    render(
      <ComprobanteHeader
        tipo="factura_c"
        numero="0001-00000123"
        estado="emitido"
        puntoVenta="0001"
        estadoFiscal="sin_autorizacion_fiscal"
        cae={null}
        totalCobrado={25000}
      />,
    )
    expect(screen.getByText('Sin autorización fiscal')).toBeTruthy()
    for (const mala of PROHIBIDAS) {
      expect(screen.queryByText(mala), `Header no puede decir "${mala}"`).toBeNull()
    }
  })

  test('ComprobanteDocumento lo muestra sin caer a Emitido', () => {
    // Indexaba por estado COMERCIAL ('emitido'), asi que este render fallaba.
    render(
      <ComprobanteDocumento
        comprobante={COMPROBANTE}
        items={[]}
        cliente={null}
        orden={null}
        profile={PERFIL}
      />,
    )
    expect(screen.getByText('Sin autorización fiscal')).toBeTruthy()
    for (const mala of PROHIBIDAS) {
      expect(screen.queryByText(mala), `Documento no puede decir "${mala}"`).toBeNull()
    }
  })

  test('no habilita acciones de emision', () => {
    expect(permiteAccionesDeEmision('sin_autorizacion_fiscal')).toBe(false)
  })

  test('los estados que SI son reintentables no se ven afectados', () => {
    // El arreglo no puede haber convertido un error tecnico en terminal.
    expect(permiteAccionesDeEmision('error_arca')).toBe(true)
    expect(getComprobanteDisplayStatus({
      estado: 'borrador', estado_fiscal: 'error_emision', cae: null,
    }).key).toBe('error_arca')
  })
})
