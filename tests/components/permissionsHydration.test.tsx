// ─────────────────────────────────────────────────────────────────────────────
// P0 PRE-BETA — Hidratación de permission overrides (lado cliente)
//
// Contraparte de tests/sql/permissions_hydration.test.sql. Allá se verifica que
// el SERVIDOR entregue `profiles.permissions`; acá, que el cliente lo resuelva
// de forma determinista contra los defaults del rol.
//
//   I.  default true  + sin override      -> true
//   J.  default false + sin override      -> false
//   K.  default false + override true     -> true
//   L.  default true  + override false    -> false   (la restricción manda)
//   M.  payload malformado                -> fail-closed (todo en false)
//   N.  el editor de plantillas de WhatsApp usa el permiso REAL hidratado
//       (no un mock de usePermissions), sin tocar el runtime de WhatsApp.
//
// Los defaults contra los que se compara NO se reescriben acá: se leen de
// ROLE_DEFAULT_PERMISSIONS, la matriz canónica. Si un default cambia, estos
// tests siguen aseverando la SEMÁNTICA DEL MERGE, que es lo que se está
// cerrando, y no un snapshot de la matriz.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import {
  effectivePermissions,
  sanitizePermissions,
  DENY_ALL,
} from '../../src/hooks/usePermissions'
import { ROLE_DEFAULT_PERMISSIONS, ALL_PERMISSIONS } from '../../src/config/permissions'

// ── Estado compartido con los mocks del CASO N ───────────────────────────────
const estado: { role: string; isOwner: boolean; permissions: unknown } = {
  role: 'admin',
  isOwner: false,
  permissions: null,
}

// Se mockea SÓLO el borde de datos (a quién está logueado el usuario y qué
// devolvió el servidor). `usePermissions` corre de verdad: es justamente el
// código bajo prueba.
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    businessId: 'biz-1',
    role: estado.role,
    isOwner: estado.isOwner,
    profile: { permissions: estado.permissions },
    user: { id: 'user-1' },
  }),
}))

vi.mock('../../src/services/whatsappService', async () => {
  const real = await vi.importActual<typeof import('../../src/services/whatsappService')>(
    '../../src/services/whatsappService',
  )
  return {
    ...real,
    whatsappService: {
      getSettings: async () => ({ ...real.DEFAULT_SETTINGS }),
      getTemplates: async () => real.DEFAULT_TEMPLATES.map(t => ({ ...t })),
      saveSettings: async () => {},
      saveAllTemplates: async () => {},
    },
  }
})

beforeEach(() => {
  estado.role = 'admin'
  estado.isOwner = false
  estado.permissions = null
})

