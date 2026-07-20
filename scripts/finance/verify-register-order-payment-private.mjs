#!/usr/bin/env node
// ============================================================================
// Verificación DINÁMICA por el camino público real: PostgREST RPC como `anon`,
// con la publishable key y SIN Authorization.
//
// register_order_payment ES un MUTADOR. Este script se usa:
//  - contra el stack LOCAL (default), donde una escritura sintética es inocua;
//  - NUNCA contra producción para el estado vulnerable (escribiría en el ledger).
//    Contra prod sólo tiene sentido para confirmar el estado CORREGIDO (denegado,
//    sin escritura), que es lo que hace por defecto.
//
//   npm run verify:register-order-payment-private                 (local)
//   node scripts/finance/verify-register-order-payment-private.mjs --url X --key Y --order UUID --biz UUID
//
// Salida sanitizada. Exit 0 = denegado (cerrado). Exit 1 = ejecutó (fuga).
// ============================================================================
import { spawnSync } from 'node:child_process'
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined }
let URL = arg('--url'), KEY = arg('--key')
const ORDER = arg('--order') || '00000000-0000-4000-8000-000000000001'
const BIZ = arg('--biz') || '00000000-0000-4000-8000-000000000002'
const AMOUNT = Number(arg('--amount') ?? 123.45)

if (!URL || !KEY) {
  const r = spawnSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true })
  const env = Object.fromEntries((r.stdout || '').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
  URL = URL || env.API_URL; KEY = KEY || env.ANON_KEY
}
if (!URL || !KEY) { console.error('Faltan API_URL/ANON_KEY. Levantá el stack local o pasá --url/--key.'); process.exit(2) }

const r = await fetch(`${URL}/rest/v1/rpc/register_order_payment`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: KEY },   // sin Authorization
  body: JSON.stringify({ p_order_id: ORDER, p_business_id: BIZ, p_amount_paid: AMOUNT }),
})
const txt = await r.text()
let body = null; try { body = JSON.parse(txt) } catch { /* void → 204 sin cuerpo */ }

console.log(`anon -> POST /rest/v1/rpc/register_order_payment  (apikey sola, sin Authorization)`)
console.log(`  HTTP ${r.status}${body && body.code ? ` | code: ${body.code}` : ''}`)

// void RETURNS: éxito = 204 (o 200). Eso significa que EJECUTÓ (escribió) → FUGA.
if (r.status === 200 || r.status === 204) {
  console.error(`\n❌ FUGA ABIERTA: anon ejecutó register_order_payment (HTTP ${r.status}) — inyectó movimiento(s) financiero(s) sin autenticarse.`)
  process.exit(1)
}
if (r.status === 401 || r.status === 403 || r.status === 404) {
  console.log(`\n✅ CERRADO: anon no puede ejecutar register_order_payment (HTTP ${r.status}), sin escritura.`)
  process.exit(0)
}
console.error(`\n⚠️  Respuesta inesperada (HTTP ${r.status}). Revisar a mano.`)
process.exit(1)
