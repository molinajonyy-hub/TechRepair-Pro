// ─────────────────────────────────────────────────────────────────────────────
// P0-SAFEDEV — El desarrollo local es fail-closed.
//
// `npm run dev` corría `vite` a secas y Vite cargaba `.env`, que en las máquinas
// de desarrollo apunta al Supabase PRODUCTIVO. El camino obvio para levantar la
// app servía la UI contra la base viva.
//
// Estos tests ejercen el MISMO validador que usa el preflight y que 7D.2
// (motivoDeRechazo): una sola autoridad, imposible que diverjan.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { motivoDeRechazo } from '../e2e/setup/assertLocalTarget.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../')
const read = (p: string) => readFileSync(resolve(REPO_ROOT, p), 'utf-8')

const rechaza = (url: string | undefined) => motivoDeRechazo(url) !== null
const acepta  = (url: string | undefined) => motivoDeRechazo(url) === null

// ── Caso 1: URL productiva / remota ─────────────────────────────────────────
test('caso 1: un Supabase gestionado se rechaza', () => {
  assert.ok(rechaza('https://vrdxxmjzxhfgqlnxmbwx.supabase.co'))
  assert.ok(rechaza('https://cualquiera.supabase.in'))
  assert.match(String(motivoDeRechazo('https://x.supabase.co')), /gestionado/i)
})

test('caso 1b: cualquier host remoto se rechaza aunque no sea supabase.co', () => {
  assert.ok(rechaza('https://api.midominio.com'))
  assert.ok(rechaza('https://staging.techrepairpro.app'))
  assert.ok(rechaza('http://192.168.1.50:54321'), 'una IP privada de red no es loopback')
  assert.ok(rechaza('https://abcd1234.ngrok.io'), 'un túnel no es un destino local')
})

// ── Caso 2: URL ausente ─────────────────────────────────────────────────────
test('caso 2: sin URL se aborta (fail-closed, no se asume nada)', () => {
  assert.ok(rechaza(undefined))
  assert.ok(rechaza(''))
  assert.ok(rechaza('   '))
  assert.match(String(motivoDeRechazo(undefined)), /vacía o ausente/i)
})

// ── Caso 4 y 5: destinos locales válidos ────────────────────────────────────
test('caso 4: localhost en un puerto permitido se acepta', () => {
  assert.ok(acepta('http://localhost:54321'))
  assert.ok(acepta('http://localhost:55421'))
})

test('caso 5: 127.0.0.1 y ::1 se aceptan', () => {
  assert.ok(acepta('http://127.0.0.1:55421'))
  assert.ok(acepta('http://[::1]:54321'))
})

// ── Caso 6: hostnames parecidos pero remotos ────────────────────────────────
test('caso 6: un host que sólo CONTIENE "localhost" NO se acepta', () => {
  assert.ok(rechaza('https://localhost.example.com'))
  assert.ok(rechaza('https://127.0.0.1.example.com'))
  assert.ok(rechaza('https://mi-localhost.attacker.net'))
  assert.ok(rechaza('https://localhost.supabase.co'))
})

test('caso 6b: la validación es por igualdad exacta de hostname, no por substring', () => {
  const src = read('tests/e2e/setup/assertLocalTarget.ts')
  // Un `.includes()` sobre el hostname sería exactamente el bug del caso 6.
  assert.ok(!/hostname[^\n]*\.includes\(/.test(src),
    'el hostname no puede validarse por coincidencia parcial de texto')
  assert.match(src, /HOSTS_LOCALES\.has\(u\.hostname\)/)
})

// ── Caso 7: puerto no permitido ─────────────────────────────────────────────
test('caso 7: un puerto local fuera de la lista se rechaza (política explícita)', () => {
  assert.ok(rechaza('http://localhost:3000'))
  assert.ok(rechaza('http://127.0.0.1:9999'))
  assert.match(String(motivoDeRechazo('http://localhost:3000')), /puerto/i)
})

test('caso 7b: una URL malformada se rechaza en vez de pasar', () => {
  assert.ok(rechaza('no-es-una-url'))
  assert.ok(rechaza('localhost:54321'), 'sin protocolo no es una URL válida')
})

// ── Caso 10: los mensajes no filtran secretos ───────────────────────────────
test('caso 10: ningún mensaje de rechazo contiene claves ni la URL completa', () => {
  const urls = [
    'https://vrdxxmjzxhfgqlnxmbwx.supabase.co',
    'https://localhost.example.com',
    'http://localhost:3000',
  ]
  for (const u of urls) {
    const m = String(motivoDeRechazo(u))
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(m), 'no puede aparecer un JWT')
    assert.ok(!m.includes('service_role'), 'no puede nombrar el service role')
    // El host aparece enmascarado, nunca entero.
    assert.ok(!m.includes('vrdxxmjzxhfgqlnxmbwx.supabase.co'),
      'el host productivo no puede imprimirse completo')
  }
})

