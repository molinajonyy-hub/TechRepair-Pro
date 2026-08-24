#!/usr/bin/env node
// ============================================================================
// P0 Seguridad — Guard de EXPOSICION de funciones SECURITY DEFINER.
//
// COMPLEMENTA a guard-security-definer.mjs, NO lo duplica:
//   · guard-security-definer.mjs  -> HIGIENE del cuerpo (search_path, pg_temp,
//                                    referencias calificadas).
//   · este archivo                -> QUIEN puede ejecutarla (grants, allowlist,
//                                    guards internos, colisiones de timestamp).
// Una sola regla por guard; si una regla aparece en los dos, es un bug.
//
// Falla (exit 1) cuando:
//   R1. una SECURITY DEFINER recibe EXECUTE para `anon` o PUBLIC y no esta en
//       la ALLOWLIST_ANON;
//   R2. se declara una SECURITY DEFINER sin REVOKE ... FROM PUBLIC explicito
//       (EXECUTE a PUBLIC es el DEFAULT de PostgreSQL: nace abierta);
//   R3. se usa `proacl IS NULL` como prueba de "no tiene permisos" sin
//       contrastarlo con has_function_privilege (proacl NULL = default PUBLIC,
//       es un FALSO NEGATIVO — el mismo error que `aclexplode(NULL)`);
//   R4. se reponen privilegios en bloque (ON ALL FUNCTIONS / ALTER DEFAULT
//       PRIVILEGES) hacia anon o authenticated;
//   R5. una funcion sensible se reescribe perdiendo su guard interno;
//   R6. hay dos migraciones con el MISMO timestamp (el incidente que obligo a
//       descartar las dos ramas rivales de este P0).
//
//   node scripts/finance/guard-secdef-exposure.mjs [archivo|dir ...]
//   node scripts/finance/guard-secdef-exposure.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

// ── Allowlist anon ──────────────────────────────────────────────────────────
// UNICA lista autoritativa del lado del repo. Tiene que coincidir con la de la
// migracion 20260804120000 (postcondicion 1). Solo dos clases entran aca:
//   a) superficies publicas intencionales del portal mayorista;
//   b) helpers de RLS derivados de auth.uid(), INERTES para anon, exigidos por
//      policies {public} (current_business_id aparece en 95, is_staff en 81).
const ALLOWLIST_ANON = new Set([
  'get_wholesale_portal_public',
  'get_wholesale_portal_features',
  'current_business_id',
  'current_user_business_id',
  'current_user_role',
  'user_business_ids',
  'is_staff',
  'can_manage',
])

// Funciones cuyo guard interno no se puede perder en un CREATE OR REPLACE.
const SENSIBLES = [
  /^arca_/, /^whatsapp_/, /^encrypt_data$/, /^decrypt_data$/,
  // `bootstrap_owner_profile` se retiro en 20260823180000 (P0-P1 fase B); el
  // patron se conserva para que reintroducirla no pase inadvertido.
  /^bootstrap_owner_profile$/, /^provision_my_business$/,
  /^recalculate_product_prices$/,
  /^get_business_subscription$/, /^get_business_subscription_features$/,
  /^pay_card_statement_atomic$/,
]
const TOKENS_GUARD = [
  '_require_platform_admin', '_require_business_member', 'auth.uid()',
  'current_user_business_id', 'is_platform_admin',
]

// Las reglas de grants miran hacia ADELANTE: la deuda historica es justamente
// lo que limpia 20260804120000. Antes de ese corte solo se aplica R6.
const CUTOFF = '20260804120000'

