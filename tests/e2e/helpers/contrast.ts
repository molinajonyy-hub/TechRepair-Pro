import type { Locator, Page } from '@playwright/test'

/** WCAG AA para texto de tamaño normal. */
export const AA_SMALL_TEXT = 4.5

export type ContrastMeasurement = {
  ratio: number
  foreground: string
  background: string
  fontSize: string
  fontWeight: string
}

/** Contraste WCAG del color computado contra las capas de fondo ya compuestas. */
export async function contrastOf(locator: Locator, colorProperty: 'color' | 'outlineColor' = 'color'): Promise<ContrastMeasurement> {
  return locator.evaluate((element, property) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) || []).map(Number)
    const srgb = (channel: number) => {
      const value = channel / 255
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
    }
    const luminance = (rgb: number[]) =>
      0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2])

    const layers: Array<{ rgb: number[]; alpha: number }> = []
    for (let node: HTMLElement | null = element as HTMLElement; node; node = node.parentElement) {
      const parts = parse(getComputedStyle(node).backgroundColor)
      if (parts.length < 3) continue
      const alpha = parts.length > 3 ? parts[3] : 1
      if (alpha === 0) continue
      layers.push({ rgb: parts.slice(0, 3), alpha })
      if (alpha === 1) break
    }

    let background = layers.length && layers[layers.length - 1].alpha === 1
      ? layers[layers.length - 1].rgb
      : [255, 255, 255]
    for (let index = layers.length - 2; index >= 0; index--) {
      const { rgb, alpha } = layers[index]
      background = rgb.map((channel, position) =>
        channel * alpha + background[position] * (1 - alpha))
    }

    const style = getComputedStyle(element)
    const foreground = parse(style[property]).slice(0, 3)
    const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)

    return {
      ratio: (high + 0.05) / (low + 0.05),
      foreground: style[property],
      background: `rgb(${background.map(Math.round).join(', ')})`,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    }
  }, colorProperty)
}

export type PaintedContrast = {
  /** Peor contraste del texto contra lo que quedó PINTADO detrás de su caja. */
  ratio: number
  /** Mejor punto del mismo fondo. Si difiere de `ratio`, el fondo es un gradiente. */
  ratioMax: number
  /** Color de texto computado. */
  foreground: string
  /** Color del núcleo de los glifos tal como se pintó (incluye opacidad y capas). */
  foregroundPainted: string
  /** Píxel de fondo de peor y de mejor contraste. */
  backgroundWorst: string
  backgroundBest: string
  /** Opacidad efectiva del elemento (producto de toda su cadena de ancestros). */
  opacity: number
  fontSize: string
  fontWeight: string
  text: string
  width: number
  height: number
  /** Medidas que hicieron falta: 1 si el elemento no se movió mientras se lo medía. */
  attempts: number
}

/**
 * Contraste WCAG contra el fondo PINTADO (BETA-UX-1E).
 *
 * `contrastOf` compone `background-color` y por eso no ve un gradiente
 * (`background-image`): en un CTA con `linear-gradient(...)` termina midiendo el
 * fondo de la tarjeta de atrás. Acá se captura la caja que ocupa el texto con
 * los glifos ocultos y se toma, de los píxeles reales, el de PEOR contraste: el
 * punto más desfavorable del gradiente que el texto pisa.
 *
 * El color de texto es el computado cuando el elemento es opaco. Si algún
 * ancestro tiene `opacity < 1` (estados deshabilitados) se usa el color con el
 * que quedaron pintados los glifos, tomado de una segunda captura.
 *
 * Los glifos se ocultan con un atributo `data-*` y una regla inyectada, sin
 * tocar el atributo `style` del elemento: el remapeo de tema claro matchea por
 * `[style*=…]` y medirlo no puede alterarlo.
 *
 * El elemento tiene que estar QUIETO mientras se lo mide (ver «Geometría de la
 * medida», abajo): se espera a que lo esté, se comprueba su caja después de
 * cada captura y, si se movió, la medida se descarta y se repite. Si no se
 * queda quieto en `MEASURE_ATTEMPTS` intentos, falla con
 * `MOVED_DURING_MEASUREMENT`: nunca devuelve un contraste tomado de otro lugar.
 */
