// ============================================================================
// DIALOG-TOUCH-1 — Gate del area tactil de las acciones del footer del
// ResponsiveDialog.
//
// Mide GEOMETRIA COMPUTADA real (boundingBox + elementFromPoint) sobre la app
// servida. No comprueba que exista una variable CSS: el bug original convivio
// con `--mobile-touch-target: 44px` ya declarada y con un test que solo
// verificaba esa declaracion.
//
// Caso que este gate hace fallar: footer CTA de ~39px (`.btn` en talla md, sin
// min-height) en 320 / 390 / 430.
//
// Desktop NO se gatea a 44px a proposito: ahi el producto conserva la densidad
// compacta.
// ============================================================================
import { expect, test, type Locator, type Page } from '@playwright/test'

const TOUCH_TARGET = 44
const MOBILE_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]

async function alto(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('El boton no tiene caja: no es visible.')
  return box.height
}

/**
 * El dialogo entra con `modalIn` (scale(0.97) -> scale(1)). `getBoundingClientRect`
 * aplica la transformacion, asi que medir a mitad de la animacion devuelve ~43,9px
 * y el gate parpadea. Se espera a que las animaciones del subarbol terminen: con
 * `prefers-reduced-motion` no hay ninguna y resuelve al instante.
 */
async function esperarAnimaciones(dialog: Locator): Promise<void> {
  await dialog.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined)))
  })
}

/**
 * El alto no alcanza si otra capa se come el click: se verifica que el propio
 * boton reciba el hit arriba, al centro y abajo de su caja.
 */
async function recibeElHit(page: Page, etiqueta: string): Promise<boolean[]> {
  return page.evaluate(label => {
    const footer = document.querySelector('[data-testid="responsive-dialog"] .modal-footer')
    const button = Array.from(footer?.querySelectorAll('button') ?? [])
      .find(element => element.textContent?.trim() === label)
    if (!button) throw new Error(`No se encontro la accion "${label}" en el footer.`)
    const rect = button.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    return [rect.top + 2, rect.top + rect.height / 2, rect.bottom - 2].map(y => {
      const hit = document.elementFromPoint(x, y)
      return hit === button || Boolean(hit && button.contains(hit))
    })
  }, etiqueta)
}

async function sinOverflowHorizontal(page: Page): Promise<void> {
  const size = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(size.scroll).toBeLessThanOrEqual(size.client + 1)
}

test.describe('@dialogtouch DIALOG-TOUCH-1 · acciones del footer', () => {
  for (const viewport of MOBILE_VIEWPORTS) {
    test(`Quick Customer · footer >= ${TOUCH_TARGET}px en ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.goto('/orders/new')

      const trigger = page.getByRole('button', { name: 'Crear cliente rápido' })
      await expect(trigger).toBeVisible()
      await trigger.click()

      const dialog = page.getByRole('dialog', { name: 'Crear cliente rápido' })
      await expect(dialog).toBeVisible()
      await esperarAnimaciones(dialog)
      const footer = dialog.locator('.modal-footer')
      const cancelar = footer.getByRole('button', { name: 'Cancelar' })
      const crear = footer.getByRole('button', { name: 'Crear cliente' })

      // ── Estado inicial: el CTA arranca deshabilitado (faltan nombre y telefono).
      await expect(crear).toBeDisabled()
      expect(await alto(crear)).toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(await alto(cancelar)).toBeGreaterThanOrEqual(TOUCH_TARGET)

      // ── El secundario si es operable: tiene que recibir el click en toda su caja.
      expect(await recibeElHit(page, 'Cancelar')).toEqual([true, true, true])
      await sinOverflowHorizontal(page)

      // ── Habilitado tras los campos minimos del customer core.
      await dialog.getByLabel('Nombre completo').fill('Cliente Dialog Touch')
      await dialog.getByLabel('Teléfono').fill('1122334455')
      await expect(crear).toBeEnabled()

      const altoHabilitado = await alto(crear)
      expect(altoHabilitado).toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(await recibeElHit(page, 'Crear cliente')).toEqual([true, true, true])
      await sinOverflowHorizontal(page)

      // ── Loading: se demora el alta para poder medir el estado intermedio. El
      //    spinner reemplaza al texto; el alto no puede moverse.
      await page.route('**/rest/v1/customers*', async route => {
        if (route.request().method() === 'POST') await new Promise(r => setTimeout(r, 1500))
        await route.fallback()
      })
      await crear.click()
      await expect(crear).toBeDisabled()
      const altoLoading = await alto(crear)
      expect(altoLoading).toBeGreaterThanOrEqual(TOUCH_TARGET)
      expect(altoLoading).toBeCloseTo(altoHabilitado, 0)
      await page.unroute('**/rest/v1/customers*')
    })
  }

  test('BarcodeScannerDialog · el footer comparte el contrato tactil', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/orders/new')

    // Pasos 1 y 2 del wizard para llegar al escaner (paso 3).
    await page.getByLabel('Buscar cliente').fill('Cliente E2E')
    await page.getByRole('button', { name: /Cliente E2E/ }).click()
    const continuar = page.getByTestId('mobile-action-bar').getByRole('button', { name: 'Continuar' })
    await continuar.click()
    await page.getByLabel('Marca').fill('Samsung')
    await page.getByLabel('Modelo').fill('Galaxy S24')
    await continuar.click()

    await page.getByRole('button', { name: 'Escanear' }).first().click()
    const scanner = page.getByRole('dialog', { name: 'Escanear identificación' })
    await expect(scanner).toBeVisible()
    await esperarAnimaciones(scanner)

    const cerrar = scanner.locator('.modal-footer').getByRole('button', { name: 'Cerrar' })
    expect(await alto(cerrar)).toBeGreaterThanOrEqual(TOUCH_TARGET)
    expect(await recibeElHit(page, 'Cerrar')).toEqual([true, true, true])
  })
})
