import { Suspense, useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ChevronLeft, Loader2, Settings as SettingsIcon } from 'lucide-react'
import { AppPageHeader } from '../../ui'
import { usePermissions } from '../../hooks/usePermissions'
import {
  SettingsNav, isSettingsPageSection, settingsSectionHref, settingsSectionLabel,
  type SettingsNavId, type SettingsPageSection, type SettingsSection,
} from './SettingsNav'

/**
 * BETA-UX-3 — el marco de Configuración: encabezado, navegación agrupada y la
 * sección a la derecha (o, por debajo de 1024px, lista → sección).
 *
 * Antes vivía escrito dentro de `Settings.tsx`. Ahora lo comparten las diez
 * secciones de `/settings?tab=` y las pantallas que salieron del menú lateral
 * (Usuarios, Moneda, Suscripción), que siguen en su ruta y con su guard: el
 * marco sólo cambia DÓNDE se dibujan, no quién entra.
 */

/**
 * Marca de `location.state` al navegar desde la lista: a dónde va el foco al
 * llegar. Celular: a la sección (la lista desaparece). Escritorio: a la sección
 * elegida de la lista, que se volvió a montar con la ruta nueva; sin esto el
 * foco del teclado caía al `<body>`.
 */
const FOCUS_STATE_KEY = 'settingsFocus'
type ArrivalFocus = 'content' | 'nav'
const MOBILE_QUERY = '(max-width: 1023px)'

const isMobileShell = () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches

interface SettingsBodyProps {
  /** La sección que se está viendo; `null` = ninguna (sólo la lista). */
  active: SettingsNavId | null
  /**
   * Cómo abrir una sección de `?tab=` cuando ya se está en `/settings` (lo
   * resuelve Settings, que maneja la URL y el foco). Sin esto, se navega.
   */
  onSelectTab?: (tab: SettingsSection) => void
  /** «‹ Secciones» del celular. Sin esto, vuelve a la lista (`/settings`). */
  onBack?: () => void
  contentRef?: RefObject<HTMLDivElement>
  children?: ReactNode
}

interface SettingsFrameProps {
  /** Por debajo de 1024px: `list` muestra la lista; `section`, la sección a pantalla completa. */
  view: 'list' | 'section'
  children?: ReactNode
}

/** El contenedor y el encabezado. Lo que va debajo del cuerpo (modales, versión) va adentro. */
export function SettingsFrame({ view, children }: SettingsFrameProps) {
  return (
    <div className="settings-page" data-view={view}>
      <AppPageHeader
        icon={<SettingsIcon size={24} />}
        title="Configuración"
        description="Negocio, equipo, facturación, cobros y documentos"
      />
      {/* Fragmento fijo: Settings pasa UN hijo mientras carga y varios después.
          Sin él, React anida el arreglo en un fragmento implícito, ve otro
          tipo en esa posición y vuelve a montar la navegación. */}
      <>{children}</>
    </div>
  )
}

/**
 * Navegación agrupada + la sección. `data-view` (en `.settings-page`) decide
 * qué se ve en el shell mobile: la lista o la sección. En escritorio, las dos.
 */
export function SettingsBody({ active, onSelectTab, onBack, contentRef, children }: SettingsBodyProps) {
  const { can } = usePermissions()
  const navigate = useNavigate()
  const location = useLocation()
  const layoutRef = useRef<HTMLDivElement>(null)
  const ownContentRef = useRef<HTMLDivElement>(null)
  const regionRef = contentRef ?? ownContentRef
  const label = active ? settingsSectionLabel(active) : 'Configuración'

  // Llegar a una sección desde la lista del celular reemplaza la lista: el foco
  // va al contenido para que el lector de pantalla no quede en un botón que ya
  // no está. (Dentro de `/settings` lo hace Settings; esto cubre el cambio de
  // ruta.) Se mira una sola vez, al montar: es la llegada, no cada render.
  const arrival = useRef({
    focus: (location.state as Record<string, unknown> | null)?.[FOCUS_STATE_KEY] as ArrivalFocus | undefined,
    hasSection: active !== null,
  })
  useEffect(() => {
    const { focus, hasSection } = arrival.current
    if (!focus || !hasSection) return
    if (focus === 'content' && isMobileShell()) regionRef.current?.focus()
    if (focus === 'nav') layoutRef.current?.querySelector<HTMLElement>('.settings-nav__item[aria-current="page"]')?.focus()
  }, [regionRef])

  const select = (id: SettingsNavId) => {
    if (!isSettingsPageSection(id) && onSelectTab) {
      onSelectTab(id)
      return
    }
    if (id === active) return
    const focus: ArrivalFocus = isMobileShell() ? 'content' : 'nav'
    navigate(settingsSectionHref(id), { state: { [FOCUS_STATE_KEY]: focus } })
  }

  const back = onBack ?? (() => navigate('/settings'))

  return (
    <div className="settings-layout" ref={layoutRef}>
      <SettingsNav active={active} onSelect={select} can={can} />

      <div
        ref={regionRef}
        className="settings-content"
        tabIndex={-1}
        role="region"
        aria-label={label}
        data-testid="settings-content"
      >
        <div className="settings-content__bar">
          <button type="button" className="btn btn-ghost settings-back" onClick={back} data-testid="settings-back">
            <ChevronLeft size={18} aria-hidden="true" /> Secciones
          </button>
          <span className="settings-content__current">{label}</span>
        </div>

        {children}
      </div>
    </div>
  )
}

/** Marco completo: lo usan las pantallas con ruta propia y `/settings` sin la capacidad `settings`. */
export function SettingsShell({ view, children, ...body }: SettingsBodyProps & SettingsFrameProps) {
  return (
    <SettingsFrame view={view}>
      <SettingsBody {...body}>{children}</SettingsBody>
    </SettingsFrame>
  )
}

/** Mientras carga una sección, el marco (y su navegación) quedan quietos. */
export function SettingsSectionLoading() {
  return (
    <div className="settings-loading" role="status" data-testid="settings-section-loading">
      <Loader2 size={22} className="settings-loading__spinner" aria-hidden="true" />
      Cargando configuración...
    </div>
  )
}

/**
 * Elemento de ruta para las pantallas que viven dentro de Configuración. Va
 * DEBAJO de su guard de capacidad (`ProtectedRouteByPermission`): si el actor
 * no entra, rebota antes de dibujar el marco.
 */
export function SettingsPageRoute({ section }: { section: SettingsPageSection }) {
  return (
    <SettingsShell active={section} view="section">
      <Suspense fallback={<SettingsSectionLoading />}>
        <Outlet />
      </Suspense>
    </SettingsShell>
  )
}
