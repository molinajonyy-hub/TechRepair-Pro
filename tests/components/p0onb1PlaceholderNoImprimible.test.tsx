// ─────────────────────────────────────────────────────────────────────────────
// P0-ONBOARDING-1 — Un placeholder tecnico NUNCA sale impreso.
//
// `'Mi Negocio'` es el DEFAULT de `provision_my_business()`: existe porque
// `businesses.name` es NOT NULL y el tenant se crea antes de que el usuario
// elija un nombre. Nunca fue un nombre elegido.
//
// Con 18 de 20 negocios sin `nombre_comercial`, cinco superficies lo usaban de
// fallback y lo IMPRIMIAN en documentos que se le entregan al cliente del
// taller. `Comprobante.tsx` era peor: caia a `'TechRepair'`, el nombre del
// SaaS, en el encabezado del PDF del comercio.
//
// POR QUE ESTE TEST RENDERIZA DE VERDAD Y NO SOLO PRUEBA EL HELPER
// ────────────────────────────────────────────────────────────────
// Cada superficie resolvia el nombre POR SU CUENTA, con su propia cadena de
// fallback. Un test del helper pasaria aunque una de ellas siguiera con su
// `|| 'Mi Negocio'` intacto — que es exactamente el falso verde que hay que
// evitar.
//
// Y `ComprobantePrintLayout` es la mas peligrosa: esta OCULTA en el DOM
// (`display: none` hasta `window.print()`), asi que un probe filtrado por
// visibilidad no la ve. Por eso se asevera sobre `container.textContent`, que
// incluye lo oculto, y no sobre `screen.getByText`.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, expect } from 'vitest'
import { render } from '@testing-library/react'

import { ComprobanteDocumento } from '../../src/components/comprobantes/ComprobanteDocumento'
import { ComprobantePrintLayout } from '../../src/components/comprobantes/ComprobantePrintLayout'
import { WarrantyPrintLayout } from '../../src/components/warranties/WarrantyPrintLayout'
import { DEFAULT_PRINT_SETTINGS } from '../../src/hooks/useOrderPrintSettings'
import {
  resolveBusinessDisplayName,
  isPlaceholderBusinessName,
  PLACEHOLDER_BUSINESS_NAME,
} from '../../src/lib/businessIdentity'

const COMPROBANTE = {
  id: 'c1', tipo: 'factura_c', numero: '0001-00000123', numero_fiscal: null,
  punto_venta: '0001', cae: null, estado: 'emitido', estado_fiscal: 'emitido',
  fecha: '2026-05-14T12:00:00Z', total: 25000, subtotal: 25000, impuestos: 0,
  condicion_fiscal: 'Consumidor Final', total_cobrado: 25000,
  currency: 'ARS', exchange_rate: 1,
} as never

const perfil = (over: Record<string, unknown>) =>
  ({ ...DEFAULT_PRINT_SETTINGS, ...over }) as never

const WARRANTY = {
  id: 'w1', business_id: 'b1', number: 'G-0001', issue_date: '2026-05-01',
  customer_name: 'Cliente', phone_model: 'Equipo', warranty_days: 180,
  equipment_status: 'nuevo', checklist: {}, is_active: true,
  created_at: '2026-05-01T12:00:00Z', updated_at: '2026-05-01T12:00:00Z',
} as never

