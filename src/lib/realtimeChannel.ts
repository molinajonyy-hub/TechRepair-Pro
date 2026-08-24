/**
 * realtimeChannel — dueño único del ciclo de vida de los canales Realtime.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * `RealtimeClient.channel(topic)` NO crea siempre un canal nuevo: si ya hay uno
 * registrado con ese topic, devuelve **la misma instancia**
 * (node_modules/@supabase/realtime-js/dist/module/RealtimeClient.js:294-305).
 * Y `RealtimeChannel.on()` tira si el canal ya está `joined()`/`joining()`
 * (RealtimeChannel.js:372-379):
 *
 *     cannot add `postgres_changes` callbacks for <topic> after `subscribe()`.
 *
 * Con un topic estático y N componentes montados a la vez (en /orders son 5
 * consumidores de useSubscription: Sidebar, useWholesalePermissions dentro del
 * propio Sidebar, SubscriptionGuard y SubscriptionBanner) el 1º
 * crea y suscribe el canal y del 2º en adelante reciben ESE canal ya suscripto
 * → su `.on()` explota y se quedan sin realtime en silencio.
 *
 * Agrava el problema que `removeChannel()` es asíncrono: el canal recién sale
 * del registro cuando el server confirma el leave (`socket._remove` desde el
 * handler `_onClose`, RealtimeChannel.js:86-88). O sea que un cleanup + remonte
 * inmediato (React StrictMode) también se topa con el canal viejo todavía vivo.
 *
 * ── Contrato que garantiza este módulo ──────────────────────────────────────
 * 1. Un solo canal por CONTRATO (clave lógica + bindings), compartido por
 *    refcount entre consumidores.
 * 2. Topic físico único por instancia (`clave#N`): un canal que se está dando de
 *    baja NUNCA puede ser devuelto para uno nuevo.
 * 3. Todos los `.on()` se registran ANTES del único `.subscribe()`.
 * 4. Jamás se agrega un callback a un canal ya suscripto: los consumidores se
 *    anotan en un Set propio, no en el canal.
 * 5. El cleanup retira el canal e invalida los callbacks tardíos (`disposed`).
 * 6. La entrada se borra del registro de forma SÍNCRONA, así un consumidor que
 *    llega durante la baja arranca una instancia nueva y limpia.
 * 7. Un fallo creando el canal NO rompe al consumidor: degrada a `channel_error`
 *    y la carga HTTP inicial sigue funcionando.
 * 8. Recuperacion ACOTADA: un canal que cae en `channel_error`/`timed_out` NO
 *    vuelve solo a `subscribed` (medido: se cortan los eventos hasta recargar la
 *    pagina). Se recrea con backoff y un tope de intentos — nunca un retry
 *    infinito — y al recuperarse avisa `subscribed` para que el consumidor
 *    recargue por HTTP lo que se haya perdido durante el corte.
 */

import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { logger } from './logger'

// ─── Tipos públicos ──────────────────────────────────────────────────────────

/** Estados explícitos del canal, normalizados desde realtime-js. */
export type RealtimeStatus =
  | 'idle'
  | 'connecting'
  | 'subscribed'
  | 'closed'
  | 'channel_error'
  | 'timed_out'

export type PostgresEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*'

export interface PostgresBinding {
  event: PostgresEvent
  table: string
  schema?: string
  filter?: string
}

export interface SharedChannelSpec {
  /** Clave lógica de deduplicación, p. ej. `subscription:<businessId>`. */
  key: string
  bindings: PostgresBinding[]
}

export type RealtimeEventPayload = RealtimePostgresChangesPayload<Record<string, unknown>>

export interface SharedChannelSubscriber {
  onEvent?: (payload: RealtimeEventPayload, binding: PostgresBinding) => void
  onStatus?: (status: RealtimeStatus) => void
}

// ─── Registro interno ────────────────────────────────────────────────────────

interface Entry {
  /** Clave de deduplicación = clave lógica + huella de los bindings. */
  dedupeKey: string
  key: string
  topic: string
  channel: RealtimeChannel | null
  bindings: PostgresBinding[]
  subscribers: Set<SharedChannelSubscriber>
  status: RealtimeStatus
  disposed: boolean
  /** Última condición de error logueada, para no repetir ruido por render. */
  loggedFailure: RealtimeStatus | null
  /** Reintentos de recuperación ya consumidos. Se resetea al reconectar. */
  intentos: number
  /** Timer del reintento pendiente, para poder cancelarlo en el cleanup. */
  timer: ReturnType<typeof setTimeout> | null
}

const entries = new Map<string, Entry>()

/**
 * Backoff de recuperación. Longitud finita A PROPÓSITO: después del último
 * intento el canal se queda en su estado de fallo y el consumidor sigue con la
 * carga HTTP y el refresh manual. Un retry infinito castigaría al servidor
 * justo cuando está caído.
 */
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000] as const

