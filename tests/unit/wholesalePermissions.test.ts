import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canViewWholesale,
  canManageWholesale,
  isWholesaleReadOnly,
  canManageClicPortal,
  isBusinessRole,
  WHOLESALE_ROLES,
  WHOLESALE_MANAGE_ROLES,
  WHOLESALE_READONLY_ROLES,
  type BusinessRole,
} from '../../src/lib/permissions/wholesalePermissions.ts'

const MANAGE: BusinessRole[] = ['owner', 'admin', 'manager', 'sales']
const READONLY: BusinessRole[] = ['tech', 'cashier', 'viewer']

// ── canViewWholesale ─────────────────────────────────────────────────────────
test('canViewWholesale: los 7 roles ven Mayorista con feature + acceso', () => {
  for (const role of WHOLESALE_ROLES) {
    assert.equal(
      canViewWholesale({ role, hasMayoristaFeature: true, hasBusinessAccess: true }),
      true,
      `rol ${role} debería poder ver`,
    )
  }
})

test('canViewWholesale: sin feature → no ve (cualquier rol)', () => {
  for (const role of WHOLESALE_ROLES) {
    assert.equal(canViewWholesale({ role, hasMayoristaFeature: false, hasBusinessAccess: true }), false)
  }
})

test('canViewWholesale: sin acceso al negocio → no ve (aunque haya feature)', () => {
  for (const role of WHOLESALE_ROLES) {
    assert.equal(canViewWholesale({ role, hasMayoristaFeature: true, hasBusinessAccess: false }), false, `rol ${role}`)
  }
})

test('canViewWholesale: rol nulo/desconocido → no ve (fail-closed)', () => {
  assert.equal(canViewWholesale({ role: null, hasMayoristaFeature: true, hasBusinessAccess: true }), false)
  assert.equal(canViewWholesale({ role: undefined, hasMayoristaFeature: true, hasBusinessAccess: true }), false)
  assert.equal(canViewWholesale({ role: 'superadmin', hasMayoristaFeature: true, hasBusinessAccess: true }), false)
})

// ── canManageWholesale ───────────────────────────────────────────────────────
test('canManageWholesale: owner/admin/manager/sales con feature + acceso → gestionan', () => {
  for (const role of MANAGE) {
    assert.equal(canManageWholesale({ role, hasMayoristaFeature: true, hasBusinessAccess: true }), true, `rol ${role}`)
  }
})

test('canManageWholesale: tech/cashier/viewer con feature + acceso → NO gestionan', () => {
  for (const role of READONLY) {
    assert.equal(canManageWholesale({ role, hasMayoristaFeature: true, hasBusinessAccess: true }), false, `rol ${role}`)
  }
})

test('canManageWholesale: sin feature → nadie gestiona', () => {
  for (const role of WHOLESALE_ROLES) {
    assert.equal(canManageWholesale({ role, hasMayoristaFeature: false, hasBusinessAccess: true }), false, `rol ${role}`)
  }
})

test('canManageWholesale: sin acceso al negocio → nadie gestiona (fail-closed)', () => {
  for (const role of MANAGE) {
    assert.equal(canManageWholesale({ role, hasMayoristaFeature: true, hasBusinessAccess: false }), false, `rol ${role}`)
  }
})

test('canManageWholesale: owner + feature pero SIN acceso al business → no administra', () => {
  assert.equal(canManageWholesale({ role: 'owner', hasMayoristaFeature: true, hasBusinessAccess: false }), false)
})

test('canManageWholesale: sales + feature pero SIN acceso → no administra', () => {
  assert.equal(canManageWholesale({ role: 'sales', hasMayoristaFeature: true, hasBusinessAccess: false }), false)
})

test('canManageWholesale: rol nulo/desconocido + feature + acceso → no gestiona (fail-closed)', () => {
  assert.equal(canManageWholesale({ role: null, hasMayoristaFeature: true, hasBusinessAccess: true }), false)
  assert.equal(canManageWholesale({ role: 'root', hasMayoristaFeature: true, hasBusinessAccess: true }), false)
})

// ── isWholesaleReadOnly ──────────────────────────────────────────────────────
test('isWholesaleReadOnly: tech/cashier/viewer con feature + acceso → solo lectura', () => {
  for (const role of READONLY) {
    assert.equal(isWholesaleReadOnly({ role, hasMayoristaFeature: true, hasBusinessAccess: true }), true, `rol ${role}`)
  }
})

test('isWholesaleReadOnly: owner/admin/manager/sales → NO read-only (gestionan)', () => {
  for (const role of MANAGE) {
    assert.equal(isWholesaleReadOnly({ role, hasMayoristaFeature: true, hasBusinessAccess: true }), false, `rol ${role}`)
  }
})

test('isWholesaleReadOnly: sin feature → false', () => {
  for (const role of READONLY) {
    assert.equal(isWholesaleReadOnly({ role, hasMayoristaFeature: false, hasBusinessAccess: true }), false, `rol ${role}`)
  }
})

test('isWholesaleReadOnly: tech + feature pero SIN acceso → NO queda en read-only (fail-closed)', () => {
  for (const role of READONLY) {
    assert.equal(isWholesaleReadOnly({ role, hasMayoristaFeature: true, hasBusinessAccess: false }), false, `rol ${role}`)
  }
})

test('isWholesaleReadOnly: rol nulo durante carga → fail-closed', () => {
  assert.equal(isWholesaleReadOnly({ role: null, hasMayoristaFeature: true, hasBusinessAccess: true }), false)
  assert.equal(isWholesaleReadOnly({ role: undefined, hasMayoristaFeature: false, hasBusinessAccess: false }), false)
})

test('manage y read-only son mutuamente excluyentes y cubren los 7 roles (con feature + acceso)', () => {
  for (const role of WHOLESALE_ROLES) {
    const ctx = { role, hasMayoristaFeature: true, hasBusinessAccess: true }
    const manage = canManageWholesale(ctx)
    const ro = isWholesaleReadOnly(ctx)
    assert.equal(manage && ro, false, `rol ${role} no puede ser ambos`)
    assert.equal(manage || ro, true, `rol ${role} debe ser manage o read-only`)
  }
})

// ── canManageClicPortal ──────────────────────────────────────────────────────
test('canManageClicPortal: owner real + portal habilitado → administra', () => {
  assert.equal(canManageClicPortal({ isBusinessOwner: true, wholesalePortalEnabled: true }), true)
})

test('canManageClicPortal: NO owner real (admin/otro) aunque portal habilitado → no administra', () => {
  assert.equal(canManageClicPortal({ isBusinessOwner: false, wholesalePortalEnabled: true }), false)
})

test('canManageClicPortal: owner real pero portal deshabilitado → no administra', () => {
  assert.equal(canManageClicPortal({ isBusinessOwner: true, wholesalePortalEnabled: false }), false)
})

test('canManageClicPortal: ni owner ni portal → no administra (fail-closed)', () => {
  assert.equal(canManageClicPortal({ isBusinessOwner: false, wholesalePortalEnabled: false }), false)
})

// ── conjuntos de roles ───────────────────────────────────────────────────────
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
