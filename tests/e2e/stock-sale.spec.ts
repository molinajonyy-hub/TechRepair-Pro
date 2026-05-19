/**
 * @stock @finance
 * Venta descuenta stock una sola vez — protege stock_processed y que
 * editar cobro no re-descuenta stock.
 *
 * POR QUÉ ESTÁ EN FIXME:
 *   Crear un comprobante requiere ComprobanteProModal, que es el componente
 *   más complejo del sistema:
 *   - Scanner detection por heurística de keypress timing
 *   - Keyboard shortcuts (F2, F4, Enter, Ctrl+B)
 *   - Línea de ítems dinámica sin data-testid
 *   - Payment chips con input de monto dinámico
 *   - Draft autosave a localStorage
 *   - Sin data-testid en ninguno de sus inputs
 *
 * QUÉ FALTA PARA ACTIVARLO:
 *   1. Agregar data-testid en ComprobanteProModal:
 *      - "comprobante-product-search" en el input de búsqueda de producto
 *      - "comprobante-product-option" en los resultados del dropdown
 *      - "comprobante-qty-input-{n}" en el input de cantidad de cada ítem
 *      - "comprobante-payment-efectivo" en el chip/botón de efectivo
 *      - "comprobante-payment-amount" en el input de monto de pago
 *      - "comprobante-save-button" en el botón "Cobrar"
 *   2. Crear helper createComprobanteViaUI(page, options)
 *   3. Verificar que stock_processed se setea al crear comprobante (no al editar cobro)
 *
 * INVARIANTE A PROTEGER:
 *   - Venta efectivo → stock -= cantidad (una sola vez)
 *   - Editar cobro (efectivo → transferencia) → stock sin cambio
 *   - Crear dos veces el mismo comprobante → stock -= 2 (no -= 1)
 */
import { test } from '@playwright/test'

test.describe('@stock @finance Venta descuenta stock una sola vez', () => {
  test('venta efectivo descuenta stock y editar cobro no re-descuenta', async ({ page: _page }) => {
    test.fixme(
      true,
      'Requiere data-testid en ComprobanteProModal (product-search, payment-efectivo, save-button). ' +
      'Ver comentario del archivo para la lista completa de lo que falta.'
    )
  })

  test('venta cuenta-corriente: stock descuenta y luego cobro no vuelve a descontar', async ({ page: _page }) => {
    test.fixme(
      true,
      'Igual que el test anterior — depende de ComprobanteProModal con testids.'
    )
  })
})
