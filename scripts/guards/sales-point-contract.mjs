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
  'supabase/migrations/20260814150000_fiscal_sales_point_canonical_contract.sql'
const EDGE_AFIP_CAE = 'supabase/functions/afip-cae/index.ts'

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
    && /v_tipo_es_fiscal\s*:=\s*\(v_tipo\s+IN\s*\(\s*'factura_a'\s*,\s*'factura_c'\s*\)\s*\)/.test(sql)
    && /v_es_fiscal\s*:=\s*v_tipo_es_fiscal/.test(sql)
    && /business_id\s*=\s*p_business_id\s+AND punto_venta\s*>\s*0/.test(sql)
}

/** La NC sólo entra por la RPC que exige original; nunca por el checkout POS. */
export function rechazaNotaCreditoCheckoutGenerico(sql) {
  const guard = sql.indexOf("IF v_tipo = 'nota_credito' THEN")
  const hash = sql.indexOf('v_server_hash := public.compute_checkout_intent_hash')
  const requestInsert = sql.indexOf('INSERT INTO comprobante_checkout_requests')
  return guard >= 0
    && /CREDIT_NOTE_REQUIRES_ORIGINAL/.test(sql)
    && hash >= 0
    && requestInsert >= 0
    && guard < hash
    && guard < requestInsert
}

/** Un documento no fiscal no puede convertir un flag cliente en intento ARCA. */
export function rechazaArcaEnRemitoAntesDeEscribir(sql) {
  const guard = sql.indexOf("IF v_tipo = 'remito' AND v_emitir_en_arca THEN")
  const requestInsert = sql.indexOf('INSERT INTO comprobante_checkout_requests')
  return guard >= 0
    && /NON_FISCAL_ARCA_NOT_ALLOWED/.test(sql)
    && requestInsert >= 0
    && guard < requestInsert
}

