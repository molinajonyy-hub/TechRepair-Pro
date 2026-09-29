// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2F — Entrega por correo de invitaciones, lado cliente + funciones puras.
//
// Contraparte de tests/deno/sendBusinessInvitation.test.ts (handler de la Edge).
//
//   A. enlace canónico     → una sola fuente; producción nunca usa el origen de la pestaña
//   B. plantilla           → escape, asunto saneado, roles, sin tracking ni soporte
//   C. servicio            → capa de entrega; sólo viaja lo mínimo; fallback a la RPC
//   D. UsersManagement     → enviar, fallo de entrega, reenviar, copiar, cancelar, plan
//
// El borde mockeado es `src/lib/supabase` (functions.invoke + rpc + from) y
// `src/utils/toast`. Servicio, helpers y la página corren de verdad.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const BIZ_ID = '22222222-2222-4222-8222-222222222222'
const INV_ID = '33333333-3333-4333-8333-333333333333'
const TOKEN = 'b'.repeat(64)
const CANONICO = 'https://www.techrepairpro.app'

type Respuesta = { data: unknown; error: unknown }

const estado = vi.hoisted(() => ({
  invoke: [] as { nombre: string; body: Record<string, unknown> }[],
  invokeImpl: null as null | ((body: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>),
  rpc: [] as { nombre: string; args: Record<string, unknown> }[],
  rpcImpl: {} as Record<string, () => { data: unknown; error: unknown }>,
  pendientes: [] as Record<string, unknown>[],
  toasts: [] as { mensaje: string; tipo: string }[],
  /** Orden global de llamadas al borde: `rpc:<nombre>` / `invoke:<slug>`. */
  secuencia: [] as string[],
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: async (nombre: string, opciones: { body: Record<string, unknown> }) => {
        estado.invoke.push({ nombre, body: opciones.body })
        estado.secuencia.push(`invoke:${nombre}`)
        if (estado.invokeImpl) return estado.invokeImpl(opciones.body)
        return { data: null, error: null }
      },
    },
    rpc: async (nombre: string, args: Record<string, unknown> = {}) => {
      estado.rpc.push({ nombre, args })
      estado.secuencia.push(`rpc:${nombre}`)
      const h = estado.rpcImpl[nombre]
      return h ? h() : { data: null, error: null }
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        gt: () => chain,
        order: async () => ({ data: estado.pendientes, error: null }),
      }
      return chain
    },
  },
}))

vi.mock('../../src/utils/toast', () => ({
  showToast: (mensaje: string, tipo = 'info') => { estado.toasts.push({ mensaje, tipo }) },
}))

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    businessId: BIZ_ID, isOwner: true, isAdmin: false,
    profile: { id: '11111111-1111-4111-8111-111111111111' },
  }),
}))

vi.mock('../../src/hooks/useSubscription', () => ({ useSubscription: () => ({}) }))

vi.mock('../../src/services/usersService', () => ({
  usersService: {
    getBusinessUsers: async () => [],
    changeUserRole: async () => {},
    setUserActiveStatus: async () => {},
    updateUserPermissions: async () => {},
  },
}))

import {
  buildInvitationUrl, invitationPath, loopbackOrigin, resolveInvitationOrigin, CANONICAL_APP_ORIGIN,
} from '../../supabase/functions/_shared/invitationLink.ts'
import {
  escapeHtml, sanitizeHeaderText, renderInvitationEmail, ROLE_LABELS, INVITABLE_ROLES,
  INVITATION_FROM, FALLBACK_BUSINESS_NAME,
} from '../../supabase/functions/send-business-invitation/email.ts'
import { invitationUrl, invitationUrlFor } from '../../src/lib/invitationLink'
import { acceptInviteePath } from '../../src/lib/pendingInvite'
import {
  createAndSendInvitation, resendInvitationEmail, parseDeliveryResponse, InvitationError, DELIVERY_UNAVAILABLE,
} from '../../src/services/invitationsService'
import { UsersManagement } from '../../src/pages/UsersManagement'

