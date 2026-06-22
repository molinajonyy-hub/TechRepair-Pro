/**
 * whatsappFormat — helpers PUROS de WhatsApp (sin Supabase ni React).
 *
 * Centraliza la única lógica de:
 *  - Normalización de teléfonos (AR + internacional).
 *  - Construcción de links (wa.me / WhatsApp Web / Desktop).
 *  - Interpolación de plantillas.
 *
 * Al no depender de `../lib/supabase` (que requiere variables de entorno de
 * Vite), este módulo es importable y testeable con el runner nativo `node:test`.
 * `whatsappService` lo re-exporta para mantener compatibilidad de imports.
 */

// ============================================
// TIPOS
// ============================================

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
  // Extended context vars
  problema?: string
  tipo_comprobante?: string
  numero_comprobante?: string
  fecha_vencimiento?: string
  codigo_garantia?: string
  presupuesto?: string
  telefono?: string
  negocio?: string
}

export interface NormalizedPhone {
  /** Digits only, ready for wa.me / Cloud API (e.g. "5493511234567"). */
  normalized: string
  /** True only when the result is a usable E.164-style number. */
  valid: boolean
  /** Human-friendly reason when invalid. */
  error?: string
}

// ============================================
// NORMALIZACIÓN DE TELÉFONOS
// ============================================

/**
 * Quita el prefijo móvil "15" embebido en un número local argentino.
 * El "15" se inserta entre la característica (2-4 dígitos) y el abonado.
 * Un número local AR sin código de país tiene 10 dígitos; con "15" tiene 12.
 * Ejemplos: 11 15 XXXXXXXX (BsAs), 351 15 XXXXXXX (Córdoba), 2966 15 XXXXXX.
 */
export function stripArgentineMobile15(local: string): string {
  if (local.length === 12) {
    // El "15" aparece justo después de la característica (longitud 2, 3 o 4).
    for (const areaLen of [2, 3, 4]) {
      if (local.slice(areaLen, areaLen + 2) === '15') {
        return local.slice(0, areaLen) + local.slice(areaLen + 2)
      }
    }
  }
  // Algunos guardan el "15" al inicio (móvil sin característica): 15XXXXXXXX
  if (local.length === 11 && local.startsWith('15')) return local.slice(2)
  return local
}

/**
 * FUENTE ÚNICA de normalización de teléfonos para WhatsApp.
 *
 * Soporta Argentina (código 54, móvil 9, quita 0 de característica y 15 local)
 * sin romper números internacionales:
 *  - Con "+" o "00" y país ≠ 54 → se preserva tal cual (no se aplican reglas AR).
 *  - Argentino → siempre devuelve 549 + 10 dígitos (formato móvil E.164).
 *  - Evita duplicar 54 o 9.
 *
 * Devuelve { normalized, valid, error }. `valid` es false ante números vacíos,
 * incompletos o internacionales fuera de rango — nunca produce "undefined".
 */
export function normalizeWhatsAppPhone(phone: string | null | undefined): NormalizedPhone {
  const raw = (phone ?? '').trim()
  if (!raw) return { normalized: '', valid: false, error: 'Sin teléfono' }

  const hadPlus = raw.startsWith('+')
  let digits = raw.replace(/\D/g, '')
  if (!digits) return { normalized: '', valid: false, error: 'Número inválido' }

  // Prefijo internacional 00 → equivalente a "+"
  let explicitIntl = hadPlus
  if (!hadPlus && digits.startsWith('00')) {
    digits = digits.slice(2)
    explicitIntl = true
  }

  // Internacional explícito y NO argentino → preservar sin tocar (regla no destructiva)
  if (explicitIntl && !digits.startsWith('54')) {
    const valid = digits.length >= 8 && digits.length <= 15
    return { normalized: digits, valid, error: valid ? undefined : 'Número internacional inválido' }
  }

  // Quitar 0 de trunk nacional (011 → 11) sólo si no tiene código de país
  if (!digits.startsWith('54') && digits.startsWith('0')) digits = digits.slice(1)

  let local: string
  if (digits.startsWith('54')) {
    let rest = digits.slice(2)
    if (rest.startsWith('0')) rest = rest.slice(1)          // 54 0351… defensivo
    if (rest.startsWith('9')) rest = rest.slice(1)          // 549… → quitar 9 (se reañade), evita doble 9
    local = stripArgentineMobile15(rest)
  } else {
    local = stripArgentineMobile15(digits)
  }

  const normalized = '549' + local
  const valid = normalized.length === 13
  return { normalized, valid, error: valid ? undefined : 'Número incompleto o inválido' }
}

/**
 * @deprecated Usar `normalizeWhatsAppPhone(phone).normalized`.
 * Se mantiene como wrapper para compatibilidad de imports existentes.
 */
export function normalizePhone(phone: string): string {
  return normalizeWhatsAppPhone(phone).normalized
}

