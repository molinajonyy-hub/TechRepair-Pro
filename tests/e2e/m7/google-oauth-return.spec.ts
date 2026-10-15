// ============================================================================
// HOTFIX BETA-UX-1G — volver de Google al login, en un navegador con
// back/forward cache, contra el stack LOCAL.
//
// El defecto: «Continuar con Google» entrega la página al proveedor. Si el
// usuario vuelve con «Atrás», el navegador RESTAURA el login desde el historial
// con el estado de antes de irse —«Redirigiendo a Google…» y todo
// deshabilitado— y nada lo deshacía (medido en Chrome; ver
// docs/beta-ux-1/beta-ux-1g-google-oauth-return.md).
//
// Por qué este spec lanza SU PROPIO navegador: el `page` del proyecto usa el
// «headless shell» de Chromium, y Playwright además le pasa
// `--disable-back-forward-cache`. Medido: ese binario no restaura ninguna página
// desde el historial, ni una trivial. El Chromium completo (`channel:
// 'chromium'`, lo instala el mismo `playwright install chromium`) sí, y sin ese
// argumento.
//
// La navegación externa es la real: el login llama a `signInWithOAuth` y el
// navegador sale al `/auth/v1/authorize` de GoTrue. En el stack local Google no
// está habilitado y GoTrue contesta 400 ahí mismo: para este contrato da igual
// qué haya del otro lado, lo que se mide es la VUELTA. El viaje completo a
// Google (cuenta existente, cuenta nueva) no se puede automatizar: queda para
// el smoke humano.
//
// Casos:
//   1. salir hacia Google y volver con «Atrás» → login usable, sin destino viejo
//   2. un segundo intento de Google después de volver
//   3. contraseña después de volver → entra y respeta el destino pedido
//   4. cancelar (GoTrue vuelve al callback con `access_denied`) → aviso con
//      salida → login usable → Google se puede volver a intentar
//   5. la carga hacia Google se detiene ANTES de salir del login («Detener»,
//      Esc, red lenta): no hay restauración; la Navigation API avisa
//      `navigateerror` → login usable
// ============================================================================
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { assertDestinoLocalSeguro } from '../setup/assertLocalTarget.ts'

async function navegadorConBfcache(playwright: typeof import('@playwright/test')): Promise<Browser> {
  return playwright.chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] })
}

async function contexto(browser: Browser, baseURL: string): Promise<{ ctx: BrowserContext; page: Page }> {
  // Sin sesión: el proyecto m7-local inyecta la del dueño también en los
  // contextos creados a mano, y con ella /login redirige a Inicio.
  const ctx = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  })
  // Cuenta las restauraciones desde el historial de ESTE documento, y las
  // navegaciones que no terminaron (Navigation API).
  await ctx.addInitScript(() => {
    const w = window as unknown as { __bfcache?: number; __navErr?: number; navigation?: EventTarget }
    window.addEventListener('pageshow', e => {
      if (e.persisted) w.__bfcache = (w.__bfcache ?? 0) + 1
    })
    w.navigation?.addEventListener('navigateerror', () => { w.__navErr = (w.__navErr ?? 0) + 1 })
  })
  return { ctx, page: await ctx.newPage() }
}

/** Sale del login hacia GoTrue / Google con el botón real. */
async function irAGoogle(page: Page, baseURL: string): Promise<void> {
  const origen = new URL(baseURL).origin
  await page.getByTestId('login-google').click()
  await page.waitForURL(u => u.origin !== origen, { timeout: 20_000 })
}

/** «Atrás» hasta el login, y prueba que volvió DESDE EL HISTORIAL (no recargado). */
async function volverAlLogin(page: Page, restauracionesEsperadas: number): Promise<void> {
  await page.goBack({ waitUntil: 'commit' })
  await page.getByTestId('login-google').waitFor({ timeout: 20_000 })
  const restauraciones = await page.evaluate(() => (window as unknown as { __bfcache?: number }).__bfcache ?? 0)
  expect(
    restauraciones,
    'precondición: el login tiene que volver desde el back/forward cache (si no, este spec no prueba nada)',
  ).toBe(restauracionesEsperadas)
}

async function loginUsable(page: Page): Promise<void> {
  await expect(page.getByTestId('login-google')).toHaveText('Continuar con Google')
  await expect(page.getByTestId('login-google')).toBeEnabled()
  await expect(page.getByTestId('login-submit')).toBeEnabled()
  await expect(page.getByTestId('login-email')).toBeEnabled()
  await expect(page.getByTestId('login-tab-register')).toBeEnabled()
}

const destinoGuardado = (page: Page) => page.evaluate(() => sessionStorage.getItem('post_login_redirect'))

test('@m7 1. salir hacia Google y volver con «Atrás» deja el login usable, sin el destino del intento', async ({ playwright, baseURL }) => {
  const browser = await navegadorConBfcache(playwright)
  const { page } = await contexto(browser, baseURL!)
  await page.goto('/login', { waitUntil: 'networkidle' })

  await irAGoogle(page, baseURL!)
  await volverAlLogin(page, 1)
  await loginUsable(page)
  expect(await destinoGuardado(page), 'el destino guardado para la vuelta de Google ya no corresponde').toBeNull()
  // Volver no es una falla: no hay mensaje de error.
  await expect(page.getByTestId('login-error')).toHaveCount(0)
  await browser.close()
})

