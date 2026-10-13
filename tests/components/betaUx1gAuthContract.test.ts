// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1G — contrato de la capa compartida del embudo de acceso.
//
// Sin pantallas montadas: reglas puras y estructura. Las pantallas corren en
// tests/components/betaUx1gAuthFlows.test.tsx.
//
//   D  destino después de autenticarse (src/lib/postAuthDestination.ts)
//   T  token de una invitación pegada a mano (src/lib/invitationLink.ts)
//   P  validación mientras se escribe (src/lib/passwordPolicy.ts)
//   M  textos compartidos de reenvío y de /auth/callback (src/lib/authErrors.ts)
//   E  estructura: un solo sistema visual en las cuatro pantallas pre-login
//   C  CSS: sólo tokens, estados de foco, áreas táctiles y aritmética WCAG
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  DEFAULT_POST_AUTH_PATH,
  POST_LOGIN_REDIRECT_KEY,
  clearPostLoginRedirect,
  consumePostAuthDestination,
  isInvitationDestination,
  rememberPostLoginRedirect,
} from '../../src/lib/postAuthDestination'
import { ACCEPT_INVITE_PATH, invitationPath, invitationTokenFromInput } from '../../src/lib/invitationLink'
import { stashInviteToken, peekInviteToken } from '../../src/lib/pendingInvite'
import {
  PASSWORD_CONFIRM_MESSAGE,
  PASSWORD_MATCH_MESSAGE,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_MESSAGE,
  PASSWORD_REQUIREMENT,
  validatePasswordPair,
  validateTypedPasswordPair,
} from '../../src/lib/passwordPolicy'
import {
  AUTH_CALLBACK_NO_SESSION_PATH,
  AUTH_URL_ERROR_MESSAGE,
  AUTH_URL_ERROR_TITLE,
  RESEND_MESSAGE,
} from '../../src/lib/authErrors'
import { sanitizeInternalPath } from '../../src/lib/authRedirect'

const here = dirname(fileURLToPath(import.meta.url))
const leer = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')

/**
 * Sin comentarios: los chequeos de estructura buscan CÓDIGO, no su documentación.
 * Primero las líneas `//`: un comentario de línea que cite una ruta con comodín
 * abriría un bloque falso y se tragaría el código hasta el próximo cierre.
 */
const leerCodigo = (rel: string) =>
  leer(rel)
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\*.*$/gm, '')

