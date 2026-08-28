#!/usr/bin/env node
// ============================================================================
// MOBILE-PWA-0 — genera los íconos de instalación de TechRepair Pro.
//
//   node scripts/pwa/generar-iconos.mjs
//
// Fuente: src/assets/logo.svg — el logo CANÓNICO de TechRepair Pro, el mismo
// que usa el Sidebar (src/components/layout/Sidebar.tsx) y el mismo que ya
// toma scripts/companion/generar-iconos.mjs. No se inventa una marca nueva ni
// se recolorea nada: el gradiente índigo→violeta (#6366f1 → #8b5cf6) de la
// identidad Gestión sale tal cual del archivo fuente.
//
// NO se usan los íconos de Mi Guita (verdes): esa es otra identidad de producto
// y el sitio primario instala TechRepair Pro.
//
// Salidas, en public/icons/:
//
//   techrepair-192.png            manifest, purpose "any". Esquinas
//   techrepair-512.png            transparentes (el rx=22 del logo).
//
//   techrepair-maskable-512.png   manifest, purpose "maskable". A sangre, con
//                                 el arte al 80% para que entre en la zona
//                                 segura circular de Android (80% del lado).
//
//   apple-touch-icon-180.png      iOS. A sangre y OPACO: Safari ignora el alpha
//                                 y aplica su propia máscara superelíptica, así
//                                 que un PNG con esquinas transparentes se ve
//                                 con marco negro. 180px es el tamaño que pide
//                                 el iPhone @3x.
//
// Por qué PNG y no SVG: Safari NO soporta SVG en `apple-touch-icon`, y el
// manifest anterior declaraba sólo SVG. PNG funciona en iOS, Android y
// escritorio sin depender de la versión.
//
// Se rasteriza con el Chromium de Playwright, que ya es dependencia del repo
// (mismo enfoque que scripts/companion/generar-iconos.mjs). No se agrega
// ninguna dependencia nueva. El script es idempotente.
// ============================================================================
import { chromium } from '@playwright/test'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FUENTE = join(RAIZ, 'src', 'assets', 'logo.svg')
const DESTINO = join(RAIZ, 'public', 'icons')

/**
 * Gradiente de respaldo a sangre. Réplica EXACTA del `catGradient` de
 * logo.svg: mismos stops, misma diagonal. Cuando el arte va al 80% centrado,
 * los stops se corren a 10%/90% para que el tramo que cubre el arte coincida
 * punto por punto con el gradiente interno del SVG y no quede costura.
 */
function fondo(porcentajeArte) {
  const margen = (100 - porcentajeArte) / 2
  return `linear-gradient(to bottom right, #6366f1 ${margen}%, #8b5cf6 ${100 - margen}%)`
}

const svg = readFileSync(FUENTE, 'utf-8')
mkdirSync(DESTINO, { recursive: true })

const navegador = await chromium.launch()
const pagina = await navegador.newPage()

/**
 * @param {number} lienzo   lado del PNG en px
 * @param {number} arte     porcentaje del lienzo que ocupa el SVG (centrado)
 * @param {boolean} sangre  true = pinta el gradiente detrás y el PNG queda
 *                          opaco de borde a borde; false = esquinas transparentes
 */
async function rasterizar(lienzo, arte, sangre, salida) {
  const lado = (lienzo * arte) / 100
  const margen = (lienzo - lado) / 2
  await pagina.setViewportSize({ width: lienzo, height: lienzo })
  await pagina.setContent(
    `<!doctype html><meta charset="utf-8">
     <style>
       html,body { margin:0; padding:0; background:transparent; }
       #lienzo { width:${lienzo}px; height:${lienzo}px; display:block; position:relative;
                 ${sangre ? `background:${fondo(arte)};` : ''} }
       #lienzo svg { position:absolute; left:${margen}px; top:${margen}px;
                     width:${lado}px; height:${lado}px; display:block; }
     </style>
     <div id="lienzo">${svg}</div>`,
    { waitUntil: 'load' },
  )
  const png = await pagina.locator('#lienzo').screenshot({ omitBackground: !sangre })
  writeFileSync(salida, png)
  return png.length
}

const SALIDAS = [
  // archivo                        lienzo  arte%  sangre
  ['techrepair-192.png',               192,   100,  false],
  ['techrepair-512.png',               512,   100,  false],
  ['techrepair-maskable-512.png',      512,    80,   true],
  ['apple-touch-icon-180.png',         180,   100,   true],
]

console.log(`\nfuente: ${FUENTE.replace(RAIZ, '.')}\n`)

for (const [archivo, lienzo, arte, sangre] of SALIDAS) {
  const bytes = await rasterizar(lienzo, arte, sangre, join(DESTINO, archivo))
  const nota = sangre ? 'a sangre' : 'esquinas transparentes'
  console.log(`  ${archivo.padEnd(30)} ${String(lienzo).padStart(3)}×${lienzo}  arte ${arte}%  ${nota}  ${String(bytes).padStart(6)} B`)
}

await navegador.close()
console.log('\nlisto.\n')