const pendiente = (over: Record<string, unknown> = {}) => ({
  id: INV_ID, business_id: BIZ_ID, email: 'invitada@example.com', role: 'tech', token: TOKEN,
  status: 'pending', expires_at: '2099-01-01T00:00:00Z', created_at: '2026-09-29T00:00:00Z', ...over,
})

const vistaOk = (delivery: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  data: {
    ok: true,
    invitation: { id: INV_ID, email: 'invitada@example.com', role: 'tech', status: 'pending', expires_at: '2099-01-01T00:00:00Z', ...over },
    delivery,
  },
  error: null,
})

/** Error de supabase-js para respuestas no-2xx: el body se lee del contexto. */
const errorHttp = (status: number, body: unknown): Respuesta => ({
  data: null,
  error: { name: 'FunctionsHttpError', context: { status, json: async () => body } },
})

beforeEach(() => {
  estado.invoke = []
  estado.invokeImpl = null
  estado.rpc = []
  estado.rpcImpl = {}
  estado.pendientes = []
  estado.toasts = []
  estado.secuencia = []
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A · enlace canónico (fuente única)', () => {
  it('producción: siempre www + /accept-invite + token codificado', () => {
    expect(CANONICAL_APP_ORIGIN).toBe(CANONICO)
    expect(buildInvitationUrl(TOKEN)).toBe(`${CANONICO}/accept-invite?token=${TOKEN}`)
    expect(buildInvitationUrl('ab c&d=1#x')).toBe(`${CANONICO}/accept-invite?token=ab%20c%26d%3D1%23x`)
    expect(buildInvitationUrl(`  ${TOKEN} `)).toBe(`${CANONICO}/accept-invite?token=${TOKEN}`)
  })

  it('un override sólo cuenta si es EXACTAMENTE loopback http', () => {
    for (const ok of ['http://localhost:5173', 'http://localhost:5174/', 'http://127.0.0.1:5174', 'http://[::1]:5173', 'http://localhost']) {
      expect(loopbackOrigin(ok), ok).not.toBeNull()
      expect(resolveInvitationOrigin(ok).startsWith('http://'), ok).toBe(true)
    }
    for (const malo of [
      'https://evil.example', 'https://clicmayorista.com.ar', 'https://techrepairpro.app',
      'https://tech-repair-pro-git-x.vercel.app', 'http://localhost.evil.example:5173',
      'http://127.0.0.1.nip.io', 'http://evil@localhost:5173', 'https://localhost:5173',
      'http://localhost:5173/accept-invite', 'http://localhost:5173/?next=https://evil.example',
      'javascript:alert(1)', '', '   ', null, undefined,
    ]) {
      expect(loopbackOrigin(malo as string), String(malo)).toBeNull()
      expect(resolveInvitationOrigin(malo as string), String(malo)).toBe(CANONICO)
    }
  })

  it('build de producción NUNCA usa el origen de la pestaña, ni siquiera loopback', () => {
    for (const origin of ['http://localhost:5173', 'https://evil.example', 'https://tech-repair-pro-git-x.vercel.app', 'https://techrepairpro.app']) {
      expect(invitationUrlFor(TOKEN, { mode: 'production', origin })).toBe(`${CANONICO}/accept-invite?token=${TOKEN}`)
    }
  })

  it('dev/E2E: loopback permitido; cualquier otro origen cae al canónico', () => {
    expect(invitationUrlFor(TOKEN, { mode: 'development', origin: 'http://localhost:5173' }))
      .toBe(`http://localhost:5173/accept-invite?token=${TOKEN}`)
    expect(invitationUrlFor(TOKEN, { mode: 'e2e', origin: 'http://localhost:5174' }))
      .toBe(`http://localhost:5174/accept-invite?token=${TOKEN}`)
    expect(invitationUrlFor(TOKEN, { mode: 'development', origin: 'https://tech-repair-pro-git-x.vercel.app' }))
      .toBe(`${CANONICO}/accept-invite?token=${TOKEN}`)
  })

  it('invitationUrl con MODE=production ignora window.location', () => {
    vi.stubEnv('MODE', 'production')
    expect(window.location.origin.startsWith('http://localhost')).toBe(true)
    expect(invitationUrl(TOKEN)).toBe(`${CANONICO}/accept-invite?token=${TOKEN}`)
  })

  it('la ruta interna de redirect sale de la misma fuente', () => {
    expect(acceptInviteePath('ab c&d')).toBe('/accept-invite?token=ab%20c%26d')
    expect(acceptInviteePath(TOKEN)).toBe(invitationPath(TOKEN))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B · plantilla del correo', () => {
  const url = `${CANONICO}/accept-invite?token=${TOKEN}`

  it('escapa HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })

  it('sanea texto de header: sin CR/LF ni controles, whitespace normalizado, largo acotado', () => {
    expect(sanitizeHeaderText('Clic\r\nBcc: x@evil.example')).toBe('Clic Bcc: x@evil.example')
    expect(sanitizeHeaderText('  Taller \t  Norte  ')).toBe('Taller Norte')
    expect(sanitizeHeaderText(`A${String.fromCharCode(0x2028)}B${String.fromCharCode(0)}C`)).toBe('A B C')
    const largo = sanitizeHeaderText('x'.repeat(500))
    expect([...largo].length).toBeLessThanOrEqual(80)
    expect(largo.endsWith('…')).toBe(true)
    expect(sanitizeHeaderText(42)).toBe('')
  })

  it('asunto y cuerpo con el nombre del negocio; el HTML lo escapa', () => {
    const { subject, html, text } = renderInvitationEmail({ businessName: 'Clic <b>"Norte"</b>\r\nBcc: x', role: 'tech', acceptUrl: url })
    expect(subject).toBe('Te invitaron a Clic <b>"Norte"</b> Bcc: x — TechRepair Pro')
    expect(/[\r\n]/.test(subject)).toBe(false)
    expect(html).not.toContain('<b>"Norte"</b>')
    expect(html).toContain('Clic &lt;b&gt;&quot;Norte&quot;&lt;/b&gt;')
    expect(html).toContain('Aceptar invitación')
    expect(html).toContain('Técnico')
    expect(html).toContain('Usá el mismo correo al que recibiste esta invitación.')
    expect(html).toContain('Si no esperabas esta invitación, ignorá este correo.')
    expect(text).toContain('Rol: Técnico')
  })

  it('mapa server-side de roles, sin owner', () => {
    expect(ROLE_LABELS).toEqual({
      admin: 'Administrador', manager: 'Gerente', tech: 'Técnico',
      sales: 'Ventas', cashier: 'Cajero', viewer: 'Visualizador',
    })
    expect(INVITABLE_ROLES).not.toContain('owner')
    for (const role of INVITABLE_ROLES) {
      expect(renderInvitationEmail({ businessName: 'X', role, acceptUrl: url }).html).toContain(ROLE_LABELS[role])
    }
  })

  it('el token aparece UNA vez en el HTML, dentro del href esperado', () => {
    const { html, text } = renderInvitationEmail({ businessName: 'Clic', role: 'tech', acceptUrl: url })
    expect(html.split(TOKEN).length - 1).toBe(1)
    expect(html).toContain(`href="${url}"`)
    expect(text.split(TOKEN).length - 1).toBe(1)
    expect(text).toContain(url)
  })

  it('sin tracking, sin imágenes, sin soporte, sin Reply-To', () => {
    const { html, text } = renderInvitationEmail({ businessName: 'Clic', role: 'admin', acceptUrl: url })
    const todo = `${html}\n${text}`
    for (const prohibido of [/<img/i, /pixel/i, /utm_/i, /open_track|click_track|tracking/i, /CONTACTO_SOPORTE/, /soporte@/i, /reply-to/i, /<script/i, /https?:\/\/(?!www\.techrepairpro\.app\/accept-invite)/i]) {
      expect(todo, String(prohibido)).not.toMatch(prohibido)
    }
    expect(INVITATION_FROM).toBe('TechRepair Pro <no-reply@techrepairpro.app>')
  })

  it('nombre vacío → nombre genérico', () => {
    expect(renderInvitationEmail({ businessName: '  ', role: 'tech', acceptUrl: url }).subject)
      .toBe(`Te invitaron a ${FALLBACK_BUSINESS_NAME} — TechRepair Pro`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C · servicio de entrega', () => {
  it('create_and_send: sólo viaja {action, email, role}; ok → invitación + delivery', async () => {
    estado.invokeImpl = async () => vistaOk({ status: 'sent' })
    const res = await createAndSendInvitation('invitada@example.com', 'tech')
    expect(estado.invoke).toEqual([{ nombre: 'send-business-invitation', body: { action: 'create_and_send', email: 'invitada@example.com', role: 'tech' } }])
    expect(res.delivery).toEqual({ status: 'sent', code: null })
    expect(res.invitation.id).toBe(INV_ID)
    // No crea por su cuenta cuando la entrega respondió.
    expect(estado.rpc.some(r => r.nombre === 'create_business_invitation')).toBe(false)
  })

  it('invitación creada + correo fallido → NO lanza, informa delivery failed', async () => {
    estado.invokeImpl = async () => vistaOk({ status: 'failed', code: 'provider_error' })
    const res = await createAndSendInvitation('invitada@example.com', 'tech')
    expect(res.delivery).toEqual({ status: 'failed', code: 'provider_error' })
  })

  it('rechazo semántico del Edge → InvitationError con mensaje de UI, sin fallback', async () => {
    estado.invokeImpl = async () => errorHttp(403, { ok: false, error: 'FORBIDDEN' })
    await expect(createAndSendInvitation('x@example.com', 'tech')).rejects.toMatchObject({
      code: 'FORBIDDEN', message: 'No tenés permisos para gestionar invitaciones.',
    })
    expect(estado.rpc.some(r => r.nombre === 'create_business_invitation')).toBe(false)
  })

  it('Edge no disponible (no desplegado / caído / CORS) → la invitación se crea igual por la RPC canónica', async () => {
    for (const falla of [
      async () => errorHttp(404, { code: 'NOT_FOUND', message: 'Requested function was not found' }),
      async () => errorHttp(503, { ok: false, error: 'AUTHORIZATION_UNAVAILABLE' }),
      async () => ({ data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' } }),
      async () => { throw new TypeError('network') },
    ]) {
      estado.rpc = []
      estado.invokeImpl = falla as never
      estado.rpcImpl['create_business_invitation'] = () => ({ data: pendiente(), error: null })
      const res = await createAndSendInvitation('invitada@example.com', 'tech')
      expect(res.delivery).toEqual({ status: 'failed', code: DELIVERY_UNAVAILABLE })
      expect(res.invitation.id).toBe(INV_ID)
      const llamada = estado.rpc.find(r => r.nombre === 'create_business_invitation')
      expect(Object.keys(llamada?.args ?? {}).sort()).toEqual(['p_email', 'p_role'])
    }
  })

  it('resend: sólo viaja el id; nunca correo ni token', async () => {
    estado.invokeImpl = async () => vistaOk({ status: 'sent' })
    const d = await resendInvitationEmail(INV_ID)
    expect(estado.invoke[0].body).toEqual({ action: 'resend', invitation_id: INV_ID })
    expect(d).toEqual({ status: 'sent', code: null })
  })

  it('resend: vencida → InvitationError; entrega caída → failed sin lanzar', async () => {
    estado.invokeImpl = async () => errorHttp(409, { ok: false, error: 'INVITATION_EXPIRED' })
    await expect(resendInvitationEmail(INV_ID)).rejects.toBeInstanceOf(InvitationError)
    estado.invokeImpl = async () => errorHttp(502, '<html>Bad Gateway</html>')
    expect(await resendInvitationEmail(INV_ID)).toEqual({ status: 'failed', code: DELIVERY_UNAVAILABLE })
  })

  it('el parser nunca propaga texto libre del servidor', () => {
    const r = parseDeliveryResponse({ ok: true, invitation: { id: INV_ID, email: 'a@b.co', role: 'tech', expires_at: 'x', token: TOKEN }, delivery: { status: 'failed', code: 'Resend said: bad key re_live' } })
    expect(r).toEqual({ tipo: 'ok', invitation: { id: INV_ID, email: 'a@b.co', role: 'tech', status: 'pending', expires_at: 'x' }, delivery: { status: 'failed', code: 'provider_error' } })
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(parseDeliveryResponse({ ok: false, error: 'function gen_random_bytes(integer) does not exist' })).toEqual({ tipo: 'no-disponible' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('D · UsersManagement', () => {
  const montar = async () => {
    render(<UsersManagement />)
    await waitFor(() => expect(screen.getByTestId('invite-open')).toBeTruthy())
  }

  const invitar = async (email: string) => {
    fireEvent.click(screen.getByTestId('invite-open'))
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: email } })
    fireEvent.click(screen.getByTestId('invite-submit'))
  }

  beforeEach(() => {
    vi.stubEnv('MODE', 'production')
    estado.rpcImpl['check_user_limit_before_invite'] = () => ({ data: 'OK', error: null })
  })

  it('éxito: gate de plan PRIMERO, después la entrega; toast «Invitación enviada a …»', async () => {
    estado.invokeImpl = async () => { estado.pendientes = [pendiente()]; return vistaOk({ status: 'sent' }) }
    await montar()
    await invitar('invitada@example.com')

    await waitFor(() => expect(estado.toasts.some(t => t.tipo === 'success')).toBe(true))
    expect(estado.toasts).toContainEqual({ mensaje: 'Invitación enviada a invitada@example.com.', tipo: 'success' })
    const idxLimite = estado.secuencia.indexOf('rpc:check_user_limit_before_invite')
    const idxEntrega = estado.secuencia.indexOf('invoke:send-business-invitation')
    expect(idxLimite).toBeGreaterThanOrEqual(0)
    expect(idxEntrega).toBeGreaterThan(idxLimite)
    expect(estado.invoke).toHaveLength(1)
    expect(estado.invoke[0].body).toEqual({ action: 'create_and_send', email: 'invitada@example.com', role: 'tech' })
    // La pendiente quedó visible, con el enlace canónico.
    await waitFor(() => expect(screen.getByTestId('pending-invitation-row')).toBeTruthy())
    expect(screen.getByTestId('invitation-link').textContent).toBe(`${CANONICO}/accept-invite?token=${TOKEN}`)
  })

  it('límite de plan alcanzado → no se invoca la entrega', async () => {
    estado.rpcImpl['check_user_limit_before_invite'] = () => ({ data: 'LIMIT_REACHED:3:3:pro', error: null })
    const alerta = vi.spyOn(window, 'alert').mockImplementation(() => {})
    await montar()
    await invitar('invitada@example.com')
    await waitFor(() => expect(alerta).toHaveBeenCalled())
    expect(estado.invoke).toHaveLength(0)
  })

  it('fallo de entrega con invitación creada → warning con fallback y la pendiente visible', async () => {
    estado.invokeImpl = async () => { estado.pendientes = [pendiente()]; return vistaOk({ status: 'failed', code: 'provider_error' }) }
    await montar()
    await invitar('invitada@example.com')
    await waitFor(() => expect(estado.toasts.length).toBeGreaterThan(0))
    expect(estado.toasts).toContainEqual({
      mensaje: 'La invitación quedó creada, pero no pudimos enviar el correo. Podés reenviarlo o copiar el link.',
      tipo: 'warning',
    })
    await waitFor(() => expect(screen.getByTestId('pending-invitation-row')).toBeTruthy())
    expect(screen.getByTestId('invitation-resend')).toBeTruthy()
    expect(screen.getByTestId('invitation-copy')).toBeTruthy()
  })

  it('el correo se escapa antes de entrar al toast (innerHTML)', async () => {
    const raro = '<img/src=x/onerror=alert(1)>@example.com'
    estado.invokeImpl = async () => vistaOk({ status: 'sent' }, { email: raro })
    await montar()
    await invitar(raro)
    await waitFor(() => expect(estado.toasts.length).toBeGreaterThan(0))
    expect(estado.toasts[0].mensaje).not.toContain('<img')
    expect(estado.toasts[0].mensaje).toContain('&lt;img/src=x/onerror=alert(1)&gt;@example.com')
  })

  it('reenviar: sólo el id, botón deshabilitado mientras corre, doble click = 1 envío', async () => {
    estado.pendientes = [pendiente()]
    let liberar: () => void = () => {}
    estado.invokeImpl = () => new Promise(resolve => { liberar = () => resolve(vistaOk({ status: 'sent' })) })
    await montar()
    fireEvent.click(screen.getByTestId('invitations-toggle'))
    const boton = await screen.findByTestId('invitation-resend') as HTMLButtonElement
    fireEvent.click(boton)
    fireEvent.click(boton)
    await waitFor(() => expect(boton.disabled).toBe(true))
    expect(boton.textContent).toContain('Reenviando...')
    liberar()
    await waitFor(() => expect(estado.toasts).toContainEqual({ mensaje: 'Invitación reenviada.', tipo: 'success' }))
    expect(estado.invoke).toHaveLength(1)
    expect(estado.invoke[0].body).toEqual({ action: 'resend', invitation_id: INV_ID })
    await waitFor(() => expect(boton.disabled).toBe(false))
  })

  it('reenviar con fallo de entrega → «No pudimos reenviar el correo. El link sigue disponible.»', async () => {
    estado.pendientes = [pendiente()]
    estado.invokeImpl = async () => vistaOk({ status: 'failed', code: 'rate_limited' })
    await montar()
    fireEvent.click(screen.getByTestId('invitations-toggle'))
    fireEvent.click(await screen.findByTestId('invitation-resend'))
    await waitFor(() => expect(estado.toasts).toContainEqual({
      mensaje: 'No pudimos reenviar el correo. El link sigue disponible.', tipo: 'warning',
    }))
  })

  it('copiar link: el enlace canónico, nunca el origen de la pestaña', async () => {
    estado.pendientes = [pendiente()]
    const copiados: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => { copiados.push(t) } },
    })
    await montar()
    fireEvent.click(screen.getByTestId('invitations-toggle'))
    fireEvent.click(await screen.findByTestId('invitation-copy'))
    await waitFor(() => expect(copiados).toHaveLength(1))
    expect(copiados[0]).toBe(`${CANONICO}/accept-invite?token=${TOKEN}`)
    expect(copiados[0]).not.toContain(window.location.origin)
  })

  it('cancelar sigue yendo por la RPC canónica', async () => {
    estado.pendientes = [pendiente()]
    estado.rpcImpl['cancel_business_invitation'] = () => ({ data: pendiente({ status: 'cancelled' }), error: null })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await montar()
    fireEvent.click(screen.getByTestId('invitations-toggle'))
    fireEvent.click(await screen.findByTestId('invitation-cancel'))
    await waitFor(() => expect(estado.rpc.some(r => r.nombre === 'cancel_business_invitation')).toBe(true))
    expect(estado.rpc.find(r => r.nombre === 'cancel_business_invitation')?.args).toEqual({ p_invitation_id: INV_ID })
    expect(estado.invoke).toHaveLength(0)
  })
})
