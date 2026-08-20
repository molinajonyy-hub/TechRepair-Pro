// ============================================================================
// POC · prueba automatizada del Companion en un Chromium REAL.
//
//   node tools/whatsapp-companion/probe.mjs
//
// Carga la extensión unpacked en un perfil temporal, sirve el harness desde el
// origin de producción (interceptado, sin salir a la red) y corre los casos
// 0..3 más los negativos de seguridad.
//
// No reemplaza la prueba manual del owner en SU Google Chrome — la adelanta.
// ============================================================================
import { chromium } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXT = dirname(fileURLToPath(import.meta.url))
const ORIGEN = 'https://www.techrepairpro.app'
const HARNESS = `${ORIGEN}/companion-harness`
const AJENO = 'https://ejemplo-no-autorizado.test/harness'

const PERFIL = mkdtempSync(join(tmpdir(), 'companion-'))
const ctx = await chromium.launchPersistentContext(PERFIL, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
})

// ── ID de la extensión: sale del target del service worker ─────────────────
let sw = ctx.serviceWorkers()[0]
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 })
const EXTENSION_ID = new URL(sw.url()).host
console.log(`extensión cargada · ID: ${EXTENSION_ID}\n`)

// El harness se sirve DESDE el origin autorizado, sin tocar la red.
const paginaHarness = '<!doctype html><meta charset="utf-8"><title>harness</title><body></body>'
async function prepararPagina(page, url) {
  await page.route('**/*', (route) => {
    const u = route.request().url()
    if (u.startsWith(HARNESS) || u.startsWith(AJENO)) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: paginaHarness })
    }
    if (u.startsWith('https://web.whatsapp.com/')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>WhatsApp (stub)</title>' })
    }
    return route.abort()
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
}

const enviar = (page, payload) => page.evaluate(([id, p]) => new Promise((resolve) => {
  if (!chrome?.runtime?.sendMessage) return resolve({ sinApi: true })
  chrome.runtime.sendMessage(id, p, (res) => {
    resolve({ res: res ?? null, lastError: chrome.runtime.lastError?.message ?? null })
  })
}), [EXTENSION_ID, payload])

const tabsWhatsApp = () => ctx.pages().filter(p => p.url().startsWith('https://web.whatsapp.com/'))
const msg = (tel, txt) => ({ type: 'OPEN_WHATSAPP_WEB', phone: tel, text: txt })

const page = ctx.pages()[0] ?? await ctx.newPage()
await prepararPagina(page, HARNESS)

let fallas = 0
const chequear = (etiqueta, ok, detalle) => {
  if (!ok) fallas++
  console.log(`   ${ok ? 'OK  ' : 'FALLA'} ${etiqueta}${detalle ? ' · ' + detalle : ''}`)
}

// ══ CASO 0 · WhatsApp abierto MANUALMENTE, se adopta ═══════════════════════
console.log('══ CASO 0 · adopta una pestaña abierta a mano ════════════════')
const manual = await ctx.newPage()
await prepararPagina(manual, 'https://web.whatsapp.com/')
console.log(`   pestañas WhatsApp antes: ${tabsWhatsApp().length}`)

const r0 = await enviar(page, msg('5493511234567', 'cliente A'))
await page.waitForTimeout(1500)
const tabsTrasA = tabsWhatsApp()
console.log(`   respuesta: ${JSON.stringify(r0.res)}`)
chequear('sigue habiendo 1 pestaña de WhatsApp', tabsTrasA.length === 1, `hay ${tabsTrasA.length}`)
chequear('la adoptó (action=reused)', r0.res?.action === 'reused')
chequear('navegó al contacto A', tabsTrasA[0]?.url().includes('phone=5493511234567'))
chequear('el harness sigue abierto', !page.isClosed() && page.url().startsWith(ORIGEN))
const tabIdA = r0.res?.tabId

// ══ CASO 1 · segundo mensaje ══════════════════════════════════════════════
console.log('\n══ CASO 1 · segundo destinatario ═════════════════════════════')
const r1 = await enviar(page, msg('5491123456789', 'cliente B'))
await page.waitForTimeout(1500)
const tabsTrasB = tabsWhatsApp()
chequear('sigue 1 pestaña', tabsTrasB.length === 1, `hay ${tabsTrasB.length}`)
chequear('MISMO tabId', r1.res?.tabId === tabIdA, `${tabIdA} vs ${r1.res?.tabId}`)
chequear('action=reused', r1.res?.action === 'reused')
chequear('navegó al contacto B', tabsTrasB[0]?.url().includes('phone=5491123456789'))

