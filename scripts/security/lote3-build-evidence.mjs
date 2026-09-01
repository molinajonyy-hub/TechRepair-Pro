// Offline reduction of catalog-only output. No network and no commercial rows.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const input=process.argv[2]
const output=process.argv[3] || 'docs/security-lote3/production-before.json'
if(!input)throw new Error('usage: node lote3-build-evidence.mjs <raw-catalog.json> [output]')
const raw=JSON.parse(readFileSync(input,'utf8').replace(/^\uFEFF/,''))
const c=raw.rows[0].catalog
const sha=text=>createHash('sha256').update(text.replace(/\r\n/g,'\n')).digest('hex')
const semanticSha=text=>sha(text.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/--[^\n]*/g,' ').replace(/\s+/g,' ').trim())
const evidence={
  captured_at:c.captured_at,
  source_baseline:'cb9299652d11cc5b3fd3d595407c1454eb5486e0',
  latest_migration:c.latest_migration,
  production_writes:false,
  scope:'catalog metadata only; no commercial rows, credentials, Vault values, tokens, or emails',
  functions:c.functions.map(f=>({
    name:f.name,identity_arguments:f.identity_arguments,result:f.result,owner:f.owner,
    security_definer:f.security_definer,proconfig:f.proconfig,proacl:f.proacl,
    anon_execute:f.anon_execute,authenticated_execute:f.authenticated_execute,
    service_role_execute:f.service_role_execute,
    definition_sha256:sha(f.definition),
    definition_semantic_sha256:semanticSha(f.definition),
    has_current_user_can:/current_user_can\s*\(/i.test(f.definition),
    has_active_check:/is_active/i.test(f.definition),
  })),
  is_staff:{...c.is_staff,definition_sha256:sha(c.is_staff.definition)},
  is_staff_policy_count:c.is_staff_policies.length,
  is_staff_policy_counts:c.is_staff_policies.reduce((a,p)=>{a[p.command]=(a[p.command]||0)+1;return a},{}),
  is_staff_policies:c.is_staff_policies,
  payment_transactions:c.payment_transactions,
}
writeFileSync(output,JSON.stringify(evidence,null,2)+'\n')
console.log(`Lote 3 production evidence: ${evidence.functions.length} RPCs, ${evidence.is_staff_policy_count} is_staff policies, ${evidence.payment_transactions.policies.length} payment policies; writes=false`)
