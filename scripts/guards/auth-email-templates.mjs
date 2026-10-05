#!/usr/bin/env node
// ============================================================================
// GUARD — PRE-BETA-2D · plantillas de correo de Auth + config local + soporte
//
// Las plantillas versionadas (supabase/templates/*.html) son lo que se pega en
// Supabase Auth de producción y lo que el stack LOCAL ya usa. Un typo en el
// enlace rompe TODAS las confirmaciones o recoveries, y un link reescrito por
// tracking los entrega a un tercero. Este guard fija el contrato:
//
//   T1 enlace        confirmation: {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup
//                    recovery:     {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery
//   T2 sin legacy    ni {{ .ConfirmationURL }} ni {{ .SiteURL }} ni {{ .Token }} (OTP)
//   T3 sin terceros  ningún <img>; la ÚNICA URL http(s) literal y los ÚNICOS
//                    href son el enlace de Auth y el WhatsApp de soporte
//   T4 soporte       la ayuda es el WhatsApp CANÓNICO: número, mensaje fijo y
//                    codificación exactos. Ningún `mailto:`, ninguna casilla
//                    de correo, ningún otro destino de WhatsApp
//   T5 copy          nombra «TechRepair Pro» y pide ignorar el correo si no se
//                    pidió la acción
//   C1 config local  [local_smtp] (no [inbucket]), mínimo 8, y las dos
//                    plantillas cableadas en supabase/config.toml
//   S1 soporte src   ninguna casilla @techrepairpro.com en src/ (dominio sin MX)
//
// BETA-UX-1A cambió T3/T4. Antes el soporte visible era el `mailto:` de
// CONTACTO_SOPORTE; el owner confirmó que esa casilla NO es un canal de soporte
// atendido (es el contacto institucional/legal), así que no puede volver a estas
// plantillas ni como enlace ni como texto.
//
// ── El número vive ACÁ, no en una variable de entorno ───────────────────────
// Supabase Auth (GoTrue) renderiza un HTML estático: no puede leer
// VITE_CONTACT_WHATSAPP. El WhatsApp de soporte es un dato PÚBLICO versionado en
// las dos plantillas y en `WHATSAPP_SOPORTE` de este archivo, y tiene que ser el
// mismo valor que esa variable en Vercel. Si el número cambia: cambiar la
// variable, las dos plantillas y esta constante, y volver a pegar las plantillas
// en producción (docs/beta-ux-1/beta-ux-1a-support-channel.md).
//
//   node scripts/guards/auth-email-templates.mjs
//   node scripts/guards/auth-email-templates.mjs --self-test
// ============================================================================
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * WhatsApp de soporte escrito en las plantillas. Mismo formato que exige la app
 * (`validarWhatsAppSoporte`, src/config/contacto.ts): 54 + 9 + 10 dígitos.
 */
export const WHATSAPP_SOPORTE = '5493574404419'

/** `ayuda` es el mensaje precargado: texto fijo, sin datos del usuario. */
export const PLANTILLAS = {
  confirmation: {
    archivo: 'supabase/templates/confirmation.html',
    tipo: 'signup',
    ayuda: 'Hola, necesito ayuda para confirmar mi correo en TechRepair Pro.',
  },
  recovery: {
    archivo: 'supabase/templates/recovery.html',
    tipo: 'recovery',
    ayuda: 'Hola, necesito ayuda para restablecer mi contraseña de TechRepair Pro.',
  },
}

const enlaceDe = (tipo) => `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=${tipo}`

/** Enlace de ayuda EXACTO de la plantilla de ese tipo (`signup` | `recovery`). */
export function enlaceSoporteDe(tipo) {
  const plantilla = Object.values(PLANTILLAS).find(p => p.tipo === tipo)
  return `https://wa.me/${WHATSAPP_SOPORTE}?text=${encodeURIComponent(plantilla.ayuda)}`
}

/** Lee CONTACTO_SOPORTE del código fuente: la casilla institucional, que NO es soporte. */
export function contactoDesdeFuente(src) {
  return src.match(/export const CONTACTO_SOPORTE\s*=\s*'([^']+)'/)?.[1] ?? null
}

