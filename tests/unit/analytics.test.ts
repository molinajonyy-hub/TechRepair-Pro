/**
 * Tests de la infraestructura de analítica (GA4 + sanitización + page views).
 * Runner: node:test nativo. Sin DOM real: se inyecta un host falso.
 * NO se usa el measurement id real; se usa G-TEST123456.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  installGA4, installClarity, isValidGaId, sanitizeForExternal,
  buildPageViewParams, isPublicTrackedPath, recordEvent, trackPageView,
  resetAnalyticsForTest, type AnalyticsHost,
} from '../../src/lib/analytics.ts'

const GA = 'G-TEST123456'

/** Host falso con un document mínimo que registra los scripts insertados. */
function makeHost(over: Partial<AnalyticsHost> = {}): AnalyticsHost & { __scripts: any[] } {
  const scripts: any[] = []
  const byId: Record<string, any> = {}
  const sink = (node: any) => { scripts.push(node); if (node && node.id) byId[node.id] = node }
  const doc = {
    getElementById: (id: string) => byId[id] || null,
    createElement: (_tag: string) => ({ id: '', async: false, src: '' }),
    getElementsByTagName: (_tag: string) => [{ parentNode: { insertBefore: (node: any) => sink(node) } }],
    head: { appendChild: (node: any) => sink(node) },
    title: 'TechRepair Pro',
    referrer: '',
  }
  return {
    location: { pathname: '/landing', search: '', origin: 'https://app.test' },
    document: doc,
    innerWidth: 1280,
    __scripts: scripts,
    ...over,
  } as unknown as AnalyticsHost & { __scripts: any[] }
}

const gtagEvents = (h: AnalyticsHost, name: string) =>
  (h.dataLayer || []).filter(e => Array.isArray(e) && e[0] === 'event' && e[1] === name)
const gtagConfig = (h: AnalyticsHost) =>
  (h.dataLayer || []).find(e => Array.isArray(e) && e[0] === 'config') as unknown[] | undefined
const internalObjects = (h: AnalyticsHost, event: string) =>
  (h.dataLayer || []).filter(e => !Array.isArray(e) && (e as { event?: string }).event === event)

// ─── Validación de ID ──────────────────────────────────────────────────────────
test('isValidGaId acepta sólo el formato GA4', () => {
  assert.ok(isValidGaId('G-92J0WYZQRK'))
  assert.ok(isValidGaId(GA))
  assert.ok(!isValidGaId(''))
  assert.ok(!isValidGaId(undefined))
  assert.ok(!isValidGaId('UA-12345-6'))
  assert.ok(!isValidGaId('G-lowercase'))
})

// ─── GA4: ausente / inválido / válido ───────────────────────────────────────────
test('GA4: ID ausente no crea script y no rompe tracking interno', () => {
  const h = makeHost()
  assert.equal(installGA4(h, undefined), false)
  assert.equal(h.__scripts.length, 0)
  // El tracking interno sigue funcionando aunque GA no esté
  recordEvent(h, 'landing_view', { device: 'desktop' }, {})
  assert.equal(internalObjects(h, 'landing_view').length, 1)
})

test('GA4: ID inválido no crea script', () => {
  const h = makeHost()
  assert.equal(installGA4(h, 'NOPE'), false)
  assert.equal(h.__scripts.length, 0)
})

test('GA4: ID válido crea un script con URL correcta, dataLayer y send_page_view:false', () => {
  const h = makeHost()
  assert.equal(installGA4(h, GA), true)
  assert.equal(h.__scripts.length, 1)
  assert.equal(h.__scripts[0].src, 'https://www.googletagmanager.com/gtag/js?id=' + GA)
  assert.ok(Array.isArray(h.dataLayer))
  const cfg = gtagConfig(h)
  assert.ok(cfg, 'debe existir gtag("config", ...)')
  assert.equal(cfg![1], GA)
  assert.deepEqual(cfg![2], { send_page_view: false })
})

test('GA4: inicialización repetida no duplica script ni config', () => {
  const h = makeHost()
  assert.equal(installGA4(h, GA), true)
  assert.equal(installGA4(h, GA), false) // segunda vez: no-op
  assert.equal(h.__scripts.length, 1)
  assert.equal((h.dataLayer || []).filter(e => Array.isArray(e) && e[0] === 'config').length, 1)
})

