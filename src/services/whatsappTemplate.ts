/**
 * whatsappTemplate — renderer W1 de plantillas de WhatsApp.
 *
 * PURO y determinista: sin Supabase, sin React, sin reloj, sin transporte.
 * Importable y testeable con el runner nativo `node:test` (igual que
 * `whatsappFormat.ts`).
 *
 * POR QUÉ EXISTE (y no alcanzaba `interpolateTemplate`):
 *
 *  1. `interpolateTemplate` (`whatsappFormat.ts`) reemplaza un set fijo de
 *     claves y deja LITERAL cualquier otro `{placeholder}` — comportamiento
 *     explícitamente fijado por su test unitario. Resultado: un `{desconocido}`
 *     viaja tal cual dentro de la URL de wa.me y el cliente lo ve.
 *  2. Reemplaza en bucle, una clave por vez. Un valor que contenga `{precio}`
 *     lo expande la iteración siguiente ⇒ template injection real.
 *  3. Una variable sin valor colapsa a string vacío sin avisar. La plantilla
 *     `debt_reminder` se renderiza como "tenés un saldo pendiente de  en …".
 *
 * Este módulo cierra los tres: allowlist explícita, UNA sola pasada con
 * replacer (un valor inyectado nunca se re-expande) y un reporte de qué quedó
 * sin resolver.
 *
 * SINTAXIS: `{clave}` — la que ya usan las plantillas guardadas en
 * `whatsapp_templates` en producción. No se migra a `{{clave}}`: cambiaría el
 * significado de cada plantilla que los negocios ya editaron.
 *
 * DOS NIVELES DE VARIABLE (por qué no todas bloquean):
 *  · `dato`   — identidad de la orden/cliente e IMPORTES. Un hueco acá
 *               desinforma ("el total a abonar es de "). Queda LITERAL en el
 *               texto y BLOQUEA la apertura de WhatsApp.
 *  · `perfil` — datos del negocio (dirección, horario, redes). Un hueco
 *               degrada el mensaje pero no miente. Colapsa a vacío y se
 *               reporta como aviso NO bloqueante, para no romper el primer
 *               uso de un negocio que todavía no completó su configuración.
 */

// ============================================
// ALLOWLIST
// ============================================

/** Nivel de exigencia de una variable. Ver el encabezado del módulo. */
export type WhatsAppVariableLevel = 'dato' | 'perfil'

export interface WhatsAppVariableSpec {
  key: string
  label: string
  /** Valor de muestra para la vista previa del editor de plantillas. */
  ejemplo: string
  level: WhatsAppVariableLevel
}

/**
 * ÚNICA fuente de verdad de qué placeholders acepta una plantilla.
 * Cualquier `{otra_cosa}` es un placeholder desconocido y bloquea el envío.
 */
export const WHATSAPP_VARIABLES: readonly WhatsAppVariableSpec[] = [
  // ── Cliente ────────────────────────────────────────────────────────────
  { key: 'nombre',             label: 'Nombre del cliente',      ejemplo: 'Ana',                 level: 'dato' },
  { key: 'apellido',           label: 'Apellido del cliente',    ejemplo: 'Gómez',               level: 'dato' },
  { key: 'cliente',            label: 'Nombre completo',         ejemplo: 'Ana Gómez',           level: 'dato' },
  { key: 'telefono',           label: 'Teléfono del cliente',    ejemplo: '351 1234567',         level: 'dato' },
  // ── Orden / equipo ─────────────────────────────────────────────────────
  { key: 'numero_orden',       label: 'Número de orden',         ejemplo: 'A1B2C3D4',            level: 'dato' },
  { key: 'equipo',             label: 'Equipo',                  ejemplo: 'Samsung Galaxy A54',  level: 'dato' },
  { key: 'marca',              label: 'Marca',                   ejemplo: 'Samsung',             level: 'dato' },
  { key: 'modelo',             label: 'Modelo',                  ejemplo: 'Galaxy A54',          level: 'dato' },
  { key: 'problema',           label: 'Falla declarada',         ejemplo: 'No carga',            level: 'dato' },
  { key: 'estado',             label: 'Estado de la orden',      ejemplo: 'Listo para retirar',  level: 'dato' },
  // ── Importes (SIEMPRE del estado canónico; ver whatsappOrderVars) ──────
  { key: 'precio',             label: 'Total',                   ejemplo: '$85.000',             level: 'dato' },
  { key: 'presupuesto',        label: 'Presupuesto estimado',    ejemplo: '$80.000',             level: 'dato' },
  { key: 'anticipo',           label: 'Cobrado',                 ejemplo: '$40.000',             level: 'dato' },
  { key: 'saldo',              label: 'Saldo pendiente',         ejemplo: '$45.000',             level: 'dato' },
  // ── Comprobante / garantía ─────────────────────────────────────────────
  { key: 'tipo_comprobante',   label: 'Tipo de comprobante',     ejemplo: 'Factura B',           level: 'dato' },
  { key: 'numero_comprobante', label: 'Número de comprobante',   ejemplo: '0001-00000045',       level: 'dato' },
  { key: 'codigo_garantia',    label: 'Código de garantía',      ejemplo: 'G-000123',            level: 'dato' },
  { key: 'fecha_vencimiento',  label: 'Vencimiento de garantía', ejemplo: '19/11/2026',          level: 'dato' },
  // ── Perfil del negocio (no bloquean) ───────────────────────────────────
  { key: 'local',              label: 'Nombre del negocio',      ejemplo: 'TechRepair Centro',   level: 'perfil' },
  { key: 'negocio',            label: 'Nombre del negocio',      ejemplo: 'TechRepair Centro',   level: 'perfil' },
  { key: 'direccion',          label: 'Dirección del negocio',   ejemplo: 'San Martín 123',      level: 'perfil' },
  { key: 'whatsapp',           label: 'WhatsApp del negocio',    ejemplo: '351 7654321',         level: 'perfil' },
  { key: 'instagram',          label: 'Instagram del negocio',   ejemplo: '@techrepair',         level: 'perfil' },
  { key: 'horario',            label: 'Horario de atención',     ejemplo: 'Lun a Vie 9 a 18',    level: 'perfil' },
  { key: 'fecha',              label: 'Fecha',                   ejemplo: '19/08/2026',          level: 'perfil' },
] as const

