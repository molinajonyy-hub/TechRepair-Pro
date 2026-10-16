// BETA-UX-2 · hotfix — «Acceso del equipo» revelado, con secretos SINTÉTICOS.
// Levanta e2e-mock/serve.mjs con el acceso ya guardado y fotografía la tarjeta.
// Nada sale de la máquina. Ningún valor de acá es un patrón real.
//
// Uso: node capture-device-access.mjs <root> <outDir> <etiqueta>
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(process.argv[2] || '.')
const outDir = path.resolve(process.argv[3] || 'out')
const label = process.argv[4] || 'run'
const { chromium } = await import(pathToFileURL(path.join(root, 'node_modules/playwright-core/index.mjs')).href)
fs.mkdirSync(outDir, { recursive: true })

const ORDER = 'f0000000-0000-4000-8000-0000000000aa'
const ESCENARIOS = [
  // Formato anterior sin 0 ni 9: no se puede saber la numeración.
  { name: 'legacy-ambiguo', mode: 'pattern', secret: '[1,2,5,8]' },
  // Formato nuevo (strings, contrato 0–8): exacto. Misma forma que arriba leída en 1–9.
  { name: 'nuevo-exacto', mode: 'pattern', secret: '["0","1","4","7"]' },
  // Migrado del frontend viejo (números con 0 ⇒ base 0): exacto.
  { name: 'migrado-con-cero', mode: 'pattern', secret: '[0,1,4,7]' },
  { name: 'pin', mode: 'pin', secret: '4826' },
]

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const user = { id: '00000000-0000-4000-8000-00000000d15c', aud: 'authenticated', role: 'authenticated', email: 'owner.qa@example.test', email_confirmed_at: '2026-10-01T12:00:00Z', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { full_name: 'QA' }, created_at: '2026-10-01T11:59:00Z', identities: [] }
const session = { access_token: `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: user.id, exp: now + 86400, role: 'authenticated', aud: 'authenticated', email: user.email })}.sig`, token_type: 'bearer', expires_in: 86400, expires_at: now + 86400, refresh_token: 'fake-refresh', user }

const arriba = async base => { for (let i = 0; i < 180; i++) { try { const r = await fetch(base); if (r.ok) return } catch {} await new Promise(r => setTimeout(r, 1000)) } throw new Error('el servidor no arrancó') }

const report = []
// UN servidor para todos los escenarios: reiniciar Vite entre uno y otro dejaba
// la caché de dependencias a medio escribir y la página no cargaba. El acceso
// guardado se cambia con el endpoint de control del simulador.
const portBase = Number(process.env.CAPTURE_PORT_BASE || 0)
const webPort = 5210 + portBase, apiPort = 59980 - portBase
const BASE = `http://127.0.0.1:${webPort}`
const API = `http://127.0.0.1:${apiPort}`
const server = spawn(process.execPath, [path.join(root, 'docs/beta-ux-2/evidence/e2e-mock/serve.mjs')], {
  cwd: root, stdio: 'ignore', env: { ...process.env, MOCK_WEB_PORT: String(webPort), MOCK_API_PORT: String(apiPort) },
})
try {
  await arriba(BASE)
  for (const esc of ESCENARIOS) {
    await fetch(`${API}/__mock/access?mode=${encodeURIComponent(esc.mode)}&secret=${encodeURIComponent(esc.secret)}`)
    const browser = await chromium.launch()
    for (const [ancho, alto, tema] of [[390, 844, 'light'], [1440, 900, 'light'], [390, 844, 'dark']]) {
      const ctx = await browser.newContext({ viewport: { width: ancho, height: alto } })
      await ctx.addInitScript(([s, t]) => { localStorage.setItem('sb-127-auth-token', s); localStorage.setItem('techrepair_theme', t); localStorage.setItem('theme', t) }, [JSON.stringify(session), tema])
      const page = await ctx.newPage()
      for (let i = 0; i < 3; i++) { try { await page.goto(`${BASE}/orders/${ORDER}`, { waitUntil: 'domcontentloaded', timeout: 120_000 }); await page.getByTestId('device-lock-status').waitFor({ timeout: 90_000 }); break } catch (e) { if (i === 2) throw e } }
      const tarjeta = page.locator('.card', { has: page.getByTestId('device-lock-status') })
      await page.getByRole('button', { name: 'Revelar' }).click()
      await page.waitForTimeout(700)
      await tarjeta.scrollIntoViewIfNeeded()
      const nombre = `${label}-${esc.name}-${ancho}${tema === 'dark' ? '-dark' : ''}.png`
      await tarjeta.screenshot({ path: path.join(outDir, nombre), animations: 'disabled' })
      report.push(`${nombre}: ${(await tarjeta.innerText()).replace(/\s+/g, ' ').slice(0, 220)}`)
      await ctx.close()
    }
    await browser.close()
  }
} finally { server.kill() }
fs.writeFileSync(path.join(outDir, `report-device-access-${label}.txt`), report.join('\n'))
console.log(report.join('\n'))
