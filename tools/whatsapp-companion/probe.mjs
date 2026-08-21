// ============================================================================
// Prueba automatizada del Companion en un Chromium REAL.
//
//   npm run companion:probe             carga la carpeta fuente
//   npm run companion:probe:packaged    carga EL ZIP que se sube al Store
//
// La segunda es la que importa antes de publicar. Probar el fuente NO alcanza:
// el bug del backslash en `lib\contract.js` produjo un ZIP que INSTALA sin
// error y queda inerte, porque el import ESM del service worker no resuelve.
// Ese modo de falla es silencioso, así que hay que cargar el artefacto real.
//
// Sirve el harness desde el origin de producción (interceptado, sin salir a la
// red) y corre el descubrimiento, los casos 0..3 y los negativos de seguridad.
//
// No reemplaza la prueba manual del owner en SU Google Chrome — la adelanta.
// ============================================================================
import { chromium } from '@playwright/test'
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extraerZip } from '../../scripts/companion/package.mjs'

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = join(AQUI, '..', '..')
const ORIGEN = 'https://www.techrepairpro.app'
const HARNESS = `${ORIGEN}/companion-harness`
const AJENO = 'https://ejemplo-no-autorizado.test/harness'

const EMPAQUETADO = process.argv.includes('--packaged')

/** De dónde se carga la extensión: la carpeta fuente, o el ZIP extraído. */
function resolverExtension() {
  if (process.env.COMPANION_EXT_DIR) return { dir: process.env.COMPANION_EXT_DIR, fuente: 'COMPANION_EXT_DIR' }
  if (!EMPAQUETADO) return { dir: AQUI, fuente: 'carpeta fuente' }

  const distDir = join(RAIZ, 'dist', 'companion')
  const zips = existsSync(distDir) ? readdirSync(distDir).filter((f) => f.endsWith('.zip')) : []
  if (zips.length !== 1) {
    console.error(`\n✗ Se esperaba exactamente 1 ZIP en dist/companion/, hay ${zips.length}.`)
    console.error('  Armalo con: npm run companion:package\n')
    process.exit(1)
  }
  const destino = mkdtempSync(join(tmpdir(), 'companion-zip-'))
  const entradas = extraerZip(readFileSync(join(distDir, zips[0])), destino)
  console.log(`ZIP: ${zips[0]} → ${entradas.length} archivos extraídos`)
  return { dir: destino, fuente: `ZIP ${zips[0]}` }
}

const { dir: EXT, fuente: DE_DONDE } = resolverExtension()

async function abrirNavegador(dirExtension) {
  const perfil = mkdtempSync(join(tmpdir(), 'companion-'))
  const ctx = await chromium.launchPersistentContext(perfil, {
    headless: false,
    args: [`--disable-extensions-except=${dirExtension}`, `--load-extension=${dirExtension}`, '--no-first-run'],
  })
  let sw = ctx.serviceWorkers()[0]
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 })
  return { ctx, id: new URL(sw.url()).host }
}

const { ctx, id: EXTENSION_ID } = await abrirNavegador(EXT)
console.log(`extensión cargada desde ${DE_DONDE} · ID: ${EXTENSION_ID}\n`)

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

const enviarA = (page, extId, payload) => page.evaluate(([id, p]) => new Promise((resolve) => {
  if (!chrome?.runtime?.sendMessage) return resolve({ sinApi: true })
  chrome.runtime.sendMessage(id, p, (res) => {
    resolve({ res: res ?? null, lastError: chrome.runtime.lastError?.message ?? null })
  })
}), [extId, payload])

const enviar = (page, payload) => enviarA(page, EXTENSION_ID, payload)

const tabsWhatsApp = () => ctx.pages().filter(p => p.url().startsWith('https://web.whatsapp.com/'))
const msg = (tel, txt) => ({ type: 'OPEN_WHATSAPP_WEB', phone: tel, text: txt })

const page = ctx.pages()[0] ?? await ctx.newPage()
await prepararPagina(page, HARNESS)

let fallas = 0
const chequear = (etiqueta, ok, detalle) => {
  if (!ok) fallas++
  console.log(`   ${ok ? 'OK  ' : 'FALLA'} ${etiqueta}${detalle ? ' · ' + detalle : ''}`)
}

// ══ PING · descubrimiento ═════════════════════════════════════════════════
// Así TechRepair sabe si el Companion está instalado sin heurísticas: le habla
// a una extensión conocida por ID. Tiene que responder SIN abrir nada.
console.log('══ PING · descubrimiento ═════════════════════════════════════')
const tabsAntesPing = tabsWhatsApp().length
const ping = await enviar(page, { type: 'PING' })
await page.waitForTimeout(500)
chequear('responde ok', ping.res?.ok === true, JSON.stringify(ping.res))
chequear('declara versión', typeof ping.res?.version === 'string' && /^\d+\.\d+\.\d+$/.test(ping.res.version), ping.res?.version)
chequear('informa hostAccess', ping.res?.hostAccess === true, String(ping.res?.hostAccess))
chequear('el PING no abre ninguna pestaña', tabsWhatsApp().length === tabsAntesPing)

// ══ CASO 0 · WhatsApp abierto MANUALMENTE, se adopta ═══════════════════════
console.log('\n══ CASO 0 · adopta una pestaña abierta a mano ════════════════')
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

// La identidad de la pestaña la determina PLAYWRIGHT, no lo que reporte la
// extensión: la respuesta ya no incluye `tabId`, y una prueba que confiara en
// el número que devuelve el sujeto bajo prueba probaría menos, no más.
const pestanaA = tabsTrasA[0]

