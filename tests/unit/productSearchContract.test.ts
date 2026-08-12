/**
 * P0 SEARCH — contrato canónico de búsqueda de productos vendibles.
 *
 * Runner: node:test nativo. Ejecutar: npm run test:unit
 *
 * Cubre la parte que causó el P0: cómo se traduce el texto del cajero a
 * filtros de servidor, y qué cuenta como producto vendible. Todo es puro:
 * ni red, ni Supabase, ni entorno Vite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getVariantParentId,
  isVariantChild,
  isGroupingParent,
  isSellableProduct,
  productDisplayName,
  VARIANT_PARENT_PREFIXES,
} from '../../src/lib/productSellability.ts'
import {
  buildSearchTokens,
  buildTokenOrFilter,
  sanitizeToken,
  phraseRelevanceBonus,
  sortByPhraseRelevance,
  buildParentReferenceFilter,
  extractParentIds,
  PRODUCT_MATCH_COLUMNS,
  MIN_QUERY_LENGTH,
} from '../../src/lib/productSearchQuery.ts'
import { buildSupabaseQuery } from '../../src/utils/searchUtils.ts'

const PADRE_ID = '00000000-0000-0000-0000-00000e2ef001'

// ─── Vínculo hijo → padre: las TRES representaciones vivas ──────────────────

test('reconoce la variante por parent_id (productService)', () => {
  assert.equal(getVariantParentId({ parent_id: PADRE_ID }), PADRE_ID)
  assert.equal(isVariantChild({ parent_id: PADRE_ID }), true)
})

test('reconoce la variante por supplier_code variant_parent: (página de Inventario)', () => {
  const item = { supplier_code: `variant_parent:${PADRE_ID}` }
  assert.equal(getVariantParentId(item), PADRE_ID)
  assert.equal(isVariantChild(item), true)
})

test('reconoce la variante por supplier_code VPREF- (legacy)', () => {
  const item = { supplier_code: `VPREF-${PADRE_ID}` }
  assert.equal(getVariantParentId(item), PADRE_ID)
  assert.equal(isVariantChild(item), true)
})

test('las tres representaciones resuelven al MISMO padre', () => {
  const porId = getVariantParentId({ parent_id: PADRE_ID })
  const porPrefijo = getVariantParentId({ supplier_code: `variant_parent:${PADRE_ID}` })
  const porLegacy = getVariantParentId({ supplier_code: `VPREF-${PADRE_ID}` })
  assert.equal(porId, porPrefijo)
  assert.equal(porPrefijo, porLegacy)
})

test('un supplier_code común NO convierte al producto en variante', () => {
  assert.equal(getVariantParentId({ supplier_code: 'PROV-ACME-123' }), null)
  assert.equal(isVariantChild({ supplier_code: 'PROV-ACME-123' }), false)
  assert.equal(getVariantParentId({}), null)
  assert.equal(getVariantParentId(null), null)
})

test('un prefijo sin id detrás no cuenta como vínculo', () => {
  for (const prefijo of VARIANT_PARENT_PREFIXES) {
    assert.equal(getVariantParentId({ supplier_code: prefijo }), null)
  }
})

// ─── Vendibilidad ───────────────────────────────────────────────────────────

test('el padre agrupador NO es vendible', () => {
  const padre = { has_variants: true, is_active: true }
  assert.equal(isGroupingParent(padre), true)
  assert.equal(isSellableProduct(padre), false)
})

test('la variante hija SÍ es vendible', () => {
  const hija = { has_variants: false, is_active: true, supplier_code: `variant_parent:${PADRE_ID}` }
  assert.equal(isGroupingParent(hija), false)
  assert.equal(isSellableProduct(hija), true)
})

test('el producto simple es vendible', () => {
  assert.equal(isSellableProduct({ has_variants: false, is_active: true }), true)
})

test('un producto inactivo no es vendible aunque no tenga variantes', () => {
  assert.equal(isSellableProduct({ has_variants: false, is_active: false }), false)
})

test('sin stock NO deja de ser vendible: es un estado, no una ausencia', () => {
  // Si el stock entrara en la definición, un producto agotado se vería como
  // inexistente y el cajero lo cargaría a mano duplicado.
  const agotado = { has_variants: false, is_active: true, stock_quantity: 0 }
  assert.equal(isSellableProduct(agotado), true)
})

test('has_variants null/undefined se trata como NO agrupador', () => {
  // El default de la columna es false, pero las filas viejas pueden tener null.
  assert.equal(isSellableProduct({ has_variants: null, is_active: true }), true)
  assert.equal(isSellableProduct({ is_active: true }), true)
})

// ─── Nombre para mostrar ────────────────────────────────────────────────────

test('compone nombre del padre + variante cuando el name no la incluye', () => {
  assert.equal(
    productDisplayName({ name: 'Vidrio Templado iPhone 14', variant_name: 'Privacidad' }),
    'Vidrio Templado iPhone 14 — Privacidad',
  )
})

test('no duplica el atributo cuando el name ya lo trae', () => {
  assert.equal(
    productDisplayName({ name: 'Funda Silicone iPhone 15 - Negro', variant_name: 'Negro' }),
    'Funda Silicone iPhone 15 - Negro',
  )
})

test('sin variant_name devuelve el name tal cual', () => {
  assert.equal(productDisplayName({ name: 'Bateria iPhone 11' }), 'Bateria iPhone 11')
  assert.equal(productDisplayName({ name: 'Bateria iPhone 11', variant_name: '  ' }), 'Bateria iPhone 11')
})

// ─── Tokenización: LA REGRESIÓN P0 ──────────────────────────────────────────

test('REGRESIÓN P0: la búsqueda conserva TODOS los tokens, no sólo el más largo', () => {
  const q = 'funda silicone iphone 15 negro'
  const tokens = buildSearchTokens(q)

  assert.deepEqual(tokens, ['funda', 'silicone', 'iphone', '15', 'negro'])

  // El comportamiento viejo: un único término, el resto se perdía antes de
  // llegar al servidor. Se deja aserción explícita para que quede registrado
  // por qué esto era un P0 y no una preferencia de estilo.
  const viejo = buildSupabaseQuery(q)
  assert.equal(viejo, '%silicone%')
  assert.ok(tokens.length > 1, 'el contrato nuevo debe mandar más de un token')
})

test('REGRESIÓN P0: un SKU exacto no se degrada a su primer fragmento', () => {
  const sku = 'SRCH-FUN-IP15-VAR-01'
  const tokens = buildSearchTokens(sku)

  // Antes: el SKU completo colapsaba a "%srch%" y traía cualquier cosa.
  assert.equal(buildSupabaseQuery(sku), '%srch%')
  assert.deepEqual(tokens, ['srch', 'fun', 'ip15', 'var', '01'])
})

test('normaliza acentos, mayúsculas y espacios repetidos al mismo conjunto', () => {
  const esperado = ['bateria', 'iphone', '11']
  assert.deepEqual(buildSearchTokens('Batería iPhone 11'), esperado)
  assert.deepEqual(buildSearchTokens('BATERIA   IPHONE 11'), esperado)
  assert.deepEqual(buildSearchTokens('  bateria iphone 11  '), esperado)
})

test('descarta comodines y sintaxis de PostgREST de los tokens', () => {
  // Un '%' sin sanear convertiría el token en comodín; una coma o un paréntesis
  // romperían el filtro `or=(...)`.
  assert.equal(sanitizeToken('ip%15'), 'ip15')
  assert.equal(sanitizeToken('a,b'), 'ab')
  assert.equal(sanitizeToken('(x)'), 'x')
  assert.equal(sanitizeToken('_'), '')
  assert.equal(sanitizeToken('%%%'), '')
})

test('una query que sólo tiene símbolos no produce tokens', () => {
  assert.deepEqual(buildSearchTokens('%%%'), [])
  assert.deepEqual(buildSearchTokens('---'), [])
  assert.deepEqual(buildSearchTokens('   '), [])
})

test('conserva letras acentuadas y dígitos dentro del token', () => {
  // normalizeText ya saca los diacríticos; sanitizeToken no debe comerse letras.
  assert.equal(sanitizeToken('niño'), 'niño')
  assert.equal(sanitizeToken('15w'), '15w')
})

// ─── Filtro de servidor ─────────────────────────────────────────────────────

test('el filtro de un token cubre todos los campos buscables', () => {
  const filtro = buildTokenOrFilter('negro')
  for (const col of PRODUCT_MATCH_COLUMNS) {
    assert.ok(filtro.includes(`${col}.ilike.%negro%`), `falta el campo ${col}`)
  }
})

test('el filtro busca en variant_name y en code, no sólo en name', () => {
  // Buscar "negro" tiene que encontrar la variante aunque el atributo viva en
  // variant_name; buscar un SKU tiene que encontrarla por code.
  const filtro = buildTokenOrFilter('x')
  assert.ok(filtro.includes('variant_name.ilike.%x%'))
  assert.ok(filtro.includes('code.ilike.%x%'))
  assert.ok(filtro.includes('subcategory.ilike.%x%'))
})

test('MIN_QUERY_LENGTH es 2: una sola letra no dispara consulta', () => {
  assert.equal(MIN_QUERY_LENGTH, 2)
})

// ─── Detección estructural de padre ─────────────────────────────────────────

test('el filtro de padres cubre parent_id y los dos prefijos de supplier_code', () => {
  const filtro = buildParentReferenceFilter([PADRE_ID])
  assert.ok(filtro)
  assert.ok(filtro.includes(`parent_id.in.(${PADRE_ID})`))
  assert.ok(filtro.includes(`"variant_parent:${PADRE_ID}"`))
  assert.ok(filtro.includes(`"VPREF-${PADRE_ID}"`))
})

test('el filtro descarta ids que no son UUID', () => {
  // Los ids vienen de la base, pero el filtro no debe poder incrustar
  // cualquier cosa en la query.
  assert.equal(buildParentReferenceFilter(['no-es-uuid', '']), null)
  assert.equal(buildParentReferenceFilter([]), null)
})

test('extractParentIds reconoce las tres representaciones', () => {
  const padres = extractParentIds([
    { parent_id: 'p1' },
    { supplier_code: 'variant_parent:p2' },
    { supplier_code: 'VPREF-p3' },
    { supplier_code: 'PROV-ACME' },
    { parent_id: null, supplier_code: null },
  ])
  assert.deepEqual([...padres].sort(), ['p1', 'p2', 'p3'])
})

test('REGRESIÓN: un padre con has_variants=false pero con hijos NO es vendible', () => {
  // has_variants lo escribe el cliente y ningún trigger lo mantiene; en
  // createProductWithVariants se setea con un UPDATE separado sin chequear.
  // Por eso la estructura tiene que mandar sobre el flag.
  const padreRoto = { id: 'p1', is_active: true, has_variants: false }

  // El flag solo lo daría por vendible...
  assert.equal(isSellableProduct(padreRoto), true)

  // ...pero la estructura lo desmiente.
  const padres = extractParentIds([{ parent_id: 'p1' }])
  assert.ok(padres.has('p1'), 'debe detectarse como padre por estructura')
})

// ─── Ranking por frase ──────────────────────────────────────────────────────

test('el escalón de relevancia respeta SKU > nombre exacto > prefijo > frase', () => {
  const q = 'funda silicone iphone 15'
  const sku      = phraseRelevanceBonus({ name: 'Otro', code: 'funda silicone iphone 15' }, q)
  const exacto   = phraseRelevanceBonus({ name: 'Funda Silicone iPhone 15', code: 'X' }, q)
  const prefijo  = phraseRelevanceBonus({ name: 'Funda Silicone iPhone 15 - Negro', code: 'X' }, q)
  const contiene = phraseRelevanceBonus({ name: 'Combo Funda Silicone iPhone 15 Pack', code: 'X' }, q)
  const nada     = phraseRelevanceBonus({ name: 'Silicone iPhone Generico 150', code: 'SRCH-FILL-150' }, q)

  assert.ok(sku > exacto, 'el SKU exacto manda')
  assert.ok(exacto > prefijo, 'el nombre exacto va antes que el prefijo')
  assert.ok(prefijo > contiene, 'el prefijo va antes que la frase contenida')
  assert.ok(contiene > nada, 'la frase contenida va antes que nada')
  assert.equal(nada, 0)
})

test('REGRESIÓN: el relleno no le gana a la variante buscada', () => {
  // Medido en el fixture: "Silicone iPhone Generico 150" salía PRIMERO porque
  // su código matchea el token "15" en un campo de mucho peso. Como la primera
  // opción se agrega con Enter, eso cargaba OTRO producto al carrito.
  const orden = sortByPhraseRelevance(
    [
      { id: 'relleno', name: 'Silicone iPhone Generico 150', code: 'SRCH-FILL-150' },
      { id: 'negro',   name: 'Funda Silicone iPhone 15 - Negro', code: 'SRCH-FUN-IP15-VAR-01' },
    ],
    'Funda Silicone iPhone 15',
  )
  assert.equal(orden[0].id, 'negro')
})

test('la variante con el atributo en variant_name también gana por frase', () => {
  // Representación B: `name` es el del padre y el atributo va aparte.
  const bonus = phraseRelevanceBonus(
    { name: 'Vidrio Templado iPhone 14', variant_name: 'Privacidad', code: 'X' },
    'vidrio templado iphone 14 privacidad',
  )
  assert.ok(bonus >= 5_000, 'la etiqueta completa debe contar como nombre exacto')
})

test('el orden es estable ante el mismo bonus', () => {
  const items = [
    { id: 'a', name: 'Funda Silicone iPhone 15 - Azul',  code: 'A' },
    { id: 'b', name: 'Funda Silicone iPhone 15 - Negro', code: 'B' },
    { id: 'c', name: 'Funda Silicone iPhone 15 - Rosa',  code: 'C' },
  ]
  const orden = sortByPhraseRelevance(items, 'Funda Silicone iPhone 15')
  assert.deepEqual(orden.map(i => i.id), ['a', 'b', 'c'])
})
