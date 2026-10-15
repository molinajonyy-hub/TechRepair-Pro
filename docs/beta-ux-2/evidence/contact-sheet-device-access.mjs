// BETA-UX-2 · hotfix — lámina «Acceso del equipo»: producción · #182 · hotfix.
// Uso: node contact-sheet-device-access.mjs <root> <dirMain> <dir182> <dirHotfix> <salida.png>
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const [root, dirMain, dir182, dirHot, salida] = process.argv.slice(2)
const { chromium } = await import(pathToFileURL(path.join(root, 'node_modules', 'playwright-core/index.mjs')).href)
const img = (dir, file) => fs.existsSync(path.join(dir, file))
  ? `<img src="data:image/png;base64,${fs.readFileSync(path.join(dir, file)).toString('base64')}">`
  : '<div class="falta">sin captura</div>'
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const FILAS = [
  ['Formato anterior sin 0 ni 9 (sintético [1,2,5,8]) — no se puede saber la numeración', 'legacy-ambiguo'],
  ['Formato actual (sintético ["0","1","4","7"])', 'nuevo-exacto'],
  ['Migrado del frontend viejo, con un 0 (sintético [0,1,4,7])', 'migrado-con-cero'],
  ['PIN (sintético)', 'pin'],
]
const COLS = [['Producción · main', dirMain, 'before-main'], ['PR #182', dir182, 'before-182'], ['Hotfix', dirHot, 'after']]

const filas = FILAS.map(([titulo, clave]) => `
  <section><h2>${esc(titulo)}</h2><div class="par">${COLS.map(([col, dir, pref]) =>
    `<figure><figcaption>${esc(col)}</figcaption>${img(dir, `${pref}-${clave}-390.png`)}</figure>`).join('')}</div></section>`).join('')
const extra = `<section><h2>Hotfix · escritorio (1440) y tema oscuro</h2><div class="par">
  <figure><figcaption>Formato anterior · 1440</figcaption>${img(dirHot, 'after-legacy-ambiguo-1440.png')}</figure>
  <figure><figcaption>Formato actual · 1440</figcaption>${img(dirHot, 'after-nuevo-exacto-1440.png')}</figure>
  <figure><figcaption>Formato anterior · oscuro</figcaption>${img(dirHot, 'after-legacy-ambiguo-390-dark.png')}</figure>
  <figure><figcaption>Formato actual · oscuro</figcaption>${img(dirHot, 'after-nuevo-exacto-390-dark.png')}</figure>
</div></section>`

const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; padding: 24px; background: #f1f5f9; font: 14px/1.4 system-ui, sans-serif; color: #0f172a; }
  h1 { margin: 0 0 4px; font-size: 18px; } p.nota { margin: 0 0 16px; color: #475569; max-width: 1100px; }
  section { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; margin-bottom: 16px; }
  h2 { margin: 0 0 10px; font-size: 14px; }
  .par { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
  figure { margin: 0; } figcaption { margin-bottom: 6px; font-size: 12px; font-weight: 700; color: #475569; }
  img { display: block; width: 300px; border: 1px solid #cbd5e1; border-radius: 8px; }
  .falta { width: 300px; padding: 40px 0; text-align: center; color: #94a3b8; border: 1px dashed #cbd5e1; border-radius: 8px; }
</style><main style="width:1000px"><h1>Acceso del equipo · patrón revelado</h1>
<p class="nota">Producción muestra el valor crudo como texto (un «0» que la grilla no tiene). #182 suma 1 a todo y corre un punto los patrones de formato anterior. El hotfix dibuja sólo lo que se lee con certeza (mini grilla 3×3) y, para el formato anterior ambiguo, avisa sin mostrar números y ofrece reconfigurar. Todos los valores son sintéticos.</p>
${filas}${extra}</main>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1050, height: 900 }, deviceScaleFactor: 1 })
await page.setContent(html, { waitUntil: 'load' })
await page.locator('main').screenshot({ path: salida })
await browser.close()
console.log(`OK ${salida}`)
