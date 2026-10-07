// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1B · smoke manual — el POS no puede quedar atrapado en la página.
//
// Abierto desde una orden, el POS aparecía corrido y con el fondo empezando
// dentro del área de la página. Causa medida: `OrderDetail` se envuelve en
// `.animate-fade-in`, cuya animación terminaba en `transform: translateY(0)` y
// se conservaba con `forwards`. Un `transform` distinto de `none` vuelve al
// elemento bloque contenedor de sus descendientes `position: fixed` — el
// `inset: 0` del POS cubría la página, no el viewport.
//
// Dos correcciones, dos guardas:
//
//   A. PORTAL. El POS y sus capas hermanas se montan en <body>. Se prueba
//      montándolo DENTRO de un ancestro transformado: no puede quedar adentro.
//      Y se prueba que el portal no cambió nada del comportamiento: cerrar,
//      Escape, confirmación con contenido, «Abrir caja» por encima y sin
//      desmontar el POS.
//
//   B. ANIMACIÓN. `.animate-fade-in` ya no retiene su último fotograma (sin
//      `forwards`). jsdom no corre animaciones, así que acá el guard es
//      estructural sobre el CSS; el contrato real
//      (`getComputedStyle(...).transform === 'none'` al terminar) lo mide
//      `tests/e2e/m7/pos-viewport-containment.spec.ts` en un navegador.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const BIZ_ID  = '22222222-2222-4222-8222-222222222222'

const estado = vi.hoisted(() => ({
  perfil: null as Record<string, unknown> | null,
  cajaAbierta: false,
  crear: [] as Array<Record<string, unknown>>,
  rpcs: [] as string[],
}))

vi.mock('../../src/lib/supabase', () => {
  const chain = (tabla: string): unknown => {
    const c: unknown = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'maybeSingle' || prop === 'single') {
          return async () => tabla === 'cajas' && estado.cajaAbierta
            ? { data: { id: '33333333-3333-4333-8333-333333333333', business_id: '22222222-2222-4222-8222-222222222222', opened_at: '2026-10-07T12:00:00Z', opened_by: null, status: 'abierta' }, error: null }
            : { data: null, error: null }
        }
        if (prop === 'then') return (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: [], error: null })
        return () => c
      },
    })
    return c
  }
  return {
    supabase: {
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: '11111111-1111-4111-8111-111111111111', email: 'u@invalid.test', email_confirmed_at: '2026-08-24T00:00:00Z' } } },
          error: null,
        }),
        getUser: async () => ({ data: { user: { id: '11111111-1111-4111-8111-111111111111' } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signOut: async () => ({ error: null }),
      },
      rpc: async (fn: string) => {
        estado.rpcs.push(fn)
        if (fn === 'get_my_profile') return { data: estado.perfil, error: null }
        if (fn === 'get_current_exchange_rate') return { data: 1450, error: null }
        if (fn === 'open_cash_session_atomic') {
          estado.cajaAbierta = true
          return { data: { ok: true, replay: false, caja_id: '33333333-3333-4333-8333-333333333333' }, error: null }
        }
        return { data: null, error: null }
      },
      from: (tabla: string) => chain(tabla),
    },
  }
})

vi.mock('../../src/services/comprobanteService', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/comprobanteService')>()
  return {
    ...real,
    comprobanteService: {
      ...real.comprobanteService,
      crear: async (input: Record<string, unknown>) => { estado.crear.push(input); return { success: true } },
      getCheckoutStatus: async () => ({ found: false }),
      getById: async () => null,
    },
  }
})
vi.mock('../../src/hooks/usePaymentCommissions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/hooks/usePaymentCommissions')>()
  return { ...real, usePaymentCommissions: () => ({ flatMethods: real.FIXED_METHODS }) }
})
vi.mock('../../src/hooks/useWholesaleAccess', () => ({ useWholesaleAccess: () => ({ canAccess: false }) }))
vi.mock('../../src/services/posCustomerSearchService', () => ({
  searchPosCustomers: async () => ({ status: 'ok', items: [], truncated: false }),
  getPosCustomerById: async () => null,
}))
vi.mock('../../src/services/productSearchService', () => ({
  searchSellableProducts: async () => ({ status: 'ok', items: [] }),
  isSellableProduct: () => true,
}))
vi.mock('../../src/services/salesPointService', () => ({ salesPointService: { getActiveNumeroFormateado: async () => '0007' } }))
vi.mock('../../src/services/arcaService', () => ({ ArcaService: { getPuntoVentaFiscal: async () => null } }))
vi.mock('../../src/components/products/ProductFormModal', () => ({ ProductFormModalSafe: () => null }))
vi.mock('../../src/components/whatsapp/WhatsAppPreviewModal', () => ({ WhatsAppPreviewModal: () => null }))
vi.mock('../../src/lib/sounds', () => ({ soundSystem: { isEnabled: () => false, play: () => {}, toggle: () => false } }))

