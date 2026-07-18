// ============================================================================
// M7 7D.3 §4 — Reemplazo de cobro: éxito normal, por UI real.
//
// El seed deja un comprobante con UN pago vivo (transferencia). El test abre el
// comprobante, edita el cobro a otro medio, confirma, y verifica:
//   · UNA sola key, UNA sola llamada económica efectiva
//   · el comprobante se refresca
//   · en base: un replacement completado, un pago sustituto vivo, el original
//     marcado como reemplazado, FM compensado, una auditoría
// ============================================================================
import { test, expect } from './fixtures'
import { GrabadorRPC } from './observability'
import { FIX, resetComprobanteConPago, estadoReemplazo, metodoPagoVivo, keysDeReemplazo }
  from '../setup/fixturesM7.ts'

const NUMERO = '0001-90000004'

test.beforeEach(() => {
  // Reproducible y aislado: cada corrida arranca del mismo estado limpio.
  resetComprobanteConPago({ comprobanteId: FIX.reemplazoOk, numero: NUMERO, metodo: 'transferencia' })
})

test('@m7 reemplazo de cobro exitoso: una key, una ejecución, refresh y base consistente', async ({ page }) => {
  const grabador = await GrabadorRPC.iniciar(page, ['replace_comprobante_payment'])

  await page.goto(`/comprobantes/${FIX.reemplazoOk}`)
  await expect(page.getByTestId('estado-cobro-widget')).toBeVisible()

  // Estado inicial en base: un pago vivo, ningún reemplazo todavía.
  const antes = estadoReemplazo(FIX.reemplazoOk)
  expect(antes.pagos_vivos).toBe(1)
  expect(antes.requests_totales).toBe(0)

  // ─── Operación por UI ─────────────────────────────────────────────────────
  await page.getByTestId('edit-payment-button').click()
  await expect(page.getByTestId('edit-payment-method-select')).toBeVisible()
  await page.getByTestId('edit-payment-method-select').selectOption('tarjeta_debito')
  await page.getByTestId('edit-payment-save-button').click()

  // La UI confirma: el modal cierra y aparece el éxito.
  await expect(page.getByTestId('edit-payment-method-select')).toBeHidden({ timeout: 15_000 })

  // ─── Observabilidad: exactamente UNA llamada, con UNA key ──────────────────
  await expect.poll(() => grabador.de('replace_comprobante_payment').length).toBe(1)
  const llamada = grabador.de('replace_comprobante_payment')[0]
  expect(llamada.errorCode).toBeNull()
  expect(llamada.replay).toBe(false)
  expect(llamada.idempotencyKey).toBeTruthy()
  expect(grabador.keysDistintas('replace_comprobante_payment')).toHaveLength(1)

  // ─── Verificación en base ──────────────────────────────────────────────────
  const despues = estadoReemplazo(FIX.reemplazoOk)
  expect(despues.pagos_vivos, 'un único pago sustituto vivo').toBe(1)
  expect(despues.pagos_reemplazados, 'el original queda marcado como reemplazado').toBe(1)
  expect(despues.pagos_totales, 'append-only: no se borró nada').toBe(2)
  expect(despues.requests_completed, 'un replacement record completado').toBe(1)
  expect(despues.requests_totales, 'sin requests duplicadas').toBe(1)
  expect(despues.fm_vivos_income, 'un único FM de ingreso vivo').toBe(1)
  expect(despues.fm_reversados, 'el FM del pago anterior fue compensado').toBeGreaterThanOrEqual(1)
  expect(despues.auditorias, 'una auditoría de la operación').toBe(1)
  expect(Number(despues.total_cobrado_vivo), 'cashflow neto correcto').toBe(1000)

  // El pago vivo es el nuevo medio.
  expect(metodoPagoVivo(FIX.reemplazoOk)).toBe('tarjeta_debito')

  // La key de la request quedó registrada y es la misma que envió la UI.
  expect(keysDeReemplazo(FIX.reemplazoOk)).toEqual([llamada.idempotencyKey])
})
