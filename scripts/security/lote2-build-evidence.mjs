// Offline catalog reduction. No network, data rows, tokens or credentials.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const input = process.argv[2] || '.lote2-local/catalog-before.json'
const catalog = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, '')).rows[0].catalog
const dir = 'docs/security-lote2'
mkdirSync(dir, { recursive: true })
const migrations = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && f.slice(0,14)<='20260906120000').sort()
  .map(file => ({ file, text: readFileSync(`supabase/migrations/${file}`, 'utf8').replace(/"/g, '') }))
const files = execFileSync('git', ['ls-files', 'src', 'supabase/functions', 'scripts', 'tests', 'supabase/tests'], { encoding: 'utf8' })
  .trim().split(/\r?\n/).filter(f => /\.(tsx?|m?js|sql|sh)$/.test(f)).map(file => ({ file, text: readFileSync(file, 'utf8') }))
const sha = value => createHash('sha256').update(value).digest('hex')
const functions = catalog.functions.filter(f => f.security_definer).map(f => {
  const name = f.name
  const declaration = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:${f.schema}\\.)?${name}\\s*\\(`, 'i')
  const reference = new RegExp(`\\b${name}\\s*\\(`)
  const sources = migrations.filter(m => declaration.test(m.text)).map(m => m.file)
  const changes = migrations.filter(m => new RegExp(`\\b(?:ALTER|GRANT|REVOKE)[^;]*\\b${name}\\s*\\(`, 'i').test(m.text)).map(m => m.file)
  const callers = files.filter(x => x.text.includes(name)).map(x => ({ file: x.file, lines: x.text.split(/\r?\n/).flatMap((line, i) => line.includes(name) ? [i + 1] : []) }))
  const parents = catalog.functions.filter(p => p.signature !== f.signature && reference.test(p.definition.replace(/"/g, ''))).map(p => ({ signature: p.signature, security_definer: p.security_definer }))
  const { definition, ...metadata } = f
  return { ...metadata, definition_sha256: sha(definition), normalized_definition_sha256: sha(definition.replace(/\r\n/g,'\n')), source_migration: sources.at(-1) || null,
    definition_migrations: sources, grant_or_alter_migrations: changes, callers, sql_parents: parents }
})
const result = { captured_at: catalog.captured_at, baseline: '3ce69b7b69f2816c0162948c89e43bec5753595c',
  counts: { total: functions.length, public_execute: functions.filter(f => f.public_execute).length,
    anon_execute: functions.filter(f => f.anon_execute).length, authenticated_execute: functions.filter(f => f.authenticated_execute).length },
  note: 'Catalog metadata only; privileges do not imply RPC reachability (trigger return type and schema USAGE also matter). Caller occurrences require manual review. Definition hash is exact pg_get_functiondef; migration mapping is provenance, not proof of equality.',
  functions }
writeFileSync(`${dir}/catalog-before.json`, JSON.stringify(result, null, 2) + '\n')
const touched = new Set(['repair_missing_stock_movements','preview_missing_stock_movements','delete_supplier_purchase_safe','backfill_remito_fm','check_user_limit_before_invite','pay_comprobante_from_account_atomic','user_can_allocate_payments','user_can_reverse_allocations','user_can_view_order_amounts'])
writeFileSync(`${dir}/definitions-before.sql`, '-- READ-ONLY EVIDENCE: pg_get_functiondef from production, CRLF normalized. Do NOT execute.\n'+catalog.functions.filter(f=>touched.has(f.name)).map(f=>f.definition.replace(/\r\n/g,'\n')+';').join('\n\n'))
console.log(JSON.stringify(result.counts))
