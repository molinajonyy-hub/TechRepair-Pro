#!/usr/bin/env node
// ============================================================================
// Guard — La búsqueda de productos vendibles pasa por UN solo contrato.
//
//   node scripts/guards/product-search-canonical.mjs             (valida el repo)
//   node scripts/guards/product-search-canonical.mjs --self-test (valida el guard)
//
// ┌── QUÉ PROTEGE ──────────────────────────────────────────────────────────┐
// │ El POS mandaba UN token al servidor, traía un tope de filas SIN ORDER   │
// │ BY y recién ahí filtraba por el resto de los tokens en React. Con       │
// │ catálogo real eso descarta productos válidos antes de mirarlos: se      │
// │ veían en Inventario y no se podían cobrar.                              │
// │                                                                          │
// │ El arreglo obvio cuando alguien necesite "una búsqueda rapidita" es     │
// │ volver a escribir la query a mano en la pantalla de turno. Este guard    │
// │ hace que ese camino se note.                                            │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Se mide sobre el CÓDIGO FUENTE, no sobre el comportamiento: los tests de
// contrato ya cubren el comportamiento. Acá interesa que no reaparezca la
// FORMA que causó el incidente.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** Superficies que buscan productos y DEBEN usar el contrato canónico. */
const SUPERFICIES = [
  'src/components/comprobantes/ComprobanteProModal.tsx',
  'src/components/order/ModalAgregarItem.tsx',
  'src/components/ui/CommandPalette.tsx',
]

const SERVICIO = 'src/services/productSearchService.ts'
const CONTRATO = 'src/lib/productSellability.ts'

/**
 * Archivos que pueden nombrar los prefijos de variante sin ser el contrato.
 * `Inventory.tsx` los ESCRIBE y `useInventoryFinance.ts` es un lector legacy de
 * métricas patrimoniales: ninguno se migra en este lote, pero tampoco pueden
 * crecer en número sin que alguien lo decida.
 */
const LECTORES_DE_PREFIJO_PERMITIDOS = new Set([
  'src/lib/productSellability.ts',
  'src/pages/Inventory.tsx',
  'src/hooks/useInventoryFinance.ts',
])

// ─── Comprobaciones puras (testeables) ──────────────────────────────────────

