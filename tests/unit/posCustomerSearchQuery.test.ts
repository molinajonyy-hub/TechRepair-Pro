/** Contrato puro de la búsqueda de clientes dentro del POS. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  POS_CUSTOMER_MATCH_COLUMNS,
  POS_CUSTOMER_MIN_QUERY_LENGTH,
  buildPosCustomerSearchTerms,
  buildPosCustomerTokenOrFilter,
  sanitizePosCustomerTerm,
} from '../../src/lib/posCustomerSearchQuery.ts'

test('conserva todos los términos de un nombre para resolverlos server-side', () => {
  assert.deepEqual(buildPosCustomerSearchTerms('Ana María Gomez'), ['ana', 'maria', 'gomez'])
})

test('compacta DNI/CUIT canónicos e históricos con la normalización de Customer Core', () => {
  assert.deepEqual(buildPosCustomerSearchTerms('DNI: 30.123.456'), ['30123456'])
  assert.deepEqual(buildPosCustomerSearchTerms('DNI 30123456'), ['30123456'])
  assert.deepEqual(buildPosCustomerSearchTerms('CUIT 20-30123456-7'), ['20301234567'])
  assert.deepEqual(buildPosCustomerSearchTerms('20-30123456-7'), ['20301234567'])
})

test('el filtro cubre nombre, teléfono y documento', () => {
  const filter = buildPosCustomerTokenOrFilter('gomez')
  for (const column of POS_CUSTOMER_MATCH_COLUMNS) {
    assert.ok(filter.includes(`${column}.ilike.%gomez%`))
  }
})

test('un identificador tolera separadores históricos sin abrir la sintaxis PostgREST', () => {
  const filter = buildPosCustomerTokenOrFilter('30123456')
  assert.ok(filter.includes('document.ilike.%3%0%1%2%3%4%5%6%'))
  assert.ok(filter.includes('phone.ilike.%3%0%1%2%3%4%5%6%'))
  assert.equal(sanitizePosCustomerTerm('30%,(123)_456'), '30123456')
  assert.equal(filter.includes('('), false)
  assert.equal(filter.includes(','), true, 'las comas sólo separan filtros controlados')
})

test('no produce términos para símbolos y exige dos caracteres', () => {
  assert.deepEqual(buildPosCustomerSearchTerms('%%%'), [])
  assert.equal(POS_CUSTOMER_MIN_QUERY_LENGTH, 2)
})
