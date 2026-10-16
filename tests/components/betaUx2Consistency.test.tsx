// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-2 — consistencia visual y recepción más rápida.
//
// jsdom no aplica index.css: acá se fija el CONTRATO (marcado, accesibilidad,
// reglas y tokens). Lo pintado —geometría idéntica del encabezado en las
// pantallas internas, contraste, la navegación de Configuración en el celular—
// se mide en `tests/e2e/m7/beta-ux-2-consistency.spec.ts`, y el antes/después
// con `docs/beta-ux-2/evidence/capture.mjs`.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ClipboardList } from 'lucide-react'
import { AppPageHeader } from '../../src/ui/components/AppPageHeader'
import { AppStepper } from '../../src/ui/components/AppStepper'
import {
  SETTINGS_GROUPS, SETTINGS_SECTIONS, SettingsNav, isSettingsSection, settingsSectionLabel,
} from '../../src/components/settings/SettingsNav'

const here = dirname(fileURLToPath(import.meta.url))
const raiz = join(here, '../../')
const leer = (rel: string) => readFileSync(join(raiz, rel), 'utf8')
const sinComentarios = (texto: string) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const css = leer('src/index.css').replace(/\/\*[\s\S]*?\*\//g, '')

interface Regla { selectores: string[]; cuerpo: string }
const REGLAS: Regla[] = [...css.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)]
  .map(m => ({ selectores: m[1].split(',').map(s => s.trim()).filter(Boolean), cuerpo: m[2] }))
const reglasDe = (selector: string) => REGLAS.filter(r => r.selectores.includes(selector))
const declaraciones = (cuerpo: string): Record<string, string> =>
  Object.fromEntries(cuerpo.split(';').map(d => d.split(':').map(s => s.trim())).filter(d => d.length === 2))
const primeraDe = (selector: string) => {
  const [regla] = reglasDe(selector)
  if (!regla) throw new Error(`no hay regla para ${selector}`)
  return declaraciones(regla.cuerpo)
}

// ─── Encabezado compartido ───────────────────────────────────────────────────

