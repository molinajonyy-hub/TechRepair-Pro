/**
 * Cliente del Companion — contrato TechRepair → extensión.
 *
 * Runner: node:test nativo. Ejecutar: npm run test:unit
 *
 * QUÉ SE TESTEA ACÁ Y QUÉ NO. Acá van las reglas del cliente: qué se manda,
 * cómo se clasifica lo que vuelve, y que falle cerrado. El comportamiento REAL
 * de la extensión —adoptar, reutilizar y crear pestañas en Chrome— lo demuestra
 * `tools/whatsapp-companion/probe.mjs` cargando el ZIP publicable en un Chromium
 * de verdad, y NO se reemplaza con mocks: un mock no tiene modelo de seguridad,
 * así que validar contra uno es justamente cómo se produce un falso positivo.
 *
 * Por eso el transporte es inyectable: se testea el contrato, no se simula
 * `chrome.tabs`.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPANION_TIPO_APERTURA,
  COMPANION_TIPO_PING,
  TIMEOUT_DESCUBRIMIENTO_MS,
  TIMEOUT_APERTURA_MS,
  REINTENTOS_DESCUBRIMIENTO,
  companionExtensionId,
  companionInstallUrl,
  consultarCompanion,
  abrirEnCompanion,
  type EnviarAlCompanion,
  type ResultadoTransporte,
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

interface Envio { id: string; mensaje: unknown; timeoutMs: number }

/** Transporte falso: registra lo enviado y devuelve la secuencia indicada. */
function espia(...respuestas: ResultadoTransporte[]) {
  const enviados: Envio[] = []
  let i = 0
  const enviar: EnviarAlCompanion = async (id, mensaje, timeoutMs) => {
    enviados.push({ id, mensaje, timeoutMs })
    return respuestas[Math.min(i++, respuestas.length - 1)]
  }
  return { enviar, enviados }
}

const responde = (datos: unknown): ResultadoTransporte => ({ tipo: 'respuesta', datos })
const SIN_EXTENSION: ResultadoTransporte = { tipo: 'sin_extension' }
const TIMEOUT: ResultadoTransporte = { tipo: 'timeout' }

/** Opciones con Companion configurado y la secuencia de respuestas dada. */
const con = (...respuestas: ResultadoTransporte[]) => {
  const { enviar, enviados } = espia(...respuestas)
  return { opciones: { extensionId: ID_VALIDO, enviar }, enviados }
}

