/**
 * ModalPortal — monta su contenido en `document.body`, fuera del árbol de la
 * página que lo abre.
 *
 * POR QUÉ EXISTE
 * Un overlay `position: fixed; inset: 0` sólo se mide contra el viewport si
 * ningún ancestro es su bloque contenedor. Un ancestro con `transform`,
 * `filter`, `perspective` o `contain` distintos de `none` lo es — y además abre
 * un contexto de apilamiento, así que el `z-index` del overlay deja de competir
 * con el header y el sidebar. El modal queda del tamaño de la página, corrido y
 * por debajo del resto de la aplicación.
 *
 * Medido en el smoke de BETA-UX-1B: el POS abierto desde una orden tomaba el
 * rectángulo del wrapper `.animate-fade-in` de `OrderDetail`
 * (top 129 px · 1042 × 1630) en lugar del viewport (1366 × 768).
 *
 * Renderizar en `<body>` saca al overlay de cualquier ancestro así, hoy o
 * mañana. El contexto de React (sesión, caja, tema) y el burbujeo de eventos
 * sintéticos NO cambian: siguen el árbol de React, no el del DOM.
 *
 * QUÉ NO HACE
 * No bloquea el scroll, no atrapa el foco, no pinta fondo ni maneja Escape. Es
 * sólo el punto de montaje; el modal sigue siendo dueño de su comportamiento.
 * Para un diálogo nuevo, `ResponsiveDialog` (`src/ui`) ya trae portal y todo eso.
 */
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function ModalPortal({ children }: { children: ReactNode }) {
  // El proyecto es Vite/browser; el guard sólo evita explotar si algún día se
  // evalúa sin DOM (un test en entorno node, por ejemplo).
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}
