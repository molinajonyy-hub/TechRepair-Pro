import { forwardRef } from 'react'
import { Loader2 } from 'lucide-react'

// ─── Tipos ────────────────────────────────────────────────────────────────────

// BUTTON-SYSTEM-1A — los botones no llevan gradientes y la jerarquía la da la
// semántica, no el color. El contrato está en index.css («BOTONES»).
export type ButtonVariant =
  | 'primary'    // índigo sólido          — crear, guardar, confirmar
  | 'indigo'     // ALIAS de `primary`     — sin diferencia visual; no usar en código nuevo
  | 'secondary'  // neutro con borde       — cancelar, volver, secundarias
  | 'ghost'      // sin fondo              — baja jerarquía, acciones de ícono
  | 'green'      // verde sólido           — cobrar, confirmar pago, completar
  | 'danger'     // rojo suave             — eliminar, anular, registrar un gasto
  | 'red'        // rojo sólido            — acción destructiva destacada
  | 'warning'    // ámbar outline          — advertencia
  | 'amber'      // ámbar sólido           — alertas
  | 'success'    // verde suave            — marcar completado
  | 'cyan'       // cyan sólido            — acción rápida secundaria

// El tamaño es por categoría. `page` es la acción de un encabezado de página o
// de un bloque protagonista (44px, `.btn-page-action`): el mismo en todas las
// pantallas. `xs` / `sm` siguen para tablas, menús y controles compactos.
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'page'

export interface AppButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
  loading?: boolean
  fullWidth?: boolean
  as?: 'button' | 'a'
  href?: string
}

// ─── Mapas CSS ────────────────────────────────────────────────────────────────

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:   'btn-primary',
  indigo:    'btn-fill-indigo',
  secondary: 'btn-secondary',
  ghost:     'btn-ghost',
  green:     'btn-green',
  danger:    'btn-danger',
  red:       'btn-red',
  warning:   'btn-amber',
  amber:     'btn-amber',
  success:   'btn-success',
  cyan:      'btn-cyan',
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'btn-xs',
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg',
  xl: 'btn-xl',
  page: 'btn-page-action',
}

// ─── Componente ───────────────────────────────────────────────────────────────

export const AppButton = forwardRef<HTMLButtonElement, AppButtonProps>(({
  variant = 'secondary',
  size = 'md',
  leftIcon,
  rightIcon,
  loading = false,
  fullWidth = false,
  children,
  className = '',
  disabled,
  type = 'button',
  ...props
}, ref) => {
  const cls = [
    'btn',
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    fullWidth ? 'btn-full' : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      disabled={disabled || loading}
      {...props}
    >
      {loading
        ? <Loader2 size={size === 'sm' || size === 'xs' ? 14 : 16} className="animate-spin" />
        : leftIcon
      }
      {children}
      {!loading && rightIcon}
    </button>
  )
})

AppButton.displayName = 'AppButton'

// ─── IconButton ────────────────────────────────────────────────────────────────

export interface AppIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode
  label: string          // requerido para accesibilidad y tooltip
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

export function AppIconButton({
  icon, label, variant = 'ghost', size = 'sm',
  loading = false, className = '', disabled, ...props
}: AppIconButtonProps) {
  const cls = [
    'btn',
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    'btn-icon',
    className,
  ].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      className={cls}
      disabled={disabled || loading}
      title={label}
      aria-label={label}
      {...props}
      style={{ padding: size === 'xs' ? '0.25rem' : '0.35rem', aspectRatio: '1', ...props.style }}
    >
      {loading
        ? <Loader2 size={size === 'xs' ? 12 : 14} className="animate-spin" />
        : icon
      }
    </button>
  )
}
