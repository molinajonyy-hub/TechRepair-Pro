/**
 * W1 — renderer de plantillas, handoff wa.me y semántica de estado.
 *
 * Runner: node:test nativo (igual que whatsappFormat.test.ts).
 * Ejecutar: npm run test:unit
 *
 * Todo lo de acá es PURO: no toca Supabase, no toca el DOM, no mira el reloj.
 * Números y datos ficticios.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  WHATSAPP_VARIABLES,
  WHATSAPP_VARIABLE_KEYS,
  isWhatsAppVariable,
  renderTemplate,
  findUnresolvedPlaceholders,
  motivoDeBloqueo,
  resolveWhatsAppValues,
  formatImporteWhatsApp,
} from '../../src/services/whatsappTemplate.ts'
import {
  buildWaMeUrl,
  buildWebSendUrl,
  buildHandoffUrl,
  buildAppUrl,
  abrirWhatsAppMovil,
  abrirAppDeEscritorio,
  abrirWhatsAppWebEnNuevaPestana,
  EVENTO_APERTURA,
} from '../../src/services/whatsappHandoff.ts'
import { resolvePermissions } from '../../src/config/permissions.ts'

// ═══════════════════════════════════════════════════════════════════════
// 1 · RENDERER
// ═══════════════════════════════════════════════════════════════════════

describe('renderTemplate — allowlist', () => {

  test('reemplaza todas las variables válidas', () => {
    const r = renderTemplate(
      'Hola {nombre}, tu {equipo} (orden #{numero_orden}) está {estado}.',
      { nombre: 'Ana', equipo: 'Galaxy A54', numero_orden: 'A1B2C3D4', estado: 'listo' },
    )
    assert.equal(r.text, 'Hola Ana, tu Galaxy A54 (orden #A1B2C3D4) está listo.')
    assert.deepEqual(r.faltantes, [])
    assert.deepEqual(r.desconocidas, [])
    assert.deepEqual(r.resueltas.sort(), ['equipo', 'estado', 'nombre', 'numero_orden'])
  })

  test('variable DESCONOCIDA: queda literal y se reporta (no se inventa un valor)', () => {
    const r = renderTemplate('Hola {nombre}, {saldo_total_inventado}', { nombre: 'Ana' })
    assert.equal(r.text, 'Hola Ana, {saldo_total_inventado}')
    assert.deepEqual(r.desconocidas, ['saldo_total_inventado'])
    assert.equal(r.usadas.includes('saldo_total_inventado'), false)
  })

  test('una variable desconocida NO puede abrir WhatsApp', () => {
    const r = renderTemplate('Hola {desconocido}', {})
    const motivo = motivoDeBloqueo(r.text)
    assert.ok(motivo, 'debe bloquear')
    assert.match(motivo!, /no existe/i)
    assert.match(motivo!, /\{desconocido\}/)
  })

  test('variable FALTANTE de nivel dato: queda literal, se nombra y bloquea', () => {
    const r = renderTemplate('Tenés un saldo pendiente de {saldo}.', {})
    assert.equal(r.text, 'Tenés un saldo pendiente de {saldo}.')
    assert.deepEqual(r.faltantes, ['saldo'])

    const motivo = motivoDeBloqueo(r.text)
    assert.ok(motivo)
    assert.match(motivo!, /Saldo pendiente/)
    // Nunca se manda el hueco silencioso que producía interpolateTemplate.
    assert.notEqual(r.text, 'Tenés un saldo pendiente de .')
  })

  test('variable FALTANTE de nivel perfil: colapsa a vacío y NO bloquea', () => {
    const r = renderTemplate('Pasá por {local}. Horario: {horario}', { local: 'TechRepair' })
    assert.equal(r.text, 'Pasá por TechRepair. Horario: ')
    assert.deepEqual(r.incompletas, ['horario'])
    assert.deepEqual(r.faltantes, [])
    assert.equal(motivoDeBloqueo(r.text), null)
  })

  test('un valor vacío o de puros espacios cuenta como faltante', () => {
    assert.deepEqual(renderTemplate('{saldo}', { saldo: '' }).faltantes, ['saldo'])
    assert.deepEqual(renderTemplate('{saldo}', { saldo: '   ' }).faltantes, ['saldo'])
    assert.deepEqual(renderTemplate('{saldo}', { saldo: undefined }).faltantes, ['saldo'])
    assert.deepEqual(renderTemplate('{saldo}', { saldo: null }).faltantes, ['saldo'])
  })

  test('nunca emite "undefined", "null" ni "NaN"', () => {
    const r = renderTemplate('{nombre} {saldo} {horario}', { nombre: undefined, saldo: null })
    assert.ok(!/undefined|null|NaN/.test(r.text), `salió: ${r.text}`)
  })

  test('preserva saltos de línea del template Y de los valores', () => {
    const r = renderTemplate('Hola {nombre}\nSegunda línea\n\nTercera', { nombre: 'Ana\nGómez' })
    assert.equal(r.text, 'Hola Ana\nGómez\nSegunda línea\n\nTercera')
    assert.equal((r.text.match(/\n/g) ?? []).length, 4)
  })

  test('tildes, ñ y mayúsculas acentuadas intactas', () => {
    const r = renderTemplate('Garantía de {equipo} — atención en {local}', {
      equipo: 'Ñandú Ártico', local: 'Córdoba Íñigo',
    })
    assert.equal(r.text, 'Garantía de Ñandú Ártico — atención en Córdoba Íñigo')
  })

  test('emojis (incluidos los de pares subrogados) sobreviven', () => {
    const r = renderTemplate('Hola {nombre} 👋🏽 tu equipo está listo 🎉', { nombre: 'Ana👩‍💻' })
    assert.equal(r.text, 'Hola Ana👩‍💻 👋🏽 tu equipo está listo 🎉')
  })

  test('caracteres especiales & ? = # no se rompen', () => {
    const r = renderTemplate('Ver {equipo}', { equipo: 'A&B ?x=1#frag' })
    assert.equal(r.text, 'Ver A&B ?x=1#frag')
  })

  test('el $ de un importe no se interpreta como patrón de replace', () => {
    // $& insertaría el match completo si se usara un string de reemplazo.
    const r = renderTemplate('Total: {precio}', { precio: '$1.234' })
    assert.equal(r.text, 'Total: $1.234')

    const r2 = renderTemplate('Total: {precio}', { precio: '$& $1 $$' })
    assert.equal(r2.text, 'Total: $& $1 $$')
  })

  test('SEGURIDAD: un valor que contiene otra variable NO se re-expande', () => {
    // Template injection: con reemplazo en bucle, {precio} dentro del nombre
    // lo expandía la iteración siguiente.
    const r = renderTemplate('Hola {nombre}. Total {precio}', {
      nombre: 'Ana {precio}', precio: '$99.999',
    })
    assert.equal(r.text, 'Hola Ana {precio}. Total $99.999')
    assert.ok(!r.text.startsWith('Hola Ana $99.999'), 'no debe expandir el valor inyectado')
  })

  test('SEGURIDAD: no ejecuta HTML ni JS — el texto se copia literal', () => {
    const payload = '<script>alert(1)</script><img src=x onerror=alert(1)>'
    const r = renderTemplate('Hola {nombre}', { nombre: payload })
    assert.equal(r.text, `Hola ${payload}`)
  })

  test('SEGURIDAD: claves de prototipo no resuelven a nada del Object.prototype', () => {
    // No están en la allowlist ⇒ desconocidas, nunca "function Object()".
    const r = renderTemplate('{__proto__} {constructor} {toString}', {})
    assert.deepEqual(r.desconocidas, ['__proto__', 'constructor', 'toString'])
    assert.equal(r.text, '{__proto__} {constructor} {toString}')
  })

  test('lo que no matchea la sintaxis de placeholder se deja tal cual', () => {
    const t = 'Llaves { sueltas } y {con espacios} y {} y {1numero}'
    const r = renderTemplate(t, {})
    assert.equal(r.text, t)
    assert.deepEqual(r.desconocidas, [])
  })

  test('la misma variable repetida se reemplaza en todas sus apariciones', () => {
    const r = renderTemplate('{nombre}, {nombre} y {nombre}', { nombre: 'Ana' })
    assert.equal(r.text, 'Ana, Ana y Ana')
    assert.deepEqual(r.resueltas, ['nombre'])
  })

  test('template vacío o sin variables no rompe', () => {
    assert.equal(renderTemplate('', {}).text, '')
    assert.equal(renderTemplate('Hola, todo bien.', {}).text, 'Hola, todo bien.')
  })

  test('renderTemplate es determinista: dos corridas iguales dan lo mismo', () => {
    const args: [string, Record<string, string>] = ['Hola {nombre} {fecha}', { nombre: 'Ana', fecha: '19/08/2026' }]
    assert.equal(renderTemplate(...args).text, renderTemplate(...args).text)
  })
})

describe('allowlist — integridad', () => {

  test('no hay claves duplicadas', () => {
    assert.equal(new Set(WHATSAPP_VARIABLE_KEYS).size, WHATSAPP_VARIABLE_KEYS.length)
  })

  test('isWhatsAppVariable es fail-closed', () => {
    assert.equal(isWhatsAppVariable('nombre'), true)
    assert.equal(isWhatsAppVariable('saldo'), true)
    assert.equal(isWhatsAppVariable('cualquier_cosa'), false)
    assert.equal(isWhatsAppVariable('__proto__'), false)
    assert.equal(isWhatsAppVariable(''), false)
  })

  test('toda variable declara label y ejemplo no vacíos', () => {
    for (const v of WHATSAPP_VARIABLES) {
      assert.ok(v.label.trim(), `${v.key} sin label`)
      assert.ok(v.ejemplo.trim(), `${v.key} sin ejemplo`)
      assert.ok(['dato', 'perfil'].includes(v.level), `${v.key} con nivel inválido`)
    }
  })

  test('los importes son de nivel "dato": un hueco de plata SIEMPRE bloquea', () => {
    for (const key of ['precio', 'saldo', 'anticipo', 'presupuesto']) {
      const spec = WHATSAPP_VARIABLES.find(v => v.key === key)
      assert.equal(spec?.level, 'dato', `${key} debería bloquear si falta`)
    }
  })
})

describe('findUnresolvedPlaceholders', () => {

  test('clasifica faltantes vs desconocidas y no repite', () => {
    const p = findUnresolvedPlaceholders('{saldo} {saldo} {inventada}')
    assert.equal(p.length, 2)
    assert.equal(p.find(x => x.key === 'saldo')?.motivo, 'faltante')
    assert.equal(p.find(x => x.key === 'inventada')?.motivo, 'desconocida')
  })

  test('un mensaje ya resuelto no reporta nada', () => {
    assert.deepEqual(findUnresolvedPlaceholders('Hola Ana, tu equipo está listo.'), [])
    assert.equal(motivoDeBloqueo('Hola Ana, tu equipo está listo.'), null)
  })

  test('valida el texto EDITADO A MANO, no sólo el de la plantilla', () => {
    // El usuario tipea un placeholder en el textarea: también debe bloquear.
    assert.ok(motivoDeBloqueo('Hola Ana, te debo {plata}'))
  })
})

describe('resolveWhatsAppValues — alias', () => {

  test('cliente cae a nombre; negocio y local se espejan', () => {
    const v = resolveWhatsAppValues({ nombre: 'Ana', local: 'TechRepair' })
    assert.equal(v.cliente, 'Ana')
    assert.equal(v.negocio, 'TechRepair')
    assert.equal(v.local, 'TechRepair')
  })

  test('whatsapp y telefono se espejan en ambos sentidos', () => {
    assert.equal(resolveWhatsAppValues({ telefono: '351 1234567' }).whatsapp, '351 1234567')
    assert.equal(resolveWhatsAppValues({ whatsapp: '351 7654321' }).telefono, '351 7654321')
  })

  test('presupuesto cae a precio', () => {
    assert.equal(resolveWhatsAppValues({ precio: '$85.000' }).presupuesto, '$85.000')
  })

  test('el valor explícito gana sobre el alias', () => {
    const v = resolveWhatsAppValues({ nombre: 'Ana', cliente: 'Ana Gómez' })
    assert.equal(v.cliente, 'Ana Gómez')
  })

  test('devuelve TODAS las claves de la allowlist (nunca undefined)', () => {
    const v = resolveWhatsAppValues({})
    for (const k of WHATSAPP_VARIABLE_KEYS) assert.equal(typeof v[k], 'string')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 8 · VALORES ECONÓMICOS
// ═══════════════════════════════════════════════════════════════════════

describe('formatImporteWhatsApp', () => {

  test('formatea un importe real', () => {
    assert.equal(formatImporteWhatsApp(85000), '$85.000')
    assert.equal(formatImporteWhatsApp(1234.56), '$1.235')
  })

  test('nunca produce "$NaN", "undefined" ni "—"', () => {
    for (const v of [NaN, Infinity, -Infinity, null, undefined, 'x', {}]) {
      assert.equal(formatImporteWhatsApp(v), '', `falló con ${String(v)}`)
    }
  })

  test('un importe no numérico se vuelve variable faltante y bloquea', () => {
    const r = renderTemplate('Total: {precio}', { precio: formatImporteWhatsApp(undefined) })
    assert.deepEqual(r.faltantes, ['precio'])
    assert.ok(motivoDeBloqueo(r.text))
  })

  test('el cero se formatea, no se descarta', () => {
    assert.equal(formatImporteWhatsApp(0), '$0')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2 y 3 · URL wa.me Y TELÉFONO
// ═══════════════════════════════════════════════════════════════════════

describe('buildWaMeUrl', () => {

  test('arma wa.me con el teléfono normalizado', () => {
    const r = buildWaMeUrl('0351 15 1234567', 'hola')
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.url, 'https://wa.me/5493511234567?text=hola')
    assert.equal(r.ok && r.telefono, '5493511234567')
  })

  test('respeta un internacional NO argentino', () => {
    const r = buildWaMeUrl('+1 415 555 2671', 'hi')
    assert.equal(r.ok && r.url, 'https://wa.me/14155552671?text=hi')
  })

  test('codifica saltos de línea, tildes, emojis y & ? = #', () => {
    const msg = 'Hola José 👋\nTotal: $1.234\nVer: https://x.com/a?b=1&c=2#top'
    const r = buildWaMeUrl('3511234567', msg)
    assert.equal(r.ok, true)
    const url = (r as { url: string }).url
    assert.ok(url.includes('%0A'), 'el salto de línea debe ir como %0A')
    assert.ok(!url.includes('\n'), 'no puede haber saltos crudos en la URL')
    assert.ok(url.includes('%26'), '& debe codificarse')
    assert.ok(url.includes('%23'), '# debe codificarse')
  })

  test('SIN doble encoding: %0A no se convierte en %250A', () => {
    const r = buildWaMeUrl('3511234567', 'a\nb 100%')
    const url = (r as { url: string }).url
    assert.ok(!url.includes('%250A'), 'doble encoding del salto de línea')
    assert.ok(!url.includes('%2525'), 'doble encoding del porcentaje')
    assert.equal(url, 'https://wa.me/5493511234567?text=' + encodeURIComponent('a\nb 100%'))
  })

  test('TELÉFONO INVÁLIDO: no devuelve URL y explica por qué', () => {
    for (const malo of ['', null, undefined, '351 123', 'no-es-un-numero']) {
      const r = buildWaMeUrl(malo as string | null | undefined, 'hola')
      assert.equal(r.ok, false, `debería fallar con ${String(malo)}`)
      assert.ok(!('url' in r), 'no puede exponer una URL rota')
      assert.ok((r as { error: string }).error.trim().length > 0, 'el error debe ser accionable')
    }
  })

  test('mensaje vacío tampoco produce URL', () => {
    const r = buildWaMeUrl('3511234567', '   ')
    assert.equal(r.ok, false)
  })

  test('nunca arma el wa.me sin destinatario (https://wa.me/?text=…)', () => {
    const r = buildWaMeUrl('', 'hola')
    assert.equal(r.ok, false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// HANDOFF POR PLATAFORMA · desktop sin pantalla intermedia
// ═══════════════════════════════════════════════════════════════════════

describe('buildHandoffUrl — desktop vs móvil', () => {

  const MSG = 'Hola Ana 👋\nTotal: $85.000'

  test('DESKTOP va directo a web.whatsapp.com/send', () => {
    const r = buildHandoffUrl('0351 15 1234567', MSG, false)
    assert.equal(r.ok, true)
    const url = (r as { url: string }).url
    assert.ok(url.startsWith('https://web.whatsapp.com/send?phone=5493511234567&text='), url)
  })

  test('DESKTOP nunca usa api.whatsapp.com (la pantalla intermedia)', () => {
    const url = (buildHandoffUrl('3511234567', MSG, false) as { url: string }).url
    assert.ok(!url.includes('api.whatsapp.com'),
      'api.whatsapp.com obliga a "Continuar en WhatsApp Web" y estrena pestaña')
  })

  test('DESKTOP tampoco usa wa.me, que redirige a esa pantalla', () => {
    const url = (buildHandoffUrl('3511234567', MSG, false) as { url: string }).url
    assert.ok(!url.includes('wa.me'), url)
  })

  test('MÓVIL sigue en wa.me, que deja abrir la app nativa', () => {
    const r = buildHandoffUrl('0351 15 1234567', MSG, true)
    const url = (r as { url: string }).url
    assert.ok(url.startsWith('https://wa.me/5493511234567?text='), url)
    assert.ok(!url.includes('web.whatsapp.com'), 'en un teléfono, WhatsApp Web es peor que la app')
  })

  test('las dos ramas fallan cerrado con teléfono inválido', () => {
    for (const esMobile of [true, false]) {
      const r = buildHandoffUrl('351 123', MSG, esMobile)
      assert.equal(r.ok, false, `esMobile=${esMobile}`)
      assert.ok(!('url' in r))
    }
  })

  test('las dos ramas codifican igual, una sola vez', () => {
    const esperado = encodeURIComponent(MSG)
    assert.ok((buildHandoffUrl('3511234567', MSG, false) as { url: string }).url.endsWith(esperado))
    assert.ok((buildHandoffUrl('3511234567', MSG, true)  as { url: string }).url.endsWith(esperado))
  })

  test('sin doble encoding en desktop: %0A, no %250A', () => {
    const url = (buildWebSendUrl('3511234567', 'a\nb 100%') as { url: string }).url
    assert.ok(url.includes('%0A'))
    assert.ok(!url.includes('%250A'))
    assert.ok(!url.includes('%2525'))
  })

  test('el teléfono va en el parámetro phone, en dígitos', () => {
    const url = (buildWebSendUrl('+54 9 351 1234567', 'hola') as { url: string }).url
    assert.ok(url.includes('phone=5493511234567'), url)
  })
})

/**
 * HANDOFF DETERMINISTA · sin reutilización de pestaña.
 *
 * El diseño anterior guardaba un `WindowProxy` y lo re-navegaba. Se midió en
 * Chromium real que eso NO puede funcionar contra WhatsApp: `web.whatsapp.com`
 * manda `Cross-Origin-Opener-Policy: same-origin`, así que al navegar hacia
 * allá el proxy queda severed y `closed` pasa a `true` con la pestaña abierta.
 * Fallan las tres vías (referencia con opener anulado, con opener conservado,
 * y target por nombre); los mismos escenarios contra un destino SIN COOP sí
 * reutilizan.
 *
 * Por eso acá NO se testea reutilización: se testea que cada camino sea
 * determinista y no cree pestañas de más.
 */
