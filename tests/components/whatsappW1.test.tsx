// ─────────────────────────────────────────────────────────────────────────────
// W1 — WhatsApp estándar: multitenant, RBAC y variables económicas.
//
// Lo puro (renderer, URL wa.me, teléfono, alias, semántica de estado) vive en
// tests/unit/whatsappTemplate.test.ts y corre con node:test. Acá va sólo lo que
// necesita React: el acotado por negocio de las consultas, el gate de permiso
// del editor de plantillas, y que el preview no deje pasar un hueco de plata.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const BIZ_A = 'biz-aaaa-1111'
const BIZ_B = 'biz-bbbb-2222'

const estado = vi.hoisted(() => ({
  businessId: 'biz-aaaa-1111' as string | null,
  puedeEditar: true,
  cloudConectado: false,
  /** Configuración del Companion. Ver el mock de `whatsappCompanionEnv`. */
  extensionId: null as string | null,
  installUrl: null as string | null,
  /** Toda operación contra Supabase, para auditar el acotado por negocio. */
  ops: [] as Array<{ tabla: string; verbo: string; filtros: Array<[string, unknown]> }>,
  filas: {} as Record<string, Array<Record<string, unknown>>>,
}))

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ businessId: estado.businessId, user: { id: 'user-1' } }),
}))

vi.mock('../../src/hooks/usePermissions', () => ({
  usePermissions: () => ({
    permissions: {},
    can: (key: string) => (key === 'settings_sensitive' ? estado.puedeEditar : true),
  }),
}))

vi.mock('../../src/services/whatsappCloudService', () => ({
  getConnection: async () => (estado.cloudConectado ? { phone_number_id: 'pn-1' } : null),
}))

/**
 * Se sustituye SÓLO la lectura de entorno. El cliente del Companion corre de
 * verdad —incluido qué payload arma y el manejo de `lastError`—; lo único
 * falseado es `chrome.runtime`, que es la API del navegador.
 *
 * (A `import.meta.env` de otro módulo no se le puede escribir desde un test:
 * Vite lo fija. De ahí que la lectura viva aislada en su propio módulo.)
 */
vi.mock('../../src/config/whatsappCompanionEnv', () => ({
  extensionIdConfigurado: () => estado.extensionId,
  installUrlConfigurada: () => estado.installUrl,
}))

function construirQuery(tabla: string) {
  const filtros: Array<[string, unknown]> = []
  const registrar = (verbo: string) => estado.ops.push({ tabla, verbo, filtros: [...filtros] })
  const resultado = () => ({ data: estado.filas[tabla] ?? [], error: null })

  const q: Record<string, unknown> = {}
  const encadenar = () => q
  q.select = encadenar
  q.order  = encadenar
  q.limit  = encadenar
  q.eq = (col: string, val: unknown) => { filtros.push([col, val]); return q }

  q.insert = (payload: unknown) => { registrar('insert'); void payload; return Promise.resolve({ data: null, error: null }) }
  q.update = (payload: unknown) => { registrar('update'); void payload; return q }
  q.upsert = (payload: unknown) => { registrar('upsert'); void payload; return Promise.resolve({ data: null, error: null }) }
  q.delete = () => { registrar('delete'); return Promise.resolve({ data: null, error: null }) }

  q.single      = async () => { registrar('select'); const r = resultado(); return { data: r.data[0] ?? null, error: r.data.length ? null : { code: 'PGRST116' } } }
  q.maybeSingle = async () => { registrar('select'); const r = resultado(); return { data: r.data[0] ?? null, error: null } }
  q.then = (resolve: (v: unknown) => unknown) => { registrar('select'); return Promise.resolve(resultado()).then(resolve) }

  return q
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: (tabla: string) => construirQuery(tabla) },
}))

import { WhatsAppTemplatesSettings } from '../../src/components/settings/WhatsAppTemplatesSettings'
import { WhatsAppPreviewModal } from '../../src/components/whatsapp/WhatsAppPreviewModal'

// ── Helpers ──────────────────────────────────────────────────────────────────

const opsDe = (tabla: string) => estado.ops.filter(o => o.tabla === tabla)
const escrituras = () => estado.ops.filter(o => o.verbo !== 'select')

/** Todo valor de business_id que se mandó a Supabase, sin repetir. */
const negociosTocados = () => [...new Set(
  estado.ops.flatMap(o => o.filtros.filter(([c]) => c === 'business_id').map(([, v]) => v)),
)]