import { AuthProvider, useAuth } from '../../src/contexts/AuthContext'
import { CajaProvider } from '../../src/contexts/CajaContext'
import { ComprobanteProModal, type ComprobanteProModalProps } from '../../src/components/comprobantes/ComprobanteProModal'
import { ModalPortal } from '../../src/components/ui/ModalPortal'

const here = dirname(fileURLToPath(import.meta.url))
const raiz = join(here, '../../')
const leer = (rel: string) => readFileSync(join(raiz, rel), 'utf8').replace(/\r\n/g, '\n')
const sinComentariosCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const sinComentariosTs = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const ITEMS: NonNullable<ComprobanteProModalProps['initialItems']> = [
  { descripcion: 'Cambio de módulo iPhone 13', cantidad: 1, precio_unitario: 85000, costo_unitario: 40000, tipo_linea: 'servicio' },
]

function Sonda() {
  const { profile } = useAuth()
  return <span data-testid="sonda-rol">{profile?.role ?? 'sin-perfil'}</span>
}

const onClose = vi.fn()

/** El POS montado como lo deja una página animada: dentro de un ancestro transformado. */
async function montarEnPaginaTransformada(props: Partial<ComprobanteProModalProps> = {}) {
  estado.perfil = {
    id: USER_ID, business_id: BIZ_ID, role: 'owner', is_active: true,
    full_name: 'U', email: 'u@invalid.test', phone: null, permissions: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }
  const utils = render(
    <AuthProvider>
      <CajaProvider>
        <Sonda />
        <div data-testid="pagina-animada" className="animate-fade-in" style={{ transform: 'translateY(0)' }}>
          <h1>Orden #1234</h1>
          <ComprobanteProModal isOpen onClose={onClose} {...props} />
        </div>
      </CajaProvider>
    </AuthProvider>,
  )
  await waitFor(() => expect(screen.getByTestId('sonda-rol').textContent).toBe('owner'))
  await waitFor(() => expect(estado.rpcs).toContain('get_current_exchange_rate'))
  return utils
}

const posRoot = () => document.querySelector('.cpm-root') as HTMLElement | null

