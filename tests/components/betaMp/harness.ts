// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · banco de pruebas de Billing SaaS.
//
// Los tests corren el código REAL de las Edge Functions (`_shared/billing/*`):
// las acciones, el camino canónico, el store sobre supabase-js y el cliente de
// Mercado Pago. Lo único simulado son los dos bordes:
//
//   · FakeDb  — PostgREST en memoria. No es un mock complaciente: conoce las
//     tablas y columnas reales, los CHECK, los índices únicos y los privilegios
//     de `service_role` (los de las migraciones 20261012120000 y 20261013120000,
//     o los anteriores con `preMigration`). Una columna mal escrita o un UPDATE
//     fuera del GRANT falla acá igual que en la base.
//   · FakeMercadoPago — la API HTTP de Mercado Pago. Responde a las mismas rutas
//     que usa `mpClient.ts`, así que también se prueban el cuerpo del POST y el
//     parseo de respuestas.
//
// Esto NO certifica Mercado Pago: lo que MP hace de verdad con un preapproval
// creado por API se mide en el smoke del runbook.
// ─────────────────────────────────────────────────────────────────────────────
import { createMpClient } from '../../../supabase/functions/_shared/billing/mpClient.ts'
import { PLAN_PRICES, buildPlanCatalog } from '../../../supabase/functions/_shared/billing/planCatalog.ts'
import type { PlanPriceTable } from '../../../supabase/functions/_shared/billing/planCatalog.ts'
import type { BillingContext, BillingLogEvent } from '../../../supabase/functions/_shared/billing/preapproval.ts'
import { createCapabilityAuthorizer, createSupabaseBillingStore } from '../../../supabase/functions/_shared/billing/store.ts'
import { handleBillingAction } from '../../../supabase/functions/_shared/billing/subscriptionActions.ts'
import type { ActionContext, ActionResponse } from '../../../supabase/functions/_shared/billing/subscriptionActions.ts'
import { parseNotification, processWebhookNotification } from '../../../supabase/functions/_shared/billing/webhook.ts'
import { FAKE_MP_TOKEN, FakeMercadoPago } from './fakeMercadoPago.ts'

export type Row = Record<string, unknown>
interface PgError { code: string; message: string }
interface PgResult { data: unknown; error: PgError | null }

// ── Esquema: columnas reales (baseline + migración BETA-MP) ──────────────────
const COLUMNS: Record<string, string[]> = {
  businesses: [
    'id', 'name', 'owner_user_id', 'updated_at', 'subscription_status', 'subscription_plan', 'subscription_provider',
    'mp_preapproval_id', 'mp_preapproval_plan_id', 'mp_payer_email', 'current_period_start', 'current_period_end',
    'grace_until', 'last_payment_id', 'last_payment_status', 'last_webhook_at', 'trial_ends_at', 'access_source',
    'override_expires_at', 'mp_last_modified',
  ],
  subscription_checkout_sessions: [
    'id', 'business_id', 'user_id', 'plan_id', 'billing_cycle', 'amount', 'currency', 'mp_preference_id',
    'external_reference', 'status', 'created_at', 'updated_at',
    // migración 20261012120000
    'mp_preapproval_plan_id', 'mp_preapproval_id', 'payer_email', 'confirmed_at',
  ],
  subscription_events: [
    'id', 'business_id', 'provider', 'event_type', 'external_id', 'raw_payload', 'processed', 'error_message',
    'created_at', 'processed_at',
    // migración 20261012120000
    'notification_id',
  ],
  payments: [
    'id', 'business_id', 'provider', 'external_payment_id', 'type', 'amount', 'currency', 'status',
    'subscription_plan', 'paid_at', 'period_start', 'period_end', 'raw_payload', 'created_at',
  ],
}

/** GRANT UPDATE (...) ON public.businesses TO service_role — baseline, línea 14550. */
const BUSINESS_UPDATE_GRANT = [
  'access_source', 'current_period_end', 'current_period_start', 'grace_until', 'last_payment_id',
  'last_payment_status', 'last_webhook_at', 'mp_last_modified', 'mp_payer_email', 'mp_preapproval_id',
  'mp_preapproval_plan_id', 'subscription_plan', 'subscription_provider', 'subscription_status', 'updated_at',
]

