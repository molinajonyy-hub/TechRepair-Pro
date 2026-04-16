// ============================================================
// TechRepair Pro — Subscription & Mercado Pago Types
// ============================================================

// ─── Status types ────────────────────────────────────────────
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'canceled'
  | 'pending_activation'

export type SubscriptionPlan = 'basico' | 'pro' | 'full'

export type PaymentStatus =
  | 'approved'
  | 'pending'
  | 'in_process'
  | 'rejected'
  | 'cancelled'
  | 'refunded'
  | 'charged_back'

export type PaymentType = 'one_time' | 'recurring' | 'manual'

// ─── Plan definitions ─────────────────────────────────────────
export interface PlanDefinition {
  id: SubscriptionPlan
  name: string
  description: string
  price_monthly: number
  price_quarterly: number
  price_annual: number
  currency: 'ARS'
  mp_plan_id_monthly: string
  mp_plan_id_quarterly: string
  mp_plan_id_annual: string
  features: string[]
  limits: {
    orders_per_month: number | 'unlimited'
    users: number | 'unlimited'
    inventory_items: number | 'unlimited'
    comprobantes: boolean
    reports: boolean
    api_access: boolean
    priority_support: boolean
  }
  highlighted?: boolean
}

export type BillingCycle = 'monthly' | 'quarterly' | 'annual'

// ─── Business subscription snapshot ──────────────────────────
export interface BusinessSubscription {
  subscription_status: SubscriptionStatus
  subscription_plan: SubscriptionPlan | null
  mp_preapproval_id: string | null
  mp_payer_email: string | null
  current_period_start: string | null
  current_period_end: string | null
  grace_until: string | null
  last_payment_status: PaymentStatus | null
  trial_ends_at: string | null
}

// ─── Payment record ───────────────────────────────────────────
export interface Payment {
  id: string
  business_id: string
  provider: string
  external_payment_id: string | null
  type: PaymentType
  amount: number
  currency: string
  status: PaymentStatus
  subscription_plan: string | null
  paid_at: string | null
  period_start: string | null
  period_end: string | null
  raw_payload: Record<string, unknown>
  created_at: string
}

// ─── Subscription event (webhook log) ────────────────────────
export interface SubscriptionEvent {
  id: string
  business_id: string | null
  provider: string
  event_type: string
  external_id: string | null
  raw_payload: Record<string, unknown>
  processed: boolean
  error_message: string | null
  created_at: string
}

// ─── Mercado Pago API shapes ──────────────────────────────────
export interface MPPreapproval {
  id: string
  status: 'authorized' | 'paused' | 'cancelled' | 'pending'
  reason: string
  payer_id: number
  payer_email: string
  preapproval_plan_id: string
  next_payment_date: string
  last_modified: string
  date_created: string
  summarized?: {
    quotas: number
    charged_quantity: number
    last_charged_date: string
    last_charged_amount: number
  }
}

export interface MPPayment {
  id: number
  status: 'approved' | 'pending' | 'in_process' | 'rejected' | 'cancelled' | 'refunded' | 'charged_back'
  status_detail: string
  transaction_amount: number
  currency_id: string
  payer: { email: string; id: number }
  date_approved: string | null
  date_created: string
  metadata?: Record<string, string>
}

// ─── Create subscription request (frontend → edge fn) ─────────
export interface CreateSubscriptionRequest {
  business_id: string
  plan: SubscriptionPlan
  billing_cycle: BillingCycle
  payer_email: string
  back_url: string
}

export interface CreateSubscriptionResponse {
  init_point: string
  preapproval_id: string
}

// ─── Access level derived from status ────────────────────────
export type AccessLevel = 'full' | 'limited' | 'blocked'

export function getAccessLevel(status: SubscriptionStatus): AccessLevel {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'full'
    case 'past_due':
      return 'limited'
    case 'suspended':
    case 'canceled':
    case 'pending_activation':
      return 'blocked'
    default:
      return 'blocked'
  }
}

export function isAccessAllowed(status: SubscriptionStatus): boolean {
  return getAccessLevel(status) !== 'blocked'
}

