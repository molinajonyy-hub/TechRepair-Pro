// ============================================================================
// salesPointService — FUENTE ÚNICA de lectura del punto de venta activo.
//
// Existía la misma consulta copiada en tres modales de comprobantes, y las tres
// pedían columnas que la tabla NO tiene. PostgREST respondía 400 y, como el
// `.then()` sólo desestructuraba `data`, el error se perdía: el POS caía
// siempre al default sin que nada lo dijera.
//
// CONTRATO REAL de public.sales_points (baseline 20260628190324):
//   numero          integer NOT NULL DEFAULT 1     ← el número del PV
//   activo          boolean NOT NULL DEFAULT true
//   predeterminado  boolean NOT NULL DEFAULT false ← el que eligió el comercio
//
// La columna que se pedía SÍ existe, pero en `comprobantes` (text) y en
// `arca_config` (integer). Son cosas distintas: allá es el PV ya emitido y
// congelado en el documento; acá es la configuración del local. Por eso esto no
// se arregla renombrando a ciegas.
//
// ORDEN: predeterminado primero, después el número más chico — el mismo
// criterio que la función canónica public.get_active_sales_point(uuid) del
// baseline. No se la invoca porque el lockdown SECDEF le revocó EXECUTE a anon
// y authenticated (quedó reservada al rol de servicio del backend); se replica
// su semántica del lado del cliente, que es seguro porque la RLS de la tabla ya
// acota por negocio (policy sales_points_select sobre business_id).
//
// ALCANCE: esto NO toca la numeración fiscal. El PV que se manda a ARCA lo
// resuelve el servidor desde arca_config (ver supabase/functions/afip-cae);
// este valor sólo alimenta el campo local del comprobante.
// ============================================================================
import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'
import {
  formatearPuntoVenta,
  interpretarRespuestaPuntoVenta,
  type ResultadoPuntoVentaActivo,
} from '../lib/salesPointFormat'

export {
  ANCHO_PUNTO_VENTA,
  PUNTO_VENTA_POR_DEFECTO,
  formatearPuntoVenta,
  type SalesPoint,
  type ResultadoPuntoVentaActivo,
} from '../lib/salesPointFormat'

export const salesPointService = {
  /**
   * Devuelve el punto de venta activo del negocio, o null si no hay ninguno.
   *
   * Nunca lanza: el error se registra y se informa con `fallo: true` para que
   * la UI conserve un comportamiento seguro sin mostrar detalles de PostgREST.
   */
  async getActive(businessId: string): Promise<ResultadoPuntoVentaActivo> {
    const respuesta = await supabase
      .from('sales_points')
      .select('id, numero, nombre, activo, predeterminado')
      .eq('business_id', businessId)
      .eq('activo', true)
      .order('predeterminado', { ascending: false })
      .order('numero', { ascending: true })
      .limit(1)
      .maybeSingle()

    const resultado = interpretarRespuestaPuntoVenta(respuesta)
    if (resultado.fallo) {
      logger.error('POS', 'No se pudo leer el punto de venta activo', respuesta.error)
    }
    return resultado
  },

  /**
   * Número de PV activo ya formateado, o `null` si no hay ninguno configurado
   * o si la consulta falló. Pensado para inicializar el campo del POS: quien
   * llama conserva su propio default si esto devuelve null.
   */
  async getActiveNumeroFormateado(businessId: string): Promise<string | null> {
    const { salesPoint } = await salesPointService.getActive(businessId)
    return salesPoint ? formatearPuntoVenta(salesPoint.numero) : null
  },
}