describe('P0-ONB1 · el placeholder tecnico no llega a un documento', () => {

  // ── El contrato del helper ────────────────────────────────────────────────
  test('el espejo tecnico se descarta; un nombre ELEGIDO se respeta', () => {
    // Caso C del contrato: sin nombre comercial y con el espejo en placeholder.
    expect(resolveBusinessDisplayName({
      nombreComercial: '', razonSocial: '', businessName: PLACEHOLDER_BUSINESS_NAME,
    })).toBe('')

    // El espejo tecnico SI se usa cuando es un nombre real.
    expect(resolveBusinessDisplayName({
      nombreComercial: '', razonSocial: '', businessName: 'Taller Real',
    })).toBe('Taller Real')

    // Caso D: la razon social es fallback permitido antes que el espejo.
    expect(resolveBusinessDisplayName({
      nombreComercial: '', razonSocial: 'Taller SRL', businessName: 'Otro',
    })).toBe('Taller SRL')

    // Caso B: el nombre comercial gana siempre.
    expect(resolveBusinessDisplayName({
      nombreComercial: 'Tecno', razonSocial: 'Tecno SRL', businessName: 'Tecno SA',
    })).toBe('Tecno')

    // Un usuario que TIPEA "Mi Negocio" eligio ese nombre: no se le borra.
    // Descartarlo seria adivinar en vez de leer — el error que produjo el lote.
    expect(resolveBusinessDisplayName({
      nombreComercial: PLACEHOLDER_BUSINESS_NAME,
    })).toBe(PLACEHOLDER_BUSINESS_NAME)

    expect(isPlaceholderBusinessName('  Mi Negocio  ')).toBe(true)
    expect(isPlaceholderBusinessName('Mi Negocio SRL')).toBe(false)
  })

  // ── El default que se renderiza en el primer frame ────────────────────────
  test('DEFAULT_PRINT_SETTINGS no trae un nombre inventado', () => {
    // Se renderiza antes de que responda la DB, y en un negocio sin
    // `nombre_comercial` NO era transitorio: quedaba impreso.
    expect(DEFAULT_PRINT_SETTINGS.nombre_comercial).toBe('')
  })

  // ── Caso C, superficie por superficie, renderizando ───────────────────────
  test('CASO C · sin nombre comercial, ninguna superficie imprime el placeholder', () => {
    const vacio = perfil({ nombre_comercial: '', razon_social: '' })

    const doc = render(<ComprobanteDocumento comprobante={COMPROBANTE} items={[]} profile={vacio} />)
    expect(doc.container.textContent).not.toContain(PLACEHOLDER_BUSINESS_NAME)
    doc.unmount()
    // NOTA: no se asevera «sin TechRepair» acá. `ComprobanteDocumento` tiene un
    // SYSTEM FOOTER deliberado («ID: … · TechRepair») que es marca del producto,
    // no un fallback del nombre del negocio. Quitarlo seria una decision de
    // branding ajena a este lote. Lo que si se cerro es el `|| 'TechRepair'` del
    // encabezado del PDF en `Comprobante.tsx`, que si era un fallback de nombre;
    // eso lo cubre el gate de codigo `guard:onboarding-canonical`.

    // La HOJA IMPRESA: oculta en el DOM. `textContent` la ve; un probe por
    // visibilidad no, y daria falso verde.
    const print = render(
      <ComprobantePrintLayout comprobante={COMPROBANTE} items={[]} cliente={null} orden={null} profile={vacio} />
    )
    expect(print.container.textContent).not.toContain(PLACEHOLDER_BUSINESS_NAME)
    print.unmount()

    const war = render(<WarrantyPrintLayout warranty={WARRANTY} settings={vacio} />)
    expect(war.container.textContent).not.toContain(PLACEHOLDER_BUSINESS_NAME)
    war.unmount()
  })

  // ── Caso B: el nombre real SI se imprime ──────────────────────────────────
  test('CASO B · con nombre comercial, las tres superficies lo imprimen', () => {
    const real = perfil({ nombre_comercial: 'Tecno Reparaciones', razon_social: '' })

    const doc = render(<ComprobanteDocumento comprobante={COMPROBANTE} items={[]} profile={real} />)
    expect(doc.container.textContent).toContain('Tecno Reparaciones')
    doc.unmount()

    const print = render(
      <ComprobantePrintLayout comprobante={COMPROBANTE} items={[]} cliente={null} orden={null} profile={real} />
    )
    expect(print.container.textContent).toContain('Tecno Reparaciones')
    print.unmount()

    const war = render(<WarrantyPrintLayout warranty={WARRANTY} settings={real} />)
    expect(war.container.textContent).toContain('Tecno Reparaciones')
    war.unmount()
  })

  // ── Caso A: un tenant reparado historicamente ─────────────────────────────
  test('CASO A · tenant reparado: el nombre que estaba en businesses.name se imprime', () => {
    // Asi queda un negocio despues de la migracion 20260904120000: el nombre
    // que el wizard habia dejado en `businesses.name` ahora vive en
    // `nombre_comercial`, que es de donde leen los documentos.
    const reparado = perfil({ nombre_comercial: 'Celu Express', razon_social: '' })
    const print = render(
      <ComprobantePrintLayout comprobante={COMPROBANTE} items={[]} cliente={null} orden={null} profile={reparado} />
    )
    expect(print.container.textContent).toContain('Celu Express')
    expect(print.container.textContent).not.toContain(PLACEHOLDER_BUSINESS_NAME)
    print.unmount()
  })

  // ── Caso D: fallback a razon social ───────────────────────────────────────
  test('CASO D · sin nombre comercial pero con razon social, se usa la razon social', () => {
    const soloRazon = perfil({ nombre_comercial: '', razon_social: 'Tecno Reparaciones SRL' })

    const war = render(<WarrantyPrintLayout warranty={WARRANTY} settings={soloRazon} />)
    expect(war.container.textContent).toContain('Tecno Reparaciones SRL')
    expect(war.container.textContent).not.toContain(PLACEHOLDER_BUSINESS_NAME)
    war.unmount()

    const print = render(
      <ComprobantePrintLayout comprobante={COMPROBANTE} items={[]} cliente={null} orden={null} profile={soloRazon} />
    )
    expect(print.container.textContent).toContain('Tecno Reparaciones SRL')
    print.unmount()
  })
})
