#!/usr/bin/env node
/**
 * ARCA SELF-SERVICE · WSASS homologación — guard del nombre del equipo (alias).
 *
 * Smoke real 2026-09-15: WSASS de homologación acepta sólo letras y números en "Nombre simbólico
 * del DN" y emite el certificado con CN = ese nombre. La autoridad es
 * public.arca_selfservice_prepare_initial (última definición en supabase/migrations).
 *
 *  A1  la última definición valida el alias por ambiente (CASE p_ambiente) y rechaza con
 *      INVALID_ALIAS; un ambiente desconocido cae en `ELSE false` (fail-closed).
 *  A2  comportamiento, no texto: las regex extraídas se ejecutan contra un corpus.
 *      Homologación acepta sólo [A-Za-z0-9]{3,50} (rechaza '.', '-', '_', espacios, acentos, largos);
 *      producción coincide EXACTAMENTE con la regla anterior en todo el corpus (ni más ni menos).
 *  A3  frontend = servidor: si src/lib/arcaFiscalInput.ts declara ARCA_ALIAS_PATTERNS (PR #133),
 *      sus regex por ambiente deben aceptar/rechazar lo mismo que el servidor en todo el corpus.
 *      Mientras el frontend no declare reglas por ambiente, A3 se informa y no bloquea.
 *
 *   node scripts/guards/arca-wsass-alias-contract.mjs [--self-test]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const LEGACY_PRODUCTION = '^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$'
const FRONTEND = 'src/lib/arcaFiscalInput.ts'

function diskTree() {
  return {
    read: (p) => readFileSync(p, 'utf8'),
    exists: (p) => existsSync(p),
    migrations: () => readdirSync('supabase/migrations').filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort()
      .map((f) => join('supabase/migrations', f).replace(/\\/g, '/')),
  }
}

/** Cuerpo de la última CREATE OR REPLACE FUNCTION public.arca_selfservice_prepare_initial. */
function lastPrepareBody(tree) {
  let found = null
  for (const file of tree.migrations()) {
    const sql = tree.read(file)
    const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.arca_selfservice_prepare_initial\s*\(/gi
    let m
    while ((m = re.exec(sql))) {
      const rest = sql.slice(m.index)
      const open = rest.indexOf('$function$')
      const close = rest.indexOf('$function$', open + 10)
      if (open >= 0 && close >= 0) found = { file, body: rest.slice(open + 10, close).replace(/--[^\n]*/g, '') }
    }
  }
  return found
}

const ascii = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
/** Corpus de comportamiento: casos del smoke + separadores, largos límite y no-ASCII. */
export const CORPUS = (() => {
  const out = new Set(['abc', 'ab', 'a', '', 'techrepair', 'techrepairdemohomo', 'techrepair-demo-homo', 'techrepair.demo',
    'techrepair_demo', 'techrepair demo', 'técnico', 'ñandu', 'ÁBC', 'demo/arca', 'demo@arca', 'demo#1', 'demo+1', "demo'1",
    'demo.alias2', 'qa-initial-setup', 'Demo2026', '123', 'ｔｅｃｈ', '١٢٣abc', 'tech\trepair', 'tech\nrepair', 'demo😀',
    'a'.repeat(50), 'a'.repeat(51), '9'.repeat(50), '9'.repeat(51), `a${'.'.repeat(49)}`, `a${'-'.repeat(50)}`, 'a..', 'a--', '.ab', '-ab'])
  const c1 = ['a', 'Z', '0', '.', '-', '_', ' ', 'é']
  const c2 = ['b', '9', '.', '-', '_']
  const c3 = ['c', '.', '-']
  const c4 = ['', 'd', '-', 'D']
  for (const a of c1) for (const b of c2) for (const c of c3) for (const d of c4) out.add(a + b + c + d)
  for (let i = 0; i < ascii.length; i += 7) out.add(ascii.slice(i, i + 5))
  return [...out]
})()

/** Igual que btrim(text) de PostgreSQL: sólo espacios. */
const btrim = (s) => s.replace(/^ +| +$/g, '')

const toRegExp = (pg) => {
  // Las reglas usan sólo clases ASCII y cuantificadores {m,n}: misma semántica en ARE (PG) y JS.
  if (/\\[dDwWsS]|\[\[:|\(\?/.test(pg)) throw new Error(`regex fuera del subconjunto comparable: ${pg}`)
  return new RegExp(pg)
}

export function check(tree) {
  const out = []
  const info = []
  const def = lastPrepareBody(tree)
  if (!def) return { problems: ['A1 falta public.arca_selfservice_prepare_initial'], info }

  const homo = def.body.match(/WHEN\s+'homologacion'\s+THEN\s+v_alias\s+~\s+'([^']+)'/)
  const prod = def.body.match(/WHEN\s+'produccion'\s+THEN\s+v_alias\s+~\s+'([^']+)'/)
  const block = def.body.match(/IF\s+NOT\s+\(\s*CASE\s+p_ambiente([\s\S]*?)END\s*\)\s*THEN\s*RETURN\s+jsonb_build_object\(\s*'ok',\s*false,\s*'state',\s*'INVALID_ALIAS'\s*\)/)
  if (!homo || !prod || !block) {
    out.push(`A1 ${def.file}: prepare_initial no valida el alias por ambiente con INVALID_ALIAS (¿se eliminó la validación autoritativa?)`)
    return { problems: out, info }
  }
  if (!/ELSE\s+false\s*$/.test(block[1].trim())) out.push(`A1 ${def.file}: un ambiente desconocido debe caer en ELSE false`)
  const vAlias = def.body.match(/v_alias\s+text\s*:=\s*([^;]+);/)
  if (!vAlias || !/btrim\(\s*coalesce\(\s*p_alias\s*,\s*''\s*\)\s*\)/.test(vAlias[1])) out.push(`A1 ${def.file}: v_alias debe seguir siendo btrim(coalesce(p_alias, ''))`)

  let homoRe
  let prodRe
  try { homoRe = toRegExp(homo[1]); prodRe = toRegExp(prod[1]) } catch (e) { out.push(`A2 ${e.message}`); return { problems: out, info } }
  const legacy = new RegExp(LEGACY_PRODUCTION)
  const strictHomo = /^[A-Za-z0-9]{3,50}$/

  for (const s of CORPUS) {
    const trimmed = btrim(s)
    if (homoRe.test(trimmed) !== strictHomo.test(trimmed)) {
      out.push(`A2 homologación ${homoRe.test(trimmed) ? 'acepta' : 'rechaza'} ${JSON.stringify(s)}: WSASS sólo admite letras y números (3..50)`)
    }
    if (prodRe.test(trimmed) !== legacy.test(trimmed)) {
      out.push(`A2 producción ${prodRe.test(trimmed) ? 'amplió' : 'redujo'} el contrato con ${JSON.stringify(s)} (regla anterior ${LEGACY_PRODUCTION})`)
    }
  }

  if (!tree.exists(FRONTEND)) {
    info.push(`A3 ${FRONTEND} no existe: sin espejo de frontend que comparar`)
  } else {
    const src = tree.read(FRONTEND)
    // Hasta la llave de cierre en columna 0: las regex llevan `{3,50}` adentro.
    const decl = src.match(/export\s+const\s+ARCA_ALIAS_PATTERNS\b[^=]*=\s*\{([\s\S]*?)\n\}/)
    if (!decl) {
      info.push(`A3 ${FRONTEND} todavía no declara ARCA_ALIAS_PATTERNS por ambiente (lo agrega PR #133): no se compara`)
    } else {
      const lit = (key) => {
        const m = decl[1].match(new RegExp(`${key}\\s*:\\s*/((?:\\\\/|[^/\\n])+)/([a-z]*)`))
        return m ? new RegExp(m[1], m[2]) : null
      }
      const fh = lit('homologacion')
      const fp = lit('produccion')
      if (!fh || !fp) out.push(`A3 ${FRONTEND}: ARCA_ALIAS_PATTERNS debe declarar homologacion y produccion como regex literales`)
      else {
        for (const s of CORPUS) {
          const t = btrim(s)
          if (fh.test(t) !== homoRe.test(t)) out.push(`A3 homologación: frontend y servidor divergen en ${JSON.stringify(s)}`)
          if (fp.test(t) !== prodRe.test(t)) out.push(`A3 producción: frontend y servidor divergen en ${JSON.stringify(s)}`)
        }
      }
    }
  }
  return { problems: [...new Set(out)], info }
}

function selfTest() {
  const base = diskTree()
  const clean = check(base)
  if (clean.problems.length) throw new Error(`self-test: el árbol real no está limpio:\n${clean.problems.join('\n')}`)
  const latest = base.migrations().find((f) => f.includes('arca_selfservice_wsass_homologacion_alias'))
  if (!latest) throw new Error('self-test: falta la migración WSASS')

  const overlay = (files) => ({
    ...base,
    read: (p) => (files.has(p) ? files.get(p) : base.read(p)),
    exists: (p) => files.has(p) || base.exists(p),
    migrations: () => [...new Set([...base.migrations(), ...[...files.keys()].filter((k) => k.startsWith('supabase/migrations/'))])].sort(),
  })
  const patch = (file, from, to) => {
    const src = base.read(file)
    if (!src.includes(from)) throw new Error(`self-test: «${from.slice(0, 50)}» no está en ${file}`)
    return new Map([[file, src.split(from).join(to)]])
  }
  const later = 'supabase/migrations/29991231120000_regresion_alias.sql'
  const phase2a = base.migrations().find((f) => f.includes('arca_selfservice_phase2a_initial_setup'))
  const oldFn = (() => {
    const s = base.read(phase2a)
    const i = s.indexOf('CREATE OR REPLACE FUNCTION public.arca_selfservice_prepare_initial(')
    return s.slice(i, s.indexOf('\n$function$;\n', i) + 13)
  })()
  const frontend = (homo, prod) => new Map([[FRONTEND,
    `export const ARCA_ALIAS_PATTERNS = {\n  homologacion: ${homo},\n  produccion: ${prod},\n} as const\n`]])

  const cases = [
    ['A2', 'homologación vuelve a aceptar punto y guion', overlay(patch(latest, "WHEN 'homologacion' THEN v_alias ~ '^[A-Za-z0-9]{3,50}$'", "WHEN 'homologacion' THEN v_alias ~ '^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$'"))],
    ['A2', 'homologación acepta underscore', overlay(patch(latest, "WHEN 'homologacion' THEN v_alias ~ '^[A-Za-z0-9]{3,50}$'", "WHEN 'homologacion' THEN v_alias ~ '^[A-Za-z0-9_]{3,50}$'"))],
    ['A2', 'homologación acepta 2 caracteres', overlay(patch(latest, "WHEN 'homologacion' THEN v_alias ~ '^[A-Za-z0-9]{3,50}$'", "WHEN 'homologacion' THEN v_alias ~ '^[A-Za-z0-9]{2,50}$'"))],
    ['A2', 'producción se endurece sin evidencia', overlay(patch(latest, "WHEN 'produccion'   THEN v_alias ~ '^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$'", "WHEN 'produccion'   THEN v_alias ~ '^[A-Za-z0-9]{3,50}$'"))],
    ['A2', 'producción se amplía con underscore', overlay(patch(latest, "WHEN 'produccion'   THEN v_alias ~ '^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$'", "WHEN 'produccion'   THEN v_alias ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,49}$'"))],
    ['A1', 'un ambiente desconocido pasa', overlay(patch(latest, 'ELSE false', 'ELSE true'))],
    ['A1', 'una migración posterior vuelve a la regla global', overlay(new Map([[later, oldFn]]))],
    ['A1', 'se elimina la validación del alias', overlay(new Map([[later, oldFn.replace(/  IF v_alias !~ '[^']+' THEN\n    RETURN jsonb_build_object\('ok', false, 'state', 'INVALID_ALIAS'\);\n  END IF;\n/, () => '')]]))],
    ['A1', 'v_alias deja de recortarse', overlay(patch(latest, "v_alias      text := btrim(coalesce(p_alias, ''));", "v_alias      text := coalesce(p_alias, '');"))],
    ['A3', 'frontend homologación permite guion', overlay(frontend('/^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/', '/^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/'))],
    ['A3', 'frontend producción más estricto', overlay(frontend('/^[A-Za-z0-9]{3,50}$/', '/^[A-Za-z0-9]{3,50}$/'))],
    ['A3', 'frontend declara sólo un ambiente', overlay(new Map([[FRONTEND, 'export const ARCA_ALIAS_PATTERNS = {\n  homologacion: /^[A-Za-z0-9]{3,50}$/,\n} as const\n']]))],
  ]
  let failed = 0
  for (const [rule, label, tree] of cases) {
    const got = check(tree).problems
    if (!got.some((g) => g.startsWith(rule))) { failed++; console.error(`❌ no detectó «${label}» (esperado ${rule}; obtenido: ${got.slice(0, 3).join(' | ') || 'nada'})`) }
    else console.log(`✅ detecta: ${label}`)
  }
  // Control positivo: un frontend espejo correcto no reporta divergencias.
  const mirror = check(overlay(frontend('/^[A-Za-z0-9]{3,50}$/', '/^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/')))
  if (mirror.problems.length) { failed++; console.error(`❌ un espejo correcto reporta problemas: ${mirror.problems.join(' | ')}`) }
  else console.log('✅ acepta: frontend espejo correcto')
  if (failed) { console.error(`\n❌ self-test ARCA WSASS alias: ${failed} fallo(s)`); process.exit(1) }
  console.log(`\n✅ Self-test ARCA WSASS alias: ${cases.length} regresiones plantadas detectadas, espejo correcto aceptado (corpus ${CORPUS.length}).`)
}

const isCLI = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('arca-wsass-alias-contract.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const { problems, info } = check(diskTree())
  for (const i of info) console.log(`ℹ️  ${i}`)
  if (problems.length) {
    console.error('❌ Guard ARCA WSASS alias:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(`✅ Guard ARCA WSASS alias OK: homologación sólo letras y números (3..50), producción igual a la regla anterior, validación autoritativa en prepare_initial (corpus ${CORPUS.length}).`)
}
