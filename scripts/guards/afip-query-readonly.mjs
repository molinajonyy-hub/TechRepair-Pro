#!/usr/bin/env node
// ============================================================================
// Guard — afip-fe-query NO puede emitir. Garantia ESTRUCTURAL.
//
//   node scripts/guards/afip-query-readonly.mjs             (valida el repo)
//   node scripts/guards/afip-query-readonly.mjs --self-test (valida el guard)
//
// ┌── QUE PROTEGE ──────────────────────────────────────────────────────────┐
// │ afip-fe-query existe para consultar ARCA sin poder autorizar nada. Un    │
// │ "modo consulta" dentro del flujo de emision seria un boundary difuso: un │
// │ import de mas y el endpoint de lectura alcanza FECAESolicitar.           │
// │                                                                          │
// │ Este guard recorre el GRAFO DE IMPORTS del endpoint (no solo su archivo) │
// │ y falla si aparece cualquier simbolo de emision o de escritura fiscal.   │
// │ No depende de una condicion de runtime.                                  │
// └─────────────────────────────────────────────────────────────────────────┘
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

const ENTRADA = 'supabase/functions/afip-fe-query/index.ts'
const DIR_FN  = 'supabase/functions/afip-fe-query'

/**
 * Simbolos que implican emision fiscal o escritura sobre el estado fiscal.
 * Si alguno aparece en CODIGO (no en comentarios) dentro del grafo del
 * endpoint, el boundary se rompio.
 */
export const SIMBOLOS_PROHIBIDOS = [
  'FECAESolicitar',
  'buildFECAESolicitarSOAP',
  'parseFECAEResponse',
  'solicitarCAEConReconciliacion',
  'decidirTrasAmbiguo',
  'FECAEA',
  'reserve_arca_number',
  'claim_comprobante_arca_emission',
  'complete_arca_attempt',
  'mark_arca_attempt_sent',
]

/** Operaciones WSFEv1 que SI puede usar. */
export const OPERACIONES_PERMITIDAS = ['FECompConsultar', 'FECompUltimoAutorizado']

/**
 * Operaciones WSFEv1 que AUTORIZAN comprobantes. Se listan explicitamente en
 * vez de "cualquier cosa que empiece con FE": esa heuristica marcaba `WSFEv1`
 * y `buildFECompConsultarSOAP`, que son legitimos.
 */
export const OPERACIONES_DE_ESCRITURA = [
  'FECAESolicitar',
  'FECAEASolicitar',
  'FECAEARegInformativo',
  'FECAEASinMovimientoInformar',
  'FECompTotXRequest',
]

/** Operaciones de escritura nombradas en CODIGO. */
export function operacionesDeEscritura(fuente) {
  const codigo = stripComments(fuente)
  return OPERACIONES_DE_ESCRITURA.filter(op => codigo.includes(op))
}

export function stripComments(src) {
  let out = '', i = 0
  while (i < src.length) {
    if (src.slice(i, i + 2) === '//') {
      const f = src.indexOf('\n', i); const e = f === -1 ? src.length : f
      out += ' '.repeat(e - i); i = e; continue
    }
    if (src.slice(i, i + 2) === '/*') {
      const f = src.indexOf('*/', i + 2); const e = f === -1 ? src.length : f + 2
      out += ' '.repeat(e - i); i = e; continue
    }
    out += src[i]; i++
  }
  return out
}

/** Simbolos prohibidos presentes en CODIGO. */
export function simbolosDeEmision(fuente) {
  const codigo = stripComments(fuente)
  return SIMBOLOS_PROHIBIDOS.filter(s => codigo.includes(s))
}

/** Imports relativos declarados por un archivo. */
export function importsRelativos(fuente) {
  const out = []
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s+['"](\.[^'"]+)['"]/g
  let m
  while ((m = re.exec(fuente)) !== null) out.push(m[1])
  return out
}

