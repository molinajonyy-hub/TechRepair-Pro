/** Operator-only Plan A exception. No dotenv, linked-project discovery, UI endpoint or automatic execution.
 * Credentials are supplied explicitly by the authorized operator, never committed or printed.
 */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, dirname, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { execFileSync } from 'node:child_process'
import { createMpClient } from '../../supabase/functions/_shared/billing/mpClient.ts'
import { inspectPlanARecovery, executePlanARecovery, PLAN_A_CASE_FINGERPRINT,
  PLAN_A_HISTORICAL_APPLICATION_VERIFIED, caseFingerprint,
  PLAN_A_BUSINESS_KEYS, PLAN_A_SESSION_KEYS, parsePlanACase } from '../../supabase/functions/_shared/billing/planARecovery.ts'

const repository = realpathSync(fileURLToPath(new URL('../..', import.meta.url)))
const commonGitDirectory = realpathSync(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
const privateArtifactExclusions = [repository, ...(basename(commonGitDirectory) === '.git' ? [dirname(commonGitDirectory)] : [])]
const usage = 'node scripts/billing/plan-a-recovery.mjs --dry-run|--execute --case-file ABS_PRIVATE --receipt-file ABS_PRIVATE [--approval-file ABS_PRIVATE]'
function argsOf(args) {
  const argsMap = new Map()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!['--dry-run', '--execute', '--case-file', '--receipt-file', '--approval-file'].includes(key) || argsMap.has(key)) throw new Error('invalid_arguments')
    argsMap.set(key, ['--dry-run', '--execute'].includes(key) ? true : args[++i])
  }
  if (argsMap.has('--dry-run') === argsMap.has('--execute') || !argsMap.get('--case-file') || !argsMap.get('--receipt-file')
    || (argsMap.has('--execute') !== argsMap.has('--approval-file'))) throw new Error('invalid_arguments')
  return argsMap
}
function privatePath(value, exists = true) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('private_absolute_path_required')
  const path = exists ? realpathSync(value) : resolve(realpathSync(dirname(value)), value.split(/[\\/]/).pop())
  for (const excluded of privateArtifactExclusions) {
    const rel = relative(excluded, path)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('artifact_must_be_outside_repository')
  }
  return path
}
function privateJson(path) {
  const text = readFileSync(path, 'utf8')
  if (text.length > 16384) throw new Error('private_artifact_too_large')
  return JSON.parse(text)
}
function config(name) {
  const value = process.env[name]
  if (!value || /[\r\n]/.test(value)) throw new Error('explicit_operator_configuration_required')
  return value
}
function unwrap(result) {
  if (result.error) throw new Error('database_read_or_commit_failed')
  return result.data
}

