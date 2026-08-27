#!/usr/bin/env node
// ============================================================================
// P0-ONBOARDING-1 — Guard del PERFIL CANONICO del negocio.
//
// Estatico: lee `src/`. No necesita credenciales ni DB, asi que corre en el job
// `quality` del CI, en PRs y en forks.
//
// Protege las invariantes que este lote establecio y que un refactor inocente
// puede deshacer sin que nadie lo note. Cada una corresponde a un defecto
// MEDIDO en produccion, no a una preferencia de estilo:
//
//   R1. NINGUNA superficie de documento cae a un placeholder tecnico como
//       nombre del negocio. Eran cinco (`|| 'Mi Negocio'`) mas el
//       `|| 'TechRepair'` del PDF, y con 18 de 20 negocios sin
//       `nombre_comercial` eso se imprimia y se le entregaba al cliente.
//
//   R2. `DEFAULT_PRINT_SETTINGS.nombre_comercial` es ''. Se renderiza en el
//       primer frame, antes de que responda la DB.
//
//   R3. Configuracion NO vuelve a tener un writer paralelo: nada de
//       `.from('business_settings').upsert/update(...)` para los campos de
//       identidad, contacto y fiscales. Ese segundo writer es la causa raiz de
//       que `businesses.name` y `nombre_comercial` divergieran.
//
//   R4. El `<select>` de condicion fiscal usa SLUGS canonicos, no etiquetas de
//       UI. Con etiquetas, un `value` que no matchea ninguna `<option>` deja el
//       campo EN BLANCO — le pasaba a los 5 negocios que venian del wizard.
//
//   R5. El vocabulario de la condicion fiscal del EMISOR vive en UN solo lugar
//       (`src/lib/fiscalCondition.ts`). Tenerlo duplicado entre el wizard y
//       Configuracion fue lo que produjo los 3 vocabularios incompatibles.
//
//   node scripts/guards/onboarding-canonical.mjs
//   node scripts/guards/onboarding-canonical.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const AUTO_TEST = process.argv.includes('--self-test')

/** Placeholders tecnicos que NO pueden ser fallback del nombre del negocio. */
const PLACEHOLDERS = ['Mi Negocio', 'TechRepair']

/** La unica fuente de verdad del vocabulario fiscal del emisor. */
const LIB_FISCAL = 'src/lib/fiscalCondition.ts'
/** La unica fuente de verdad de la identidad comercial. */
const LIB_IDENTIDAD = 'src/lib/businessIdentity.ts'

/**
 * Superficies que producen un documento entregado al cliente. La lista es
 * explicita a proposito: si aparece una nueva, hay que agregarla acá y el
 * guard obliga a pensarlo.
 */
const SUPERFICIES_DOCUMENTO = [
  'src/components/comprobantes/ComprobanteDocumento.tsx',
  'src/components/comprobantes/ComprobantePrintLayout.tsx',
  'src/components/print/ServiceOrderPrint.tsx',
  'src/components/print/OrderPrintPreviewModal.tsx',
  'src/components/warranties/WarrantyPrintLayout.tsx',
  'src/components/warranties/WarrantyDetailModal.tsx',
  'src/hooks/useOrderPrintSettings.ts',
  'src/pages/Comprobante.tsx',
  'src/pages/Orders.tsx',
]

/** Campos que gobierna el writer canonico: Settings no puede escribirlos suelto. */
const CAMPOS_CANONICOS = [
  'nombre_comercial', 'razon_social', 'cuit', 'condicion_iva', 'domicilio_fiscal',
  'localidad', 'provincia', 'codigo_postal', 'telefono', 'email',
  'observaciones_comprobantes',
]

/** Reemplaza comentarios JS/TS por espacios, conservando offsets. */
function despojarJs(s) {
  let out = '', i = 0, modo = null
  while (i < s.length) {
    if (!modo && s.slice(i, i + 2) === '//') {
      const f = s.indexOf('\n', i); const e = f === -1 ? s.length : f
      out += ' '.repeat(e - i); i = e; continue
    }
    if (!modo && s.slice(i, i + 2) === '/*') {
      const f = s.indexOf('*/', i + 2); const e = f === -1 ? s.length : f + 2
      out += ' '.repeat(e - i); i = e; continue
    }
    // Cadenas: un placeholder dentro de una cadena SI cuenta (es el bug), pero
    // hay que entrar y salir para no confundir un `//` de una URL con comentario.
    const c = s[i]
    if (modo) { if (c === modo && s[i - 1] !== '\\') modo = null }
    else if (c === '"' || c === "'" || c === '`') modo = c
    out += c; i++
  }
  return out
}

