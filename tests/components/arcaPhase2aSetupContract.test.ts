/**
 * ARCA Self-Service Phase 2A — contrato del asistente en el navegador (sin UI).
 *
 *   · la pantalla se deriva SÓLO del estado canónico de Phase 1 (deriveArcaSetupWizard);
 *   · un negocio configurado (Clic) nunca ve un paso de escritura del asistente inicial;
 *   · "Listo" sólo con conexión verificada y nada pendiente;
 *   · una espera de verificación decidida por la base nunca ofrece "Verificar";
 *   · el parser de respuestas del Edge copia sólo campos del contrato y falla cerrado.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() } } }))

import type { ArcaSelfServiceStatus, ArcaVerificationHold } from '../../src/lib/arcaStatus'
import { ARCA_VERIFICATION_HOLDS } from '../../src/lib/arcaStatus'
import { ARCA_SETUP_HOLD_COPY, deriveArcaSetupWizard } from '../../src/lib/arcaSetupWizard'
import { parseArcaSetupResponse, newArcaSetupIdempotencyKey } from '../../src/services/arcaSetupService'

const noHold = { verification_hold: null, retry_not_before: null }

const base = (): ArcaSelfServiceStatus => ({
  contract_version: 1, available: true, status: 'not_configured', configured: false,
  environment: null, cuit: null, razon_social: null, punto_venta: null, alias: null,
  certificate: { present: false, expires_at: null, days_remaining: null, renewal_state: 'not_configured', matches_credential: false },
  credential: { active: false },
  connection: { state: 'unknown', last_verified_at: null },
  setup: { state: 'not_started', kind: null, step: null, started_at: null, ...noHold },
  attention: [], can_manage: true, next_action: 'start_setup',
})

const inProgress = (step: 'certificate' | 'verification' | 'activation', kind: 'initial' | 'renewal' = 'initial',
  hold: ArcaVerificationHold | null = null): ArcaSelfServiceStatus => ({
  ...base(), status: 'setup_in_progress', next_action: 'continue_setup',
  setup: { state: 'in_progress', kind, step, started_at: '2026-09-13T10:00:00Z',
    verification_hold: hold, retry_not_before: hold === null ? null : '2026-09-14T22:30:00Z' },
})

const clic = (): ArcaSelfServiceStatus => ({
  ...base(), status: 'connected', configured: true, environment: 'produccion', cuit: '20123456783', punto_venta: 10,
  certificate: { present: true, expires_at: '2028-07-25T23:58:12Z', days_remaining: 681, renewal_state: 'healthy', matches_credential: true },
  credential: { active: true }, connection: { state: 'connected', last_verified_at: '2026-09-11T13:31:12Z' },
  setup: { state: 'completed', kind: null, step: null, started_at: null, ...noHold }, next_action: 'none',
})

describe('deriveArcaSetupWizard — autoridad = Phase 1', () => {
  it.each([
    ['sin configurar + gestor', base(), 'datos_fiscales', ['prepare']],
    ['esperando certificado', inProgress('certificate'), 'presentar_en_arca', ['csr', 'certificate', 'cancel']],
    ['certificado adjunto', inProgress('verification'), 'verificar_conexion', ['csr', 'certificate', 'verify', 'cancel']],
    ['verificado sin activar', inProgress('activation'), 'finalizar_activacion', ['verify', 'cancel']],
    ['Clic configurado', clic(), 'listo', []],
  ] as const)('%s → %s', (_label, status, screen, actions) => {
    const view = deriveArcaSetupWizard(status)
    expect(view.screen).toBe(screen)
    expect([...view.actions]).toEqual(actions)
  })

  it('Clic nunca recibe acciones del asistente inicial, ni siquiera con renovación viva', () => {
    const renewal = { ...clic(), setup: { state: 'in_progress' as const, kind: 'renewal' as const, step: 'certificate' as const, started_at: null, ...noHold } }
    expect(deriveArcaSetupWizard(renewal).actions).toEqual([])
    expect(deriveArcaSetupWizard(renewal).screen).toBe('fuera_de_alcance')
  })

  it('"Listo" sólo con conexión verificada y sin pendientes', () => {
    const pending = { ...clic(), status: 'pending_verification' as const, connection: { state: 'unknown' as const, last_verified_at: null }, next_action: 'verify_connection' as const }
    expect(deriveArcaSetupWizard(pending).screen).toBe('fuera_de_alcance')
    const error = { ...clic(), status: 'attention' as const, attention: ['connection_error' as const], connection: { state: 'error' as const, last_verified_at: '2026-09-11T13:31:12Z' }, next_action: 'verify_connection' as const }
    expect(deriveArcaSetupWizard(error).screen).toBe('fuera_de_alcance')
    const renew = { ...clic(), next_action: 'renew_certificate' as const }
    expect(deriveArcaSetupWizard(renew).screen).toBe('fuera_de_alcance')
    for (const s of [pending, error, renew]) expect(deriveArcaSetupWizard(s).actions).toEqual([])
  })

  it('renovación en curso sin credencial activa (fila legacy) → fuera de alcance', () => {
    expect(deriveArcaSetupWizard(inProgress('certificate', 'renewal')).screen).toBe('fuera_de_alcance')
  })

  it('no gestores: solo lectura en cualquier paso', () => {
    for (const s of [base(), inProgress('certificate'), inProgress('activation'), inProgress('verification', 'initial', 'result_unknown')]) {
      const view = deriveArcaSetupWizard({ ...s, can_manage: false })
      expect(view.screen).toBe('solo_lectura')
      expect(view.actions).toEqual([])
    }
  })

  it('plan sin ARCA, estado ilegible o atención con material suelto → sin acciones', () => {
    expect(deriveArcaSetupWizard({ ...base(), available: false }).screen).toBe('no_disponible')
    expect(deriveArcaSetupWizard(null).screen).toBe('fuera_de_alcance')
    const loose = { ...base(), status: 'attention' as const, attention: ['credential_missing' as const],
      certificate: { ...base().certificate, present: true } }
    expect(deriveArcaSetupWizard(loose).actions).toEqual([])
  })
})

describe('deriveArcaSetupWizard — espera de verificación decidida por la base', () => {
  it.each([
    ['en curso', 'in_progress', ['csr'], false],
    ['resultado desconocido', 'result_unknown', ['csr', 'certificate', 'cancel'], true],
    ['acceso vigente en ARCA', 'ticket_active', ['csr', 'certificate', 'cancel'], true],
    ['verificación vencida', 'verification_expired', ['csr', 'certificate', 'cancel'], true],
    ['espera corta tras un rechazo', 'cooldown', ['csr', 'certificate', 'cancel'], false],
  ] as const)('%s: nunca ofrece verificar', (_label, hold, actions, confirmCancel) => {
    const view = deriveArcaSetupWizard(inProgress('verification', 'initial', hold))
    expect(view.screen).toBe('verificar_conexion')
    expect([...view.actions]).toEqual(actions)
    expect(view.actions).not.toContain('verify')
    expect(view.hold).toEqual({ reason: hold, retryNotBefore: '2026-09-14T22:30:00Z' })
    expect(view.confirmCancel).toBe(confirmCancel)
  })

  it('espera heredada en el paso del certificado: se puede subir, no verificar, y cancelar pide confirmación', () => {
    const view = deriveArcaSetupWizard(inProgress('certificate', 'initial', 'result_unknown'))
    expect([view.screen, [...view.actions], view.confirmCancel]).toEqual(['presentar_en_arca', ['csr', 'certificate', 'cancel'], true])
    expect(view.hold?.reason).toBe('result_unknown')
  })

  it('verificado sin activar: cancelar pide confirmación (descarta un acceso vigente)', () => {
    expect(deriveArcaSetupWizard(inProgress('activation')).confirmCancel).toBe(true)
  })

  it('textos de espera: uno por motivo, sin detalles técnicos ni promesas de reintento inmediato', () => {
    expect(Object.keys(ARCA_SETUP_HOLD_COPY).sort()).toEqual([...ARCA_VERIFICATION_HOLDS].sort())
    for (const text of Object.values(ARCA_SETUP_HOLD_COPY)) expect(text).not.toMatch(/WSAA|token|ticket|TA\b|LoginCms|CSR|PEM|Vault|reintentá ya/i)
    expect(ARCA_SETUP_HOLD_COPY.result_unknown).toBe('ARCA puede haber procesado la verificación. Por seguridad vamos a esperar antes de repetirla.')
  })
})

describe('parseArcaSetupResponse — fail-closed', () => {
  it('copia sólo campos del contrato', () => {
    const r = parseArcaSetupResponse({
      ok: true, state: 'SETUP_PREPARED',
      csr: { pem: '-----BEGIN CERTIFICATE REQUEST-----\nX\n-----END CERTIFICATE REQUEST-----', filename: 'techrepair-arca-20111111112.csr' },
      subject: { alias: 'a', cuit: '20111111112' }, signing_key_pem: 'NO', token: 'NO', detail: 'SQL', attempt_id: 'NO',
    })
    expect(r).toEqual({ ok: true, state: 'SETUP_PREPARED', csr: { pem: '-----BEGIN CERTIFICATE REQUEST-----\nX\n-----END CERTIFICATE REQUEST-----', filename: 'techrepair-arca-20111111112.csr' } })
    expect(JSON.stringify(r)).not.toMatch(/signing|token|SQL|attempt/)
  })

  it.each([
    [null, { ok: false, state: 'SETUP_UNAVAILABLE' }],
    [{ ok: true, state: 'ESTADO_INVENTADO' }, { ok: false, state: 'SETUP_UNAVAILABLE' }],
    [{ ok: false, state: 'CERTIFICATE_CUIT_MISMATCH', detail: 'x' }, { ok: false, state: 'CERTIFICATE_CUIT_MISMATCH' }],
    [{ ok: false, error: 'FORBIDDEN' }, { ok: false, state: 'FORBIDDEN' }],
    [{ ok: false, state: 'WSAA_TICKET_ALREADY_ISSUED', retry_after_seconds: 45000 }, { ok: false, state: 'WSAA_TICKET_ALREADY_ISSUED', retryAfterSeconds: 45000 }],
    [{ ok: false, state: 'WSAA_RESULT_UNKNOWN', retry_after_seconds: 44990 }, { ok: false, state: 'WSAA_RESULT_UNKNOWN', retryAfterSeconds: 44990 }],
    [{ ok: false, state: 'VERIFICATION_EXPIRED', retry_after_seconds: 600 }, { ok: false, state: 'VERIFICATION_EXPIRED', retryAfterSeconds: 600 }],
    [{ ok: false, state: 'VERIFICATION_COOLDOWN', retry_after_seconds: 60 }, { ok: false, state: 'VERIFICATION_COOLDOWN', retryAfterSeconds: 60 }],
    [{ ok: false, state: 'WSAA_RESULT_UNKNOWN', retry_after_seconds: -5 }, { ok: false, state: 'WSAA_RESULT_UNKNOWN' }],
    [{ ok: false, state: 'WSAA_RESULT_UNKNOWN', retry_after_seconds: 10_000_000 }, { ok: false, state: 'WSAA_RESULT_UNKNOWN' }],
    [{ ok: true, state: 'ACTIVATED', connection: 'connected', expires_at: '2028-07-25T00:00:00Z' }, { ok: true, state: 'ACTIVATED', connection: 'connected', expiresAt: '2028-07-25T00:00:00Z' }],
    [{ ok: true, state: 'ACTIVATED', connection: 'pending_verification' }, { ok: true, state: 'ACTIVATED' }],
    [{ ok: true, state: 'SETUP_CANCELLED', remote_ticket_possible: true }, { ok: true, state: 'SETUP_CANCELLED', remoteTicketPossible: true }],
    [{ ok: true, state: 'SETUP_CANCELLED', remote_ticket_possible: 'yes' }, { ok: true, state: 'SETUP_CANCELLED' }],
    [{ ok: true, state: 'SETUP_PREPARED', csr: { pem: 'not a csr', filename: '../../etc' } }, { ok: true, state: 'SETUP_PREPARED' }],
  ])('%j', (raw, want) => {
    expect(parseArcaSetupResponse(raw)).toEqual(want)
  })

  it('claves de idempotencia estables y válidas para el backend', () => {
    const k = newArcaSetupIdempotencyKey()
    expect(k).toMatch(/^[A-Za-z0-9._:-]{8,128}$/)
    expect(newArcaSetupIdempotencyKey()).not.toBe(k)
  })
})
