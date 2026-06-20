/**
 * Verifica que el JSON-LD de index.html (landing) no se desincronice de los
 * precios definidos en PLANS (src/types/subscription.ts), la fuente única de
 * verdad, y que no reaparezcan métricas inventadas (aggregateRating / reviews).
 *
 * Nota: NO se importa subscription.ts directamente porque usa `import.meta.env`
 * (sólo definido bajo Vite) y rompería al cargarse en el runner de Node. En su
 * lugar se leen los precios del archivo como texto, manteniendo el vínculo con
 * la fuente sin tocar el módulo interno.
 *
 * Runner: node:test nativo (igual que productPricing.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf-8')
const subscriptionSrc = readFileSync(new URL('../../src/types/subscription.ts', import.meta.url), 'utf-8')

/** Extrae los `price_monthly` de PLANS desde el código fuente (admite separador `_`). */
function planMonthlyPrices(): number[] {
  const prices: number[] = []
  const re = /price_monthly:\s*([\d_]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(subscriptionSrc))) prices.push(Number(m[1].replace(/_/g, '')))
  return prices
}

function jsonLdRaw(): string[] {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g
  const raw: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) raw.push(m[1])
  return raw
}

function jsonLdBlocks(): Record<string, any>[] {
  return jsonLdRaw().map(s => JSON.parse(s))
}

test('hay 3 planes con precios mensuales detectables en la fuente', () => {
  const prices = planMonthlyPrices()
  assert.equal(prices.length, 3, 'Se esperan 3 price_monthly en subscription.ts')
  assert.ok(prices.every(p => p > 0), 'Todos los precios deben ser positivos')
})

test('JSON-LD: el AggregateOffer coincide con los precios de PLANS', () => {
  const prices = planMonthlyPrices()
  const app = jsonLdBlocks().find(b => b['@type'] === 'SoftwareApplication')
  assert.ok(app, 'Falta el bloque SoftwareApplication en index.html')

  const offer = app.offers
  assert.equal(offer['@type'], 'AggregateOffer')
  assert.equal(offer.priceCurrency, 'ARS')
  assert.equal(Number(offer.lowPrice), Math.min(...prices), 'lowPrice debe ser el plan más barato')
  assert.equal(Number(offer.highPrice), Math.max(...prices), 'highPrice debe ser el plan más caro')
  assert.equal(Number(offer.offerCount), prices.length, 'offerCount debe igualar la cantidad de planes')
})

test('JSON-LD: no hay aggregateRating ni reviews inventadas', () => {
  for (const b of jsonLdBlocks()) {
    assert.equal(b.aggregateRating, undefined, 'No debe existir aggregateRating fabricado')
    assert.equal(b.review, undefined, 'No debe existir review inventada')
  }
  // El propio bloque JSON-LD no debe contener estas claves (no chequea comentarios).
  for (const raw of jsonLdRaw()) {
    assert.ok(!/aggregateRating/i.test(raw), 'El JSON-LD no debe mencionar aggregateRating')
    assert.ok(!/"review"/i.test(raw), 'El JSON-LD no debe incluir reviews')
  }
})
