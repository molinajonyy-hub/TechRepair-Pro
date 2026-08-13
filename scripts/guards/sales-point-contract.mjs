#!/usr/bin/env node
// ============================================================================
// Guard — La lectura del punto de venta usa el contrato REAL de la tabla.
//
//   node scripts/guards/sales-point-contract.mjs             (valida el repo)
//   node scripts/guards/sales-point-contract.mjs --self-test (valida el guard)
//
// ┌── QUÉ PROTEGE ──────────────────────────────────────────────────────────┐
// │ Tres modales de comprobantes pedían `punto_venta` e `is_active` a       │
// │ `sales_points`. Esas columnas NO existen ahí: son `numero` y `activo`.  │
// │ PostgREST devolvía 400 y el `.then(({ data }) => …)` tiraba el error a  │
// │ la basura, así que el POS caía siempre al '0001' sin decir nada.        │
// │                                                                          │
// │ Es una trampa fácil de repetir porque `punto_venta` SÍ existe — en      │
// │ `comprobantes` (text) y en `arca_config` (integer). Copiar el nombre    │
// │ desde ahí a una query de sales_points compila, pasa el type-check y     │
// │ falla sólo en runtime.                                                  │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Se mide sobre el CÓDIGO FUENTE: el gate E2E ya cubre el comportamiento
// (que el PV configurado llegue a la pantalla). Acá interesa que no vuelva la
// FORMA que causó el incidente.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

const SERVICIO = 'src/services/salesPointService.ts'
/** Parte pura del contrato (testeable sin Supabase). */
const FORMATO = 'src/lib/salesPointFormat.ts'

/**
 * Únicos archivos que pueden tocar la tabla directamente.
 *
 * `Settings.tsx` es el ABM del punto de venta: escribe con los nombres
 * correctos y necesita `select('*')`. El resto de la app lee por el servicio.
 */
const CONSUMIDORES_DIRECTOS_PERMITIDOS = new Set([
  'src/services/salesPointService.ts',
  'src/pages/Settings.tsx',
])

/** Columnas que NO existen en public.sales_points y rompen la query. */
const COLUMNAS_INEXISTENTES = ['punto_venta', 'is_active']

/** Migración que fija el contrato fiscal server-side. */
const MIGRACION_FISCAL =
  'supabase/migrations/20260813120000_fiscal_sales_point_canonical_contract.sql'

// ─── Comprobaciones puras (testeables) ──────────────────────────────────────

/**
 * Columnas inexistentes usadas DENTRO de una consulta a sales_points.
 *
 * Se inspecciona sólo la cadena que sigue a `.from('sales_points')` y no el
 * archivo entero: `punto_venta` es una columna legítima de `comprobantes` y de
 * `arca_config`, así que marcar el archivo completo daría falsos positivos en
 * comprobanteService, arcaService y los layouts de impresión.
 */
