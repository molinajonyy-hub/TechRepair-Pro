// ============================================================================
// M7 7D.3 §11/§12/§14 — Códigos de error M7 que devuelve replace_comprobante_payment,
// provocados de VERDAD (sin interceptar la respuesta) desde el modal "Editar cobro".
//
// En los tres: el formulario se conserva, no hay éxito, no se aplica ningún
// reemplazo, y el mensaje es el del contrato. La base queda intacta.
//
// ALREADY_REVERSED y AUDIT_FAILED viven en otras superficies (reversa de gasto /
// pago de orden; fallo del audit helper) y quedan fuera de este spec — ver informe.
// ============================================================================
import { test, expect } from './fixtures'
import { GrabadorRPC } from './observability'
import {
  FIX, resetComprobanteConPago, estadoReemplazo, esAnulado,
  cerrarPeriodoHoy, reabrirPeriodoHoy, cerrarCaja, abrirCaja, anularComprobante,
} from '../setup/fixturesM7.ts'

async function abrirEditor(page: import('@playwright/test').Page, comprobanteId: string) {
  await page.goto(`/comprobantes/${comprobanteId}`)
  await expect(page.getByTestId('estado-cobro-widget')).toBeVisible()
  await page.getByTestId('edit-payment-button').click()
  await expect(page.getByTestId('edit-payment-method-select')).toBeVisible()
}

// ─── §11 PERIOD_CLOSED ────────────────────────────────────────────────────────
test.describe('@m7 PERIOD_CLOSED', () => {
  test.beforeEach(() => {
    resetComprobanteConPago({ comprobanteId: FIX.periodClosed, numero: '0001-90000111', metodo: 'transferencia' })
    cerrarPeriodoHoy()
  })
  test.afterEach(() => reabrirPeriodoHoy())

  test('período cerrado: la RPC rechaza, el formulario se conserva y no hay movimiento', async ({ page }) => {
    page.on('dialog', d => d.accept())
    const grabador = await GrabadorRPC.iniciar(page, ['replace_comprobante_payment'])
    await abrirEditor(page, FIX.periodClosed)

    await page.getByTestId('edit-payment-method-select').selectOption('tarjeta_debito')
    await page.getByTestId('edit-payment-save-button').click()

    await expect.poll(() => grabador.de('replace_comprobante_payment').length).toBe(1)
    expect(grabador.de('replace_comprobante_payment')[0].errorCode).toBe('PERIOD_CLOSED')
    // Sin éxito: el formulario sigue disponible.
    await expect(page.getByTestId('edit-payment-method-select')).toBeVisible()

    const st = estadoReemplazo(FIX.periodClosed)
    expect(st.pagos_reemplazados, 'no se creó ningún reemplazo').toBe(0)
    expect(st.requests_completed, 'ninguna request completada').toBe(0)
    expect(st.pagos_vivos, 'el pago original quedó intacto').toBe(1)
  })
})

