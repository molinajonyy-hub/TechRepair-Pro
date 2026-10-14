// HOTFIX BETA-UX-1G — control del instrumento: ¿el navegador automatizado
// restaura desde el back/forward cache AL MENOS una página trivial?
//
// Si una página HTML sin JS de la app no vuelve del bfcache, un «no se
// restauró» en la app no dice nada sobre la app: es el entorno.
//
// Uso: node bfcache-probe.mjs <worktree>
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const worktree = process.argv[2]
const pw = await import(pathToFileURL(path.join(worktree, 'node_modules', 'playwright-core/index.mjs')).href)

const A = 'http://127.0.0.1:59981'
const B = 'http://127.0.0.1:59982'
const pagina = (titulo, enlace) => `<!doctype html><meta charset="utf-8"><title>${titulo}</title>
  <h1>${titulo}</h1>${enlace ? `<a id="ir" href="${enlace}">ir</a>` : ''}
  <script>window.__estado = 'vivo-' + Math.random(); addEventListener('pageshow', e => { if (e.persisted) window.__bfcache = (window.__bfcache || 0) + 1 })</script>`
const servidor = (puerto, html) => http.createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html) }).listen(puerto, '127.0.0.1')
const sa = servidor(59981, pagina('A', `${B}/`))
const sb = servidor(59982, pagina('B', null))

const variantes = [
  ['chromium · headless por defecto (headless shell)', 'chromium', { ignoreDefaultArgs: ['--disable-back-forward-cache'] }],
  ['chromium · channel=chromium (headless nuevo)', 'chromium', { channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] }],
  ['chromium · channel=chrome (Chrome instalado)', 'chromium', { channel: 'chrome', ignoreDefaultArgs: ['--disable-back-forward-cache'] }],
  ['chromium · channel=msedge (Edge instalado)', 'chromium', { channel: 'msedge', ignoreDefaultArgs: ['--disable-back-forward-cache'] }],
  ['webkit', 'webkit', {}],
]
for (const [nombre, motor, opciones] of variantes) {
  let browser
  try { browser = await pw[motor].launch(opciones) } catch (e) { console.log(`${nombre}: no disponible (${String(e.message).split('\n')[0].slice(0, 80)})`); continue }
  const page = await browser.newPage()
  await page.goto(`${A}/`, { waitUntil: 'load' })
  const antes = await page.evaluate(() => window.__estado)
  await page.click('#ir')
  await page.waitForURL(`${B}/`)
  await page.goBack({ waitUntil: 'commit' })
  await page.waitForTimeout(500)
  const r = await page.evaluate(() => ({
    estado: window.__estado,
    bfcache: window.__bfcache || 0,
    motivos: (() => { const n = performance.getEntriesByType('navigation')[0]; return n?.notRestoredReasons ? JSON.stringify(n.notRestoredReasons.reasons) : null })(),
  }))
  console.log(`${nombre}: restaurada=${r.bfcache > 0} · mismo estado JS=${r.estado === antes}${r.motivos ? ` · motivos=${r.motivos}` : ''}`)
  await browser.close()
}
sa.close(); sb.close()