// ── Companion ────────────────────────────────────────────────────────────────
//
// NO se mockea `whatsappCompanion`: se falsea sólo la API del navegador
// (`chrome.runtime`) y se deja correr el cliente real. Así estos tests también
// cubren qué payload sale y que no se navegue nada. El comportamiento de la
// extensión —pestañas— lo prueba `tools/whatsapp-companion/probe.mjs` en
// Chromium real; eso no se simula.

const ID_COMPANION = 'abcdefghijklmnopabcdefghijklmnop'

type MensajeCompanion = { type: string; phone?: string; text?: string }

/** Companion instalado: `chrome.runtime` responde. Devuelve lo que se le mandó. */
function companionInstalado(responder: (m: MensajeCompanion) => unknown = (m) =>
  m.type === 'PING' ? { ok: true, version: '1.0.0' } : { ok: true, action: 'reused', tabId: 7 },
) {
  estado.extensionId = ID_COMPANION
  const enviados: Array<{ id: string; mensaje: MensajeCompanion }> = []
  vi.stubGlobal('chrome', {
    runtime: {
      lastError: undefined,
      sendMessage: (id: string, mensaje: MensajeCompanion, cb: (r: unknown) => void) => {
        enviados.push({ id, mensaje })
        setTimeout(() => cb(responder(mensaje)), 0)
      },
    },
  })
  return enviados
}

/** Instalado, pero Chrome le retiró el acceso a WhatsApp Web. */
function companionSinAcceso() {
  return companionInstalado((m) => m.type === 'PING'
    ? { ok: true, version: '1.0.0', hostAccess: false }
    : { ok: false, code: 'HOST_ACCESS_REQUIRED' })
}

/** Instalado pero el service worker no contesta a tiempo. */
function companionQueNoContesta() {
  estado.extensionId = ID_COMPANION
  const enviados: MensajeCompanion[] = []
  vi.stubGlobal('chrome', {
    runtime: {
      lastError: undefined,
      // Nunca llama al callback: el cliente tiene que caer por timeout, no por
      // lastError. Es el caso del worker MV3 dormido.
      sendMessage: (_id: string, mensaje: MensajeCompanion) => { enviados.push(mensaje) },
    },
  })
  return enviados
}

/** Configurado pero NO instalado: Chrome contesta con `lastError`. */
function companionNoInstalado() {
  estado.extensionId = ID_COMPANION
  const enviados: MensajeCompanion[] = []
  const runtime = {
    lastError: { message: 'Could not establish connection.' },
    sendMessage: (_id: string, mensaje: MensajeCompanion, cb: (r: unknown) => void) => {
      enviados.push(mensaje)
      setTimeout(() => cb(undefined), 0)
    },
  }
  vi.stubGlobal('chrome', { runtime })
  return enviados
}

