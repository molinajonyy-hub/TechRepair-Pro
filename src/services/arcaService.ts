import { supabase } from '../lib/supabase'
import { sanitizeArcaError } from './arcaSanitize'

// ────────────────────────────────────────────────────────────────────────────
// AFIP-S1B-A2: contratos tipados del frontend. NINGUNO expone `private_key`.
//   · ArcaConfigSafe          → lo que devuelve get_arca_config_safe (no secretos)
//   · ArcaConfigEditable      → lo editable por save_arca_config_legacy
//   · ArcaCertificateReplacement → solo el certificado PÚBLICO (save_arca_certificate_legacy)
// El frontend NO hace SELECT/DML directo sobre arca_config: todo pasa por RPC.
// ────────────────────────────────────────────────────────────────────────────

export type ArcaAmbiente = 'homologacion' | 'produccion'
/** Estados permitidos por set_arca_estado_conexion (validados server-side). */
export type ArcaEstadoConexion =
  | 'conectado' | 'desconectado' | 'error' | 'csr_generado' | 'no_configurado'

/** Campos NO secretos que devuelve get_arca_config_safe. Nunca incluye PEM/clave. */
export interface ArcaConfigSafe {
  cuit?: string
  razon_social?: string
  ambiente?: ArcaAmbiente
  punto_venta?: number
  web_service?: string
  alias?: string
  expires_at?: string
  estado_conexion?: string
  ultima_sincronizacion?: string
  ultimo_error?: string
  // Indicadores de presencia (nunca el contenido del secreto):
  has_certificate?: boolean
  has_private_key_configured?: boolean
  wsaa_token_valid?: boolean
  configured?: boolean
}

/** Campos editables por save_arca_config_legacy. Sin cert/clave/token/estado. */
export interface ArcaConfigEditable {
  cuit?: string | null
  razon_social?: string | null
  ambiente?: ArcaAmbiente | null
  punto_venta?: number | null
  web_service?: string | null
  alias?: string | null
  expires_at?: string | null
}

/** Reemplazo del certificado PÚBLICO. Jamás lleva la clave privada. */
export interface ArcaCertificateReplacement {
  business_id: string
  cert_file: string
}

export interface ArcaSaveResult { success: boolean; updated_at?: string }

/** Forma mínima que devuelven las RPC de escritura (jsonb {success, updated_at}). */
type RpcSavePayload = { success?: boolean; updated_at?: string } | null

/**
 * Servicio para integración con ARCA/AFIP.
 * Las operaciones criptográficas y las llamadas SOAP se ejecutan en las
 * Edge Functions `afip-wsaa` y `afip-cae` (sin CORS, con node-forge).
 */
export class ArcaService {
  // ──────────────────────────────────────────────
  // Configuración
  // ──────────────────────────────────────────────

  static async getArcaConfig(businessId: string) {
    // AFIP-S1A: contrato de lectura SEGURO. Nunca trae private_key, cert PEM,
    // pfx, passwords, wsaa token/sign ni secret_id al navegador. Devuelve solo
    // columnas no secretas + indicadores (has_certificate, has_private_key_configured).
    const { data, error } = await supabase.rpc('get_arca_config_safe', {
      p_business_id: businessId,
    })

    if (error) throw new Error('Error al obtener configuración ARCA')
    return data
  }

  /**
   * Guarda la configuración NO secreta vía save_arca_config_legacy (AFIP-S1B-A2).
   * Mapea cada parámetro explícitamente — NUNCA hace spread ni envía secretos
   * (cert/clave/token/estado). NULL = preservar el valor existente (server-side).
   */
  static async saveArcaConfig(
    businessId: string,
    editable: ArcaConfigEditable
  ): Promise<ArcaSaveResult> {
    const { data, error } = await supabase.rpc('save_arca_config_legacy', {
      p_business_id: businessId,
      p_cuit:         editable.cuit ?? null,
      p_razon_social: editable.razon_social ?? null,
      p_ambiente:     editable.ambiente ?? null,
      p_punto_venta:  editable.punto_venta ?? null,
      p_web_service:  editable.web_service ?? null,
      p_alias:        editable.alias ?? null,
      p_expires_at:   editable.expires_at ?? null,
    })
    if (error) throw new Error(error.message)
    const res = data as RpcSavePayload
    return { success: res?.success ?? false, updated_at: res?.updated_at }
  }

