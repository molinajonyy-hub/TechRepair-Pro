/**
 * Contrato de la superficie pública del portal mayorista.
 *
 * Cierra el P0 de `businesses_portal_public_read`: la tabla `businesses` tiene
 * 34 columnas (incluida la facturación de Mercado Pago) y el portal público
 * sólo puede ver 7. La barrera vive en la DB (RPC SECURITY DEFINER + lockdown
 * de grants), y estos tests protegen el lado del cliente, que es donde una
 * regresión inocente —un `select('*')`, un fallback demasiado ancho— volvería
 * a abrir el agujero sin tocar ninguna migración.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  isMissingObject,
  PORTAL_PUBLIC_COLUMNS,
  PORTAL_PUBLIC_RPC,
  PORTAL_FEATURES_RPC,
  portalCanOrder,
} from '../../src/portal/portalPublicContract.ts'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '../../src/portal/services/portalService.ts'), 'utf8')

/** Allowlist canónica: debe coincidir con RETURNS TABLE de la RPC. */
const ALLOWLIST = [
  'id',
  'name',
  'logo_url',
  'wholesale_portal_enabled',
  'wholesale_portal_slug',
  'wholesale_whatsapp',
  'wholesale_portal_theme',
]

/** Columnas de `businesses` que nunca pueden salir por la superficie pública. */
const PROHIBIDAS = [
  'mp_preapproval_id',
  'mp_preapproval_plan_id',
  'mp_payer_email',
  'mp_last_modified',
  'last_payment_id',
  'last_payment_status',
  'owner_user_id',
  'subscription_status',
  'subscription_plan',
  'grace_until',
  'trial_ends_at',
  'access_source',
  'override_reason',
]

// ── Allowlist de columnas ───────────────────────────────────────────────────

test('la allowlist tiene exactamente las 7 columnas públicas', () => {
  const cols = PORTAL_PUBLIC_COLUMNS.split(',').map(c => c.trim()).filter(Boolean)
  assert.equal(cols.length, 7, `esperaba 7 columnas, hay ${cols.length}`)
  assert.deepEqual([...cols].sort(), [...ALLOWLIST].sort())
})

test('ninguna columna sensible figura en la allowlist', () => {
  const cols = PORTAL_PUBLIC_COLUMNS.split(',').map(c => c.trim())
  for (const prohibida of PROHIBIDAS) {
    assert.ok(!cols.includes(prohibida), `la allowlist expone ${prohibida}`)
  }
})

/**
 * Una columna nueva en `businesses` no debe volverse pública sola. Del lado
 * del cliente eso se garantiza porque la selección es una lista explícita y
 * cerrada: agregar una columna a la tabla no cambia este string. El test lo
 * fija para que una regresión a `*` (o a una lista abierta) falle acá.
 */
test('una columna futura de businesses no se vuelve pública', () => {
  const cols = PORTAL_PUBLIC_COLUMNS.split(',').map(c => c.trim())
  const columnaFutura = 'columna_nueva_hipotetica'
  assert.ok(!cols.includes(columnaFutura))
  assert.ok(
    !PORTAL_PUBLIC_COLUMNS.includes('*'),
    'la selección debe ser una lista cerrada, nunca un comodín',
  )
})

// ── Prohibición de select('*') ──────────────────────────────────────────────

/**
 * Acotado a `businesses` a propósito: `select('*')` sobre `wholesale_customers`
 * es legítimo y preexistente (tabla con RLS propia, alcance por tenant). Lo que
 * no puede pasar es traer el comodín de una tabla con 34 columnas de las cuales
 * 7 son públicas.
 */
