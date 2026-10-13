// ============================================================================
// BUTTON-SYSTEM-1A — el sistema de botones, medido en el navegador.
//
//   npx playwright test --project=m7-local --grep @button-system-1a
//
// El contrato (reglas, clases, aritmética de tokens) está fijado en
// `tests/components/buttonSystem1a.test.tsx`. jsdom no aplica `index.css` ni
// carga Bootstrap: acá se mide lo que sólo existe con la hoja servida —
//
//   · que una acción de página mide y pinta LO MISMO en todas las pantallas
//     («Nueva Orden» en Inicio y en Órdenes, «Nueva tarea» en Inicio y en
//     Tareas): alto, padding, radio, tipografía, ícono y fondo;
//   · que ningún botón del contrato lleva gradiente ni resplandor;
//   · el contraste PINTADO del texto, en claro y en oscuro, en reposo y con el
//     puntero encima;
//   · que con el foco del teclado y al presionar no aparecen los colores de
//     Bootstrap (entra por CDN y define esos estados con más especificidad que
//     la regla base de cada variante).
//
// No hay capturas ni snapshots: son medidas.
// ============================================================================
import { test, expect } from './fixtures'
import type { Locator, Page } from '@playwright/test'
import { AA_SMALL_TEXT, applyTheme, paintedContrastOf } from '../helpers/contrast'

type Tema = 'light' | 'dark'
type Variante = 'primary' | 'secondary' | 'danger'

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 375, height: 812 }
const ALTO = 44
const TOL = 1

// `paintedContrastOf` mide sobre píxeles: necesita 2x para no promediar bordes.
test.use({ deviceScaleFactor: 2 })

type Ancho = 'desktop' | 'mobile'

/**
 * Una acción que en mobile (< 768 px) NO es un botón del encabezado: BETA-UX-1D
 * la pasa a un menú. A ese ancho se le exige estar en el menú, con ese rótulo;
 * no se le exige —ni se espera— un botón visible.
 */
interface EnMenu { disparador: (page: Page) => Locator; menu: (page: Page) => Locator; item: string }
interface Accion { nombre: string; variante: Variante; localizar: (page: Page) => Locator; enMobile?: EnMenu }
interface Pantalla { ruta: string; listo: (page: Page) => Locator; acciones: Accion[] }

const enInicio = (page: Page, nombre: string) =>
  page.getByTestId('dashboard-actions').getByRole('button', { name: nombre, exact: true })

/** El menú del encabezado de Clientes en mobile. */
const MENU_DE_CLIENTES = {
  disparador: (page: Page) => page.getByTestId('customers-mobile-header-menu'),
  menu: (page: Page) => page.getByRole('menu', { name: 'Más acciones de clientes' }),
}
/** Las secundarias de Clientes: en el encabezado en escritorio, en el menú en mobile. */
const SECUNDARIAS_DE_CLIENTES = ['Plantilla', 'Exportar', 'Importar']