// ============================================
// CONSTRUCCIÓN DE LINKS
// ============================================

/** Detecta si estamos en un dispositivo móvil/tablet. */
export function isMobileDevice(): boolean {
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

/**
 * Genera el link wa.me con mensaje pre-cargado.
 * Usa el normalizador central (formato móvil AR 549… correcto).
 */
export function generateWhatsAppLink(phone: string, message: string): string {
  const { normalized } = normalizeWhatsAppPhone(phone)
  const encoded = encodeURIComponent(message)
  if (!normalized) return `https://wa.me/?text=${encoded}`
  return `https://wa.me/${normalized}?text=${encoded}`
}

/**
 * URL de WhatsApp Web (desktop).
 * Abre directamente en web.whatsapp.com evitando la pantalla intermedia de
 * api.whatsapp.com. Reutiliza la pestaña si se llama con el mismo target name.
 */
export function buildWhatsAppWebUrl(phone: string, message: string): string {
  const { normalized } = normalizeWhatsAppPhone(phone)
  return `https://web.whatsapp.com/send?phone=${normalized}&text=${encodeURIComponent(message)}`
}

/**
 * URL universal wa.me (mobile / fallback).
 * En móvil abre la app nativa; en desktop muestra la pantalla de selección.
 */
export function buildWhatsAppUniversalUrl(phone: string, message: string): string {
  const { normalized } = normalizeWhatsAppPhone(phone)
  if (!normalized) return `https://wa.me/?text=${encodeURIComponent(message)}`
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`
}

/**
 * URL inteligente según plataforma:
 * - Desktop → web.whatsapp.com/send (sin pantalla intermedia)
 * - Mobile  → wa.me (abre app nativa)
 */
export function buildWhatsAppFallbackUrl(phone: string, message: string): string {
  return isMobileDevice()
    ? buildWhatsAppUniversalUrl(phone, message)
    : buildWhatsAppWebUrl(phone, message)
}

/**
 * URL con protocolo whatsapp:// para la app de escritorio (WhatsApp Desktop).
 * No abre una pestaña nueva — el OS delega en la app instalada.
 */
export function buildWhatsAppDesktopUrl(phone: string, message: string): string {
  const { normalized } = normalizeWhatsAppPhone(phone)
  return `whatsapp://send?phone=${normalized}&text=${encodeURIComponent(message)}`
}

/**
 * Abre WhatsApp reutilizando siempre la misma pestaña del navegador.
 * No se usa noopener para que el named-window funcione correctamente.
 * Devuelve la referencia de ventana (null si el navegador bloqueó el popup).
 */
export function openWhatsAppWindow(url: string): Window | null {
  return window.open(url, 'techrepair-whatsapp-web')
}

/**
 * Navega a una URL de protocolo whatsapp:// sin abrir pestaña nueva.
 * Equivalente a hacer click en un link tel: o mailto:.
 */
export function openWhatsAppDesktop(url: string): void {
  window.location.href = url
}

// ============================================
// INTERPOLACIÓN DE PLANTILLAS
// ============================================

/**
 * Reemplaza variables {variable} con valores reales.
 * Si una variable no existe, la deja vacía (no "undefined" ni "null").
 */
export function interpolateTemplate(template: string, vars: WhatsAppVars): string {
  let result = template
  const replacements: Record<string, string> = {
    nombre:            vars.nombre            || '',
    apellido:          vars.apellido          || '',
    cliente:           vars.cliente           || vars.nombre || '',
    equipo:            vars.equipo            || '',
    marca:             vars.marca             || '',
    modelo:            vars.modelo            || '',
    estado:            vars.estado            || '',
    precio:            vars.precio            || '',
    anticipo:          vars.anticipo          || '',
    saldo:             vars.saldo             || '',
    numero_orden:      vars.numero_orden      || '',
    local:             vars.local             || vars.negocio || '',
    negocio:           vars.negocio           || vars.local || '',
    direccion:         vars.direccion         || '',
    whatsapp:          vars.whatsapp          || vars.telefono || '',
    telefono:          vars.telefono          || vars.whatsapp || '',
    instagram:         vars.instagram         || '',
    horario:           vars.horario           || '',
    fecha:             vars.fecha             || new Date().toLocaleDateString('es-AR'),
    tipo_comprobante:  vars.tipo_comprobante  || '',
    numero_comprobante:vars.numero_comprobante|| '',
    fecha_vencimiento: vars.fecha_vencimiento || '',
    codigo_garantia:   vars.codigo_garantia   || '',
    presupuesto:       vars.presupuesto       || vars.precio || '',
  }

  for (const [key, value] of Object.entries(replacements)) {
    // Reemplazo con función para que '$' en importes (p. ej. "$1.234") no se
    // interprete como patrón especial de String.replace ($&, $1, etc.).
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), () => value)
  }

  return result
}