/** Índice por clave, para lookups O(1) sin recorrer el array. */
const SPEC_BY_KEY: ReadonlyMap<string, WhatsAppVariableSpec> = new Map(
  WHATSAPP_VARIABLES.map(v => [v.key, v]),
)

export const WHATSAPP_VARIABLE_KEYS: readonly string[] = WHATSAPP_VARIABLES.map(v => v.key)

/** True sólo para claves de la allowlist. Fail-closed ante cualquier otra cosa. */
export function isWhatsAppVariable(key: string): boolean {
  return SPEC_BY_KEY.has(key)
}

export function getWhatsAppVariableSpec(key: string): WhatsAppVariableSpec | undefined {
  return SPEC_BY_KEY.get(key)
}

/** Valores de entrada del renderer: ya vienen formateados como texto. */
export type WhatsAppTemplateValues = Readonly<Record<string, string | null | undefined>>

/**
 * Formato de importe para el cuerpo del mensaje ("$85.000"), igual al que ya
 * emiten las demás superficies de WhatsApp del producto.
 *
 * Devuelve '' — no "$NaN" ni "—" — ante cualquier cosa que no sea un número
 * finito. Un importe vacío hace que la variable cuente como faltante y el
 * preview la nombre, que es mejor que mandarle basura al cliente.
 */
export function formatImporteWhatsApp(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ''
  return `$${Math.round(v).toLocaleString('es-AR')}`
}

// ============================================
// DETECCIÓN DE PLACEHOLDERS
// ============================================

/**
 * Un placeholder es `{` + identificador + `}`. Deliberadamente restrictivo: no
 * admite espacios, puntos, índices ni expresiones. Nada de lo que matchea acá
 * puede ser código, así que no hay nada que evaluar — y por lo tanto no hay
 * `eval`, `new Function` ni acceso dinámico a propiedades en todo el módulo.
 */
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export interface UnresolvedPlaceholder {
  key: string
  /** `desconocida` = fuera de la allowlist. `faltante` = permitida pero sin valor. */
  motivo: 'desconocida' | 'faltante'
  /** Etiqueta legible; para las desconocidas es la clave cruda. */
  label: string
}

/**
 * Escanea un texto YA renderizado y devuelve todo `{placeholder}` que haya
 * sobrevivido. Se corre sobre el mensaje FINAL — el mismo string que va a
 * wa.me — así que también valida lo que el usuario escribió a mano en el
 * textarea, no sólo lo que produjo la plantilla.
 */
export function findUnresolvedPlaceholders(text: string): UnresolvedPlaceholder[] {
  const vistos = new Set<string>()
  const out: UnresolvedPlaceholder[] = []
  // `matchAll` sobre una regex global no comparte `lastIndex` entre llamadas.
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const key = m[1]
    if (vistos.has(key)) continue
    vistos.add(key)
    const spec = SPEC_BY_KEY.get(key)
    out.push(
      spec
        ? { key, motivo: 'faltante',    label: spec.label }
        : { key, motivo: 'desconocida', label: key },
    )
  }
  return out
}

// ============================================
// RENDER
// ============================================

