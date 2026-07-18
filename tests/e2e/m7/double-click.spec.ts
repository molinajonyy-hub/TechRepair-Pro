// ============================================================================
// M7 7D.3 §17 — Dobles clics en confirmar reemplazo.
//
// Una doble confirmación rápida no puede producir dos operaciones económicas.
// No se confía sólo en `disabled`: se cuentan requests reales y filas en base.
// El seguro de fondo es la idempotency key — dos envíos de la misma intención
// llevan la MISMA key, así que el segundo, si llega, es un replay.
// ============================================================================
import { test, expect } from './fixtures'
import { GrabadorRPC } from './observability'
import { FIX, resetComprobanteConPago, estadoReemplazo, keysDeReemplazo } from '../setup/fixturesM7.ts'

const NUMERO = '0001-90000017'

test.beforeEach(() => {
  resetComprobanteConPago({ comprobanteId: FIX.dobleClick, numero: NUMERO, metodo: 'transferencia' })
})

test('@m7 doble clic en confirmar: una sola operación económica, una sola key', async ({ page }) => {
  page.on('dialog', d => d.accept())
  const grabador = await GrabadorRPC.iniciar(page, ['replace_comprobante_payment'])

  await page.goto(`/comprobantes/${FIX.dobleClick}`)
  await expect(page.getByTestId('estado-cobro-widget')).toBeVisible()
  await page.getByTestId('edit-payment-button').click()
  await page.getByTestId('edit-payment-method-select').selectOption('tarjeta_debito')

  // Doble clic rápido sobre confirmar.
  await page.getByTestId('edit-payment-save-button').dblclick()
  await expect(page.getByTestId('edit-payment-method-select')).toBeHidden({ timeout: 15_000 })

  // Cualquiera sea la cantidad de requests que hayan salido, todas comparten la
  // MISMA intención → una sola key.
  expect(grabador.keysDistintas('replace_comprobante_payment'), 'una sola key pese al doble clic').toHaveLength(1)

  // Autoridad: en base hay EXACTAMENTE un reemplazo, una request completada,
  // un pago vivo. Ningún duplicado.
  const st = estadoReemplazo(FIX.dobleClick)
  expect(st.pagos_reemplazados, 'una única sustitución').toBe(1)
  expect(st.pagos_vivos, 'un único pago vivo').toBe(1)
  expect(st.pagos_totales, 'sin pago duplicado por el segundo clic').toBe(2)
  expect(st.requests_completed, 'una única request completada').toBe(1)
  expect(st.requests_totales, 'ninguna key adicional').toBe(1)
  expect(st.auditorias, 'una única auditoría').toBe(1)
  expect(keysDeReemplazo(FIX.dobleClick)).toHaveLength(1)
})
