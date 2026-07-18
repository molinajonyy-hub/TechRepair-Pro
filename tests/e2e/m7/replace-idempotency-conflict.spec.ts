// ============================================================================
// M7 7D.3 §7 — IDEMPOTENCY_CONFLICT.
//
// En uso correcto NO ocurre: la UI rota la key cuando cambia el payload. Se
// fuerza con una inyección focalizada y segura: se reutiliza deliberadamente una
// key ya usada con OTRO payload. La RPC LOCAL produce el conflicto de verdad (no
// se simula la respuesta): sólo se reescribe la idempotency_key del request que
// sale del navegador, conservando autenticación y flujo real.
// ============================================================================
import { test, expect } from './fixtures'
import { GrabadorRPC } from './observability'
import { FIX, resetComprobanteConPago, estadoReemplazo, metodoPagoVivo, reemplazoCanonicoOtroActor }
  from '../setup/fixturesM7.ts'

const NUMERO = '0001-90000007'
const KEY_REUSADA = `conflict-key-${NUMERO}`

test.beforeEach(() => {
  resetComprobanteConPago({ comprobanteId: FIX.idemConflict, numero: NUMERO, metodo: 'transferencia' })
})

test('@m7 IDEMPOTENCY_CONFLICT: misma key, payload distinto → conflicto, sin éxito ni retry', async ({ page }) => {
  page.on('dialog', d => d.accept())
  const grabador = await GrabadorRPC.iniciar(page, ['replace_comprobante_payment'])

  // Se "quema" la key con un payload (qr) mediante un reemplazo real.
  const r = reemplazoCanonicoOtroActor({ comprobanteId: FIX.idemConflict, metodo: 'qr', idempotencyKey: KEY_REUSADA })
  expect(r.ok).toBe(true)

  // La UI enviará su reemplazo, pero se reescribe su key a la ya usada. Como su
  // payload (tarjeta_debito) difiere, el hash de intención no coincide con el
  // almacenado → la RPC devuelve IDEMPOTENCY_CONFLICT.
  await page.route('**/rest/v1/rpc/replace_comprobante_payment', route => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    body.p_idempotency_key = KEY_REUSADA
    return route.continue({ postData: JSON.stringify(body) })
  })

  await page.goto(`/comprobantes/${FIX.idemConflict}`)
  await expect(page.getByTestId('estado-cobro-widget')).toBeVisible()

  await page.getByTestId('edit-payment-button').click()
  await page.getByTestId('edit-payment-method-select').selectOption('tarjeta_debito')
  await page.getByTestId('edit-payment-save-button').click()

  // El conflicto se registró.
  await expect.poll(() => grabador.de('replace_comprobante_payment').length).toBe(1)
  expect(grabador.de('replace_comprobante_payment')[0].errorCode).toBe('IDEMPOTENCY_CONFLICT')

  // No hay éxito: el modal sigue abierto (se exige revisar el comprobante).
  await expect(page.getByTestId('edit-payment-method-select')).toBeVisible()
  // No se auto-generó otra key ni se reintentó: una sola llamada.
  expect(grabador.de('replace_comprobante_payment')).toHaveLength(1)

  // La UI no aplicó nada: sigue el conjunto del otro actor (qr).
  const st = estadoReemplazo(FIX.idemConflict)
  expect(st.pagos_reemplazados).toBe(1)
  expect(st.pagos_vivos).toBe(1)
  expect(metodoPagoVivo(FIX.idemConflict)).toBe('qr')
})