const TOKEN = 'b'.repeat(64)

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('D · destino después de autenticarse: una sola regla', () => {
  it('D1. sin nada pedido ni guardado → /dashboard', () => {
    expect(DEFAULT_POST_AUTH_PATH).toBe('/dashboard')
    expect(consumePostAuthDestination()).toBe('/dashboard')
    expect(consumePostAuthDestination({ requested: null })).toBe('/dashboard')
  })

  it('D2. el destino guardado por la pestaña gana, y se CONSUME', () => {
    rememberPostLoginRedirect('/orders?estado=listas')
    expect(window.sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)).toBe('/orders?estado=listas')
    expect(consumePostAuthDestination({ requested: '/customers' })).toBe('/orders?estado=listas')
    // Una segunda resolución ya no lo hereda.
    expect(window.sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)).toBeNull()
    expect(consumePostAuthDestination({ requested: '/customers' })).toBe('/customers')
  })

  it('D3. sin guardado, gana el destino pedido por la pantalla', () => {
    expect(consumePostAuthDestination({ requested: '/onboarding?plan=pro' })).toBe('/onboarding?plan=pro')
  })

  it('D4. sin destino propio, una invitación pendiente lleva a aceptarla', () => {
    stashInviteToken(TOKEN)
    expect(consumePostAuthDestination()).toBe(invitationPath(TOKEN))
    // Pedir /dashboard es no pedir nada: la invitación sigue ganando.
    expect(consumePostAuthDestination({ requested: '/dashboard' })).toBe(invitationPath(TOKEN))
    // Resolver el destino NO consume el token: lo consume aceptar.
    expect(peekInviteToken()).toBe(TOKEN)
  })

  it('D5. un destino explícito le gana a la invitación pendiente', () => {
    stashInviteToken(TOKEN)
    expect(consumePostAuthDestination({ requested: '/orders' })).toBe('/orders')
    rememberPostLoginRedirect('/customers')
    expect(consumePostAuthDestination()).toBe('/customers')
  })

  it('D6. el dominio del portal mayorista va siempre a la raíz', () => {
    rememberPostLoginRedirect('/orders')
    stashInviteToken(TOKEN)
    expect(consumePostAuthDestination({ portalHost: true, requested: '/customers' })).toBe('/')
  })

  it.each([
    '//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)',
    '/%2f%2fevil.example', '/\t/evil.example', '/ruta con espacio', '/login', '/auth/callback',
    '/verificar-email', '/logout', '', '   ',
  ])('D7. ni lo guardado ni lo pedido pueden sacar al usuario del sitio: %j', (hostil) => {
    window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, hostil)
    expect(consumePostAuthDestination({ requested: hostil })).toBe('/dashboard')
    // Lo guardado se descarta también cuando no sirve.
    expect(window.sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)).toBeNull()
  })

  it('D8. guardar y limpiar no fallan sin storage', () => {
    rememberPostLoginRedirect('/orders')
    clearPostLoginRedirect()
    expect(window.sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)).toBeNull()
  })

  it('D9. reconoce el destino de una invitación por su path, no por un substring', () => {
    expect(ACCEPT_INVITE_PATH).toBe('/accept-invite')
    expect(isInvitationDestination(invitationPath(TOKEN))).toBe(true)
    expect(isInvitationDestination('/accept-invite')).toBe(true)
    expect(isInvitationDestination('/accept-invite#x')).toBe(true)
    for (const no of ['/dashboard', '/accept-invite-otra', '/x/accept-invite', '/orders?next=/accept-invite', '', null, undefined]) {
      expect(isInvitationDestination(no), String(no)).toBe(false)
    }
  })

  it('D10. Login y AuthCallback usan ESTA regla: ninguno vuelve a leer el storage por su cuenta', () => {
    for (const rel of ['src/pages/Login.tsx', 'src/pages/AuthCallback.tsx']) {
      const src = leerCodigo(rel)
      expect(src, rel).toContain('consumePostAuthDestination(')
      expect(src, rel).not.toContain('post_login_redirect')
      expect(src, rel).not.toMatch(/sessionStorage/)
    }
    // El destino de una invitación sale de la fuente única del enlace.
    expect(leerCodigo('src/lib/postAuthDestination.ts')).toMatch(/from '\.\/invitationLink'/)
    // Y todo lo no confiable pasa por el saneador.
    expect(leerCodigo('src/lib/postAuthDestination.ts').match(/sanitizeInternalPath\(/g)?.length).toBe(2)
    expect(sanitizeInternalPath('//evil.example', '/dashboard')).toBe('/dashboard')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('T · invitación pegada a mano', () => {
  it('T1. del enlace entero del correo sale el token', () => {
    expect(invitationTokenFromInput(`https://www.techrepairpro.app/accept-invite?token=${TOKEN}`)).toBe(TOKEN)
    expect(invitationTokenFromInput(`  http://localhost:5174/accept-invite?token=${TOKEN}  `)).toBe(TOKEN)
    // Parámetro histórico.
    expect(invitationTokenFromInput(`https://www.techrepairpro.app/accept-invite?invite=${TOKEN}`)).toBe(TOKEN)
  })

  it('T2. el código suelto se acepta tal cual (sin espacios alrededor)', () => {
    expect(invitationTokenFromInput(`  ${TOKEN} `)).toBe(TOKEN)
  })

  it('T3. un enlace sin token, vacío o roto no produce nada', () => {
    for (const malo of ['', '   ', 'https://www.techrepairpro.app/accept-invite', 'https://www.techrepairpro.app/?x=1', 'http://[']) {
      expect(invitationTokenFromInput(malo), malo).toBe('')
    }
  })

  it('T4. sólo LEE el parámetro: no arma una URL ni mira el host', () => {
    const src = leerCodigo('src/lib/invitationLink.ts')
    const cuerpo = src.slice(src.indexOf('export function invitationTokenFromInput'))
    expect(cuerpo).not.toMatch(/window\.|location|fetch\(|navigate/)
    // Un host ajeno no cambia el resultado: el valor sólo viaja a la RPC.
    expect(invitationTokenFromInput(`https://otro.example/x?token=${TOKEN}`)).toBe(TOKEN)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('P · validación mientras se escribe', () => {
  it('P1. un campo vacío no es un error hasta el envío', () => {
    expect(validateTypedPasswordPair('', '')).toEqual({})
    expect(validateTypedPasswordPair('segura-123', '')).toEqual({})
    // El envío sí lo reclama (regla previa, intacta).
    expect(validatePasswordPair('segura-123', '').confirm).toBe(PASSWORD_CONFIRM_MESSAGE.missing)
  })

  it('P2. lo ya escrito se valida con la MISMA política del envío', () => {
    expect(validateTypedPasswordPair('corta', '')).toEqual({ password: PASSWORD_POLICY_MESSAGE.too_short })
    expect(validateTypedPasswordPair('ñ'.repeat(37), '')).toEqual({ password: PASSWORD_POLICY_MESSAGE.too_long })
    expect(validateTypedPasswordPair('        ', '')).toEqual({ password: PASSWORD_POLICY_MESSAGE.blank })
    expect(validateTypedPasswordPair('segura-123', 'segura-124')).toEqual({ confirm: PASSWORD_CONFIRM_MESSAGE.mismatch })
    expect(validateTypedPasswordPair('segura-123', 'segura-123')).toEqual({})
    for (const [p, c] of [['corta', 'corta'], ['segura-123', 'otra'], ['12345678', '12345678']] as const) {
      const alEscribir = validateTypedPasswordPair(p, c)
      const alEnviar = validatePasswordPair(p, c)
      expect(alEscribir.password, p).toBe(alEnviar.password)
      expect(alEscribir.confirm, c).toBe(alEnviar.confirm)
    }
  })

  it('P3. el requisito visible sale del mínimo canónico y no choca con el mensaje de error', () => {
    expect(PASSWORD_REQUIREMENT).toBe(`${PASSWORD_MIN_LENGTH} caracteres o más`)
    // El E2E busca el error por su texto exacto: el requisito no puede contenerlo.
    expect(PASSWORD_REQUIREMENT.toLowerCase()).not.toContain(PASSWORD_POLICY_MESSAGE.too_short.toLowerCase())
    expect(PASSWORD_CONFIRM_MESSAGE.mismatch.toLowerCase()).not.toContain(PASSWORD_MATCH_MESSAGE.toLowerCase())
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('M · textos compartidos', () => {
  it('M1. el reenvío tiene un texto por resultado, y lo usan el login y /verificar-email', () => {
    expect(Object.keys(RESEND_MESSAGE).sort()).toEqual(['error', 'rate_limited', 'sent'])
    for (const rel of ['src/pages/Login.tsx', 'src/pages/VerifyEmail.tsx']) {
      const src = leerCodigo(rel)
      expect(src, rel).toContain('RESEND_MESSAGE.')
      expect(src, rel).not.toMatch(/reenviamos el correo|varios correos en poco tiempo|No pudimos reenviar/)
    }
  })

  it('M2. /auth/callback tiene título y detalle para cada error, y un motivo para «sin sesión»', () => {
    expect(Object.keys(AUTH_URL_ERROR_TITLE).sort()).toEqual(Object.keys(AUTH_URL_ERROR_MESSAGE).sort())
    // Cancelar no es un error del sistema.
    expect(AUTH_URL_ERROR_TITLE.oauth_cancelled).not.toMatch(/error/i)
    expect(AUTH_CALLBACK_NO_SESSION_PATH).toBe('/login?motivo=sesion_no_iniciada')
    // El motivo existe en el enum cerrado del login, con el texto ya conocido.
    expect(leerCodigo('src/pages/Login.tsx')).toMatch(/sesion_no_iniciada:\s*AUTH_URL_ERROR_MESSAGE\.failed/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
const PRE_LOGIN = ['src/pages/Login.tsx', 'src/pages/ResetPassword.tsx', 'src/pages/AuthCallback.tsx', 'src/pages/AcceptInvite.tsx']
const EMBUDO = [...PRE_LOGIN, 'src/pages/VerifyEmail.tsx', 'src/pages/NoBusiness.tsx', 'src/pages/Onboarding.tsx']

describe('E · un solo sistema visual', () => {
  it('E1. las siete pantallas del embudo componen el MISMO shell', () => {
    for (const rel of EMBUDO) {
      const src = leerCodigo(rel)
      expect(src, rel).toMatch(/from '\.\.\/components\/auth\/AuthFlowShell'/)
      expect(src, rel).toMatch(/<AuthFlowShell|<AuthFlowLoading/)
    }
  })

  it('E2. las cuatro pantallas pre-login no traen estilos propios', () => {
    for (const rel of PRE_LOGIN) {
      const src = leerCodigo(rel)
      // Ni un atributo `style`, ni handlers que pinten el hover o el foco a mano.
      expect(src, rel).not.toMatch(/\bstyle=\{/)
      expect(src, rel).not.toMatch(/onMouseEnter|onMouseLeave|\.style\./)
      expect(src, rel).not.toMatch(/authCardStyles|linear-gradient|rgba?\(/)
      // Botones: los del shell. Ningún `<button className="btn …">` suelto.
      expect(src, rel).not.toMatch(/className=["'`]btn\b/)
      // Íconos: Lucide. Ni emoji ni caracteres usados como ícono.
      expect(src, rel).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    }
  })

  it('E3. el único color literal del embudo pre-login es el logo de Google', () => {
    const literales = PRE_LOGIN.flatMap(rel =>
      [...leerCodigo(rel).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => `${rel}:${m[0]}`))
    expect(literales.sort()).toEqual([
      'src/pages/Login.tsx:#34A853',
      'src/pages/Login.tsx:#4285F4',
      'src/pages/Login.tsx:#EA4335',
      'src/pages/Login.tsx:#FBBC05',
    ])
  })

  it('E4. los campos del embudo son presentacionales: no conocen auth, datos ni negocio', () => {
    const src = leerCodigo('src/components/auth/AuthFlowFields.tsx')
    expect(src).not.toMatch(/supabase|AuthContext|useAuth|usePermissions|services\/|businessId|provision|passwordPolicy|authErrors|react-router/i)
    // Reusa las clases del sistema en vez de definir un control propio.
    for (const clase of ['form-control', 'border-error', 'form-error', 'alert alert-', 'sr-only']) {
      expect(src, clase).toContain(clase)
    }
    expect(src).not.toMatch(/\bstyle=\{/)
    // `.input-group` es también una clase de Bootstrap (entra por CDN): medido,
    // le saca el radio al control y lo apila sobre el ícono y el botón del campo.
    expect(src).not.toMatch(/input-group|input-icon/)
  })

  it('E5. authCardStyles quedó en la superficie: sin controles ni gradientes de botón', () => {
    const src = leerCodigo('src/components/auth/authCardStyles.ts')
    expect(src).not.toMatch(/btn|input|tab\b|label|focusOn|blurOn|cursor/i)
    // Sólo lo importa el shell.
    for (const rel of EMBUDO) expect(leerCodigo(rel), rel).not.toContain('authCardStyles')
  })

  it('E6. cada pantalla conserva los `data-testid` que ya usaban los tests y el E2E', () => {
    const esperados: Record<string, string[]> = {
      'src/pages/Login.tsx': [
        'login-tab-register', 'login-error', 'login-error-soporte', 'login-resend-confirmation',
        'login-resend-sent', 'login-resend-limited', 'login-success', 'login-forgot-form',
        'login-forgot-email', 'login-forgot-submit', 'login-forgot-back', 'login-email',
        'login-password', 'login-confirm-password', 'login-submit', 'login-forgot-link',
        'login-link-privacidad',
      ],
      'src/pages/ResetPassword.tsx': [
        'reset-password-page', 'reset-password-checking', 'reset-password-invalid',
        'reset-password-request-new', 'reset-password-back-login', 'reset-password-soporte',
        'reset-password-done', 'reset-password-continue', 'reset-password-error',
        'reset-password-new', 'reset-password-toggle-new', 'reset-password-new-error',
        'reset-password-confirm', 'reset-password-toggle-confirm', 'reset-password-confirm-error',
        'reset-password-submit',
      ],
    }
    for (const [rel, ids] of Object.entries(esperados)) {
      const src = leer(rel)
      for (const id of ids) expect(src, `${rel} · ${id}`).toMatch(new RegExp(`["']${id}["']`))
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Aritmética WCAG 2.x. Los colores se leen de los tokens de index.css.
function luminancia([r, g, b]: number[]): number {
  const canal = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b)
}
const contraste = (a: number[], b: number[]) => {
  const [l1, l2] = [luminancia(a), luminancia(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}
const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
/** Color `[r,g,b]` con opacidad `a`, pintado sobre un fondo opaco. */
const sobre = (color: number[], a: number, fondo: number[]) => color.map((c, i) => c * a + fondo[i] * (1 - a))

describe('C · CSS del embudo', () => {
  const css = leer('src/css/auth-flow.css')
  const sinComentarios = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const index = leer('src/index.css')

  /** Valor de un token en el bloque oscuro (el primero) y en el claro (el segundo). */
  const token = (nombre: string): { oscuro: string; claro: string } => {
    const valores = [...index.matchAll(new RegExp(`\\n\\s*${nombre}:\\s*([^;]+);`, 'g'))].map(m => m[1].trim())
    return { oscuro: valores[0], claro: valores[1] ?? valores[0] }
  }

  it('C1. no define colores propios: sólo tokens', () => {
    expect(sinComentarios).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(sinComentarios).not.toMatch(/rgba?\(|hsla?\(/)
    expect(sinComentarios).not.toMatch(/linear-gradient|radial-gradient/)
  })

  it('C2. todo queda bajo .auth-flow (sin reglas globales nuevas)', () => {
    const selectores = [...sinComentarios.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map(m => m[2].trim()).filter(Boolean)
    for (const s of selectores) {
      for (const parte of s.split(',').map(p => p.trim())) {
        if (/^(from|to|\d+%)$/.test(parte)) continue
        expect(parte, parte).toMatch(/\.auth-flow\b|\.auth-flow__/)
      }
    }
  })

  it('C3. los controles nuevos tienen foco de teclado visible', () => {
    for (const clase of ['auth-flow__segment-option', 'auth-flow__inline-link', 'auth-flow__reveal']) {
      expect(sinComentarios, clase).toMatch(new RegExp(`\\.${clase}:focus-visible[^{]*\\{[^}]*outline:\\s*2px solid var\\(--accent-primary\\)`))
    }
    // El control de texto usa el foco de `.form-control`: acá no se lo apaga.
    expect(sinComentarios).not.toMatch(/\.form-control[^{]*\{[^}]*outline:\s*none/)
  })

  it('C4. áreas táctiles: el «ojo» y el selector de modo miden el mínimo del sistema', () => {
    expect(token('--mobile-touch-target').oscuro).toBe('44px')
    expect(sinComentarios).toMatch(/\.auth-flow__reveal \{[^}]*width: var\(--mobile-touch-target\)/)
    expect(sinComentarios).toMatch(/\.auth-flow__reveal \{[^}]*top: 0;[^}]*bottom: 0;/)
    expect(sinComentarios).toMatch(/\.auth-flow__segment-option \{[^}]*min-height: var\(--mobile-touch-target\)/)
    // El campo deja lugar para el botón: el texto no pasa por debajo.
    expect(sinComentarios).toMatch(/\.auth-flow__control--trailing \.form-control \{ padding-right: var\(--mobile-touch-target\); \}/)
  })

  it('C5. respeta prefers-reduced-motion también en los controles nuevos', () => {
    const bloque = sinComentarios.slice(sinComentarios.indexOf('@media (prefers-reduced-motion: reduce)'))
    for (const clase of ['.auth-flow__reveal', '.auth-flow__segment-option']) expect(bloque, clase).toContain(clase)
  })

  it('C6. la opción elegida del selector llega a AA con los colores del botón primario', () => {
    expect(sinComentarios).toMatch(/\.auth-flow__segment-option\[aria-selected="true"\] \{\s*background: var\(--indigo-600\);\s*color: var\(--text-on-accent\);/)
    const indigo = hex(token('--indigo-600').oscuro)
    const blanco = hex(token('--text-on-accent').oscuro)
    expect(contraste(blanco, indigo)).toBeGreaterThanOrEqual(4.5)
    // No depende del tema: los dos tokens viven en un bloque invariante.
    expect(index.match(/--indigo-600\s*:/g)).toHaveLength(1)
    expect(index.match(/--text-on-accent\s*:/g)).toHaveLength(1)
  })

  it('C7. el texto de una alerta usa el color primario: AA sobre su fondo en los dos temas', () => {
    // Doble clase: con una sola empata con `.alert-*` y gana la hoja que cargue última.
    expect(sinComentarios).toMatch(/\.auth-flow \.auth-flow__alert \{\s*margin: 0;\s*color: var\(--text-primary\);/)
    // Tarjeta (blanco / azul noche) + el tinte del tono más opaco (`*-subtle` ≤ 8 %).
    const tarjeta = { claro: [255, 255, 255], oscuro: [13, 26, 48] }
    const texto = { claro: hex(token('--text-primary').claro), oscuro: hex(token('--text-primary').oscuro) }
    const tintes = { claro: [[220, 38, 38], [5, 150, 105], [217, 119, 6], [2, 132, 199]], oscuro: [[248, 113, 113], [52, 211, 153], [251, 191, 36], [56, 189, 248]] }
    for (const tema of ['claro', 'oscuro'] as const) {
      for (const tinte of tintes[tema]) {
        const fondo = sobre(tinte, 0.08, tarjeta[tema])
        expect(contraste(texto[tema], fondo), `${tema} ${tinte}`).toBeGreaterThanOrEqual(7)
      }
    }
  })

  it('C8. por qué el texto NO usa el color del tono: en claro no llega a AA', () => {
    // Medido sobre el fondo real de la alerta: es el motivo de C7, no un gate.
    const tarjeta = [255, 255, 255]
    const exito = hex(token('--success').claro)
    expect(contraste(exito, sobre(exito, 0.06, tarjeta))).toBeLessThan(4.5)
  })

  it('C9. el requisito cumplido usa el verde que sí llega a AA como texto', () => {
    expect(sinComentarios).toMatch(/\.auth-flow__requirement\[data-met="true"\] \{ color: var\(--order-badge-paid-fg\); \}/)
    const verde = token('--order-badge-paid-fg')
    expect(contraste(hex(verde.claro), [255, 255, 255])).toBeGreaterThanOrEqual(4.5)
    expect(contraste(hex(verde.oscuro), [13, 26, 48])).toBeGreaterThanOrEqual(4.5)
  })

  it('C10. textos secundarios del embudo (`--text-muted`) llegan a AA en los dos temas', () => {
    const muted = token('--text-muted')
    expect(contraste(hex(muted.claro), [255, 255, 255])).toBeGreaterThanOrEqual(4.5)
    expect(contraste(hex(muted.oscuro), [13, 26, 48])).toBeGreaterThanOrEqual(4.5)
    // …y el embudo ya no usa `--text-subtle`, que no llega en ninguno.
    expect(sinComentarios).not.toContain('--text-subtle')
    const subtle = token('--text-subtle')
    expect(contraste(hex(subtle.claro), [255, 255, 255])).toBeLessThan(4.5)
  })
})
