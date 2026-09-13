/**
 * ARCA Self-Service Phase 0 — autoridad canónica de gestión ARCA en Edge.
 *
 *   perfil activo AND rol owner/admin AND settings_sensitive (current_user_can)
 *   tenant resuelto por identidad; el business_id del body solo lo confirma.
 *
 * Además prueba que afip-wsaa (authorizeArcaCaller SIN `roles`) conserva su
 * contrato capability-only: el cambio compartido no lo endurece ni lo afloja.
 *
 * RUN: deno test -A --node-modules-dir=auto tests/deno/
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import {
  ArcaAuthorizationError, authorizeArcaCaller, type ArcaUserClient,
} from '../../supabase/functions/_shared/arcaAuthorization.ts'
import {
  ARCA_MANAGER_ROLES, authorizeArcaManager, resolveManagedBusiness,
} from '../../supabase/functions/_shared/arcaManagementAuthority.ts'

const BIZ = '00000000-0000-4000-8000-00000000a001'
const OTHER = '00000000-0000-4000-8000-00000000b002'
const USER = '00000000-0000-4000-8000-00000000c003'
const SERVICE = `sb_secret_${'I'.repeat(22)}_abcd1234`

/**
 * Cliente falso. `capability` simula private.capability_resolve server-side
 * (defaults por rol + override), igual que current_user_can en la base.
 */
function client(profile: { role: string; active?: boolean; permissions?: unknown; business?: string | null }, opts: { rpcError?: boolean } = {}) {
  const calls: string[] = []
  const c: ArcaUserClient = {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    rpc: async (name, args) => {
      calls.push(`${name}:${args?.p_key ?? ''}`)
      if (opts.rpcError) return { data: null, error: { message: 'synthetic' } }
      if (name === 'get_my_profile') {
        return { error: null, data: [{
          id: USER, user_id: USER, business_id: profile.business === undefined ? BIZ : profile.business,
          role: profile.role, is_active: profile.active ?? true, permissions: profile.permissions ?? null,
        }] }
      }
      if (name === 'current_user_can') {
        const defaults: Record<string, boolean> = { owner: true, admin: true }
        if (profile.role === 'owner') return { error: null, data: true }
        const perms = profile.permissions as Record<string, unknown> | null
        const override = perms && typeof perms.settings_sensitive === 'boolean' ? perms.settings_sensitive : undefined
        return { error: null, data: override ?? defaults[profile.role] ?? false }
      }
      throw new Error(`rpc inesperada ${name}`)
    },
  }
  return { c, calls }
}

const asManager = (profile: Parameters<typeof client>[0], authorization: string | null = 'Bearer user-jwt') => {
  const { c, calls } = client(profile)
  return { promise: authorizeArcaManager(authorization, { createUserClient: () => c }), calls }
}

async function expectForbidden(p: Promise<unknown>, status = 403) {
  const err = await assertRejects(() => p, ArcaAuthorizationError)
  assertEquals(err.status, status)
}

Deno.test('roles de gestión: exactamente owner y admin', () => {
  assertEquals([...ARCA_MANAGER_ROLES].sort(), ['admin', 'owner'])
})

Deno.test('matriz: owner y admin activos con settings_sensitive pasan', async () => {
  for (const role of ['owner', 'admin']) {
    const { promise, calls } = asManager({ role })
    assertEquals(await promise, { userId: USER, businessId: BIZ })
    assert(calls.includes('current_user_can:settings_sensitive'), `${role}: la capacidad se consulta server-side`)
  }
})

Deno.test('matriz: admin con settings_sensitive=false NO pasa', async () => {
  await expectForbidden(asManager({ role: 'admin', permissions: { settings_sensitive: false } }).promise)
})

Deno.test('matriz: manager con settings_sensitive=true NO pasa (rol insuficiente)', async () => {
  const { promise, calls } = asManager({ role: 'manager', permissions: { settings_sensitive: true } })
  await expectForbidden(promise)
  assert(!calls.includes('current_user_can:settings_sensitive'), 'el rol corta antes de consultar la capacidad')
})