/** Las acciones de página que el lote llevó al contrato, por pantalla. */
const PANTALLAS: Pantalla[] = [
  {
    ruta: '/dashboard',
    listo: page => page.getByTestId('dashboard-tasks'),
    acciones: [
      { nombre: 'Inicio · Nueva Orden', variante: 'primary', localizar: page => enInicio(page, 'Nueva Orden') },
      { nombre: 'Inicio · Nuevo Comprobante', variante: 'secondary', localizar: page => enInicio(page, 'Nuevo Comprobante') },
      { nombre: 'Inicio · Gestionar Caja', variante: 'secondary', localizar: page => enInicio(page, 'Gestionar Caja') },
      { nombre: 'Inicio · Registrar gasto', variante: 'danger', localizar: page => enInicio(page, 'Registrar gasto') },
      { nombre: 'Inicio · Nueva tarea', variante: 'primary', localizar: page => page.getByTestId('dashboard-tasks').getByRole('button', { name: 'Nueva tarea' }) },
      { nombre: 'Inicio · Ver todas (tareas)', variante: 'secondary', localizar: page => page.getByRole('link', { name: 'Ver todas las tareas' }) },
      { nombre: 'Inicio · Ver todas (órdenes)', variante: 'secondary', localizar: page => page.getByRole('link', { name: 'Ver todas las órdenes' }) },
    ],
  },
  {
    ruta: '/orders',
    listo: page => page.getByTestId('orders-new-button'),
    acciones: [{ nombre: 'Órdenes · Nueva Orden', variante: 'primary', localizar: page => page.getByTestId('orders-new-button') }],
  },
  {
    ruta: '/customers',
    listo: page => page.getByTestId('customers-new-button'),
    acciones: [
      { nombre: 'Clientes · Nuevo Cliente', variante: 'primary', localizar: page => page.getByTestId('customers-new-button') },
      // Las tres compañeras del encabezado son la misma categoría. En mobile
      // no son botones del encabezado: las ofrece el menú (`enMobile`).
      ...SECUNDARIAS_DE_CLIENTES.map((nombre): Accion => ({
        nombre: `Clientes · ${nombre}`,
        variante: 'secondary',
        localizar: page => page.locator('.page-hdr-right').getByRole('button', { name: nombre, exact: true }),
        enMobile: { ...MENU_DE_CLIENTES, item: nombre },
      })),
    ],
  },
  {
    ruta: '/tasks',
    listo: page => page.locator('.page-shell').getByRole('button', { name: 'Nueva tarea' }).first(),
    acciones: [{ nombre: 'Tareas · Nueva tarea', variante: 'primary', localizar: page => page.locator('.page-shell').getByRole('button', { name: 'Nueva tarea' }).first() }],
  },
  {
    ruta: '/comprobantes',
    listo: page => page.getByTestId('comprobantes-new-button'),
    acciones: [{ nombre: 'Comprobantes · Nuevo Comprobante', variante: 'primary', localizar: page => page.getByTestId('comprobantes-new-button') }],
  },
  {
    ruta: '/warranties',
    listo: page => page.locator('.page-hdr-right').getByRole('button', { name: 'Nueva garantía' }),
    acciones: [{ nombre: 'Garantías · Nueva garantía', variante: 'primary', localizar: page => page.locator('.page-hdr-right').getByRole('button', { name: 'Nueva garantía' }) }],
  },
  {
    ruta: '/offers',
    listo: page => page.locator('.page-hdr-right').getByRole('button', { name: 'Nueva oferta' }),
    acciones: [{ nombre: 'Ofertas · Nueva oferta', variante: 'primary', localizar: page => page.locator('.page-hdr-right').getByRole('button', { name: 'Nueva oferta' }) }],
  },
]

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Espera a que terminen las animaciones de entrada: una caja a media escala mide de menos. */
const asentar = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations()
    .filter(a => a.effect?.getComputedTiming().iterations !== Infinity)
    .map(a => a.finished.catch(() => undefined))))

/**
 * Abre la pantalla y deja cada acción en el estado que le corresponde a ese
 * ancho. Ninguna se saltea: o está a la vista y habilitada en el encabezado, o
 * (sólo en mobile, sólo las que declaran `enMobile`) no está en el encabezado y
 * su menú sí.
 */
async function abrir(page: Page, pantalla: Pantalla, ancho: Ancho = 'desktop') {
  await page.goto(pantalla.ruta)
  await expect(pantalla.listo(page)).toBeVisible({ timeout: 30_000 })
  for (const accion of pantalla.acciones) {
    const boton = accion.localizar(page)
    const enMenu = ancho === 'mobile' ? accion.enMobile : undefined
    if (enMenu) {
      await expect(boton, `${accion.nombre}: en mobile no va como botón del encabezado`).toBeHidden()
      await expect(enMenu.disparador(page), `${accion.nombre}: falta el menú que la ofrece en mobile`).toBeVisible({ timeout: 30_000 })
      continue
    }
    await expect(boton, `${accion.nombre}: no está a la vista (${ancho})`).toBeVisible({ timeout: 30_000 })
    // «Nuevo Comprobante» está deshabilitado mientras carga la lista: se mide habilitado.
    await expect(boton, `${accion.nombre}: no está habilitada (${ancho})`).toBeEnabled({ timeout: 30_000 })
  }
  await page.waitForLoadState('networkidle')
  await asentar(page)
}

const estilo = (l: Locator) => l.evaluate(el => {
  const s = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  const icono = el.querySelector('svg')?.getBoundingClientRect()
  return {
    alto: r.height,
    fondo: s.backgroundColor, imagen: s.backgroundImage, color: s.color, borde: s.borderTopColor, sombra: s.boxShadow,
    contorno: s.outlineStyle,
    padding: `${s.paddingLeft}/${s.paddingRight}`, gap: s.columnGap, radio: s.borderTopLeftRadius,
    fuente: `${s.fontSize}/${s.fontWeight}`,
    icono: icono ? `${Math.round(icono.width)}x${Math.round(icono.height)}` : null,
  }
})

async function enReposo(page: Page, l: Locator) {
  await page.mouse.move(0, 0)
  await asentar(page)
  expect(await l.evaluate(el => el.matches(':hover')), 'se mide en reposo, sin el puntero encima').toBe(false)
}

async function bajoElPuntero(page: Page, l: Locator) {
  await l.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }))
  await l.hover()
  await asentar(page)
  expect(await l.evaluate(el => el.matches(':hover')), 'se mide con el puntero encima').toBe(true)
}

