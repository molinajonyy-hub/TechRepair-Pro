// ──────────────────────────────────────────────────────────────────────────────
// Permissions system for TechRepair Pro
// Each permission key maps to a UI feature/area.
// NULL profile.permissions → use role defaults below.
// Partial overrides are merged on top of role defaults.
// ──────────────────────────────────────────────────────────────────────────────

export interface AppPermissions {
  /** Can see and manage service orders */
  orders: boolean
  /** Can change order status (e.g. tech updating Recibido → En proceso) */
  orders_change_status: boolean
  /** Can see prices, totals and financial data within an order */
  orders_view_financials: boolean
  /** Can access inventory module */
  inventory: boolean
  /** Can see cost prices in inventory */
  inventory_view_costs: boolean
  /** Can access customers module */
  customers: boolean
  /** Can access finance / caja module */
  finance: boolean
  /** Can access and issue comprobantes (receipts/invoices) */
  comprobantes: boolean
  /** Can view reports */
  reports: boolean
  /** Can access settings */
  settings: boolean
  /** Can change sensitive settings (business info, integrations, etc.) */
  settings_sensitive: boolean
  /** Can manage subscription & billing */
  subscription: boolean
  /** Can manage team members and their permissions */
  users: boolean
  /**
   * P0-P6 — Can access the wholesale (Mayorista) module.
   *
   * Que el NEGOCIO tenga la feature `mayorista` no implica que todos sus
   * miembros deban verla. Antes el gate era «feature activa + rol ∈ los 7», así
   * que un técnico veía Mayorista sólo porque el plan del negocio era Full.
   * Ahora hacen falta las dos cosas: feature del negocio Y capacidad del actor.
   */
  wholesale: boolean
  /**
   * P0-P6 — Can access Mi Guita (finanzas personales).
   *
   * Cerrado para TODOS los roles del negocio durante la beta. No es un permiso
   * que el owner pueda otorgar desde la matriz: el acceso interno se resuelve
   * por `system_admins`, que es server-side y no configurable desde el tenant.
   */
  personal_finance: boolean
}

export type PermissionKey = keyof AppPermissions

export const ALL_PERMISSIONS: PermissionKey[] = [
  'orders',
  'orders_change_status',
  'orders_view_financials',
  'inventory',
  'inventory_view_costs',
  'customers',
  'finance',
  'comprobantes',
  'reports',
  'settings',
  'settings_sensitive',
  'subscription',
  'users',
  'wholesale',
  'personal_finance',
]

/** Human-readable labels for the permissions matrix UI */
export const PERMISSION_LABELS: Record<PermissionKey, { label: string; description: string; group: string }> = {
  orders:                  { label: 'Órdenes de servicio',        description: 'Ver y gestionar órdenes',                    group: 'Órdenes' },
  orders_change_status:    { label: 'Cambiar estado de órdenes',  description: 'Actualizar el estado de una orden',          group: 'Órdenes' },
  orders_view_financials:  { label: 'Ver precios en órdenes',     description: 'Ver totales y datos financieros por orden',  group: 'Órdenes' },
  inventory:               { label: 'Inventario',                 description: 'Acceder al módulo de inventario',            group: 'Inventario' },
  inventory_view_costs:    { label: 'Ver costos de inventario',   description: 'Ver precios de costo en el inventario',      group: 'Inventario' },
  customers:               { label: 'Clientes',                   description: 'Acceder al módulo de clientes',              group: 'Clientes' },
  finance:                 { label: 'Finanzas / Caja',            description: 'Acceder al área de finanzas',                group: 'Finanzas' },
  comprobantes:            { label: 'Comprobantes',               description: 'Emitir y ver comprobantes',                  group: 'Finanzas' },
  reports:                 { label: 'Reportes',                   description: 'Ver reportes y estadísticas',                group: 'Finanzas' },
  settings:                { label: 'Configuración',              description: 'Acceder a configuración básica',             group: 'Configuración' },
  settings_sensitive:      { label: 'Config. avanzada',          description: 'Cambiar datos del negocio e integraciones',   group: 'Configuración' },
  subscription:            { label: 'Suscripción',                description: 'Ver y gestionar suscripción',                group: 'Configuración' },
  users:                   { label: 'Usuarios / Equipo',          description: 'Invitar y gestionar usuarios',               group: 'Configuración' },
  wholesale:               { label: 'Mayorista',                  description: 'Acceder al módulo mayorista',                group: 'Clientes' },
  personal_finance:        { label: 'Mi Guita',                   description: 'Finanzas personales (no disponible en beta)', group: 'Configuración' },
}

/** Groups for rendering the matrix in sections */
export const PERMISSION_GROUPS = ['Órdenes', 'Inventario', 'Clientes', 'Finanzas', 'Configuración'] as const