describe('handoff · caminos deterministas', () => {

  const MSG = 'Hola Ana 👋\nTotal: $85.000'

  test('DESKTOP · el fallback Web abre una pestaña NUEVA, con _blank explícito', () => {
    const llamadas: Array<[string, string]> = []
    const url = (buildWebSendUrl('0351 15 1234567', MSG) as { url: string }).url

    const r = abrirWhatsAppWebEnNuevaPestana(url, (u, t) => {
      llamadas.push([u, t]); return {} as Window
    })

    assert.equal(r.abierto, true)
    assert.deepEqual(llamadas, [[url, '_blank']])
  })

  test('DESKTOP · el fallback NO navega la pestaña de TechRepair', () => {
    // El contrato cambió respecto de PR #55: navegar la pestaña actual sacaba
    // al usuario de su trabajo y el Back devolvía a una SPA recargada. Con el
    // Companion resolviendo el caso bueno, el fallback puede ser honesto.
    let navegoLaActual = false
    const url = (buildWebSendUrl('3511234567', 'uno') as { url: string }).url

    abrirWhatsAppWebEnNuevaPestana(url, (_u, t) => {
      if (t !== '_blank') navegoLaActual = true
      return {} as Window
    })

    assert.equal(navegoLaActual, false)
  })

  test('DESKTOP · popup bloqueado en el fallback ⇒ error accionable', () => {
    const r = abrirWhatsAppWebEnNuevaPestana('https://web.whatsapp.com/send?phone=1', () => null)
    assert.equal(r.abierto, false)
    assert.match((r as { error: string }).error, /ventana|emergente/i)
  })

  test('DESKTOP · app de escritorio usa whatsapp:// y no abre pestaña', () => {
    const navegadas: string[] = []
    const r = buildAppUrl('0351 15 1234567', MSG)
    assert.equal(r.ok, true)
    const url = (r as { url: string }).url

    assert.ok(url.startsWith('whatsapp://send?phone=5493511234567&text='), url)
    assert.ok(!url.includes('web.whatsapp.com'))
    assert.ok(!url.includes('wa.me'))

    assert.equal(abrirAppDeEscritorio(url, (u) => navegadas.push(u)).abierto, true)
    assert.deepEqual(navegadas, [url])
  })

  test('MÓVIL · wa.me en pestaña nueva, con target _blank explícito', () => {
    const llamadas: { url: string; target: string }[] = []
    const url = (buildWaMeUrl('3511234567', MSG) as { url: string }).url

    const r = abrirWhatsAppMovil(url, (u, t) => { llamadas.push({ url: u, target: t }); return {} as Window })

    assert.equal(r.abierto, true)
    assert.equal(llamadas.length, 1)
    assert.equal(llamadas[0].url, url)
    // `_blank` a propósito: no se promete reutilizar ninguna pestaña.
    assert.equal(llamadas[0].target, '_blank')
  })

  test('MÓVIL · popup bloqueado ⇒ error accionable, no silencio', () => {
    const r = abrirWhatsAppMovil('https://wa.me/5493511234567?text=a', () => null)
    assert.equal(r.abierto, false)
    assert.match((r as { error: string }).error, /ventana|emergente/i)
  })

  test('los tres caminos consumen EXACTAMENTE el mismo mensaje', () => {
    const tel = '0351 15 1234567'
    const web = (buildWebSendUrl(tel, MSG) as { url: string }).url
    const app = (buildAppUrl(tel, MSG)     as { url: string }).url
    const mov = (buildWaMeUrl(tel, MSG)    as { url: string }).url

    const textoDe = (u: string, sep: string) => decodeURIComponent(u.slice(u.indexOf(sep) + sep.length))
    assert.equal(textoDe(web, '&text='), MSG)
    assert.equal(textoDe(app, '&text='), MSG)
    assert.equal(textoDe(mov, '?text='), MSG)
  })

  test('encoding: %0A en los tres, sin doble encoding', () => {
    for (const [nombre, r] of [
      ['web', buildWebSendUrl('3511234567', 'a\nb 100%')],
      ['app', buildAppUrl('3511234567', 'a\nb 100%')],
      ['mov', buildWaMeUrl('3511234567', 'a\nb 100%')],
    ] as const) {
      const u = (r as { url: string }).url
      assert.ok(u.includes('%0A'), `${nombre}: falta %0A`)
      assert.ok(!u.includes('%250A'), `${nombre}: doble encoding`)
      assert.ok(!u.includes('\n'), `${nombre}: salto crudo`)
    }
  })

  test('los tres fallan CERRADO con teléfono inválido', () => {
    for (const build of [buildWebSendUrl, buildAppUrl, buildWaMeUrl]) {
      const r = build('351 123', 'hola')
      assert.equal(r.ok, false)
      assert.ok(!('url' in r))
    }
  })

  test('ningún camino apunta a la pantalla intermedia api.whatsapp.com', () => {
    for (const build of [buildWebSendUrl, buildAppUrl, buildWaMeUrl]) {
      const u = (build('3511234567', 'hola') as { url: string }).url
      assert.ok(!u.includes('api.whatsapp.com'), u)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 6 · EL PREVIEW ES EXACTAMENTE LO QUE VA A WHATSAPP
// ═══════════════════════════════════════════════════════════════════════

describe('preview ≡ mensaje enviado a wa.me', () => {

  const casos = [
    'Hola Ana 👋\nTu Galaxy A54 ya está listo.\nTotal: $85.000',
    'Símbolos: & ? = # % + / \\ " \' < >',
    'Multi\n\nlínea\ttab',
    'Ñandú Ártico — José & María 🎉',
  ]

  for (const msg of casos) {
    test(`round-trip exacto: ${JSON.stringify(msg.slice(0, 28))}…`, () => {
      const r = buildWaMeUrl('3511234567', msg)
      assert.equal(r.ok, true)
      const url = (r as { url: string }).url
      const enviado = decodeURIComponent(url.split('?text=')[1])
      assert.equal(enviado, msg, 'lo que ve el usuario debe ser byte a byte lo que recibe WhatsApp')
    })
  }

  test('el mensaje renderizado viaja sin alterarse', () => {
    const render = renderTemplate(
      'Hola {nombre} 👋\nTu {equipo} está listo.\nSaldo: {saldo}',
      { nombre: 'José', equipo: 'Galaxy A54', saldo: '$45.000' },
    )
    const r = buildWaMeUrl('3511234567', render.text)
    const enviado = decodeURIComponent((r as { url: string }).url.split('?text=')[1])
    assert.equal(enviado, render.text)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 7 · ESTADO: prepared/opened, NUNCA sent/delivered/read
// ═══════════════════════════════════════════════════════════════════════

describe('semántica de estado', () => {

  /** Vocabulario que acepta el CHECK de whatsapp_logs.send_result en prod. */
  const VOCABULARIO_DB = ['opened', 'copied', 'failed', 'skipped', 'sent_api']

  test('el evento de apertura es "opened"', () => {
    assert.equal(EVENTO_APERTURA, 'opened')
  })

  test('"opened" pertenece al vocabulario que acepta la DB', () => {
    assert.ok(VOCABULARIO_DB.includes(EVENTO_APERTURA))
  })

  test('el handoff NO expone sent / delivered / read', () => {
    for (const prohibido of ['sent', 'delivered', 'read']) {
      assert.notEqual(EVENTO_APERTURA as string, prohibido)
      assert.equal(VOCABULARIO_DB.includes(prohibido), false)
    }
  })

  test('ya no existe promesa de reutilizar una pestaña con nombre estable', () => {
    // El módulo no exporta más `WHATSAPP_WINDOW_NAME` ni una fábrica de
    // handoff con referencia: WhatsApp Web no se puede reutilizar (COOP).
    assert.equal(typeof abrirWhatsAppMovil, 'function')
    assert.equal(typeof abrirWhatsAppWebEnNuevaPestana, 'function')
    assert.equal(typeof abrirAppDeEscritorio, 'function')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5 · RBAC — permiso de uso y permiso de edición
// ═══════════════════════════════════════════════════════════════════════

describe('RBAC canónico (config/permissions)', () => {

  test('EDICIÓN de plantillas: sólo owner y admin traen settings_sensitive', () => {
    assert.equal(resolvePermissions('owner').settings_sensitive, true)
    assert.equal(resolvePermissions('admin').settings_sensitive, true)
    for (const rol of ['manager', 'tech', 'sales', 'cashier', 'viewer']) {
      assert.equal(resolvePermissions(rol).settings_sensitive, false, `${rol} NO debe editar plantillas`)
    }
  })

  test('USO: seguir el permiso de órdenes, no un rol hardcodeado', () => {
    for (const rol of ['owner', 'admin', 'manager', 'tech', 'sales', 'cashier', 'viewer']) {
      assert.equal(resolvePermissions(rol).orders, true, `${rol} accede a la orden`)
    }
  })

  test('fail-closed: un rol desconocido cae a viewer, no a permisos abiertos', () => {
    const p = resolvePermissions('rol-inventado')
    assert.equal(p.settings_sensitive, false)
    assert.equal(p.settings, false)
  })

  test('un override no puede inventar un permiso fuera del catálogo', () => {
    const p = resolvePermissions('tech', { settings_sensitive: true })
    assert.equal(p.settings_sensitive, true)   // override explícito y sanitizado
    assert.equal(p.finance, false)             // lo no tocado sigue en el default del rol
  })
})
