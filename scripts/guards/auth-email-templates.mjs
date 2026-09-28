#!/usr/bin/env node
// ============================================================================
// GUARD — PRE-BETA-2D · plantillas de correo de Auth + config local + soporte
//
// Las plantillas versionadas (supabase/templates/*.html) son lo que PRE-BETA-2E
// pega en producción y lo que el stack LOCAL ya usa. Un typo en el enlace rompe
// TODAS las confirmaciones o recoveries, y un link reescrito por tracking los
// entrega a un tercero. Este guard fija el contrato:
//
//   T1 enlace        confirmation: {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup
//                    recovery:     {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery
//   T2 sin legacy    ni {{ .ConfirmationURL }} ni {{ .SiteURL }} ni {{ .Token }} (OTP)
//   T3 sin terceros  ningún http(s):// literal (ni tracking, ni imágenes remotas),
//                    ningún <img>; los únicos href son el enlace de Auth y el
//                    mailto del soporte
//   T4 soporte       el contacto visible es EXACTAMENTE CONTACTO_SOPORTE
//                    (src/config/contacto.ts): GoTrue no puede importar TS, así
//                    que el literal se compara contra la constante
//   T5 copy          nombra «TechRepair Pro» y pide ignorar el correo si no se
//                    pidió la acción
//   C1 config local  [local_smtp] (no [inbucket]), mínimo 8, y las dos
//                    plantillas cableadas en supabase/config.toml
//   S1 soporte src   ninguna casilla @techrepairpro.com en src/ (dominio sin MX)
//
//   node scripts/guards/auth-email-templates.mjs
//   node scripts/guards/auth-email-templates.mjs --self-test
// ============================================================================
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLANTILLAS = {
  confirmation: { archivo: 'supabase/templates/confirmation.html', tipo: 'signup' },
  recovery: { archivo: 'supabase/templates/recovery.html', tipo: 'recovery' },
}

const enlaceDe = (tipo) => `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=${tipo}`

/** Lee CONTACTO_SOPORTE del código fuente (una sola fuente de verdad). */
export function contactoDesdeFuente(src) {
  return src.match(/export const CONTACTO_SOPORTE\s*=\s*'([^']+)'/)?.[1] ?? null
}

/** Hallazgos de una plantilla. Pura. */
export function analizarPlantilla(html, tipo, contacto) {
  const out = []
  const enlace = enlaceDe(tipo)
  if (!html.includes(`href="${enlace}"`)) out.push(`T1 falta el enlace exacto ${enlace}`)
  for (const otro of Object.values(PLANTILLAS).map(p => p.tipo).filter(t => t !== tipo)) {
    if (html.includes(`type=${otro}`)) out.push(`T1 trae el tipo de otra plantilla (type=${otro})`)
  }
  if (/\{\{\s*\.ConfirmationURL\s*\}\}/.test(html)) out.push('T2 usa {{ .ConfirmationURL }} (legacy, lo consume un escáner)')
  if (/\{\{\s*\.SiteURL\s*\}\}/.test(html)) out.push('T2 usa {{ .SiteURL }}: el destino tiene que ser .RedirectTo')
  if (/\{\{\s*\.Token\s*\}\}/.test(html)) out.push('T2 expone el OTP {{ .Token }}')
  if (/https?:\/\//i.test(html)) out.push('T3 contiene una URL http(s) literal (tracking, imagen o dominio ajeno)')
  if (/<img\b/i.test(html)) out.push('T3 contiene <img>')
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1])
  for (const h of hrefs) {
    if (h !== enlace && h !== `mailto:${contacto}`) out.push(`T3 href no permitido: ${h.slice(0, 60)}`)
  }
  if (!contacto) out.push('T4 no se pudo leer CONTACTO_SOPORTE de src/config/contacto.ts')
  else {
    if (!html.includes(contacto)) out.push('T4 falta el contacto de soporte canónico')
    const emails = [...html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map(m => m[0])
    for (const e of emails) if (e !== contacto) out.push(`T4 casilla distinta de CONTACTO_SOPORTE: ${e}`)
  }
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
  const contactoPath = join(raiz, 'src/config/contacto.ts')
  const contacto = existsSync(contactoPath) ? contactoDesdeFuente(readFileSync(contactoPath, 'utf8')) : null
  for (const [nombre, { archivo, tipo }] of Object.entries(PLANTILLAS)) {
    const p = join(raiz, archivo)
    if (!existsSync(p)) { hallazgos.push({ archivo, detalle: `falta la plantilla ${nombre}` }); continue }
    for (const d of analizarPlantilla(readFileSync(p, 'utf8'), tipo, contacto)) hallazgos.push({ archivo, detalle: d })
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
  const C = 'soporte-sintetico@example.test'
  const buena = (tipo) => `<html><body><p>TechRepair Pro</p>
    <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=${tipo}">Seguir</a>
    <p>Si no lo pediste, ignorá este correo.</p>
    <p>Soporte: <a href="mailto:${C}">${C}</a></p></body></html>`
  const casos = [
    ['confirmación correcta', buena('signup'), 'signup', 0],
    ['recovery correcta', buena('recovery'), 'recovery', 0],
    ['ConfirmationURL legacy', buena('signup').replace('{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup', '{{ .ConfirmationURL }}'), 'signup', 2],
    ['tipo equivocado', buena('recovery'), 'signup', 1],
    ['dominio de tracking', buena('signup').replace('Seguir</a>', 'Seguir</a><a href="https://click.tracker.example/x">x</a>'), 'signup', 1],
    ['imagen remota', buena('signup').replace('<p>TechRepair Pro</p>', '<p>TechRepair Pro</p><img src="https://cdn.example/logo.png">'), 'signup', 1],
    ['soporte distinto', buena('signup').replaceAll(C, 'soporte@techrepairpro.com'), 'signup', 1],
    ['SiteURL', buena('signup').replace('{{ .RedirectTo }}', '{{ .SiteURL }}'), 'signup', 1],
    ['sin advertencia', buena('signup').replace('ignorá este correo', 'gracias'), 'signup', 1],
    ['sin marca', buena('signup').replace('TechRepair Pro', 'Acme'), 'signup', 1],
  ]
  let malos = 0
  for (const [etiqueta, html, tipo, minimo] of casos) {
    const h = analizarPlantilla(html, tipo, C)
    const ok = minimo === 0 ? h.length === 0 : h.length >= minimo
    if (!ok) malos++
    console.log(`  ${ok ? 'OK  ' : 'MAL '} ${etiqueta} (esperado ${minimo === 0 ? 'PASA' : 'FALLA'}, dio ${h.length ? `FALLA ×${h.length}` : 'PASA'})`)
  }
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
  console.log('\nself-test OK: el guard caza enlaces legacy, tracking, soporte divergente y config local vieja.')
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
      'Las plantillas son las que PRE-BETA-2E pega en producción: un enlace roto rompe TODAS las\n' +
      'confirmaciones o recoveries. Ver docs/pre-beta-2/pre-beta-2d-auth-ux-tokenhash.md.',
    )
    process.exit(1)
  }
  console.log('GUARD auth-email-templates: OK — plantillas token_hash, soporte canónico y config local al día.')
}
