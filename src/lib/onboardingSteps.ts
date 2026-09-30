// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-3A-1a — Modelo de pasos del onboarding. ÚNICA fuente de verdad.
//
// Antes el wizard tenía `TOTAL_STEPS = 6`, un contador «Paso X de 5», seis
// puntos generados con otro número y los títulos escritos a mano en cada rama.
// Tres fuentes para lo mismo, y ninguna coincidía: el quinto «paso» vendía el
// trial y el sexto era la pantalla final.
//
// Ahora el onboarding son CUATRO pasos de configuración más un estado de
// finalización que NO es un paso: no tiene formulario, no se cuenta y nunca se
// anuncia como «Paso 5 de 4». De este arreglo se derivan la cantidad, el texto
// del progreso, la navegación (siguiente / atrás) y el paso donde se retoma.
//
// Es presentación y navegación: la autoridad de qué quedó guardado y de si el
// onboarding está completo sigue siendo el servidor (`update_my_business_onboarding`).
// ─────────────────────────────────────────────────────────────────────────────
import type { BusinessSetup } from '../services/businessSetupService'
import { isPlaceholderBusinessName } from './businessIdentity'

export type OnboardingStepId = 'negocio' | 'identidad' | 'contacto' | 'fiscal'

export interface OnboardingStep {
  id: OnboardingStepId
  /** Nombre corto del paso: es el eyebrow de la tarjeta. */
  label: string
  title: string
  /** Qué se configura y qué se puede dejar para después. */
  description: string
  /** Si el paso ofrece «Omitir». El nombre y el rubro NO se pueden omitir. */
  optional: boolean
  /** ¿Hay que volver a este paso al retomar? Se evalúa contra lo PERSISTIDO. */
  isPending: (setup: BusinessSetup) => boolean
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'negocio',
    label: 'Tu negocio',
    title: 'Configurá tu negocio',
    description: 'Empecemos por los datos básicos de tu taller.',
    optional: false,
    // `Mi Negocio` es el nombre por defecto de `provision_my_business`: cuenta
    // como «todavía sin elegir». El rubro lo exige el servidor para completar
    // (ONBOARDING_INCOMPLETE): no es omitible.
    isPending: s => !s.name || isPlaceholderBusinessName(s.name) || !s.rubro,
  },
  {
    id: 'identidad',
    label: 'Identidad',
    title: 'Logo de tu negocio',
    description: 'Es opcional: podés omitir este paso y cargarlo después desde Configuración.',
    optional: true,
    isPending: s => !s.logoUrl,
  },
  {
    id: 'contacto',
    label: 'Contacto',
    title: 'Datos de contacto',
    description: 'Para WhatsApp y el encabezado de tus comprobantes.',
    optional: true,
    isPending: s => !s.ciudad || !s.whatsapp,
  },
  {
    id: 'fiscal',
    label: 'Datos fiscales',
    title: 'Datos impositivos',
    description: 'La facturación electrónica (ARCA) se configura después, desde Configuración.',
    optional: true,
    isPending: s => !s.cuit || !s.condicionFiscal,
  },
]

/** Cantidad de pasos de configuración. */
export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length

/**
 * Posición del estado final («Todo listo»). Es la que sigue al último paso,
 * pero no es un paso: `onboardingStepAt` devuelve `null` y el progreso no la
 * cuenta.
 */
export const ONBOARDING_DONE = ONBOARDING_STEP_COUNT + 1

/** Paso en la posición 1-based, o `null` si es el estado final (o inválida). */
export function onboardingStepAt(position: number): OnboardingStep | null {
  return ONBOARDING_STEPS[position - 1] ?? null
}

export function isOnboardingDone(position: number): boolean {
  return position >= ONBOARDING_DONE
}

/** Texto del progreso. El estado final NUNCA se anuncia como un paso más. */
export function onboardingProgressLabel(position: number): string {
  if (isOnboardingDone(position)) return 'Configuración completa'
  return `Paso ${position} de ${ONBOARDING_STEP_COUNT}`
}

export function nextOnboardingPosition(position: number): number {
  return Math.min(position + 1, ONBOARDING_DONE)
}

/** «Atrás» sólo entre pasos de configuración: ni desde el primero ni desde el final. */
export function canGoBackFrom(position: number): boolean {
  return position > 1 && position <= ONBOARDING_STEP_COUNT
}

export function previousOnboardingPosition(position: number): number {
  return canGoBackFrom(position) ? position - 1 : position
}

/**
 * Dónde retomar: el PRIMER paso con algo pendiente en lo persistido; si no
 * falta nada, el estado final. Cerrar la pestaña en el paso 3 y volver no
 * pierde lo guardado ni obliga a empezar de nuevo.
 */
export function resumeOnboardingPosition(setup: BusinessSetup): number {
  const i = ONBOARDING_STEPS.findIndex(step => step.isPending(setup))
  return i === -1 ? ONBOARDING_DONE : i + 1
}
