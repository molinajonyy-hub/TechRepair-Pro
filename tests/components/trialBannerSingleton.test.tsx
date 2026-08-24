import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { SubscriptionBanner } from '../../src/components/subscription/SubscriptionBanner'

const subscriptionState = vi.hoisted(() => ({
  isTrial: true,
  isPastDue: false,
  daysUntilTrialEnd: 6 as number | null,
  daysUntilGraceEnd: null as number | null,
  daysUntilPeriodEnd: null as number | null,
  isActive: false,
  loading: false,
}))

vi.mock('../../src/hooks/useSubscription', () => ({
  useSubscription: () => subscriptionState,
}))

function CurrentPath() {
  return <span data-testid="current-path">{useLocation().pathname}</span>
}

function mountBanner() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <SubscriptionBanner />
      <CurrentPath />
    </MemoryRouter>,
  )
}

describe('banner canónico de período de prueba', () => {
  beforeEach(() => {
    Object.assign(subscriptionState, {
      isTrial: true,
      isPastDue: false,
      daysUntilTrialEnd: 6,
      daysUntilGraceEnd: null,
      daysUntilPeriodEnd: null,
      isActive: false,
      loading: false,
    })
  })

  it('trialing renderiza exactamente un aviso con los días provistos por trial_ends_at', () => {
    mountBanner()

    expect(screen.getAllByText(/Tu período de prueba vence en 6 días/i)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Ver planes' })).toHaveLength(1)
    expect(screen.queryByText(/acceso completo al Plan Pro/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Elegir plan' })).not.toBeInTheDocument()
  })

  it('active no renderiza avisos de período de prueba', () => {
    Object.assign(subscriptionState, { isTrial: false, isActive: true })
    mountBanner()

    expect(screen.queryByText(/período de prueba/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ver planes' })).not.toBeInTheDocument()
  })

  it('trial vencido conserva el comportamiento canónico y no muestra 0 días restantes', () => {
    subscriptionState.daysUntilTrialEnd = 0
    mountBanner()

    expect(screen.getByText(/Tu período de prueba ha vencido/i)).toBeInTheDocument()
    expect(screen.queryByText(/0 días/i)).not.toBeInTheDocument()
  })

  it('el CTA canónico conserva el destino de planes', () => {
    mountBanner()
    fireEvent.click(screen.getByRole('button', { name: 'Ver planes' }))
    expect(screen.getByTestId('current-path')).toHaveTextContent('/subscription/plans')
  })
})

describe('regresión estructural del banner duplicado', () => {
  const layout = readFileSync('src/layouts/MainLayout.tsx', 'utf8')

  it('MainLayout monta una sola fuente de avisos de trial', () => {
    expect((layout.match(/<SubscriptionBanner\b/g) ?? [])).toHaveLength(1)
    expect(layout).not.toMatch(/TrialBanner/)
  })
})
