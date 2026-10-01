// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-3A-2 — el borde rojo de error se perdía en tema claro.
//
// index.css remapea en tema claro TODO `input[style]`/`select[style]`/
// `textarea[style]` legacy a `--input-border` con `!important`. AppInput
// marcaba el error con la clase `border-error` Y con un `borderColor` inline:
// el inline le daba al campo un atributo `style`, eso lo metía en el remap, y
// el borde quedaba neutro. AppSelect/AppTextarea sólo tenían el inline.
//
// Contrato:
// - El error viaja por la clase `border-error` + `aria-invalid="true"`.
// - Un campo con error no agrega atributo `style` propio.
// - El `style` del consumidor pasa intacto, sin `border-color` inyectado.
// - Para `error + style`, index.css tiene una excepción scopeada a
//   `.border-error` que va DESPUÉS del remap (misma especificidad: gana por
//   orden). El remap legacy queda intacto: protege decenas de campos viejos.
//
// Límite honesto: jsdom no resuelve la cascada (y esta config corre con
// `css: false`), así que acá NO se afirma el color computado. Eso se midió con
// Playwright sobre la app real y un harness en ambos temas (PRE-BETA-3A-2):
// light rgba(15,23,42,.12) → rgb(220,38,38); dark rgb(248,113,113) sin cambio.
// Este archivo fija el contrato estructural que hace verdadera esa medición.
// ─────────────────────────────────────────────────────────────────────────────
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AppInput, AppSelect, AppTextarea } from '../../src/ui/components/AppInput'

const OPTIONS = [{ value: 'a', label: 'A' }]
const CONSUMER_STYLE: React.CSSProperties = { textAlign: 'right', minWidth: '10px' }

function renderField(kind: 'input' | 'select' | 'textarea', props: { error?: string; style?: React.CSSProperties }) {
  const { container } = render(
    kind === 'input' ? <AppInput id="f" label="Campo" {...props} />
      : kind === 'select' ? <AppSelect id="f" label="Campo" options={OPTIONS} {...props} />
        : <AppTextarea id="f" label="Campo" {...props} />,
  )
  const field = container.querySelector<HTMLElement>('#f')
  if (!field) throw new Error(`no se renderizó el ${kind}`)
  return field
}

describe.each(['input', 'select', 'textarea'] as const)('PRE-BETA-3A-2 · error de %s', kind => {
  it('error sin style: border-error + aria-invalid="true", sin atributo style', () => {
    const field = renderField(kind, { error: 'Obligatorio' })
    expect(field.classList.contains('border-error')).toBe(true)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(field.hasAttribute('style')).toBe(false)
  })

  it('error + style del consumidor: border-error + aria-invalid="true", style intacto y sin border-color inyectado', () => {
    const field = renderField(kind, { error: 'Obligatorio', style: CONSUMER_STYLE })
    expect(field.classList.contains('border-error')).toBe(true)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(field.style.textAlign).toBe('right')
    expect(field.style.minWidth).toBe('10px')
    expect(field.style.borderColor).toBe('')
  })

  it('sin error: ni border-error ni style', () => {
    const field = renderField(kind, {})
    expect(field.classList.contains('border-error')).toBe(false)
    expect(field.getAttribute('aria-invalid')).toBe('false')
    expect(field.hasAttribute('style')).toBe(false)
  })

  it('style del consumidor sin error: pasa intacto y sin border-error', () => {
    const field = renderField(kind, { style: CONSUMER_STYLE })
    expect(field.classList.contains('border-error')).toBe(false)
    expect(field.style.textAlign).toBe('right')
    expect(field.style.minWidth).toBe('10px')
  })
})

describe('PRE-BETA-3A-2 · index.css: excepción de error frente al remap legacy', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const css = readFileSync(join(here, '../../src/index.css'), 'utf8')
  const REMAP = /\[data-theme="light"\] :is\(input\[style\], select\[style\], textarea\[style\]\):not\(\[data-theme="dark"\], \[data-theme="dark"\] \*, \.cpm-root, \.cpm-root \*\) \{\s*color: var\(--text-primary\) !important;\s*background-color: var\(--input-bg\) !important;\s*border-color: var\(--input-border\) !important;\s*\}/
  const EXCEPTION = /\[data-theme="light"\] \.border-error:is\(\s*input\[style\],\s*select\[style\],\s*textarea\[style\]\s*\) \{\s*border-color: var\(--error\) !important;\s*\}/

  it('el remap legacy sigue intacto', () => {
    expect(REMAP.test(css)).toBe(true)
  })

  it('la excepción existe, sólo toca border-color y va DESPUÉS del remap', () => {
    const remapAt = css.search(REMAP)
    const exceptionAt = css.search(EXCEPTION)
    expect(remapAt).toBeGreaterThan(-1)
    expect(exceptionAt).toBeGreaterThan(remapAt)
  })
})
