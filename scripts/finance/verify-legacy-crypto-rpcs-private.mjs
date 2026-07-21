#!/usr/bin/env node
// ============================================================================
// Verificación DINÁMICA por el camino público real: PostgREST RPC como `anon`,
// con la publishable key y SIN Authorization, para encrypt_data y decrypt_data.
//
// Ambas son mutadoras-legacy retiradas. Este script confirma el estado CORREGIDO:
// anon NO puede ejecutarlas (permiso denegado ANTES del cuerpo). Datos sintéticos.
// No imprime plaintext/ciphertext. Exit 0 = ambas denegadas. Exit 1 = alguna abrió.
//
//   npm run verify:legacy-crypto-private                 (local, autodetecta URL/KEY)
//   node scripts/finance/verify-legacy-crypto-rpcs-private.mjs --url X --key Y
// ============================================================================
import { spawnSync } from 'node:child_process'
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined }
let URL = arg('--url'), KEY = arg('--key')
if (!URL || !KEY) {
  const r = spawnSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true })
  const env = Object.fromEntries((r.stdout || '').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
  URL = URL || env.API_URL; KEY = KEY || env.ANON_KEY
}
if (!URL || !KEY) { console.error('Faltan API_URL/ANON_KEY. Levantá el stack local o pasá --url/--key.'); process.exit(2) }

const SYN = 'SYNTHETIC-do-not-store'
const probe = async (fn, body) => {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY }, body: JSON.stringify(body),
  })
  await r.text()
  const denied = r.status === 401 || r.status === 403 || r.status === 404
  console.log(`anon -> POST /rest/v1/rpc/${fn}  → HTTP ${r.status} ${denied ? '(denegado)' : ''}`)
  // 200/204 = ejecutó el cuerpo = FUGA. Cualquier otra cosa que no sea denegación = revisar.
  return { fn, http: r.status, denied, leaked: r.status === 200 || r.status === 204 }
}

const enc = await probe('encrypt_data', { data_to_encrypt: SYN })
const dec = await probe('decrypt_data', { encrypted_data: 'bm90LXZhbGlk' })
const leaked = [enc, dec].filter(x => x.leaked)
const notDenied = [enc, dec].filter(x => !x.denied && !x.leaked)

if (leaked.length) { console.error(`\n❌ FUGA: ${leaked.map(x => x.fn).join(', ')} ejecutó el cuerpo como anon.`); process.exit(1) }
if (notDenied.length) { console.error(`\n⚠️  Respuesta inesperada en ${notDenied.map(x => `${x.fn}(HTTP ${x.http})`).join(', ')}. Revisar a mano.`); process.exit(1) }
console.log(`\n✅ CERRADO: anon no puede ejecutar encrypt_data ni decrypt_data (sin escritura, sin cuerpo).`)
process.exit(0)
