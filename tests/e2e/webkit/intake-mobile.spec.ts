/**
 * ORDERS-V2-0.1 · WebKit REAL a 390×844 (iPhone 13).
 *
 * Este archivo existe porque el E2E responsive que ya había NO detectó nada de
 * lo que el owner encontró en dos minutos con su teléfono. La razón es que
 * corría Chromium con el viewport chico, y los dos bugs eran divergencias de
 * MOTOR, no de ancho:
 *
 *   1. `BarcodeDetector` no existe en WebKit → el scanner decía
 *      "no disponible" sin siquiera intentar abrir la cámara.
 *   2. `<datalist>` no despliega opciones en WebKit móvil → marca y modelo se
 *      veían como campos de texto pelados.
 *
 * Chromium tiene la primera API y renderiza la segunda, así que daba verde con
 * los dos defectos presentes.
 *
 * ── LÍMITE HONESTO DE ESTE ARCHIVO ────────────────────────────────────────
 * El WebKit headless de Playwright comparte el motor con Safari, pero NO trae
 * el stack de medios: `navigator.mediaDevices` no existe, aunque en Safari iOS
 * sobre HTTPS sí. Por eso los tests de cámara **inyectan** `mediaDevices` para
 * reproducir el dispositivo del owner (sin BarcodeDetector, con getUserMedia).
 * Lo que WebKit prueba por sí solo es la ausencia de `BarcodeDetector`, que es
 * la mitad decisiva del root cause. Esto no reemplaza un smoke en un iPhone
 * de verdad.
 */
import { expect, test, type Page } from '@playwright/test'

const EVIDENCE = 'docs/orders-v2-0-1-evidence'
/** El cliente que siembra `e2e:prepare`. */
const SEED_CUSTOMER = 'Cliente E2E'

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'no puede scrollear en horizontal').toBeLessThanOrEqual(0)
}

async function continuar(page: Page) {
  await page.getByRole('button', { name: 'Continuar' }).last().click()
}

/** Elige el cliente sembrado. La búsqueda exige 2 caracteres como mínimo. */
async function elegirCliente(page: Page) {
  await page.getByTestId('customer-picker-search').fill(SEED_CUSTOMER)
  const option = page.getByRole('button', { name: new RegExp(SEED_CUSTOMER) }).first()
  await option.waitFor({ timeout: 20000 })
  await option.click()
  await continuar(page)
}

/** Simula el equipo del owner sobre el motor real: sin la API, con cámara. */
async function simularSafariConCamara(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })),
        enumerateDevices: () => Promise.resolve([{ kind: 'videoinput', label: '' }]),
      },
    })
  })
}

test.describe('@webkit ORDERS-V2-0.1 · WebKit móvil', () => {
  test('el motor confirma el root cause: BarcodeDetector no existe', async ({ page }) => {
    await page.goto('/orders/new')
    const hasDetector = await page.evaluate(() => 'BarcodeDetector' in window)

    // Ésta es la medición que explica el bug. La compuerta del scanner era
    // exactamente `!window.BarcodeDetector`, así que en este motor —el del
    // iPhone del owner— la app se rendía siempre.
    expect(hasDetector, 'WebKit no implementa la Barcode Detection API').toBe(false)
  })

  test('sin BarcodeDetector el scanner ofrece la cámara en vez de rendirse', async ({ page }) => {
    await simularSafariConCamara(page)
    await page.goto('/orders/new')
    await elegirCliente(page)

    await page.getByTestId('intake-brand').fill('Samsung')
    await page.getByTestId('intake-model').fill('A04e')
    await continuar(page)

    await page.getByRole('button', { name: 'Escanear' }).first().click()
    await expect(page.getByTestId('barcode-scanner')).toBeVisible()

    // ANTES: cartel "Este navegador no ofrece escaneo" y ningún botón.
    // AHORA: se ofrece pedir permiso, porque la cámara sí está.
    await expect(page.getByTestId('scanner-start')).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/webkit-390-01-scanner-ofrece-camara.png` })

    // Y si el permiso se niega, se explica cómo destrabarlo — no se culpa al
    // navegador ni se pierde el ingreso manual.
    await page.getByTestId('scanner-start').click()
    await expect(page.getByTestId('scanner-error')).toContainText(/No diste permiso/i)
    await expect(page.getByText(/escribir el número de serie a mano/i)).toBeVisible()
    await page.screenshot({ path: `${EVIDENCE}/webkit-390-02-scanner-permiso-denegado.png` })
  })

  test('marca y modelo se despliegan de verdad en WebKit', async ({ page }) => {
    await page.goto('/orders/new')
    await elegirCliente(page)

    const marca = page.getByTestId('intake-brand')
    await expect(marca).toBeVisible()
    await expect(marca).toHaveAttribute('role', 'combobox')

    // El corazón del bug: en WebKit `<datalist>` no mostraba nada. Con el
    // combobox propio la lista es DOM de la app y se puede aseverar.
    await marca.click()
    const listbox = page.getByRole('listbox', { name: 'Sugerencias de Marca' })
    await expect(listbox).toBeVisible()
    expect(await listbox.getByRole('option').count()).toBeGreaterThan(0)
    await page.screenshot({ path: `${EVIDENCE}/webkit-390-03-marca-abierta.png` })

    await marca.fill('Samsung')
    await page.getByRole('option', { name: 'Samsung', exact: true }).first().click()
    await expect(marca).toHaveValue('Samsung')

    // El texto libre sigue permitido: el taller recibe equipos que el catálogo
    // no conoce.
    const modelo = page.getByTestId('intake-model')
    await modelo.click()
    await modelo.fill('Modelo Inexistente 9000')
    await expect(modelo).toHaveValue('Modelo Inexistente 9000')
    await page.screenshot({ path: `${EVIDENCE}/webkit-390-04-modelo-texto-libre.png` })

    await noHorizontalOverflow(page)
  })

  test('el presupuesto muestra la moneda y no la convierte', async ({ page }) => {
    await page.goto('/orders/new')
    await elegirCliente(page)

    await page.getByTestId('intake-brand').fill('Samsung')
    await page.getByTestId('intake-model').fill('A04e')
    await continuar(page)   // equipo → identificación
    await continuar(page)   // → estado y fotos
    await continuar(page)   // → checklist
    await continuar(page)   // → acceso
    await continuar(page)   // → problema
    await page.getByLabel('Problema informado por el cliente').fill('No carga')
    await continuar(page)   // → asignación
    await continuar(page)   // → presupuesto

    const amount = page.getByTestId('intake-budget')
    await expect(amount).toBeVisible()
    await amount.fill('85000')
    await expect(amount).toHaveValue('85.000')
    await expect(page.locator('.app-money-prefix')).toHaveText('$')
    await page.screenshot({ path: `${EVIDENCE}/webkit-390-05-presupuesto-ars.png` })

    await page.getByTestId('intake-budget-currency').selectOption('USD')
    await expect(page.locator('.app-money-prefix')).toHaveText('US$')
    // INVARIANTE: cambia la unidad, nunca el número.
    await expect(amount).toHaveValue('85.000')
    await page.screenshot({ path: `${EVIDENCE}/webkit-390-06-presupuesto-usd.png` })

    await noHorizontalOverflow(page)
  })
})
