// ─────────────────────────────────────────────────────────────────────────────
// G2-C.3A2 · Fake de Supabase para los tests de autoridad de stock.
//
//   · Registra TODA operación de tabla (select / insert / update / upsert /
//     delete) con su payload y filtros: el test puede afirmar que ningún write
//     de inventory lleva stock y que nadie escribe inventory_movements.
//   · Emula la RPC A1 (apply_inventory_stock_adjustments_atomic) sobre un mapa
//     de stock en memoria con su contrato: idempotencia por (negocio, clave),
//     replay 'existing', conflicto de payload, stale por fila, noop sin
//     movimiento, negativos permitidos.
//
// No reemplaza la matriz SQL de A1 (tests/sql/g2c3a1_*.test.sql): sólo le da
// al frontend un servidor con la misma forma de respuesta.
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeOp {
  table:    string
  kind:     'select' | 'insert' | 'update' | 'upsert' | 'delete'
  payload?: unknown
  columns?: string
  filters:  Array<[string, string, unknown]>
  single:   boolean
  maybe:    boolean
}

export interface FakeRpc { fn: string; args: Record<string, any> }

export interface FakeState {
  ops:    FakeOp[]
  rpcs:   FakeRpc[]
  /** Stock "real" del servidor por inventory_id. */
  stock:  Map<string, number>
  /** Respuestas persistidas de A1 por clave. */
  a1:     Map<string, { hash: string; response: any }>
  /** Movimientos que "escribió" la RPC (server-side). */
  movements: Array<{ inventory_id: string; quantity: number; source: string; key: string }>
  seq:    number
  /** Hooks opcionales por test. */
  selectData?: (op: FakeOp) => unknown
  rpcOverride?: (fn: string, args: Record<string, any>) => { data: unknown; error: unknown } | undefined
  writeError?: (op: FakeOp) => { message: string; code?: string } | null
}

export function newFakeState(): FakeState {
  return { ops: [], rpcs: [], stock: new Map(), a1: new Map(), movements: [], seq: 0 }
}

export function resetFakeState(h: FakeState) {
  h.ops.length = 0
  h.rpcs.length = 0
  h.stock.clear()
  h.a1.clear()
  h.movements.length = 0
  h.seq = 0
  h.selectData = undefined
  h.rpcOverride = undefined
  h.writeError = undefined
}

function uuid(h: FakeState): string {
  h.seq++
  const n = String(h.seq).padStart(12, '0')
  return `aaaaaaaa-aaaa-4aaa-8aaa-${n}`
}

function applyA1(h: FakeState, args: Record<string, any>) {
  const key = String(args.p_idempotency_key)
  const hash = JSON.stringify({ b: args.p_business_id, s: args.p_source, r: args.p_reason ?? null, i: args.p_items })
  const prev = h.a1.get(`${args.p_business_id}:${key}`)
  if (prev) {
    if (prev.hash !== hash) {
      return { data: null, error: { message: 'IDEMPOTENCY_CONFLICT: esta clave ya se uso con un ajuste distinto', code: '23505', details: null, hint: null } }
    }
    return { data: { ...prev.response, status: 'existing' }, error: null }
  }
  const items = (args.p_items as any[]).map((it) => {
    const current = h.stock.get(it.inventory_id) ?? 0
    const mode = 'delta' in it ? 'delta' : 'target'
    const expected = 'expected' in it ? it.expected : null
    if (expected !== null && expected !== current) {
      return { inventory_id: it.inventory_id, status: 'stale', mode, delta: it.delta ?? null, target: it.target ?? null, expected,
        current_stock: current, previous_stock: current, new_stock: current, quantity: 0, movement_type: null, movement_id: null }
    }
    const next = mode === 'delta' ? current + it.delta : it.target
    const qty = next - current
    if (qty === 0) {
      return { inventory_id: it.inventory_id, status: 'noop', mode, delta: it.delta ?? null, target: it.target ?? null, expected,
        current_stock: current, previous_stock: current, new_stock: current, quantity: 0, movement_type: null, movement_id: null }
    }
    h.stock.set(it.inventory_id, next)
    h.movements.push({ inventory_id: it.inventory_id, quantity: qty, source: args.p_source, key })
    return { inventory_id: it.inventory_id, status: 'applied', mode, delta: it.delta ?? null, target: it.target ?? null, expected,
      current_stock: current, previous_stock: current, new_stock: next, quantity: qty,
      movement_type: args.p_source === 'initial_stock' ? (qty > 0 ? 'in' : 'out') : 'adjustment', movement_id: uuid(h) }
  })
  const response = {
    ok: true, status: 'created', request_id: uuid(h), business_id: args.p_business_id, idempotency_key: key,
    source: args.p_source, reason: args.p_reason ?? null, item_count: items.length,
    applied_count: items.filter((i) => i.status === 'applied').length,
    stale_count: items.filter((i) => i.status === 'stale').length,
    noop_count: items.filter((i) => i.status === 'noop').length,
    items,
  }
  h.a1.set(`${args.p_business_id}:${key}`, { hash, response })
  return { data: response, error: null }
}