const PING_OK = responde({ ok: true, version: '1.0.0', hostAccess: true })
const APERTURA_OK = responde({ ok: true, action: 'reused' })

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
      'abc', ID_VALIDO + 'a',
      'abcdefghijklmnopabcdefghijklmnoz',   // 'z' fuera de a-p
      'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP',   // mayúsculas
      '   ', '', null, undefined, 42,
    ]) {
      assert.equal(normalizarExtensionId(malo as never), null, String(malo))
    }
  })

  test('la URL de instalación exige https', () => {
    assert.ok(normalizarInstallUrl('https://chromewebstore.google.com/detail/x')?.startsWith('https://'))
    for (const mala of [
      'http://inseguro.example/x', 'javascript:alert(1)', 'chrome://extensions',
      'no-es-url', '', '   ', null, undefined,
    ]) {
      assert.equal(normalizarInstallUrl(mala as never), null, String(mala))
    }
  })

  test('sin entorno configurado, ambas quedan en null (fail-closed)', () => {
    assert.equal(companionExtensionId(), null)
    assert.equal(companionInstallUrl(), null)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// A · Companion PING disponible
// ═══════════════════════════════════════════════════════════════════════

describe('A · descubrimiento con el Companion presente', () => {

  test('si responde ok con acceso: disponible', async () => {
    const { opciones, enviados } = con(PING_OK)

    const r = await consultarCompanion(opciones)

    assert.deepEqual(r, { estado: 'disponible', version: '1.0.0' })
    assert.equal(enviados.length, 1)
    assert.equal(enviados[0].id, ID_VALIDO)
    assert.deepEqual(enviados[0].mensaje, { type: COMPANION_TIPO_PING })
  })

  test('el PING no lleva teléfono ni mensaje', async () => {
    const { opciones, enviados } = con(PING_OK)
    await consultarCompanion(opciones)
    assert.deepEqual(Object.keys(enviados[0].mensaje as object), ['type'])
  })

  test('usa el presupuesto de descubrimiento, no el de apertura', async () => {
    const { opciones, enviados } = con(PING_OK)
    await consultarCompanion(opciones)
    assert.equal(enviados[0].timeoutMs, TIMEOUT_DESCUBRIMIENTO_MS)
  })

  test('una extensión vieja que no informa hostAccess se toma como disponible', async () => {
    // Compatibilidad hacia atrás: si no lo dice, se asume que lo tiene. Si no
    // fuera cierto, el OPEN devuelve HOST_ACCESS_REQUIRED y la UI se corrige.
    const r = await consultarCompanion(con(responde({ ok: true, version: '0.9.0' })).opciones)
    assert.equal(r.estado, 'disponible')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// A.2 · instalada pero SIN ACCESO — el estado que antes no existía
// ═══════════════════════════════════════════════════════════════════════

describe('A.2 · sin acceso al host', () => {

  test('hostAccess:false NO es lo mismo que ausente', async () => {
    // Chrome permite dejar el acceso al sitio en «Al hacer clic». La extensión
    // está: mandar a instalarla de nuevo sería un consejo inútil.
    const r = await consultarCompanion(con(responde({ ok: true, version: '1.0.0', hostAccess: false })).opciones)
    assert.deepEqual(r, { estado: 'sin_acceso', version: '1.0.0' })
  })

  test('la apertura devuelve el estado sin_acceso para que la UI se corrija', async () => {
    const r = await abrirEnCompanion('351 1234567', 'hola',
      con(responde({ ok: false, code: 'HOST_ACCESS_REQUIRED' })).opciones)

    assert.deepEqual(r, { ok: false, code: 'HOST_ACCESS_REQUIRED', estado: 'sin_acceso' })
  })

  test('cualquier OTRO error NO se confunde con falta de acceso', async () => {
    const r = await abrirEnCompanion('351 1234567', 'hola',
      con(responde({ ok: false, code: 'TAB_ERROR' })).opciones)

    assert.equal((r as { estado: string }).estado, 'disponible')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// B · Companion ausente — y la diferencia con "no contestó"
// ═══════════════════════════════════════════════════════════════════════

describe('B · descubrimiento sin Companion', () => {

  test('sin ID configurado: ausente, y NO se manda nada', async () => {
    const { enviar, enviados } = espia(PING_OK)

    const r = await consultarCompanion({ extensionId: null, enviar })

    assert.deepEqual(r, { estado: 'ausente', motivo: 'sin_configurar' })
    assert.equal(enviados.length, 0, 'sin ID no hay a quién hablarle')
  })

  test('lastError es CONCLUYENTE: ausente al primer intento, sin reintentar', async () => {
    // Medido: una extensión que no está resuelve por lastError en ~1 ms. No
    // tiene sentido reintentar ni esperar el timeout.
    const { opciones, enviados } = con(SIN_EXTENSION)

    const r = await consultarCompanion(opciones)

    assert.deepEqual(r, { estado: 'ausente', motivo: 'sin_extension' })
    assert.equal(enviados.length, 1, 'no se reintenta lo que ya es concluyente')
  })

  test('una respuesta que no es del contrato tampoco cuenta como disponible', async () => {
    for (const datos of [{}, { ok: false }, { ok: 'sí' }, 'pong', 0, null]) {
      const r = await consultarCompanion(con(responde(datos)).opciones)
      assert.equal(r.estado, 'ausente', JSON.stringify(datos))
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// B.2 · TIMEOUT ≠ AUSENTE — service worker frío
// ═══════════════════════════════════════════════════════════════════════

describe('B.2 · un timeout no es una ausencia', () => {

  test('reintenta UNA vez ante un timeout', async () => {
    const { opciones, enviados } = con(TIMEOUT, PING_OK)

    const r = await consultarCompanion(opciones)

    assert.equal(enviados.length, 2, 'el primer timeout se reintenta')
    assert.equal(r.estado, 'disponible', 'y el segundo intento manda')
  })

  test('si el reintento tampoco contesta: indeterminado, NO ausente', async () => {
    // Un service worker MV3 dormido puede tardar en despertar. Decir «no está
    // instalada» por eso hace que la persona vea los fallbacks teniendo la
    // extensión, sin forma de descubrir el error.
    const { opciones, enviados } = con(TIMEOUT, TIMEOUT)

    const r = await consultarCompanion(opciones)

    assert.deepEqual(r, { estado: 'indeterminado' })
    assert.equal(enviados.length, 1 + REINTENTOS_DESCUBRIMIENTO)
  })

  test('no reintenta para siempre', async () => {
    const { opciones, enviados } = con(TIMEOUT)
    await consultarCompanion(opciones)
    assert.ok(enviados.length <= 1 + REINTENTOS_DESCUBRIMIENTO, `fueron ${enviados.length}`)
  })

  test('el presupuesto de descubrimiento tiene holgura sobre el cold start medido', () => {
    // Medido en Chromium real: 78 ms con el worker recién arrancado, 1-2 ms en
    // caliente. El presupuesto no puede quedar pegado a esa medición.
    assert.ok(TIMEOUT_DESCUBRIMIENTO_MS >= 2000, `es ${TIMEOUT_DESCUBRIMIENTO_MS} ms`)
    assert.ok(TIMEOUT_APERTURA_MS > TIMEOUT_DESCUBRIMIENTO_MS, 'la apertura además navega pestañas')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// C/D · apertura: reused y created
// ═══════════════════════════════════════════════════════════════════════

describe('C/D · apertura exitosa', () => {

  test('C · reutilizó una pestaña existente', async () => {
    const r = await abrirEnCompanion('351 1234567', 'hola', con(APERTURA_OK).opciones)
    assert.deepEqual(r, { ok: true, accion: 'reused' })
  })

  test('D · creó una pestaña porque no había ninguna', async () => {
    const r = await abrirEnCompanion('351 1234567', 'hola',
      con(responde({ ok: true, action: 'created' })).opciones)
    assert.deepEqual(r, { ok: true, accion: 'created' })
  })

  test('el éxito NO propaga nada del estado del navegador', async () => {
    // Aunque una extensión vieja mandara tabId o encontradas, el cliente no los
    // deja pasar: la superficie de datos hacia la app es { ok, accion }.
    const r = await abrirEnCompanion('351 1234567', 'hola',
      con(responde({ ok: true, action: 'reused', tabId: 42, encontradas: 3 })).opciones)

    assert.deepEqual(Object.keys(r).sort(), ['accion', 'ok'])
  })

  test('usa el presupuesto de apertura, más generoso', async () => {
    const { opciones, enviados } = con(APERTURA_OK)
    await abrirEnCompanion('351 1234567', 'hola', opciones)
    assert.equal(enviados[0].timeoutMs, TIMEOUT_APERTURA_MS)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// E · errores
// ═══════════════════════════════════════════════════════════════════════

describe('E · apertura con error', () => {

  test('sin ID configurado no se manda nada', async () => {
    const { enviar, enviados } = espia(APERTURA_OK)
    const r = await abrirEnCompanion('351 1234567', 'hola', { extensionId: null, enviar })

    assert.equal(r.ok, false)
    assert.equal((r as { code: string }).code, 'NO_CONFIGURADO')
    assert.equal(enviados.length, 0)
  })

  test('teléfono inválido: falla CERRADO, sin llegar a la extensión', async () => {
    const { opciones, enviados } = con(APERTURA_OK)

    const r = await abrirEnCompanion('351 123', 'hola', opciones)

    assert.equal(r.ok, false)
    assert.equal((r as { code: string }).code, 'BAD_PHONE')
    assert.equal(enviados.length, 0)
  })

  test('mensaje vacío: tampoco sale', async () => {
    const { opciones, enviados } = con(APERTURA_OK)
    assert.equal((await abrirEnCompanion('351 1234567', '   ', opciones)).ok, false)
    assert.equal(enviados.length, 0)
  })

  test('lastError en la apertura ⇒ ausente, para caer al menú de fallbacks', async () => {
    const r = await abrirEnCompanion('351 1234567', 'hola', con(SIN_EXTENSION).opciones)
    assert.deepEqual(r, { ok: false, code: 'SIN_RESPUESTA', estado: 'ausente' })
  })

  test('un timeout en la apertura NO declara la extensión ausente', async () => {
    const r = await abrirEnCompanion('351 1234567', 'hola', con(TIMEOUT).opciones)
    assert.equal((r as { estado: string }).estado, 'indeterminado')
    assert.notEqual((r as { estado: string }).estado, 'ausente')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// F · el payload lleva SÓLO type/phone/text
// ═══════════════════════════════════════════════════════════════════════

describe('F · superficie del payload', () => {

  test('exactamente tres claves, ni una más', async () => {
    const { opciones, enviados } = con(APERTURA_OK)
    await abrirEnCompanion('351 1234567', 'Hola Ana', opciones)

    assert.deepEqual(Object.keys(enviados[0].mensaje as object).sort(), ['phone', 'text', 'type'])
  })

  test('NUNCA se manda la URL: si viniera de acá sería un open-redirect', async () => {
    const { opciones, enviados } = con(APERTURA_OK)
    await abrirEnCompanion('351 1234567', 'Hola', opciones)

    const enviado = JSON.stringify(enviados[0].mensaje)
    assert.ok(!enviado.includes('web.whatsapp.com'), enviado)
    assert.ok(!enviado.includes('http'), enviado)
  })

  test('el teléfono viaja normalizado, en dígitos', async () => {
    const { opciones, enviados } = con(APERTURA_OK)
    await abrirEnCompanion('0351 15 1234567', 'Hola', opciones)

    const m = enviados[0].mensaje as { phone: string }
    assert.equal(m.phone, '5493511234567')
    assert.match(m.phone, /^[0-9]{8,15}$/, 'es lo que la extensión revalida')
  })

  test('el texto viaja tal cual, sin codificar: la URL la arma la extensión', async () => {
    const { opciones, enviados } = con(APERTURA_OK)
    const MSG = 'Hola José 👋\nTotal: $85.000 & 100%'

    await abrirEnCompanion('3511234567', MSG, opciones)

    assert.equal((enviados[0].mensaje as { text: string }).text, MSG)
  })

  test('el tipo es el del contrato', async () => {
    const { opciones, enviados } = con(APERTURA_OK)
    await abrirEnCompanion('3511234567', 'hola', opciones)

    assert.equal((enviados[0].mensaje as { type: string }).type, COMPANION_TIPO_APERTURA)
    assert.equal(COMPANION_TIPO_APERTURA, 'OPEN_WHATSAPP_WEB')
  })
})
