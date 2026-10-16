/** One exceptional, owner-attested identity. Never imported by checkout/webhook/reconcile.
 * Provider evidence decides payment/access; the attestation ONLY identifies the historical tenant.
 * This module cannot write to the real store or call a mutating provider endpoint.
 */
import { applyPreapprovalEvidence, parseCheckoutReference } from './preapproval.ts'
import { checkoutTermsProblem } from './planCatalog.ts'
import type { BillingContext } from './preapproval.ts'
import type { MpClient, MpPreapproval, MpPreapprovalPlan, MpAuthorizedPayment, MpPayment } from './mpClient.ts'
import type { BillingStore, BusinessBillingRow, CheckoutSessionRow, PaymentLedgerRow, NewBillingEvent } from './store.ts'

export const PLAN_A_CASE_FINGERPRINT = 'cf128e8c4ec6fa425e002286f4db8c9df5d6b884abdf138c50b21bcddfff6c7a'
/** Current integration and historical contract report different applications. Collector/read access
 * cannot resolve that provenance. No environment variable or approval artifact can open this gate.
 * A separately reviewed change with provider provenance is required before any real recovery.
 */
export const PLAN_A_HISTORICAL_APPLICATION_VERIFIED = false
export const PLAN_A_BUSINESS_KEYS = ['id', 'subscription_status', 'subscription_plan', 'subscription_provider',
  'access_source', 'mp_preapproval_id', 'mp_preapproval_plan_id', 'mp_last_modified', 'current_period_start',
  'current_period_end', 'grace_until', 'last_payment_id', 'last_payment_status', 'trial_ends_at',
  'override_reason', 'override_created_by', 'override_created_at', 'override_expires_at', 'updated_at'] as const
export const PLAN_A_SESSION_KEYS = ['id', 'business_id', 'user_id', 'plan_id', 'billing_cycle', 'amount', 'currency',
  'mp_preference_id', 'external_reference', 'status', 'created_at', 'updated_at', 'mp_preapproval_plan_id',
  'mp_preapproval_id', 'confirmed_at'] as const
const CASE_KEYS = ['business_id', 'session_id', 'preapproval_id', 'preapproval_plan_id', 'invoice_id', 'payment_id'] as const
export type PlanACase = Record<typeof CASE_KEYS[number], string>
export interface PlanATrust { applicationId: string; collectorId: string }
export interface PlanASnapshot {
  business: Record<string, unknown> | null
  session: Record<string, unknown> | null
  otherSessionIds: string[]
  businessPayments: PaymentLedgerRow[]
  boundBusinessId: string | null
  boundSessionId: string | null
  recoveryRecorded: boolean
  recoveryDigest: string | null
}
export interface PlanAReader {
  loadSnapshot(identity: PlanACase): Promise<PlanASnapshot>
  getPaymentByInvoiceId(id: string): Promise<PaymentLedgerRow | null>
  getPaymentByPaymentId(id: string): Promise<PaymentLedgerRow | null>
}
export interface PlanAInspectionDependencies {
  reader: PlanAReader
  mp: MpClient
  now: () => Date
  sourceCommit?: string
}
export interface PlanACommitPlan {
  identity: PlanACase
  expectedBusiness: Record<string, unknown>
  expectedSession: Record<string, unknown>
  ledger: PaymentLedgerRow
  providerLastModified: string
  nextPaymentDate: string
}
export interface PlanADryRun {
  version: 1
  mode: 'dry-run'
  caseFingerprint: string
  observedAt: string
  eligible: boolean
  checks: string[]
  blockers: string[]
  evidenceDigest: string | null
  /** Private in-memory plan; CLI never prints it or provider bodies. */
  plan: PlanACommitPlan | null
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  return JSON.stringify(value)
}
export async function evidenceDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(value)))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}
export async function caseFingerprint(identity: PlanACase): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CASE_KEYS.map(k => identity[k]).join('\n')))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}
export function parsePlanACase(value: unknown): PlanACase {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_case_manifest')
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== [...CASE_KEYS].sort().join(',')
    || CASE_KEYS.some(k => typeof row[k] !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(row[k] as string))) {
    throw new Error('invalid_case_manifest')
  }
  return row as PlanACase
}
function select(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map(key => [key, row[key] ?? null]))
}
function iso(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}
function nativeId(value: unknown): string {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)) ? String(value) : ''
}
function expect(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}

