#!/usr/bin/env node
// ============================================================================
// Copia DEV del Companion con la `key` del ítem del Chrome Web Store.
//
//   node scripts/companion/dev-unpacked.mjs [ruta/a/public-key.pem]
//
// POR QUÉ EXISTE: el ID de una extensión desempaquetada se deriva de la RUTA de
// la carpeta, así que en desarrollo nunca coincide con el de producción. Eso
// hace intesteable el camino real —`externally_connectable` autoriza orígenes,
// pero TechRepair le habla a un ID concreto—. El mecanismo oficial para fijarlo
// es el campo `key` del manifest, con la clave pública del ítem:
// https://developer.chrome.com/docs/extensions/reference/manifest/key
//
// POR QUÉ ES UNA COPIA Y NO UNA EDICIÓN: el ZIP que el Store ya aceptó NO
// lleva `key`, y si un re-upload que la incluya es aceptado no está documentado
// oficialmente — las únicas fuentes son hilos de comunidad que se contradicen.
// Así que el runtime canónico queda intacto y la key sólo vive en esta copia
// descartable, bajo `dist/` (ignorado por git). El artefacto publicable no se
// toca nunca desde acá.
//
// La clave es PÚBLICA —Chrome la incluye en cada CRX— pero igual se lee de un
// archivo fuera del control de versiones, para no meter datos del ítem en el
// repo.
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { ARCHIVOS_DEL_PAQUETE } from './package.mjs'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXT = join(RAIZ, 'tools', 'whatsapp-companion')

/**
 * NO va bajo `dist/`. Vite vacía ese directorio en cada `npm run build`, así que
 * la carpeta que el owner tiene cargada en `chrome://extensions` desaparecería
 * —y Chrome la marcaría como rota— por correr un build cualquiera. Vive en un
 * directorio propio, ignorado por git y que ninguna tarea limpia.
 */
const LOCAL = join(RAIZ, '.companion-local')
const SALIDA = join(LOCAL, 'unpacked')
const KEY_POR_DEFECTO = join(LOCAL, 'public-key.pem')

/** PEM → una sola línea de base64, que es lo que espera el campo `key`. */
export function pemAUnaLinea(pem) {
  const cuerpo = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '')
  if (!cuerpo) throw new Error('el PEM no tiene cuerpo')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cuerpo)) throw new Error('el cuerpo del PEM no es base64 limpio')
  return cuerpo
}

/**
 * Deriva el extension ID de la clave pública, igual que Chrome:
 * sha256(DER) → primeros 16 bytes → hex → cada dígito 0-f mapeado a a-p.
 *
 * Sirve para comparar contra el ID del ítem SIN abrir un navegador, y para
 * cazar una key que no corresponde antes de perder tiempo cargándola.
 */
export function idDesdeClavePublica(base64) {
  const hash = createHash('sha256').update(Buffer.from(base64, 'base64')).digest()
  return [...hash.subarray(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .split('')
    .map((h) => String.fromCharCode(97 + parseInt(h, 16)))
    .join('')
}

function construir(rutaKey) {
  if (!existsSync(rutaKey)) {
    console.error(`\n✗ No está la clave pública en ${rutaKey}`)
    console.error('  Sacala del dashboard del Store: el ítem → pestaña Package → View public key.\n')
    process.exit(1)
  }

  const base64 = pemAUnaLinea(readFileSync(rutaKey, 'utf8'))
  const id = idDesdeClavePublica(base64)

  rmSync(SALIDA, { recursive: true, force: true })
  mkdirSync(SALIDA, { recursive: true })

  for (const nombre of ARCHIVOS_DEL_PAQUETE) {
    const origen = join(EXT, nombre)
    if (!existsSync(origen)) {
      console.error(`\n✗ Falta ${nombre} en el runtime canónico.\n`)
      process.exit(1)
    }
    const destino = join(SALIDA, nombre)
    mkdirSync(dirname(destino), { recursive: true })
    if (nombre === 'manifest.json') {
      // ÚNICA diferencia con lo que se publica: se agrega `key`. Nada más.
      const m = JSON.parse(readFileSync(origen, 'utf8'))
      if (m.key) { console.error('\n✗ El manifest canónico YA tiene `key`. No debería.\n'); process.exit(1) }
      writeFileSync(destino, JSON.stringify({ ...m, key: base64 }, null, 2) + '\n', 'utf8')
    } else {
      copyFileSync(origen, destino)
    }
  }

  console.log(`\n✓ copia dev en  ${SALIDA}`)
  console.log(`  ID que Chrome debería asignarle: ${id}`)
  console.log(`\n  Cargala con: chrome://extensions → Modo de desarrollador → Cargar descomprimida\n`)
  return { ruta: SALIDA, id }
}

const ejecutadoDirectamente =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (ejecutadoDirectamente) {
  construir(resolve(process.argv[2] ?? KEY_POR_DEFECTO))
}