export function columnasInexistentesEnSalesPoints(fuente) {
  const encontradas = []
  const re = /\.from\(\s*['"]sales_points['"]\s*\)/g
  let m
  while ((m = re.exec(fuente)) !== null) {
    // La cadena termina en el ejecutor de la query. Si no aparece ninguno se
    // toma una ventana amplia: es preferible mirar de más que perder el caso.
    const resto = fuente.slice(m.index)
    const fin = resto.search(/\b(maybeSingle|single|then|await|csv)\s*\(/)
    const cadena = resto.slice(0, fin === -1 ? 400 : fin)
    for (const col of COLUMNAS_INEXISTENTES) {
      if (new RegExp(`['"]${col}['"]`).test(cadena) && !encontradas.includes(col)) {
        encontradas.push(col)
      }
    }
  }
  return encontradas
}

/** El archivo consulta la tabla directamente. */
export function tocaSalesPointsDirecto(fuente) {
  return /\.from\(\s*['"]sales_points['"]\s*\)/.test(fuente)
}

/** El servicio filtra por la columna real de actividad. */
export function filtraPorActivo(fuente) {
  return /\.eq\(\s*['"]activo['"]\s*,\s*true\s*\)/.test(fuente)
}

/** El servicio pide la columna real del número de punto de venta. */
export function seleccionaNumero(fuente) {
  return /\.select\(\s*['"][^'"]*\bnumero\b[^'"]*['"]\s*\)/.test(fuente)
}

/**
 * El desempate respeta el punto de venta marcado como predeterminado.
 *
 * Sin esto gana el más antiguo por created_at y el comercio que eligió un
 * default explícito en Settings ve otro número en la caja.
 */
export function priorizaPredeterminado(fuente) {
  return /\.order\(\s*['"]predeterminado['"]\s*,\s*\{\s*ascending:\s*false\s*\}\s*\)/.test(fuente)
}

/**
 * Un fallo de la consulta no se puede confundir con "no hay punto de venta".
 *
 * Ése fue exactamente el modo de falla: 400 silencioso indistinguible de un
 * negocio sin PV configurado.
 */
export function distingueErrorDeAusencia(fuente) {
  return /\bfallo\s*:\s*(true|false)\b/.test(fuente)
}

/** El error se registra por el logger central, no se descarta. */
export function registraElError(fuente) {
  return /logger\.(error|warn)\(/.test(fuente)
}

// ─── Contrato FISCAL (P0) ───────────────────────────────────────────────────

/**
 * El CbtesAsoc de una NC no puede inferirse del punto de venta LOCAL.
 *
 * El fallback `nroParts[0] ? ... : parseInt(original.punto_venta)` mandaba a
 * AFIP una referencia al PV local, que alla no existe.
 */
export function infiereCbtesAsocDelPvLocal(fuente) {
  return /parseInt\(\s*original\.punto_venta/.test(fuente)
}

/** Una superficie que arma el numero pegando el PV local al numero. */
export function armaNumeroConPvLocal(fuente) {
  return /function formatNumero\s*\(\s*numero[^)]*puntoVenta/.test(fuente)
}

/** `numero || numero_fiscal` esconde el fiscal: el local nunca es nulo. */
export function priorizaNumeroLocalSobreFiscal(fuente) {
  return /\bnumero\s*\|\|\s*[\w.]*numero_fiscal/.test(fuente)
}

/** La migracion resuelve el PV fiscal server-side desde arca_config. */
export function resuelvePvFiscalServerSide(sql) {
  return /SELECT punto_venta INTO v_arca_pv/.test(sql)
    && /ARCA_NOT_CONFIGURED/.test(sql)
    && /v_tipo_es_fiscal := \(v_tipo IN/.test(sql)
}

// ─── Recorrido del repo ─────────────────────────────────────────────────────

function archivosDe(dir, ext = ['.ts', '.tsx']) {
  const out = []
  for (const entrada of readdirSync(dir)) {
    const p = join(dir, entrada)
    if (statSync(p).isDirectory()) out.push(...archivosDe(p, ext))
    else if (ext.some(e => p.endsWith(e))) out.push(p)
  }
  return out
}

function rel(p) {
  return p.slice(RAIZ.length + 1).split('\\').join('/')
}

/**
 * Quita comentarios para asertar sobre CÓDIGO.
 *
 * Los archivos migrados documentan a propósito la forma vieja ("antes se hacía
 * `numero || numero_fiscal`"), y sin esto el guard se dispararía con su propia
 * explicación. Mismo criterio que guard-no-fragile-functiondef-patch.
 */
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

function validarRepo() {
  const fallas = []

  if (!existsSync(join(RAIZ, SERVICIO))) {
    return [`Falta ${SERVICIO}: desapareció la fuente única de lectura del punto de venta.`]
  }

  const servicio = stripComments(readFileSync(join(RAIZ, SERVICIO), 'utf-8'))

  if (!seleccionaNumero(servicio)) {
    fallas.push(`${SERVICIO}: dejó de pedir la columna 'numero'. Es el número real del punto de venta; 'punto_venta' no existe en esta tabla.`)
  }
  if (!filtraPorActivo(servicio)) {
    fallas.push(`${SERVICIO}: dejó de filtrar por 'activo'. La columna es 'activo', no 'is_active'.`)
  }
  if (!priorizaPredeterminado(servicio)) {
    fallas.push(`${SERVICIO}: perdió el desempate por 'predeterminado'. Sin él gana el PV más antiguo y se ignora el que eligió el comercio.`)
  }
  // La distinción error/ausencia vive en el módulo puro (para poder testearla
  // sin Supabase); el servicio sólo la compone.
  if (!existsSync(join(RAIZ, FORMATO))) {
    fallas.push(`Falta ${FORMATO}: desapareció la parte pura del contrato del punto de venta.`)
  } else if (!distingueErrorDeAusencia(stripComments(readFileSync(join(RAIZ, FORMATO), 'utf-8')))) {
    fallas.push(`${FORMATO}: ya no distingue un fallo de la consulta de "no hay punto de venta configurado". Ése es el bug original: un 400 leído como ausencia.`)
  }
  if (!registraElError(servicio)) {
    fallas.push(`${SERVICIO}: dejó de registrar el error con el logger central. Un fallo mudo es indistinguible del caso normal.`)
  }

  // Nadie más consulta la tabla, y nadie usa los nombres viejos.
  for (const abs of archivosDe(join(RAIZ, 'src'))) {
    const p = rel(abs)
    const fuente = stripComments(readFileSync(abs, 'utf-8'))

    const malas = columnasInexistentesEnSalesPoints(fuente)
    if (malas.length) {
      fallas.push(`${p}: consulta sales_points con ${malas.map(c => `'${c}'`).join(' y ')}, que no existe(n) en esa tabla (son 'numero' y 'activo'). Es el 400 silencioso que se cerró en el lote pre-beta del POS.`)
    }

    if (tocaSalesPointsDirecto(fuente) && !CONSUMIDORES_DIRECTOS_PERMITIDOS.has(p)) {
      fallas.push(`${p}: consulta sales_points directo. Usá salesPointService: la consulta duplicada es lo que dejó tres copias con las columnas equivocadas.`)
    }

    // ── Contrato fiscal ──
    if (infiereCbtesAsocDelPvLocal(fuente)) {
      fallas.push(`${p}: infiere el CbtesAsoc desde punto_venta LOCAL. Ese PV puede no existir en AFIP; el CbtesAsoc sale sólo de numero_fiscal (parseNumeroFiscal) y si falta, la NC no se emite.`)
    }
    if (armaNumeroConPvLocal(fuente)) {
      fallas.push(`${p}: volvió el helper que arma el número pegando el punto de venta LOCAL. La identidad la resuelve identidadVisible: manda numero_fiscal.`)
    }
    if (priorizaNumeroLocalSobreFiscal(fuente)) {
      fallas.push(`${p}: usa \`numero || numero_fiscal\`. El número local nunca es nulo, así que el fiscal no se mostraría jamás.`)
    }
  }

  // ── La migración del contrato fiscal sigue en pie ──
  if (!existsSync(join(RAIZ, MIGRACION_FISCAL))) {
    fallas.push(`Falta ${MIGRACION_FISCAL}: desapareció la migración que resuelve el punto de venta fiscal server-side.`)
  } else if (!resuelvePvFiscalServerSide(readFileSync(join(RAIZ, MIGRACION_FISCAL), 'utf-8'))) {
    fallas.push(`${MIGRACION_FISCAL}: perdió la resolución server-side del PV fiscal (arca_config + ARCA_NOT_CONFIGURED + fiscalidad derivada del tipo).`)
  }

  return fallas
}

// ─── Self-test ──────────────────────────────────────────────────────────────
//
// Cada comprobación se prueba en los DOS sentidos: que cace lo que tiene que
// cazar y que no marque lo correcto. Un guard que nunca falla no protege nada.

function selfTest() {
  const casos = []
  const chequear = (nombre, real, esperado) => {
    const ok = JSON.stringify(real) === JSON.stringify(esperado)
    casos.push({ nombre, ok, real, esperado })
  }

  const ROTA = `
    supabase.from('sales_points').select('punto_venta').eq('business_id', b)
      .eq('is_active', true).order('created_at', { ascending: true }).limit(1).maybeSingle()
      .then(({ data }) => { if (data?.punto_venta) setPuntoVenta(data.punto_venta) })
  `
  const SANA = `
    supabase.from('sales_points')
      .select('id, numero, nombre, activo, predeterminado')
      .eq('business_id', businessId)
      .eq('activo', true)
      .order('predeterminado', { ascending: false })
      .order('numero', { ascending: true })
      .limit(1).maybeSingle()
  `
  // punto_venta LEGÍTIMO: otra tabla. No puede marcarse.
  const OTRA_TABLA = `
    supabase.from('comprobantes').select('*').eq('punto_venta', pv).eq('numero', n).single()
  `
  // is_active legítimo sobre otra tabla, en un archivo que TAMBIÉN lee sales_points.
  const MIXTO = `
    supabase.from('sales_points').select('numero').eq('activo', true).maybeSingle()
    supabase.from('inventory').select('id').eq('is_active', true)
  `

  chequear('caza las dos columnas inexistentes',
    columnasInexistentesEnSalesPoints(ROTA).sort(), ['is_active', 'punto_venta'])
  chequear('no marca la consulta sana',
    columnasInexistentesEnSalesPoints(SANA), [])
  chequear('no marca punto_venta en comprobantes',
    columnasInexistentesEnSalesPoints(OTRA_TABLA), [])
  chequear('no marca is_active de OTRA tabla en el mismo archivo',
    columnasInexistentesEnSalesPoints(MIXTO), [])
  chequear('no marca un archivo que ni toca la tabla',
    columnasInexistentesEnSalesPoints('const x = 1'), [])

  chequear('detecta el acceso directo', tocaSalesPointsDirecto(SANA), true)
  chequear('no marca el acceso vía servicio',
    tocaSalesPointsDirecto(`salesPointService.getActive(businessId)`), false)

  chequear('caza la falta del filtro activo', filtraPorActivo(ROTA), false)
  chequear('reconoce el filtro activo', filtraPorActivo(SANA), true)

  chequear('caza la falta de numero', seleccionaNumero(ROTA), false)
  chequear('reconoce el select de numero', seleccionaNumero(SANA), true)

  chequear('caza el orden por created_at', priorizaPredeterminado(ROTA), false)
  chequear('reconoce el desempate por predeterminado', priorizaPredeterminado(SANA), true)

  chequear('caza el error indistinguible',
    distingueErrorDeAusencia(`return { salesPoint: null }`), false)
  chequear('reconoce el flag de fallo',
    distingueErrorDeAusencia(`return { salesPoint: null, fallo: true }`), true)

  chequear('caza el error descartado',
    registraElError(`if (error) return { salesPoint: null, fallo: true }`), false)
  chequear('reconoce el logueo',
    registraElError(`logger.error('POS', 'no se pudo leer el PV', error)`), true)

  // ── Contrato fiscal ──
  chequear('caza el CbtesAsoc inferido del PV local',
    infiereCbtesAsocDelPvLocal(
      `const pv = nroParts[0] ? parseInt(nroParts[0],10) : (parseInt(original.punto_venta || '1', 10))`), true)
  chequear('no marca el CbtesAsoc canonico',
    infiereCbtesAsocDelPvLocal(
      `const pv = parseInt(identidadOriginal.puntoVenta, 10)`), false)

  chequear('caza el numero armado con el PV local',
    armaNumeroConPvLocal(
      `function formatNumero(numero: string | null, puntoVenta: string) { return pv }`), true)
  chequear('no marca la superficie migrada',
    armaNumeroConPvLocal(`const identidad = identidadVisible(comprobante)`), false)

  chequear('caza el listado que esconde el numero fiscal',
    priorizaNumeroLocalSobreFiscal(`{comp.numero || comp.numero_fiscal || '-'}`), true)
  chequear('no marca el listado migrado',
    priorizaNumeroLocalSobreFiscal(`{identidadVisible(comp).texto}`), false)

  chequear('reconoce la migracion fiscal completa',
    resuelvePvFiscalServerSide(`
      v_tipo_es_fiscal := (v_tipo IN ('factura_a','factura_c','nota_credito'));
      SELECT punto_venta INTO v_arca_pv FROM arca_config WHERE business_id = p_business_id;
      RAISE EXCEPTION 'ARCA_NOT_CONFIGURED: falta el PV';`), true)
  chequear('caza la migracion sin fail-closed',
    resuelvePvFiscalServerSide(`
      v_tipo_es_fiscal := (v_tipo IN ('factura_a'));
      SELECT punto_venta INTO v_arca_pv FROM arca_config;`), false)

  const fallidos = casos.filter(c => !c.ok)
  for (const c of casos) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.nombre}`)
    if (!c.ok) console.log(`      esperado ${JSON.stringify(c.esperado)}, obtuvo ${JSON.stringify(c.real)}`)
  }
  if (fallidos.length) {
    console.error(`\n✗ Self-test FALLIDO: ${fallidos.length}/${casos.length} comprobaciones no se comportan como dicen.`)
    process.exit(1)
  }
  console.log(`\n✓ Self-test OK: ${casos.length} comprobaciones verificadas en ambos sentidos.`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  console.log('\n─── guard:sales-point · self-test ──────────────────────────────────')
  selfTest()
} else {
  const fallas = validarRepo()
  if (fallas.length) {
    console.error('\n' + '═'.repeat(74))
    console.error('  GUARD FALLIDO — la lectura del punto de venta se salió del contrato real')
    console.error('═'.repeat(74))
    for (const f of fallas) console.error(`  ✗ ${f}`)
    console.error('═'.repeat(74) + '\n')
    process.exit(1)
  }
  console.log('✓ guard:sales-point — la lectura del punto de venta usa el contrato real de la tabla.')
}
