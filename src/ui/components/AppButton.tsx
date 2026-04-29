import { forwardRef } from 'react'
import { Loader2 } from 'lucide-react'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type ButtonVariant =
  | 'primary'    // gradiente índigo→cyan  — crear, guardar, confirmar
  | 'indigo'     // índigo sólido          — acción principal alternativa
  | 'secondary'  // outline oscuro         — cancelar, volver, secundarias
  | 'ghost'      // sin fondo              — acciones icon dentro de tablas
  | 'green'      // verde sólido           — cobrar, confirmar pago, completar
  | 'danger'     // rojo outline           — eliminar, anular
  | 'red'        // rojo sólido            — acción destructiva destacada
  | 'warning'    // ámbar outline          — advertencia
  | 'amber'      // ámbar sólido           — nueva orden, alertas
  | 'success'    // verde outline          — marcar completado
  | 'cyan'       // cyan sólido            — acción rápida secundaria

export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

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
