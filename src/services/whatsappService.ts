import { supabase } from '../lib/supabase'
import { OrderStatus, STATUS_CONFIG } from '../types/orderStatus'

// ============================================
// TIPOS
// ============================================

export interface WhatsAppSettings {
  id?: string
  business_id?: string
  enabled: boolean
  auto_send_enabled: boolean
  business_name: string
  business_address: string
  business_whatsapp: string
  business_instagram: string
  business_hours: string
  closing_message: string
  // API Mode (WhatsApp Business Cloud API)
  api_mode?: boolean
  phone_number_id?: string
  access_token?: string
}

export interface WhatsAppTemplate {
  id?: string
  business_id?: string
  status_key: string
  status_label: string
  message_template: string
  auto_send: boolean
  is_active: boolean
}

export interface WhatsAppLog {
  id?: string
  business_id?: string
  order_id?: string
  customer_id?: string
  phone?: string
  status_key?: string
  message: string
  send_mode: 'manual' | 'auto' | 'api'
  send_result: 'opened' | 'copied' | 'failed' | 'skipped' | 'sent_api'
  error_message?: string
  created_at?: string
}

export interface WhatsAppVars {
  nombre?: string
  apellido?: string
  cliente?: string
  equipo?: string
  marca?: string
  modelo?: string
  estado?: string
  precio?: string
  anticipo?: string
  saldo?: string
  numero_orden?: string
  local?: string
  direccion?: string
  whatsapp?: string
  instagram?: string
  horario?: string
  fecha?: string
}

// ============================================
// MAPEO ESTADO → TEMPLATE KEY
// ============================================

export const STATUS_TO_TEMPLATE_KEY: Record<OrderStatus, string> = {
  new:             'received',
  diagnosis:       'diagnosing',
  waiting_approval:'waiting_approval',
  repair:          'repairing',
  waiting_parts:   'waiting_parts',
  ready_delivery:  'ready_pickup',
  waiting_payment: 'waiting_payment',
  completed:       'delivered',
  cancelled:       'cancelled',
}

// ============================================
// PLANTILLAS POR DEFECTO
// ============================================

export const DEFAULT_TEMPLATES: Omit<WhatsAppTemplate, 'id' | 'business_id'>[] = [
  {
    status_key: 'received',
    status_label: 'Recibido',
    auto_send: false,
    is_active: true,
    message_template:
      'Hola {nombre} 👋\n' +
      'Recibimos correctamente tu equipo {marca} {modelo} en {local}.\n' +
      'Tu número de orden es #{numero_orden}.\n' +
      'En breve vamos a revisarlo y te mantendremos informado.\n' +
      '¡Gracias por confiar en nosotros!',
  },
  {
    status_key: 'diagnosing',
    status_label: 'En Diagnóstico',
    auto_send: false,
    is_active: true,
    message_template:
      'Hola {nombre} 👋\n' +
      'Queremos avisarte que ya estamos realizando el diagnóstico de tu equipo {marca} {modelo}.\n' +
      'Apenas tengamos novedades o presupuesto, te escribimos por este medio.\n' +
      'Gracias por tu paciencia.',
  },
  {
    status_key: 'waiting_approval',
    status_label: 'Esperando Aprobación',
    auto_send: false,
    is_active: true,
    message_template:
      'Hola {nombre} 👋\n' +
      'Tu equipo ya fue revisado y estamos esperando tu confirmación para continuar con la reparación.\n' +
      'Si querés avanzar, respondé este mensaje y seguimos con el trabajo.',
  },
  {
    status_key: 'repairing',
    status_label: 'En Reparación',
    auto_send: false,
    is_active: true,
    message_template:
      'Hola {nombre} 👋\n' +
      'Te confirmamos que ya comenzamos la reparación de tu equipo {marca} {modelo}.\n' +
      'Te vamos avisando apenas esté terminado.\n' +
      'Gracias por confiar en {local}.',
  },
  {
    status_key: 'waiting_parts',
    status_label: 'Esperando Repuesto',
    auto_send: false,
    is_active: true,
    message_template:
      'Hola {nombre} 👋\n' +
      'Tu equipo se encuentra en espera porque estamos aguardando el repuesto necesario para continuar.\n' +
      'Apenas tengamos novedades, te informamos por aquí.\n' +
      'Gracias por tu paciencia.',
  },
  {
    status_key: 'ready_pickup',
    status_label: 'Listo para Retirar',
    auto_send: true,
    is_active: true,
    message_template:
      'Hola {nombre} 🙌\n' +
      'Tu equipo {marca} {modelo} ya está listo para retirar.\n' +
      'Podés pasar por {local} en nuestro horario: {horario}.\n' +
      'Dirección: {direccion}\n' +
      'Cualquier consulta, escribinos a {whatsapp}.',
  },
  {
    status_key: 'waiting_payment',
    status_label: 'Esperando Pago',
    auto_send: false,
    is_active: true,
    message_template:
      'Hola {nombre} 👋\n' +
      'Tu equipo {marca} {modelo} está listo. El total a abonar es de {precio}.\n' +
      'Ante cualquier duda, respondé este mensaje y te ayudamos.',
  },
  {
    status_key: 'delivered',
    status_label: 'Entregado',
    auto_send: false,
    is_active: true,
    message_template:
      'Hola {nombre} 😊\n' +
      'Gracias por confiar en {local}.\n' +
      'Te entregamos tu equipo correctamente y esperamos que todo funcione perfecto.\n' +
      'Cualquier inconveniente o consulta, estamos a disposición.',
  },
  {
    status_key: 'cancelled',
    status_label: 'Cancelado',
    auto_send: false,
    is_active: true,
    message_template:
      'Hola {nombre}.\n' +
      'Te informamos que la orden #{numero_orden} fue cancelada.\n' +
      'Si querés retomar el servicio más adelante o necesitás ayuda, podés comunicarte con nosotros.',
  },
]

