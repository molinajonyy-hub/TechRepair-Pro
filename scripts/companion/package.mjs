#!/usr/bin/env node
// ============================================================================
// Empaquetado CANÓNICO del Companion para Chrome Web Store.
//
//   npm run companion:package        arma y valida dist/companion/<nombre>.zip
//   npm run companion:package -- --self-test   valida las comprobaciones puras
//
// POR QUÉ EXISTE: probar el FUENTE no alcanza. Armando el ZIP a mano con
// `Compress-Archive` de PowerShell salió `lib\contract.js` — con backslash. El
// spec ZIP exige barra normal, y el service worker es un módulo ES que hace
// `import './lib/contract.js'`: con la entrada mal escrita el import no
// resuelve, la extensión INSTALA SIN ERROR y queda inerte. Todo `sendMessage`
// timeoutea y el usuario ve «no está instalada».
//
// Ese modo de falla es silencioso, así que no puede depender de que alguien se
// acuerde. Acá se arma el paquete de una sola manera y se valida el ARTEFACTO,
// no la carpeta de la que salió.
//
// El ZIP se construye con la implementación mínima de DEFLATE/STORE que hay
// abajo, para no depender de utilidades del sistema operativo, y con la marca de
// tiempo fija. El artefacto es REPRODUCIBLE EN EL ENTORNO CANÓNICO DE
// PACKAGING y verificable mediante SHA-256: dos corridas seguidas sobre el
// mismo checkout dan el mismo archivo.
//
// No se afirma reproducibilidad entre plataformas: el repo tiene
// `core.autocrlf=true` y no hay `.gitattributes`, así que el árbol de trabajo en
// Windows usa CRLF donde el índice guarda LF, y el ZIP se arma desde el árbol de
// trabajo. Un clon en Linux produce un SHA-256 distinto. No afecta a la
// extensión —Chrome no distingue los finales de línea— y no bloquea al Chrome
// Web Store; sólo importa al comparar hashes entre máquinas.
//
// FAIL-CLOSED: antes de escribir nada corre el guard de release del Companion y
// el self-test de este script. Si algo falla no se escribe ZIP, así que no puede
// quedar un artefacto publicable que las comprobaciones habrían rechazado.
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib'
import { validarRepo } from '../guards/whatsapp-companion-release.mjs'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXT = join(RAIZ, 'tools', 'whatsapp-companion')
const SALIDA_DIR = join(RAIZ, 'dist', 'companion')

/**
 * Contenido EXACTO del paquete. Lista blanca, no lista negra: agregar un
 * archivo de desarrollo a la carpeta no puede filtrarlo al Store por descuido.
 *
 * `store-icon-128.png` NO está: es el ícono de la FICHA, se sube por el
 * dashboard y no forma parte de la extensión.
 */
export const ARCHIVOS_DEL_PAQUETE = Object.freeze([
  'manifest.json',
  'service-worker.js',
  'lib/contract.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
])

/** Nada de esto puede terminar adentro, por más que viva en la misma carpeta. */
export const PROHIBIDOS_EN_EL_PAQUETE = Object.freeze([
  'README.md', 'probe.mjs', 'spike-navapi.mjs', 'spike-softnav.mjs',
  'harness/index.html', 'store-icon-128.png',
  '.env', '.env.local', 'key.pem', 'node_modules/x.js', '.git/config',
])

// ─── Comprobaciones puras (testeables) ──────────────────────────────────────

/** Toda entrada del ZIP usa barra normal. Un backslash rompe el import ESM. */
export function entradasConBackslash(entradas) {
  return entradas.filter((e) => e.includes('\\'))
}

/** `manifest.json` va en la RAÍZ, no adentro de una carpeta. */
export function manifestEnLaRaiz(entradas) {
  return entradas.includes('manifest.json')
}

/** Nada de desarrollo se coló. */
export function archivosDeMas(entradas, permitidos = ARCHIVOS_DEL_PAQUETE) {
  return entradas.filter((e) => !permitidos.includes(e))
}

/**
 * Todo lo que el manifest referencia existe en el paquete.
 *
 * Cubre el service worker, sus imports estáticos y los íconos: es la
 * comprobación que caza el ZIP que instala pero no arranca.
 */
