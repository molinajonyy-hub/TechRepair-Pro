/**
 * Cliente del Companion — contrato TechRepair → extensión.
 *
 * Runner: node:test nativo. Ejecutar: npm run test:unit
 *
 * QUÉ SE TESTEA ACÁ Y QUÉ NO. Acá van las reglas del cliente: qué se manda,
 * cuándo se declara disponible, y que falle cerrado. El comportamiento REAL de
 * la extensión —adoptar, reutilizar y crear pestañas en Chrome— lo demuestra
 * `tools/whatsapp-companion/probe.mjs` en un Chromium de verdad, y NO se
 * reemplaza con mocks: un mock no tiene modelo de seguridad, así que validar
 * contra uno es justamente cómo se produce un falso positivo.
 *
 * Por eso el transporte es inyectable: se testea el contrato, no se simula
 * `chrome.tabs`.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPANION_TIPO_APERTURA,
  COMPANION_TIPO_PING,
  companionExtensionId,
  companionInstallUrl,
  consultarCompanion,
  abrirEnCompanion,
  type EnviarAlCompanion,
} from '../../src/services/whatsappCompanion.ts'
import {
  normalizarExtensionId,
  normalizarInstallUrl,
} from '../../src/config/whatsappCompanionEnv.ts'

// ─── Cómo se inyecta ─────────────────────────────────────────────────────────
//
// `import.meta.env` pertenece a CADA módulo: escribirlo desde el test no toca
// el del módulo bajo prueba. Por eso el ID se inyecta por parámetro y la
// lectura de entorno se testea aparte, en las funciones puras que la validan.

const ID_VALIDO = 'abcdefghijklmnopabcdefghijklmnop'

/** Transporte falso: registra lo enviado y devuelve lo que se le indique. */
function espia(respuesta: unknown | null) {
  const enviados: Array<{ id: string; mensaje: unknown }> = []
  const enviar: EnviarAlCompanion = async (id, mensaje) => {
    enviados.push({ id, mensaje })
    return respuesta
  }
  return { enviar, enviados }
}

/** Opciones con Companion configurado. */
const con = (respuesta: unknown | null) => {
  const { enviar, enviados } = espia(respuesta)
  return { opciones: { extensionId: ID_VALIDO, enviar }, enviados }
}

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN · fail-closed
// ═══════════════════════════════════════════════════════════════════════