/** Colores que delatan una regla de Bootstrap ganando: los azules, grises y rojos de su paleta. */
const DE_BOOTSTRAP = /rgb\((13, 110, 253|11, 94, 215|10, 88, 202|10, 83, 190|108, 117, 125|92, 99, 106|86, 94, 100|220, 53, 69|187, 45, 59|176, 42, 55)\)/

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@button-system-1a acciones de página', () => {
  // Cada test recorre varias pantallas: el límite por defecto (30 s) no alcanza.
  test.describe.configure({ timeout: 120_000 })

  for (const tema of ['light', 'dark'] as const) {
    test(`${tema} · una acción de página mide y pinta lo mismo en todas las pantallas`, async ({ page }) => {
      await applyTheme(page, tema)
      await page.setViewportSize(DESKTOP)

      const medidas: (Awaited<ReturnType<typeof estilo>> & { nombre: string; variante: Variante })[] = []
      for (const pantalla of PANTALLAS) {
        await abrir(page, pantalla)
        for (const accion of pantalla.acciones) {
          const l = accion.localizar(page)
          await enReposo(page, l)
          medidas.push({ nombre: accion.nombre, variante: accion.variante, ...(await estilo(l)) })
        }
      }

      for (const m of medidas) {
        expect.soft(Math.abs(m.alto - ALTO), `${m.nombre}: alto ${m.alto}`).toBeLessThanOrEqual(TOL)
        expect.soft(m.padding, `${m.nombre}: padding`).toBe('16px/16px')
        expect.soft(m.gap, `${m.nombre}: espacio ícono–texto`).toBe('8px')
        expect.soft(m.fuente, `${m.nombre}: tipografía`).toBe('14px/600')
        expect.soft(m.imagen, `${m.nombre}: lleva un gradiente`).toBe('none')
        expect.soft(m.sombra, `${m.nombre}: lleva sombra`).toBe('none')
        if (m.icono) expect.soft(m.icono, `${m.nombre}: ícono`).toBe('16x16')
      }
      expect(new Set(medidas.map(m => m.radio)).size, `radios: ${[...new Set(medidas.map(m => m.radio))].join(', ')}`).toBe(1)

      // Las primarias son el MISMO botón en todas las pantallas: índigo sólido.
      const primarias = medidas.filter(m => m.variante === 'primary')
      expect(primarias).toHaveLength(8)
      expect([...new Set(primarias.map(m => `${m.fondo} · ${m.color}`))], primarias.map(m => `${m.nombre}: ${m.fondo}`).join('\n'))
        .toEqual(['rgb(79, 70, 229) · rgb(255, 255, 255)'])
      // Y una secundaria o un `danger` no se confunden con ella.
      for (const m of medidas.filter(x => x.variante !== 'primary')) {
        expect(m.fondo, `${m.nombre} pinta como una primaria`).not.toBe('rgb(79, 70, 229)')
      }
    })

    test(`${tema} · contraste pintado ≥ 4,5:1, en reposo y con el puntero encima`, async ({ page }) => {
      await applyTheme(page, tema)
      await page.setViewportSize(DESKTOP)

      // Inicio (la fila completa y el bloque de Tareas) y Órdenes.
      for (const pantalla of PANTALLAS.slice(0, 2)) {
        await abrir(page, pantalla)
        for (const accion of pantalla.acciones) {
          const l = accion.localizar(page)
          await enReposo(page, l)
          const reposo = await paintedContrastOf(l)
          expect.soft(reposo.ratio, `${accion.nombre} · ${tema} · reposo: ${reposo.foreground} sobre ${reposo.backgroundWorst} = ${reposo.ratio.toFixed(2)}:1`)
            .toBeGreaterThanOrEqual(AA_SMALL_TEXT)
          await bajoElPuntero(page, l)
          const hover = await paintedContrastOf(l)
          expect.soft(hover.ratio, `${accion.nombre} · ${tema} · hover: ${hover.foreground} sobre ${hover.backgroundWorst} = ${hover.ratio.toFixed(2)}:1`)
            .toBeGreaterThanOrEqual(AA_SMALL_TEXT)
        }
      }
    })

    test(`${tema} · hover, presionado y foco de teclado: sin gradiente y sin los colores de Bootstrap`, async ({ page }) => {
      await applyTheme(page, tema)
      await page.setViewportSize(DESKTOP)
      await abrir(page, PANTALLAS[0])

      for (const accion of PANTALLAS[0].acciones.slice(0, 5)) {
        const l = accion.localizar(page)
        await enReposo(page, l)
        const reposo = await estilo(l)

        await bajoElPuntero(page, l)
        const hover = await estilo(l)
        await page.mouse.down()
        await asentar(page)
        const presionado = await estilo(l)
        // Se suelta afuera: el estado se midió sin disparar la acción.
        await page.mouse.move(0, 0)
        await page.mouse.up()
        await expect(page, `${accion.nombre}: medir el presionado navegó`).toHaveURL(/\/dashboard$/)

        await l.focus()
        await page.keyboard.press('Shift+Tab')
        await page.keyboard.press('Tab')
        await asentar(page)
        expect(await l.evaluate(el => el.matches(':focus-visible')), `${accion.nombre}: no quedó con el foco del teclado`).toBe(true)
        const foco = await estilo(l)
        await l.evaluate(el => (el as HTMLElement).blur())

        for (const [estado, e] of [['reposo', reposo], ['hover', hover], ['presionado', presionado], ['foco', foco]] as const) {
          expect.soft(e.imagen, `${accion.nombre} · ${estado}: gradiente`).toBe('none')
          expect.soft(`${e.fondo} ${e.borde}`, `${accion.nombre} · ${estado}: color de Bootstrap`).not.toMatch(DE_BOOTSTRAP)
        }
        // El foco conserva los colores de la variante y muestra el anillo del sistema.
        expect.soft(foco.fondo, `${accion.nombre}: el foco cambió el fondo`).toBe(reposo.fondo)
        expect.soft(foco.color, `${accion.nombre}: el foco cambió el texto`).toBe(reposo.color)
        expect.soft(foco.contorno, `${accion.nombre}: el foco no tiene indicador`).toBe('solid')
        expect.soft(foco.sombra, `${accion.nombre}: el foco trae el halo de Bootstrap`).toBe('none')
        if (accion.variante === 'primary') {
          expect.soft(hover.fondo, `${accion.nombre}: el hover no es el índigo oscuro`).toBe('rgb(67, 56, 202)')
          expect.soft(presionado.fondo, `${accion.nombre}: presionado`).toBe('rgb(67, 56, 202)')
          expect.soft(hover.sombra, `${accion.nombre}: resplandor en hover`).toBe('none')
        }
      }
    })
  }

  test('375×812 · las acciones de página son un objetivo táctil de 44 px', async ({ page }) => {
    await applyTheme(page, 'light')
    await page.setViewportSize(MOBILE)
    const ofrecidasPorMenu: string[] = []
    for (const pantalla of PANTALLAS.slice(0, 3)) {
      // `abrir` ya exigió que cada acción del encabezado mobile esté a la vista
      // y habilitada: acá no se saltea ninguna.
      await abrir(page, pantalla, 'mobile')
      for (const accion of pantalla.acciones.filter(a => !a.enMobile)) {
        const l = accion.localizar(page)
        const caja = await l.boundingBox()
        expect(caja?.height ?? 0, `${accion.nombre}: alto en mobile`).toBeGreaterThanOrEqual(ALTO - 0.01)
        expect(await l.evaluate(el => el.scrollWidth - el.clientWidth), `${accion.nombre}: el texto se recorta`).toBeLessThanOrEqual(TOL)
      }

      // Las que en mobile viven en un menú (BETA-UX-1D): el disparador es un
      // objetivo táctil y el menú las ofrece, todas, en su orden y habilitadas.
      const enMenu = pantalla.acciones.flatMap(a => (a.enMobile ? [a.enMobile] : []))
      if (enMenu.length === 0) continue
      const [{ disparador, menu }] = enMenu
      const cajaDelMenu = await disparador(page).boundingBox()
      expect(cajaDelMenu?.height ?? 0, `${pantalla.ruta}: alto del menú del encabezado`).toBeGreaterThanOrEqual(ALTO - 0.01)
      expect(cajaDelMenu?.width ?? 0, `${pantalla.ruta}: ancho del menú del encabezado`).toBeGreaterThanOrEqual(ALTO - 0.01)
      await disparador(page).click()
      const items = menu(page).getByRole('menuitem')
      await expect(items, `${pantalla.ruta}: lo que ofrece el menú`).toHaveText(enMenu.map(m => m.item))
      for (const item of await items.all()) {
        const rotulo = (await item.textContent())?.trim() ?? ''
        await expect(item, `«${rotulo}» del menú: no está habilitada`).toBeEnabled()
        expect((await item.boundingBox())?.height ?? 0, `«${rotulo}» del menú: alto`).toBeGreaterThanOrEqual(ALTO - 0.01)
        ofrecidasPorMenu.push(rotulo)
      }
      await page.keyboard.press('Escape')
      await expect(menu(page)).toBeHidden()
    }
    // Las tres secundarias de Clientes se comprobaron DENTRO del menú: si alguien
    // les quita `enMobile`, esto falla en vez de dejarlas sin medir.
    expect(ofrecidasPorMenu).toEqual(SECUNDARIAS_DE_CLIENTES)
  })
})
