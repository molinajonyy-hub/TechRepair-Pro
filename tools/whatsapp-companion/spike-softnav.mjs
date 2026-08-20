// ============================================================================
// SPIKE · ¿se puede pasar de cliente A a B dentro del MISMO documento?
//
//   node tools/whatsapp-companion/spike-softnav.mjs
//
// Mide, en Chromium real y sobre el origen de WhatsApp Web:
//   1. qué hace exactamente la navegación top-level que usa hoy el Companion;
//   2. pushState · popstate · Navigation API · anchor same-origin;
//   3. si el bundle de WhatsApp siquiera escucha popstate / tiene router.
//
// LÍMITE HONESTO: sin sesión iniciada no se puede verificar que la UI cambie de
// contacto. Lo que sí se puede establecer es si existe la MAQUINARIA para que
// eso ocurra — si no hay listener de popstate ni router de historia, ninguna
// primitiva same-document puede funcionar, y eso ya decide el spike.
//
// No usa internals de WhatsApp, no lee chats, no toca el DOM de la app.
// ============================================================================
import { chromium } from '@playwright/test'

const WA = 'https://web.whatsapp.com'
const A = `${WA}/send?phone=5493511234567&text=cliente%20A`
const B = `${WA}/send?phone=5491123456789&text=cliente%20B`

const nav = await chromium.launch({ headless: true })
console.log(`Chromium: ${nav.version()}\n`)
const ctx = await nav.newContext({ locale: 'es-AR' })
const page = await ctx.newPage()

// ── Capturar el bundle para el análisis estático ───────────────────────────
const js = []
page.on('response', async (r) => {
  if (!/javascript/.test(r.headers()['content-type'] ?? '')) return
  try { js.push(await r.text()) } catch { /* noop */ }
})

// ── Instrumentación de ciclo de vida, ANTES de cualquier carga ─────────────
await page.addInitScript(() => {
  const w = window
  // Sobrevive sólo si el documento NO se recrea.
  w.__SENTINEL__ = Math.random().toString(36).slice(2)
  w.__EV__ = []
  addEventListener('DOMContentLoaded', () => w.__EV__.push('DOMContentLoaded'))
  addEventListener('load', () => w.__EV__.push('load'))
  addEventListener('popstate', () => w.__EV__.push('popstate'))
})

const t0 = Date.now()
await page.goto(WA, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForTimeout(6000)
console.log(`carga inicial: ${Date.now() - t0} ms\n`)

const leer = () => page.evaluate(() => ({
  sentinel: window.__SENTINEL__,
  url: location.pathname + location.search,
  eventos: [...(window.__EV__ ?? [])],
  navEntries: performance.getEntriesByType('navigation').length,
  tieneNavigationAPI: 'navigation' in window,
}))

const base = await leer()
console.log(`sentinel inicial: ${base.sentinel}`)
console.log(`Navigation API disponible: ${base.tieneNavigationAPI}\n`)

const evaluar = (etiqueta, antes, despues, ms) => {
  const mismoDoc = antes.sentinel === despues.sentinel
  const recargo = despues.eventos.filter(e => e === 'DOMContentLoaded').length > antes.eventos.filter(e => e === 'DOMContentLoaded').length
  console.log(`── ${etiqueta}`)
  console.log(`     URL              : ${despues.url}`)
  console.log(`     mismo documento  : ${mismoDoc ? 'SÍ' : 'NO (se recreó)'}`)
  console.log(`     DOMContentLoaded : ${recargo ? 'volvió a ocurrir' : 'no volvió a ocurrir'}`)
  console.log(`     popstate         : ${despues.eventos.filter(e => e === 'popstate').length}`)
  if (ms != null) console.log(`     tiempo           : ${ms} ms`)
  return { mismoDoc, recargo }
}

// ── 1 · pushState ──────────────────────────────────────────────────────────
let antes = await leer()
await page.evaluate((u) => history.pushState({}, '', new URL(u).pathname + new URL(u).search), B)
await page.waitForTimeout(2500)
const rPush = evaluar('A · history.pushState', antes, await leer())

// ── 2 · pushState + popstate ───────────────────────────────────────────────
antes = await leer()
await page.evaluate((u) => {
  history.pushState({}, '', new URL(u).pathname + new URL(u).search)
  dispatchEvent(new PopStateEvent('popstate', { state: {} }))
}, A)
await page.waitForTimeout(2500)
const rPop = evaluar('B · pushState + PopStateEvent', antes, await leer())

// ── 3 · Navigation API ─────────────────────────────────────────────────────
antes = await leer()
let notaNav = ''
try {
  await page.evaluate(async (u) => {
    const destino = new URL(u).pathname + new URL(u).search
    await window.navigation.navigate(destino).finished.catch(() => {})
  }, B)
} catch (e) { notaNav = String(e).split('\n')[0].slice(0, 90) }
await page.waitForTimeout(3500)
const rNavApi = evaluar('C · navigation.navigate()', antes, await leer())
if (notaNav) console.log(`     nota: ${notaNav}`)

// ── 4 · anchor same-origin real ────────────────────────────────────────────
antes = await leer()
await page.evaluate((u) => {
  document.getElementById('spike-a')?.remove()
  const a = document.createElement('a')
  a.id = 'spike-a'; a.href = new URL(u).pathname + new URL(u).search; a.textContent = 'ir'
  a.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;padding:14px;background:#25d366;color:#fff'
  document.body.appendChild(a)
}, A)
const tAnchor = Date.now()
await page.click('#spike-a')
await page.waitForTimeout(4000)
const rAnchor = evaluar('D · anchor same-origin', antes, await leer(), Date.now() - tAnchor)

// ── 5 · navegación top-level (lo que hace hoy el Companion) ────────────────
antes = await leer()
const tTop = Date.now()
await page.goto(B, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(5000)
const rTop = evaluar('E · navegación top-level (tabs.update)', antes, await leer(), Date.now() - tTop)

// ── 6 · ¿el bundle tiene router de historia? ───────────────────────────────
const todo = js.join('\n')
const contar = (re) => (todo.match(re) ?? []).length
console.log(`\n── análisis del bundle (${Math.round(todo.length / 1024)} KB) ──────────────`)
for (const [etiqueta, re] of [
  ["addEventListener('popstate'", /addEventListener\((["'`])popstate\1/g],
  ['onpopstate',                  /onpopstate/g],
  ['history.pushState',           /pushState/g],
  ['history.replaceState',        /replaceState/g],
  ['navigation.addEventListener', /navigation\.addEventListener/g],
  ['location.search',             /location\.search/g],
  ['phone= (parseo)',             /phone=/g],
]) console.log(`   ${String(contar(re)).padStart(4)}  ${etiqueta}`)

console.log('\n══ RESUMEN ══════════════════════════════════════════════════')
const fila = (n, r) => console.log(`   ${n.padEnd(34)} mismoDoc=${r.mismoDoc ? 'SÍ' : 'NO'}  reload=${r.recargo ? 'SÍ' : 'no'}`)
fila('A pushState', rPush)
fila('B pushState + popstate', rPop)
fila('C navigation.navigate()', rNavApi)
fila('D anchor same-origin', rAnchor)
fila('E top-level (tabs.update actual)', rTop)

await nav.close()
