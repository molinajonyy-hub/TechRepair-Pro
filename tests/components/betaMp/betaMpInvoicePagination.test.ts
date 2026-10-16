// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMpClient, MpApiError } from '../../../supabase/functions/_shared/billing/mpClient.ts'
import { FAKE_MP_TOKEN } from './fakeMercadoPago.ts'
import { BIZ_A, BIZ_B, DAY, HOUR, OWNER_A, OWNER_B, World } from './harness.ts'

const PREAPPROVAL = 'pre_pagination_fixture'
const invoice = (id: string | number) => ({ id, preapproval_id: PREAPPROVAL })
const page = (offset = 0, limit = 20, total = 1, results: unknown[] = [invoice('invoice_one')]) => ({
  paging: { offset, limit, total }, results,
})

function clientFor(body: unknown, status = 200) {
  const requests: URL[] = []
  const client = createMpClient({
    accessToken: () => FAKE_MP_TOKEN,
    fetchImpl: async input => {
      requests.push(new URL(input))
      return new Response(JSON.stringify(body), { status })
    },
  })
  return { client, requests }
}

describe('authorized_payments search transport omits an explicit limit and follows provider metadata', () => {
  it('first page sends only the server-known subscription filter, even with a legacy limit argument', async () => {
    const { client, requests } = clientFor(page())
    await expect(client.listAuthorizedPayments(PREAPPROVAL, 0, 20)).resolves.toMatchObject(page())
    expect(requests.map(u => u.pathname + u.search)).toEqual([
      `/authorized_payments/search?preapproval_id=${PREAPPROVAL}`,
    ])
  })

  it('subsequent pages send offset without limit and accept the provider page size', async () => {
    const results = [invoice('invoice_four'), invoice('invoice_five')]
    const { client, requests } = clientFor(page(3, 3, 5, results))
    await expect(client.listAuthorizedPayments(PREAPPROVAL, 3, 20)).resolves.toMatchObject(page(3, 3, 5, results))
    expect(requests[0].search).toBe(`?preapproval_id=${PREAPPROVAL}&offset=3`)
    expect(requests[0].searchParams.has('limit')).toBe(false)
  })

  it('accepts an empty complete result only with explicit valid metadata', async () => {
    const { client } = clientFor(page(0, 20, 0, []))
    await expect(client.listAuthorizedPayments(PREAPPROVAL, 0, 20)).resolves.toMatchObject({ results: [] })
  })

  it('accepts a provider default page size above the history cap when its declared result set is complete and bounded', async () => {
    const response = page(0, 500, 1, [invoice(810001)])
    const { client } = clientFor(response)
    await expect(client.listAuthorizedPayments(PREAPPROVAL, 0, 20)).resolves.toMatchObject(response)
  })

  it.each([
    ['missing paging', { results: [] }],
    ['missing results', { paging: { offset: 0, limit: 20, total: 0 } }],
    ['string total', { paging: { offset: 0, limit: 20, total: '1' }, results: [invoice('invoice_one')] }],
    ['fractional total', page(0, 20, 1.5)],
    ['negative total', page(0, 20, -1, [])],
    ['total above cap', page(0, 20, 101)],
    ['zero page size', page(0, 0, 0, [])],
    ['unsafe page size', page(0, Number.MAX_SAFE_INTEGER + 1, 1)],
    ['string page size', { paging: { offset: 0, limit: '20', total: 1 }, results: [invoice('invoice_one')] }],
    ['history exceeds cap despite larger provider page size', page(0, 500, 101, Array.from({ length: 101 }, (_, index) => invoice(810001 + index)))],
    ['fractional page size', page(0, 1.5, 1)],
    ['wrong offset', page(1, 20, 1, [])],
    ['short non-final page', page(0, 2, 3)],
    ['too many rows for total', page(0, 20, 0)],
    ['too many rows for page size', page(0, 1, 2, [invoice('one'), invoice('two')])],
    ['missing invoice identity', page(0, 20, 1, [{}])],
    ['null invoice', page(0, 20, 1, [null])],
    ['foreign invoice', page(0, 20, 1, [{ id: 'invoice_one', preapproval_id: 'pre_other_fixture' }])],
    ['empty invoice id', page(0, 20, 1, [invoice('')])],
    ['object invoice id', page(0, 20, 1, [{ id: {}, preapproval_id: PREAPPROVAL }])],
    ['unsafe numeric invoice id', page(0, 20, 1, [invoice(Number.MAX_SAFE_INTEGER + 1)])],
    ['duplicate identity in page', page(0, 20, 2, [invoice('same'), invoice('same')])],
    ['same numeric and string identity', page(0, 20, 2, [invoice(10), invoice('10')])],
  ])('rejects %s without treating a prefix as complete', async (_label, response) => {
    const { client } = clientFor(response)
    await expect(client.listAuthorizedPayments(PREAPPROVAL, 0, 20)).rejects.toBeInstanceOf(MpApiError)
  })

  it.each([-1, 0.5, 100, Number.NaN])('rejects invalid request offset %s before contacting MP', async offset => {
    const { client, requests } = clientFor(page())
    await expect(client.listAuthorizedPayments(PREAPPROVAL, offset, 20)).rejects.toBeInstanceOf(MpApiError)
    expect(requests).toEqual([])
  })
})

