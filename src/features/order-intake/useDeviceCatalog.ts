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
   * ORDERS-V2-0.1 — separados a propósito.
   *
   * Con un único `loading` compartido, el combobox de MARCA mostraba el
   * spinner mientras en realidad se estaban buscando MODELOS, y peor: al
   * vaciar la marca el efecto salía por el `return` temprano sin apagarlo,
   * dejando a Marca girando para siempre.
   */
  brandsLoading: boolean
  modelsLoading: boolean
}

export function useDeviceCatalog(brandName: string): DeviceCatalogOptions {
  const [brands, setBrands] = useState<string[]>(DEFAULT_BRANDS)
  const [models, setModels] = useState<string[]>([])
  const [brandsLoading, setBrandsLoading] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(false)

  useEffect(() => {
    let active = true
    setBrandsLoading(true)
    loadBrandOptions()
      .then(options => { if (active) setBrands(options) })
      .catch(() => { /* el service ya degrada a DEFAULT_BRANDS */ })
      .finally(() => { if (active) setBrandsLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const trimmed = brandName.trim()
    if (!trimmed) {
      // Sin marca no hay búsqueda que esperar. Apagar el loading acá es lo que
      // faltaba: el `return` temprano lo dejaba encendido de la marca anterior.
      setModels([])
      setModelsLoading(false)
      return
    }

    // `active` cubre la carrera real de este campo: se tipea «S», «Sa», «Sam»…
    // Una respuesta vieja no puede pisar los modelos de la marca vigente NI
    // apagar el loading de una búsqueda más nueva, porque cada corrida sólo
    // toca el estado si su propio `active` sigue en pie.
    let active = true
    setModelsLoading(true)
    const timer = setTimeout(() => {
      loadModelOptions(trimmed)
        .then(options => { if (active) setModels(options) })
        .catch(() => { if (active) setModels([]) })
        .finally(() => { if (active) setModelsLoading(false) })
    }, BRAND_SETTLE_MS)

    return () => { active = false; clearTimeout(timer) }
  }, [brandName])

  return { brands, models, brandsLoading, modelsLoading }
}