/**
 * Contador monótono para el topic físico. A propósito NO usamos `Date.now()`:
 * dos montajes en el mismo milisegundo generarían el mismo topic y volveríamos
 * a caer en la reutilización de canal que este módulo existe para evitar.
 */
let topicSeq = 0

const isDev = import.meta.env?.DEV ?? false

/**
 * Huella normalizada del contrato. Entra en la clave de deduplicación para que
 * dos consumidores con bindings distintos NO puedan compartir canal ni siquiera
 * por error: si el contrato difiere, se crea otro canal en lugar de descartar
 * en silencio los bindings del segundo.
 */
function fingerprint(bindings: PostgresBinding[]): string {
  return bindings
    .map(b => `${b.schema ?? 'public'}.${b.table}|${b.event}|${b.filter ?? ''}`)
    .sort()
    .join(';')
}

/** Descripción SANITIZADA para logs: sólo tabla y evento, nunca el filtro. */
function describeBindings(bindings: PostgresBinding[]): string {
  return bindings.map(b => `${b.schema ?? 'public'}.${b.table}:${b.event}`).join(', ')
}

/**
 * Nombre lógico sanitizado para logs. La clave lleva el businessId
 * (`subscription:<uuid>`), así que sólo publicamos el prefijo.
 */
function describeKey(key: string): string {
  const i = key.indexOf(':')
  return i === -1 ? key : `${key.slice(0, i)}:…`
}

function normalizeStatus(raw: string): RealtimeStatus {
  switch (raw) {
    case 'SUBSCRIBED':    return 'subscribed'
    case 'CHANNEL_ERROR': return 'channel_error'
    case 'TIMED_OUT':     return 'timed_out'
    case 'CLOSED':        return 'closed'
    default:              return 'connecting'
  }
}

/**
 * Programa la recreación del canal tras un fallo. Acotada por BACKOFF_MS: al
 * agotarse, deja de intentar y el consumidor se queda con HTTP + refresh manual.
 */
function programarRecuperacion(entry: Entry): void {
  if (entry.disposed || entry.timer) return
  if (entry.subscribers.size === 0) return
  const espera = BACKOFF_MS[entry.intentos]
  if (espera === undefined) {
    if (isDev) {
      logger.debug('REALTIME', `"${describeKey(entry.key)}" agotó los reintentos; queda en ${entry.status}`)
    }
    return
  }
  entry.intentos += 1
  entry.timer = setTimeout(() => {
    entry.timer = null
    if (entry.disposed || entry.subscribers.size === 0) return
    recrearCanal(entry)
  }, espera)
}

/**
 * Reemplaza el canal por uno NUEVO. Nunca se reusa el viejo ni se le agregan
 * callbacks: un canal que ya pasó por subscribe() no admite `.on()`.
 */
function recrearCanal(entry: Entry): void {
  const viejo = entry.channel
  entry.channel = null
  if (viejo) {
    try {
      void Promise.resolve(supabase.removeChannel(viejo)).catch(() => { /* ignorado */ })
    } catch { /* ignorado */ }
  }
  topicSeq += 1
  entry.topic = `${entry.key}#${topicSeq}`
  if (isDev) logger.debug('REALTIME', `reintento ${entry.intentos} de "${describeKey(entry.key)}"`)
  armarCanal(entry)
}

function setStatus(entry: Entry, status: RealtimeStatus): void {
  if (entry.status === status) return
  entry.status = status

  const isFailure = status === 'channel_error' || status === 'timed_out'
  if (isFailure && entry.loggedFailure !== status) {
    // Una línea por transición a fallo, no una por render ni por consumidor.
    // Sanitizado: nombre lógico, tablas/eventos y estado. Sin JWT, sin anon key,
    // sin payload, sin filtros y sin datos de clientes.
    entry.loggedFailure = status
    logger.warn('REALTIME', `canal "${describeKey(entry.key)}" → ${status}`, {
      bindings: describeBindings(entry.bindings),
      subscribers: entry.subscribers.size,
    })
  }
  if (status === 'subscribed') {
    entry.loggedFailure = null
    entry.intentos = 0          // reconectado: el presupuesto se renueva
  }

  for (const sub of [...entry.subscribers]) {
    try { sub.onStatus?.(status) } catch { /* un consumidor roto no tumba al resto */ }
  }

  // Después de avisar, no antes: el consumidor ve el fallo aunque el reintento
  // arranque en el mismo tick.
  if (isFailure) programarRecuperacion(entry)
}

function createEntry(dedupeKey: string, spec: SharedChannelSpec): Entry {
  topicSeq += 1

  const entry: Entry = {
    dedupeKey,
    key: spec.key,
    topic: `${spec.key}#${topicSeq}`,
    channel: null,
    bindings: spec.bindings,
    subscribers: new Set(),
    status: 'connecting',
    disposed: false,
    loggedFailure: null,
    intentos: 0,
    timer: null,
  }

  armarCanal(entry)
  return entry
}

/**
 * Construye el canal físico de una entrada: registra TODOS los `.on()` y recién
 * después ejecuta el único `subscribe()`. Se usa tanto en el alta como en cada
 * recuperación, siempre sobre un canal recién creado.
 */
