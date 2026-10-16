// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMpClient, MpApiError } from '../../../supabase/functions/_shared/billing/mpClient.ts'
import { FAKE_MP_TOKEN } from './fakeMercadoPago.ts'
import { BIZ_A, BIZ_B, OWNER_A, World } from './harness.ts'

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

describe('authorized_payments search transport uses only supported pagination parameters', () => {
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

  it.each([
    ['missing paging', { results: [] }],
    ['missing results', { paging: { offset: 0, limit: 20, total: 0 } }],
    ['string total', { paging: { offset: 0, limit: 20, total: '1' }, results: [invoice('invoice_one')] }],
    ['fractional total', page(0, 20, 1.5)],
    ['negative total', page(0, 20, -1, [])],
    ['total above cap', page(0, 20, 101)],
    ['zero page size', page(0, 0, 0, [])],
    ['page size above cap', page(0, 101, 1)],
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