/** GET-only by construction, including when the canonical code runs on its shadow store. */
export function readOnlyMpClient(client: MpClient): MpClient {
  const forbidden = async (): Promise<never> => { throw new Error('provider_mutation_forbidden') }
  return {
    createPendingPreapproval: forbidden, cancelPreapproval: forbidden,
    getPreapproval: id => client.getPreapproval(id), getPreapprovalPlan: id => client.getPreapprovalPlan(id),
    getAuthorizedPayment: id => client.getAuthorizedPayment(id), getPayment: id => client.getPayment(id),
    listAuthorizedPayments: (id, offset, limit) => client.listAuthorizedPayments(id, offset, limit),
  }
}

/** Reuses the production authority in an isolated store. No database mutator is accepted here. */
function shadowContext(snapshot: PlanASnapshot, identity: PlanACase, reader: PlanAReader, mp: MpClient, now: () => Date) {
  const business = structuredClone(snapshot.business) as unknown as BusinessBillingRow
  const session = { ...structuredClone(snapshot.session), mp_preapproval_id: identity.preapproval_id } as unknown as CheckoutSessionRow
  const ledger = new Map<string, PaymentLedgerRow>()
  const events: NewBillingEvent[] = []
  const forbidden = async (): Promise<never> => { throw new Error('unexpected_shadow_operation') }
  const store: BillingStore = {
    getBusinessBilling: async id => id === business.id ? structuredClone(business) : null,
    findBusinessByPreapprovalId: async id => id === business.mp_preapproval_id ? structuredClone(business) : null,
    updateBusinessBilling: async (id, patch) => { expect(id === business.id, 'foreign_shadow_business'); Object.assign(business, patch) },
    compareBusinessBilling: async (before, patch) => {
      expect(stable(before) === stable(business), 'shadow_concurrent_change'); Object.assign(business, patch); return true
    },
    findCheckoutSessionByPreapprovalId: async id => id === identity.preapproval_id ? structuredClone(session) : null,
    findCheckoutSessionByReference: async ref => ref === session.external_reference ? structuredClone(session) : null,
    listCheckoutSessions: async id => id === business.id ? [structuredClone(session)] : [],
    listPendingCheckouts: async id => id === business.id && session.status === 'pending' ? [structuredClone(session)] : [],
    insertCheckoutSession: forbidden, closePendingCheckout: forbidden,
    updateCheckoutSession: async (id, patch) => { expect(id === session.id, 'foreign_shadow_session'); Object.assign(session, patch) },
    claimEvent: async event => { events.push(structuredClone(event)); return { id: String(events.length), duplicate: false } },
    recordEvent: async event => { events.push(structuredClone(event)) },
    updateEvent: async (id, patch) => { expect(Boolean(events[Number(id) - 1]), 'unknown_shadow_event'); Object.assign(events[Number(id) - 1], patch) },
    upsertPayment: async row => { ledger.set(row.external_payment_id, structuredClone(row)) },
    getPaymentByInvoiceId: async id => ledger.get(id) ?? reader.getPaymentByInvoiceId(id),
    getPaymentByPaymentId: async id => [...ledger.values()].find(p => p.raw_payload.payment_id === id) ?? reader.getPaymentByPaymentId(id),
    getApprovedPaymentByPreapprovalId: async id => [...ledger.values()].find(p => p.raw_payload.preapproval_id === id && p.status === 'approved') ?? null,
  }
  const ctx: BillingContext = { store, mp, now, log: () => {} }
  return { ctx, business, session, ledger, events }
}

type ProviderProof = { pre: MpPreapproval; plan: MpPreapprovalPlan; invoice: MpAuthorizedPayment; payment: MpPayment }
function proofFields(proof: ProviderProof) {
  // Exclude payer data and all provider fields not used for this decision.
  const recurring = (value: MpPreapproval['auto_recurring']) => value ? select(value as Record<string, unknown>,
    ['frequency', 'frequency_type', 'transaction_amount', 'currency_id']) : null
  return {
    pre: { ...select(proof.pre as unknown as Record<string, unknown>, ['id', 'status', 'application_id', 'collector_id',
      'preapproval_plan_id', 'external_reference', 'date_created', 'last_modified', 'next_payment_date']), auto_recurring: recurring(proof.pre.auto_recurring) },
    plan: { ...select(proof.plan as unknown as Record<string, unknown>, ['id', 'status', 'application_id', 'collector_id',
      'date_created', 'last_modified']), auto_recurring: recurring(proof.plan.auto_recurring) },
    invoice: select(proof.invoice as unknown as Record<string, unknown>, ['id', 'preapproval_id', 'status', 'transaction_amount',
      'currency_id', 'date_created', 'debit_date', 'payment', 'payment_id']),
    payment: select(proof.payment as unknown as Record<string, unknown>, ['id', 'status', 'status_detail', 'collector_id',
      'live_mode', 'transaction_amount', 'currency_id', 'date_created', 'date_approved']),
  }
}

