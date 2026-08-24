#!/usr/bin/env node
// ============================================================================
// P0-P1 — Guard de AUTORIDAD DE PROVISIONING.
//
// Estatico: lee migraciones y `src/`. No necesita credenciales ni DB, asi que
// corre en el job `quality` del CI, en PRs y en forks.
//
// Protege las dos invariantes que este lote establecio y que una migracion o un
// refactor inocente pueden deshacer sin que nadie lo note:
//
//   R1. `anon`/`authenticated` NO reciben INSERT/UPDATE/DELETE sobre `profiles`
//       ni `businesses`. Es lo que obliga a que toda escritura estructural pase
//       por una SECURITY DEFINER. Las policies de escritura de esas tablas
//       existen pero son codigo muerto: reponer el GRANT las despertaria, y
//       `profiles_update` permite reescribir `business_id` y `role` de la
//       propia fila.
//
//   R2. UNA sola autoridad creadora de tenants: despues del corte, ninguna
//       funcion nueva puede insertar en `businesses` salvo
//       `provision_my_business`.
//
//   R3. El provisioning automatico no vuelve: ninguna migracion posterior al
//       corte recrea `handle_new_user`, `bootstrap_owner_profile` ni un trigger
//       de provisioning sobre `auth.users`.
//
//   R4. Del lado del cliente, la RPC se invoca UNICAMENTE desde el servicio
//       canonico, y NUNCA desde el portal mayorista (un cliente mayorista no
//       debe fabricarse un tenant SaaS: se midieron 2 de 2 antes del lote).
//
//   node scripts/guards/provisioning-authority.mjs
//   node scripts/guards/provisioning-authority.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, relative } from 'node:path'

const AUTO_TEST = process.argv.includes('--self-test')

// El corte es la migracion de la fase B. Antes de ella la deuda historica es
// justamente lo que el lote limpia: mirar hacia atras daria falsos positivos
// sobre el baseline, que contiene handle_new_user y bootstrap_owner_profile.
const CUTOFF = '20260823180000'

const RPC = 'provision_my_business'
const SERVICIO_CANONICO = 'src/services/provisioningService.ts'

