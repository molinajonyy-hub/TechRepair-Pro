#!/usr/bin/env node
// H01: conservative review gate. SQL role tests validate the effective catalog;
// this guard prevents unreviewed migrations or privileged browser telemetry.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION = '20261017142335_tr_b42_h01_customer_events_hardening.sql'
const APPROVED_SQL_SHA256 = 'a0fa883e1f04e6e16bda936ba6d509677513056ca22dbded64de43255ea849bc'
const SERVICE = 'src/portal/services/portalService.ts'
const stripSql = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const stripJs = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
const hash = s => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex')
const walk = dir => readdirSync(dir).flatMap(n => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?|mjs)$/.test(n) ? [p.replaceAll('\\', '/')] : []
})

export function inspect({ migrations, files, vercel, pkg, workflow }) {
  const failures = []
  const candidate = migrations.find(([name]) => name === MIGRATION)
  if (!candidate || hash(candidate[1]) !== APPROVED_SQL_SHA256) {
    failures.push('H01 SQL changed/missing: review ownership, grants, SELECT preservation and catalog assertions; rerun real-role SQL tests before updating the pin')
  }
  for (const [name, raw] of migrations) {
    if (name <= MIGRATION) continue
    const sql = stripSql(raw).replaceAll('"', '')
    // Fail closed on every later CE change (including dynamic SQL bodies).
    // A safe evolution requires an explicit review of this contract.
    if (/\bcustomer_events\b/i.test(sql)) failures.push(`${name}: changes the reviewed customer_events contract`)
    if (/\bEXECUTE\b(?!\s+ON\b)/i.test(sql)) {
      failures.push(`${name}: dynamic SQL cannot be certified statically; review the H01 boundary and rerun catalog tests`)
    }
    if (/\bGRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\b/i.test(sql)
      || /\bALTER\s+DEFAULT\s+PRIVILEGES\b[^;]*\bGRANT\b[^;]*\bON\s+TABLES\b/i.test(sql)) {
      failures.push(`${name}: broad table privileges require a security review`)
    }
    if (/\bGRANT\b(?![^;]*\bON\b)[^;]*\bTO\s+[^;]*\b(?:PUBLIC|anon|authenticated)\b/i.test(sql)
      || /\bALTER\s+ROLE\s+(?:anon|authenticated)\b[^;]*\b(?:BYPASSRLS|SUPERUSER)\b/i.test(sql)) {
      failures.push(`${name}: browser role inheritance/bypass changed`)
    }
  }
  for (const [path, raw] of files) {
    const code = stripJs(raw)
    if (/\bcustomer_events\b/.test(code) && path !== SERVICE) {
      failures.push(`${path}: new customer_events consumer needs discovery and real-role coverage`)
    }
    if ((path.startsWith('src/portal/') || path === 'src/lib/supabase.ts')
      && /service[_-]?role|supabase[_-]?secret|sb_secret_|SUPABASE_SERVICE|SUPABASE_SECRET|BYPASSRLS/i.test(code)) {
      failures.push(`${path}: privileged credential/bypass in portal client`)
    }
    if (path === SERVICE) {
      const events = code.slice(code.indexOf('export async function trackEvent('))
      if (!events || !/await supabase\.from\('customer_events'\)\.insert\(/.test(events)
        || /\.rpc\(|\.functions\.|createClient\(|fetch\(/.test(events)
        || (code.match(/\.from\(['"]customer_events['"]\)/g) || []).length !== 1) {
        failures.push(`${path}: telemetry must use the existing unprivileged Supabase INSERT only`)
      }
    }
  }
  if (!files.some(([p]) => p === SERVICE)) failures.push('portal service missing')
  if (vercel.git?.deploymentEnabled?.['codex/tr-b42-h01-customer-events'] !== false) {
    failures.push('H01 branch must disable automatic Vercel deployments before its first push')
  }
  const quality = workflow.match(/\n  quality:[\s\S]*?(?=\n  [a-z0-9-]+:|$)/)?.[0] || ''
  const databaseJob = workflow.match(/\n  h01-customer-events:[\s\S]*?(?=\n  [a-z0-9-]+:|$)/)?.[0] || ''
  if (pkg.scripts?.['guard:h01'] !== 'node scripts/guards/customer-events-h01.mjs'
    || !pkg.scripts?.['test:h01']?.includes('npm run guard:h01:self-test && npm run guard:h01')
    || !pkg.scripts?.['test:sql:h01']?.includes('customer-events-h01-local.mjs --self-test --related')
    || !/run:\s*npm run test:h01\b/.test(quality)
    || !/run:\s*npm run test:sql:h01\b/.test(databaseJob)
    || !/npm run test:e2e:h01\b/.test(databaseJob)) {
    failures.push('H01 guard, negative controls, real-role SQL and real portal tests must remain connected to scripts and CI')
  }
  return failures
}

function readTree() {
  return {
    migrations: readdirSync('supabase/migrations').filter(n => n.endsWith('.sql')).sort()
      .map(n => [n, readFileSync(join('supabase/migrations', n), 'utf8')]),
    files: ['src', 'supabase/functions'].flatMap(walk).map(p => [p, readFileSync(p, 'utf8')]),
    vercel: JSON.parse(readFileSync('vercel.json', 'utf8')),
    pkg: JSON.parse(readFileSync('package.json', 'utf8')),
    workflow: readFileSync('.github/workflows/ci.yml', 'utf8'),
  }
}

function selfTest(tree) {
  assert.deepEqual(inspect(tree), [], 'current tree must pass')
  const later = sql => ({ ...tree, migrations: [...tree.migrations, ['20991231000000_regression.sql', sql]] })
  const cases = [
    ['permissive INSERT true', later('CREATE POLICY reopened ON public.customer_events FOR INSERT TO authenticated WITH CHECK (true);')],
    ['implicit FOR ALL', later('CREATE POLICY admin_again ON "public"."customer_events" USING (true);')],
    ['FOR ALL with misleading ownership branch', later('CREATE POLICY x ON customer_events FOR ALL USING (business_id IS NOT NULL);')],
    ['alter policy OR true', later('ALTER POLICY ce_customer_insert ON customer_events WITH CHECK (true);')],
    ['anon table INSERT', later('GRANT INSERT ON public.customer_events TO anon;')],
    ['anon column INSERT', later('GRANT INSERT (business_id) ON customer_events TO anon;')],
    ['broad all table privileges', later('GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;')],
    ['broad privileges with schema list', later('GRANT ALL ON ALL TABLES IN SCHEMA private, public TO authenticated;')],
    ['broad default privileges', later('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;')],
    ['role inheritance', later('GRANT service_role TO authenticated;')],
    ['role inheritance with multiple recipients', later('GRANT service_role TO anon, authenticated;')],
    ['role bypass', later('ALTER ROLE authenticated BYPASSRLS;')],
    ['disable RLS', later('ALTER TABLE customer_events DISABLE ROW LEVEL SECURITY;')],
    ['definer wrapper', later('CREATE FUNCTION public.track() RETURNS void SECURITY DEFINER AS $$ INSERT INTO customer_events DEFAULT VALUES $$ LANGUAGE sql;')],
    ['dynamic split-name policy', later("DO $$ BEGIN EXECUTE 'CREATE POLICY x ON public.' || 'customer_' || 'events FOR INSERT WITH CHECK (true)'; END $$;")],
    ['edited H01 migration', { ...tree, migrations: tree.migrations.map(([n, s]) => [n, n === MIGRATION ? s + '\nSELECT 1;' : s]) }],
    ['missing H01', { ...tree, migrations: tree.migrations.filter(([n]) => n !== MIGRATION) }],
    ['privileged portal credential', { ...tree, files: [...tree.files, ['src/portal/unsafe.ts', 'createClient(url, import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY)']] }],
    ['new privileged event writer', { ...tree, files: [...tree.files, ['supabase/functions/unsafe.ts', "admin.from('customer_events').insert(body)"]] }],
    ['telemetry RPC bypass', { ...tree, files: tree.files.map(([p, s]) => [p, p === SERVICE ? s + '\nsupabase.rpc("track_admin")' : s]) }],
    ['preview protection removed', { ...tree, vercel: { git: { deploymentEnabled: {} } } }],
    ['CI guard disconnected', { ...tree, workflow: tree.workflow.replace('run: npm run test:h01', 'run: echo guard removed') }],
    ['SQL negative tests disconnected', { ...tree, pkg: { ...tree.pkg, scripts: { ...tree.pkg.scripts, 'test:sql:h01': 'echo skipped' } } }],
  ]
  for (const [name, mutated] of cases) {
    assert.ok(inspect(mutated).length > 0, `negative control missed: ${name}`)
    console.log(`OK negative: ${name}`)
  }
  assert.deepEqual(inspect(later('-- customer_events: comment only\nGRANT SELECT ON public.unrelated TO authenticated;')), [])
  console.log(`H01 self-test OK: ${cases.length} regressions rejected + safe control`)
}

const tree = readTree()
if (process.argv.includes('--self-test')) selfTest(tree)
else {
  const failures = inspect(tree)
  failures.forEach(f => console.error(`H01: ${f}`))
  if (failures.length) process.exitCode = 1
  else console.log('H01 static guard OK: reviewed migration, later grants/policies, unprivileged portal, previews disabled')
}