test("ninguna lectura de businesses usa select('*')", () => {
  const lecturas = [...src.matchAll(/\.from\(\s*['"`]businesses['"`]\s*\)([\s\S]{0,300})/g)]
  assert.ok(lecturas.length > 0, 'se esperaba el fallback transitorio a businesses')
  for (const [, cola] of lecturas) {
    assert.doesNotMatch(cola, /\.select\(\s*['"`]\s*\*\s*['"`]\s*\)/,
      "el fallback a businesses no puede usar el comodín select('*')")
  }
})

test('toda lectura de businesses selecciona la allowlist por constante', () => {
  const lecturas = [...src.matchAll(/\.from\(\s*['"`]businesses['"`]\s*\)([\s\S]{0,300})/g)]
  assert.ok(lecturas.length > 0)
  for (const [, cola] of lecturas) {
    assert.match(cola, /\.select\(PORTAL_PUBLIC_COLUMNS\)/,
      'debe seleccionar PORTAL_PUBLIC_COLUMNS, no una lista escrita a mano')
  }
})

test('el portal consulta la RPC pública', () => {
  assert.equal(PORTAL_PUBLIC_RPC, 'get_wholesale_portal_public')
  assert.match(src, /supabase\.rpc\(PORTAL_PUBLIC_RPC/)
})

// ── Fallback acotado ────────────────────────────────────────────────────────

test('el fallback se activa sólo si el objeto no existe', () => {
  assert.equal(isMissingObject({ code: 'PGRST202' }), true, 'función ausente del schema cache')
  assert.equal(isMissingObject({ code: '42883' }), true, 'undefined_function')
  assert.equal(isMissingObject({ code: 'PGRST205' }), true, 'relación ausente')
  assert.equal(isMissingObject({ code: '42P01' }), true, 'undefined_table')
})

test('el fallback NO se activa para permisos, auth ni 5xx', () => {
  // Éste es el caso peligroso: con el lockdown aplicado, la RPC puede devolver
  // 42501 si alguien rompe los grants. Si el fallback se disparara, el portal
  // volvería a golpear la tabla en vez de fallar a la vista.
  assert.equal(isMissingObject({ code: '42501', message: 'permission denied for table businesses' }), false)
  assert.equal(isMissingObject({ code: 'PGRST301', message: 'JWT expired' }), false)
  assert.equal(isMissingObject({ code: 'PGRST116', message: 'no rows' }), false)
  assert.equal(isMissingObject({ code: '500', message: 'internal server error' }), false)
  assert.equal(isMissingObject({ code: '', message: 'relation does not exist' }), false,
    'sin código conocido no se asume ausencia: el mensaje solo no alcanza')
  assert.equal(isMissingObject(null), false)
})

// ─── Superficie de features del portal ───────────────────────────────────────

test('el portal usa su propia RPC de features, no el paywall del comercio', () => {
  assert.equal(PORTAL_FEATURES_RPC, 'get_wholesale_portal_features')
  assert.notEqual(PORTAL_FEATURES_RPC, 'get_business_subscription_features',
    'get_business_subscription_features exige pertenencia al negocio y el ' +
    'cliente del portal NO es miembro: usarla daría 42501')
})

test('portalCanOrder exige plan mayorista Y suscripción activa', () => {
  assert.equal(portalCanOrder({ mayorista: true,  active: true  }), true)
  assert.equal(portalCanOrder({ mayorista: false, active: true  }), false,
    'sin plan mayorista no se toman pedidos aunque la suscripción esté al día')
  assert.equal(portalCanOrder({ mayorista: true,  active: false }), false,
    'suspendida o cancelada no toma pedidos aunque el plan los habilite')
  assert.equal(portalCanOrder({ mayorista: false, active: false }), false)
})

test('portalCanOrder es fail-closed ante ausencia de payload', () => {
  // La RPC devuelve NULL para slug inexistente, portal apagado o error de red.
  // Ninguno de esos casos puede interpretarse como "sí, tomá el pedido".
  assert.equal(portalCanOrder(null), false)
  assert.equal(portalCanOrder(undefined), false)
})

test('createOrder exige el slug del portal, no sólo el businessId', () => {
  // Regresión: si createOrder volviera a decidir por business_id, cualquier
  // usuario registrado podría consultar features de otro tenant. El contrato
  // seguro se resuelve por slug exacto.
  const svc = readFileSync(join(here, '../../src/portal/services/portalService.ts'), 'utf8')
  assert.match(svc, /portalSlug:\s*string/,
    'createOrder debe recibir el slug del portal')
  assert.doesNotMatch(svc, /requireFeature\s*\(/,
    'portalService no debe usar requireFeature: ése es el paywall del comercio')
})
