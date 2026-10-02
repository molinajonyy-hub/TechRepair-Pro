// ─────────────────────────────────────────────────────────────────────────────
// BETA-MP · Mercado Pago simulado, a nivel HTTP.
//
// Responde a las mismas rutas que usa `_shared/billing/mpClient.ts`, así que el
// cliente real (URLs, headers, cuerpo del POST, parseo, manejo de 404/5xx)
// también queda bajo prueba. Lo comparten los tests de vitest y la matriz contra
// el stack local (`scripts/billing/beta-mp-local.mjs`), por eso usa sólo sintaxis
// TypeScript borrable: Node lo importa sin transpilar.
//
// NO es Mercado Pago. Modela lo que la documentación dice de cada endpoint más lo
// que se midió en el smoke real del 2026-10-02 (ver `dropsExternalReference`).
// ─────────────────────────────────────────────────────────────────────────────

export type MpRow = Record<string, unknown>
export interface MpCall { method: string; path: string; body?: MpRow; idempotencyKey?: string | null }

export const FAKE_MP_TOKEN = 'TEST-token'

const CHECKOUT_BASE = 'https://www.mercadopago.com.ar/subscriptions/checkout'

export class FakeMercadoPago {
  preapprovals = new Map<string, MpRow>()
  authorizedPayments = new Map<string, MpRow>()
  payments = new Map<string, MpRow>()
  calls: MpCall[] = []
  /** Mercado Pago caído: todas las llamadas responden 500. */
  down = false
  /** El PUT de cancelación responde 200 pero MP no cambia el estado. */
  cancelIsIgnored = false
  /** El PUT de cancelación responde 500. */
  cancelFails = false
  /** `POST /preapproval` responde este status con un cuerpo de error de MP. */
  createFailsWith: number | null = null
  /**
   * Mercado Pago NO devuelve `external_reference` (ni al crear ni al leer). Es lo
   * que se midió en el smoke real del 2026-10-02 para el checkout de un plan:
   * el preapproval quedó `authorized` con la referencia vacía.
   */
  dropsExternalReference = false
  /** Altera la respuesta de `POST /preapproval` antes de devolverla (y de guardarla). */
  tamperCreated: ((row: MpRow) => void) | null = null
  /** Ids que usará `POST /preapproval`, en orden. Sin cola: `pre_auto_<n>`. */
  nextIds: string[] = []
  now: () => Date
  private seq = 0

  constructor(now: () => Date) {
    this.now = now
  }

  callsTo(method: string, pathPrefix: string): MpCall[] {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix))
  }

  /** Los `POST /preapproval` que llegaron, con su cuerpo. */
  created(): MpCall[] {
    return this.calls.filter((c) => c.method === 'POST' && c.path === '/preapproval')
  }

  private view(row: MpRow): MpRow {
    return this.dropsExternalReference ? { ...row, external_reference: '' } : row
  }

  fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) as MpRow : undefined
    this.calls.push({ method, path: url.pathname + url.search, body, idempotencyKey: headers.get('x-idempotency-key') })
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status })
    if (this.down) return json({ message: 'internal error' }, 500)
    if (headers.get('authorization') !== `Bearer ${FAKE_MP_TOKEN}`) return json({ message: 'unauthorized' }, 401)

    if (method === 'POST' && url.pathname === '/preapproval') {
      if (this.createFailsWith !== null) {
        return json({ message: 'Invalid value for payer_email: alguien@invalid.test', error: 'bad_request', status: this.createFailsWith }, this.createFailsWith)
      }
      const request = body ?? {}
      // La misma clave de idempotencia devuelve el mismo recurso.
      const key = headers.get('x-idempotency-key')
      const replay = key ? [...this.preapprovals.values()].find((p) => p.__idempotency_key === key) : undefined
      if (replay) return json(this.view(replay), 201)

      const id = this.nextIds.shift() ?? `pre_auto_${(this.seq += 1)}`
      const nowIso = this.now().toISOString()
      const row: MpRow = {
        id, status: request.status ?? 'pending', preapproval_plan_id: null,
        reason: request.reason ?? null,
        external_reference: request.external_reference ?? null,
        payer_email: request.payer_email ?? null,
        back_url: request.back_url ?? null,
        auto_recurring: request.auto_recurring ?? null,
        date_created: nowIso, last_modified: nowIso, next_payment_date: null,
        init_point: `${CHECKOUT_BASE}?preapproval_id=${id}`,
        __idempotency_key: key,
      }
      this.tamperCreated?.(row)
      if (typeof row.id === 'string' && row.id) this.preapprovals.set(row.id, row)
      return json(this.view(row), 201)
    }

    const one = (prefix: string, store: Map<string, MpRow>, map: (row: MpRow) => MpRow = (row) => row) => {
      if (!url.pathname.startsWith(prefix)) return null
      const row = store.get(decodeURIComponent(url.pathname.slice(prefix.length)))
      return row ? json(map(row)) : json({ message: 'not found' }, 404)
    }
    if (method === 'PUT' && url.pathname.startsWith('/preapproval/')) {
      const row = this.preapprovals.get(decodeURIComponent(url.pathname.slice('/preapproval/'.length)))
      if (!row) return json({ message: 'not found' }, 404)
      if (this.cancelFails) return json({ message: 'internal error' }, 500)
      if (!this.cancelIsIgnored && body?.status === 'cancelled') {
        row.status = 'cancelled'
        row.last_modified = this.now().toISOString()
      }
      return json(this.view(row))
    }
    if (method === 'GET') {
      return one('/preapproval/', this.preapprovals, (row) => this.view(row))
        ?? one('/authorized_payments/', this.authorizedPayments) ?? one('/v1/payments/', this.payments)
        ?? json({ message: 'not found' }, 404)
    }
    return json({ message: 'not found' }, 404)
  }

  /** Quien abrió el checkout completó el pago: el preapproval pasa a `authorized`. */
  authorize(id: string, patch: MpRow = {}): MpRow {
    const row = this.preapprovals.get(id)
    if (!row) throw new Error(`Mercado Pago simulado: no existe el preapproval ${id}`)
    const now = this.now()
    Object.assign(row, {
      status: 'authorized', last_modified: now.toISOString(),
      next_payment_date: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }, patch)
    return row
  }

  /**
   * Un preapproval que existe en la cuenta de Mercado Pago pero que el servidor
   * NO creó (otra app, un plan del panel, el checkout por URL del Plan A).
   */
  seedForeignPreapproval(id: string, patch: MpRow = {}): MpRow {
    const nowIso = this.now().toISOString()
    const row: MpRow = {
      id, status: 'authorized', preapproval_plan_id: null, external_reference: null,
      payer_email: 'pagador@invalid.test', date_created: nowIso, last_modified: nowIso,
      next_payment_date: new Date(this.now().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      init_point: `${CHECKOUT_BASE}?preapproval_id=${id}`,
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 25000, currency_id: 'ARS' },
      ...patch,
    }
    this.preapprovals.set(id, row)
    return row
  }
}