/** La RPC de NC no puede inventar Factura C/NC-C cuando falta CbteTipo. */
export function notaCreditoFailClosedServerSide(sql) {
  const funcion = sql.indexOf('CREATE OR REPLACE FUNCTION public.create_credit_note_from_comprobante')
  const acceso = sql.indexOf('IF NOT v_has_access THEN', funcion)
  const lock = sql.indexOf('FOR UPDATE', acceso)
  return funcion >= 0
    && acceso > funcion
    && lock > acceso
    && /FISCAL_IDENTITY_INCOMPLETE/.test(sql)
    && /v_comp\.tipo IS DISTINCT FROM 'factura_c'/.test(sql)
    && /v_original_cbte_tipo IS DISTINCT FROM 11/.test(sql)
    && /v_nc_tipo_fiscal\s*:=\s*13/.test(sql)
    && /SELECT punto_venta INTO v_arca_pv\s+FROM arca_config/.test(sql)
    && /ARCA_NOT_CONFIGURED/.test(sql)
    && /WHERE comprobante_original_id = p_comprobante_id\s+AND business_id = v_business_id/.test(sql)
    && /'nota_credito', 'nota_credito', lpad\(v_arca_pv::text, 4, '0'\)/.test(sql)
    && !/CASE\s+COALESCE\(v_comp\.tipo_comprobante_fiscal/i.test(sql)
    && !/ELSE\s+13\b/.test(sql)
}

/** Emision diferida: PV invalido no puede persistirse en un attempt nuevo. */
export function protegeAttemptConPvPositivo(sql) {
  return /ADD CONSTRAINT arca_emission_attempts_positive_punto_venta\s+CHECK \(punto_venta > 0\) NOT VALID/.test(sql)
}

/** El attempt conserva original + terna como snapshot all-or-none y positivo. */
export function protegeSnapshotCbtesAsoc(sql) {
  return /ADD COLUMN cbte_asoc_original_id uuid/.test(sql)
    && /ADD COLUMN cbte_asoc_tipo integer/.test(sql)
    && /ADD COLUMN cbte_asoc_punto_venta integer/.test(sql)
    && /ADD COLUMN cbte_asoc_numero integer/.test(sql)
    && /arca_emission_attempts_cbtes_asoc_all_or_none[\s\S]*?num_nonnulls\([\s\S]*?\) IN \(0, 4\)/.test(sql)
    && /arca_emission_attempts_cbtes_asoc_positive[\s\S]*?cbte_asoc_tipo IS NULL OR cbte_asoc_tipo > 0[\s\S]*?cbte_asoc_punto_venta IS NULL OR cbte_asoc_punto_venta > 0[\s\S]*?cbte_asoc_numero IS NULL OR cbte_asoc_numero > 0/.test(sql)
    && /FOREIGN KEY \(cbte_asoc_original_id\)[\s\S]*?REFERENCES public\.comprobantes\(id\)/.test(sql)
}

/** La RPC snapshot revalida NC-C/original/attempt y solo expone service_role. */
export function snapshotCbtesAsocFailClosed(sql) {
  const inicio = sql.indexOf('CREATE OR REPLACE FUNCTION public.snapshot_arca_nc_cbtes_asoc')
  const fin = sql.indexOf('CREATE OR REPLACE FUNCTION public.create_comprobante_checkout_atomic', inicio)
  if (inicio < 0 || fin < 0) return false
  const cuerpo = sql.slice(inicio, fin)
  return /SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/.test(cuerpo)
    && /v_attempt\.status NOT IN \('claimed', 'number_reserved', 'sent'\)/.test(cuerpo)
    && /v_attempt\.tipo_comprobante IS DISTINCT FROM 13/.test(cuerpo)
    && /v_nc\.tipo IS DISTINCT FROM 'nota_credito'/.test(cuerpo)
    && /v_nc\.comprobante_original_id IS DISTINCT FROM p_original_id/.test(cuerpo)
    && /v_original\.tipo IS DISTINCT FROM 'factura_c'/.test(cuerpo)
    && /v_original_tipo IS DISTINCT FROM 11/.test(cuerpo)
    && /CBTES_ASOC_SNAPSHOT_CONFLICT/.test(cuerpo)
    && /v_attempt\.cbte_asoc_original_id IS NOT DISTINCT FROM p_original_id/.test(cuerpo)
    && /REVOKE EXECUTE ON FUNCTION public\.snapshot_arca_nc_cbtes_asoc[\s\S]*?FROM anon/.test(cuerpo)
    && /REVOKE EXECUTE ON FUNCTION public\.snapshot_arca_nc_cbtes_asoc[\s\S]*?FROM authenticated/.test(cuerpo)
    && /GRANT EXECUTE ON FUNCTION public\.snapshot_arca_nc_cbtes_asoc[\s\S]*?TO service_role/.test(cuerpo)
}

/** La Edge fija el snapshot despues del resolver y antes de toda llamada ARCA. */
export function edgePersisteSnapshotAntesDeArca(fuente) {
  const resolver = fuente.indexOf('await resolverCbtesAsocCanonico')
  const snapshot = fuente.indexOf('await persistirCbtesAsocSnapshot', resolver)
  const wsaa = fuente.indexOf("supabase.functions.invoke('afip-wsaa'", resolver)
  const ultimo = fuente.indexOf('await getUltimoComprobante', resolver)
  const solicitar = fuente.indexOf('await solicitarCAEConReconciliacion', resolver)
  return resolver >= 0
    && snapshot > resolver
    && snapshot < wsaa
    && snapshot < ultimo
    && snapshot < solicitar
    && /if \(!snapshot\.ok\)[\s\S]{0,300}?return jsonResponse/.test(fuente.slice(snapshot))
    && /supabase\.rpc\('snapshot_arca_nc_cbtes_asoc'/.test(fuente)
}

/** Una sola RPC debe cerrar original y ambos libros, con replay idempotente. */
export function finalizaNotaCreditoAtomica(sql) {
  const inicio = sql.indexOf('CREATE OR REPLACE FUNCTION public.create_credit_note_finance_reversal')
  if (inicio < 0) return false
  const cuerpo = sql.slice(inicio)
  const acceso = cuerpo.indexOf('IF NOT v_has_access THEN')
  const lock = cuerpo.indexOf('FOR UPDATE', acceso)
  const scope = cuerpo.indexOf("set_config('m7.annulment_scope', '1', true)")
  const updateOriginal = cuerpo.search(/UPDATE public\.comprobantes\s+SET estado = 'anulado'/)
  const pruebaAttempt = cuerpo.indexOf('SELECT * INTO v_attempt')
  const insertaFm = cuerpo.indexOf('INSERT INTO public.financial_movements')
  const insertaBfe = cuerpo.indexOf('INSERT INTO public.business_finance_entries')
  return acceso >= 0
    && lock > acceso
    && pruebaAttempt > lock
    && insertaFm > pruebaAttempt
    && insertaBfe > pruebaAttempt
    && scope > lock
    && updateOriginal > scope
    && /auth\.role\(\) = 'service_role'/.test(cuerpo)
    && /v_nc_tipo IS DISTINCT FROM 13/.test(cuerpo)
    && /v_original_tipo IS DISTINCT FROM 11/.test(cuerpo)
    && /status IN \('authorized', 'authorized_reconciled'\)/.test(cuerpo)
    && /numero_intentado = v_nc_numero/.test(cuerpo)
    && /cae = v_nc\.cae/.test(cuerpo)
    && /cbte_asoc_original_id = v_original\.id/.test(cuerpo)
    && /cbte_asoc_tipo = v_original_tipo/.test(cuerpo)
    && /cbte_asoc_punto_venta = v_original_pv/.test(cuerpo)
    && /cbte_asoc_numero = v_original_numero/.test(cuerpo)
    && !/WHEN unique_violation/.test(cuerpo)
    && /original_finalized/.test(cuerpo)
}

/** Las redefiniciones forward-only deben aplicarse como una sola unidad. */
export function migracionFiscalAtomica(sql) {
  return /\bBEGIN;\s*SET LOCAL lock_timeout/.test(sql)
    && /SET LOCAL statement_timeout/.test(sql)
    && /COMMIT;\s*$/.test(sql)
}

/** `numero_fiscal` aislado no identifica una serie: no puede ser UNIQUE. */
export function agregaUnicidadNumeroFiscal(sql) {
  const sinComentarios = sql
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  const definiciones = [
    ...sinComentarios.matchAll(/CREATE\s+UNIQUE\s+INDEX[\s\S]{0,300}?\(([^)]*)\)/gi),
    ...sinComentarios.matchAll(/\bUNIQUE\s*\(([^)]*)\)/gi),
  ]
  return definiciones.some((m) => {
    const columnas = m[1]
    return /\bnumero_fiscal\b/i.test(columnas)
      && !/\btipo_comprobante_fiscal\b/i.test(columnas)
  })
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
  } else {
    const sqlFiscal = readFileSync(join(RAIZ, MIGRACION_FISCAL), 'utf-8')
    if (!resuelvePvFiscalServerSide(sqlFiscal)) {
      fallas.push(`${MIGRACION_FISCAL}: perdió la resolución server-side del PV fiscal (arca_config con PV > 0 + ARCA_NOT_CONFIGURED + fiscalidad persistida derivada del tipo).`)
    }
    if (!notaCreditoFailClosedServerSide(sqlFiscal)) {
      fallas.push(`${MIGRACION_FISCAL}: la RPC de NC volvió a inventar el CbteTipo cuando falta identidad fiscal completa del original.`)
    }
    if (!rechazaNotaCreditoCheckoutGenerico(sqlFiscal)) {
      fallas.push(`${MIGRACION_FISCAL}: el checkout genérico puede crear una NC sin comprobante original o deja escrituras antes de rechazarla.`)
    }
    if (!rechazaArcaEnRemitoAntesDeEscribir(sqlFiscal)) {
      fallas.push(`${MIGRACION_FISCAL}: un remito puede pedir ARCA o el rechazo ocurre después de escribir idempotencia.`)
    }
    if (!migracionFiscalAtomica(sqlFiscal)) {
      fallas.push(`${MIGRACION_FISCAL}: las redefiniciones forward-only no están envueltas en una transacción explícita.`)
    }
    if (!protegeAttemptConPvPositivo(sqlFiscal)) {
      fallas.push(`${MIGRACION_FISCAL}: una emisión diferida puede persistir un attempt con punto de venta 0/negativo.`)
    }
    if (!protegeSnapshotCbtesAsoc(sqlFiscal)) {
      fallas.push(`${MIGRACION_FISCAL}: el attempt perdió el snapshot all-or-none/positivo de original + CbtesAsoc.`)
    }
    if (!snapshotCbtesAsocFailClosed(sqlFiscal)) {
      fallas.push(`${MIGRACION_FISCAL}: la RPC snapshot no es service_role-only o dejó de revalidar NC-C/original/attempt/replay exacto.`)
    }
    if (!finalizaNotaCreditoAtomica(sqlFiscal)) {
      fallas.push(`${MIGRACION_FISCAL}: la NC puede finalizar sin prueba terminal exacta de attempt+snapshot o no cierra original + FM/BFE atómicamente.`)
    }
    if (agregaUnicidadNumeroFiscal(sqlFiscal)) {
      fallas.push(`${MIGRACION_FISCAL}: intenta hacer UNIQUE numero_fiscal sin CbteTipo; son series fiscales distintas.`)
    }
  }

  if (!existsSync(join(RAIZ, EDGE_AFIP_CAE))) {
    fallas.push(`Falta ${EDGE_AFIP_CAE}: no se puede verificar el orden fail-closed de CbtesAsoc.`)
  } else if (!edgePersisteSnapshotAntesDeArca(readFileSync(join(RAIZ, EDGE_AFIP_CAE), 'utf-8'))) {
    fallas.push(`${EDGE_AFIP_CAE}: CbtesAsoc no se persiste con fail-closed antes de WSAA/numeración/FECAESolicitar.`)
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
    armaNumeroConPvLocal(`const numero = formatearNumeroComprobante(comprobante)`), false)

  chequear('caza el listado que esconde el numero fiscal',
    priorizaNumeroLocalSobreFiscal(`{comp.numero || comp.numero_fiscal || '-'}`), true)
  chequear('no marca el listado migrado',
    priorizaNumeroLocalSobreFiscal(`{formatearNumeroComprobante(comp)}`), false)

  chequear('reconoce la migracion fiscal completa',
    resuelvePvFiscalServerSide(`
      v_tipo_es_fiscal := (v_tipo IN ('factura_a','factura_c'));
      v_es_fiscal := v_tipo_es_fiscal;
      SELECT punto_venta INTO v_arca_pv FROM arca_config
       WHERE business_id = p_business_id AND punto_venta > 0;
      RAISE EXCEPTION 'ARCA_NOT_CONFIGURED: falta el PV';`), true)
  chequear('caza la migracion sin fail-closed',
    resuelvePvFiscalServerSide(`
      v_tipo_es_fiscal := (v_tipo IN ('factura_a'));
      SELECT punto_venta INTO v_arca_pv FROM arca_config;`), false)

  chequear('reconoce que la NC generica se rechaza antes de cualquier escritura',
    rechazaNotaCreditoCheckoutGenerico(`
      IF v_tipo = 'nota_credito' THEN
        RETURN jsonb_build_object('error_code','CREDIT_NOTE_REQUIRES_ORIGINAL');
      END IF;
      v_server_hash := public.compute_checkout_intent_hash(p_business_id, p_payload);
      INSERT INTO comprobante_checkout_requests DEFAULT VALUES;`), true)
  chequear('caza un rechazo tardio de NC despues del INSERT idempotente',
    rechazaNotaCreditoCheckoutGenerico(`
      v_server_hash := public.compute_checkout_intent_hash(p_business_id, p_payload);
      INSERT INTO comprobante_checkout_requests DEFAULT VALUES;
      IF v_tipo = 'nota_credito' THEN
        RETURN jsonb_build_object('error_code','CREDIT_NOTE_REQUIRES_ORIGINAL');
      END IF;`), false)

  chequear('reconoce que remito + ARCA falla antes de idempotencia',
    rechazaArcaEnRemitoAntesDeEscribir(`
      IF v_tipo = 'remito' AND v_emitir_en_arca THEN
        RETURN jsonb_build_object('error_code','NON_FISCAL_ARCA_NOT_ALLOWED');
      END IF;
      INSERT INTO comprobante_checkout_requests DEFAULT VALUES;`), true)
  chequear('caza la normalizacion silenciosa de ARCA en remito',
    rechazaArcaEnRemitoAntesDeEscribir(`
      v_emitir_en_arca := v_emitir_en_arca AND v_tipo_es_fiscal;
      INSERT INTO comprobante_checkout_requests DEFAULT VALUES;`), false)

  chequear('reconoce la NC fail-closed sin fallback de CbteTipo',
    notaCreditoFailClosedServerSide(`
      CREATE OR REPLACE FUNCTION public.create_credit_note_from_comprobante(p_comprobante_id uuid)
      RETURNS jsonb AS $$
      IF NOT v_has_access THEN RETURN '{}'::jsonb; END IF;
      SELECT * INTO v_comp FROM comprobantes WHERE id = p_comprobante_id FOR UPDATE;
      IF falta THEN RETURN jsonb_build_object('error_code','FISCAL_IDENTITY_INCOMPLETE'); END IF;
      IF v_comp.tipo IS DISTINCT FROM 'factura_c' OR v_original_cbte_tipo IS DISTINCT FROM 11 THEN RETURN '{}'::jsonb; END IF;
      v_nc_tipo_fiscal := 13;
      SELECT punto_venta INTO v_arca_pv FROM arca_config WHERE punto_venta > 0;
      IF v_arca_pv IS NULL THEN RETURN jsonb_build_object('error_code','ARCA_NOT_CONFIGURED'); END IF;
      SELECT id FROM comprobantes WHERE comprobante_original_id = p_comprobante_id
        AND business_id = v_business_id;
      INSERT INTO comprobantes(tipo, type, punto_venta)
      VALUES ('nota_credito', 'nota_credito', lpad(v_arca_pv::text, 4, '0'));
      $$ LANGUAGE plpgsql;`), true)
  chequear('caza el default silencioso a NC-C',
    notaCreditoFailClosedServerSide(`
      CREATE OR REPLACE FUNCTION public.create_credit_note_from_comprobante(p_comprobante_id uuid)
      RETURNS jsonb AS $$
      v_nc_tipo_fiscal := CASE COALESCE(v_comp.tipo_comprobante_fiscal, '11')::integer
        WHEN 1 THEN 3 ELSE 13 END;
      $$ LANGUAGE plpgsql;`), false)

  chequear('reconoce el constraint de PV positivo para attempts nuevos',
    protegeAttemptConPvPositivo(`ALTER TABLE public.arca_emission_attempts
      ADD CONSTRAINT arca_emission_attempts_positive_punto_venta
      CHECK (punto_venta > 0) NOT VALID;`), true)
  chequear('caza attempts sin defensa de PV positivo',
    protegeAttemptConPvPositivo(`INSERT INTO arca_emission_attempts(punto_venta) VALUES (0);`), false)

  chequear('reconoce snapshot all-or-none y positivo de CbtesAsoc',
    protegeSnapshotCbtesAsoc(`ALTER TABLE public.arca_emission_attempts
      ADD COLUMN cbte_asoc_original_id uuid,
      ADD COLUMN cbte_asoc_tipo integer,
      ADD COLUMN cbte_asoc_punto_venta integer,
      ADD COLUMN cbte_asoc_numero integer;
      ADD CONSTRAINT arca_emission_attempts_cbtes_asoc_all_or_none
        CHECK (num_nonnulls(cbte_asoc_original_id, cbte_asoc_tipo,
          cbte_asoc_punto_venta, cbte_asoc_numero) IN (0, 4));
      ADD CONSTRAINT arca_emission_attempts_cbtes_asoc_positive CHECK (
        (cbte_asoc_tipo IS NULL OR cbte_asoc_tipo > 0) AND
        (cbte_asoc_punto_venta IS NULL OR cbte_asoc_punto_venta > 0) AND
        (cbte_asoc_numero IS NULL OR cbte_asoc_numero > 0));
      FOREIGN KEY (cbte_asoc_original_id) REFERENCES public.comprobantes(id);`), true)
  chequear('caza un snapshot parcial/sin positivos',
    protegeSnapshotCbtesAsoc(`ALTER TABLE attempts ADD COLUMN cbte_asoc_tipo integer;`), false)

  chequear('reconoce RPC snapshot hardened, NC-C y replay exacto',
    snapshotCbtesAsocFailClosed(`
      CREATE OR REPLACE FUNCTION public.snapshot_arca_nc_cbtes_asoc()
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp AS $$
      IF v_attempt.status NOT IN ('claimed', 'number_reserved', 'sent') THEN RETURN '{}'; END IF;
      IF v_attempt.tipo_comprobante IS DISTINCT FROM 13 THEN RETURN '{}'; END IF;
      IF v_nc.tipo IS DISTINCT FROM 'nota_credito' OR
         v_nc.comprobante_original_id IS DISTINCT FROM p_original_id THEN RETURN '{}'; END IF;
      IF v_original.tipo IS DISTINCT FROM 'factura_c' OR
         v_original_tipo IS DISTINCT FROM 11 THEN RETURN '{}'; END IF;
      IF v_attempt.cbte_asoc_original_id IS NOT DISTINCT FROM p_original_id THEN RETURN '{}'; END IF;
      RAISE EXCEPTION 'CBTES_ASOC_SNAPSHOT_CONFLICT';
      $$;
      REVOKE EXECUTE ON FUNCTION public.snapshot_arca_nc_cbtes_asoc() FROM anon;
      REVOKE EXECUTE ON FUNCTION public.snapshot_arca_nc_cbtes_asoc() FROM authenticated;
      GRANT EXECUTE ON FUNCTION public.snapshot_arca_nc_cbtes_asoc() TO service_role;
      CREATE OR REPLACE FUNCTION public.create_comprobante_checkout_atomic()`), true)
  chequear('caza RPC snapshot expuesta o sin validacion de identidad',
    snapshotCbtesAsocFailClosed(`CREATE OR REPLACE FUNCTION public.snapshot_arca_nc_cbtes_asoc()
      RETURNS jsonb SECURITY DEFINER AS $$ UPDATE attempts SET cbte_asoc_tipo=11 $$;
      CREATE OR REPLACE FUNCTION public.create_comprobante_checkout_atomic()`), false)

  chequear('reconoce orden resolver -> snapshot -> WSAA/numeracion/ARCA',
    edgePersisteSnapshotAntesDeArca(`
      await resolverCbtesAsocCanonico()
      const snapshot = await persistirCbtesAsocSnapshot()
      if (!snapshot.ok) { return jsonResponse() }
      supabase.rpc('snapshot_arca_nc_cbtes_asoc')
      supabase.functions.invoke('afip-wsaa')
      await getUltimoComprobante()
      await solicitarCAEConReconciliacion()`), true)
  chequear('caza snapshot posterior a WSAA',
    edgePersisteSnapshotAntesDeArca(`
      await resolverCbtesAsocCanonico()
      supabase.functions.invoke('afip-wsaa')
      const snapshot = await persistirCbtesAsocSnapshot()
      if (!snapshot.ok) return jsonResponse()
      supabase.rpc('snapshot_arca_nc_cbtes_asoc')
      await getUltimoComprobante()
      await solicitarCAEConReconciliacion()`), false)

  chequear('reconoce finalizacion atomica de NC',
    finalizaNotaCreditoAtomica(`
      CREATE OR REPLACE FUNCTION public.create_credit_note_finance_reversal(p_nc_id uuid)
      RETURNS jsonb AS $$
      IF auth.role() = 'service_role' THEN NULL; END IF;
      IF NOT v_has_access THEN RETURN '{}'::jsonb; END IF;
      SELECT * FROM public.comprobantes FOR UPDATE;
      IF v_nc_tipo IS DISTINCT FROM 13 OR v_original_tipo IS DISTINCT FROM 11 THEN RETURN '{}'; END IF;
      SELECT * INTO v_attempt FROM attempts WHERE status IN ('authorized', 'authorized_reconciled')
        AND numero_intentado = v_nc_numero AND cae = v_nc.cae
        AND cbte_asoc_original_id = v_original.id
        AND cbte_asoc_tipo = v_original_tipo
        AND cbte_asoc_punto_venta = v_original_pv
        AND cbte_asoc_numero = v_original_numero;
      INSERT INTO public.financial_movements DEFAULT VALUES;
      INSERT INTO public.business_finance_entries DEFAULT VALUES;
      PERFORM pg_catalog.set_config('m7.annulment_scope', '1', true);
      UPDATE public.comprobantes SET estado = 'anulado';
      RETURN jsonb_build_object('original_finalized', true);
      $$ LANGUAGE plpgsql;`), true)
  chequear('caza lock pre-autorizacion o falta de scope canonico de anulacion',
    finalizaNotaCreditoAtomica(`
      CREATE OR REPLACE FUNCTION public.create_credit_note_finance_reversal(p_nc_id uuid)
      RETURNS jsonb AS $$
      SELECT * FROM public.comprobantes FOR UPDATE;
      IF NOT v_has_access THEN RETURN '{}'::jsonb; END IF;
      INSERT INTO public.financial_movements DEFAULT VALUES;
      INSERT INTO public.business_finance_entries DEFAULT VALUES;
      UPDATE public.comprobantes SET estado = 'anulado';
      IF auth.role() = 'service_role' THEN NULL; END IF;
      RETURN jsonb_build_object('original_finalized', true);
      $$ LANGUAGE plpgsql;`), false)
  chequear('caza finalizacion partida entre cliente y RPC',
    finalizaNotaCreditoAtomica(`CREATE OR REPLACE FUNCTION public.create_credit_note_finance_reversal()
      RETURNS void AS $$ INSERT INTO public.financial_movements DEFAULT VALUES; $$ LANGUAGE sql;`), false)

  chequear('reconoce la transaccion explicita de la migracion',
    migracionFiscalAtomica(`BEGIN;
      SET LOCAL lock_timeout = '8s';
      SET LOCAL statement_timeout = '120s';
      SELECT 1;
      COMMIT;`), true)
  chequear('caza redefiniciones sin transaccion explicita',
    migracionFiscalAtomica(`CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;`), false)

  chequear('acepta UNIQUE de la terna con CbteTipo',
    agregaUnicidadNumeroFiscal(`CREATE UNIQUE INDEX ok ON comprobantes (business_id, tipo_comprobante_fiscal, numero_fiscal);`), false)
  chequear('caza UNIQUE(numero_fiscal)',
    agregaUnicidadNumeroFiscal(`ALTER TABLE comprobantes ADD UNIQUE (numero_fiscal);`), true)
  chequear('caza UNIQUE(business_id, numero_fiscal) sin CbteTipo',
    agregaUnicidadNumeroFiscal(`CREATE UNIQUE INDEX mal ON comprobantes (business_id, numero_fiscal);`), true)
  chequear('acepta numero_fiscal sin restriccion UNIQUE',
    agregaUnicidadNumeroFiscal(`CREATE INDEX idx_nf ON comprobantes (numero_fiscal);`), false)

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
