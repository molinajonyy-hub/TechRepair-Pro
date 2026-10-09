// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1E — CTAs de acento legibles: garantías estructurales.
//
// El defecto (P1-6): un CTA con fondo de acento y `color: '#fff'` EN LÍNEA. El
// barrido de tema claro de index.css remapea todo blanco en línea a
// `--text-primary`, y el CTA queda con texto casi negro sobre índigo.
//
// jsdom no aplica index.css ni pinta nada: acá NO se mide contraste. Eso vive
// en tests/e2e/m7/cta-contrast.spec.ts, sobre píxeles pintados. Acá se fija lo
// que hace que esa medida no pueda volver a caerse:
//
//   1. los tokens: qué valen, que el blanco llega a AA sobre el fondo de acento
//      y la tinta sobre los fondos claros de estado (aritmética WCAG pura);
//   2. que un `var(--…)` en línea no cae en el barrido de tema claro, y que el
//      barrido sigue siendo el mismo;
//   3. la fuente de las seis superficies del lote: ningún estilo con fondo de
//      acento vuelve a declarar blanco literal, y cada CTA identificado usa el
//      token;
//   4. los componentes que se pueden montar baratos, con el estilo que termina
//      en el DOM.
//
// El guard está acotado a las superficies de 1E: no obliga a limpiar el resto
// de los blancos en línea del repo.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'

const h = vi.hoisted(() => ({ state: null as any }))
vi.mock('../../src/lib/supabase', async () => {
  const fake = await import('./fakes/supabaseStockFake')
  h.state = h.state ?? fake.newFakeState()
  return { supabase: fake.makeSupabaseFake(h.state) }
})
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: '77777777-7777-4777-8777-777777777777', user: { id: 'u1' } }),
}))
vi.mock('../../src/services/dollarRateService', () => ({
  getCurrentDollarRate: vi.fn(async () => null),
  refreshDollarRate: vi.fn(async () => null),
}))
vi.mock('../../src/services/inventoryCostAccess', async (orig) => ({
  ...(await orig<typeof import('../../src/services/inventoryCostAccess')>()),
  fetchInventoryCosts: vi.fn(async () => ({ costs: new Map(), authorized: true })),
  hasInventoryCostAuthority: vi.fn(async () => true),
}))
vi.mock('../../src/services/currencyService', () => ({
  currencyService: { getCurrentExchangeRate: vi.fn(async () => 1000) },
}))
vi.mock('../../src/hooks/usePermissions', () => ({
  usePermissions: () => ({ can: () => true }),
}))
vi.mock('../../src/features/order-intake/service', () => ({
  deleteDeviceAccess: vi.fn(), revealDeviceAccess: vi.fn(), setDeviceAccess: vi.fn(),
}))

import { newFakeState, resetFakeState } from './fakes/supabaseStockFake'
import { accentCta } from '../../src/lib/tokens'
import { ProductFormModal } from '../../src/components/products/ProductFormModal'
import { ModalAgregarItem } from '../../src/components/order/ModalAgregarItem'
import { DeviceLockCard } from '../../src/components/order/DeviceLockCard'

const here = dirname(fileURLToPath(import.meta.url))
const leer = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')

/** Las seis superficies del lote. El guard no mira nada fuera de acá. */
const SUPERFICIES = [
  'src/pages/UsersManagement.tsx',
  'src/components/products/ProductFormModal.tsx',
  'src/pages/Inventory.tsx',
  'src/components/order/ModalAgregarItem.tsx',
  'src/pages/OrderDetail.tsx',
  'src/components/order/DeviceLockCard.tsx',
] as const

beforeEach(() => {
  if (!h.state) h.state = newFakeState()
  resetFakeState(h.state)
  localStorage.clear()
})

// ─── Aritmética WCAG ────────────────────────────────────────────────────────

const AA = 4.5

