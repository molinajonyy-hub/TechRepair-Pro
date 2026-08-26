/**
 * P0 FIRST-STEPS-1 — lectura canónica del progreso de "Primeros pasos".
 *
 * FUENTE ÚNICA. El progreso se deriva server-side del estado real del tenant;
 * el navegador no opina sobre si una acción ocurrió.
 *
 * Deliberadamente NO recibe `businessId`: la RPC no acepta parámetros y deriva
 * el negocio de `auth.uid()`. Pasarle un id desde el cliente sería justamente el
 * agujero cross-tenant que este contrato cierra por firma.
 */
import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'

/** Contrato de la RPC `public.get_my_first_steps()`. Cinco booleanos, nada más. */
export interface FirstSteps {
  /** Existe al menos un cliente activo del negocio. */
  has_customer:  boolean
  /** Existe al menos una orden, en cualquier estado. */
  has_order:     boolean
  /** Existe al menos un producto vendible (activo y no padre de variantes). */
  has_inventory: boolean
  /**
   * Ocurrió históricamente al menos un cobro canónico. NO vuelve a `false`
   * porque después se haya reversado o reemplazado: mide aprendizaje, no saldo.
   */
  has_cobro:     boolean
  /** Hay un logo real en `businesses` o en `business_settings`. */
  has_logo:      boolean
}

export const FIRST_STEPS_EMPTY: FirstSteps = {
  has_customer:  false,
  has_order:     false,
  has_inventory: false,
  has_cobro:     false,
  has_logo:      false,
}

export const firstStepsService = {
  /**
   * Un único round-trip. Ante error devuelve `null` (no un falso 0/5): el
   * llamador distingue "no pudo leerse" de "no hay nada hecho" y no muestra
   * un checklist que miente.
   */
  async get(): Promise<FirstSteps | null> {
    const { data, error } = await supabase.rpc('get_my_first_steps').single<FirstSteps>()

    if (error) {
      logger.error('SUPABASE', 'get_my_first_steps falló', error)
      return null
    }
    if (!data) return null

    return {
      has_customer:  Boolean(data.has_customer),
      has_order:     Boolean(data.has_order),
      has_inventory: Boolean(data.has_inventory),
      has_cobro:     Boolean(data.has_cobro),
      has_logo:      Boolean(data.has_logo),
    }
  },
}
