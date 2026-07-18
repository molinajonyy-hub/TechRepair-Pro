// ============================================================================
// M7 7D — Invocación del Health Check financiero.
//
// Capa de I/O. La lógica pura (tipos, parsing fail-closed, agrupación, formato)
// vive en src/lib/financeHealth.ts para poder testearla sin el cliente Supabase.
// ============================================================================
import { supabase } from '../lib/supabase'
import { parseHealthResult, esV2Inexistente, type HealthResult } from '../lib/financeHealth'

export interface RunHealthCheckOpts {
  businessId: string
  /**
   * Pedir los checks globales de plataforma. La BASE decide si los devuelve
   * (exige ser owner del negocio). Esto es una petición, no una autorización:
   * ocultar la UI nunca autoriza nada.
   */
  includeGlobal?: boolean
}

/**
 * Llama a finance_health_check_v2 y, SOLO si la función todavía no existe
 * (deploy pendiente o schema cache viejo), cae a v1 marcando
 * health_version='legacy_v1'.
 *
 * Cualquier otro error —permisos, SQL, timeout, contrato roto, fallo de
 * seguridad— se propaga tal cual: el fallback nunca los oculta.
 */
export async function runHealthCheck(opts: RunHealthCheckOpts): Promise<HealthResult> {
  const { data, error } = await supabase.rpc('finance_health_check_v2', {
    p_business_id: opts.businessId,
    p_include_global: opts.includeGlobal ?? false,
  })

  if (error) {
    if (!esV2Inexistente(error)) throw new Error(error.message)
    const legacy = await supabase.rpc('finance_health_check', { p_business_id: opts.businessId })
    if (legacy.error) throw new Error(legacy.error.message)
    const parsedLegacy = parseHealthResult(legacy.data, 'legacy_v1')
    if (!parsedLegacy.ok && parsedLegacy.error) throw new Error(parsedLegacy.error)
    return parsedLegacy
  }

  const parsed = parseHealthResult(data, 'v2')
  // La RPC devuelve {ok:false, error} para auth/ownership: es un error real.
  if (!parsed.ok && parsed.error) throw new Error(parsed.error)
  return parsed
}

export type { HealthResult } from '../lib/financeHealth'