const CHECKS: Record<string, Record<string, readonly string[]>> = {
  businesses: {
    subscription_status: ['trialing', 'active', 'past_due', 'suspended', 'canceled', 'pending_activation'],
    subscription_plan: ['basico', 'pro', 'full'],
  },
  subscription_checkout_sessions: {
    plan_id: ['basico', 'pro', 'full'],
    status: ['pending', 'paid', 'failed', 'expired', 'canceled'],
  },
  payments: {
    status: ['approved', 'pending', 'in_process', 'rejected', 'cancelled', 'refunded', 'charged_back'],
    type: ['one_time', 'recurring', 'manual'],
  },
}

const fail = (code: string, message: string): PgResult => ({ data: null, error: { code, message } })

export interface DbWrite { table: string; op: 'insert' | 'update' | 'upsert'; columns: string[] }

export class FakeDb {
  tables: Record<string, Row[]> = { businesses: [], subscription_checkout_sessions: [], subscription_events: [], payments: [], profiles: [] }
  /** Todas las escrituras que llegaron a la base, en orden. */
  writes: DbWrite[] = []
  /** `true`: la base todavía NO tiene la migración 20261012120000. */
  preMigration = false
  /** Fuerza un error en la próxima operación sobre esa tabla. */
  failOn: { table: string; op: string; code: string } | null = null
  private seq = 0

  constructor(readonly now: () => Date) {}