  /**
   * Reemplaza el certificado PÚBLICO vía save_arca_certificate_legacy.
   * Solo se llama cuando el usuario pegó un certificado nuevo y no vacío.
   * Rechaza claves privadas (defensa cliente; el server también valida el header).
   */
  static async saveCertificate(businessId: string, certFile: string): Promise<ArcaSaveResult> {
    const cert = (certFile ?? '').trim()
    if (!cert) throw new Error('El certificado está vacío')
    if (/PRIVATE KEY/i.test(cert)) throw new Error('El campo certificado no admite claves privadas')
    if (!cert.startsWith('-----BEGIN CERTIFICATE-----')) {
      throw new Error('El certificado no tiene el formato PEM público esperado')
    }
    const { data, error } = await supabase.rpc('save_arca_certificate_legacy', {
      p_business_id: businessId,
      p_cert_file: cert,
    })
    if (error) throw new Error(error.message)
    const res = data as RpcSavePayload
    return { success: res?.success ?? false, updated_at: res?.updated_at }
  }

  /** Actualiza el estado de conexión vía set_arca_estado_conexion (sin DML directo). */
  static async setEstadoConexion(
    businessId: string,
    estado: ArcaEstadoConexion,
    error?: unknown
  ): Promise<void> {
    const { error: rpcError } = await supabase.rpc('set_arca_estado_conexion', {
      p_business_id: businessId,
      p_estado: estado,
      p_error: estado === 'error' ? sanitizeArcaError(error) : null,
    })
    if (rpcError) throw new Error(rpcError.message)
  }

  // ──────────────────────────────────────────────
  // Autenticación WSAA (via Edge Function)
  // ──────────────────────────────────────────────

  /**
   * Obtiene token+sign del WSAA.
   * Usa caché interno en arca_config (válido 12h con buffer de 30 min).
   * Si force_refresh=true, siempre obtiene uno nuevo.
   */
  static async getWSAAToken(
    businessId: string,
    service = 'wsfe',
    forceRefresh = false
  ): Promise<{ token: string; sign: string; cached: boolean }> {
    const { data, error } = await supabase.functions.invoke('afip-wsaa', {
      body: { business_id: businessId, service, force_refresh: forceRefresh },
    })

    if (error) throw new Error(error.message || 'Error al conectar con afip-wsaa')
    if (!data?.success) throw new Error(data?.error || 'Error en WSAA')

    return {
      token:  data.token  as string,
      sign:   data.sign   as string,
      cached: data.cached as boolean,
    }
  }

  // ──────────────────────────────────────────────
  // Test de conexión
  // ──────────────────────────────────────────────

  static async testConnection(businessId: string): Promise<{
    success: boolean
    message: string
    details?: any
  }> {
    try {
      const config = await this.getArcaConfig(businessId)

      // AFIP-S1A: presencia por indicadores del contrato seguro (nunca el PEM).
      if (!config?.has_certificate) {
        return { success: false, message: 'No hay certificado digital cargado' }
      }
      if (!config?.has_private_key_configured) {
        return { success: false, message: 'No hay clave privada cargada' }
      }
      if (config.expires_at && new Date(config.expires_at) < new Date()) {
        return { success: false, message: 'El certificado digital está vencido' }
      }

      // Obtener token fresco para testear
      const { token, sign } = await this.getWSAAToken(businessId, 'wsfe', true)

      // Consultar puntos de venta con el token real
      const puntosVenta = await this.getPuntosVenta(businessId)

      return {
        success: true,
        message: 'Conexión exitosa con ARCA',
        details: {
          ambiente:             config.ambiente,
          puntosVenta,
          tokenOk:              !!token,
          signOk:               !!sign,
          ultimaSincronizacion: new Date().toISOString(),
        },
      }
    } catch (error: any) {
      console.error('Error testing ARCA connection:', error)

      // AFIP-S1B-A2: estado por RPC (sin DML directo). El mensaje va sanitizado
      // (sin PEM/XML/token); el server además lo trunca a 500.
      try {
        await this.setEstadoConexion(businessId, 'error', error)
      } catch (persistErr) {
        console.error('No se pudo registrar el estado de conexión ARCA:', persistErr)
      }

      return { success: false, message: error.message || 'Error al conectar con ARCA' }
    }
  }