function despojar(s) {
  let out = '', i = 0
  while (i < s.length) {
    if (s.slice(i, i + 2) === '--') { const f = s.indexOf('\n', i); const e = f === -1 ? s.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (s.slice(i, i + 2) === '/*') { const f = s.indexOf('*/', i + 2); const e = f === -1 ? s.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += s[i]; i++
  }
  return out
}

/** Nombre de funcion sin schema ni comillas. */
function pelar(nombre) {
  return nombre.replace(/"/g, '').split('.').pop().toLowerCase()
}

/** Declaraciones SECURITY DEFINER del archivo: [{ nombre, cuerpo }]. */
function declaraciones(limpio, crudo) {
  const out = []
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+("?[\w]+"?\."?[\w]+"?|"?[\w]+"?)\s*\(/gi
  let m
  while ((m = re.exec(limpio)) !== null) {
    const marca = limpio.indexOf('$', m.index)
    const decl = limpio.slice(m.index, marca === -1 ? m.index + 600 : marca)
    if (!/SECURITY\s+DEFINER/i.test(decl)) continue
    const dm = crudo.slice(m.index).match(/\$(\w*)\$/)
    let cuerpo = ''
    if (dm) {
      const d = dm[0]
      const a = crudo.indexOf(d, m.index) + d.length
      const b = crudo.indexOf(d, a)
      cuerpo = b === -1 ? '' : crudo.slice(a, b)
    }
    out.push({
      nombre: pelar(m[1]),
      cuerpo,
      esReplace: /OR\s+REPLACE/i.test(m[0]),
      // `decl` va desde CREATE hasta el primer `$`, asi que incluye el RETURNS.
      retornaTrigger: /RETURNS\s+trigger\b/i.test(decl),
    })
  }
  return out
}

function revisarArchivo(archivo, { soloR6 = false } = {}) {
  const crudo = readFileSync(archivo, 'utf8')
  const limpio = despojar(crudo)
  const hallazgos = []
  if (soloR6) return hallazgos

  const decls = declaraciones(limpio, crudo)

  // ── R1: EXECUTE a anon/PUBLIC fuera de la allowlist ───────────────────────
  const reGrant = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+("?[\w]+"?\."?[\w]+"?|"?[\w]+"?)\s*\([^)]*\)\s*TO\s+("?[\w]+"?)/gi
  let g
  while ((g = reGrant.exec(limpio)) !== null) {
    const fn = pelar(g[1])
    const rol = g[2].replace(/"/g, '').toLowerCase()
    if ((rol === 'anon' || rol === 'public') && !ALLOWLIST_ANON.has(fn)) {
      hallazgos.push(`R1 ${fn}: GRANT EXECUTE a ${rol} fuera de ALLOWLIST_ANON`)
    }
  }

  // ── R2: SECDEF declarada sin REVOKE ... FROM PUBLIC ───────────────────────
  //
  // EXENCION UNICA Y ACOTADA: `CREATE OR REPLACE` de una funcion que YA esta en
  // ALLOWLIST_ANON. Para esas ocho, ser ejecutable por anon ES el contrato
  // intencional (helpers de RLS inertes sin sesion + superficies publicas del
  // portal), asi que exigirles `REVOKE ... FROM PUBLIC` es contradictorio con la
  // propia allowlist. Y sobre una funcion existente `CREATE OR REPLACE` PRESERVA
  // el ACL: no aplica la premisa de R2 ("nace abierta").
  //
  // La exencion NO cubre un `CREATE FUNCTION` pelado, ni ninguna funcion fuera
  // de la allowlist: ahi la premisa sigue valiendo y R2 sigue bloqueando.
  //
  // Motivo concreto: 20260822160000 tiene que cambiar el CUERPO de
  // current_business_id() (sin eso, un perfil reparado por
  // link_profile_to_auth_user deja 96 policies negando). MEDIDO contra
  // produccion: cerrarla a PUBLIC le sacaria EXECUTE a 26 roles, entre ellos
  // authenticator, supabase_realtime_admin, supabase_storage_admin y
  // supabase_auth_admin. Ese cierre merece su propio lote con verificacion de
  // realtime y storage, no colarse en un P0 de auth.
  // SEGUNDA EXENCION, IGUAL DE ACOTADA: funciones que retornan `trigger`.
  //
  // R2 existe porque una SECDEF "nace abierta": EXECUTE a PUBLIC es el default
  // de PostgreSQL, asi que anon podria INVOCARLA. Sobre una funcion de trigger
  // esa premisa no se sostiene, y esta MEDIDO (2026-08-23, stack local):
  //
  //   SET LOCAL ROLE anon; PERFORM public.handle_new_user();
  //   -> SQLSTATE 0A000: trigger functions can only be called as triggers
  //
  // Aunque tenga EXECUTE, NADIE puede invocarla: ni por SQL directo ni por
  // PostgREST, que sólo expone funciones con retorno distinto de `trigger`.
  // Un REVOKE ahi no cierra nada — no hay superficie que cerrar.
  //
  // La exencion es por RETORNO, no por nombre: cualquier funcion invocable
  // sigue cayendo bajo R2 aunque este en la misma migracion. Las fixtures
  // "R2 trigger" del self-test fijan las dos mitades del contrato.
  for (const d of decls) {
    if (d.esReplace && ALLOWLIST_ANON.has(d.nombre)) continue
    if (d.retornaTrigger) continue
    const reRevoke = new RegExp(
      `REVOKE\\s+(?:ALL|EXECUTE)[\\s\\S]{0,200}?ON\\s+FUNCTION\\s+(?:"?\\w+"?\\.)?"?${d.nombre}"?\\s*\\([^)]*\\)[\\s\\S]{0,80}?FROM\\s+PUBLIC`, 'i')
    if (!reRevoke.test(limpio)) {
      hallazgos.push(`R2 ${d.nombre}: SECURITY DEFINER sin REVOKE ... FROM PUBLIC (nace abierta a anon)`)
    }
  }

  // ── R5: funcion sensible reescrita sin guard ──────────────────────────────
  // El cuerpo se normaliza sacando las comillas dobles: el repo escribe los
  // identificadores calificados (`"auth"."uid"()`), y sin normalizar el token
  // `auth.uid()` nunca casaria -> falso positivo sobre codigo correcto.
  for (const d of decls) {
    if (!SENSIBLES.some(re => re.test(d.nombre))) continue
    const cuerpo = d.cuerpo.replace(/"/g, '')
    if (!TOKENS_GUARD.some(t => cuerpo.includes(t))) {
      hallazgos.push(`R5 ${d.nombre}: funcion sensible reescrita SIN guard interno`)
    }
  }

  // ── R3: proacl IS NULL como prueba de ausencia de permiso ─────────────────
  if (/proacl\s+IS\s+NULL/i.test(limpio) && !/has_function_privilege/i.test(limpio)) {
    hallazgos.push('R3: usa `proacl IS NULL` sin has_function_privilege (proacl NULL = default PUBLIC: falso negativo)')
  }

  // ── R4: reposicion masiva de privilegios ──────────────────────────────────
  // Dos formas distintas, y el orden de las palabras NO es el mismo en las dos:
  //   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
  //   ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon;
  const MASIVOS = [
    { re: /ON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA[\s\S]{0,120}?TO\s+"?(anon|authenticated)"?/gi,
      etq: 'ON ALL FUNCTIONS IN SCHEMA' },
    { re: /ALTER\s+DEFAULT\s+PRIVILEGES[\s\S]{0,240}?GRANT[\s\S]{0,120}?TO\s+"?(anon|authenticated)"?/gi,
      etq: 'ALTER DEFAULT PRIVILEGES' },
  ]
  for (const { re, etq } of MASIVOS) {
    let mm
    re.lastIndex = 0
    while ((mm = re.exec(limpio)) !== null) {
      hallazgos.push(`R4: GRANT en bloque hacia ${mm[1]} (${etq})`)
    }
  }

  return hallazgos
}

/** R6: colision de timestamps entre migraciones. */
function revisarTimestamps(dir) {
  const hallazgos = []
  let archivos
  try { archivos = readdirSync(dir).filter(f => f.endsWith('.sql')) } catch { return hallazgos }
  const porTs = new Map()
  for (const f of archivos) {
    const ts = basename(f).split('_')[0]
    if (!/^\d{14}$/.test(ts)) continue
    if (!porTs.has(ts)) porTs.set(ts, [])
    porTs.get(ts).push(f)
  }
  for (const [ts, fs] of porTs) {
    if (fs.length > 1) hallazgos.push(`R6 timestamp ${ts} duplicado: ${fs.join(', ')}`)
  }
  return hallazgos
}

// ── self-test ───────────────────────────────────────────────────────────────
const FIXTURES = [
  // ── Exencion R2: funciones de trigger (no son invocables por nadie) ───────
  { nombre: 'R2 trigger: SECDEF que retorna trigger, sin REVOKE', debeFallar: false, sql:
`CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
 AS $$ begin return new; end; $$;` },

  // La otra mitad: la exencion NO puede filtrarse a una funcion invocable
  // declarada en el mismo archivo.
  { nombre: 'R2 trigger: una funcion INVOCABLE en el mismo archivo sigue bloqueando', debeFallar: true, sql:
`CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
 AS $$ begin return new; end; $$;
CREATE FUNCTION public.cobrar_todo(p uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
 AS $$ begin perform 1; end; $$;` },

  // ── Exencion R2: CREATE OR REPLACE de una funcion de ALLOWLIST_ANON ───────
  { nombre: 'R2 exenta: OR REPLACE de una funcion de la allowlist, sin REVOKE', debeFallar: false, sql:
`CREATE OR REPLACE FUNCTION public.current_business_id() RETURNS uuid LANGUAGE sql
 STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
 AS $$ SELECT p.business_id FROM public.profiles p WHERE COALESCE(p.user_id, p.id) = auth.uid() LIMIT 1 $$;` },
  { nombre: 'R2 NO exenta: CREATE pelado de una funcion de la allowlist', debeFallar: true, sql:
`CREATE FUNCTION public.current_business_id() RETURNS uuid LANGUAGE sql
 STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
 AS $$ SELECT 1 $$;` },
  { nombre: 'R2 NO exenta: OR REPLACE de una funcion FUERA de la allowlist', debeFallar: true, sql:
`CREATE OR REPLACE FUNCTION public.get_my_profile() RETURNS uuid LANGUAGE sql
 STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
 AS $$ SELECT 1 $$;` },
  { nombre: 'SECDEF con REVOKE y grant sólo a authenticated', debeFallar: false, sql:
`CREATE FUNCTION public.f1(a uuid) RETURNS int LANGUAGE sql SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION public.f1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.f1(uuid) TO authenticated;` },
  { nombre: 'R1 grant a anon fuera de allowlist', debeFallar: true, sql:
`CREATE FUNCTION public.f2(a uuid) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION public.f2(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.f2(uuid) TO anon;` },
  { nombre: 'R1 grant a anon DENTRO de allowlist', debeFallar: false, sql:
`CREATE FUNCTION public.get_wholesale_portal_public(p text) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION public.get_wholesale_portal_public(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_wholesale_portal_public(text) TO anon;` },
  { nombre: 'R2 SECDEF sin REVOKE', debeFallar: true, sql:
`CREATE FUNCTION public.f3(a uuid) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;` },
  { nombre: 'R2 no aplica a SECURITY INVOKER', debeFallar: false, sql:
`CREATE FUNCTION public.f4(a uuid) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;` },
  { nombre: 'R3 proacl IS NULL solo', debeFallar: true, sql:
`SELECT proname FROM pg_proc WHERE proacl IS NULL;` },
  { nombre: 'R3 proacl IS NULL + has_function_privilege', debeFallar: false, sql:
`SELECT proname FROM pg_proc WHERE proacl IS NULL AND has_function_privilege('anon', oid, 'EXECUTE');` },
  { nombre: 'R4 ON ALL FUNCTIONS a authenticated', debeFallar: true, sql:
`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;` },
  { nombre: 'R5 sensible sin guard', debeFallar: true, sql:
`CREATE OR REPLACE FUNCTION public.bootstrap_owner_profile(e text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
 AS $$ BEGIN RETURN gen_random_uuid(); END $$;
REVOKE ALL ON FUNCTION public.bootstrap_owner_profile(text) FROM PUBLIC;` },
  { nombre: 'R5 sensible CON guard', debeFallar: false, sql:
`CREATE OR REPLACE FUNCTION public.bootstrap_owner_profile(e text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
 AS $$ DECLARE v uuid := auth.uid(); BEGIN RETURN v; END $$;
REVOKE ALL ON FUNCTION public.bootstrap_owner_profile(text) FROM PUBLIC;` },
]

function autoTest() {
  const dir = mkdtempSync(join(tmpdir(), 'sdexp-'))
  let fallas = 0
  for (const f of FIXTURES) {
    const p = join(dir, 'fx.sql')
    writeFileSync(p, f.sql)
    const h = revisarArchivo(p)
    const fallo = h.length > 0
    const ok = fallo === f.debeFallar
    if (!ok) fallas++
    console.log(`${ok ? 'OK  ' : 'FALLA'} fixture "${f.nombre}": esperaba ${f.debeFallar ? 'FALLA' : 'OK'}, obtuvo ${fallo ? 'FALLA' : 'OK'}${fallo ? ` (${h[0]})` : ''}`)
  }
  // R6 sobre un directorio con colision
  const d2 = mkdtempSync(join(tmpdir(), 'sdexp-ts-'))
  writeFileSync(join(d2, '20260803140000_a.sql'), '')
  writeFileSync(join(d2, '20260803140000_b.sql'), '')
  const h6 = revisarTimestamps(d2)
  const ok6 = h6.length === 1
  if (!ok6) fallas++
  console.log(`${ok6 ? 'OK  ' : 'FALLA'} fixture "R6 timestamps duplicados": ${h6[0] || 'no detectado'}`)

  const d3 = mkdtempSync(join(tmpdir(), 'sdexp-ts2-'))
  writeFileSync(join(d3, '20260803140000_a.sql'), '')
  writeFileSync(join(d3, '20260804120000_b.sql'), '')
  const h7 = revisarTimestamps(d3)
  const ok7 = h7.length === 0
  if (!ok7) fallas++
  console.log(`${ok7 ? 'OK  ' : 'FALLA'} fixture "R6 timestamps unicos": ${h7[0] || 'sin hallazgos'}`)

  if (fallas) { console.error(`\nself-test: ${fallas} fixture(s) mal clasificadas`); process.exit(1) }
  console.log(`\nself-test OK: ${FIXTURES.length + 2} fixtures clasificadas correctamente`)
}

// ── main ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
if (args[0] === '--self-test') { autoTest(); process.exit(0) }

const rutas = args.filter(a => !a.startsWith('--'))
const objetivos = rutas.length ? rutas : ['supabase/migrations']
const archivos = []
for (const t of objetivos) {
  if (statSync(t).isDirectory()) for (const f of readdirSync(t)) { if (f.endsWith('.sql')) archivos.push(join(t, f)) }
  else archivos.push(t)
}

let total = 0
for (const a of archivos) {
  const ts = basename(a).split('_')[0]
  const legacy = /^\d{14}$/.test(ts) && ts < CUTOFF
  const h = revisarArchivo(a, { soloR6: legacy })
  if (!h.length) continue
  total += h.length
  console.error(`\n[BLOQUEA] ${a.replace(/\\/g, '/')}:`)
  for (const x of h) console.error(`   . ${x}`)
}

for (const t of objetivos) {
  if (!statSync(t).isDirectory()) continue
  const h = revisarTimestamps(t)
  if (!h.length) continue
  total += h.length
  console.error(`\n[BLOQUEA] ${t}:`)
  for (const x of h) console.error(`   . ${x}`)
}

if (total) {
  console.error(`\nGuard SECDEF exposicion FALLO: ${total} hallazgo(s).`)
  process.exit(1)
}
console.log(`Guard SECDEF exposicion OK (${archivos.length} archivos, corte ${CUTOFF}): ` +
  `sin grants a anon fuera de la allowlist (${ALLOWLIST_ANON.size}), sin SECDEF sin REVOKE, sin timestamps duplicados.`)
