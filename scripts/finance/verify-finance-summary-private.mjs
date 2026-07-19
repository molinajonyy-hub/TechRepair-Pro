#!/usr/bin/env node
// ============================================================================
// Verificacion DINAMICA por el camino publico real: PostgREST RPC como `anon`,
// con la publishable key y SIN Authorization.
//
// Esto es el vector de ataque, no una aproximacion: la publishable key viaja en
// el bundle del frontend, asi que cualquiera la tiene. Si este script consigue
// datos financieros, el agujero esta abierto, digan lo que digan los catalogos.
//
// Existe ademas porque el equivalente en SQL —cambiar de rol dentro de un DO y
// capturar el permission denied— CRASHEA postgres:17.6.1.104 con SIGSEGV. El
// detalle esta en supabase/tests/security_get_finance_summary_revoked_test.sql.
//
//   npm run verify:finance-summary-private              (contra el stack local)
//   node scripts/finance/verify-finance-summary-private.mjs --url X --key Y --biz UUID
//
// Salida SANITIZADA: no imprime la key ni importes.
// Exit 0 = cerrado. Exit 1 = fuga.
// ============================================================================
import { spawnSync } from 'node:child_process'

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined }

let URL = arg('--url')
let KEY = arg('--key')
const BIZ = arg('--biz') || '00000000-0000-0000-0000-000000000001'

// Por defecto se apunta al stack local, leyendo su configuracion del CLI.
if (!URL || !KEY) {
  // spawnSync y NO execFileSync: `supabase status` sale con codigo != 0 cuando
  // hay servicios opcionales detenidos (imgproxy, pooler...), aunque imprima el
  // env perfectamente. Lo que importa es el stdout, no el exit code.
  // shell:true — en Windows npx.cmd es un batch y sin shell no se resuelve.
  const r = spawnSync('npx supabase status -o env',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true })
  const out = r.stdout || ''
  const env = Object.fromEntries(out.split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
  URL = URL || env.API_URL
  KEY = KEY || env.ANON_KEY
  if (!URL || !KEY) {
    console.error('No se pudo leer API_URL/ANON_KEY de `supabase status`. Levanta el stack local o pasa --url/--key.')
    process.exit(2)
  }
}

if (!URL || !KEY) { console.error('Faltan URL o key.'); process.exit(2) }

const r = await fetch(`${URL}/rest/v1/rpc/get_finance_summary`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: KEY },   // sin Authorization
  body: JSON.stringify({ p_business_id: BIZ, p_from: '2020-01-01', p_to: '2030-01-01' }),
})

const txt = await r.text()
let body = null
try { body = JSON.parse(txt) } catch { /* no-json */ }

const filas = Array.isArray(body) ? body.length : 0
const campos = filas > 0 && body[0] ? Object.keys(body[0]) : []
const devuelveFinanzas = campos.some(c => /income|expense|result|balance/i.test(c))

console.log(`anon -> POST /rest/v1/rpc/get_finance_summary  (apikey sola, sin Authorization)`)
console.log(`  HTTP ${r.status}`)
if (body && body.code) console.log(`  code: ${body.code}`)
console.log(`  filas: ${filas}${campos.length ? ` | campos: ${campos.join(', ')}` : ''}`)

if (devuelveFinanzas) {
  console.error(`\n❌ FUGA ABIERTA: anon obtuvo ${filas} fila(s) con campos financieros SIN autenticarse.`)
  console.error(`   Aplicar la migracion 20260719130000 (REVOKE de PUBLIC/anon/authenticated).`)
  process.exit(1)
}

// PostgREST devuelve 404 cuando la funcion no esta expuesta al rol, y 403 si la
// bloquea por permisos. Cualquiera de las dos es un cierre valido.
if (r.status === 404 || r.status === 403 || r.status === 401) {
  console.log(`\n✅ CERRADO: anon no alcanza la funcion (HTTP ${r.status}), sin datos financieros.`)
  process.exit(0)
}

console.error(`\n⚠️  Respuesta inesperada (HTTP ${r.status}). Revisar a mano antes de dar por cerrado.`)
process.exit(1)
