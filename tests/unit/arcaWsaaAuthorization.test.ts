import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import {
  authorizeArcaCaller, configuredServiceCredentials, type ArcaUserClient,
} from '../../supabase/functions/_shared/arcaAuthorization.ts'
import { withWsaaAuthorization } from '../../supabase/functions/afip-wsaa/authorizationBoundary.ts'
import { evaluarPreEnvio } from '../../supabase/functions/afip-cae/preSend.ts'

const BUSINESS_A = '00000000-0000-4000-8000-000000000001'
const BUSINESS_B = '00000000-0000-4000-8000-000000000002'
const USER = '00000000-0000-4000-8000-000000000003'
const SERVICE = 'synthetic-internal-credential-not-a-real-key'
// P0-ARCA-A: production injects the secret API key (sb_secret_*, not a JWT) as
// SUPABASE_SERVICE_ROLE_KEY. Synthetic values with the same shapes:
const SECRET_KEY = `sb_secret_${'S'.repeat(22)}_abcd1234`
const PUBLISHABLE_KEY = `sb_publishable_${'P'.repeat(22)}_abcd1234`
const b64u = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const LEGACY_SERVICE_JWT = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ iss: 'supabase', ref: 'syntheticref', role: 'service_role' })}.${'x'.repeat(43)}`
const PLATFORM_JWT = `${b64u({ alg: 'ES256', typ: 'JWT' })}.${b64u({ role: 'service_role' })}.${'y'.repeat(86)}`

function fixture(options: {
  role?: string; active?: boolean; capability?: boolean; identityValid?: boolean
  legacy?: boolean; permissions?: unknown; authReadFailure?: boolean
  runFailure?: boolean; cached?: boolean; serviceCredentials?: string[]
} = {}) {
  const identityReads: string[] = []
  const effects: { operation: string; businessId: string; message?: string }[] = []
  const client: ArcaUserClient = {
    auth: { getUser: async () => {
      identityReads.push('getUser')
      return { data: { user: options.identityValid === false ? null : { id: USER } }, error: null }
    } },
    rpc: async (name, args) => {
      identityReads.push(name)
      if (options.authReadFailure) throw new Error('synthetic-private-database-detail')
      if (name === 'get_my_profile') return { error: null, data: [{
        id: options.legacy ? 'legacy-profile-id' : USER,
        user_id: options.legacy ? USER : null,
        business_id: BUSINESS_A, is_active: options.active ?? true,
        role: options.role ?? 'admin', permissions: options.permissions ?? null,
      }] }
      assert.equal(name, 'current_user_can')
      assert.ok(['settings_sensitive', 'comprobantes'].includes(String(args?.p_key)))
      return { error: null, data: options.capability ?? true }
    },
  }
  async function request(authorization: string | null, body: unknown, headers: Record<string, string> = {}) {
    const req = new Request('https://example.invalid/afip-wsaa', {
      method: 'POST', headers: { ...headers, ...(authorization ? { Authorization: authorization } : {}) },
      body: JSON.stringify(body),
    })
    return withWsaaAuthorization(req, {
      authorize: () => authorizeArcaCaller(req.headers.get('Authorization'), {
        capability: 'settings_sensitive',
        serviceCredentials: options.serviceCredentials ?? [SERVICE],
        presentedApiKey: req.headers.get('apikey'),
        createUserClient: () => { identityReads.push('createUserClient'); return client },
      }),
      json: (value, status) => Response.json(value, { status }),
      run: async (context) => {
        effects.push({ operation: 'config-read', businessId: context.businessId })
        if (options.runFailure) throw new Error('synthetic-WSAA-token-that-must-not-escape')
        assert.equal(context.service, 'wsfe')
        if (options.cached === false) effects.push({ operation: 'mock-wsaa', businessId: context.businessId })
        return Response.json({ success: true, token: 'synthetic-ticket', sign: 'synthetic-signature',
          cached: options.cached ?? true, expires_at: '2030-01-01T00:00:00.000Z',
          private_config: 'must-not-escape',
        })
      },
      markAuthorizedError: async (businessId, message) => { effects.push({ operation: 'error-write', businessId, message }) },
    })
  }
  return { request, identityReads, effects, client }
}

for (const business of [BUSINESS_A, BUSINESS_B]) {
  test(`anonymous rejected before any identity/config/Vault read or write (${business})`, async () => {
    const f = fixture()
    const response = await f.request(null, { business_id: business, force_refresh: true }, { 'x-internal': 'true', Origin: 'https://allowed.invalid' })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { success: false, error: 'UNAUTHENTICATED' })
    assert.deepEqual(f.identityReads, [])
    assert.deepEqual(f.effects, [])
  })
}

test('invalid JWT or forged service-role claim cannot use the internal path', async () => {
  for (const token of ['invalid-jwt', 'synthetic.jwt-with-service-role-claim.signature', LEGACY_SERVICE_JWT, PLATFORM_JWT]) {
    const f = fixture({ identityValid: false })
    const response = await f.request(`Bearer ${token}`, { business_id: BUSINESS_B })
    assert.equal(response.status, 401)
    assert.deepEqual(f.effects, [])
  }
})

test('foreign business is rejected before configuration access, refresh, or error write', async () => {
  const f = fixture({ runFailure: true })
  const response = await f.request('Bearer synthetic-user-jwt', { business_id: BUSINESS_B, force_refresh: true, role: 'owner' })
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { success: false, error: 'FORBIDDEN' })
  assert.deepEqual(f.effects, [])
})

for (const role of ['tech', 'sales', 'viewer']) {
  test(`${role} without settings_sensitive cannot invoke direct WSAA`, async () => {
    const f = fixture({ role, capability: false })
    assert.equal((await f.request('Bearer synthetic-user-jwt', { business_id: BUSINESS_A })).status, 403)
    assert.deepEqual(f.effects, [])
  })
}

test('inactive profile and explicit capability denial fail closed', async () => {
  for (const options of [{ active: false }, { role: 'admin', capability: false }]) {
    const f = fixture(options)
    assert.equal((await f.request('Bearer synthetic-user-jwt', { business_id: BUSINESS_A })).status, 403)
    assert.deepEqual(f.effects, [])
  }
})

test('malformed sensitive permission never falls back to a permissive role default', async () => {
  for (const permissions of ['invalid', [], { settings_sensitive: 'false' }, { settings_sensitive: null }]) {
    const f = fixture({ permissions })
    assert.equal((await f.request('Bearer synthetic-user-jwt', { business_id: BUSINESS_A })).status, 403)
    assert.deepEqual(f.effects, [])
  }
})

for (const role of ['owner', 'admin']) for (const legacy of [false, true]) for (const cached of [false, true]) {
  test(`${role}, ${legacy ? 'legacy' : 'canonical'}, ${cached ? 'cached' : 'mock refresh'}: human gets flags, never secrets`, async () => {
    const f = fixture({ role, legacy, cached })
    const response = await f.request('Bearer synthetic-user-jwt', { business_id: BUSINESS_A })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body, { success: true, tokenOk: true, signOk: true, cached, expires_at: '2030-01-01T00:00:00.000Z' })
    assert.ok(f.effects.every(e => e.businessId === BUSINESS_A))
  })
}

test('exact internal credential preserves token/sign for CAE/query without pretending to be a human', async () => {
  const f = fixture({ identityValid: false })
  const response = await f.request(`Bearer ${SERVICE}`, { business_id: BUSINESS_B })
  const body = await response.json()
  assert.equal(body.token, 'synthetic-ticket')
  assert.equal(body.sign, 'synthetic-signature')
  assert.deepEqual(f.identityReads, [])
  assert.deepEqual(f.effects, [{ operation: 'config-read', businessId: BUSINESS_B }])
})

test('authorization infrastructure error cannot write estado_conexion/ultimo_error', async () => {
  const f = fixture({ authReadFailure: true })
  const response = await f.request('Bearer synthetic-user-jwt', { business_id: BUSINESS_A })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { success: false, error: 'AUTHORIZATION_UNAVAILABLE' })
  assert.deepEqual(f.effects, [])
})

test('CAE Supabase client forwards its service credential and consumes the internal WSAA response', async () => {
  const f = fixture({ identityValid: false })
  const client = createClient('https://example.invalid', SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const request = new Request(input, init)
      assert.equal(new URL(request.url).pathname, '/functions/v1/afip-wsaa')
      assert.equal(request.headers.get('authorization'), `Bearer ${SERVICE}`)
      return f.request(request.headers.get('authorization'), await request.json())
    } },
  })
  const { data, error } = await client.functions.invoke('afip-wsaa', { body: { business_id: BUSINESS_A, service: 'wsfe' } })
  assert.equal(error, null)
  assert.equal(data.success, true)
  assert.equal(data.token, 'synthetic-ticket')
  assert.equal(data.sign, 'synthetic-signature')
  assert.deepEqual(f.identityReads, [])
})

test('authorized error write uses verified business and a sanitized message only', async () => {
  const f = fixture({ runFailure: true })
  const response = await f.request('Bearer synthetic-user-jwt', { business_id: BUSINESS_A })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { success: false, error: 'No se pudo completar la autenticación WSAA.' })
  assert.deepEqual(f.effects, [
    { operation: 'config-read', businessId: BUSINESS_A },
    { operation: 'error-write', businessId: BUSINESS_A, message: 'No se pudo completar la autenticación WSAA.' },
  ])
})

test('invalid business/service/refresh/body cannot enter privileged work or its error path', async () => {
  for (const body of [null, [], { business_id: 'invalid' }, { business_id: BUSINESS_A, service: '<xml>' },
    { business_id: BUSINESS_A, force_refresh: 'true' }]) {
    const f = fixture()
    assert.equal((await f.request('Bearer synthetic-user-jwt', body)).status, 400)
    assert.deepEqual(f.effects, [])
  }
})

test('CAE caller requires comprobantes and does not accept the service credential as a human', async () => {
  const f = fixture({ identityValid: false })
  await assert.rejects(authorizeArcaCaller(`Bearer ${SERVICE}`, {
    capability: 'comprobantes', createUserClient: () => f.client,
  }), { status: 401 })
  const permitted = fixture()
  const caller = await authorizeArcaCaller('Bearer synthetic-user-jwt', {
    capability: 'comprobantes', createUserClient: () => permitted.client,
  })
  assert.deepEqual(caller, { kind: 'user', userId: USER, businessId: BUSINESS_A })
})

test('CAE pre-send scopes attempt lookup to verified business and stops before WSAA/NC resolution', async () => {
  const filters: [string, string][] = []
  const client = { from(table: string) {
    assert.equal(table, 'arca_emission_attempts')
    return { select() { return this }, eq(key: string, value: string) { filters.push([key, value]); return this },
      maybeSingle: async () => ({ data: null, error: null }) }
  } }
  const result = await evaluarPreEnvio(client, { comprobanteId: 'known-foreign-receipt', attemptId: 'known-foreign-attempt',
    authorizedBusinessId: BUSINESS_A, body: {} })
  assert.deepEqual(filters, [['id', 'known-foreign-attempt'], ['business_id', BUSINESS_A]])
  assert.equal(result.ok, false)
  if (!result.ok) { assert.equal(result.status, 403); assert.equal(result.gate, 'FORBIDDEN_ATTEMPT') }
})

test('deployed entrypoints wire the tested boundary before privileged clients/calls', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
  const wsaa = read('../../supabase/functions/afip-wsaa/index.ts')
  assert.ok(wsaa.indexOf('return withWsaaAuthorization(req,') < wsaa.indexOf('const supabase = createClient(supabaseUrl, supabaseKey)'))
  assert.ok(!wsaa.includes('req.clone().json'))
  assert.match(wsaa, /serviceCredentials: configuredServiceCredentials\(Deno\.env\)/)
  assert.match(wsaa, /presentedApiKey: req\.headers\.get\('apikey'\)/)
  assert.ok(!wsaa.includes('serviceRoleKey:'), 'afip-wsaa must not pin the internal path to a single legacy key')
  const cae = read('../../supabase/functions/afip-cae/index.ts')
  assert.ok(cae.indexOf('await authorizeArcaCaller') < cae.indexOf('const supabase = createClient(supabaseUrl, supabaseKey)'))
  assert.match(cae, /authorizedBusinessId: caller.businessId/)
  assert.match(cae, /supabase\.functions\.invoke\('afip-wsaa'/)
  assert.ok(!/capability: 'comprobantes',\s*serviceCredentials/.test(cae), 'afip-cae accepts human callers only')
  const config = read('../../supabase/config.toml')
  // P0-ARCA-A: the injected server credential is not a JWT, so the gateway JWT
  // check must be off for afip-wsaa; afip-cae keeps it for its browser callers.
  assert.match(config, /\[functions.afip-wsaa\]\s*verify_jwt = false/)
  assert.match(config, /\[functions.afip-cae\]\s*verify_jwt = true/)
})

test('CAE own authorized attempt still reaches WSAA boundary with its persisted fiscal identity', async () => {
  const attempt = { id: 'own-attempt', comprobante_id: 'own-invoice', business_id: BUSINESS_A,
    ambiente: 'homologacion', cuit_emisor: '20111111112', punto_venta: 10, tipo_comprobante: 11,
    numero_intentado: null, status: 'claimed' }
  const filters: [string, unknown][] = []
  const client = {
    from(table: string) {
      assert.equal(table, 'arca_emission_attempts')
      return { select() { return this }, eq(key: string, value: unknown) { filters.push([key, value]); return this },
        maybeSingle: async () => ({ error: null, data: filters.every(([key, value]) =>
          (attempt as Record<string, unknown>)[key] === value) ? attempt : null }) }
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, 'snapshot_arca_comprobante_identity')
      assert.equal(args.p_business_id, BUSINESS_A)
      assert.equal(args.p_comprobante_id, 'own-invoice')
      return { error: null, data: { tipo: 'factura_c', tipo_comprobante_fiscal: null, comprobante_original_id: null } }
    },
  }
  const result = await evaluarPreEnvio(client, { authorizedBusinessId: BUSINESS_A,
    comprobanteId: 'own-invoice', attemptId: 'own-attempt', body: {} })
  assert.equal(result.ok, true)
  if (result.ok) { assert.deepEqual(result.attempt, attempt); assert.equal(result.requiereSnapshotNc, false) }
})

// ── P0-ARCA-A: service-to-service contract with the injected secret API key ──

test('P0 reproduction: legacy service_role JWT that is not the runtime credential falls to the user path (401)', async () => {
  // Exactly the certified production probe: gateway passed, exact match failed,
  // getUser rejected a token without sub → 401 UNAUTHENTICATED, nothing privileged ran.
  const f = fixture({ identityValid: false, serviceCredentials: [SECRET_KEY] })
  const response = await f.request(`Bearer ${LEGACY_SERVICE_JWT}`, { business_id: BUSINESS_A, service: 'wsfe' },
    { apikey: LEGACY_SERVICE_JWT })
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { success: false, error: 'UNAUTHENTICATED' })
  assert.deepEqual(f.identityReads, ['createUserClient', 'getUser'])
  assert.deepEqual(f.effects, [])
})

test('runtime sb_secret credential in Bearer and apikey (as afip-cae sends it) is internal', async () => {
  const f = fixture({ identityValid: false, serviceCredentials: [SECRET_KEY] })
  const response = await f.request(`Bearer ${SECRET_KEY}`, { business_id: BUSINESS_B, service: 'wsfe' }, { apikey: SECRET_KEY })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.token, 'synthetic-ticket')
  assert.equal(body.sign, 'synthetic-signature')
  assert.deepEqual(f.identityReads, [])
  assert.deepEqual(f.effects, [{ operation: 'config-read', businessId: BUSINESS_B }])
})

test('runtime credential in apikey is internal even if Authorization was replaced by another token', async () => {
  const f = fixture({ identityValid: false, serviceCredentials: [SECRET_KEY] })
  const response = await f.request(`Bearer ${PLATFORM_JWT}`, { business_id: BUSINESS_A }, { apikey: SECRET_KEY })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).token, 'synthetic-ticket')
  assert.deepEqual(f.identityReads, [])
})

test('runtime credential in apikey without Authorization is internal; wrong apikey without Authorization is 401 before identity', async () => {
  const ok = fixture({ serviceCredentials: [SECRET_KEY] })
  assert.equal((await ok.request(null, { business_id: BUSINESS_A }, { apikey: SECRET_KEY })).status, 200)
  assert.deepEqual(ok.identityReads, [])
  const bad = fixture({ serviceCredentials: [SECRET_KEY] })
  const response = await bad.request(null, { business_id: BUSINESS_A }, { apikey: `sb_secret_${'Z'.repeat(22)}_abcd1234` })
  assert.equal(response.status, 401)
  assert.deepEqual(bad.identityReads, [])
  assert.deepEqual(bad.effects, [])
})

test('publishable key, forged x-internal header and near-miss secrets never grant internal mode', async () => {
  const cases: [string | null, Record<string, string>][] = [
    [`Bearer ${PUBLISHABLE_KEY}`, { apikey: PUBLISHABLE_KEY }],
    [`Bearer ${SECRET_KEY.slice(0, -1)}X`, { apikey: `${SECRET_KEY}X` }],
    [`Bearer ${SECRET_KEY.slice(1)}`, { apikey: SECRET_KEY.toUpperCase() }],
    ['Bearer synthetic-user-jwt', { 'x-internal': 'true', 'x-role': 'service_role', apikey: PUBLISHABLE_KEY }],
  ]
  for (const [authorization, headers] of cases) {
    const f = fixture({ identityValid: false, serviceCredentials: [SECRET_KEY] })
    const response = await f.request(authorization, { business_id: BUSINESS_B }, headers)
    assert.equal(response.status, 401, JSON.stringify(headers))
    assert.deepEqual(f.effects, [])
  }
})

test('with no configured credential nothing is internal, not even an empty value', async () => {
  for (const serviceCredentials of [[], ['', ' ', 'short']]) {
    const f = fixture({ identityValid: false, serviceCredentials })
    assert.equal((await f.request('Bearer ', { business_id: BUSINESS_A }, { apikey: '' })).status, 401)
    assert.equal((await f.request('Bearer short', { business_id: BUSINESS_A }, { apikey: 'short' })).status, 401)
    assert.deepEqual(f.effects, [])
  }
})

test('user paths are unchanged when internal credentials are configured', async () => {
  const owner = fixture({ role: 'owner', serviceCredentials: [SECRET_KEY] })
  assert.equal((await owner.request('Bearer synthetic-user-jwt', { business_id: BUSINESS_A }, { apikey: PUBLISHABLE_KEY })).status, 200)
  const denied = fixture({ role: 'tech', capability: false, serviceCredentials: [SECRET_KEY] })
  assert.equal((await denied.request('Bearer synthetic-user-jwt', { business_id: BUSINESS_A }, { apikey: PUBLISHABLE_KEY })).status, 403)
  const inactive = fixture({ active: false, serviceCredentials: [SECRET_KEY] })
  assert.equal((await inactive.request('Bearer synthetic-user-jwt', { business_id: BUSINESS_A })).status, 403)
  const foreign = fixture({ role: 'owner', serviceCredentials: [SECRET_KEY] })
  assert.equal((await foreign.request('Bearer synthetic-user-jwt', { business_id: BUSINESS_B })).status, 403)
  assert.deepEqual(foreign.effects, [])
})

test('configuredServiceCredentials reads SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS, fails closed on junk', () => {
  const env = (values: Record<string, string>) => ({ get: (name: string) => values[name] })
  assert.deepEqual(configuredServiceCredentials(env({})), [])
  assert.deepEqual(configuredServiceCredentials(env({ SUPABASE_SERVICE_ROLE_KEY: ` ${SECRET_KEY} ` })), [SECRET_KEY])
  const other = `sb_secret_${'O'.repeat(22)}_abcd1234`
  assert.deepEqual(configuredServiceCredentials(env({
    SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY, automations: other, bad: 42, empty: '' }),
  })).sort(), [SECRET_KEY, other].sort())
  assert.deepEqual(configuredServiceCredentials(env({ SUPABASE_SECRET_KEYS: '{not json' })), [])
  assert.deepEqual(configuredServiceCredentials(env({ SUPABASE_SECRET_KEYS: JSON.stringify([SECRET_KEY]) })), [])
  assert.deepEqual(configuredServiceCredentials(env({ SUPABASE_SERVICE_ROLE_KEY: 'short' })), [])
})

test('afip-cae supabase client with an sb_secret key reaches the internal WSAA path end to end', async () => {
  const f = fixture({ identityValid: false, serviceCredentials: [SECRET_KEY] })
  const client = createClient('https://example.invalid', SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const request = new Request(input, init)
      assert.equal(request.headers.get('authorization'), `Bearer ${SECRET_KEY}`)
      assert.equal(request.headers.get('apikey'), SECRET_KEY)
      return f.request(request.headers.get('authorization'), await request.json(),
        { apikey: request.headers.get('apikey') ?? '' })
    } },
  })
  const { data, error } = await client.functions.invoke('afip-wsaa', { body: { business_id: BUSINESS_A, service: 'wsfe' } })
  assert.equal(error, null)
  assert.equal(data.token, 'synthetic-ticket')
  assert.deepEqual(f.identityReads, [])
})
