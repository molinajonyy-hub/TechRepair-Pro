#!/usr/bin/env node
// ============================================================================
// Genera los íconos del Companion a partir del logo CANÓNICO de TechRepair Pro.
//
//   node scripts/companion/generar-iconos.mjs
//
// Fuente: src/assets/logo.svg — el mismo archivo que usa el Sidebar de la app
// (src/components/layout/Sidebar.tsx). No se inventa una marca nueva y no se usa
// ninguna iconografía de WhatsApp ni de Meta: la extensión no está afiliada a
// ellos y el ícono no puede insinuar lo contrario.
//
// Salidas, en tools/whatsapp-companion/icons/:
//   icon16.png icon32.png icon48.png icon128.png   → los que declara el manifest
//   store-icon-128.png                             → para la FICHA del Store,
//     con el arte dentro de 96×96 y 16 px de padding transparente por lado, que
//     es lo que pide Chrome Web Store. NO va en el ZIP: se sube por el dashboard.
//
// Se rasteriza con el Chromium de Playwright, que ya es dependencia del repo.
// El script es idempotente: volver a correrlo reproduce los mismos archivos.
// ============================================================================
import { chromium } from '@playwright/test'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FUENTE = join(RAIZ, 'src', 'assets', 'logo.svg')
const DESTINO = join(RAIZ, 'tools', 'whatsapp-companion', 'icons')

/** Tamaños que declara el manifest. El 128 es el que exige el Store. */
const TAMANOS = [16, 32, 48, 128]

const svg = readFileSync(FUENTE, 'utf-8')
mkdirSync(DESTINO, { recursive: true })

const navegador = await chromium.launch()
const pagina = await navegador.newPage()

/**
 * Rasteriza el SVG en un lienzo de `lienzo` px con el arte ocupando `arte` px,
 * centrado. Fondo transparente: `omitBackground` deja el alpha intacto, así el
 * ícono se ve bien sobre fondo claro y oscuro.
 */
async function rasterizar(lienzo, arte, salida) {
  const margen = (lienzo - arte) / 2
  await pagina.setViewportSize({ width: lienzo, height: lienzo })
  await pagina.setContent(
    `<!doctype html><meta charset="utf-8">
     <style>
       html,body { margin:0; padding:0; background:transparent; }
       #lienzo { width:${lienzo}px; height:${lienzo}px; display:block; position:relative; }
       #lienzo svg { position:absolute; left:${margen}px; top:${margen}px;
                     width:${arte}px; height:${arte}px; display:block; }
     </style>
     <div id="lienzo">${svg}</div>`,
    { waitUntil: 'load' },
  )
  const png = await pagina.locator('#lienzo').screenshot({ omitBackground: true })
  writeFileSync(salida, png)
  return png.length
}

console.log(`\nfuente: ${FUENTE.replace(RAIZ, '.')}\n`)

for (const n of TAMANOS) {
  const salida = join(DESTINO, `icon${n}.png`)
  const bytes = await rasterizar(n, n, salida)
  console.log(`  icon${String(n).padEnd(3)} ${String(n).padStart(3)}×${n}  ${String(bytes).padStart(6)} B`)
}

// Ícono de la FICHA: 128×128 con el arte en 96×96 y padding transparente.
const bytesStore = await rasterizar(128, 96, join(DESTINO, 'store-icon-128.png'))
console.log(`  store-icon-128  128×128 (arte 96×96)  ${String(bytesStore).padStart(6)} B  ← ficha del Store, NO va en el ZIP`)

await navegador.close()
console.log('\nlisto.\n')
