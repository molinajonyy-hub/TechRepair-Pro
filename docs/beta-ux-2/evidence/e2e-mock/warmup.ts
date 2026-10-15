// Vite en frío optimiza dependencias en la primera carga y recarga la página:
// el primer `page.goto` de la corrida esperaba un `load` que no llegaba. Acá se
// recorren las rutas una vez antes de los tests, hasta que cada una pinta su h1.
import { chromium, type FullConfig } from '@playwright/test'

export default async function warmup(config: FullConfig) {
  const { baseURL, storageState } = config.projects[0].use
  const browser = await chromium.launch()
  const context = await browser.newContext({ storageState: storageState as string })
  const page = await context.newPage()
  for (const ruta of ['/dashboard', '/orders/new', '/orders', '/settings', '/comprobantes', '/caja']) {
    for (let intento = 0; intento < 3; intento += 1) {
      try {
        await page.goto(`${baseURL}${ruta}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
        await page.locator('h1').first().waitFor({ timeout: 90_000 })
        break
      } catch { /* recarga por optimización de dependencias: otra vuelta */ }
    }
  }
  await browser.close()
}
