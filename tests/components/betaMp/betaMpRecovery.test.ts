// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { BIZ_A, BIZ_B, HOUR, OWNER_A, World } from './harness.ts'
import { applyPreapprovalEvidence } from '../../../supabase/functions/_shared/billing/preapproval.ts'

let w: World
beforeEach(() => { w = new World() })
const reconcile = () => w.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
const invoice = (pre: string) => w.mp.authorizedPayments.get(`first_${pre}`)!
const payment = (pre: string) => w.mp.payments.get(`pay_first_${pre}`)!

describe('approved first payment is the commercial authority', () => {
  it('authorized alone preserves trial/access and never consumes or confirms the checkout', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    const before = w.snapshot(BIZ_A)
    w.mp.authorize(preapprovalId)
    const r = await reconcile()
    expect(r.body).toMatchObject({ activated: false, confirmed: false, outcome: 'pending', checkout: { status: 'pending', payment_confirmed: false } })
    expect(w.snapshot(BIZ_A)).toEqual(before)
    expect(w.db.tables.payments).toHaveLength(0)
    expect(w.sessionOf(preapprovalId).status).toBe('pending')
  })
  it('no webhook: recovers subscription → invoice → actual approved payment and the unique ledger', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    const otherTenant = w.snapshot(BIZ_B)
    w.mp.authorize(preapprovalId)
    w.mp.approveFirstPayment(preapprovalId)
    const r = await reconcile()
    expect(r.body).toMatchObject({ activated: true, confirmed: true, checkout: { status: 'paid', payment_confirmed: true } })
    expect(w.db.tables.payments).toHaveLength(1)
    expect(w.db.tables.payments[0]).toMatchObject({ business_id: BIZ_A, amount: 15000, currency: 'ARS', status: 'approved',
      raw_payload: { preapproval_id: preapprovalId, authorized_payment_id: `first_${preapprovalId}`, payment_id: `pay_first_${preapprovalId}` } })
    expect(w.snapshot(BIZ_B)).toEqual(otherTenant)
    const writes = w.db.writes.length
    await reconcile(); await reconcile()
    expect(w.db.writes.length).toBe(writes)
    await w.notify('subscription_authorized_payment', `first_${preapprovalId}`, 'notification-a')
    await w.notify('subscription_authorized_payment', `first_${preapprovalId}`, 'notification-a')
    expect(w.db.tables.payments).toHaveLength(1)
    expect(w.db.events('billing_state_applied')).toHaveLength(1)
  })
  it.each(['pending', 'in_process', 'rejected', 'refunded', 'charged_back'])('a %s payment cannot activate, even if invoice says processed', async status => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.pay(preapprovalId)
    payment(preapprovalId).status = status
    const r = await reconcile()
    expect(r.body.activated).toBe(false)
    expect(w.db.business(BIZ_A).subscription_status).toBe('trialing')
    expect(w.db.tables.payments[0].status).toBe(status)
  })
  it.each(['invoice_amount', 'invoice_currency', 'payment_amount', 'payment_currency', 'invoice_preapproval', 'payment_id', 'missing_approval_date'])('rejects inconsistent %s before activation or ledger writes', async fault => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.pay(preapprovalId)
    if (fault === 'invoice_amount') invoice(preapprovalId).transaction_amount = 1
    if (fault === 'invoice_currency') invoice(preapprovalId).currency_id = 'USD'
    if (fault === 'payment_amount') payment(preapprovalId).transaction_amount = 1
    if (fault === 'payment_currency') payment(preapprovalId).currency_id = 'USD'
    if (fault === 'invoice_preapproval') invoice(preapprovalId).preapproval_id = 'foreign'
    if (fault === 'payment_id') payment(preapprovalId).id = 'another-payment'
    if (fault === 'missing_approval_date') payment(preapprovalId).date_approved = null
    const r = await reconcile()
    expect(r.body.activated).not.toBe(true)
    expect(w.db.business(BIZ_A).subscription_status).toBe('trialing')
    expect(w.db.tables.payments).toHaveLength(0)
  })
  it('a persisted paid label without an approved ledger is not a payment confirmation', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.sessionOf(preapprovalId).status = 'paid'
    const r = await w.call(OWNER_A, { action: 'status', business_id: BIZ_A })
    expect(r.body.checkout).toMatchObject({ status: 'pending', payment_confirmed: false })
  })
  it('simultaneous recovery cannot duplicate the ledger or the activation', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.pay(preapprovalId)
    const results = await Promise.all([reconcile(), reconcile(), reconcile()])
    expect(results.every(r => r.status === 200 && r.body.activated === true)).toBe(true)
    expect(w.db.tables.payments).toHaveLength(1)
    expect(w.db.events('billing_state_applied')).toHaveLength(1)
  })
  it('an administrative access grant racing activation is preserved by the conditional write', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.pay(preapprovalId)
    const ctx = w.billingContext()
    const compare = ctx.store.compareBusinessBilling
    ctx.store.compareBusinessBilling = async (before, patch, now) => {
      Object.assign(w.db.business(BIZ_A), { access_source: 'admin_override', subscription_status: 'active', subscription_plan: 'full' })
      return compare(before, patch, now)
    }
    const result = await applyPreapprovalEvidence(ctx, w.mp.preapprovals.get(preapprovalId)!, { source: 'reconcile', expectBusinessId: BIZ_A })
    expect(result.reason).toBe('concurrent_change')
    expect(w.db.business(BIZ_A)).toMatchObject({ access_source: 'admin_override', subscription_plan: 'full', mp_preapproval_id: null })
    expect(w.sessionOf(preapprovalId).status).toBe('pending')
  })
  it('a legacy last_payment_status label cannot reactivate without approved payment evidence', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.mp.authorize(preapprovalId)
    Object.assign(w.db.business(BIZ_A), { mp_preapproval_id: preapprovalId, subscription_status: 'canceled',
      subscription_plan: 'basico', last_payment_status: 'approved' })
    await reconcile()
    expect(w.db.business(BIZ_A).subscription_status).toBe('canceled')
    expect(w.sessionOf(preapprovalId).status).toBe('pending')
  })
  it('an older subscription timestamp cannot discard actual invoice recovery or overwrite newer access', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'known')
    w.db.business(BIZ_A).mp_last_modified = '2026-10-02T12:00:00.000Z'
    w.db.tables.payments.length = 0 // lost historical ledger, without altering the provider fixture
    const before = w.snapshot(BIZ_A)
    await reconcile()
    expect(w.snapshot(BIZ_A)).toEqual(before)
    expect(w.db.tables.payments).toHaveLength(1)
    expect(w.db.tables.payments[0].status).toBe('approved')
  })
  it.each(['payment_id', 'authorized_payment_id'])('an approved ledger without %s cannot confirm a paid checkout', async field => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.pay(preapprovalId); await reconcile()
    delete w.db.tables.payments[0].raw_payload[field]
    const r = await w.call(OWNER_A, { action: 'status', business_id: BIZ_A })
    expect(r.body.checkout).toMatchObject({ status: 'pending', payment_confirmed: false })
  })
  it('failure between business activation and checkout settlement completes the original audit once', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.pay(preapprovalId)
    w.db.failOn = { table: 'subscription_checkout_sessions', op: 'update', code: 'XX000' }
    expect((await reconcile()).status).toBe(503)
    expect(w.db.business(BIZ_A).subscription_status).toBe('active')
    expect(w.sessionOf(preapprovalId).status).toBe('pending')
    expect(w.db.events('billing_state_applied')[0].processed).toBe(false)
    expect((await reconcile()).body.confirmed).toBe(true)
    await reconcile()
    expect(w.db.events('billing_state_applied')).toHaveLength(1)
    expect(w.db.events('billing_state_applied')[0].processed).toBe(true)
    expect(w.db.tables.payments).toHaveLength(1)
  })
  it('reads every invoice page and rejects the same payment under two invoices before writing', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.pay(preapprovalId)
    for (let n = 0; n < 20; n++) w.mp.authorizedPayments.set(`pending_${n}`, {
      id: `pending_${n}`, preapproval_id: preapprovalId, currency_id: 'ARS', transaction_amount: 15000, status: 'scheduled',
    })
    expect((await reconcile()).body.confirmed).toBe(true)
    expect(w.db.tables.payments).toHaveLength(21)
    expect(w.mp.calls.some(c => c.path.endsWith('offset=20&limit=20'))).toBe(true)
    const before = w.db.tables.payments.length
    w.mp.authorizedPayments.set('duplicate_invoice', { ...invoice(preapprovalId), id: 'duplicate_invoice' })
    const r = await reconcile()
    expect(r.body.outcome).toBe('mismatch')
    expect(w.db.tables.payments).toHaveLength(before)
  })
  it('a ledger row from another tenant cannot be reassociated or overwritten', async () => {
    const { preapprovalId } = await w.openCheckout(OWNER_A, BIZ_A, 'basico')
    w.pay(preapprovalId)
    await reconcile()
    w.db.tables.payments[0].business_id = BIZ_B // simulate inconsistent historical data; no heuristic repair
    const before = structuredClone(w.db.tables.payments)
    const r = await reconcile()
    expect(r.body.outcome).toBe('mismatch')
    expect(w.db.tables.payments).toEqual(before)
  })
  it('historical invoice of a replaced cancelled contract is booked to its original session without changing access', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'old')
    await w.openCheckout(OWNER_A, BIZ_A, 'pro', 'monthly', 'new')
    w.advance(HOUR); w.pay('new'); await reconcile()
    const before = w.snapshot(BIZ_A)
    const lateInvoice = { ...invoice('old'), id: 'late_old', payment: { id: 'late_old_payment' } }
    w.mp.authorizedPayments.set('late_old', lateInvoice)
    w.mp.payments.set('late_old_payment', { ...payment('old'), id: 'late_old_payment' })
    await w.notify('subscription_authorized_payment', 'late_old')
    expect(w.snapshot(BIZ_A)).toEqual(before)
    expect(w.db.tables.payments.find(p => p.external_payment_id === 'late_old')).toMatchObject({ business_id: BIZ_A, subscription_plan: 'basico', status: 'approved' })
  })
})

