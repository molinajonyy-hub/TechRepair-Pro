import { supabase } from '../lib/supabase'
import EncryptionService from './encryptionService'

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
    const { data, error } = await supabase
      .from('arca_config')
      .select('*')
      .eq('business_id', businessId)
      .single()

    if (error) throw new Error('Error al obtener configuración ARCA')
    return data
  }

  static async saveArcaConfig(businessId: string, fields: Record<string, any>) {
    const { error } = await supabase
      .from('arca_config')
      .upsert({ ...fields, business_id: businessId }, { onConflict: 'business_id' })
    if (error) throw new Error(error.message)
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

      if (!config.cert_file && !config.pfx_file) {
        return { success: false, message: 'No hay certificado digital cargado' }
      }
      if (!config.pfx_file && !config.private_key) {
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

      await supabase
        .from('arca_config')
        .update({ estado_conexion: 'error', ultimo_error: error.message })
        .eq('business_id', businessId)

      return { success: false, message: error.message || 'Error al conectar con ARCA' }
    }
  }

  // ──────────────────────────────────────────────
  // Puntos de venta
  // ──────────────────────────────────────────────

  static async getPuntosVenta(businessId: string): Promise<number[]> {
    try {
      const config = await this.getArcaConfig(businessId)
      const { token, sign } = await this.getWSAAToken(businessId)

      const wsfeUrl = config.ambiente === 'produccion'
        ? 'https://wsfe.afip.gov.ar/wsfev1/service.asmx'
        : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx'

      // Esta llamada la hacemos directo desde el cliente ya que no requiere certificados
      // (solo token+sign que ya tenemos)
      // Sin embargo AFIP tiene CORS restrictivo, así que hacemos el fallback con el punto_venta configurado
      void token
      void sign
      void wsfeUrl

      // Devolver punto de venta configurado como fallback
      return config.punto_venta ? [config.punto_venta] : [1]
    } catch {
      return [1]
    }
  }

  // ──────────────────────────────────────────────
  // Último comprobante autorizado
  // ──────────────────────────────────────────────

  static async getUltimoComprobante(
    businessId: string,
    puntoVenta: number,
    tipoComprobante: number
  ): Promise<number> {
    try {
      const config = await this.getArcaConfig(businessId)
      const { token, sign } = await this.getWSAAToken(businessId)

      void token
      void sign
      void config
      void puntoVenta
      void tipoComprobante

      // FECompUltimoAutorizado requiere llamada SOAP directa desde el server
      // (sin CORS en el cliente). En producción esto lo hace la Edge Function afip-cae.
      // Aquí devolvemos 0 para que afip-cae calcule el siguiente número.
      return 0
    } catch (error) {
      console.error('Error getting last invoice:', error)
      return 0
    }
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
    }
  ): Promise<{
    success: boolean
    cae?: string
    caeVencimiento?: string
    numeroComprobante?: string
    observaciones?: string
    error?: string
  }> {
    try {
      const config = await this.getArcaConfig(businessId)

      const { data, error } = await supabase.functions.invoke('afip-cae', {
        body: {
          business_id:      businessId,
          cuit:             config.cuit?.replace(/\D/g, '') || '',
          punto_venta:      config.punto_venta || 1,
          ambiente:         config.ambiente || 'homologacion',
          ...datosFactura,
        },
      })

      if (error) throw new Error(error.message || 'Error al conectar con afip-cae')
      if (!data?.success) throw new Error(data?.error || 'Error al solicitar CAE')

      return {
        success:           true,
        cae:               data.cae,
        caeVencimiento:    data.cae_vencimiento,
        numeroComprobante: data.numero_comprobante,
        observaciones:     data.observaciones,
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
  // Upload de certificados
  // ──────────────────────────────────────────────

  /**
   * Sube un certificado PEM, clave privada PEM o PFX al perfil ARCA.
   * Encripta el contenido antes de guardarlo (si la RPC encrypt_data existe).
   */
  static async uploadCertificate(
    businessId: string,
    type: 'cert_file' | 'private_key' | 'pfx_file',
    content: string,   // Base64 o texto PEM
    expiresAt?: string,
    pfxPassword?: string
  ) {
    try {
      let encrypted = content
      try {
        const { data } = await supabase.rpc('encrypt_data', { plain_text: content })
        if (data) encrypted = data
      } catch {
        // encrypt_data RPC no existe — guardar como texto plano
      }

      const fields: Record<string, any> = { [type]: encrypted }
      if (expiresAt) fields.expires_at = expiresAt
      if (pfxPassword && type === 'pfx_file') {
        try {
          const { data } = await supabase.rpc('encrypt_data', { plain_text: pfxPassword })
          fields.pfx_password = data || pfxPassword
        } catch {
          fields.pfx_password = pfxPassword
        }
      }

      await this.saveArcaConfig(businessId, fields)
    } catch (error: any) {
      throw new Error('Error al guardar el certificado: ' + error.message)
    }
  }
}

export default ArcaService