/** ¿Escribe en la base? Un endpoint de lectura no puede. */
export function escribeEnDb(fuente) {
  const codigo = stripComments(fuente)
  return /\.(insert|update|upsert|delete)\s*\(/.test(codigo)
}

// ─── Recorrido del grafo ────────────────────────────────────────────────────

function resolverImport(desdeArchivo, especificador) {
  const base = resolve(dirname(desdeArchivo), especificador)
  for (const cand of [base, base + '.ts', join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

/** Archivos alcanzables desde la entrada por imports relativos. */
export function grafoDeImports(entradaAbs) {
  const vistos = new Set()
  const pend = [entradaAbs]
  while (pend.length) {
    const f = pend.pop()
    if (!f || vistos.has(f)) continue
    vistos.add(f)
    const src = readFileSync(f, 'utf-8')
    for (const esp of importsRelativos(src)) {
      const r = resolverImport(f, esp)
      if (r) pend.push(r)
    }
  }
  return [...vistos]
}

function rel(p) {
  return p.slice(RAIZ.length + 1).split('\\').join('/')
}

function validarRepo() {
  const fallas = []
  const entradaAbs = join(RAIZ, ENTRADA)

  if (!existsSync(entradaAbs)) {
    return [`Falta ${ENTRADA}: desaparecio el endpoint de consulta read-only.`]
  }

  // 1. Grafo de imports: ni un simbolo de emision, ni una escritura.
  const grafo = grafoDeImports(entradaAbs)
  for (const abs of grafo) {
    const p = rel(abs)
    const src = readFileSync(abs, 'utf-8')

    const malos = simbolosDeEmision(src)
    if (malos.length) {
      fallas.push(`${p}: alcanzable desde ${ENTRADA} y contiene simbolos de emision fiscal (${malos.join(', ')}). El endpoint de consulta dejaria de ser estructuralmente incapaz de emitir.`)
    }
    if (escribeEnDb(src)) {
      fallas.push(`${p}: alcanzable desde ${ENTRADA} y escribe en la base (insert/update/upsert/delete). Este endpoint es de solo lectura.`)
    }
  }

  // 2. No puede importar el modulo de emision, ni por ruta.
  for (const abs of grafo) {
    const src = stripComments(readFileSync(abs, 'utf-8'))
    if (/from\s+['"][^'"]*afip-cae[^'"]*['"]/.test(src)) {
      fallas.push(`${rel(abs)}: importa desde afip-cae. Ese modulo contiene el camino FECAESolicitar; la copia read-only vive en afip-fe-query/queryLogic.ts a proposito.`)
    }
  }

  // 3. Ninguna operacion WSFEv1 de ESCRITURA aparece en el directorio.
  const dirAbs = join(RAIZ, DIR_FN)
  for (const f of readdirSync(dirAbs).filter(f => f.endsWith('.ts'))) {
    const ops = operacionesDeEscritura(readFileSync(join(dirAbs, f), 'utf-8'))
    if (ops.length) {
      fallas.push(`${DIR_FN}/${f}: nombra operaciones WSFEv1 que autorizan comprobantes (${ops.join(', ')}).`)
    }
  }

  // 4. Y al menos una de lectura sigue presente: un endpoint que ya no consulta
  //    nada pasaria los tres chequeos anteriores sin proteger nada.
  const fuentesFn = readdirSync(dirAbs)
    .filter(f => f.endsWith('.ts'))
    .map(f => stripComments(readFileSync(join(dirAbs, f), 'utf-8')))
    .join('\n')
  const presentes = OPERACIONES_PERMITIDAS.filter(op => fuentesFn.includes(op))
  if (presentes.length !== OPERACIONES_PERMITIDAS.length) {
    const faltan = OPERACIONES_PERMITIDAS.filter(op => !presentes.includes(op))
    fallas.push(`${DIR_FN}: perdio operaciones de lectura (${faltan.join(', ')}). El endpoint dejo de cumplir su proposito.`)
  }

  return fallas
}

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  const casos = []
  const chequear = (nombre, real, esperado) => {
    casos.push({ nombre, ok: JSON.stringify(real) === JSON.stringify(esperado), real, esperado })
  }

  chequear('caza FECAESolicitar en codigo',
    simbolosDeEmision(`const s = buildFECAESolicitarSOAP({})`), ['FECAESolicitar', 'buildFECAESolicitarSOAP'])
  chequear('caza la RPC de reserva',
    simbolosDeEmision(`await sb.rpc('reserve_arca_number', {})`), ['reserve_arca_number'])
  chequear('caza el claim de intento',
    simbolosDeEmision(`rpc('claim_comprobante_arca_emission')`), ['claim_comprobante_arca_emission'])
  chequear('NO marca la mencion en un comentario',
    simbolosDeEmision(`// no hay FECAESolicitar aca\nconst x = 1`), [])
  chequear('NO marca el codigo de solo lectura',
    simbolosDeEmision(`const s = buildFECompConsultarSOAP({})`), [])

  chequear('detecta escritura insert', escribeEnDb(`await sb.from('t').insert({})`), true)
  chequear('detecta escritura update', escribeEnDb(`await sb.from('t').update({})`), true)
  chequear('no marca una lectura', escribeEnDb(`await sb.from('t').select('*')`), false)
  chequear('no marca "insert" en comentario', escribeEnDb(`// nunca hacer insert(\nselect()`), false)

  chequear('caza una operacion WSFEv1 de escritura',
    operacionesDeEscritura(`const s = '<ar:FECAESolicitar>'`), ['FECAESolicitar'])
  chequear('NO marca WSFEv1 ni el builder de consulta',
    operacionesDeEscritura(`// WSFEv1\nconst s = buildFECompConsultarSOAP({})`), [])

  chequear('lee imports relativos',
    importsRelativos(`import { a } from './queryLogic.ts'\nimport b from 'https://x/y.ts'`), ['./queryLogic.ts'])
  chequear('lee imports multilinea',
    importsRelativos(`import {\n  a,\n  b,\n} from './q.ts'`), ['./q.ts'])

  const fallidos = casos.filter(c => !c.ok)
  for (const c of casos) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.nombre}`)
    if (!c.ok) console.log(`      esperado ${JSON.stringify(c.esperado)}, obtuvo ${JSON.stringify(c.real)}`)
  }
  if (fallidos.length) {
    console.error(`\n✗ Self-test FALLIDO: ${fallidos.length}/${casos.length}.`)
    process.exit(1)
  }
  console.log(`\n✓ Self-test OK: ${casos.length} comprobaciones verificadas en ambos sentidos.`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  console.log('\n─── guard:afip-query-readonly · self-test ──────────────────────────')
  selfTest()
} else {
  const fallas = validarRepo()
  if (fallas.length) {
    console.error('\n' + '═'.repeat(74))
    console.error('  GUARD FALLIDO — afip-fe-query dejo de ser estructuralmente read-only')
    console.error('═'.repeat(74))
    for (const f of fallas) console.error(`  ✗ ${f}`)
    console.error('═'.repeat(74) + '\n')
    process.exit(1)
  }
  console.log('✓ guard:afip-query-readonly — el endpoint de consulta no puede emitir ni escribir.')
}
