/**
 * entitlements — resolución centralizada de acceso/features (cliente).
 *
 * Cubre los casos A–E del audit de auth/planes/permisos a nivel de resolver
 * (la fuente de verdad client-side que consume useSubscription). El gating de
 * SaaS Admin (system_admins) y de Portal Clic (flag wholesale_portal_enabled +
 * rol) NO son features de plan y se validan en los tests SQL/RLS, no aquí.
 *
 * Puro: `node --test tests/unit/entitlements.test.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveEntitlement,
  hasActiveOverride,
  getAccessLevel,
} from '../../src/lib/entitlements.ts'

const NOW = new Date('2026-06-26T12:00:00Z')

// ── getAccessLevel ──────────────────────────────────────────────────────────
test('getAccessLevel mapea cada estado', () => {
  assert.equal(getAccessLevel('active'), 'full')
  assert.equal(getAccessLevel('trialing'), 'full')
  assert.equal(getAccessLevel('past_due'), 'limited')
  assert.equal(getAccessLevel('suspended'), 'blocked')
  assert.equal(getAccessLevel('canceled'), 'blocked')
  assert.equal(getAccessLevel('pending_activation'), 'blocked')
})

// ── hasActiveOverride ───────────────────────────────────────────────────────
test('hasActiveOverride: permanente / vigente / vencido / fuente inválida', () => {
  assert.equal(hasActiveOverride('manual_grandfathered', null, NOW), true)
  assert.equal(hasActiveOverride('admin_override', null, NOW), true)
  assert.equal(hasActiveOverride('admin_override', '2099-12-31T00:00:00Z', NOW), true)
  assert.equal(hasActiveOverride('admin_override', '2020-01-01T00:00:00Z', NOW), false)
  assert.equal(hasActiveOverride('mercado_pago', null, NOW), false)
  assert.equal(hasActiveOverride('trial', null, NOW), false)
  assert.equal(hasActiveOverride(null, null, NOW), false)
  assert.equal(hasActiveOverride('admin_override', 'no-es-fecha', NOW), false)
})

// ── CASO A — System Owner (molina): Full permanente vía override ─────────────
test('CASO A — owner Full + override permanente: acceso total, Mayorista visible', () => {
  const r = resolveEntitlement({
    subscription_status: 'active',
    subscription_plan: 'full',
    access_source: 'manual_grandfathered',
    override_expires_at: null,
  }, NOW)
  assert.equal(r.isAllowed, true)
  assert.equal(r.currentPlan, 'full')
  assert.equal(r.effectiveStatus, 'active')
  assert.equal(r.hasActiveOverride, true)
  assert.equal(r.hasFeature('mayorista'), true)
  assert.equal(r.hasFeature('audit'), true)
  assert.equal(r.hasFeature('multisucursal'), true)
  assert.equal(r.hasFeature('advancedRoles'), true)
})

test('CASO A (robustez) — override permanente rescata un estado bloqueado', () => {
  // Reproduce el bug previo (pending_activation) y prueba que el override lo cubre.
  const r = resolveEntitlement({
    subscription_status: 'pending_activation',
    subscription_plan: 'full',
    access_source: 'manual_grandfathered',
    override_expires_at: null,
  }, NOW)
  assert.equal(r.effectiveStatus, 'active')
  assert.equal(r.isAllowed, true)
  assert.equal(r.hasFeature('mayorista'), true)
})

// ── CASO B — cliente Básico ─────────────────────────────────────────────────
test('CASO B — Básico: NO Mayorista (paywall), NO features Pro', () => {
  const r = resolveEntitlement({ subscription_status: 'active', subscription_plan: 'basico' }, NOW)
  assert.equal(r.isAllowed, true)
  assert.equal(r.currentPlan, 'basico')
  assert.equal(r.hasFeature('mayorista'), false)
  assert.equal(r.hasFeature('arca'), false)
  assert.equal(r.hasFeature('personal_finance'), false)
  assert.equal(r.hasFeature('audit'), false)
})

// ── CASO C — cliente Pro ────────────────────────────────────────────────────
test('CASO C — Pro: features Pro sí, Mayorista NO (es Full-only)', () => {
  const r = resolveEntitlement({ subscription_status: 'active', subscription_plan: 'pro' }, NOW)
  assert.equal(r.hasFeature('arca'), true)
  assert.equal(r.hasFeature('personal_finance'), true)
  assert.equal(r.hasFeature('currentAccounts'), true)
  assert.equal(r.hasFeature('mayorista'), false)
  assert.equal(r.hasFeature('audit'), false)
  assert.equal(r.hasFeature('multisucursal'), false)
})

// ── CASO D — otro negocio Full (distinto de Clic) ───────────────────────────
test('CASO D — otro Full: ve Mayorista genérico (Portal Clic se gatea por flag, no por plan)', () => {
  const r = resolveEntitlement({
    subscription_status: 'active', subscription_plan: 'full', access_source: 'mercado_pago',
  }, NOW)
  assert.equal(r.hasFeature('mayorista'), true)
  // Portal Clic NO es feature de plan → no se decide acá (ver tests SQL/RLS).
})

// ── Bloqueos confirmados ────────────────────────────────────────────────────
test('suspended / canceled: bloqueado, sin ninguna feature', () => {
  for (const s of ['suspended', 'canceled'] as const) {
    const r = resolveEntitlement({ subscription_status: s, subscription_plan: 'full' }, NOW)
    assert.equal(r.isAllowed, false)
    assert.equal(r.hasFeature('mayorista'), false)
    assert.equal(r.hasFeature('arca'), false)
  }
})

test('pending_activation sin override: bloqueado (causa raíz original)', () => {
  const r = resolveEntitlement({
    subscription_status: 'pending_activation', subscription_plan: 'full', access_source: null,
  }, NOW)
  assert.equal(r.isAllowed, false)
  assert.equal(r.hasFeature('mayorista'), false)
})

test('override vencido NO rescata un estado bloqueado', () => {
  const r = resolveEntitlement({
    subscription_status: 'suspended', subscription_plan: 'full',
    access_source: 'admin_override', override_expires_at: '2020-01-01T00:00:00Z',
  }, NOW)
  assert.equal(r.isAllowed, false)
  assert.equal(r.hasFeature('mayorista'), false)
})

// ── Default optimista (sin datos cargados) ──────────────────────────────────
test('sin datos (null): default optimista trialing → features Pro, NO Mayorista', () => {
  const r = resolveEntitlement({ subscription_status: undefined, subscription_plan: undefined }, NOW)
  assert.equal(r.effectiveStatus, 'trialing')
  assert.equal(r.isAllowed, true)
  assert.equal(r.hasFeature('arca'), true)
  assert.equal(r.hasFeature('mayorista'), false)
})
