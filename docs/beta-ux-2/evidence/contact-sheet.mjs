// BETA-UX-2 — láminas «antes | después» a partir de las capturas de capture.mjs
// (una corrida sobre `main`, otra sobre la rama).
//
// Uso: node contact-sheet.mjs <root> <dirAntes> <dirDespues> <dirSalida>
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const [root, antes, despues, salida] = process.argv.slice(2)
const { chromium } = await import(pathToFileURL(path.join(root, 'node_modules', 'playwright-core/index.mjs')).href)
fs.mkdirSync(salida, { recursive: true })

const dataUrl = file => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const img = (dir, file, w, h) => `<div class="recorte" style="width:${w}px;${h ? `height:${h}px` : ''}"><img src="${dataUrl(path.join(dir, file))}" style="width:${w}px"></div>`

const CSS = `
  body { margin: 0; padding: 24px; background: #f1f5f9; font: 14px/1.4 system-ui, sans-serif; color: #0f172a; }
  h1 { margin: 0 0 4px; font-size: 18px; } p.nota { margin: 0 0 16px; color: #475569; }
  section { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; margin-bottom: 16px; }
  h2 { margin: 0 0 10px; font-size: 14px; }
  .par { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
  figure { margin: 0; } figcaption { margin-bottom: 6px; font-size: 12px; font-weight: 700; color: #475569; }
  .recorte { overflow: hidden; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; }
  .recorte img { display: block; }
  .tira { display: flex; gap: 8px; flex-wrap: wrap; }
  .tira figure figcaption { font-weight: 600; }`

async function lamina(nombre, titulo, nota, cuerpo, ancho = 1400) {
  const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style><main style="width:${ancho - 48}px"><h1>${esc(titulo)}</h1><p class="nota">${esc(nota)}</p>${cuerpo}</main>`
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: ancho, height: 900 }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.locator('main').screenshot({ path: path.join(salida, nombre) })
  await browser.close()
  console.log('OK', nombre)
}

const par = (titulo, archivo, w, h) => `
  <section><h2>${esc(titulo)}</h2><div class="par">
    <figure><figcaption>Antes · main</figcaption>${img(antes, `before-${archivo}`, w, h)}</figure>
    <figure><figcaption>Después · BETA-UX-2</figcaption>${img(despues, `after-${archivo}`, w, h)}</figure>
  </div></section>`

// 1. Encabezados en escritorio: el recorte muestra barra superior, encabezado y primer bloque.
await lamina('01-encabezados-escritorio.png', 'Encabezado de página · escritorio (1440 px)',
  'Antes: ícono de 44px con gradiente (Órdenes), 40px plano (Inicio, Gastos) o 36px armado a mano (Comprobantes); las pantallas con .page-shell arrancaban 24px más abajo y 32px más adentro. Después: un solo patrón (AppPageHeader), ícono de 48px y misma columna en todas.',
  [['Inicio', 'dashboard-desktop.png'], ['Órdenes de Trabajo (referencia)', 'orders-desktop.png'], ['Comprobantes', 'comprobantes-desktop.png'],
   ['Caja', 'caja-desktop.png'], ['Gastos', 'expenses-desktop.png'], ['Proveedores', 'suppliers-desktop.png']]
    .map(([t, f]) => par(t, f, 640, 190)).join(''))

// 2. Encabezados en el celular.
await lamina('02-encabezados-celular.png', 'Encabezado de página · celular (390 px)',
  'Antes: Comprobantes, Tareas y Gastos perdían 16px por lado (padding doble) y usaban otro ícono. Después: margen y encabezado iguales a Órdenes.',
  `<div class="par">${[['Órdenes', 'orders-mobile.png'], ['Comprobantes', 'comprobantes-mobile.png'], ['Tareas', 'tasks-mobile.png'], ['Gastos', 'expenses-mobile.png']]
    .map(([t, f]) => par(t, f, 260, 420)).join('')}</div>`)

// 3. Configuración.
await lamina('03-configuracion.png', 'Configuración · navegación',
  'Antes: diez pestañas en dos filas, sin grupos, con íconos repetidos. Después: cuatro grupos (Negocio · Facturación · Cobros · Documentos y mensajes); en el celular, lista agrupada que abre la sección.',
  par('Escritorio', 'settings-desktop.png', 640, 480) + par('Celular', 'settings-mobile-full.png', 300, 900))

// 4. Recepción: diez pasos contra cuatro.
const tira = (prefijo, dir, n) => `<div class="tira">${Array.from({ length: n }, (_, i) => {
  const f = `${prefijo}-wizard-mobile-${String(i + 1).padStart(2, '0')}.png`
  return `<figure><figcaption>Paso ${i + 1}</figcaption>${img(dir, f, 120, 260)}</figure>`
}).join('')}</div>`
await lamina('04-recepcion-pasos.png', 'Nueva orden · cantidad de pasos (390 px)',
  'Antes: 10 pasos y una barra de progreso con gradiente, sin nombres. Después: 4 pasos con nombre (Cliente · Equipo · Ingreso · Confirmar) en un stepper; checklist plegado.',
  `<section><h2>Antes · main — 10 pasos</h2>${tira('before', antes, 10)}</section><section><h2>Después · BETA-UX-2 — 4 pasos</h2>${tira('after', despues, 4)}</section>`)

// 5. Recepción: el paso nuevo de Equipo en escritorio, y el resultado con un patrón 1-5-9.
await lamina('05-recepcion-escritorio.png', 'Nueva orden · escritorio (1440 px)',
  'Equipo y acceso en un solo paso; Ingreso con el checklist plegado; Confirmar con asignación, presupuesto y resumen.',
  `<div class="par">${[2, 3, 4].map(n => `<figure><figcaption>Después · paso ${n}</figcaption>${img(despues, `after-wizard-desktop-${String(n).padStart(2, '0')}.png`, 420, 640)}</figure>`).join('')}</div>`)

await lamina('06-patron-no-bloquea.png', 'Patrón 1-5-9 → «Crear orden»',
  'Antes: la grilla mandaba [1,5,9]; el servidor sólo acepta 0–8 y la creación fallaba con el código crudo INVALID_ACCESS_PATTERN. Después: viaja [0,4,8] y la orden se crea. (Backend simulado con la regla de private.mobile2a_legacy_from_access.)',
  par('Resultado de «Crear orden»', 'wizard-mobile-final.png', 300, 640))
