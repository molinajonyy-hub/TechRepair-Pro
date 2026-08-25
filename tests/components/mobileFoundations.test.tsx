import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  AppInput,
  CompactList,
  MobileActionBar,
  OverflowMenu,
  ResponsiveDialog,
} from '../../src/ui'
import { UpdateBanner } from '../../src/components/UpdateBanner'
import { useKeyboardAwareBottomOffset } from '../../src/hooks/useKeyboardAwareBottomOffset'

const updateDetector = vi.hoisted(() => ({
  updateAvailable: true,
  reload: vi.fn(),
}))

vi.mock('../../src/hooks/useUpdateDetector', () => ({
  useUpdateDetector: () => updateDetector,
}))

class FakeVisualViewport extends EventTarget {
  height = 800
  offsetTop = 0
}

function KeyboardProbe() {
  const offset = useKeyboardAwareBottomOffset()
  return <output data-testid="keyboard-offset">{offset}</output>
}

const here = dirname(fileURLToPath(import.meta.url))

describe('MOBILE-0 · foundations compartidas', () => {
  let visualViewport: FakeVisualViewport

  beforeEach(() => {
    visualViewport = new FakeVisualViewport()
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    })
    updateDetector.updateAvailable = true
    updateDetector.reload.mockReset()
  })

  afterEach(() => {
    document.body.style.overflow = ''
  })

  it('calcula el teclado desde visualViewport y vuelve a cero al cerrarlo', () => {
    render(<KeyboardProbe />)
    expect(screen.getByTestId('keyboard-offset')).toHaveTextContent('0')

    visualViewport.height = 520
    act(() => visualViewport.dispatchEvent(new Event('resize')))
    expect(screen.getByTestId('keyboard-offset')).toHaveTextContent('280')

    visualViewport.height = 800
    act(() => visualViewport.dispatchEvent(new Event('scroll')))
    expect(screen.getByTestId('keyboard-offset')).toHaveTextContent('0')
  })

  it('expone el offset de teclado en MobileActionBar y limita la API a dos acciones', () => {
    render(
      <MobileActionBar
        primaryAction={<button>Guardar</button>}
        secondaryAction={<button>Cancelar</button>}
      />,
    )

    visualViewport.height = 500
    act(() => visualViewport.dispatchEvent(new Event('resize')))

    const actionBar = screen.getByTestId('mobile-action-bar')
    expect(actionBar.style.getPropertyValue('--mobile-keyboard-offset')).toBe('300px')
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it.each(['centered', 'sheet', 'fullscreen'] as const)(
    'ResponsiveDialog declara el modo %s con diálogo modal y cierre accesible',
    mode => {
      const onClose = vi.fn()
      const { unmount } = render(
        <ResponsiveDialog
          isOpen
          onClose={onClose}
          title="Contrato mobile"
          mobilePresentation={mode}
          footer={<button>Confirmar</button>}
        >
          <input aria-label="Campo" />
        </ResponsiveDialog>,
      )

      const dialog = screen.getByRole('dialog', { name: 'Contrato mobile' })
      expect(dialog).toHaveAttribute('data-mobile-presentation', mode)
      expect(screen.getByRole('button', { name: 'Cerrar' })).toHaveStyle({ minWidth: '44px', minHeight: '44px' })
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledOnce()
      unmount()
      expect(document.body.style.overflow).toBe('')
    },
  )

  it('prepara semántica segura sin type=number para DNI y montos', () => {
    render(
      <>
        <AppInput label="DNI" semantic="numeric" />
        <AppInput label="Monto" semantic="decimal" />
        <AppInput label="Teléfono" semantic="tel" />
      </>,
    )
    expect(screen.getByLabelText('DNI')).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText('DNI')).toHaveAttribute('inputmode', 'numeric')
    expect(screen.getByLabelText('Monto')).toHaveAttribute('inputmode', 'decimal')
    expect(screen.getByLabelText('Teléfono')).toHaveAttribute('autocomplete', 'tel')
  })

  it('CompactList permite selección por teclado y un overflow menu touch-friendly', () => {
    const select = vi.fn()
    const remove = vi.fn()
    render(
      <CompactList
        items={[{
          id: '1',
          primary: 'Notebook Dell',
          secondary: 'Serie 123',
          amount: '$ 25.000',
          onSelect: select,
          accessibleLabel: 'Abrir Notebook Dell',
          trailingAction: (
            <OverflowMenu
              label="Acciones de Notebook Dell"
              actions={[
                { label: 'Editar', onSelect: vi.fn() },
                { label: 'Eliminar', onSelect: remove, destructive: true },
              ]}
            />
          ),
        }]}
      />,
    )

    fireEvent.keyDown(screen.getByRole('link', { name: 'Abrir Notebook Dell' }), { key: 'Enter' })
    expect(select).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Notebook Dell' }))
    expect(screen.getByRole('menu')).toBeVisible()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Eliminar' }))
    expect(remove).toHaveBeenCalledOnce()
  })

  it('UpdateBanner usa el rail coordinado y acciones con target contractual', () => {
    render(<UpdateBanner />)
    const banner = screen.getByTestId('update-banner')
    expect(banner).toHaveClass('update-banner')
    expect(banner).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: 'Actualizar' })).toHaveClass('mobile-touch-target')
    expect(screen.getByRole('button', { name: 'Cerrar aviso de actualización' })).toHaveClass('mobile-touch-target')
  })

  it('CSS fija safe-area, dvh, inputs 16px, touch 44 y reduced-motion', () => {
    const css = readFileSync(join(here, '../../src/index.css'), 'utf8')
    expect(css).toContain('env(safe-area-inset-bottom')
    expect(css).toContain('100dvh')
    expect(css).toMatch(/--mobile-touch-target:\s*44px/)
    expect(css).toMatch(/font-size:\s*16px/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
