// ============================================================================
// M7 7D.3 §5 — Gasto general: idempotencia end-to-end por UI.
//
// Este flujo (create_expense_with_finance) NO mandaba idempotency key hasta este
// lote: la RPC la aceptaba y el frontend simplemente no la enviaba, así que un
// doble submit o un retry tras una respuesta perdida creaba DOS gastos, con sus
// dos BFE y sus dos movimientos financieros.
//
// Los asserts no miran sólo la UI: verifican el efecto económico tabla por tabla
// (§9). Un test que valide "aparece un gasto en pantalla" pasaría igual con dos
// filas en base.
// ============================================================================
import { test, expect } from './fixtures'
import { GrabadorRPC } from './observability'
import { abrirCaja, resetGasto, estadoGasto } from '../setup/fixturesM7.ts'

const RPC = 'create_expense_with_finance'

/** Descripción única por escenario: es la clave con la que se mide en base. */
const DESC = {
  dobleClick: 'E2E 7D3 gasto doble clic',
  perdida:    'E2E 7D3 gasto respuesta perdida',
  conflicto:  'E2E 7D3 gasto conflicto',
  refresh:    'E2E 7D3 gasto refresh',
}

async function completarFormulario(page: import('@playwright/test').Page, desc: string, monto: string) {
  await page.goto('/expenses')
  await page.getByTestId('expense-new-button').click()
  await page.getByTestId('expense-amount-input').fill(monto)
  await page.getByTestId('expense-description-input').fill(desc)
}

test.beforeEach(() => {
  // El gasto en efectivo exige caja abierta: es precondición del escenario, no
  // lo que se está probando.
  abrirCaja()
})

test('@m7 doble clic en guardar gasto: una sola operación económica, una sola key', async ({ page }) => {
  resetGasto(DESC.dobleClick)
  const grabador = await GrabadorRPC.iniciar(page, [RPC])

  // Retener la primera request para que el segundo clic ocurra con la primera
  // TODAVIA en vuelo. Sin esto el segundo clic saldría después de la respuesta y
  // no probaría nada: el caso peligroso es la concurrencia real.
  let liberar: (() => void) | null = null
  const enVuelo = new Promise<void>(r => { liberar = r })
  let interceptadas = 0
  await page.route(`**/rest/v1/rpc/${RPC}`, async route => {
    interceptadas++
    if (interceptadas === 1) await enVuelo
    return route.fallback()
  })

  await completarFormulario(page, DESC.dobleClick, '1500')

  const guardar = page.getByTestId('expense-save-button')
  await guardar.click()
  await guardar.click({ force: true })   // 2º clic con la 1ª request en vuelo
  liberar!()

  await expect(page.getByTestId('expense-save-button')).toBeHidden({ timeout: 15_000 })

  const st = estadoGasto(DESC.dobleClick)
  expect(st.expenses, 'un solo gasto').toBe(1)
  expect(st.bfe, 'un solo asiento contable').toBe(1)
  expect(st.fm, 'un solo movimiento financiero').toBe(1)
  expect(st.auditorias, 'una sola auditoría').toBe(1)
  expect(st.keys, 'una sola idempotency key').toBe(1)
  expect(grabador.keysDistintas(RPC), 'el segundo clic no generó otra key').toHaveLength(1)
})

