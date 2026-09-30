/**
 * Plan entitlements — single-source-of-truth consistency.
 *
 * Verifies the client entitlements matrix (planFeatures.ts) matches:
 *   1. the commercial rules of the audit (Básico/Pro/Full + Trial = Pro);
 *   2. the server-side RPC `get_business_subscription_features` (encoded here as
 *      the canonical matrix), so client and DB cannot silently drift.
 *
 * PRE-BETA-3A-2: `mayorista` pasa a Pro+ por contrato de producto. El servidor
 * todavía no (ver el test «GAP PRE-BETA-3A-2S» al final): hasta que 3A-2S alinee
 * el RPC y `business_has_feature`, la matriz canónica de acá es el CONTRATO, y
 * ese test deja la divergencia a la vista en vez de esconderla.
 *
 * planFeatures.ts is pure (no import.meta) so it is imported directly.
 * subscription.ts uses import.meta → its prices are read from source text.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
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

// ── Canonical matrix = product contract (= RPC once PRE-BETA-3A-2S lands) ────
const PRO_TIER: PlanFeature[]  = ['arca', 'currentAccounts', 'reports', 'advancedFinance', 'tasks', 'personal_finance', 'mayorista']
const FULL_ONLY: PlanFeature[] = ['advancedRoles', 'audit', 'multisucursal']

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

// ── Trial = Pro (incl. mayorista, since PRE-BETA-3A-2 Pro has mayorista) ─────
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

// ── PRE-BETA-3A-2: mayorista es Pro+ (Básico no) ────────────────────────────
test('mayorista: Básico NO, Pro SÍ, Full SÍ, Trial SÍ, y FEATURE_REQUIRED_PLAN = pro', () => {
  assert.equal(PLAN_FEATURES.basico.mayorista, false)
  assert.equal(PLAN_FEATURES.pro.mayorista, true)
  assert.equal(PLAN_FEATURES.full.mayorista, true)
  // El trial conserva su semántica: hereda Pro, sin excepción por feature.
  assert.equal(TRIAL_FEATURES.mayorista, true)
  assert.equal(TRIAL_FEATURES.mayorista, PLAN_FEATURES.pro.mayorista)
  assert.equal(FEATURE_REQUIRED_PLAN.mayorista, 'pro')
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

// ── GAP PRE-BETA-3A-2S: el servidor sigue resolviendo `mayorista` Full-only ───
// No es un test del contrato: prueba que la divergencia EXISTE en la última
// definición migrada. Cuando PRE-BETA-3A-2S alinee el servidor, este test falla
// a propósito y se reemplaza por la paridad (Pro+) contra esas funciones.
function lastDefinition(fn: string): string {
  const dir = new URL('../../supabase/migrations/', import.meta.url)
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  const header = new RegExp(`CREATE OR REPLACE FUNCTION "?public"?\\."?${fn}"?\\(`, 'g')
  let last = ''
  for (const f of files) {
    const sql = readFileSync(new URL(f, dir), 'utf-8')
    // La ÚLTIMA definición del archivo (un archivo puede redefinirla).
    for (const m of sql.matchAll(header)) {
      const end = sql.indexOf('$$;', m.index)
      last = sql.slice(m.index, end > 0 ? end : undefined)
    }
  }
  assert.ok(last, `no se encontró la definición de ${fn}`)
  return last
}

test('GAP PRE-BETA-3A-2S: business_has_feature y el RPC siguen dando mayorista sólo a Full', () => {
  const hasFeature = lastDefinition('business_has_feature')
  assert.match(hasFeature, /WHEN 'mayorista'\s+THEN b\.subscription_plan = 'full'/)
  const rpc = lastDefinition('get_business_subscription_features')
  assert.match(rpc, /'mayorista',\s+"?public"?\."?_feat_full"?\(/)
  // …mientras el contrato del cliente ya es Pro+.
  assert.equal(PLAN_FEATURES.pro.mayorista, true)
})