  // ──────────────────────────────────────────────
  // Puntos de venta
  // ──────────────────────────────────────────────

  static async getPuntosVenta(businessId: string): Promise<number[]> {
    try {
      const config = await this.getArcaConfig(businessId)

      // AFIP tiene CORS restrictivo: la consulta real de puntos de venta (FEParamGetPtosVenta)
      // requiere una llamada SOAP server-side. El frontend no construye URLs de ARCA
      // (ver afip-cae/index.ts::resolveWsfeUrl, única fuente de verdad).
      // Por ahora devolvemos el punto de venta configurado como fallback.
      return config.punto_venta ? [config.punto_venta] : [1]
    } catch {
      return [1]
    }
  }

  // ──────────────────────────────────────────────
  // Último comprobante autorizado
  // ──────────────────────────────────────────────

  static async getUltimoComprobante(
    _businessId: string,
    _puntoVenta: number,
    _tipoComprobante: number
  ): Promise<number> {
    // FECompUltimoAutorizado requiere llamada SOAP directa desde el server
    // (sin CORS en el cliente, y sin que el frontend decida la URL de ARCA).
    // La Edge Function afip-cae ya la consulta internamente antes de pedir el CAE.
    // Este método devuelve 0 para no duplicar esa lógica en el cliente.
    return 0
  }

  // ──────────────────────────────────────────────
  // Emisión de factura (via Edge Function)
  // ──────────────────────────────────────────────

