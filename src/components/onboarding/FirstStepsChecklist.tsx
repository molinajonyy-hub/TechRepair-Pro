/**
 * P0 FIRST-STEPS-1 — "Primeros pasos" derivado del estado real del tenant.
 *
 * Reemplaza a `OnboardingChecklist`, que usaba `localStorage` como fuente de
 * completitud y permitía tildar tareas a mano. Las tareas NO son checkboxes:
 * el círculo/check es sólo un indicador, y el estado viene del servidor.
 *
 * VISIBILIDAD (§13). La regla vieja era "onboarding completo + >7 días →
 * desaparece", que ocultaba trabajo REALMENTE pendiente al día 8. La nueva:
 *
 *   - hay tareas pendientes  -> se muestra hasta que el usuario lo descarte;
 *   - 5/5                    -> se muestra el estado de éxito, que el usuario
 *                               cierra cuando quiere;
 *   - descartado             -> oculto en ese navegador, para siempre.
 *
 * Se evaluó la ventana de 30 días que proponía el lote y se descartó: sólo
 * mueve el problema del día 8 al día 31. Un negocio que a los dos meses todavía
 * no cargó un producto necesita ver ese recordatorio más, no menos. Cerrar la
 * tarjeta ya es un gesto de un clic, así que el control queda en el usuario en
 * lugar de en un timer arbitrario. Además ahorra leer `businesses.created_at`,
 * que habría costado un segundo round-trip contra el §16 (una sola RPC).
 *
 * Ante error de lectura la tarjeta NO se dibuja: mejor no mostrar nada que
 * mostrar un 0/5 falso.
 */
import { useFirstSteps } from '../../hooks/useFirstSteps'
import { SetupChecklist, type SetupChecklistItem } from './SetupChecklist'
import type { FirstSteps } from '../../services/firstStepsService'

/** Orden de presentación: el camino natural de un taller que arranca. */
const STEPS: { id: string; label: string; href: string; key: keyof FirstSteps }[] = [
  { id: 'customer',  label: 'Registrar tu primer cliente',          href: '/customers/new', key: 'has_customer'  },
  { id: 'order',     label: 'Crear tu primera orden de reparación', href: '/orders/new',    key: 'has_order'     },
  { id: 'inventory', label: 'Agregar un producto al inventario',    href: '/inventory',     key: 'has_inventory' },
  { id: 'cobro',     label: 'Hacer tu primer cobro',                href: '/comprobantes',  key: 'has_cobro'     },
  { id: 'logo',      label: 'Subir el logo del negocio',            href: '/settings',      key: 'has_logo'      },
]

export function FirstStepsChecklist() {
  const { steps, loading, dismissed, dismiss } = useFirstSteps()

  if (loading || dismissed || !steps) return null

  const items: SetupChecklistItem[] = STEPS.map(s => ({
    id:    s.id,
    label: s.label,
    href:  s.href,
    done:  steps[s.key],
  }))

  return <SetupChecklist items={items} onDismiss={dismiss} />
}
