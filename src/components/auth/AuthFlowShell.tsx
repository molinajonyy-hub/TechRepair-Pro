// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-3A-1a — Shell compartido de las superficies post-login del alta.
//
// /verificar-email, /no-business y /onboarding tenían cada una su propio fondo,
// su tarjeta y sus botones inline: parecidos pero independientes, y el embudo
// se sentía armado pantalla por pantalla. Acá vive UNA implementación.
//
// Es PRESENTACIONAL. No sabe de Supabase, AuthContext, negocio, roles, pasos del
// onboarding ni provisioning: recibe contenido y lo enmarca. Cada pantalla sigue
// siendo dueña de su lógica y de sus `data-testid`.
//
// Reutiliza lo que ya existe en vez de crear un segundo sistema visual:
//   · tarjeta y fondos decorativos → `authCardStyles` (los mismos del Login);
//   · botones → `AppButton` de src/ui (el blanco del texto va por clase, así que
//     el remapeo de texto blanco inline del tema claro no lo alcanza);
//   · campos → `.form-control`;
//   · colores, radios y sombras → tokens de index.css. `src/css/auth-flow.css`
//     sólo compone layout con esos tokens.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Check, ChevronLeft, Loader2 } from 'lucide-react'
import { AppButton, type AppButtonProps } from '../../ui'
import { S } from './authCardStyles'
import logoSvg from '../../assets/logo.svg'
import '../../css/auth-flow.css'

export type AuthFlowTone = 'accent' | 'success' | 'warning'

export interface AuthFlowBackAction {
  label: string
  onClick: () => void
  disabled?: boolean
  testId?: string
}

export interface AuthFlowProgressModel {
  /** Cantidad de pasos que se cuentan. */
  total: number
  /** Posición 1-based. Mayor que `total` = flujo completo: todos llenos. */
  current: number
  /** Texto visible y anunciado (p. ej. «Paso 2 de 4»). */
  label: string
  testId?: string
}

export interface AuthFlowShellProps {
  children?: ReactNode
  /** Navegación secundaria sobre la tarjeta (p. ej. «Atrás»). */
  back?: AuthFlowBackAction
  /** Progreso del flujo, sobre la tarjeta. */
  progress?: AuthFlowProgressModel
  /** Encabezado de la tarjeta. Todo opcional. */
  icon?: ReactNode
  tone?: AuthFlowTone
  eyebrow?: ReactNode
  title?: ReactNode
  description?: ReactNode
  /** `center` para pantallas de estado; `start` para formularios. */
  align?: 'start' | 'center'
  /**
   * Identidad del contenido. Cuando cambia (otro paso), la tarjeta anima la
   * entrada y el foco pasa al título para que el lector de pantalla lo anuncie.
   */
  contentKey?: string | number
  /** `data-testid` de la raíz de la página. */
  testId?: string
  /** `data-testid` de la tarjeta. */
  cardTestId?: string
}

// ── Marco: fondo, decoración, columna y marca ───────────────────────────────

function AuthFlowFrame({ testId, children }: { testId?: string; children: ReactNode }) {
  return (
    <div className="auth-flow" data-auth-flow-shell="" data-testid={testId}>
      <div aria-hidden="true" style={S.blob1} />
      <div aria-hidden="true" style={S.blob2} />
      <div aria-hidden="true" style={S.blob3} />
      <main className="auth-flow__column">
        <div className="auth-flow__brand" role="img" aria-label="TechRepair Pro">
          <img src={logoSvg} alt="" width={32} height={32} />
          <span className="auth-flow__wordmark" aria-hidden="true">TechRepair<span>Pro</span></span>
        </div>
        {children}
      </main>
    </div>
  )
}

/** Segmentos del progreso. Decorativos: el texto lo anuncia la etiqueta visible. */
function AuthFlowProgressBar({ total, current, testId }: AuthFlowProgressModel) {
  return (
    <div
      className="auth-flow__progress-track"
      data-testid={testId}
      data-total={total}
      data-current={Math.min(current, total + 1)}
      aria-hidden="true"
    >
      {Array.from({ length: total }, (_, i) => {
        const pos = i + 1
        const state = pos < current ? 'done' : pos === current ? 'current' : 'pending'
        return <span key={pos} className={`auth-flow__segment is-${state}`} data-state={state} />
      })}
    </div>
  )
}

export function AuthFlowShell({
  children, back, progress, icon, tone = 'accent', eyebrow, title, description,
  align = 'start', contentKey, testId, cardTestId,
}: AuthFlowShellProps) {
  const titleId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  // Se compara contra la clave anterior y no contra «primer render»: en
  // StrictMode el efecto de montaje corre dos veces y le robaría el foco al
  // `autoFocus` del primer campo.
  const claveAnterior = useRef(contentKey)

  useEffect(() => {
    if (claveAnterior.current === contentKey) return
    claveAnterior.current = contentKey
    titleRef.current?.focus()
  }, [contentKey])

  const hayEncabezado = Boolean(icon || eyebrow || title || description)

  return (
    <AuthFlowFrame testId={testId}>
      {(back || progress) && (
        <div className="auth-flow__top">
          <div className={`auth-flow__top-row${back ? ' auth-flow__top-row--with-back' : ''}`}>
            {back && (
              <button
                type="button"
                className="auth-flow__back"
                onClick={back.onClick}
                disabled={back.disabled}
                data-testid={back.testId}
              >
                <ChevronLeft size={18} aria-hidden="true" />
                {back.label}
              </button>
            )}
            {progress && (
              <p className="auth-flow__progress-label" aria-live="polite" data-testid={progress.testId ? `${progress.testId}-label` : undefined}>
                {progress.label}
              </p>
            )}
          </div>
          {progress && <AuthFlowProgressBar {...progress} />}
        </div>
      )}

      <section
        className={`auth-flow__card auth-flow__card--${align}`}
        style={S.card}
        data-testid={cardTestId}
        aria-labelledby={title ? titleId : undefined}
      >
        <div aria-hidden="true" style={S.cardTopGlow} />
        <div key={contentKey} className="auth-flow__body">
          {hayEncabezado && (
            <header className="auth-flow__header">
              {icon && <div className={`auth-flow__icon auth-flow__icon--${tone}`} aria-hidden="true">{icon}</div>}
              {eyebrow && <p className="auth-flow__eyebrow">{eyebrow}</p>}
              {title && <h1 id={titleId} ref={titleRef} tabIndex={-1} className="auth-flow__title">{title}</h1>}
              {description && <div className="auth-flow__description">{description}</div>}
            </header>
          )}
          {children}
        </div>
      </section>
    </AuthFlowFrame>
  )
}

