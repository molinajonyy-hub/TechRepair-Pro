import {
  BadgeCheck, Building2, ChevronRight, Coins, CreditCard, FileText, MapPin, MessageCircle, Percent,
  Printer, Server, Shield, SlidersHorizontal, Users, type LucideIcon,
} from 'lucide-react'
import type { PermissionKey } from '../../config/permissions'

/**
 * BETA-UX-2 — navegación de Configuración por grupos.
 *
 * Antes: diez pestañas seguidas en una fila que envolvía en dos o tres líneas,
 * sin agrupación y con íconos repetidos o equivocados (un escudo para «Cobros
 * y Pagos», una campana para «Comisiones»). Ahora las secciones se agrupan por
 * tarea y se presentan como lista:
 *
 *   · ≥1024px: columna lateral fija y la sección elegida a la derecha.
 *   · <1024px: lista agrupada (como Ajustes de iOS). Tocar una sección la abre
 *     a pantalla completa con «‹ Configuración» para volver.
 *
 * El corte lo decide el CSS (`.settings-layout[data-view]`); este componente
 * sólo dibuja la lista. La sección elegida vive en la URL (`?tab=`): los
 * enlaces que ya existían (`?tab=arca`, `?tab=pagos`, `?tab=whatsapp`) siguen
 * abriendo directo la sección.
 *
 * BETA-UX-3 — Usuarios, Moneda y Suscripción dejan de ser entradas sueltas del
 * menú lateral y pasan a esta lista. Son PANTALLAS que ya existían, con su ruta
 * y su guard (`/users`, `/currency-settings`, `/subscription`): no se mudan a
 * `?tab=`, se dibujan dentro del mismo marco (`SettingsShell`). Así los enlaces
 * directos, los guards por capacidad y las excepciones de `SubscriptionGuard`
 * (que exime `/subscription` y `/settings`, no `/users`) quedan como estaban.
 *
 * Cada sección declara la capacidad que exige su destino y la lista sólo
 * muestra las que el actor puede abrir. Es presentación: la autoridad sigue
 * siendo el guard de la ruta y, del lado del servidor, RLS + capacidades.
 */

/** Secciones de `/settings?tab=` — las diez de BETA-UX-2, con las mismas claves. */
export type SettingsSection =
  | 'datos' | 'preferencias' | 'seguridad'
  | 'puntos' | 'arca'
  | 'pagos' | 'comisiones'
  | 'orden' | 'comprobante' | 'whatsapp'

/** BETA-UX-3 — Secciones que son una pantalla existente con ruta propia. */
export type SettingsPageSection = 'moneda' | 'usuarios' | 'suscripcion'

/** Cualquier entrada de la navegación de Configuración. */
export type SettingsNavId = SettingsSection | SettingsPageSection

/** La ruta de cada pantalla que vive dentro de Configuración. No cambia. */
export const SETTINGS_PAGE_PATHS: Record<SettingsPageSection, string> = {
  moneda: '/currency-settings',
  usuarios: '/users',
  suscripcion: '/subscription',
}

interface SectionDef {
  id: SettingsNavId
  label: string
  icon: LucideIcon
  /** La MISMA capacidad que exige el guard de su ruta en App.tsx. */
  permission: PermissionKey
}
interface GroupDef { id: string; label: string; sections: SectionDef[] }

export const SETTINGS_GROUPS: GroupDef[] = [
  {
    id: 'negocio', label: 'Negocio', sections: [
      { id: 'datos', label: 'Datos del negocio', icon: Building2, permission: 'settings' },
      { id: 'preferencias', label: 'Preferencias', icon: SlidersHorizontal, permission: 'settings' },
      // Antes «Moneda» en el menú lateral. Es preferencia monetaria del
      // negocio (moneda y cotización del dólar), no una sección financiera.
      { id: 'moneda', label: 'Moneda y cotización', icon: Coins, permission: 'settings' },
      { id: 'seguridad', label: 'Seguridad', icon: Shield, permission: 'settings' },
    ],
  },
  {
    id: 'equipo', label: 'Equipo', sections: [
      // Antes «Usuarios» en el menú lateral: invitaciones, roles y permisos.
      { id: 'usuarios', label: 'Usuarios y permisos', icon: Users, permission: 'users' },
    ],
  },
  {
    id: 'facturacion', label: 'Facturación', sections: [
      { id: 'puntos', label: 'Puntos de venta', icon: MapPin, permission: 'settings' },
      { id: 'arca', label: 'Integración ARCA', icon: Server, permission: 'settings' },
    ],
  },
  {
    id: 'cobros', label: 'Cobros', sections: [
      { id: 'pagos', label: 'Cobros y pagos', icon: CreditCard, permission: 'settings' },
      // La sección también tiene el interruptor del módulo Mayorista: con
      // «Comisiones» a secas nadie lo encontraba.
      { id: 'comisiones', label: 'Comisiones y mayorista', icon: Percent, permission: 'settings' },
    ],
  },
  {
    id: 'documentos', label: 'Documentos y mensajes', sections: [
      { id: 'orden', label: 'Orden impresa', icon: Printer, permission: 'settings' },
      { id: 'comprobante', label: 'Comprobantes', icon: FileText, permission: 'settings' },
      { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle, permission: 'settings' },
    ],
  },
  {
    // Antes «Suscripción» en el menú lateral. Es el plan y el pago de
    // TechRepair Pro, NO la facturación del negocio (ARCA vive en «Facturación»):
    // por eso el grupo se llama como el producto.
    id: 'techrepair', label: 'TechRepair Pro', sections: [
      { id: 'suscripcion', label: 'Plan y suscripción', icon: BadgeCheck, permission: 'subscription' },
    ],
  },
]

