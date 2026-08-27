/**
 * Contrato del sistema de temas Light/Dark:
 *
 *  1. index.html aplica el tema ANTES del primer paint (script inline) con la
 *     misma clave y el mismo default que ThemeContext — si se desincronizan,
 *     hay flash de tema incorrecto al cargar.
 *  2. ThemeContext: default "light" cuando no hay preferencia guardada,
 *     lee/escribe localStorage y aplica data-theme en documentElement.
 *  3. index.css define los dos sets de tokens (dark default + [data-theme="light"]).
 *
 * Nota: NO se importa ThemeContext.tsx directamente porque es JSX y requiere
 * DOM; se verifica el contrato sobre el código fuente como texto, igual que
 * landing-structured-data.test.ts.
 *
 * Runner: node:test nativo.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf-8')
const themeCtx = readFileSync(new URL('../../src/contexts/ThemeContext.tsx', import.meta.url), 'utf-8')
const indexCss = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf-8')
const setupChecklist = readFileSync(new URL('../../src/components/onboarding/SetupChecklist.tsx', import.meta.url), 'utf-8')

const THEME_KEY = 'techrepair_theme'

test('index.html: script pre-paint aplica data-theme con default light', () => {
  const script = /<script>[\s\S]*?<\/script>/.exec(html)?.[0] ?? ''
  assert.ok(script.includes(`localStorage.getItem('${THEME_KEY}')`), 'El script inline debe leer la clave techrepair_theme')
  assert.match(script, /var theme = 'light'/, 'El default pre-paint debe ser light')
  assert.ok(script.includes("setAttribute('data-theme', theme)"), 'Debe aplicar data-theme en documentElement')
  assert.ok(script.includes('prefers-color-scheme'), 'Debe resolver el modo system con prefers-color-scheme')
})

test('ThemeContext: usa la misma clave de storage que el script pre-paint', () => {
  assert.ok(themeCtx.includes(`const THEME_KEY = '${THEME_KEY}'`), 'ThemeContext debe usar la clave techrepair_theme')
  assert.ok(themeCtx.includes(`localStorage.getItem(THEME_KEY)`), 'getInitialTheme debe leer la preferencia guardada')
  assert.ok(themeCtx.includes(`localStorage.setItem(THEME_KEY, theme)`), 'applyTheme debe persistir la preferencia')
})

test('ThemeContext: default light cuando no hay preferencia guardada', () => {
  const fn = /const getInitialTheme[\s\S]*?\n};/.exec(themeCtx)?.[0] ?? ''
  assert.ok(fn.length > 0, 'Debe existir getInitialTheme')
  assert.match(fn, /return 'light';\s*$/m, 'El fallback de getInitialTheme debe ser light')
  assert.doesNotMatch(fn, /return 'dark'/, 'getInitialTheme no debe forzar dark')
})

test('ThemeContext: aplica data-theme y colorScheme en documentElement', () => {
  assert.ok(themeCtx.includes("root.setAttribute('data-theme', nextResolvedTheme)"), 'Debe setear data-theme')
  assert.ok(themeCtx.includes('root.style.colorScheme = nextResolvedTheme'), 'Debe setear color-scheme')
})

test('index.css: existen los dos sets de tokens (dark default + light)', () => {
  assert.match(indexCss, /:root,\s*\[data-theme="dark"\]\s*\{/, 'Tokens dark en :root/[data-theme="dark"]')
  assert.match(indexCss, /\[data-theme="light"\]\s*\{/, 'Tokens light en [data-theme="light"]')
  for (const token of ['--bg-primary', '--text-primary', '--accent-primary', '--input-bg', '--border-color']) {
    const occurrences = indexCss.split(`${token}:`).length - 1
    assert.ok(occurrences >= 2, `El token ${token} debe estar definido en ambos temas`)
  }
})

test('fundaciones compartidas usan tokens de tema y touch target canónicos', () => {
  const iconButton = /\.icon-btn\s*\{([\s\S]*?)\}/.exec(indexCss)?.[1] ?? ''
  const iconButtonHover = /\.icon-btn:hover:not\(:disabled\)\s*\{([\s\S]*?)\}/.exec(indexCss)?.[1] ?? ''

  assert.match(iconButton, /background:\s*var\(--bg-surface\)/)
  assert.match(iconButton, /border:\s*1px solid var\(--border-color\)/)
  assert.match(iconButtonHover, /background:\s*var\(--bg-hover\)/)
  assert.match(indexCss, /@media \(max-width: 1023px\)\s*\{\s*\.icon-btn\s*\{[\s\S]*?min-width:\s*var\(--mobile-touch-target\);[\s\S]*?min-height:\s*var\(--mobile-touch-target\)/)
  assert.match(indexCss, /\.data-table td\s*\{[\s\S]*?border-bottom:\s*1px solid var\(--border-subtle\)/)
  assert.match(indexCss, /\.data-table tbody tr:hover\s*\{\s*background:\s*var\(--bg-hover\)/)
  assert.match(indexCss, /\.intake-pattern\s*\{[^}]*background:\s*var\(--bg-tertiary\)/)
  assert.doesNotMatch(setupChecklist, /var\(--accent(?:,|\))/)
  assert.match(setupChecklist, /var\(--accent-primary\)/)
})
