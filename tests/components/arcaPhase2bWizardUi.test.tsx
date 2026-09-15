/**
 * ARCA Self-Service Phase 2B — asistente en pantalla (React, sin red).
 *
 * El servicio del Edge y el lector de estado se mockean en su límite. Se fija que:
 *   · la pantalla se deriva del estado recibido y se relee después de cada acción;
 *   · una espera nunca muestra "Verificar"; un doble clic nunca manda dos pedidos;
 *   · el archivo para ARCA se vuelve a pedir en cada descarga (sirve tras recargar);
 *   · cancelar siempre pide confirmación y la copia es honesta según el riesgo;
 *   · los errores se muestran con la capa central, sin códigos crudos;
 *   · un archivo con clave nunca se envía;
 *   · el estado se relee al volver el foco, la red o al vencer la espera.
 */
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

const service = vi.hoisted(() => ({
  prepare: vi.fn(),
  getRequestFile: vi.fn(),
  attachCertificatePem: vi.fn(),
  attachCertificateDerBase64: vi.fn(),
  verifyAndActivate: vi.fn(),
  cancel: vi.fn(),
}))
const statusReader = vi.hoisted(() => ({ getSelfServiceStatus: vi.fn() }))

vi.mock('../../src/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() }, rpc: vi.fn() } }))
vi.mock('../../src/services/arcaSetupService', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/arcaSetupService')>()
  return { ...original, arcaSetupService: service }
})
vi.mock('../../src/services/arcaService', () => ({ ArcaService: statusReader, default: statusReader }))

import type { ArcaSelfServiceStatus, ArcaVerificationHold } from '../../src/lib/arcaStatus'
import { ArcaSetupPanel } from '../../src/components/settings/arca-setup/ArcaSetupPanel'
import { useArcaSelfServiceStatus } from '../../src/hooks/useArcaSelfServiceStatus'

const DEFAULTS = { cuit: '20123456786', razonSocial: 'QA Demo SRL', businessName: 'QA Demo' }

const base = (): ArcaSelfServiceStatus => ({
  contract_version: 1, available: true, status: 'not_configured', configured: false,
  environment: null, cuit: null, razon_social: null, punto_venta: null, alias: null,
  certificate: { present: false, expires_at: null, days_remaining: null, renewal_state: 'not_configured', matches_credential: false },
  credential: { active: false },
  connection: { state: 'unknown', last_verified_at: null },
  setup: { state: 'not_started', kind: null, step: null, started_at: null, verification_hold: null, retry_not_before: null },
  attention: [], can_manage: true, next_action: 'start_setup',
})

const inProgress = (step: 'certificate' | 'verification' | 'activation', hold: ArcaVerificationHold | null = null): ArcaSelfServiceStatus => ({
  ...base(), status: 'setup_in_progress', next_action: 'continue_setup',
  environment: 'homologacion', cuit: '20123456786', razon_social: 'QA Demo SRL', punto_venta: 3, alias: 'techrepair-qa-demo',
  setup: { state: 'in_progress', kind: 'initial', step, started_at: '2026-09-14T14:00:00Z',
    verification_hold: hold, retry_not_before: hold === null ? null : new Date(Date.now() + 3_600_000).toISOString() },
})

const connected = (): ArcaSelfServiceStatus => ({
  ...inProgress('activation'), status: 'connected', configured: true, next_action: 'none',
  certificate: { present: true, expires_at: '2028-09-14T00:00:00Z', days_remaining: 730, renewal_state: 'healthy', matches_credential: true },
  credential: { active: true }, connection: { state: 'connected', last_verified_at: '2026-09-14T15:00:00Z' },
  setup: { state: 'completed', kind: null, step: null, started_at: null, verification_hold: null, retry_not_before: null },
})

const LEAK = /token|sign\b|fingerprint|vault|secret|PRIVATE KEY|signing_key|WSAA|LoginCms|SOAP/i

function renderPanel(status: ArcaSelfServiceStatus | null, refresh = vi.fn(async () => status)) {
  const utils = render(<ArcaSetupPanel status={status} loading={false} failed={status === null} refresh={refresh} defaults={DEFAULTS} />)
  return { ...utils, refresh }
}