const PAGE_SECTION_IDS = Object.keys(SETTINGS_PAGE_PATHS) as SettingsPageSection[]

export function isSettingsPageSection(id: SettingsNavId): id is SettingsPageSection {
  return (PAGE_SECTION_IDS as string[]).includes(id)
}

/** Las secciones de `?tab=` (sin las pantallas con ruta propia). */
export const SETTINGS_SECTIONS: SettingsSection[] = SETTINGS_GROUPS
  .flatMap(g => g.sections.map(s => s.id))
  .filter((id): id is SettingsSection => !isSettingsPageSection(id))

/**
 * Las capacidades que abren ALGUNA sección de Configuración. Es la puerta del
 * ítem «Configuración» del menú y del guard de `/settings`: con cualquiera de
 * ellas hay algo que mostrar.
 */
export const SETTINGS_PERMISSIONS: PermissionKey[] = [
  ...new Set(SETTINGS_GROUPS.flatMap(g => g.sections.map(s => s.permission))),
]

/**
 * Rutas que se dibujan dentro de Configuración: el ítem del menú queda marcado
 * en cualquiera de ellas (y en sus subrutas, como `/subscription/plans`).
 */
export const SETTINGS_ROUTE_PATHS: string[] = ['/settings', ...Object.values(SETTINGS_PAGE_PATHS)]

export function isSettingsSection(value: string | null): value is SettingsSection {
  return value !== null && (SETTINGS_SECTIONS as string[]).includes(value)
}

export function settingsSectionLabel(id: SettingsNavId): string {
  for (const group of SETTINGS_GROUPS) {
    const section = group.sections.find(s => s.id === id)
    if (section) return section.label
  }
  return id
}

/** Destino de una sección: su ruta propia o `/settings?tab=`. */
export function settingsSectionHref(id: SettingsNavId): string {
  return isSettingsPageSection(id) ? SETTINGS_PAGE_PATHS[id] : `/settings?tab=${id}`
}

/** Los grupos con sólo las secciones que el actor puede abrir; sin grupos vacíos. */
export function visibleSettingsGroups(can: (permission: PermissionKey) => boolean): GroupDef[] {
  return SETTINGS_GROUPS
    .map(group => ({ ...group, sections: group.sections.filter(section => can(section.permission)) }))
    .filter(group => group.sections.length > 0)
}

interface SettingsNavProps {
  /** La sección que se está viendo; `null` cuando no hay ninguna (sólo la lista). */
  active: SettingsNavId | null
  onSelect: (section: SettingsNavId) => void
  /** Capacidades efectivas del actor (`usePermissions().can`). */
  can: (permission: PermissionKey) => boolean
}

export function SettingsNav({ active, onSelect, can }: SettingsNavProps) {
  return (
    <nav className="settings-nav" aria-label="Secciones de configuración" data-testid="settings-nav">
      {visibleSettingsGroups(can).map(group => (
        <div key={group.id} className="settings-nav__group">
          <p className="settings-nav__group-label" id={`settings-group-${group.id}`}>{group.label}</p>
          <ul className="settings-nav__list" aria-labelledby={`settings-group-${group.id}`}>
            {group.sections.map(section => {
              const Icon = section.icon
              const isActive = section.id === active
              return (
                <li key={section.id}>
                  <button
                    type="button"
                    className={`settings-nav__item${isActive ? ' is-active' : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                    data-testid={`settings-nav-${section.id}`}
                    onClick={() => onSelect(section.id)}
                  >
                    <span className="settings-nav__icon"><Icon size={18} aria-hidden /></span>
                    <span className="settings-nav__label">{section.label}</span>
                    <ChevronRight size={16} className="settings-nav__chevron" aria-hidden="true" />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