// ═════════════════════════════════════════════════════════════════════════════
// Merge determinista
// ═════════════════════════════════════════════════════════════════════════════
describe('permissions hydration — merge semantics', () => {
  it('I. default true + sin override -> true', () => {
    // admin.settings_sensitive = true por default.
    expect(ROLE_DEFAULT_PERMISSIONS.admin.settings_sensitive).toBe(true)

    const perms = effectivePermissions('admin', false, null)
    expect(perms.settings_sensitive).toBe(true)
  })

  it('J. default false + sin override -> false', () => {
    // viewer.finance = false por default.
    expect(ROLE_DEFAULT_PERMISSIONS.viewer.finance).toBe(false)

    const perms = effectivePermissions('viewer', false, null)
    expect(perms.finance).toBe(false)
  })

  it('K. default false + override true -> true', () => {
    const perms = effectivePermissions('viewer', false, { finance: true })
    expect(perms.finance).toBe(true)
    // El override es un DIFF: no debe arrastrar el resto de la matriz.
    expect(perms.users).toBe(ROLE_DEFAULT_PERMISSIONS.viewer.users)
  })

  it('L. default true + override false -> false (la restricción manda)', () => {
    // Este es el caso que el defecto ignoraba: la restricción se perdía y el
    // admin seguía viendo configuración sensible.
    const perms = effectivePermissions('admin', false, { settings_sensitive: false })
    expect(perms.settings_sensitive).toBe(false)
    expect(perms.orders).toBe(true)
  })

  it('un rol desconocido cae al piso de viewer, no a "todo permitido"', () => {
    const perms = effectivePermissions('rol_que_no_existe', false, null)
    expect(perms).toEqual(ROLE_DEFAULT_PERMISSIONS.viewer)
  })

  it('el owner conserva la matriz completa y no se le aplican overrides', () => {
    const perms = effectivePermissions('owner', true, { finance: false, users: false })
    expect(perms).toEqual(ROLE_DEFAULT_PERMISSIONS.owner)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Payloads que no se entienden
// ═════════════════════════════════════════════════════════════════════════════
describe('permissions hydration — fail-closed', () => {
  it('M. payload malformado -> todo denegado', () => {
    const malformados: unknown[] = [
      // jsonb que no es un objeto plano.
      [],
      ['finance'],
      'finance',
      42,
      true,
      // clave conocida con un valor que no es boolean: el override existe pero
      // no se puede leer. Degradar al default del rol sería ignorar en silencio
      // algo que podía estar RESTRINGIENDO.
      { finance: 'true' },
      { settings_sensitive: 1 },
      { orders: null },
    ]

    for (const raw of malformados) {
      expect(sanitizePermissions(raw)).toEqual({ kind: 'malformed' })
      expect(effectivePermissions('admin', false, raw)).toEqual(DENY_ALL)
    }
  })

  it('DENY_ALL cubre TODAS las claves conocidas', () => {
    // Si alguien agrega una clave a la matriz y no al piso, el fail-closed
    // dejaría esa clave en `undefined` en vez de en false.
    for (const key of ALL_PERMISSIONS) {
      expect(DENY_ALL[key]).toBe(false)
    }
  })

  it('null / undefined / {} significan "sin overrides", no "malformado"', () => {
    expect(sanitizePermissions(null)).toEqual({ kind: 'none' })
    expect(sanitizePermissions(undefined)).toEqual({ kind: 'none' })
    expect(sanitizePermissions({})).toEqual({ kind: 'none' })
    // El caso real de hoy: el servidor viejo no mandaba la columna.
    expect(effectivePermissions('manager', false, undefined))
      .toEqual(ROLE_DEFAULT_PERMISSIONS.manager)
  })

  it('una clave desconocida se ignora y no amplía privilegio', () => {
    const raw = { clave_inventada: true, finance: true }
    expect(sanitizePermissions(raw)).toEqual({ kind: 'ok', overrides: { finance: true } })

    const perms = effectivePermissions('viewer', false, raw)
    expect(perms.finance).toBe(true)
    expect(Object.keys(perms).sort()).toEqual([...ALL_PERMISSIONS].sort())
    expect((perms as Record<string, unknown>).clave_inventada).toBeUndefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// N. Consumidor real
// ═════════════════════════════════════════════════════════════════════════════
// El editor de plantillas de WhatsApp es el consumidor vivo de
// `can('settings_sensitive')`. Acá se monta con el usePermissions REAL para
// probar que el override hidratado llega hasta la UI. No se toca nada del
// runtime de WhatsApp: sólo se mockea el servicio de datos.
describe('N. el editor de plantillas de WhatsApp usa el permiso hidratado', () => {
  const montar = async () => {
    const { WhatsAppTemplatesSettings } = await import(
      '../../src/components/settings/WhatsAppTemplatesSettings'
    )
    render(<WhatsAppTemplatesSettings />)
    // Esperar a que termine la carga inicial.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('TechRepair Centro')).toBeInTheDocument()
    })
  }

  it('admin sin overrides: puede editar', async () => {
    estado.role = 'admin'
    estado.permissions = null

    await montar()

    expect(screen.queryByTestId('whatsapp-templates-readonly')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('TechRepair Centro')).not.toBeDisabled()
  })

  it('admin con override {settings_sensitive:false}: queda en solo lectura', async () => {
    estado.role = 'admin'
    estado.permissions = { settings_sensitive: false }

    await montar()

    expect(screen.getByTestId('whatsapp-templates-readonly')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('TechRepair Centro')).toBeDisabled()
  })

  it('manager con override {settings_sensitive:true}: puede editar', async () => {
    // manager.settings_sensitive = false por default; el override lo habilita.
    expect(ROLE_DEFAULT_PERMISSIONS.manager.settings_sensitive).toBe(false)
    estado.role = 'manager'
    estado.permissions = { settings_sensitive: true }

    await montar()

    expect(screen.queryByTestId('whatsapp-templates-readonly')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('TechRepair Centro')).not.toBeDisabled()
  })

  // Regresión W1: los roles que NO tienen settings_sensitive por default deben
  // seguir sin poder editar cuando no hay override. Es el lado negativo del
  // gate, el que una hidratación mal hecha podría abrir.
  it.each(['sales', 'viewer'] as const)(
    '%s sin overrides: sigue en solo lectura',
    async (rol) => {
      expect(ROLE_DEFAULT_PERMISSIONS[rol].settings_sensitive).toBe(false)
      estado.role = rol
      estado.permissions = null

      await montar()

      expect(screen.getByTestId('whatsapp-templates-readonly')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('TechRepair Centro')).toBeDisabled()
    },
  )

  it('payload malformado: solo lectura aunque el rol sea admin', async () => {
    estado.role = 'admin'
    estado.permissions = 'no-soy-un-objeto'

    await montar()

    expect(screen.getByTestId('whatsapp-templates-readonly')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('TechRepair Centro')).toBeDisabled()
  })
})