export const DEFAULT_SETTINGS: Omit<WhatsAppSettings, 'id' | 'business_id'> = {
  enabled: false,
  auto_send_enabled: false,
  business_name: '',
  business_address: '',
  business_whatsapp: '',
  business_instagram: '',
  business_hours: '',
  closing_message: 'Saludos, {local}.\nWhatsApp: {whatsapp}\nInstagram: {instagram}',
}

// ============================================
// HELPERS
// ============================================

/**
 * Normaliza un número de teléfono para usar en wa.me
 * Elimina espacios, guiones, paréntesis y el + inicial
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  // Quitar todo excepto dígitos
  let cleaned = phone.replace(/\D/g, '')
  // Si empieza con 0, quitar el 0 (para Argentina: 011 → 11)
  if (cleaned.startsWith('0')) cleaned = cleaned.slice(1)
  // Si no tiene código de país y parece argentino (10 dígitos), agregar 54
  if (cleaned.length === 10) cleaned = '54' + cleaned
  return cleaned
}

/**
 * Genera el link de WhatsApp con mensaje pre-cargado
 */
export function generateWhatsAppLink(phone: string, message: string): string {
  const normalized = normalizePhone(phone)
  const encoded = encodeURIComponent(message)
  if (!normalized) return `https://wa.me/?text=${encoded}`
  return `https://wa.me/${normalized}?text=${encoded}`
}

/**
 * Reemplaza variables {variable} con valores reales
 * Si una variable no existe, la deja vacía (no "undefined" ni "null")
 */
export function interpolateTemplate(template: string, vars: WhatsAppVars): string {
  let result = template
  const replacements: Record<string, string> = {
    nombre:       vars.nombre       || '',
    apellido:     vars.apellido     || '',
    cliente:      vars.cliente      || vars.nombre || '',
    equipo:       vars.equipo       || '',
    marca:        vars.marca        || '',
    modelo:       vars.modelo       || '',
    estado:       vars.estado       || '',
    precio:       vars.precio       || '',
    anticipo:     vars.anticipo     || '',
    saldo:        vars.saldo        || '',
    numero_orden: vars.numero_orden || '',
    local:        vars.local        || '',
    direccion:    vars.direccion    || '',
    whatsapp:     vars.whatsapp     || '',
    instagram:    vars.instagram    || '',
    horario:      vars.horario      || '',
    fecha:        vars.fecha        || new Date().toLocaleDateString('es-AR'),
  }

  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value)
  }

  return result
}

/**
 * Construye las variables para una orden
 */
export function buildOrderVars(order: any, settings: WhatsAppSettings): WhatsAppVars {
  const customer = order.customer || {}
  const device   = order.device   || {}

  // Primer nombre solamente
  const fullName = customer.name || ''
  const firstName = fullName.split(' ')[0] || fullName
  const lastName  = fullName.split(' ').slice(1).join(' ') || ''

  const total = order.total_cost || order.estimated_total || 0
  const advance = order.payments?.reduce((s: number, p: any) => s + (p.amount || 0), 0) || 0
  const balance = Math.max(0, total - advance)

  const shortId = (order.id || '').slice(0, 8).toUpperCase()

  return {
    nombre:       firstName,
    apellido:     lastName,
    cliente:      fullName,
    equipo:       device.type || device.brand || '',
    marca:        device.brand || '',
    modelo:       device.model || '',
    estado:       order.status ? STATUS_CONFIG[order.status as OrderStatus]?.label || '' : '',
    precio:       total > 0 ? `$${total.toLocaleString('es-AR')}` : '',
    anticipo:     advance > 0 ? `$${advance.toLocaleString('es-AR')}` : '',
    saldo:        balance > 0 ? `$${balance.toLocaleString('es-AR')}` : '',
    numero_orden: shortId,
    local:        settings.business_name    || '',
    direccion:    settings.business_address || '',
    whatsapp:     settings.business_whatsapp   || '',
    instagram:    settings.business_instagram  || '',
    horario:      settings.business_hours      || '',
    fecha:        new Date().toLocaleDateString('es-AR'),
  }
}

