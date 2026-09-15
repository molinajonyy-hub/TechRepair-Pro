#!/usr/bin/env node
/**
 * ARCA SELF-SERVICE · PHASE 2B — guard estático del asistente en el navegador.
 *
 *  B1  el navegador nunca pide tickets WSAA: sin invoke('afip-wsaa'), sin force_refresh y sin el
 *      viejo testConnection/"Probar conexión" (forzaba un LoginCms con un ticket vigente).
 *  B2  el asistente no guarda progreso propio ni habla con Supabase: los módulos del asistente no
 *      usan localStorage/sessionStorage/indexedDB/supabase/fetch; los componentes no importan el
 *      servicio del Edge (sólo a través de useArcaSetupActions).
 *  B3  la pantalla sale del estado canónico: el asistente deriva la vista con deriveArcaSetupWizard y
 *      "Verificar"/"Terminar activación" sólo se renderizan bajo view.actions.includes('verify').
 *  B4  la UI no nombra material secreto (token, sign, fingerprint, secret ids, Vault, clave de firma).
 *  B5  las respuestas del Edge pasan por la capa central de errores (describeArcaSetupError) y el
 *      certificado se clasifica localmente (readArcaCertificateFile) antes de enviarse.
 *  B6  el estado se relee al volver el foco, la red, la visibilidad y al vencer la espera.
 *  B7  Settings monta ArcaSetupPanel con useArcaSelfServiceStatus y no conserva arca-test-connection.
 *  B8  el modal del asistente es pantalla completa en mobile y no se cierra tocando el fondo.
 *  B9  copy honesto: (a) ningún texto del asistente, la guía o la tarjeta de estado promete una emisión
 *      que Phase 2B no verificó (no emite, no pide CAE); (b) la entrada y la guía aclaran que la Clave Fiscal
 *      se usa en ARCA y que TechRepair Pro nunca la pide ni la guarda; (c) no existe ningún campo de
 *      Clave Fiscal ni de contraseña en el asistente.
 *  B10 nombre del equipo por ambiente (smoke real WSASS 2026-09-15): arcaFiscalInput declara
 *      ARCA_ALIAS_PATTERNS { homologacion, produccion } y, por COMPORTAMIENTO, homologación sólo acepta
 *      letras y números (3..50) y producción conserva la regla anterior; aliasError recibe el ambiente;
 *      la sugerencia automática no genera '.' ni '-'. (La comparación con el servidor la hace
 *      scripts/guards/arca-wsass-alias-contract.mjs cuando la migración está en el árbol.)
 *  B11 un solo indicador de paso: sin barra de progreso (intake-progress / progressbar) ni "Paso N de 6"
 *      en el subtítulo del modal; "Paso … de" aparece una única vez en el asistente.
 *  B12 guía de homologación y error del nombre: la guía dice que el nombre lleva sólo letras y números,
 *      que un DN existente usa «agregar certificado a DN existente» y que la autorización WSFE se conserva;
 *      CERTIFICATE_ALIAS_MISMATCH explica cómo generar el certificado y agrega el detalle de homologación.
 *
 *   node scripts/guards/arca-phase2b-wizard-contract.mjs [--self-test]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const UI_DIR = 'src/components/settings/arca-setup'
const STATUS_HOOK = 'src/hooks/useArcaSelfServiceStatus.ts'
const ACTIONS_HOOK = 'src/hooks/useArcaSetupActions.ts'
const WIZARD = `${UI_DIR}/ArcaSetupWizard.tsx`
const PANEL = `${UI_DIR}/ArcaSetupPanel.tsx`
const SETTINGS = 'src/pages/Settings.tsx'
const STATUS_LIB = 'src/lib/arcaStatus.ts'
const GUIDE = 'src/lib/arcaSetupGuide.ts'
const FISCAL_INPUT = 'src/lib/arcaFiscalInput.ts'
const ERRORS_LIB = 'src/lib/arcaSetupErrors.ts'
const PURE = ['src/lib/arcaSetupWizard.ts', 'src/lib/arcaSetupErrors.ts', 'src/lib/arcaFiscalInput.ts', 'src/lib/arcaCertificateFile.ts', 'src/lib/arcaSetupGuide.ts']

const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

function diskTree() {
  return {
    read: (p) => readFileSync(p, 'utf8'),
    exists: (p) => existsSync(p),
    listSrc: () => walk('src'),
    listUi: () => walk(UI_DIR),
  }
}

export function check(tree) {
  const out = []
  const code = (p) => stripJs(tree.read(p))

  // ── B1 ──
  for (const file of tree.listSrc()) {
    const c = code(file)
    if (/invoke\(\s*['"`]afip-wsaa['"`]/.test(c) || /\/functions\/v1\/afip-wsaa\b/.test(c)) out.push(`B1 ${file} pide tickets a afip-wsaa desde el navegador`)
    // `force_refresh` es el campo del body de afip-wsaa; `forceRefresh` sólo cuenta en código ARCA
    // (el dashboard tiene su propio forceRefresh de caché, ajeno a ARCA).
    if (/\bforce_refresh\b/.test(c) || (/arca|afip|wsaa/i.test(file) && /\bforceRefresh\b/.test(c))) out.push(`B1 ${file} fuerza un ticket WSAA nuevo`)
    if (/\btestConnection\b|handleTestArcaConnection|arca-test-connection/.test(c) && /arca/i.test(file)) out.push(`B1 ${file} conserva el "Probar conexión" que forzaba ARCA`)
  }
  if (tree.exists(SETTINGS) && /\btestConnection\b|handleTestArcaConnection|arca-test-connection|Probar conexión/.test(code(SETTINGS))) {
    out.push('B1 Settings conserva el "Probar conexión" que forzaba ARCA')
  }

  // ── B2 ──
  const wizardModules = [...tree.listUi(), STATUS_HOOK, ACTIONS_HOOK, ...PURE]
  for (const file of wizardModules) {
    if (!tree.exists(file)) { out.push(`B2 falta ${file}`); continue }
    const c = code(file)
    if (/localStorage|sessionStorage|indexedDB/.test(c)) out.push(`B2 ${file} guarda progreso propio en el navegador`)
    if (/from\s+['"][^'"]*lib\/supabase['"]|\.rpc\(|functions\.invoke|\bfetch\(/.test(c)) out.push(`B2 ${file} habla con el backend por fuera de los servicios`)
  }
  for (const file of tree.listUi()) {
    if (/from\s+['"][^'"]*services\/arcaSetupService['"]/.test(code(file)) && !/^\s*import\s+type\b/m.test(code(file).match(/.*services\/arcaSetupService.*/)?.[0] ?? '')) {
      out.push(`B2 ${file} llama al servicio del Edge sin pasar por useArcaSetupActions`)
    }
  }
  if (tree.exists(STATUS_HOOK) && !/ArcaService\.getSelfServiceStatus\(/.test(code(STATUS_HOOK))) out.push('B2 useArcaSelfServiceStatus debe leer por ArcaService.getSelfServiceStatus')

  // ── B3 ──
  if (tree.exists(WIZARD)) {
    const c = code(WIZARD)
    if (!/useMemo\(\(\) => deriveArcaSetupWizard\(status\), \[status\]\)/.test(c)) out.push('B3 el asistente debe derivar la vista con deriveArcaSetupWizard(status)')
    for (const id of ['arca-setup-verify', 'arca-setup-activate']) {
      let at = c.indexOf(`data-testid="${id}"`)
      if (at < 0 && id === 'arca-setup-verify') out.push('B3 falta el botón de verificar')
      while (at >= 0) {
        // El botón tiene que estar dentro de un bloque condicionado por la acción permitida.
        const before = c.slice(Math.max(0, at - 700), at)
        const all = c.slice(0, at)
        const lastCase = all.slice(all.lastIndexOf("case '")).match(/^case '([a-z_]+)'/)?.[1]
        // finalizar_activacion sólo existe con actions = ['verify', 'cancel'] (contrato de Phase 2A).
        const screenGuard = id === 'arca-setup-activate' && lastCase === 'finalizar_activacion'
        if (!/view\.actions\.includes\('verify'\)\s*&&/.test(before) && !screenGuard) out.push(`B3 ${id} se renderiza sin view.actions.includes('verify')`)
        at = c.indexOf(`data-testid="${id}"`, at + 1)
      }
    }
  }

  // ── B4 ──
  const LEAK = /\b(token|sign|fingerprint|secret_id|private_key_secret_id|signing_key_pem|verification_attempt_id|wsaa_token|wsaa_sign|vault)\b/i
  for (const file of [...tree.listUi(), STATUS_HOOK, ACTIONS_HOOK]) {
    if (!tree.exists(file)) continue
    const m = code(file).match(LEAK)
    if (m) out.push(`B4 ${file} nombra material secreto: ${m[0]}`)
  }

  // ── B5 ──
  if (tree.exists(ACTIONS_HOOK)) {
    const c = code(ACTIONS_HOOK)
    if (!/describeArcaSetupError\(result\.state\)/.test(c)) out.push('B5 las fallas del Edge deben pasar por describeArcaSetupError')
    const read = c.indexOf('readArcaCertificateFile(')
    const sendPem = c.indexOf('attachCertificatePem(')
    const sendDer = c.indexOf('attachCertificateDerBase64(')
    if (read < 0 || sendPem < read || sendDer < read) out.push('B5 el certificado debe clasificarse localmente antes de enviarse')
  }
  for (const file of tree.listUi()) {
    if (/\{\s*(result|error)\.state\s*\}/.test(code(file))) out.push(`B5 ${file} muestra un código crudo`)
  }

  // ── B6 ──
  if (tree.exists(STATUS_HOOK)) {
    const c = code(STATUS_HOOK)
    for (const ev of ["'focus'", "'online'", "'visibilitychange'"]) if (!c.includes(`addEventListener(${ev}`)) out.push(`B6 useArcaSelfServiceStatus no relee en ${ev}`)
    if (!/nextArcaStatusRefreshMs\(/.test(c)) out.push('B6 useArcaSelfServiceStatus no relee al vencer la espera')
  }

  // ── B7 ──
  if (tree.exists(SETTINGS)) {
    const c = code(SETTINGS)
    if (!/<ArcaSetupPanel\b/.test(c)) out.push('B7 Settings debe montar ArcaSetupPanel')
    if (!/useArcaSelfServiceStatus\(businessId\)/.test(c)) out.push('B7 Settings debe leer el estado con useArcaSelfServiceStatus')
  } else out.push(`B7 falta ${SETTINGS}`)
  if (!tree.exists(PANEL)) out.push(`B7 falta ${PANEL}`)

  // ── B8 ──
  if (tree.exists(WIZARD)) {
    const c = code(WIZARD)
    if (!/mobilePresentation="fullscreen"/.test(c)) out.push('B8 el asistente debe ser pantalla completa en mobile')
    if (!/closeOnBackdrop=\{false\}/.test(c)) out.push('B8 el asistente no debe cerrarse tocando el fondo')
  }
  // ── B9 ──
  const EMISSION_PROMISE = /(ya\s+)?pod[eé]s\s+(emitir|facturar)|\bCAE\b|emisi[oó]n\s+(real|probada|verificada)|comprobante\s+(emitido|autorizado)/i
  for (const file of [...tree.listUi(), GUIDE, STATUS_LIB, 'src/lib/arcaSetupErrors.ts']) {
    if (!tree.exists(file)) continue
    const m = code(file).match(EMISSION_PROMISE)
    if (m) out.push(`B9 ${file} promete una emisión que el asistente no verificó: ${m[0]}`)
  }
  if (tree.exists(PANEL) && !/nunca te pide ni guarda tu Clave Fiscal/.test(code(PANEL))) out.push('B9 la entrada debe aclarar que TechRepair Pro nunca pide ni guarda la Clave Fiscal')
  if (tree.exists(GUIDE) && !/sitio de ARCA[^']*nunca te pide ni guarda tu Clave Fiscal/.test(code(GUIDE))) out.push('B9 la guía debe aclarar que la Clave Fiscal se usa en ARCA y nunca en TechRepair Pro')
  if (tree.exists(WIZARD) && !/quedó configurada correctamente/.test(code(WIZARD))) out.push('B9 el cierre debe describir la conexión configurada, no una emisión')
  for (const file of tree.listUi()) {
    const c = code(file)
    if (/type=["']password["']|\bclave_?fiscal\b\s*[:=]|name=["'][^"']*clave|(label|placeholder|aria-label)=["'][^"']*Clave Fiscal/i.test(c)) {
      out.push(`B9 ${file} tiene un campo de Clave Fiscal o contraseña`)
    }
  }

  // ── B10 ──
  const FISCAL = 'src/lib/arcaFiscalInput.ts'
  if (!tree.exists(FISCAL)) out.push(`B10 falta ${FISCAL}`)
  else {
    const src = tree.read(FISCAL)
    const decl = src.match(/export\s+const\s+ARCA_ALIAS_PATTERNS\b[^=]*=\s*\{([\s\S]*?)\n\}/)
    const lit = (key) => {
      const m = decl?.[1].match(new RegExp(`${key}\\s*:\\s*/((?:\\\\/|[^/\\n])+)/([a-z]*)`))
      return m ? new RegExp(m[1], m[2]) : null
    }
    const homo = lit('homologacion')
    const prod = lit('produccion')
    if (!homo || !prod) out.push('B10 arcaFiscalInput debe declarar ARCA_ALIAS_PATTERNS con homologacion y produccion')
    else {
      const legacy = /^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/
      const strict = /^[A-Za-z0-9]{3,50}$/
      const samples = ['abc', 'ab', 'techrepairdemohomo', 'techrepair-demo', 'techrepair.demo', 'techrepair_demo', 'techrepair demo',
        'técnico', 'demo/arca', 'a'.repeat(50), 'a'.repeat(51), '-abc', 'a.b', 'a-b', 'Demo2026', 'ｔｅｃｈ']
      for (const s of samples) {
        if (homo.test(s) !== strict.test(s)) out.push(`B10 homologación ${homo.test(s) ? 'acepta' : 'rechaza'} ${JSON.stringify(s)} (WSASS: sólo letras y números, 3..50)`)
        if (prod.test(s) !== legacy.test(s)) out.push(`B10 producción cambió con ${JSON.stringify(s)} sin evidencia`)
      }
    }
    const c = stripJs(src)
    if (/export\s+const\s+ARCA_ALIAS_PATTERN\s*=/.test(c)) out.push('B10 no puede quedar una regex global única del alias')
    if (!/export\s+function\s+aliasError\(\s*alias:\s*string,\s*ambiente\b/.test(c)) out.push('B10 aliasError debe recibir el ambiente')
    if (!/aliasError\(\s*draft\.alias,\s*draft\.ambiente\s*\)/.test(c)) out.push('B10 fiscalDraftErrors debe validar el alias con el ambiente del borrador')
    const suggest = c.slice(c.indexOf('export function suggestArcaAlias'))
    const suggestBody = suggest.slice(0, suggest.indexOf('\n}') + 2)
    if (!suggestBody || /`techrepair[-.]|replace\([^)]*,\s*'[-.]'\)/.test(suggestBody)) out.push('B10 la sugerencia automática no puede generar punto ni guion')
  }

  // ── B11 ──
  if (tree.exists(WIZARD)) {
    const c = code(WIZARD)
    if (/intake-progress|role="progressbar"|aria-valuenow/.test(c)) out.push('B11 el asistente no usa barra de progreso')
    if (/subtitle=\{[^}]*Paso/.test(c)) out.push('B11 el subtítulo del modal no repite el paso')
    if ((c.match(/Paso\s*\{/g) ?? []).length + (c.match(/`Paso \$\{/g) ?? []).length !== 1) out.push('B11 "Paso N de 6" debe aparecer una sola vez en el asistente')
  }

  // ── B12 ──
  if (tree.exists(GUIDE)) {
    const g = code(GUIDE)
    // Bloque de homologación: desde su `if` hasta el `return {` de producción (nivel de función).
    const start = g.indexOf("ambiente === 'homologacion'")
    const end = start < 0 ? -1 : g.indexOf('\n  return {', start)
    const homoGuide = start < 0 ? '' : g.slice(start, end < 0 ? undefined : end)
    if (!/letras y números/.test(homoGuide)) out.push('B12 la guía de homologación debe decir que el nombre lleva sólo letras y números')
    if (!/agregar certificado a DN existente/.test(homoGuide)) out.push('B12 la guía de homologación debe explicar «agregar certificado a DN existente»')
    if (!/autorización se conserva/.test(homoGuide)) out.push('B12 la guía debe aclarar que la autorización WSFE del DN se conserva')
  }
  const ERRORS = 'src/lib/arcaSetupErrors.ts'
  if (tree.exists(ERRORS)) {
    const e = code(ERRORS)
    const entry = e.match(/CERTIFICATE_ALIAS_MISMATCH:\s*\{[\s\S]*?\},/)?.[0] ?? ''
    if (!/exactamente el nombre que muestra TechRepair Pro/.test(entry)) out.push('B12 CERTIFICATE_ALIAS_MISMATCH debe decir cómo generar el certificado')
    if (/letras y números/.test(entry)) out.push('B12 CERTIFICATE_ALIAS_MISMATCH no puede afirmar la regla de homologación para todos los ambientes')
    const detail = e.match(/HOMOLOGACION_DETAIL[\s\S]*?\}/)?.[0] ?? ''
    if (!/CERTIFICATE_ALIAS_MISMATCH:\s*'[^']*letras y números/.test(detail)) out.push('B12 falta el detalle de homologación para CERTIFICATE_ALIAS_MISMATCH')
    if (!/ambiente === 'homologacion'/.test(e)) out.push('B12 el detalle de homologación debe depender del ambiente')
  }
  if (tree.exists(WIZARD) && !/arcaSetupErrorForAmbiente\(/.test(code(WIZARD))) out.push('B12 el asistente debe mostrar los errores con el detalle del ambiente')
  return out
}

function selfTest() {
  const base = diskTree()
  const clean = check(base)
  if (clean.length) throw new Error(`self-test: el árbol real no está limpio:\n${clean.join('\n')}`)
  const overlay = (files, extraSrc = []) => ({
    ...base,
    read: (p) => (files.has(p) ? files.get(p) : base.read(p)),
    exists: (p) => (files.has(p) ? files.get(p) !== null : base.exists(p)),
    listSrc: () => [...base.listSrc(), ...extraSrc],
    listUi: () => [...base.listUi(), ...extraSrc.filter((f) => f.startsWith(`${UI_DIR}/`))],
  })
  const patch = (file, from, to) => {
    const src = base.read(file)
    const next = src.replace(from, to)
    if (next === src) throw new Error(`self-test: la mutación sobre ${file} no cambió nada (${String(from).slice(0, 50)})`)
    return new Map([[file, next]])
  }
  const cases = [
    ['B1', 'vuelve el invoke a afip-wsaa', overlay(new Map([['src/services/x.ts', "await supabase.functions.invoke('afip-wsaa', { body: {} })"]]), ['src/services/x.ts'])],
    ['B1', 'fuerza un ticket nuevo', overlay(new Map([['src/services/x.ts', 'export const body = { force_refresh: true }']]), ['src/services/x.ts'])],
    ['B1', 'Settings vuelve a tener Probar conexión', overlay(patch(SETTINGS, '<ArcaSetupPanel', '<button data-testid="arca-test-connection">Probar conexión</button>\n              <ArcaSetupPanel'))],
    ['B2', 'el asistente guarda el paso en localStorage', overlay(patch(WIZARD, 'const { busy, error } = actions', "const { busy, error } = actions\n  localStorage.setItem('arca-step', view.screen)"))],
    ['B2', 'un componente llama al Edge directo', overlay(patch(PANEL, "import { useArcaSetupActions } from '../../../hooks/useArcaSetupActions'", "import { useArcaSetupActions } from '../../../hooks/useArcaSetupActions'\nimport { arcaSetupService } from '../../../services/arcaSetupService'"))],
    ['B2', 'el hook de estado consulta Supabase', overlay(patch(STATUS_HOOK, "import { ArcaService } from '../services/arcaService'", "import { ArcaService } from '../services/arcaService'\nimport { supabase } from '../lib/supabase'"))],
    ['B3', 'Verificar sin chequear la acción permitida', overlay(patch(WIZARD, "{view.actions.includes('verify') && (", '{true && ('))],
    ['B3', 'la vista no sale del estado canónico', overlay(patch(WIZARD, 'useMemo(() => deriveArcaSetupWizard(status)', "useMemo(() => ({ screen: 'verificar_conexion' } as never)"))],
    ['B4', 'la UI muestra el fingerprint', overlay(patch(WIZARD, "<div><dt>CUIT</dt>", '<div><dt>Huella</dt><dd>{(status as never as { fingerprint: string }).fingerprint}</dd></div>\n              <div><dt>CUIT</dt>'))],
    ['B5', 'las fallas no pasan por la capa central', overlay(patch(ACTIONS_HOOK, 'describeArcaSetupError(result.state)', "({ code: result.state, category: 'network', tone: 'danger', retry: 'later', title: result.state, message: '', action: '' })"))],
    ['B5', 'el certificado se envía sin clasificar', overlay(patch(ACTIONS_HOOK, /const local = readArcaCertificateFile\(\{ name: file\.name, size: file\.size, bytes \}\)/, "await arcaSetupService.attachCertificatePem(new TextDecoder().decode(bytes))\n      const local = readArcaCertificateFile({ name: file.name, size: file.size, bytes })"))],
    ['B5', 'un componente muestra el código crudo', overlay(new Map([[`${UI_DIR}/Raw.tsx`, 'export const Raw = ({ result }: { result: { state: string } }) => <p>{result.state}</p>']]), [`${UI_DIR}/Raw.tsx`])],
    ['B6', 'no relee al volver el foco', overlay(patch(STATUS_HOOK, "window.addEventListener('focus', onEvent)\n", ''))],
    ['B6', 'no relee al vencer la espera', overlay(patch(STATUS_HOOK, 'nextArcaStatusRefreshMs(status, Date.now())', 'null'))],
    ['B7', 'Settings no monta el panel', overlay(patch(SETTINGS, '<ArcaSetupPanel', '<ArcaSetupPanelDisabled'))],
    ['B8', 'el asistente se cierra tocando el fondo', overlay(patch(WIZARD, 'closeOnBackdrop={false}', 'closeOnBackdrop'))],
    ['B9', 'el cierre vuelve a prometer emisión', overlay(patch(WIZARD, 'La conexión con ARCA quedó configurada correctamente. TechRepair Pro usará esta conexión cuando emitas comprobantes electrónicos.', 'Ya podés emitir comprobantes electrónicos desde TechRepair Pro.'))],
    ['B9', 'la tarjeta de estado promete un CAE', overlay(patch(STATUS_LIB, "TechRepair Pro la usa cuando emitís comprobantes electrónicos.'", "Tu primer CAE ya está listo.'"))],
    ['B9', 'la entrada vuelve a sugerir que pedimos la Clave Fiscal', overlay(patch(PANEL, 'TechRepair Pro nunca te pide ni guarda tu Clave Fiscal.', 'Tené a mano la Clave Fiscal del negocio.'))],
    ['B9', 'la guía pierde la aclaración', overlay(patch(GUIDE, 'TechRepair Pro nunca te pide ni guarda tu Clave Fiscal.', 'Cargala cuando te la pidamos.'))],
    ['B9', 'aparece un campo de Clave Fiscal', overlay(new Map([[`${UI_DIR}/ClaveFiscal.tsx`, 'export const F = () => <input type="password" aria-label="Clave Fiscal" />']]), [`${UI_DIR}/ClaveFiscal.tsx`])],
    ['B10', 'homologación vuelve a aceptar punto y guion', overlay(patch(FISCAL_INPUT, 'homologacion: /^[A-Za-z0-9]{3,50}$/,', 'homologacion: /^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/,'))],
    ['B10', 'producción se endurece sin evidencia', overlay(patch(FISCAL_INPUT, 'produccion: /^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/,', 'produccion: /^[A-Za-z0-9]{3,50}$/,'))],
    ['B10', 'vuelve una regex global única', overlay(patch(FISCAL_INPUT, 'export type ArcaAmbiente', "export const ARCA_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/\nexport type ArcaAmbiente"))],
    ['B10', 'el borrador valida el alias sin ambiente', overlay(patch(FISCAL_INPUT, 'aliasError(draft.alias, draft.ambiente)', 'aliasError(draft.alias)'))],
    ['B10', 'la sugerencia vuelve a usar guiones', overlay(patch(FISCAL_INPUT, '`techrepair${slug}`', '`techrepair-${slug}`'))],
    ['B11', 'vuelve la barra de progreso', overlay(patch(WIZARD, '<div className="arca-setup-titles">', '<div className="intake-progress" role="progressbar"><span /></div>\n        <div className="arca-setup-titles">'))],
    ['B11', 'el subtítulo repite el paso', overlay(patch(WIZARD, 'title="Conectar ARCA"', 'title="Conectar ARCA"\n      subtitle={`Paso ${stepNumber} de ${ARCA_SETUP_TOTAL_STEPS}`}'))],
    ['B12', 'la guía pierde el caso del DN existente', overlay(patch(GUIDE, 'agregar certificado a DN existente', 'crear otro certificado'))],
    ['B12', 'la guía deja de aclarar que WSFE se conserva', overlay(patch(GUIDE, 'esa autorización se conserva', 'hay que autorizar de nuevo'))],
    ['B12', 'el error del nombre afirma la regla para producción', overlay(patch(ERRORS_LIB, "message: 'El nombre del certificado no coincide con el nombre del equipo configurado.'", "message: 'El nombre del certificado no coincide. ARCA acepta sólo letras y números.'"))],
    ['B12', 'el asistente muestra errores sin el ambiente', overlay(patch(WIZARD, 'arcaSetupErrorForAmbiente(error.view, errorAmbiente)', 'error.view'))],
  ]
  let failed = 0
  for (const [rule, label, tree] of cases) {
    const got = check(tree)
    if (!got.some((g) => g.startsWith(rule))) { failed++; console.error(`❌ no detectó «${label}» (esperado ${rule}; obtenido: ${got.join(' | ') || 'nada'})`) }
    else console.log(`✅ detecta: ${label}`)
  }
  if (failed) { console.error(`\n❌ self-test ARCA Phase 2B: ${failed} fallo(s)`); process.exit(1) }
  console.log(`\n✅ Self-test ARCA Phase 2B: ${cases.length} violaciones plantadas, todas detectadas por su regla.`)
}

const isCLI = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('arca-phase2b-wizard-contract.mjs')
if (isCLI && process.argv.includes('--self-test')) { selfTest(); process.exit(0) }
if (isCLI) {
  const problems = check(diskTree())
  if (problems.length) {
    console.error('❌ Guard ARCA Phase 2B:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log('✅ Guard ARCA Phase 2B OK: sin tickets WSAA desde el navegador, asistente derivado del estado canónico, sin progreso local ni material secreto, errores centralizados, relectura por foco/red/espera y copy honesto (Clave Fiscal, sin promesa de emisión).')
}
