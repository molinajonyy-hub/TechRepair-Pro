// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  caseFingerprint, createPlanAInspector, executePlanARecovery, inspectPlanARecovery,
  parsePlanACase, PLAN_A_BUSINESS_KEYS, PLAN_A_CASE_FINGERPRINT, PLAN_A_HISTORICAL_APPLICATION_VERIFIED,
  PLAN_A_SESSION_KEYS, readOnlyMpClient,
} from '../../../supabase/functions/_shared/billing/planARecovery.ts'
import type {
  PlanAApproval, PlanACase, PlanAInspectionDependencies, PlanAReader, PlanAReceipt, PlanASnapshot,
} from '../../../supabase/functions/_shared/billing/planARecovery.ts'
import type { PaymentLedgerRow } from '../../../supabase/functions/_shared/billing/store.ts'
import { createMpClient } from '../../../supabase/functions/_shared/billing/mpClient.ts'
import { BIZ_A, BIZ_B, OWNER_A, World } from './harness.ts'
import { FAKE_MP_TOKEN, FakeMercadoPago } from './fakeMercadoPago.ts'

const NOW = '2026-10-16T12:00:00.000Z'
const RESERVED = '2026-10-02T12:45:00.000Z'
const CREATED = '2026-10-02T12:46:00.000Z'
const INVOICED = '2026-10-02T12:46:30.000Z'
const APPROVED = '2026-10-02T12:47:00.000Z'
const NEXT = '2026-11-02T12:47:00.000Z'
const TRUST = { applicationId: '110001', collectorId: '220001' }
const IDENTITY: PlanACase = {
  business_id: BIZ_A,
  session_id: '33333333-3333-4333-8333-33333333cccc',
  preapproval_id: 'plan-a-contract-fixture',
  preapproval_plan_id: 'plan-a-template-fixture',
  invoice_id: '730001',
  payment_id: '740001',
}
const REFERENCE = 'trpcs_dddddddd-0000-4000-8000-0000000000aa'
const terms = () => ({ frequency: 1, frequency_type: 'months', transaction_amount: 15000, currency_id: 'ARS' })