const openWizard = () => {
  fireEvent.click(screen.getByTestId(/arca-setup-(start|continue)/))
  return screen.getByTestId('arca-setup-wizard')
}

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset()
  statusReader.getSelfServiceStatus.mockReset()
})

describe('entrada en Configuración → ARCA', () => {
  it('sin plan: no ofrece nada ni llama al asistente', () => {
    renderPanel({ ...base(), available: false })
    expect(screen.queryByTestId('arca-setup-entry')).toBeNull()
    expect(Object.values(service).every((fn) => fn.mock.calls.length === 0)).toBe(true)
  })

  it('sin permiso: sólo "Actualizar estado", que relee el estado y nunca llama al asistente', () => {
    const { refresh } = renderPanel({ ...base(), can_manage: false })
    expect(screen.getByTestId('arca-setup-entry').dataset.entryKind).toBe('read_only')
    expect(screen.queryByTestId('arca-setup-start')).toBeNull()
    fireEvent.click(screen.getByTestId('arca-refresh-status'))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(Object.values(service).every((fn) => fn.mock.calls.length === 0)).toBe(true)
  })

  it('conectado: sin CTA del asistente (el "Probar conexión" que forzaba ARCA ya no existe)', () => {
    renderPanel(connected())
    expect(screen.getByTestId('arca-setup-entry').dataset.entryKind).toBe('connected')
    expect(screen.queryByTestId('arca-setup-start')).toBeNull()
    expect(screen.queryByTestId('arca-setup-continue')).toBeNull()
    expect(screen.queryByText(/Probar conexión/)).toBeNull()
  })

  it('configuración en curso con espera: explica la espera en la entrada', () => {
    renderPanel(inProgress('verification', 'result_unknown'))
    expect(screen.getByTestId('arca-setup-entry-step').textContent).toMatch(/Paso 5 de 6/)
    expect(screen.getByTestId('arca-setup-hold').dataset.holdReason).toBe('result_unknown')
  })
})

