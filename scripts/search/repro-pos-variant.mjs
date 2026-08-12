#!/usr/bin/env node
// ============================================================================
// P0 SEARCH — Reproducción del bug reportado por el owner.
//
//   npm run repro:search
//
// "Productos con variantes que se ven bien en Inventario a veces NO aparecen
//  cuando se buscan al momento de cobrar."
//
// Este script NO usa service_role: se loguea como el usuario E2E real, así que
// mide exactamente lo que ve la caja (RLS incluida).
//
// Corre la query TAL CUAL la escribe el POS hoy y la compara contra el universo
// autorizado completo. Sale con código 1 si el bug está presente.
// ============================================================================
import { createClient } from '@supabase/supabase-js'
import { assertDestinoLocalSeguro } from '../../tests/e2e/setup/assertLocalTarget.ts'
import { sembrarE2E, E2E } from '../../tests/e2e/setup/seedE2E.ts'
import { SEARCH_FIXTURE } from '../../tests/e2e/setup/seedSearchFixture.ts'
import { buildSupabaseQuery, smartSearch } from '../../src/utils/searchUtils.ts'
import { buildSearchTokens, buildTokenOrFilter } from '../../src/lib/productSearchQuery.ts'

const destino = await assertDestinoLocalSeguro()
await sembrarE2E(destino)

const sb = createClient(destino.supabaseUrl, destino.anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const { error: authErr } = await sb.auth.signInWithPassword({
  email: destino.email,
  password: destino.password,
})
if (authErr) {
  console.error(`No se pudo loguear el usuario E2E: ${authErr.message}`)
  process.exit(1)
}

const COLUMNAS =
  'id,code,name,variant_name,category,stock_quantity,cost_price,cost_price_usd,sale_price,' +
  'precio_mayorista,base_price,base_currency,auto_update_price,exchange_rate_used,has_variants'

/** Réplica EXACTA de ComprobanteProModal.runSearch (baseline e96ca40). */
async function busquedaPosActual(q) {
  const dbQ = buildSupabaseQuery(q)
  const { data, error } = await sb
    .from('inventory')
    .select(COLUMNAS)
    .eq('business_id', E2E.business)
    .eq('is_active', true)
    .not('has_variants', 'is', true)
    .or(`name.ilike.${dbQ},variant_name.ilike.${dbQ},code.ilike.${dbQ},category.ilike.${dbQ}`)
    .limit(40)
  if (error) throw new Error(error.message)
  const ordenados = smartSearch(data ?? [], q, [
    { getValue: (inv) => inv.name, weight: 2 },
    { getValue: (inv) => inv.variant_name ?? '', weight: 1.5 },
    { getValue: (inv) => inv.code, weight: 1.5 },
  ])
  return { termino: dbQ, descargadas: data?.length ?? 0, resultados: ordenados.slice(0, 10) }
}

/** Búsqueda CANÓNICA: AND multi-token server-side + orden estable + tope señalizado. */
async function busquedaCanonica(q, limite = 20) {
  // Se usan los helpers REALES del servicio, no una réplica: si la producción
  // cambia de criterio, esta medición cambia con ella.
  const tokens = buildSearchTokens(q)

  let query = sb
    .from('inventory')
    .select(COLUMNAS)
    .eq('business_id', E2E.business)
    .eq('is_active', true)
    .not('has_variants', 'is', true)

  for (const t of tokens) {
    query = query.or(buildTokenOrFilter(t))
  }
  query = query.order('name', { ascending: true }).order('id', { ascending: true }).limit(limite + 1)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return {
    tokens,
    descargadas: data?.length ?? 0,
    truncado: (data?.length ?? 0) > limite,
    resultados: (data ?? []).slice(0, limite),
  }
}

/** Universo autorizado completo, sin truncar: la verdad contra la que medimos. */
async function universoCompleto(q) {
  const { data, error } = await sb
    .from('inventory')
    .select(COLUMNAS)
    .eq('business_id', E2E.business)
    .eq('is_active', true)
  if (error) throw new Error(error.message)
  return smartSearch(data ?? [], q, [
    { getValue: (inv) => inv.name, weight: 2 },
    { getValue: (inv) => inv.variant_name ?? '', weight: 1.5 },
    { getValue: (inv) => inv.code, weight: 1.5 },
  ])
}

const CASOS = [
  { q: 'Funda Silicone iPhone 15', espera: SEARCH_FIXTURE.varNegro, etiqueta: 'nombre del padre → variantes' },
  { q: 'funda silicone iphone 15 negro', espera: SEARCH_FIXTURE.varNegro, etiqueta: 'nombre completo de la variante' },
  { q: 'SRCH-FUN-IP15-VAR-01', espera: SEARCH_FIXTURE.varNegro, etiqueta: 'SKU exacto de la variante' },
  { q: 'Vidrio Templado iPhone 14', espera: SEARCH_FIXTURE.vidrioComun, etiqueta: 'padre parent_id → variantes' },
  { q: 'Bateria iPhone 11', espera: SEARCH_FIXTURE.bateria, etiqueta: 'producto simple (control)' },
]

console.log('\n' + '═'.repeat(74))
console.log('  P0 SEARCH — reproducción del bug de variantes en el POS')
console.log('═'.repeat(74))
console.log(`  Catálogo sembrado : ${SEARCH_FIXTURE.relleno} de relleno + variantes`)
console.log(`  Query del POS     : ilike sobre UN token, LIMIT 40, sin ORDER BY`)
console.log('─'.repeat(74))

let fallas = 0

for (const caso of CASOS) {
  const pos = await busquedaPosActual(caso.q)
  const canon = await busquedaCanonica(caso.q)
  const universo = await universoCompleto(caso.q)

  const enPos = pos.resultados.some(r => r.id === caso.espera)
  const enCanon = canon.resultados.some(r => r.id === caso.espera)
  const enUniverso = universo.some(r => r.id === caso.espera)

  const okAntes = enPos || !enUniverso
  const okDespues = enCanon || !enUniverso

  if (!okDespues) fallas++

  console.log(`\n  "${caso.q}"  —  ${caso.etiqueta}`)
  console.log(`     existe y es vendible : ${enUniverso ? 'SÍ' : 'no'}`)
  console.log(`     ANTES   ${okAntes ? '✓' : '✗ BUG'}  ilike ${pos.termino} · ${pos.descargadas} filas descargadas · ${pos.resultados.length} mostrados · encuentra: ${enPos ? 'SÍ' : 'NO'}`)
  console.log(`     DESPUÉS ${okDespues ? '✓' : '✗ BUG'}  ${canon.tokens.length} token(s) AND server-side · ${canon.descargadas} filas descargadas · ${canon.resultados.length} mostrados · encuentra: ${enCanon ? 'SÍ' : 'NO'}${canon.truncado ? ' · truncado' : ''}`)
}

console.log('\n' + '─'.repeat(74))
if (fallas > 0) {
  console.log(`  RESULTADO: BUG REPRODUCIDO — ${fallas}/${CASOS.length} casos pierden un producto vendible.`)
  console.log('  Un producto que Inventario muestra es inalcanzable desde la caja.')
  console.log('═'.repeat(74) + '\n')
  process.exit(1)
}
console.log(`  RESULTADO: sin pérdidas — ${CASOS.length}/${CASOS.length} casos encuentran el producto esperado.`)
console.log('═'.repeat(74) + '\n')
