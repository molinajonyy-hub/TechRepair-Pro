// BETA-UX-3 — láminas «antes | después» a partir de las capturas de capture.mjs
// (una corrida sobre `main`, otra sobre la rama).
//
// Uso: node contact-sheet.mjs <root> <dirAntes> <dirDespues> <dirSalida>
// CHROMIUM_PATH (opcional): un Chromium ya instalado.
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const [root, antes, despues, salida] = process.argv.slice(2)
const { chromium } = await import(pathToFileURL(path.join(root, 'node_modules', 'playwright-core/index.mjs')).href)
fs.mkdirSync(salida, { recursive: true })

const dataUrl = file => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
/** Recorte: `w` es el ancho mostrado; `h` recorta el alto (en px mostrados). */
const img = (dir, file, w, h, escala = 1) =>
  `<div class="recorte" style="width:${w}px;${h ? `height:${h}px` : ''}"><img src="${dataUrl(path.join(dir, file))}" style="width:${Math.round(w * escala)}px"></div>`

const CSS = `
  body { margin: 0; padding: 24px; background: #f1f5f9; font: 14px/1.4 system-ui, sans-serif; color: #0f172a; }
  h1 { margin: 0 0 4px; font-size: 18px; } p.nota { margin: 0 0 16px; color: #475569; max-width: 1200px; }
  section { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; margin-bottom: 16px; }
  h2 { margin: 0 0 10px; font-size: 14px; }
  .par { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
  figure { margin: 0; } figcaption { margin-bottom: 6px; font-size: 12px; font-weight: 700; color: #475569; }
  .recorte { overflow: hidden; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; }
  .recorte img { display: block; }`

async function lamina(nombre, titulo, nota, cuerpo, ancho = 1400) {
  const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style><main style="width:${ancho - 48}px"><h1>${esc(titulo)}</h1><p class="nota">${esc(nota)}</p>${cuerpo}</main>`
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
  const page = await browser.newPage({ viewport: { width: ancho, height: 900 }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.locator('main').screenshot({ path: path.join(salida, nombre) })
  await browser.close()
  console.log('OK', nombre)
}

const par = (titulo, archivoAntes, archivoDespues, w, h) => `
  <section><h2>${esc(titulo)}</h2><div class="par">
    <figure><figcaption>Antes · main</figcaption>${img(antes, `before-${archivoAntes}`, w, h)}</figure>
    <figure><figcaption>Después · BETA-UX-3</figcaption>${img(despues, `after-${archivoDespues}`, w, h)}</figure>
  </div></section>`
const mismo = (titulo, archivo, w, h) => par(titulo, archivo, archivo, w, h)

// 1. Menú lateral por rol: la sección Administración.
await lamina('01-menu-administracion.png', 'Menú lateral · Administración por rol',
  'Antes: seis entradas sueltas (Usuarios, Configuración, Moneda, Suscripción, Tutoriales, Ayuda). Después: «Configuración» (con Usuarios, Moneda y Suscripción adentro) y «Centro de ayuda». El técnico, sin capacidades de configuración, ve sólo el Centro de ayuda.',
  `<div class="par">${[['Dueño', 'sidebar-owner.png'], ['Administrador (sin suscripción)', 'sidebar-admin.png'], ['Técnico', 'sidebar-tech.png']]
    .map(([t, f]) => mismo(t, f, 200, 780)).join('')}</div>`)

// 2. Configuración en escritorio: las pantallas sueltas pasan a vivir en el marco.
await lamina('02-configuracion-escritorio.png', 'Configuración · Usuarios, Moneda y Suscripción dentro de la navegación agrupada (1440 px)',
  'Misma ruta y mismo guard de siempre (/users, /currency-settings, /subscription); ahora se dibujan dentro de Configuración, con la sección marcada en la lista. Seis grupos: Negocio (con Moneda y cotización) · Equipo · Facturación · Cobros · Documentos y mensajes · TechRepair Pro.',
  mismo('Usuarios → Equipo › Usuarios y permisos', 'usuarios-desktop.png', 640, 400)
  + mismo('Suscripción → TechRepair Pro › Plan y suscripción', 'suscripcion-desktop.png', 640, 400)
  + mismo('Moneda → Negocio › Moneda y cotización', 'moneda-desktop.png', 640, 400))

await lamina('03-configuracion-lista-y-roles.png', 'Configuración · lista completa y filtro por capacidad',
  'Izquierda: el dueño ve las trece secciones (la lista entra en 1440×900). Derecha: el administrador no tiene la capacidad `subscription`, así que «TechRepair Pro» no aparece. Abajo: 1280 px, el ancho de escritorio más angosto; la tabla de usuarios scrollea en su tarjeta en vez de recortarse.',
  mismo('Dueño · /settings', 'configuracion-desktop.png', 640, 400)
  + mismo('Administrador · /settings', 'configuracion-admin-desktop.png', 640, 400)
  + mismo('1280 px · /users', 'usuarios-1280.png', 640, 400))

// 3. Centro de ayuda.
await lamina('04-centro-de-ayuda.png', 'Centro de ayuda · Soporte + Tutoriales',
  'Antes: «Ayuda» (sólo el botón de WhatsApp) y «Tutoriales» eran dos pantallas y dos entradas del menú. Después: una sola, con el canal de soporte de siempre y el catálogo de tutoriales (guías y, cuando haya, videos). /tutorials redirige a la sección Tutoriales.',
  par('/ayuda', 'ayuda-desktop.png', 'ayuda-desktop.png', 640, 400)
  + par('/tutorials', 'tutoriales-desktop.png', 'tutoriales-desktop.png', 640, 400)
  + par('Tema oscuro · /ayuda', 'ayuda-desktop-dark.png', 'ayuda-desktop-dark.png', 640, 400))

// 4. Celular.
await lamina('05-celular.png', 'Celular (390 px)',
  'Drawer «Más»: Administración pasa de seis a dos entradas. Configuración: lista agrupada → sección a pantalla completa con «‹ Secciones». Centro de ayuda: Soporte arriba y Tutoriales abajo.',
  `<div class="par">${[['«Más»', 'mas-mobile.png'], ['/settings (lista)', 'configuracion-mobile.png'], ['/users', 'usuarios-mobile.png'], ['/ayuda', 'ayuda-mobile.png']]
    .map(([t, f]) => mismo(t, f, 200, 520)).join('')}</div>`, 1840)
