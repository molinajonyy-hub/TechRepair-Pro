import type { Page } from '@playwright/test'

export const nav = {
  dashboard:      (page: Page) => page.goto('/dashboard'),
  customers:      (page: Page) => page.goto('/customers'),
  inventory:      (page: Page) => page.goto('/inventory'),
  comprobantes:   (page: Page) => page.goto('/comprobantes'),
  caja:           (page: Page) => page.goto('/caja'),
  finance:        (page: Page) => page.goto('/finance'),
  financeReports: (page: Page) => page.goto('/finance/reports'),
  financeHealth:  (page: Page) => page.goto('/finance/health'),
  expenses:       (page: Page) => page.goto('/expenses'),
  orders:         (page: Page) => page.goto('/orders'),
  suppliers:      (page: Page) => page.goto('/suppliers'),
  warranties:     (page: Page) => page.goto('/warranties'),
  reports:        (page: Page) => page.goto('/reports'),
}
