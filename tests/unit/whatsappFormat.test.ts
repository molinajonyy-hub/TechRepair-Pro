/**
 * Tests unitarios de los helpers puros de WhatsApp (whatsappFormat).
 * Runner: node:test nativo (igual que productPricing.test.ts).
 * Ejecutar: npm run test:unit   (o: node --test tests/unit/)
 *
 * Cubre: normalización de teléfonos (AR + internacional), construcción de
 * links e interpolación de plantillas. Números ficticios.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeWhatsAppPhone,
  generateWhatsAppLink,
  buildWhatsAppWebUrl,
  buildWhatsAppDesktopUrl,
  buildWhatsAppUniversalUrl,
  interpolateTemplate,
} from '../../src/services/whatsappFormat.ts'

// ─── Normalización de teléfonos ──────────────────────────────────────────────

test('número local de Córdoba (10 díg) → 549 + 10', () => {
  const r = normalizeWhatsAppPhone('351 1234567')
  assert.equal(r.normalized, '5493511234567')
  assert.equal(r.valid, true)
})

test('Córdoba con 0 y 15 locales → quita ambos', () => {
  const r = normalizeWhatsAppPhone('0351 15 1234567')
  assert.equal(r.normalized, '5493511234567')
  assert.equal(r.valid, true)
})

test('Córdoba con 15 (sin 0) → quita 15', () => {
  const r = normalizeWhatsAppPhone('351 15 1234567')
  assert.equal(r.normalized, '5493511234567')
  assert.equal(r.valid, true)
})

test('formato internacional +54 9 → se respeta sin duplicar', () => {
  const r = normalizeWhatsAppPhone('+54 9 351 1234567')
  assert.equal(r.normalized, '5493511234567')
  assert.equal(r.valid, true)
})

test('número ya normalizado 549… → no cambia (sin doble 9)', () => {
  const r = normalizeWhatsAppPhone('5493511234567')
  assert.equal(r.normalized, '5493511234567')
  assert.equal(r.valid, true)
})

test('con guiones y paréntesis → mismo resultado', () => {
  const r = normalizeWhatsAppPhone('(0351) 15-123-4567')
  assert.equal(r.normalized, '5493511234567')
  assert.equal(r.valid, true)
})

test('evita doble 54 (54 + local de 10 díg)', () => {
  const r = normalizeWhatsAppPhone('54 351 1234567')
  assert.equal(r.normalized, '5493511234567')
  assert.equal(r.valid, true)
})

test('Buenos Aires con 0 y 15 (área de 2 díg)', () => {
  const r = normalizeWhatsAppPhone('011 15 2345-6789')
  assert.equal(r.normalized, '5491123456789')
  assert.equal(r.valid, true)
})

test('Buenos Aires ya normalizado no duplica el 9', () => {
  const r = normalizeWhatsAppPhone('5491123456789')
  assert.equal(r.normalized, '5491123456789')
  assert.equal(r.valid, true)
})

test('número vacío → inválido con motivo', () => {
  const r = normalizeWhatsAppPhone('')
  assert.equal(r.valid, false)
  assert.equal(r.normalized, '')
  assert.equal(r.error, 'Sin teléfono')
})

test('null/undefined → inválido (no rompe)', () => {
  assert.equal(normalizeWhatsAppPhone(null).valid, false)
  assert.equal(normalizeWhatsAppPhone(undefined).valid, false)
})

test('número incompleto → inválido', () => {
  const r = normalizeWhatsAppPhone('351 123')
  assert.equal(r.valid, false)
})

test('internacional NO argentino se preserva (no se le agrega 549)', () => {
  const r = normalizeWhatsAppPhone('+1 415 555 2671')
  assert.equal(r.normalized, '14155552671')
  assert.equal(r.valid, true)
  assert.ok(!r.normalized.startsWith('549'), 'no debe argentinizar un número de EE.UU.')
})

test('internacional con 00 (España) se preserva', () => {
  const r = normalizeWhatsAppPhone('0034 600 123 456')
  assert.equal(r.normalized, '34600123456')
  assert.equal(r.valid, true)
})

// ─── Construcción de links ───────────────────────────────────────────────────

test('generateWhatsAppLink arma wa.me con número normalizado', () => {
  const link = generateWhatsAppLink('0351 15 1234567', 'hola')
  assert.equal(link, 'https://wa.me/5493511234567?text=hola')
})

test('generateWhatsAppLink sin teléfono → wa.me sin número', () => {
  const link = generateWhatsAppLink('', 'hola mundo')
  assert.equal(link, 'https://wa.me/?text=hola%20mundo')
})

test('encodeURIComponent: saltos de línea, acentos, $ y URL', () => {
  const msg = 'Hola José 👋\nTotal: $1.234\nVer: https://x.com/a?b=1&c=2'
  const link = generateWhatsAppLink('3511234567', msg)
  assert.ok(link.includes(encodeURIComponent(msg)))
  assert.ok(link.includes('%0A'), 'el salto de línea debe codificarse')
  assert.ok(!link.includes('\n'), 'no debe haber saltos crudos en la URL')
})

test('buildWhatsAppWebUrl usa web.whatsapp.com', () => {
  const url = buildWhatsAppWebUrl('3511234567', 'hola')
  assert.ok(url.startsWith('https://web.whatsapp.com/send?phone=5493511234567'))
})

test('buildWhatsAppDesktopUrl usa protocolo whatsapp://', () => {
  const url = buildWhatsAppDesktopUrl('3511234567', 'hola')
  assert.ok(url.startsWith('whatsapp://send?phone=5493511234567'))
})

test('buildWhatsAppUniversalUrl sin número → wa.me genérico', () => {
  const url = buildWhatsAppUniversalUrl('', 'hola')
  assert.equal(url, 'https://wa.me/?text=hola')
})

// ─── Interpolación de plantillas ─────────────────────────────────────────────

test('interpola variables presentes', () => {
  const out = interpolateTemplate('Hola {nombre}, tu orden #{numero_orden}', {
    nombre: 'José', numero_orden: 'A1B2',
  })
  assert.equal(out, 'Hola José, tu orden #A1B2')
})

test('variables faltantes quedan vacías (no "undefined"/"null")', () => {
  const out = interpolateTemplate('Hola {nombre} {apellido}', {})
  assert.equal(out, 'Hola  ')
  assert.ok(!/undefined|null/.test(out))
})

test('importe con $ no se rompe por el reemplazo (función replacer)', () => {
  const out = interpolateTemplate('Total a pagar: {precio}', { precio: '$1.234' })
  assert.equal(out, 'Total a pagar: $1.234')
})

test('acentos y saltos de línea se conservan', () => {
  const out = interpolateTemplate('Garantía de {equipo}\nVálida', { equipo: 'iPhone 13' })
  assert.equal(out, 'Garantía de iPhone 13\nVálida')
})

test('cliente cae a nombre si no se pasa cliente', () => {
  const out = interpolateTemplate('{cliente}', { nombre: 'Ana' })
  assert.equal(out, 'Ana')
})

test('placeholder desconocido se deja literal (no rompe)', () => {
  const out = interpolateTemplate('Hola {desconocido}', { nombre: 'Ana' })
  assert.equal(out, 'Hola {desconocido}')
})
