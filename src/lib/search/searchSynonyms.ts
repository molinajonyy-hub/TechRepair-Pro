/**
 * Mapa de sinónimos para búsqueda de productos de tecnología.
 * Clave = término canónico, valor = términos alternativos que deben matchear.
 */
export const SEARCH_SYNONYMS: Record<string, string[]> = {
  'iphone':    ['apple', 'ios', 'manzana'],
  'apple':     ['iphone', 'ios'],
  'original':  ['oem', 'genuino', 'oficial'],
  'lightning': ['conector lightning'],
  'tipo c':    ['usb c', 'type c', 'tipoc'],
  'usb c':     ['tipo c', 'type c'],
  'type c':    ['tipo c', 'usb c'],
  'funda':     ['case', 'protector', 'carcasa'],
  'cargador':  ['charger', 'adaptador', 'carga rapida'],
  'charger':   ['cargador', 'adaptador'],
  'templado':  ['vidrio templado', 'glass'],
  'auriculares': ['auricular', 'headphones', 'earphones', 'manos libres'],
  'bateria':   ['battery', 'acumulador'],
  'power bank': ['bateria portatil', 'cargador portatil'],
  'inalambrico': ['wireless', 'bluetooth'],
  'bluetooth': ['inalambrico', 'bt'],
  'soporte':   ['holder', 'stand', 'base'],
  'magsafe':   ['mag safe', 'magnetico'],
  'samsung':   ['galaxy', 'android'],
}

/**
 * Expande un único token con sus sinónimos conocidos.
 * Retorna el token original + todos sus sinónimos.
 */
export function expandToken(token: string): string[] {
  const result = new Set([token])
  for (const [canonical, synonyms] of Object.entries(SEARCH_SYNONYMS)) {
    if (token === canonical || synonyms.includes(token)) {
      result.add(canonical)
      synonyms.forEach(s => result.add(s))
    }
  }
  return [...result]
}
