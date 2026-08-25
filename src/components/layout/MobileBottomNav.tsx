import { ClipboardList, Home, ListTodo, MoreHorizontal, ReceiptText, Users, WalletCards } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import type { NavigationAccess } from '../../hooks/useNavigationAccess'
import { useSidebar } from '../../hooks/useSidebar'
import {
  resolveMobilePrimaryNavigation,
  type MobileDestinationKey,
} from '../../config/mobileNavigation'

const ICONS: Record<MobileDestinationKey, typeof Home> = {
  home: Home,
  orders: ClipboardList,
  pos: ReceiptText,
  customers: Users,
  tasks: ListTodo,
  cash: WalletCards,
  more: MoreHorizontal,
}

interface MobileBottomNavProps {
  access: NavigationAccess
}

export function MobileBottomNav({ access }: MobileBottomNavProps) {
  const { isMobileOpen, toggleMobileSidebar } = useSidebar()
  const destinations = resolveMobilePrimaryNavigation(access)

  return (
    <nav
      className="mobile-bottom-nav"
      data-testid="mobile-bottom-nav"
      aria-label="Navegación principal"
    >
      <div className="mobile-bottom-nav__items">
        {destinations.map(destination => {
          const Icon = ICONS[destination.key]

          if (!destination.path) {
            return (
              <button
                key={destination.key}
                type="button"
                className={`mobile-bottom-nav__item${isMobileOpen ? ' is-active' : ''}`}
                aria-label="Abrir más módulos"
                aria-expanded={isMobileOpen}
                aria-controls="mobile-more-drawer"
                onClick={toggleMobileSidebar}
              >
                <Icon aria-hidden="true" />
                <span>{destination.label}</span>
              </button>
            )
          }

          return (
            <NavLink
              key={destination.key}
              to={destination.path}
              end={destination.key === 'home'}
              className={({ isActive }) => `mobile-bottom-nav__item${isActive ? ' is-active' : ''}`}
            >
              <Icon aria-hidden="true" />
              <span>{destination.label}</span>
            </NavLink>
          )
        })}
      </div>
    </nav>
  )
}
