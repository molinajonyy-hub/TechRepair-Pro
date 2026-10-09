// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1D · contrato responsive (CSS + fuente).
//
// jsdom no aplica `index.css`: los tests de componentes de este lote ven la
// tabla y las tarjetas a la vez. Quién se muestra en cada ancho lo decide el
// CSS, y eso lo mide el navegador (`tests/e2e/m7/mobile-orders.spec.ts`, job
// `e2e-local`). Este archivo deja el mismo contrato fijado en el job `quality`,
// que corre en segundos y sin navegador:
//   · <768 px lista / una columna, >=768 px tabla / dos columnas;
//   · el bloque sólo usa tokens de tema definidos en claro y en oscuro;
//   · las páginas no miden el viewport en JS ni vuelven a los estilos en línea
//     que una media query no puede pisar;
//   · la presentación mobile no abre una segunda vía a los importes.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/index.css', 'utf8')
const leer = (ruta: string) => readFileSync(ruta, 'utf8')
const sinComentariosTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

const TITULO = 'BETA-UX-1D — la orden en el celular'
const SIGUIENTE = 'BETA-UX-1C — Mi Suscripción por estado'
const bloque = css
  .slice(css.indexOf(TITULO), css.indexOf(SIGUIENTE))
  .replace(/\/\*[\s\S]*?\*\//g, '')

interface Regla { media: string | null; selectores: string[]; cuerpo: string }

/** Parser mínimo: reglas sueltas y reglas dentro de un `@media` (un nivel). */
function parsear(texto: string): Regla[] {
  const reglas: Regla[] = []
  const leerReglas = (fragmento: string, media: string | null) => {
    for (const m of fragmento.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      reglas.push({ media, selectores: m[1].split(',').map(s => s.trim().replace(/\s+/g, ' ')), cuerpo: m[2] })
    }
  }
  let resto = ''
  let i = 0
  while (i < texto.length) {
    const at = texto.indexOf('@media', i)
    if (at < 0) { resto += texto.slice(i); break }
    resto += texto.slice(i, at)
    const abre = texto.indexOf('{', at)
    let profundidad = 1
    let j = abre + 1
    while (j < texto.length && profundidad > 0) {
      if (texto[j] === '{') profundidad++
      else if (texto[j] === '}') profundidad--
      j++
    }
    leerReglas(texto.slice(abre + 1, j - 1), texto.slice(at + '@media'.length, abre).trim())
    i = j
  }
  leerReglas(resto, null)
  return reglas
}

const reglas = parsear(bloque)

/** Valor de `propiedad` para `selector` en ese contexto (la última declaración gana). */
function valor(media: string | null, selector: string, propiedad: string): string | null {
  let encontrado: string | null = null
  for (const regla of reglas) {
    if (regla.media !== media || !regla.selectores.includes(selector)) continue
    for (const declaracion of regla.cuerpo.split(';')) {
      const [prop, ...resto] = declaracion.split(':')
      if (prop?.trim() === propiedad) encontrado = resto.join(':').trim()
    }
  }
  return encontrado
}

const MOBILE = '(max-width: 767px)'

describe('BETA-UX-1D · el bloque de CSS existe y se pudo leer', () => {
  it('está en index.css, antes del bloque de 1C, y trae reglas base y de mobile', () => {
    expect(css.indexOf(TITULO)).toBeGreaterThan(0)
    expect(css.indexOf(TITULO)).toBeLessThan(css.indexOf(SIGUIENTE))
    expect(reglas.filter(r => r.media === null).length).toBeGreaterThan(20)
    expect(reglas.filter(r => r.media === MOBILE).length).toBeGreaterThan(10)
  })

  it('el corte es 768 px: sólo hay consultas `max-width`, y la de las listas es 767', () => {
    const medias = [...new Set(reglas.map(r => r.media).filter(Boolean))]
    expect(medias.sort()).toEqual(['(max-width: 359px)', '(max-width: 480px)', MOBILE].sort())
    // Ninguna regla de escritorio depende de un `min-width`: >=768 es el caso base.
    expect(bloque).not.toMatch(/min-width:\s*\d+px\s*\)/)
  })
})

