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
const HOOK = 'src/features/customer-core/useCustomerCore.ts'
const GATE = 'src/features/customer-core/useWholesaleCustomerGate.ts'
const QUICK = 'src/pages/NewOrder.tsx'
// PRE-BETA-3A-2 — autoridad central de acceso a Mayorista (el gate del core delega acá).
const AUTHORITY = 'src/lib/permissions/wholesalePermissions.ts'
const AUTHORITY_HOOK = 'src/hooks/useWholesaleAccess.ts'

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

  // PRE-BETA-3A-2. Qué error se MUESTRA lo decide el core (tocado / intento de
  // envío). Una superficie que vuelve a validar, a llevar su propio "touched" o
  // a pasarle al cuerpo los errores crudos reintroduce el rojo antes de tocar.
  [/validateCustomerCore\(|firstCustomerCoreError\(/, 'validación duplicada fuera del core'],
  [/\bsetTouched\b|\btouched\s*\[|useState<[^>]*[Tt]ouched/, 'estado "touched" propio: la validación visible es del core'],
  [/<CustomerCreateFields\b[^>]*\berrors=\{/, 'errores crudos pasados al cuerpo: rojo antes de interactuar'],
  // Un CTA deshabilitado por validación, con los errores todavía ocultos, es un
  // bloqueo sin explicación. El CTA sólo lo bloquea el guardado en curso.
  [/disabled=\{[^}]*(?:invalid|isValid|[Ee]rrors\)?\.length)/, 'CTA deshabilitado por validación (bloqueo sin explicación visible)'],
  // El gate Mayorista vive en el core. Una superficie que lo recalcula (o lo
  // resuelve por rol) crea una segunda matriz.
  [/hasFeature\(\s*['"]mayorista['"]\s*\)|can\(\s*['"]wholesale['"]\s*\)/, 'gate Mayorista recalculado fuera del core'],
]

/**
 * PRE-BETA-3A-2 — la alta rápida conserva la autoridad de la recepción. Un
 * técnico tiene `orders_create` y NO `customers`, y necesita crear al cliente
 * que tiene enfrente.
 */
const QUICK_FORBIDDEN = [
  [/can\(\s*['"]customers['"]\s*\)/, 'alta rápida gateada por el permiso `customers`'],
]

function inspectSurface(text) {
  return FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(([, label]) => label)
}

function inspectQuick(text) {
  return QUICK_FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(([, label]) => label)
}

/** Las tres superficies montan el cuerpo con el paquete del core, sin armarlo a mano. */
function mountsCoreFieldProps(text) {
  return /<CustomerCreateFields\s+\{\.\.\.\w*[Ff]ieldProps\}/.test(text)
}

/** Gate Mayorista y validación visible: únicos, y en el core. */
function inspectAccess(model, hook, gate) {
  const findings = []

  const gateCode = gate.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  // PRE-BETA-3A-2: el core no decide Mayorista; usa la MISMA decisión que el
  // menú, el guard de ruta y la página.
  if (!/return useWholesaleAccess\(\)\.canAccess\b/.test(gateCode)) {
    findings.push('gate Mayorista no delega en la autoridad central (useWholesaleAccess)')
  }
  if (/hasFeature\(|can\(\s*['"]wholesale['"]\s*\)/.test(gateCode)) {
    findings.push('gate Mayorista recalculado en el core (segunda matriz)')
  }
  if (/\brole\b|isOwner/.test(gateCode)) {
    findings.push('gate Mayorista resuelto por rol hardcodeado')
  }
  if (!/useWholesaleCustomerGate\(\)/.test(hook)) {
    findings.push('el core no resuelve el gate Mayorista')
  }
  if (!/if \(submitCount > 0\) return errors/.test(hook) || !/if \(touched\[field\]\) shown\[field\]/.test(hook)) {
    findings.push('errores visibles sin la regla tocado / intento de envío')
  }
  if (!/\berrors: visibleErrors,/.test(hook)) {
    findings.push('el cuerpo recibe errores crudos: rojo antes de interactuar')
  }
  if (!/storedType === 'mayorista' \? 'preserved' : 'retail'/.test(model)) {
    findings.push('un mayorista existente sin gate deja de quedar `preserved` (conversión silenciosa)')
  }
  if (!/access === 'full' \? values : effectiveCustomerCoreValues\(values, 'retail'\)/.test(model)) {
    findings.push('toCreatePayload no garantiza minorista sin gate')
  }
  if (!/if \(access === 'preserved'\) return common\b/.test(model)) {
    findings.push('la edición `preserved` vuelve a escribir tipo o datos mayoristas')
  }
  return findings
}

/**
 * PRE-BETA-3A-2 — contrato de la autoridad central de Mayorista:
 * feature Y (owner | admin | capacidad `wholesale`), owner/admin sin depender de
 * `can('wholesale')`, y cerrada hasta tener la suscripción confirmada.
 */
function inspectAuthority(engine, hook) {
  const findings = []
  if (!/WHOLESALE_AUTOMATIC_ROLES: readonly BusinessRole\[\] = \[\s*'owner', 'admin',\s*\] as const/.test(engine)) {
    findings.push('roles automáticos de Mayorista distintos de owner/admin')
  }
  if (!/if \(!hasAutomaticWholesaleAccess\(input\.role\) && input\.hasWholesaleCapability !== true\) \{/.test(engine)) {
    findings.push('owner/admin dependen de la capacidad `wholesale` (un override false los deja afuera)')
  }
  if (!/if \(input\.hasMayoristaFeature !== true\) return 'plan_required'/.test(engine)) {
    findings.push('acceso Mayorista sin la feature `mayorista` del negocio')
  }
  if (!/const decision = decideWholesaleAccess\(input\)/.test(hook)) {
    findings.push('useWholesaleAccess no usa la decisión central')
  }
  if (!/const hasMayoristaFeature = !loading && subscription != null && hasFeature\('mayorista'\)/.test(hook)) {
    findings.push('gate Mayorista abierto sin suscripción confirmada (el trial optimista ya trae Mayorista)')
  }
  return findings
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
  // PRE-BETA-3A-2: la única excepción admitida es `preserved`, donde la
  // edición no escribe tipo ni razón social. Cualquier otra condición la debilita.
  if (!/if \((?:access !== 'preserved' && )?values\.customerType === 'mayorista' && !text\(values\.businessName\)\)/.test(model)) {
    findings.push('regla de mayorista condicionada a algo más que `preserved`')
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

/** Mutación que TIENE que cambiar el texto: un replace mudo haría pasar el self-test en falso. */
function mutate(text, from, to) {
  const next = text.replace(from, to)
  if (next === text) throw new Error(`self-test: la mutación no aplicó (${String(from).slice(0, 60)})`)
  return next
}

if (process.argv.includes('--self-test')) {
  const model = read(CORE)
  const document = read(DOCUMENT)
  const hook = read(HOOK)
  const gate = read(GATE)
  const quick = read(QUICK)
  const engine = read(AUTHORITY)
  const authorityHook = read(AUTHORITY_HOOK)

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
  // PRE-BETA-3A-2
  expectSurface('if (submitLock.current || firstCustomerCoreError(errors)) return', 'validación duplicada')
  expectSurface("const errors = validateCustomerCore(values, 'create')", 'validación duplicada')
  expectSurface('const [touched, setTouched] = useState<Record<string, boolean>>({})', 'touched')
  expectSurface('<CustomerCreateFields values={values} errors={errors} setField={setField} />', 'errores crudos')
  expectSurface('<AppButton type="submit" loading={saving} disabled={invalid}>', 'CTA deshabilitado')
  expectSurface('disabled={editLoading || Object.keys(editErrors).length > 0}', 'CTA deshabilitado')
  expectSurface("const offer = hasFeature('mayorista') && role === 'owner'", 'gate Mayorista recalculado')

  const clean = inspectSurface(SURFACES.map(([path]) => read(path)).join('\n'))
  if (clean.length) throw new Error(`self-test falso positivo en superficies: ${clean.join(', ')}`)
  for (const [path] of SURFACES) {
    if (!mountsCoreFieldProps(read(path))) throw new Error(`self-test: ${path} no monta fieldProps`)
  }
  if (mountsCoreFieldProps('<CustomerCreateFields values={values} errors={visibleErrors} />')) {
    throw new Error('self-test no detectó: cuerpo armado a mano')
  }

  if (!inspectQuick("onCreateNew={can('customers') ? () => setQuickOpen(true) : undefined}").length) {
    throw new Error('self-test no detectó: alta rápida gateada por customers')
  }
  if (inspectQuick(quick).length) throw new Error('self-test falso positivo en la alta rápida')

  const expectCore = (mutatedModel, mutatedDocument, label) => {
    const hits = inspectCore(mutatedModel, mutatedDocument)
    if (!hits.some((hit) => hit.includes(label))) {
      throw new Error(`self-test no detectó: ${label}`)
    }
  }
  expectCore(
    mutate(
      model,
      "values.customerType === 'mayorista' && !text(values.businessName)",
      "mode === 'create' && values.customerType === 'mayorista' && !text(values.businessName)"
    ),
    document,
    'limitada a create'
  )
  expectCore(
    mutate(model, "if (access !== 'preserved' && values.customerType", "if (access === 'full' && values.customerType"),
    document,
    'condicionada a algo más'
  )
  expectCore(mutate(model, 'business_name: orNull(businessName)', 'business_name: orUndefined(businessName)'), document, 'null explícito')
  expectCore(model, mutate(document, 'return `${type.toUpperCase()} ${body}`', 'return body'), 'formato canónico')
  expectCore(model, mutate(document, "customerType === 'mayorista' ? 'cuit' : 'dni'", "'dni'"), 'default DNI/CUIT')

  if (inspectCore(model, document).length) {
    throw new Error('self-test falso positivo en el core')
  }

  const expectAccess = ([mutatedModel, mutatedHook, mutatedGate], label) => {
    const hits = inspectAccess(mutatedModel, mutatedHook, mutatedGate)
    if (!hits.some((hit) => hit.includes(label))) {
      throw new Error(`self-test no detectó: ${label}`)
    }
  }
  expectAccess([model, hook, mutate(gate, 'return useWholesaleAccess().canAccess', "return hasFeature('mayorista') && can('wholesale')")], 'no delega en la autoridad central')
  expectAccess([model, hook, mutate(gate, 'return useWholesaleAccess().canAccess', "return useWholesaleAccess().canAccess && can('wholesale')")], 'recalculado en el core')
  expectAccess([model, hook, mutate(gate, 'return useWholesaleAccess().canAccess', "const { role } = useAuth()\n  return useWholesaleAccess().canAccess || role === 'owner'")], 'rol hardcodeado')
  expectAccess([model, mutate(hook, 'useWholesaleCustomerGate()', 'true'), gate], 'no resuelve el gate')
  expectAccess([model, mutate(hook, 'if (submitCount > 0) return errors', 'return errors'), gate], 'tocado / intento')
  expectAccess([model, mutate(hook, '    errors: visibleErrors,\n', '    errors,\n'), gate], 'errores crudos')
  expectAccess([mutate(model, "storedType === 'mayorista' ? 'preserved' : 'retail'", "'retail'"), hook, gate], 'conversión silenciosa')
  expectAccess([mutate(model, "access === 'full' ? values : effectiveCustomerCoreValues(values, 'retail')", 'values'), hook, gate], 'minorista sin gate')
  expectAccess([mutate(model, "if (access === 'preserved') return common", "if (access === 'preserved') return { ...common, business_name: null }"), hook, gate], '`preserved` vuelve a escribir')

  if (inspectAccess(model, hook, gate).length) {
    throw new Error(`self-test falso positivo en gate/validación visible: ${inspectAccess(model, hook, gate).join(', ')}`)
  }

  const expectAuthority = ([mutatedEngine, mutatedHook], label) => {
    const hits = inspectAuthority(mutatedEngine, mutatedHook)
    if (!hits.some((hit) => hit.includes(label))) {
      throw new Error(`self-test no detectó: ${label}`)
    }
  }
  expectAuthority([mutate(engine, "'owner', 'admin',\n] as const", "'owner', 'admin', 'manager',\n] as const"), authorityHook], 'roles automáticos')
  expectAuthority([mutate(engine, 'if (!hasAutomaticWholesaleAccess(input.role) && input.hasWholesaleCapability !== true) {', 'if (input.hasWholesaleCapability !== true) {'), authorityHook], 'dependen de la capacidad')
  expectAuthority([mutate(engine, "if (input.hasMayoristaFeature !== true) return 'plan_required'", "if (false) return 'plan_required'"), authorityHook], 'sin la feature')
  expectAuthority([engine, mutate(authorityHook, 'const decision = decideWholesaleAccess(input)', "const decision = can('wholesale') ? 'allowed' : 'actor_denied'")], 'no usa la decisión central')
  expectAuthority([engine, mutate(authorityHook, "!loading && subscription != null && hasFeature('mayorista')", "hasFeature('mayorista')")], 'sin suscripción confirmada')

  if (inspectAuthority(engine, authorityHook).length) {
    throw new Error(`self-test falso positivo en la autoridad central: ${inspectAuthority(engine, authorityHook).join(', ')}`)
  }
  console.log('customer-core guard self-test OK: gates de documento, mayorista, limpieza, validación visible, acceso y autoridad central detectados')
  process.exit(0)
}

const failures = []

for (const [path, label] of SURFACES) {
  const text = read(path)
  for (const finding of inspectSurface(text)) failures.push(`${label} (${path}): ${finding}`)
  if (!/from '(?:\.\.\/)+features\/customer-core'/.test(text)) {
    failures.push(`${label} (${path}): no consume el customer core`)
  }
  if (!mountsCoreFieldProps(text)) {
    failures.push(`${label} (${path}): no monta el cuerpo con el paquete fieldProps del core`)
  }
}

for (const finding of inspectQuick(read(QUICK))) failures.push(`alta rápida (${QUICK}): ${finding}`)
for (const finding of inspectCore(read(CORE), read(DOCUMENT))) failures.push(`core: ${finding}`)
for (const finding of inspectAccess(read(CORE), read(HOOK), read(GATE))) failures.push(`core: ${finding}`)
for (const finding of inspectAuthority(read(AUTHORITY), read(AUTHORITY_HOOK))) failures.push(`autoridad Mayorista: ${finding}`)

if (failures.length) {
  console.error('UI-CONSISTENCY-1 / PRE-BETA-3A-2 guard FAIL:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('UI-CONSISTENCY-1 / PRE-BETA-3A-2 guard OK: las tres superficies montan el core; documento, regla de mayorista, limpieza, validación visible y gate Mayorista intactos.')