// ============================================
// SERVICIO
// ============================================

export const whatsappService = {

  // ---------- SETTINGS ----------

  async getSettings(businessId: string): Promise<WhatsAppSettings> {
    const { data } = await supabase
      .from('whatsapp_settings')
      .select('*')
      .eq('business_id', businessId)
      .single()

    if (!data) return { ...DEFAULT_SETTINGS }
    return data as WhatsAppSettings
  },

  async saveSettings(businessId: string, settings: Omit<WhatsAppSettings, 'id' | 'business_id'>): Promise<void> {
    const { data: existing } = await supabase
      .from('whatsapp_settings')
      .select('id')
      .eq('business_id', businessId)
      .single()

    if (existing) {
      const { error } = await supabase
        .from('whatsapp_settings')
        .update({ ...settings, updated_at: new Date().toISOString() })
        .eq('business_id', businessId)
      if (error) throw error
    } else {
      const { error } = await supabase
        .from('whatsapp_settings')
        .insert({ ...settings, business_id: businessId })
      if (error) throw error
    }
  },

  // ---------- TEMPLATES ----------

  async getTemplates(businessId: string): Promise<WhatsAppTemplate[]> {
    const { data } = await supabase
      .from('whatsapp_templates')
      .select('*')
      .eq('business_id', businessId)
      .order('status_key')

    if (!data || data.length === 0) {
      return DEFAULT_TEMPLATES.map(t => ({ ...t }))
    }

    // Merge con defaults para agregar templates que falten
    const existing = data as WhatsAppTemplate[]
    const merged = DEFAULT_TEMPLATES.map(def => {
      const found = existing.find(e => e.status_key === def.status_key)
      return found || { ...def }
    })
    return merged
  },

  async saveTemplate(businessId: string, template: WhatsAppTemplate): Promise<void> {
    if (template.id) {
      const { error } = await supabase
        .from('whatsapp_templates')
        .update({
          message_template: template.message_template,
          auto_send:        template.auto_send,
          is_active:        template.is_active,
          updated_at:       new Date().toISOString(),
        })
        .eq('id', template.id)
      if (error) throw error
    } else {
      const { error } = await supabase
        .from('whatsapp_templates')
        .upsert({
          business_id:      businessId,
          status_key:       template.status_key,
          status_label:     template.status_label,
          message_template: template.message_template,
          auto_send:        template.auto_send,
          is_active:        template.is_active,
        }, { onConflict: 'business_id,status_key' })
      if (error) throw error
    }
  },

  async saveAllTemplates(businessId: string, templates: WhatsAppTemplate[]): Promise<void> {
    for (const template of templates) {
      await this.saveTemplate(businessId, template)
    }
  },

  async resetTemplates(businessId: string): Promise<void> {
    // Eliminar las existentes
    await supabase
      .from('whatsapp_templates')
      .delete()
      .eq('business_id', businessId)

    // Insertar las por defecto
    const toInsert = DEFAULT_TEMPLATES.map(t => ({
      ...t,
      business_id: businessId,
    }))
    const { error } = await supabase
      .from('whatsapp_templates')
      .insert(toInsert)
    if (error) throw error
  },

  // ---------- LOGS ----------

  async logMessage(businessId: string, log: Omit<WhatsAppLog, 'id' | 'business_id' | 'created_at'>): Promise<void> {
    const { error } = await supabase
      .from('whatsapp_logs')
      .insert({ ...log, business_id: businessId })
    if (error) console.error('Error guardando log WhatsApp:', error)
  },

  async getLogs(orderId: string): Promise<WhatsAppLog[]> {
    const { data } = await supabase
      .from('whatsapp_logs')
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
    return (data as WhatsAppLog[]) || []
  },

  // ---------- ENVÍO VÍA API (WhatsApp Business Cloud API) ----------

  /**
   * Envía un mensaje real vía WhatsApp Business Cloud API (Meta).
   * Requiere phone_number_id y access_token configurados.
   * Llama a la Edge Function `whatsapp-send` de Supabase (sin CORS).
   */
  async sendViaAPI(
    businessId: string,
    phone: string,
    message: string,
    context: { order_id?: string; customer_id?: string; status_key?: string },
    credentials: { phone_number_id: string; access_token: string }
  ): Promise<{ success: boolean; message_id?: string; error?: string }> {
    try {
      const { data, error } = await supabase.functions.invoke('whatsapp-send', {
        body: {
          phone,
          message,
          phone_number_id: credentials.phone_number_id,
          access_token:    credentials.access_token,
          business_id:     businessId,
          order_id:        context.order_id,
          customer_id:     context.customer_id,
          status_key:      context.status_key,
          send_mode:       'api',
        },
      })

      if (error) throw error

      return {
        success:    data?.success ?? false,
        message_id: data?.message_id,
        error:      data?.error,
      }
    } catch (err: any) {
      console.error('Error sendViaAPI:', err)
      return { success: false, error: err?.message || 'Error al conectar con la API' }
    }
  },

  // ---------- ENVÍO MANUAL ----------

  /**
   * Abre WhatsApp con el mensaje precargado y guarda el log
   */
  async sendManual(
    businessId: string,
    phone: string,
    message: string,
    context: { order_id?: string; customer_id?: string; status_key?: string }
  ): Promise<{ success: boolean; link: string }> {
    const link = generateWhatsAppLink(phone, message)

    try {
      window.open(link, '_blank', 'noopener,noreferrer')
      await this.logMessage(businessId, {
        order_id:    context.order_id,
        customer_id: context.customer_id,
        phone,
        status_key:  context.status_key,
        message,
        send_mode:   'manual',
        send_result: 'opened',
      })
      return { success: true, link }
    } catch (err: any) {
      await this.logMessage(businessId, {
        order_id:      context.order_id,
        customer_id:   context.customer_id,
        phone,
        status_key:    context.status_key,
        message,
        send_mode:     'manual',
        send_result:   'failed',
        error_message: err?.message || 'Error desconocido',
      })
      return { success: false, link }
    }
  },

  async logCopy(
    businessId: string,
    phone: string,
    message: string,
    context: { order_id?: string; customer_id?: string; status_key?: string }
  ): Promise<void> {
    await this.logMessage(businessId, {
      order_id:    context.order_id,
      customer_id: context.customer_id,
      phone,
      status_key:  context.status_key,
      message,
      send_mode:   'manual',
      send_result: 'copied',
    })
  },

  // ---------- ENVÍO AUTOMÁTICO ----------

  /**
   * Se llama al cambiar el estado de una orden.
   * Evalúa si debe enviar automáticamente y lo hace.
   */
  async handleAutoSend(
    businessId: string,
    order: any,
    newStatus: OrderStatus
  ): Promise<{ sent: boolean; reason?: string }> {
    try {
      const settings = await this.getSettings(businessId)

      if (!settings.enabled) return { sent: false, reason: 'WhatsApp deshabilitado' }
      if (!settings.auto_send_enabled) return { sent: false, reason: 'Envío automático deshabilitado' }

      const phone = order.customer?.phone
      if (!phone) return { sent: false, reason: 'Cliente sin teléfono' }

      const templateKey = STATUS_TO_TEMPLATE_KEY[newStatus]
      if (!templateKey) return { sent: false, reason: 'Estado sin plantilla' }

      const templates = await this.getTemplates(businessId)
      const template = templates.find(t => t.status_key === templateKey)
      if (!template) return { sent: false, reason: 'Plantilla no encontrada' }
      if (!template.is_active) return { sent: false, reason: 'Plantilla inactiva' }
      if (!template.auto_send) return { sent: false, reason: 'Auto-envío desactivado para este estado' }

      const vars = buildOrderVars(order, settings)
      let message = interpolateTemplate(template.message_template, vars)

      if (settings.closing_message) {
        const closing = interpolateTemplate(settings.closing_message, vars)
        message = `${message}\n\n${closing}`
      }

      const context = {
        order_id:    order.id as string,
        customer_id: (order.customer_id || order.customer?.id) as string,
        status_key:  templateKey,
      }

      // API mode: envío silencioso sin abrir el navegador
      if (settings.api_mode && settings.phone_number_id && settings.access_token) {
        const apiResult = await this.sendViaAPI(
          businessId,
          phone,
          message,
          context,
          { phone_number_id: settings.phone_number_id, access_token: settings.access_token }
        )
        return {
          sent:   apiResult.success,
          reason: apiResult.success ? undefined : (apiResult.error || 'Error en API'),
        }
      }

      // Fallback: wa.me link (requiere interacción del usuario)
      const link = generateWhatsAppLink(phone, message)
      window.open(link, '_blank', 'noopener,noreferrer')

      await this.logMessage(businessId, {
        ...context,
        phone,
        message,
        send_mode:   'auto',
        send_result: 'opened',
      })

      return { sent: true }
    } catch (err: any) {
      console.error('Error en auto-send WhatsApp:', err)
      return { sent: false, reason: err?.message }
    }
  },
}

export default whatsappService
