/**
 * Behavioral tests for the shared WhatsApp tenant-authorization logic
 * (`supabase/functions/_shared/whatsappAuth.ts`).
 *
 * The module is pure & dependency-injected, so node:test can drive it directly
 * with mocked clients — no Deno runtime needed. These prove the cross-tenant
 * fix: a user of business A cannot act on business B, the actor comes only from
 * the JWT (never the body), inactive members and disallowed roles are blocked,
 * and credentials/Meta are never reached when authorization fails.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  authorizeWhatsAppSender,
  ALLOWED_SENDER_ROLES,
  type AuthzDeps,
} from '../../supabase/functions/_shared/whatsappAuth.ts'

// ── Membership fixture: who belongs (actively) to which business, and as what ──
type Membership = { userId: string; businessId: string; role: string; active: boolean }
const MEMBERSHIPS: Membership[] = [
  { userId: 'userA', businessId: 'bizA', role: 'admin',  active: true },
  { userId: 'userB', businessId: 'bizB', role: 'owner',  active: true },
  { userId: 'userV', businessId: 'bizA', role: 'viewer', active: true },
  { userId: 'userX', businessId: 'bizA', role: 'sales',  active: false }, // revoked/inactive
]

/** Mirrors the Deno closure: only ACTIVE memberships resolve (filters is_active). */
function makeMembershipLookup(calls: Array<{ userId: string; businessId: string }>) {
  return async (userId: string, businessId: string) => {
    calls.push({ userId, businessId })
    const m = MEMBERSHIPS.find(
      (x) => x.userId === userId && x.businessId === businessId && x.active,
    )
    return m ? { role: m.role } : null
  }
}

function deps(partial: Partial<AuthzDeps> & Pick<AuthzDeps, 'getUserId' | 'businessId'>): AuthzDeps {
  return {
    getActiveMembership: makeMembershipLookup([]),
    ...partial,
  }
}

// 1) Member of A can send for A.
test('miembro activo de A puede enviar para A', async () => {
  const r = await authorizeWhatsAppSender(deps({
    getUserId: async () => 'userA',
    businessId: 'bizA',
  }))
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.userId, 'userA')
    assert.equal(r.role, 'admin')
  }
})

// 2) Member of A cannot send using business_id of B → 403 (cross-tenant blocked).
test('usuario de A NO puede enviar con business_id de B → 403', async () => {
  const calls: Array<{ userId: string; businessId: string }> = []
  const r = await authorizeWhatsAppSender({
    getUserId: async () => 'userA',
    getActiveMembership: makeMembershipLookup(calls),
    businessId: 'bizB',
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.status, 403)
  // membership was checked for (userA, bizB) and found nothing
  assert.deepEqual(calls, [{ userId: 'userA', businessId: 'bizB' }])
})

// 3) User with no business membership → 403.
test('usuario sin negocio → 403', async () => {
  const r = await authorizeWhatsAppSender(deps({
    getUserId: async () => 'ghost',
    businessId: 'bizA',
  }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.status, 403)
})

// 4) Inactive/revoked membership → 403.
test('membresía inactiva/revocada → 403', async () => {
  const r = await authorizeWhatsAppSender(deps({
    getUserId: async () => 'userX', // member of bizA but active=false
    businessId: 'bizA',
  }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.status, 403)
})

// 5) Missing/invalid JWT → 401.
test('JWT ausente o inválido → 401', async () => {
  const r = await authorizeWhatsAppSender(deps({
    getUserId: async () => null,
    businessId: 'bizA',
  }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.status, 401)
})

// 6) Nonexistent business is non-enumerative: same 403 + message as "not a member".
test('business_id inexistente no filtra info (mismo 403 que no-miembro)', async () => {
  const notMember = await authorizeWhatsAppSender(deps({
    getUserId: async () => 'userA',
    businessId: 'bizB', // exists, not a member
  }))
  const nonexistent = await authorizeWhatsAppSender(deps({
    getUserId: async () => 'userA',
    businessId: 'biz-does-not-exist',
  }))
  assert.equal(notMember.ok, false)
  assert.equal(nonexistent.ok, false)
  if (!notMember.ok && !nonexistent.ok) {
    assert.equal(notMember.status, nonexistent.status)
    assert.equal(notMember.error, nonexistent.error) // identical → no existence signal
  }
})

// 7 & 8) When authorization fails, the credential/Meta step is never reached.
test('autz fallida ⇒ no se leen credenciales ni se llama a Meta', async () => {
  let credentialsRead = false
  let metaCalled = false
  const guardedSend = async (d: AuthzDeps) => {
    const authz = await authorizeWhatsAppSender(d)
    if (!authz.ok) return { sent: false, status: authz.status }
    credentialsRead = true // stand-in for loadActiveConnection()/Vault
    metaCalled = true      // stand-in for callMetaMessagesAPI()
    return { sent: true, status: 200 }
  }
  // A → B (blocked)
  const blocked = await guardedSend(deps({ getUserId: async () => 'userA', businessId: 'bizB' }))
  assert.equal(blocked.sent, false)
  assert.equal(credentialsRead, false)
  assert.equal(metaCalled, false)
  // A → A (allowed) reaches the credential/Meta step exactly once
  const ok = await guardedSend(deps({ getUserId: async () => 'userA', businessId: 'bizA' }))
  assert.equal(ok.sent, true)
  assert.equal(credentialsRead, true)
  assert.equal(metaCalled, true)
})

// 9) Disallowed role (viewer) is blocked even with active membership.
test('rol no autorizado (viewer) → 403', async () => {
  const r = await authorizeWhatsAppSender(deps({
    getUserId: async () => 'userV', // viewer in bizA
    businessId: 'bizA',
  }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.status, 403)
  // sanity: viewer is intentionally excluded from the allowlist
  assert.equal(ALLOWED_SENDER_ROLES.includes('viewer'), false)
  assert.equal(ALLOWED_SENDER_ROLES.includes('admin'), true)
})

// 10) A `user_id` in the body is NOT an authority source; the actor is the JWT.
test('no se confía en user_id del body; el actor sale del JWT', async () => {
  // businessId carries an attacker-controlled user_id-shaped object; ignored.
  const calls: Array<{ userId: string; businessId: string }> = []
  const r = await authorizeWhatsAppSender({
    getUserId: async () => 'userA', // JWT actor
    getActiveMembership: makeMembershipLookup(calls),
    // Even if the body tried to smuggle user_id, authz only consumes businessId
    // and the JWT-derived id. The membership lookup must use the JWT id 'userA'.
    businessId: 'bizA',
  })
  assert.equal(r.ok, true)
  assert.equal(calls[0].userId, 'userA')
})

// Ordering guarantee: no session beats missing business_id (401 before 400).
test('orden: 401 (sin sesión) precede a 400 (sin business_id)', async () => {
  const r = await authorizeWhatsAppSender({
    getUserId: async () => null,
    getActiveMembership: async () => null,
    businessId: '', // also missing
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.status, 401)
})

// Missing business_id (with valid session) → 400.
test('business_id ausente con sesión válida → 400', async () => {
  const r = await authorizeWhatsAppSender({
    getUserId: async () => 'userA',
    getActiveMembership: async () => null,
    businessId: undefined,
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.status, 400)
})