describe('confirmed cancellation and retryable plan replacement', () => {
  it.each(['cancelIsIgnored', 'cancelFails'] as const)('preserves the old plan on %s and finishes once cancellation is confirmed', async flag => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'old')
    await w.openCheckout(OWNER_A, BIZ_A, 'pro', 'monthly', 'new')
    w.advance(HOUR); w.pay('new'); w.mp[flag] = true
    const r = await reconcile()
    expect(r.body).toMatchObject({ outcome: 'replacement_pending', confirmed: false, checkout: { status: 'pending', payment_confirmed: true } })
    expect(w.db.business(BIZ_A)).toMatchObject({ mp_preapproval_id: 'old', subscription_plan: 'basico' })
    expect(w.mp.preapprovals.get('old')!.status).toBe('authorized')
    expect(w.db.events('preapproval_superseded')).toHaveLength(1)
    expect(w.db.events('preapproval_superseded')[0].processed).toBe(false)
    w.mp[flag] = false
    await reconcile(); await reconcile()
    expect(w.mp.preapprovals.get('old')!.status).toBe('cancelled')
    expect(w.db.business(BIZ_A)).toMatchObject({ mp_preapproval_id: 'new', subscription_plan: 'pro' })
    expect(w.db.events('preapproval_superseded')).toHaveLength(1)
    expect(w.db.events('preapproval_superseded')[0].processed).toBe(true)
  })
  it('failure after MP cancellation leaves a recoverable checkout, without a second successful cancellation', async () => {
    await w.subscribe(OWNER_A, BIZ_A, 'basico', 'old')
    await w.openCheckout(OWNER_A, BIZ_A, 'pro', 'monthly', 'new')
    w.advance(HOUR); w.pay('new')
    w.db.failOn = { table: 'businesses', op: 'update', code: 'XX000' }
    // Direct new-resource webhook exercises the failure after old cancellation.
    await expect(w.notify('subscription_preapproval', 'new')).rejects.toThrow()
    expect(w.mp.preapprovals.get('old')!.status).toBe('cancelled')
    expect(w.sessionOf('new').status).toBe('pending')
    await reconcile(); await reconcile()
    expect(w.db.business(BIZ_A).mp_preapproval_id).toBe('new')
    expect(w.mp.callsTo('PUT', '/preapproval/old')).toHaveLength(1)
    expect(w.db.tables.payments).toHaveLength(2)
  })
})
