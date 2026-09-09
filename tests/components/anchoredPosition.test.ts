// ─────────────────────────────────────────────────────────────────────────────
// ORDERS-V2-0.1.1 — posicionamiento del desplegable contra el viewport.
//
// ROOT CAUSE medido en el iPhone del owner, a 390×844:
//
//     lista              top 341 → bottom 597  (alto 256)
//     .intake-step-card  overflow hidden/hidden, bottom 449
//
// La card recortaba la lista a 108 px de 256. NO era falta de espacio: había
// 327 px libres debajo del campo y la lista no se salía de pantalla. Por eso la
// solución es sacarla del ancestro (portal) y posicionarla contra el viewport;
// esta función hace ese cálculo y acá se fijan sus casos límite.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from 'vitest'
import {
  ANCHOR_DEFAULTS,
  computeAnchoredPosition,
  type AnchorRect,
  type ViewportBox,
} from '../../src/ui/components/anchoredPosition'

/** iPhone 13 tal como lo reporta el navegador en el spec de WebKit. */
const IPHONE: ViewportBox = { width: 390, height: 664, offsetTop: 0 }
const { gutter, gap, preferredMaxHeight } = ANCHOR_DEFAULTS

/** El campo de Marca, con las medidas reales del diagnóstico. */
const CAMPO_MARCA: AnchorRect = { top: 289, bottom: 337, left: 33, width: 324 }

describe('ORDERS-V2-0.1.1 · placement', () => {
  it('A · con espacio abajo, abre abajo', () => {
    const p = computeAnchoredPosition(CAMPO_MARCA, IPHONE)
    expect(p.placement).toBe('bottom')
    expect(p.top).toBe(CAMPO_MARCA.bottom + gap)
    // Y ahora usa el alto completo: 664-337-4-8 = 315 > 256.
    expect(p.maxHeight).toBe(preferredMaxHeight)
  })

  it('B · sin espacio abajo pero con espacio arriba, abre arriba', () => {
    // Campo pegado al borde inferior: quedan 24 px debajo.
    const campoAbajo: AnchorRect = { top: 592, bottom: 640, left: 33, width: 324 }
    const p = computeAnchoredPosition(campoAbajo, IPHONE)
    expect(p.placement).toBe('top')
    // La lista termina justo encima del campo, nunca encimada.
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(campoAbajo.top - gap)
    expect(p.top).toBeGreaterThanOrEqual(gutter)
  })

  it('C · con poco espacio de los dos lados, el alto se adapta', () => {
    // Viewport bajo (teclado abierto) y campo al medio.
    const conTeclado: ViewportBox = { width: 390, height: 300, offsetTop: 0 }
    const campo: AnchorRect = { top: 120, bottom: 168, left: 33, width: 324 }
    const p = computeAnchoredPosition(campo, conTeclado)

    expect(p.maxHeight).toBeLessThan(preferredMaxHeight)
    expect(p.maxHeight).toBeGreaterThan(0)
    // Entre en la dirección que entre, no puede salirse de la pantalla.
    expect(p.top).toBeGreaterThanOrEqual(gutter)
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(conTeclado.height - gutter)
  })

  it('C2 · nunca devuelve un alto negativo', () => {
    // Caso degenerado: el campo queda fuera del viewport visible.
    const campo: AnchorRect = { top: 700, bottom: 748, left: 33, width: 324 }
    const p = computeAnchoredPosition(campo, IPHONE)
    expect(p.maxHeight).toBeGreaterThanOrEqual(0)
  })
})

describe('ORDERS-V2-0.1.1 · límites horizontales', () => {
  it('D · un campo pegado al borde izquierdo se corre hacia adentro', () => {
    const campo: AnchorRect = { top: 289, bottom: 337, left: 0, width: 324 }
    const p = computeAnchoredPosition(campo, IPHONE)
    expect(p.left).toBeGreaterThanOrEqual(gutter)
    expect(p.left + p.width).toBeLessThanOrEqual(IPHONE.width - gutter)
  })

  it('D2 · un campo pegado al borde derecho tampoco se sale', () => {
    const campo: AnchorRect = { top: 289, bottom: 337, left: 300, width: 324 }
    const p = computeAnchoredPosition(campo, IPHONE)
    expect(p.left + p.width).toBeLessThanOrEqual(IPHONE.width - gutter)
    expect(p.left).toBeGreaterThanOrEqual(gutter)
  })

  it('D3 · un campo más ancho que la pantalla se recorta al viewport', () => {
    const campo: AnchorRect = { top: 289, bottom: 337, left: 0, width: 900 }
    const p = computeAnchoredPosition(campo, IPHONE)
    expect(p.width).toBeLessThanOrEqual(IPHONE.width - gutter * 2)
  })

  it('la lista sigue el ancho del campo cuando entra', () => {
    const p = computeAnchoredPosition(CAMPO_MARCA, IPHONE)
    expect(p.width).toBe(CAMPO_MARCA.width)
    expect(p.left).toBe(CAMPO_MARCA.left)
  })

  it('en ninguno de los anchos móviles se sale de pantalla', () => {
    for (const width of [320, 375, 390, 393, 430]) {
      const vp: ViewportBox = { width, height: 664, offsetTop: 0 }
      for (const left of [0, 16, width - 100, width - 10]) {
        const p = computeAnchoredPosition({ top: 289, bottom: 337, left, width: 324 }, vp)
        expect(p.left, `w=${width} left=${left}`).toBeGreaterThanOrEqual(gutter)
        expect(p.left + p.width, `w=${width} left=${left}`).toBeLessThanOrEqual(width - gutter)
      }
    }
  })
})

describe('ORDERS-V2-0.1.1 · viewport visual de iOS', () => {
  it('respeta el desplazamiento del viewport visual', () => {
    // Con el teclado abierto iOS desplaza el viewport visual: la lista tiene
    // que medirse contra ESE recuadro, no contra el de layout.
    const desplazado: ViewportBox = { width: 390, height: 400, offsetTop: 100 }
    const campo: AnchorRect = { top: 150, bottom: 198, left: 33, width: 324 }
    const p = computeAnchoredPosition(campo, desplazado)

    expect(p.top).toBeGreaterThanOrEqual(desplazado.offsetTop)
    expect(p.top + p.maxHeight)
      .toBeLessThanOrEqual(desplazado.offsetTop + desplazado.height - gutter)
  })
})
