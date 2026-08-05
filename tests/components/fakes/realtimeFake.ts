// ─────────────────────────────────────────────────────────────────────────────
// Cliente Supabase FALSO que reproduce los tres comportamientos de
// @supabase/realtime-js 2.x que causaron el P0, y que registra el ORDEN de las
// llamadas para poder afirmar sobre el ciclo de vida.
//
// Reproducidos a proposito (si el fake fuera "amable", los tests no probarian
// nada):
//   1. `channel(topic)` devuelve la MISMA instancia si el topic ya esta
//      registrado (RealtimeClient.js:294-305).
//   2. `.on('postgres_changes', ...)` TIRA si el canal ya esta joined/joining
//      (RealtimeChannel.js:372-379).
//   3. `removeChannel()` es ASINCRONO: el canal recien sale del registro cuando
//      resuelve la promesa (RealtimeChannel.js:86-88).
// ─────────────────────────────────────────────────────────────────────────────

export type Traza =
  | { tipo: 'channel'; topic: string; reutilizado: boolean }
  | { tipo: 'on'; topic: string; table: string; event: string; filter?: string }
  | { tipo: 'subscribe'; topic: string }
  | { tipo: 'removeChannel'; topic: string }

export interface FakeChannel {
  topic: string
  estado: 'idle' | 'joining' | 'joined' | 'closed'
  bindings: Array<{ table: string; event: string; filter?: string }>
  callbacks: Array<(payload: unknown) => void>
  statusCb: ((estado: string) => void) | null
  subscribeCount: number
  on(tipo: string, filtro: Record<string, string>, cb: (payload: unknown) => void): FakeChannel
  subscribe(cb?: (estado: string) => void): FakeChannel
  /**
   * Empuja UN evento. Igual que realtime-js, el evento se rutea al binding que
   * le corresponde, no a todos: un canal con bindings sobre `businesses` y
   * `payments` no entrega un cambio de `businesses` al callback de `payments`.
   * Sin `tabla` se usa el primer binding.
   */
  emitir(payload: unknown, tabla?: string): void
  /** Fuerza una transicion de estado (channel_error, timed_out, …). */
  emitirEstado(estado: string): void
}

export interface FakeSupabase {
  traza: Traza[]
  canales: Map<string, FakeChannel>
  /** Canales creados alguna vez, incluidos los ya retirados. */
  historial: FakeChannel[]
  channel(topic: string): FakeChannel
  removeChannel(ch: FakeChannel): Promise<'ok'>
  /** Promesas de removeChannel pendientes, para probar la asincronia. */
  bajasPendientes: Array<() => void>
  /** Resuelve todas las bajas pendientes. */
  vaciarBajas(): void
}

export function crearSupabaseFake(): FakeSupabase {
  const traza: Traza[] = []
  const canales = new Map<string, FakeChannel>()
  const historial: FakeChannel[] = []
  const bajasPendientes: Array<() => void> = []

  function crearCanal(topic: string): FakeChannel {
    const ch: FakeChannel = {
      topic,
      estado: 'idle',
      bindings: [],
      callbacks: [],
      statusCb: null,
      subscribeCount: 0,

      on(tipo, filtro, cb) {
        // (2) El comportamiento que rompia: no se pueden agregar callbacks
        // postgres_changes despues del subscribe().
        if (tipo === 'postgres_changes' && (ch.estado === 'joined' || ch.estado === 'joining')) {
          throw new Error(
            `tried to subscribe multiple times. 'subscribe' can only be called a single time per channel instance: ` +
            `cannot add \`postgres_changes\` callbacks for ${topic} after \`subscribe()\`.`,
          )
        }
        ch.bindings.push({ table: filtro.table, event: filtro.event, filter: filtro.filter })
        ch.callbacks.push(cb)
        traza.push({ tipo: 'on', topic, table: filtro.table, event: filtro.event, filter: filtro.filter })
        return ch
      },

      subscribe(cb) {
        ch.subscribeCount += 1
        ch.estado = 'joining'
        ch.statusCb = cb ?? null
        traza.push({ tipo: 'subscribe', topic })
        // El server confirma: pasamos a joined y avisamos.
        ch.estado = 'joined'
        cb?.('SUBSCRIBED')
        return ch
      },

      emitir(payload, tabla) {
        const destino = tabla ?? ch.bindings[0]?.table
        for (let i = 0; i < ch.callbacks.length; i++) {
          if (ch.bindings[i]?.table === destino) ch.callbacks[i](payload)
        }
      },

      emitirEstado(estado) {
        ch.statusCb?.(estado)
      },
    }
    return ch
  }

  return {
    traza,
    canales,
    historial,
    bajasPendientes,

    channel(topic: string): FakeChannel {
      // (1) Reutilizacion por topic: la causa raiz del P0.
      const existente = canales.get(topic)
      if (existente) {
        traza.push({ tipo: 'channel', topic, reutilizado: true })
        return existente
      }
      const ch = crearCanal(topic)
      canales.set(topic, ch)
      historial.push(ch)
      traza.push({ tipo: 'channel', topic, reutilizado: false })
      return ch
    },

    removeChannel(ch: FakeChannel): Promise<'ok'> {
      traza.push({ tipo: 'removeChannel', topic: ch.topic })
      // (3) ASINCRONO: el canal sigue en el registro hasta que se resuelva.
      return new Promise(resolve => {
        bajasPendientes.push(() => {
          ch.estado = 'closed'
          if (canales.get(ch.topic) === ch) canales.delete(ch.topic)
          resolve('ok')
        })
      })
    },

    vaciarBajas() {
      const pendientes = bajasPendientes.splice(0, bajasPendientes.length)
      for (const f of pendientes) f()
    },
  }
}
