/**
 * BETA-UX-3 — Catálogo de tutoriales del Centro de ayuda.
 *
 * Sólo METADATOS: el contenido de cada guía vive en `pages/Tutorials.tsx` y se
 * carga recién al abrirla, así el Centro de ayuda no arrastra cientos de líneas
 * de contenido para dibujar la lista.
 *
 * Para sumar contenido:
 *   · Guía paso a paso dentro de la app → `{ kind: 'guia', id, ... }` y su
 *     componente en `TUTORIAL_GUIDES` (pages/Tutorials.tsx), con el mismo `id`.
 *     Se abre en `/ayuda/tutoriales/<id>`.
 *   · Video → `{ kind: 'video', url, ... }`. Se abre aparte (YouTube, etc.).
 *
 * Un test fija que cada guía tenga su componente y que no haya ids repetidos.
 */
import { Shield, type LucideIcon } from 'lucide-react'

interface TutorialBase {
  /** Clave estable: es parte de la URL (`/ayuda/tutoriales/<id>`). */
  id: string
  title: string
  description: string
  icon: LucideIcon
  /** Duración estimada, como se muestra («20 min»). */
  duration: string
  level: 'Inicial' | 'Intermedio' | 'Avanzado'
}

export interface GuideTutorial extends TutorialBase {
  kind: 'guia'
}

export interface VideoTutorial extends TutorialBase {
  kind: 'video'
  /** Enlace https al video. Se abre en otra pestaña. */
  url: string
}

export type Tutorial = GuideTutorial | VideoTutorial

export const TUTORIAL_KIND_LABELS: Record<Tutorial['kind'], string> = {
  guia: 'Guía',
  video: 'Video',
}

export const TUTORIALS: readonly Tutorial[] = [
  {
    kind: 'guia',
    id: 'arca',
    title: 'Integración con ARCA (Factura Electrónica)',
    description: 'Configurá tu certificado digital y empezá a emitir facturas A, B y C con CAE válido.',
    icon: Shield,
    duration: '20 min',
    level: 'Intermedio',
  },
]

export function findTutorial(id: string | undefined): Tutorial | undefined {
  return TUTORIALS.find(tutorial => tutorial.id === id)
}

export function tutorialHref(tutorial: Tutorial): string {
  return tutorial.kind === 'video' ? tutorial.url : `/ayuda/tutoriales/${tutorial.id}`
}

/** «Guía · 20 min · Intermedio». */
export function tutorialMeta(tutorial: Tutorial): string {
  return [TUTORIAL_KIND_LABELS[tutorial.kind], tutorial.duration, tutorial.level].join(' · ')
}
