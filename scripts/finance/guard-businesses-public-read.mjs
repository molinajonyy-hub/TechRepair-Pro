#!/usr/bin/env node
// ============================================================================
// P0 Seguridad FASE 2 — Guard del lockdown de lectura de `public.businesses`.
//
// ACOTADO a este P0. No duplica ni reemplaza a guard-secdef-exposure.mjs (que
// mira grants de FUNCIONES) ni a guard-security-definer.mjs (higiene de cuerpo).
// Acá se vigila una sola cosa: que nadie vuelva a abrir la lectura pública de
// `businesses`, ni desde la base ni desde el cliente del portal.
//
// Falla (exit 1) cuando:
//   R1. una migración crea una policy de LECTURA sobre businesses alcanzable por
//       PUBLIC (sin cláusula TO) o por anon. Cubre FOR SELECT, FOR ALL y la
//       ausencia de FOR (que en PostgreSQL significa ALL);
//   R2. una migración vuelve a conceder SELECT —de tabla o de columna— sobre
//       businesses a anon o a PUBLIC;
//   R3. el portal lee `businesses` con el comodín select('*');
//   R4. el fallback a la tabla deja de estar acotado a "el objeto no existe":
//       si 42501 entrara en isMissingObject, o si la lectura de la tabla saliera
//       de esa rama, un lockdown correcto mandaría al portal contra la tabla
//       recién cerrada;
//   R5. la carga del portal puede quedar en loading infinito: sin try/catch en
//       getPortalBusiness o sin apagado incondicional de bizLoading;
//   R6. se agrega `businesses` a la publicación supabase_realtime;
//   R7. una migración documenta un "rollback" que RECREA el estado vulnerable
//       (la recuperación de este P0 es forward-only);
//   R8. dos migraciones comparten timestamp.
//
//   node scripts/finance/guard-businesses-public-read.mjs [archivo|dir ...]
//   node scripts/finance/guard-businesses-public-read.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, extname } from 'node:path'

// Las reglas de SQL miran hacia ADELANTE. La deuda histórica es justamente lo
// que limpia 20260804130000: el baseline 20260628190324 CONTIENE la policy
// vulnerable y el GRANT a anon, y reescribir el baseline no es una opción.
const CUTOFF = '20260804130000'

// tests/sql/wholesale_portal_public_read.test.sql reconstruye el estado
// vulnerable a propósito (CASO 21) dentro de una transacción que termina en
// ROLLBACK: es la prueba de que el cierre sirvió para algo. Por eso el escaneo
// SQL se limita a supabase/migrations y nunca a tests/.
const DIRS_SQL_POR_DEFECTO = ['supabase/migrations']
const DIRS_TS_POR_DEFECTO  = ['src/portal']

