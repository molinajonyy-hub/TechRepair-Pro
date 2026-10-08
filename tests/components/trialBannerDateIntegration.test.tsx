import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionBanner } from '../../src/components/subscription/SubscriptionBanner'

const subscriptionService = vi.hoisted(() => ({
  getSubscription: vi.fn(),
  getPayments: vi.fn(),
}))

// PRE-BETA-3A-0: el banner exige la capacidad `subscription`; el actor de este
// test es el dueño (el único que ve el estado del trial).
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    businessId: 'trial-date-integration-business',
    role: 'owner',
    isOwner: true,
    profile: { permissions: null },
  }),
}))

vi.mock('../../src/services/subscriptionService', () => subscriptionService)

vi.mock('../../src/lib/realtimeChannel', () => ({
  subscribeShared: () => () => undefined,
}))

vi.mock('../../src/lib/logger', () => ({
  logger: { error: vi.fn() },
}))

describe('fecha real del banner de trial', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'))
    subscriptionService.getPayments.mockResolvedValue([])
    subscriptionService.getSubscription.mockResolvedValue({
      id: 'subscription-1',
      business_id: 'trial-date-integration-business',
      subscription_status: 'trialing',
      subscription_plan: 'pro',
      access_source: 'trial',
      override_expires_at: null,
      // BETA-UX-1C: 5 días, el primero en que el aviso aparece.
      trial_ends_at: '2026-08-29T12:00:00.000Z',
      grace_until: null,
      current_period_end: null,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calcula y muestra los días restantes desde trial_ends_at', async () => {
    render(
      <MemoryRouter>
        <SubscriptionBanner />
      </MemoryRouter>,
    )

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(subscriptionService.getSubscription).toHaveBeenCalledWith('trial-date-integration-business')
    expect(screen.getByText(/Tu período de prueba vence en 5 días/i)).toBeInTheDocument()
    expect(screen.queryByText(/14 días/i)).not.toBeInTheDocument()
  })

  it('BETA-UX-1C: a 6 días de la fecha real todavía no hay aviso', async () => {
    // Un día después del caso anterior: `useSubscription` guarda la última
    // lectura 45 s a nivel de módulo, y acá tiene que leer ESTA fila.
    vi.setSystemTime(new Date('2026-08-25T12:00:00.000Z'))
    subscriptionService.getSubscription.mockResolvedValue({
      subscription_status: 'trialing',
      subscription_plan: 'pro',
      access_source: 'trial',
      override_expires_at: null,
      trial_ends_at: '2026-08-31T12:00:00.000Z',
      grace_until: null,
      current_period_end: null,
    })
    const { container } = render(
      <MemoryRouter>
        <SubscriptionBanner />
      </MemoryRouter>,
    )

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(subscriptionService.getSubscription).toHaveBeenCalledWith('trial-date-integration-business')
    expect(container.textContent).toBe('')
  })
})