function leer(raiz, rel) {
  const p = join(raiz, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

function archivosFuente(dir) {
  let out = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out = out.concat(archivosFuente(p))
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

function correr(raiz) {
  const h = []

  // ── R1 · ninguna superficie cae a un placeholder ──────────────────────────
  for (const rel of SUPERFICIES_DOCUMENTO) {
    const crudo = leer(raiz, rel)
    if (crudo === null) continue
    const limpio = despojarJs(crudo)
    for (const ph of PLACEHOLDERS) {
      // El patron del bug: `algo || 'Mi Negocio'` o `algo ?? 'TechRepair'`.
      const re = new RegExp(`(\\|\\||\\?\\?)\\s*['"\`]${ph}['"\`]`)
      if (re.test(limpio)) {
        h.push(`R1 ${rel}: cae a '${ph}' como nombre del negocio. Un placeholder tecnico no puede terminar impreso — usar resolveBusinessDisplayName().`)
      }
      // El otro patron: el placeholder como valor por defecto de un campo de
      // nombre. `nombre_comercial: 'Mi Negocio'`.
      const reDefault = new RegExp(`nombre_comercial\\s*:\\s*['"\`]${ph}['"\`]`)
      if (reDefault.test(limpio)) {
        h.push(`R2 ${rel}: usa '${ph}' como valor por defecto de nombre_comercial. Se renderiza antes de que responda la DB.`)
      }
    }
  }

  // ── R3 · Settings no puede tener un writer paralelo ───────────────────────
  const settings = leer(raiz, 'src/pages/Settings.tsx')
  if (settings !== null) {
    const limpio = despojarJs(settings)
    // Un upsert/update directo sobre business_settings en la misma sentencia
    // que un campo canonico. `mayorista_enabled` y los campos de impresion
    // tienen sus propias pantallas y NO estan en la lista.
    const re = /\.from\(\s*['"`]business_settings['"`]\s*\)[\s\S]{0,400}?\.(upsert|update)\s*\(([\s\S]{0,600}?)\)/g
    let m
    while ((m = re.exec(limpio)) !== null) {
      const payload = m[2]
      const tocados = CAMPOS_CANONICOS.filter(c => new RegExp(`\\b${c}\\b`).test(payload))
      // Un spread opaco (`...fieldsToUpdate`) puede contener cualquier cosa: es
      // exactamente la forma que tenia el writer viejo, y no se puede auditar.
      const spreadOpaco = /\.\.\.[A-Za-z_$][\w$]*/.test(payload)
      if (tocados.length || spreadOpaco) {
        h.push(`R3 src/pages/Settings.tsx: writer paralelo sobre business_settings (${spreadOpaco ? 'spread opaco' : tocados.join(', ')}). Usar businessSetupService.updateMyBusinessProfile().`)
      }
    }

    // ── R4 · el <select> del EMISOR usa slugs, no etiquetas ─────────────────
    // Se busca la etiqueta como `value=` de una <option>: ese es el bug exacto
    // que dejaba el campo en blanco.
    //
    // ALCANCE. Hay dos <select> de condicion fiscal en esta pantalla y sólo uno
    // es de este lote:
    //   · el que bindea `condicion_iva`      -> el EMISOR (el negocio). ESTE.
    //   · el que bindea `condicion_fiscal`   -> el PUNTO DE VENTA
    //     (`sales_points`), que es territorio ARCA y este lote NO gobierna.
    // Sin esta distincion el guard marcaria el select de puntos de venta y
    // empujaria a tocar algo que esta explicitamente fuera de alcance.
    const bloques = limpio.match(/<select[\s\S]{0,2000}?<\/select>/g) ?? []
    for (const bloque of bloques) {
      const esEmisor = /value=\{[^}]*\bcondicion_iva\b/.test(bloque)
      if (!esEmisor) continue
      for (const label of ['Responsable Inscripto', 'Responsable Monotributo', 'Monotributista Social', 'Consumidor Final']) {
        if (new RegExp(`<option\\s+value=["'\`]${label}["'\`]`).test(bloque)) {
          h.push(`R4 src/pages/Settings.tsx: el <select> de condicion_iva (EMISOR) usa <option value="${label}"> — la ETIQUETA como value. Debe ser el slug canonico (ver ${LIB_FISCAL}).`)
        }
      }
    }
  }

  // ── R5 · vocabulario fiscal del emisor en UN solo lugar ───────────────────
  // Una lista literal de condiciones fiscales fuera de la lib es una segunda
  // fuente de verdad. Se mide por co-ocurrencia de dos slugs canonicos, que es
  // lo que distingue una lista de una mencion suelta.
  const SLUGS = ['responsable_inscripto', 'monotributista_social', 'consumidor_final']
  for (const abs of archivosFuente(join(raiz, 'src'))) {
    const rel = relative(raiz, abs).replace(/\\/g, '/')
    if (rel === LIB_FISCAL) continue
    const limpio = despojarJs(readFileSync(abs, 'utf8'))
    const presentes = SLUGS.filter(s => limpio.includes(s))
    if (presentes.length >= 2) {
      h.push(`R5 ${rel}: define su propia lista de condiciones fiscales (${presentes.join(', ')}). El vocabulario del EMISOR vive solo en ${LIB_FISCAL}.`)
    }
  }

  // ── R1b · la lib de identidad tiene que existir y ser usada ───────────────
  if (leer(raiz, LIB_IDENTIDAD) === null) {
    h.push(`R1 falta ${LIB_IDENTIDAD}: es donde vive la regla de que un placeholder no se imprime.`)
  } else {
    for (const rel of ['src/components/comprobantes/ComprobantePrintLayout.tsx',
                       'src/components/print/ServiceOrderPrint.tsx',
                       'src/components/warranties/WarrantyPrintLayout.tsx']) {
      const crudo = leer(raiz, rel)
      if (crudo !== null && !despojarJs(crudo).includes('resolveBusinessDisplayName')) {
        h.push(`R1 ${rel}: resuelve el nombre del negocio por su cuenta. Debe usar resolveBusinessDisplayName() para que la regla viva en un solo lugar.`)
      }
    }
  }

  return h
}

// ── Self-test ───────────────────────────────────────────────────────────────
// Cada caso muta el arbol a proposito y verifica que el guard REACCIONE. Un
// guard que nunca se probo contra el defecto que dice detectar es decorativo.
const BASE_OK = {
  [LIB_IDENTIDAD]: `export function resolveBusinessDisplayName(x){return ''}`,
  [LIB_FISCAL]: `export const C=[{slug:'responsable_inscripto'},{slug:'monotributista_social'},{slug:'consumidor_final'}]`,
  'src/components/comprobantes/ComprobantePrintLayout.tsx': `const n = resolveBusinessDisplayName({})`,
  'src/components/print/ServiceOrderPrint.tsx': `const n = resolveBusinessDisplayName({})`,
  'src/components/warranties/WarrantyPrintLayout.tsx': `const n = resolveBusinessDisplayName({})`,
  'src/hooks/useOrderPrintSettings.ts': `export const D = { nombre_comercial: '' }`,
  'src/pages/Settings.tsx':
    `<select value={normalizeCondicionFiscal(businessSettings.condicion_iva) ?? ''}>` +
    `<option value="responsable_inscripto">Responsable Inscripto</option></select>`,
}

const CASOS = [
  { nombre: 'arbol canonico (no debe disparar)', debeFallar: false, src: {} },
  {
    nombre: 'R1 vuelve el fallback a Mi Negocio en la hoja impresa',
    debeFallar: true,
    src: { 'src/components/comprobantes/ComprobantePrintLayout.tsx':
      `const n = profile.nombre_comercial || 'Mi Negocio'\nresolveBusinessDisplayName({})` },
  },
  {
    nombre: 'R1 vuelve el fallback a TechRepair en el PDF',
    debeFallar: true,
    src: { 'src/pages/Comprobante.tsx': `const name = profile.nombre_comercial || 'TechRepair';` },
  },
  {
    nombre: 'R1 mencion del placeholder en un comentario (permitido)',
    debeFallar: false,
    src: { 'src/pages/Comprobante.tsx': `// antes caia a || 'Mi Negocio'\nconst name = resolve({})` },
  },
  {
    nombre: 'R2 vuelve el default Mi Negocio en DEFAULT_PRINT_SETTINGS',
    debeFallar: true,
    src: { 'src/hooks/useOrderPrintSettings.ts': `export const D = { nombre_comercial: 'Mi Negocio' }` },
  },
  {
    nombre: 'R3 vuelve el upsert directo de Settings con spread opaco',
    debeFallar: true,
    src: { 'src/pages/Settings.tsx':
      `await supabase.from('business_settings').upsert({ ...fieldsToUpdate, business_id })` },
  },
  {
    nombre: 'R3 update directo de un campo canonico',
    debeFallar: true,
    src: { 'src/pages/Settings.tsx':
      `await supabase.from('business_settings').update({ nombre_comercial: x }).eq('business_id', b)` },
  },
  {
    nombre: 'R3 update de un campo NO canonico (permitido)',
    debeFallar: false,
    src: { 'src/pages/Settings.tsx':
      `await supabase.from('business_settings').update({ mayorista_enabled: v }).eq('business_id', b)` },
  },
  {
    nombre: 'R4 vuelve la etiqueta como value en el select del EMISOR',
    debeFallar: true,
    src: { 'src/pages/Settings.tsx':
      `<select value={businessSettings.condicion_iva}>` +
      `<option value="Responsable Inscripto">Responsable Inscripto</option></select>` },
  },
  {
    nombre: 'R4 el select del PUNTO DE VENTA con etiquetas (fuera de alcance, permitido)',
    debeFallar: false,
    src: { 'src/pages/Settings.tsx':
      `<select value={normalizeCondicionFiscal(businessSettings.condicion_iva) ?? ''}>` +
      `<option value="responsable_inscripto">RI</option></select>` +
      `<select value={salesPointForm.condicion_fiscal}>` +
      `<option value="Responsable Inscripto">Responsable Inscripto</option></select>` },
  },
  {
    nombre: 'R5 se duplica el vocabulario fiscal fuera de la lib',
    debeFallar: true,
    src: { 'src/pages/Onboarding.tsx':
      `const C=[{id:'responsable_inscripto'},{id:'consumidor_final'}]` },
  },
  {
    nombre: 'R1 una superficie deja de usar el resolvedor comun',
    debeFallar: true,
    src: { 'src/components/warranties/WarrantyPrintLayout.tsx':
      `const n = settings.nombre_comercial || settings.razon_social` },
  },
]

function autoTest() {
  let fallos = 0
  for (const c of CASOS) {
    const raiz = mkdtempSync(join(tmpdir(), 'onb1-'))
    const arbol = { ...BASE_OK, ...c.src }
    for (const [rel, contenido] of Object.entries(arbol)) {
      const p = join(raiz, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, contenido)
    }
    const h = correr(raiz)
    const fallo = h.length > 0
    const ok = fallo === c.debeFallar
    console.log(`  ${ok ? 'OK ' : 'XX '} ${c.nombre}${ok ? '' : ` -> esperaba ${c.debeFallar ? 'FALLO' : 'PASS'}, hubo ${fallo ? 'FALLO' : 'PASS'}${h.length ? ': ' + h[0] : ''}`}`)
    if (!ok) fallos++
  }
  if (fallos) {
    console.error(`\nX SELF-TEST: ${fallos} caso(s) no se comportaron como se espera. El guard no mide lo que dice medir.\n`)
    process.exit(1)
  }
  console.log(`\nOK self-test: ${CASOS.length}/${CASOS.length}. Cada regla dispara y ninguna es un falso positivo.\n`)
}

// ── Main ────────────────────────────────────────────────────────────────────
if (AUTO_TEST) {
  console.log('\n--- Guard del perfil canonico del negocio - self-test ---')
  autoTest()
} else {
  const h = correr(process.cwd())
  if (h.length) {
    console.error('\nX PERFIL CANONICO DEL NEGOCIO VIOLADO\n')
    for (const x of h) console.error('  - ' + x)
    console.error('')
    process.exit(1)
  }
  console.log('OK perfil canonico intacto: un solo writer, un solo vocabulario, ningun placeholder imprimible.')
}