/** Reemplaza comentarios por espacios conservando offsets. */
function despojar(s) {
  let out = '', i = 0
  while (i < s.length) {
    if (s.slice(i, i + 2) === '--') { const f = s.indexOf('\n', i); const e = f === -1 ? s.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (s.slice(i, i + 2) === '/*') { const f = s.indexOf('*/', i + 2); const e = f === -1 ? s.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += s[i]; i++
  }
  return out
}

const esBusinesses = (txt) => /"?public"?\s*\.\s*"?businesses"?|(?<![\w."])"?businesses"?(?![\w."])/i.test(txt)

// ── R1 · policies de lectura públicas ───────────────────────────────────────
function reglaPolicies(limpio) {
  const out = []
  const re = /CREATE\s+POLICY\s+("?[\w]+"?)\s+ON\s+((?:"?\w+"?\s*\.\s*)?"?\w+"?)([\s\S]*?);/gi
  let m
  while ((m = re.exec(limpio)) !== null) {
    const [, nombre, tabla, cola] = m
    if (!esBusinesses(tabla)) continue

    // AS RESTRICTIVE no concede acceso, sólo lo recorta: marcarla sería un falso
    // positivo. El default es PERMISSIVE.
    if (/\bAS\s+RESTRICTIVE\b/i.test(cola)) continue

    // Sin cláusula FOR, PostgreSQL asume ALL — que incluye lectura.
    const mFor = cola.match(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i)
    const cmd = mFor ? mFor[1].toUpperCase() : 'ALL'
    if (cmd !== 'ALL' && cmd !== 'SELECT') continue

    // Sin cláusula TO, polroles queda en '{0}' = PUBLIC. Ése fue el bug original.
    const mTo = cola.match(/\bTO\s+([^;]*?)(?:\bUSING\b|\bWITH\s+CHECK\b|$)/i)
    if (!mTo) {
      out.push(`R1 ${nombre.replace(/"/g, '')}: CREATE POLICY ${cmd} sobre businesses SIN cláusula TO (aplica a PUBLIC)`)
      continue
    }
    const roles = mTo[1].split(',').map(r => r.trim().replace(/"/g, '').toLowerCase())
    const malos = roles.filter(r => r === 'anon' || r === 'public')
    if (malos.length) {
      out.push(`R1 ${nombre.replace(/"/g, '')}: CREATE POLICY ${cmd} sobre businesses TO ${malos.join(', ')}`)
    }
  }
  return out
}

// ── R2 · GRANT SELECT sobre businesses a anon/PUBLIC ────────────────────────
function reglaGrants(limpio) {
  const out = []
  // Sólo GRANT: el REVOKE tiene la misma forma y es exactamente lo que hace la
  // migración de este lockdown.
  const re = /\bGRANT\s+([\s\S]*?)\s+ON\s+(?:TABLE\s+)?((?:"?\w+"?\s*\.\s*)?"?\w+"?)\s+TO\s+([^;]+);/gi
  let m
  while ((m = re.exec(limpio)) !== null) {
    const [, privs, tabla, destinos] = m
    if (!esBusinesses(tabla)) continue
    // Cubre `SELECT`, `SELECT (col1, col2)` y `ALL PRIVILEGES`.
    if (!/\bSELECT\b|\bALL\b/i.test(privs)) continue
    const roles = destinos.split(',').map(r => r.trim().replace(/"/g, '').toLowerCase())
    const malos = roles.filter(r => r === 'anon' || r === 'public')
    if (malos.length) {
      const porColumna = /\(/.test(privs) ? ' por columna' : ''
      out.push(`R2: GRANT SELECT${porColumna} sobre businesses a ${malos.join(', ')}`)
    }
  }
  return out
}

// ── R6 · businesses en la publicación de Realtime ───────────────────────────
function reglaRealtime(limpio) {
  const out = []
  const re = /ALTER\s+PUBLICATION\s+("?\w+"?)\s+ADD\s+TABLE\s+([^;]+);/gi
  let m
  while ((m = re.exec(limpio)) !== null) {
    if (!esBusinesses(m[2])) continue
    out.push(`R6: ALTER PUBLICATION ${m[1].replace(/"/g, '')} ADD TABLE ... businesses (Realtime queda fuera de alcance)`)
  }
  return out
}

// ── R7 · rollback documentado que recrea el estado vulnerable ───────────────
// Ésta es la ÚNICA regla que mira los comentarios: un rollback se documenta,
// no se ejecuta. Se busca la forma exacta de una receta —una línea comentada
// que EMPIEZA con CREATE POLICY o GRANT SELECT— precedida de cerca por una
// palabra de reversión. Citar la definición vulnerable para explicar la causa
// (que es lo que hace la cabecera de la migración del lockdown) no alcanza:
// ahí no hay ninguna palabra de reversión cerca.
const PALABRAS_ROLLBACK = /\b(rollback|revertir|reversible|revert|deshacer|restaurar)\b/i

function reglaRollback(crudo) {
  const out = []
  const lineas = crudo.split('\n')
  for (let i = 0; i < lineas.length; i++) {
    const receta = lineas[i].match(/^\s*--\s*(CREATE\s+POLICY|GRANT\s+SELECT)\b/i)
    if (!receta) continue

    // ¿Hay una palabra de reversión en las 5 líneas anteriores?
    const contexto = lineas.slice(Math.max(0, i - 5), i).join('\n')
    if (!PALABRAS_ROLLBACK.test(contexto)) continue

    // La receta puede seguir en las líneas comentadas siguientes.
    const stmt = lineas.slice(i, i + 4).join(' ')
    const recreaPolicy = /businesses_portal_public_read/i.test(stmt)
    const recreaGrant  = /\bGRANT\s+SELECT\b[\s\S]*\bbusinesses\b[\s\S]*\banon\b/i.test(stmt)
    if (recreaPolicy || recreaGrant) {
      out.push(`R7 línea ${i + 1}: rollback documentado que RECREA el acceso público a businesses (la recuperación es forward-only)`)
    }
  }
  return out
}

// ── R8 · timestamps duplicados ──────────────────────────────────────────────
function reglaTimestamps(dir) {
  const out = []
  let archivos
  try { archivos = readdirSync(dir).filter(f => f.endsWith('.sql')) } catch { return out }
  const porTs = new Map()
  for (const f of archivos) {
    const ts = basename(f).split('_')[0]
    if (!/^\d{14}$/.test(ts)) continue
    if (!porTs.has(ts)) porTs.set(ts, [])
    porTs.get(ts).push(f)
  }
  for (const [ts, fs] of porTs) {
    if (fs.length > 1) out.push(`R8 timestamp ${ts} duplicado: ${fs.join(', ')}`)
  }
  return out
}

// ── R3/R4/R5 · el lado del cliente ──────────────────────────────────────────
function reglasFrontend(archivo, crudo) {
  const out = []
  const nombre = basename(archivo)

  // R3 — comodín sobre businesses. Acotado a businesses a propósito: un
  // select('*') sobre wholesale_customers es legítimo y preexistente.
  for (const m of crudo.matchAll(/\.from\(\s*['"`]businesses['"`]\s*\)([\s\S]{0,300})/g)) {
    if (/\.select\(\s*['"`]\s*\*\s*['"`]\s*\)/.test(m[1])) {
      out.push(`R3 ${nombre}: lectura de businesses con select('*')`)
    }
  }

  // R4 — el fallback tiene que seguir acotado a "objeto ausente".
  // El cuerpo se recorta hasta el `\n}` de cierre, NO por una ventana de N
  // caracteres: el módulo documenta el 42501 justo debajo (es el código que el
  // fallback NO debe atender) y una ventana fija lo leía como parte de la lista.
  if (/export\s+function\s+isMissingObject/.test(crudo)) {
    const i = crudo.indexOf('export function isMissingObject')
    const fin = crudo.indexOf('\n}', i)
    const cuerpo = crudo.slice(i, fin === -1 ? crudo.length : fin)
    if (/42501/.test(cuerpo)) {
      out.push(`R4 ${nombre}: isMissingObject incluye 42501 — el fallback se activaría ante permiso denegado`)
    }
  }
  if (crudo.includes(".from('businesses')")) {
    const iGuarda = crudo.indexOf('isMissingObject(')
    const iTabla  = crudo.indexOf(".from('businesses')")
    if (iGuarda === -1 || iTabla < iGuarda) {
      out.push(`R4 ${nombre}: la lectura de businesses no está dentro de la guarda isMissingObject`)
    }
    const lecturas = [...crudo.matchAll(/\.from\(\s*['"`]businesses['"`]\s*\)/g)]
    if (lecturas.length > 1) {
      out.push(`R4 ${nombre}: hay ${lecturas.length} lecturas de businesses; sólo se admite el fallback transitorio`)
    }
  }

  // R5 — ningún camino puede dejar el loading prendido.
  if (/export\s+async\s+function\s+getPortalBusiness/.test(crudo)) {
    const i = crudo.indexOf('export async function getPortalBusiness')
    const cuerpo = crudo.slice(i, crudo.indexOf('\n}', i))
    if (!/\btry\s*\{/.test(cuerpo) || !/\bcatch\b/.test(cuerpo)) {
      out.push(`R5 ${nombre}: getPortalBusiness sin try/catch — un rechazo dejaría el spinner colgado`)
    }
  }
  if (crudo.includes('getPortalBusiness(') && /setBizLoading/.test(crudo)) {
    // El apagado tiene que ser incondicional: `.finally(...)` o un `finally {}`.
    if (!/\.finally\(/.test(crudo) && !/finally\s*\{/.test(crudo)) {
      out.push(`R5 ${nombre}: bizLoading no se apaga en un finally — un error deja loading infinito`)
    }
  }

  return out
}

// ── Recorrido ───────────────────────────────────────────────────────────────
function revisarSql(archivo, { soloR7yR8 = false } = {}) {
  const crudo = readFileSync(archivo, 'utf8')
  const hallazgos = reglaRollback(crudo)
  if (soloR7yR8) return hallazgos
  const limpio = despojar(crudo)
  return [...hallazgos, ...reglaPolicies(limpio), ...reglaGrants(limpio), ...reglaRealtime(limpio)]
}

function listar(dir, exts) {
  const out = []
  let entradas
  try { entradas = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entradas) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listar(p, exts))
    else if (exts.includes(extname(e.name))) out.push(p)
  }
  return out
}

// ── self-test ───────────────────────────────────────────────────────────────
const FIXTURES_SQL = [
  { nombre: 'lockdown real (DROP + REVOKE)', debeFallar: false, sql:
`DROP POLICY IF EXISTS "businesses_portal_public_read" ON "public"."businesses";
REVOKE SELECT ON TABLE "public"."businesses" FROM "anon";
REVOKE SELECT ON TABLE "public"."businesses" FROM PUBLIC;` },

  { nombre: 'R1 policy FOR SELECT sin TO', debeFallar: true, sql:
`CREATE POLICY "x" ON public.businesses FOR SELECT USING (wholesale_portal_enabled = true);` },

  { nombre: 'R1 policy sin FOR y sin TO (= ALL a PUBLIC)', debeFallar: true, sql:
`CREATE POLICY "y" ON public.businesses USING (true);` },

  { nombre: 'R1 policy FOR ALL TO anon', debeFallar: true, sql:
`CREATE POLICY "z" ON "public"."businesses" FOR ALL TO "anon" USING (true);` },

  { nombre: 'R1 policy FOR SELECT TO authenticated (legítima)', debeFallar: false, sql:
`CREATE POLICY "businesses_select" ON public.businesses FOR SELECT TO authenticated USING (id = current_user_business_id());` },

  { nombre: 'R1 policy RESTRICTIVE a PUBLIC no es un leak', debeFallar: false, sql:
`CREATE POLICY "r" ON public.businesses AS RESTRICTIVE FOR SELECT USING (true);` },

  { nombre: 'R1 policy FOR INSERT sin TO no es lectura', debeFallar: false, sql:
`CREATE POLICY "i" ON public.businesses FOR INSERT WITH CHECK (owner_user_id = auth.uid());` },

  { nombre: 'R1 no aplica a otra tabla', debeFallar: false, sql:
`CREATE POLICY "otra" ON public.wholesale_customers FOR SELECT USING (true);` },

  { nombre: 'R2 GRANT SELECT a anon', debeFallar: true, sql:
`GRANT SELECT ON TABLE public.businesses TO anon;` },

  { nombre: 'R2 GRANT SELECT por columna a anon', debeFallar: true, sql:
`GRANT SELECT (mp_payer_email) ON TABLE public.businesses TO anon;` },

  { nombre: 'R2 GRANT SELECT a PUBLIC', debeFallar: true, sql:
`GRANT SELECT ON public.businesses TO PUBLIC;` },

  { nombre: 'R2 GRANT SELECT a authenticated (legítimo)', debeFallar: false, sql:
`GRANT SELECT ON TABLE public.businesses TO authenticated;` },

  { nombre: 'R2 GRANT UPDATE(col) a service_role (legítimo)', debeFallar: false, sql:
`GRANT UPDATE (mp_payer_email) ON TABLE public.businesses TO service_role;` },

  { nombre: 'R2 REVOKE no se confunde con GRANT', debeFallar: false, sql:
`REVOKE SELECT ON TABLE public.businesses FROM anon;` },

  { nombre: 'R6 businesses a supabase_realtime', debeFallar: true, sql:
`ALTER PUBLICATION supabase_realtime ADD TABLE public.businesses;` },

  { nombre: 'R6 otra tabla a realtime no es asunto de este guard', debeFallar: false, sql:
`ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;` },

  { nombre: 'R7 rollback que recrea la policy', debeFallar: true, sql:
`-- Reversible (rollback de emergencia, restaura el comportamiento inseguro):
--   CREATE POLICY "businesses_portal_public_read" ON public.businesses
--     FOR SELECT USING (wholesale_portal_enabled = true);
DROP POLICY IF EXISTS "businesses_portal_public_read" ON public.businesses;` },

  { nombre: 'R7 rollback que reconcede SELECT a anon', debeFallar: true, sql:
`-- Para revertir:
--   GRANT SELECT ON TABLE public.businesses TO anon;
REVOKE SELECT ON TABLE public.businesses FROM anon;` },

  { nombre: 'R7 citar la policy vulnerable para explicar la causa NO es rollback', debeFallar: false, sql:
`-- CAUSA: el baseline creo la policy SIN clausula TO:
--   CREATE POLICY "businesses_portal_public_read" ON "public"."businesses"
--     FOR SELECT USING (("wholesale_portal_enabled" = true));
-- Sin TO, polroles queda vacio => aplica a PUBLIC.
DROP POLICY IF EXISTS "businesses_portal_public_read" ON public.businesses;` },

  { nombre: 'R7 decir que NO hay rollback no es documentar uno', debeFallar: false, sql:
`-- RECUPERACION FORWARD-ONLY: no hay rollback. Restaurar
-- businesses_portal_public_read reabre el P0 completo.
REVOKE SELECT ON TABLE public.businesses FROM anon;` },
]

const FIXTURES_TS = [
  { nombre: 'portalService correcto', archivo: 'portalService.ts', debeFallar: false, src:
`export async function getPortalBusiness(slug: string) {
  try {
    const { data, error, status } = await supabase.rpc(PORTAL_PUBLIC_RPC, { p_slug: slug })
    if (error) {
      if (isMissingObject(error)) {
        const { data: legacy } = await supabase.from('businesses').select(PORTAL_PUBLIC_COLUMNS).eq('wholesale_portal_slug', slug).maybeSingle()
        return legacy ? { status: 'ok', business: legacy } : { status: 'unavailable' }
      }
      return { status: 'error', reason: classifyPortalError(error, status) }
    }
    return { status: 'ok', business: data[0] }
  } catch {
    return { status: 'error', reason: 'network' }
  }
}` },

  { nombre: "R3 select('*') sobre businesses", archivo: 'portalService.ts', debeFallar: true, src:
`const { data } = await supabase.from('businesses').select('*').eq('wholesale_portal_slug', slug).maybeSingle()` },

  { nombre: 'R4 isMissingObject con 42501', archivo: 'portalPublicContract.ts', debeFallar: true, src:
`export function isMissingObject(error) {
  return ['PGRST202', '42883', '42501'].includes(error?.code ?? '')
}` },

  { nombre: 'R4 isMissingObject sin 42501', archivo: 'portalPublicContract.ts', debeFallar: false, src:
`export function isMissingObject(error) {
  return ['PGRST202', '42883', 'PGRST205', '42P01'].includes(error?.code ?? '')
}` },

  // Forma real del módulo: el 42501 se documenta y se clasifica JUSTO DEBAJO de
  // isMissingObject. Con una ventana de N caracteres esto daba falso positivo.
  { nombre: 'R4 el 42501 documentado fuera del cuerpo no es un hallazgo', archivo: 'portalPublicContract.ts', debeFallar: false, src:
`export function isMissingObject(error) {
  return ['PGRST202', '42883', 'PGRST205', '42P01'].includes(error?.code ?? '')
}

/** 42501 = insufficient_privilege. El único código que significa "sin permiso". */
export function isPermissionDenied(error) {
  return error?.code === '42501'
}` },

  { nombre: 'R4 lectura de businesses fuera de la guarda', archivo: 'portalService.ts', debeFallar: true, src:
`export async function getPortalBusiness(slug: string) {
  try {
    const { data: legacy } = await supabase.from('businesses').select(PORTAL_PUBLIC_COLUMNS).maybeSingle()
    if (isMissingObject(null)) return null
    return legacy
  } catch { return { status: 'error', reason: 'network' } }
}` },

  { nombre: 'R5 getPortalBusiness sin try/catch', archivo: 'portalService.ts', debeFallar: true, src:
`export async function getPortalBusiness(slug: string) {
  const { data } = await supabase.rpc(PORTAL_PUBLIC_RPC, { p_slug: slug })
  return { status: 'ok', business: data[0] }
}` },

  { nombre: 'PortalContext con finally', archivo: 'PortalContext.tsx', debeFallar: false, src:
`getPortalBusiness(slug).then(res => { setBusiness(res.business) }).finally(() => { setBizLoading(false) })` },

  { nombre: 'R5 PortalContext sin finally', archivo: 'PortalContext.tsx', debeFallar: true, src:
`getPortalBusiness(slug).then(res => { setBusiness(res.business); setBizLoading(false) })` },
]

function autoTest() {
  let fallas = 0
  const dir = mkdtempSync(join(tmpdir(), 'bizread-'))

  for (const f of FIXTURES_SQL) {
    const p = join(dir, `${CUTOFF}_fx.sql`)
    writeFileSync(p, f.sql)
    const h = revisarSql(p)
    const fallo = h.length > 0
    const ok = fallo === f.debeFallar
    if (!ok) fallas++
    console.log(`${ok ? 'OK  ' : 'FALLA'} sql "${f.nombre}": esperaba ${f.debeFallar ? 'FALLA' : 'OK'}, obtuvo ${fallo ? 'FALLA' : 'OK'}${fallo ? ` (${h[0]})` : ''}`)
  }

  for (const f of FIXTURES_TS) {
    const p = join(dir, f.archivo)
    writeFileSync(p, f.src)
    const h = reglasFrontend(p, f.src)
    const fallo = h.length > 0
    const ok = fallo === f.debeFallar
    if (!ok) fallas++
    console.log(`${ok ? 'OK  ' : 'FALLA'} ts  "${f.nombre}": esperaba ${f.debeFallar ? 'FALLA' : 'OK'}, obtuvo ${fallo ? 'FALLA' : 'OK'}${fallo ? ` (${h[0]})` : ''}`)
  }

  // R8 — con y sin colisión.
  const dupDir = mkdtempSync(join(tmpdir(), 'bizread-ts-'))
  mkdirSync(join(dupDir, 'sub'), { recursive: true })
  writeFileSync(join(dupDir, '20260804130000_a.sql'), '')
  writeFileSync(join(dupDir, '20260804130000_b.sql'), '')
  const hDup = reglaTimestamps(dupDir)
  const okDup = hDup.length === 1
  if (!okDup) fallas++
  console.log(`${okDup ? 'OK  ' : 'FALLA'} r8  "timestamps duplicados": ${hDup[0] || 'no detectado'}`)

  const uniDir = mkdtempSync(join(tmpdir(), 'bizread-ts2-'))
  writeFileSync(join(uniDir, '20260804130000_a.sql'), '')
  writeFileSync(join(uniDir, '20260804140000_b.sql'), '')
  const hUni = reglaTimestamps(uniDir)
  const okUni = hUni.length === 0
  if (!okUni) fallas++
  console.log(`${okUni ? 'OK  ' : 'FALLA'} r8  "timestamps únicos": ${hUni[0] || 'sin hallazgos'}`)

  // El corte histórico: el baseline tiene la policy vulnerable y NO puede
  // hacer fallar al guard, pero su rollback documentado sí se seguiría viendo.
  const pLegacy = join(dir, '20260628190324_remote_baseline.sql')
  writeFileSync(pLegacy, 'CREATE POLICY "businesses_portal_public_read" ON public.businesses FOR SELECT USING (wholesale_portal_enabled = true);\nGRANT SELECT ON TABLE public.businesses TO anon;')
  const hLegacy = revisarSql(pLegacy, { soloR7yR8: true })
  const okLegacy = hLegacy.length === 0
  if (!okLegacy) fallas++
  console.log(`${okLegacy ? 'OK  ' : 'FALLA'} cut "baseline histórico exento": ${hLegacy[0] || 'sin hallazgos'}`)

  const total = FIXTURES_SQL.length + FIXTURES_TS.length + 3
  if (fallas) { console.error(`\nself-test: ${fallas} fixture(s) mal clasificadas`); process.exit(1) }
  console.log(`\nself-test OK: ${total} fixtures clasificadas correctamente`)
}

// ── main ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
if (args[0] === '--self-test') { autoTest(); process.exit(0) }

const rutas = args.filter(a => !a.startsWith('--'))
const objetivosSql = []
const objetivosTs  = []

if (rutas.length) {
  for (const r of rutas) {
    const esDir = statSync(r).isDirectory()
    if (esDir) { objetivosSql.push(...listar(r, ['.sql'])); objetivosTs.push(...listar(r, ['.ts', '.tsx'])) }
    else if (extname(r) === '.sql') objetivosSql.push(r)
    else objetivosTs.push(r)
  }
} else {
  for (const d of DIRS_SQL_POR_DEFECTO) objetivosSql.push(...listar(d, ['.sql']))
  for (const d of DIRS_TS_POR_DEFECTO)  objetivosTs.push(...listar(d, ['.ts', '.tsx']))
}

let total = 0
const reportar = (archivo, h) => {
  if (!h.length) return
  total += h.length
  console.error(`\n[BLOQUEA] ${archivo.replace(/\\/g, '/')}:`)
  for (const x of h) console.error(`   . ${x}`)
}

for (const a of objetivosSql) {
  const ts = basename(a).split('_')[0]
  const legacy = /^\d{14}$/.test(ts) && ts < CUTOFF
  reportar(a, revisarSql(a, { soloR7yR8: legacy }))
}
for (const a of objetivosTs) {
  reportar(a, reglasFrontend(a, readFileSync(a, 'utf8')))
}

for (const d of DIRS_SQL_POR_DEFECTO) {
  const h = reglaTimestamps(d)
  if (h.length) { total += h.length; console.error(`\n[BLOQUEA] ${d}:`); for (const x of h) console.error(`   . ${x}`) }
}

if (total) {
  console.error(`\nGuard businesses public-read FALLÓ: ${total} hallazgo(s).`)
  process.exit(1)
}
console.log(
  `Guard businesses public-read OK (${objetivosSql.length} SQL desde el corte ${CUTOFF}, ` +
  `${objetivosTs.length} archivos del portal): sin policies ni grants de lectura para anon/PUBLIC, ` +
  `sin select('*'), fallback acotado a objeto ausente, sin loading infinito, sin rollback que reabra el P0.`,
)