export function makeSupabaseFake(h: FakeState) {
  function builder(table: string) {
    const op: FakeOp = { table, kind: 'select', filters: [], single: false, maybe: false }
    let recorded = false
    const record = () => { if (!recorded) { h.ops.push(op); recorded = true } }
    const b: any = {
      select(cols?: string) { if (op.kind === 'select') op.columns = cols; record(); return b },
      insert(p: unknown) { op.kind = 'insert'; op.payload = p; record(); return b },
      update(p: unknown) { op.kind = 'update'; op.payload = p; record(); return b },
      upsert(p: unknown) { op.kind = 'upsert'; op.payload = p; record(); return b },
      delete() { op.kind = 'delete'; record(); return b },
      eq(c: string, v: unknown) { op.filters.push(['eq', c, v]); return b },
      neq(c: string, v: unknown) { op.filters.push(['neq', c, v]); return b },
      in(c: string, v: unknown) { op.filters.push(['in', c, v]); return b },
      ilike(c: string, v: unknown) { op.filters.push(['ilike', c, v]); return b },
      or(v: unknown) { op.filters.push(['or', '', v]); return b },
      is(c: string, v: unknown) { op.filters.push(['is', c, v]); return b },
      gt() { return b }, gte() { return b }, lt() { return b }, lte() { return b },
      order() { return b }, limit() { return b }, range() { return b },
      single() { op.single = true; return b },
      maybeSingle() { op.maybe = true; return b },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve(respond(op)).then(res, rej)
      },
    }
    return b
  }

  function respond(op: FakeOp): { data: unknown; error: unknown } {
    if (op.kind !== 'select') {
      const err = h.writeError?.(op)
      if (err) return { data: null, error: err }
    }
    if (op.kind === 'insert') {
      const row = Array.isArray(op.payload) ? op.payload[0] : op.payload
      const id = uuid(h)
      h.stock.set(id, 0) // default de la columna: nace en 0
      return { data: op.single || op.maybe ? { ...(row as object), id, stock: 0, stock_quantity: 0 } : null, error: null }
    }
    if (op.kind === 'select') {
      const custom = h.selectData?.(op)
      if (custom !== undefined) return { data: custom, error: null }
      return { data: op.single || op.maybe ? null : [], error: null }
    }
    return { data: null, error: null }
  }

  return {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      h.rpcs.push({ fn, args })
      const o = h.rpcOverride?.(fn, args)
      if (o) return o
      if (fn === 'apply_inventory_stock_adjustments_atomic') return applyA1(h, args)
      return { data: null, error: null }
    },
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    channel: () => ({ on() { return this }, subscribe() { return this }, unsubscribe() {} }),
    removeChannel: () => {},
  }
}

/** Writes de inventory (insert/update/upsert). */
export const inventoryWrites = (h: FakeState) =>
  h.ops.filter((o) => o.table === 'inventory' && (o.kind === 'insert' || o.kind === 'update' || o.kind === 'upsert'))

/** ¿Algún payload lleva stock / stock_quantity? */
export function payloadHasStock(p: unknown): boolean {
  const rows = Array.isArray(p) ? p : [p]
  return rows.some((r) => r && typeof r === 'object' && ('stock' in (r as object) || 'stock_quantity' in (r as object)))
}

export const a1Calls = (h: FakeState) => h.rpcs.filter((r) => r.fn === 'apply_inventory_stock_adjustments_atomic')
