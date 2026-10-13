/** Shared ledger recovery. IDs identify resources; amounts and dates never identify tenants. */
import { MpApiError, ledgerPaymentStatus } from './mpClient.ts'
import type { MpAuthorizedPayment, MpPreapproval } from './mpClient.ts'
import type { BillingContext } from './preapproval.ts'
import type { CheckoutSessionRow, PaymentLedgerRow } from './store.ts'

export interface VerifiedInvoice {
  row: PaymentLedgerRow
  chargedAt: string | null
  paymentId: string | null
}
export type PaymentEvidenceProblem = 'payment_link_mismatch' | 'payment_terms_mismatch' | 'payment_missing_approval_date' | 'payment_missing_event_date'
export interface RecoveredPayments { invoices: VerifiedInvoice[]; problem: PaymentEvidenceProblem | null }
export interface PaymentRecoveryOptions {
  /** Historical ledger only; never use a single invoice to decide access. */
  onlyInvoiceId?: string
  /** Include the notified resource even if subscription search has not indexed it yet. */
  notifiedInvoiceId?: string
  /** Server-stored payment identity is a lookup hint; its invoice/payment are reread in MP. */
  knownPaymentId?: string
}

const DEFINITE_PAYMENT_STATES = ['approved', 'rejected', 'cancelled', 'refunded', 'charged_back']
function compareEvidence(a: VerifiedInvoice, b: VerifiedInvoice): number {
  const chronology = (a.chargedAt ?? '').localeCompare(b.chargedAt ?? '')
  if (chronology) return chronology
  // At an equal instant, approval cannot outrank a rejection, refund or chargeback.
  const priority = (i: VerifiedInvoice) => i.row.status === 'rejected' ? 3
    : ['refunded', 'charged_back'].includes(i.row.status) ? 2 : ['approved', 'cancelled'].includes(i.row.status) ? 1 : 0
  return priority(a) - priority(b)
}

export function latestPaymentEvidence(invoices: VerifiedInvoice[], periodStart: string | null = null): VerifiedInvoice | undefined {
  return [...invoices].sort(compareEvidence).reverse().find(i => i.paymentId
    && DEFINITE_PAYMENT_STATES.includes(i.row.status) && i.chargedAt
    && (!periodStart || Date.parse(i.chargedAt) >= Date.parse(periodStart)))
}

function instant(value: unknown): string | null {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}
function cents(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+(\.\d{1,2})?$/.test(String(value))) return null
  const amount = Math.round(Number(value) * 100)
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null
}

/** Local proof produced by canonical recovery, never a paid/session/status label alone. */
export function approvedLedgerMatchesSession(row: PaymentLedgerRow | null, session: CheckoutSessionRow): boolean {
  return row !== null && row.status === 'approved' && row.business_id === session.business_id
    && typeof session.mp_preapproval_id === 'string' && session.mp_preapproval_id.length > 0
    && row.raw_payload.preapproval_id === session.mp_preapproval_id
    && typeof row.external_payment_id === 'string' && row.external_payment_id.length > 0
    && row.raw_payload.authorized_payment_id === row.external_payment_id
    && typeof row.raw_payload.payment_id === 'string' && row.raw_payload.payment_id.length > 0
    && cents(row.amount) !== null && cents(row.amount) === cents(session.amount) && row.currency === session.currency
    && row.subscription_plan === session.plan_id && instant(row.paid_at) !== null
}

/** Read every page before writing. An incomplete/contradictory response fails closed. */
async function invoiceIds(ctx: BillingContext, preapprovalId: string): Promise<string[]> {
  const ids = new Set<string>()
  const limit = 20
  let total: number | null = null
  for (let offset = 0; offset < 100; offset += limit) {
    const page = await ctx.mp.listAuthorizedPayments(preapprovalId, offset, limit)
    if (total !== null && total !== page.paging.total) throw new MpApiError('GET authorized_payments (changing pagination)', 502)
    total = page.paging.total
    for (const candidate of page.results) {
      if (candidate.preapproval_id !== preapprovalId || candidate.id === null || candidate.id === undefined) {
        throw new MpApiError('GET authorized_payments (foreign invoice)', 502)
      }
      const id = String(candidate.id)
      if (!id || ids.has(id)) throw new MpApiError('GET authorized_payments (duplicate invoice)', 502)
      ids.add(id)
    }
    if (offset + page.results.length >= total) return [...ids]
    if (page.results.length !== limit) throw new MpApiError('GET authorized_payments (incomplete page)', 502)
  }
  throw new MpApiError('GET authorized_payments (recovery limit exceeded)', 502)
}

