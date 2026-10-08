// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1C · C — aviso de suscripción (P1-13).
//
//   · trial: sólo con 5 días o menos (del 14 al 6 no hay aviso);
//   · cerrar lo oculta POR EL DÍA: sobrevive al remontaje (navegar / recargar) y
//     vuelve al día siguiente; por negocio y por tipo de aviso;
//   · contraste por tokens y contrato táctil (cierre 44×44) en el CSS.
//
// El reloj se fija con fechas LOCALES (`new Date(año, mes, día…)`): «el día» es
// el del usuario, así que el test no depende de la zona horaria de la máquina.
// Sin sleeps: sólo se falsea `Date`.
// ─────────────────────────────────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({
  businessId: 'biz-uno' as string | null,
  role: 'owner',
  sub: {
    subscription: null as Record<string, unknown> | null,
    isTrial: true,
    isPastDue: false,
    isActive: false,
    daysUntilTrialEnd: 5 as number | null,
    daysUntilGraceEnd: null as number | null,
    daysUntilPeriodEnd: null as number | null,
    loading: false,
  },
}))

vi.mock('../../src/hooks/useSubscription', () => ({ useSubscription: () => h.sub }))
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: h.businessId, role: h.role, isOwner: h.role === 'owner', profile: { permissions: null } }),
}))

import { SubscriptionBanner, TRIAL_BANNER_MAX_DAYS } from '../../src/components/subscription/SubscriptionBanner'
import {
  DISMISSAL_PERSISTS_FOR_THE_DAY,
  dismissForToday,
  dismissalKey,
  isDismissedToday,
  localDay,
} from '../../src/lib/subscriptionBannerDismissal'

const CERRAR = 'Cerrar aviso de suscripción'
const HOY = new Date(2026, 9, 8, 10, 30, 0)          // 8 de octubre de 2026, 10:30 local
const MAS_TARDE = new Date(2026, 9, 8, 23, 59, 59)   // el mismo día, a última hora
const MANIANA = new Date(2026, 9, 9, 0, 0, 1)        // el día siguiente, apenas empieza

function Ruta() {
  return <span data-testid="ruta">{useLocation().pathname}</span>
}
const montar = () => render(<MemoryRouter initialEntries={['/orders']}><SubscriptionBanner /><Ruta /></MemoryRouter>)
const aviso = () => screen.queryByTestId('subscription-banner')
const cerrar = () => fireEvent.click(screen.getByRole('button', { name: CERRAR }))

const trial = (dias: number | null) => Object.assign(h.sub, {
  subscription: null, isTrial: true, isPastDue: false, isActive: false,
  daysUntilTrialEnd: dias, daysUntilGraceEnd: null, daysUntilPeriodEnd: null, loading: false,
})
const pagoVencido = (gracia: number | null = 2) => Object.assign(h.sub, {
  subscription: { mp_preapproval_id: 'pre_1' }, isTrial: false, isPastDue: true, isActive: false,
  daysUntilTrialEnd: null, daysUntilGraceEnd: gracia, daysUntilPeriodEnd: null, loading: false,
})
const periodoPorVencer = (dias = 2) => Object.assign(h.sub, {
  subscription: { mp_preapproval_id: 'pre_1', access_source: 'mercado_pago' }, isTrial: false, isPastDue: false, isActive: true,
  daysUntilTrialEnd: null, daysUntilGraceEnd: null, daysUntilPeriodEnd: dias, loading: false,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(HOY)
  window.localStorage.clear()
  h.businessId = 'biz-uno'
  h.role = 'owner'
  trial(5)
})

