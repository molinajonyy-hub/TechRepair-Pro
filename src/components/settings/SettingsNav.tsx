import {
  Building2, ChevronRight, CreditCard, FileText, MapPin, MessageCircle, Percent,
  Printer, Server, Shield, SlidersHorizontal, type LucideIcon,
} from 'lucide-react'

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
 */

export type SettingsSection =
  | 'datos' | 'preferencias' | 'seguridad'
  | 'puntos' | 'arca'
  | 'pagos' | 'comisiones'
  | 'orden' | 'comprobante' | 'whatsapp'

interface SectionDef { id: SettingsSection; label: string; icon: LucideIcon }
interface GroupDef { id: string; label: string; sections: SectionDef[] }

export const SETTINGS_GROUPS: GroupDef[] = [
  {
    id: 'negocio', label: 'Negocio', sections: [
      { id: 'datos', label: 'Datos del negocio', icon: Building2 },
      { id: 'preferencias', label: 'Preferencias', icon: SlidersHorizontal },
      { id: 'seguridad', label: 'Seguridad', icon: Shield },
    ],
  },
  {
    id: 'facturacion', label: 'Facturación', sections: [
      { id: 'puntos', label: 'Puntos de venta', icon: MapPin },
      { id: 'arca', label: 'Integración ARCA', icon: Server },
    ],
  },
  {
    id: 'cobros', label: 'Cobros', sections: [
      { id: 'pagos', label: 'Cobros y pagos', icon: CreditCard },
      // La sección también tiene el interruptor del módulo Mayorista: con
      // «Comisiones» a secas nadie lo encontraba.
      { id: 'comisiones', label: 'Comisiones y mayorista', icon: Percent },
    ],
  },
  {
    id: 'documentos', label: 'Documentos y mensajes', sections: [
      { id: 'orden', label: 'Orden impresa', icon: Printer },
      { id: 'comprobante', label: 'Comprobantes', icon: FileText },
      { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
    ],
  },
]

export const SETTINGS_SECTIONS: SettingsSection[] = SETTINGS_GROUPS.flatMap(g => g.sections.map(s => s.id))

export function isSettingsSection(value: string | null): value is SettingsSection {
  return value !== null && (SETTINGS_SECTIONS as string[]).includes(value)
}

export function settingsSectionLabel(id: SettingsSection): string {
  for (const group of SETTINGS_GROUPS) {
    const section = group.sections.find(s => s.id === id)
    if (section) return section.label
  }
  return id
}

interface SettingsNavProps {
  active: SettingsSection
  onSelect: (section: SettingsSection) => void
}

export function SettingsNav({ active, onSelect }: SettingsNavProps) {
  return (
    <nav className="settings-nav" aria-label="Secciones de configuración" data-testid="settings-nav">
      {SETTINGS_GROUPS.map(group => (
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