describe('BETA-UX-1D · listas: <768 tarjetas, >=768 tabla', () => {
  it('por defecto (escritorio) la lista mobile y el menú del encabezado no se muestran', () => {
    for (const selector of ['.orders-mobile-list', '.customers-mobile-list', '.list-hdr-overflow']) {
      expect(valor(null, selector, 'display'), selector).toBe('none')
    }
    // Las secundarias del encabezado son hijas directas de la fila, como antes.
    expect(valor(null, '.list-hdr-secondary', 'display')).toBe('contents')
    // La tabla no se toca en el caso base: ninguna regla suelta la oculta.
    for (const selector of ['.orders-desktop-table', '.customers-desktop-table']) {
      expect(valor(null, selector, 'display'), selector).toBeNull()
    }
  })

  it('en mobile se oculta la tabla y se muestra la lista', () => {
    for (const selector of ['.orders-desktop-table', '.customers-desktop-table', '.list-hdr-secondary']) {
      expect(valor(MOBILE, selector, 'display'), selector).toBe('none')
    }
    for (const selector of ['.orders-mobile-list', '.customers-mobile-list']) {
      expect(valor(MOBILE, selector, 'display'), selector).toBe('block')
    }
    expect(valor(MOBILE, '.list-hdr-overflow', 'display')).toBe('inline-flex')
  })

  it('ninguna otra regla del bloque vuelve a mostrar la tabla ni a ocultar la lista en mobile', () => {
    for (const regla of reglas.filter(r => r.media !== null)) {
      const toca = (s: string) => regla.selectores.some(sel => sel === s || sel.startsWith(`${s} `))
      const display = /(?:^|;)\s*display:\s*([^;]+)/.exec(regla.cuerpo)?.[1].trim()
      if (!display) continue
      if (toca('.orders-desktop-table') || toca('.customers-desktop-table')) expect(display).toBe('none')
      if (toca('.orders-mobile-list') || toca('.customers-mobile-list')) expect(display).not.toBe('none')
    }
  })

  it('la primaria del encabezado, el CTA del estado vacío, «Limpiar filtros» y la confirmación de borrado son táctiles en mobile', () => {
    for (const selector of [
      '.mobile-list-page .page-hdr-right > .btn-primary',
      '.list-empty-state button',
      '.list-filter-bar > .btn',
      '.mobile-list-page .modal-ftr .btn',
    ]) {
      expect(valor(MOBILE, selector, 'min-height'), selector).toBe('var(--mobile-touch-target)')
    }
    expect(css).toMatch(/--mobile-touch-target:\s*44px/)
  })

  it('los filtros conservan en escritorio los anchos mínimos que tenían en línea', () => {
    expect(valor(null, '.list-filter-bar__search', 'min-width')).toBe('240px')
    expect(valor(null, '.list-filter-bar__search', 'flex')).toBe('1')
    expect(valor(null, '.orders-filter-status', 'min-width')).toBe('150px')
    expect(valor(null, '.orders-filter-payment', 'min-width')).toBe('160px')
    expect(valor(null, '.orders-filter-priority', 'min-width')).toBe('130px')
    // Mobile: búsqueda de lado a lado y filtros de a dos; una columna en lo muy angosto.
    expect(valor(MOBILE, '.list-filter-bar', 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))')
    expect(valor(MOBILE, '.list-filter-bar__search', 'grid-column')).toBe('1 / -1')
    expect(valor('(max-width: 359px)', '.list-filter-bar', 'grid-template-columns')).toBe('minmax(0, 1fr)')
  })
})