beforeEach(() => {
  vi.unstubAllGlobals()
  estado.extensionId = null
  estado.installUrl = null
  estado.businessId = BIZ_A
  estado.puedeEditar = true
  estado.cloudConectado = false
  estado.ops = []
  estado.filas = {
    whatsapp_settings: [{
      id: 's1', business_id: BIZ_A, enabled: true, auto_send_enabled: false,
      business_name: 'TechRepair A', business_address: 'San Martín 1',
      business_whatsapp: '3517654321', business_instagram: '@a',
      business_hours: 'Lun a Vie', closing_message: '',
    }],
    whatsapp_templates: [{
      id: 't1', business_id: BIZ_A, status_key: 'ready_pickup', status_label: 'Listo para Retirar',
      message_template: 'Hola {nombre}, tu {equipo} está listo en {local}.',
      auto_send: false, is_active: true,
    }],
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 4 · MULTITENANT
// ═════════════════════════════════════════════════════════════════════════════

describe('W1 · multitenant', () => {

  it('las plantillas se leen SIEMPRE acotadas al negocio de la sesión', async () => {
    render(<WhatsAppTemplatesSettings />)
    await screen.findByTestId('whatsapp-templates-settings')

    const lecturas = opsDe('whatsapp_templates')
    expect(lecturas.length).toBeGreaterThan(0)
    for (const op of lecturas) {
      expect(op.filtros).toContainEqual(['business_id', BIZ_A])
    }
  })

  it('el negocio B nunca aparece en una consulta hecha desde el negocio A', async () => {
    render(<WhatsAppTemplatesSettings />)
    await screen.findByTestId('whatsapp-templates-settings')

    expect(negociosTocados()).toEqual([BIZ_A])
    expect(negociosTocados()).not.toContain(BIZ_B)
  })

  it('cambiar de negocio cambia el acotado (no queda pegado el anterior)', async () => {
    estado.businessId = BIZ_B
    estado.filas.whatsapp_templates = [{
      id: 't2', business_id: BIZ_B, status_key: 'ready_pickup', status_label: 'Listo para Retirar',
      message_template: 'Hola {nombre}', auto_send: false, is_active: true,
    }]

    render(<WhatsAppTemplatesSettings />)
    await screen.findByTestId('whatsapp-templates-settings')

    expect(negociosTocados()).toEqual([BIZ_B])
  })

  it('sin businessId no se emite ninguna consulta de plantillas', async () => {
    estado.businessId = null
    render(<WhatsAppTemplatesSettings />)

    await waitFor(() => expect(opsDe('whatsapp_templates')).toHaveLength(0))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5 · RBAC — permiso de edición
// ═════════════════════════════════════════════════════════════════════════════

describe('W1 · RBAC del editor de plantillas', () => {

  it('con settings_sensitive: el editor es editable y se puede guardar', async () => {
    estado.puedeEditar = true
    render(<WhatsAppTemplatesSettings />)
    await screen.findByTestId('whatsapp-templates-settings')

    expect(screen.queryByTestId('whatsapp-templates-readonly')).toBeNull()
    expect(screen.getByTestId('whatsapp-templates-save')).toBeEnabled()
    expect(screen.getByTestId('whatsapp-settings-business_name')).toBeEnabled()
  })

  it('SIN settings_sensitive: modo lectura, todo deshabilitado y aviso visible', async () => {
    estado.puedeEditar = false
    render(<WhatsAppTemplatesSettings />)
    await screen.findByTestId('whatsapp-templates-settings')

    expect(screen.getByTestId('whatsapp-templates-readonly')).toBeVisible()
    expect(screen.getByTestId('whatsapp-templates-save')).toBeDisabled()
    expect(screen.getByTestId('whatsapp-settings-business_name')).toBeDisabled()
  })

  it('SIN permiso, el textarea de la plantilla está deshabilitado', async () => {
    estado.puedeEditar = false
    const user = userEvent.setup()
    render(<WhatsAppTemplatesSettings />)
    await screen.findByTestId('whatsapp-templates-settings')

    await user.click(screen.getByTestId('whatsapp-template-ready_pickup').querySelector('button')!)
    expect(await screen.findByTestId('whatsapp-template-editor')).toBeDisabled()
  })

  it('FAIL-CLOSED: sin permiso no se emite NINGUNA escritura', async () => {
    estado.puedeEditar = false
    render(<WhatsAppTemplatesSettings />)
    await screen.findByTestId('whatsapp-templates-settings')

    estado.ops = []
    // El botón está deshabilitado; además el handler corta antes de escribir.
    screen.getByTestId('whatsapp-templates-save').click()

    await waitFor(() => expect(escrituras()).toHaveLength(0))
  })

  it('las variables disponibles salen de la allowlist, no de una lista paralela', async () => {
    render(<WhatsAppTemplatesSettings />)
    const chips = await screen.findByTestId('whatsapp-variables-disponibles')

    expect(chips.textContent).toContain('{nombre}')
    expect(chips.textContent).toContain('{saldo}')
    expect(chips.textContent).toContain('{numero_orden}')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 1 y 8 · PREVIEW: variables desconocidas y huecos de plata
// ═════════════════════════════════════════════════════════════════════════════

describe('W1 · preview del editor', () => {

  it('avisa de una variable inexistente MIENTRAS se edita la plantilla', async () => {
    estado.filas.whatsapp_templates = [{
      id: 't1', business_id: BIZ_A, status_key: 'ready_pickup', status_label: 'Listo para Retirar',
      message_template: 'Hola {nombre}, total {plata_total}',
      auto_send: false, is_active: true,
    }]
    const user = userEvent.setup()
    render(<WhatsAppTemplatesSettings />)
    await screen.findByTestId('whatsapp-templates-settings')

    await user.click(screen.getByTestId('whatsapp-template-ready_pickup').querySelector('button')!)

    const aviso = await screen.findByText(/Variables que no existen/i)
    expect(aviso).toBeVisible()
    // El aviso tiene que NOMBRAR la variable, no sólo decir que hay una.
    expect(aviso.textContent).toContain('{plata_total}')
  })

  it('la vista previa usa los ejemplos de la allowlist', async () => {
    const user = userEvent.setup()
    render(<WhatsAppTemplatesSettings />)
    await screen.findByTestId('whatsapp-templates-settings')

    await user.click(screen.getByTestId('whatsapp-template-ready_pickup').querySelector('button')!)

    const preview = await screen.findByTestId('whatsapp-template-preview')
    expect(preview.textContent).toContain('Ana')            // ejemplo de {nombre}
    expect(preview.textContent).not.toContain('{nombre}')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3, 6 y 8 · MODAL: teléfono inválido, hueco económico, preview ≡ wa.me
// ═════════════════════════════════════════════════════════════════════════════

describe('W1 · modal de preview', () => {

  const abrirModal = (props: Partial<React.ComponentProps<typeof WhatsAppPreviewModal>> = {}) =>
    render(
      <WhatsAppPreviewModal
        isOpen
        onClose={() => {}}
        recipientName="Ana Gómez"
        phone="351 1234567"
        defaultTemplateKey="ready_pickup"
        vars={{ equipo: 'Galaxy A54' }}
        context={{ orderId: 'ord-1' }}
        {...props}
      />,
    )

  it('se monta en document.body, fuera del subárbol de la página', async () => {
    // REGRESIÓN MEDIDA a 1280×800 preparando la captura del Chrome Web Store:
    // las páginas se envuelven en `.animate-fade-in`, que anima `transform` con
    // `forwards`, así que la matriz identidad queda aplicada para siempre. Un
    // `transform` crea un CONTEXTO DE APILAMIENTO: dentro de él el z-index 9999
    // del overlay sólo competía con sus hermanos, y `.top-header` (z-index 30)
    // pintaba encima y tapaba el encabezado del modal. Peor todavía, un ancestro
    // transformado se vuelve el bloque contenedor de `position: fixed`, así que
    // `inset: 0` cubría ese contenedor y no el viewport.
    //
    // Este test falla si el modal vuelve a renderizarse dentro del contenedor
    // del caller. Subir el z-index NO lo arreglaría —el problema es el contexto,
    // no el número— y este test seguiría en rojo, que es lo que se quiere.
    const { container } = abrirModal()
    const overlay = await screen.findByTestId('whatsapp-preview-modal')

    expect(container.contains(overlay), 'el modal quedó dentro del subárbol del caller').toBe(false)
    expect(overlay.parentElement).toBe(document.body)
  })

  it('un hueco de plata NOMBRA la variable y bloquea la apertura', async () => {
    estado.filas.whatsapp_templates = [{
      id: 't1', business_id: BIZ_A, status_key: 'ready_pickup', status_label: 'Listo para Retirar',
      message_template: 'Hola {nombre}, tenés un saldo pendiente de {saldo}.',
      auto_send: false, is_active: true,
    }]
    // `saldo` NO se pasa: es exactamente lo que hace OrderDetail cuando el
    // saldo canónico no está disponible.
    abrirModal()

    const aviso = await screen.findByTestId('whatsapp-variables-faltantes')
    expect(aviso.textContent).toMatch(/Saldo pendiente/i)
    expect(screen.getByTestId('whatsapp-desktop-app-button')).toBeDisabled()

    // Y jamás se manda el hueco silencioso.
    const textarea = screen.getByTestId('whatsapp-preview-textarea') as HTMLTextAreaElement
    expect(textarea.value).not.toContain('saldo pendiente de .')
  })

  it('con el saldo canónico presente, se puede abrir y no queda aviso', async () => {
    estado.filas.whatsapp_templates = [{
      id: 't1', business_id: BIZ_A, status_key: 'ready_pickup', status_label: 'Listo para Retirar',
      message_template: 'Hola {nombre}, tenés un saldo pendiente de {saldo}.',
      auto_send: false, is_active: true,
    }]
    abrirModal({ vars: { saldo: '$45.000' } })

    await screen.findByTestId('whatsapp-preview-textarea')
    await waitFor(() => expect(screen.queryByTestId('whatsapp-variables-faltantes')).toBeNull())
    expect(screen.getByTestId('whatsapp-desktop-app-button')).toBeEnabled()
  })

  it('teléfono inválido: no se puede abrir y se explica por qué', async () => {
    abrirModal({ phone: '351 123' })

    await screen.findByTestId('whatsapp-preview-textarea')
    expect(screen.getByTestId('whatsapp-desktop-app-button')).toBeDisabled()
    expect(screen.getByText(/no es válido|no tiene teléfono/i)).toBeVisible()
  })

  it('el preview lista las variables que realmente se usaron', async () => {
    abrirModal({ vars: { equipo: 'Galaxy A54' } })

    const usadas = await screen.findByTestId('whatsapp-vars-usadas')
    expect(usadas.textContent).toContain('Ana')
  })

  it('un re-render del padre NO pisa el mensaje editado a mano', async () => {
    // Los llamadores pasan `vars` como objeto literal inline: su identidad
    // cambia en cada render. Si eso rearmara el mensaje, la edición manual
    // -que es la vía para desbloquear una variable faltante- se perdería.
    const user = userEvent.setup()
    const props = {
      isOpen: true as const,
      onClose: () => {},
      recipientName: 'Ana Gómez',
      phone: '351 1234567',
      defaultTemplateKey: 'ready_pickup',
      context: { orderId: 'ord-1' },
    }
    const { rerender } = render(<WhatsAppPreviewModal {...props} vars={{ equipo: 'Galaxy A54' }} />)

    const textarea = await screen.findByTestId('whatsapp-preview-textarea') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value.length).toBeGreaterThan(0))

    await user.clear(textarea)
    await user.type(textarea, 'Texto escrito a mano')

    // Mismo CONTENIDO, objeto nuevo: exactamente lo que produce un re-render.
    rerender(<WhatsAppPreviewModal {...props} vars={{ equipo: 'Galaxy A54' }} />)

    await waitFor(() => expect(textarea.value).toBe('Texto escrito a mano'))
  })
  // ── CON Companion ─────────────────────────────────────────────────────────

  /**
   * §18: con el Companion instalado hay UN solo CTA. Volver a tres botones
   * permanentes sería regresar a hacerle elegir al usuario algo que el sistema
   * ya sabe resolver.
   */
  it('DESKTOP · con Companion hay UNA sola acción, sin menú de fallbacks', async () => {
    companionInstalado()
    abrirModal({ vars: { equipo: 'Galaxy A54' } })
    await screen.findByTestId('whatsapp-preview-textarea')

    const primario = screen.getByTestId('whatsapp-companion-button')
    await waitFor(() => expect(primario.textContent?.trim()).toMatch(/^Abrir WhatsApp$/i))

    expect(screen.queryByTestId('whatsapp-fallback-button'), 'sobra con el Companion').toBeNull()
    expect(screen.queryByTestId('whatsapp-install-companion')).toBeNull()

    const ayuda = screen.getByTestId('whatsapp-ayuda-desktop').textContent ?? ''
    expect(ayuda).toMatch(/conectado con TechRepair/i)
    // El copy no habla de pestañas técnicas ni promete reutilización.
    expect(ayuda).not.toMatch(/reutiliz/i)
  })

  /**
   * G + H: con el Companion activo TechRepair no se mueve y no estrena
   * pestañas. La navegación la hace Chrome del lado de la extensión.
   */
  it('DESKTOP · Companion: no navega, no abre pestañas, y registra "opened"', async () => {
    const enviados = companionInstalado()
    const openSpy = vi.fn()
    vi.stubGlobal('open', openSpy)
    const asignadas: string[] = []
    const navegadas: string[] = []
    Object.defineProperty(window, 'location', {
      value: { assign: (u: string) => asignadas.push(u), set href(u: string) { navegadas.push(u) }, get href() { return '' } },
      writable: true, configurable: true,
    })

    const user = userEvent.setup()
    abrirModal({ vars: { equipo: 'Galaxy A54' } })

    const textarea = await screen.findByTestId('whatsapp-preview-textarea') as HTMLTextAreaElement
    const boton = screen.getByTestId('whatsapp-companion-button')
    await waitFor(() => expect(boton).toBeEnabled())
    const mensajeEnPantalla = textarea.value
    estado.ops = []
    await user.click(boton)

    // G · TechRepair se queda donde está.
    await waitFor(() => expect(enviados.some(e => e.mensaje.type === 'OPEN_WHATSAPP_WEB')).toBe(true))
    expect(asignadas, 'TechRepair no puede navegarse a WhatsApp').toHaveLength(0)
    expect(navegadas).toHaveLength(0)
    // H · y no estrena ninguna pestaña.
    expect(openSpy).not.toHaveBeenCalled()

    // El payload es el del contrato, y el texto es EL MISMO que el preview.
    const apertura = enviados.find(e => e.mensaje.type === 'OPEN_WHATSAPP_WEB')!
    expect(apertura.id).toBe(ID_COMPANION)
    expect(Object.keys(apertura.mensaje).sort()).toEqual(['phone', 'text', 'type'])
    expect(apertura.mensaje.phone).toBe('5493511234567')
    expect(apertura.mensaje.text).toBe(mensajeEnPantalla)

    // Estado honesto: se abrió, no se envió.
    const chip = await screen.findByTestId('whatsapp-send-status')
    expect(chip.textContent).not.toMatch(/enviado/i)
    await waitFor(() => expect(opsDe('whatsapp_logs').length).toBeGreaterThan(0))
  })

  it('DESKTOP · si el Companion deja de responder, se cae al menú de fallbacks', async () => {
    // Instalado al momento del PING, pero la apertura falla: desinstalado en
    // caliente, o service worker caído. No puede dejar al usuario sin salida.
    companionInstalado((m) => m.type === 'PING' ? { ok: true, version: '1.0.0' } : null)

    const user = userEvent.setup()
    abrirModal({ vars: { equipo: 'Galaxy A54' } })
    await screen.findByTestId('whatsapp-preview-textarea')
    const boton = screen.getByTestId('whatsapp-companion-button')
    await waitFor(() => expect(boton.textContent?.trim()).toMatch(/^Abrir WhatsApp$/i))
    await user.click(boton)

    await waitFor(() => expect(screen.getByTestId('whatsapp-fallback-button')).toBeInTheDocument())
    expect(screen.getByTestId('whatsapp-desktop-app-button').textContent).toMatch(/WhatsApp Desktop/i)
  })

  // ── SIN Companion (I · fallbacks) ─────────────────────────────────────────

  it('I · sin Companion aparecen los fallbacks, con copy honesto', async () => {
    companionNoInstalado()
    estado.installUrl = 'https://chromewebstore.google.com/detail/x'

    abrirModal({ vars: { equipo: 'Galaxy A54' } })
    await screen.findByTestId('whatsapp-preview-textarea')

    await waitFor(() => expect(screen.getByTestId('whatsapp-fallback-button')).toBeInTheDocument())
    expect(screen.getByTestId('whatsapp-desktop-app-button').textContent).toMatch(/WhatsApp Desktop/i)
    expect(screen.getByTestId('whatsapp-fallback-button').textContent).toMatch(/WhatsApp Web/i)

    const instalar = screen.getByTestId('whatsapp-install-companion') as HTMLAnchorElement
    expect(instalar.getAttribute('href')).toMatch(/^https:\/\//)
    expect(instalar.getAttribute('rel')).toContain('noopener')

    // No se promete lo que sin extensión no se puede cumplir.
    const ayuda = screen.getByTestId('whatsapp-ayuda-desktop').textContent ?? ''
    expect(ayuda).toMatch(/nueva pestaña/i)
    expect(ayuda).not.toMatch(/reutiliz/i)
  })

  // ── Instalada pero SIN ACCESO al host ─────────────────────────────────────

  /**
   * Chrome permite dejar el acceso al sitio en «Al hacer clic». MEDIDO: en ese
   * estado `tabs.query({url})` no falla — devuelve cero pestañas — así que la
   * extensión crearía una pestaña nueva por mensaje, en silencio. Ahora se
   * detecta, y necesita un mensaje propio: no hay nada que instalar.
   */
  it('sin acceso al host: se dice DÓNDE habilitarlo, y no se ofrece instalar', async () => {
    companionSinAcceso()
    estado.installUrl = 'https://chromewebstore.google.com/detail/x'

    abrirModal({ vars: { equipo: 'Galaxy A54' } })
    await screen.findByTestId('whatsapp-preview-textarea')

    const aviso = await screen.findByTestId('whatsapp-sin-acceso')
    expect(aviso.textContent).toMatch(/está instalado/i)
    expect(aviso.textContent, 'tiene que decir dónde se arregla').toMatch(/Acceso al sitio/i)
    expect(aviso.textContent).toMatch(/web\.whatsapp\.com/)

    // Instalarla de nuevo no arreglaría nada.
    expect(screen.queryByTestId('whatsapp-install-companion'),
      'ya está instalada: ofrecer instalarla sería un consejo inútil').toBeNull()
  })

  it('sin acceso al host: quedan alternativas para mandar el mensaje ahora', async () => {
    // Nadie tiene por qué pelearse con los permisos de Chrome para poder
    // contestarle a un cliente en este momento.
    companionSinAcceso()
    abrirModal({ vars: { equipo: 'Galaxy A54' } })
    await screen.findByTestId('whatsapp-preview-textarea')
    await screen.findByTestId('whatsapp-sin-acceso')

    expect(screen.getByTestId('whatsapp-desktop-app-button')).toBeInTheDocument()
    expect(screen.getByTestId('whatsapp-fallback-button')).toBeInTheDocument()
    // Y el botón del Companion sigue: si acaba de habilitar el permiso, un clic
    // alcanza — sin cerrar y reabrir el modal.
    expect(screen.getByTestId('whatsapp-companion-button')).toBeInTheDocument()
  })

  it('sin acceso al host: NO se registra "opened", porque no se abrió nada', async () => {
    companionSinAcceso()
    const user = userEvent.setup()
    abrirModal({ vars: { equipo: 'Galaxy A54' } })
    await screen.findByTestId('whatsapp-preview-textarea')
    const boton = screen.getByTestId('whatsapp-companion-button')
    await waitFor(() => expect(boton).toBeEnabled())
    estado.ops = []
    await user.click(boton)

    const chip = await screen.findByTestId('whatsapp-send-status')
    expect(chip.textContent).toMatch(/no se pudo abrir/i)
    // `opened` significa handoff iniciado. Acá no hubo handoff.
    await waitFor(() => expect(screen.getByTestId('whatsapp-sin-acceso')).toBeInTheDocument())
    expect(opsDe('whatsapp_logs')).toHaveLength(0)
  })

  // ── Service worker frío ───────────────────────────────────────────────────

  /**
   * Un timeout NO es una ausencia. Medido: la ausencia real llega por
   * `lastError` en ~1 ms. Si el worker tarda, decir «no está instalada» hace
   * que la persona vea los fallbacks teniendo la extensión, sin forma de
   * descubrir el error. Por eso se es optimista y el clic decide.
   */
  it('si el Companion no contesta a tiempo, NO se lo declara ausente', async () => {
    companionQueNoContesta()
    abrirModal({ vars: { equipo: 'Galaxy A54' } })
    await screen.findByTestId('whatsapp-preview-textarea')

    // Con 2500 ms × 2 intentos, a los 300 ms todavía está buscando: lo que
    // importa es que NO haya saltado al menú de fallbacks.
    await new Promise(r => setTimeout(r, 300))
    expect(screen.queryByTestId('whatsapp-fallback-button')).toBeNull()
    expect(screen.getByTestId('whatsapp-companion-button')).toBeInTheDocument()
  }, 10_000)

  it('I · sin URL de instalación configurada NO se ofrece instalar', async () => {
    // Mientras la extensión no esté publicada, mandar a un link inventado sería
    // peor que no ofrecerlo.
    companionNoInstalado()
    abrirModal({ vars: { equipo: 'Galaxy A54' } })
    await screen.findByTestId('whatsapp-preview-textarea')

    await waitFor(() => expect(screen.getByTestId('whatsapp-fallback-button')).toBeInTheDocument())
    expect(screen.queryByTestId('whatsapp-install-companion')).toBeNull()
  })

  it('DESKTOP · app usa whatsapp://, sin window.open, y registra "opened"', async () => {
    companionNoInstalado()
    const navegadas: string[] = []
    const openSpy = vi.fn()
    vi.stubGlobal('open', openSpy)
    // `location.href` es lo que usa el camino de la app.
    const loc = { assign: vi.fn(), _href: '', set href(u: string) { navegadas.push(u) }, get href() { return '' } }
    Object.defineProperty(window, 'location', { value: loc, writable: true, configurable: true })

    const user = userEvent.setup()
    abrirModal({ vars: { equipo: 'Galaxy A54' } })

    const textarea = await screen.findByTestId('whatsapp-preview-textarea') as HTMLTextAreaElement
    const boton = screen.getByTestId('whatsapp-desktop-app-button')
    await waitFor(() => expect(boton.textContent).toMatch(/WhatsApp Desktop/i))
    await waitFor(() => expect(boton).toBeEnabled())
    const mensajeEnPantalla = textarea.value
    estado.ops = []
    await user.click(boton)

    expect(openSpy, 'la app no abre ninguna pestaña').not.toHaveBeenCalled()
    expect(navegadas).toHaveLength(1)
    expect(navegadas[0].startsWith('whatsapp://send?phone=5493511234567&text=')).toBe(true)
    expect(navegadas[0]).not.toContain('web.whatsapp.com')
    // Mismo texto que el preview.
    expect(decodeURIComponent(navegadas[0].split('&text=')[1])).toBe(mensajeEnPantalla)

    // La UI no afirma que la app se haya abierto — no se puede saber.
    const chip = await screen.findByTestId('whatsapp-send-status')
    expect(chip.textContent).not.toMatch(/enviado/i)

    await waitFor(() => expect(opsDe('whatsapp_logs').length).toBeGreaterThan(0))
  })

  /**
   * G · el fallback abre una pestaña NUEVA y TechRepair NO se navega.
   *
   * Esto invierte lo que hacía PR #55 a propósito: sin forma de reutilizar
   * nada, navegar la pestaña actual era el mal menor; con el Companion
   * resolviendo el caso bueno, sacar al usuario de su trabajo dejó de ser
   * aceptable. Lo que NO cambió: no se promete reutilizar esta pestaña.
   */
  it('G · sin Companion, WhatsApp Web abre pestaña nueva y NO navega TechRepair', async () => {
    companionNoInstalado()
    const llamadas: Array<[string, string]> = []
    vi.stubGlobal('open', vi.fn((u: string, t: string) => { llamadas.push([u, t]); return {} as Window }))
    const asignadas: string[] = []
    const navegadas: string[] = []
    Object.defineProperty(window, 'location', {
      value: { assign: (u: string) => asignadas.push(u), set href(u: string) { navegadas.push(u) }, get href() { return '' } },
      writable: true, configurable: true,
    })

    const user = userEvent.setup()
    abrirModal({ vars: { equipo: 'Galaxy A54' } })

    const textarea = await screen.findByTestId('whatsapp-preview-textarea') as HTMLTextAreaElement
    await waitFor(() => expect(screen.getByTestId('whatsapp-fallback-button')).toBeEnabled())
    const web = screen.getByTestId('whatsapp-fallback-button')
    const mensajeEnPantalla = textarea.value
    await user.click(web)

    await waitFor(() => expect(llamadas).toHaveLength(1))
    expect(asignadas, 'TechRepair no se navega a WhatsApp').toHaveLength(0)
    expect(navegadas).toHaveLength(0)
    expect(llamadas[0][1]).toBe('_blank')
    expect(llamadas[0][0].startsWith('https://web.whatsapp.com/send?phone=5493511234567&text=')).toBe(true)
    expect(llamadas[0][0]).not.toContain('api.whatsapp.com')
    expect(decodeURIComponent(llamadas[0][0].split('&text=')[1])).toBe(mensajeEnPantalla)
  })

  it('el popup bloqueado en el fallback se dice, no se traga', async () => {
    companionNoInstalado()
    vi.stubGlobal('open', vi.fn(() => null))

    const user = userEvent.setup()
    abrirModal({ vars: { equipo: 'Galaxy A54' } })
    await screen.findByTestId('whatsapp-preview-textarea')
    await waitFor(() => expect(screen.getByTestId('whatsapp-fallback-button')).toBeEnabled())
    await user.click(screen.getByTestId('whatsapp-fallback-button'))

    const chip = await screen.findByTestId('whatsapp-send-status')
    expect(chip.textContent).toMatch(/no se pudo abrir/i)
  })

  /**
   * J · el móvil no cambia y NO usa el Companion. Ahí `wa.me` se lo entrega el
   * sistema a la app nativa, que es mejor que cualquier cosa que pueda hacer
   * una extensión de escritorio. Ni se consulta ni se ofrece instalarla.
   */
  it('J · MÓVIL · una sola acción wa.me, sin Companion y sin botones de desktop', async () => {
    const original = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', configurable: true })
    try {
      // Companion instalado a propósito: aun así el móvil no le habla.
      const enviados = companionInstalado()
      estado.installUrl = 'https://chromewebstore.google.com/detail/x'
      const llamadas: Array<[string, string]> = []
      vi.stubGlobal('open', vi.fn((u: string, t: string) => { llamadas.push([u, t]); return {} as Window }))

      const user = userEvent.setup()
      abrirModal({ vars: { equipo: 'Galaxy A54' } })
      const textarea = await screen.findByTestId('whatsapp-preview-textarea') as HTMLTextAreaElement
      const boton = screen.getByTestId('whatsapp-mobile-button')

      expect(boton.textContent).toMatch(/Abrir WhatsApp/i)
      expect(screen.queryByTestId('whatsapp-fallback-button'), 'móvil no muestra las acciones de desktop').toBeNull()
      expect(screen.queryByTestId('whatsapp-install-companion'), 'no se ofrece una extensión de escritorio en un teléfono').toBeNull()
      expect(screen.queryByTestId('whatsapp-ayuda-desktop')).toBeNull()

      await waitFor(() => expect(boton).toBeEnabled())
      const mensajeEnPantalla = textarea.value
      await user.click(boton)

      expect(llamadas).toHaveLength(1)
      expect(llamadas[0][0].startsWith('https://wa.me/5493511234567?text=')).toBe(true)
      expect(llamadas[0][1]).toBe('_blank')
      expect(decodeURIComponent(llamadas[0][0].split('?text=')[1])).toBe(mensajeEnPantalla)

      // Ni el PING salió.
      expect(enviados, 'en móvil no se consulta al Companion').toHaveLength(0)
    } finally {
      Object.defineProperty(navigator, 'userAgent', { value: original, configurable: true })
    }
  })
})
