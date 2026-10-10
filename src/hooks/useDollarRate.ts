/**
 * useDollarRate — UNA lectura de la cotización para toda la aplicación.
 *
 * BETA-UX-1F: el dólar dejó de ser una tarjeta de Inicio y pasó a la barra
 * superior. Antes cada `DollarRateBadge` pedía la cotización por su cuenta al
 * montarse, y además Inicio la pedía otra vez en un efecto propio: dos lecturas
 * en carrera por cada visita. Acá vive el estado compartido: la cotización se
 * lee una vez por negocio, la consumen todos los que la muestran (la barra de
 * escritorio y la fila de mobile están las dos en el DOM y el CSS elige cuál se
 * ve) y se le vuelve a preguntar al servicio cada 15 minutos mientras alguien la
 * esté mirando.
 *
 * DOS EFECTOS DISTINTOS, que este módulo no acopla:
 *
 *   1. Refrescar la cotización que se MUESTRA. Es del shell: `useDollarRate`
 *      —la lectura inicial, el botón del chip y la lectura periódica—. No toca
 *      inventario, en ninguna pantalla.
 *   2. Repreciar el inventario atado al dólar. Es un efecto heredado de Inicio:
 *      `useInventoryDollarPriceSync`, que corre sólo mientras Inicio está
 *      montado. El shell no lo monta.
 *
 * Que la cotización cambie no reprecia nada por sí solo.
 *
 * El módulo NO decide precios ni fuentes: lee y reparte lo que devuelve
 * `dollarRateService`, sin lógica propia. Lo que ese servicio hace al leer es
 * suyo y es anterior a 1F: cuando consulta la fuente (auto-update activo y
 * caché vencido, o lectura forzada) guarda el valor obtenido en
 * `exchange_rates`, `dollar_rate_history` y `business_settings.last_dollar_*`.
 * Eso es persistencia de la COTIZACIÓN; no es inventario.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useAuth } from '../contexts/AuthContext'
import {
  clearDollarCache,
  refreshDollarRate,
  refreshInventoryDollarPrices,
  type DollarRateResult,
} from '../services/dollarRateService'

/** Igual al TTL del caché de `dollarRateService`. */
const REFRESH_INTERVAL_MS = 15 * 60_000

interface DollarRateSnapshot {
  businessId: string | null
  rate: DollarRateResult | null
  loading: boolean
  /** Lecturas terminadas para este negocio. Señal de «hay una cotización nueva». */
  loads: number
  loadedAt: number
}

const EMPTY: DollarRateSnapshot = { businessId: null, rate: null, loading: false, loads: 0, loadedAt: 0 }

let snapshot: DollarRateSnapshot = EMPTY
const listeners = new Set<() => void>()
let consumers = 0
let timer: ReturnType<typeof setInterval> | null = null
let inFlight: { businessId: string; promise: Promise<void> } | null = null
/** Última lectura ya aplicada al inventario: evita repetirla al volver a Inicio. */
let inventorySync: { businessId: string; loads: number } | null = null