export function referenciasFaltantes(manifest, entradas, importsDelWorker = []) {
  const faltan = []
  const sw = manifest?.background?.service_worker
  if (!sw) faltan.push('background.service_worker no declarado')
  else if (!entradas.includes(sw)) faltan.push(sw)

  for (const ruta of importsDelWorker) {
    if (!entradas.includes(ruta)) faltan.push(ruta)
  }
  for (const icono of Object.values(manifest?.icons ?? {})) {
    if (!entradas.includes(icono)) faltan.push(icono)
  }
  if (!manifest?.icons || !manifest.icons['128']) {
    faltan.push('icons.128 (Chrome Web Store lo exige)')
  }
  return faltan
}

/**
 * Resuelve los imports relativos de un módulo a rutas del paquete.
 * Sólo estáticos: el service worker no usa `import()` dinámico a propósito.
 */
export function importsRelativos(fuente, rutaDelModulo) {
  const base = posix.dirname(rutaDelModulo.replace(/\\/g, '/'))
  const rutas = []
  for (const m of fuente.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"](\.[^'"]+)['"]/g)) {
    rutas.push(posix.normalize(posix.join(base === '.' ? '' : base, m[1])))
  }
  return rutas
}

// ─── Construcción del ZIP (sin dependencias del sistema) ────────────────────

function entradaZip(nombre, datos) {
  const nombreBuf = Buffer.from(nombre, 'utf-8')
  const comprimido = deflateRawSync(datos, { level: 9 })
  // Si comprimir no ayuda, se guarda tal cual (método 0).
  const usaDeflate = comprimido.length < datos.length
  const cuerpo = usaDeflate ? comprimido : datos

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)   // firma
  local.writeUInt16LE(20, 4)           // versión necesaria
  local.writeUInt16LE(0x0800, 6)       // bit 11: nombre en UTF-8
  local.writeUInt16LE(usaDeflate ? 8 : 0, 8)
  local.writeUInt16LE(0, 10)           // hora — fija, para que el ZIP sea reproducible
  local.writeUInt16LE(0x0021, 12)      // fecha — 1980-01-01
  local.writeUInt32LE(crc32(datos), 14)
  local.writeUInt32LE(cuerpo.length, 18)
  local.writeUInt32LE(datos.length, 22)
  local.writeUInt16LE(nombreBuf.length, 26)
  local.writeUInt16LE(0, 28)

  return { nombreBuf, cuerpo, datos, usaDeflate, local }
}

function construirZip(archivos) {
  const partes = []
  const central = []
  let offset = 0

  for (const { nombre, datos } of archivos) {
    const e = entradaZip(nombre, datos)
    partes.push(e.local, e.nombreBuf, e.cuerpo)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(e.usaDeflate ? 8 : 0, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x0021, 14)
    cd.writeUInt32LE(crc32(e.datos), 16)
    cd.writeUInt32LE(e.cuerpo.length, 20)
    cd.writeUInt32LE(e.datos.length, 24)
    cd.writeUInt16LE(e.nombreBuf.length, 28)
    cd.writeUInt32LE(0, 38)            // atributos externos
    cd.writeUInt32LE(offset, 42)
    central.push(cd, e.nombreBuf)

    offset += e.local.length + e.nombreBuf.length + e.cuerpo.length
  }

  const centralBuf = Buffer.concat(central)
  const fin = Buffer.alloc(22)
  fin.writeUInt32LE(0x06054b50, 0)
  fin.writeUInt16LE(archivos.length, 8)
  fin.writeUInt16LE(archivos.length, 10)
  fin.writeUInt32LE(centralBuf.length, 12)
  fin.writeUInt32LE(offset, 16)

  return Buffer.concat([...partes, centralBuf, fin])
}