beforeEach(() => {
  estado.perfil = null
  estado.cajaAbierta = false
  estado.crear = []
  estado.rpcs = []
  onClose.mockClear()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A · el POS vive en un portal, fuera de la página que lo abre', () => {
  it('montado dentro de un ancestro transformado, `.cpm-root` NO queda adentro: es hijo de <body>', async () => {
    const { container } = await montarEnPaginaTransformada({ initialItems: ITEMS })
    const pagina = screen.getByTestId('pagina-animada')
    const root = posRoot()

    expect(root, 'el POS debe estar montado').not.toBeNull()
    expect(pagina.contains(root), '.cpm-root quedó dentro del ancestro transformado').toBe(false)
    expect(container.contains(root), '.cpm-root quedó dentro del árbol de la página').toBe(false)
    expect(root!.parentElement).toBe(document.body)
    // Ningún ancestro del POS puede ser su bloque contenedor.
    for (let p = root!.parentElement; p; p = p.parentElement) {
      expect(p.style.transform, `${p.tagName} transformado por encima del POS`).toBe('')
      expect(p.classList.contains('animate-fade-in')).toBe(false)
    }
    // La página conserva lo suyo; sólo salió el modal.
    expect(within(pagina).getByText('Orden #1234')).toBeInTheDocument()
    expect(within(pagina).queryByTestId('comprobante-product-search')).toBeNull()
    // Y el POS funciona: el carrito de la orden está cargado.
    expect((screen.getByTestId('comprobante-item-description') as HTMLInputElement).value).toBe(ITEMS[0].descripcion)
  })

  it('hay UN solo POS en el documento (el portal no lo duplica)', async () => {
    await montarEnPaginaTransformada({ initialItems: ITEMS })
    expect(document.querySelectorAll('.cpm-root')).toHaveLength(1)
    expect(screen.getAllByTestId('comprobante-save-button')).toHaveLength(1)
  })

  it('las capas hermanas salen por el MISMO portal, después del POS: la confirmación de cierre nunca queda debajo', async () => {
    await montarEnPaginaTransformada({ initialItems: ITEMS })
    const root = posRoot()!
    // Con contenido, Escape NO cierra: pregunta.
    fireEvent.keyDown(document, { key: 'Escape' })
    const titulo = await screen.findByText('Cambios sin guardar')
    expect(onClose).not.toHaveBeenCalled()

    // La confirmación es hermana del POS en <body>, posterior en el DOM y con
    // un z-index mayor: mismo contexto de apilamiento, siempre arriba.
    const capa = titulo.closest('div[style*="position: fixed"]') as HTMLElement
    expect(capa.parentElement).toBe(document.body)
    expect(root.compareDocumentPosition(capa) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(Number(capa.style.zIndex)).toBeGreaterThan(Number(root.style.zIndex))
    expect(screen.getByTestId('pagina-animada').contains(capa)).toBe(false)

    // «Seguir editando» vuelve al POS intacto; «Descartar y cerrar» cierra.
    fireEvent.click(screen.getByText('Seguir editando'))
    await waitFor(() => expect(screen.queryByText('Cambios sin guardar')).toBeNull())
    expect(posRoot()).toBe(root)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(await screen.findByText('Descartar y cerrar'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('cerrar sigue funcionando: botón, Escape y click en el fondo (carrito vacío)', async () => {
    await montarEnPaginaTransformada()
    fireEvent.click(screen.getByTestId('comprobante-cancel-button'))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)

    // Click en el fondo (el propio overlay) cierra; click dentro del shell, no.
    fireEvent.click(document.querySelector('.cpm-shell') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.click(posRoot()!)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('cerrado no deja nada en <body>; al desmontar tampoco', async () => {
    const { unmount } = await montarEnPaginaTransformada({ initialItems: ITEMS })
    expect(posRoot()).not.toBeNull()
    unmount()
    expect(posRoot()).toBeNull()
    expect(document.body.querySelector('[data-testid="comprobante-save-button"]')).toBeNull()

    render(
      <AuthProvider><CajaProvider>
        <ComprobanteProModal isOpen={false} onClose={onClose} />
      </CajaProvider></AuthProvider>,
    )
    expect(posRoot()).toBeNull()
  })

  it('«Abrir caja» sigue DENTRO del POS, por encima del shell, y abrirlo o cerrarlo no desmonta el POS', async () => {
    await montarEnPaginaTransformada({ initialItems: ITEMS })
    const root = posRoot()!
    const descripcion = screen.getByTestId('comprobante-item-description')

    fireEvent.click(await screen.findByTestId('pos-open-caja-button'))
    const overlay = await screen.findByTestId('pos-open-caja-overlay')
    // Dentro de .cpm-root (necesita sus tokens) y posterior al shell en el DOM.
    expect(root.contains(overlay)).toBe(true)
    expect(overlay.parentElement).toBe(root)
    const shell = root.querySelector('.cpm-shell') as HTMLElement
    expect(shell.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Mismo nodo del POS y mismo input del carrito: no hubo remontaje.
    expect(posRoot()).toBe(root)
    expect(screen.getByTestId('comprobante-item-description')).toBe(descripcion)

    fireEvent.click(screen.getByTestId('pos-open-caja-cancel'))
    await waitFor(() => expect(screen.queryByTestId('pos-open-caja-dialog')).toBeNull())
    expect(posRoot()).toBe(root)
    expect(screen.getByTestId('comprobante-item-description')).toBe(descripcion)

    // Abrir la caja de verdad: mismo POS, misma venta.
    fireEvent.click(screen.getByTestId('pos-open-caja-button'))
    fireEvent.click(await screen.findByTestId('pos-open-caja-confirm'))
    await waitFor(() => expect(screen.queryByTestId('pos-caja-closed')).toBeNull())
    expect(posRoot()).toBe(root)
    expect(screen.getByTestId('comprobante-item-description')).toBe(descripcion)
    expect((descripcion as HTMLInputElement).value).toBe(ITEMS[0].descripcion)
    expect(estado.crear).toEqual([])
  })

  it('el contexto de React atraviesa el portal: la capacidad y la caja siguen llegando al POS', async () => {
    await montarEnPaginaTransformada({ initialItems: ITEMS })
    // owner + caja cerrada → el aviso accionable de BETA-UX-1B, dentro del POS.
    const aviso = await screen.findByTestId('pos-caja-closed')
    await waitFor(() => expect(aviso).toHaveAttribute('data-caja-action', 'open'))
    expect(posRoot()!.contains(screen.getByTestId('pos-caja-closed'))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('ModalPortal', () => {
  it('monta a sus hijos como hijos directos de <body>, sin wrapper, y los retira al desmontar', () => {
    const { container, unmount } = render(
      <div data-testid="pagina" style={{ transform: 'scale(1)' }}>
        <ModalPortal><div data-testid="capa">contenido</div></ModalPortal>
      </div>,
    )
    const capa = screen.getByTestId('capa')
    expect(capa.parentElement).toBe(document.body)
    expect(container.contains(capa)).toBe(false)
    unmount()
    expect(screen.queryByTestId('capa')).toBeNull()
  })

  it('es sólo el punto de montaje: los eventos sintéticos siguen el árbol de React', () => {
    const onClick = vi.fn()
    render(
      <div onClick={onClick}>
        <ModalPortal><button data-testid="boton">ok</button></ModalPortal>
      </div>,
    )
    fireEvent.click(screen.getByTestId('boton'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('no trae comportamiento ni dependencias: createPortal a document.body y nada más', () => {
    const src = sinComentariosTs(leer('src/components/ui/ModalPortal.tsx'))
    expect(src).toMatch(/return createPortal\(children, document\.body\)/)
    expect(src).not.toMatch(/useEffect|useState|addEventListener|overflow|zIndex|style=/)
    expect([...src.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort()).toEqual(['react', 'react-dom'])
  })

  it('el POS lo usa como raíz de TODO lo que renderiza', () => {
    const modal = sinComentariosTs(leer('src/components/comprobantes/ComprobanteProModal.tsx'))
    expect(modal).toMatch(/import \{ ModalPortal \} from '\.\.\/ui\/ModalPortal'/)
    // Un único return con JSX, que abre y cierra con el portal: ninguna capa afuera.
    expect(modal).toMatch(/return \(\s*<ModalPortal>\s*<div\s+className=\{`cpm-root/)
    expect(modal).toMatch(/<\/ModalPortal>\s*\)\s*\}\s*$/)
    expect(modal.match(/<ModalPortal>/g)).toHaveLength(1)
    // Sin parches de posición: el arreglo es el punto de montaje, no un offset.
    const raizDelPos = modal.slice(modal.indexOf('className={`cpm-root'), modal.indexOf('className={`cpm-shell'))
    expect(raizDelPos).toMatch(/position: 'fixed', inset: 0, zIndex: 9999/)
    expect(raizDelPos).not.toMatch(/scrollY|pageYOffset|getBoundingClientRect|marginTop|top:\s*-?\d/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B · `.animate-fade-in` no deja un transform aplicado', () => {
  const css = sinComentariosCss(leer('src/index.css'))

  /** Todos los bloques `@keyframes <nombre> { … }` de un CSS, con sus pasos. */
  function keyframes(source: string, nombre: string): string[] {
    const out: string[] = []
    const re = new RegExp(`@keyframes\\s+${nombre}\\s*\\{`, 'g')
    for (let m = re.exec(source); m; m = re.exec(source)) {
      let i = m.index + m[0].length, nivel = 1
      while (i < source.length && nivel > 0) { if (source[i] === '{') nivel++; else if (source[i] === '}') nivel--; i++ }
      out.push(source.slice(m.index + m[0].length, i - 1))
    }
    return out
  }
  /** Declaraciones del paso final (`to` / `100%`) de un bloque de keyframes. */
  const pasoFinal = (bloque: string) => (bloque.match(/(?:^|[\s}])(?:to|100%)\s*\{([^}]*)\}/) ?? [])[1] ?? null

  it('hay UNA sola definición de `@keyframes fadeIn` y una sola de `.animate-fade-in` en las hojas de estilo', () => {
    expect(keyframes(css, 'fadeIn')).toHaveLength(1)
    expect(css.match(/\.animate-fade-in\s*\{/g)).toHaveLength(1)
    for (const hoja of readdirSync(join(raiz, 'src/css')).filter(f => f.endsWith('.css'))) {
      const otra = sinComentariosCss(leer(`src/css/${hoja}`))
      expect(keyframes(otra, 'fadeIn'), `src/css/${hoja} redefine fadeIn`).toHaveLength(0)
      expect(otra, `src/css/${hoja} redefine .animate-fade-in`).not.toMatch(/\.animate-fade-in\b/)
    }
  })

  const regla = (css.match(/\.animate-fade-in\s*\{([^}]*)\}/) ?? [])[1] ?? ''

  it('`.animate-fade-in` NO retiene el último fotograma: sin `forwards` ni `both`', () => {
    // El contrato. Retener el fotograma final deja aplicado su `transform`, y un
    // `transform` distinto de `none` atrapa a los `position: fixed` de adentro.
    //
    // Terminar el keyframe en `transform: none` NO es una alternativa: medido en
    // Chromium con `to { transform: none }` + `forwards`, `getComputedStyle`
    // siguió devolviendo `matrix(1, 0, 0, 1, 0, 0)` (el valor retenido es la
    // lista interpolada, no `none`). Lo único que libera al elemento es que la
    // animación termine.
    expect(regla).toMatch(/^\s*animation:\s*fadeIn\s+0\.28s\s+ease\s*;\s*$/)
    expect(regla).not.toMatch(/forwards|both/)
    // Tampoco por la propiedad larga, en esa regla o en otra.
    expect(css).not.toMatch(/\.animate-fade-in\b[^{}]*\{[^}]*animation-fill-mode/)
  })

  it('el fotograma final ES el estado natural del elemento: terminar la animación no produce un salto', () => {
    const [bloque] = keyframes(css, 'fadeIn')
    const fin = pasoFinal(bloque)
    expect(fin, 'fadeIn debe declarar su paso final').not.toBeNull()
    // Opacidad plena y desplazamiento cero: lo mismo que el elemento sin animar.
    expect(fin).toMatch(/opacity:\s*1\s*;/)
    expect(fin).toMatch(/transform:\s*(none|translateY\(0(px)?\))\s*;/)
    // …y la clase no declara un estado base distinto que dependa del fill.
    expect(regla).not.toMatch(/opacity|transform/)
    // La entrada no cambió: sigue arrancando 8px abajo y transparente.
    expect(bloque).toMatch(/from\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(8px\);\s*\}/)
  })

  it('nada más en esa clase crea un bloque contenedor para `position: fixed`', () => {
    const [bloque] = keyframes(css, 'fadeIn')
    expect(bloque).not.toMatch(/filter|perspective|contain\s*:|will-change/)
    expect(regla).not.toMatch(/filter|perspective|contain\s*:|will-change/)
  })

  it('ningún uso de `.animate-fade-in` arranca invisible esperando que la animación lo deje visible', () => {
    // Sin `forwards`, un elemento con `opacity: 0` propio volvería a quedar
    // invisible al terminar. Hoy ninguno lo hace; esto lo mantiene así.
    const usos: string[] = []
    const recorrer = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) { recorrer(p); continue }
        if (!/\.tsx$/.test(e)) continue
        const lineas = sinComentariosTs(readFileSync(p, 'utf8')).split('\n')
        lineas.forEach((l, i) => {
          if (!/className=(?:"|\{`)[^"`]*\banimate-fade-in\b(?!-)/.test(l)) return
          const elemento = lineas.slice(i, i + 10).join('\n')
          usos.push(relative(raiz, p).replace(/\\/g, '/'))
          expect(elemento.slice(0, elemento.indexOf('>') + 1 || undefined), `${e}:${i + 1}`).not.toMatch(/opacity:\s*0\b/)
        })
      }
    }
    recorrer(join(raiz, 'src'))
    // El guard mide algo: los wrappers de página conocidos están entre los usos.
    expect(usos).toEqual(expect.arrayContaining(['src/pages/OrderDetail.tsx', 'src/pages/CustomerDetail.tsx']))
  })

  it('nadie más redefine `fadeIn` con un <style> en línea (salvo la colisión conocida del portal mayorista)', () => {
    // Un `@keyframes fadeIn` inyectado por un componente pisa al global mientras
    // ese componente esté montado. Hoy lo hace una sola pantalla, del portal
    // mayorista (dominio aparte); cualquier otra sería una regresión de esto.
    const encontrados: string[] = []
    const recorrer = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) recorrer(p)
        else if (/\.tsx?$/.test(e) && /@keyframes\s+fadeIn\s*\{/.test(readFileSync(p, 'utf8'))) {
          encontrados.push(relative(raiz, p).replace(/\\/g, '/'))
        }
      }
    }
    recorrer(join(raiz, 'src'))
    expect(encontrados).toEqual(['src/portal/pages/PortalCatalog.tsx'])
  })

  it('las páginas que usan el wrapper siguen usándolo (la entrada no se quitó, se corrigió)', () => {
    for (const pagina of ['src/pages/OrderDetail.tsx', 'src/pages/CustomerDetail.tsx', 'src/pages/DashboardNew.tsx', 'src/pages/Reports.tsx']) {
      expect(leer(pagina), pagina).toMatch(/className="animate-fade-in"/)
    }
  })
})