/**
 * P0-P6 — Capacidades que el owner NO puede otorgar desde la matriz de permisos.
 *
 * `personal_finance` está cerrado para la beta y su acceso interno se decide por
 * `system_admins` (server-side, fuera del tenant). Dejarlo configurable haría
 * que un owner cualquiera se lo habilite a su equipo, que es justo lo que la
 * decisión de producto descarta.
 *
 * Nada de lo que otorga privilegio SaaS o permite escapar del tenant puede
 * aparecer acá como configurable.
 */
export const NON_CONFIGURABLE_PERMISSIONS: readonly PermissionKey[] = ['personal_finance'] as const

/** Las capacidades que la matriz de permisos puede mostrar y editar. */
export const CONFIGURABLE_PERMISSIONS: PermissionKey[] =
  ALL_PERMISSIONS.filter(k => !NON_CONFIGURABLE_PERMISSIONS.includes(k))

/** Default permissions per role. Owners always get all. */
export const ROLE_DEFAULT_PERMISSIONS: Record<string, AppPermissions> = {
  owner: {
    orders: true,
    orders_change_status: true,
    orders_view_financials: true,
    inventory: true,
    inventory_view_costs: true,
    customers: true,
    finance: true,
    comprobantes: true,
    reports: true,
    settings: true,
    settings_sensitive: true,
    subscription: true,
    users: true,
    wholesale: true,
    personal_finance: false,
  },
  admin: {
    orders: true,
    orders_change_status: true,
    orders_view_financials: true,
    inventory: true,
    inventory_view_costs: true,
    customers: true,
    finance: true,
    comprobantes: true,
    reports: true,
    settings: true,
    settings_sensitive: true,
    subscription: false,
    users: true,
    wholesale: true,
    personal_finance: false,
  },
  manager: {
    orders: true,
    orders_change_status: true,
    orders_view_financials: true,
    inventory: true,
    inventory_view_costs: true,
    customers: true,
    finance: false,
    comprobantes: true,
    reports: true,
    settings: false,
    settings_sensitive: false,
    subscription: false,
    users: false,
    wholesale: true,
    personal_finance: false,
  },
  tech: {
    orders: true,
    orders_change_status: true,
    orders_view_financials: false,
    inventory: false,
    inventory_view_costs: false,
    customers: false,
    finance: false,
    comprobantes: false,
    reports: false,
    settings: false,
    settings_sensitive: false,
    subscription: false,
    users: false,
    // P0-P6: el técnico es el rol más acotado. Sin mayorista, sin finanzas,
    // sin costos y sin Mi Guita por defecto.
    wholesale: false,
    personal_finance: false,
  },
  sales: {
    orders: true,
    orders_change_status: true,
    orders_view_financials: true,
    inventory: true,
    inventory_view_costs: false,
    customers: true,
    finance: false,
    comprobantes: true,
    reports: false,
    settings: false,
    settings_sensitive: false,
    subscription: false,
    users: false,
    wholesale: true,
    personal_finance: false,
  },
  cashier: {
    orders: true,
    orders_change_status: false,
    orders_view_financials: true,
    inventory: false,
    inventory_view_costs: false,
    customers: true,
    finance: true,
    comprobantes: true,
    reports: true,
    settings: false,
    settings_sensitive: false,
    subscription: false,
    users: false,
    // Cashier opera caja, no vende mayorista.
    wholesale: false,
    personal_finance: false,
  },
  viewer: {
    orders: true,
    orders_change_status: false,
    orders_view_financials: false,
    inventory: false,
    inventory_view_costs: false,
    customers: false,
    finance: false,
    comprobantes: false,
    reports: false,
    settings: false,
    settings_sensitive: false,
    subscription: false,
    users: false,
    wholesale: false,
    personal_finance: false,
  },
}

/**
 * Resolve final permissions for a user:
 * Start with role defaults, then apply any custom overrides stored in profile.permissions.
 */
export function resolvePermissions(
  role: string,
  customPermissions?: Partial<AppPermissions> | null
): AppPermissions {
  const defaults = ROLE_DEFAULT_PERMISSIONS[role]
  if (!defaults) {
    // Rol desconocido — aplicar permisos mínimos y advertir en desarrollo.
    // `import.meta.env` sólo lo inyecta Vite: fuera del bundler (p. ej. los
    // tests unitarios con `node --test`) es undefined, y este aviso de DEV no
    // debe tumbar una resolución de permisos que por lo demás es pura.
    if (import.meta.env?.DEV) {
      console.warn(`[permissions] Rol desconocido: "${role}". Aplicando permisos de viewer.`)
    }
    return { ...ROLE_DEFAULT_PERMISSIONS['viewer'] }
  }
  if (!customPermissions) return { ...defaults }
  return { ...defaults, ...customPermissions }
}