async function verifyInvoice(
  ctx: BillingContext, id: string, pre: MpPreapproval, session: CheckoutSessionRow,
): Promise<VerifiedInvoice | PaymentEvidenceProblem> {
  const invoice: MpAuthorizedPayment | null = await ctx.mp.getAuthorizedPayment(id)
  if (!invoice) throw new MpApiError('GET authorized_payment', 404)
  if (String(invoice.id) !== id || invoice.preapproval_id !== pre.id) return 'payment_link_mismatch'
  const expected = cents(session.amount)
  if (expected === null || cents(invoice.transaction_amount) !== expected || invoice.currency_id !== session.currency) return 'payment_terms_mismatch'
  const nested = invoice.payment?.id
  const standalone = invoice.payment_id
  if (nested != null && standalone != null && String(nested) !== String(standalone)) return 'payment_link_mismatch'
  const paymentId = nested ?? standalone ?? null
  const payment = paymentId === null ? null : await ctx.mp.getPayment(String(paymentId))
  if (paymentId !== null && !payment) throw new MpApiError('GET payment', 404)
  if (payment && (String(payment.id) !== String(paymentId)
    || cents(payment.transaction_amount) !== expected || payment.currency_id !== session.currency)) return 'payment_terms_mismatch'
  const status = payment ? ledgerPaymentStatus(payment.status)
    : (invoice.status === 'cancelled' ? 'cancelled' : 'pending')
  const paidAt = instant(payment?.date_approved)
  if (status === 'approved' && !paidAt) return 'payment_missing_approval_date'
  return {
    paymentId: paymentId === null ? null : String(paymentId),
    chargedAt: paidAt ?? instant(payment?.date_created) ?? instant(invoice.debit_date) ?? instant(invoice.date_created),
    row: {
      business_id: session.business_id, external_payment_id: id, type: 'recurring',
      amount: expected / 100, currency: session.currency, status,
      subscription_plan: session.plan_id, paid_at: paidAt,
      raw_payload: {
        authorized_payment_id: id, preapproval_id: pre.id,
        payment_id: paymentId === null ? null : String(paymentId),
        invoice_status: invoice.status ?? null, payment_status: payment?.status ?? null,
        payment_status_detail: payment?.status_detail ?? null, debit_date: invoice.debit_date ?? null,
      },
    },
  }
}

/** Only called after the canonical path has validated this server-issued session. */
export async function recoverPayments(
  ctx: BillingContext, pre: MpPreapproval, session: CheckoutSessionRow, options: PaymentRecoveryOptions = {},
): Promise<RecoveredPayments> {
  const ids = options.onlyInvoiceId ? [options.onlyInvoiceId] : await invoiceIds(ctx, pre.id)
  if (options.notifiedInvoiceId && !ids.includes(options.notifiedInvoiceId)) ids.push(options.notifiedInvoiceId)
  if (options.knownPaymentId) {
    const known = await ctx.store.getPaymentByPaymentId(options.knownPaymentId)
      ?? await ctx.store.getPaymentByInvoiceId(options.knownPaymentId)
    if (known) {
      if (known.business_id !== session.business_id || known.raw_payload.preapproval_id !== pre.id
        || known.raw_payload.authorized_payment_id !== known.external_payment_id) {
        return { invoices: [], problem: 'payment_link_mismatch' }
      }
      if (!ids.includes(known.external_payment_id)) ids.push(known.external_payment_id)
    }
  }
  const invoices: VerifiedInvoice[] = []
  const paymentIds = new Set<string>()
  for (const id of ids) {
    const verified = await verifyInvoice(ctx, id, pre, session)
    if (typeof verified === 'string') {
      ctx.log({ event: verified, preapproval_id: pre.id, authorized_payment_id: id })
      return { invoices: [], problem: verified }
    }
    if (verified.paymentId && paymentIds.has(verified.paymentId)) return { invoices: [], problem: 'payment_link_mismatch' }
    if (verified.paymentId) paymentIds.add(verified.paymentId)
    invoices.push(verified)
  }
  if (options.knownPaymentId && !invoices.some(i => i.paymentId === options.knownPaymentId
    || i.row.external_payment_id === options.knownPaymentId)) {
    return { invoices: [], problem: 'payment_link_mismatch' }
  }
  if (!options.onlyInvoiceId && invoices.some(i => i.paymentId
    && DEFINITE_PAYMENT_STATES.includes(i.row.status) && !i.chargedAt)) {
    return { invoices: [], problem: 'payment_missing_event_date' }
  }
  // Validate all evidence before persisting any of it. Same invoice/payment cannot migrate tenants.
  for (const invoice of invoices) {
    const row = invoice.row
    const existing = await ctx.store.getPaymentByInvoiceId(row.external_payment_id)
    if (existing && (existing.business_id !== row.business_id
      || existing.raw_payload.preapproval_id !== pre.id
      || (existing.raw_payload.payment_id != null && existing.raw_payload.payment_id !== invoice.paymentId))) {
      return { invoices: [], problem: 'payment_link_mismatch' }
    }
    if (invoice.paymentId) {
      const other = await ctx.store.getPaymentByPaymentId(invoice.paymentId)
      if (other && other.external_payment_id !== row.external_payment_id) return { invoices: [], problem: 'payment_link_mismatch' }
    }
  }
  for (const invoice of invoices) {
    const existing = await ctx.store.getPaymentByInvoiceId(invoice.row.external_payment_id)
    const unchanged = existing && Object.entries(invoice.row).every(([key, value]) => {
      if (key === 'paid_at') return instant(existing.paid_at) === value
      if (key === 'raw_payload') {
        return Object.keys(existing.raw_payload).length === Object.keys(invoice.row.raw_payload).length
          && Object.entries(invoice.row.raw_payload).every(([field, v]) => existing.raw_payload[field] === v)
      }
      return existing[key as keyof PaymentLedgerRow] === value
    })
    if (!unchanged) await ctx.store.upsertPayment(invoice.row)
  }
  return { invoices: invoices.sort(compareEvidence), problem: null }
}