export interface RenderTemplateResult {
  /** Mensaje final. Es EXACTAMENTE el texto que se codifica en la URL wa.me. */
  text: string
  /** Claves de la allowlist presentes en la plantilla. */
  usadas: string[]
  /** Claves de la allowlist que se resolvieron con un valor real. */
  resueltas: string[]
  /** Nivel `dato` sin valor: quedan literales y BLOQUEAN. */
  faltantes: string[]
  /** Nivel `perfil` sin valor: colapsan a vacío, sólo avisan. */
  incompletas: string[]
  /** Placeholders fuera de la allowlist. Quedan literales y BLOQUEAN. */
  desconocidas: string[]
}

/** Un valor cuenta como resuelto sólo si aporta texto visible. */
function tieneValor(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Renderiza una plantilla contra la allowlist.
 *
 * Garantías:
 *  · UNA sola pasada. Un valor que contenga `{saldo}` se copia tal cual y NO
 *    se re-expande: no hay template injection.
 *  · Los saltos de línea, tildes y emojis del template y de los valores se
 *    preservan byte a byte.
 *  · El `$` de un importe ("$1.234") nunca se interpreta como patrón de
 *    `String.replace` ($&, $1…), porque se reemplaza con una función.
 *  · No ejecuta HTML ni JS. No usa `eval` ni `new Function`.
 *  · Determinista: sin reloj ni aleatoriedad. `{fecha}` la aporta el llamador.
 */
export function renderTemplate(
  template: string,
  values: WhatsAppTemplateValues = {},
): RenderTemplateResult {
  const usadas: string[] = []
  const resueltas: string[] = []
  const faltantes: string[] = []
  const incompletas: string[] = []
  const desconocidas: string[] = []

  const push = (arr: string[], key: string) => { if (!arr.includes(key)) arr.push(key) }

  const text = template.replace(PLACEHOLDER_RE, (match, key: string) => {
    const spec = SPEC_BY_KEY.get(key)

    // Fuera de la allowlist: se deja literal para que se vea, y se reporta.
    if (!spec) {
      push(desconocidas, key)
      return match
    }

    push(usadas, key)
    // Acceso por Map, no por índice de objeto: inmune a `__proto__`/`constructor`.
    const raw = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined

    if (tieneValor(raw)) {
      push(resueltas, key)
      return raw
    }

    if (spec.level === 'dato') {
      push(faltantes, key)
      return match            // literal ⇒ visible ⇒ bloquea
    }
    push(incompletas, key)
    return ''                 // perfil ⇒ colapsa ⇒ sólo avisa
  })

  return { text, usadas, resueltas, faltantes, incompletas, desconocidas }
}

/**
 * Motivo accionable por el que NO se puede abrir WhatsApp, o `null` si se puede.
 * Se evalúa sobre el mensaje final (post-edición del usuario).
 */
export function motivoDeBloqueo(text: string): string | null {
  const pendientes = findUnresolvedPlaceholders(text)
  if (pendientes.length === 0) return null

  const desconocidas = pendientes.filter(p => p.motivo === 'desconocida')
  if (desconocidas.length > 0) {
    const lista = desconocidas.map(p => `{${p.key}}`).join(', ')
    return `El mensaje tiene ${desconocidas.length === 1 ? 'una variable que no existe' : 'variables que no existen'}: ${lista}. Corregí la plantilla o borrá ese texto.`
  }

  const lista = pendientes.map(p => `${p.label} ({${p.key}})`).join(', ')
  return `Falta completar: ${lista}. Editá el mensaje o cargá ese dato antes de abrir WhatsApp.`
}

// ============================================
// RESOLUCIÓN DE ALIAS
// ============================================

/**
 * Aplica los alias históricos que las plantillas guardadas ya asumen, para que
 * el renderer no tenga que conocerlos:
 *   cliente ← nombre · negocio ↔ local · whatsapp ↔ telefono · presupuesto ← precio
 *
 * Separado del render a propósito: el renderer queda tonto y puro, y la
 * política de fallback se puede testear sola.
 */
export function resolveWhatsAppValues(values: WhatsAppTemplateValues): Record<string, string> {
  const get = (k: string): string => {
    const v = Object.prototype.hasOwnProperty.call(values, k) ? values[k] : undefined
    return tieneValor(v) ? v : ''
  }

  const out: Record<string, string> = {}
  for (const key of WHATSAPP_VARIABLE_KEYS) out[key] = get(key)

  out.cliente     = get('cliente')     || get('nombre')
  out.negocio     = get('negocio')     || get('local')
  out.local       = get('local')       || get('negocio')
  out.whatsapp    = get('whatsapp')    || get('telefono')
  out.telefono    = get('telefono')    || get('whatsapp')
  out.presupuesto = get('presupuesto') || get('precio')

  return out
}
