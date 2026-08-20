// ─────────────────────────────────────────────────────────────────────────────
// Política de privacidad — página pública.
//
// Dos propiedades que no pueden volver a romperse:
//
// 1. La página es PÚBLICA. Si cayera detrás de ProtectedRoute, un visitante
//    anónimo terminaría en /login y la URL sería inservible — justo para quien
//    la necesita: un revisor del Chrome Web Store, que no tiene cuenta.
// 2. Los enlaces legales APUNTAN a algo. Estuvieron en `href="#"` desde
//    siempre: la pantalla de registro prometía dos documentos inexistentes.
//
// Y el contenido tiene que decir lo incómodo: que el mensaje llega a Meta, que
// la navegación queda en el historial, y que la aplicación guarda el texto.
// Una política que sólo enumera lo que NO se hace es la que hace que la
// rechacen.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const navegaciones = vi.hoisted(() => [] as string[])

vi.mock('react-router-dom', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-router-dom')>()
  return { ...real, useNavigate: () => (r: string) => { navegaciones.push(r) } }
})

import { Privacidad } from '../../src/pages/Privacidad'

const montar = () => render(<MemoryRouter><Privacidad /></MemoryRouter>)
const texto = () => (screen.getByTestId('pagina-privacidad').textContent ?? '')

beforeEach(() => { navegaciones.length = 0 })

describe('política de privacidad · es pública', () => {

  it('se renderiza sin sesión, sin contexto de auth y sin layout de la app', () => {
    // No monta AuthProvider ni MainLayout a propósito: si la página dependiera
    // de una sesión, este render explotaría.
    expect(() => montar()).not.toThrow()
    expect(screen.getByTestId('pagina-privacidad')).toBeVisible()
  })

  it('tiene un encabezado que la identifica', () => {
    montar()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/política de privacidad/i)
  })
})

describe('política de privacidad · dice lo incómodo', () => {

  it('declara que el destinatario efectivo es WhatsApp/Meta', () => {
    montar()
    expect(texto()).toMatch(/WhatsApp \(Meta\)|infraestructura de Meta/i)
  })

  it('declara que la navegación queda en el historial del navegador', () => {
    // «No toca el historial» era falso: tabs.update es una navegación real y
    // Chrome la asienta con el teléfono y el mensaje en la URL.
    const t = (montar(), texto())
    expect(t).toMatch(/historial/i)
    expect(t).toMatch(/restauración de sesión|sincroniza/i)
    expect(t, 'no puede volver a afirmar que no toca el historial').not.toMatch(/no toca[^.]{0,30}historial/i)
  })

  it('declara que la APLICACIÓN guarda el teléfono y el texto del mensaje', () => {
    // Es lo que faltaba en todas las redacciones: la extensión no guarda, pero
    // la app sí. Omitirlo sería la clase de omisión que se lee como engañosa.
    const t = (montar(), texto())
    expect(t).toMatch(/registra el número de teléfono y el/i)
    expect(t).toMatch(/texto completo del mensaje/i)
  })

  it('incluye la declaración de Limited Use, que el Store exige literal', () => {
    montar()
    expect(texto()).toMatch(/Limited Use/)
    expect(texto()).toMatch(/cumple con la política/i)
  })

  it('declara el permiso solicitado y qué avisa Chrome al instalar', () => {
    const t = (montar(), texto())
    expect(t).toMatch(/web\.whatsapp\.com/)
    expect(t).toMatch(/leer y cambiar tus datos/i)
  })

  it('no promete afiliación con Meta', () => {
    montar()
    expect(texto()).toMatch(/no está afiliado a WhatsApp ni a Meta/i)
  })

  it('dice que el envío lo hace la persona', () => {
    montar()
    expect(texto()).toMatch(/bot[oó]n Enviar lo apret[aá]s vos/i)
  })
})

describe('política de privacidad · contacto fail-closed', () => {

  it('sin casilla configurada NO inventa una dirección', () => {
    // `VITE_CONTACT_EMAIL` está vacía en el repo. Publicar un mailto que nadie
    // lee sería peor que no publicar ninguno.
    montar()
    expect(screen.queryByTestId('privacidad-contacto')).toBeNull()
    expect(screen.getByTestId('privacidad-contacto-pendiente')).toBeVisible()
    expect(texto()).not.toMatch(/mailto:/)
  })
})

describe('política de privacidad · sección del Companion', () => {

  it('la extensión tiene su propia sección, enlazable', () => {
    montar()
    const seccion = screen.getByTestId('privacidad-companion')
    expect(seccion).toBeVisible()
    expect(seccion.getAttribute('id')).toBe('whatsapp-companion')
  })

  it('enumera exactamente los dos datos que recibe', () => {
    const t = (montar(), texto())
    expect(t).toMatch(/número de teléfono del destinatario/i)
    expect(t).toMatch(/texto del mensaje que preparaste/i)
    expect(t).toMatch(/no recibe ningún otro dato/i)
  })

  it('dice que no guarda, no manda a servidores nuestros y no vende', () => {
    const t = (montar(), texto())
    expect(t).toMatch(/no los guarda/i)
    expect(t).toMatch(/no los envía a ningún servidor nuestro/i)
    expect(t).toMatch(/no los vende/i)
  })
})
