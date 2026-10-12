// ─────────────────────────────────────────────────────────────────────────────
// BUTTON-SYSTEM-1A — contrato del sistema de botones.
//
// La misma jerarquía de acción («Nueva Orden» en Inicio y en Órdenes, «Nueva
// tarea» en Inicio y en Tareas) tenía colores, gradientes, altos, paddings e
// íconos distintos según la pantalla, y dos índigos (`primary` con un gradiente
// índigo → cyan, `indigo` con otro). Decisión del owner:
//
//   · los botones normales NO llevan gradientes;
//   · primary es índigo sólido, y la jerarquía la dan la semántica y la
//     posición, no un color distinto;
//   · las acciones de página comparten tamaño (`.btn-page-action`, 44px);
//   · los botones compactos conservan el suyo: la uniformidad es por categoría.
//
// jsdom no aplica `index.css`: acá se fija el CONTRATO (reglas, clases y la
// aritmética WCAG de los tokens). Lo pintado —alto real, estados con Bootstrap
// cargado, contraste sobre píxeles— se mide en `tests/e2e/m7/button-system.spec.ts`
// y en `docs/beta-ux-1/evidence-1f/verify-buttons.mjs`.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AppButton, AppIconButton } from '../../src/ui/components/AppButton'
import { accentCta } from '../../src/lib/tokens'

const here = dirname(fileURLToPath(import.meta.url))
const leer = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')
const sinComentarios = (texto: string) =>
  texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const leerCodigo = (rel: string) => sinComentarios(leer(rel))

const css = leer('src/index.css').replace(/\/\*[\s\S]*?\*\//g, '')

// ─── Lectura de reglas ──────────────────────────────────────────────────────

interface Regla { selectores: string[]; cuerpo: string }

/** Todas las reglas de la hoja, también las de adentro de un `@media`. */
const REGLAS: Regla[] = [...css.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)]
  .map(m => ({ selectores: m[1].split(',').map(s => s.trim()).filter(Boolean), cuerpo: m[2] }))

/** Las reglas cuya lista de selectores incluye exactamente `selector`. */
const reglasDe = (selector: string) => REGLAS.filter(r => r.selectores.includes(selector))
/** Las reglas que tocan a esa clase en cualquier estado (`.x`, `.x:hover…`). */
const reglasDeLaClase = (clase: string) =>
  REGLAS.filter(r => r.selectores.some(s => new RegExp(`^\\${clase}(:|$)`).test(s)))
const declaraciones = (cuerpo: string): Record<string, string> =>
  Object.fromEntries(cuerpo.split(';').map(d => d.split(':').map(s => s.trim())).filter(d => d.length === 2))
/** Declaraciones de la PRIMERA regla (la de nivel raíz) con ese selector. */
function declaracionesDe(selector: string): Record<string, string> {
  const [regla] = reglasDe(selector)
  if (!regla) throw new Error(`no hay regla para ${selector}`)
  return declaraciones(regla.cuerpo)
}

// ─── Aritmética WCAG ────────────────────────────────────────────────────────

const AA = 4.5
type RGB = [number, number, number]
const hex = (v: string): RGB => {
  const n = v.trim().replace('#', '')
  return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16)) as RGB
}
const luminancia = ([r, g, b]: RGB) => {
  const [R, G, B] = [r, g, b].map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * R + 0.7152 * G + 0.0722 * B
}
const contraste = (a: RGB, b: RGB) => {
  const [alto, bajo] = [luminancia(a), luminancia(b)].sort((x, y) => y - x)
  return (alto + 0.05) / (bajo + 0.05)
}
/** `rgba(r, g, b, a)` compuesto sobre un fondo opaco. */
const sobre = (rgba: string, fondo: RGB): RGB => {
  const [r, g, b, a] = (rgba.match(/[\d.]+/g) ?? []).map(Number)
  return [r, g, b].map((c, i) => c * a + fondo[i] * (1 - a)) as RGB
}

const OSCURO = css.slice(0, css.indexOf('[data-theme="light"] {'))
const CLARO = css.slice(css.indexOf('[data-theme="light"] {'), css.indexOf('*, *::before, *::after { box-sizing'))
const token = (tema: string, nombre: string) => {
  const m = new RegExp(`${nombre}:\\s*([^;]+);`).exec(tema)
  if (!m) throw new Error(`token ${nombre} no definido`)
  return m[1].trim()
}
/** Tokens que se definen una sola vez y valen en los dos temas. */
const invariante = (nombre: string) => {
  const hallados = [...css.matchAll(new RegExp(`${nombre}:\\s*([^;]+);`, 'g'))].map(m => m[1].trim())
  if (hallados.length !== 1) throw new Error(`${nombre}: se esperaba una definición y hay ${hallados.length}`)
  return hallados[0]
}
const TEMAS = [['oscuro', OSCURO], ['claro', CLARO]] as const