afterEach(() => {
  vi.useRealTimers()
  window.localStorage.clear()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('trial: el aviso aparece sólo con 5 días o menos', () => {
  it('el umbral es 5', () => {
    expect(TRIAL_BANNER_MAX_DAYS).toBe(5)
  })

  it.each([14, 13, 10, 7, 6])('%i días → NO hay aviso', (dias) => {
    trial(dias)
    const { container } = montar()
    expect(aviso()).toBeNull()
    expect(container.textContent).not.toMatch(/prueba/i)
    expect(screen.queryByRole('button', { name: 'Ver planes' })).toBeNull()
  })

  it.each([5, 4, 3, 2])('%i días → aviso, con los días que quedan', (dias) => {
    trial(dias)
    montar()
    expect(aviso()).not.toBeNull()
    expect(screen.getByText(`Tu período de prueba vence en ${dias} días.`)).toBeInTheDocument()
    expect(aviso()!.getAttribute('data-banner-kind')).toBe('trial')
  })

  it('1 día → aviso en singular', () => {
    trial(1)
    montar()
    expect(screen.getByText('Tu período de prueba vence en 1 día.')).toBeInTheDocument()
  })

  it('0 días con el negocio todavía en prueba → «ha vencido», nunca «0 días»', () => {
    trial(0)
    montar()
    expect(screen.getByText('Tu período de prueba ha vencido.')).toBeInTheDocument()
    expect(aviso()!.textContent).not.toMatch(/0 días/)
    expect(aviso()!.textContent).toMatch(/Elegí un plan/)
  })

  it.each([-1, -3])('%i días (fecha pasada hace más de un día) → sin aviso', (dias) => {
    trial(dias)
    montar()
    expect(aviso()).toBeNull()
  })

  it('sin fecha de fin de prueba → sin aviso', () => {
    trial(null)
    montar()
    expect(aviso()).toBeNull()
  })

  it('mientras carga → sin aviso', () => {
    Object.assign(h.sub, { loading: true })
    montar()
    expect(aviso()).toBeNull()
  })

  it('«Ver planes» sigue llevando a Planes', () => {
    montar()
    fireEvent.click(screen.getByRole('button', { name: 'Ver planes' }))
    expect(screen.getByTestId('ruta').textContent).toBe('/subscription/plans')
  })

  it('sin la capacidad `subscription` no hay aviso, tampoco a 5 días', () => {
    h.role = 'tech'
    const { container } = montar()
    expect(container.querySelector('[data-testid="subscription-banner"]')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('cierre persistente POR DÍA', () => {
  it('cerrar lo hace desaparecer', () => {
    montar()
    expect(aviso()).not.toBeNull()
    cerrar()
    expect(aviso()).toBeNull()
    expect(screen.queryByRole('button', { name: CERRAR })).toBeNull()
  })

  it('remontar el mismo día (navegar, recargar) → sigue cerrado', () => {
    const primera = montar()
    cerrar()
    primera.unmount()

    const segunda = montar()
    expect(aviso()).toBeNull()
    segunda.unmount()

    // Hasta el último segundo del día.
    vi.setSystemTime(MAS_TARDE)
    montar()
    expect(aviso()).toBeNull()
  })

  it('al día siguiente, si la condición sigue, vuelve a aparecer', () => {
    const primera = montar()
    cerrar()
    primera.unmount()

    vi.setSystemTime(MANIANA)
    trial(4)
    montar()
    expect(aviso()).not.toBeNull()
    expect(screen.getByText('Tu período de prueba vence en 4 días.')).toBeInTheDocument()
  })

  it('no es «no mostrar más»: se puede volver a cerrar al día siguiente, y eso vale sólo por ESE día', () => {
    const primera = montar()
    cerrar()
    primera.unmount()

    vi.setSystemTime(MANIANA)
    const segunda = montar()
    cerrar()
    segunda.unmount()
    const tercera = montar()
    expect(aviso()).toBeNull()
    tercera.unmount()

    vi.setSystemTime(new Date(2026, 9, 10, 9, 0, 0))
    montar()
    expect(aviso()).not.toBeNull()
  })

  it('otro negocio NO hereda el cierre', () => {
    const primera = montar()
    cerrar()
    primera.unmount()

    h.businessId = 'biz-dos'
    const otro = montar()
    expect(aviso()).not.toBeNull()
    otro.unmount()

    // Y el primero sigue cerrado.
    h.businessId = 'biz-uno'
    montar()
    expect(aviso()).toBeNull()
  })

  it('otro TIPO de aviso no hereda el cierre', () => {
    const primera = montar()
    cerrar()
    primera.unmount()

    periodoPorVencer(2)
    montar()
    expect(aviso()!.getAttribute('data-banner-kind')).toBe('period_ending')
  })

  it('la marca: una clave por negocio + tipo + fecha local, con un `1` y nada más', () => {
    montar()
    cerrar()

    const claves = Object.keys(window.localStorage)
    expect(claves).toEqual(['techrepair:subscription-banner:dismissed:biz-uno:trial:2026-10-08'])
    expect(window.localStorage.getItem(claves[0])).toBe('1')
  })

  it('no guarda nada sensible ni estado de billing', () => {
    Object.assign(h.sub, { subscription: { mp_preapproval_id: 'pre_secreto', mp_payer_email: 'pagador@invalid.test', subscription_plan: 'pro' } })
    montar()
    cerrar()
    const guardado = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage }) + document.cookie
    expect(guardado).not.toMatch(/pre_secreto|pagador@invalid\.test|pro\b|active|trialing|approved|paid/)
  })

  it('las marcas de días anteriores se borran: no se acumulan', () => {
    const primera = montar()
    cerrar()
    primera.unmount()
    vi.setSystemTime(MANIANA)
    montar()
    cerrar()
    expect(Object.keys(window.localStorage)).toEqual(['techrepair:subscription-banner:dismissed:biz-uno:trial:2026-10-09'])
  })

  it('borrar una marca vieja no toca las de otro negocio ni otro tipo', () => {
    window.localStorage.setItem('techrepair:subscription-banner:dismissed:biz-dos:trial:2026-10-01', '1')
    window.localStorage.setItem('techrepair:subscription-banner:dismissed:biz-uno:period_ending:2026-10-01', '1')
    window.localStorage.setItem('otra-clave-de-la-app', 'x')
    montar()
    cerrar()
    expect(Object.keys(window.localStorage).sort()).toEqual([
      'otra-clave-de-la-app',
      'techrepair:subscription-banner:dismissed:biz-dos:trial:2026-10-01',
      'techrepair:subscription-banner:dismissed:biz-uno:period_ending:2026-10-01',
      'techrepair:subscription-banner:dismissed:biz-uno:trial:2026-10-08',
    ])
  })

  it('una marca de AYER no oculta el aviso de hoy', () => {
    window.localStorage.setItem('techrepair:subscription-banner:dismissed:biz-uno:trial:2026-10-07', '1')
    montar()
    expect(aviso()).not.toBeNull()
  })

  it('período por vencer: también se cierra por el día', () => {
    periodoPorVencer(2)
    const primera = montar()
    cerrar()
    primera.unmount()
    const segunda = montar()
    expect(aviso()).toBeNull()
    segunda.unmount()

    vi.setSystemTime(MANIANA)
    periodoPorVencer(1)
    montar()
    expect(aviso()).not.toBeNull()
  })

  it('pago vencido: conserva su comportamiento — el cierre dura lo que la pantalla y no se guarda', () => {
    pagoVencido(2)
    const primera = montar()
    expect(screen.getByText('Pago vencido.')).toBeInTheDocument()
    cerrar()
    expect(aviso()).toBeNull()
    expect(Object.keys(window.localStorage)).toEqual([])
    primera.unmount()

    montar()
    expect(aviso()).not.toBeNull()
    expect(DISMISSAL_PERSISTS_FOR_THE_DAY).toEqual({ trial: true, period_ending: true, past_due: false })
  })

  it('cerrar el aviso de trial no oculta después un pago vencido en la misma pantalla', () => {
    const vista = montar()
    cerrar()
    pagoVencido(3)
    vista.rerender(<MemoryRouter initialEntries={['/orders']}><SubscriptionBanner /><Ruta /></MemoryRouter>)
    expect(aviso()!.getAttribute('data-banner-kind')).toBe('past_due')
  })

  it('si el navegador no deja guardar, el cierre igual funciona en la pantalla', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    montar()
    cerrar()
    expect(aviso()).toBeNull()
    expect(setItem).toHaveBeenCalled()
  })

  it('si el navegador no deja leer, el aviso se muestra en vez de romper', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    expect(() => montar()).not.toThrow()
    expect(aviso()).not.toBeNull()
  })

  it('sin negocio (no debería pasar) el cierre es sólo de la pantalla', () => {
    h.businessId = null
    montar()
    cerrar()
    expect(aviso()).toBeNull()
    expect(Object.keys(window.localStorage)).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('helper puro del cierre', () => {
  it('`localDay` es la fecha LOCAL, con ceros a la izquierda', () => {
    expect(localDay(new Date(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05')
    expect(localDay(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31')
    // El mismo día local de punta a punta, sea cual sea su fecha en UTC.
    expect(localDay(new Date(2026, 9, 8, 0, 0, 1))).toBe(localDay(new Date(2026, 9, 8, 23, 59, 59)))
    expect(localDay(new Date(2026, 9, 8, 23, 59, 59))).not.toBe(localDay(new Date(2026, 9, 9, 0, 0, 1)))
  })

  it('la clave cambia con el negocio, el tipo y el día', () => {
    const base = dismissalKey('biz-a', 'trial', HOY)
    expect(base).toBe('techrepair:subscription-banner:dismissed:biz-a:trial:2026-10-08')
    expect(dismissalKey('biz-b', 'trial', HOY)).not.toBe(base)
    expect(dismissalKey('biz-a', 'period_ending', HOY)).not.toBe(base)
    expect(dismissalKey('biz-a', 'trial', MANIANA)).not.toBe(base)
    expect(dismissalKey('biz-a', 'trial', MAS_TARDE)).toBe(base)
  })

  it('sin almacenamiento, sin negocio o para un tipo que no persiste: no marca y no está cerrado', () => {
    expect(dismissForToday(null, 'biz-a', 'trial', HOY)).toBe(false)
    expect(isDismissedToday(null, 'biz-a', 'trial', HOY)).toBe(false)
    expect(dismissForToday(window.localStorage, null, 'trial', HOY)).toBe(false)
    expect(dismissForToday(window.localStorage, '', 'trial', HOY)).toBe(false)
    expect(dismissForToday(window.localStorage, 'biz-a', 'past_due', HOY)).toBe(false)
    expect(isDismissedToday(window.localStorage, 'biz-a', 'past_due', HOY)).toBe(false)
    expect(Object.keys(window.localStorage)).toEqual([])
  })

  it('marcar y leer: sólo ese negocio, ese tipo y ese día', () => {
    expect(dismissForToday(window.localStorage, 'biz-a', 'trial', HOY)).toBe(true)
    expect(isDismissedToday(window.localStorage, 'biz-a', 'trial', HOY)).toBe(true)
    expect(isDismissedToday(window.localStorage, 'biz-a', 'trial', MAS_TARDE)).toBe(true)
    expect(isDismissedToday(window.localStorage, 'biz-a', 'trial', MANIANA)).toBe(false)
    expect(isDismissedToday(window.localStorage, 'biz-b', 'trial', HOY)).toBe(false)
    expect(isDismissedToday(window.localStorage, 'biz-a', 'period_ending', HOY)).toBe(false)
  })

  it('un valor que no es `1` no cuenta como cerrado', () => {
    window.localStorage.setItem(dismissalKey('biz-a', 'trial', HOY), 'true')
    expect(isDismissedToday(window.localStorage, 'biz-a', 'trial', HOY)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('contraste y contrato táctil (estructura)', () => {
  const css = readFileSync('src/index.css', 'utf8')
  const fuente = readFileSync('src/components/subscription/SubscriptionBanner.tsx', 'utf8')

  /** El cuerpo de la PRIMERA regla `selector { … }` (fuera de media queries). */
  const regla = (selector: string) => {
    const i = css.indexOf(`\n${selector} {`)
    expect(i, `falta la regla ${selector}`).toBeGreaterThan(-1)
    return css.slice(i, css.indexOf('}', i))
  }
  const bloque1C = css.slice(css.indexOf('BETA-UX-1C — Mi Suscripción por estado'), css.lastIndexOf('@media print'))

  it('el cierre conserva su nombre accesible y es un <button> de verdad', () => {
    montar()
    const boton = screen.getByRole('button', { name: CERRAR })
    expect(boton.tagName).toBe('BUTTON')
    expect(boton.getAttribute('type')).toBe('button')
    expect(boton.className).toBe('sub-banner__close')
  })

  it('el cierre mide 44×44 por CSS', () => {
    const cierre = regla('.sub-banner__close')
    expect(cierre).toMatch(/width:\s*44px;\s*height:\s*44px;/)
  })

  it('en mobile la acción del aviso mide al menos 44px de alto', () => {
    const movil = bloque1C.slice(bloque1C.indexOf('@media (max-width: 640px)'))
    expect(movil).toMatch(/\.sub-banner__cta\s*\{[^}]*min-height:\s*44px/)
  })

  it('el cierre y la acción tienen foco visible', () => {
    expect(bloque1C).toMatch(/\.sub-banner__cta:focus-visible,\s*\.sub-banner__close:focus-visible\s*\{\s*outline:\s*2px solid var\(--accent-primary\)/)
  })

  it('el componente no trae colores propios: ni hex, ni rgb(), ni estilos inline', () => {
    expect(fuente).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(fuente).not.toMatch(/rgba?\(/)
    expect(fuente).not.toMatch(/style=\{/)
    // El azul que daba 2,54:1 sobre claro.
    expect(fuente).not.toContain('60a5fa')
  })

  it('el bloque de 1C del CSS usa sólo tokens de tema para los colores', () => {
    expect(bloque1C.length).toBeGreaterThan(1000)
    expect(bloque1C).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(bloque1C).not.toMatch(/rgba?\(/)
  })

  it('el TEXTO del aviso usa tokens de texto, no el color del estado', () => {
    expect(regla('.sub-banner__text')).toMatch(/color:\s*var\(--text-secondary\)/)
    expect(regla('.sub-banner__text strong')).toMatch(/color:\s*var\(--text-primary\)/)
    expect(regla('.sub-banner__cta')).toMatch(/[^-]color:\s*var\(--text-primary\)/)
    // El color del estado queda para el ícono, el borde y el fondo.
    expect(regla('.sub-banner__icon')).toMatch(/color:\s*var\(--sub-tone\)/)
  })

  it('cada tono sale de tokens que existen en los dos temas', () => {
    const tokens = [...bloque1C.matchAll(/var\((--[a-z-]+)\)/g)].map(m => m[1]).filter(t => !t.startsWith('--sub-'))
    const oscuro = css.slice(0, css.indexOf('[data-theme="light"] {'))
    const claro = css.slice(css.indexOf('[data-theme="light"] {'), css.indexOf('BASE RESET & GLOBAL'))
    for (const token of new Set(tokens)) {
      expect(oscuro, `${token} no está definido en el tema oscuro`).toContain(`${token}:`)
      // Radios y similares no cambian con el tema: alcanza con la definición base.
      if (/^--(radius|shadow)/.test(token)) continue
      expect(claro, `${token} no está redefinido en el tema claro`).toContain(`${token}:`)
    }
  })
})
