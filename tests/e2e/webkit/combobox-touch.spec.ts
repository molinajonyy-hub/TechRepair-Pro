/**
 * ORDERS-V2-0.1 · pre-merge review — scroll táctil del desplegable en WebKit.
 *
 * La primera versión elegía la opción en `pointerdown`, así que apoyar el dedo
 * sobre la lista para desplazarla la seleccionaba y cerraba el desplegable.
 *
 * ── LÍMITE DE ESTE ARCHIVO ────────────────────────────────────────────────
 * Playwright sintetiza eventos de puntero; NO reproduce el reconocimiento de
 * gestos de un dedo real ni el momentum scrolling de iOS. Lo que se prueba acá
 * es lo que sí es determinístico:
 *
 *   - que la lista sea scrolleable de verdad (su contenido excede su alto y
 *     `scrollTop` se puede mover);
 *   - que mover el scroll NO seleccione ni cierre;
 *   - que un tap después de haber scrolleado SÍ elija la opción visible.
 *
 * El gesto físico —dedo que baja, arrastra y suelta sobre una opción— queda
 * para el smoke humano. No se afirma PASS de eso acá.
 */
import { expect, test, type Page } from '@playwright/test'

const EVIDENCE = 'docs/orders-v2-0-1-evidence'
const SEED_CUSTOMER = 'Cliente E2E'

/** Marcas suficientes para que la lista exceda su `max-height` de 16rem. */
const MANY_BRANDS = [
  'Alcatel', 'Apple', 'Asus', 'BLU', 'Google', 'Honor', 'Huawei', 'Infinix',
  'Lanix', 'Lenovo', 'LG', 'Motorola', 'Nokia', 'OnePlus', 'Oppo', 'Realme',
  'Samsung', 'Sony', 'TCL', 'Tecno', 'Vivo', 'Xiaomi', 'ZTE',
]

async function elegirCliente(page: Page) {
  await page.getByTestId('customer-picker-search').fill(SEED_CUSTOMER)
  const option = page.getByRole('button', { name: new RegExp(SEED_CUSTOMER) }).first()
  await option.waitFor({ timeout: 20000 })
  await option.click()
  await page.getByRole('button', { name: 'Continuar' }).last().click()
}

/**
 * El catálogo del tenant sembrado tiene pocas marcas. Se interceptan las dos
 * lecturas para tener una lista larga de verdad, que es la condición en la que
 * el bug aparecía.
 */
async function conCatalogoLargo(page: Page) {
  await page.route('**/rest/v1/brands*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(MANY_BRANDS.map((name, index) => ({ id: `b${index}`, name }))),
  }))
}

test.describe('@webkit ORDERS-V2-0.1 · desplegable táctil', () => {
  test('la lista scrollea sin seleccionar, y el tap posterior sí elige', async ({ page }) => {
    await conCatalogoLargo(page)
    await page.goto('/orders/new')
    await elegirCliente(page)

    const marca = page.getByTestId('intake-brand')
    await marca.click()

    const list = page.locator('.app-combobox-list')
    await expect(list).toBeVisible()

    // La lista tiene que EXCEDER su alto: si no, no hay scroll que probar y el
    // test daría un verde vacío.
    const metrics = await list.evaluate(node => ({
      scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
    }))
    expect(metrics.scrollHeight, 'la lista debe exceder su alto visible')
      .toBeGreaterThan(metrics.clientHeight)
    await page.screenshot({ path: `${EVIDENCE}/webkit-390-07-lista-larga.png` })

    // Desplazar la lista NO puede elegir nada ni cerrarla.
    await list.evaluate(node => { node.scrollTop = 160 })
    await expect(list).toBeVisible()
    await expect(marca).toHaveValue('')
    await expect(marca).toHaveAttribute('aria-expanded', 'true')
    expect(await list.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    await page.screenshot({ path: `${EVIDENCE}/webkit-390-08-lista-scrolleada.png` })

    // Y un tap sobre una opción visible DESPUÉS del scroll sí elige.
    const visible = list.getByRole('option').first()
    const elegida = (await visible.textContent())?.trim() ?? ''
    await visible.click()
    await expect(marca).toHaveValue(elegida)
    await expect(marca).toHaveAttribute('aria-expanded', 'false')
    await page.screenshot({ path: `${EVIDENCE}/webkit-390-09-tap-tras-scroll.png` })
  })

  test('salir del campo cierra el desplegable', async ({ page }) => {
    await conCatalogoLargo(page)
    await page.goto('/orders/new')
    await elegirCliente(page)

    const marca = page.getByTestId('intake-brand')
    await marca.click()
    await expect(page.getByRole('listbox', { name: 'Sugerencias de Marca' })).toBeVisible()

    // Tab lleva el foco fuera del combobox de Marca: SU lista no puede quedar
    // flotando encima del campo siguiente.
    //
    // Se asevera por nombre y no con `.app-combobox-list`: el foco aterriza en
    // el combobox de Modelo, que abre la suya — y eso es correcto. Un selector
    // amplio contaría esa segunda lista y daría un falso fallo.
    await page.keyboard.press('Tab')
    await expect(page.getByRole('listbox', { name: 'Sugerencias de Marca' })).toHaveCount(0)
    await expect(marca).toHaveAttribute('aria-expanded', 'false')
  })
})