function seedInstallment(world: World, preapprovalId: string, id: string, status: 'approved' | 'rejected') {
  const at = world.now().toISOString()
  const paymentId = `pay_${id}`
  world.mp.authorizedPayments.set(id, { id, preapproval_id: preapprovalId, status: 'processed',
    transaction_amount: 25000, currency_id: 'ARS', date_created: at, debit_date: at,
    payment: { id: paymentId, status } })
  world.mp.payments.set(paymentId, { id: paymentId, status, transaction_amount: 25000,
    currency_id: 'ARS', date_created: at, date_approved: status === 'approved' ? at : null })
  return { id, paymentId, at }
}

function orderInvoices(world: World, ids: string[]) {
  const rows = new Map(world.mp.authorizedPayments)
  expect(ids).toHaveLength(rows.size)
  world.mp.authorizedPayments.clear()
  for (const id of ids) world.mp.authorizedPayments.set(id, rows.get(id)!)
}

function commercialState(world: World, businessId = BIZ_A) {
  const { updated_at: _updated, last_webhook_at: _webhook, ...state } = world.snapshot(businessId)
  return state
}

describe('pagination preserves payment chronology independently of result ordering', () => {
  it.each(['approved', 'rejected'] as const)('the newest %s on the first page outranks an older opposite status on the final page', async newestStatus => {
    const world = new World()
    const preapprovalId = 'pre_chronology_fixture'
    await world.subscribe(OWNER_A, BIZ_A, 'pro', preapprovalId)
    const otherBusiness = world.snapshot(BIZ_B)
    world.advance(HOUR)
    const middle = seedInstallment(world, preapprovalId, 'middle_approved_fixture', 'approved')
    world.advance(HOUR)
    const opposite = seedInstallment(world, preapprovalId, 'older_opposite_fixture', newestStatus === 'approved' ? 'rejected' : 'approved')
    world.advance(HOUR)
    const newest = seedInstallment(world, preapprovalId, 'newest_installment_fixture', newestStatus)
    Object.assign(world.mp.preapprovals.get(preapprovalId)!, { last_modified: newest.at,
      next_payment_date: new Date(world.now().getTime() + 30 * DAY).toISOString() })
    orderInvoices(world, [newest.id, `first_${preapprovalId}`, middle.id, opposite.id])
    world.mp.invoicePageSize = 2
    world.mp.calls.length = 0
    const response = await world.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(response.status).toBe(200)
    expect(world.db.business(BIZ_A)).toMatchObject({ subscription_status: newestStatus === 'approved' ? 'active' : 'past_due',
      last_payment_status: newestStatus, last_payment_id: newest.paymentId, mp_preapproval_id: preapprovalId })
    expect(world.db.tables.payments).toHaveLength(4)
    expect(world.db.tables.payments.every(row => row.business_id === BIZ_A && (row.raw_payload as Record<string, unknown>).preapproval_id === preapprovalId)).toBe(true)
    expect(world.mp.calls.filter(call => call.path.startsWith('/authorized_payments/search')).map(call => call.path)).toEqual([
      `/authorized_payments/search?preapproval_id=${preapprovalId}`,
      `/authorized_payments/search?preapproval_id=${preapprovalId}&offset=2`,
    ])
    const state = commercialState(world)
    const ledgerWrites = world.db.writesTo('payments').length
    await world.notify('subscription_authorized_payment', opposite.id)
    await world.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(commercialState(world)).toEqual(state)
    expect(world.db.tables.payments).toHaveLength(4)
    expect(world.db.writesTo('payments')).toHaveLength(ledgerWrites)
    expect(world.snapshot(BIZ_B)).toEqual(otherBusiness)
    expect(world.mp.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it.each([false, true])('a temporal tie across pages cannot prefer approval over rejection, rejectedFirst=%s', async rejectedFirst => {
    const world = new World()
    const preapprovalId = 'pre_tie_fixture'
    await world.subscribe(OWNER_A, BIZ_A, 'pro', preapprovalId)
    world.advance(HOUR)
    const approved = seedInstallment(world, preapprovalId, 'equal_time_approval_fixture', 'approved')
    const rejected = seedInstallment(world, preapprovalId, 'equal_time_rejection_fixture', 'rejected')
    orderInvoices(world, rejectedFirst ? [rejected.id, `first_${preapprovalId}`, approved.id]
      : [approved.id, `first_${preapprovalId}`, rejected.id])
    world.mp.invoicePageSize = 1
    world.mp.calls.length = 0
    const response = await world.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(response.status).toBe(200)
    expect(world.db.business(BIZ_A)).toMatchObject({ subscription_status: 'past_due', last_payment_id: rejected.paymentId,
      last_payment_status: 'rejected' })
    expect(world.db.tables.payments).toHaveLength(3)
    expect(world.mp.calls.filter(call => call.path.startsWith('/authorized_payments/search'))).toHaveLength(3)
    expect(world.mp.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('a later-page failure after an approved first page writes nothing; a healthy manual retry converges once', async () => {
    const { world, preapprovalId, session } = await worldWithInvoices(7)
    const before = commercialState(world)
    const otherBusiness = world.snapshot(BIZ_B)
    const fetch = world.mp.fetchImpl
    world.mp.fetchImpl = async (input, init) => {
      const response = await fetch(input, init)
      const url = new URL(input)
      return url.pathname === '/authorized_payments/search' && url.searchParams.get('offset') === '3'
        ? new Response(JSON.stringify({ message: 'temporary pagination failure' }), { status: 503 }) : response
    }
    const failed = await world.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(failed.status).toBe(502)
    expect(commercialState(world)).toEqual(before)
    expect(session.status).toBe('pending')
    expect(world.db.tables.payments).toEqual([])
    expect(world.db.writes).toEqual([])
    expect(world.mp.callsTo('GET', '/v1/payments/')).toEqual([])

    world.mp.fetchImpl = fetch
    const retried = await world.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(retried.status).toBe(200)
    expect(retried.body.confirmed).toBe(true)
    expect(session.status).toBe('paid')
    expect(world.db.tables.payments).toHaveLength(7)
    const paidState = commercialState(world)
    const ledgerWrites = world.db.writesTo('payments').length
    await world.notify('subscription_authorized_payment', `first_${preapprovalId}`)
    await world.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(commercialState(world)).toEqual(paidState)
    expect(world.db.tables.payments).toHaveLength(7)
    expect(world.db.writesTo('payments')).toHaveLength(ledgerWrites)
    expect(new Set(world.db.tables.payments.map(row => row.external_payment_id)).size).toBe(7)
    expect(world.snapshot(BIZ_B)).toEqual(otherBusiness)
    expect(world.mp.calls.every(call => call.method === 'GET')).toBe(true)
  })
})

describe('pagination keeps the server-issued identity despite identical commercial terms', () => {
  it.each([false, true])('same payer, amount and chronology across A/B remain isolated, foreignRowInjected=%s', async foreignRowInjected => {
    const world = new World()
    for (const [owner, businessId, id] of [[OWNER_A, BIZ_A, 'pre_same_terms_a_fixture'], [OWNER_B, BIZ_B, 'pre_same_terms_b_fixture']]) {
      world.mp.nextIds.push(id)
      const created = await world.call(owner, { action: 'create', business_id: businessId, plan: 'pro', billing_cycle: 'monthly',
        mp_payer_email: 'shared-payer@invalid.test' })
      expect(created.status).toBe(200)
      world.pay(id)
    }
    const preA = 'pre_same_terms_a_fixture'
    const preB = 'pre_same_terms_b_fixture'
    seedInstallment(world, preA, 'same_terms_a_second_fixture', 'approved')
    seedInstallment(world, preA, 'same_terms_a_third_fixture', 'approved')
    await world.notify('subscription_preapproval', preB)
    const beforeA = world.snapshot(BIZ_A)
    const beforeB = world.snapshot(BIZ_B)
    const beforeLedger = structuredClone(world.db.tables.payments)
    world.mp.invoicePageSize = 2
    world.mp.calls.length = 0
    world.db.writes.length = 0
    if (foreignRowInjected) {
      const fetch = world.mp.fetchImpl
      world.mp.fetchImpl = async (input, init) => {
        const response = await fetch(input, init)
        const url = new URL(input)
        if (url.pathname !== '/authorized_payments/search' || url.searchParams.get('preapproval_id') !== preA
          || url.searchParams.get('offset') !== '2') return response
        const body = await response.json()
        body.results[0] = world.mp.authorizedPayments.get(`first_${preB}`)
        return new Response(JSON.stringify(body), { status: 200 })
      }
    }
    const response = await world.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(response.status).toBe(foreignRowInjected ? 502 : 200)
    expect(world.snapshot(BIZ_B)).toEqual(beforeB)
    if (foreignRowInjected) {
      expect(world.snapshot(BIZ_A)).toEqual(beforeA)
      expect(world.db.tables.payments).toEqual(beforeLedger)
      expect(world.db.writes).toEqual([])
      expect(world.mp.callsTo('GET', '/v1/payments/')).toEqual([])
    } else {
      expect(world.db.business(BIZ_A)).toMatchObject({ subscription_status: 'active', mp_preapproval_id: preA })
      expect(world.db.tables.payments.filter(row => row.business_id === BIZ_A)).toHaveLength(3)
      expect(world.db.tables.payments.filter(row => row.business_id === BIZ_B)).toEqual(beforeLedger)
    }
    expect(world.mp.calls.some(call => call.path === `/preapproval/${preB}` || call.path === `/authorized_payments/first_${preB}`)).toBe(false)
    expect(world.mp.calls.every(call => call.method === 'GET')).toBe(true)
  })
})

describe('documented provider response shapes remain compatible without coercing identity', () => {
  it.each(['numbers', 'strings', 'mixed'] as const)('safe native IDs as %s and decimal-string amounts still require the real payment approval', async idShape => {
    const world = new World()
    const { preapprovalId } = await world.openCheckout(OWNER_A, BIZ_A, 'pro')
    world.mp.invoicePageSize = 500
    world.mp.authorize(preapprovalId)
    world.mp.preapprovals.get(preapprovalId)!.auto_recurring = { frequency: 1, frequency_type: 'months', transaction_amount: '25000.00', currency_id: 'ARS' }
    const invoiceId = idShape === 'strings' ? '810001' : 810001
    const paymentId = idShape === 'numbers' ? 820001 : '820001'
    const at = world.now().toISOString()
    // API examples use numeric IDs and decimal-string amounts; SDK types also
    // allow string IDs. All identifiers here are synthetic, never live samples.
    world.mp.authorizedPayments.set(String(invoiceId), { id: invoiceId, preapproval_id: preapprovalId,
      status: 'scheduled', summarized: 'pending', transaction_amount: '25000.00', currency_id: 'ARS',
      date_created: at, debit_date: at, payment: { id: paymentId, status: 'approved' } })
    world.mp.payments.set(String(paymentId), { id: paymentId, status: 'approved', status_detail: 'accredited',
      transaction_amount: '25000.00', currency_id: 'ARS', date_created: at, date_approved: at })
    world.mp.calls.length = 0
    const response = await world.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(response.status).toBe(200)
    expect(response.body.confirmed).toBe(true)
    expect(world.db.tables.payments).toHaveLength(1)
    expect(world.db.tables.payments[0]).toMatchObject({ external_payment_id: String(invoiceId), amount: 25000, status: 'approved',
      raw_payload: { authorized_payment_id: String(invoiceId), payment_id: String(paymentId), preapproval_id: preapprovalId } })
    expect(world.mp.calls.some(call => call.path === `/authorized_payments/${invoiceId}`)).toBe(true)
    expect(world.mp.calls.some(call => call.path === `/v1/payments/${paymentId}`)).toBe(true)
    expect(world.mp.calls.every(call => call.method === 'GET')).toBe(true)
  })
})

async function worldWithInvoices(count: number, pageSize = 3) {
  const world = new World()
  const { preapprovalId, session } = await world.openCheckout(OWNER_A, BIZ_A, 'pro')
  world.pay(preapprovalId)
  const firstInvoice = world.mp.authorizedPayments.get(`first_${preapprovalId}`)!
  const firstPayment = world.mp.payments.get(`pay_first_${preapprovalId}`)!
  for (let i = 1; i < count; i++) {
    const id = `pagination_invoice_${i}`
    const paymentId = `pagination_payment_${i}`
    world.mp.authorizedPayments.set(id, { ...firstInvoice, id, payment: { id: paymentId, status: 'approved' } })
    world.mp.payments.set(paymentId, { ...firstPayment, id: paymentId })
  }
  world.mp.invoicePageSize = pageSize
  world.mp.calls.length = 0
  world.db.writes.length = 0
  return { world, preapprovalId, session }
}

describe('invoice recovery validates every declared page before ledger writes', () => {
  it('follows the provider page size rather than assuming 20 and rereads all invoices/payments by ID', async () => {
    const { world, preapprovalId } = await worldWithInvoices(8)
    const otherBusiness = world.snapshot(BIZ_B)
    const response = await world.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(response.status).toBe(200)
    expect(response.body.activated).toBe(true)
    expect(world.mp.calls.filter(c => c.path.startsWith('/authorized_payments/search')).map(c => c.path)).toEqual([
      `/authorized_payments/search?preapproval_id=${preapprovalId}`,
      `/authorized_payments/search?preapproval_id=${preapprovalId}&offset=3`,
      `/authorized_payments/search?preapproval_id=${preapprovalId}&offset=6`,
    ])
    expect(world.db.tables.payments).toHaveLength(8)
    expect(world.mp.callsTo('GET', '/authorized_payments/').filter(c => !c.path.includes('/search'))).toHaveLength(8)
    expect(world.mp.callsTo('GET', '/v1/payments/')).toHaveLength(8)
    expect(world.snapshot(BIZ_B)).toEqual(otherBusiness)
  })

  it('accepts exactly the bounded 100 invoices with the provider page size', async () => {
    const { world } = await worldWithInvoices(100, 7)
    const response = await world.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(response.status).toBe(200)
    expect(response.body.activated).toBe(true)
    expect(world.db.tables.payments).toHaveLength(100)
    expect(world.mp.calls.filter(c => c.path.startsWith('/authorized_payments/search'))).toHaveLength(15)
  })

  it.each([
    'missing metadata', 'short page', 'changed total', 'changed page size', 'ignored offset',
    'duplicate across pages', 'foreign invoice', 'second page 400', 'second page 503',
  ])('%s blocks access and leaves the ledger empty, including on retry', async fault => {
    const { world, session } = await worldWithInvoices(7)
    const originalFetch = world.mp.fetchImpl
    world.mp.fetchImpl = async (input, init) => {
      const response = await originalFetch(input, init)
      const url = new URL(input)
      if (url.pathname !== '/authorized_payments/search' || url.searchParams.get('offset') !== '3') return response
      if (fault === 'second page 400' || fault === 'second page 503') {
        return new Response(JSON.stringify({ message: 'pagination unavailable' }), { status: fault.endsWith('400') ? 400 : 503 })
      }
      const body = await response.json()
      if (fault === 'missing metadata') delete body.paging
      if (fault === 'short page') body.results.pop()
      if (fault === 'changed total') body.paging.total++
      if (fault === 'changed page size') { body.paging.limit = 4; body.results.push({ ...body.results[0], id: 'extra_invoice' }) }
      if (fault === 'ignored offset') body.paging.offset = 0
      if (fault === 'duplicate across pages') body.results[0].id = [...world.mp.authorizedPayments.keys()][0]
      if (fault === 'foreign invoice') body.results[0].preapproval_id = 'pre_other_fixture'
      return new Response(JSON.stringify(body), { status: 200 })
    }
    const before = world.snapshot(BIZ_A)
    const otherBusiness = world.snapshot(BIZ_B)
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await world.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
      expect(response.status).toBe(502)
      expect(response.body.activated).not.toBe(true)
      expect(world.snapshot(BIZ_A)).toEqual(before)
      expect(world.snapshot(BIZ_B)).toEqual(otherBusiness)
      expect(session.status).toBe('pending')
      expect(world.db.tables.payments).toEqual([])
      expect(world.db.writes).toEqual([])
      expect(world.mp.calls.every(c => c.method === 'GET')).toBe(true)
      expect(world.mp.callsTo('GET', '/v1/payments/')).toEqual([])
    }
  })

  it('rejects a provider total above 100 before reading invoices or writing any payment', async () => {
    const { world, session } = await worldWithInvoices(101)
    const before = world.snapshot(BIZ_A)
    const response = await world.call(OWNER_A, { action: 'reconcile', business_id: BIZ_A })
    expect(response.status).toBe(502)
    expect(world.snapshot(BIZ_A)).toEqual(before)
    expect(session.status).toBe('pending')
    expect(world.db.tables.payments).toEqual([])
    expect(world.db.writes).toEqual([])
    expect(world.mp.callsTo('GET', '/v1/payments/')).toEqual([])
  })
})
