/**
 * Plan entitlements — single-source-of-truth consistency.
 *
 * Verifies the client entitlements matrix (planFeatures.ts) matches:
 *   1. the commercial rules of the audit (Básico/Pro/Full + Trial = Pro);
 *   2. the server-side RPC `get_business_subscription_features` (encoded here as
 *      the canonical matrix), so client and DB cannot silently drift.
 *
 * planFeatures.ts is pure (no import.meta) so it is imported directly.
 * subscription.ts uses import.meta → its prices are read from source text.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PLAN_FEATURES,
  TRIAL_FEATURES,
  FEATURE_REQUIRED_PLAN,
  type PlanFeature,
} from '../../src/config/planFeatures.ts'

const subscriptionSrc = readFileSync(new URL('../../src/types/subscription.ts', import.meta.url), 'utf-8')

function planMonthlyPrices(): Record<string, number> {
  const out: Record<string, number> = {}
  const re = /id:\s*'(basico|pro|full)'[\s\S]*?price_monthly:\s*([\d_]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(subscriptionSrc))) out[m[1]] = Number(m[2].replace(/_/g, ''))
  return out
}

// ── Canonical matrix = the corrected get_business_subscription_features RPC ──
const PRO_TIER: PlanFeature[]  = ['arca', 'currentAccounts', 'reports', 'advancedFinance', 'tasks', 'personal_finance']
const FULL_ONLY: PlanFeature[] = ['advancedRoles', 'audit', 'multisucursal', 'mayorista']

function expectedHas(feature: PlanFeature, plan: 'basico' | 'pro' | 'full' | 'trial'): boolean {
  if (plan === 'trial') return PRO_TIER.includes(feature)             // trial mirrors Pro
  if (FULL_ONLY.includes(feature)) return plan === 'full'
  if (PRO_TIER.includes(feature)) return plan === 'pro' || plan === 'full'
  return false
}

// ── Commercial prices ───────────────────────────────────────────────────────
test('precios mensuales: Básico 15.000 / Pro 25.000 / Full 45.000', () => {
  const p = planMonthlyPrices()
  assert.equal(p.basico, 15_000)
  assert.equal(p.pro,    25_000)
  assert.equal(p.full,   45_000)
})

// ── Mi Guita gating ─────────────────────────────────────────────────────────
test('Mi Guita (personal_finance): Básico NO, Pro/Full SÍ, Trial SÍ', () => {
  assert.equal(PLAN_FEATURES.basico.personal_finance, false)
  assert.equal(PLAN_FEATURES.pro.personal_finance, true)
  assert.equal(PLAN_FEATURES.full.personal_finance, true)
  assert.equal(TRIAL_FEATURES.personal_finance, true)
})

// ── Full plan: multisucursal + 10 usuarios ──────────────────────────────────
test('Full incluye multisucursal y hasta 10 usuarios', () => {
  assert.equal(PLAN_FEATURES.full.multisucursal, true)
  assert.equal(PLAN_FEATURES.full.maxUsers, 10)
  assert.equal(PLAN_FEATURES.pro.maxUsers, 3)
  assert.equal(PLAN_FEATURES.basico.maxUsers, 1)
})

// ── Trial = Pro (incl. NO mayorista, since Pro has no mayorista) ─────────────
test('Trial refleja exactamente las features del plan Pro', () => {
  for (const key of Object.keys(PLAN_FEATURES.pro) as (keyof typeof PLAN_FEATURES.pro)[]) {
    assert.equal(TRIAL_FEATURES[key], PLAN_FEATURES.pro[key], `Trial debe igualar Pro en ${String(key)}`)
  }
})

// ── Client matrix matches the canonical (DB) matrix ─────────────────────────
test('PLAN_FEATURES y TRIAL_FEATURES coinciden con el RPC de entitlements', () => {
  const allFeatures = [...PRO_TIER, ...FULL_ONLY]
  for (const f of allFeatures) {
    assert.equal(PLAN_FEATURES.basico[f], expectedHas(f, 'basico'), `basico.${f}`)
    assert.equal(PLAN_FEATURES.pro[f],    expectedHas(f, 'pro'),    `pro.${f}`)
    assert.equal(PLAN_FEATURES.full[f],   expectedHas(f, 'full'),   `full.${f}`)
    assert.equal(TRIAL_FEATURES[f],       expectedHas(f, 'trial'),  `trial.${f}`)
  }
})

// ── mayorista is Full-only (regression: it was wrongly 'pro') ────────────────
test('mayorista es Full-only y FEATURE_REQUIRED_PLAN lo refleja', () => {
  assert.equal(PLAN_FEATURES.basico.mayorista, false)
  assert.equal(PLAN_FEATURES.pro.mayorista, false)
  assert.equal(PLAN_FEATURES.full.mayorista, true)
  assert.equal(FEATURE_REQUIRED_PLAN.mayorista, 'full')
})

// ── FEATURE_REQUIRED_PLAN is internally consistent with PLAN_FEATURES ───────
test('FEATURE_REQUIRED_PLAN: el plan requerido tiene la feature y el inferior no', () => {
  for (const [feat, reqPlan] of Object.entries(FEATURE_REQUIRED_PLAN) as [PlanFeature, 'pro' | 'full'][]) {
    assert.equal(PLAN_FEATURES[reqPlan][feat], true, `${feat} debería estar activa en ${reqPlan}`)
    assert.equal(PLAN_FEATURES.basico[feat], false, `${feat} no debería estar en Básico`)
    if (reqPlan === 'full') {
      assert.equal(PLAN_FEATURES.pro[feat], false, `${feat} es Full-only; Pro no debería tenerla`)
    }
  }
})