// ══ CASO 1 · segundo mensaje ══════════════════════════════════════════════
console.log('\n══ CASO 1 · segundo destinatario ═════════════════════════════')
const r1 = await enviar(page, msg('5491123456789', 'cliente B'))
await page.waitForTimeout(1500)
const tabsTrasB = tabsWhatsApp()
chequear('sigue 1 pestaña', tabsTrasB.length === 1, `hay ${tabsTrasB.length}`)
chequear('es LA MISMA pestaña (identidad de Playwright)', tabsTrasB[0] === pestanaA)
chequear('action=reused', r1.res?.action === 'reused')
chequear('navegó al contacto B', tabsTrasB[0]?.url().includes('phone=5491123456789'))

// ══ CASO 2 · tercero ══════════════════════════════════════════════════════
console.log('\n══ CASO 2 · tercer destinatario ══════════════════════════════')
const r2 = await enviar(page, msg('5493512223333', 'cliente C'))
await page.waitForTimeout(1500)
chequear('sigue 1 pestaña', tabsWhatsApp().length === 1)
chequear('sigue siendo LA MISMA pestaña', tabsWhatsApp()[0] === pestanaA)
chequear('action=reused', r2.res?.action === 'reused')
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
const pestanaNueva = tabsWhatsApp()[0]

const r4 = await enviar(page, msg('5491123456789', 'cliente B otra vez'))
await page.waitForTimeout(1500)
chequear('sigue 1 (reutiliza la nueva)', tabsWhatsApp().length === 1)
chequear('action=reused', r4.res?.action === 'reused')
chequear('es la MISMA que se acaba de crear', tabsWhatsApp()[0] === pestanaNueva)

// ══ RESPUESTA MÍNIMA ══════════════════════════════════════════════════════
// TechRepair no tiene por qué enterarse de cuántas pestañas de WhatsApp Web
// tiene abiertas la persona, ni del id interno de ninguna.
console.log('\n══ RESPUESTA MÍNIMA ══════════════════════════════════════════')
const clavesApertura = Object.keys(r4.res ?? {}).sort()
chequear('la apertura devuelve SÓLO { ok, action }',
  JSON.stringify(clavesApertura) === JSON.stringify(['action', 'ok']), JSON.stringify(clavesApertura))
chequear('no filtra tabId', !('tabId' in (r4.res ?? {})))
chequear('no filtra la cantidad de pestañas', !('encontradas' in (r4.res ?? {})))

// ══ NEGATIVOS DE SEGURIDAD ════════════════════════════════════════════════
console.log('\n══ NEGATIVOS DE SEGURIDAD ════════════════════════════════════')
const antes = tabsWhatsApp().length

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

// El error nunca lleva detalle: los mensajes crudos de la Tabs API pueden
// incluir la URL completa, o sea el teléfono y el mensaje.
chequear('los errores no adjuntan detalle',
  ['detalle', 'message', 'stack'].every(k => !(k in (nPhone.res ?? {}))), JSON.stringify(nPhone.res))

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

await ctx.close()

// ══ SIN ACCESO AL HOST ════════════════════════════════════════════════════
// Chrome permite dejar el acceso al sitio en «Al hacer clic». En ese estado
// `tabs.query({url})` NO tira error: devuelve CERO pestañas —medido— así que
// sin el chequeo de permisos la extensión crearía una pestaña nueva cada vez,
// en silencio y respondiendo ok. Acá se reproduce cargando una copia sin el
// host permission, que es el mismo estado desde el punto de vista del código.
console.log('\n══ SIN ACCESO A web.whatsapp.com ═════════════════════════════')
{
  const copia = mkdtempSync(join(tmpdir(), 'companion-sin-host-'))
  cpSync(EXT, copia, { recursive: true })
  const m = JSON.parse(readFileSync(join(copia, 'manifest.json'), 'utf-8'))
  delete m.host_permissions
  writeFileSync(join(copia, 'manifest.json'), JSON.stringify(m, null, 2), 'utf-8')

  const { ctx: ctx2, id: id2 } = await abrirNavegador(copia)
  const p2 = ctx2.pages()[0] ?? await ctx2.newPage()
  await prepararPagina(p2, HARNESS)

  const ping2 = await enviarA(p2, id2, { type: 'PING' })
  chequear('el PING responde igual (la extensión ESTÁ)', ping2.res?.ok === true, JSON.stringify(ping2.res))
  chequear('pero informa hostAccess=false', ping2.res?.hostAccess === false, String(ping2.res?.hostAccess))

  const tabsAntes = ctx2.pages().filter(p => p.url().startsWith('https://web.whatsapp.com/')).length
  const open2 = await enviarA(p2, id2, msg('5493511234567', 'sin acceso'))
  await p2.waitForTimeout(1200)
  const tabsDespues = ctx2.pages().filter(p => p.url().startsWith('https://web.whatsapp.com/')).length

  chequear('la apertura devuelve HOST_ACCESS_REQUIRED',
    open2.res?.code === 'HOST_ACCESS_REQUIRED', JSON.stringify(open2.res))
  chequear('NO crea una pestaña a ciegas', tabsDespues === tabsAntes, `${tabsAntes} → ${tabsDespues}`)
  chequear('no se hace pasar por éxito', open2.res?.ok !== true)

  await ctx2.close()
}

console.log(`\n${fallas === 0 ? '✅ Todos los chequeos pasaron' : `❌ ${fallas} chequeos fallaron`}`)
console.log(`\nCargado desde: ${DE_DONDE}`)
console.log('Permisos declarados: host_permissions ["https://web.whatsapp.com/*"] · SIN "tabs"')

process.exit(fallas === 0 ? 0 : 1)