// ══ CASO 2 · tercero ══════════════════════════════════════════════════════
console.log('\n══ CASO 2 · tercer destinatario ══════════════════════════════')
const r2 = await enviar(page, msg('5493512223333', 'cliente C'))
await page.waitForTimeout(1500)
chequear('sigue 1 pestaña', tabsWhatsApp().length === 1)
chequear('MISMO tabId', r2.res?.tabId === tabIdA)
chequear('navegó al contacto C', tabsWhatsApp()[0]?.url().includes('phone=5493512223333'))

// ══ CASO 3 · pestaña cerrada ══════════════════════════════════════════════
console.log('\n══ CASO 3 · con la pestaña cerrada ═══════════════════════════')
for (const t of tabsWhatsApp()) await t.close()
await page.waitForTimeout(800)
chequear('quedaron 0 pestañas de WhatsApp', tabsWhatsApp().length === 0)

const r3 = await enviar(page, msg('5493511234567', 'cliente A otra vez'))
await page.waitForTimeout(1500)
chequear('creó exactamente 1', tabsWhatsApp().length === 1)
chequear('action=created', r3.res?.action === 'created', JSON.stringify(r3.res))

const r4 = await enviar(page, msg('5491123456789', 'cliente B otra vez'))
await page.waitForTimeout(1500)
chequear('sigue 1 (reutiliza la nueva)', tabsWhatsApp().length === 1)
chequear('action=reused', r4.res?.action === 'reused')
chequear('MISMO tabId que la recién creada', r4.res?.tabId === r3.res?.tabId)

// ══ NEGATIVOS DE SEGURIDAD ════════════════════════════════════════════════
console.log('\n══ NEGATIVOS DE SEGURIDAD ════════════════════════════════════')
const antes = tabsWhatsApp().length
const urlAntes = tabsWhatsApp()[0]?.url()

const nPhone = await enviar(page, msg('+54 9 351 boom', 'hola'))
chequear('phone inválido → BAD_PHONE', nPhone.res?.code === 'BAD_PHONE', JSON.stringify(nPhone.res))

const nTipo = await enviar(page, { type: 'DAME_LOS_CHATS', phone: '5493511234567', text: 'x' })
chequear('type desconocido → UNKNOWN_TYPE', nTipo.res?.code === 'UNKNOWN_TYPE', JSON.stringify(nTipo.res))

const nLargo = await enviar(page, msg('5493511234567', 'x'.repeat(9000)))
chequear('text gigante → TEXT_TOO_LONG', nLargo.res?.code === 'TEXT_TOO_LONG', JSON.stringify(nLargo.res))

const nUrl = await enviar(page, { type: 'OPEN_WHATSAPP_WEB', phone: '5493511234567', text: 'hola', url: 'https://evil.example/x' })
await page.waitForTimeout(1200)
chequear('url arbitraria IGNORADA', nUrl.res?.ok === true)
chequear('no navegó a evil.example', !tabsWhatsApp().some(t => t.url().includes('evil.example')))
chequear('el destino sigue siendo web.whatsapp.com', tabsWhatsApp()[0]?.url().startsWith('https://web.whatsapp.com/send'))

chequear('los negativos no crearon pestañas', tabsWhatsApp().length === antes, `${antes} → ${tabsWhatsApp().length}`)
void urlAntes

// Origin NO autorizado.
//
// El resultado esperado es MÁS fuerte que un rechazo: Chrome sólo expone
// `chrome.runtime.sendMessage` a las páginas que matchean
// `externally_connectable`, así que desde un origin ajeno la API ni siquiera
// existe y el mensaje no llega a salir. `FORBIDDEN_ORIGIN` (la segunda barrera,
// en el service worker) también se acepta: cubre el caso de que alguien afloje
// el manifest sin tocar el código.
const ajeno = await ctx.newPage()
await prepararPagina(ajeno, AJENO)
const nAjeno = await enviar(ajeno, msg('5493511234567', 'desde un origin ajeno'))
chequear('origin no autorizado NO puede hablarle a la extensión',
  nAjeno.sinApi === true || nAjeno.res?.code === 'FORBIDDEN_ORIGIN',
  nAjeno.sinApi ? 'chrome.runtime ni existe en ese origin' : JSON.stringify(nAjeno))
chequear('y no creó ninguna pestaña', tabsWhatsApp().length === antes)

console.log(`\n${fallas === 0 ? '✅ POC: todos los chequeos pasaron' : `❌ ${fallas} chequeos fallaron`}`)
console.log(`\nPermisos declarados: host_permissions ["https://web.whatsapp.com/*"] · SIN "tabs"`)

await ctx.close()
process.exit(fallas === 0 ? 0 : 1)