async function main() {
  if (process.argv.slice(2).join(' ') === '--help') { console.log(usage); return }
  const args = argsOf(process.argv.slice(2))
  const executing = args.has('--execute')
  const identity = parsePlanACase(privateJson(privatePath(args.get('--case-file'))))
  const casePath = privatePath(args.get('--case-file'))
  const receiptPath = privatePath(args.get('--receipt-file'), executing)
  const approvalPath = executing ? privatePath(args.get('--approval-file')) : null
  const paths = [casePath, receiptPath, approvalPath].filter(Boolean).map(path => process.platform === 'win32' ? path.toLowerCase() : path)
  if (new Set(paths).size !== paths.length) throw new Error('independent_private_artifacts_required')
  if (await caseFingerprint(identity) !== PLAN_A_CASE_FINGERPRINT) throw new Error('owner_attested_identity')
  if (!PLAN_A_HISTORICAL_APPLICATION_VERIFIED) {
    // Deliberately before credentials, network or receipt creation. An approval file cannot bypass provenance.
    console.log(JSON.stringify({ mode: executing ? 'execute' : 'dry-run', eligible: false,
      caseFingerprint: PLAN_A_CASE_FINGERPRINT, blockers: ['historical_application_identity_unresolved'],
      databaseWrites: 0, providerRequests: 0 }))
    process.exitCode = 2
    return
  }
  if (execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: repository, encoding: 'utf8' }).trim()) {
    throw new Error('clean_reviewed_checkout_required')
  }
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('reviewed_commit_required')
  const url = new URL(config('BETA_MP_RECOVERY_SUPABASE_URL'))
  if (!((url.protocol === 'https:' && /^[a-z0-9]+\.supabase\.co$/.test(url.hostname))
    || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) || url.username || url.password || url.pathname !== '/') {
    throw new Error('invalid_explicit_database_origin')
  }
  const serviceKey = config('BETA_MP_RECOVERY_SERVICE_ROLE_KEY')
  const token = config('BETA_MP_RECOVERY_ACCESS_TOKEN')
  const trust = { applicationId: process.env.BETA_MP_RECOVERY_APPLICATION_ID ?? '', collectorId: process.env.BETA_MP_RECOVERY_COLLECTOR_ID ?? '' }
  const getOnly = async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method !== 'GET') throw new Error('readonly_transport_rejected_mutation')
    return fetch(input, init)
  }
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const readClient = createClient(url.href, serviceKey, { ...options, global: { fetch: getOnly } })
  const mp = createMpClient({ accessToken: () => token, fetchImpl: getOnly })
  const ledgerColumns = 'business_id,external_payment_id,type,amount,currency,status,subscription_plan,paid_at,raw_payload'
  const findPayment = async (field, value) => unwrap(await readClient.from('payments').select(ledgerColumns)
    .eq('provider', 'mercadopago').eq(field, value).maybeSingle())
  const reader = {
    getPaymentByInvoiceId: id => findPayment('external_payment_id', id),
    getPaymentByPaymentId: id => findPayment('raw_payload->>payment_id', id),
    async loadSnapshot(c) {
      const b = readClient.from('businesses').select(PLAN_A_BUSINESS_KEYS.join(',')).eq('id', c.business_id).maybeSingle()
      const s = readClient.from('subscription_checkout_sessions').select(PLAN_A_SESSION_KEYS.join(',')).eq('id', c.session_id).maybeSingle()
      const other = readClient.from('subscription_checkout_sessions').select('id').eq('business_id', c.business_id).neq('id', c.session_id).limit(1)
      const payments = readClient.from('payments').select(ledgerColumns).eq('provider', 'mercadopago').eq('business_id', c.business_id).limit(1)
      const boundB = readClient.from('businesses').select('id').eq('mp_preapproval_id', c.preapproval_id).maybeSingle()
      const boundS = readClient.from('subscription_checkout_sessions').select('id').eq('mp_preapproval_id', c.preapproval_id).maybeSingle()
      const audit = readClient.from('subscription_events').select('business_id,processed,raw_payload')
        .eq('provider', 'mercadopago').eq('event_type', 'plan_a_paid_case_recovered').eq('external_id', PLAN_A_CASE_FINGERPRINT)
        .eq('notification_id', `case:${PLAN_A_CASE_FINGERPRINT}`).maybeSingle()
      const results = await Promise.allSettled([b, s, other, payments, boundB, boundS, audit])
      const data = results.map(result => {
        if (result.status !== 'fulfilled') throw new Error('database_read_failed')
        return unwrap(result.value)
      })
      const record = data[6]
      if (record && (!record.processed || record.business_id !== c.business_id || record.raw_payload.case_hash !== PLAN_A_CASE_FINGERPRINT
        || record.raw_payload.session_id !== c.session_id || record.raw_payload.preapproval_id !== c.preapproval_id
        || record.raw_payload.invoice_id !== c.invoice_id || record.raw_payload.payment_id !== c.payment_id)) throw new Error('conflicting_recovery_audit')
      return { business: data[0], session: data[1], otherSessionIds: data[2].map(row => row.id), businessPayments: data[3],
        boundBusinessId: data[4]?.id ?? null, boundSessionId: data[5]?.id ?? null,
        recoveryRecorded: Boolean(record), recoveryDigest: record?.raw_payload.evidence_digest ?? null }
    },
  }
  const deps = { reader, mp, now: () => new Date(), sourceCommit }
  if (!executing) {
    const report = await inspectPlanARecovery(deps, identity, trust)
    console.log(JSON.stringify({ ...report, sourceCommit, plan: report.plan ? { action: 'recover-existing-approved-payment', plan: 'basico',
      billingCycle: 'monthly', amount: 15000, currency: 'ARS', ledgerInvoices: 1, createsOrCancelsSubscription: false } : null }, null, 2))
    if (!report.eligible) { process.exitCode = 2; return }
    writeFileSync(receiptPath, JSON.stringify({ version: 1, mode: 'dry-run', caseFingerprint: report.caseFingerprint,
      evidenceDigest: report.evidenceDigest, observedAt: report.observedAt, sourceCommit }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return
  }
  const receipt = privateJson(receiptPath)
  const approval = privateJson(approvalPath)
  const outcome = await executePlanARecovery(deps, identity, trust, receipt, approval, async (plan, digest, authorization) => {
    // Created only after fresh inspection + independent authorization guards. No general write adapter exists.
    const writer = createClient(url.href, serviceKey, options)
    const result = unwrap(await writer.rpc('recover_plan_a_paid_case', {
      p_case: plan.identity, p_expected_business: plan.expectedBusiness, p_expected_session: plan.expectedSession,
      p_ledger: plan.ledger, p_provider_last_modified: plan.providerLastModified, p_next_payment_date: plan.nextPaymentDate,
      p_evidence_digest: digest, p_approval_ref: authorization.approvalRef, p_operator_ref: authorization.operatorRef,
    }))
    if (result?.case_hash !== PLAN_A_CASE_FINGERPRINT || !['applied', 'already_applied'].includes(result?.outcome)) throw new Error('invalid_atomic_commit_result')
    return result.outcome === 'applied' ? 'recovered' : 'already_recovered'
  })
  console.log(JSON.stringify({ mode: 'execute', outcome, caseFingerprint: PLAN_A_CASE_FINGERPRINT }))
}
try { await main() } catch (error) {
  const message = error instanceof Error ? error.message : ''
  console.error(/^[a-z_]+$/.test(message) ? message : 'recovery_stopped_without_automatic_retry')
  process.exitCode = 1
}