async function readProof(mp: MpClient, identity: PlanACase): Promise<ProviderProof> {
  // No discovery/search of candidate identities. Every resource comes from the exact attested tuple.
  const pre = await mp.getPreapproval(identity.preapproval_id)
  const plan = await mp.getPreapprovalPlan(identity.preapproval_plan_id)
  const invoice = await mp.getAuthorizedPayment(identity.invoice_id)
  const payment = await mp.getPayment(identity.payment_id)
  expect(pre && plan && invoice && payment, 'provider_resource_missing')
  return { pre, plan, invoice, payment }
}

/** Public operational entry point is pinned. Tests can exercise a separate inspector with synthetic identities;
 * neither variant commits, and the SQL committer independently pins the production fingerprint.
 */
export function createPlanAInspector(allowedFingerprint = PLAN_A_CASE_FINGERPRINT) {
  return async (deps: PlanAInspectionDependencies, untrustedCase: unknown, trust: PlanATrust): Promise<PlanADryRun> => {
    const report: PlanADryRun = { version: 1, mode: 'dry-run', caseFingerprint: allowedFingerprint,
      observedAt: deps.now().toISOString(), eligible: false, checks: [], blockers: [], evidenceDigest: null, plan: null }
    const check = (code: string, condition: unknown) => { expect(condition, code); report.checks.push(code) }
    try {
      const identity = parsePlanACase(untrustedCase)
      check('owner_attested_identity', await caseFingerprint(identity) === allowedFingerprint)
      if (allowedFingerprint === PLAN_A_CASE_FINGERPRINT) {
        check('historical_application_identity_unresolved', PLAN_A_HISTORICAL_APPLICATION_VERIFIED)
      }
      check('trusted_application_and_collector_configured', /^[1-9]\d*$/.test(trust.applicationId) && /^[1-9]\d*$/.test(trust.collectorId))
      const snapshot = await deps.reader.loadSnapshot(identity)
      check('not_previously_recovered', !snapshot.recoveryRecorded)
      check('local_rows_exist', snapshot.business && snapshot.session)
      const business = snapshot.business!
      const session = snapshot.session!
      check('exact_local_ownership', business.id === identity.business_id && session.id === identity.session_id && session.business_id === identity.business_id)
      check('untouched_historical_reservation', session.status === 'pending' && session.mp_preapproval_id === null
        && session.mp_preapproval_plan_id === identity.preapproval_plan_id && session.mp_preference_id === null
        && session.confirmed_at === null && Boolean(parseCheckoutReference(session.external_reference))
        && iso(session.created_at)?.startsWith('2026-10-02T'))
      check('trial_without_billing_or_admin_authority', business.subscription_status === 'trialing' && business.subscription_plan === null
        && business.mp_preapproval_id === null && business.mp_preapproval_plan_id === null
        && [null, 'mercadopago'].includes(business.subscription_provider as string | null)
        && business.last_payment_id === null && business.last_payment_status === null
        && [null, 'trial'].includes(business.access_source as string | null)
        && ['override_reason', 'override_created_by', 'override_created_at', 'override_expires_at', 'mp_last_modified',
          'current_period_start', 'current_period_end', 'grace_until'].every(k => business[k] === null))
      check('no_other_local_contract_or_payment', !snapshot.boundBusinessId && !snapshot.boundSessionId
        && snapshot.otherSessionIds.length === 0 && snapshot.businessPayments.length === 0)
      check('local_terms', session.plan_id === 'basico' && session.billing_cycle === 'monthly'
        && Number(session.amount) === 15000 && session.currency === 'ARS')
      const mp = readOnlyMpClient(deps.mp)
      const proof = await readProof(mp, identity)
      const { pre, plan, invoice, payment } = proof
      check('native_resource_identity', pre.id === identity.preapproval_id && plan.id === identity.preapproval_plan_id
        && pre.preapproval_plan_id === plan.id && nativeId(invoice.id) === identity.invoice_id
        && invoice.preapproval_id === pre.id && nativeId(payment.id) === identity.payment_id
        && nativeId(invoice.payment?.id ?? invoice.payment_id) === identity.payment_id
        && (!invoice.payment_id || nativeId(invoice.payment_id) === identity.payment_id))
      check('provider_application_and_collector', nativeId(pre.application_id) === trust.applicationId
        && nativeId(plan.application_id) === trust.applicationId && nativeId(pre.collector_id) === trust.collectorId
        && nativeId(plan.collector_id) === trust.collectorId && nativeId(payment.collector_id) === trust.collectorId
        && payment.live_mode === true)
      check('authorized_processed_approved', pre.status === 'authorized' && plan.status === 'active'
        && invoice.status === 'processed' && invoice.payment?.status === 'approved' && payment.status === 'approved')
      // Empty reference is a required, documented Plan A limitation, never a tenant lookup.
      check('historical_plan_a_reference', pre.external_reference === '' || pre.external_reference === null)
      const terms = { billingCycle: 'monthly' as const, amount: 15000, currency: 'ARS' }
      check('native_plan_and_contract_terms', !checkoutTermsProblem(terms, pre.auto_recurring) && !checkoutTermsProblem(terms, plan.auto_recurring))
      const approved = iso(payment.date_approved)
      const now = deps.now().getTime()
      const next = iso(pre.next_payment_date)
      const modified = iso(pre.last_modified)
      const created = iso(pre.date_created)
      check('approval_chronology', approved?.startsWith('2026-10-02T') && created && iso(plan.date_created)
        && iso(invoice.date_created) && iso(invoice.debit_date) && iso(payment.date_created) && modified && next
        && Date.parse(created) >= Date.parse(String(session.created_at)) && Date.parse(created) <= Date.parse(approved!)
        && Date.parse(String(plan.date_created)) <= Date.parse(created)
        && Date.parse(String(invoice.date_created)) >= Date.parse(created) && Date.parse(String(invoice.date_created)) <= Date.parse(approved!)
        && Date.parse(String(payment.date_created)) >= Date.parse(created) && Date.parse(String(payment.date_created)) <= Date.parse(approved!)
        && Date.parse(String(invoice.debit_date)) <= Date.parse(approved!)
        && Date.parse(approved!) <= now && Date.parse(modified!) >= Date.parse(approved!) && Date.parse(modified!) <= now
        && next!.startsWith('2026-11-02T') && Date.parse(next!) > now)
      const page = await mp.listAuthorizedPayments(pre.id, 0, 20)
      check('complete_single_historical_invoice', page.paging.offset === 0 && page.paging.total === 1
        && page.results.length === 1 && nativeId(page.results[0].id) === identity.invoice_id && page.results[0].preapproval_id === pre.id)
      const shadow = shadowContext(snapshot, identity, deps.reader, mp, deps.now)
      const outcome = await applyPreapprovalEvidence(shadow.ctx, pre, { source: 'reconcile', expectBusinessId: identity.business_id })
      const ledger = [...shadow.ledger.values()]
      check('canonical_approved_ledger_and_access', outcome.kind === 'activated' && shadow.business.subscription_status === 'active'
        && shadow.business.subscription_plan === 'basico' && shadow.session.status === 'paid' && ledger.length === 1
        && ledger[0].external_payment_id === identity.invoice_id && ledger[0].raw_payload.payment_id === identity.payment_id
        && ledger[0].status === 'approved' && ledger[0].paid_at === approved && shadow.events.some(e => e.processed))
      // Catch provider changes during the inspection, including a new/rejected invoice.
      const reread = await readProof(mp, identity)
      const finalPage = await mp.listAuthorizedPayments(pre.id, 0, 20)
      check('provider_evidence_stable', stable(proofFields(proof)) === stable(proofFields(reread))
        && stable(page) === stable(finalPage))
      check('local_snapshot_stable', stable(snapshot) === stable(await deps.reader.loadSnapshot(identity)))
      const commitPlan: PlanACommitPlan = { identity, expectedBusiness: select(business, PLAN_A_BUSINESS_KEYS),
        expectedSession: select(session, PLAN_A_SESSION_KEYS), ledger: ledger[0], providerLastModified: modified!, nextPaymentDate: next! }
      report.evidenceDigest = await evidenceDigest({ plan: commitPlan, provider: proofFields(proof), trust })
      report.plan = commitPlan
      report.eligible = true
    } catch (error) {
      // Error codes only: never echo provider body, query, user data, tokens or native IDs.
      const message = error instanceof Error ? error.message : ''
      report.blockers.push(/^[a-z_]+$/.test(message) ? message : 'inspection_failed_or_provider_unavailable')
    }
    return report
  }
}
export const inspectPlanARecovery = createPlanAInspector()

