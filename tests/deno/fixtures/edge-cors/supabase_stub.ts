// Inert supabase-js: records every use, authenticates nobody, reaches no backend.
const calls: string[] = ((globalThis as { __backendCalls?: string[] }).__backendCalls ??= [])
const denied = { data: null, error: { message: 'stub: no backend' } }

type Query = { [key: string]: unknown }
function query(label: string): Query {
  const chain: Query = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(denied)
      return () => { calls.push(`${label}.${String(prop)}`); return chain }
    },
  })
  return chain
}

export function createClient(_url: string, _key: string, _options?: unknown) {
  calls.push('createClient')
  return {
    auth: {
      getUser: () => {
        calls.push('auth.getUser')
        return Promise.resolve({ data: { user: null }, error: { message: 'stub: invalid session' } })
      },
    },
    rpc: (name: string) => { calls.push(`rpc:${name}`); return Promise.resolve(denied) },
    from: (table: string) => { calls.push(`from:${table}`); return query(`from:${table}`) },
    functions: {
      invoke: (name: string) => { calls.push(`invoke:${name}`); return Promise.resolve(denied) },
    },
  }
}
