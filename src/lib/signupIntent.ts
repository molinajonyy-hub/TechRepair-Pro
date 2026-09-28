// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — Intención de alta desde la landing.
//
// Antes «Probar gratis» navegaba a `/onboarding`; sin sesión el guard mandaba a
// `/login` en la pestaña «Iniciar sesión» y el `?plan=` se perdía. Ahora los
// CTAs de prueba abren `/login?modo=registro` con el destino explícito.
//
// Nada de esto es autoridad: `modo` sólo elige una pestaña de un enum cerrado,
// el destino pasa por `sanitizeInternalPath` en el Login como cualquier
// `?redirectTo=`, y el plan se valida contra `PLANS`. El plan elegido no se
// aplica a nada: el onboarding lo muestra como informativo.
// ─────────────────────────────────────────────────────────────────────────────
import { PLANS, type SubscriptionPlan } from '../types/subscription'

export type LoginMode = 'login' | 'register' | 'forgot'

/** Valores de `?modo=` que abren una pestaña distinta de «Iniciar sesión». */
const MODE_BY_PARAM: Readonly<Record<string, LoginMode>> = {
  registro: 'register',
  recuperar: 'forgot',
}

export function initialLoginMode(search: string): LoginMode {
  const modo = new URLSearchParams(search).get('modo')
  return (modo && Object.prototype.hasOwnProperty.call(MODE_BY_PARAM, modo)) ? MODE_BY_PARAM[modo] : 'login'
}

export function isValidPlan(v: unknown): v is SubscriptionPlan {
  return typeof v === 'string' && PLANS.some(p => p.id === v)
}

/** Destino de la prueba gratis: el mismo de siempre. */
export const TRIAL_DESTINATION = '/onboarding'

/** Ruta del CTA de prueba: registro, con el destino (y el plan, si hay) preservados. */
export function signupPath(plan?: SubscriptionPlan | null): string {
  const destino = isValidPlan(plan) ? `${TRIAL_DESTINATION}?plan=${plan}` : TRIAL_DESTINATION
  return `/login?${new URLSearchParams({ modo: 'registro', redirectTo: destino }).toString()}`
}

/** Plan de un path interno ya saneado (`/onboarding?plan=pro` → `pro`). */
export function planFromInternalPath(path: string): SubscriptionPlan | null {
  const i = path.indexOf('?')
  if (i < 0) return null
  const plan = new URLSearchParams(path.slice(i + 1)).get('plan')
  return isValidPlan(plan) ? plan : null
}

// ── Plan a través de la confirmación en otra pestaña ─────────────────────────
//
// El enlace de confirmación se abre casi siempre en una pestaña nueva, donde
// `sessionStorage` (y con él `post_login_redirect`) está vacío. El plan viaja
// aparte, en localStorage con vencimiento, igual que el token de invitación
// (`src/lib/pendingInvite.ts`). Sólo el id del plan y la hora: nada de la cuenta.

const SIGNUP_PLAN_KEY = 'trp_signup_plan'
const SIGNUP_PLAN_TTL_MS = 24 * 60 * 60 * 1000

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function rememberSignupPlan(plan: SubscriptionPlan, now: number = Date.now()): void {
  try {
    store()?.setItem(SIGNUP_PLAN_KEY, JSON.stringify({ plan, at: now }))
  } catch {
    // best-effort: sin storage el plan sólo se pierde, el alta no
  }
}

export function readSignupPlan(now: number = Date.now()): SubscriptionPlan | null {
  try {
    const raw = store()?.getItem(SIGNUP_PLAN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { plan?: unknown; at?: unknown }
    if (!isValidPlan(parsed.plan) || typeof parsed.at !== 'number') return null
    const age = now - parsed.at
    return age >= 0 && age <= SIGNUP_PLAN_TTL_MS ? parsed.plan : null
  } catch {
    return null
  }
}

export function clearSignupPlan(): void {
  try {
    store()?.removeItem(SIGNUP_PLAN_KEY)
  } catch {
    // nada que limpiar
  }
}
