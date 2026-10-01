// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Mercado Pago simulado, a nivel HTTP.
//
// Responde a las mismas rutas que usa `_shared/billing/mpClient.ts`, así que el
// cliente real (URLs, headers, parseo, manejo de 404/5xx) también queda bajo
// prueba. Lo comparten los tests de vitest y la matriz contra el stack local
// (`scripts/billing/beta-mp-local.mjs`), por eso usa sólo sintaxis TypeScript
// borrable: Node lo importa sin transpilar.
//
// NO es Mercado Pago. Modela lo que la documentación dice de cada endpoint; lo
// que MP hace de verdad con el checkout de un plan se mide en el smoke.
// ─────────────────────────────────────────────────────────────────────────────

export type MpRow = Record<string, unknown>
export interface MpCall { method: string; path: string }

export const FAKE_MP_TOKEN = 'TEST-token'

export class FakeMercadoPago {
  preapprovals = new Map<string, MpRow>()
  plans = new Map<string, MpRow>()
  authorizedPayments = new Map<string, MpRow>()
  payments = new Map<string, MpRow>()
  calls: MpCall[] = []
  /** Mercado Pago caído: todas las llamadas responden 500. */
  down = false
  /** El PUT de cancelación responde 200 pero MP no cambia el estado. */
  cancelIsIgnored = false
  /** El PUT de cancelación responde 500. */
  cancelFails = false
  /** Simula que /preapproval/search ignora `offset` (devuelve siempre la primera página). */
  searchIgnoresOffset = false
  now: () => Date

  constructor(now: () => Date) {
    this.now = now
  }

  callsTo(method: string, pathPrefix: string): MpCall[] {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix))
  }

  fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    this.calls.push({ method, path: url.pathname + url.search })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (this.down) return json({ message: 'internal error' }, 500)
    const auth = new Headers(init?.headers).get('authorization')
    if (auth !== `Bearer ${FAKE_MP_TOKEN}`) return json({ message: 'unauthorized' }, 401)

    if (method === 'GET' && url.pathname === '/preapproval/search') {
      const planId = url.searchParams.get('preapproval_plan_id')
      const offset = this.searchIgnoresOffset ? 0 : Number(url.searchParams.get('offset') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 20)
      const all = [...this.preapprovals.values()].filter((p) => p.preapproval_plan_id === planId)
      return json({ paging: { offset, limit, total: all.length }, results: all.slice(offset, offset + limit) })
    }
    const one = (prefix: string, store: Map<string, MpRow>) => {
      if (!url.pathname.startsWith(prefix)) return null
      const row = store.get(decodeURIComponent(url.pathname.slice(prefix.length)))
      return row ? json(row) : json({ message: 'not found' }, 404)
    }
    if (method === 'PUT' && url.pathname.startsWith('/preapproval/')) {
      const row = this.preapprovals.get(decodeURIComponent(url.pathname.slice('/preapproval/'.length)))
      if (!row) return json({ message: 'not found' }, 404)
      if (this.cancelFails) return json({ message: 'internal error' }, 500)
      const body = JSON.parse(String(init?.body ?? '{}')) as MpRow
      if (!this.cancelIsIgnored && body.status === 'cancelled') {
        row.status = 'cancelled'
        row.last_modified = this.now().toISOString()
      }
      return json(row)
    }
    if (method === 'GET') {
      return one('/preapproval_plan/', this.plans) ?? one('/preapproval/', this.preapprovals)
        ?? one('/authorized_payments/', this.authorizedPayments) ?? one('/v1/payments/', this.payments)
        ?? json({ message: 'not found' }, 404)
    }
    return json({ message: 'not found' }, 404)
  }

  /** Planes de prueba: `[id, importe, meses]`. */
  seedPlans(plans: [string, number, number][]): void {
    for (const [id, amount, frequency] of plans) {
      this.plans.set(id, {
        id, status: 'active',
        init_point: `https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=${id}`,
        auto_recurring: { frequency, frequency_type: 'months', transaction_amount: amount, currency_id: 'ARS' },
      })
    }
  }

  /** Lo que Mercado Pago tendría después de que alguien completa (o no) un checkout. */
  seedPreapproval(id: string, patch: MpRow): MpRow {
    const nowIso = this.now().toISOString()
    const row: MpRow = {
      id, status: 'authorized', preapproval_plan_id: null, external_reference: null,
      payer_email: 'pagador@invalid.test', date_created: nowIso, last_modified: nowIso,
      next_payment_date: new Date(this.now().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      init_point: `https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=${id}`,
      ...patch,
    }
    this.preapprovals.set(id, row)
    return row
  }
}

/** Secrets de plan del entorno de prueba. Trimestral queda SIN configurar a propósito. */
export const PLAN_ENV: Record<string, string> = {
  MP_PLAN_BASICO_MONTHLY: 'mpplan_basico_m',
  MP_PLAN_BASICO_ANNUAL: 'mpplan_basico_a',
  MP_PLAN_PRO_MONTHLY: 'mpplan_pro_m',
  MP_PLAN_PRO_ANNUAL: 'mpplan_pro_a',
  MP_PLAN_FULL_MONTHLY: 'mpplan_full_m',
  MP_PLAN_FULL_ANNUAL: 'mpplan_full_a',
}

export const TEST_PLANS: [string, number, number][] = [
  ['mpplan_basico_m', 15000, 1], ['mpplan_basico_a', 144000, 12],
  ['mpplan_pro_m', 25000, 1], ['mpplan_pro_a', 240000, 12],
  ['mpplan_full_m', 45000, 1], ['mpplan_full_a', 432000, 12],
]