/** Reemplaza comentarios por espacios, conservando offsets. */
function despojar(s) {
  let out = '', i = 0
  while (i < s.length) {
    if (s.slice(i, i + 2) === '--') { const f = s.indexOf('\n', i); const e = f === -1 ? s.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (s.slice(i, i + 2) === '/*') { const f = s.indexOf('*/', i + 2); const e = f === -1 ? s.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += s[i]; i++
  }
  return out
}

/** Comentarios de JS/TS: `//` y `/* *​/`. */
function despojarJs(s) {
  return despojar(s.replace(/(^|[^:])\/\//g, (m, p) => p + '--'))
}

function archivosSql(dir) {
  let out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out = out.concat(archivosSql(p))
    else if (e.endsWith('.sql')) out.push(p)
  }
  return out
}

function archivosFuente(dir) {
  let out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out = out.concat(archivosFuente(p))
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

/** Declaraciones de funcion: [{ nombre, cuerpo }]. */
function declaraciones(limpio, crudo) {
  const out = []
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+("?[\w]+"?\."?[\w]+"?|"?[\w]+"?)\s*\(/gi
  let m
  while ((m = re.exec(limpio)) !== null) {
    const nombre = m[1].replace(/"/g, '').split('.').pop().toLowerCase()
    const dm = crudo.slice(m.index).match(/\$(\w*)\$/)
    let cuerpo = ''
    if (dm) {
      const d = dm[0]
      const a = crudo.indexOf(d, m.index) + d.length
      const b = crudo.indexOf(d, a)
      cuerpo = b === -1 ? '' : crudo.slice(a, b)
    }
    out.push({ nombre, cuerpo })
  }
  return out
}

// ── Reglas SQL ──────────────────────────────────────────────────────────────
function revisarMigracion(archivo) {
  const nombre = basename(archivo)
  const ts = (nombre.match(/^(\d{14})/) || [])[1]
  if (!ts || ts < CUTOFF) return []

  const crudo = readFileSync(archivo, 'utf8')
  const limpio = despojar(crudo)
  const h = []

  // R1 · GRANT de DML estructural al cliente.
  const reGrant = /GRANT\s+([A-Z ,]+?)\s+(?:\([^)]*\)\s*)?ON\s+(?:TABLE\s+)?("?public"?\.)?"?(profiles|businesses)"?\s+TO\s+("?\w+"?)/gi
  let g
  while ((g = reGrant.exec(limpio)) !== null) {
    const privs = g[1].toUpperCase()
    const tabla = g[3]
    const rol = g[4].replace(/"/g, '').toLowerCase()
    if (!['anon', 'authenticated', 'public'].includes(rol)) continue
    if (/\b(INSERT|UPDATE|DELETE|ALL)\b/.test(privs)) {
      h.push(`R1 ${nombre}: GRANT ${privs.trim()} sobre ${tabla} a ${rol}. Reponer DML estructural despierta policies de escritura que hoy son codigo muerto.`)
    }
  }

  const decls = declaraciones(limpio, crudo)

  // R2 · una sola autoridad creadora.
  for (const d of decls) {
    if (d.nombre === RPC) continue
    if (/insert\s+into\s+("?public"?\.)?"?businesses"?/i.test(despojar(d.cuerpo))) {
      h.push(`R2 ${nombre}: ${d.nombre}() inserta en businesses. La unica autoridad creadora de tenants es ${RPC}().`)
    }
  }

  // R3 · el provisioning automatico no vuelve.
  for (const d of decls) {
    if (d.nombre === 'handle_new_user' || d.nombre === 'bootstrap_owner_profile') {
      h.push(`R3 ${nombre}: recrea ${d.nombre}(), retirada en ${CUTOFF}.`)
    }
  }
  const reTrig = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)[\s\S]{0,400}?ON\s+"?auth"?\."?users"?[\s\S]{0,200}?EXECUTE\s+(?:PROCEDURE|FUNCTION)\s+("?[\w]+"?\."?[\w]+"?|"?[\w]+"?)/gi
  let t
  while ((t = reTrig.exec(limpio)) !== null) {
    const fn = t[2].replace(/"/g, '').split('.').pop().toLowerCase()
    const decl = decls.find(d => d.nombre === fn)
    const cuerpo = decl ? despojar(decl.cuerpo) : ''
    const provisiona = fn === 'handle_new_user' ||
      /insert\s+into\s+("?public"?\.)?"?(profiles|businesses)"?/i.test(cuerpo)
    if (provisiona) {
      h.push(`R3 ${nombre}: el trigger ${t[1]} sobre auth.users ejecuta ${fn}(), que provisiona. Confirmar identidad no puede volver a crear tenants.`)
    }
  }

  return h
}

// ── Reglas de frontend ──────────────────────────────────────────────────────
function revisarFuente(archivo, raiz) {
  const rel = relative(raiz, archivo).replace(/\\/g, '/')
  const limpio = despojarJs(readFileSync(archivo, 'utf8'))
  const h = []

  const invocaRpc = new RegExp(`rpc\\(\\s*['"\`]${RPC}['"\`]`).test(limpio)
  if (invocaRpc && !rel.endsWith('services/provisioningService.ts')) {
    h.push(`R4 ${rel}: invoca ${RPC} directo. Tiene que pasar por ${SERVICIO_CANONICO}.`)
  }

  // El portal mayorista no provisiona tenants SaaS, ni por la RPC ni por el
  // servicio.
  if (/^src\/portal\//.test(rel) && (invocaRpc || /provisionMyBusiness\s*\(/.test(limpio))) {
    h.push(`R4 ${rel}: el portal mayorista no puede provisionar un tenant SaaS.`)
  }

  if (/rpc\(\s*['"`]bootstrap_owner_profile['"`]/.test(limpio)) {
    h.push(`R4 ${rel}: invoca bootstrap_owner_profile, retirada en ${CUTOFF}.`)
  }

  return h
}

function correr(raiz) {
  const h = []
  const dirMig = join(raiz, 'supabase/migrations')
  for (const f of archivosSql(dirMig)) h.push(...revisarMigracion(f))
  const dirSrc = join(raiz, 'src')
  for (const f of archivosFuente(dirSrc)) h.push(...revisarFuente(f, raiz))
  return h
}

// ── Self-test: cada regla tiene que DISPARAR ────────────────────────────────
const CASOS = [
  {
    nombre: 'R1 GRANT UPDATE sobre profiles a authenticated',
    debeFallar: true,
    mig: `GRANT UPDATE ON TABLE public.profiles TO authenticated;`,
  },
  {
    nombre: 'R1 GRANT ALL sobre businesses a anon',
    debeFallar: true,
    mig: `GRANT ALL ON public.businesses TO anon;`,
  },
  {
    nombre: 'R1 GRANT SELECT (permitido)',
    debeFallar: false,
    mig: `GRANT SELECT ON TABLE public.profiles TO authenticated;`,
  },
  {
    nombre: 'R2 segunda funcion que crea businesses',
    debeFallar: true,
    mig: `CREATE FUNCTION public.otra_autoridad() RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.businesses (name) VALUES ('x'); RETURN NULL; END $$;`,
  },
  {
    nombre: 'R2 la autoridad canonica SI puede',
    debeFallar: false,
    mig: `CREATE OR REPLACE FUNCTION public.provision_my_business(p text) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.businesses (name) VALUES ('x'); RETURN NULL; END $$;`,
  },
  {
    nombre: 'R3 recrear handle_new_user',
    debeFallar: true,
    mig: `CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RETURN new; END $$;`,
  },
  {
    nombre: 'R3 trigger de provisioning sobre auth.users',
    debeFallar: true,
    mig: `CREATE FUNCTION public.reprovision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.profiles (id, business_id) VALUES (new.id, gen_random_uuid()); RETURN new; END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.reprovision();`,
  },
  {
    nombre: 'R3 trigger inocente sobre auth.users (permitido)',
    debeFallar: false,
    mig: `CREATE FUNCTION public.solo_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.audit_log (x) VALUES (new.id); RETURN new; END $$;
CREATE TRIGGER on_auth_audit AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.solo_log();`,
  },
  {
    nombre: 'R4 una pantalla invoca la RPC directo',
    debeFallar: true,
    src: { 'src/pages/Algo.tsx': `await supabase.rpc('${RPC}', { p_business_name: 'x' })` },
  },
  {
    nombre: 'R4 el portal provisiona',
    debeFallar: true,
    src: { 'src/portal/services/x.ts': `await provisionMyBusiness('x')` },
  },
  {
    nombre: 'R4 el servicio canonico SI puede',
    debeFallar: false,
    src: { 'src/services/provisioningService.ts': `await supabase.rpc('${RPC}', {})` },
  },
  {
    nombre: 'R4 llamador de la RPC retirada',
    debeFallar: true,
    src: { 'src/pages/Viejo.tsx': `await supabase.rpc('bootstrap_owner_profile', {})` },
  },
  {
    nombre: 'R4 mencion en comentario (permitido)',
    debeFallar: false,
    src: { 'src/pages/Doc.tsx': `// antes usaba rpc('bootstrap_owner_profile', {})\nconst x = 1` },
  },
]

function autoTest() {
  let fallos = 0
  for (const c of CASOS) {
    const raiz = mkdtempSync(join(tmpdir(), 'provauth-'))
    mkdirSync(join(raiz, 'supabase/migrations'), { recursive: true })
    mkdirSync(join(raiz, 'src'), { recursive: true })
    if (c.mig) writeFileSync(join(raiz, 'supabase/migrations/20260901120000_caso.sql'), c.mig)
    for (const [rel, contenido] of Object.entries(c.src ?? {})) {
      const p = join(raiz, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, contenido)
    }
    const h = correr(raiz)
    const fallo = h.length > 0
    const ok = fallo === c.debeFallar
    console.log(`  ${ok ? '✓' : '✗'} ${c.nombre} ${ok ? '' : `-> esperaba ${c.debeFallar ? 'FALLO' : 'OK'}, hubo ${fallo ? 'FALLO' : 'OK'}${h.length ? ': ' + h[0] : ''}`}`)
    if (!ok) fallos++
  }
  if (fallos) {
    console.error(`\n✖ SELF-TEST: ${fallos} caso(s) no se comportaron como se espera. El guard no mide lo que dice medir.\n`)
    process.exit(1)
  }
  console.log(`\n✓ self-test OK: ${CASOS.length}/${CASOS.length}. Cada regla dispara y ninguna es un falso positivo.\n`)
}

// ── Main ────────────────────────────────────────────────────────────────────
if (AUTO_TEST) {
  console.log('\n─── Guard de autoridad de provisioning · self-test ' + '─'.repeat(21))
  autoTest()
} else {
  const h = correr(process.cwd())
  if (h.length) {
    console.error('\n✖ AUTORIDAD DE PROVISIONING VIOLADA\n')
    for (const x of h) console.error('  · ' + x)
    console.error('')
    process.exit(1)
  }
  console.log('✓ autoridad de provisioning intacta: una sola creadora de tenants, sin DML estructural para el cliente.')
}
