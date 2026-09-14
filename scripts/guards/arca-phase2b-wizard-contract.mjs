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
  console.log('✅ Guard ARCA Phase 2B OK: sin tickets WSAA desde el navegador, asistente derivado del estado canónico, sin progreso local ni material secreto, errores centralizados y relectura por foco/red/espera.')
}