  static async emitirFactura(
    businessId: string,
    datosFactura: {
      tipo_comprobante:  number
      tipo_doc_receptor: number
      nro_doc_receptor:  string
      concepto:          number
      importe_neto:      number
      importe_iva:       number
      alicuota_iva:      number
      importe_total:     number
      moneda?:           string
      cotizacion_moneda?: number
      fecha_cbte?:       string
      // Nota de Crédito: referencia al comprobante original (CbtesAsoc)
      cbte_asoc_tipo?:    number
      cbte_asoc_pto_vta?: number
      cbte_asoc_nro?:     number
      // Condición IVA del receptor (RG AFIP — será obligatorio)
      condicion_iva_receptor_id?: number
      // ID del comprobante local y del intento ya reclamado atómicamente vía
      // la RPC claim_comprobante_arca_emission. OBLIGATORIOS: afip-cae rechaza
      // la solicitud si faltan (nunca emite fiscalmente sin una identidad
      // local persistente y sin un claim ya adquirido — ver
      // supabase/migrations/20260701150000_arca_atomic_claim.sql). No llamar
      // a este método directamente: usar comprobanteService (que reclama el
      // attempt_id por vos).
      comprobante_id: string
      attempt_id: string
    }
  ): Promise<{
    success: boolean
    cae?: string
    caeVencimiento?: string
    numeroComprobante?: string
    observaciones?: string
    error?: string
    /** Discriminante fino del resultado — ver EmissionOutcome en afip-cae/logic.ts. */
    outcome?: 'authorized' | 'authorized_reconciled' | 'rejected' | 'not_sent' | 'pending_reconciliation'
    /** true si el CAE se recuperó vía FECompConsultar en vez de una respuesta directa. */
    reconciled?: boolean
    /** true si ARCA no pudo confirmar el resultado — no reintentar automáticamente. */
    pendingReconciliation?: boolean
  }> {
    try {
      const config = await this.getArcaConfig(businessId)

      // Timeout generoso: la Edge Function puede reconciliar (FECompConsultar)
      // ante un resultado ambiguo antes de responder, lo que puede tardar más
      // que una sola llamada SOAP. Si igual se agota, el comprobante queda
      // pendiente de conciliación y se resuelve solo en el próximo reintento
      // (afip-cae detecta el intento previo server-side).
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ARCA no respondió a tiempo. El comprobante quedó pendiente de emisión.')), 45_000)
      )

      const invokeResult = await Promise.race([
        supabase.functions.invoke('afip-cae', {
          body: {
            business_id:  businessId,
            cuit:         config.cuit?.replace(/\D/g, '') || '',
            punto_venta:  config.punto_venta || 1,
            ambiente:     config.ambiente || 'homologacion',
            ...datosFactura,
          },
        }),
        timeout,
      ])

      const { data, error } = invokeResult as { data: any; error: any }

      if (error) {
        // Supabase discards the response body for non-2xx and returns a generic
        // message. Try to extract the real error from the response context.
        let msg = error.message || 'Error al conectar con afip-cae'
        let body: any
        try {
          if (error.context?.json) {
            body = await error.context.json()
            if (body?.error) msg = body.error
          }
        } catch {/* context not readable — use generic message */}

        // `not_sent` (502) y `pending_reconciliation` (200 con success:false) llegan
        // acá también según el status HTTP; propagamos el detalle si lo tenemos.
        if (body?.pending_reconciliation) {
          return { success: false, error: msg, outcome: 'pending_reconciliation', pendingReconciliation: true }
        }
        throw new Error(msg)
      }
      if (!data?.success) {
        return {
          success: false,
          error: data?.error || 'Error al solicitar CAE',
          outcome: data?.outcome,
          pendingReconciliation: !!data?.pending_reconciliation,
        }
      }

      return {
        success:           true,
        cae:               data.cae,
        caeVencimiento:    data.cae_vencimiento,
        numeroComprobante: data.numero_comprobante,
        observaciones:     data.observaciones,
        outcome:           data.outcome,
        reconciled:        !!data.reconciled,
      }
    } catch (error: any) {
      console.error('Error emitting invoice:', error)
      return { success: false, error: error.message || 'Error al emitir factura' }
    }
  }

  // ──────────────────────────────────────────────
  // Consultar comprobante
  // ──────────────────────────────────────────────

  static async consultarComprobante(
    businessId: string,
    puntoVenta: number,
    tipoComprobante: number,
    numero: number
  ): Promise<any> {
    // Nota: requeriría una Edge Function adicional para evitar CORS.
    // Por ahora busca en la tabla local de comprobantes.
    try {
      const { data } = await supabase
        .from('comprobantes')
        .select('*')
        .eq('business_id', businessId)
        .eq('punto_venta', puntoVenta)
        .eq('tipo_comprobante', tipoComprobante)
        .eq('numero', numero)
        .single()
      return data
    } catch (error) {
      console.error('Error consulting invoice:', error)
      throw new Error('Error al consultar comprobante')
    }
  }

  // ──────────────────────────────────────────────
  // Parámetros (tipos de comprobante, monedas, IVA)
  // ──────────────────────────────────────────────

  /**
   * Devuelve los tipos de comprobante. Los carga desde la tabla arca_parametros
   * (previamente sincronizados) o usa los valores hardcodeados estándar de AFIP.
   */
  static async getTiposComprobante(businessId: string): Promise<{ codigo: string; descripcion: string }[]> {
    const DEFAULTS = [
      { codigo: '01', descripcion: 'Factura A' },
      { codigo: '06', descripcion: 'Factura B' },
      { codigo: '11', descripcion: 'Factura C' },
      { codigo: '51', descripcion: 'Factura M' },
      { codigo: '02', descripcion: 'Nota de Débito A' },
      { codigo: '03', descripcion: 'Nota de Crédito A' },
      { codigo: '07', descripcion: 'Nota de Crédito B' },
      { codigo: '08', descripcion: 'Nota de Crédito C' },
    ]
    try {
      const { data } = await supabase
        .from('arca_parametros')
        .select('datos')
        .eq('business_id', businessId)
        .eq('tipo', 'tipos_comprobante')
        .single()
      return (data?.datos as any[]) || DEFAULTS
    } catch {
      return DEFAULTS
    }
  }

  static async getAlicuotasIVA(businessId: string): Promise<{ codigo: string; descripcion: string; valor: number }[]> {
    const DEFAULTS = [
      { codigo: '3', descripcion: '0%',    valor: 0 },
      { codigo: '4', descripcion: '10.5%', valor: 10.5 },
      { codigo: '5', descripcion: '21%',   valor: 21 },
      { codigo: '6', descripcion: '27%',   valor: 27 },
      { codigo: '8', descripcion: 'Exento',    valor: 0 },
      { codigo: '9', descripcion: 'No gravado', valor: 0 },
    ]
    try {
      const { data } = await supabase
        .from('arca_parametros')
        .select('datos')
        .eq('business_id', businessId)
        .eq('tipo', 'alicuotas_iva')
        .single()
      return (data?.datos as any[]) || DEFAULTS
    } catch {
      return DEFAULTS
    }
  }

  // ──────────────────────────────────────────────
  // Sincronización de parámetros
  // ──────────────────────────────────────────────

  static async sincronizarTiposComprobante(businessId: string) {
    try {
      const tipos = await this.getTiposComprobante(businessId)
      await supabase.from('arca_parametros').upsert({
        business_id: businessId,
        tipo: 'tipos_comprobante',
        datos: tipos,
        actualizado: new Date().toISOString(),
      }, { onConflict: 'business_id,tipo' })
      return { success: true, tipos }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  static async sincronizarMonedas(businessId: string) {
    const monedas = [
      { codigo: 'PES', descripcion: 'Pesos Argentinos',         decimales: 2 },
      { codigo: 'DOL', descripcion: 'Dólares Estadounidenses',  decimales: 2 },
      { codigo: 'EUR', descripcion: 'Euros',                    decimales: 2 },
      { codigo: 'BRL', descripcion: 'Reales',                   decimales: 2 },
    ]
    try {
      await supabase.from('arca_parametros').upsert({
        business_id: businessId,
        tipo: 'monedas',
        datos: monedas,
        actualizado: new Date().toISOString(),
      }, { onConflict: 'business_id,tipo' })
      return { success: true, monedas }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  static async sincronizarAlicuotasIVA(businessId: string) {
    try {
      const alicuotas = await this.getAlicuotasIVA(businessId)
      await supabase.from('arca_parametros').upsert({
        business_id: businessId,
        tipo: 'alicuotas_iva',
        datos: alicuotas,
        actualizado: new Date().toISOString(),
      }, { onConflict: 'business_id,tipo' })
      return { success: true, alicuotas }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  static async sincronizarTodosParametros(businessId: string) {
    try {
      const resultados = {
        tiposComprobante: await this.sincronizarTiposComprobante(businessId),
        monedas:          await this.sincronizarMonedas(businessId),
        alicuotasIVA:     await this.sincronizarAlicuotasIVA(businessId),
      }
      const allSuccess = Object.values(resultados).every(r => r.success)
      return { success: allSuccess, resultados }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  // ──────────────────────────────────────────────
  // Certificados
  // ──────────────────────────────────────────────
  // AFIP-S1B-A2: `uploadCertificate` fue ELIMINADO. Aceptaba `private_key` en el
  // frontend y escribía secretos vía DML directo — vector prohibido. La carga del
  // certificado PÚBLICO ahora pasa por `saveCertificate` (RPC, solo cert_file). La
  // clave privada la genera server-side `generate-csr` y NUNCA la toca el cliente.
}

export default ArcaService