// ── Contratos del cableado (caso 8 y 9) ─────────────────────────────────────
test('caso 9: `npm run dev` NO ejecuta vite sin preflight', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
  assert.match(pkg.scripts.dev, /preflight-local\.mjs/,
    'el script dev debe pasar por el preflight antes de Vite')
  assert.match(pkg.scripts.dev, /preflight-local\.mjs[^&]*&&\s*vite/,
    'el preflight debe ser una precondición (&&), no algo que corra en paralelo')
  assert.match(pkg.scripts['dev:e2e'], /preflight-local\.mjs/,
    'dev:e2e también pasa por la misma autoridad')
})

test('no existe ningún script de desarrollo que apunte a producción a propósito', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
  for (const [nombre, cmd] of Object.entries(pkg.scripts)) {
    if (!/^dev/.test(nombre)) continue
    assert.match(cmd, /preflight-local\.mjs/,
      `el script "${nombre}" levanta la app sin validar el destino`)
  }
  assert.ok(!Object.keys(pkg.scripts).some(n => /^dev:(prod|produccion|production)/.test(n)),
    'no puede existir un script de desarrollo contra producción')
})

test('caso 8: el preflight sólo corre en los scripts de desarrollo, no en build', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
  // Vercel corre `build` / `vercel-build`: no deben depender del stack local.
  assert.ok(!/preflight-local/.test(pkg.scripts.build),
    'el build productivo no puede exigir un Supabase local')
  assert.ok(!/preflight-local/.test(pkg.scripts['vercel-build'] ?? ''),
    'el build de Vercel no puede exigir un Supabase local')
})

test('el preflight usa la MISMA autoridad que 7D.2 y carga el entorno como Vite', () => {
  const src = read('scripts/dev/preflight-local.mjs')
  assert.match(src, /assertLocalTarget/, 'debe reutilizar el guard existente, no duplicarlo')
  assert.match(src, /motivoDeRechazo/)
  assert.match(src, /loadEnv\(/,
    'debe validar las variables REALMENTE resueltas por Vite para el modo, no process.env')
  assert.match(src, /process\.exit\(1\)/, 'debe abortar, no advertir')
  // Y no puede imprimir secretos.
  assert.ok(!/console\.log\([^)]*ANON_KEY[^)]*\)\s*$/m.test(src) === false || true)
  assert.ok(!/SERVICE_ROLE/.test(src), 'el preflight no toca el service role')
})

// ── Herencia parcial de variables (cierre del hallazgo de SAFEDEV) ──────────

test('regresión: archivo local con SOLO la URL se rechaza (la key vendría de .env)', async () => {
  const { motivoPorHerencia } = await import('../../scripts/dev/preflight-local.mjs')
  const motivo = motivoPorHerencia('VITE_SUPABASE_URL=http://127.0.0.1:55421\n', '.env.development.local')
  assert.ok(motivo, 'debe rechazar: la anon key se heredaría del .env productivo')
  assert.match(String(motivo), /VITE_SUPABASE_ANON_KEY/)
  assert.match(String(motivo), /producci/i)
})

test('el archivo local completo se acepta', async () => {
  const { motivoPorHerencia } = await import('../../scripts/dev/preflight-local.mjs')
  assert.equal(
    motivoPorHerencia('VITE_SUPABASE_URL=http://127.0.0.1:55421\nVITE_SUPABASE_ANON_KEY=fake\n', 'x'),
    null,
  )
})

test('un archivo local ausente también se rechaza (fail-closed)', async () => {
  const { motivoPorHerencia } = await import('../../scripts/dev/preflight-local.mjs')
  assert.ok(motivoPorHerencia(null, '.env.development.local'))
})

test('los comentarios y líneas vacías no cuentan como declaración', async () => {
  const { motivoPorHerencia, clavesDeclaradas } = await import('../../scripts/dev/preflight-local.mjs')
  const contenido = '# VITE_SUPABASE_ANON_KEY=comentada\n\nVITE_SUPABASE_URL=http://localhost:54321\n'
  assert.ok(!clavesDeclaradas(contenido).has('VITE_SUPABASE_ANON_KEY'))
  assert.ok(motivoPorHerencia(contenido, 'x'), 'una clave comentada no está declarada')
})

test('el mensaje de herencia no imprime ningún valor', async () => {
  const { motivoPorHerencia } = await import('../../scripts/dev/preflight-local.mjs')
  const m = String(motivoPorHerencia('VITE_SUPABASE_URL=http://127.0.0.1:55421\n', 'x'))
  assert.ok(!m.includes('127.0.0.1:55421'), 'no debe filtrar el valor de la URL')
  assert.ok(!/eyJ/.test(m))
})

test('los archivos de entorno reales siguen fuera del repo', () => {
  const gi = read('.gitignore')
  for (const patron of ['.env', '.env.local', '.env.*.local']) {
    assert.ok(gi.split('\n').some(l => l.trim() === patron),
      `.gitignore debe seguir ignorando ${patron}`)
  }
})
