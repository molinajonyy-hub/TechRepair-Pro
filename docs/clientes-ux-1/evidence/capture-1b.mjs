// CLIENTES-UX-1B — capturas antes/después contra serve-stateful.mjs recién levantado.
// Uso: node capture-1b.mjs <repoRoot> <before|after> <outDir>
// «before» corre sobre la rama de 1A; «after», sobre la de 1B.
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const [root, mode, out] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const { chromium } = await import(pathToFileURL(path.join(root, 'node_modules', 'playwright-core/index.mjs')).href)
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const USER_ID = '00000000-0000-4000-8000-00000000d15c'
const user = { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'owner.qa@example.test', email_confirmed_at: '2026-10-01T12:00:00Z', created_at: '2026-10-01T11:59:00Z', app_metadata: { provider: 'email' }, user_metadata: {}, identities: [] }
const jwt = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: USER_ID, exp: now + 86400, role: 'authenticated', aud: 'authenticated' })}.sig`
const session = { access_token: jwt, token_type: 'bearer', expires_in: 86400, expires_at: now + 86400, refresh_token: 'r', user }
const BASE = 'http://127.0.0.1:5200'
const RETAIL = 'c0000000-0000-4000-8000-0000000000e2'
const after = mode === 'after'

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' })
async function pageAt(width) {
  const mobile = width < 768
  const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 1 })
  await context.addInitScript(([s]) => { localStorage.setItem('sb-127-auth-token', s); localStorage.setItem('techrepair_theme', 'light') }, [JSON.stringify(session)])
  return { page: await context.newPage(), context, mobile }
}
const shot = (target, name) => target.screenshot({ path: path.join(out, `${mode}-${name}.png`) })
const settle = page => page.waitForTimeout(1600)
async function next(page, mobile) {
  const scope = mobile ? page.getByTestId('mobile-action-bar') : page.locator('.intake-desktop-actions')
  await scope.getByRole('button', { name: 'Continuar' }).click()
}
async function finish(page, mobile) {
  await next(page, mobile)
  await page.getByLabel('Marca').fill('Samsung'); await page.getByLabel('Modelo').fill('Galaxy S24')
  await next(page, mobile)
  await page.getByTestId('intake-problem').fill('No carga'); await next(page, mobile)
  await page.waitForTimeout(300)
  await shot(page, `recepcion-resumen-${mobile ? 390 : 1440}`)
  const scope = mobile ? page.getByTestId('mobile-action-bar') : page.locator('.intake-desktop-actions')
  await scope.getByRole('button', { name: 'Crear orden' }).click()
  await page.waitForURL(/\/orders\//); await settle(page)
  // El detalle entra con un fade: se espera a que termine antes de capturar.
  await page.waitForTimeout(1200)
}

// 1. Ficha → Editar cliente: la sección «Contacto para avisos».
{
  const { page, context } = await pageAt(1440)
  await page.goto(`${BASE}/customers/${RETAIL}`); await settle(page)
  await page.getByRole('button', { name: 'Editar cliente' }).click()
  const dialog = page.getByRole('dialog').first(); await dialog.waitFor()
  if (after) {
    await dialog.getByLabel('Nombre del contacto').fill('María Hija')
    await dialog.getByLabel('Teléfono para avisos').fill('351 15 555-1234')
    await dialog.getByTestId('customer-notice-toggle').scrollIntoViewIfNeeded()
  } else {
    await dialog.getByTestId('customer-additional-toggle').scrollIntoViewIfNeeded()
  }
  await page.waitForTimeout(300)
  await shot(page, 'editar-cliente-1440')
  if (after) {
    await dialog.getByTestId('customer-edit-save-button').click()
    await page.getByTestId('customer-saved-notice').getByText('Cambios guardados.').waitFor()
    await page.waitForTimeout(300)
    await shot(page, 'ficha-1440')
  }
  await context.close()
}

// 2. Nueva orden (escritorio): elegir a quién avisar, crear, ver la orden y el preview.
{
  const { page, context } = await pageAt(1440)
  await page.goto(`${BASE}/orders/new`); await settle(page)
  await page.getByRole('button', { name: /Cliente E2E/ }).first().click(); await page.waitForTimeout(800)
  await shot(page, 'recepcion-cliente-1440')
  if (after) await page.getByTestId('intake-notify-alternate').click()
  await finish(page, false)
  await shot(page, 'orden-1440')
  const card = page.getByTestId('order-customer-card')
  await card.scrollIntoViewIfNeeded(); await page.waitForTimeout(300)
  await shot(card, 'orden-tarjeta-1440')
  await page.locator('.order-detail-header__secondary').getByRole('button', { name: 'WhatsApp' }).click()
  await page.getByTestId('order-whatsapp-free').click()
  await page.getByTestId('whatsapp-preview-modal').waitFor(); await page.waitForTimeout(900)
  await shot(page, 'whatsapp-1440')
  await context.close()
}

// 3. Celular: la elección en la recepción y el panel de la orden.
{
  const { page, context } = await pageAt(390)
  await page.goto(`${BASE}/orders/new`); await settle(page)
  await page.getByRole('button', { name: /Cliente E2E/ }).first().click(); await page.waitForTimeout(800)
  if (after) await page.getByTestId('intake-notify').scrollIntoViewIfNeeded()
  await shot(page, 'recepcion-cliente-390')
  if (after) await page.getByTestId('intake-notify-alternate').click()
  await finish(page, true)
  const card = page.getByTestId('order-customer-card')
  await card.scrollIntoViewIfNeeded(); await page.waitForTimeout(300)
  await shot(page, 'orden-390')
  await context.close()
}
await browser.close()
console.log('OK', mode)