describe('paso 1 — datos fiscales', () => {
  it('precarga el CUIT del negocio formateado, exige elegir ambiente y enlaza el error al campo', async () => {
    renderPanel(base())
    openWizard()
    const cuit = screen.getByTestId('arca-setup-cuit') as HTMLInputElement
    expect(cuit.value).toBe('20-12345678-6')
    expect((screen.getByTestId('arca-setup-alias') as HTMLInputElement).value).toBe('techrepair-qa-demo')
    expect(screen.getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked)).toBe(true)

    fireEvent.change(cuit, { target: { value: '20123456783' } })
    fireEvent.click(screen.getByTestId('arca-setup-prepare'))
    expect(service.prepare).not.toHaveBeenCalled()
    await waitFor(() => expect((cuit).getAttribute('aria-invalid')).toBe('true'))
    expect(cuit.getAttribute('aria-describedby')).toBe('arca-setup-cuit-error')
    expect(document.getElementById('arca-setup-cuit-error')?.textContent).toMatch(/dígito verificador/)
    expect((screen.getByText('Elegí dónde vas a emitir.')).isConnected).toBe(true)
  })

  it('un doble clic manda UN solo prepare y después relee el estado', async () => {
    let resolve!: (v: unknown) => void
    service.prepare.mockReturnValue(new Promise((r) => { resolve = r }))
    const { refresh } = renderPanel(base())
    openWizard()
    fireEvent.click(screen.getByTestId('arca-setup-ambiente-homologacion').querySelector('input')!)
    fireEvent.change(screen.getByTestId('arca-setup-punto-venta'), { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('arca-setup-prepare'))
    fireEvent.click(screen.getByTestId('arca-setup-prepare'))
    expect(service.prepare).toHaveBeenCalledTimes(1)
    expect(service.prepare.mock.calls[0][0]).toEqual({ cuit: '20123456786', razon_social: 'QA Demo SRL', ambiente: 'homologacion', punto_venta: 3, alias: 'techrepair-qa-demo' })
    expect(screen.getByTestId('arca-setup-wizard').dataset.step).toBe('2')
    await act(async () => { resolve({ ok: true, state: 'SETUP_PREPARED' }) })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('un error del servidor se muestra con la capa central, en el campo y sin el código crudo', async () => {
    service.prepare.mockResolvedValue({ ok: false, state: 'CUIT_TENANT_MISMATCH' })
    renderPanel(base())
    openWizard()
    fireEvent.click(screen.getByTestId('arca-setup-ambiente-produccion').querySelector('input')!)
    fireEvent.change(screen.getByTestId('arca-setup-punto-venta'), { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('arca-setup-prepare'))
    const notice = await screen.findByTestId('arca-setup-error')
    expect(notice.textContent).toMatch(/El CUIT no coincide con tu negocio/)
    expect(notice.textContent).not.toMatch(/CUIT_TENANT_MISMATCH/)
    expect(document.getElementById('arca-setup-cuit-error')?.textContent).toMatch(/Datos del negocio/)
  })
})

describe('pasos 3–4 — archivo para ARCA y certificado', () => {
  it('el archivo se vuelve a pedir al servidor en cada descarga (después de recargar o días después)', async () => {
    const createObjectURL = vi.fn(() => 'blob:arca')
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = vi.fn()
    onTestFinished(() => { URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke })
    service.getRequestFile.mockResolvedValue({ ok: true, state: 'CSR_AVAILABLE', csr: { pem: '-----BEGIN CERTIFICATE REQUEST-----\nx\n-----END CERTIFICATE REQUEST-----', filename: 'techrepair-qa-demo.csr' } })
    renderPanel(inProgress('certificate'))
    openWizard()
    expect(screen.getByTestId('arca-setup-wizard').dataset.step).toBe('3')
    expect(screen.getByTestId('arca-setup-guide').dataset.ambiente).toBe('homologacion')
    fireEvent.click(screen.getByTestId('arca-setup-download'))
    await waitFor(() => expect(service.getRequestFile).toHaveBeenCalledTimes(1))
    await waitFor(() => expect((screen.getByTestId('arca-setup-download') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('arca-setup-download'))
    await waitFor(() => expect(service.getRequestFile).toHaveBeenCalledTimes(2))
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('un archivo con clave se rechaza localmente y nunca se envía', async () => {
    renderPanel(inProgress('certificate'))
    openWizard()
    fireEvent.click(screen.getByTestId('arca-setup-have-certificate'))
    expect(screen.getByTestId('arca-setup-wizard').dataset.step).toBe('4')
    const label = ['PRIVATE', 'KEY'].join(' ')
    const file = new File([`-----BEGIN ${label}-----\nMIIE\n-----END ${label}-----\n`], 'mi-clave.pem', { type: 'application/x-pem-file' })
    fireEvent.change(screen.getByTestId('arca-setup-certificate-input'), { target: { files: [file] } })
    const error = await screen.findByTestId('arca-setup-certificate-error')
    expect(error.textContent).toMatch(/contiene una clave/)
    expect(service.attachCertificatePem).not.toHaveBeenCalled()
    expect(service.attachCertificateDerBase64).not.toHaveBeenCalled()
    expect(screen.getByTestId('arca-setup-dropzone').dataset.uploadState).toBe('rejected')
  })

  it('certificado PEM válido → se envía y se relee el estado', async () => {
    service.attachCertificatePem.mockResolvedValue({ ok: true, state: 'CERTIFICATE_ATTACHED' })
    const { refresh } = renderPanel(inProgress('certificate'))
    openWizard()
    fireEvent.click(screen.getByTestId('arca-setup-have-certificate'))
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'
    fireEvent.change(screen.getByTestId('arca-setup-certificate-input'), { target: { files: [new File([pem], 'arca.crt')] } })
    await waitFor(() => expect(service.attachCertificatePem).toHaveBeenCalledWith(pem.trim()))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(screen.getByTestId('arca-setup-dropzone').dataset.uploadState).toBe('accepted')
  })
})

describe('paso 5 — verificar: las esperas son absolutas', () => {
  it.each(['in_progress', 'result_unknown', 'ticket_active', 'verification_expired', 'cooldown'] as const)('espera %s → sin botón Verificar', (hold) => {
    renderPanel(inProgress('verification', hold))
    const wizard = openWizard()
    expect(within(document.body).queryByTestId('arca-setup-verify')).toBeNull()
    expect(within(wizard).getByTestId('arca-setup-hold').dataset.holdReason).toBe(hold)
    if (hold === 'in_progress') {
      expect(screen.queryByTestId('arca-setup-cancel')).toBeNull()
      expect(screen.queryByTestId('arca-setup-replace-certificate')).toBeNull()
    }
  })

  it('espera heredada en el paso del certificado: se puede subir, pero no verificar', () => {
    renderPanel(inProgress('certificate', 'ticket_active'))
    const wizard = openWizard()
    expect(within(wizard).getByTestId('arca-setup-hold').dataset.holdReason).toBe('ticket_active')
    expect(screen.queryByTestId('arca-setup-verify')).toBeNull()
  })

  it('sin espera: un doble clic manda UNA sola verificación con la misma clave, con progreso accesible', async () => {
    let resolve!: (v: unknown) => void
    service.verifyAndActivate.mockReturnValue(new Promise((r) => { resolve = r }))
    const { refresh } = renderPanel(inProgress('verification'))
    openWizard()
    fireEvent.click(screen.getByTestId('arca-setup-verify'))
    fireEvent.click(screen.getByTestId('arca-setup-verify'))
    expect(service.verifyAndActivate).toHaveBeenCalledTimes(1)
    expect((screen.getByTestId('arca-setup-verifying')).getAttribute('role')).toBe('status')
    expect(screen.getByTestId('arca-setup-verifying').textContent).toMatch(/Verificando conexión con ARCA…/)
    expect((screen.getByTestId('arca-setup-cancel') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { resolve({ ok: false, state: 'WSAA_UNAVAILABLE' }) })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    const firstKey = service.verifyAndActivate.mock.calls[0][0]
    await waitFor(() => expect((screen.getByTestId('arca-setup-verify') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('arca-setup-verify'))
    await waitFor(() => expect(service.verifyAndActivate).toHaveBeenCalledTimes(2))
    expect(service.verifyAndActivate.mock.calls[1][0]).toBe(firstKey)
  })

  it('una respuesta ambigua se muestra sin jerga y la pantalla pasa a la espera cuando el estado la trae', async () => {
    service.verifyAndActivate.mockResolvedValue({ ok: false, state: 'WSAA_RESULT_UNKNOWN', retryAfterSeconds: 45_000 })
    let current = inProgress('verification')
    const refresh = vi.fn(async () => { current = inProgress('verification', 'result_unknown'); return current })
    const { rerender } = render(<ArcaSetupPanel status={current} loading={false} failed={false} refresh={refresh} defaults={DEFAULTS} />)
    openWizard()
    fireEvent.click(screen.getByTestId('arca-setup-verify'))
    const notice = await screen.findByTestId('arca-setup-error')
    expect(notice.dataset.errorCategory).toBe('ambiguous')
    expect(notice.textContent).not.toMatch(LEAK)
    rerender(<ArcaSetupPanel status={current} loading={false} failed={false} refresh={refresh} defaults={DEFAULTS} />)
    expect(screen.queryByTestId('arca-setup-verify')).toBeNull()
    expect(screen.getAllByTestId('arca-setup-hold').length).toBeGreaterThan(0)
    // La espera del servidor reemplaza al aviso de la acción: no se repite el mismo mensaje.
    expect(screen.queryByTestId('arca-setup-error')).toBeNull()
  })

  it('verificado sin activar: "Terminar activación" reusa verify (no hay otro camino a ARCA)', async () => {
    service.verifyAndActivate.mockResolvedValue({ ok: true, state: 'ACTIVATED', connection: 'connected' })
    renderPanel(inProgress('activation'))
    openWizard()
    fireEvent.click(screen.getByTestId('arca-setup-activate'))
    await waitFor(() => expect(service.verifyAndActivate).toHaveBeenCalledTimes(1))
  })
})

describe('cancelar siempre confirma', () => {
  it('con espera ambigua: advertencia fuerte, nada se envía hasta confirmar y la espera se sigue mostrando', async () => {
    service.cancel.mockResolvedValue({ ok: true, state: 'SETUP_CANCELLED', remoteTicketPossible: true })
    const { refresh } = renderPanel(inProgress('verification', 'result_unknown'))
    openWizard()
    fireEvent.click(screen.getByTestId('arca-setup-cancel'))
    const confirm = screen.getByTestId('arca-setup-cancel-confirm')
    expect(confirm.dataset.strong).toBe('true')
    expect(confirm.textContent).toMatch(/no revoca nada en ARCA/)
    expect((within(confirm).getByTestId('arca-setup-hold')).isConnected).toBe(true)
    expect(service.cancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('arca-setup-cancel-back'))
    expect(screen.queryByTestId('arca-setup-cancel-confirm')).toBeNull()
    fireEvent.click(screen.getByTestId('arca-setup-cancel'))
    fireEvent.click(screen.getByTestId('arca-setup-cancel-confirm-button'))
    await waitFor(() => expect(service.cancel).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('verificado sin activar: la confirmación explica que descarta un acceso vigente', () => {
    renderPanel(inProgress('activation'))
    openWizard()
    fireEvent.click(screen.getByTestId('arca-setup-cancel'))
    expect(screen.getByTestId('arca-setup-cancel-confirm').textContent).toMatch(/ARCA ya habilitó el acceso/)
  })

  it('sin espera: confirmación simple', () => {
    renderPanel(inProgress('certificate'))
    openWizard()
    fireEvent.click(screen.getByTestId('arca-setup-cancel'))
    expect(screen.getByTestId('arca-setup-cancel-confirm').dataset.strong).toBe('false')
  })
})

describe('paso 6 — listo', () => {
  it('sólo con conectado y sin pendientes; muestra identidad y vigencia, nunca material', () => {
    const { rerender } = renderPanel(inProgress('activation'))
    openWizard()
    rerender(<ArcaSetupPanel status={{ ...connected(), next_action: 'verify_connection' }} loading={false} failed={false} refresh={vi.fn()} defaults={DEFAULTS} />)
    expect(screen.queryByTestId('arca-setup-done')).toBeNull()
    rerender(<ArcaSetupPanel status={connected()} loading={false} failed={false} refresh={vi.fn()} defaults={DEFAULTS} />)
    const done = screen.getByTestId('arca-setup-done')
    expect(screen.getByTestId('arca-setup-wizard').dataset.step).toBe('6')
    expect(done.textContent).toMatch(/20-12345678-6/)
    expect(done.textContent).toMatch(/QA Demo SRL/)
    expect(done.textContent).toMatch(/Homologación/)
    expect(done.textContent).toMatch(/Vigente · vence 13\/09\/2028/)
    // Phase 2B verifica y activa la conexión; no emite ni obtiene CAE: el cierre no promete más que eso.
    expect(screen.getByTestId('arca-setup-done-message').textContent).toMatch(/La conexión con ARCA quedó configurada correctamente\. TechRepair Pro usará esta conexión cuando emitas comprobantes electrónicos\./)
    expect(screen.getByTestId('arca-setup-wizard').textContent).not.toMatch(EMISSION_PROMISE)
    expect(done.textContent).toMatch(/Conectada/)
    expect(screen.getByTestId('arca-setup-wizard').textContent).not.toMatch(LEAK)
  })
})

describe('useArcaSelfServiceStatus — relectura sin máquina de estados local', () => {
  afterEach(() => { vi.useRealTimers() })

  it('relee al montar, al volver el foco, al volver la red y con la pestaña visible', async () => {
    let t = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => t)
    statusReader.getSelfServiceStatus.mockResolvedValue(base())
    const { result } = renderHook(() => useArcaSelfServiceStatus('biz-1'))
    await waitFor(() => expect(result.current.status).not.toBeNull())
    expect(statusReader.getSelfServiceStatus).toHaveBeenCalledTimes(1)
    t += 5_000
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    t += 5_000
    await act(async () => { window.dispatchEvent(new Event('online')) })
    t += 5_000
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(statusReader.getSelfServiceStatus).toHaveBeenCalledTimes(4))
    // Ráfaga (focus + visibilitychange juntos) → una sola lectura.
    t += 5_000
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(statusReader.getSelfServiceStatus).toHaveBeenCalledTimes(5))
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('al vencer retry_not_before relee; la espera sigue hasta que el servidor diga lo contrario', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date('2026-09-14T15:00:00Z'))
    const held = { ...inProgress('verification', 'cooldown'), setup: { ...inProgress('verification', 'cooldown').setup, retry_not_before: '2026-09-14T15:00:30Z' } }
    statusReader.getSelfServiceStatus.mockResolvedValueOnce(held).mockResolvedValueOnce(inProgress('verification'))
    const { result } = renderHook(() => useArcaSelfServiceStatus('biz-1'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(result.current.status?.setup.verification_hold).toBe('cooldown')
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(statusReader.getSelfServiceStatus).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(13_000) })
    expect(statusReader.getSelfServiceStatus).toHaveBeenCalledTimes(2)
    expect(result.current.status?.setup.verification_hold).toBeNull()
  })

  it('una respuesta vieja no pisa a una más nueva; una lectura fallida no deja un estado pintado', async () => {
    let first!: (v: unknown) => void
    statusReader.getSelfServiceStatus
      .mockReturnValueOnce(new Promise((r) => { first = r }))
      .mockResolvedValueOnce(inProgress('certificate'))
      .mockRejectedValueOnce(new Error('network'))
    const { result } = renderHook(() => useArcaSelfServiceStatus('biz-1'))
    await act(async () => { await result.current.refresh() })
    expect(result.current.status?.setup.step).toBe('certificate')
    await act(async () => { first(base()) })
    expect(result.current.status?.setup.step).toBe('certificate')
    await act(async () => { await result.current.refresh() })
    expect(result.current.status).toBeNull()
    expect(result.current.failed).toBe(true)
  })
})

const EMISSION_PROMISE = /(ya )?pod[eé]s (emitir|facturar)|emitir (ya|ahora)|\bCAE\b|emisi[oó]n (real|probada|verificada)|comprobante (emitido|autorizado)/i

describe('Clave Fiscal: se usa en ARCA, TechRepair Pro nunca la pide ni la guarda', () => {
  const noClaveFiscalInput = () => {
    for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
      const id = el.getAttribute('id')
      const label = id ? document.querySelector(`label[for="${id}"]`)?.textContent ?? '' : ''
      const described = [el.getAttribute('name'), el.getAttribute('placeholder'), el.getAttribute('aria-label'), label, el.closest('label')?.textContent].join(' ')
      expect(described).not.toMatch(/clave fiscal/i)
      expect(el.getAttribute('type')).not.toBe('password')
    }
  }

  it('la entrada conserva las dos ideas y no hay ningún campo de Clave Fiscal en todo el recorrido', () => {
    service.getRequestFile.mockResolvedValue({ ok: false, state: 'SETUP_UNAVAILABLE' })
    const { rerender } = renderPanel(base())
    const line = screen.getByTestId('arca-setup-entry-clave-fiscal').textContent ?? ''
    expect(line).toMatch(/acceso a ARCA con Clave Fiscal/)
    expect(line).toMatch(/en el sitio de ARCA/)
    expect(line).toMatch(/TechRepair Pro nunca te pide ni guarda tu Clave Fiscal/)
    openWizard()
    noClaveFiscalInput()
    for (const status of [inProgress('certificate'), inProgress('verification'), inProgress('activation'), connected()]) {
      rerender(<ArcaSetupPanel status={status} loading={false} failed={false} refresh={vi.fn()} defaults={DEFAULTS} />)
      noClaveFiscalInput()
    }
  })

  it('la guía del paso 3 repite la aclaración', () => {
    renderPanel(inProgress('certificate'))
    openWizard()
    expect(screen.getByTestId('arca-setup-guide-clave-fiscal').textContent).toMatch(/nunca te pide ni guarda tu Clave Fiscal/)
    expect(screen.getByTestId('arca-setup-wizard').textContent).not.toMatch(EMISSION_PROMISE)
  })
})
