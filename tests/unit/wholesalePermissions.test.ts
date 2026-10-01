// PRE-BETA-3A-2 — motor PURO de acceso a Mayorista.
//
// Contrato de producto:
//   acceso = feature `mayorista` (Pro+) Y acceso al negocio
//            Y (owner | admin | capacidad `wholesale` EFECTIVA)
// owner/admin no dependen de la capacidad (un override false no los saca); el
// resto de los roles no la trae por defecto. Las capacidades se resuelven con
// la autoridad REAL de permisos (`resolvePermissions`: defaults + overrides).
//
// Puro: `node --test tests/unit/wholesalePermissions.test.ts`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideWholesaleAccess,
  canAccessWholesale,
  canManageWholesale,
  isWholesaleReadOnly,
  hasAutomaticWholesaleAccess,
  isBusinessRole,
  WHOLESALE_ROLES,
  WHOLESALE_MANAGE_ROLES,
  WHOLESALE_READONLY_ROLES,
  WHOLESALE_AUTOMATIC_ROLES,
  type BusinessRole,
  type WholesaleAccessInput,
} from '../../src/lib/permissions/wholesalePermissions.ts'
import { resolvePermissions, ROLE_DEFAULT_PERMISSIONS, type AppPermissions } from '../../src/config/permissions.ts'

const MANAGE: BusinessRole[] = ['owner', 'admin', 'manager', 'sales']
const READONLY: BusinessRole[] = ['tech', 'cashier', 'viewer']
const NON_AUTOMATIC: BusinessRole[] = ['manager', 'sales', 'tech', 'cashier', 'viewer']

/** Capacidad `wholesale` efectiva de un miembro no owner (defaults + overrides reales). */
function capability(role: BusinessRole, overrides: Partial<AppPermissions> | null = null): boolean {
  return resolvePermissions(role, overrides).wholesale
}

function input(role: string | null | undefined, over: Partial<WholesaleAccessInput> = {}): WholesaleAccessInput {
  return {
    role,
    hasMayoristaFeature: true,
    hasBusinessAccess: true,
    hasWholesaleCapability: isBusinessRole(role) && role !== 'owner' ? capability(role) : true,
    ...over,
  }
}

// ── DEFAULTS de la capacidad `wholesale` ─────────────────────────────────────
test('defaults: owner/admin traen wholesale; manager/sales/tech/cashier/viewer NO', () => {
  assert.equal(ROLE_DEFAULT_PERMISSIONS.owner.wholesale, true)
  assert.equal(ROLE_DEFAULT_PERMISSIONS.admin.wholesale, true)
  for (const role of NON_AUTOMATIC) {
    assert.equal(ROLE_DEFAULT_PERMISSIONS[role].wholesale, false, `${role} no debería traer wholesale`)
  }
})

test('roles automáticos = owner y admin, exactamente', () => {
  assert.deepEqual([...WHOLESALE_AUTOMATIC_ROLES], ['owner', 'admin'])
  for (const role of WHOLESALE_ROLES) {
    assert.equal(hasAutomaticWholesaleAccess(role), role === 'owner' || role === 'admin', role)
  }
  for (const bad of [null, undefined, '', 'OWNER', 'Admin', 'root']) {
    assert.equal(hasAutomaticWholesaleAccess(bad), false, String(bad))
  }
})

// ── ROLES ───────────────────────────────────────────────────────────────────
test('owner y admin: acceso automático con la feature', () => {
  for (const role of ['owner', 'admin'] as const) {
    assert.equal(canAccessWholesale(input(role)), true, role)
  }
})

test('manager / sales / tech / cashier / viewer SIN wholesale → no acceden', () => {
  for (const role of NON_AUTOMATIC) {
    assert.equal(decideWholesaleAccess(input(role)), 'actor_denied', role)
  }
})

test('manager / sales / tech / cashier / viewer CON wholesale → acceden', () => {
  for (const role of NON_AUTOMATIC) {
    const cap = capability(role, { wholesale: true })
    assert.equal(cap, true)
    assert.equal(canAccessWholesale(input(role, { hasWholesaleCapability: cap })), true, role)
  }
})

// ── OVERRIDE ────────────────────────────────────────────────────────────────
test('owner/admin NO pierden Mayorista por un override wholesale=false', () => {
  // admin: el override sí baja la capacidad…
  assert.equal(capability('admin', { wholesale: false }), false)
  // …pero la autoridad no depende de ella.
  for (const role of ['owner', 'admin'] as const) {
    assert.equal(canAccessWholesale(input(role, { hasWholesaleCapability: false })), true, role)
  }
})

