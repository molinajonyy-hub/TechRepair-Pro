/**
 * ARCA Self-Service Phase 0 — espejo de UI de la autoridad de gestión ARCA.
 *
 * La autoridad real es server-side (private.arca_actor_can_manage /
 * authorizeArcaManager). Este test fija que la UI no OFREZCA acciones de gestión
 * a quien el servidor va a rechazar, con la misma matriz que el backend, y que
 * reutilice la resolución de permisos existente (effectivePermissions) en vez de
 * un segundo motor.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({}) }))

import { canManageArca, isArcaIdentityLocked } from '../../src/lib/arcaAuthority'
import { effectivePermissions } from '../../src/hooks/usePermissions'

/** Resuelve settings_sensitive con la misma función que usePermissions(). */
const actor = (role: string, isActive: boolean, permissions: unknown = null) => ({
  role,
  isActive,
  settingsSensitive: effectivePermissions(role, role === 'owner', permissions).settings_sensitive,
})

describe('canManageArca — matriz owner/admin + settings_sensitive', () => {
  it.each([
    ['owner activo', actor('owner', true), true],
    ['admin activo', actor('admin', true), true],
    ['owner activo con override false (el owner ignora overrides)', actor('owner', true, { settings_sensitive: false }), true],
    ['admin con settings_sensitive=false', actor('admin', true, { settings_sensitive: false }), false],
    ['admin con override malformado', actor('admin', true, { settings_sensitive: 'yes' }), false],
    ['manager con settings_sensitive=true', actor('manager', true, { settings_sensitive: true }), false],
    ['tech con settings_sensitive=true', actor('tech', true, { settings_sensitive: true }), false],
    ['sales', actor('sales', true), false],
    ['cashier', actor('cashier', true), false],
    ['viewer', actor('viewer', true), false],
    ['owner inactivo', actor('owner', false), false],
    ['admin inactivo', actor('admin', false), false],
  ])('%s → %s', (_label, input, expected) => {
    expect(canManageArca(input)).toBe(expected)
  })

  it('sin rol o sin estado de actividad no habilita nada', () => {
    expect(canManageArca({ role: null, isActive: true, settingsSensitive: true })).toBe(false)
    expect(canManageArca({ role: 'owner', isActive: undefined, settingsSensitive: true })).toBe(false)
  })
})

describe('isArcaIdentityLocked', () => {
  it('bloquea con certificado o credencial vigente', () => {
    expect(isArcaIdentityLocked({ has_certificate: true })).toBe(true)
    expect(isArcaIdentityLocked({ has_private_key_configured: true })).toBe(true)
  })
  it('no bloquea sin identidad fiscal vigente', () => {
    expect(isArcaIdentityLocked({})).toBe(false)
    expect(isArcaIdentityLocked(null)).toBe(false)
    expect(isArcaIdentityLocked({ has_certificate: false, has_private_key_configured: false })).toBe(false)
  })
})
