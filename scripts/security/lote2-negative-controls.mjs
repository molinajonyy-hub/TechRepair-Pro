// Deliberately restore ONE original flaw, only in a rolled-back local transaction.
// A suite that also passes against the insecure definition is not a security test.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const container=process.env.LOTE2_DB_CONTAINER||'supabase_db_techrepair-mobile2a-expand'
if(!/^supabase_db_[a-z0-9-]+$/.test(container))throw new Error('Local container required')
const originals=readFileSync('docs/security-lote2/definitions-before.sql','utf8')
const definitions=[...originals.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?AS \$function\$[\s\S]*?\$function\$\s*;/g)]
const tests=readFileSync('tests/sql/lote2_secdef_tenant_authority.test.sql','utf8').replace(/^(BEGIN|ROLLBACK);\s*$/gm,'')
const grants={backfill_remito_fm:'uuid[]',user_can_allocate_payments:'uuid,uuid',user_can_reverse_allocations:'uuid,uuid',user_can_view_order_amounts:'uuid,uuid'}
let count=0
for(const [definition,name]of definitions){
 const mutation=grants[name]?`GRANT EXECUTE ON FUNCTION public.${name}(${grants[name]}) TO authenticated;`:definition
 try{execFileSync('docker',['exec','-i',container,'psql','-X','-U','supabase_admin','-d','lote2_certification','-Atq','-v','ON_ERROR_STOP=1'],{input:'BEGIN;\n'+mutation+'\n'+tests+'\nROLLBACK;',encoding:'utf8',stdio:['pipe','pipe','pipe']});throw new Error(`Security suite failed to detect restored flaw: ${name}`)}
 catch(error){const stderr=error.stderr?.toString()||'';if(!stderr.includes('ERROR:  FAIL:'))throw error;count++;console.log(`PASS negative control: original ${name} flaw detected; transaction rolled back`)}
}
if(count!==9)throw new Error(`Expected 9 negative controls, got ${count}`)