function armarCanal(entry: Entry): void {
  const topic = entry.topic

  try {
    const channel = supabase.channel(topic)

    // (3) TODOS los .on() antes del subscribe().
    for (const binding of entry.bindings) {
      const filtro: Record<string, string> = {
        event:  binding.event,
        schema: binding.schema ?? 'public',
        table:  binding.table,
      }
      if (binding.filter) filtro.filter = binding.filter

      // El tipado de supabase-js exige literales para `event`; acá es dinámico.
      ;(channel.on as unknown as (
        type: 'postgres_changes',
        filter: Record<string, string>,
        cb: (payload: RealtimeEventPayload) => void,
      ) => RealtimeChannel)('postgres_changes', filtro, payload => {
        // (5) Un evento que llega después del cleanup se descarta.
        if (entry.disposed) return
        for (const sub of [...entry.subscribers]) {
          try { sub.onEvent?.(payload, binding) } catch (err) {
            logger.error('REALTIME', `callback falló en "${describeKey(entry.key)}"`,
              (err as { message?: string })?.message ?? err)
          }
        }
      })
    }

    // (3) Un único subscribe, después de registrar todo.
    channel.subscribe(raw => {
      if (entry.disposed) return
      setStatus(entry, normalizeStatus(raw))
    })

    entry.channel = channel
    if (isDev) logger.debug('REALTIME', `canal creado "${describeKey(entry.key)}"`, describeBindings(entry.bindings))
  } catch (err) {
    // (7) Realtime caído no puede romper el render ni la carga HTTP: la entrada
    // queda sin canal y en channel_error. Los consumidores siguen su camino.
    entry.channel = null
    entry.status = 'channel_error'
    entry.loggedFailure = 'channel_error'
    logger.warn('REALTIME', `no se pudo crear el canal "${describeKey(entry.key)}"`, {
      bindings: describeBindings(entry.bindings),
      message: (err as { message?: string })?.message ?? String(err),
    })
    // (8) También acá corresponde reintentar: el cliente puede estar caído
    // justo en el montaje y recuperarse un segundo después.
    programarRecuperacion(entry)
  }
}

function disposeEntry(entry: Entry): void {
  if (entry.disposed) return
  entry.disposed = true

  // Un reintento pendiente no puede sobrevivir al cleanup.
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }

  // (6) Baja SÍNCRONA del registro: `removeChannel` es async, así que si no
  // borráramos acá, un consumidor que llega en el mismo tick reutilizaría una
  // entrada moribunda.
  if (entries.get(entry.dedupeKey) === entry) entries.delete(entry.dedupeKey)

  const channel = entry.channel
  entry.channel = null
  entry.status = 'closed'

  if (channel) {
    // No await: nadie espera la baja, pero sí tragamos el rechazo.
    try {
      void Promise.resolve(supabase.removeChannel(channel)).catch(() => { /* ignorado */ })
    } catch { /* removeChannel síncrono que tira: nada que hacer */ }
  }
  if (isDev) logger.debug('REALTIME', `canal dado de baja "${describeKey(entry.key)}"`)
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Suscribe un consumidor al canal compartido del contrato `spec`, creándolo si
 * hace falta. Devuelve la función de baja (idempotente); cuando se va el último
 * consumidor, el canal se retira.
 *
 * Dos consumidores comparten canal si y sólo si coinciden clave lógica Y
 * bindings. Un contrato distinto obtiene su propio canal.
 */
export function subscribeShared(
  spec: SharedChannelSpec,
  subscriber: SharedChannelSubscriber,
): () => void {
  const dedupeKey = `${spec.key}::${fingerprint(spec.bindings)}`

  let entry = entries.get(dedupeKey)
  if (!entry) {
    entry = createEntry(dedupeKey, spec)
    entries.set(dedupeKey, entry)
  }

  entry.subscribers.add(subscriber)

  // El que llega tarde recibe el estado actual sin esperar otra transición.
  try { subscriber.onStatus?.(entry.status) } catch { /* ignorado */ }

  // Capturamos la entrada concreta: si mientras tanto se creó otra para el mismo
  // contrato, este consumidor debe darse de baja de la SUYA, no de la nueva.
  const propia = entry
  let released = false
  return () => {
    if (released) return
    released = true
    propia.subscribers.delete(subscriber)
    if (propia.subscribers.size === 0) disposeEntry(propia)
  }
}

/** Cantidad de canales compartidos vivos. Diagnóstico y tests. */
export function activeSharedChannelCount(): number {
  return entries.size
}

/** Topics físicos vivos. Diagnóstico y tests. */
export function activeSharedChannelTopics(): string[] {
  return [...entries.values()].map(e => e.topic)
}

/** Sólo para tests: descarta todo el estado del módulo. */
export function __resetSharedChannels(): void {
  for (const entry of [...entries.values()]) disposeEntry(entry)
  entries.clear()
  topicSeq = 0
}