describe('BETA-UX-1D · detalle de orden: dos columnas en escritorio, una en mobile', () => {
  it('la grilla es de dos columnas por defecto y de una por debajo de 768', () => {
    expect(valor(null, '.order-detail-grid', 'display')).toBe('grid')
    expect(valor(null, '.order-detail-grid', 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))')
    expect(valor(MOBILE, '.order-detail-grid', 'grid-template-columns')).toBe('minmax(0, 1fr)')
  })

  it('los bloques de ancho completo valen en los dos modos: de la primera a la última línea', () => {
    expect(valor(null, '.order-detail-grid__full', 'grid-column')).toBe('1 / -1')
    // No hay una versión mobile distinta que se pueda desalinear.
    expect(valor(MOBILE, '.order-detail-grid__full', 'grid-column')).toBeNull()
    expect(bloque).not.toMatch(/span 2/)
  })

  it('Marca / Modelo se apilan en pantallas angostas y los textos largos envuelven', () => {
    expect(valor(null, '.order-device-grid', 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))')
    expect(valor('(max-width: 480px)', '.order-device-grid', 'grid-template-columns')).toBe('minmax(0, 1fr)')
    expect(valor(null, '.order-detail-wrap', 'overflow-wrap')).toBe('anywhere')
  })

  it('encabezado: en mobile se van las secundarias, aparece el menú y la primaria es táctil', () => {
    expect(valor(null, '.order-detail-header__secondary', 'display')).toBe('contents')
    expect(valor(null, '.order-detail-header__overflow', 'display')).toBe('none')
    expect(valor(MOBILE, '.order-detail-header__secondary', 'display')).toBe('none')
    expect(valor(MOBILE, '.order-detail-header__overflow', 'display')).toBe('inline-flex')
    for (const selector of ['.order-detail-header .btn', '.order-detail-grid .btn']) {
      expect(valor(MOBILE, selector, 'min-height'), selector).toBe('var(--mobile-touch-target)')
    }
  })
})

describe('BETA-UX-1D · el menú no queda debajo de la barra de navegación', () => {
  it('el popover reserva el alto de la barra al traerse a la vista, y el componente lo pide al abrir', () => {
    expect(css).toMatch(/\.overflow-menu__popover \{ scroll-margin-bottom: calc\(var\(--mobile-bottom-navigation-offset, 0px\) \+ 0\.5rem\); \}/)
    expect(leer('src/ui/components/OverflowMenu.tsx')).toMatch(/popoverRef\.current\?\.scrollIntoView\?\.\(\{ block: 'nearest' \}\)/)
  })
})

describe('BETA-UX-1D · sólo tokens de tema', () => {
  it('el bloque no trae colores fijos', () => {
    expect(bloque).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(bloque).not.toMatch(/\b(?:rgba?|hsla?)\(/)
  })

  it('cada token que usa está definido, y los de color lo están en claro y en oscuro', () => {
    // El tema se declara en varios bloques con el mismo selector: se unen todos.
    const definidosEn = (selector: string) => {
      const tokens = new Set<string>()
      let inicio = css.indexOf(`\n${selector} {`)
      expect(inicio, selector).toBeGreaterThanOrEqual(0)
      while (inicio >= 0) {
        for (const m of css.slice(inicio, css.indexOf('\n}', inicio)).matchAll(/(--[\w-]+)\s*:/g)) tokens.add(m[1])
        inicio = css.indexOf(`\n${selector} {`, inicio + 1)
      }
      return tokens
    }
    // `:root, [data-theme="dark"]` es el tema por defecto (oscuro).
    const oscuro = definidosEn('[data-theme="dark"]')
    const claro = definidosEn('[data-theme="light"]')
    const usados = [...new Set([...bloque.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]))]
    expect(usados.length).toBeGreaterThan(3)
    // Medidas (no cambian con el tema) vs. tokens de color.
    const medidas = new Set(['--mobile-touch-target', '--mobile-page-padding'])
    for (const token of usados) {
      expect(oscuro.has(token), `${token} no está en el tema por defecto`).toBe(true)
      if (!medidas.has(token)) expect(claro.has(token), `${token} no está en el tema claro`).toBe(true)
    }
  })
})

