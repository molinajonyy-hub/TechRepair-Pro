#!/usr/bin/env node
// ============================================================================
// GUARD — EMAIL VERIFICATION P0 · contrato de RedirectTo
//
// La plantilla «Confirm signup» de Supabase usa `{{ .RedirectTo }}`, que es
// exactamente el `emailRedirectTo` que manda el cliente. Dos consecuencias:
//
//   1. Un `signUp`/`resend` SIN `emailRedirectTo` hace que GoTrue caiga al
//      Site URL. La confirmación de un cliente del portal mayorista
//      aterrizaría en el dominio equivocado y la sesión —que vive por
//      ORIGEN— quedaría del lado equivocado: el alta nunca se completa.
//
//   2. Un `emailRedirectTo` armado a mano con `window.location.origin` acepta
//      cualquier host donde se sirva el bundle. El único emisor autorizado es
//      `src/lib/authRedirect.ts`, que tiene una allowlist cerrada.
//
// Este guard falla si alguna llamada de auth con redirect no usa el helper.
//
//   node scripts/guards/auth-redirect-canonical.mjs
//   node scripts/guards/auth-redirect-canonical.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const RAIZ = process.cwd()
const SRC = join(RAIZ, 'src')

/** El único módulo autorizado a construir URLs de redirect. */
const HELPER = 'src/lib/authRedirect.ts'

const HELPERS_OK = ['getAuthCallbackUrl(', 'getResetPasswordUrl(']

/** Llamadas de auth que llevan un redirect al correo o al proveedor. */
const LLAMADAS = [
  { patron: /supabase\.auth\.signUp\s*\(/g, nombre: 'signUp', requiere: 'emailRedirectTo' },
  { patron: /supabase\.auth\.resend\s*\(/g, nombre: 'resend', requiere: 'emailRedirectTo' },
  { patron: /supabase\.auth\.resetPasswordForEmail\s*\(/g, nombre: 'resetPasswordForEmail', requiere: 'redirectTo' },
  { patron: /supabase\.auth\.signInWithOAuth\s*\(/g, nombre: 'signInWithOAuth', requiere: 'redirectTo' },
]

function archivos(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...archivos(p))
    else if (/\.(ts|tsx)$/.test(p)) out.push(p)
  }
  return out
}

/**
 * Recorta el bloque de argumentos de la llamada que empieza en `desde`,
 * balanceando paréntesis. Sin esto, una llamada podría "tomar prestado" el
 * emailRedirectTo de la siguiente y el guard daría un falso verde.
 */
function bloqueDeLlamada(src, desde) {
  let prof = 0
  for (let i = desde; i < src.length; i++) {
    const c = src[i]
    if (c === '(') prof++
    else if (c === ')') {
      prof--
      if (prof === 0) return src.slice(desde, i + 1)
    }
  }
  return src.slice(desde)
}

function analizar(contenido) {
  const fallas = []
  for (const { patron, nombre, requiere } of LLAMADAS) {
    patron.lastIndex = 0
    let m
    while ((m = patron.exec(contenido)) !== null) {
      const bloque = bloqueDeLlamada(contenido, m.index + m[0].length - 1)
      const linea = contenido.slice(0, m.index).split('\n').length

      if (!bloque.includes(`${requiere}:`)) {
        fallas.push({ linea, nombre, motivo: `no pasa \`${requiere}\`` })
        continue
      }
      if (!HELPERS_OK.some(h => bloque.includes(h))) {
        fallas.push({ linea, nombre, motivo: `arma \`${requiere}\` sin el helper canónico` })
      }
    }
  }
  return fallas
}

// ── Self-test: el guard tiene que cazar los dos defectos ────────────────────
if (process.argv.includes('--self-test')) {
  const casos = [
    ['sin emailRedirectTo', 'supabase.auth.signUp({ email, password })', true],
    ['origin crudo', "supabase.auth.signUp({ email, options: { emailRedirectTo: `${window.location.origin}/auth/callback` } })", true],
    ['con helper', 'supabase.auth.signUp({ email, options: { emailRedirectTo: getAuthCallbackUrl() } })', false],
    ['reset con helper', 'supabase.auth.resetPasswordForEmail(email, { redirectTo: getResetPasswordUrl() })', false],
    ['no toma prestado el del vecino', 'supabase.auth.signUp({ email })\nsupabase.auth.resend({ email, options: { emailRedirectTo: getAuthCallbackUrl() } })', true],
  ]
  let malos = 0
  for (const [etiqueta, codigo, deberiaFallar] of casos) {
    const fallas = analizar(codigo)
    const fallo = fallas.length > 0
    const ok = fallo === deberiaFallar
    if (!ok) malos++
    console.log(`  ${ok ? 'OK  ' : 'MAL '} ${etiqueta} (esperado ${deberiaFallar ? 'FALLA' : 'PASA'}, dio ${fallo ? 'FALLA' : 'PASA'})`)
  }
  if (malos) {
    console.error(`\nSELF-TEST FALLIDO: ${malos} caso(s).`)
    process.exit(1)
  }
  console.log('\nself-test OK: el guard caza el signUp sin redirect y el origin crudo.')
  process.exit(0)
}

// ── Corrida real ────────────────────────────────────────────────────────────
let total = 0
for (const p of archivos(SRC)) {
  const rel = relative(RAIZ, p).replace(/\\/g, '/')
  if (rel === HELPER) continue

  const fallas = analizar(readFileSync(p, 'utf8'))
  for (const f of fallas) {
    console.error(`  ${rel}:${f.linea}  ${f.nombre} ${f.motivo}`)
    total++
  }
}

if (total) {
  console.error(
    `\nGUARD auth-redirect-canonical: ${total} llamada(s) fuera de contrato.\n` +
    `Usá getAuthCallbackUrl() / getResetPasswordUrl() de ${HELPER}.\n` +
    `Con «Confirm Email» ON, un redirect no canónico manda la confirmación al\n` +
    `dominio equivocado (o GoTrue lo rechaza con 400 por no estar allowlisted).`
  )
  process.exit(1)
}

console.log('GUARD auth-redirect-canonical: OK — todos los redirects de auth salen del helper.')
