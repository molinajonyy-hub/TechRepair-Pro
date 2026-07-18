// ============================================================================
// M7 7D.3 §8 — Rotación de la key por los campos ECONÓMICOS, verificada por UI.
//
// Los 9 campos del hash de intención se prueban exhaustivamente en el unitario
// tests/unit/replacePaymentIdempotency.test.ts (incluidos los que el modal no
// expone hoy: currency, rate, provider, commission, amount_ars). Acá se verifica,
// con el componente REAL, que los campos VISIBLES (medio, monto, notas) rotan la
// key, y que un payload sin cambios la conserva.
//
// Truco: se intercepta la RPC con un error BENIGNO (sin error_code especial) que,
// según handleSaveEditPago, CONSERVA la key. Así se pueden encadenar varios
// intentos sin que un éxito descarte la key entre medio, y observar la rotación.
// ============================================================================
import { test, expect } from './fixtures'
import { GrabadorRPC } from './observability'
import { FIX, resetComprobanteConPago } from '../setup/fixturesM7.ts'

const NUMERO = '0001-90000008'
const ERROR_BENIGNO = JSON.stringify({ ok: false, error: 'error de validación de prueba' })

test.beforeEach(() => {
  resetComprobanteConPago({ comprobanteId: FIX.rotacion, numero: NUMERO, metodo: 'transferencia' })
})

test('@m7 la key rota al cambiar medio/monto/notas y se conserva sin cambios', async ({ page }) => {
  page.on('dialog', d => d.accept())
  const grabador = await GrabadorRPC.iniciar(page, ['replace_comprobante_payment'])

  // La RPC nunca "tiene éxito": devuelve un error benigno que conserva la key.
  // Nada se aplica en base; sólo se observa qué key envía la UI cada vez.
  await page.route('**/rest/v1/rpc/replace_comprobante_payment', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: ERROR_BENIGNO }))

  await page.goto(`/comprobantes/${FIX.rotacion}`)
  await page.getByTestId('edit-payment-button').click()

  const guardar = async () => {
    const antes = grabador.de('replace_comprobante_payment').length
    await page.getByTestId('edit-payment-save-button').click()
    await expect.poll(() => grabador.de('replace_comprobante_payment').length).toBe(antes + 1)
    return grabador.de('replace_comprobante_payment').at(-1)!.idempotencyKey
  }

  // 1. Medio A.
  await page.getByTestId('edit-payment-method-select').selectOption('efectivo')
  const kEfectivo = await guardar()

  // 2. Cambiar el MEDIO → rota.
  await page.getByTestId('edit-payment-method-select').selectOption('tarjeta_debito')
  const kTarjeta = await guardar()
  expect(kTarjeta, 'cambiar el medio rota la key').not.toBe(kEfectivo)

  // 3. Mismo payload otra vez → CONSERVA la key (retry, no nueva intención).
  const kTarjeta2 = await guardar()
  expect(kTarjeta2, 'sin cambios, la key se conserva').toBe(kTarjeta)

  // 4. Cambiar el MONTO → rota.
  await page.getByTestId('edit-payment-amount-input').fill('750')
  const kMonto = await guardar()
  expect(kMonto, 'cambiar el monto rota la key').not.toBe(kTarjeta)

  // 5. Cambiar las NOTAS → rota. (El input no tiene testid; se localiza por su
  //    placeholder, sin tocar el componente sólo para el test.)
  await page.getByPlaceholder(/Pagó en dos cuotas/i).fill('una nota nueva')
  const kNotas = await guardar()
  expect(kNotas, 'cambiar las notas rota la key').not.toBe(kMonto)

  // Todas las keys de intenciones distintas son únicas entre sí.
  const distintas = new Set([kEfectivo, kTarjeta, kMonto, kNotas])
  expect(distintas.size, 'cuatro intenciones económicas distintas → cuatro keys').toBe(4)
})
