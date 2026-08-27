#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// UI-CONSISTENCY-1 · Guard del customer core canónico.
//
// Impide que las superficies de cliente vuelvan a divergir: que alguna arme el
// documento a mano, que se pierda la regla de mayorista, o que la edición
// vuelva a mandar `undefined` donde tiene que mandar `null`.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'

const SURFACES = [
  ['src/pages/NewCustomer.tsx', 'alta full page'],
  ['src/pages/NewOrder.tsx', 'alta rápida'],
  ['src/pages/Customers.tsx', 'edición'],
]
const CORE = 'src/features/customer-core/model.ts'
const DOCUMENT = 'src/features/customer-core/document.ts'

const read = (path) => readFileSync(path, 'utf8')

/** Nadie fuera del core puede fabricar el valor de `document`. */
const FORBIDDEN = [
  [/document:\s*`\$\{[^}]*documentType[^}]*\}/, 'documento armado a mano en una superficie'],
  [/document:\s*(?:form|formData|editForm)\.document\s*\|\|/, 'documento persistido crudo, sin normalizar'],
  [/\.toUpperCase\(\)\}\s*:\s*\$\{/, 'prefijo legacy `TIPO: valor` reintroducido'],

  // UI-CONSISTENCY-2A. El par de colores de la época dark-only medía 1.44:1 en
  // tema claro. El selector va por clase canónica (`seg-field-option`), nunca
  // inline.
  [/rgba\(99,\s*102,\s*241,\s*0?\.25\)/, 'color inline legacy del selector DNI/CUIT (1.44:1 en claro)'],
  [/#a5b4fc/i, 'color de texto inline legacy del selector DNI/CUIT'],

  // El motivo de validación se muestra UNA vez, en el campo. Volver a
  // empujarlo al resumen reintroduce el mensaje duplicado.
  [/firstCustomerCoreError\([^)]*\)\s*;?\s*\n?\s*if\s*\(\s*message\s*\)\s*\{\s*set[A-Za-z]*[Ee]rror\(message\)/,
    'mensaje de validación empujado al resumen (duplica el error inline)'],
]

function inspectSurface(text) {
  return FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(([, label]) => label)
}

/** El core sigue siendo la autoridad de las reglas que este lote canonizó. */
function inspectCore(model, document) {
  const findings = []

  if (!/mayorista'\s*&&\s*!text\(values\.businessName\)/.test(model)) {
    findings.push('regla de mayorista ausente en el core')
  }
  // La regla NO puede quedar condicionada al modo: ese era exactamente el bug
  // de la edición, que dejaba crear mayoristas sin razón social.
  if (/mode\s*===\s*'create'\s*&&\s*values\.customerType\s*===\s*'mayorista'/.test(model)) {
    findings.push('regla de mayorista limitada a create: la edición vuelve a quedar sin gate')
  }
  if (!/business_name:\s*orNull\(businessName\)/.test(model)) {
    findings.push('update no borra business_name con null explícito')
  }
  if (!/contact_person:\s*orNull\(contactPerson\)/.test(model)) {
    findings.push('update no borra contact_person con null explícito')
  }
  if (!/return\s+`\$\{type\.toUpperCase\(\)\}\s\$\{body\}`/.test(document)) {
    findings.push('formato canónico del documento alterado')
  }
  if (!/mayorista'\s*\?\s*'cuit'\s*:\s*'dni'/.test(document)) {
    findings.push('default DNI/CUIT por tipo de cliente ausente')
  }
  return findings
}

if (process.argv.includes('--self-test')) {
  const model = read(CORE)
  const document = read(DOCUMENT)

  const expectSurface = (snippet, label) => {
    const hits = inspectSurface(snippet)
    if (!hits.some((hit) => hit.includes(label))) {
      throw new Error(`self-test no detectó: ${label}`)
    }
  }
  expectSurface('document: `${formData.documentType.toUpperCase()}: ${formData.document}`', 'documento armado a mano')
  expectSurface('document: form.document || undefined,', 'documento persistido crudo')
  expectSurface('return `${type.toUpperCase()}: ${body}`', 'prefijo legacy')
  expectSurface("background: sel ? 'rgba(99,102,241,0.25)' : 'transparent',", 'color inline legacy')
  expectSurface("color: sel ? '#a5b4fc' : 'var(--text-subtle)',", 'texto inline legacy')
  expectSurface('const message=firstCustomerCoreError(errors)\n    if(message){setError(message);return}', 'empujado al resumen')

  const clean = inspectSurface(SURFACES.map(([path]) => read(path)).join('\n'))
  if (clean.length) throw new Error(`self-test falso positivo en superficies: ${clean.join(', ')}`)

  const expectCore = (mutatedModel, mutatedDocument, label) => {
    const hits = inspectCore(mutatedModel, mutatedDocument)
    if (!hits.some((hit) => hit.includes(label))) {
      throw new Error(`self-test no detectó: ${label}`)
    }
  }
  expectCore(
    model.replace(
      "if (values.customerType === 'mayorista' && !text(values.businessName))",
      "if (mode === 'create' && values.customerType === 'mayorista' && !text(values.businessName))"
    ),
    document,
    'limitada a create'
  )
  expectCore(model.replace('business_name: orNull(businessName)', 'business_name: orUndefined(businessName)'), document, 'null explícito')
  expectCore(model, document.replace('return `${type.toUpperCase()} ${body}`', 'return body'), 'formato canónico')
  expectCore(model, document.replace("customerType === 'mayorista' ? 'cuit' : 'dni'", "'dni'"), 'default DNI/CUIT')

  if (inspectCore(model, document).length) {
    throw new Error('self-test falso positivo en el core')
  }
  console.log('customer-core guard self-test OK: gates de documento, mayorista y limpieza detectados')
  process.exit(0)
}

const failures = []

for (const [path, label] of SURFACES) {
  const text = read(path)
  for (const finding of inspectSurface(text)) failures.push(`${label} (${path}): ${finding}`)
  if (!/from '(?:\.\.\/)+features\/customer-core'/.test(text)) {
    failures.push(`${label} (${path}): no consume el customer core`)
  }
}

for (const finding of inspectCore(read(CORE), read(DOCUMENT))) failures.push(`core: ${finding}`)

if (failures.length) {
  console.error('UI-CONSISTENCY-1 guard FAIL:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('UI-CONSISTENCY-1 guard OK: las tres superficies consumen el core; documento, regla de mayorista y limpieza intactos.')
