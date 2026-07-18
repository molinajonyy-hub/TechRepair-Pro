// ============================================================================
// M7 7D.3 Ã¢â‚¬â€ Ejecutor de SQL contra el Postgres LOCAL.
//
// Se usa SOLO para preparar/limpiar fixtures y para verificar el estado final
// en base (7D.3 Ã‚Â§2). Nunca sustituye la interacciÃƒÂ³n por UI de la operaciÃƒÂ³n que
// se estÃƒÂ¡ probando.
//
// Va por `docker exec` al contenedor del stack local en vez de por una URL de
// conexiÃƒÂ³n. No es comodidad: un contenedor local no puede ser producciÃƒÂ³n, asÃƒÂ­
// que este mÃƒÂ³dulo es estructuralmente incapaz de escribir en el proyecto remoto
// aunque alguien configure mal un .env.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

let contenedorCache: string | null = null

function contenedorDb(): string {
  if (contenedorCache) return contenedorCache
  const toml = readFileSync('supabase/config.toml', 'utf-8')
  const m = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)
  if (!m) throw new Error('supabase/config.toml no declara project_id')
  const nombre = `supabase_db_${m[1]}`

  const corriendo = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf-8' })
  if (!corriendo.split('\n').map(s => s.trim()).includes(nombre)) {
    throw new Error(`El contenedor "${nombre}" no estÃƒÂ¡ corriendo (npx supabase start).`)
  }
  contenedorCache = nombre
  return nombre
}

/** Ejecuta SQL. Lanza si falla (ON_ERROR_STOP): un fixture roto no es un test que falla raro. */
export function ejecutarSQL(sql: string): string {
  try {
    return execFileSync(
      'docker',
      ['exec', '-i', contenedorDb(), 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
      { input: sql, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    )
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new Error(`SQL local fallÃƒÂ³:\n${err.stderr || err.message}\n--- SQL ---\n${sql}`)
  }
}

/** Ejecuta SQL que devuelve UNA fila y la parsea como JSON. */
export function consultarJSON<T = Record<string, unknown>>(sqlSelect: string): T {
  // -t -A: sin encabezados ni alineaciÃƒÂ³n Ã¢â€ â€™ sÃƒÂ³lo el JSON, sin lÃƒÂ­neas de status
  // que ensuciarÃƒÂ­an el parseo (los meta-comandos \pset sÃƒÂ­ las imprimen).
  let salida: string
  try {
    salida = execFileSync(
      'docker',
      ['exec', '-i', contenedorDb(), 'psql', '-X', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
       '-U', 'postgres', '-d', 'postgres',
       '-c', `SELECT row_to_json(t) FROM (${sqlSelect}) t`],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new Error(`Consulta local fallÃƒÂ³:\n${err.stderr || err.message}\n--- SQL ---\n${sqlSelect}`)
  }
  if (!salida) throw new Error(`La consulta no devolviÃƒÂ³ filas:\n${sqlSelect}`)
  return JSON.parse(salida.split('\n')[0]) as T
}