/** La superficie no puede armar su propia búsqueda de inventario. */
export function buscaInventarioAMano(fuente) {
  // Una query a `inventory` que combine filtro de texto y tope es, por
  // definición, una búsqueda propia.
  const tocaInventario = /\.from\(\s*['"]inventory['"]\s*\)/.test(fuente)
  if (!tocaInventario) return false
  const tieneIlike = /\.or\(\s*[`'"][^`'"]*ilike/.test(fuente)
  const tieneTope = /\.limit\(/.test(fuente)
  return tieneIlike && tieneTope
}

/** `buildSupabaseQuery` es el helper de un solo token: no vuelve a productos. */
export function usaHelperDeUnSoloToken(fuente) {
  return /\bbuildSupabaseQuery\b/.test(fuente)
}

/** La superficie tiene que importar el contrato canónico. */
export function usaContratoCanonico(fuente) {
  return /from\s+['"][^'"]*productSearchService['"]/.test(fuente)
}

/** La búsqueda canónica ordena: sin ORDER BY el truncado es arbitrario. */
export function ordenaDeFormaDeterminista(fuente) {
  return /\.order\(/.test(fuente)
}

/** El padre agrupador sigue excluido del universo vendible. */
export function excluyePadreAgrupador(fuente) {
  return /\.not\(\s*['"]has_variants['"]\s*,\s*['"]is['"]\s*,\s*true\s*\)/.test(fuente)
}

/** Un fallo del backend se reporta como error, no como lista vacía. */
export function distingueErrorDeVacio(fuente) {
  return /status:\s*['"]error['"]/.test(fuente)
}

/** El AND multi-token se resuelve en el servidor, un filtro por token. */
export function haceAndMultiToken(fuente) {
  return /for\s*\(\s*const\s+\w+\s+of\s+tokens\s*\)/.test(fuente)
}

/** Nombra alguno de los prefijos de vínculo padre→hijo. */
export function nombraPrefijoDeVariante(fuente) {
  return /['"]variant_parent:['"]|['"]VPREF-['"]/.test(fuente)
}

/** La service_role key jamás puede vivir en el bundle del browser. */
export function exponeServiceRole(fuente) {
  return /SUPABASE_SERVICE_ROLE|service_role/.test(fuente)
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

function validarRepo() {
  const fallas = []
  const leer = p => readFileSync(join(RAIZ, p), 'utf-8')

  // 1. El contrato y el servicio existen.
  for (const p of [SERVICIO, CONTRATO]) {
    if (!existsSync(join(RAIZ, p))) {
      fallas.push(`Falta ${p}: el contrato canónico de búsqueda desapareció.`)
    }
  }
  if (fallas.length) return fallas

  const servicio = leer(SERVICIO)

  // 2. El servicio conserva las propiedades que cerraron el P0.
  if (!ordenaDeFormaDeterminista(servicio)) {
    fallas.push(`${SERVICIO}: la búsqueda perdió el ORDER BY. Sin orden estable, el tope devuelve un subconjunto arbitrario y un producto válido desaparece de la caja.`)
  }
  if (!excluyePadreAgrupador(servicio)) {
    fallas.push(`${SERVICIO}: dejó de excluir al padre agrupador (.not('has_variants','is',true)). Un padre seleccionable vende una unidad que no existe.`)
  }
  if (!distingueErrorDeVacio(servicio)) {
    fallas.push(`${SERVICIO}: ya no distingue el error del backend de "sin resultados". El cajero cargaría el producto a mano y lo duplicaría.`)
  }
  if (!haceAndMultiToken(servicio)) {
    fallas.push(`${SERVICIO}: el AND multi-token dejó de resolverse en el servidor. Ése es exactamente el limit-before-filter que causó el P0.`)
  }

  // 3. Las superficies no vuelven a escribir su propia búsqueda.
  for (const p of SUPERFICIES) {
    if (!existsSync(join(RAIZ, p))) {
      fallas.push(`Falta la superficie ${p} (¿se renombró? actualizá el guard a propósito).`)
      continue
    }
    const fuente = leer(p)
    if (buscaInventarioAMano(fuente)) {
      fallas.push(`${p}: volvió a armar una búsqueda propia sobre inventory (ilike + limit). Tiene que ir por searchSellableProducts.`)
    }
    if (usaHelperDeUnSoloToken(fuente)) {
      fallas.push(`${p}: usa buildSupabaseQuery, que se queda con UN solo token y descarta el resto antes del servidor.`)
    }
    if (!usaContratoCanonico(fuente)) {
      fallas.push(`${p}: no importa el contrato canónico (productSearchService).`)
    }
  }

  // 4. El criterio padre/hijo no se duplica por el repo.
  for (const abs of archivosDe(join(RAIZ, 'src'))) {
    const p = rel(abs)
    if (LECTORES_DE_PREFIJO_PERMITIDOS.has(p)) continue
    if (nombraPrefijoDeVariante(readFileSync(abs, 'utf-8'))) {
      fallas.push(`${p}: define su propio criterio de variante (prefijo 'variant_parent:'/'VPREF-'). Usá getVariantParentId del contrato: dos criterios divergentes es lo que hacía que Inventario y POS vieran universos distintos.`)
    }
  }

  // 5. La service_role nunca en el frontend.
  for (const abs of archivosDe(join(RAIZ, 'src'))) {
    if (exponeServiceRole(readFileSync(abs, 'utf-8'))) {
      fallas.push(`${rel(abs)}: menciona service_role. Esa key jamás puede entrar al bundle del browser.`)
    }
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
    casos.push({ nombre, ok: real === esperado, real, esperado })
  }

  const BUSQUEDA_A_MANO = `
    const { data } = await supabase.from('inventory')
      .select('id,name')
      .or(\`name.ilike.\${q},code.ilike.\${q}\`)
      .limit(40)
  `
  const BUSQUEDA_CANONICA = `
    import { searchSellableProducts } from '../../services/productSearchService'
    const res = await searchSellableProducts({ businessId, query: q, limit: 10 })
  `

  chequear('caza la búsqueda a mano', buscaInventarioAMano(BUSQUEDA_A_MANO), true)
  chequear('no marca la búsqueda canónica', buscaInventarioAMano(BUSQUEDA_CANONICA), false)
  // Una query a inventory que NO es búsqueda (scan por código exacto) es legítima.
  chequear('no marca el scan por código exacto', buscaInventarioAMano(`
    supabase.from('inventory').select('id').or(\`code.eq.\${c},barcode.eq.\${c}\`).limit(1)
  `), false)

  chequear('caza buildSupabaseQuery', usaHelperDeUnSoloToken('const q = buildSupabaseQuery(x)'), true)
  chequear('no marca su ausencia', usaHelperDeUnSoloToken(BUSQUEDA_CANONICA), false)

  chequear('reconoce el import canónico', usaContratoCanonico(BUSQUEDA_CANONICA), true)
  chequear('caza la falta del import canónico', usaContratoCanonico(BUSQUEDA_A_MANO), false)

  chequear('caza la falta de ORDER BY', ordenaDeFormaDeterminista(BUSQUEDA_A_MANO), false)
  chequear('reconoce el ORDER BY', ordenaDeFormaDeterminista(`q.order('name', { ascending: true })`), true)

  chequear('caza al padre agrupador sin excluir', excluyePadreAgrupador('q.eq("is_active", true)'), false)
  chequear('reconoce la exclusión del padre', excluyePadreAgrupador(`q.not('has_variants', 'is', true)`), true)

  chequear('caza el error disfrazado de vacío', distingueErrorDeVacio('return { items: [] }'), false)
  chequear('reconoce el error explícito', distingueErrorDeVacio(`return { status: 'error', items: [] }`), true)

  chequear('caza la pérdida del AND multi-token', haceAndMultiToken('q.or(filtro)'), false)
  chequear('reconoce el AND multi-token', haceAndMultiToken('for (const token of tokens) { q = q.or(f(token)) }'), true)

  chequear('caza el prefijo duplicado', nombraPrefijoDeVariante(`const P = 'variant_parent:'`), true)
  chequear('caza el prefijo legacy duplicado', nombraPrefijoDeVariante(`if (sc.startsWith('VPREF-'))`), true)
  chequear('no marca código sin prefijos', nombraPrefijoDeVariante('const x = 1'), false)

  chequear('caza la service_role', exponeServiceRole('const k = SUPABASE_SERVICE_ROLE_KEY'), true)
  chequear('no marca la anon key', exponeServiceRole('const k = VITE_SUPABASE_ANON_KEY'), false)

  const fallidos = casos.filter(c => !c.ok)
  for (const c of casos) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.nombre}`)
  }
  if (fallidos.length) {
    console.error(`\n✗ Self-test FALLIDO: ${fallidos.length}/${casos.length} comprobaciones no se comportan como dicen.`)
    process.exit(1)
  }
  console.log(`\n✓ Self-test OK: ${casos.length} comprobaciones verificadas en ambos sentidos.`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  console.log('\n─── guard:product-search · self-test ───────────────────────────────')
  selfTest()
} else {
  const fallas = validarRepo()
  if (fallas.length) {
    console.error('\n' + '═'.repeat(74))
    console.error('  GUARD FALLIDO — la búsqueda de productos se salió del contrato único')
    console.error('═'.repeat(74))
    for (const f of fallas) console.error(`  ✗ ${f}`)
    console.error('═'.repeat(74) + '\n')
    process.exit(1)
  }
  console.log('✓ guard:product-search — todas las superficies usan el contrato canónico.')
}
