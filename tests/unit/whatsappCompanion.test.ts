/**
 * Contrato del WhatsApp Companion — reglas puras.
 *
 * Runner: node:test nativo. Ejecutar: npm run test:unit
 *
 * El comportamiento real (adoptar/crear/reutilizar una pestaña) lo cubre
 * `tools/whatsapp-companion/probe.mjs` en un Chromium de verdad — eso NO se
 * reemplaza con mocks. Acá se fijan las reglas de validación y de elección,
 * que son las que deciden si la extensión es segura.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  VERSION,
  MAX_TEXTO,
  ORIGENES_AUTORIZADOS,
  origenAutorizado,
  validarApertura,
  construirUrl,
  elegirPestana,
} from '../../tools/whatsapp-companion/lib/contract.js'

// ═══════════════════════════════════════════════════════════════════════
// ORIGEN
// ═══════════════════════════════════════════════════════════════════════

describe('origenAutorizado', () => {

  test('acepta los origins de producción', () => {
    for (const o of ORIGENES_AUTORIZADOS) {
      assert.equal(origenAutorizado({ origin: o }), true, o)
    }
  })

  test('los deriva de sender.url si no viene origin', () => {
    assert.equal(origenAutorizado({ url: 'https://www.techrepairpro.app/orders/1' }), true)
  })

  test('rechaza cualquier otro origin', () => {
    for (const o of [
      'https://evil.example',
      'https://techrepairpro.app.evil.example',
      'http://techrepairpro.app',          // http, no https
      'https://sub.techrepairpro.app',     // subdominio no listado
      'null',
    ]) assert.equal(origenAutorizado({ origin: o }), false, o)
  })

  test('NO autoriza origins de desarrollo', () => {
    for (const o of ['http://localhost:4599', 'http://localhost', 'http://127.0.0.1:4599']) {
      assert.equal(origenAutorizado({ origin: o }), false, o)
    }
  })

  test('fail-closed ante un sender roto', () => {
    for (const s of [null, undefined, {}, { url: 'no-es-una-url' }, 'string', 42]) {
      assert.equal(origenAutorizado(s as never), false)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// PAYLOAD
// ═══════════════════════════════════════════════════════════════════════

describe('validarApertura', () => {

  const ok = { type: 'OPEN_WHATSAPP_WEB', phone: '5493511234567', text: 'hola' }

  test('acepta un payload válido', () => {
    assert.equal(validarApertura(ok), null)
  })

  test('rechaza un type que no es el esperado', () => {
    assert.equal(validarApertura({ ...ok, type: 'DAME_LOS_CHATS' })?.code, 'UNKNOWN_TYPE')
    assert.equal(validarApertura({ ...ok, type: 'ping' })?.code, 'UNKNOWN_TYPE')
  })

  test('rechaza teléfonos que no son sólo dígitos', () => {
    for (const p of [
      '+5493511234567', '549 351 1234567', '549-351-1234567',
      'javascript:alert(1)', '../../etc', '5493511234567/x', '', '   ',
    ]) assert.equal(validarApertura({ ...ok, phone: p })?.code, 'BAD_PHONE', p)
  })

  test('rechaza teléfonos fuera de rango E.164', () => {
    assert.equal(validarApertura({ ...ok, phone: '1234567' })?.code, 'BAD_PHONE')       // 7
    assert.equal(validarApertura({ ...ok, phone: '1'.repeat(16) })?.code, 'BAD_PHONE')  // 16
  })

  test('acepta los extremos válidos', () => {
    assert.equal(validarApertura({ ...ok, phone: '1'.repeat(8) }), null)
    assert.equal(validarApertura({ ...ok, phone: '1'.repeat(15) }), null)
  })

  test('rechaza texto vacío o no-string', () => {
    assert.equal(validarApertura({ ...ok, text: '' })?.code, 'BAD_TEXT')
    assert.equal(validarApertura({ ...ok, text: null })?.code, 'BAD_TEXT')
    assert.equal(validarApertura({ ...ok, text: 42 })?.code, 'BAD_TEXT')
  })

  test('rechaza texto por encima del límite', () => {
    assert.equal(validarApertura({ ...ok, text: 'x'.repeat(MAX_TEXTO) }), null)
    assert.equal(validarApertura({ ...ok, text: 'x'.repeat(MAX_TEXTO + 1) })?.code, 'TEXT_TOO_LONG')
  })

  test('rechaza payloads que no son objetos', () => {
    for (const m of [null, undefined, 'x', 42, []]) {
      const r = validarApertura(m as never)
      assert.ok(r?.code === 'BAD_PAYLOAD' || r?.code === 'UNKNOWN_TYPE')
    }
  })

  test('IGNORA campos extra: el destino no se negocia', () => {
    // Que el payload traiga `url` no lo hace inválido — simplemente no se usa.
    assert.equal(validarApertura({ ...ok, url: 'https://evil.example/x', hostname: 'evil' }), null)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// URL
// ═══════════════════════════════════════════════════════════════════════

describe('construirUrl', () => {

  test('siempre apunta a web.whatsapp.com/send', () => {
    const u = new URL(construirUrl('5493511234567', 'hola'))
    assert.equal(u.origin, 'https://web.whatsapp.com')
    assert.equal(u.pathname, '/send')
    assert.equal(u.searchParams.get('phone'), '5493511234567')
  })

  test('un solo encodeURIComponent: %0A y no %250A', () => {
    const u = construirUrl('5493511234567', 'a\nb 100%')
    assert.ok(u.includes('%0A'))
    assert.ok(!u.includes('%250A'))
    assert.ok(!u.includes('%2525'))
  })

  test('round-trip exacto del mensaje', () => {
    for (const msg of [
      'Hola José 👋\nTotal: $85.000',
      'Símbolos: & ? = # % + / \\ " \' < >',
      'Ñandú Ártico — María 🎉',
    ]) {
      const u = construirUrl('5493511234567', msg)
      assert.equal(decodeURIComponent(u.slice(u.indexOf('&text=') + 6)), msg)
    }
  })

  test('un texto malicioso no puede cambiar el destino', () => {
    // Ni con un & ni con un # se puede inyectar otro parámetro o fragmento
    // que mueva el host o el path.
    const u = new URL(construirUrl('5493511234567', '&phone=999#https://evil.example'))
    assert.equal(u.origin, 'https://web.whatsapp.com')
    assert.equal(u.pathname, '/send')
    assert.equal(u.searchParams.get('phone'), '5493511234567')
    assert.equal(u.hash, '')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// ELECCIÓN DE PESTAÑA
// ═══════════════════════════════════════════════════════════════════════

describe('elegirPestana', () => {

  test('sin pestañas devuelve null', () => {
    assert.equal(elegirPestana([]), null)
    assert.equal(elegirPestana(undefined as never), null)
  })

  test('con una sola, ésa', () => {
    assert.equal(elegirPestana([{ id: 7 }])?.id, 7)
  })

  test('1º criterio: la ACTIVA gana', () => {
    const r = elegirPestana([
      { id: 1, lastAccessed: 999 },
      { id: 2, active: true, lastAccessed: 1 },
    ])
    assert.equal(r?.id, 2, 'la activa gana aunque otra sea más reciente')
  })

  test('2º criterio: la más recientemente usada', () => {
    const r = elegirPestana([
      { id: 1, lastAccessed: 100 },
      { id: 2, lastAccessed: 300 },
      { id: 3, lastAccessed: 200 },
    ])
    assert.equal(r?.id, 2)
  })

  test('3º criterio: fallback estable por (windowId, index)', () => {
    const r = elegirPestana([
      { id: 1, windowId: 5, index: 2 },
      { id: 2, windowId: 3, index: 9 },
      { id: 3, windowId: 3, index: 1 },
    ])
    assert.equal(r?.id, 3, 'menor windowId, y dentro de ésa menor index')
  })

  test('es DETERMINISTA: el mismo set da siempre lo mismo', () => {
    const tabs = [
      { id: 1, windowId: 2, index: 4 },
      { id: 2, windowId: 1, index: 7 },
      { id: 3, windowId: 1, index: 3 },
    ]
    const primero = elegirPestana(tabs)?.id
    for (let i = 0; i < 25; i++) assert.equal(elegirPestana([...tabs])?.id, primero)
  })

  test('no muta el array recibido', () => {
    const tabs = [{ id: 1, windowId: 9, index: 1 }, { id: 2, windowId: 1, index: 1 }]
    const copia = JSON.stringify(tabs)
    elegirPestana(tabs)
    assert.equal(JSON.stringify(tabs), copia)
  })
})

describe('metadatos', () => {
  test('la versión está declarada', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/)
  })
})
