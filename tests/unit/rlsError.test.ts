import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPermissionDeniedError,
  permissionErrorMessage,
  PERMISSION_DENIED_MESSAGE,
} from '../../src/lib/permissions/rlsError.ts'

// ── isPermissionDeniedError: detecta permiso denegado ────────────────────────
test('código 42501 → permiso denegado', () => {
  assert.equal(isPermissionDeniedError({ code: '42501', message: 'permission denied for table x' }), true)
})

test('mensaje insufficient_privilege → permiso denegado', () => {
  assert.equal(isPermissionDeniedError({ message: 'ERROR: insufficient_privilege' }), true)
})

test('mensaje de violación RLS / policy → permiso denegado', () => {
  assert.equal(isPermissionDeniedError({ message: 'new row violates row-level security policy for table "x"' }), true)
  assert.equal(isPermissionDeniedError({ message: 'violates row level security policy' }), true)
})

test('PostgREST 403 (status) → permiso denegado', () => {
  assert.equal(isPermissionDeniedError({ status: 403, message: 'Forbidden' }), true)
})

test('"permission denied" en el mensaje (sin code) → permiso denegado', () => {
  assert.equal(isPermissionDeniedError({ message: 'permission denied for relation businesses' }), true)
})

// ── isPermissionDeniedError: NO clasifica otros errores como permiso ─────────
test('error común NO de permisos → no se clasifica como RLS', () => {
  assert.equal(isPermissionDeniedError({ code: '23505', message: 'duplicate key value violates unique constraint' }), false)
  assert.equal(isPermissionDeniedError({ code: '23503', message: 'foreign key violation' }), false)
  assert.equal(isPermissionDeniedError({ status: 500, message: 'internal server error' }), false)
  assert.equal(isPermissionDeniedError(new Error('Network request failed')), false)
})

// ── fail-safe: entradas raras no rompen ──────────────────────────────────────
test('null / undefined / string / objeto desconocido → false sin romper', () => {
  assert.equal(isPermissionDeniedError(null), false)
  assert.equal(isPermissionDeniedError(undefined), false)
  assert.equal(isPermissionDeniedError('permission denied' as unknown), false) // string suelto: no es objeto de error
  assert.equal(isPermissionDeniedError(42 as unknown), false)
  assert.equal(isPermissionDeniedError({}), false)
  assert.equal(isPermissionDeniedError({ code: 123, message: null } as unknown), false)
})

// ── permissionErrorMessage: mensaje amigable solo para permisos ──────────────
test('permissionErrorMessage devuelve el mensaje amigable para errores de permiso', () => {
  assert.equal(permissionErrorMessage({ code: '42501' }), PERMISSION_DENIED_MESSAGE)
  assert.equal(permissionErrorMessage({ message: 'insufficient_privilege' }), PERMISSION_DENIED_MESSAGE)
})

test('permissionErrorMessage devuelve null para errores reales (no los esconde)', () => {
  assert.equal(permissionErrorMessage({ code: '23505', message: 'duplicate key' }), null)
  assert.equal(permissionErrorMessage(new Error('boom')), null)
  assert.equal(permissionErrorMessage(null), null)
})
