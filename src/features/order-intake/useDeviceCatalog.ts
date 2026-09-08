import { useEffect, useState } from 'react'
import {
  DEFAULT_BRANDS,
  loadBrandOptions,
  loadModelOptions,
} from '../../services/deviceCatalogService'

/**
 * ORDERS-V2-0 — sugerencias de marca y modelo para la recepción.
 *
 * Antes la pantalla consumía `DEFAULT_BRANDS` / `DEFAULT_MODELS_BY_BRAND`
 * directamente: las tablas `brands` y `device_models` existían, con sus RPCs
 * de deduplicación, y ningún alta las leía ni las alimentaba.
 *
 * El hook expone SÓLO nombres. Las capas (catálogo del negocio, fallback y,
 * en ORDERS-V2-1, el catálogo global) se resuelven dentro de
 * `deviceCatalogService`, para que sumar una capa no toque las pantallas.
 *
 * Nunca bloquea el alta: si la DB falla, el service degrada a los fallbacks y
 * el campo sigue aceptando texto libre.
 */

/** El modelo sólo se consulta cuando la marca ya parece escrita del todo. */
const BRAND_SETTLE_MS = 300

export interface DeviceCatalogOptions {
  brands: string[]
  models: string[]
  /**
   * ORDERS-V2-0.1 — el combobox lo muestra mientras espera al catálogo.
   * `<datalist>` no tenía forma de expresar «estoy buscando», así que en una
   * conexión lenta la lista simplemente aparecía vacía.
   */
  loading: boolean
}

export function useDeviceCatalog(brandName: string): DeviceCatalogOptions {
  const [brands, setBrands] = useState<string[]>(DEFAULT_BRANDS)
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    loadBrandOptions()
      .then(options => { if (active) setBrands(options) })
      .catch(() => { /* el service ya degrada a DEFAULT_BRANDS */ })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const trimmed = brandName.trim()
    if (!trimmed) { setModels([]); return }

    // `active` cubre la carrera real de este campo: se tipea «S», «Sa», «Sam»…
    // y una respuesta vieja no puede pisar la sugerencia de la marca vigente.
    let active = true
    setLoading(true)
    const timer = setTimeout(() => {
      loadModelOptions(trimmed)
        .then(options => { if (active) setModels(options) })
        .catch(() => { if (active) setModels([]) })
        .finally(() => { if (active) setLoading(false) })
    }, BRAND_SETTLE_MS)

    return () => { active = false; clearTimeout(timer) }
  }, [brandName])

  return { brands, models, loading }
}
