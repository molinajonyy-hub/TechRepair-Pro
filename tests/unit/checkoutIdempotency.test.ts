/**
 * Idempotencia server-side del checkout (auditoría 2026-07-01).
 *
 * Cubre: hash determinista del contenido comercial (orden de claves/ítems/
 * pagos, normalización numérica), gestión de la idempotency key en
 * sessionStorage (useRef/persistencia/recuperación), y contrato de fuente
 * (crear() llama a la RPC atómica, nunca a los inserts directos viejos;
 * grants correctos en la migración).
 *
 * computeCheckoutRequestHash usa crypto.subtle (Web Crypto) — disponible de
 * forma nativa en el runtime de Node usado por este test runner, así que se
 * ejecuta de verdad (no es un test de contrato de fuente).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  computeCheckoutRequestHash, getOrCreateIdempotencyKey, readPendingCheckout,
  savePendingCheckout, clearPendingCheckout, type CheckoutHashInput,
} from '../../src/lib/checkoutIdempotency.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

// ── Mock de sessionStorage (Node no lo tiene por defecto) ───────────────────
function installMockSessionStorage() {
  const store = new Map<string, string>()
  ;(globalThis as any).sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
  return store
}

const baseInput = (): CheckoutHashInput => ({
  business_id: 'biz-1',
  tipo: 'factura_c',
  customer_id: null,
  condicion_fiscal: 'Consumidor Final',
  currency: 'ARS',
  items: [
    { descripcion: 'Producto A', tipo_linea: 'producto', cantidad: 2, precio_unitario: 500, descuento_linea: 0, currency: 'ARS' },
    { descripcion: 'Producto B', tipo_linea: 'producto', cantidad: 1, precio_unitario: 300, descuento_linea: 10, currency: 'ARS' },
  ],
  pagos: [{ payment_method: 'efectivo', amount: 1270, currency: 'ARS' }],
  subtotal: 1270,
  tax: 0,
  total: 1270,
  cc_total: 0,
})

test('computeCheckoutRequestHash: es determinista — mismo input produce el mismo hash', async () => {
  const h1 = await computeCheckoutRequestHash(baseInput())
  const h2 = await computeCheckoutRequestHash(baseInput())
  assert.equal(h1, h2)
  assert.match(h1, /^[0-9a-f]{64}$/, 'debe ser un hex SHA-256 de 64 caracteres')
})

test('computeCheckoutRequestHash: el ORDEN de ítems/pagos no cambia el hash (no es semántico)', async () => {
  const input = baseInput()
  const reordered: CheckoutHashInput = { ...input, items: [...input.items].reverse() }
  const h1 = await computeCheckoutRequestHash(input)
  const h2 = await computeCheckoutRequestHash(reordered)
  assert.equal(h1, h2, 'reordenar los mismos ítems del carrito debe producir el mismo hash')
})

test('computeCheckoutRequestHash: cambiar PRECIO sí cambia el hash', async () => {
  const input = baseInput()
  const changed: CheckoutHashInput = { ...input, items: [{ ...input.items[0], precio_unitario: 999 }, input.items[1]] }
  const h1 = await computeCheckoutRequestHash(input)
  const h2 = await computeCheckoutRequestHash(changed)
  assert.notEqual(h1, h2)
})

test('computeCheckoutRequestHash: cambiar CANTIDAD sí cambia el hash', async () => {
  const input = baseInput()
  const changed: CheckoutHashInput = { ...input, items: [{ ...input.items[0], cantidad: 99 }, input.items[1]] }
  const h1 = await computeCheckoutRequestHash(input)
  const h2 = await computeCheckoutRequestHash(changed)
  assert.notEqual(h1, h2)
})

test('computeCheckoutRequestHash: cambiar el MEDIO DE PAGO sí cambia el hash', async () => {
  const input = baseInput()
  const changed: CheckoutHashInput = { ...input, pagos: [{ payment_method: 'tarjeta_credito', amount: 1270, currency: 'ARS' }] }
  const h1 = await computeCheckoutRequestHash(input)
  const h2 = await computeCheckoutRequestHash(changed)
  assert.notEqual(h1, h2)
})

test('computeCheckoutRequestHash: diferencias de punto flotante insignificantes (redondeo) NO cambian el hash', async () => {
  const input = baseInput()
  const almostSame: CheckoutHashInput = { ...input, total: 1270.00000001, subtotal: 1270.00000001 }
  const h1 = await computeCheckoutRequestHash(input)
  const h2 = await computeCheckoutRequestHash(almostSame)
  assert.equal(h1, h2, 'la normalización a 2 decimales debe colapsar diferencias de punto flotante')
})

test('computeCheckoutRequestHash: distinto business_id (distinto negocio) sí cambia el hash', async () => {
  const input = baseInput()
  const other: CheckoutHashInput = { ...input, business_id: 'biz-2' }
  const h1 = await computeCheckoutRequestHash(input)
  const h2 = await computeCheckoutRequestHash(other)
  assert.notEqual(h1, h2)
})

test('getOrCreateIdempotencyKey: mismo hash -> reutiliza la MISMA key (no la regenera)', () => {
  installMockSessionStorage()
  const { idempotencyKey: k1 } = getOrCreateIdempotencyKey('biz-1', 'hash-a')
  const { idempotencyKey: k2, isResumed } = getOrCreateIdempotencyKey('biz-1', 'hash-a')
  assert.equal(k1, k2, 'reintentar con el mismo hash debe reutilizar la key persistida')
  assert.equal(isResumed, true)
})

test('getOrCreateIdempotencyKey: hash DISTINTO -> genera una key NUEVA (venta distinta)', () => {
  installMockSessionStorage()
  const { idempotencyKey: k1 } = getOrCreateIdempotencyKey('biz-1', 'hash-a')
  const { idempotencyKey: k2, isResumed } = getOrCreateIdempotencyKey('biz-1', 'hash-b')
  assert.notEqual(k1, k2, 'un carrito distinto (hash distinto) nunca debe reutilizar la key anterior')
  assert.equal(isResumed, false)
})

test('getOrCreateIdempotencyKey: sin checkout pendiente -> genera una key nueva y la persiste', () => {
  const store = installMockSessionStorage()
  assert.equal(store.size, 0)
  const { idempotencyKey, isResumed } = getOrCreateIdempotencyKey('biz-1', 'hash-a')
  assert.equal(isResumed, false)
  assert.ok(idempotencyKey.length > 0)
  const pending = readPendingCheckout('biz-1')
  assert.equal(pending?.idempotencyKey, idempotencyKey)
  assert.equal(pending?.requestHash, 'hash-a')
})

test('clearPendingCheckout: descarta el pendiente — el siguiente intento genera una key nueva aunque el hash coincida', () => {
  installMockSessionStorage()
  const { idempotencyKey: k1 } = getOrCreateIdempotencyKey('biz-1', 'hash-a')
  clearPendingCheckout('biz-1')
  const { idempotencyKey: k2, isResumed } = getOrCreateIdempotencyKey('biz-1', 'hash-a')
  assert.notEqual(k1, k2, 'tras descartar el pendiente, ni siquiera el mismo hash reutiliza la key vieja')
  assert.equal(isResumed, false)
})

test('savePendingCheckout/readPendingCheckout: persisten business_id/hash/comprobante_id correctamente', () => {
  installMockSessionStorage()
  savePendingCheckout({ idempotencyKey: 'k-1', requestHash: 'h-1', businessId: 'biz-1', createdAt: '2026-01-01T00:00:00Z', comprobanteId: 'comp-1' })
  const pending = readPendingCheckout('biz-1')
  assert.equal(pending?.idempotencyKey, 'k-1')
  assert.equal(pending?.comprobanteId, 'comp-1')
})

test('readPendingCheckout: negocios DISTINTOS tienen storage keys separadas (no se pisan)', () => {
  installMockSessionStorage()
  getOrCreateIdempotencyKey('biz-1', 'hash-a')
  getOrCreateIdempotencyKey('biz-2', 'hash-b')
  const p1 = readPendingCheckout('biz-1')
  const p2 = readPendingCheckout('biz-2')
  assert.notEqual(p1?.idempotencyKey, p2?.idempotencyKey)
})

// ─── Contrato de fuente: comprobanteService.crear() usa la RPC atómica ─────

test('comprobanteService.crear(): llama a create_comprobante_checkout_atomic, no a inserts directos de comprobantes/items/pagos', () => {
  const service = read('../../src/services/comprobanteService.ts')
  const crearStart = service.indexOf('async crear(input: CrearComprobanteInput)')
  const crearEnd = service.indexOf('\n  // ── Emitir borrador', crearStart)
  assert.ok(crearStart >= 0 && crearEnd > crearStart)
  const body = service.slice(crearStart, crearEnd)

  assert.match(body, /supabase\.rpc\('create_comprobante_checkout_atomic'/, 'crear() debe llamar a la RPC atómica')
  assert.doesNotMatch(body, /\.from\('comprobantes'\)\s*\.insert/, 'crear() ya NO debe insertar comprobantes directamente')
  assert.doesNotMatch(body, /\.from\('comprobante_items'\)\s*\.insert/, 'crear() ya NO debe insertar ítems directamente')
  assert.doesNotMatch(body, /\.from\('comprobante_payments'\)\s*\.insert/, 'crear() ya NO debe insertar pagos directamente')
  assert.doesNotMatch(body, /this\._descontarStock/, 'crear() ya NO debe llamar a _descontarStock directamente (lo hace la RPC)')
})

test('comprobanteService.crear(): calcula el request_hash SIEMPRE internamente (nunca confía en uno provisto por el caller)', () => {
  const service = read('../../src/services/comprobanteService.ts')
  const crearStart = service.indexOf('async crear(input: CrearComprobanteInput)')
  const crearEnd = service.indexOf('\n  // ── Emitir borrador', crearStart)
  const body = service.slice(crearStart, crearEnd)
  assert.match(body, /computeCheckoutRequestHash\(/)
  assert.doesNotMatch(body, /input\.request_hash/, 'no debe existir un campo request_hash en el input confiado del caller')
})

test('comprobanteService.crear(): ARCA se llama DESPUÉS de la RPC de creación local, nunca antes', () => {
  const service = read('../../src/services/comprobanteService.ts')
  const crearStart = service.indexOf('async crear(input: CrearComprobanteInput)')
  const crearEnd = service.indexOf('\n  // ── Emitir borrador', crearStart)
  const body = service.slice(crearStart, crearEnd)
  const idxRpc = body.indexOf("supabase.rpc('create_comprobante_checkout_atomic'")
  const idxArca = body.indexOf('_claimYEmitirArca(business_id, compId')
  assert.ok(idxRpc >= 0 && idxArca > idxRpc, 'la llamada a ARCA debe aparecer DESPUÉS de la RPC de creación local en el código fuente')
})

test('comprobanteService.crear(): maneja explícitamente idempotency_conflict y already_processing (nunca los trata como error genérico)', () => {
  const service = read('../../src/services/comprobanteService.ts')
  const crearStart = service.indexOf('async crear(input: CrearComprobanteInput)')
  const crearEnd = service.indexOf('\n  // ── Emitir borrador', crearStart)
  const body = service.slice(crearStart, crearEnd)
  assert.match(body, /checkoutStatus === 'idempotency_conflict'/)
  assert.match(body, /checkoutStatus === 'already_processing'/)
  assert.match(body, /idempotencyConflict: true/)
  assert.match(body, /alreadyProcessing: true/)
})

test('ComprobanteProModal: genera/recupera la idempotency key ANTES de llamar a crear(), nunca la regenera en cada submit', () => {
  const modal = read('../../src/components/comprobantes/ComprobanteProModal.tsx')
  assert.match(modal, /import\s*\{[\s\S]*?getOrCreateIdempotencyKey[\s\S]*?\}\s*from\s*'\.\.\/\.\.\/lib\/checkoutIdempotency'/)
  assert.match(modal, /getOrCreateIdempotencyKey\(businessId, requestHash\)/)
  assert.match(modal, /idempotency_key:\s*idempotencyKey/)
})

test('ComprobanteProModal: recupera un checkout pendiente al abrir el modal (fase 9) — nunca dispara una creación nueva sin resolverlo antes', () => {
  const modal = read('../../src/components/comprobantes/ComprobanteProModal.tsx')
  assert.match(modal, /readPendingCheckout\(businessId\)/)
  assert.match(modal, /getCheckoutStatus\(businessId, pending\.idempotencyKey\)/)
})

test('ComprobanteProModal: idempotency_conflict nunca genera una key nueva automáticamente — solo descarta el pendiente y exige revisión', () => {
  const modal = read('../../src/components/comprobantes/ComprobanteProModal.tsx')
  const idx = modal.indexOf('if (result.idempotencyConflict)')
  assert.ok(idx >= 0)
  const block = modal.slice(idx, idx + 700)
  assert.match(block, /clearPendingCheckout\(businessId\)/)
  assert.match(block, /La operación cambió/)
  assert.doesNotMatch(block, /getOrCreateIdempotencyKey/, 'el manejo del conflicto no debe generar una key nueva por sí mismo')
})

// ─── Migración: grants explícitos, nunca solo REVOKE ALL FROM PUBLIC ───────

test('migración de checkout: revoca EXECUTE de anon explícitamente en las 2 RPCs nuevas (no solo REVOKE ALL FROM PUBLIC)', () => {
  const migration = read('../../supabase/migrations/20260701170000_comprobante_checkout_idempotency.sql')
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION "public"\."create_comprobante_checkout_atomic"\(uuid, text, text, jsonb\) FROM "anon";/)
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION "public"\."get_checkout_request_status"\(uuid, text\) FROM "anon";/)
})

test('migración de checkout: UNIQUE(business_id, idempotency_key) es el lock atómico real', () => {
  const migration = read('../../supabase/migrations/20260701170000_comprobante_checkout_idempotency.sql')
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "idx_checkout_requests_business_key"\s*\n\s*ON "public"\."comprobante_checkout_requests" \("business_id", "idempotency_key"\);/)
})

test('migración de checkout: ARCA nunca se llama dentro de la RPC atómica (no hay fetch/http, ni RPC de claim ARCA)', () => {
  const migration = read('../../supabase/migrations/20260701170000_comprobante_checkout_idempotency.sql')
  const fnStart = migration.indexOf('CREATE OR REPLACE FUNCTION "public"."create_comprobante_checkout_atomic"')
  const fnEnd = migration.indexOf('ALTER FUNCTION "public"."create_comprobante_checkout_atomic"', fnStart)
  const body = migration.slice(fnStart, fnEnd)
  assert.doesNotMatch(body, /claim_comprobante_arca_emission/)
  assert.doesNotMatch(body, /arca_emission_attempts/)
})

test('migración de checkout: la falla dentro del bloque de trabajo se marca failed_retryable, nunca deja el request "completed" a medias', () => {
  const migration = read('../../supabase/migrations/20260701170000_comprobante_checkout_idempotency.sql')
  assert.match(migration, /EXCEPTION WHEN OTHERS THEN/)
  assert.match(migration, /SET status = 'failed_retryable', last_error_code = SQLSTATE, last_error_message = SQLERRM/)
})

test('migración de checkout: pending_reconciliation / Nota de Crédito no se mezclan con este mecanismo (tablas y RPCs separadas)', () => {
  const migration = read('../../supabase/migrations/20260701170000_comprobante_checkout_idempotency.sql')
  assert.doesNotMatch(migration, /create_credit_note_from_comprobante/, 'la idempotencia de checkout no debe tocar el flujo de Nota de Crédito')
  // comprobante_checkout_requests.status es una máquina de estado propia
  // (comercial), separada de comprobantes.estado_fiscal (fiscal/ARCA) — el
  // CHECK constraint de status nunca debe mezclar valores fiscales.
  const checkMatch = migration.match(/"status"\s+text NOT NULL DEFAULT 'processing' CHECK \("status" IN \(([\s\S]*?)\)\)/)
  assert.ok(checkMatch, 'debe existir el CHECK constraint de status en comprobante_checkout_requests')
  const allowedValues = checkMatch![1]
  for (const fiscalValue of ['pendiente_emision', 'pendiente_conciliacion', 'emitido', 'error_emision', 'anulado_fiscal']) {
    assert.doesNotMatch(allowedValues, new RegExp(fiscalValue), `el status del checkout NO debe incluir el valor fiscal "${fiscalValue}"`)
  }
})

// ─── Fase 7: auditoría de entry points ─────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vercel', '_legacy'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = `${dir}/${entry}`
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

test('saleTransactionService permanece NO importado — es código muerto confirmado por grep en toda la base', () => {
  const files = walk(`${REPO_ROOT}src`).concat(walk(`${REPO_ROOT}tests`))
  const importers: string[] = []
  for (const f of files) {
    // el propio archivo se referencia a sí mismo en comentarios, y este test
    // (checkoutIdempotency.test.ts) menciona los nombres a propósito para auditarlos.
    if (f.endsWith('saleTransactionService.ts') || f.endsWith('checkoutIdempotency.test.ts')) continue
    const content = readFileSync(f, 'utf-8')
    if (content.includes('saleTransactionService') || content.includes('processSaleTransaction')) {
      importers.push(f)
    }
  }
  assert.deepEqual(importers, [],
    'Si este test falla, alguien volvió a importar saleTransactionService.ts SIN wirearlo con ' +
    'idempotencia server-side (useCheckoutIdempotency) — antes de reintroducirlo, agregar el mismo ' +
    'resolveIdempotencyKey/clearPending que tienen ComprobanteProModal y ModalCobro.')
})

test('ModalCobro usa useCheckoutIdempotency (entry point productivo — Mayorista.tsx/OrderDetail.tsx)', () => {
  const modal = read('../../src/components/cobro/ModalCobro.tsx')
  assert.match(modal, /import \{ useCheckoutIdempotency \} from '\.\.\/\.\.\/hooks\/useCheckoutIdempotency'/)
  assert.match(modal, /resolveIdempotencyKey\(\{/)
  assert.match(modal, /idempotency_key:\s*idempotencyKey/)
  assert.match(modal, /clearPending\(\)/)
})

// M7 7D.3 — CORRECCION DE UN TEST QUE MENTIA.
//
// Este bloque afirmaba que ModalCrearComprobante.tsx era "entry point
// productivo — Comprobantes.tsx". No lo es, y no lo era: Comprobantes.tsx,
// Mayorista.tsx y OrderDetail.tsx importan ComprobanteProModal y le ponen el
// ALIAS `ModalCrearComprobante`. El alias hacía que el archivo pareciera vivo.
//
// ModalCrearComprobante.tsx sólo se referencia desde el barrel
// components/comprobantes/index.ts, y NADIE importa ese barrel. O sea: el test
// verificaba idempotencia sobre código inalcanzable y daba verde. Una garantía
// falsa es peor que ninguna, porque nadie va a mirar dos veces.
//
// Los tests de abajo ahora apuntan a los entry points REALES.
test('ModalCrearComprobante.tsx NO es alcanzable: sólo lo re-exporta un barrel que nadie importa', () => {
  const barrel = read('../../src/components/comprobantes/index.ts')
  assert.match(barrel, /ModalCrearComprobante/,
    'si esto falla, el barrel ya no lo re-exporta: revisar si el archivo se puede borrar')

  // Los entry points reales importan ComprobanteProModal, con o sin alias.
  for (const f of ['../../src/pages/Comprobantes.tsx', '../../src/pages/Mayorista.tsx', '../../src/pages/OrderDetail.tsx']) {
    const content = read(f)
    assert.match(content, /from '\.\.\/components\/comprobantes\/ComprobanteProModal'/,
      `${f} debe importar el modal REAL (ComprobanteProModal), no el archivo muerto`)
    assert.doesNotMatch(content, /from '\.\.\/components\/comprobantes\/ModalCrearComprobante'/,
      `${f} NO debe importar ModalCrearComprobante.tsx: es código muerto`)
  }
})

test('los 2 entry points productivos REALES (ComprobanteProModal/ModalCobro) llaman a comprobanteService.crear() con idempotency_key — nunca sin ella', () => {
  const files = [
    '../../src/components/comprobantes/ComprobanteProModal.tsx',
    '../../src/components/cobro/ModalCobro.tsx',
  ]
  for (const f of files) {
    const content = read(f)
    assert.match(content, /comprobanteService\.crear\(/, `${f} debe llamar a comprobanteService.crear()`)
    assert.match(content, /idempotency_key/, `${f} debe pasar idempotency_key`)
  }
})
