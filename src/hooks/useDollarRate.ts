/**
 * useDollarRate — UNA lectura de la cotización para toda la aplicación.
 *
 * BETA-UX-1F: el dólar dejó de ser una tarjeta de Inicio y pasó a la barra
 * superior. Antes cada `DollarRateBadge` pedía la cotización por su cuenta al
 * montarse, y además Inicio la pedía otra vez en un efecto propio: dos lecturas
 * en carrera por cada visita. Acá vive el estado compartido: la cotización se
 * lee una vez por negocio, la consumen todos los que la muestran (la barra de
 * escritorio y la fila de mobile están las dos en el DOM y el CSS elige cuál se
 * ve) y se vuelve a leer sola cada 15 minutos mientras alguien la esté mirando.
 *
 * El módulo NO decide precios: sólo lee y reparte lo que devuelve
 * `dollarRateService`. Quien reacciona a una cotización nueva —hoy, los precios
 * de inventario atados al dólar— lo hace desde `useInventoryDollarPriceSync`.
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
/** Última lectura ya aplicada al inventario: evita repetirla al remontar. */
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
 * `force` ignora el caché del servicio: lo usan el botón de actualizar y la
 * lectura periódica. La periódica no puede apoyarse en el TTL del caché porque
 * dura lo mismo que el intervalo: el caché se llena cuando la lectura TERMINA,
 * así que al dispararse el intervalo todavía estaría «fresco» y la cotización
 * se renovaría recién cada 30 minutos.
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
    timer = setInterval(() => {
      if (snapshot.businessId) void load(snapshot.businessId, true)
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
 * Mantiene al día el precio en pesos de los productos atados al dólar.
 *
 * `refreshInventoryDollarPrices` es el ÚNICO mecanismo que recalcula
 * `sale_price` de los productos `linked_to_dolar` (precio en USD × cotización
 * de venta). Hasta BETA-UX-1F lo disparaba un efecto de Inicio: los precios se
 * actualizaban sólo si alguien abría esa pantalla, y cada 15 minutos sólo
 * mientras se quedaba en ella. Un taller que deja la aplicación abierta en
 * Órdenes o en el POS no los actualizaba nunca.
 *
 * Ahora corre con el ciclo de vida del shell: una vez por cada lectura
 * terminada de la cotización —la inicial, la periódica y la manual—, sin
 * importar la pantalla. La fórmula y la fuente NO cambian: es la misma función
 * del servicio, con la misma cotización que se muestra arriba.
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
