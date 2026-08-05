import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { subscribeShared, type RealtimeStatus } from '../lib/realtimeChannel'
import { logger } from '../lib/logger'
import { useAuth } from '../contexts/AuthContext'

/**
 * Forma de una fila de `public.notifications`.
 *
 * Contrato cerrado en la migración `20260805120000_notifications_contract.sql`.
 * Las columnas son exactamente estas: escribir cualquier otra hace que PostgREST
 * responda 400 PGRST204 ("Could not find the column ... in the schema cache") y
 * se pierda la escritura ENTERA.
 *
 * Campos que el código escribía y NO existían (venían de
 * `supabase/_archive/loose-scripts/notifications.sql`, nunca aplicado):
 *  - `order_id` y `metadata` → SÍ tenían consumidor real en
 *    NotificationsDropdown (deep-link a la orden y badge de estado), así que la
 *    migración los agrega.
 *  - `customer_id` y `read_at` → NINGÚN consumidor en toda la app. Se retiran
 *    del código en lugar de agregarlos al esquema: `is_read` ya cubre la UI.
 */
export interface Notification {
  id: string
  type: string
  title: string
  message: string
  is_read: boolean
  created_at: string
  /** Deep-link opcional a la orden. FK a `orders`, mismo negocio. */
  order_id?: string | null
  /** Payload chico y no sensible. Default `{}` en la DB. */
  metadata?: {
    from_status?: string
    to_status?: string
    changed_by?: string
  } | null
}

/** Orden canónico: más nueva primero; `id` desempata para que sea estable. */
function ordenar(filas: Notification[]): Notification[] {
  return [...filas].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
    return a.id < b.id ? 1 : -1
  })
}

export function useNotifications() {
  const { businessId } = useAuth()
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('idle')
  /** Se apaga en el cleanup: ninguna respuesta tardía toca un hook desmontado. */
  const vivoRef = useRef(true)

  const loadNotifications = useCallback(async () => {
    if (!businessId) return
    try {
      setLoading(true)

      // Consulta de LISTA: cero notificaciones es un estado legítimo y devuelve
      // 200 con `[]`. Nunca `.single()` acá — eso mandaría
      // `Accept: application/vnd.pgrst.object+json` y con 0 filas PostgREST
      // respondería 406 PGRST116.
      const { data, error: dbError } = await supabase
        .from('notifications')
        .select('id, type, title, message, is_read, created_at, order_id, metadata')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false })
        .limit(50)

      if (!vivoRef.current) return
      if (dbError) throw dbError

      const filas = ordenar((data ?? []) as Notification[])
      setError(null)
      // La carga HTTP es la verdad: reemplaza, pero conservando cualquier fila
      // que haya llegado por Realtime y todavía no esté en la respuesta.
      setNotifications(prev => {
        const vistos = new Set(filas.map(n => n.id))
        const soloRealtime = prev.filter(n => !vistos.has(n.id))
        return soloRealtime.length ? ordenar([...filas, ...soloRealtime]) : filas
      })
    } catch (err) {
      if (!vivoRef.current) return
      // Un error NO se convierte en cero: dejamos la lista como está y marcamos
      // el error para que la UI pueda distinguir "sin datos" de "falló".
      logger.error('SUPABASE', 'useNotifications: fallo cargando notificaciones',
        (err as { message?: string })?.message ?? err)
      setError('No se pudieron cargar las notificaciones')
    } finally {
      if (vivoRef.current) setLoading(false)
    }
  }, [businessId])

  // El contador de no leídas se deriva de la lista: no se incrementa a mano, así
  // no puede desincronizarse cuando Realtime reenvía una fila ya conocida.
  useEffect(() => {
    setUnreadCount(notifications.filter(n => !n.is_read).length)
  }, [notifications])

  useEffect(() => {
    vivoRef.current = true
    if (!businessId) {
      setLoading(false)
      return () => { vivoRef.current = false }
    }
    loadNotifications()

    const baja = subscribeShared(
      {
        key: `notifications:${businessId}`,
        bindings: [
          { event: 'INSERT', table: 'notifications', filter: `business_id=eq.${businessId}` },
        ],
      },
      {
        onEvent: (payload) => {
          if (!vivoRef.current) return
          const fila = payload.new as Notification
          if (!fila?.id) return
          // Dedup por id: la carga HTTP inicial y una reconexión pueden traer la
          // misma fila. Realtime incorpora o invalida, nunca duplica.
          setNotifications(prev =>
            prev.some(n => n.id === fila.id) ? prev : ordenar([fila, ...prev]),
          )
        },
        onStatus: (status) => {
          if (!vivoRef.current) return
          setRealtimeStatus(status)
        },
      },
    )

    return () => {
      vivoRef.current = false
      baja()
    }
  }, [businessId, loadNotifications])

  async function markAsRead(notificationId: string) {
    try {
      // Sólo `is_read`: `read_at` no es una columna (ver nota del tipo).
      const { error: dbError } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('id', notificationId)

      if (dbError) throw dbError

      setNotifications(prev =>
        prev.map(n => (n.id === notificationId ? { ...n, is_read: true } : n)),
      )
    } catch (err) {
      logger.error('SUPABASE', 'useNotifications: fallo marcando como leída',
        (err as { message?: string })?.message ?? err)
    }
  }

  async function markAllAsRead() {
    if (!businessId) return
    try {
      const { error: dbError } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('business_id', businessId)
        .eq('is_read', false)

      if (dbError) throw dbError

      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })))
    } catch (err) {
      logger.error('SUPABASE', 'useNotifications: fallo marcando todas como leídas',
        (err as { message?: string })?.message ?? err)
    }
  }

  return {
    notifications,
    unreadCount,
    loading,
    error,
    realtimeStatus,
    markAsRead,
    markAllAsRead,
    refresh: loadNotifications,
  }
}