Deno.test('matriz: tech/sales/cashier/viewer NO pasan, ni con override', async () => {
  for (const role of ['tech', 'sales', 'cashier', 'viewer']) {
    await expectForbidden(asManager({ role }).promise)
    await expectForbidden(asManager({ role, permissions: { settings_sensitive: true } }).promise)
  }
})

Deno.test('matriz: owner/admin inactivos NO pasan', async () => {
  for (const role of ['owner', 'admin']) {
    await expectForbidden(asManager({ role, active: false }).promise)
  }
})

Deno.test('matriz: override malformado falla cerrado', async () => {
  await expectForbidden(asManager({ role: 'admin', permissions: { settings_sensitive: 'yes' } }).promise)
})

Deno.test('matriz: perfil sin negocio NO pasa', async () => {
  await expectForbidden(asManager({ role: 'owner', business: null }).promise)
})

Deno.test('sin Authorization → 401', async () => {
  await expectForbidden(asManager({ role: 'owner' }, null).promise, 401)
})

Deno.test('una credencial de servidor NO es un actor de gestión', async () => {
  // authorizeArcaManager no acepta serviceCredentials: el secreto de servidor se
  // trata como un bearer de usuario y no pasa la identidad.
  const c: ArcaUserClient = {
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    rpc: async () => ({ data: null, error: null }),
  }
  await expectForbidden(authorizeArcaManager(`Bearer ${SERVICE}`, { createUserClient: () => c }), 401)
})

Deno.test('error de la base al resolver autoridad → 503 (fail-closed)', async () => {
  const { c } = client({ role: 'owner' }, { rpcError: true })
  await expectForbidden(authorizeArcaManager('Bearer user-jwt', { createUserClient: () => c }), 503)
})

Deno.test('tenant: ausente usa el de la identidad; igual (cualquier casing) se acepta', () => {
  const manager = { userId: USER, businessId: BIZ }
  assertEquals(resolveManagedBusiness(undefined, manager), BIZ)
  assertEquals(resolveManagedBusiness(null, manager), BIZ)
  assertEquals(resolveManagedBusiness('', manager), BIZ)
  assertEquals(resolveManagedBusiness(BIZ.toUpperCase(), manager), BIZ)
})

Deno.test('tenant: un business_id ajeno o no-string → 403 (nunca elige el tenant)', () => {
  const manager = { userId: USER, businessId: BIZ }
  for (const requested of [OTHER, 123, { id: BIZ }, [BIZ]]) {
    try {
      resolveManagedBusiness(requested, manager)
      throw new Error(`aceptó ${JSON.stringify(requested)}`)
    } catch (err) {
      assert(err instanceof ArcaAuthorizationError)
      assertEquals(err.status, 403)
    }
  }
})

Deno.test('regresión afip-wsaa: sin `roles` un manager con settings_sensitive sigue autorizado', async () => {
  const { c } = client({ role: 'manager', permissions: { settings_sensitive: true } })
  const caller = await authorizeArcaCaller('Bearer user-jwt', {
    capability: 'settings_sensitive', serviceCredentials: [SERVICE], createUserClient: () => c,
  })
  assertEquals(caller, { kind: 'user', userId: USER, businessId: BIZ })
})

Deno.test('regresión afip-wsaa: la credencial de servidor exacta sigue siendo internal', async () => {
  const { c } = client({ role: 'viewer' })
  const caller = await authorizeArcaCaller(`Bearer ${SERVICE}`, {
    capability: 'settings_sensitive', serviceCredentials: [SERVICE], createUserClient: () => c,
  })
  assertEquals(caller, { kind: 'internal' })
})

Deno.test('los Edge de gestión usan la autoridad canónica y no toman el tenant del body', async () => {
  for (const file of ['supabase/functions/arca-rotate-prepare/index.ts', 'supabase/functions/arca-rotate-activate/index.ts']) {
    const src = (await Deno.readTextFile(file)).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
    assert(/authorizeArcaManager\(/.test(src), `${file}: authorizeArcaManager`)
    assert(/resolveManagedBusiness\(/.test(src), `${file}: resolveManagedBusiness`)
    assert(!/auth\.getUser\(/.test(src), `${file}: sin getUser propio`)
    assert(!/businessId\s*=\s*String\(\s*body/.test(src), `${file}: sin tenant del body`)
  }
})
