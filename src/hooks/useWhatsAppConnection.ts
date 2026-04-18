import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import {
  getConnection,
  getAutomationSettings,
  saveAutomationSettings as saveAutomationSettingsService,
  disconnectWhatsApp,
  type WhatsAppConnection,
  type WhatsAppAutomationSettings,
} from '../services/whatsappCloudService'

// ──────────────────────────────────────────────────────────────
// Caché a nivel de módulo — persiste entre navegaciones (5 min TTL)
// ──────────────────────────────────────────────────────────────

interface CacheEntry {
  connection: WhatsAppConnection | null
  automationSettings: WhatsAppAutomationSettings | null
  businessId: string
  timestamp: number
}

let connectionCache: CacheEntry | null = null
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutos

/** Verifica si la caché es válida para el businessId dado */
function isCacheValid(businessId: string | null): boolean {
  return (
    connectionCache !== null &&
    businessId !== null &&
    connectionCache.businessId === businessId &&
    Date.now() - connectionCache.timestamp < CACHE_TTL_MS
  )
}

/** Invalida la caché para forzar una recarga */
function invalidateCache(): void {
  connectionCache = null
}

// ──────────────────────────────────────────────────────────────
// Hook principal
// ──────────────────────────────────────────────────────────────

export interface UseWhatsAppConnectionReturn {
  /** Conexión activa (null si no hay o está desconectada) */
  connection: WhatsAppConnection | null
  /** Configuración de automatización del negocio */
  automationSettings: WhatsAppAutomationSettings | null
  /** Indica si se está cargando la información */
  loading: boolean
  /** Mensaje de error si hubo algún fallo */
  error: string | null
  /** Fuerza una recarga ignorando la caché */
  refresh: () => void
  /** Desconecta la cuenta de WhatsApp activa */
  disconnect: () => Promise<{ success: boolean; error?: string }>
  /** Guarda la configuración de automatización */
  saveAutomationSettings: (
    settings: Partial<Omit<WhatsAppAutomationSettings, 'id' | 'business_id' | 'created_at' | 'updated_at'>>
  ) => Promise<{ success: boolean; error?: string }>
}

export function useWhatsAppConnection(): UseWhatsAppConnectionReturn {
  // Obtenemos el businessId del contexto de autenticación
  const { businessId } = useAuth()

  const [connection, setConnection] = useState<WhatsAppConnection | null>(
    () => (isCacheValid(businessId) ? connectionCache!.connection : null)
  )
  const [automationSettings, setAutomationSettings] = useState<WhatsAppAutomationSettings | null>(
    () => (isCacheValid(businessId) ? connectionCache!.automationSettings : null)
  )
  const [loading, setLoading] = useState<boolean>(() => !isCacheValid(businessId))
  const [error, setError] = useState<string | null>(null)

  // Carga los datos desde Supabase (respetando caché)
  const loadData = useCallback(
    async (forceRefresh = false) => {
      // Si no tenemos businessId, no hacemos nada
      if (!businessId) {
        setConnection(null)
        setAutomationSettings(null)
        setLoading(false)
        return
      }

      // Si la caché es válida y no se fuerza recarga, usamos la caché
      if (!forceRefresh && isCacheValid(businessId)) {
        setConnection(connectionCache!.connection)
        setAutomationSettings(connectionCache!.automationSettings)
        setLoading(false)
        return
      }

      try {
        setLoading(true)
        setError(null)

        // Cargamos conexión y configuración de automatización en paralelo
        const [conn, automation] = await Promise.all([
          getConnection(businessId),
          getAutomationSettings(businessId),
        ])

        // Actualizamos la caché del módulo
        connectionCache = {
          connection: conn,
          automationSettings: automation,
          businessId,
          timestamp: Date.now(),
        }

        setConnection(conn)
        setAutomationSettings(automation)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al cargar datos de WhatsApp'
        console.error('Error en useWhatsAppConnection:', err)
        setError(msg)
      } finally {
        setLoading(false)
      }
    },
    [businessId]
  )

  // Carga inicial al montar el componente o cambiar el businessId
  useEffect(() => {
    void loadData()
  }, [loadData])

  // Fuerza una recarga invalidando la caché primero
  const refresh = useCallback(() => {
    invalidateCache()
    void loadData(true)
  }, [loadData])

  // Desconecta la cuenta activa y actualiza el estado local
  const disconnect = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!businessId) return { success: false, error: 'No hay negocio activo' }

    const result = await disconnectWhatsApp(businessId)

    if (result.success) {
      // Invalidamos caché y actualizamos estado local inmediatamente
      invalidateCache()
      setConnection(null)
    }

    return result
  }, [businessId])

  // Guarda la configuración de automatización y actualiza el estado local
  const saveSettings = useCallback(
    async (
      settings: Partial<Omit<WhatsAppAutomationSettings, 'id' | 'business_id' | 'created_at' | 'updated_at'>>
    ): Promise<{ success: boolean; error?: string }> => {
      if (!businessId) return { success: false, error: 'No hay negocio activo' }

      const result = await saveAutomationSettingsService(businessId, settings)

      if (result.success) {
        // Invalidamos caché y forzamos recarga para obtener datos actualizados
        invalidateCache()
        void loadData(true)
      }

      return result
    },
    [businessId, loadData]
  )

  return {
    connection,
    automationSettings,
    loading,
    error,
    refresh,
    disconnect,
    saveAutomationSettings: saveSettings,
  }
}