// ─── Plan catalog ─────────────────────────────────────────────
export const PLANS: PlanDefinition[] = [
  {
    id: 'basico',
    name: 'Básico',
    description: 'Ideal para talleres pequeños que empiezan a digitalizarse.',
    price_monthly: 4900,
    price_quarterly: 12900,
    price_annual: 44900,
    currency: 'ARS',
    mp_plan_id_monthly: import.meta.env.VITE_MP_PLAN_BASICO_MONTHLY || '',
    mp_plan_id_quarterly: import.meta.env.VITE_MP_PLAN_BASICO_QUARTERLY || '',
    mp_plan_id_annual: import.meta.env.VITE_MP_PLAN_BASICO_ANNUAL || '',
    features: [
      'Hasta 50 órdenes por mes',
      '2 usuarios',
      '200 productos en inventario',
      'Remitos y comprobantes básicos',
      'Soporte por email',
    ],
    limits: {
      orders_per_month: 50,
      users: 2,
      inventory_items: 200,
      comprobantes: true,
      reports: false,
      api_access: false,
      priority_support: false,
    },
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'Para talleres en crecimiento con mayor volumen de trabajo.',
    price_monthly: 9900,
    price_quarterly: 25900,
    price_annual: 89900,
    currency: 'ARS',
    mp_plan_id_monthly: import.meta.env.VITE_MP_PLAN_PRO_MONTHLY || '',
    mp_plan_id_quarterly: import.meta.env.VITE_MP_PLAN_PRO_QUARTERLY || '',
    mp_plan_id_annual: import.meta.env.VITE_MP_PLAN_PRO_ANNUAL || '',
    features: [
      'Órdenes ilimitadas',
      'Hasta 10 usuarios',
      'Inventario ilimitado',
      'Comprobantes completos (Factura A/C)',
      'Reportes y estadísticas',
      'Soporte prioritario',
    ],
    limits: {
      orders_per_month: 'unlimited',
      users: 10,
      inventory_items: 'unlimited',
      comprobantes: true,
      reports: true,
      api_access: false,
      priority_support: true,
    },
    highlighted: true,
  },
  {
    id: 'full',
    name: 'Full',
    description: 'Para cadenas y talleres con múltiples sucursales.',
    price_monthly: 19900,
    price_quarterly: 51900,
    price_annual: 179900,
    currency: 'ARS',
    mp_plan_id_monthly: import.meta.env.VITE_MP_PLAN_FULL_MONTHLY || '',
    mp_plan_id_quarterly: import.meta.env.VITE_MP_PLAN_FULL_QUARTERLY || '',
    mp_plan_id_annual: import.meta.env.VITE_MP_PLAN_FULL_ANNUAL || '',
    features: [
      'Todo lo de Pro',
      'Usuarios ilimitados',
      'Multi-sucursal',
      'Acceso a API',
      'Panel de administración avanzado',
      'Soporte dedicado 24/7',
    ],
    limits: {
      orders_per_month: 'unlimited',
      users: 'unlimited',
      inventory_items: 'unlimited',
      comprobantes: true,
      reports: true,
      api_access: true,
      priority_support: true,
    },
  },
]

export const BILLING_LABELS: Record<BillingCycle, string> = {
  monthly: 'Mensual',
  quarterly: 'Trimestral',
  annual: 'Anual',
}

export const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: 'Período de prueba',
  active: 'Activa',
  past_due: 'Pago vencido',
  suspended: 'Suspendida',
  canceled: 'Cancelada',
  pending_activation: 'Pendiente de activación',
}

export const STATUS_COLORS: Record<SubscriptionStatus, string> = {
  trialing: '#60a5fa',
  active: '#34d399',
  past_due: '#fbbf24',
  suspended: '#f87171',
  canceled: '#94a3b8',
  pending_activation: '#a78bfa',
}

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  approved: 'Aprobado',
  pending: 'Pendiente',
  in_process: 'En proceso',
  rejected: 'Rechazado',
  cancelled: 'Cancelado',
  refunded: 'Reembolsado',
  charged_back: 'Contracargo',
}

export const PAYMENT_STATUS_COLORS: Record<PaymentStatus, string> = {
  approved: '#34d399',
  pending: '#fbbf24',
  in_process: '#60a5fa',
  rejected: '#f87171',
  cancelled: '#94a3b8',
  refunded: '#a78bfa',
  charged_back: '#fb923c',
}