// ─── Evento personalizado: objeto interno + un solo gtag('event') ───────────────
test('evento: conserva el objeto interno y emite un único gtag("event") sanitizado', () => {
  const h = makeHost()
  installGA4(h, GA)
  recordEvent(
    h,
    'plan_selected',
    { plan: 'pro', business_id: 'biz-uuid', device: 'desktop' },
    sanitizeForExternal({ plan: 'pro', business_id: 'biz-uuid', device: 'desktop' }),
  )
  const internal = internalObjects(h, 'plan_selected')
  assert.equal(internal.length, 1)
  assert.equal((internal[0] as any).business_id, 'biz-uuid') // contrato interno conserva id

  const events = gtagEvents(h, 'plan_selected')
  assert.equal(events.length, 1, 'un solo gtag("event")')
  const params = events[0][2] as Record<string, unknown>
  assert.equal(params.plan, 'pro')
  assert.equal(params.device, 'desktop')
  assert.equal(params.business_id, undefined, 'business_id NO debe ir a GA4')
})

// ─── Sanitización ────────────────────────────────────────────────────────────────
test('sanitizeForExternal: elimina claves sensibles y conserva las permitidas', () => {
  const out = sanitizeForExternal({
    business_id: 'biz', user_id: 'usr', email: 'a@b.com', phone: '123', whatsapp: '123',
    token: 'secret', imei: 'x', amount: 9999,
    plan: 'pro', section: 'journey', step: 'cobra', faq_id: 2, utm_source: 'ig',
  })
  assert.deepEqual(out, { plan: 'pro', section: 'journey', step: 'cobra', faq_id: 2, utm_source: 'ig' })
  for (const k of ['business_id', 'user_id', 'email', 'phone', 'whatsapp', 'token', 'imei', 'amount']) {
    assert.equal((out as Record<string, unknown>)[k], undefined, `${k} no debe pasar`)
  }
})

// ─── Page views ──────────────────────────────────────────────────────────────────
test('buildPageViewParams: sin hash y sólo con query params comerciales seguros', () => {
  const p = buildPageViewParams(
    { pathname: '/onboarding', search: '?token=secret&plan=pro&foo=bar&utm_source=ig', origin: 'https://app.test' },
    'Onboarding',
  )
  assert.equal(p.page_path, '/onboarding?plan=pro&utm_source=ig')
  assert.equal(p.page_location, 'https://app.test/onboarding?plan=pro&utm_source=ig')
  assert.equal(p.page_title, 'Onboarding')
  assert.ok(!/token|foo/.test(p.page_path), 'no debe incluir params desconocidos')
})

test('isPublicTrackedPath: sólo rutas públicas de adquisición', () => {
  assert.ok(isPublicTrackedPath('/landing'))
  assert.ok(isPublicTrackedPath('/onboarding'))
  assert.ok(!isPublicTrackedPath('/dashboard'))
  assert.ok(!isPublicTrackedPath('/personal/insights'))
  assert.ok(!isPublicTrackedPath('/'))
})

test('trackPageView: mide ruta pública, deduplica la misma y omite privadas', () => {
  resetAnalyticsForTest()
  const h = makeHost()
  installGA4(h, GA)
  const loc = (pathname: string, search = '') => ({ pathname, search, origin: 'https://app.test' })

  trackPageView(h, loc('/landing'), 'Landing')
  assert.equal(internalObjects(h, 'page_view').length, 1)

  trackPageView(h, loc('/landing'), 'Landing') // misma ruta: dedup
  assert.equal(internalObjects(h, 'page_view').length, 1)

  trackPageView(h, loc('/onboarding'), 'Onboarding') // ruta nueva
  assert.equal(internalObjects(h, 'page_view').length, 2)

  trackPageView(h, loc('/dashboard'), 'Dash') // privada: no mide
  assert.equal(internalObjects(h, 'page_view').length, 2)

  // page_view también se envía a GA4, una vez por vista
  assert.equal(gtagEvents(h, 'page_view').length, 2)
})

// ─── Clarity ─────────────────────────────────────────────────────────────────────
test('Clarity: no-op sin project id', () => {
  const h = makeHost()
  assert.equal(installClarity(h, undefined), false)
  assert.equal(h.__scripts.length, 0)
})

test('Clarity: instala una vez y no duplica en init repetida', () => {
  const h = makeHost()
  assert.equal(installClarity(h, 'proj123'), true)
  assert.equal(installClarity(h, 'proj123'), false)
  assert.equal(h.__scripts.length, 1)
  assert.equal(h.__scripts[0].src, 'https://www.clarity.ms/tag/proj123')
})
