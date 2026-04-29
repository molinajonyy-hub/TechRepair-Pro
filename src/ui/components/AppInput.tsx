import { forwardRef } from 'react'

// ─── AppInput ─────────────────────────────────────────────────────────────────

export interface AppInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
  /** Si true, el input ocupa toda la fila del grid sin label adicional */
  noLabel?: boolean
}

export const AppInput = forwardRef<HTMLInputElement, AppInputProps>(({
  label, error, hint, leftIcon, rightIcon, noLabel, className = '', id, ...props
}, ref) => {
  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined)

  return (
    <div>
      {label && !noLabel && (
        <label htmlFor={inputId} className="form-label">{label}</label>
      )}
      <div className={leftIcon || rightIcon ? 'input-group' : undefined}>
        {leftIcon && <span className="input-icon">{leftIcon}</span>}
        <input
          ref={ref}
          id={inputId}
          className={`form-control ${error ? 'border-error' : ''} ${className}`}
          style={error ? { borderColor: 'var(--error)', ...(props.style || {}) } : props.style}
          aria-invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          {...props}
        />
        {rightIcon && (
          <span style={{
            position: 'absolute', right: '0.75rem', top: '50%',
            transform: 'translateY(-50%)', color: 'var(--text-subtle)',
          }}>
            {rightIcon}
          </span>
        )}
      </div>
      {error && <p id={`${inputId}-error`} className="form-error">{error}</p>}
      {hint && !error && <p id={`${inputId}-hint`} className="form-hint">{hint}</p>}
    </div>
  )
})
AppInput.displayName = 'AppInput'

// ─── AppSelect ────────────────────────────────────────────────────────────────

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface AppSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  hint?: string
  options: SelectOption[]
  placeholder?: string
}

export const AppSelect = forwardRef<HTMLSelectElement, AppSelectProps>(({
  label, error, hint, options, placeholder, className = '', id, ...props
}, ref) => {
  const selectId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined)

  return (
    <div>
      {label && <label htmlFor={selectId} className="form-label">{label}</label>}
      <select
        ref={ref}
        id={selectId}
        className={`form-select ${className}`}
        style={error ? { borderColor: 'var(--error)', ...(props.style || {}) } : props.style}
        aria-invalid={!!error}
        {...props}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map(o => (
          <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
        ))}
      </select>
      {error && <p className="form-error">{error}</p>}
      {hint && !error && <p className="form-hint">{hint}</p>}
    </div>
  )
})
AppSelect.displayName = 'AppSelect'

// ─── AppTextarea ──────────────────────────────────────────────────────────────

export interface AppTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  hint?: string
  minRows?: number
}

export const AppTextarea = forwardRef<HTMLTextAreaElement, AppTextareaProps>(({
  label, error, hint, minRows = 3, className = '', id, ...props
}, ref) => {
  const textareaId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined)

  return (
    <div>
      {label && <label htmlFor={textareaId} className="form-label">{label}</label>}
      <textarea
        ref={ref}
        id={textareaId}
        className={`form-control ${className}`}
        rows={minRows}
        style={error ? { borderColor: 'var(--error)', ...(props.style || {}) } : props.style}
        aria-invalid={!!error}
        {...props}
      />
      {error && <p className="form-error">{error}</p>}
      {hint && !error && <p className="form-hint">{hint}</p>}
    </div>
  )
})
AppTextarea.displayName = 'AppTextarea'

// ─── AppSearchInput ───────────────────────────────────────────────────────────

import { Search, X } from 'lucide-react'

export interface AppSearchInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  value: string
  onChange: (value: string) => void
  onClear?: () => void
}

export function AppSearchInput({ value, onChange, onClear, placeholder = 'Buscar...', ...props }: AppSearchInputProps) {
  return (
    <div className="input-group" style={{ flex: 1, minWidth: 200 }}>
      <Search size={14} className="input-icon" />
      <input
        type="text"
        className="form-control"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        {...props}
      />
      {value && (
        <button
          type="button"
          onClick={() => { onChange(''); onClear?.() }}
          style={{
            position: 'absolute', right: '0.625rem', top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-subtle)', padding: '0.125rem',
            display: 'flex', alignItems: 'center',
          }}
          aria-label="Limpiar búsqueda"
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}