export interface PlanAReceipt {
  version: 1
  mode: 'dry-run'
  caseFingerprint: string
  evidenceDigest: string
  observedAt: string
  sourceCommit: string
}
export interface PlanAApproval {
  caseFingerprint: string
  evidenceDigest: string
  dryRunObservedAt: string
  approvalRef: string
  operatorRef: string
  authorizedAt: string
  action: 'execute-existing-paid-plan-a-once'
  sourceCommit: string
}
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','))
}
/** No direct fallback writes; only the separately reviewed atomic RPC may commit. */
export async function executePlanARecovery(
  deps: PlanAInspectionDependencies,
  identity: unknown,
  trust: PlanATrust,
  receipt: PlanAReceipt,
  approval: PlanAApproval,
  commit: (plan: PlanACommitPlan, digest: string, approval: PlanAApproval) => Promise<'recovered' | 'already_recovered'>,
): Promise<'recovered' | 'already_recovered'> {
  const now = deps.now().getTime()
  expect(exactKeys(receipt, ['version', 'mode', 'caseFingerprint', 'evidenceDigest', 'observedAt', 'sourceCommit'])
    && receipt.version === 1 && receipt.mode === 'dry-run' && receipt.caseFingerprint === PLAN_A_CASE_FINGERPRINT
    && /^[a-f0-9]{64}$/.test(receipt.evidenceDigest) && /^[a-f0-9]{40}$/.test(receipt.sourceCommit)
    && receipt.sourceCommit === deps.sourceCommit, 'invalid_dry_run_receipt')
  expect(iso(receipt.observedAt) && now - Date.parse(receipt.observedAt) >= 0
    && now - Date.parse(receipt.observedAt) <= 5 * 60_000, 'expired_dry_run_receipt')
  expect(exactKeys(approval, ['action', 'caseFingerprint', 'evidenceDigest', 'dryRunObservedAt', 'approvalRef', 'operatorRef', 'authorizedAt', 'sourceCommit'])
    && approval.action === 'execute-existing-paid-plan-a-once' && approval.caseFingerprint === receipt.caseFingerprint
    && approval.sourceCommit === receipt.sourceCommit
    && approval.evidenceDigest === receipt.evidenceDigest && approval.dryRunObservedAt === receipt.observedAt
    && iso(approval.authorizedAt) && Date.parse(approval.authorizedAt) > Date.parse(receipt.observedAt)
    && Date.parse(approval.authorizedAt) <= now && /^[a-zA-Z0-9_-]{8,100}$/.test(approval.approvalRef)
    && /^[a-zA-Z0-9_-]{8,100}$/.test(approval.operatorRef), 'independent_execution_approval_required')
  const parsed = parsePlanACase(identity)
  expect(await caseFingerprint(parsed) === PLAN_A_CASE_FINGERPRINT, 'owner_attested_identity')
  expect(PLAN_A_HISTORICAL_APPLICATION_VERIFIED, 'historical_application_identity_unresolved')
  const prior = await deps.reader.loadSnapshot(parsed)
  if (prior.recoveryRecorded) {
    const ledger = await deps.reader.getPaymentByInvoiceId(parsed.invoice_id)
    expect(prior.recoveryDigest === receipt.evidenceDigest && prior.session?.business_id === parsed.business_id
      && prior.session?.id === parsed.session_id && prior.session?.mp_preapproval_id === parsed.preapproval_id
      && ledger?.business_id === parsed.business_id && ledger.raw_payload.preapproval_id === parsed.preapproval_id
      && ledger.raw_payload.payment_id === parsed.payment_id, 'recovery_receipt_identity_conflict')
    // Later renewals/refunds/admin decisions remain authoritative. Retry never grants access again.
    return 'already_recovered'
  }
  const fresh = await inspectPlanARecovery(deps, identity, trust)
  expect(fresh.eligible && fresh.plan && fresh.evidenceDigest === receipt.evidenceDigest, 'fresh_evidence_changed_or_blocked')
  expect(deps.now().getTime() - Date.parse(fresh.observedAt) <= 30_000, 'fresh_evidence_too_old')
  return commit(fresh.plan, fresh.evidenceDigest!, approval)
}
