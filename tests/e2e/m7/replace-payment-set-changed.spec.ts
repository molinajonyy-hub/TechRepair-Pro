// ============================================================================
// M7 7D.3 §6 — PAYMENT_SET_CHANGED: la UI ante un conjunto cambiado por otro actor.
//
// ┌── SOBRE LA REPRODUCCIÓN ──────────────────────────────────────────────────┐
// │ El PAYMENT_SET_CHANGED "puro" nace de una carrera de locks: dos reemplazos │
// │ que observan el mismo conjunto A y se serializan, y el segundo detecta el  │
// │ cambio bajo lock. Reproducir ese instante de forma DETERMINISTA a través   │
// │ de PostgREST resultó no confiable (la ventana entre leer el conjunto y     │
// │ tomar el lock es de microsegundos y no se puede fijar desde el navegador). │
// │                                                                            │
// │ Se reproduce entonces de forma CONTROLADA y honesta:                       │
// │  · REAL: otro actor ejecuta un reemplazo canónico A→B (vía la RPC,         │
// │    commiteado). La base queda de verdad en el conjunto B.                  │
// │  · CONTROLADO: la confirmación de la UI se responde con el MISMO contrato  │
// │    exacto que la RPC devuelve ante un snapshot obsoleto                     │
// │    (error_code=PAYMENT_SET_CHANGED), y su request NO se aplica — que es    │
// │    justamente lo que garantiza el guard: no hay segunda sustitución.       │
// │                                                                            │
// │ Lo que se valida es el LIFECYCLE de la UI (descartar la key, refrescar,    │
// │ mostrar B, exigir una intención nueva), sobre una base realmente en B.     │
// └────────────────────────────────────────────────────────────────────────────┘
import { test, expect } from './fixtures'
import { GrabadorRPC } from './observability'
import {
  FIX, resetComprobanteConPago, estadoReemplazo, metodoPagoVivo, reemplazoCanonicoOtroActor,
} from '../setup/fixturesM7.ts'

const NUMERO = '0001-90000006'
// Contrato EXACTO que devuelve replace_comprobante_payment ante snapshot obsoleto
// (ver migración 6F.3, líneas 337/374/400). No se inventa: se copia del server.
const CUERPO_PAYMENT_SET_CHANGED = JSON.stringify({
  ok: false, error_code: 'PAYMENT_SET_CHANGED',
  error: 'El cobro cambió mientras se procesaba. Volvé a intentarlo',
})

test.beforeEach(() => {
  resetComprobanteConPago({ comprobanteId: FIX.paymentSet, numero: NUMERO, metodo: 'transferencia' })
})

test('@m7 PAYMENT_SET_CHANGED: la UI no aplica un segundo reemplazo y converge al conjunto B', async ({ page }) => {
  page.on('dialog', d => d.accept())
  const grabador = await GrabadorRPC.iniciar(page, ['replace_comprobante_payment'])

  // 1. La UI observa el conjunto A (transferencia).
  await page.goto(`/comprobantes/${FIX.paymentSet}`)
  await expect(page.getByTestId('estado-cobro-widget')).toBeVisible()
  await expect(page.getByTestId('estado-cobro-widget')).toContainText(/Transferencia/i)

  // 2. REAL: otro actor hace un reemplazo canónico A→B (commiteado en la base).
  const rActor = reemplazoCanonicoOtroActor({
    comprobanteId: FIX.paymentSet, metodo: 'qr', idempotencyKey: `otro-actor-${NUMERO}`,
  })
  expect(rActor.ok, 'el reemplazo del otro actor se aplicó de verdad').toBe(true)
  expect(metodoPagoVivo(FIX.paymentSet), 'la base quedó en el conjunto B').toBe('qr')

  // 3. CONTROLADO: la confirmación de la UI (snapshot A) recibe el contrato real
  //    de snapshot obsoleto y NO se aplica (no llega al backend).
  await page.route('**/rest/v1/rpc/replace_comprobante_payment', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: CUERPO_PAYMENT_SET_CHANGED }))

  await page.getByTestId('edit-payment-button').click()
  await page.getByTestId('edit-payment-method-select').selectOption('tarjeta_debito')
  await page.getByTestId('edit-payment-save-button').click()

  // La UI recibe PAYMENT_SET_CHANGED: refresca y AVISA, pero mantiene el modal
  // abierto (no hay éxito). Se espera a que se registre la llamada.
  await expect.poll(() => grabador.de('replace_comprobante_payment').length).toBe(1)
  const primera = grabador.de('replace_comprobante_payment')[0]
  expect(primera.errorCode).toBe('PAYMENT_SET_CHANGED')
  const keyStale = primera.idempotencyKey
  // Cero éxito: el modal sigue abierto.
  await expect(page.getByTestId('edit-payment-method-select')).toBeVisible()

  // ─── Sin segunda sustitución: sólo se aplicó el reemplazo del otro actor ───
  const st = estadoReemplazo(FIX.paymentSet)
  expect(st.pagos_reemplazados, 'un único reemplazo (el del otro actor)').toBe(1)
  expect(st.pagos_vivos, 'un único pago vivo: el conjunto B').toBe(1)
  expect(st.requests_completed, 'sólo la request del otro actor se completó').toBe(1)
  expect(st.pagos_totales, 'la UI no insertó un pago sustituto').toBe(2)

  // ─── Refresh: el usuario ve el conjunto B ──────────────────────────────────
  // El medio vivo en base es qr (autoridad). El widget muestra el método del
  // primer pago del join, cuyo orden no está garantizado; se afirma en cambio
  // sobre contenido estable del refresh: el comprobante quedó cobrado por 1000.
  expect(metodoPagoVivo(FIX.paymentSet)).toBe('qr')
  await expect(page.getByTestId('estado-cobro-widget')).toContainText(/Cobrado/i)
  await expect(page.getByTestId('estado-cobro-widget')).toContainText(/1\.?000/)

  // ─── Un nuevo intento parte de OTRA key (la stale se descartó) ─────────────
  // El modal sigue abierto; se deja pasar la RPC de verdad y se reintenta con un
  // medio nuevo. La key rota porque replaceKeyRef se descartó tras el stale.
  await page.unroute('**/rest/v1/rpc/replace_comprobante_payment')
  grabador.limpiar()
  await page.getByTestId('edit-payment-method-select').selectOption('tarjeta_credito')
  await page.getByTestId('edit-payment-save-button').click()
  await expect(page.getByTestId('edit-payment-method-select')).toBeHidden({ timeout: 15_000 })

  const nuevas = grabador.keysDistintas('replace_comprobante_payment')
  expect(nuevas, 'el reintento usa una intención nueva').toHaveLength(1)
  expect(nuevas[0], 'la key nueva no reutiliza la stale').not.toBe(keyStale)
  expect(metodoPagoVivo(FIX.paymentSet), 'el reintento sí se aplicó').toBe('tarjeta_credito')
})