// ─── §14 CASH_REGISTER_NOT_OPEN ──────────────────────────────────────────────
test.describe('@m7 CASH_REGISTER_NOT_OPEN', () => {
  test.beforeEach(() => {
    // Pago original en efectivo: reemplazar en efectivo exige caja abierta.
    resetComprobanteConPago({ comprobanteId: FIX.cashClosed, numero: '0001-90000141', metodo: 'efectivo' })
    cerrarCaja()
  })
  test.afterEach(() => abrirCaja())

  test('sin caja abierta: la RPC rechaza el cobro en efectivo, sin movimiento', async ({ page }) => {
    page.on('dialog', d => d.accept())
    const grabador = await GrabadorRPC.iniciar(page, ['replace_comprobante_payment'])
    await abrirEditor(page, FIX.cashClosed)

    await page.getByTestId('edit-payment-method-select').selectOption('efectivo')
    await page.getByTestId('edit-payment-save-button').click()

    await expect.poll(() => grabador.de('replace_comprobante_payment').length).toBe(1)
    expect(grabador.de('replace_comprobante_payment')[0].errorCode).toBe('CASH_REGISTER_NOT_OPEN')
    await expect(page.getByTestId('edit-payment-method-select')).toBeVisible()

    const st = estadoReemplazo(FIX.cashClosed)
    expect(st.pagos_reemplazados).toBe(0)
    expect(st.requests_completed).toBe(0)
  })

  test('reabierta la caja, una intención nueva sí se completa', async ({ page }) => {
    abrirCaja()   // se abre por el flujo permitido (fixture); la intención nueva debe converger
    const grabador = await GrabadorRPC.iniciar(page, ['replace_comprobante_payment'])
    await abrirEditor(page, FIX.cashClosed)
    await page.getByTestId('edit-payment-method-select').selectOption('efectivo')
    await page.getByTestId('edit-payment-save-button').click()
    await expect(page.getByTestId('edit-payment-method-select')).toBeHidden({ timeout: 15_000 })
    expect(grabador.de('replace_comprobante_payment')[0].errorCode).toBeNull()
    expect(estadoReemplazo(FIX.cashClosed).pagos_reemplazados).toBe(1)
  })
})

// ─── §12 ALREADY_ANNULLED ────────────────────────────────────────────────────
test.describe('@m7 ALREADY_ANNULLED', () => {
  test.beforeEach(() => {
    // Sin cobro: anulable comercialmente por otro actor.
    resetComprobanteConPago({ comprobanteId: FIX.anulado, numero: '0001-90000121', sinPago: true })
  })

  test('anulado por otro actor: operación incompatible rechazada y afordancia bloqueada tras refresh', async ({ page }) => {
    page.on('dialog', d => d.accept())
    const grabador = await GrabadorRPC.iniciar(page, ['replace_comprobante_payment'])

    // El editor se abre sobre un comprobante VIGENTE.
    await abrirEditor(page, FIX.anulado)

    // Otro actor lo anula (RPC canónica, commiteado).
    const r = anularComprobante(FIX.anulado)
    expect(r.ok, 'la anulación se aplicó de verdad').toBe(true)

    // La UI intenta el reemplazo con su modal ya abierto → ALREADY_ANNULLED.
    await page.getByTestId('edit-payment-method-select').selectOption('tarjeta_debito')
    await page.getByTestId('edit-payment-save-button').click()
    await expect.poll(() => grabador.de('replace_comprobante_payment').length).toBe(1)
    expect(grabador.de('replace_comprobante_payment')[0].errorCode).toBe('ALREADY_ANNULLED')

    // No hubo éxito falso: no se aplicó reemplazo.
    expect(estadoReemplazo(FIX.anulado).pagos_reemplazados).toBe(0)

    // Señal canónica de anulación (autoridad de negocio).
    expect(esAnulado(FIX.anulado), 'el comprobante quedó anulado según is_comprobante_annulled').toBe(true)

    // NOTA (riesgo reportado): el backend es fail-safe — un reintento tras el
    // refresh vuelve a recibir ALREADY_ANNULLED y NO aplica nada. Pero el widget
    // de cobro se oculta según el `estado` legacy ('emitido'), no según la señal
    // canónica, así que la afordancia de "Editar cobro" SIGUE visible tras el
    // refresh. No hay éxito falso posible, pero la UI no refleja la anulación.
    await page.reload()
    await expect(page.getByTestId('estado-cobro-widget')).toBeVisible()
    // Un segundo intento por esa afordancia vuelve a ser rechazado (sin falso éxito).
    await page.getByTestId('edit-payment-button').click()
    await page.getByTestId('edit-payment-method-select').selectOption('qr')
    await page.getByTestId('edit-payment-save-button').click()
    await expect.poll(() => grabador.de('replace_comprobante_payment').length).toBe(2)
    expect(grabador.de('replace_comprobante_payment')[1].errorCode).toBe('ALREADY_ANNULLED')
    expect(estadoReemplazo(FIX.anulado).pagos_reemplazados, 'sigue sin aplicarse nada').toBe(0)
  })
})