export async function paintedContrastOf(locator: Locator): Promise<PaintedContrast> {
  const page = locator.page()

  // Hasta `MEASURE_ATTEMPTS` medidas. Una en la que el elemento se movió se
  // DESCARTA entera: sus dos capturas no son del mismo lugar.
  const descartes: string[] = []
  let medible: Medible | null = null
  for (let intento = 1; intento <= MEASURE_ATTEMPTS && !medible; intento += 1) {
    const resultado = await intentarMedida(locator)
    if (typeof resultado === 'string') descartes.push(`${intento}) ${resultado}`)
    else medible = resultado
  }
  if (!medible) {
    const nombre = ((await locator.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 30)
    throw new Error(
      `paintedContrastOf: ${MOVED_DURING_MEASUREMENT} — «${nombre}» no se pudo medir quieto en ${MEASURE_ATTEMPTS} intentos: ${descartes.join(' · ')}`,
    )
  }
  const { info, conTexto, sinTexto } = medible

  const medida = await page.evaluate(async ({ a, b, color, opaco }) => {
    const pixeles = async (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none' })
      // Un <canvas> suelto, no `OffscreenCanvas`: el WebKit de Playwright no lo trae.
      const lienzo = document.createElement('canvas')
      lienzo.width = bitmap.width
      lienzo.height = bitmap.height
      const ctx = lienzo.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    }
    const srgb = (canal: number) => {
      const v = canal / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    const luminancia = (r: number, g: number, bl: number) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(bl)
    const contraste = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)

    const [con, sin] = [await pixeles(a), await pixeles(b)]

    // Núcleo de los glifos: el píxel que más se aparta de su fondo. Los bordes
    // suavizados son mezclas y quedan siempre más cerca del fondo.
    let nucleo = [0, 0, 0]
    let mayor = -1
    for (let i = 0; i < con.length; i += 4) {
      const d = (con[i] - sin[i]) ** 2 + (con[i + 1] - sin[i + 1]) ** 2 + (con[i + 2] - sin[i + 2]) ** 2
      if (d > mayor) { mayor = d; nucleo = [con[i], con[i + 1], con[i + 2]] }
    }

    const computado = (color.match(/[\d.]+/g) || []).map(Number)
    const alfa = computado.length > 3 ? computado[3] : 1
    const texto = opaco && alfa === 1 ? computado.slice(0, 3) : nucleo
    const lTexto = luminancia(texto[0], texto[1], texto[2])

    let peor = Infinity, mejor = 0
    let pxPeor = [0, 0, 0], pxMejor = [0, 0, 0]
    for (let i = 0; i < sin.length; i += 4) {
      const c = contraste(lTexto, luminancia(sin[i], sin[i + 1], sin[i + 2]))
      if (c < peor) { peor = c; pxPeor = [sin[i], sin[i + 1], sin[i + 2]] }
      if (c > mejor) { mejor = c; pxMejor = [sin[i], sin[i + 1], sin[i + 2]] }
    }
    const rgb = (c: number[]) => `rgb(${c.join(', ')})`
    return { ratio: peor, ratioMax: mejor, foregroundPainted: rgb(nucleo), backgroundWorst: rgb(pxPeor), backgroundBest: rgb(pxMejor) }
  }, { a: conTexto.toString('base64'), b: sinTexto.toString('base64'), color: info.color, opaco: info.opacity === 1 })

  return {
    ...medida,
    foreground: info.color,
    opacity: info.opacity,
    fontSize: info.fontSize,
    fontWeight: info.fontWeight,
    text: info.text,
    width: info.width,
    height: info.height,
    attempts: descartes.length + 1,
  }
}

// ─── Geometría de la medida ─────────────────────────────────────────────────
//
// La medida son DOS capturas del mismo recorte de pantalla (con y sin glifos),
// y el recorte se calcula antes, en coordenadas del viewport. Si la página se
// mueve entre el cálculo y cualquiera de las dos capturas, la segunda ya no es
// «el fondo de este texto»: es lo que haya quedado en ese lugar.
//
// Pasó en CI (BUTTON-SYSTEM-1A, Inventario, 375 px oscuro): el clic de un
// filtro de stock dispara un scroll suave a la tabla, la medida arrancó con la
// página todavía en movimiento y la captura sin glifos tomó el fondo de la caja
// de alerta que rodea al botón → «texto rgb(15, 23, 42) sobre rgb(31, 27, 27)
// = 1,05:1» con el botón pintado en ámbar a 8,31:1. En tema claro el mismo
// corrimiento da un fondo claro y la medida habría salido VERDE sin haber
// medido el botón: los dos errores son el mismo.
//
// Contrato: quieto → caja → captura → caja otra vez. Si la caja cambió, la
// medida se descarta y se repite; si nunca queda quieta, se FALLA. Nunca se
// devuelve un número tomado de otro lugar.

/** Lo que identifica una medida que no se pudo tomar porque el elemento se movió. */
export const MOVED_DURING_MEASUREMENT = 'element moved during contrast measurement'
/** Medidas que se intentan antes de fallar. */
export const MEASURE_ATTEMPTS = 4
/** Tolerancia de la caja y del scroll, en px CSS: medio píxel (uno de dispositivo a 2x). */
const GEOMETRY_TOLERANCE_PX = 0.5
/** Cuadros seguidos con la misma geometría para dar al elemento por quieto. */
const STILL_FRAMES = 4
/** Tope de cada espera a que el elemento se quede quieto. */
const STILL_TIMEOUT_MS = 2_000

type Medible = { info: NonNullable<Awaited<ReturnType<typeof prepararMedida>>>; conTexto: Buffer; sinTexto: Buffer }

/** `''` si las dos lecturas coinciden; si no, cuánto se corrió cada componente. */
function corrimientoEntre(antes: number[], despues: number[]): string {
  const nombres = ['x', 'y', 'ancho', 'alto', 'scrollX', 'scrollY']
  const cambios = nombres
    .map((nombre, i) => ({ nombre, delta: despues[i] - antes[i] }))
    .filter(c => Math.abs(c.delta) > GEOMETRY_TOLERANCE_PX)
  return cambios.map(c => `${c.nombre} ${c.delta > 0 ? '+' : ''}${Math.round(c.delta * 10) / 10}px`).join(', ')
}

/** Caja del elemento y scroll de la página, leídos un cuadro después. */
const geometriaDe = (locator: Locator) =>
  locator.evaluate(async (element) => {
    // Un cuadro antes de leer: un scroll que el compositor ya aplicó le llega
    // al hilo principal con el cuadro siguiente.
    await new Promise<void>((listo) => {
      let hecho = false
      const fin = () => { if (!hecho) { hecho = true; listo() } }
      requestAnimationFrame(fin)
      setTimeout(fin, 100)
    })
    const r = element.getBoundingClientRect()
    return [r.x, r.y, r.width, r.height, window.scrollX, window.scrollY]
  })

/**
 * Una medida: las dos capturas y la caja que se midió. Devuelve el motivo (un
 * texto) si hubo que descartarla porque el elemento no estaba quieto.
 */
async function intentarMedida(locator: Locator): Promise<Medible | string> {
  const page = locator.page()
  const info = await prepararMedida(locator)
  if (!info) return `no se quedó quieto en ${STILL_TIMEOUT_MS} ms`

  // `caret: 'initial'`: el modo por defecto de Playwright le deja `style=""` a
  // los inputs y eso los mete en el remapeo de tema claro (`input[style]`).
  const captura = () => page.screenshot({ clip: info.clip, caret: 'initial', animations: 'disabled' })

  const conTexto = await captura()
  let corrimiento = corrimientoEntre(info.geometria, await geometriaDe(locator))
  if (corrimiento) return `se movió durante la captura con texto (${corrimiento})`

  await locator.evaluate(el => el.setAttribute('data-contrast-probe', ''))
  const sonda = await page.addStyleTag({
    content: '[data-contrast-probe], [data-contrast-probe] * {'
      + ' -webkit-text-fill-color: transparent !important; text-shadow: none !important; transition: none !important; }'
      // Los íconos también son primer plano: un trazo que pise la caja medida
      // no puede contar como fondo.
      + ' [data-contrast-probe] svg { visibility: hidden !important; }',
  })
  let sinTexto: Buffer
  let despues: number[]
  try {
    sinTexto = await captura()
    despues = await geometriaDe(locator)
  } finally {
    await locator.evaluate(el => el.removeAttribute('data-contrast-probe')).catch(() => undefined)
    await sonda.evaluate(nodo => (nodo as HTMLStyleElement).remove()).catch(() => undefined)
  }
  corrimiento = corrimientoEntre(info.geometria, despues)
  if (corrimiento) return `se movió entre las dos capturas (${corrimiento})`

  return { info, conTexto, sinTexto }
}

/**
 * Espera a que el elemento esté quieto, lo lleva al centro, vuelve a esperar y
 * recién ahí lee su caja y el recorte a capturar. `null` si no se quedó quieto.
 */
const prepararMedida = (locator: Locator) =>
  locator.evaluate(async (element, { cuadros, espera, tolerancia }) => {
    const el = element as HTMLElement
    const leer = () => {
      const r = el.getBoundingClientRect()
      return [r.x, r.y, r.width, r.height, window.scrollX, window.scrollY]
    }
    // Un cuadro. Con un tope: una pestaña que no pinta no puede colgar la medida.
    const cuadro = () => new Promise<void>((listo) => {
      let hecho = false
      const fin = () => { if (!hecho) { hecho = true; listo() } }
      requestAnimationFrame(fin)
      setTimeout(fin, 100)
    })
    /** `cuadros` cuadros seguidos con la misma caja y el mismo scroll. */
    const quieto = async () => {
      const limite = performance.now() + espera
      let previa = leer()
      for (let iguales = 0; iguales < cuadros;) {
        if (performance.now() > limite) return false
        await cuadro()
        const ahora = leer()
        iguales = ahora.every((v, i) => Math.abs(v - previa[i]) <= tolerancia) ? iguales + 1 : 0
        previa = ahora
      }
      return true
    }

    // Quieto ANTES de moverlo: un scroll en curso (el `scrollIntoView` suave que
    // dispara un clic de la propia pantalla) termina primero.
    if (!(await quieto())) return null
    // Al centro y sin animar: una barra fija (la navegación inferior en mobile)
    // tapa lo que queda pegado al borde, y `scroll-behavior: smooth` deja la
    // caja a mitad de camino cuando se la mide.
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    // Y quieto donde quedó, antes de leer la caja.
    if (!(await quieto())) return null
    const caja = el.getBoundingClientRect()
    const rects: DOMRect[] = []
    const rango = document.createRange()
    const nodos = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let nodo = nodos.nextNode(); nodo; nodo = nodos.nextNode()) {
      if (!nodo.textContent?.trim()) continue
      rango.selectNodeContents(nodo)
      for (const r of rango.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r)
    }
    // Un control de sólo ícono (el chevron de un botón partido): su «texto» es el
    // trazo del SVG, que hereda `color`.
    if (rects.length === 0) {
      for (const svg of el.querySelectorAll('svg')) {
        const r = svg.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) rects.push(r)
      }
    }
    if (rects.length === 0) throw new Error('paintedContrastOf: el elemento no tiene texto ni ícono visible')
    const left = Math.max(caja.left, Math.min(...rects.map(r => r.left)))
    const top = Math.max(caja.top, Math.min(...rects.map(r => r.top)))
    const right = Math.min(caja.right, Math.max(...rects.map(r => r.right)))
    const bottom = Math.min(caja.bottom, Math.max(...rects.map(r => r.bottom)))

    // Lo que se captura tiene que ser ESTE elemento: si otra capa lo tapa, los
    // píxeles serían de esa capa y la medida no diría nada del texto.
    const puntos = [[left + 2, top + 2], [right - 2, top + 2], [left + 2, bottom - 2], [right - 2, bottom - 2], [(left + right) / 2, (top + bottom) / 2]]
    for (const [x, y] of puntos) {
      const arriba = document.elementFromPoint(x, y)
      if (!arriba || !(arriba === el || el.contains(arriba))) {
        const quien = arriba ? `${arriba.tagName.toLowerCase()}.${String((arriba as HTMLElement).className).slice(0, 40)}` : 'nada (fuera del viewport)'
        throw new Error(`paintedContrastOf: «${(el.textContent || '').trim().slice(0, 30)}» está tapado en (${Math.round(x)}, ${Math.round(y)}) por ${quien}`)
      }
    }

    let opacity = 1
    for (let nodo: Element | null = el; nodo; nodo = nodo.parentElement) {
      opacity *= Number(getComputedStyle(nodo).opacity)
    }
    const estilo = getComputedStyle(el)
    return {
      clip: { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) },
      color: estilo.color,
      opacity,
      fontSize: estilo.fontSize,
      fontWeight: estilo.fontWeight,
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      width: caja.width,
      height: caja.height,
      geometria: leer(),
    }
  }, { cuadros: STILL_FRAMES, espera: STILL_TIMEOUT_MS, tolerancia: GEOMETRY_TOLERANCE_PX })

/** Fija el tema ANTES de que cargue la app. */
export async function applyTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((value) => {
    localStorage.setItem('theme', value)
    localStorage.setItem('techrepair_theme', value)
  }, theme)
}