test('@m7 2. un segundo intento de Google después de volver', async ({ playwright, baseURL }) => {
  const browser = await navegadorConBfcache(playwright)
  const { page } = await contexto(browser, baseURL!)
  await page.goto('/login', { waitUntil: 'networkidle' })

  await irAGoogle(page, baseURL!)
  await volverAlLogin(page, 1)
  await irAGoogle(page, baseURL!)
  await volverAlLogin(page, 2)
  await loginUsable(page)
  await browser.close()
})

test('@m7 3. contraseña después de volver: entra y respeta el destino pedido', async ({ playwright, baseURL }) => {
  const d = await assertDestinoLocalSeguro()
  const browser = await navegadorConBfcache(playwright)
  const { page } = await contexto(browser, baseURL!)
  await page.goto('/login?redirectTo=%2Forders', { waitUntil: 'networkidle' })

  await irAGoogle(page, baseURL!)
  await volverAlLogin(page, 1)
  await loginUsable(page)

  await page.getByTestId('login-email').fill(d.email)
  await page.getByTestId('login-password').fill(d.password)
  await page.getByTestId('login-submit').click()
  // `toHaveURL` y no `waitForURL`: en un documento restaurado desde el historial
  // Playwright no vuelve a ver el `load`, y `waitForURL` espera ese evento aun
  // para una navegación interna de la SPA que ya ocurrió.
  await expect(page).toHaveURL(/\/orders$/, { timeout: 25_000 })
  expect(await destinoGuardado(page)).toBeNull()
  await browser.close()
})

test('@m7 4. cancelar: el callback lo explica, y el login vuelve a estar usable y a ofrecer Google', async ({ playwright, baseURL }) => {
  const browser = await navegadorConBfcache(playwright)
  const { page } = await contexto(browser, baseURL!)
  await page.goto('/login?redirectTo=%2Forders', { waitUntil: 'networkidle' })
  await irAGoogle(page, baseURL!)

  // Lo que hace GoTrue cuando el usuario cancela en Google: vuelve al callback
  // con el error en la query (y en el fragmento).
  await page.goto('/auth/callback?error=access_denied&error_description=The+user+denied+the+request#error=access_denied')
  const tarjeta = page.getByTestId('auth-callback-error')
  await expect(tarjeta.locator('h1')).toHaveText('No iniciaste sesión', { timeout: 20_000 })
  await expect(tarjeta).toContainText('Cancelaste el inicio de sesión con Google.')
  await expect(page.locator('body')).not.toContainText(/denied/i)

  await page.getByTestId('auth-callback-volver').click()
  await page.waitForURL(/\/login$/, { timeout: 20_000 })
  await loginUsable(page)
  // El destino pedido antes de cancelar sigue guardado para el próximo ingreso.
  expect(await destinoGuardado(page)).toBe('/orders')

  await irAGoogle(page, baseURL!)
  await browser.close()
})

test('@m7 5. la carga hacia Google se detiene antes de salir: el login vuelve a estar usable', async ({ playwright, baseURL }) => {
  const browser = await navegadorConBfcache(playwright)
  const { ctx, page } = await contexto(browser, baseURL!)
  await page.goto('/login?redirectTo=%2Forders', { waitUntil: 'networkidle' })

  // «Google» lento: GoTrue redirige (como siempre) a un proveedor que no
  // contesta, y la salida queda pendiente. La ruta contesta en el acto: un
  // pedido retenido por `page.route` no deja que el navegador detenga la carga.
  const colgados: ServerResponse[] = []
  const googleLento = createServer((_pedido, respuesta) => { colgados.push(respuesta) })
  await new Promise<void>(listo => googleLento.listen(0, '127.0.0.1', listo))
  const google = `http://127.0.0.1:${(googleLento.address() as AddressInfo).port}`
  await page.route('**/auth/v1/authorize**', ruta =>
    ruta.fulfill({ status: 302, headers: { location: `${google}/o/oauth2/auth` } }))
  const pedido = page.waitForRequest(r => r.url().startsWith(google))
  // Clic desde la página: el `click` de Playwright esperaría la navegación que
  // acá, a propósito, no termina.
  await page.evaluate(() => (document.querySelector('[data-testid="login-google"]') as HTMLButtonElement).click())
  await pedido
  // (Mientras la salida está pendiente no se lee la página: Playwright, y hasta
  // `Runtime.evaluate` por CDP, esperan a que termine. Que el login queda en
  // «Redirigiendo a Google…» lo prueba el control negativo contra `main`.)

  // Lo mismo que el botón «Detener» del navegador.
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Page.stopLoading')
  await page.unroute('**/auth/v1/authorize**')
  for (const respuesta of colgados) respuesta.destroy()
  googleLento.close()

  expect(new URL(page.url()).pathname, 'la salida no ocurrió: sigue en el login').toBe('/login')
  expect(
    await page.evaluate(() => (window as unknown as { __navErr?: number }).__navErr ?? 0),
    'precondición: el navegador avisó la navegación interrumpida (Navigation API `navigateerror`)',
  ).toBe(1)
  await loginUsable(page)
  expect(await destinoGuardado(page), 'el destino guardado para la vuelta de Google ya no corresponde').toBeNull()
  await expect(page.getByTestId('login-error')).toHaveCount(0)

  // Y Google se puede volver a intentar (esta vez la salida ocurre).
  await irAGoogle(page, baseURL!)
  await browser.close()
})