/** Recorre el directorio central. Devuelve { nombre, offset } por entrada. */
function entradasDelCentral(zip) {
  const idx = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (idx < 0) throw new Error('ZIP sin directorio central')
  const cantidad = zip.readUInt16LE(idx + 10)
  let p = zip.readUInt32LE(idx + 16)
  const entradas = []
  for (let i = 0; i < cantidad; i++) {
    const largoNombre = zip.readUInt16LE(p + 28)
    const largoExtra = zip.readUInt16LE(p + 30)
    const largoComentario = zip.readUInt16LE(p + 32)
    entradas.push({
      nombre: zip.toString('utf-8', p + 46, p + 46 + largoNombre),
      offset: zip.readUInt32LE(p + 42),
    })
    p += 46 + largoNombre + largoExtra + largoComentario
  }
  return entradas
}

/** Lee los nombres de entrada de un ZIP. */
export function leerEntradas(zip) {
  return entradasDelCentral(zip).map((e) => e.nombre)
}

/**
 * Extrae el ZIP a `destino`, preservando la estructura de carpetas.
 *
 * Es lo que usa `companion:probe:packaged` para cargar en el navegador EL
 * ARTEFACTO que se sube, y no la carpeta de la que salió. Si `lib/` se aplanara
 * o el import no resolviera, acá se ve.
 */
export function extraerZip(zip, destino) {
  const escritos = []
  for (const { nombre, offset } of entradasDelCentral(zip)) {
    const largoNombre = zip.readUInt16LE(offset + 26)
    const largoExtra = zip.readUInt16LE(offset + 28)
    const metodo = zip.readUInt16LE(offset + 8)
    const comprimido = zip.readUInt32LE(offset + 18)
    const inicio = offset + 30 + largoNombre + largoExtra
    const cuerpo = zip.subarray(inicio, inicio + comprimido)
    const datos = metodo === 8 ? inflateRawSync(cuerpo) : cuerpo

    const salida = join(destino, ...nombre.split('/'))
    mkdirSync(dirname(salida), { recursive: true })
    writeFileSync(salida, datos)
    escritos.push(nombre)
  }
  return escritos
}

// ─── Self-test ──────────────────────────────────────────────────────────────

/**
 * Corre las comprobaciones puras y DEVUELVE los casos, sin imprimir ni salir.
 *
 * Lo llaman dos consumidores con necesidades distintas: `--self-test`, que
 * quiere el detalle completo en pantalla, y `empaquetar()`, que sólo necesita
 * saber si algo falló para abortar antes de escribir el ZIP.
 */