describe('BETA-UX-1D · las páginas no vuelven a lo que una media query no puede cambiar', () => {
  const paginas = ['src/pages/OrderDetail.tsx', 'src/pages/Orders.tsx', 'src/pages/Customers.tsx']

  it.each(paginas)('%s no mide el viewport en JS', (ruta) => {
    expect(sinComentariosTs(leer(ruta))).not.toMatch(/innerWidth|matchMedia|useMediaQuery|ResizeObserver|addEventListener\(\s*['"]resize/)
  })

  it('el detalle no trae la grilla ni los `span 2` en línea', () => {
    const fuente = sinComentariosTs(leer('src/pages/OrderDetail.tsx'))
    expect(fuente).not.toMatch(/gridTemplateColumns/)
    expect(fuente).not.toMatch(/gridColumn/)
    expect(fuente).toMatch(/className="order-detail-grid"/)
    expect(fuente.match(/order-detail-grid__full/g)?.length).toBeGreaterThanOrEqual(7)
  })

  it.each(['src/pages/Orders.tsx', 'src/pages/Customers.tsx'])('%s no mete el estado vacío en una celda de tabla', (ruta) => {
    const fuente = sinComentariosTs(leer(ruta))
    expect(fuente).not.toMatch(/empty-row/)
    expect(fuente).not.toMatch(/colSpan/)
    // El estado vacío y la tabla son ramas excluyentes del mismo ternario.
    expect(fuente).toMatch(/\.length === 0 \? \(\s*<div[^>]*list-empty-state/)
  })

  it.each(paginas)('%s importa los primitivos mobile desde `../ui`, no desde su archivo', (ruta) => {
    const fuente = leer(ruta)
    expect(fuente).toMatch(/import \{[^}]*\bOverflowMenu\b[^}]*\} from '\.\.\/ui'/)
    expect(fuente).not.toMatch(/ui\/components\//)
  })

  it('las plantillas de WhatsApp se declaran una sola vez para los dos encabezados', () => {
    const fuente = leer('src/pages/OrderDetail.tsx')
    expect(fuente.match(/order-whatsapp-received/g)).toHaveLength(1)
    expect(fuente.match(/WHATSAPP_TEMPLATE_OPTIONS\.map\(/g)).toHaveLength(2)
    expect(fuente.match(/setWaPreview\(\{ open: true/g)).toHaveLength(1)
  })
})

describe('BETA-UX-1D · la presentación mobile no es una segunda vía a los importes', () => {
  it('Órdenes: tabla y tarjetas leen los importes de UNA función, gateada por la autorización', () => {
    const fuente = sinComentariosTs(leer('src/pages/Orders.tsx'))
    // El total y el saldo se leen del mapa financiero en UN lugar: `orderAmounts`.
    expect(fuente.match(/\.labor_cost\b/g)).toHaveLength(1)
    expect(fuente.match(/saldo_pendiente/g)).toHaveLength(1)
    // `estimated_total` se lee además para imprimir, también detrás de la autorización.
    expect(fuente.match(/\?\.estimated_total\b/g)).toHaveLength(2)
    expect(fuente).toMatch(/const montos = amountsAuthorized === true && !financialError \? financial\[order\.id\] : undefined/)
    expect(fuente).toMatch(/const orderAmounts = [\s\S]{0,120}if \(financialError \|\| amountsAuthorized !== true\) return null/)
    // Las dos presentaciones la usan.
    expect(fuente.match(/orderAmounts\(order\.id\)/g)).toHaveLength(2)
  })

  it('Órdenes: no se reconstruye un total sumando líneas ni pagos', () => {
    const fuente = sinComentariosTs(leer('src/pages/Orders.tsx'))
    expect(fuente).not.toMatch(/order_items|orderItems|precio_unitario|amount_paid|total_cobrado|\.reduce\(/)
    // La lista no pide datos por su cuenta: una sola lectura, la del hook.
    expect(fuente.match(/useOrders\(/g)).toHaveLength(1)
    expect(fuente).not.toMatch(/\.rpc\(|\.from\(\s*['"]v_order/)
  })

  it('Clientes: el total de la tarjeta es el de `customerStats`, detrás de `amountsAuthorized`', () => {
    const fuente = sinComentariosTs(leer('src/pages/Customers.tsx'))
    expect(fuente.match(/formatCurrency\(stats\.total\)/g)).toHaveLength(2)
    expect(fuente.match(/amountsAuthorized\s*\?\s*\(?\s*(?:<span[^>]*>)?\{?formatCurrency\(stats\.total\)/g)).toHaveLength(2)
    // Una sola consulta de importes, por la ruta autorizada.
    expect(fuente.match(/get_order_financial_amounts/g)).toHaveLength(1)
    expect(fuente.match(/customersService\.getAll\(/g)).toHaveLength(1)
  })
})
