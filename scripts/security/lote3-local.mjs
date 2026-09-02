// LOCAL Docker only. Runs the rolled-back SQL authority/negative-control suite.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const project = readFileSync('supabase/config.toml','utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('Cannot identify local Supabase project')
const container = process.env.LOTE3_DB_CONTAINER || `supabase_db_${project}`
if (!/^supabase_db_[a-z0-9-]+$/.test(container)) throw new Error('A local Supabase DB container is required')

try {
  const output = execFileSync('docker',[
    'exec','-i',container,'psql','-X','-U','postgres','-d','postgres',
    '-v','ON_ERROR_STOP=1','-P','pager=off',
  ],{
    input:readFileSync('tests/sql/lote3_action_write_authority.test.sql','utf8'),
    encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:32*1024*1024,
  })
  const notice = output.split('\n').find(line => line.includes('PASS Lote 3 SQL authority suite'))
  console.log(notice || 'PASS Lote 3 SQL authority suite')
} catch (error) {
  console.error(error.stderr?.toString() || error.message)
  process.exitCode = 1
}