describe('configuración del Companion', () => {

  test('un ID con la forma correcta se acepta', () => {
    assert.equal(normalizarExtensionId(ID_VALIDO), ID_VALIDO)
    assert.equal(normalizarExtensionId(`  ${ID_VALIDO}  `), ID_VALIDO)
  })

  test('un ID con forma inválida se descarta, no se usa a medias', () => {
    // Los IDs de Chrome son 32 caracteres en [a-p]. Mandarle mensajes a un
    // valor de configuración roto es la forma silenciosa de "no funciona".
    for (const malo of [
      'abc',                                   // corto
      ID_VALIDO + 'a',                         // largo
      'abcdefghijklmnopabcdefghijklmnoz',      // 'z' fuera de a-p
      'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP',      // mayúsculas
      '   ', '', null, undefined, 42,
    ]) {
      assert.equal(normalizarExtensionId(malo as never), null, String(malo))
    }
  })

  test('la URL de instalación exige https', () => {
    assert.ok(normalizarInstallUrl('https://chromewebstore.google.com/detail/x')?.startsWith('https://'))

    for (const mala of [
      'http://inseguro.example/x',   // sin TLS
      'javascript:alert(1)',         // no puede terminar en un href
      'chrome://extensions',
      'no-es-url', '', '   ', null, undefined,
    ]) {
      assert.equal(normalizarInstallUrl(mala as never), null, String(mala))
    }
  })

  test('sin entorno configurado, ambas quedan en null (fail-closed)', () => {
    // Bajo node:test no hay `import.meta.env`, que es exactamente el caso
    // "variable sin setear": la app tiene que comportarse como si no hubiera
    // Companion, no romperse.
    assert.equal(companionExtensionId(), null)
    assert.equal(companionInstallUrl(), null)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// A · Companion PING disponible
// ═══════════════════════════════════════════════════════════════════════

describe('A · descubrimiento con el Companion presente', () => {

  test('si responde ok, está disponible y se conoce la versión', async () => {
    const { opciones, enviados } = con({ ok: true, version: '1.0.0' })

    const r = await consultarCompanion(opciones)

    assert.deepEqual(r, { disponible: true, version: '1.0.0' })
    assert.equal(enviados.length, 1)
    assert.equal(enviados[0].id, ID_VALIDO)
    assert.deepEqual(enviados[0].mensaje, { type: COMPANION_TIPO_PING })
  })

  test('el PING no lleva teléfono ni mensaje', async () => {
    const { opciones, enviados } = con({ ok: true, version: '1.0.0' })
    await consultarCompanion(opciones)

    assert.deepEqual(Object.keys(enviados[0].mensaje as object), ['type'])
  })

  test('si contesta sin versión, sigue estando disponible', async () => {
    const r = await consultarCompanion(con({ ok: true }).opciones)
    assert.equal(r.disponible, true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// B · Companion ausente
// ═══════════════════════════════════════════════════════════════════════

describe('B · descubrimiento sin Companion', () => {

  test('sin ID configurado: no disponible, y NO se manda nada', async () => {
    const { enviar, enviados } = espia({ ok: true, version: '1.0.0' })

    const r = await consultarCompanion({ extensionId: null, enviar })

    assert.deepEqual(r, { disponible: false, motivo: 'sin_configurar' })
    assert.equal(enviados.length, 0, 'sin ID no hay a quién hablarle')
  })

  test('si nadie contesta: no disponible', async () => {
    const r = await consultarCompanion(con(null).opciones)
    assert.deepEqual(r, { disponible: false, motivo: 'sin_respuesta' })
  })

  test('una respuesta que no dice ok NO cuenta como disponible', async () => {
    for (const respuesta of [{}, { ok: false }, { ok: 'sí' }, 'pong', 0]) {
      const r = await consultarCompanion(con(respuesta).opciones)
      assert.equal(r.disponible, false, JSON.stringify(respuesta))
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// C/D · apertura: reused y created
// ═══════════════════════════════════════════════════════════════════════

describe('C/D · apertura exitosa', () => {

  test('C · reutilizó una pestaña existente', async () => {
    const r = await abrirEnCompanion('351 1234567', 'hola',
      con({ ok: true, action: 'reused', tabId: 42 }).opciones)

    assert.deepEqual(r, { ok: true, accion: 'reused' })
  })

  test('D · creó una pestaña porque no había ninguna', async () => {
    const r = await abrirEnCompanion('351 1234567', 'hola',
      con({ ok: true, action: 'created', tabId: 43 }).opciones)

    assert.deepEqual(r, { ok: true, accion: 'created' })
  })

  test('el tabId NO se propaga: no se usa para nada', async () => {
    const r = await abrirEnCompanion('351 1234567', 'hola',
      con({ ok: true, action: 'reused', tabId: 42 }).opciones)

    assert.ok(!('tabId' in r), 'un id de pestaña no es identidad ni permiso')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// E · errores
// ═══════════════════════════════════════════════════════════════════════

describe('E · apertura con error', () => {

  test('sin ID configurado no se manda nada', async () => {
    const { enviar, enviados } = espia({ ok: true, action: 'reused' })
    const r = await abrirEnCompanion('351 1234567', 'hola', { extensionId: null, enviar })

    assert.equal(r.ok, false)
    assert.equal((r as { code: string }).code, 'NO_CONFIGURADO')
    assert.equal(enviados.length, 0)
  })

  test('teléfono inválido: falla CERRADO, sin llegar a la extensión', async () => {
    const { opciones, enviados } = con({ ok: true, action: 'reused' })

    const r = await abrirEnCompanion('351 123', 'hola', opciones)

    assert.equal(r.ok, false)
    assert.equal((r as { code: string }).code, 'BAD_PHONE')
    assert.equal(enviados.length, 0)
  })

  test('mensaje vacío: tampoco sale', async () => {
    const { opciones, enviados } = con({ ok: true, action: 'reused' })

    assert.equal((await abrirEnCompanion('351 1234567', '   ', opciones)).ok, false)
    assert.equal(enviados.length, 0)
  })

  test('el error de la extensión se propaga con su código', async () => {
    const r = await abrirEnCompanion('351 1234567', 'hola',
      con({ ok: false, code: 'TAB_ERROR' }).opciones)

    assert.deepEqual(r, { ok: false, code: 'TAB_ERROR' })
  })

  test('sin respuesta se distingue de un rechazo, para poder caer al fallback', async () => {
    const r = await abrirEnCompanion('351 1234567', 'hola', con(null).opciones)

    assert.equal(r.ok, false)
    assert.equal((r as { motivo?: string }).motivo, 'sin_respuesta')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// F · el payload lleva SÓLO type/phone/text
// ═══════════════════════════════════════════════════════════════════════

describe('F · superficie del payload', () => {

  test('exactamente tres claves, ni una más', async () => {
    const { opciones, enviados } = con({ ok: true, action: 'reused' })

    await abrirEnCompanion('351 1234567', 'Hola Ana', opciones)

    assert.deepEqual(
      Object.keys(enviados[0].mensaje as object).sort(),
      ['phone', 'text', 'type'],
    )
  })

  test('NUNCA se manda la URL: si viniera de acá sería un open-redirect', async () => {
    const { opciones, enviados } = con({ ok: true, action: 'reused' })

    await abrirEnCompanion('351 1234567', 'Hola', opciones)

    const enviado = JSON.stringify(enviados[0].mensaje)
    assert.ok(!enviado.includes('web.whatsapp.com'), enviado)
    assert.ok(!enviado.includes('http'), enviado)
  })

  test('el teléfono viaja normalizado, en dígitos', async () => {
    const { opciones, enviados } = con({ ok: true, action: 'reused' })

    await abrirEnCompanion('0351 15 1234567', 'Hola', opciones)

    const m = enviados[0].mensaje as { phone: string }
    assert.equal(m.phone, '5493511234567')
    assert.match(m.phone, /^[0-9]{8,15}$/, 'es lo que la extensión revalida')
  })

  test('el texto viaja tal cual, sin codificar: la URL la arma la extensión', async () => {
    const { opciones, enviados } = con({ ok: true, action: 'reused' })
    const MSG = 'Hola José 👋\nTotal: $85.000 & 100%'

    await abrirEnCompanion('3511234567', MSG, opciones)

    assert.equal((enviados[0].mensaje as { text: string }).text, MSG)
  })

  test('el tipo es el del contrato', async () => {
    const { opciones, enviados } = con({ ok: true, action: 'reused' })

    await abrirEnCompanion('3511234567', 'hola', opciones)

    assert.equal((enviados[0].mensaje as { type: string }).type, COMPANION_TIPO_APERTURA)
    assert.equal(COMPANION_TIPO_APERTURA, 'OPEN_WHATSAPP_WEB')
  })
})
