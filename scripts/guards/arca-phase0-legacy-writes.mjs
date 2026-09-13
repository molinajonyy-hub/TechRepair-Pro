#!/usr/bin/env node
/**
 * ARCA SELF-SERVICE · PHASE 0 — guard estático de escrituras legacy y autoridad.
 *
 * Falla (exit 1) si vuelve a abrirse alguno de los caminos que Phase 0 cerró:
 *
 *  F1  el frontend (src/**) menciona en CÓDIGO `private_key_pem`, las RPC retiradas
 *      (save_arca_certificate_legacy, set_arca_estado_conexion), los métodos
 *      cliente retirados (saveCertificate, setEstadoConexion), cualquier
 *      from('arca_config') o una invocación a `arca-credentials`.
 *  E1  `arca-credentials` deja de ser un stub 410 sin lectura de body, sin cliente
 *      Supabase, sin RPC y sin criptografía.
 *  E2  alguna Edge Function lee una clave privada del body del request.
 *  E3  un Edge de gestión ARCA (rotate-prepare/activate) no usa la autoridad
 *      canónica (authorizeArcaManager + resolveManagedBusiness), toma el tenant
 *      del body o valida identidad por su cuenta con auth.getUser().
 *  E4  la autoridad compartida deja de exigir settings_sensitive + owner/admin,
 *      o acepta credenciales de servidor como actor de gestión.
 *  M1  falta la migración Phase 0 o le falta el REVOKE de tabla / el DROP POLICY.
 *  M2  una migración POSTERIOR re-otorga escritura de arca_config a anon/
 *      authenticated/PUBLIC, crea una policy no-service_role sobre arca_config,
 *      re-otorga EXECUTE sobre una RPC retirada o sobre la autoridad privada, o
 *      debilita private.arca_actor_can_manage / save_arca_config_legacy.
 *
 *   node scripts/guards/arca-phase0-legacy-writes.mjs [--self-test]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PHASE0_MIGRATION = 'supabase/migrations/20260928120000_arca_selfservice_phase0_hardening.sql'
const PHASE0_VERSION = '20260928120000'
const MANAGEMENT_EDGES = [
  'supabase/functions/arca-rotate-prepare/index.ts',
  'supabase/functions/arca-rotate-activate/index.ts',
]
const CREDENTIALS_STUB = ['supabase/functions/arca-credentials/index.ts', 'supabase/functions/arca-credentials/handler.ts']
const SHARED_AUTHORITY = 'supabase/functions/_shared/arcaManagementAuthority.ts'

function stripJsComments(src) {
  let out = '', i = 0, quote = null
  while (i < src.length) {
    const ch = src[i]
    if (quote) {
      out += ch
      if (ch === '\\') { out += src[i + 1] ?? ''; i += 2; continue }
      if (ch === quote) quote = null
      i++; continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i++; continue }
    if (src.startsWith('//', i)) { const f = src.indexOf('\n', i); const e = f === -1 ? src.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (src.startsWith('/*', i)) { const f = src.indexOf('*/', i + 2); const e = f === -1 ? src.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += ch; i++
  }
  return out
}

function stripSqlComments(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.startsWith('--', i)) { const f = sql.indexOf('\n', i); const e = f === -1 ? sql.length : f; out += ' '.repeat(e - i); i = e; continue }
    if (sql.startsWith('/*', i)) { const f = sql.indexOf('*/', i + 2); const e = f === -1 ? sql.length : f + 2; out += ' '.repeat(e - i); i = e; continue }
    out += sql[i]; i++
  }
  return out
}

function diskTree(root) {
  const walk = (dir, re) => {
    let entries
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }) } catch { return [] }
    return entries.flatMap((e) => {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) return walk(rel, re)
      return re.test(e.name) ? [rel] : []
    })
  }
  return {
    read: (rel) => readFileSync(join(root, rel), 'utf8'),
    exists: (rel) => { try { return statSync(join(root, rel)).isFile() } catch { return false } },
    list: (dir, re) => walk(dir, re),
  }
}

function overlayTree(base, overrides) {
  return {
    read: (rel) => (overrides.has(rel) ? overrides.get(rel) : base.read(rel)),
    exists: (rel) => overrides.has(rel) || base.exists(rel),
    list: (dir, re) => [...new Set([
      ...base.list(dir, re),
      ...[...overrides.keys()].filter((k) => k.startsWith(`${dir}/`) && re.test(k.split('/').pop())),
    ])].sort(),
  }
}

