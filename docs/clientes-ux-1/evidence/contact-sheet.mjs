// CLIENTES-UX-1A — láminas «antes | después» a partir de las capturas de
// capture-1a.mjs (una corrida sobre `main`, otra sobre la rama).
//
// Uso: node contact-sheet.mjs <repoRoot> <dirCapturas> <dirSalida> [1b]
//   sin modo: láminas 01–02 (1A, edición). `1b`: láminas 03–05 (contacto y avisos);
//   en 1B el «antes» es la rama de 1A.
// CHROMIUM_PATH (opcional): un Chromium ya instalado.
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const [root, shots, salida, modo] = process.argv.slice(2)
const { chromium } = await import(pathToFileURL(path.join(root, 'node_modules', 'playwright-core/index.mjs')).href)
fs.mkdirSync(salida, { recursive: true })

const dataUrl = file => `data:image/png;base64,${fs.readFileSync(path.join(shots, file)).toString('base64')}`
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const img = (file, w, h) => `<div class="recorte" style="width:${w}px;${h ? `height:${h}px` : ''}"><img src="${dataUrl(file)}" style="width:${w}px"></div>`
const fig = (caption, file, w, h) => `<figure><figcaption>${esc(caption)}</figcaption>${img(file, w, h)}</figure>`

const CSS = `
  body { margin: 0; padding: 24px; background: #f1f5f9; font: 14px/1.4 system-ui, sans-serif; color: #0f172a; }
  h1 { margin: 0 0 4px; font-size: 18px; } p.nota { margin: 0 0 16px; color: #475569; max-width: 1300px; }
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

const section = (titulo, figs) => `<section><h2>${esc(titulo)}</h2><div class="par">${figs.join('')}</div></section>`

if (modo !== '1b') {
await lamina('01-ficha-editar-cliente.png', 'Ficha del cliente · «Editar cliente»',
  'Antes: la ficha no tenía ninguna forma de editar, y en el celular la grilla fija de 260 px dejaba las pestañas cortadas fuera de la pantalla. Después: «Editar cliente» abre el mismo diálogo que el listado; al guardar, un aviso confirma y la tarjeta Contacto muestra lo guardado (también documento y notas, que antes no se veían).',
  section('Escritorio · 1440 px', [
    fig('Antes · main', 'before-detalle-1440.png', 620, 380),
    fig('Después · ficha', 'after-detalle-1440.png', 620, 380),
    fig('Después · guardado', 'after-detalle-guardado-1440.png', 620, 380),
  ])
  + section('Celular · 390 px', [
    fig('Antes · main', 'before-detalle-390.png', 240, 520),
    fig('Después · ficha', 'after-detalle-390.png', 240, 520),
    fig('Después · editor', 'after-detalle-dialogo-390.png', 240, 520),
    fig('Después · guardado', 'after-detalle-guardado-390.png', 240, 520),
  ]), 1960)

await lamina('02-listado-y-mayorista.png', 'Listado · confirmación y mayorista del portal',
  'Arriba: guardar desde el listado cerraba el diálogo y nada decía si había quedado; ahora aparece «Cambios guardados en <cliente>». Abajo: un mayorista creado desde el portal sin razón social. Antes, el owner (con acceso a Mayorista) no podía ni corregirle el teléfono sin inventar una razón social —alguien sin ese acceso sí podía—; después se guarda y sigue mayorista, sin razón social inventada.',
  section('Guardar desde el listado · 1440 px', [
    fig('Antes · main', 'before-listado-despues-de-guardar-1440.png', 620, 330),
    fig('Después', 'after-listado-despues-de-guardar-1440.png', 620, 330),
  ])
  + section('Mayorista del portal sin razón social · cambiar el teléfono', [
    fig('Antes · main (bloqueado)', 'before-portal-mayorista-guardar-1440.png', 620, 380),
    fig('Después (guardado)', 'after-portal-mayorista-guardar-1440.png', 620, 380),
  ]))
}

if (modo === '1b') {
  await lamina('03-contacto-para-avisos.png', 'Contacto para avisos · alta, edición y ficha',
    'Una sección opcional en el formulario compartido (alta, edición y alta rápida desde Nueva orden): nombre y teléfono de otra persona a la que se le puede avisar. No es la «Persona de contacto» mayorista. La ficha lo muestra en la tarjeta Contacto.',
    section('Editar cliente · 1440 px', [
      fig('Antes · CLIENTES-UX-1A', 'before-editar-cliente-1440.png', 620, 400),
      fig('Después · CLIENTES-UX-1B', 'after-editar-cliente-1440.png', 620, 400),
    ])
    + section('Ficha del cliente', [fig('Después · guardado', 'after-ficha-1440.png', 620, 380)]))

  await lamina('04-recepcion-destinatario.png', 'Nueva orden · ¿A quién avisamos por WhatsApp?',
    'Si el cliente tiene contacto para avisos, la recepción ofrece elegir; por defecto, el teléfono principal. La elección queda en el resumen y se guarda en la orden. Sin contacto, la recepción no cambia.',
    section('Escritorio · 1440 px', [
      fig('Antes', 'before-recepcion-cliente-1440.png', 620, 420),
      fig('Después', 'after-recepcion-cliente-1440.png', 620, 420),
    ])
    + section('Celular · 390 px y resumen', [
      fig('Antes · 390', 'before-recepcion-cliente-390.png', 240, 520),
      fig('Después · 390', 'after-recepcion-cliente-390.png', 240, 520),
      fig('Después · resumen 1440', 'after-recepcion-resumen-1440.png', 620, 520),
    ]), 1600)

  await lamina('05-orden-y-whatsapp.png', 'Orden · Avisos por WhatsApp y preview',
    'La tarjeta Cliente dice a quién se avisa (rol, nombre y número) y permite cambiarlo. El preview de WhatsApp propone ese destinatario —«Para María Hija · Contacto alternativo»— y el número se sigue pudiendo corregir. No se envía nada automáticamente.',
    section('Tarjeta Cliente', [
      fig('Antes · 1440', 'before-orden-tarjeta-1440.png', 546, 300),
      fig('Después · 1440', 'after-orden-tarjeta-1440.png', 546, 300),
      fig('Después · 390', 'after-orden-390.png', 240, 520),
    ])
    + section('Preview de WhatsApp · 1440 px', [
      fig('Antes', 'before-whatsapp-1440.png', 620, 560),
      fig('Después', 'after-whatsapp-1440.png', 620, 560),
    ]), 1500)
}