function luminancia(hex: string): number {
  const n = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contraste = (a: string, b: string) => {
  const [alto, bajo] = [luminancia(a), luminancia(b)].sort((x, y) => y - x)
  return (alto + 0.05) / (bajo + 0.05)
}
const hexes = (valor: string) => valor.match(/#[0-9a-f]{6}\b/gi) ?? []

// ─── index.css ──────────────────────────────────────────────────────────────

const css = leer('src/index.css').replace(/\/\*[\s\S]*?\*\//g, '')

/** Valor de un token dentro del bloque `:root { … }` propio (el invariante de tema). */
function tokenInvariante(nombre: string): string | null {
  const bloque = /(^|\n):root\s*\{([^}]*)\}/.exec(css)
  return bloque ? new RegExp(`${nombre}:\\s*([^;]+);`).exec(bloque[2])?.[1].trim() ?? null : null
}

/** Los patrones `[style*="color: rgb(…)"]` que el tema claro remapea. */
function patronesDelBarrido(): { patrones: string[]; destino: string }[] {
  const reglas: { patrones: string[]; destino: string }[] = []
  const APERTURA = '[data-theme="light"] :is('
  for (let inicio = css.indexOf(APERTURA); inicio >= 0; inicio = css.indexOf(APERTURA, inicio + 1)) {
    const llave = css.indexOf('{', inicio)
    const selector = css.slice(inicio, llave)
    const cuerpo = css.slice(llave + 1, css.indexOf('}', llave))
    // Sólo los que empiezan por `color:`; `background-color:` es otra regla.
    const patrones = [...selector.matchAll(/\[style\*="(color: rgb\([^"]+)"\]/g)].map(x => x[1])
    const destino = /(?:^|;)\s*color:\s*([^;]+);/.exec(cuerpo)?.[1].trim()
    if (patrones.length && destino) reglas.push({ patrones, destino })
  }
  return reglas
}

// ─── Fuente (AST) ───────────────────────────────────────────────────────────

type Estilo = Map<string, string>

function parsear(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, leer(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function constanteDeEstilo(sf: ts.SourceFile, nombre: string): ts.ObjectLiteralExpression | null {
  let hallada: ts.ObjectLiteralExpression | null = null
  const visitar = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === nombre
      && n.initializer && ts.isObjectLiteralExpression(n.initializer)) hallada = n.initializer
    ts.forEachChild(n, visitar)
  }
  visitar(sf)
  return hallada
}

/** Propiedades de un literal de objeto. Un `...constante` del mismo archivo se resuelve. */
function propiedades(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): Estilo {
  const out: Estilo = new Map()
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression)) {
      const base = constanteDeEstilo(sf, p.expression.text)
      if (base) for (const [k, v] of propiedades(base, sf)) out.set(k, v)
    } else if (ts.isPropertyAssignment(p)) {
      out.set(p.name.getText(sf).replace(/^['"]|['"]$/g, ''), p.initializer.getText(sf))
    }
  }
  return out
}

/** Todo literal de objeto del archivo, con su línea. */
function literales(rel: string): { estilo: Estilo; linea: number }[] {
  const sf = parsear(rel)
  const out: { estilo: Estilo; linea: number }[] = []
  const visitar = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      out.push({ estilo: propiedades(n, sf), linea: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 })
    }
    ts.forEachChild(n, visitar)
  }
  visitar(sf)
  return out
}

/** Los atributos del elemento más chico de esa etiqueta cuya fuente contiene `aguja`. */
function atributosDe(sf: ts.SourceFile, rel: string, aguja: string, etiqueta: string): ts.JsxAttributes {
  let mejor: ts.JsxElement | ts.JsxSelfClosingElement | null = null
  let largo = Infinity
  const visitar = (n: ts.Node) => {
    const esLaEtiqueta = (ts.isJsxElement(n) && n.openingElement.tagName.getText(sf) === etiqueta)
      || (ts.isJsxSelfClosingElement(n) && n.tagName.getText(sf) === etiqueta)
    if (esLaEtiqueta) {
      const texto = n.getText(sf)
      if (texto.includes(aguja) && texto.length < largo) { mejor = n as ts.JsxElement | ts.JsxSelfClosingElement; largo = texto.length }
    }
    ts.forEachChild(n, visitar)
  }
  visitar(sf)
  const hallado = mejor as ts.JsxElement | ts.JsxSelfClosingElement | null
  if (!hallado) throw new Error(`${rel}: no hay <${etiqueta}> que contenga «${aguja}»`)
  return ts.isJsxElement(hallado) ? hallado.openingElement.attributes : hallado.attributes
}

/** Las clases (`className="…"`) de ese elemento. */
function clasesDe(rel: string, aguja: string, etiqueta = 'button'): string[] {
  const sf = parsear(rel)
  for (const a of atributosDe(sf, rel, aguja, etiqueta).properties) {
    if (ts.isJsxAttribute(a) && a.name.getText(sf) === 'className' && a.initializer && ts.isStringLiteral(a.initializer)) {
      return a.initializer.text.split(/\s+/).filter(Boolean)
    }
  }
  throw new Error(`${rel}: el <${etiqueta}> de «${aguja}» no tiene un className literal`)
}

/** El `style` del elemento más chico de esa etiqueta cuya fuente contiene `aguja`. */
function estiloDe(rel: string, aguja: string, etiqueta = 'button'): Estilo {
  const sf = parsear(rel)
  const atributos = atributosDe(sf, rel, aguja, etiqueta)
  for (const a of atributos.properties) {
    if (!ts.isJsxAttribute(a) || a.name.getText(sf) !== 'style') continue
    const expr = a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined
    if (expr && ts.isObjectLiteralExpression(expr)) return propiedades(expr, sf)
    if (expr && ts.isIdentifier(expr)) {
      const base = constanteDeEstilo(sf, expr.text)
      if (base) return propiedades(base, sf)
    }
  }
  throw new Error(`${rel}: el <${etiqueta}> de «${aguja}» no tiene un style legible`)
}

/** Un fondo de acento o de estado sólido: donde el color de texto importa. */
const FONDO_DE_ACENTO = /linear-gradient|accentCta\.(background|solid)|#(6366f1|4f46e5|8b5cf6|7c3aed|4338ca|0f766e|10b981|22c55e|f59e0b|ef4444|06b6d4|0891b2)\b/i
const BLANCO_LITERAL = /(['"`])(#fff|#ffffff|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))\1/i
const fondoDe = (e: Estilo) => e.get('background') ?? e.get('backgroundColor') ?? ''

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1E · tokens', () => {
  it('`accentCta` apunta a los tokens de texto, no a un color literal', () => {
    expect(accentCta.text).toBe('var(--text-on-accent)')
    expect(accentCta.textOnBright).toBe('var(--text-on-bright)')
  })

  it('los dos tokens de texto son invariantes de tema: un valor, un solo lugar', () => {
    expect(tokenInvariante('--text-on-accent')).toBe('#ffffff')
    expect(tokenInvariante('--text-on-bright')).toBe('#0f172a')
    // Ni el bloque oscuro ni el claro los redefinen.
    expect(css.match(/--text-on-accent\s*:/g)).toHaveLength(1)
    expect(css.match(/--text-on-bright\s*:/g)).toHaveLength(1)
  })

  it('el gradiente de acento tiene UNA fuente: el token de index.css', () => {
    // `accentCta.background` (CTAs en línea) y `.btn-primary-aa` (botones de
    // clase) leen el mismo token: no pueden divergir.
    expect(accentCta.background).toBe('var(--gradient-primary-aa)')
    expect(tokenInvariante('--gradient-primary-aa')).toBe('linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)')
    expect(css.match(/--gradient-primary-aa\s*:/g)).toHaveLength(1)
    expect(css.match(/--gradient-primary-aa-hover\s*:/g)).toHaveLength(1)
    // Y el gradiente no está escrito otra vez en JS.
    expect(leer('src/lib/tokens.ts')).not.toMatch(/linear-gradient\(/)
  })

  it('el blanco llega a AA en TODOS los puntos del fondo de acento, en reposo y en hover', () => {
    for (const token of ['--gradient-primary-aa', '--gradient-primary-aa-hover']) {
      const paradas = hexes(tokenInvariante(token) ?? '')
      expect(paradas.length, `${token} declara sus paradas`).toBeGreaterThanOrEqual(2)
      for (const parada of paradas) {
        expect(contraste('#ffffff', parada), `blanco sobre ${parada} (${token})`).toBeGreaterThanOrEqual(AA)
      }
    }
    expect(contraste('#ffffff', accentCta.solid)).toBeGreaterThanOrEqual(AA)
  })

  it('el gradiente legacy no llegaba: por eso el fondo no puede volver a ser ése', () => {
    // #6366f1 → #8b5cf6: 4,47:1 y 4,23:1. Ningún punto intermedio supera al mejor extremo.
    expect(contraste('#ffffff', '#6366f1')).toBeLessThan(AA)
    expect(contraste('#ffffff', '#8b5cf6')).toBeLessThan(AA)
    expect(tokenInvariante('--gradient-primary-aa')).not.toMatch(/#6366f1|#8b5cf6/i)
    expect(accentCta.solid).not.toMatch(/#6366f1/i)
  })

  it('la tinta llega a AA sobre los fondos claros de estado, donde el blanco no', () => {
    const tinta = tokenInvariante('--text-on-bright')!
    for (const fondo of ['#f59e0b', '#ef4444', '#10b981']) {
      expect(contraste(tinta, fondo), `tinta sobre ${fondo}`).toBeGreaterThanOrEqual(AA)
      expect(contraste('#ffffff', fondo), `blanco sobre ${fondo}`).toBeLessThan(AA)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1E · el barrido de tema claro', () => {
  const reglas = patronesDelBarrido()
  const todos = reglas.flatMap(r => r.patrones)
  const cae = (el: HTMLElement) => todos.some(p => (el.getAttribute('style') || '').includes(p))

  it('sigue siendo el mismo: no se relajó para arreglar los CTAs', () => {
    const blanco = reglas.find(r => r.patrones.includes('color: rgb(255, 255, 255)'))
    expect(blanco, 'la regla que remapea el blanco en línea').toBeDefined()
    expect(blanco!.destino).toBe('var(--text-primary) !important')
    expect(blanco!.patrones).toEqual([
      'color: rgb(248, 250, 252)', 'color: rgb(241, 245, 249)', 'color: rgb(240, 244, 255)',
      'color: rgb(226, 232, 240)', 'color: rgb(229, 231, 235)', 'color: rgb(255, 255, 255)',
    ])
    // Y nadie fuerza el blanco por encima del barrido.
    expect(css).not.toMatch(/color:\s*(#fff|#ffffff|white)\s*!important/i)
  })

  it('un blanco literal en línea cae en el barrido; los tokens no', () => {
    const literal = document.createElement('button')
    literal.style.color = '#fff'
    expect(cae(literal)).toBe(true)

    for (const valor of [accentCta.text, accentCta.textOnBright, 'var(--text-primary)']) {
      const conToken = document.createElement('button')
      conToken.style.color = valor
      // jsdom conserva el `var(…)`: si lo descartara, este test pasaría vacío.
      expect(conToken.style.color).toBe(valor)
      expect(cae(conToken), `${valor} no debe caer en el barrido`).toBe(false)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1E · la fuente de las seis superficies', () => {
  it.each(SUPERFICIES)('%s: ningún estilo con fondo de acento declara blanco literal', (rel) => {
    const infractores = literales(rel)
      .filter(({ estilo }) => FONDO_DE_ACENTO.test(fondoDe(estilo)) && BLANCO_LITERAL.test(estilo.get('color') ?? ''))
      .map(({ estilo, linea }) => `${rel}:${linea} · color: ${estilo.get('color')} sobre ${fondoDe(estilo).slice(0, 60)}`)
    expect(infractores).toEqual([])
  })

  it('el detector ve el defecto: marcaría el estilo que este lote corrigió', () => {
    const viejo: Estilo = new Map([['background', "'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)'"], ['color', "'#ffffff'"]])
    expect(FONDO_DE_ACENTO.test(fondoDe(viejo)) && BLANCO_LITERAL.test(viejo.get('color')!)).toBe(true)
    const condicional: Estilo = new Map([['backgroundColor', "tipo === value ? '#6366f1' : 'transparent'"], ['color', "tipo === value ? '#fff' : '#64748b'"]])
    expect(FONDO_DE_ACENTO.test(fondoDe(condicional)) && BLANCO_LITERAL.test(condicional.get('color')!)).toBe(true)
  })

  // ── CTAs sobre el gradiente de acento: texto y fondo salen de `accentCta` ──
  const SOBRE_GRADIENTE: [string, string, string][] = [
    ['Usuarios · «Guardar permisos»',            'src/pages/UsersManagement.tsx', "'Guardar permisos'"],
    ['Usuarios · «Enviar Invitación»',           'src/pages/UsersManagement.tsx', 'invite-submit'],
    ['Inventario · «Reintentar»',                'src/pages/Inventory.tsx', 'Reintentar'],
    ['Inventario · «Agregar Primer Producto»',   'src/pages/Inventory.tsx', 'inventory-new-product-empty'],
    ['Inventario · «Agregar Variante»',          'src/pages/Inventory.tsx', 'Agregar Variante'],
    ['Inventario · submit del modal de variantes', 'src/pages/Inventory.tsx', 'modalSubmitLabel'],
  ]
  it.each(SOBRE_GRADIENTE)('%s', (_nombre, rel, aguja) => {
    const estilo = estiloDe(rel, aguja)
    expect(estilo.get('color')).toBe('accentCta.text')
    expect(fondoDe(estilo)).toBe('accentCta.background')
  })

  it('Usuarios: los dos CTAs comparten `primaryButtonStyle` y no lo pisan', () => {
    const sf = parsear('src/pages/UsersManagement.tsx')
    const base = propiedades(constanteDeEstilo(sf, 'primaryButtonStyle')!, sf)
    expect(base.get('color')).toBe('accentCta.text')
    expect(base.get('background')).toBe('accentCta.background')
    expect(leer('src/pages/UsersManagement.tsx').match(/\.\.\.primaryButtonStyle/g)).toHaveLength(2)
  })

  // ── Producto: los cuatro CTAs conservan su gradiente y toman el token ─────
  const PRODUCTO: [string, string][] = [
    ['«Guardar producto»', 'product-form-save-button'],
    ['«Seguir editando»', 'Seguir editando'],
    ['«Restaurar borrador»', 'Restaurar borrador'],
    ['«Cerrar» del error', 'this.props.onClose()'],
  ]
  it.each(PRODUCTO)('Producto · %s', (_nombre, aguja) => {
    const estilo = estiloDe('src/components/products/ProductFormModal.tsx', aguja)
    expect(estilo.get('color')).toBe('accentCta.text')
    // Sobre este gradiente el blanco ya llegaba a AA bajo el texto (medido en el
    // navegador): no se tocó. Su punto más claro es el índigo de la esquina.
    const paradas = hexes(fondoDe(estilo))
    expect(paradas).toEqual(['#6366f1', '#4f46e5'])
  })

  it('Notas de la orden: sin guardar es un CTA de acento; «Guardado» no cambia', () => {
    const estilo = estiloDe('src/pages/OrderDetail.tsx', 'order-notes-save')
    expect(estilo.get('color')).toBe("notesSaved ? '#10b981' : accentCta.text")
    expect(fondoDe(estilo).replace(/\s+/g, ' ')).toBe("notesSaved ? 'rgba(16,185,129,0.15)' : accentCta.background")
  })

  it('Agregar ítem: el CTA usa el token sobre el acento y el texto del tema mientras envía', () => {
    const estilo = estiloDe('src/components/order/ModalAgregarItem.tsx', '`Agregar ${')
    // Enviando, el fondo es gris y el tema claro lo vuelve una superficie clara:
    // con el token blanco ahí el texto desaparecería.
    expect(estilo.get('color')).toBe("isSubmitting ? 'var(--text-primary)' : accentCta.text")
    expect(fondoDe(estilo)).toBe("isSubmitting ? '#374151' : accentCta.background")
  })

  it('Agregar ítem: los selectores activos (tipo y moneda)', () => {
    const tipo = estiloDe('src/components/order/ModalAgregarItem.tsx', 'setTipo(value)')
    expect(tipo.get('color')).toBe("tipo === value ? accentCta.text : '#64748b'")
    expect(fondoDe(tipo)).toBe("tipo === value ? accentCta.solid : 'transparent'")

    const moneda = estiloDe('src/components/order/ModalAgregarItem.tsx', 'setBaseCurrency(cur)')
    expect(moneda.get('color')).toBe("baseCurrency === cur ? (cur === 'USD' ? accentCta.textOnBright : accentCta.text) : '#64748b'")
    expect(fondoDe(moneda)).toBe("baseCurrency === cur ? (cur === 'USD' ? '#10b981' : accentCta.solid) : 'transparent'")
  })

  it('Inventario: los filtros de stock no llevan blanco ni activos ni inactivos', () => {
    for (const [aguja, clave] of [['Ver stock bajo', 'low'], ['Ver agotados', 'out']] as const) {
      const estilo = estiloDe('src/pages/Inventory.tsx', aguja)
      expect(estilo.get('color')).toBe(`stockStatusFilter === '${clave}' ? accentCta.textOnBright : 'var(--text-primary)'`)
    }
  })

  it('Inventario: el selector de moneda de una variante usa el token cuando está activo', () => {
    const estilo = estiloDe('src/pages/Inventory.tsx', "updateVariant(index, 'base_currency', cur)")
    expect(estilo.get('color')).toBe("(variant.base_currency || 'ARS') === cur ? accentCta.text : '#94a3b8'")
    // Sus dos fondos activos ya daban AA con blanco.
    for (const fondo of hexes(fondoDe(estilo))) expect(contraste('#ffffff', fondo)).toBeGreaterThanOrEqual(AA)
  })

  it('«Cifrado · interno» no depende del `.badge` genérico', () => {
    const fuente = leer('src/components/order/DeviceLockCard.tsx')
    expect(fuente).toMatch(/<span className="badge device-lock-badge" data-testid="device-lock-badge">Cifrado · interno<\/span>/)
    expect(fuente).not.toMatch(/<span className="badge">/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1E · `.btn-primary-aa`: el primario de las superficies del lote', () => {
  const cuerpo = (selector: string) => {
    const inicio = css.indexOf(`\n${selector} {`)
    return inicio < 0 ? null : css.slice(css.indexOf('{', inicio) + 1, css.indexOf('}', inicio))
  }
  const declaraciones = (texto: string) =>
    Object.fromEntries(texto.split(';').map(d => d.split(':').map(s => s.trim())).filter(d => d.length === 2))

  it('la variante cambia texto y fondo, y nada más', () => {
    const regla = cuerpo('.btn-primary.btn-primary-aa')
    expect(regla, 'no hay regla `.btn-primary.btn-primary-aa`').not.toBeNull()
    // Elevación, sombra, estado activo y deshabilitado siguen viniendo de `.btn-primary`.
    expect(declaraciones(regla!)).toEqual({
      color: 'var(--text-on-accent)',
      background: 'var(--gradient-primary-aa)',
    })
  })

  it('el hover se declara aparte: sin eso `.btn-primary:hover` volvería a poner el cyan', () => {
    const regla = cuerpo('.btn-primary.btn-primary-aa:hover:not(:disabled)')
    expect(regla, 'no hay regla de hover para la variante').not.toBeNull()
    expect(declaraciones(regla!)).toEqual({
      color: 'var(--text-on-accent)',
      background: 'var(--gradient-primary-aa-hover)',
    })
  })

  it('NO se tocó el `.btn-primary` global ni su gradiente', () => {
    expect(declaraciones(cuerpo('.btn-primary')!)).toEqual({
      color: '#ffffff',
      background: 'var(--gradient-primary)',
      'border-color': 'transparent',
      'box-shadow': 'var(--shadow-indigo)',
    })
    expect(declaraciones(cuerpo('.btn-primary:hover:not(:disabled)')!).background).toBe('var(--gradient-primary-hover)')
    // El gradiente de marca sigue siendo índigo → cyan en los dos temas.
    expect(css.match(/--gradient-primary:\s*([^;]+);/g)).toEqual([
      '--gradient-primary:   linear-gradient(135deg, #6366f1 0%, #06b6d4 100%);',
      '--gradient-primary:   linear-gradient(135deg, #4f46e5 0%, #0891b2 100%);',
    ])
  })

  // ── Los primarios que viven en estas superficies ───────────────────────────
  const PRIMARIOS: [string, string, string, string][] = [
    ['Usuarios · «Invitar Usuario»',                 'src/pages/UsersManagement.tsx', 'invite-open', 'button'],
    ['Inventario · «Nuevo Producto»',                'src/pages/Inventory.tsx', 'inventory-new-product-button', 'button'],
    ['Inventario · chevron del botón partido',       'src/pages/Inventory.tsx', 'inventory-new-product-chevron', 'button'],
    ['Detalle de orden · «Generar Comprobante»',     'src/pages/OrderDetail.tsx', 'Generar Comprobante', 'button'],
    ['Detalle de orden · «Ver Detalle»',             'src/pages/OrderDetail.tsx', 'Ver Detalle', 'Link'],
    ['Ítems de la orden · «Agregar ítem»',           'src/components/order/OrderItemsCard.tsx', 'Agregar ítem', 'button'],
    ['Ítems de la orden · «Agregar primer ítem»',    'src/components/order/OrderItemsCard.tsx', 'Agregar primer ítem', 'button'],
    ['Estado financiero · «Imputar crédito»',        'src/components/orders/OrderFinancialSummary.tsx', 'order-allocate-button', 'button'],
    ['Comunicación · «Enviar Notificación»',         'src/components/order/NotificationCard.tsx', 'Enviar Notificación', 'button'],
  ]
  it.each(PRIMARIOS)('%s lleva la variante además de `.btn-primary`', (_nombre, rel, aguja, etiqueta) => {
    const clases = clasesDe(rel, aguja, etiqueta)
    expect(clases).toContain('btn-primary')
    expect(clases).toContain('btn-primary-aa')
  })

  // Los archivos cuyos primarios se renderizan dentro de las superficies de 1E.
  const ARCHIVOS_DE_SUPERFICIE = [
    ...SUPERFICIES,
    'src/components/order/OrderItemsCard.tsx',
    'src/components/orders/OrderFinancialSummary.tsx',
    'src/components/order/NotificationCard.tsx',
  ]
  it.each(ARCHIVOS_DE_SUPERFICIE)('%s: ningún primario depende sólo de `.btn-primary`', (rel) => {
    const fuente = leer(rel)
    const sinVariante = [...fuente.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
      .map(m => m[1] ?? m[2])
      .filter(clases => /(^|\s)btn-primary(\s|$)/.test(clases) && !/(^|\s)btn-primary-aa(\s|$)/.test(clases))
    expect(sinVariante).toEqual([])
    // Y los del design system (`AppButton variant="primary"`) la reciben por `className`.
    const appButtons = [...fuente.matchAll(/<AppButton\b[^>]*\bvariant="primary"[^>]*>/g)].map(m => m[0])
    for (const boton of appButtons) expect(boton).toMatch(/className="[^"]*\bbtn-primary-aa\b[^"]*"/)
  })

  it('«Guardar» de Acceso del equipo: el AppButton primario termina con las dos clases', () => {
    render(<DeviceLockCard orderId="o1" accessMode="pin" />)
    fireEvent.click(screen.getByRole('button', { name: 'Configurar' }))
    const guardar = screen.getByRole('button', { name: 'Guardar' })
    expect([...guardar.classList]).toEqual(expect.arrayContaining(['btn', 'btn-primary', 'btn-primary-aa']))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1E · «Cifrado · interno» tiene superficie propia, sólo con tokens de tema', () => {
  const regla = /\.badge\.device-lock-badge\s*\{([^}]*)\}/.exec(css)

  it('la regla existe y declara texto, fondo y borde con tokens', () => {
    expect(regla, 'no hay regla `.badge.device-lock-badge`').not.toBeNull()
    const declaraciones = Object.fromEntries(regla![1].split(';').map(d => d.split(':').map(s => s.trim())).filter(d => d.length === 2))
    expect(declaraciones.color).toBe('var(--text-secondary)')
    expect(declaraciones.background).toBe('var(--bg-tertiary)')
    expect(declaraciones.border).toBe('1px solid var(--border-strong)')
    // Ningún color literal: un valor fijo sólo se vería bien en un tema.
    expect(regla![1]).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })

  it('cada token que usa está definido en el tema oscuro y en el claro', () => {
    const bloque = (selector: string) => {
      const inicio = css.indexOf(selector)
      return css.slice(inicio, css.indexOf('\n}', inicio))
    }
    const oscuro = bloque('[data-theme="dark"] {')
    const claro = bloque('[data-theme="light"] {')
    for (const token of regla![1].match(/--[\w-]+/g) ?? []) {
      expect(oscuro, `${token} en oscuro`).toMatch(new RegExp(`${token}\\s*:`))
      expect(claro, `${token} en claro`).toMatch(new RegExp(`${token}\\s*:`))
    }
  })

  it('montada, la etiqueta lleva la clase propia', () => {
    render(<DeviceLockCard orderId="o1" accessMode="pin" />)
    const etiqueta = screen.getByTestId('device-lock-badge')
    expect(etiqueta).toHaveTextContent('Cifrado · interno')
    expect([...etiqueta.classList]).toEqual(['badge', 'device-lock-badge'])
    // Sólo presentación: las acciones del acceso siguen ahí.
    expect(screen.getByRole('button', { name: 'Revelar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Configurar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Eliminar' })).toBeInTheDocument()
  })

  it('el estado y el ícono de la tarjeta declaran un color de tema', () => {
    // Sin color propio heredaban el de Bootstrap (#212529): invisibles en oscuro.
    render(<DeviceLockCard orderId="o1" accessMode="pin" />)
    const estado = screen.getByTestId('device-lock-status')
    expect(estado).toHaveTextContent('PIN configurado')
    expect(estado.style.color).toBe('var(--text-primary)')
    const icono = estado.closest('.card')!.querySelector<SVGElement>('.card-header svg')!
    expect(icono.style.color).toBe('var(--text-secondary)')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1E · el estilo que termina en el DOM', () => {
  // La regla que oscurece los textos CLAROS en línea (la del defecto). El gris de
  // una opción inactiva cae en otra, que lo lleva a `--text-secondary` a propósito.
  // (Si esa regla desapareciera, lo dice el bloque de arriba; acá no se rompe la colección.)
  const claros = patronesDelBarrido().find(r => r.patrones.includes('color: rgb(255, 255, 255)'))?.patrones ?? []
  const cae = (el: HTMLElement) => claros.some(p => (el.getAttribute('style') || '').includes(p))

  it('Producto: «Guardar producto» lleva el token y no cae en el barrido', () => {
    render(<ProductFormModal isOpen onClose={() => {}} onCreated={() => {}} registerStock />)
    const cta = screen.getByTestId('product-form-save-button')
    expect(cta).toHaveTextContent('Guardar producto')
    expect(cta.style.color).toBe('var(--text-on-accent)')
    expect(cae(cta)).toBe(false)
  })

  it('Agregar ítem: el CTA y los selectores activos llevan el token que corresponde', () => {
    render(<ModalAgregarItem isOpen orderId="o1" onClose={() => {}} onItemAdded={() => {}} />)

    const cta = screen.getByRole('button', { name: 'Agregar repuesto' })
    expect(cta.style.color).toBe('var(--text-on-accent)')
    expect(cae(cta)).toBe(false)

    // Tipo: el activo usa el token; el inactivo no es un CTA de acento.
    const repuesto = screen.getByRole('button', { name: 'Repuesto' })
    const servicio = screen.getByRole('button', { name: 'Servicio' })
    expect(repuesto.style.color).toBe('var(--text-on-accent)')
    expect(servicio.style.color).not.toBe('var(--text-on-accent)')

    // Moneda: ARS activo es de acento; USD activo es verde y lleva la tinta.
    const ars = screen.getByRole('button', { name: '$ ARS' })
    const usd = screen.getByRole('button', { name: 'USD $' })
    expect(ars.style.color).toBe('var(--text-on-accent)')
    expect(cae(ars)).toBe(false)
    fireEvent.click(usd)
    expect(usd.style.color).toBe('var(--text-on-bright)')
    expect(ars.style.color).not.toBe('var(--text-on-accent)')
    for (const el of [repuesto, usd]) expect(cae(el)).toBe(false)

    // Y el copy del CTA sigue al tipo.
    fireEvent.click(servicio)
    expect(screen.getByRole('button', { name: 'Agregar servicio' }).style.color).toBe('var(--text-on-accent)')
    expect(servicio.style.color).toBe('var(--text-on-accent)')
  })
})
