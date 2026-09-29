/**
 * PRE-BETA-3A-0 — Aviso de «permiso denegado».
 *
 * `ProtectedRouteByPermission` rebota a /dashboard con
 * `state.deniedPermission` desde P0-P6, pero nadie lo leía: el usuario tocaba
 * un acceso, volvía a Inicio y no sabía por qué. Este aviso cierra ese rebote
 * silencioso.
 *
 * Contrato:
 *  - Sólo se muestra si `deniedPermission` es una capacidad CONOCIDA
 *    (`ALL_PERMISSIONS`). Cualquier otro valor en el state se ignora.
 *  - El nombre visible sale de `PERMISSION_LABELS` (la misma fuente que la
 *    matriz de permisos). Nunca la clave interna ni detalles técnicos.
 *  - No bloquea: es un `role="status"` descartable.
 *  - Descartarlo limpia SÓLO `deniedPermission` del state con `replace`, así
 *    que no agrega una entrada al historial ni vuelve a disparar el aviso.
 *
 * No es seguridad: la autoridad sigue siendo RLS + current_user_can(). Esto
 * sólo explica un rebote que ya ocurrió.
 */
import { useLocation, useNavigate } from 'react-router-dom'
import { Lock, X } from 'lucide-react'
import {
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
  type PermissionKey,
} from '../../config/permissions'
import { colors, radius } from '../../lib/tokens'

/**
 * Capacidades cuyo módulo no se nombra: Mi Guita está oculto para la beta y
 * el aviso no puede ser la vía por la que aparezca.
 */
const UNNAMED_MODULES: ReadonlySet<PermissionKey> = new Set<PermissionKey>(['personal_finance'])

/** Lee `deniedPermission` del state del router y lo valida contra el catálogo. */
export function readDeniedPermission(state: unknown): PermissionKey | null {
  if (!state || typeof state !== 'object') return null
  const raw = (state as Record<string, unknown>).deniedPermission
  if (typeof raw !== 'string') return null
  return (ALL_PERMISSIONS as readonly string[]).includes(raw) ? (raw as PermissionKey) : null
}

/** Texto humano del aviso. Exportado para testearlo sin montar el router. */
export function permissionNoticeMessage(permission: PermissionKey): string {
  const modulo = UNNAMED_MODULES.has(permission)
    ? 'esta sección'
    : PERMISSION_LABELS[permission].label
  return `No tenés permiso para entrar a ${modulo}. Pedíselo al dueño del negocio.`
}

export function PermissionNotice() {
  const location = useLocation()
  const navigate = useNavigate()
  const denied = readDeniedPermission(location.state)

  if (!denied) return null

  const dismiss = () => {
    // Se conserva el resto del state (p. ej. `from`) y se quita sólo la marca.
    const { deniedPermission: _descartado, ...resto } = location.state as Record<string, unknown>
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: Object.keys(resto).length > 0 ? resto : null },
    )
  }

  return (
    <div
      role="status"
      data-testid="permission-notice"
      className="alert-inline"
      style={{
        alignItems: 'center',
        marginBottom: '1rem',
        background: colors.warningBg,
        border: `1px solid ${colors.warningBorder}`,
        borderRadius: radius.md,
        color: colors.text.primary,
        fontSize: '0.875rem',
      }}
    >
      <Lock size={16} aria-hidden="true" style={{ color: colors.warning, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>{permissionNoticeMessage(denied)}</span>
      <button
        type="button"
        className="icon-btn"
        onClick={dismiss}
        aria-label="Cerrar aviso de permiso"
        data-testid="permission-notice-close"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
