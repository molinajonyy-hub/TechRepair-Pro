// BETA-UX-1G — lámina comparativa «antes | después» a partir de las capturas de
// `capture-auth.mjs` (una corrida sobre `main`, otra sobre la rama).
//
// Uso: node contact-sheet.mjs <worktree> <dirAntes> <dirDespues> <salida.png> <archivo.png=Título> [...]
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [worktree, antes, despues, salida, ...items] = process.argv.slice(2)
if (!worktree || !antes || !despues || !salida || !items.length) {
  console.error('Uso: node contact-sheet.mjs <worktree> <dirAntes> <dirDespues> <salida.png> <archivo.png=Título> [...]')
  process.exit(2)
}
const { chromium } = await import(pathToFileURL(path.join(worktree, 'node_modules', 'playwright-core/index.mjs')).href)

const dataUrl = file => `data:image/png;base64,${readFileSync(file).toString('base64')}`
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const filas = items.map(item => {
  const [archivo, titulo] = item.split('=')
  return `
    <section>
      <h2>${esc(titulo || archivo)}</h2>
      <div class="par">
        <figure><figcaption>Antes · main</figcaption><img src="${dataUrl(path.join(antes, archivo))}"></figure>
        <figure><figcaption>Después · BETA-UX-1G</figcaption><img src="${dataUrl(path.join(despues, archivo))}"></figure>
      </div>
    </section>`
}).join('')

const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; padding: 24px; background: #f1f5f9; font: 14px/1.4 system-ui, sans-serif; color: #0f172a; }
  main { display: grid; grid-template-columns: repeat(2, max-content); gap: 24px; }
  section { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; }
  h2 { margin: 0 0 12px; font-size: 15px; }
  .par { display: flex; gap: 16px; align-items: flex-start; }
  figure { margin: 0; }
  figcaption { margin-bottom: 6px; font-size: 12px; font-weight: 600; color: #475569; }
  img { display: block; width: 300px; border: 1px solid #cbd5e1; border-radius: 8px; }
</style><main>${filas}</main>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 })
await page.setContent(html, { waitUntil: 'load' })
await page.locator('main').screenshot({ path: salida })
await browser.close()
console.log(`OK ${salida}`)
