// ─────────────────────────────────────────────────────────────────────────────
// P0 final pre-M8 — ciclo de vida de los canales Realtime.
//
// Los 15 casos del contrato. TODOS tienen que fallar contra el lifecycle
// anterior (topic estatico + `.on()` post-subscribe + removeChannel ignorado);
// el fake de tests/components/fakes/realtimeFake.ts reproduce a proposito los
// tres comportamientos de realtime-js que causaron el P0, asi que un test verde
// aca significa que el modulo los sortea, no que el fake sea amable.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { StrictMode, useEffect } from 'react'
import { crearSupabaseFake, type FakeSupabase } from './fakes/realtimeFake'

// El modulo bajo prueba importa `supabase` de ../lib/supabase: lo interceptamos
// ANTES de importarlo. `vi.hoisted` para que el fake exista al evaluar el mock.
const estado = vi.hoisted(() => ({ fake: null as unknown as FakeSupabase }))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: (t: string) => estado.fake.channel(t),
    removeChannel: (c: never) => estado.fake.removeChannel(c),
  },
}))

vi.mock('../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  subscribeShared,
  activeSharedChannelCount,
  activeSharedChannelTopics,
  __resetSharedChannels,
  type RealtimeStatus,
} from '../../src/lib/realtimeChannel'

const BIZ_A = '11111111-1111-1111-1111-111111111111'
const BIZ_B = '22222222-2222-2222-2222-222222222222'

const specSub = (biz: string) => ({
  key: `subscription:${biz}`,
  bindings: [
    { event: 'UPDATE' as const, table: 'businesses', filter: `id=eq.${biz}` },
    { event: 'INSERT' as const, table: 'payments', filter: `business_id=eq.${biz}` },
  ],
})

beforeEach(() => {
  estado.fake = crearSupabaseFake()
  __resetSharedChannels()
})

afterEach(() => {
  __resetSharedChannels()
})

