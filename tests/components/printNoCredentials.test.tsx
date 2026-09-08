// ─────────────────────────────────────────────────────────────────────────────
// ORDERS-V2-0 — la impresión NUNCA recibe ni renderiza credenciales del equipo.
//
// `ServiceOrderPrint` tenía una fila «Contraseña» alimentada por
// `device.password`. Desde MOBILE-2A el acceso vive cifrado en
// `private.order_device_access_secrets` y sólo se revela por
// `reveal_order_device_access`, que audita cada lectura. Una hoja impresa no
// tiene trazabilidad: no se sabe quién la leyó ni se puede retirar.
//
// El campo se retiró del TIPO, no se ocultó con CSS. Estos tests cubren las dos
// mitades de esa afirmación:
//   1. que el componente no lo pinte aunque un llamador lo cuele por `any`;
//   2. que el archivo fuente no vuelva a nombrarlo — un `display:none` o un
//      `{false && ...}` pasaría el test de render pero dejaría el camino vivo.
//
// La copia INTERNA es la que hay que probar: la fila estaba sólo ahí, así que
// un probe sobre la copia del cliente daba verde sin tocar el problema.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

// La hoja resuelve la identidad del negocio por su cuenta; acá sólo interesa
// qué campos del EQUIPO llegan al papel.
vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ businessId: 'biz-a' }) }))

import { ServiceOrderPrint, type ServiceOrderData } from '../../src/components/print/ServiceOrderPrint'
import { DEFAULT_PRINT_SETTINGS } from '../../src/hooks/useOrderPrintSettings'

const SOURCE = resolve(process.cwd(), 'src/components/print/ServiceOrderPrint.tsx')

/**
 * Las guardas de código miran CÓDIGO. Los comentarios que explican por qué se
 * retiró algo nombran justamente lo retirado, y hacerlos fallar obligaría a
 * borrar la explicación para que pase el test.
 */
function sourceWithoutComments(): string {
  return readFileSync(SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
const PIN = '4826'

const ORDER: ServiceOrderData = {
  id: 'abc12345-0000-0000-0000-000000000000',
  created_at: '2026-05-14T12:00:00Z',
  status: 'new',
  customer: { name: 'Cliente Demo', phone: '3512345678' },
  device: { type: 'smartphone', brand: 'Samsung', model: 'A04e', imei: '490154203237518', serial: 'SER-1' },
  reported_issue: 'No carga',
}

/** Un llamador viejo que todavía intenta pasar el secreto. */
const WITH_SECRET = {
  ...ORDER,
  device: { ...ORDER.device, password: PIN, pin: PIN, pattern: '1-2-3' },
} as unknown as ServiceOrderData

function renderPrint(order: ServiceOrderData) {
  // `container.textContent` incluye lo oculto: la copia interna puede estar
  // fuera de pantalla y un probe filtrado por visibilidad no la vería.
  return render(<ServiceOrderPrint order={order} printSettings={DEFAULT_PRINT_SETTINGS} />).container
}

describe('ORDERS-V2-0 · la impresión no lleva credenciales', () => {
  it('no renderiza el secreto aunque un llamador lo cuele por `any`', () => {
    const container = renderPrint(WITH_SECRET)
    expect(container.textContent).not.toContain(PIN)
    expect(container.textContent).not.toContain('1-2-3')
  })

  it('no queda ni la etiqueta del campo en ninguna de las dos copias', () => {
    const container = renderPrint(WITH_SECRET)
    // La hoja lleva COPIA CLIENTE y USO INTERNO: si sólo se renderizara una,
    // este test daría un verde falso.
    expect(container.textContent).toContain('COPIA CLIENTE')
    expect(container.textContent).toContain('USO INTERNO')
    expect(container.textContent).not.toMatch(/Contrase[ñn]a/i)
    expect(container.textContent).not.toMatch(/\bPIN\b/)
    expect(container.textContent).not.toMatch(/Patr[óo]n/i)
  })

  it('sigue imprimiendo lo que sí corresponde', () => {
    const container = renderPrint(ORDER)
    expect(container.textContent).toContain('490154203237518')
    expect(container.textContent).toContain('Samsung A04e')
    expect(container.textContent).toContain('No carga')
  })

  it('el componente no nombra credenciales — no es un `display:none`', () => {
    const source = sourceWithoutComments()
    expect(source).not.toMatch(/device\.password/)
    expect(source).not.toMatch(/device\.pin\b/)
    expect(source).not.toMatch(/label="Contrase/i)
  })
})

describe('ORDERS-V2-0 · la impresión no llama a servicios externos', () => {
  it('ningún identificador de orden sale hacia api.qrserver.com', () => {
    const container = renderPrint(ORDER)
    for (const img of Array.from(container.querySelectorAll('img'))) {
      expect(img.getAttribute('src') ?? '').not.toContain('qrserver')
    }
    expect(sourceWithoutComments()).not.toContain('qrserver')
  })
})
