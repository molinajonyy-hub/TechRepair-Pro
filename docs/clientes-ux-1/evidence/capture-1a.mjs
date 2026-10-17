// CLIENTES-UX-1A — capturas antes/después contra el Supabase simulado (stateful).
// Uso (con serve-stateful.mjs recién levantado, así arranca sin cambios):
//   node capture-1a.mjs <repoRoot> <before|after> <outDir>
// «before» corre sobre `main`; «after», sobre la rama.
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
const PORTAL = 'c0000000-0000-4000-8000-0000000000f1'

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
async function pageAt(width, theme = 'light') {
  const mobile = width < 768
  const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 1 })
  await context.addInitScript(([s, t]) => { localStorage.setItem('sb-127-auth-token', s); localStorage.setItem('techrepair_theme', t) }, [JSON.stringify(session), theme])
  const page = await context.newPage()
  return { page, context, mobile }
}
const shot = (page, name) => page.screenshot({ path: path.join(out, `${mode}-${name}.png`) })
const settle = page => page.waitForTimeout(1600)

// 1. Ficha individual (escritorio y celular)
for (const width of [1440, 390]) {
  const { page, context } = await pageAt(width)
  await page.goto(`${BASE}/customers/${RETAIL}`); await settle(page)
  await shot(page, `detalle-${width}`)
  if (mode === 'after') {
    await page.getByRole('button', { name: 'Editar cliente' }).click()
    await page.getByRole('dialog').waitFor()
    await page.waitForTimeout(400)
    await shot(page, `detalle-dialogo-${width}`)
    await page.getByTestId('customer-phone-input').fill('3517654321')
    await page.getByTestId('customer-edit-save-button').click()
    await page.getByRole('status').filter({ hasText: 'Cambios guardados' }).waitFor({ timeout: 5000 })
    await page.waitForTimeout(300)
    await shot(page, `detalle-guardado-${width}`)
  }
  await context.close()
}

// 2. Mayorista del portal sin razón social: el owner intenta cambiar el teléfono.
{
  const { page, context } = await pageAt(1440)
  await page.goto(`${BASE}/customers`); await settle(page)
  await page.getByRole('row').filter({ hasText: 'Mayorista Portal' }).getByTitle('Editar cliente').click()
  await page.getByRole('dialog').waitFor()
  await page.getByTestId('customer-phone-input').fill('3519990000')
  await page.getByTestId('customer-edit-save-button').click()
  await page.waitForTimeout(1200)
  await shot(page, 'portal-mayorista-guardar-1440')
  await context.close()
}

// 3. Después de guardar desde el listado.
{
  const { page, context } = await pageAt(1440)
  await page.goto(`${BASE}/customers`); await settle(page)
  await page.getByRole('row').filter({ hasText: 'Cliente E2E' }).getByTitle('Editar cliente').click()
  await page.getByRole('dialog').waitFor()
  await page.getByTestId('customer-notes-input').fill('Prefiere WhatsApp por la tarde')
  await page.getByTestId('customer-edit-save-button').click()
  await page.waitForTimeout(1500)
  await shot(page, 'listado-despues-de-guardar-1440')
  await context.close()
}
await browser.close()
console.log('OK', mode)
