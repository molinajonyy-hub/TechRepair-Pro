/**
 * Retención de whatsapp_logs — el centinela, de los dos lados.
 *
 * Runner: node:test nativo. Ejecutar: npm run test:unit
 *
 * POR QUÉ ESTE TEST EXISTE
 * El texto que la base escribe al vencer la retención está en la migración
 * (`public.whatsapp_log_redaction_marker()`), y el que el frontend compara está
 * en `src/services/whatsappRetention.ts`. Son dos literales en dos lenguajes
 * distintos, y si se separan NO SE ROMPE NADA VISIBLE: la UI simplemente deja
 * de reconocer las filas redactadas y le muestra a la persona el centinela
 * crudo entre corchetes, como si fuera el mensaje que le mandó al cliente.
 *
 * Esa es la clase de falla que ningún test de comportamiento encuentra, así que
 * acá se compara contra el TEXTO DE LA MIGRACIÓN leído del archivo.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  MARCA_REDACCION,
  AVISO_REDACCION,
  estaRedactado,
} from '../../src/services/whatsappRetention.ts'

const RAIZ = join(import.meta.dirname, '..', '..')

/** El literal que la migración le hace escribir a la base. */
function marcaDeLaMigracion(): string {
  const dir = join(RAIZ, 'supabase', 'migrations')
  const archivo = readdirSync(dir).find(f => f.includes('whatsapp_logs_retention'))
  assert.ok(archivo, 'no existe la migración de retención de whatsapp_logs')
  const sql = readFileSync(join(dir, archivo!), 'utf-8')

  const m = sql.match(/whatsapp_log_redaction_marker\(\)[\s\S]{0,400}?SELECT\s+'([^']+)'::text/)
  assert.ok(m, 'no se pudo leer el centinela de whatsapp_log_redaction_marker() en la migración')
  return m![1]
}

describe('retención · el centinela coincide en las dos puntas', () => {

  test('el literal del frontend es EXACTAMENTE el de la migración', () => {
    // Si esto falla, la UI le muestra al usuario el centinela crudo creyendo
    // que es el mensaje. No rompe nada; sólo miente en pantalla.
    assert.equal(MARCA_REDACCION, marcaDeLaMigracion())
  })

  test('el centinela no contiene nada que parezca un mensaje real', () => {
    assert.ok(MARCA_REDACCION.startsWith('['), MARCA_REDACCION)
    assert.ok(MARCA_REDACCION.endsWith(']'), MARCA_REDACCION)
    assert.ok(!/\d{6,}/.test(MARCA_REDACCION), 'no puede llevar nada parecido a un teléfono')
  })

  test('el aviso de la UI no es el centinela crudo', () => {
    // Mostrar el literal entre corchetes sería filtrar el detalle de
    // implementación a la persona que usa el sistema.
    assert.notEqual(AVISO_REDACCION, MARCA_REDACCION)
    assert.ok(!AVISO_REDACCION.includes('['), AVISO_REDACCION)
    assert.match(AVISO_REDACCION, /retenci[oó]n/i)
  })
})

describe('estaRedactado', () => {

  test('reconoce una fila redactada', () => {
    assert.equal(estaRedactado(MARCA_REDACCION), true)
  })

  test('NO marca un mensaje real', () => {
    for (const m of [
      'Hola Ana, tu Galaxy A54 está listo.',
      'Total: $85.000',
      '',
      '[contenido]',
      '[contenido eliminado]',
      'contenido eliminado por política de retención',   // sin corchetes
      `  ${MARCA_REDACCION}  `,                           // con espacios: no es el valor que escribe la base
    ]) {
      assert.equal(estaRedactado(m), false, JSON.stringify(m))
    }
  })

  test('tolera null y undefined sin romper', () => {
    // `message` es NOT NULL en la base, pero el tipo llega desde una consulta
    // y la UI no puede explotar si alguna vez viene vacío.
    assert.equal(estaRedactado(null), false)
    assert.equal(estaRedactado(undefined), false)
  })
})

describe('retención · el contrato de la migración', () => {

  const sql = () => {
    const dir = join(RAIZ, 'supabase', 'migrations')
    const archivo = readdirSync(dir).find(f => f.includes('whatsapp_logs_retention'))!
    return readFileSync(join(dir, archivo), 'utf-8')
  }

  test('los plazos son 90 días y 12 meses', () => {
    const s = sql()
    assert.match(s, /interval '90 days'/)
    assert.match(s, /interval '12 months'/)
  })

  test('el mantenimiento NO queda ejecutable por anon ni authenticated', () => {
    const s = sql()
    assert.match(s, /REVOKE ALL ON FUNCTION public\.apply_whatsapp_logs_retention\(integer\) FROM PUBLIC/)
    assert.match(s, /REVOKE ALL ON FUNCTION public\.apply_whatsapp_logs_retention\(integer\) FROM anon, authenticated/)
    assert.match(s, /GRANT\s+EXECUTE ON FUNCTION public\.apply_whatsapp_logs_retention\(integer\) TO service_role/)
  })

  test('search_path fijo y con pg_temp AL FINAL', () => {
    // Omitir pg_temp lo pone PRIMERO, y entonces una tabla temporal del
    // llamador puede secuestrar un nombre dentro de una SECURITY DEFINER.
    //
    // Se usa la forma SIN comillas a propósito: es la dominante en el repo
    // (92 contra 14) y es la única que `guard-security-definer.mjs` sabe leer
    // — su preprocesador blanquea los literales entre comillas simples antes
    // de parsear, así que la forma `TO 'public', 'pg_temp'` le queda vacía y
    // la reporta como si omitiera pg_temp.
    const s = sql()
    assert.match(s, /SET search_path = public, pg_temp/)
    assert.ok(!/SET search_path = pg_temp\b/.test(s), 'pg_temp no puede ir primero')
  })

  test('redacta las tres columnas con PII', () => {
    const s = sql()
    assert.match(s, /SET phone\s*=\s*NULL/)
    assert.match(s, /message\s*=\s*v_marca/)
    assert.match(s, /error_message\s*=\s*NULL/)
  })

  test('no guarda un hash del contenido purgado', () => {
    // Un hash de un mensaje corto es reversible por fuerza bruta: sería
    // conservar el dato con otro nombre.
    const s = sql()
    for (const p of [/digest\s*\(/i, /md5\s*\(/i, /sha\d/i, /crypt\s*\(/i, /encode\s*\(/i]) {
      assert.ok(!p.test(s), `la migración no puede derivar nada del contenido: ${p}`)
    }
  })

  test('el job de cron se documenta pero NO se crea desde la migración', () => {
    // Es el patrón del proyecto: los dos jobs de billing que ya corren en
    // producción tampoco se crean desde una migración. Crearlo acá haría que
    // cada `db reset` local intente programar un cron que en local no aplica.
    const s = sql()
    const sinComentarios = s.replace(/^\s*--.*$/gm, '')
    assert.ok(!/cron\.schedule\s*\(/.test(sinComentarios),
      'cron.schedule no puede ejecutarse desde la migración')
    assert.match(s, /cron\.schedule/, 'pero sí tiene que quedar documentado cómo programarlo')
  })
})