/** Hallazgos de las constantes de este guard. Pura. */
export function analizarContrato(numero = WHATSAPP_SOPORTE, plantillas = PLANTILLAS) {
  const out = []
  if (!/^549\d{10}$/.test(numero)) out.push('T4 el WhatsApp versionado no es un celular argentino (549 + 10 dígitos)')
  for (const [nombre, { ayuda }] of Object.entries(plantillas)) {
    if (!/^Hola, [^@\d{}$<>]+\.$/.test(ayuda)) out.push(`T4 el mensaje de ayuda de ${nombre} no es un texto fijo sin datos`)
  }
  return out
}

/**
 * Hallazgos de una plantilla. Pura.
 * `institucional` es CONTACTO_SOPORTE: sólo se usa para nombrarla si reaparece.
 */
export function analizarPlantilla(html, tipo, institucional) {
  const out = []
  const enlace = enlaceDe(tipo)
  const soporte = enlaceSoporteDe(tipo)

  if (!html.includes(`href="${enlace}"`)) out.push(`T1 falta el enlace exacto ${enlace}`)
  for (const otro of Object.values(PLANTILLAS).map(p => p.tipo).filter(t => t !== tipo)) {
    if (html.includes(`type=${otro}`)) out.push(`T1 trae el tipo de otra plantilla (type=${otro})`)
  }
  if (/\{\{\s*\.ConfirmationURL\s*\}\}/.test(html)) out.push('T2 usa {{ .ConfirmationURL }} (legacy, lo consume un escáner)')
  if (/\{\{\s*\.SiteURL\s*\}\}/.test(html)) out.push('T2 usa {{ .SiteURL }}: el destino tiene que ser .RedirectTo')
  if (/\{\{\s*\.Token\s*\}\}/.test(html)) out.push('T2 expone el OTP {{ .Token }}')

  // T3 — la única URL literal admitida es el WhatsApp canónico, completo y exacto.
  const urls = [...html.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map(m => m[0])
  for (const u of new Set(urls)) {
    if (u !== soporte) out.push(`T3 URL http(s) que no es el WhatsApp de soporte canónico (tracking, imagen o dominio ajeno): ${u.slice(0, 60)}`)
  }
  if (/<img\b/i.test(html)) out.push('T3 contiene <img>')
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1])
  for (const h of hrefs) {
    if (h === enlace || h === soporte) continue
    out.push(/^mailto:/i.test(h)
      ? 'T4 un mailto como ayuda: el soporte de estas plantillas es WhatsApp'
      : `T3 href no permitido: ${h.slice(0, 60)}`)
  }

  // T4 — la ayuda es el WhatsApp canónico y nada más.
  if (!hrefs.includes(soporte)) {
    out.push('T4 falta el enlace de ayuda al WhatsApp canónico (número, mensaje fijo y codificación exactos)')
  }
  if (/mailto:/i.test(html) && !hrefs.some(h => /^mailto:/i.test(h))) out.push('T4 contiene un mailto')
  const emails = new Set([...html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map(m => m[0]))
  for (const e of emails) {
    out.push(e === institucional
      ? 'T4 volvió la casilla institucional (CONTACTO_SOPORTE): no es un canal de soporte atendido'
      : `T4 casilla de correo en la plantilla: ${e}`)
  }
  if (/api\.whatsapp\.com|web\.whatsapp\.com|whatsapp:\/\//i.test(html)) out.push('T4 destino de WhatsApp que no es wa.me')
  const waMe = (html.match(/wa\.me\//gi) ?? []).length
  const canonicos = html.split(soporte).length - 1
  if (waMe !== canonicos) out.push('T4 hay un wa.me que no es el canónico (otro número, otro mensaje o datos interpolados)')

  if (!html.includes('TechRepair Pro')) out.push('T5 no nombra «TechRepair Pro»')
  if (!/ignorá este correo/i.test(html)) out.push('T5 falta la advertencia de ignorar el correo si no se pidió')
  return out
}

/** Hallazgos del config.toml LOCAL. Pura. */
export function analizarConfig(toml) {
  const out = []
  if (!/^\[local_smtp\]\s*$/m.test(toml)) out.push('C1 falta [local_smtp]')
  if (/^\[inbucket\]\s*$/m.test(toml)) out.push('C1 sigue usando [inbucket] (deprecado)')
  if (!/^minimum_password_length = 8$/m.test(toml)) out.push('C1 minimum_password_length local no es 8')
  for (const [nombre, { archivo }] of Object.entries(PLANTILLAS)) {
    const bloque = toml.split(new RegExp(`^\\[auth\\.email\\.template\\.${nombre}\\]\\s*$`, 'm'))[1]?.split(/^\[/m)[0] ?? ''
    if (!bloque.includes(`content_path = "./${archivo}"`)) out.push(`C1 la plantilla ${nombre} no apunta a ${archivo}`)
    if (!/subject = "[^"]*TechRepair Pro"/.test(bloque)) out.push(`C1 el asunto de ${nombre} no nombra TechRepair Pro`)
  }
  return out
}

function archivosSrc(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...archivosSrc(p))
    else if (/\.(ts|tsx|html|css)$/.test(p)) out.push(p)
  }
  return out
}

/** Casillas del dominio `.com` (sin MX, no es del producto). Pura. */
export function analizarSoporteSrc(src) {
  return /@techrepairpro\.com\b/i.test(src) ? ['S1 casilla @techrepairpro.com (dominio sin MX): usar CONTACTO_SOPORTE'] : []
}

export function validar(raiz) {
  const hallazgos = []
  for (const d of analizarContrato()) hallazgos.push({ archivo: 'scripts/guards/auth-email-templates.mjs', detalle: d })
  const contactoPath = join(raiz, 'src/config/contacto.ts')
  const institucional = existsSync(contactoPath) ? contactoDesdeFuente(readFileSync(contactoPath, 'utf8')) : null
  if (!institucional) hallazgos.push({ archivo: 'src/config/contacto.ts', detalle: 'T4 no se pudo leer CONTACTO_SOPORTE (la casilla que NO debe aparecer)' })
  for (const [nombre, { archivo, tipo }] of Object.entries(PLANTILLAS)) {
    const p = join(raiz, archivo)
    if (!existsSync(p)) { hallazgos.push({ archivo, detalle: `falta la plantilla ${nombre}` }); continue }
    for (const d of analizarPlantilla(readFileSync(p, 'utf8'), tipo, institucional)) hallazgos.push({ archivo, detalle: d })
  }
  const toml = join(raiz, 'supabase/config.toml')
  if (existsSync(toml)) for (const d of analizarConfig(readFileSync(toml, 'utf8'))) hallazgos.push({ archivo: 'supabase/config.toml', detalle: d })
  else hallazgos.push({ archivo: 'supabase/config.toml', detalle: 'no existe' })
  const src = join(raiz, 'src')
  if (existsSync(src)) {
    for (const p of archivosSrc(src)) {
      for (const d of analizarSoporteSrc(readFileSync(p, 'utf8'))) hallazgos.push({ archivo: relative(raiz, p).replace(/\\/g, '/'), detalle: d })
    }
  }
  return hallazgos
}

// ── Self-test: cada regla caza su defecto y la plantilla buena pasa ──────────
function selfTest() {
  // Casilla sintética en el rol de CONTACTO_SOPORTE (la institucional).
  const C = 'institucional-sintetica@example.test'
  const buena = (tipo) => `<html><body><p>TechRepair Pro</p>
    <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=${tipo}">Seguir</a>
    <p>Si no lo pediste, ignorá este correo.</p>
    <p>¿Necesitás ayuda? <a href="${enlaceSoporteDe(tipo)}">Escribinos por WhatsApp</a>.</p></body></html>`
  const S = enlaceSoporteDe('signup')
  const conAyuda = (ayuda) => buena('signup').replace(`<a href="${S}">Escribinos por WhatsApp</a>`, ayuda)
  const conEnlace = (href) => buena('signup').replace(S, href)

  const casos = [
    ['confirmación correcta', buena('signup'), 'signup', 0],
    ['recovery correcta', buena('recovery'), 'recovery', 0],
    ['ConfirmationURL legacy', buena('signup').replace('{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup', '{{ .ConfirmationURL }}'), 'signup', 2],
    ['tipo equivocado', buena('recovery'), 'signup', 1],
    ['dominio de tracking', buena('signup').replace('Seguir</a>', 'Seguir</a><a href="https://click.tracker.example/x">x</a>'), 'signup', 1],
    ['imagen remota', buena('signup').replace('<p>TechRepair Pro</p>', '<p>TechRepair Pro</p><img src="https://cdn.example/logo.png">'), 'signup', 1],
    ['SiteURL', buena('signup').replace('{{ .RedirectTo }}', '{{ .SiteURL }}'), 'signup', 1],
    ['sin advertencia', buena('signup').replace('ignorá este correo', 'gracias'), 'signup', 1],
    ['sin marca', buena('signup').replace('TechRepair Pro</p>', 'Acme</p>'), 'signup', 1],
    // BETA-UX-1A — la ayuda es el WhatsApp canónico, nunca un correo.
    ['ayuda por mailto a la casilla institucional (el pie anterior)', conAyuda(`Escribinos a <a href="mailto:${C}">${C}</a>`), 'signup', 3],
    ['casilla institucional como texto, sin enlace', conAyuda(`Escribinos a ${C}`), 'signup', 2],
    ['WhatsApp MÁS la casilla institucional', buena('signup').replace('</body>', `<p>O escribinos a ${C}</p></body>`), 'signup', 1],
    ['WhatsApp MÁS un mailto a otra casilla', buena('signup').replace('</body>', '<a href="mailto:otra@example.test">correo</a></body>'), 'signup', 2],
    ['sin ningún enlace de ayuda', conAyuda('Escribinos'), 'signup', 1],
    ['WhatsApp a otro número', conEnlace(S.replace(WHATSAPP_SOPORTE, '5491100000000')), 'signup', 2],
    ['WhatsApp con la transposición 594', conEnlace(S.replace('wa.me/549', 'wa.me/594')), 'signup', 2],
    ['WhatsApp con + delante del número', conEnlace(S.replace('wa.me/', 'wa.me/+')), 'signup', 2],
    ['WhatsApp sin mensaje', conEnlace(`https://wa.me/${WHATSAPP_SOPORTE}`), 'signup', 2],
    ['mensaje sin codificar', conEnlace(`https://wa.me/${WHATSAPP_SOPORTE}?text=${PLANTILLAS.confirmation.ayuda}`), 'signup', 2],
    ['mensaje con datos del usuario', conEnlace(`${S}%20{{ .Email }}`), 'signup', 2],
    ['mensaje de la otra plantilla', conEnlace(enlaceSoporteDe('recovery')), 'signup', 2],
    ['WhatsApp con parámetros de tracking', conEnlace(`${S}&utm_source=email`), 'signup', 2],
    ['WhatsApp por api.whatsapp.com', conEnlace(`https://api.whatsapp.com/send?phone=${WHATSAPP_SOPORTE}`), 'signup', 2],
    ['WhatsApp por http', conEnlace(S.replace('https://', 'http://')), 'signup', 2],
  ]
  let malos = 0
  for (const [etiqueta, html, tipo, minimo] of casos) {
    const h = analizarPlantilla(html, tipo, C)
    const ok = minimo === 0 ? h.length === 0 : h.length >= minimo
    if (!ok) malos++
    console.log(`  ${ok ? 'OK  ' : 'MAL '} ${etiqueta} (esperado ${minimo === 0 ? 'PASA' : 'FALLA'}, dio ${h.length ? `FALLA ×${h.length}` : 'PASA'})`)
  }

  const nombraLaCasilla = analizarPlantilla(conAyuda(`Escribinos a ${C}`), 'signup', C).some(d => /casilla institucional/.test(d))
  if (!nombraLaCasilla) malos++
  console.log(`  ${nombraLaCasilla ? 'OK  ' : 'MAL '} si vuelve la casilla institucional, el hallazgo lo dice`)

  const contratos = [
    ['contrato vigente', WHATSAPP_SOPORTE, PLANTILLAS, 0],
    ['número con la transposición 594', '5943574404419', PLANTILLAS, 1],
    ['número sin el 9 de celular', '543574404419', PLANTILLAS, 1],
    ['número con +', `+${WHATSAPP_SOPORTE}`, PLANTILLAS, 1],
    ['mensaje con un marcador para interpolar', WHATSAPP_SOPORTE, { x: { ayuda: 'Hola, soy {{ .Email }}.' } }, 1],
    ['mensaje con una casilla', WHATSAPP_SOPORTE, { x: { ayuda: 'Hola, soy a@b.test.' } }, 1],
  ]
  for (const [etiqueta, numero, plantillas, minimo] of contratos) {
    const h = analizarContrato(numero, plantillas)
    const ok = minimo === 0 ? h.length === 0 : h.length >= minimo
    if (!ok) malos++
    console.log(`  ${ok ? 'OK  ' : 'MAL '} ${etiqueta} (esperado ${minimo === 0 ? 'PASA' : 'FALLA'}, dio ${h.length ? `FALLA ×${h.length}` : 'PASA'})`)
  }
  const codificado = Object.values(PLANTILLAS).every(({ tipo, ayuda }) => {
    const url = new URL(enlaceSoporteDe(tipo))
    return url.origin === 'https://wa.me' && url.pathname === `/${WHATSAPP_SOPORTE}`
      && url.searchParams.get('text') === ayuda && [...url.searchParams.keys()].length === 1
      && /^[A-Za-z0-9%.,_~!*'()-]+$/.test(url.search.slice('?text='.length))
  })
  if (!codificado) malos++
  console.log(`  ${codificado ? 'OK  ' : 'MAL '} el enlace canónico va URL-encoded y WhatsApp recibe exactamente el mensaje fijo`)

  const tomlBueno = `[local_smtp]\nport = 1\nminimum_password_length = 8\n[auth.email.template.confirmation]\nsubject = "Confirmá — TechRepair Pro"\ncontent_path = "./supabase/templates/confirmation.html"\n[auth.email.template.recovery]\nsubject = "Restablecé — TechRepair Pro"\ncontent_path = "./supabase/templates/recovery.html"\n`
  const configs = [
    ['config correcto', tomlBueno, 0],
    ['config con [inbucket]', tomlBueno.replace('[local_smtp]', '[inbucket]'), 2],
    ['config con mínimo 6', tomlBueno.replace('= 8', '= 6'), 1],
    ['config sin plantilla de recovery', tomlBueno.replace('./supabase/templates/recovery.html', './otra.html'), 1],
  ]
  for (const [etiqueta, toml, minimo] of configs) {
    const h = analizarConfig(toml)
    const ok = minimo === 0 ? h.length === 0 : h.length >= minimo
    if (!ok) malos++
    console.log(`  ${ok ? 'OK  ' : 'MAL '} ${etiqueta} (esperado ${minimo === 0 ? 'PASA' : 'FALLA'}, dio ${h.length ? `FALLA ×${h.length}` : 'PASA'})`)
  }
  const s1 = analizarSoporteSrc("<p>Escribinos a soporte@techrepairpro.com</p>").length === 1 && analizarSoporteSrc(`<p>${C}</p>`).length === 0
  if (!s1) malos++
  console.log(`  ${s1 ? 'OK  ' : 'MAL '} soporte en src/ (caza @techrepairpro.com, deja pasar el canónico)`)
  const lee = contactoDesdeFuente("export const CONTACTO_SOPORTE = 'x@example.test'") === 'x@example.test'
  if (!lee) malos++
  console.log(`  ${lee ? 'OK  ' : 'MAL '} lee CONTACTO_SOPORTE del fuente`)

  if (malos) {
    console.error(`\nSELF-TEST FALLIDO: ${malos} caso(s).`)
    process.exit(1)
  }
  console.log('\nself-test OK: el guard caza enlaces legacy, tracking, un correo como ayuda, un WhatsApp que no es el canónico y config local vieja.')
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const esCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (esCli) {
  if (process.argv.includes('--self-test')) {
    selfTest()
    process.exit(0)
  }
  const hallazgos = validar(process.cwd())
  if (hallazgos.length) {
    for (const h of hallazgos) console.error(`  ${h.archivo}  ${h.detalle}`)
    console.error(
      `\nGUARD auth-email-templates: ${hallazgos.length} hallazgo(s).\n` +
      'Las plantillas son las que se pegan en Supabase Auth de producción: un enlace roto rompe TODAS las\n' +
      'confirmaciones o recoveries, y la ayuda tiene que llegar a un canal atendido (WhatsApp).\n' +
      'Ver docs/beta-ux-1/beta-ux-1a-support-channel.md y docs/pre-beta-2/pre-beta-2d-auth-ux-tokenhash.md.',
    )
    process.exit(1)
  }
  console.log('GUARD auth-email-templates: OK — plantillas token_hash, ayuda por el WhatsApp canónico (sin correo) y config local al día.')
}
