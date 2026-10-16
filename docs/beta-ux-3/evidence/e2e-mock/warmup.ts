// Igual que el warmup de BETA-UX-2: Vite en frío optimiza dependencias en la
// primera carga y recarga la página. Se recorren las rutas del lote una vez,
// hasta que cada una pinta su h1, antes de los tests.
import { chromium, type FullConfig } from '@playwright/test'

export default async function warmup(config: FullConfig) {
  const { baseURL, storageState, launchOptions } = config.projects[0].use
  const browser = await chromium.launch(launchOptions)
  const context = await browser.newContext({ storageState: storageState as string })
  const page = await context.newPage()
  for (const ruta of ['/dashboard', '/settings', '/users', '/currency-settings', '/subscription', '/ayuda', '/ayuda/tutoriales/arca', '/orders']) {
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
