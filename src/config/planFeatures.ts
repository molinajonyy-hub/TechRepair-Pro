/**
 * planFeatures.ts — Fuente única de verdad para control de acceso por plan.
 * Toda lógica de features debe leer desde aquí.
 */

export type PlanId = 'basico' | 'pro' | 'full'

export type PlanFeature =
  | 'arca'             // Facturación electrónica ARCA / CAE
  | 'currentAccounts'  // Cuentas corrientes
  | 'reports'          // Reportes
  | 'advancedFinance'  // Finanzas pro: costos, métricas, trazabilidad
  | 'tasks'            // Módulo tareas / empleados
  | 'advancedRoles'    // Permisos granulares
  | 'audit'            // Auditoría y logs
  | 'multisucursal'    // Multi-sucursal
  | 'mayorista'        // Módulo mayorista
  | 'personal_finance' // Mi Guita — finanzas personales del dueño

export interface PlanFeatureSet {
  arca:             boolean
  currentAccounts:  boolean
  reports:          boolean
  advancedFinance:  boolean
  tasks:            boolean
  advancedRoles:    boolean
  audit:            boolean
  multisucursal:    boolean
  mayorista:        boolean
  personal_finance: boolean
  maxUsers:         number
}

export const PLAN_FEATURES: Record<PlanId, PlanFeatureSet> = {
  basico: {
    arca:             false,
    currentAccounts:  false,
    reports:          false,
    advancedFinance:  false,
    tasks:            false,
    advancedRoles:    false,
    audit:            false,
    multisucursal:    false,
    mayorista:        false,
    personal_finance: false,
    maxUsers:         1,
  },
  pro: {
    arca:             true,
    currentAccounts:  true,
    reports:          true,
    advancedFinance:  true,
    tasks:            true,
    advancedRoles:    false,
    audit:            false,
    multisucursal:    false,
    mayorista:        false,
    personal_finance: true,
    maxUsers:         3,
  },
  full: {
    arca:             true,
    currentAccounts:  true,
    reports:          true,
    advancedFinance:  true,
    tasks:            true,
    advancedRoles:    true,
    audit:            true,
    multisucursal:    true,
    mayorista:        true,
    personal_finance: true,
    maxUsers:         10,
  },
}

// Durante el trial se otorgan features del plan Pro
export const TRIAL_FEATURES: PlanFeatureSet = { ...PLAN_FEATURES.pro }

// Plan mínimo requerido por feature (para el copy del upgrade CTA)
export const FEATURE_REQUIRED_PLAN: Record<PlanFeature, 'pro' | 'full'> = {
  arca:             'pro',
  currentAccounts:  'pro',
  reports:          'pro',
  advancedFinance:  'pro',
  tasks:            'pro',
  advancedRoles:    'full',
  audit:            'full',
  multisucursal:    'full',
  mayorista:        'pro',
  personal_finance: 'pro',
}

export const PLAN_DISPLAY: Record<PlanId, { label: string; color: string }> = {
  basico: { label: 'Básico',  color: '#64748b' },
  pro:    { label: 'Pro',     color: '#6366f1' },
  full:   { label: 'Full',    color: '#475569' },
}

// ─── Feature Registry tipado — usar en lugar de strings hardcodeados ──────────
// Evita typos como 'arcaaa', 'report', 'finance_advanced', etc.
export const FEATURES = {
  ARCA:             'arca',
  CURRENT_ACCOUNTS: 'currentAccounts',
  REPORTS:          'reports',
  ADVANCED_FINANCE: 'advancedFinance',
  TASKS:            'tasks',
  MAYORISTA:        'mayorista',
  ADVANCED_ROLES:   'advancedRoles',
  AUDIT:            'audit',
  MULTISUCURSAL:    'multisucursal',
  PERSONAL_FINANCE: 'personal_finance',
} as const satisfies Record<string, PlanFeature>
