#!/usr/bin/env node
// Read-only production drift check. Consumes `supabase db query --linked
// --output-format json` on stdin and compares only catalog metadata captured
// before implementation. It never queries or persists commercial rows.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const baseline = JSON.parse(readFileSync('docs/security-lote3/production-before.json','utf8'))
let input = ''
for await (const chunk of process.stdin) input += chunk
const raw = JSON.parse(input.replace(/^\uFEFF/,''))
const catalog = raw.rows?.[0]?.catalog
if (!catalog) throw new Error('production catalog response is missing rows[0].catalog')

const sha = text => createHash('sha256').update(text.replace(/\r\n/g,'\n')).digest('hex')
const semanticSha = text => sha(text.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/--[^\n]*/g,' ').replace(/\s+/g,' ').trim())
const bySignature = (a,b) => `${a.name}(${a.identity_arguments})`.localeCompare(`${b.name}(${b.identity_arguments})`)
const functions = catalog.functions.map(f => ({
  name:f.name, identity_arguments:f.identity_arguments, result:f.result,
  owner:f.owner, security_definer:f.security_definer, proconfig:f.proconfig,
  proacl:f.proacl, anon_execute:f.anon_execute,
  authenticated_execute:f.authenticated_execute,
  service_role_execute:f.service_role_execute,
  definition_sha256:sha(f.definition),
  definition_semantic_sha256:semanticSha(f.definition),
  has_current_user_can:/current_user_can\s*\(/i.test(f.definition),
  has_active_check:/is_active/i.test(f.definition),
})).sort(bySignature)
const isStaff = {...catalog.is_staff,definition_sha256:sha(catalog.is_staff.definition)}

const stable = value => JSON.stringify(value)
const semanticContract = ({definition_sha256: _rawHash,...rest}) => rest
const checks = [
  ['latest migration',catalog.latest_migration,baseline.latest_migration],
  ['25 function contracts',functions.map(semanticContract),[...baseline.functions].sort(bySignature).map(semanticContract)],
  ['is_staff definition',isStaff,baseline.is_staff],
  ['is_staff policy catalog',catalog.is_staff_policies,baseline.is_staff_policies],
  ['payment_transactions catalog',catalog.payment_transactions,baseline.payment_transactions],
]
const drift = checks.filter(([,actual,expected]) => stable(actual) !== stable(expected)).map(([name]) => name)
if (drift.length) {
  console.error(`BLOCKED production catalog drift: ${drift.join(', ')}`)
  if (drift.includes('25 function contracts')) {
    const expectedBySignature = new Map(baseline.functions.map(f => [`${f.name}(${f.identity_arguments})`,f]))
    for (const actual of functions) {
      const key = `${actual.name}(${actual.identity_arguments})`
      const expected = expectedBySignature.get(key)
      if (!expected) {
        console.error(`- added signature: ${key}`)
        continue
      }
      const changed = Object.keys(actual).filter(field => stable(actual[field]) !== stable(expected[field]))
      if (changed.length) console.error(`- ${key}: ${changed.join(', ')}`)
      expectedBySignature.delete(key)
    }
    for (const key of expectedBySignature.keys()) console.error(`- removed signature: ${key}`)
  }
  process.exit(1)
}
console.log(`PASS production preflight: unchanged baseline ${baseline.source_baseline}; 25 RPCs, ${baseline.is_staff_policy_count} is_staff policies, payment_transactions metadata stable; catalog read only`)
