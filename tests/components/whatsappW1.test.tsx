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
import { _olvidarPestanaWhatsApp } from '../../src/services/whatsappHandoff'

// ── Helpers ──────────────────────────────────────────────────────────────────

const opsDe = (tabla: string) => estado.ops.filter(o => o.tabla === tabla)
const escrituras = () => estado.ops.filter(o => o.verbo !== 'select')

/** Todo valor de business_id que se mandó a Supabase, sin repetir. */
const negociosTocados = () => [...new Set(
  estado.ops.flatMap(o => o.filtros.filter(([c]) => c === 'business_id').map(([, v]) => v)),
)]

beforeEach(() => {
  // La referencia a la pestaña de WhatsApp vive a nivel de módulo y sobrevive
  // a propósito entre aperturas del modal. En la suite hay que soltarla, o un
  // test hereda la pestaña abierta por el anterior y nunca llama a `open`.
  _olvidarPestanaWhatsApp()
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
    expect(screen.getByTestId('whatsapp-send-api-button')).toBeDisabled()

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
    expect(screen.getByTestId('whatsapp-send-api-button')).toBeEnabled()
  })

  it('teléfono inválido: no se puede abrir y se explica por qué', async () => {
    abrirModal({ phone: '351 123' })

    await screen.findByTestId('whatsapp-preview-textarea')
    expect(screen.getByTestId('whatsapp-send-api-button')).toBeDisabled()
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

  it('abrir WhatsApp usa WhatsApp Web, la pestaña estable, y registra "opened" (no "sent")', async () => {
    const aperturas: Array<[string, string]> = []
    const navegaciones: string[] = []
    const pestana = {
      closed: false, opener: undefined as unknown,
      location: { set href(u: string) { navegaciones.push(u) }, get href() { return '' } },
      focus() {},
    }
    vi.stubGlobal('open', vi.fn((url: string, target: string) => {
      aperturas.push([url, target]); return pestana as unknown as Window
    }))

    const user = userEvent.setup()
    abrirModal({ vars: { equipo: 'Galaxy A54' } })

    const textarea = await screen.findByTestId('whatsapp-preview-textarea') as HTMLTextAreaElement
    const boton = screen.getByTestId('whatsapp-send-api-button')
    await waitFor(() => expect(boton).toBeEnabled())

    const mensajeEnPantalla = textarea.value
    estado.ops = []
    await user.click(boton)

    // 1 · desktop (jsdom no es móvil): se abre VACÍA con el nombre estable —
    //     about:blank sigue siendo same-origin y es donde se corta el opener —
    //     y recién ahí se navega a WhatsApp Web. Nunca api.whatsapp.com, que es
    //     la pantalla intermedia que sacaba al usuario de esa pestaña.
    expect(aperturas).toHaveLength(1)
    const [urlApertura, target] = aperturas[0]
    expect(urlApertura).toBe('')
    expect(target).toBe('techrepair_whatsapp')
    expect(target).not.toBe('_blank')

    expect(navegaciones).toHaveLength(1)
    const url = navegaciones[0]
    expect(url.startsWith('https://web.whatsapp.com/send?phone=5493511234567&text=')).toBe(true)
    expect(url).not.toContain('api.whatsapp.com')

    // 2 · el preview es EXACTAMENTE lo que recibe WhatsApp
    expect(decodeURIComponent(url.split('&text=')[1])).toBe(mensajeEnPantalla)

    // 3 · la UI dice "abierto", nunca "enviado"
    const chip = await screen.findByTestId('whatsapp-send-status')
    expect(chip.textContent).toMatch(/abierto/i)
    expect(chip.textContent).not.toMatch(/enviado/i)

    // 4 · el log escrito es `opened`, jamás sent/delivered/read
    await waitFor(() => expect(opsDe('whatsapp_logs').length).toBeGreaterThan(0))
  })

  it('dos mensajes seguidos REUTILIZAN la pestaña: un solo open, la referencia navega', async () => {
    // El nombre de ventana NO alcanza: se resetea al navegar cross-origin
    // (techrepairpro.app → web.whatsapp.com). Lo que se asevera acá es el
    // contrato real: cuántas veces se llamó a open, y adónde se navegó la
    // pestaña ya abierta.
    estado.filas.whatsapp_templates = [
      { id: 't1', business_id: BIZ_A, status_key: 'ready_pickup', status_label: 'Listo para Retirar',
        message_template: 'Hola {nombre}, tu equipo está listo.', auto_send: false, is_active: true },
      { id: 't2', business_id: BIZ_A, status_key: 'received', status_label: 'Recibido',
        message_template: 'Hola {nombre}, recibimos tu equipo.', auto_send: false, is_active: true },
    ]

    const aperturas: Array<[string, string]> = []
    const navegaciones: string[] = []
    let openerSeteado: unknown = 'sin tocar'
    let focos = 0
    const pestana = {
      closed: false,
      set opener(v: unknown) { openerSeteado = v },
      get opener() { return openerSeteado },
      location: { set href(u: string) { navegaciones.push(u) }, get href() { return '' } },
      focus() { focos++ },
    }
    vi.stubGlobal('open', vi.fn((url: string, target: string) => {
      aperturas.push([url, target]); return pestana as unknown as Window
    }))

    const user = userEvent.setup()
    abrirModal()

    const textarea = await screen.findByTestId('whatsapp-preview-textarea') as HTMLTextAreaElement
    const boton = screen.getByTestId('whatsapp-send-api-button')
    await waitFor(() => expect(boton).toBeEnabled())
    await user.click(boton)

    // Segundo mensaje: otra plantilla ⇒ otro texto ⇒ otro destino.
    await user.selectOptions(screen.getByTestId('whatsapp-template-select'), 'received')
    await waitFor(() => expect(textarea.value).toContain('recibimos'))
    await waitFor(() => expect(boton).toBeEnabled())
    await user.click(boton)

    // UN solo open: el segundo mensaje NO estrena pestaña.
    expect(aperturas).toHaveLength(1)
    expect(aperturas[0][0]).toBe('')                       // about:blank
    expect(aperturas[0][1]).toBe('techrepair_whatsapp')
    expect(aperturas[0][1]).not.toBe('_blank')

    // WhatsApp no queda con referencia de vuelta a TechRepair.
    expect(openerSeteado).toBeNull()

    // La MISMA pestaña navegó dos veces, a destinos distintos.
    expect(navegaciones).toHaveLength(2)
    expect(navegaciones[1]).not.toBe(navegaciones[0])
    expect(navegaciones.every(u => u.startsWith('https://web.whatsapp.com/send?'))).toBe(true)
    expect(navegaciones.some(u => u.includes('api.whatsapp.com'))).toBe(false)
    expect(focos).toBe(2)
  })
})