async function fixture() {
  const identity = { ...IDENTITY }
  const business = Object.fromEntries(PLAN_A_BUSINESS_KEYS.map(key => [key, null])) as Record<string, unknown>
  Object.assign(business, { id: BIZ_A, subscription_status: 'trialing', subscription_plan: null,
    access_source: 'trial', trial_ends_at: '2026-10-09T12:45:00.000Z', updated_at: RESERVED })
  const session = Object.fromEntries(PLAN_A_SESSION_KEYS.map(key => [key, null])) as Record<string, unknown>
  Object.assign(session, { id: identity.session_id, business_id: BIZ_A, user_id: OWNER_A, plan_id: 'basico',
    billing_cycle: 'monthly', amount: 15000, currency: 'ARS', external_reference: REFERENCE,
    status: 'pending', created_at: RESERVED, updated_at: RESERVED, mp_preapproval_plan_id: identity.preapproval_plan_id })
  const snapshot: PlanASnapshot = {
    business, session, otherSessionIds: [], businessPayments: [], boundBusinessId: null, boundSessionId: null,
    recoveryRecorded: false, recoveryDigest: null,
  }
  const ledger = new Map<string, PaymentLedgerRow>()
  let snapshotLoads = 0
  let onSnapshotLoad: ((count: number) => void) | undefined
  // The inspection receives exactly three readers, with no database mutator capability.
  const reader: PlanAReader = Object.freeze({
    loadSnapshot: async (requested: PlanACase) => {
      expect(requested).toEqual(identity)
      snapshotLoads++
      onSnapshotLoad?.(snapshotLoads)
      return structuredClone(snapshot)
    },
    getPaymentByInvoiceId: async (id: string) => structuredClone(ledger.get(id) ?? null),
    getPaymentByPaymentId: async (id: string) => structuredClone([...ledger.values()].find(row => row.raw_payload.payment_id === id) ?? null),
  })
  const mp = new FakeMercadoPago(() => new Date(NOW))
  const pre = mp.seedForeignPreapproval(identity.preapproval_id, { status: 'authorized', external_reference: '',
    preapproval_plan_id: identity.preapproval_plan_id, application_id: TRUST.applicationId, collector_id: TRUST.collectorId,
    date_created: CREATED, last_modified: APPROVED, next_payment_date: NEXT, auto_recurring: terms() })
  const plan: Record<string, unknown> = { id: identity.preapproval_plan_id, status: 'active', application_id: TRUST.applicationId,
    collector_id: TRUST.collectorId, date_created: '2026-10-01T12:00:00.000Z', last_modified: '2026-10-01T12:00:00.000Z', auto_recurring: terms() }
  mp.preapprovalPlans.set(identity.preapproval_plan_id, plan)
  const invoice: Record<string, unknown> = { id: identity.invoice_id, preapproval_id: identity.preapproval_id, status: 'processed',
    transaction_amount: 15000, currency_id: 'ARS', date_created: INVOICED, debit_date: INVOICED,
    payment: { id: identity.payment_id, status: 'approved' } }
  mp.authorizedPayments.set(identity.invoice_id, invoice)
  const payment: Record<string, unknown> = { id: identity.payment_id, status: 'approved', status_detail: 'accredited',
    collector_id: TRUST.collectorId, live_mode: true, transaction_amount: 15000, currency_id: 'ARS', date_created: INVOICED, date_approved: APPROVED }
  mp.payments.set(identity.payment_id, payment)
  const deps: PlanAInspectionDependencies = { reader, mp: createMpClient({ fetchImpl: (input, init) => mp.fetchImpl(input, init), accessToken: () => FAKE_MP_TOKEN }), now: () => new Date(NOW), sourceCommit: 'c'.repeat(40) }
  const inspect = createPlanAInspector(await caseFingerprint(identity))
  return { identity, business, session, snapshot, reader, ledger, mp, pre, plan, invoice, payment, deps,
    inspect: () => inspect(deps, identity, TRUST), inspector: inspect, snapshotLoads: () => snapshotLoads,
    onSnapshotLoad: (fn: (count: number) => void) => { onSnapshotLoad = fn } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

function foreignLedger(identity = IDENTITY): PaymentLedgerRow {
  return { business_id: BIZ_B, external_payment_id: identity.invoice_id, type: 'recurring', amount: 15000,
    currency: 'ARS', status: 'approved', subscription_plan: 'basico', paid_at: APPROVED,
    raw_payload: { preapproval_id: identity.preapproval_id, authorized_payment_id: identity.invoice_id, payment_id: identity.payment_id } }
}

describe('Plan A attested dry run has read-only capabilities and canonical payment authority', () => {
  it('builds one verified ledger/commit plan without changing the real reader, business or session', async () => {
    const f = await fixture()
    const before = structuredClone(f.snapshot)
    const report = await f.inspect()
    expect(report.blockers).toEqual([])
    expect(report.eligible).toBe(true)
    expect(report.mode).toBe('dry-run')
    expect(report.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(report.plan).toMatchObject({ identity: IDENTITY, providerLastModified: APPROVED, nextPaymentDate: NEXT,
      ledger: { business_id: BIZ_A, external_payment_id: IDENTITY.invoice_id, status: 'approved', paid_at: APPROVED,
        amount: 15000, currency: 'ARS', subscription_plan: 'basico', raw_payload: { payment_id: IDENTITY.payment_id, preapproval_id: IDENTITY.preapproval_id } } })
    expect(Object.keys(report.plan!.expectedBusiness).sort()).toEqual([...PLAN_A_BUSINESS_KEYS].sort())
    expect(Object.keys(report.plan!.expectedSession).sort()).toEqual([...PLAN_A_SESSION_KEYS].sort())
    expect(f.snapshot).toEqual(before)
    expect(f.ledger.size).toBe(0)
    expect(f.snapshotLoads()).toBe(2)
    expect(Object.keys(f.reader).sort()).toEqual(['getPaymentByInvoiceId', 'getPaymentByPaymentId', 'loadSnapshot'])
    expect(f.mp.calls.every(call => call.method === 'GET')).toBe(true)
    expect(f.mp.calls.some(call => call.path.startsWith('/preapproval/search') || call.path.includes('payer_email'))).toBe(false)
    expect(f.mp.calls.filter(call => call.path.startsWith('/authorized_payments/search')).every(call => !call.path.includes('offset=') && !call.path.includes('limit='))).toBe(true)
  })

  it('repeated and concurrent dry runs produce the same evidence and never mutate local state', async () => {
    const f = await fixture()
    const before = structuredClone(f.snapshot)
    const reports = await Promise.all([f.inspect(), f.inspect(), f.inspect()])
    reports.push(await f.inspect())
    expect(reports.every(report => report.eligible)).toBe(true)
    expect(new Set(reports.map(report => report.evidenceDigest)).size).toBe(1)
    expect(f.snapshot).toEqual(before)
    expect(f.ledger.size).toBe(0)
    expect(f.mp.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('an existing provider label alone grants no authority and is still compatible with an untouched trial', async () => {
    const f = await fixture()
    f.business.subscription_provider = 'mercadopago'
    const before = structuredClone(f.snapshot)
    expect((await f.inspect()).eligible).toBe(true)
    expect(f.snapshot).toEqual(before)
    expect(f.ledger.size).toBe(0)
  })

  it('the public inspector refuses synthetic identities before any provider or database lookup', async () => {
    const f = await fixture()
    const report = await inspectPlanARecovery(f.deps, f.identity, TRUST)
    expect(report.eligible).toBe(false)
    expect(report.blockers).toEqual(['owner_attested_identity'])
    expect(f.snapshotLoads()).toBe(0)
    expect(f.mp.calls).toEqual([])
  })

  it.each(['public inspector', 'default factory', 'explicit production fingerprint'])('%s retains the compiled historical-application block despite configuration changes', async entryPoint => {
    const f = await fixture()
    expect(PLAN_A_HISTORICAL_APPLICATION_VERIFIED).toBe(false)
    const inspector = entryPoint === 'public inspector' ? inspectPlanARecovery
      : entryPoint === 'default factory' ? createPlanAInspector() : createPlanAInspector(PLAN_A_CASE_FINGERPRINT)
    // Reach the compiled production gate using synthetic IDs only. Spoofing this
    // single test digest does not enable the gate or supply a mutating capability.
    const bytes = Uint8Array.from(PLAN_A_CASE_FINGERPRINT.match(/.{2}/g)!, hex => Number.parseInt(hex, 16))
    const digest = vi.spyOn(crypto.subtle, 'digest').mockResolvedValueOnce(bytes.buffer)
    vi.stubEnv('PLAN_A_HISTORICAL_APPLICATION_VERIFIED', 'true')
    vi.stubEnv('MP_APPLICATION_ID', '999999')
    vi.stubEnv('MP_COLLECTOR_ID', '999999')
    try {
      const report = await inspector(f.deps, f.identity, { applicationId: '999999', collectorId: '999999' })
      expect(report.eligible).toBe(false)
      expect(report.blockers).toEqual(['historical_application_identity_unresolved'])
      expect(report.plan).toBeNull()
      expect(f.snapshotLoads()).toBe(0)
      expect(f.mp.calls).toEqual([])
      expect(f.ledger.size).toBe(0)
    } finally { digest.mockRestore(); vi.unstubAllEnvs() }
  })

  it('a GET-only provider facade rejects both mutation capabilities before calling the client', async () => {
    const f = await fixture()
    const readOnly = readOnlyMpClient(f.deps.mp)
    await expect(readOnly.cancelPreapproval(f.identity.preapproval_id)).rejects.toThrow('provider_mutation_forbidden')
    await expect(readOnly.createPendingPreapproval({ reason: 'forbidden fixture', externalReference: REFERENCE,
      payerEmail: 'fixture@invalid.test', backUrl: 'https://www.techrepairpro.app/subscription/pending',
      frequency: 1, frequencyType: 'months', amount: 15000, currency: 'ARS' })).rejects.toThrow('provider_mutation_forbidden')
    expect(f.mp.calls).toEqual([])
  })

  it.each([null, {}, { ...IDENTITY, extra: 'unexpected' }, { ...IDENTITY, payment_id: '' }, { ...IDENTITY, invoice_id: 'not/a/native/id' }])('rejects an invalid manifest %j', value => {
    expect(() => parsePlanACase(value)).toThrow('invalid_case_manifest')
  })
})

const rejectedProofs: [string, (f: Fixture) => void][] = [
  ['preapproval native ID', f => { f.pre.id = 'wrong-contract' }],
  ['plan native ID', f => { f.plan.id = 'wrong-plan' }],
  ['preapproval native plan link', f => { f.pre.preapproval_plan_id = 'wrong-plan' }],
  ['invoice native ID', f => { f.invoice.id = 'wrong-invoice' }],
  ['invoice contract link', f => { f.invoice.preapproval_id = 'wrong-contract' }],
  ['payment native ID', f => { f.payment.id = 'wrong-payment' }],
  ['invoice nested payment link', f => { f.invoice.payment = { id: 'wrong-payment', status: 'approved' } }],
  ['contradictory standalone payment link', f => { f.invoice.payment_id = 'wrong-payment' }],
  ['contract application', f => { f.pre.application_id = '999999' }],
  ['plan application', f => { f.plan.application_id = '999999' }],
  ['contract collector', f => { f.pre.collector_id = '999999' }],
  ['plan collector', f => { f.plan.collector_id = '999999' }],
  ['payment collector', f => { f.payment.collector_id = '999999' }],
  ['test-mode payment', f => { f.payment.live_mode = false }],
  ['missing live-mode flag', f => { delete f.payment.live_mode }],
  ['string live-mode flag', f => { f.payment.live_mode = 'true' }],
  ['contract amount', f => { f.pre.auto_recurring = { ...terms(), transaction_amount: 1 } }],
  ['template amount', f => { f.plan.auto_recurring = { ...terms(), transaction_amount: 1 } }],
  ['contract cycle', f => { f.pre.auto_recurring = { ...terms(), frequency: 12 } }],
  ['template currency', f => { f.plan.auto_recurring = { ...terms(), currency_id: 'USD' } }],
  ['invoice amount', f => { f.invoice.transaction_amount = 1 }],
  ['invoice currency', f => { f.invoice.currency_id = 'USD' }],
  ['payment amount', f => { f.payment.transaction_amount = 1 }],
  ['payment currency', f => { f.payment.currency_id = 'USD' }],
  ['missing approval date', f => { f.payment.date_approved = null }],
  ['invalid approval date', f => { f.payment.date_approved = 'not-an-instant' }],
  ['another approval day', f => { f.payment.date_approved = '2026-10-03T12:47:00.000Z' }],
  ['approval before contract creation', f => { f.payment.date_approved = '2026-10-02T12:44:00.000Z' }],
  ['contract created before reservation', f => { f.pre.date_created = '2026-10-02T12:44:00.000Z' }],
  ['template created after contract', f => { f.plan.date_created = APPROVED }],
  ['invoice created after approval', f => { f.invoice.date_created = NEXT }],
  ['payment created before contract', f => { f.payment.date_created = RESERVED }],
  ['future provider modification', f => { f.pre.last_modified = NEXT }],
  ['wrong renewal day', f => { f.pre.next_payment_date = '2026-11-03T12:47:00.000Z' }],
  ['unexpected external reference', f => { f.pre.external_reference = REFERENCE }],
  ['pending preapproval', f => { f.pre.status = 'pending' }],
  ['cancelled preapproval', f => { f.pre.status = 'cancelled' }],
  ['inactive template', f => { f.plan.status = 'inactive' }],
  ['scheduled invoice', f => { f.invoice.status = 'scheduled' }],
  ['nested payment not approved', f => { f.invoice.payment = { id: IDENTITY.payment_id, status: 'pending' } }],
  ...['pending', 'in_process', 'rejected', 'cancelled', 'refunded', 'charged_back'].map(status =>
    [`payment ${status}`, (f: Fixture) => { f.payment.status = status }] as [string, (f: Fixture) => void]),
  ['admin override reason', f => { f.business.override_reason = 'manual fixture' }],
  ['admin override operator', f => { f.business.override_created_by = OWNER_A }],
  ['admin override date', f => { f.business.override_created_at = RESERVED }],
  ['admin override expiry', f => { f.business.override_expires_at = NEXT }],
  ['unknown provider label', f => { f.business.subscription_provider = 'other-provider' }],
  ['existing subscription plan', f => { f.business.subscription_plan = 'basico' }],
  ['existing contract on business', f => { f.business.mp_preapproval_id = 'other-contract' }],
  ['existing payment authority', f => { f.business.last_payment_status = 'approved' }],
  ['session already linked', f => { f.session.mp_preapproval_id = IDENTITY.preapproval_id }],
  ['session already paid', f => { f.session.status = 'paid' }],
  ['different local plan', f => { f.session.plan_id = 'pro' }],
  ['different local amount', f => { f.session.amount = 25000 }],
  ['different reservation date', f => { f.session.created_at = '2026-10-03T12:45:00.000Z' }],
  ['another business bound to contract', f => { f.snapshot.boundBusinessId = BIZ_B }],
  ['another session bound to contract', f => { f.snapshot.boundSessionId = 'other-session' }],
  ['another checkout for business', f => { f.snapshot.otherSessionIds = ['other-session'] }],
  ['existing business ledger', f => { f.snapshot.businessPayments = [foreignLedger()] }],
  ['existing invoice ledger belongs to another business', f => { f.ledger.set(IDENTITY.invoice_id, foreignLedger()) }],
  ['existing payment ledger belongs to another invoice', f => { const row = foreignLedger(); row.external_payment_id = 'other-invoice'; f.ledger.set(row.external_payment_id, row) }],
  ['recovery already recorded', f => { f.snapshot.recoveryRecorded = true }],
]

describe('Plan A fails closed for contradictory native, commercial or local evidence', () => {
  it.each(rejectedProofs)('%s prevents a commit plan without changing persisted state', async (_label, mutate) => {
    const f = await fixture()
    mutate(f)
    const before = structuredClone(f.snapshot)
    const beforeLedger = structuredClone([...f.ledger])
    const report = await f.inspect()
    expect(report.eligible).toBe(false)
    expect(report.plan).toBeNull()
    expect(report.evidenceDigest).toBeNull()
    expect(report.blockers).toHaveLength(1)
    expect(f.snapshot).toEqual(before)
    expect([...f.ledger]).toEqual(beforeLedger)
    expect(f.mp.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it.each(['applicationId', 'collectorId'] as const)('requires a separately configured trusted %s', async key => {
    const f = await fixture()
    const report = await f.inspector(f.deps, f.identity, { ...TRUST, [key]: '' })
    expect(report.blockers).toEqual(['trusted_application_and_collector_configured'])
    expect(f.mp.calls).toEqual([])
    expect(f.snapshotLoads()).toBe(0)
  })

  it('blocks snapshot drift detected after provider verification', async () => {
    const f = await fixture()
    f.onSnapshotLoad(count => { if (count === 2) f.business.updated_at = NOW })
    const report = await f.inspect()
    expect(report.eligible).toBe(false)
    expect(report.blockers).toEqual(['local_snapshot_stable'])
    expect(report.plan).toBeNull()
    expect(f.ledger.size).toBe(0)
  })

  it('blocks a provider authorization/cancellation race on its final native reread', async () => {
    const f = await fixture()
    const fetch = f.mp.fetchImpl
    let contractReads = 0
    f.mp.fetchImpl = async (input, init) => {
      if (new URL(input).pathname === `/preapproval/${IDENTITY.preapproval_id}` && ++contractReads === 2) f.pre.status = 'cancelled'
      return fetch(input, init)
    }
    const report = await f.inspect()
    expect(report.eligible).toBe(false)
    expect(report.blockers).toEqual(['provider_evidence_stable'])
    expect(f.pre.status).toBe('cancelled')
    expect(f.mp.calls.every(call => call.method === 'GET')).toBe(true)
    expect(f.ledger.size).toBe(0)
  })

  it.each(['initial search', 'canonical search', 'final search'])('blocks a new rejected invoice appearing in %s', async stage => {
    const f = await fixture()
    const fetch = f.mp.fetchImpl
    let searches = 0
    f.mp.fetchImpl = async (input, init) => {
      if (new URL(input).pathname === '/authorized_payments/search') {
        searches++
        if (searches === ({ 'initial search': 1, 'canonical search': 2, 'final search': 3 }[stage])) {
          f.mp.authorizedPayments.set('new-rejected-invoice', { ...f.invoice, id: 'new-rejected-invoice', status: 'processed', payment: { id: 'new-rejected-payment', status: 'rejected' }, debit_date: NOW, date_created: NOW })
          f.mp.payments.set('new-rejected-payment', { ...f.payment, id: 'new-rejected-payment', status: 'rejected', date_approved: null, date_created: NOW })
        }
      }
      return fetch(input, init)
    }
    const report = await f.inspect()
    expect(report.eligible).toBe(false)
    expect(report.plan).toBeNull()
    expect(f.ledger.size).toBe(0)
    expect(f.mp.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it.each(['missing metadata', 'false total', 'short page', 'wrong offset', 'foreign invoice'])('blocks imperfect pagination: %s', async fault => {
    const f = await fixture()
    const fetch = f.mp.fetchImpl
    f.mp.fetchImpl = async (input, init) => {
      const response = await fetch(input, init)
      if (new URL(input).pathname !== '/authorized_payments/search') return response
      const body = await response.json()
      if (fault === 'missing metadata') delete body.paging
      if (fault === 'false total') body.paging.total = 0
      if (fault === 'short page') body.paging.total = 2
      if (fault === 'wrong offset') body.paging.offset = 1
      if (fault === 'foreign invoice') body.results[0].preapproval_id = 'other-contract'
      return new Response(JSON.stringify(body), { status: 200 })
    }
    const report = await f.inspect()
    expect(report.eligible).toBe(false)
    expect(report.plan).toBeNull()
    expect(f.ledger.size).toBe(0)
    expect(f.mp.calls.every(call => call.method === 'GET')).toBe(true)
  })
})

describe('exceptional recovery does not weaken ordinary Plan B identity', () => {
  it('a real approved legacy fixture without a server link cannot activate through webhook/reconcile', async () => {
    const w = new World()
    w.db.tables.subscription_checkout_sessions.push({ ...Object.fromEntries(PLAN_A_SESSION_KEYS.map(key => [key, null])),
      id: IDENTITY.session_id, business_id: BIZ_A, user_id: OWNER_A, plan_id: 'basico', billing_cycle: 'monthly', amount: 15000,
      currency: 'ARS', external_reference: REFERENCE, status: 'pending', created_at: RESERVED, updated_at: RESERVED,
      mp_preapproval_plan_id: IDENTITY.preapproval_plan_id })
    w.mp.seedForeignPreapproval(IDENTITY.preapproval_id, { preapproval_plan_id: IDENTITY.preapproval_plan_id, external_reference: '', auto_recurring: terms() })
    w.mp.approveFirstPayment(IDENTITY.preapproval_id)
    const before = w.snapshot(BIZ_A)
    const notify = await w.notify('subscription_preapproval', IDENTITY.preapproval_id)
    expect(notify.detail).toBe('not_applied:unknown_preapproval')
    const response = await w.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(response.body.activated).toBe(false)
    expect(w.db.tables.payments).toEqual([])
    expect(w.snapshot(BIZ_A)).toEqual(before)
    expect(w.mp.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('after a synthetic atomic recovery result, the second installment uses canonical IDs and remains idempotent', async () => {
    const f = await fixture()
    const report = await f.inspect()
    expect(report.eligible).toBe(true)
    const w = new World()
    const otherBusiness = w.snapshot(BIZ_B)
    // This is only the post-transaction fixture. Production writes belong to the
    // separately authorized atomic RPC, which is exercised by the SQL matrix.
    Object.assign(w.db.business(BIZ_A), f.business, {
      subscription_status: 'active', subscription_plan: 'basico', subscription_provider: 'mercadopago', access_source: 'mercado_pago',
      mp_preapproval_id: IDENTITY.preapproval_id, mp_preapproval_plan_id: IDENTITY.preapproval_plan_id,
      mp_last_modified: APPROVED, current_period_start: APPROVED, current_period_end: NEXT,
      last_payment_id: IDENTITY.payment_id, last_payment_status: 'approved',
    })
    w.db.tables.subscription_checkout_sessions.push({ ...f.session, mp_preapproval_id: IDENTITY.preapproval_id, status: 'paid', confirmed_at: NOW })
    w.db.tables.payments.push({ ...structuredClone(report.plan!.ledger), provider: 'mercadopago' })
    w.mp.preapprovals.set(IDENTITY.preapproval_id, structuredClone(f.pre))
    w.mp.authorizedPayments.set(IDENTITY.invoice_id, structuredClone(f.invoice))
    w.mp.payments.set(IDENTITY.payment_id, structuredClone(f.payment))
    w.advance(Date.parse(NEXT) - w.now().getTime())
    const secondInvoice = 'second-installment-fixture'
    const secondPayment = 'second-installment-payment-fixture'
    const secondAt = w.now().toISOString()
    const thirdDue = '2026-12-02T12:47:00.000Z'
    Object.assign(w.mp.preapprovals.get(IDENTITY.preapproval_id)!, { last_modified: secondAt, next_payment_date: thirdDue })
    w.mp.authorizedPayments.set(secondInvoice, { ...f.invoice, id: secondInvoice, date_created: secondAt, debit_date: secondAt,
      payment: { id: secondPayment, status: 'approved' } })
    w.mp.payments.set(secondPayment, { ...f.payment, id: secondPayment, date_created: secondAt, date_approved: secondAt })
    w.mp.calls.length = 0
    const firstNotification = await w.notify('subscription_authorized_payment', secondInvoice)
    expect(firstNotification.result).toBe('processed')
    expect(w.db.tables.payments).toHaveLength(2)
    expect(w.db.business(BIZ_A)).toMatchObject({ subscription_status: 'active', subscription_plan: 'basico',
      mp_preapproval_id: IDENTITY.preapproval_id, last_payment_id: secondPayment, last_payment_status: 'approved',
      current_period_start: secondAt, current_period_end: thirdDue })
    const recovered = w.snapshot(BIZ_A)
    await w.notify('subscription_authorized_payment', secondInvoice)
    await w.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(w.db.tables.payments).toHaveLength(2)
    expect(w.snapshot(BIZ_A)).toEqual(recovered)
    expect(w.snapshot(BIZ_B)).toEqual(otherBusiness)
    expect(w.mp.calls.every(call => call.method === 'GET')).toBe(true)

    w.mp.seedForeignPreapproval('unattested-contract-fixture', { preapproval_plan_id: IDENTITY.preapproval_plan_id,
      external_reference: '', auto_recurring: terms() })
    w.mp.approveFirstPayment('unattested-contract-fixture')
    const unknown = await w.notify('subscription_preapproval', 'unattested-contract-fixture')
    expect(unknown.detail).toBe('not_applied:unknown_preapproval')
    expect(w.db.tables.payments).toHaveLength(2)
    expect(w.snapshot(BIZ_A)).toEqual(recovered)
  })
})

describe('execution requires a fresh dry-run receipt and independent authorization before its committer', () => {
  const receipt: PlanAReceipt = { version: 1, mode: 'dry-run', caseFingerprint: PLAN_A_CASE_FINGERPRINT,
    evidenceDigest: 'a'.repeat(64), observedAt: '2026-10-16T11:59:00.000Z', sourceCommit: 'c'.repeat(40) }
  const approval: PlanAApproval = { caseFingerprint: receipt.caseFingerprint, evidenceDigest: receipt.evidenceDigest,
    dryRunObservedAt: receipt.observedAt, approvalRef: 'approval_fixture', operatorRef: 'operator_fixture',
    authorizedAt: '2026-10-16T11:59:30.000Z', action: 'execute-existing-paid-plan-a-once', sourceCommit: receipt.sourceCommit }

  it.each([
    ['wrong receipt mode', { ...receipt, mode: 'execute' }, approval, 'invalid_dry_run_receipt'],
    ['wrong fingerprint', { ...receipt, caseFingerprint: 'b'.repeat(64) }, approval, 'invalid_dry_run_receipt'],
    ['invalid digest', { ...receipt, evidenceDigest: 'not-a-digest' }, approval, 'invalid_dry_run_receipt'],
    ['different source commit', { ...receipt, sourceCommit: 'd'.repeat(40) }, approval, 'invalid_dry_run_receipt'],
    ['mixed receipt and approval', { ...receipt, ...approval }, approval, 'invalid_dry_run_receipt'],
    ['stale receipt', { ...receipt, observedAt: '2026-10-16T11:50:00.000Z' }, approval, 'expired_dry_run_receipt'],
    ['future receipt', { ...receipt, observedAt: NEXT }, approval, 'expired_dry_run_receipt'],
    ['wrong action', receipt, { ...approval, action: 'dry-run' }, 'independent_execution_approval_required'],
    ['wrong approved digest', receipt, { ...approval, evidenceDigest: 'b'.repeat(64) }, 'independent_execution_approval_required'],
    ['different approved commit', receipt, { ...approval, sourceCommit: 'd'.repeat(40) }, 'independent_execution_approval_required'],
    ['mixed approval and receipt', receipt, { ...approval, ...receipt }, 'independent_execution_approval_required'],
    ['approval before dry run', receipt, { ...approval, authorizedAt: receipt.observedAt }, 'independent_execution_approval_required'],
    ['missing approval reference', receipt, { ...approval, approvalRef: '' }, 'independent_execution_approval_required'],
    ['missing operator reference', receipt, { ...approval, operatorRef: '' }, 'independent_execution_approval_required'],
  ])('%s cannot call the committer or read commercial/provider data', async (_label, untrustedReceipt, untrustedApproval, blocker) => {
    const f = await fixture()
    const commit = vi.fn(async () => 'recovered' as const)
    await expect(executePlanARecovery(f.deps, f.identity, TRUST, untrustedReceipt as PlanAReceipt, untrustedApproval as PlanAApproval, commit)).rejects.toThrow(String(blocker))
    expect(commit).not.toHaveBeenCalled()
    expect(f.snapshotLoads()).toBe(0)
    expect(f.mp.calls).toEqual([])
  })

  it('a valid-looking receipt cannot bypass the pinned real-case fingerprint with synthetic identities', async () => {
    const f = await fixture()
    const commit = vi.fn(async () => 'recovered' as const)
    await expect(executePlanARecovery(f.deps, f.identity, TRUST, receipt, approval, commit)).rejects.toThrow('owner_attested_identity')
    expect(commit).not.toHaveBeenCalled()
    expect(f.snapshotLoads()).toBe(0)
    expect(f.mp.calls).toEqual([])
  })

  it('the compiled historical-application block prevents execution before reads even with an approved-looking receipt', async () => {
    const f = await fixture()
    const commit = vi.fn(async () => 'recovered' as const)
    const bytes = Uint8Array.from(PLAN_A_CASE_FINGERPRINT.match(/.{2}/g)!, hex => Number.parseInt(hex, 16))
    const digest = vi.spyOn(crypto.subtle, 'digest').mockResolvedValueOnce(bytes.buffer)
    try {
      await expect(executePlanARecovery(f.deps, f.identity, TRUST, receipt, approval, commit)).rejects.toThrow('historical_application_identity_unresolved')
      expect(commit).not.toHaveBeenCalled()
      expect(f.snapshotLoads()).toBe(0)
      expect(f.mp.calls).toEqual([])
    } finally { digest.mockRestore() }
  })
})
