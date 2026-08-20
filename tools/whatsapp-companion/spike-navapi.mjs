// ¿WhatsApp Web INTERCEPTA navegaciones con la Navigation API?
// Se extrae el contexto real de cada `navigation.addEventListener` del bundle,
// y se comprueba en vivo si hay un listener de 'navigate' instalado.
import { chromium } from '@playwright/test'

const nav = await chromium.launch({ headless: true })
const ctx = await nav.newContext({ locale: 'es-AR' })
const page = await ctx.newPage()

const js = []
page.on('response', async (r) => {
  if (!/javascript/.test(r.headers()['content-type'] ?? '')) return
  try { js.push(await r.text()) } catch { /* noop */ }
})

// Detectar en vivo si alguien registra 'navigate' o usa intercept().
await page.addInitScript(() => {
  const w = window
  w.__NAVLOG__ = { registrados: [], intercepts: 0 }
  if (w.navigation) {
    const orig = w.navigation.addEventListener.bind(w.navigation)
    w.navigation.addEventListener = (tipo, ...resto) => {
      w.__NAVLOG__.registrados.push(tipo)
      return orig(tipo, ...resto)
    }
  }
})

await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForTimeout(9000)

const vivo = await page.evaluate(() => ({
  registrados: [...new Set(window.__NAVLOG__.registrados)],
  total: window.__NAVLOG__.registrados.length,
}))
console.log('── listeners de Navigation API registrados EN VIVO ─────────')
console.log(`   tipos: ${JSON.stringify(vivo.registrados)}   (${vivo.total} registros)\n`)

const todo = js.join('\n')
console.log('── contexto en el bundle ───────────────────────────────────')
const patrones = [
  ['navigation.addEventListener', /navigation\.addEventListener\(/g],
  ["'navigate'",                  /["'`]navigate["'`]/g],
  ['.intercept(',                 /\.intercept\(/g],
  ['navigateEvent',               /navigateEvent/g],
  ['canIntercept',                /canIntercept/g],
]
for (const [etiqueta, re] of patrones) console.log(`   ${String((todo.match(re) ?? []).length).padStart(4)}  ${etiqueta}`)

console.log('\n── fragmentos de navigation.addEventListener ───────────────')
let i = -1, n = 0
const vistos = new Set()
while ((i = todo.indexOf('navigation.addEventListener(', i + 1)) !== -1 && n < 4) {
  const frag = todo.slice(Math.max(0, i - 120), i + 320).replace(/\s+/g, ' ')
  const clave = frag.slice(100, 260)
  if (vistos.has(clave)) continue
  vistos.add(clave); n++
  console.log(`\n[${n}] …${frag}…`)
}

await nav.close()
