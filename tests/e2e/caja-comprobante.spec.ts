/**
 * @cash @finance @local-only
 * Comprobante efectivo impacta caja — protege que una venta en efectivo
 * crea un movimiento en la caja del día.
 *
 * POR QUÉ ESTÁ EN FIXME:
 *   Igual que stock-sale.spec.ts: requiere interactuar con ComprobanteProModal
 *   para crear el comprobante. Sin data-testid en ese componente, el test
 *   es frágil y no confiable.
 *
 * ADICIONALMENTE:
 *   Los movimientos de caja dependen del estado del día (caja abierta/cerrada).
 *   Si la caja se cierra entre runs, el total cambia. Esto hace el test
 *   dependiente del estado externo.
 *
 * QUÉ FALTA PARA ACTIVARLO:
 *   1. Los mismos data-testid de ComprobanteProModal (ver stock-sale.spec.ts)
 *   2. data-testid="caja-movements-table" en la tabla de movimientos de CajaPage
 *   3. data-testid="caja-movement-description" en cada fila de movimiento
 *   4. helper createComprobanteViaUI(page, options)
 *   5. ensureCajaOpen() helper (ya creado en helpers/caja.ts)
 *
 * @local-only: No correr contra techrepairpro.app
 */
import { test } from '@playwright/test'

test.describe('@cash @finance @local-only Comprobante efectivo impacta caja', () => {
  test('comprobante efectivo crea movimiento en caja', async ({ page: _page }) => {
    test.fixme(
      true,
      'Requiere ComprobanteProModal con data-testid completos. ' +
      'Ver lista en stock-sale.spec.ts.'
    )
  })

  test('comprobante efectivo no duplica movimiento en caja', async ({ page: _page }) => {
    test.fixme(
      true,
      'Requiere ComprobanteProModal con data-testid completos.'
    )
  })
})