test('@m7 respuesta perdida al crear gasto: retry con la misma key, una sola ejecución', async ({ page }) => {
  resetGasto(DESC.perdida)
  const grabador = await GrabadorRPC.iniciar(page, [RPC])

  let intentosHTTP = 0
  let perdidaSimulada = false
  await page.route(`**/rest/v1/rpc/${RPC}`, async route => {
    intentosHTTP++
    if (!perdidaSimulada) {
      // La RPC corre y COMMITEA de verdad contra el Postgres local...
      const resp = await route.fetch()
      await resp.text()
      perdidaSimulada = true
      // ...y recién ahí se pierde la respuesta hacia el navegador.
      return route.abort('connectionfailed')
    }
    return route.fallback()   // retry de la UI con la MISMA key → replay
  })

  await completarFormulario(page, DESC.perdida, '2750')

  // Intento 1: la respuesta se pierde, el modal sigue abierto.
  await page.getByTestId('expense-save-button').click()
  await expect.poll(() => intentosHTTP).toBe(1)
  await expect(page.getByTestId('expense-amount-input')).toBeVisible()

  // Intento 2: mismo payload → misma key → replay.
  await page.getByTestId('expense-save-button').click()
  await expect(page.getByTestId('expense-save-button')).toBeHidden({ timeout: 15_000 })

  expect(intentosHTTP, 'hubo dos requests HTTP').toBe(2)

  // El invariante ECONOMICO va primero: es el que falla de verdad si la key no
  // viaja. Sin idempotency key este assert da 2 —dos gastos, dos asientos, dos
  // movimientos— que es exactamente el bug que este lote cierra. El guard de
  // doble submit del cliente no puede salvar este caso: la primera request ya
  // había terminado cuando el usuario reintenta.
  const st = estadoGasto(DESC.perdida)
  expect(st.expenses, 'un solo gasto pese a los dos intentos').toBe(1)
  expect(st.bfe, 'un solo asiento contable').toBe(1)
  expect(st.fm, 'un solo movimiento financiero').toBe(1)
  expect(st.auditorias, 'una única auditoría').toBe(1)

  expect(grabador.keysDistintas(RPC), 'con UNA sola idempotency key').toHaveLength(1)
  expect(st.keys).toBe(1)
})

test('@m7 IDEMPOTENCY_CONFLICT en gasto: error accionable, sin segunda escritura', async ({ page }) => {
  // La UI rota la key cuando cambia el payload, así que un conflicto no puede
  // salir "solo". Se fuerza pinneando la key de la 1ª request en la 2ª, que es
  // exactamente lo que pasaría con una key stale (p.ej. reenviada desde una
  // pestaña vieja). El server tiene que rechazar, no aplicar.
  resetGasto(DESC.conflicto)
  const errores: string[] = []
  page.on('dialog', d => { errores.push(d.message()); d.accept() })

  let keyFijada: string | null = null
  await page.route(`**/rest/v1/rpc/${RPC}`, async route => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    if (!keyFijada) keyFijada = body.p_idempotency_key
    else body.p_idempotency_key = keyFijada       // misma key, payload distinto
    return route.fallback({ postData: JSON.stringify(body) })
  })

  await completarFormulario(page, DESC.conflicto, '4000')
  await page.getByTestId('expense-save-button').click()
  await expect(page.getByTestId('expense-save-button')).toBeHidden({ timeout: 15_000 })

  const trasPrimero = estadoGasto(DESC.conflicto)
  expect(trasPrimero.expenses, 'el primer gasto sí se creó').toBe(1)

  // Segundo gasto, MISMO texto pero otro importe → el hash server-side difiere,
  // la key pinneada ya está usada → conflicto.
  await completarFormulario(page, DESC.conflicto, '9999')
  await page.getByTestId('expense-save-button').click()

  const alerta = page.getByTestId('expense-error-message')
  await expect(alerta).toBeVisible({ timeout: 15_000 })

  // El mensaje es accionable y NO expone el código crudo ni SQL.
  const texto = (await alerta.textContent()) ?? ''
  expect(texto).not.toMatch(/IDEMPOTENCY_CONFLICT|SELECT|INSERT|PL\/pgSQL/)
  expect(texto.length, 'el mensaje explica algo, no es un código').toBeGreaterThan(20)

  // Y sobre todo: no hubo segunda escritura.
  const st = estadoGasto(DESC.conflicto)
  expect(st.expenses, 'el conflicto no creó un segundo gasto').toBe(1)
  expect(st.bfe).toBe(1)
  expect(st.fm).toBe(1)
})

test('@m7 tras crear un gasto, un refresh completo muestra el estado del backend', async ({ page }) => {
  resetGasto(DESC.refresh)

  await completarFormulario(page, DESC.refresh, '3100')
  await page.getByTestId('expense-save-button').click()
  await expect(page.getByTestId('expense-save-button')).toBeHidden({ timeout: 15_000 })

  // Recarga dura: nada puede venir del estado en memoria de React.
  await page.reload()
  await expect(page.getByText(DESC.refresh).first()).toBeVisible({ timeout: 15_000 })

  // El formulario viejo no reaparece...
  await expect(page.getByTestId('expense-amount-input')).toBeHidden()
  // ...y el refresh no duplicó nada.
  const st = estadoGasto(DESC.refresh)
  expect(st.expenses).toBe(1)
  expect(st.fm).toBe(1)
})