/** Espera antes de poder decidir qué mostrar. Mismo marco, sin tarjeta. */
export function AuthFlowLoading({ label = 'Cargando…', testId }: { label?: string; testId?: string }) {
  return (
    <AuthFlowFrame>
      <div className="auth-flow__loading" role="status" aria-live="polite" data-testid={testId}>
        <Loader2 size={30} className="animate-spin" aria-hidden="true" />
        <p>{label}</p>
      </div>
    </AuthFlowFrame>
  )
}

// ── Primitivos de contenido ─────────────────────────────────────────────────

export function AuthFlowForm({ children }: { children: ReactNode }) {
  return <div className="auth-flow__form">{children}</div>
}

export function AuthFlowField({
  label, htmlFor, optional, hint, children,
}: { label: string; htmlFor: string; optional?: boolean; hint?: string; children: ReactNode }) {
  return (
    <div className="auth-flow__field">
      <label htmlFor={htmlFor} className="auth-flow__label">
        {label}
        {optional && <span className="auth-flow__optional"> (opcional)</span>}
      </label>
      {children}
      {hint && <p id={`${htmlFor}-hint`} className="auth-flow__hint">{hint}</p>}
    </div>
  )
}

export interface AuthFlowChoice {
  id: string
  label: string
}

/**
 * Selección única entre opciones cortas. El seleccionado no depende sólo del
 * color: lleva marca, borde y `aria-pressed`.
 */
export function AuthFlowChoiceGroup({
  label, options, value, onChange, testIdPrefix, optional,
}: {
  label: string
  options: readonly AuthFlowChoice[]
  value: string
  onChange: (id: string) => void
  /** Se concatena con el id de cada opción: `onboarding-rubro-` + `redes`. */
  testIdPrefix: string
  optional?: boolean
}) {
  const labelId = useId()
  return (
    <div className="auth-flow__field">
      <span id={labelId} className="auth-flow__label">
        {label}
        {optional && <span className="auth-flow__optional"> (opcional)</span>}
      </span>
      <div role="group" aria-labelledby={labelId} className="auth-flow__choices">
        {options.map(o => {
          const selected = value === o.id
          return (
            <button
              key={o.id}
              type="button"
              className="auth-flow__choice"
              aria-pressed={selected}
              data-testid={`${testIdPrefix}${o.id}`}
              onClick={() => onChange(o.id)}
            >
              <span className="auth-flow__choice-mark" aria-hidden="true">
                {selected && <Check size={12} strokeWidth={3} />}
              </span>
              <span>{o.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function AuthFlowError({ children, testId }: { children: ReactNode; testId?: string }) {
  return <p className="auth-flow__error" role="alert" data-testid={testId}>{children}</p>
}

export function AuthFlowNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return <p className="auth-flow__note" data-testid={testId}>{children}</p>
}

/**
 * Convención de acciones:
 *   · `row`   → secundaria a la izquierda, primaria a la derecha y más ancha;
 *   · `stack` → una debajo de otra, la primaria primero;
 *   · `pair`  → dos acciones del mismo peso: lado a lado si entran, apiladas si no.
 */
export function AuthFlowActions({ children, layout = 'row' }: { children: ReactNode; layout?: 'row' | 'stack' | 'pair' }) {
  return <div className={`auth-flow__actions auth-flow__actions--${layout}`}>{children}</div>
}

// ── Botones: AppButton con la convención del embudo ─────────────────────────

type AuthFlowButtonProps = Omit<AppButtonProps, 'variant' | 'size' | 'fullWidth' | 'as' | 'href'>

const conClase = (base: string, extra?: string) => (extra ? `${base} ${extra}` : base)

export function AuthFlowPrimaryButton({ className, ...props }: AuthFlowButtonProps) {
  return <AppButton {...props} variant="indigo" size="lg" fullWidth className={conClase('auth-flow__btn auth-flow__primary', className)} />
}

export function AuthFlowSecondaryButton({ className, ...props }: AuthFlowButtonProps) {
  return <AppButton {...props} variant="secondary" size="lg" fullWidth className={conClase('auth-flow__btn', className)} />
}

/** Acción de menor jerarquía (cerrar sesión, «no es para mí»). */
export function AuthFlowTextButton({ className, ...props }: AuthFlowButtonProps) {
  return <AppButton {...props} variant="ghost" fullWidth className={conClase('auth-flow__btn auth-flow__btn--text', className)} />
}
