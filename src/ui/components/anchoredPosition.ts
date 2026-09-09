/**
 * ORDERS-V2-0.1.1 — posición de una capa flotante anclada a un campo.
 *
 * ── ROOT CAUSE que la motiva (medido, no supuesto) ────────────────────────
 * El desplegable de Marca/Modelo se dibujaba con `position:absolute` dentro
 * del árbol del formulario. A 390×844, en el iPhone del owner:
 *
 *     lista            top 341 → bottom 597   (alto 256)
 *     .intake-step-card  overflow hidden/hidden, bottom 449
 *
 * La card recortaba la lista a 108 px de 256. **No era falta de espacio**:
 * había 327 px libres debajo del campo y la lista no se salía del viewport.
 * Por eso subir `z-index` no habría cambiado nada — no se escapa de un clip de
 * `overflow` — y agrandar `max-height` lo habría empeorado.
 *
 * La única salida es sacar la lista de ese ancestro (portal) y posicionarla
 * contra el viewport. Este módulo hace ese cálculo, y es una función PURA para
 * poder probar los casos límite sin navegador.
 */

export interface AnchorRect {
  top: number
  bottom: number
  left: number
  width: number
}

/**
 * En iOS con el teclado abierto, `innerHeight` no representa el área visible.
 * `visualViewport` sí, y por eso se pasa por separado en vez de leerlo acá.
 */
export interface ViewportBox {
  width: number
  height: number
  /** Desplazamiento del viewport visual respecto del de layout. */
  offsetTop: number
}

export type Placement = 'bottom' | 'top'

export interface AnchoredPosition {
  top: number
  left: number
  width: number
  maxHeight: number
  placement: Placement
}

export interface AnchorOptions {
  /** Margen mínimo contra los bordes de la pantalla. */
  gutter?: number
  /** Separación entre el campo y la capa. */
  gap?: number
  /** Alto máximo deseado; se recorta si no entra. */
  preferredMaxHeight?: number
  /** Por debajo de esto la lista no es usable y conviene voltearla. */
  minUsableHeight?: number
}

export const ANCHOR_DEFAULTS: Required<AnchorOptions> = {
  gutter: 8,
  gap: 4,
  preferredMaxHeight: 256, // 16rem, el alto que ya tenía el desplegable
  minUsableHeight: 96,
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

/**
 * Devuelve coordenadas para `position: fixed`, en el mismo sistema que
 * `getBoundingClientRect()`.
 */
export function computeAnchoredPosition(
  anchor: AnchorRect,
  viewport: ViewportBox,
  options: AnchorOptions = {},
): AnchoredPosition {
  const { gutter, gap, preferredMaxHeight, minUsableHeight } = { ...ANCHOR_DEFAULTS, ...options }

  const viewportTop = viewport.offsetTop
  const viewportBottom = viewport.offsetTop + viewport.height

  const availableBelow = viewportBottom - anchor.bottom - gap - gutter
  const availableAbove = anchor.top - viewportTop - gap - gutter

  /**
   * Se abre abajo mientras la lista sea usable ahí. Sólo se voltea cuando
   * arriba hay un espacio genuinamente mayor: dar vuelta el desplegable es
   * desorientador y no se hace por unos pocos píxeles.
   */
  const placement: Placement =
    availableBelow >= Math.min(preferredMaxHeight, minUsableHeight) || availableBelow >= availableAbove
      ? 'bottom'
      : 'top'

  const available = placement === 'bottom' ? availableBelow : availableAbove
  // Nunca menos de 0: un alto negativo rompería el layout en vez de degradar.
  const maxHeight = Math.max(0, Math.min(preferredMaxHeight, available))

  // La lista sigue el ancho del campo, pero no puede exceder la pantalla.
  const width = Math.min(anchor.width, Math.max(0, viewport.width - gutter * 2))
  // Y si el campo está pegado a un borde, se corre hacia adentro.
  const left = clamp(anchor.left, gutter, Math.max(gutter, viewport.width - width - gutter))

  const top = placement === 'bottom'
    ? anchor.bottom + gap
    : anchor.top - gap - maxHeight

  return { top, left, width, maxHeight, placement }
}

/** Lee el viewport real, prefiriendo `visualViewport` cuando existe. */
export function readViewport(): ViewportBox {
  const vv = typeof window !== 'undefined' ? window.visualViewport : undefined
  if (vv) return { width: vv.width, height: vv.height, offsetTop: vv.offsetTop }
  return { width: window.innerWidth, height: window.innerHeight, offsetTop: 0 }
}