function publish(next: DollarRateSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const getSnapshot = () => snapshot

/**
 * Lee la cotización del negocio. Dos pedidos simultáneos comparten la misma
 * lectura: es lo que impide el doble fetch.
 *
 * `force` ignora el caché del servicio y lo usa SÓLO una acción explícita del
 * usuario (el botón del chip, «Actualizar» en Inicio). La lectura inicial y la
 * periódica no fuerzan: respetan el caché del servicio.
 */
function load(businessId: string, force: boolean): Promise<void> {
  if (inFlight && inFlight.businessId === businessId) return inFlight.promise

  const current: { businessId: string; promise: Promise<void> } = { businessId, promise: Promise.resolve() }
  current.promise = (async () => {
    publish({ ...snapshot, loading: true })
    try {
      if (force) clearDollarCache(businessId)
      const rate = await refreshDollarRate(businessId, force)
      // El negocio cambió mientras la lectura estaba en vuelo: se descarta.
      if (snapshot.businessId !== businessId) return
      publish({ businessId, rate, loading: false, loads: snapshot.loads + 1, loadedAt: Date.now() })
    } catch {
      // El servicio ya degrada al último valor guardado; si igual falla, se
      // conserva lo que había y no se inventa una cotización.
      if (snapshot.businessId === businessId) publish({ ...snapshot, loading: false })
    } finally {
      if (inFlight === current) inFlight = null
    }
  })()

  inFlight = current
  return current.promise
}

function attach(businessId: string): () => void {
  consumers += 1

  if (snapshot.businessId !== businessId) {
    // Otro negocio (o primera vez): nada de lo anterior se muestra.
    snapshot = { ...EMPTY, businessId }
    void load(businessId, false)
  } else if (!snapshot.loading && Date.now() - snapshot.loadedAt >= REFRESH_INTERVAL_MS) {
    void load(businessId, false)
  }

  if (!timer) {
    // Lectura periódica, para que el chip no muestre un valor viejo. NO fuerza:
    // le pregunta al servicio y es SU caché el que decide si se consulta la
    // fuente —igual que la lectura periódica que tenía Inicio antes de 1F—. El
    // caché se llena cuando la lectura termina, así que al dispararse el
    // intervalo suele seguir fresco: la fuente se consulta, en la práctica, uno
    // de cada dos ciclos.
    //
    // Este timer refresca lo que se muestra y nada más. No reprecia inventario.
    timer = setInterval(() => {
      if (snapshot.businessId) void load(snapshot.businessId, false)
    }, REFRESH_INTERVAL_MS)
  }

  return () => {
    consumers -= 1
    if (consumers <= 0 && timer) {
      clearInterval(timer)
      timer = null
      consumers = 0
    }
  }
}

/**
 * Vuelve a leer la cotización que la barra superior está mostrando, ignorando
 * el caché. No hace nada si todavía nadie la pidió: quien llama (el botón
 * «Actualizar» de Inicio) no se convierte en un consumidor más.
 */
export function refreshSharedDollarRate(): Promise<void> {
  return snapshot.businessId ? load(snapshot.businessId, true) : Promise.resolve()
}

/** Vuelve el estado compartido a cero. Para tests y para cerrar sesión. */
export function resetDollarRateStore(): void {
  if (timer) clearInterval(timer)
  timer = null
  consumers = 0
  inFlight = null
  inventorySync = null
  publish(EMPTY)
}

export interface UseDollarRateReturn {
  rate: DollarRateResult | null
  loading: boolean
  /** Lecturas terminadas para el negocio actual. */
  loads: number
  /** Fuerza una lectura nueva, ignorando el caché. */
  refresh: () => Promise<void>
}

export function useDollarRate(): UseDollarRateReturn {
  const { businessId } = useAuth()
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    if (!businessId) return
    return attach(businessId)
  }, [businessId])

  const refresh = useCallback(
    () => (businessId ? load(businessId, true) : Promise.resolve()),
    [businessId],
  )

  // Nunca la cotización de otro negocio, ni por un render.
  const own = Boolean(businessId) && state.businessId === businessId
  return {
    rate: own ? state.rate : null,
    loading: own && state.loading,
    loads: own ? state.loads : 0,
    refresh,
  }
}

// ─── Precios de inventario atados al dólar ────────────────────────────────────

/**
 * Reprecio heredado de los productos atados al dólar — acotado a Inicio.
 *
 * `refreshInventoryDollarPrices` es el único mecanismo del frontend que
 * recalcula `sale_price` de los productos `linked_to_dolar` (precio en USD ×
 * cotización de venta), y lo hace con un UPDATE por producto desde el
 * navegador. Antes de BETA-UX-1F lo disparaba un efecto de Inicio. Ese
 * comportamiento se conserva y en el mismo lugar: este hook se monta SÓLO
 * desde `Dashboard`.
 *
 * No se monta en el shell, a propósito. Hacerlo convertiría navegar por
 * cualquier pantalla —o dejar la aplicación abierta en Órdenes— en un
 * disparador de escrituras de inventario: un cambio en el ciclo de vida de las
 * escrituras de toda la aplicación, que este lote no introduce.
 *
 * Mientras Inicio está montado, cada lectura efectiva de la cotización —una
 * lectura terminada que trae precio de venta— se aplica como máximo una vez:
 *   · no pide la cotización por su cuenta: usa la lectura compartida;
 *   · una lectura ya aplicada no se repite al volver a entrar a Inicio;
 *   · una lectura hecha con Inicio desmontado no reprecia nada en ese momento;
 *     si es la vigente cuando Inicio se monta, se aplica ahí, una sola vez.
 *
 * La fórmula y la fuente no cambian: es la misma función del servicio.
 *
 * Deuda DOLLAR-PRICE-SYNC-1: el reprecio debería ser del servidor, en lote y
 * sólo cuando cambia la cotización efectiva. No se resuelve en BETA-UX-1F.
 */
export function useInventoryDollarPriceSync(): void {
  const { businessId } = useAuth()
  const { rate, loads } = useDollarRate()
  const sellPrice = rate?.sellPrice ?? 0

  useEffect(() => {
    if (!businessId || loads === 0 || !sellPrice) return
    if (inventorySync?.businessId === businessId && inventorySync.loads === loads) return
    inventorySync = { businessId, loads }
    // Silencioso, como siempre fue: un fallo acá no puede tumbar la pantalla, y
    // el próximo ciclo vuelve a intentarlo.
    void refreshInventoryDollarPrices(businessId).catch(() => undefined)
  }, [businessId, loads, sellPrice])
}
