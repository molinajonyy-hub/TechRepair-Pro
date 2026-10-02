/**
 * Mercado Pago status normalization + effective-access logic (pure helpers).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeMercadoPagoStatus,
  isTrialExpired,
  hasTrialAccess,
  hasActivePaidAccess,
  isAccessEffective,
} from '../../src/lib/mpStatus.ts'

test('normalizeMercadoPagoStatus: valores conocidos + fallback a pending', () => {
  assert.equal(normalizeMercadoPagoStatus('approved'), 'approved')
  assert.equal(normalizeMercadoPagoStatus('APPROVED'), 'approved')
  assert.equal(normalizeMercadoPagoStatus(' rejected '), 'rejected')
  assert.equal(normalizeMercadoPagoStatus('charged_back'), 'charged_back')
  assert.equal(normalizeMercadoPagoStatus('weird'), 'pending')
  assert.equal(normalizeMercadoPagoStatus(null), 'pending')
  assert.equal(normalizeMercadoPagoStatus(undefined), 'pending')
})

// BETA-MP: `mapPreapprovalToInternal` se eliminó del cliente. El mapeo del estado
// de un preapproval es del servidor (`_shared/billing/preapproval.ts`) y lo
// cubre tests/components/betaMpPreapprovalAuthority.test.ts.

const NOW = new Date('2026-06-23T12:00:00Z')
const PAST = '2026-06-10T00:00:00Z'
const FUTURE = '2026-07-10T00:00:00Z'

test('isTrialExpired: sólo true cuando trialing y trial_ends_at pasado', () => {
  assert.equal(isTrialExpired('trialing', PAST, NOW), true)
  assert.equal(isTrialExpired('trialing', FUTURE, NOW), false)
  assert.equal(isTrialExpired('trialing', null, NOW), false)
  assert.equal(isTrialExpired('active', PAST, NOW), false)
})

test('hasTrialAccess: trial vigente sí, trial vencido no', () => {
  assert.equal(hasTrialAccess('trialing', FUTURE, NOW), true)
  assert.equal(hasTrialAccess('trialing', PAST, NOW), false)
})

test('hasActivePaidAccess: active y past_due permiten acceso', () => {
  assert.equal(hasActivePaidAccess('active'), true)
  assert.equal(hasActivePaidAccess('past_due'), true)
  assert.equal(hasActivePaidAccess('suspended'), false)
  assert.equal(hasActivePaidAccess('canceled'), false)
  assert.equal(hasActivePaidAccess('trialing'), false)
})

test('isAccessEffective: bloquea trial vencido, suspended, canceled, pending', () => {
  assert.equal(isAccessEffective('active', null, NOW), true)
  assert.equal(isAccessEffective('past_due', null, NOW), true)
  assert.equal(isAccessEffective('trialing', FUTURE, NOW), true)
  assert.equal(isAccessEffective('trialing', PAST, NOW), false)
  assert.equal(isAccessEffective('suspended', null, NOW), false)
  assert.equal(isAccessEffective('canceled', null, NOW), false)
  assert.equal(isAccessEffective('pending_activation', null, NOW), false)
})
