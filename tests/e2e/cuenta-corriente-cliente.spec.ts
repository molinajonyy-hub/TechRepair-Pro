/**
 * @cc @finance
 * Cuenta corriente cliente — protege que:
 *   - Venta en CC genera deuda
 *   - Pagos parciales reducen saldo
 *   - Pago final saldo el balance
 *
 * POR QUÉ ESTÁ EN FIXME:
 *   1. Requiere ComprobanteProModal para crear venta en cuenta corriente
 *      (mismo problema que stock-sale y caja-comprobante).
 *   2. Los modales de pago en CuentasCorrientes no tienen data-testid:
 *      - Modal "Registrar pago": sin testid en amount input ni save button
 *      - El panel de detalle de cuenta abre inline (no URL nueva)
 *
 * QUÉ FALTA PARA ACTIVARLO:
 *   1. ComprobanteProModal data-testid (ver stock-sale.spec.ts)
 *   2. En CuentasCorrientes.tsx agregar:
 *      - data-testid="cc-register-payment-button" en botón Registrar pago
 *      - data-testid="cc-payment-amount-input" en el input de monto
 *      - data-testid="cc-payment-save-button" en el botón guardar
 *      - data-testid="cc-detail-balance" en el balance del panel de detalle
 *   3. helper registerCCPayment(page, amount, method)
 *
 * ESTADO PARCIAL QUE SÍ CORRE (en cc-health.spec.ts):
 *   - La lista de cuentas carga sin errores
 *   - La búsqueda funciona
 *   - Los balances se muestran sin NaN/undefined
 */
import { test } from '@playwright/test'

test.describe('@cc @finance Cuenta corriente cliente', () => {
  test('venta en CC genera deuda en la cuenta del cliente', async ({ page: _page }) => {
    test.fixme(
      true,
      'Requiere ComprobanteProModal y modales de CC con data-testid. Ver lista en el archivo.'
    )
  })

  test('pago parcial reduce saldo de CC correctamente', async ({ page: _page }) => {
    test.fixme(
      true,
      'Requiere modales de CC con data-testid: cc-register-payment-button, cc-payment-amount-input, cc-payment-save-button.'
    )
  })

  test('pago final salda la cuenta a $0', async ({ page: _page }) => {
    test.fixme(
      true,
      'Depende de los dos tests anteriores. Requiere todo el stack de CC y comprobante.'
    )
  })
})