  nextId(): string {
    this.seq += 1
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`
  }

  from(table: string): Query {
    return new Query(this, table)
  }

  writesTo(table: string): DbWrite[] {
    return this.writes.filter((w) => w.table === table)
  }

  business(id: string): Row {
    const row = this.tables.businesses.find((b) => b.id === id)
    if (!row) throw new Error(`no existe el negocio ${id}`)
    return row
  }

  events(type?: string): Row[] {
    return this.tables.subscription_events.filter((e) => !type || e.event_type === type)
  }
}

class Query implements PromiseLike<PgResult> {
  private op: 'select' | 'insert' | 'update' | 'upsert' = 'select'
  private payload: Row | Row[] | null = null
  private filters: [string, unknown][] = []
  private returning: string | null = null
  private orderBy: { col: string; ascending: boolean } | null = null
  private max: number | null = null
  private onConflict: string | null = null
  private mode: 'many' | 'single' | 'maybe' = 'many'

  constructor(private readonly db: FakeDb, private readonly table: string) {}

  select(cols = '*') { this.returning = cols; return this }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = rows; return this }
  update(patch: Row) { this.op = 'update'; this.payload = patch; return this }
  upsert(row: Row, opts: { onConflict: string }) { this.op = 'upsert'; this.payload = row; this.onConflict = opts.onConflict; return this }
  eq(col: string, val: unknown) { this.filters.push([col, val]); return this }
  order(col: string, opts: { ascending: boolean }) { this.orderBy = { col, ascending: opts.ascending }; return this }
  limit(n: number) { this.max = n; return this }
  single() { this.mode = 'single'; return this }
  maybeSingle() { this.mode = 'maybe'; return this }

  then<A = PgResult, B = never>(ok?: ((v: PgResult) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve().then(() => this.run()).then(ok, ko)
  }

  private run(): PgResult {
    const { db, table } = this
    const known = COLUMNS[table]
    if (!known) return fail('42P01', `relation "${table}" does not exist`)
    if (db.failOn && db.failOn.table === table && db.failOn.op === this.op) {
      const code = db.failOn.code
      db.failOn = null
      return fail(code, 'forced failure')
    }

    const badColumn = (cols: string[]) => cols.find((c) => !known.includes(c))
    const selected = this.returning && this.returning !== '*' ? this.returning.split(',').map((c) => c.trim()) : null
    const unknown = badColumn([...(selected ?? []), ...this.filters.map(([c]) => c), ...(this.orderBy ? [this.orderBy.col] : [])])
    if (unknown) return fail('42703', `column "${unknown}" does not exist`)

    const rows = db.tables[table]
    const matches = (row: Row) => this.filters.every(([c, v]) => row[c] === v)
    const project = (row: Row): Row => {
      if (!selected) return { ...row }
      const out: Row = {}
      for (const c of selected) out[c] = row[c] ?? null
      return out
    }

    let affected: Row[]
    if (this.op === 'select') {
      affected = rows.filter(matches)
    } else {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}]
      const columns = [...new Set(payloads.flatMap((p) => Object.keys(p)))]
      const bad = badColumn(columns)
      if (bad) return fail('PGRST204', `Could not find the '${bad}' column of '${table}'`)
      const denied = this.denied(columns)
      if (denied) return fail('42501', denied)
      const checked = payloads.map((p) => this.violates(p)).find(Boolean)
      if (checked) return fail('23514', checked)

      if (this.op === 'update') {
        affected = rows.filter(matches)
        const patch = payloads[0]
        const conflict = this.uniqueViolation(patch, affected)
        if (conflict) return fail('23505', conflict)
        for (const row of affected) Object.assign(row, patch)
      } else if (this.op === 'insert') {
        affected = []
        for (const p of payloads) {
          const row = this.withDefaults(p)
          const conflict = this.uniqueViolation(row, [])
          if (conflict) return fail('23505', conflict)
          rows.push(row)
          affected.push(row)
        }
      } else {
        // Antes de la migración el único índice único de `payments` era PARCIAL:
        // PostgreSQL no lo infiere desde un ON CONFLICT sin predicado (42P10).
        // Medido contra el stack local; el upsert viejo fallaba en el primer cobro.
        if (db.preMigration && table === 'payments') {
          return fail('42P10', 'there is no unique or exclusion constraint matching the ON CONFLICT specification')
        }
        const p = payloads[0]
        const keys = (this.onConflict ?? '').split(',').map((k) => k.trim())
        const existing = rows.find((r) => keys.every((k) => r[k] === (p[k] ?? this.withDefaults(p)[k])))
        if (existing) { Object.assign(existing, p); affected = [existing] }
        else { const row = this.withDefaults(p); rows.push(row); affected = [row] }
      }
      db.writes.push({ table, op: this.op, columns })
      if (!this.returning) return { data: null, error: null }
    }

    if (this.orderBy) {
      const { col, ascending } = this.orderBy
      affected = [...affected].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (ascending ? 1 : -1))
    }
    if (this.max !== null) affected = affected.slice(0, this.max)

    if (this.mode === 'many') return { data: affected.map(project), error: null }
    if (affected.length > 1) return fail('PGRST116', 'multiple rows')
    if (affected.length === 0) return this.mode === 'single' ? fail('PGRST116', '0 rows') : { data: null, error: null }
    return { data: project(affected[0]), error: null }
  }

  /** Privilegios de `service_role`, tabla por tabla. */
  private denied(columns: string[]): string | null {
    const { table, op, db } = this
    if (table === 'businesses') {
      if (op !== 'update') return 'permission denied for table businesses'
      const outside = columns.find((c) => !BUSINESS_UPDATE_GRANT.includes(c))
      return outside ? `permission denied for column ${outside} of businesses` : null
    }
    if (table === 'subscription_checkout_sessions' && db.preMigration) {
      if (op !== 'update') return 'permission denied for table subscription_checkout_sessions'
      const outside = columns.find((c) => !['status', 'updated_at'].includes(c))
      return outside ? `permission denied for column ${outside}` : null
    }
    return null
  }

  private violates(payload: Row): string | null {
    for (const [col, allowed] of Object.entries(CHECKS[this.table] ?? {})) {
      const value = payload[col]
      if (value !== undefined && value !== null && !allowed.includes(String(value))) return `check constraint on ${this.table}.${col}`
    }
    if (this.op === 'insert' && this.table === 'subscription_checkout_sessions') {
      for (const col of ['business_id', 'plan_id', 'amount']) {
        if (payload[col] === undefined || payload[col] === null) return `null value in column "${col}"`
      }
    }
    return null
  }

  private withDefaults(payload: Row): Row {
    const nowIso = this.db.now().toISOString()
    const row: Row = {}
    for (const c of COLUMNS[this.table]) row[c] = null
    Object.assign(row, { id: this.db.nextId() })
    if (this.table === 'subscription_checkout_sessions') Object.assign(row, { billing_cycle: 'monthly', currency: 'ARS', status: 'pending', created_at: nowIso, updated_at: nowIso })
    if (this.table === 'subscription_events') Object.assign(row, { provider: 'mercadopago', processed: false, raw_payload: {}, created_at: nowIso })
    if (this.table === 'payments') Object.assign(row, { provider: 'mercadopago', type: 'recurring', currency: 'ARS', status: 'pending', raw_payload: {}, created_at: nowIso })
    return Object.assign(row, payload)
  }

  /** Índices únicos reales. `own` son las filas que el UPDATE está tocando. */
  private uniqueViolation(next: Row, own: Row[]): string | null {
    const others = this.db.tables[this.table].filter((r) => !own.includes(r))
    if (this.table === 'businesses' && next.mp_preapproval_id) {
      if (others.some((r) => r.mp_preapproval_id === next.mp_preapproval_id)) return 'uq_businesses_mp_preapproval_id'
    }
    if (this.table === 'subscription_checkout_sessions') {
      if (next.external_reference && others.some((r) => r.external_reference === next.external_reference)) {
        return 'subscription_checkout_sessions_external_reference_key'
      }
      // uq_scs_mp_preapproval (migración 20261013120000): un preapproval, una sesión.
      if (next.mp_preapproval_id && others.some((r) => r.mp_preapproval_id === next.mp_preapproval_id)) {
        return 'uq_scs_mp_preapproval'
      }
      const merged = own.length === 1 ? { ...own[0], ...next } : next
      if (merged.status === 'pending' && others.some((r) => r.status === 'pending' && r.business_id === merged.business_id
          && r.plan_id === merged.plan_id && r.billing_cycle === merged.billing_cycle)) return 'idx_scs_pending_unique'
    }
    if (this.table === 'subscription_events' && next.external_id && next.notification_id) {
      if (others.some((r) => r.provider === next.provider && r.event_type === next.event_type
          && r.external_id === next.external_id && r.notification_id === next.notification_id)) return 'uq_subscription_events_notification'
    }
    return null
  }
}

// ── Mundo de prueba ─────────────────────────────────────────────────────────

export const BIZ_A = '11111111-1111-4111-8111-11111111aaaa'
export const BIZ_B = '22222222-2222-4222-8222-22222222bbbb'
export const OWNER_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
export const OWNER_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
export const TECH_A = 'aaaaaaaa-0000-4000-8000-0000000000a2'
export const ORIGIN = 'https://www.techrepairpro.app'

export interface Member { userId: string; businessId: string; role: string; active?: boolean; permissions?: Row | null }

export class World {
  private clock = new Date('2026-10-01T12:00:00.000Z')
  readonly now = () => new Date(this.clock.getTime())
  readonly db = new FakeDb(this.now)
  readonly mp = new FakeMercadoPago(this.now)
  readonly logs: BillingLogEvent[] = []
  /** Tabla de precios del servidor. Un test la cambia para simular un cambio de precio. */
  prices: PlanPriceTable = structuredClone(PLAN_PRICES)
  /** La consulta de capacidad falla (base caída / contrato de cliente rechazado). */
  authorizerDown = false
  private notificationSeq = 1000
  private idSeq = 0

  constructor() {
    this.addBusiness(BIZ_A, OWNER_A, { subscription_status: 'trialing', access_source: 'trial', trial_ends_at: '2026-10-07T12:00:00.000Z' })
    this.addBusiness(BIZ_B, OWNER_B, { subscription_status: 'trialing', access_source: 'trial', trial_ends_at: '2026-10-07T12:00:00.000Z' })
    this.addMember({ userId: OWNER_A, businessId: BIZ_A, role: 'owner' })
    this.addMember({ userId: OWNER_B, businessId: BIZ_B, role: 'owner' })
    this.addMember({ userId: TECH_A, businessId: BIZ_A, role: 'tech' })
  }

  advance(ms: number): void { this.clock = new Date(this.clock.getTime() + ms) }

  addBusiness(id: string, ownerUserId: string, patch: Row = {}): Row {
    const row: Row = {}
    for (const c of COLUMNS.businesses) row[c] = null
    Object.assign(row, { id, name: `Negocio ${id.slice(0, 4)}`, owner_user_id: ownerUserId, subscription_status: 'trialing', subscription_provider: 'mercadopago' }, patch)
    this.db.tables.businesses.push(row)
    return row
  }

  addMember(member: Member): void {
    this.db.tables.profiles.push({
      user_id: member.userId, business_id: member.businessId, role: member.role,
      is_active: member.active ?? true, permissions: member.permissions ?? null,
    })
  }

  /** Copia de la fila de billing de un negocio, para comparar antes/después. */
  snapshot(businessId: string): Row { return { ...this.db.business(businessId) } }

  /**
   * `current_user_can_in_business(p_business_id, 'subscription')` tal como la
   * define la base: el dueño registrado y el rol owner la tienen; el resto sólo
   * con un override explícito; un perfil inactivo o de otro negocio, nunca.
   */
  private userClient(userId: string) {
    return {
      rpc: async (fn: string, args: Record<string, unknown>): Promise<PgResult> => {
        if (this.authorizerDown) return fail('PGRST301', 'service unavailable')
        if (fn !== 'current_user_can_in_business') return fail('PGRST202', `function ${fn} not found`)
        const businessId = args.p_business_id
        const key = String(args.p_key)
        const business = this.db.tables.businesses.find((b) => b.id === businessId)
        if (business?.owner_user_id === userId) return { data: key !== 'personal_finance', error: null }
        const profile = this.db.tables.profiles.find((p) => p.user_id === userId && p.business_id === businessId && p.is_active === true)
        if (!profile) return { data: false, error: null }
        if (profile.role === 'owner') return { data: true, error: null }
        const override = (profile.permissions as Row | null)?.[key]
        if (typeof override === 'boolean') return { data: override, error: null }
        return { data: false, error: null }   // default de 'subscription' para todo rol que no es owner
      },
    }
  }

  billingContext(): BillingContext {
    return {
      store: createSupabaseBillingStore(this.db),
      mp: createMpClient({ fetchImpl: (input, init) => this.mp.fetchImpl(input, init), accessToken: () => FAKE_MP_TOKEN }),
      now: this.now,
      log: (event) => { this.logs.push(event) },
    }
  }

  actionContext(userId: string): ActionContext {
    return {
      ...this.billingContext(),
      authorizer: createCapabilityAuthorizer(this.userClient(userId)),
      catalog: buildPlanCatalog(this.prices),
      newId: () => { this.idSeq += 1; return `cccccccc-0000-4000-8000-${String(this.idSeq).padStart(12, '0')}` },
      allowedOrigins: [ORIGIN, 'https://techrepairpro.app'],
      appOrigin: ORIGIN,
    }
  }

  /** Una llamada autenticada a `mp-subscription`, como la haría el navegador. */
  call(userId: string, body: Row, opts: { email?: string | null; origin?: string | null } = {}): Promise<ActionResponse> {
    const email = opts.email === undefined ? `${userId.slice(0, 8)}@invalid.test` : opts.email
    return handleBillingAction(this.actionContext(userId), {
      user: { id: userId, email }, body, origin: opts.origin === undefined ? ORIGIN : opts.origin,
    })
  }

  /** Una notificación firmada de Mercado Pago (la firma se valida en index.ts, fuera de este módulo). */
  notify(topic: string, resourceId: string, notificationId?: string | number | null) {
    const id = notificationId === undefined ? (this.notificationSeq += 1) : notificationId
    const body: Row = { type: topic, action: 'updated', data: { id: resourceId } }
    if (id !== null) body.id = id
    return processWebhookNotification(this.billingContext(), parseNotification(body))
  }

  /** La sesión de checkout que el servidor vinculó a un preapproval. */
  sessionOf(preapprovalId: string): Row {
    const row = this.db.tables.subscription_checkout_sessions.find((s) => s.mp_preapproval_id === preapprovalId)
    if (!row) throw new Error(`ninguna sesión tiene el preapproval ${preapprovalId}`)
    return row
  }

  /**
   * Abre un checkout como lo haría el navegador. El id del preapproval y la
   * referencia se leen de la BASE (lo que el servidor guardó), no de la respuesta:
   * al navegador sólo le llega el `init_point`.
   */
  async openCheckout(userId: string, businessId: string, plan: string, billingCycle = 'monthly', preapprovalId?: string) {
    if (preapprovalId) this.mp.nextIds.push(preapprovalId)
    const res = await this.call(userId, { action: 'create', business_id: businessId, plan, billing_cycle: billingCycle })
    if (res.status !== 200) throw new Error(`create respondió ${res.status}: ${JSON.stringify(res.body)}`)
    const url = new URL(String(res.body.init_point))
    const id = url.searchParams.get('preapproval_id') as string
    const session = this.sessionOf(id)
    return { res, url, preapprovalId: id, session, reference: session.external_reference as string }
  }

  /** Quien abrió el checkout paga: Mercado Pago deja ESE preapproval `authorized`. */
  pay(preapprovalId: string, patch: Row = {}): Row {
    return this.mp.authorize(preapprovalId, patch)
  }

  /** Atajo: checkout abierto + pago en MP + webhook procesado. */
  async subscribe(userId: string, businessId: string, plan: string, preapprovalId: string, billingCycle = 'monthly') {
    await this.openCheckout(userId, businessId, plan, billingCycle, preapprovalId)
    this.pay(preapprovalId)
    await this.notify('subscription_preapproval', preapprovalId)
    return preapprovalId
  }
}

export const DAY = 24 * 60 * 60 * 1000
export const HOUR = 60 * 60 * 1000
