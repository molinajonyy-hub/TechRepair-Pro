// ============================================================================
// M7 7D.3 §5 — Reemplazo con respuesta perdida → retry → replay.
//
// El caso más peligroso de la idempotencia: la RPC se ejecuta y COMMITEA, pero
// la respuesta nunca llega al navegador. Si la UI reintentara con una key nueva,
// habría DOS reemplazos. Con la misma key, el segundo intento recibe un replay
// y el estado converge a UNA sola ejecución económica.
//
// Simulación de la pérdida (según el pliego): dejar que la request llegue de
// verdad al backend (route.fetch → la RPC corre y commitea), y recién entonces
// impedir que el navegador reciba la respuesta (abort). Nunca se aborta antes de
// que la RPC se ejecute.
// ============================================================================
import { test, expect } from './fixtures'
import { GrabadorRPC } from './observability'
import { FIX, resetComprobanteConPago, estadoReemplazo, metodoPagoVivo, keysDeReemplazo }
  from '../setup/fixturesM7.ts'

const NUMERO = '0001-90000005'

test.beforeEach(() => {
  resetComprobanteConPago({ comprobanteId: FIX.respuestaPerdida, numero: NUMERO, metodo: 'transferencia' })
})

test('@m7 respuesta perdida: mismo key, dos intentos HTTP, una sola ejecución económica', async ({ page }) => {
  page.on('dialog', d => d.accept())   // la UI avisa el error con window.alert
  const grabador = await GrabadorRPC.iniciar(page, ['replace_comprobante_payment'])

  let intentosHTTP = 0
  let perdidaSimulada = false
  await page.route('**/rest/v1/rpc/replace_comprobante_payment', async route => {
    intentosHTTP++
    if (!perdidaSimulada) {
      // 1er intento: dejar que la RPC corra y COMMITEE de verdad...
      const resp = await route.fetch()
      await resp.text()                 // consume el cuerpo: el server ya aplicó
      perdidaSimulada = true
      // ...y recién ahora perder la respuesta hacia el navegador.
      return route.abort('connectionfailed')
    }
    // 2º intento (retry de la UI con la MISMA key): pasa normalmente → replay.
    return route.fallback()
  })

  await page.goto(`/comprobantes/${FIX.respuestaPerdida}`)
  await expect(page.getByTestId('estado-cobro-widget')).toBeVisible()

  await page.getByTestId('edit-payment-button').click()
  await page.getByTestId('edit-payment-method-select').selectOption('tarjeta_credito')

  // ─── Intento 1: la respuesta se pierde ─────────────────────────────────────
  await page.getByTestId('edit-payment-save-button').click()
  // El modal NO cierra: el error de transporte deja la intención viva para retry.
  await expect.poll(() => intentosHTTP).toBe(1)
  await expect(page.getByTestId('edit-payment-method-select')).toBeVisible()

  // ─── Intento 2: retry con la misma key → replay → converge ────────────────
  await page.getByTestId('edit-payment-save-button').click()
  await expect(page.getByTestId('edit-payment-method-select')).toBeHidden({ timeout: 15_000 })

  // Dos intentos HTTP...
  expect(intentosHTTP).toBe(2)
  // ...pero UNA sola idempotency key.
  expect(keysDeReemplazo(FIX.respuestaPerdida)).toHaveLength(1)
  expect(grabador.keysDistintas('replace_comprobante_payment')).toHaveLength(1)
  // El segundo resultado observado por el navegador es un replay.
  const replay = grabador.de('replace_comprobante_payment').find(l => l.replay)
  expect(replay, 'el retry debe recibir un replay, no un segundo reemplazo').toBeTruthy()

  // ─── Una sola ejecución económica ──────────────────────────────────────────
  const st = estadoReemplazo(FIX.respuestaPerdida)
  expect(st.pagos_reemplazados, 'el original se reemplazó UNA vez').toBe(1)
  expect(st.pagos_vivos, 'un único pago sustituto vivo').toBe(1)
  expect(st.pagos_totales, 'no hay un tercer pago fantasma del retry').toBe(2)
  expect(st.requests_completed).toBe(1)
  expect(st.fm_vivos_income).toBe(1)
  expect(st.auditorias, 'una única auditoría pese a los dos intentos').toBe(1)
  expect(metodoPagoVivo(FIX.respuestaPerdida)).toBe('tarjeta_credito')
})