test('miembros normales SÍ respetan wholesale=false (incluso sobre un true previo)', () => {
  for (const role of NON_AUTOMATIC) {
    const cap = capability(role, { wholesale: false })
    assert.equal(canAccessWholesale(input(role, { hasWholesaleCapability: cap })), false, role)
  }
})

// ── PLAN / ACCESO / FAIL-CLOSED ─────────────────────────────────────────────
test('sin feature: quien podría entrar ve el paywall; quien no, ni eso', () => {
  for (const role of ['owner', 'admin'] as const) {
    assert.equal(decideWholesaleAccess(input(role, { hasMayoristaFeature: false })), 'plan_required', role)
  }
  assert.equal(
    decideWholesaleAccess(input('sales', { hasMayoristaFeature: false, hasWholesaleCapability: true })),
    'plan_required',
  )
  // Sin la capacidad no se ofrece un upgrade que el actor no puede comprar.
  assert.equal(decideWholesaleAccess(input('sales', { hasMayoristaFeature: false })), 'actor_denied')
})

test('sin acceso al negocio → nadie accede (ni owner)', () => {
  for (const role of WHOLESALE_ROLES) {
    assert.equal(
      decideWholesaleAccess(input(role, { hasBusinessAccess: false, hasWholesaleCapability: true })),
      'actor_denied',
      role,
    )
  }
})

test('rol nulo / desconocido → no accede aunque traiga la capacidad (fail-closed)', () => {
  for (const role of [null, undefined, '', 'superadmin', 'OWNER']) {
    assert.equal(canAccessWholesale(input(role, { hasWholesaleCapability: true })), false, String(role))
  }
})

// ── ESCRITURA vs LECTURA dentro del acceso (espeja can_manage_wholesale) ────
test('con acceso: owner/admin/manager/sales gestionan; tech/cashier/viewer leen', () => {
  for (const role of MANAGE) {
    const ctx = input(role, { hasWholesaleCapability: true })
    assert.equal(canManageWholesale(ctx), true, role)
    assert.equal(isWholesaleReadOnly(ctx), false, role)
  }
  for (const role of READONLY) {
    const ctx = input(role, { hasWholesaleCapability: true })
    assert.equal(canManageWholesale(ctx), false, role)
    assert.equal(isWholesaleReadOnly(ctx), true, role)
  }
})

test('sin acceso no hay ni gestión ni lectura (manage/read-only derivan del acceso)', () => {
  for (const role of NON_AUTOMATIC) {
    const ctx = input(role) // defaults: sin wholesale
    assert.equal(canManageWholesale(ctx), false, role)
    assert.equal(isWholesaleReadOnly(ctx), false, role)
  }
  for (const role of WHOLESALE_ROLES) {
    const ctx = input(role, { hasMayoristaFeature: false, hasWholesaleCapability: true })
    assert.equal(canManageWholesale(ctx), false, role)
    assert.equal(isWholesaleReadOnly(ctx), false, role)
  }
})

test('manage y read-only son excluyentes y cubren a todo el que accede', () => {
  for (const role of WHOLESALE_ROLES) {
    const ctx = input(role, { hasWholesaleCapability: true })
    const manage = canManageWholesale(ctx)
    const ro = isWholesaleReadOnly(ctx)
    assert.equal(manage && ro, false, `rol ${role} no puede ser ambos`)
    assert.equal(manage || ro, canAccessWholesale(ctx), `rol ${role}`)
  }
})

// ── conjuntos de roles ──────────────────────────────────────────────────────
test('isBusinessRole valida solo los 7 roles', () => {
  for (const role of WHOLESALE_ROLES) assert.equal(isBusinessRole(role), true)
  for (const bad of [null, undefined, '', 'OWNER', 'root', 42, {}]) {
    assert.equal(isBusinessRole(bad as unknown), false, `${String(bad)} no es rol`)
  }
})

test('los conjuntos manage/readonly particionan los 7 roles', () => {
  assert.equal(WHOLESALE_MANAGE_ROLES.length + WHOLESALE_READONLY_ROLES.length, WHOLESALE_ROLES.length)
  for (const r of WHOLESALE_MANAGE_ROLES) assert.equal(WHOLESALE_READONLY_ROLES.includes(r), false)
})

// ── Portal Clic ya NO es parte de este motor ──────────────────────────────
// PRE-BETA-3A-2S: Portal Clic es una herramienta interna con autoridad
// server-side propia (public.current_user_has_internal_tool_access). Su matriz
// vive en tests/sql/prebeta3a2s_portal_clic_authority.test.sql y en
// tests/components/prebeta3a2WholesaleAccess.test.tsx (seccion C).
test('el motor Mayorista no exporta una autoridad de Portal Clic', async () => {
  const mod = await import('../../src/lib/permissions/wholesalePermissions.ts')
  assert.equal('canManageClicPortal' in mod, false)
})