describe('BETA-UX-2 · AppPageHeader es el encabezado de la referencia (Órdenes)', () => {
  it('emite la familia `.page-hdr*`, con el ícono decorativo y el título como h1', () => {
    render(
      <AppPageHeader
        icon={<ClipboardList size={20} />}
        title="Órdenes de Trabajo"
        description="Gestiona las órdenes"
        descriptionTestId="hdr-sub"
        badge={<span>3 vencidas</span>}
        actions={<button className="btn btn-primary btn-page-action">Nueva Orden</button>}
      />,
    )
    const titulo = screen.getByRole('heading', { level: 1, name: 'Órdenes de Trabajo' })
    expect(titulo).toHaveClass('page-hdr-title')
    const raizHdr = titulo.closest('.page-hdr') as HTMLElement
    expect(raizHdr).not.toBeNull()
    expect(raizHdr.querySelector('.page-hdr-left .page-hdr-icon')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('hdr-sub')).toHaveClass('page-hdr-subtitle')
    expect(screen.getByText('3 vencidas').closest('.page-hdr-heading')).not.toBeNull()
    expect(within(raizHdr.querySelector('.page-hdr-right') as HTMLElement).getByRole('button', { name: 'Nueva Orden' })).toBeInTheDocument()
    // Ningún estilo en línea: las medidas son del sistema, no de cada pantalla.
    expect(raizHdr.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('el tono es semántico (clase), no un color suelto', () => {
    const { container } = render(<AppPageHeader icon={<ClipboardList />} tone="danger" title="Gastos" />)
    expect(container.querySelector('.page-hdr-icon')).toHaveClass('page-hdr-icon--danger')
    expect(container.querySelector('.page-hdr-right')).toBeNull()
  })

  it('las acciones conservan la clase propia de la pantalla (Inicio recompone las suyas en mobile)', () => {
    const { container } = render(<AppPageHeader title="Inicio" actionsClassName="dash-actions-slot" actions={<span>x</span>} />)
    expect(container.querySelector('.page-hdr-right')).toHaveClass('dash-actions-slot')
  })
})

describe('BETA-UX-2 · las pantallas usan el patrón compartido', () => {
  const MIGRADAS = [
    'Dashboard', 'Orders', 'Comprobantes', 'Tasks', 'Expenses', 'CuentasCorrientes', 'Suppliers',
    'FinanceDashboard', 'FinanceHealthCheck', 'CajaPage', 'Warranties', 'Reports', 'Settings', 'NewCustomer',
  ]
  // BETA-UX-3: el encabezado de Configuración vive en su marco compartido
  // (`SettingsShell`), que usa Settings y las pantallas que entraron a él.
  const FUENTE: Record<string, string> = { Settings: 'src/components/settings/SettingsShell.tsx' }
  it.each(MIGRADAS)('%s usa `AppPageHeader`', (pagina) => {
    expect(sinComentarios(leer(FUENTE[pagina] ?? `src/pages/${pagina}.tsx`))).toMatch(/<AppPageHeader\b/)
  })

  it('Settings se dibuja en ese marco', () => {
    expect(sinComentarios(leer('src/pages/Settings.tsx'))).toMatch(/<SettingsFrame\b/)
  })

  it('no queda ningún encabezado armado a mano con `.page-top` + `.stat-icon`', () => {
    const paginas = readdirSync(join(raiz, 'src/pages')).filter(f => f.endsWith('.tsx'))
    const conPageTop = paginas.filter(f => /className="page-top"/.test(sinComentarios(leer(`src/pages/${f}`))))
    expect(conPageTop).toEqual([])
  })

  it('`iconColor` dejó de existir: el tono se pide por nombre', () => {
    const paginas = readdirSync(join(raiz, 'src/pages')).filter(f => f.endsWith('.tsx'))
    expect(paginas.filter(f => /\biconColor=/.test(leer(`src/pages/${f}`)))).toEqual([])
  })

  it('las acciones visibles de los encabezados migrados son UNA categoría (acción de página)', () => {
    // Regla del owner (BUTTON-SYSTEM-1A): mismo alto en la fila del encabezado.
    for (const pagina of ['Comprobantes', 'Suppliers', 'CajaPage', 'FinanceHealthCheck', 'Expenses', 'CuentasCorrientes']) {
      const fuente = sinComentarios(leer(`src/pages/${pagina}.tsx`))
      const inicio = fuente.indexOf('<AppPageHeader')
      const encabezado = fuente.slice(inicio, fuente.indexOf('/>\n', fuente.indexOf('actions=', inicio)))
      expect(encabezado, pagina).not.toMatch(/\bbtn-(sm|xs|lift)\b|size="sm"/)
    }
  })
})

describe('BETA-UX-2 · CSS del encabezado y del ritmo vertical', () => {
  it('el ícono es tinte plano con tokens: sin gradiente ni colores sueltos', () => {
    const icono = primeraDe('.page-hdr-icon')
    expect(icono.width).toBe('var(--page-header-icon)')
    expect(icono.background).toBe('var(--page-icon-bg)')
    for (const r of REGLAS.filter(r => r.selectores.some(s => s.startsWith('.page-hdr'))))
      expect(r.cuerpo, r.selectores.join(',')).not.toMatch(/gradient|#818cf8|rgba\(139/)
  })

  it('tokens: 48px de ícono y 24px de glifo en escritorio; 44/22 en el celular', () => {
    const raices = reglasDe(':root').map(r => declaraciones(r.cuerpo)).filter(d => '--page-header-icon' in d)
    expect(raices.map(d => d['--page-header-icon'])).toEqual(['48px', '44px'])
    expect(raices.map(d => d['--page-header-glyph'])).toEqual(['24px', '22px'])
    expect(primeraDe('.page-hdr-icon svg').width).toBe('var(--page-header-glyph)')
  })

  it('el subtítulo usa un token que pasa AA sobre el fondo del shell, nunca `--text-subtle`', () => {
    expect(primeraDe('.page-hdr-subtitle').color).toBe('var(--text-secondary)')
    expect(primeraDe('.page-subtitle').color).toBe('var(--text-secondary)')
  })

  it('`.page-shell` no suma padding al del layout, en ningún ancho', () => {
    const paddings = reglasDe('.page-shell').map(r => declaraciones(r.cuerpo).padding)
    expect(paddings).toEqual(['0'])
    expect(reglasDe('.dash-page.page-shell')).toEqual([])
  })

  it('Inicio: el slot de acciones es bloque, para que la fila ocupe el ancho del encabezado', () => {
    // CI (técnico, 375px): como flex, «Nueva Orden» medía 146px y «Actualizar»
    // quedaba 194px fuera de su fila. `.page-hdr-right` sigue siendo flex.
    expect(primeraDe('.dash-actions-slot').display).toBe('block')
    expect(primeraDe('.page-hdr-right').display).toBe('flex')
    const iSlot = REGLAS.findIndex(r => r.selectores.includes('.dash-actions-slot'))
    const iDerecha = REGLAS.findIndex(r => r.selectores.includes('.page-hdr-right'))
    expect(iSlot, 'la regla de Inicio va después y gana el empate').toBeGreaterThan(iDerecha)
  })

  it('con barra de acción fija, el scroll al foco descuenta la barra y la navegación inferior', () => {
    // CI (320×568): «Crear cliente rápido» quedaba 1–3px debajo del borde de la
    // barra y `scrollIntoView` no lo movía.
    const regla = reglasDe('html:has(.mobile-action-bar)')
    expect(regla).toHaveLength(1)
    const padding = declaraciones(regla[0].cuerpo)['scroll-padding-bottom']
    for (const parte of ['var(--mobile-bottom-nav-height)', 'var(--mobile-cta-height)', '1.5rem', '0.5rem', 'env(safe-area-inset-bottom, 0px)'])
      expect(padding).toContain(parte)
    const enMobile = css.indexOf('html:has(.mobile-action-bar)')
    expect(css.slice(css.lastIndexOf('@media', enMobile), css.indexOf('{', css.lastIndexOf('@media', enMobile))).trim()).toBe('@media (max-width: 1023px)')
  })

  it('la barra de progreso del gradiente índigo→cyan se retiró', () => {
    expect(reglasDe('.intake-progress')).toEqual([])
    expect(reglasDe('.intake-progress span')).toEqual([])
  })
})

// ─── AppStepper ──────────────────────────────────────────────────────────────

describe('BETA-UX-2 · AppStepper', () => {
  const PASOS = ['Cliente', 'Equipo', 'Ingreso', 'Confirmar'] as const

  it('cada paso dice su estado con forma y texto; el actual lleva aria-current', () => {
    render(<AppStepper steps={PASOS} current={2} label="Pasos de la recepción" />)
    const lista = screen.getByRole('list', { name: 'Pasos de la recepción' })
    const items = within(lista).getAllByRole('listitem')
    expect(items.map(i => i.getAttribute('data-state'))).toEqual(['done', 'done', 'current', 'upcoming'])
    expect(items[2]).toHaveAttribute('aria-current', 'step')
    expect(items[2]).toHaveTextContent('paso 3 de 4, actual')
    // Sin `onSelect` es sólo informativo: ningún botón.
    expect(within(lista).queryAllByRole('button')).toHaveLength(0)
  })

  it('con `onSelect`, sólo los pasos hechos son botones (no se saltea hacia adelante)', () => {
    const onSelect = vi.fn()
    render(<AppStepper steps={PASOS} current={2} onSelect={onSelect} />)
    const botones = screen.getAllByRole('button')
    expect(botones.map(b => b.getAttribute('aria-label'))).toEqual([
      'Volver al paso 1: Cliente (completo)', 'Volver al paso 2: Equipo (completo)',
    ])
    fireEvent.click(botones[1])
    expect(onSelect).toHaveBeenCalledWith(1)
  })

  it('el estado no depende sólo del color: hecho = check, actual/pendiente = número', () => {
    const { container } = render(<AppStepper steps={PASOS} current={1} />)
    const marcas = [...container.querySelectorAll('.app-stepper__marker')]
    expect(marcas[0].querySelector('svg')).not.toBeNull()
    expect(marcas[1].textContent).toBe('2')
    expect(marcas[2].textContent).toBe('3')
  })
})

// ─── Configuración ───────────────────────────────────────────────────────────

describe('BETA-UX-2 · navegación de Configuración', () => {
  // BETA-UX-3 sumó Moneda (Negocio), Equipo y TechRepair Pro: pantallas con ruta
  // propia, fuera de `?tab=`. Las diez secciones de `?tab=` no cambiaron.
  it('seis grupos; las diez secciones de `?tab=`, cada una UNA vez', () => {
    expect(SETTINGS_GROUPS.map(g => g.label)).toEqual(['Negocio', 'Equipo', 'Facturación', 'Cobros', 'Documentos y mensajes', 'TechRepair Pro'])
    expect(SETTINGS_SECTIONS).toHaveLength(10)
    expect(new Set(SETTINGS_SECTIONS).size).toBe(10)
    // Las mismas claves que ya usaban los enlaces (`?tab=`): nada se rompe.
    expect([...SETTINGS_SECTIONS].sort()).toEqual(
      ['arca', 'comisiones', 'comprobante', 'datos', 'orden', 'pagos', 'preferencias', 'puntos', 'seguridad', 'whatsapp'],
    )
  })

  it('un `?tab=` desconocido no es una sección (la pantalla cae a «datos», no en blanco)', () => {
    expect(isSettingsSection('arca')).toBe(true)
    expect(isSettingsSection('inexistente')).toBe(false)
    expect(isSettingsSection(null)).toBe(false)
    expect(settingsSectionLabel('pagos')).toBe('Cobros y pagos')
  })

  it('cada grupo es una lista con nombre; la sección actual lleva aria-current', () => {
    const onSelect = vi.fn()
    render(<SettingsNav active="arca" onSelect={onSelect} can={() => true} />)
    const nav = screen.getByRole('navigation', { name: 'Secciones de configuración' })
    expect(within(nav).getAllByRole('list').map(l => l.getAttribute('aria-labelledby'))).toEqual([
      'settings-group-negocio', 'settings-group-equipo', 'settings-group-facturacion', 'settings-group-cobros',
      'settings-group-documentos', 'settings-group-techrepair',
    ])
    expect(within(nav).getByRole('list', { name: 'Facturación' })).toBeInTheDocument()
    const actual = within(nav).getByRole('button', { name: 'Integración ARCA' })
    expect(actual).toHaveAttribute('aria-current', 'page')
    expect(actual).toHaveClass('is-active')
    expect(within(nav).getAllByRole('button').filter(b => b.hasAttribute('aria-current'))).toHaveLength(1)
    fireEvent.click(within(nav).getByRole('button', { name: 'WhatsApp' }))
    expect(onSelect).toHaveBeenCalledWith('whatsapp')
  })

  it('ya no hay íconos repetidos ni equivocados (escudo para cobros, campana para comisiones)', () => {
    const iconos = SETTINGS_GROUPS.flatMap(g => g.sections.map(s => s.icon))
    expect(new Set(iconos).size).toBe(iconos.length)
  })

  it('el corte escritorio / celular lo decide el CSS con `[data-view]`', () => {
    expect(primeraDe('.settings-layout')['grid-template-columns']).toBe('248px minmax(0, 1fr)')
    expect(declaraciones(reglasDe('.settings-page[data-view="list"] .settings-content')[0].cuerpo).display).toBe('none')
    expect(declaraciones(reglasDe('.settings-page[data-view="section"] .settings-nav')[0].cuerpo).display).toBe('none')
    // El ítem activo tiene forma (barra) y peso, no sólo color.
    expect(primeraDe('.settings-nav__item.is-active')['font-weight']).toBe('700')
    expect(primeraDe('.settings-nav__item.is-active::before').width).toBe('3px')
  })

  it('Settings lee la sección de la URL y la escribe al elegir', () => {
    const fuente = sinComentarios(leer('src/pages/Settings.tsx'))
    expect(fuente).toMatch(/isSettingsSection\(requestedTab\) \? requestedTab : 'datos'/)
    expect(fuente).toMatch(/next\.set\('tab', section\)/)
    // Las pestañas sueltas se fueron.
    expect(fuente).not.toMatch(/className=\{`tab\$\{/)
  })
})
