import { execFileSync } from 'node:child_process'
import { motivoDeRechazo } from '../setup/assertLocalTarget'

export function localTarget() {
  const api = process.env.H01_SUPABASE_URL
  const rejected = motivoDeRechazo(api)
  if (rejected) throw new Error(`H01: ${rejected}`)
  const container = process.env.H01_DB_CONTAINER
  if (container !== 'supabase_db_techrepair-h01' && !(process.env.CI === 'true' && container === 'supabase_db_techrepair-vite')) {
    throw new Error('H01 only accepts its isolated local container (or the clean CI local stack).')
  }
  const expectedPort = container === 'supabase_db_techrepair-h01' ? '55421' : '54421'
  if (new URL(api!).port !== expectedPort) throw new Error('H01 API port does not match the selected local container.')
  const anon = process.env.H01_SUPABASE_ANON_KEY
  const service = process.env.H01_SUPABASE_SERVICE_ROLE_KEY
  if (!anon || !service) throw new Error('H01 local stack keys are required.')
  return { api: api!, anon, service, container }
}

export function localSQL(sql: string): string {
  const { container } = localTarget()
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}