function correrSelfTest() {
  const casos = []
  const chequear = (nombre, real, esperado) =>
    casos.push({ nombre, ok: JSON.stringify(real) === JSON.stringify(esperado) })

  chequear('caza el backslash', entradasConBackslash(['manifest.json', 'lib\\contract.js']), ['lib\\contract.js'])
  chequear('acepta rutas POSIX', entradasConBackslash(['manifest.json', 'lib/contract.js']), [])

  chequear('reconoce el manifest en la raíz', manifestEnLaRaiz(['manifest.json', 'lib/contract.js']), true)
  chequear('caza la carpeta como raíz', manifestEnLaRaiz(['companion/manifest.json']), false)

  chequear('caza el README colado', archivosDeMas(['manifest.json', 'README.md'], ['manifest.json']), ['README.md'])
  chequear('caza el probe colado', archivosDeMas(['manifest.json', 'probe.mjs'], ['manifest.json']), ['probe.mjs'])
  chequear('no marca el paquete correcto', archivosDeMas(['manifest.json'], ['manifest.json']), [])

  const manifestOk = { background: { service_worker: 'service-worker.js' }, icons: { 128: 'icons/icon128.png' } }
  chequear('acepta un paquete completo',
    referenciasFaltantes(manifestOk, ['service-worker.js', 'lib/contract.js', 'icons/icon128.png'], ['lib/contract.js']), [])
  chequear('caza el import ausente (el ZIP que instala e igual no arranca)',
    referenciasFaltantes(manifestOk, ['service-worker.js', 'icons/icon128.png'], ['lib/contract.js']), ['lib/contract.js'])
  chequear('caza lib/ aplanado',
    referenciasFaltantes(manifestOk, ['service-worker.js', 'contract.js', 'icons/icon128.png'], ['lib/contract.js']), ['lib/contract.js'])
  chequear('caza el service worker ausente',
    referenciasFaltantes(manifestOk, ['icons/icon128.png'], []), ['service-worker.js'])
  chequear('caza la falta del ícono 128',
    referenciasFaltantes({ background: { service_worker: 'sw.js' } }, ['sw.js'], []),
    ['icons.128 (Chrome Web Store lo exige)'])

  chequear('resuelve el import relativo del worker',
    importsRelativos("import { a } from './lib/contract.js';", 'service-worker.js'), ['lib/contract.js'])
  chequear('resuelve un import multilínea', importsRelativos(
    "import {\n  a,\n  b,\n} from './lib/contract.js';", 'service-worker.js'), ['lib/contract.js'])
  chequear('ignora los imports de paquete',
    importsRelativos("import { chromium } from '@playwright/test';", 'service-worker.js'), [])

  // El ZIP que arma este script se puede releer y da exactamente lo que se metió.
  const zip = construirZip([
    { nombre: 'manifest.json', datos: Buffer.from('{"a":1}') },
    { nombre: 'lib/contract.js', datos: Buffer.from('export const x = 1;\n'.repeat(20)) },
  ])
  chequear('el ZIP se relee con las mismas entradas', leerEntradas(zip), ['manifest.json', 'lib/contract.js'])
  chequear('y sin backslashes', entradasConBackslash(leerEntradas(zip)), [])

  // Round-trip real: lo que se escribe es lo que se lee de vuelta, con la
  // estructura de carpetas intacta. Es la propiedad que el bug del backslash
  // rompía en silencio.
  const tmp = mkdtempSync(join(tmpdir(), 'pkg-selftest-'))
  try {
    const contenidoLib = 'export const x = 1;\n'.repeat(20)
    extraerZip(zip, tmp)
    chequear('extraído: manifest.json en la raíz', readFileSync(join(tmp, 'manifest.json'), 'utf-8'), '{"a":1}')
    chequear('extraído: lib/ NO se aplanó', readFileSync(join(tmp, 'lib', 'contract.js'), 'utf-8'), contenidoLib)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  return casos
}

/** Modo `--self-test`: imprime cada caso y sale con código según el resultado. */
function selfTest() {
  const casos = correrSelfTest()
  for (const c of casos) console.log(`  ${c.ok ? '✓' : '✗'} ${c.nombre}`)
  const fallidos = casos.filter((c) => !c.ok)
  if (fallidos.length) {
    console.error(`\n✗ Self-test FALLIDO: ${fallidos.length}/${casos.length}.`)
    process.exit(1)
  }
  console.log(`\n✓ Self-test OK: ${casos.length} comprobaciones.`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

/** Aborta el empaquetado con un cartel legible. NUNCA deja un ZIP escrito. */
function abortar(titulo, fallas, pista) {
  console.error('\n' + '═'.repeat(70))
  console.error(`  ${titulo}`)
  console.error('═'.repeat(70))
  for (const f of fallas) console.error(`  ✗ ${f}`)
  if (pista) console.error(`\n  ${pista}`)
  console.error('═'.repeat(70))
  console.error('  No se escribió ningún ZIP.\n')
  process.exit(1)
}

function empaquetar() {
  // Se limpia la salida ANTES de cualquier comprobación. Si esta corrida falla,
  // no puede quedar el ZIP de una corrida anterior haciéndose pasar por el
  // artefacto actual: fallar tiene que dejar CERO artefactos, no uno viejo con
  // fecha creíble.
  rmSync(SALIDA_DIR, { recursive: true, force: true })

  // ── Puerta 1 · las comprobaciones puras se comportan como dicen ──────────
  // Si el verificador está roto, todo lo que venga después no prueba nada.
  const fallidosSelfTest = correrSelfTest().filter((c) => !c.ok)
  if (fallidosSelfTest.length) {
    abortar(
      'SELF-TEST FALLIDO — las comprobaciones del empaquetador no son confiables',
      fallidosSelfTest.map((c) => c.nombre),
      'Detalle completo: npm run companion:package:self-test',
    )
  }

  // ── Puerta 2 · el guard de release ──────────────────────────────────────
  // Corre ACÁ, no en un comando aparte que hay que acordarse de ejecutar. Cubre
  // description fuera de límite, permisos prohibidos, origins de desarrollo
  // (localhost), íconos declarados que no existen y superficie de más.
  const fallasGuard = validarRepo()
  if (fallasGuard.length) {
    abortar(
      'GUARD DE RELEASE FALLIDO — el Companion no está en condiciones de distribuirse',
      fallasGuard,
      'Este es el mismo guard que npm run guard:whatsapp-companion.',
    )
  }

  const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf-8'))
  const nombreZip = `techrepair-companion-${manifest.version}.zip`

  const archivos = ARCHIVOS_DEL_PAQUETE.map((nombre) => {
    const disco = join(EXT, nombre.replace(/\//g, '/'))
    if (!existsSync(disco)) {
      const pista = nombre.startsWith('icons/')
        ? 'Generá los íconos con: node scripts/companion/generar-iconos.mjs'
        : null
      abortar('FALTA UN ARCHIVO DEL PAQUETE', [`${nombre} no está en tools/whatsapp-companion/`], pista)
    }
    return { nombre, datos: readFileSync(disco) }
  })

  const zip = construirZip(archivos)

  // ── Puerta 3 · validación del ARTEFACTO, no de la carpeta ───────────────
  // Se valida el ZIP EN MEMORIA y recién después se escribe. Antes se escribía
  // primero y se validaba después: un paquete rechazado quedaba igual en disco,
  // con pinta de publicable, y nada distinguía la corrida que falló de la que
  // funcionó salvo leer la consola.
  const entradas = leerEntradas(zip)
  const fallas = []

  const conBackslash = entradasConBackslash(entradas)
  if (conBackslash.length) fallas.push(`entradas con backslash: ${conBackslash.join(', ')}`)
  if (!manifestEnLaRaiz(entradas)) fallas.push('manifest.json no está en la raíz del ZIP')

  const deMas = archivosDeMas(entradas)
  if (deMas.length) fallas.push(`archivos de más: ${deMas.join(', ')}`)

  const fuenteWorker = readFileSync(join(EXT, 'service-worker.js'), 'utf-8')
  const imports = importsRelativos(fuenteWorker, 'service-worker.js')
  const faltan = referenciasFaltantes(manifest, entradas, imports)
  if (faltan.length) fallas.push(`el manifest referencia lo que no está: ${faltan.join(', ')}`)

  for (const prohibido of PROHIBIDOS_EN_EL_PAQUETE) {
    if (entradas.includes(prohibido)) fallas.push(`archivo prohibido en el paquete: ${prohibido}`)
  }

  if (fallas.length) abortar('PAQUETE INVÁLIDO', fallas)

  // ── Recién acá se escribe, con las tres puertas pasadas ──────────────────
  mkdirSync(SALIDA_DIR, { recursive: true })
  const rutaZip = join(SALIDA_DIR, nombreZip)
  writeFileSync(rutaZip, zip)

  console.log(`\n✓ ${nombreZip}  (${zip.length} B, ${entradas.length} archivos)`)
  for (const e of entradas) console.log(`    ${e}`)
  console.log(`\n  ${rutaZip.replace(RAIZ, '.')}`)
  console.log('  Verificalo cargado en un navegador con: npm run companion:probe:packaged\n')
}

/**
 * Sólo empaqueta si el archivo se ejecutó directamente.
 *
 * `tools/whatsapp-companion/probe.mjs` importa `extraerZip` de acá. Sin esta
 * condición, ese import ejecutaba `empaquetar()` como efecto secundario: cada
 * `companion:probe:packaged` volvía a armar el ZIP en silencio, y el probe
 * terminaba verificando un artefacto que él mismo acababa de generar en vez del
 * que había en disco. Con las puertas fail-closed sería peor todavía: un guard
 * en rojo cortaría el probe con un cartel de empaquetado.
 */
const ejecutadoDirectamente =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (ejecutadoDirectamente) {
  if (process.argv.includes('--self-test')) {
    console.log('\n─── companion:package · self-test ──────────────────────────────────')
    selfTest()
  } else {
    empaquetar()
  }
}
