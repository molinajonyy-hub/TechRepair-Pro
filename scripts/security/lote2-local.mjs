// Isolated LOCAL database, schema only. Never accepts a database URL.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const container = process.env.LOTE2_DB_CONTAINER || 'supabase_db_techrepair-mobile2a-expand'
if (!/^supabase_db_[a-z0-9-]+$/.test(container)) throw new Error('Expected a local Supabase Docker container')
const database = 'lote2_certification'
const docker = (args, input) => execFileSync('docker', ['exec', ...(input ? ['-i'] : []), container, ...args], {input,encoding:'utf8',maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']})
const psql = sql => docker(['psql','-X','-U','supabase_admin','-d',database,'-v','ON_ERROR_STOP=1','-At'],sql)
const migration = readFileSync('supabase/migrations/20260907120000_secdef_tenant_authority.sql','utf8')
try {
  if (process.argv.includes('--rebuild')) {
    const schemas = ['public','private','auth','storage','extensions','vault']
    let schema = docker(['pg_dump','-U','postgres','-d','postgres','--schema-only','--no-publications','--no-subscriptions',...schemas.flatMap(s=>['--schema',s])])
    // pg_dump with --schema excludes extension declarations and their members.
    // Restore exactly the needed extensions after namespaces, before functions.
    schema = schema.replace('CREATE FUNCTION', `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE FUNCTION`)
    // This fixed disposable database is owned exclusively by this test harness.
    docker(['dropdb','-U','supabase_admin','--if-exists',database])
    docker(['createdb','-U','supabase_admin',database])
    psql('DROP SCHEMA public;')
    psql(schema)
    // Current local stack precedes three main migrations. Apply only these
    // explicit baseline deltas to the isolated clone, never the source database.
    for (const file of ['20260904120000_p0onb1_canonical_business_profile.sql','20260905120000_first_steps_derived.sql','20260906120000_mp_pos_beta_containment.sql']) psql('SET ROLE postgres;\n'+readFileSync(`supabase/migrations/${file}`,'utf8'))
    console.log('PASS isolated schema rebuild + missing baseline migrations (no production data, cron or secrets copied)')
  }
  const sigs = ['repair_missing_stock_movements(uuid,boolean)','preview_missing_stock_movements(uuid)','delete_supplier_purchase_safe(uuid,uuid,uuid)','backfill_remito_fm(uuid[])','check_user_limit_before_invite(uuid)','pay_comprobante_from_account_atomic(uuid,uuid,uuid,numeric,text,text,date,uuid,uuid,text)','user_can_allocate_payments(uuid,uuid)','user_can_reverse_allocations(uuid,uuid)','user_can_view_order_amounts(uuid,uuid)']
  const snapshot = () => psql(`SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text,'owner',pg_get_userbyid(p.proowner)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid IN (${sigs.map(s=>`'public.${s}'::regprocedure`).join(',')});`).trim()
  const before = snapshot()
  if (process.argv.includes('--rebuild')) {
    const production = JSON.parse(readFileSync('docs/security-lote2/catalog-before.json','utf8')).functions
    const local = JSON.parse(before)
    for (const fn of local) {
      const prod = production.find(p => p.signature === fn.signature)
      const hash=createHash('sha256').update(fn.definition.replace(/\r\n/g,'\n')).digest('hex')
      if (!prod || prod.normalized_definition_sha256 !== hash || prod.proacl !== fn.acl || prod.owner !== fn.owner) throw new Error(`Baseline differs from production: ${fn.signature}`)
    }
    console.log('PASS all 9 touched baseline definitions (CRLF normalized), owners and ACLs match production catalog')
  }
  psql('BEGIN;\n'+migration.replace(/^(BEGIN|COMMIT);\s*$/gm,'')+'\nROLLBACK;')
  if (before !== snapshot()) throw new Error('Rollback changed definition/owner/ACL')
  console.log('PASS migration apply + rollback restores every touched definition/owner/ACL')
  psql(migration)
  const after = snapshot()
  psql(migration)
  if (after !== snapshot()) throw new Error('Reapply is not idempotent')
  writeFileSync('docs/security-lote2/local-grants.json',psql(`SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'search_path',p.proconfig,'public',EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'),'anon',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),'service_role',has_function_privilege('service_role',p.oid,'EXECUTE')) ORDER BY p.proname) FROM pg_proc p WHERE p.oid IN (${sigs.map(s=>`'public.${s}'::regprocedure`).join(',')});`).trim()+'\n')
  console.log('PASS migration apply + idempotent reapply; local grants captured')
  if (!process.argv.includes('--setup-only')) {
    const output = psql(readFileSync('tests/sql/lote2_secdef_tenant_authority.test.sql','utf8'))
    console.log(output.split('\n').filter(line=>line.startsWith('PASS')).join('\n'))
  }
} catch (error) { console.error(error.stderr?.toString() || error.message); process.exitCode=1 }
