// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1G — Campos, alertas y selector de modo del embudo de acceso.
//
// /login, /reset-password y /accept-invite tenían tres versiones del mismo
// campo: estilos inline con colores fijos, el foco pintado desde JavaScript, el
// «ojo» de la contraseña de 17 px y, según la pantalla, con o sin `aria-invalid`
// y con o sin el mensaje asociado al control. Acá vive UNA.
//
// Igual que AuthFlowShell, es PRESENTACIONAL: no sabe de sesión, de errores del
// servidor ni de reglas de contraseña. Recibe valores y textos ya resueltos.
//
// No define un sistema visual propio:
//   · el control es `.form-control` (alto, radio, foco, hover, disabled, 16 px
//     en mobile);
//   · el error es `.form-error`; el borde de error va por la clase
//     `.border-error` (un `borderColor` inline lo pisa el remapeo del tema claro);
//   · la alerta es `.alert` + `.alert-*`;
//   · `src/css/auth-flow.css` sólo compone layout con los tokens de index.css.
//
// El ícono y el botón del campo NO usan `.input-group`: Bootstrap entra por CDN
// y define esa misma clase como un grupo flex (MEDIDO: le saca el radio al
// control, lo deja `position: relative` por encima del ícono y, con el foco,
// también por encima del botón de mostrar la contraseña).
// ─────────────────────────────────────────────────────────────────────────────
import {
  forwardRef, useId, useState,
  type FocusEvent, type InputHTMLAttributes, type KeyboardEvent, type ReactNode,
} from 'react'
import { AlertTriangle, Check, CheckCircle2, Circle, CircleAlert, Eye, EyeOff, Info } from 'lucide-react'

/**
 * `true` si el foco salió del campo. `false` si sólo pasó a un control del mismo
 * campo (el botón de mostrar la contraseña): ahí no corresponde validar todavía.
 */
export function focusLeftField(event: FocusEvent<HTMLInputElement>): boolean {
  const destino = event.relatedTarget
  const campo = event.currentTarget.parentElement
  return !(destino instanceof Node && campo?.contains(destino))
}

// ── Campo de texto ───────────────────────────────────────────────────────────

export interface AuthFlowTextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'> {
  /** Id del control. De él salen los ids del error (`-error`) y de la ayuda (`-hint`). */
  id: string
  label: string
  /** Mensaje de validación. Con valor, el control queda `aria-invalid` y descrito por él. */
  error?: string
  /** Ayuda permanente bajo el control. La reemplaza el error cuando lo hay. */
  hint?: ReactNode
  optional?: boolean
  /** Ícono decorativo a la izquierda. */
  icon?: ReactNode
  /** Control a la derecha, dentro del campo (el «ojo» de la contraseña). */
  trailing?: ReactNode
  /** `data-testid` del mensaje de error. */
  errorTestId?: string
}

export const AuthFlowTextField = forwardRef<HTMLInputElement, AuthFlowTextFieldProps>(({
  id, label, error, hint, optional, icon, trailing, errorTestId, ...input
}, ref) => {
  const descripcion = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  const clases = ['auth-flow__control', icon ? 'auth-flow__control--icon' : '', trailing ? 'auth-flow__control--trailing' : '']
    .filter(Boolean).join(' ')

  return (
    <div className="auth-flow__field">
      <label htmlFor={id} className="auth-flow__label">
        {label}
        {optional && <span className="auth-flow__optional"> (opcional)</span>}
      </label>
      <div className={clases}>
        {icon && <span className="auth-flow__control-icon" aria-hidden="true">{icon}</span>}
        <input
          {...input}
          ref={ref}
          id={id}
          className={`form-control${error ? ' border-error' : ''}`}
          aria-invalid={Boolean(error)}
          aria-describedby={descripcion}
        />
        {trailing}
      </div>
      {error
        ? <p id={`${id}-error`} className="form-error auth-flow__field-error" data-testid={errorTestId}>{error}</p>
        : hint ? <p id={`${id}-hint`} className="auth-flow__hint">{hint}</p> : null}
    </div>
  )
})
AuthFlowTextField.displayName = 'AuthFlowTextField'

// ── Campo de contraseña ──────────────────────────────────────────────────────

export interface AuthFlowPasswordFieldProps extends Omit<AuthFlowTextFieldProps, 'type' | 'trailing'> {
  /** `data-testid` del botón de mostrar/ocultar. */
  toggleTestId?: string
}

/**
 * Contraseña con mostrar/ocultar. El botón es un interruptor: el nombre no
 * cambia y el estado lo lleva `aria-pressed`. Área de 44 px, alcanzable con Tab.
 */