describe('lifecycle de canales Realtime', () => {
  // ── 1 ──────────────────────────────────────────────────────────────────────
  it('1. todos los `on` ocurren ANTES del subscribe', () => {
    subscribeShared(specSub(BIZ_A), {})

    const idxSubscribe = estado.fake.traza.findIndex(t => t.tipo === 'subscribe')
    const idxUltimoOn = estado.fake.traza.map(t => t.tipo).lastIndexOf('on')

    expect(idxSubscribe).toBeGreaterThan(-1)
    expect(idxUltimoOn).toBeGreaterThan(-1)
    expect(idxUltimoOn).toBeLessThan(idxSubscribe)
  })

  // ── 2 ──────────────────────────────────────────────────────────────────────
  it('2. subscribe se llama UNA sola vez aunque haya N consumidores', () => {
    subscribeShared(specSub(BIZ_A), {})
    subscribeShared(specSub(BIZ_A), {})
    subscribeShared(specSub(BIZ_A), {})
    subscribeShared(specSub(BIZ_A), {})
    subscribeShared(specSub(BIZ_A), {})   // los 5 de /orders

    const subs = estado.fake.traza.filter(t => t.tipo === 'subscribe')
    expect(subs).toHaveLength(1)
    expect(estado.fake.historial[0].subscribeCount).toBe(1)
  })

  // ── 3 ──────────────────────────────────────────────────────────────────────
  it('3. contratos distintos NO colisionan de topic', () => {
    subscribeShared(specSub(BIZ_A), {})
    subscribeShared({ key: `notifications:${BIZ_A}`, bindings: [
      { event: 'INSERT', table: 'notifications', filter: `business_id=eq.${BIZ_A}` },
    ] }, {})

    const topics = activeSharedChannelTopics()
    expect(new Set(topics).size).toBe(topics.length)
    expect(activeSharedChannelCount()).toBe(2)
  })

  // ── 4 ──────────────────────────────────────────────────────────────────────
  it('4. instancias equivalentes comparten UN canal; un contrato distinto no', () => {
    subscribeShared(specSub(BIZ_A), {})
    subscribeShared(specSub(BIZ_A), {})
    expect(activeSharedChannelCount()).toBe(1)

    // Misma clave logica pero OTROS bindings: no puede compartir en silencio.
    subscribeShared({
      key: `subscription:${BIZ_A}`,
      bindings: [{ event: 'DELETE', table: 'payments', filter: `business_id=eq.${BIZ_A}` }],
    }, {})
    expect(activeSharedChannelCount()).toBe(2)
  })

  // ── 5 ──────────────────────────────────────────────────────────────────────
  it('5. el refcount cuenta consumidores, no montajes de canal', () => {
    const a = subscribeShared(specSub(BIZ_A), {})
    const b = subscribeShared(specSub(BIZ_A), {})
    const c = subscribeShared(specSub(BIZ_A), {})
    expect(estado.fake.traza.filter(t => t.tipo === 'channel' && !t.reutilizado)).toHaveLength(1)

    a(); b()
    expect(activeSharedChannelCount()).toBe(1)   // todavia queda `c`
    c()
    expect(activeSharedChannelCount()).toBe(0)
  })

  // ── 6 ──────────────────────────────────────────────────────────────────────
  it('6. una instancia se desmonta y el canal SIGUE vivo si queda otra', () => {
    const recibidosA: unknown[] = []
    const recibidosB: unknown[] = []
    const a = subscribeShared(specSub(BIZ_A), { onEvent: p => recibidosA.push(p) })
    subscribeShared(specSub(BIZ_A), { onEvent: p => recibidosB.push(p) })

    a()
    estado.fake.historial[0].emitir({ new: { id: 'x' } })

    expect(recibidosA).toHaveLength(0)   // el que se fue no recibe mas
    expect(recibidosB).toHaveLength(1)   // el que queda sigue recibiendo
    expect(estado.fake.traza.filter(t => t.tipo === 'removeChannel')).toHaveLength(0)
  })

  // ── 7 ──────────────────────────────────────────────────────────────────────
  it('7. el ULTIMO consumidor en irse retira el canal', () => {
    const a = subscribeShared(specSub(BIZ_A), {})
    const b = subscribeShared(specSub(BIZ_A), {})
    a()
    expect(estado.fake.traza.filter(t => t.tipo === 'removeChannel')).toHaveLength(0)
    b()
    expect(estado.fake.traza.filter(t => t.tipo === 'removeChannel')).toHaveLength(1)
    expect(activeSharedChannelCount()).toBe(0)
  })

  // ── 8 ──────────────────────────────────────────────────────────────────────
  it('8. cambiar el filtro crea un contrato NUEVO', () => {
    subscribeShared({
      key: 'notifications:x',
      bindings: [{ event: 'INSERT', table: 'notifications', filter: `business_id=eq.${BIZ_A}` }],
    }, {})
    subscribeShared({
      key: 'notifications:x',
      bindings: [{ event: 'INSERT', table: 'notifications', filter: `business_id=eq.${BIZ_B}` }],
    }, {})

    expect(activeSharedChannelCount()).toBe(2)
  })

  // ── 9 ──────────────────────────────────────────────────────────────────────
  it('9. StrictMode no deja canales huerfanos ni duplica callbacks', () => {
    const recibidos: unknown[] = []

    function Consumidor() {
      useEffect(() => subscribeShared(specSub(BIZ_A), { onEvent: p => recibidos.push(p) }), [])
      return null
    }

    render(<StrictMode><Consumidor /></StrictMode>)

    // StrictMode monta, desmonta y remonta: tiene que quedar UN canal vivo.
    expect(activeSharedChannelCount()).toBe(1)

    // Y el consumidor recibe el evento UNA sola vez, no dos.
    const vivo = estado.fake.historial[estado.fake.historial.length - 1]
    act(() => { vivo.emitir({ new: { id: 'n1' } }) })
    expect(recibidos).toHaveLength(1)
  })

  // ── 10 ─────────────────────────────────────────────────────────────────────
  it('10. removeChannel ASINCRONO no permite reutilizar el canal moribundo', () => {
    const a = subscribeShared(specSub(BIZ_A), {})
    const topicViejo = activeSharedChannelTopics()[0]

    a()   // dispara removeChannel, que NO resuelve todavia
    expect(estado.fake.bajasPendientes).toHaveLength(1)

    // Un consumidor que llega durante la baja tiene que obtener un canal NUEVO.
    subscribeShared(specSub(BIZ_A), {})
    const topicNuevo = activeSharedChannelTopics()[0]

    expect(topicNuevo).not.toBe(topicViejo)
    // Y no se reutilizo ninguna instancia del cliente.
    expect(estado.fake.traza.filter(t => t.tipo === 'channel' && t.reutilizado)).toHaveLength(0)
  })

  // ── 11 ─────────────────────────────────────────────────────────────────────
  it('11. un evento TARDIO no llega a un consumidor dado de baja', () => {
    const recibidos: unknown[] = []
    const baja = subscribeShared(specSub(BIZ_A), { onEvent: p => recibidos.push(p) })
    const canal = estado.fake.historial[0]

    baja()
    // El server todavia no confirmo el leave y empuja un evento.
    canal.emitir({ new: { id: 'tardio' } })

    expect(recibidos).toHaveLength(0)
  })

  // ── 12 ─────────────────────────────────────────────────────────────────────
  it('12. channel_error se propaga como estado y NO tira', () => {
    const estados: RealtimeStatus[] = []
    subscribeShared(specSub(BIZ_A), { onStatus: s => estados.push(s) })

    expect(() => estado.fake.historial[0].emitirEstado('CHANNEL_ERROR')).not.toThrow()
    expect(estados).toContain('channel_error')
    // El canal sigue registrado: el consumidor decide, el modulo no lo mata.
    expect(activeSharedChannelCount()).toBe(1)
  })

  // ── 13 ─────────────────────────────────────────────────────────────────────
  it('13. un re-subscribe del mismo contrato no agrega listeners', () => {
    subscribeShared(specSub(BIZ_A), {})
    const onsIniciales = estado.fake.traza.filter(t => t.tipo === 'on').length

    subscribeShared(specSub(BIZ_A), {})
    subscribeShared(specSub(BIZ_A), {})

    // Los consumidores nuevos se anotan en el Set del modulo, NUNCA en el canal.
    expect(estado.fake.traza.filter(t => t.tipo === 'on')).toHaveLength(onsIniciales)
  })

  // ── 14 ─────────────────────────────────────────────────────────────────────
  it('14. businessId A y B NO comparten canal', () => {
    const recibidosA: unknown[] = []
    const recibidosB: unknown[] = []
    subscribeShared(specSub(BIZ_A), { onEvent: p => recibidosA.push(p) })
    subscribeShared(specSub(BIZ_B), { onEvent: p => recibidosB.push(p) })

    expect(activeSharedChannelCount()).toBe(2)

    // Un evento del canal de A no puede aparecer en el consumidor de B.
    estado.fake.historial[0].emitir({ new: { id: 'de-A' } })
    expect(recibidosA).toHaveLength(1)
    expect(recibidosB).toHaveLength(0)
  })

  // ── 15 ─────────────────────────────────────────────────────────────────────
  it('15. NINGUNA llamada a `on` ocurre despues de un subscribe', () => {
    // Escenario completo: 5 consumidores, altas y bajas intercaladas, dos
    // negocios y un remonte. Es el que reventaba con el topic estatico.
    const a = subscribeShared(specSub(BIZ_A), {})
    subscribeShared(specSub(BIZ_A), {})
    subscribeShared(specSub(BIZ_B), {})
    a()
    subscribeShared(specSub(BIZ_A), {})
    subscribeShared(specSub(BIZ_B), {})

    // Se recorre la traza real: para cada topic, ningun `on` puede venir
    // despues de su `subscribe`.
    const yaSuscripto = new Set<string>()
    for (const t of estado.fake.traza) {
      if (t.tipo === 'subscribe') yaSuscripto.add(t.topic)
      if (t.tipo === 'on' && yaSuscripto.has(t.topic)) {
        throw new Error('`on` despues de subscribe en ' + t.topic)
      }
    }
    // Y ningun canal recibio dos subscribe.
    for (const ch of estado.fake.historial) expect(ch.subscribeCount).toBeLessThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Prueba de que los tests de arriba DISCRIMINAN: se reproduce el lifecycle
// anterior (el de main en bca8e31) contra el MISMO fake y se verifica que rompe.
// Sin esto, 17 tests verdes no demostrarian nada.
// ─────────────────────────────────────────────────────────────────────────────
describe('regresion: el lifecycle ANTERIOR rompe contra el mismo fake', () => {
  /** Copia literal del patron de useSubscription en bca8e31: topic estatico. */
  function suscribirComoAntes(biz: string) {
    return estado.fake
      .channel(`subscription:${biz}`)                       // topic ESTATICO
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'businesses', filter: `id=eq.${biz}` },
        () => {})
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'payments', filter: `business_id=eq.${biz}` },
        () => {})
      .subscribe()
  }

  it('el 2do consumidor del topic estatico explota con "after subscribe()"', () => {
    suscribirComoAntes(BIZ_A)   // 1er consumidor: crea y suscribe
    expect(() => suscribirComoAntes(BIZ_A))   // 2do: recibe el MISMO canal ya joined
      .toThrow(/after `subscribe\(\)`/)
  })

  it('con 5 consumidores (el caso de /orders) sobrevive solo el primero', () => {
    let rotos = 0
    for (let i = 0; i < 5; i++) {
      try { suscribirComoAntes(BIZ_A) } catch { rotos++ }
    }
    expect(rotos).toBe(4)   // 4 de 5 se quedan sin realtime, en silencio
  })

  it('`Date.now()` como sufijo colisiona si dos montajes caen en el mismo ms', () => {
    // El patron de useNotifications en bca8e31. Con el reloj congelado —que es
    // lo que pasa dentro de un mismo tick de React— los dos topics son iguales.
    vi.useFakeTimers()
    try {
      const t1 = `notifications:${BIZ_A}:${Date.now()}`
      const t2 = `notifications:${BIZ_A}:${Date.now()}`
      expect(t1).toBe(t2)   // ← misma clave: el canal se reutiliza

      estado.fake.channel(t1)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, () => {})
        .subscribe()
      expect(() => estado.fake.channel(t2)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, () => {}))
        .toThrow(/after `subscribe\(\)`/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('el contador monotono del modulo NO colisiona con el reloj congelado', () => {
    // Mismo escenario, pero con subscribeShared: alta, baja y alta inmediata
    // dentro del mismo milisegundo.
    vi.useFakeTimers()
    try {
      const baja = subscribeShared(specSub(BIZ_A), {})
      const topic1 = activeSharedChannelTopics()[0]
      baja()
      subscribeShared(specSub(BIZ_A), {})
      const topic2 = activeSharedChannelTopics()[0]
      expect(topic2).not.toBe(topic1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Recuperacion ACOTADA tras un corte. Medido en el smoke local: al detener el
// contenedor de realtime, el canal cae en timed_out y NO vuelve solo a
// subscribed — los eventos se cortan hasta recargar la pagina.
// ─────────────────────────────────────────────────────────────────────────────
describe('recuperacion tras channel_error / timed_out', () => {
  it('recrea el canal con backoff y vuelve a quedar operativo', () => {
    vi.useFakeTimers()
    try {
      const estados: RealtimeStatus[] = []
      subscribeShared(specSub(BIZ_A), { onStatus: s => estados.push(s) })
      const topicInicial = activeSharedChannelTopics()[0]

      estado.fake.historial[0].emitirEstado('CHANNEL_ERROR')
      expect(estados).toContain('channel_error')

      // Antes del backoff no se toca nada.
      vi.advanceTimersByTime(1_000)
      expect(activeSharedChannelTopics()[0]).toBe(topicInicial)

      // Al cumplirse, se crea un canal NUEVO (nunca se reusa el errado).
      vi.advanceTimersByTime(1_500)
      const topicNuevo = activeSharedChannelTopics()[0]
      expect(topicNuevo).not.toBe(topicInicial)
      expect(estados).toContain('subscribed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('el canal recreado registra sus `on` ANTES del subscribe', () => {
    vi.useFakeTimers()
    try {
      subscribeShared(specSub(BIZ_A), {})
      estado.fake.historial[0].emitirEstado('TIMED_OUT')
      vi.advanceTimersByTime(2_000)

      const yaSuscripto = new Set<string>()
      for (const t of estado.fake.traza) {
        if (t.tipo === 'subscribe') yaSuscripto.add(t.topic)
        if (t.tipo === 'on' && yaSuscripto.has(t.topic)) {
          throw new Error('`on` despues de subscribe en ' + t.topic)
        }
      }
      for (const ch of estado.fake.historial) expect(ch.subscribeCount).toBeLessThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('los reintentos son FINITOS: no hay retry infinito', () => {
    vi.useFakeTimers()
    try {
      // El fake falla al crear, asi que cada reintento vuelve a fallar.
      const original = estado.fake.channel.bind(estado.fake)
      estado.fake.channel = () => { throw new Error('realtime caido') }

      subscribeShared(specSub(BIZ_A), {})
      // Muy por encima de la suma del backoff (2+5+15+30 = 52s).
      vi.advanceTimersByTime(600_000)

      // 1 alta + 4 reintentos como maximo. Sin tope esto seria ilimitado.
      const intentos = estado.fake.traza.filter(t => t.tipo === 'channel').length
      expect(intentos).toBeLessThanOrEqual(5)
      estado.fake.channel = original
    } finally {
      vi.useRealTimers()
    }
  })

  it('una reconexion exitosa renueva el presupuesto de reintentos', () => {
    vi.useFakeTimers()
    try {
      subscribeShared(specSub(BIZ_A), {})
      // Primer corte -> se recupera.
      estado.fake.historial[0].emitirEstado('CHANNEL_ERROR')
      vi.advanceTimersByTime(2_000)
      const trasPrimera = estado.fake.traza.filter(t => t.tipo === 'channel').length

      // Segundo corte: si el contador no se hubiera reseteado, el backoff
      // arrancaria en 5s y no en 2s.
      estado.fake.historial[estado.fake.historial.length - 1].emitirEstado('CHANNEL_ERROR')
      vi.advanceTimersByTime(2_000)
      expect(estado.fake.traza.filter(t => t.tipo === 'channel').length).toBe(trasPrimera + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('el cleanup CANCELA el reintento pendiente (no revive un canal muerto)', () => {
    vi.useFakeTimers()
    try {
      const baja = subscribeShared(specSub(BIZ_A), {})
      estado.fake.historial[0].emitirEstado('CHANNEL_ERROR')
      baja()
      expect(activeSharedChannelCount()).toBe(0)

      vi.advanceTimersByTime(600_000)
      // Ningun canal nuevo despues de la baja.
      expect(activeSharedChannelCount()).toBe(0)
      expect(estado.fake.traza.filter(t => t.tipo === 'channel')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tras recuperarse, los eventos vuelven a llegar a los consumidores', () => {
    vi.useFakeTimers()
    try {
      const recibidos: unknown[] = []
      subscribeShared(specSub(BIZ_A), { onEvent: p => recibidos.push(p) })

      estado.fake.historial[0].emitirEstado('CHANNEL_ERROR')
      vi.advanceTimersByTime(2_000)

      const vivo = estado.fake.historial[estado.fake.historial.length - 1]
      vivo.emitir({ new: { id: 'post-recuperacion' } })
      expect(recibidos).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('resiliencia', () => {
  it('un fallo creando el canal NO rompe al consumidor', () => {
    // El cliente explota (realtime caido, cliente sin inicializar…).
    const original = estado.fake.channel.bind(estado.fake)
    estado.fake.channel = () => { throw new Error('realtime caido') }

    const estados: RealtimeStatus[] = []
    let baja: (() => void) | null = null
    expect(() => { baja = subscribeShared(specSub(BIZ_A), { onStatus: s => estados.push(s) }) }).not.toThrow()

    expect(estados).toContain('channel_error')
    expect(() => baja?.()).not.toThrow()
    estado.fake.channel = original
  })

  it('un callback de consumidor que tira no tumba a los demas', () => {
    const recibidos: unknown[] = []
    subscribeShared(specSub(BIZ_A), { onEvent: () => { throw new Error('consumidor roto') } })
    subscribeShared(specSub(BIZ_A), { onEvent: p => recibidos.push(p) })

    expect(() => estado.fake.historial[0].emitir({ new: { id: 'x' } })).not.toThrow()
    expect(recibidos).toHaveLength(1)
  })
})