/** Bloque CREATE [OR REPLACE] FUNCTION <name>(...) ... $tag$ ... $tag$ */
function fnBlocks(sql, qualifiedName) {
  const blocks = []
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${qualifiedName.replace('.', '\\.')}\\s*\\(`, 'gi')
  let m
  while ((m = re.exec(sql)) !== null) {
    const rest = sql.slice(m.index)
    const tag = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(rest)
    if (!tag) { blocks.push(rest.slice(0, 2000)); continue }
    const start = tag.index + tag[0].length
    const end = rest.indexOf(tag[1], start)
    blocks.push(rest.slice(0, end === -1 ? rest.length : end + tag[1].length))
  }
  return blocks
}

export function analyze(tree) {
  const out = []

  // ── F1 frontend ────────────────────────────────────────────────────────────
  const FRONTEND_FORBIDDEN = [
    [/private_key_pem/, 'private_key_pem en el frontend'],
    [/save_arca_certificate_legacy/, 'RPC retirada save_arca_certificate_legacy'],
    [/set_arca_estado_conexion/, 'RPC retirada set_arca_estado_conexion'],
    [/\bsaveCertificate\s*\(/, 'método cliente retirado saveCertificate'],
    [/\bsetEstadoConexion\s*\(/, 'método cliente retirado setEstadoConexion'],
    [/from\(\s*['"`]arca_config['"`]\s*\)/, "acceso directo from('arca_config')"],
    [/invoke\(\s*['"`]arca-credentials['"`]|functions\/v1\/arca-credentials/, 'invocación a arca-credentials (retirada)'],
  ]
  for (const file of tree.list('src', /\.(ts|tsx)$/)) {
    const code = stripJsComments(tree.read(file))
    for (const [re, label] of FRONTEND_FORBIDDEN) {
      if (re.test(code)) out.push(`F1 ${file}: ${label}`)
    }
  }

  // ── E1 arca-credentials es un stub 410 ─────────────────────────────────────
  for (const file of CREDENTIALS_STUB) {
    if (!tree.exists(file)) { out.push(`E1 falta ${file}`); continue }
  }
  if (CREDENTIALS_STUB.every((f) => tree.exists(f))) {
    const stub = CREDENTIALS_STUB.map((f) => stripJsComments(tree.read(f))).join('\n')
    if (!/status:\s*410/.test(stub)) out.push('E1 arca-credentials debe responder 410')
    if (!/ARCA_CREDENTIAL_UPLOAD_RETIRED/.test(stub)) out.push('E1 arca-credentials debe devolver ARCA_CREDENTIAL_UPLOAD_RETIRED')
    if (/req\.(json|text|formData|arrayBuffer|blob)\s*\(|req\.body\b/.test(stub)) out.push('E1 arca-credentials NO debe leer el body')
    if (/createClient|supabase-js/.test(stub)) out.push('E1 arca-credentials NO debe crear cliente Supabase')
    if (/\.rpc\(/.test(stub)) out.push('E1 arca-credentials NO debe invocar RPC')
    if (/node-forge|forge\.|crypto\.subtle|vault/i.test(stub)) out.push('E1 arca-credentials NO debe procesar material criptográfico ni Vault')
    if (/SERVICE_ROLE|service_role/i.test(stub)) out.push('E1 arca-credentials NO debe usar service_role')
    if (/private_key/i.test(stub)) out.push('E1 arca-credentials NO debe manejar private_key')
  }

  // ── E2 ninguna Edge lee una clave privada del body ─────────────────────────
  const BODY_KEY = /\bbody\s*(?:\?\.|\.)\s*(?:private_key_pem|private_key|key_pem)\b|\bbody\s*(?:\?\.)?\[\s*['"`](?:private_key_pem|private_key|key_pem)['"`]\s*\]|\{[^}]*\b(?:private_key_pem|private_key)\b[^}]*\}\s*=\s*(?:await\s+)?(?:body|req\.json\(\))/
  for (const file of tree.list('supabase/functions', /\.ts$/)) {
    const code = stripJsComments(tree.read(file))
    if (BODY_KEY.test(code)) out.push(`E2 ${file}: lee una clave privada del body del request`)
  }

  // ── E3 Edge de gestión con autoridad canónica ──────────────────────────────
  for (const file of MANAGEMENT_EDGES) {
    if (!tree.exists(file)) { out.push(`E3 falta ${file}`); continue }
    const code = stripJsComments(tree.read(file))
    if (!/authorizeArcaManager\s*\(/.test(code)) out.push(`E3 ${file}: no usa authorizeArcaManager`)
    if (!/resolveManagedBusiness\s*\(/.test(code)) out.push(`E3 ${file}: no valida el business_id contra el tenant resuelto`)
    if (/auth\.getUser\s*\(/.test(code)) out.push(`E3 ${file}: valida identidad por su cuenta (auth.getUser) en vez de la autoridad canónica`)
    if (/businessId\s*=\s*String\(\s*body/.test(code)) out.push(`E3 ${file}: toma el tenant del body`)
    if (!/is_business_owner_or_admin/.test(code)) out.push(`E3 ${file}: perdió la defensa en profundidad SQL`)
  }

  // ── E4 autoridad compartida ────────────────────────────────────────────────
  if (!tree.exists(SHARED_AUTHORITY)) {
    out.push(`E4 falta ${SHARED_AUTHORITY}`)
  } else {
    const code = stripJsComments(tree.read(SHARED_AUTHORITY))
    if (!/capability:\s*['"]settings_sensitive['"]/.test(code)) out.push('E4 la autoridad de gestión debe exigir settings_sensitive')
    const roles = /ARCA_MANAGER_ROLES[^=]*=\s*\[([^\]]*)\]/.exec(code)?.[1]
    const list = (roles ?? '').split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean).sort()
    if (list.join(',') !== 'admin,owner') out.push(`E4 ARCA_MANAGER_ROLES debe ser exactamente owner/admin (es: ${list.join(',') || 'vacío'})`)
    if (!/roles:\s*ARCA_MANAGER_ROLES/.test(code)) out.push('E4 la autoridad de gestión debe pasar roles a authorizeArcaCaller')
    if (/serviceCredentials/.test(code)) out.push('E4 la autoridad de gestión NO debe aceptar credenciales de servidor')
  }

  // ── M1 migración Phase 0 ───────────────────────────────────────────────────
  if (!tree.exists(PHASE0_MIGRATION)) {
    out.push(`M1 falta ${PHASE0_MIGRATION}`)
  } else {
    const sql = stripSqlComments(tree.read(PHASE0_MIGRATION))
    if (!/REVOKE\s+ALL\s+ON\s+TABLE\s+public\.arca_config\s+FROM\s+anon,\s*authenticated/i.test(sql)) out.push('M1 falta REVOKE ALL ON TABLE public.arca_config FROM anon, authenticated')
    if (!/REVOKE\s+ALL\s+ON\s+TABLE\s+public\.arca_config\s+FROM\s+PUBLIC/i.test(sql)) out.push('M1 falta REVOKE ALL ON TABLE public.arca_config FROM PUBLIC')
    if (!/DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?arca_config_plan_write\s+ON\s+public\.arca_config/i.test(sql)) out.push('M1 falta DROP POLICY arca_config_plan_write')
  }

  // ── M2 migraciones (la Phase 0 y todas las posteriores) ────────────────────
  const migrations = tree.list('supabase/migrations', /^\d{14}_.*\.sql$/)
    .filter((f) => f.split('/').pop().slice(0, 14) >= PHASE0_VERSION)
  for (const file of migrations) {
    const sql = stripSqlComments(tree.read(file))
    const name = file.split('/').pop()

    const grantTable = /GRANT\s+([^;]*?)\s+ON\s+(?:TABLE\s+)?public\.arca_config\s+TO\s+([^;]+);/gi
    let m
    while ((m = grantTable.exec(sql)) !== null) {
      if (/\b(insert|update|delete|truncate|all|select)\b/i.test(m[1]) && /\b(anon|authenticated|public)\b/i.test(m[2])) {
        out.push(`M2 ${name}: GRANT ${m[1].trim()} sobre arca_config a ${m[2].trim()}`)
      }
    }
    const policy = /CREATE\s+POLICY\s+("?[\w]+"?)\s+ON\s+public\.arca_config\b([^;]*);/gi
    while ((m = policy.exec(sql)) !== null) {
      if (!/USING\s*\(\s*\(?\s*auth\.role\(\)\s*=\s*'service_role'/i.test(m[2]) || /WITH\s+CHECK\s*\((?![^)]*service_role)/i.test(m[2])) {
        out.push(`M2 ${name}: policy ${m[1]} sobre arca_config que no es exclusiva de service_role`)
      }
    }
    for (const fn of ['save_arca_certificate_legacy', 'set_arca_estado_conexion', 'private\\.arca_actor_can_manage']) {
      const re = new RegExp(`GRANT\\s+(?:EXECUTE|ALL)[^;]*ON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\([^)]*\\)\\s+TO\\s+([^;]+);`, 'gi')
      while ((m = re.exec(sql)) !== null) {
        if (/\b(anon|authenticated|public|service_role)\b/i.test(m[1])) {
          out.push(`M2 ${name}: GRANT EXECUTE ${fn.replace('\\', '')} a ${m[1].trim()}`)
        }
      }
    }
    for (const block of fnBlocks(sql, 'private.arca_actor_can_manage')) {
      if (!/'owner'/.test(block) || !/'admin'/.test(block)) out.push(`M2 ${name}: arca_actor_can_manage sin restricción owner/admin`)
      if (!/capability_resolve\s*\([^)]*'settings_sensitive'/.test(block)) out.push(`M2 ${name}: arca_actor_can_manage sin capability_resolve(settings_sensitive)`)
      if (!/is_active\s+IS\s+TRUE/i.test(block)) out.push(`M2 ${name}: arca_actor_can_manage sin perfil activo estricto`)
      if (/SECURITY\s+DEFINER/i.test(block)) out.push(`M2 ${name}: arca_actor_can_manage no debe ser SECURITY DEFINER`)
    }
    for (const block of fnBlocks(sql, 'public.is_business_owner_or_admin')) {
      if (!/private\.arca_actor_can_manage/.test(block)) out.push(`M2 ${name}: is_business_owner_or_admin no delega en la autoridad canónica`)
    }
    for (const block of fnBlocks(sql, 'public.save_arca_config_legacy')) {
      if (!/private\.arca_actor_can_manage/.test(block)) out.push(`M2 ${name}: save_arca_config_legacy sin autoridad canónica`)
      if (!/get_my_profile/.test(block)) out.push(`M2 ${name}: save_arca_config_legacy sin tenant resuelto por identidad`)
      if (!/ARCA_FIELD_LOCKED/.test(block)) out.push(`M2 ${name}: save_arca_config_legacy sin bloqueo de identidad fiscal`)
      if (/\bexpires_at\s*=/.test(block)) out.push(`M2 ${name}: save_arca_config_legacy escribe expires_at`)
      if (/\b(cert_file|pfx_file|wsaa_token|wsaa_sign|estado_conexion|cuit_emisor)\s*=/.test(block)) {
        out.push(`M2 ${name}: save_arca_config_legacy escribe material/cache/estado`)
      }
    }
    for (const [fn, code] of [['save_arca_certificate_legacy', 'ARCA_LEGACY_CERTIFICATE_WRITE_RETIRED'],
                              ['set_arca_estado_conexion', 'ARCA_CLIENT_CONNECTION_STATE_WRITE_RETIRED']]) {
      for (const block of fnBlocks(sql, `public.${fn}`)) {
        if (!block.includes(code)) out.push(`M2 ${name}: ${fn} vuelve a ser operativa (sin ${code})`)
        if (/arca_config/.test(block)) out.push(`M2 ${name}: ${fn} vuelve a tocar arca_config`)
      }
    }
  }

  return out
}

function selfTest() {
  const base = diskTree(ROOT)
  const clean = analyze(base)
  if (clean.length) {
    console.error('❌ self-test: el repo real ya tiene hallazgos:')
    for (const f of clean) console.error('  · ' + f)
    process.exit(1)
  }
  const read = (rel) => base.read(rel)
  const mig = read(PHASE0_MIGRATION)
  const later = 'supabase/migrations/20261001120000_regresion.sql'
  const cases = [
    ['frontend usa save_arca_certificate_legacy', 'src/services/x.ts', "await supabase.rpc('save_arca_certificate_legacy', { p_business_id: b, p_cert_file: c })"],
    ['frontend usa set_arca_estado_conexion', 'src/services/x.ts', "await supabase.rpc('set_arca_estado_conexion', { p_business_id: b, p_estado: 'error' })"],
    ['frontend sube private_key_pem', 'src/services/x.ts', "await supabase.functions.invoke('arca-credentials', { body: { private_key_pem: k } })"],
    ['frontend escribe arca_config directo', 'src/services/x.ts', "await supabase.from('arca_config').insert({ business_id: b })"],
    ['frontend reintroduce saveCertificate', 'src/pages/x.tsx', 'await ArcaService.saveCertificate(businessId, cert)'],
    ['arca-credentials vuelve a leer el body', 'supabase/functions/arca-credentials/handler.ts',
      read('supabase/functions/arca-credentials/handler.ts').replace('export function handler(req: Request): Response {', 'export async function handler(req: Request): Promise<Response> {\n  const body = await req.json()')],
    ['arca-credentials deja de responder 410', 'supabase/functions/arca-credentials/handler.ts',
      read('supabase/functions/arca-credentials/handler.ts').replace('status: 410', 'status: 200')],
    ['otra Edge lee private_key_pem del body', 'supabase/functions/otra/index.ts', 'const keyPem = String(body?.private_key_pem ?? "")'],
    ['rotate-prepare toma el tenant del body', MANAGEMENT_EDGES[0],
      read(MANAGEMENT_EDGES[0]).replace('businessId = resolveManagedBusiness(body?.business_id, manager)', "businessId = String(body?.business_id ?? '')")],
    ['rotate-activate vuelve a auth.getUser', MANAGEMENT_EDGES[1],
      read(MANAGEMENT_EDGES[1]).replace(/authorizeArcaManager\(/g, 'userClient.auth.getUser(')],
    ['autoridad compartida acepta manager', SHARED_AUTHORITY,
      read(SHARED_AUTHORITY).replace("['owner', 'admin']", "['owner', 'admin', 'manager']")],
    ['autoridad compartida sin settings_sensitive', SHARED_AUTHORITY,
      read(SHARED_AUTHORITY).replace("capability: 'settings_sensitive'", "capability: 'comprobantes'")],
    ['Phase 0 sin REVOKE de tabla', PHASE0_MIGRATION, mig.replace('REVOKE ALL ON TABLE public.arca_config FROM anon, authenticated;', '')],
    ['Phase 0 conserva plan_write', PHASE0_MIGRATION, mig.replace('DROP POLICY IF EXISTS arca_config_plan_write ON public.arca_config;', '')],
    ['posterior re-otorga INSERT a authenticated', later, 'GRANT INSERT, UPDATE ON TABLE public.arca_config TO authenticated;'],
    ['posterior crea policy de miembro', later, "CREATE POLICY arca_member_write ON public.arca_config FOR ALL TO authenticated USING (business_id = public.current_business_id());"],
    ['posterior re-otorga la RPC de certificado', later, 'GRANT EXECUTE ON FUNCTION public.save_arca_certificate_legacy(uuid, text) TO authenticated;'],
    ['posterior debilita la autoridad (sin rol)', later,
      fnBlocks(mig, 'private.arca_actor_can_manage')[0].replace("v_role NOT IN ('owner', 'admin')", 'false') + ';'],
    ['posterior vuelve a escribir expires_at', later,
      fnBlocks(mig, 'public.save_arca_config_legacy')[0].replace('updated_at   = now();', 'expires_at = p_expires_at, updated_at = now();') + ';'],
    ['posterior reactiva la RPC de estado', later,
      "CREATE OR REPLACE FUNCTION public.set_arca_estado_conexion(p_business_id uuid, p_estado text, p_error text DEFAULT NULL)\nRETURNS jsonb LANGUAGE plpgsql AS $function$\nBEGIN UPDATE public.arca_config SET estado_conexion = p_estado WHERE business_id = p_business_id; RETURN '{}'::jsonb; END\n$function$;"],
  ]
  let fail = 0
  for (const [label, rel, content] of cases) {
    const got = analyze(overlayTree(base, new Map([[rel, content]])))
    if (got.length === 0) { fail++; console.error(`❌ no detectó: ${label}`) }
    else console.log(`✅ detecta: ${label} (${got[0]})`)
  }
  const comment = analyze(overlayTree(base, new Map([['src/services/x.ts', '// save_arca_certificate_legacy y set_arca_estado_conexion fueron retiradas\nexport const x = 1\n']])))
  if (comment.length) { fail++; console.error('❌ un comentario se contó como uso') }
  else console.log('✅ un comentario que menciona las RPC retiradas no es uso')
  if (fail) { console.error(`\n❌ self-test: ${fail} fallo(s)`); process.exit(1) }
  console.log(`\n✅ self-test ARCA Phase 0: ${cases.length + 1} fixtures OK`)
}

const isCLI = process.argv[1] && process.argv[1].endsWith('arca-phase0-legacy-writes.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const found = analyze(diskTree(ROOT))
  if (found.length) {
    console.error('❌ Guard ARCA Phase 0:\n')
    for (const f of found) console.error('  · ' + f)
    process.exit(1)
  }
  console.log('✅ Guard ARCA Phase 0 OK: sin escrituras legacy en el frontend, arca-credentials retirada (410), ninguna Edge lee claves privadas del body, gestión con autoridad canónica, arca_config sin escritura cliente.')
}
