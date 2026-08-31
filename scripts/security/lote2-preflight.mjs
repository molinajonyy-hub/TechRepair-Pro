// Compare READ-ONLY production remeasurement with reviewed catalog. Never applies SQL.
import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const before=JSON.parse(readFileSync('docs/security-lote2/catalog-before.json','utf8'))
const after=JSON.parse(readFileSync(process.argv[2]||'.lote2-local/catalog-preflight.json','utf8').replace(/^\uFEFF/,'')).rows[0].catalog
const functions=after.functions.filter(f=>f.security_definer)
const differences=[]
for(const prior of before.functions){
 const current=functions.find(f=>f.schema===prior.schema&&f.signature===prior.signature)
 if(!current){differences.push({signature:prior.signature,field:'missing'});continue}
 const hash=createHash('sha256').update(current.definition).digest('hex')
 if(hash!==prior.definition_sha256)differences.push({signature:prior.signature,field:'definition'})
 for(const field of ['owner','proacl','proconfig','anon_execute','public_execute','authenticated_execute','service_role_execute','authenticated_schema_usage','anon_schema_usage'])
   if(JSON.stringify(prior[field])!==JSON.stringify(current[field]))differences.push({signature:prior.signature,field})
}
for(const f of functions)if(!before.functions.some(p=>p.schema===f.schema&&p.signature===f.signature))differences.push({signature:f.signature,field:'added'})
const result={captured_at:after.captured_at,baseline:before.baseline,total_secdef:functions.length,differences,
  unchanged:!differences.length,production_writes:false,
  expected_local_changes:JSON.parse(readFileSync('docs/security-lote2/local-grants.json','utf8'))}
writeFileSync('docs/security-lote2/production-preflight.json',JSON.stringify(result,null,2)+'\n')
console.log(`Production READ-ONLY preflight: ${functions.length} SECDEF; ${differences.length} definition/owner/path/ACL/schema-usage changes since inventory`)
if(differences.length)process.exitCode=1