export const AuthFlowPasswordField = forwardRef<HTMLInputElement, AuthFlowPasswordFieldProps>(({
  toggleTestId, disabled, ...field
}, ref) => {
  const [visible, setVisible] = useState(false)

  return (
    <AuthFlowTextField
      {...field}
      ref={ref}
      disabled={disabled}
      type={visible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          className="auth-flow__reveal"
          onClick={() => setVisible(v => !v)}
          disabled={disabled}
          aria-label="Mostrar contraseña"
          aria-pressed={visible}
          title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          data-testid={toggleTestId}
        >
          {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
        </button>
      }
    />
  )
})
AuthFlowPasswordField.displayName = 'AuthFlowPasswordField'

// ── Requisito de un campo ────────────────────────────────────────────────────

/**
 * Requisito que se va cumpliendo mientras se escribe. Va como `hint` del campo.
 * El estado no depende sólo del color: cambia el ícono.
 */
export function AuthFlowRequirement({ met, children }: { met: boolean; children: ReactNode }) {
  return (
    <span className="auth-flow__requirement" data-met={met}>
      {met ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : <Circle size={13} aria-hidden="true" />}
      {children}
      {met && <span className="sr-only"> (cumplido)</span>}
    </span>
  )
}

// ── Alerta ───────────────────────────────────────────────────────────────────

export type AuthFlowAlertTone = 'error' | 'success' | 'warning' | 'info'

const ICONO_ALERTA: Record<AuthFlowAlertTone, ReactNode> = {
  error: <CircleAlert aria-hidden="true" />,
  success: <CheckCircle2 aria-hidden="true" />,
  warning: <AlertTriangle aria-hidden="true" />,
  info: <Info aria-hidden="true" />,
}

export interface AuthFlowAlertProps {
  tone: AuthFlowAlertTone
  children: ReactNode
  testId?: string
  /**
   * Por defecto un error interrumpe (`alert`) y lo demás se anuncia sin
   * interrumpir (`status`). `note` es para contexto que ya está al cargar.
   */
  role?: 'alert' | 'status' | 'note'
  /** Reemplaza el ícono del tono. */
  icon?: ReactNode
}

/**
 * Mensaje de la pantalla (no de un campo). El tono no depende sólo del color:
 * lleva ícono, y el texto usa el color primario para llegar a AA en los dos
 * temas (los `--success` / `--error` del tema claro no llegan como texto).
 */
export function AuthFlowAlert({ tone, children, testId, role, icon }: AuthFlowAlertProps) {
  return (
    <div
      className={`alert alert-${tone} auth-flow__alert`}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      data-testid={testId}
      data-tone={tone}
    >
      {icon ?? ICONO_ALERTA[tone]}
      <div className="auth-flow__alert-body">{children}</div>
    </div>
  )
}

// ── Selector de modo ─────────────────────────────────────────────────────────

export interface AuthFlowSegment<T extends string> {
  id: T
  label: string
  testId?: string
}

export interface AuthFlowSegmentedProps<T extends string> {
  /** Nombre accesible del grupo. */
  label: string
  options: readonly AuthFlowSegment<T>[]
  value: T
  onChange: (id: T) => void
  disabled?: boolean
  /** Id del panel que cambia con la selección (`aria-controls`). */
  panelId?: string
}

/**
 * Dos o tres modos de una misma pantalla. Es un `tablist`: una sola parada de
 * Tab, y las flechas (y Inicio / Fin) cambian de opción.
 */
export function AuthFlowSegmented<T extends string>({
  label, options, value, onChange, disabled, panelId,
}: AuthFlowSegmentedProps<T>) {
  const base = useId()

  const mover = (e: KeyboardEvent<HTMLDivElement>) => {
    const actual = options.findIndex(o => o.id === value)
    const destino =
      e.key === 'ArrowRight' ? (actual + 1) % options.length
      : e.key === 'ArrowLeft' ? (actual - 1 + options.length) % options.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? options.length - 1
      : -1
    if (destino < 0 || destino === actual) return
    e.preventDefault()
    onChange(options[destino].id)
    document.getElementById(`${base}-${options[destino].id}`)?.focus()
  }

  return (
    <div className="auth-flow__segmented" role="tablist" aria-label={label} onKeyDown={mover}>
      {options.map(o => {
        const selected = o.id === value
        return (
          <button
            key={o.id}
            id={`${base}-${o.id}`}
            type="button"
            role="tab"
            className="auth-flow__segment-option"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            data-testid={o.testId}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Separador ────────────────────────────────────────────────────────────────

/** Separa dos formas de hacer lo mismo («o continuá con»). */
export function AuthFlowDivider({ children }: { children: ReactNode }) {
  return (
    <div className="auth-flow__divider">
      <span>{children}</span>
    </div>
  )
}