/** Las variantes que el contrato nombra, con sus alias. */
const DEL_CONTRATO = ['.btn-primary', '.btn-indigo', '.btn-fill-indigo', '.btn-secondary', '.btn-outline', '.btn-ghost', '.btn-danger', '.btn-success']

// ═══════════════════════════════════════════════════════════════════════════
describe('BUTTON-SYSTEM-1A · los botones no llevan gradientes', () => {
  it('`.btn-primary` no contiene un gradiente en ningún estado', () => {
    const reglas = reglasDeLaClase('.btn-primary')
    expect(reglas.length).toBeGreaterThanOrEqual(3)
    for (const r of reglas) expect(r.cuerpo, r.selectores.join(', ')).not.toMatch(/gradient/i)
  })

  it('`.btn-fill-indigo` (AppButton `indigo`) no contiene un gradiente en ningún estado', () => {
    const reglas = reglasDeLaClase('.btn-fill-indigo')
    expect(reglas.length).toBeGreaterThanOrEqual(3)
    for (const r of reglas) expect(r.cuerpo, r.selectores.join(', ')).not.toMatch(/gradient/i)
  })

  it.each(DEL_CONTRATO)('%s: ninguna de sus reglas pinta un gradiente', (clase) => {
    const reglas = reglasDeLaClase(clase)
    expect(reglas.length, `${clase} no tiene reglas`).toBeGreaterThan(0)
    for (const r of reglas) expect(r.cuerpo, r.selectores.join(', ')).not.toMatch(/gradient/i)
  })

  it('el segundo gradiente de 1E se retiró: ni el token ni la variante `-aa`', () => {
    expect(css).not.toMatch(/--gradient-primary-aa/)
    expect(css).not.toMatch(/\.btn-primary-aa\b[^{}]*\{|\.btn-indigo-aa\b[^{}]*\{|\.btn-danger-aa\b[^{}]*\{/)
    // El CTA en línea (estilos `style`) usa el mismo sólido que `.btn-primary`.
    expect(accentCta.background).toBe('var(--indigo-600)')
    expect(leer('src/lib/tokens.ts')).not.toMatch(/linear-gradient\(/)
  })

  it('`--gradient-primary` NO se tocó: sigue para superficies que no son botones', () => {
    expect(css.match(/--gradient-primary:\s*([^;]+);/g)).toEqual([
      '--gradient-primary:   linear-gradient(135deg, #6366f1 0%, #06b6d4 100%);',
      '--gradient-primary:   linear-gradient(135deg, #4f46e5 0%, #0891b2 100%);',
    ])
    // Sólo lo usan reglas que no son de un `.btn`.
    const usos = REGLAS.filter(r => /var\(--gradient-primary(-hover)?\)/.test(r.cuerpo))
    expect(usos.length).toBeGreaterThan(0)
    for (const r of usos) expect(r.selectores.join(', ')).not.toMatch(/\.btn/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BUTTON-SYSTEM-1A · primary: índigo sólido, sin resplandor', () => {
  const REPOSO = { color: 'var(--text-on-accent)', background: 'var(--indigo-600)', 'border-color': 'transparent', 'box-shadow': 'none' }
  const HOVER = { color: 'var(--text-on-accent)', background: 'var(--indigo-700)', 'border-color': 'transparent', 'box-shadow': 'none' }

  it('reposo y hover son dos sólidos de la paleta, con el texto del token', () => {
    expect(declaracionesDe('.btn-primary')).toEqual(REPOSO)
    expect(declaracionesDe('.btn-primary:hover:not(:disabled)')).toEqual(HOVER)
  })

  it('sin resplandor y sin elevación: ninguna regla de primary trae sombra ni `transform`', () => {
    for (const r of reglasDeLaClase('.btn-primary')) {
      const d = declaraciones(r.cuerpo)
      expect(d['box-shadow'] ?? 'none', r.selectores.join(', ')).toBe('none')
      expect(d.transform, r.selectores.join(', ')).toBeUndefined()
    }
  })

  it.each(['.btn-indigo', '.btn-fill-indigo'])('%s es un ALIAS de primary: la misma regla, sin diferencia visual', (alias) => {
    for (const estado of ['', ':focus-visible', ':disabled', ':hover:not(:disabled)', ':active:not(:disabled)']) {
      const [deLaPrimaria] = reglasDe(`.btn-primary${estado}`)
      expect(deLaPrimaria, `.btn-primary${estado}`).toBeDefined()
      // Misma regla (misma lista de selectores), no una copia que pueda divergir.
      expect(deLaPrimaria.selectores, `${alias}${estado}`).toContain(`${alias}${estado}`)
    }
    // Y ninguna regla propia del alias, fuera de las que comparte con primary.
    for (const r of reglasDeLaClase(alias)) expect(r.selectores.some(s => s.startsWith('.btn-primary'))).toBe(true)
  })

  it('el blanco llega a AA sobre el fondo, en reposo y en hover — y el hover es más oscuro', () => {
    const texto = hex(invariante('--text-on-accent'))
    const reposo = hex(invariante('--indigo-600'))
    const hover = hex(invariante('--indigo-700'))
    expect(contraste(texto, reposo)).toBeGreaterThanOrEqual(AA)
    expect(contraste(texto, hover)).toBeGreaterThanOrEqual(AA)
    expect(luminancia(hover)).toBeLessThan(luminancia(reposo))
    // Los dos tokens son de `:root`: el fondo no depende del tema.
    expect(CLARO).not.toMatch(/--indigo-600:|--indigo-700:/)
  })

  it('por qué no `--accent-primary`: en oscuro es #6366f1 y el blanco queda bajo 4,5', () => {
    expect(contraste(hex('#ffffff'), hex(token(OSCURO, '--accent-primary')))).toBeLessThan(AA)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Bootstrap entra por CDN y define color, fondo y borde de `.btn:hover`,
// `:focus-visible`, `:active` y `:disabled` con más especificidad que la regla
// base de cada variante. Con el gradiente eso quedaba tapado; con un fondo
// sólido se ve. Medido antes del lote: con el foco del teclado un secundario se
// pintaba gris (#5c636a) y un `danger`, rojo sobre rojo.
// ═══════════════════════════════════════════════════════════════════════════
describe('BUTTON-SYSTEM-1A · cada variante declara sus estados (no los de Bootstrap)', () => {
  it('el foco de teclado es el anillo del sistema, no el halo de Bootstrap', () => {
    expect(declaracionesDe('.btn:focus-visible')).toEqual({
      outline: '2px solid var(--accent-primary)',
      'outline-offset': '2px',
      'box-shadow': 'none',
    })
  })

  it.each([
    ['.btn-primary', ['color', 'background', 'border-color']],
    ['.btn-secondary', ['color', 'background', 'border-color']],
    ['.btn-danger', ['color', 'background', 'border-color']],
    ['.btn-success', ['color', 'background', 'border-color']],
  ] as const)('%s: el foco conserva los colores de la variante', (clase, propiedades) => {
    const reposo = declaracionesDe(clase)
    const foco = declaracionesDe(`${clase}:focus-visible`)
    for (const p of propiedades) {
      expect(foco[p], `${clase}:focus-visible no declara ${p}`).toBeDefined()
      expect(foco[p]).toBe(reposo[p])
    }
  })

  it.each(['.btn-primary', '.btn-secondary', '.btn-danger', '.btn-success'])(
    '%s: presionado pinta lo mismo que el hover (también al tocar, sin puntero encima)',
    (clase) => {
      const [hover] = reglasDe(`${clase}:hover:not(:disabled)`)
      expect(hover.selectores).toContain(`${clase}:active:not(:disabled)`)
      const d = declaraciones(hover.cuerpo)
      for (const p of ['color', 'background', 'border-color']) expect(d[p], `${clase}:hover no declara ${p}`).toBeDefined()
    },
  )

  it('un primario deshabilitado sigue siendo índigo: no toma el azul de Bootstrap', () => {
    const deshabilitado = declaracionesDe('.btn-primary:disabled')
    expect(deshabilitado.background).toBe('var(--indigo-600)')
    expect(deshabilitado['border-color']).toBe('transparent')
    expect(declaracionesDe('.btn:disabled')).toEqual({ opacity: '0.45', 'pointer-events': 'none' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BUTTON-SYSTEM-1A · secondary y danger llegan a AA en los dos temas', () => {
  it.each(TEMAS)('secondary (%s): texto sobre la página, en reposo y en hover', (_tema, vars) => {
    expect(declaracionesDe('.btn-secondary')).toEqual({
      color: 'var(--text-secondary)', background: 'transparent', 'border-color': 'var(--border-strong)',
    })
    const pagina = hex(token(vars, '--bg-primary'))
    expect(contraste(hex(token(vars, '--text-secondary')), pagina)).toBeGreaterThanOrEqual(AA)
    expect(contraste(hex(token(vars, '--text-primary')), sobre(token(vars, '--bg-hover'), pagina))).toBeGreaterThanOrEqual(AA)
  })

  it.each(TEMAS)('danger (%s): rojo semántico suave, legible en reposo y en hover', (_tema, vars) => {
    expect(declaracionesDe('.btn-danger').color).toBe('var(--order-badge-pending-fg)')
    expect(declaracionesDe('.btn-danger:hover:not(:disabled)').color).toBe('var(--order-badge-pending-fg)')
    const pagina = hex(token(vars, '--bg-primary'))
    const texto = hex(token(vars, '--order-badge-pending-fg'))
    expect(contraste(texto, sobre(token(vars, '--error-subtle'), pagina))).toBeGreaterThanOrEqual(AA)
    expect(contraste(texto, sobre(token(vars, '--error-light'), pagina))).toBeGreaterThanOrEqual(AA)
  })

  it('danger no es primary: fondo suave y otro color, sin resplandor', () => {
    const danger = declaracionesDe('.btn-danger')
    expect(danger.background).toBe('var(--error-subtle)')
    expect(danger.background).not.toBe(declaracionesDe('.btn-primary').background)
    for (const r of reglasDeLaClase('.btn-danger')) expect(declaraciones(r.cuerpo)['box-shadow']).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BUTTON-SYSTEM-1A · acción de página: un tamaño, en todas las pantallas', () => {
  it('`.btn-page-action`: 44px, 16px de padding, 8px de espacio, 14px / 600, ícono de 16px', () => {
    expect(declaracionesDe('.btn-page-action')).toEqual({
      'min-height': '44px',
      padding: '0.5rem 1rem',
      gap: '0.5rem',
      'font-size': '0.875rem',
      'font-weight': '600',
      'line-height': '1.25',
      'border-radius': 'var(--radius-md)',
    })
    expect(declaracionesDe('.btn-page-action svg')).toEqual({ width: '1rem', height: '1rem' })
  })

  it('no fija el ancho: lo da el texto', () => {
    const d = declaracionesDe('.btn-page-action')
    for (const p of ['width', 'min-width', 'max-width', 'flex', 'flex-basis']) expect(d[p], p).toBeUndefined()
  })

  it('gana sobre el ícono de `.btn` por orden: va después de `.btn svg`', () => {
    expect(css.indexOf('\n.btn-page-action svg {')).toBeGreaterThan(css.indexOf('\n.btn svg {'))
    expect(css.indexOf('\n.btn-page-action {')).toBeGreaterThan(css.indexOf('\n.btn-sm '))
  })

  it('los tamaños compactos NO se tocaron: la uniformidad es por categoría', () => {
    expect(css).toContain('.btn-xs  { padding: 0.2rem 0.5rem;  font-size: 0.75rem; border-radius: var(--radius-sm); }')
    expect(css).toContain('.btn-sm  { padding: 0.35rem 0.75rem; font-size: 0.8125rem; border-radius: var(--radius-sm); }')
    // Ninguna regla global le impone 44px a todo `.btn`.
    for (const r of reglasDe('.btn')) expect(declaraciones(r.cuerpo)['min-height']).toBeUndefined()
    expect(declaracionesDe('.btn-sm')['min-height']).toBeUndefined()
  })

  it('`AppButton size="page"` es esa clase, y sólo esa', () => {
    render(
      <>
        <AppButton variant="primary" size="page">Página</AppButton>
        <AppButton variant="primary">Normal</AppButton>
        <AppButton variant="secondary" size="sm">Compacto</AppButton>
        <AppIconButton icon={<svg />} label="Ícono" />
      </>,
    )
    const clases = (nombre: string) => [...screen.getByRole('button', { name: nombre }).classList]
    expect(clases('Página')).toEqual(['btn', 'btn-primary', 'btn-page-action'])
    expect(clases('Normal')).toEqual(['btn', 'btn-primary'])
    expect(clases('Compacto')).toEqual(['btn', 'btn-secondary', 'btn-sm'])
    // El botón de ícono sigue siendo compacto por defecto.
    expect(clases('Ícono')).toEqual(['btn', 'btn-ghost', 'btn-sm', 'btn-icon'])
  })

  it('`AppButton variant="indigo"` sigue existiendo como alias: misma clase, misma regla que primary', () => {
    render(<AppButton variant="indigo">Alias</AppButton>)
    expect([...screen.getByRole('button', { name: 'Alias' }).classList]).toEqual(['btn', 'btn-fill-indigo'])
    expect(reglasDe('.btn-primary')[0].selectores).toContain('.btn-fill-indigo')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Las acciones que el lote llevó al contrato. Cada una se busca por algo que la
// identifica (su `data-testid` o su rótulo) y se le exige la variante y el
// tamaño — no un snapshot de la pantalla.
// ═══════════════════════════════════════════════════════════════════════════

/** La etiqueta de apertura del elemento JSX que contiene `aguja`. */
function aperturaCon(rel: string, aguja: string): string {
  const fuente = leerCodigo(rel)
  const i = fuente.indexOf(aguja)
  if (i < 0) throw new Error(`${rel}: no aparece «${aguja}»`)
  // Hacia atrás desde la aguja: la primera etiqueta cuya apertura la abarca. Lo
  // que va entre llaves (`onClick={() => …}`, `leftIcon={<Icono />}`) no cierra
  // la etiqueta.
  for (let inicio = fuente.lastIndexOf('<', i); inicio >= 0; inicio = fuente.lastIndexOf('<', inicio - 1)) {
    if (!/[A-Za-z]/.test(fuente[inicio + 1] ?? '')) continue
    let profundidad = 0
    for (let j = inicio; j < fuente.length; j += 1) {
      const c = fuente[j]
      if (c === '{') profundidad += 1
      else if (c === '}') profundidad -= 1
      else if (c === '>' && profundidad === 0) {
        if (j >= i) return fuente.slice(inicio, j + 1)
        break
      }
    }
  }
  throw new Error(`${rel}: ninguna etiqueta abarca «${aguja}»`)
}
const claseDe = (apertura: string) => (/className="([^"]*)"/.exec(apertura)?.[1] ?? '').split(/\s+/).filter(Boolean)

describe('BUTTON-SYSTEM-1A · las acciones de página migradas', () => {
  /** [nombre, archivo, aguja dentro de la etiqueta de apertura] — botones y enlaces con clases `.btn`. */
  const DE_CLASE: [string, string, string][] = [
    ['Órdenes · «Nueva Orden»', 'src/pages/Orders.tsx', 'data-testid="orders-new-button"'],
    ['Clientes · «Nuevo Cliente»', 'src/pages/Customers.tsx', 'data-testid="customers-new-button"'],
    ['Comprobantes · «Nuevo Comprobante»', 'src/pages/Comprobantes.tsx', 'data-testid="comprobantes-new-button"'],
    ['Garantías · «Nueva garantía»', 'src/pages/Warranties.tsx', 'onClick={openCreate} className="btn btn-primary'],
    ['Ofertas · «Nueva oferta»', 'src/pages/Offers.tsx', 'className="btn btn-primary btn-page-action" onClick={() => { setEditing(null)'],
  ]
  it.each(DE_CLASE)('%s: primary + acción de página, sin tamaño compacto ni elevación propia', (_nombre, rel, aguja) => {
    const clases = claseDe(aperturaCon(rel, aguja))
    expect(clases).toEqual(['btn', 'btn-primary', 'btn-page-action'])
  })

  /** Acciones escritas con `AppButton`. */
  const DE_APPBUTTON: [string, string, string, string][] = [
    ['Inicio · «Nueva Orden»', 'src/pages/Dashboard.tsx', "navigate('/orders/new')", 'primary'],
    ['Inicio · «Nuevo Comprobante»', 'src/pages/Dashboard.tsx', "navigate('/comprobantes'", 'secondary'],
    ['Inicio · «Gestionar Caja»', 'src/pages/Dashboard.tsx', "navigate('/caja')", 'secondary'],
    ['Inicio · «Registrar gasto»', 'src/pages/Dashboard.tsx', "navigate('/expenses')", 'danger'],
    ['Inicio · «Nueva tarea»', 'src/components/tasks/DashboardTasks.tsx', 'onClick={openCreate}', 'primary'],
    ['Tareas · «Nueva tarea»', 'src/pages/Tasks.tsx', 'onClick={() => setShowCreate(true)}', 'primary'],
  ]
  it.each(DE_APPBUTTON)('%s: `AppButton` con `size="page"` y variante %s', (_nombre, rel, aguja, variante) => {
    const apertura = aperturaCon(rel, aguja)
    expect(apertura).toMatch(/^<AppButton\b/)
    expect(apertura).toMatch(/\bsize="page"/)
    expect(apertura).toMatch(new RegExp(`\\bvariant="${variante}"`))
    // Sin clases que le cambien el color o el tamaño por su cuenta.
    expect(claseDe(apertura).filter(c => /^btn-/.test(c))).toEqual([])
  })

  it('Inicio: las cuatro acciones comparten tamaño y hay UNA sola primaria', () => {
    const fuente = leerCodigo('src/pages/Dashboard.tsx')
    const acciones = [...fuente.matchAll(/<AppButton\b[\s\S]*?>/g)].map(m => m[0]).filter(a => /dash-action--(primary|secondary)/.test(a))
    expect(acciones).toHaveLength(4)
    for (const a of acciones) expect(a).toMatch(/\bsize="page"/)
    expect(acciones.filter(a => /variant="primary"/.test(a))).toHaveLength(1)
    expect(fuente).not.toMatch(/variant="indigo"|btn-fill-indigo|btn-indigo/)
    // Mismo tamaño de ícono en las cuatro.
    expect([...new Set(acciones.map(a => /leftIcon=\{<\w+ size=\{(\d+)\}/.exec(a)?.[1]))]).toEqual(['16'])
  })

  it('Inicio · Tareas: «Nueva tarea» y «Ver todas» comparten el tamaño de acción', () => {
    const verTodas = aperturaCon('src/components/tasks/DashboardTasks.tsx', 'aria-label="Ver todas las tareas"')
    expect(claseDe(verTodas)).toEqual(expect.arrayContaining(['btn', 'btn-secondary', 'btn-page-action']))
    expect(claseDe(verTodas)).not.toContain('btn-sm')
    expect(aperturaCon('src/components/tasks/DashboardTasks.tsx', 'onClick={openCreate}')).toMatch(/\bsize="page"/)
    // El otro «Ver todas» de Inicio (órdenes recientes) es el mismo botón.
    const deOrdenes = aperturaCon('src/pages/Dashboard.tsx', 'aria-label="Ver todas las órdenes"')
    expect(claseDe(deOrdenes).filter(c => /^btn/.test(c))).toEqual(claseDe(verTodas).filter(c => /^btn/.test(c)))
  })

  it('«Nueva Orden» es el mismo botón en Inicio y en Órdenes: variante, tamaño e ícono', () => {
    const enInicio = aperturaCon('src/pages/Dashboard.tsx', "navigate('/orders/new')")
    expect(enInicio).toMatch(/variant="primary"/)
    expect(enInicio).toMatch(/size="page"/)
    expect(enInicio).toMatch(/leftIcon=\{<NewOrderIcon size=\{16\} \/>\}/)
    const ordenes = leerCodigo('src/pages/Orders.tsx')
    expect(claseDe(aperturaCon('src/pages/Orders.tsx', 'data-testid="orders-new-button"'))).toEqual(['btn', 'btn-primary', 'btn-page-action'])
    expect(ordenes).toMatch(/data-testid="orders-new-button"[^>]*>\s*<NewOrderIcon size=\{16\} \/>\s*Nueva Orden/)
  })

  it('«Nueva tarea» es el mismo botón en Inicio y en Tareas', () => {
    const enInicio = aperturaCon('src/components/tasks/DashboardTasks.tsx', 'onClick={openCreate}')
    const enTareas = aperturaCon('src/pages/Tasks.tsx', 'onClick={() => setShowCreate(true)}')
    for (const a of [enInicio, enTareas]) {
      expect(a).toMatch(/variant="primary"/)
      expect(a).toMatch(/size="page"/)
      expect(a).toMatch(/leftIcon=\{<\w+ size=\{16\} \/>\}/)
    }
  })

  it('un `AppButton` de página y un enlace con las clases terminan con el mismo contrato', () => {
    render(
      <>
        <AppButton variant="primary" size="page">Con AppButton</AppButton>
        <a href="/orders/new" className="btn btn-primary btn-page-action">Con enlace</a>
      </>,
    )
    expect([...screen.getByRole('link', { name: 'Con enlace' }).classList])
      .toEqual([...screen.getByRole('button', { name: 'Con AppButton' }).classList])
  })
})
