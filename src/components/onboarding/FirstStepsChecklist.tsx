/**
 * P0 FIRST-STEPS-1 — "Primeros pasos" derivado del estado real del tenant.
 *
 * Reemplaza a `OnboardingChecklist`, que usaba `localStorage` como fuente de
 * completitud y permitía tildar tareas a mano. Las tareas NO son checkboxes:
 * el círculo/check es sólo un indicador, y el estado viene del servidor.
 *
 * VISIBILIDAD. La regla vieja era "onboarding completo + >7 días →
 * desaparece", que ocultaba trabajo REALMENTE pendiente al día 8. La regla
 * canónica ahora es:
 *
 *   - hay tareas pendientes  -> se muestra hasta que el usuario lo descarte;
 *   - 5/5                    -> no se renderiza: la guía ya cumplió su función;
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
 *
 * PRE-BETA-3A-0 — CADA PASO DECLARA LA CAPACIDAD QUE EXIGE SU DESTINO.
 * `get_my_first_steps` es SECURITY DEFINER por tenant: un técnico invitado
 * recibe el mismo progreso que el dueño. Antes se le ofrecían los cinco pasos
 * y cuatro rebotaban a /dashboard (cliente, inventario, cobro, logo). Ahora se
 * muestran sólo los que el actor puede hacer, el progreso se cuenta SOBRE ESOS
 * pasos, y si no queda ninguno la tarjeta no se dibuja. El filtro es por
 * capacidad efectiva (defaults del rol + overrides), nunca por nombre de rol;
 * la autoridad real sigue siendo RLS + current_user_can().
 */
import { useFirstSteps } from '../../hooks/useFirstSteps'
import { usePermissions } from '../../hooks/usePermissions'
import { SetupChecklist, type SetupChecklistItem } from './SetupChecklist'
import type { FirstSteps } from '../../services/firstStepsService'
import type { PermissionKey } from '../../config/permissions'

interface FirstStep {
  id: string
  label: string
  href: string
  key: keyof FirstSteps
  /** Capacidad que exige el destino (la ruta o la pantalla de alta). */
  need: PermissionKey
}

/** Orden de presentación: el camino natural de un taller que arranca. */
export const FIRST_STEPS: readonly FirstStep[] = [
  { id: 'customer',  label: 'Registrar tu primer cliente',          href: '/customers/new', key: 'has_customer',  need: 'customers'     },
  { id: 'order',     label: 'Crear tu primera orden de reparación', href: '/orders/new',    key: 'has_order',     need: 'orders_create' },
  { id: 'inventory', label: 'Agregar un producto al inventario',    href: '/inventory',     key: 'has_inventory', need: 'inventory'     },
  { id: 'cobro',     label: 'Hacer tu primer cobro',                href: '/comprobantes',  key: 'has_cobro',     need: 'comprobantes'  },
  { id: 'logo',      label: 'Subir el logo del negocio',            href: '/settings',      key: 'has_logo',      need: 'settings'      },
]

export function FirstStepsChecklist() {
  const { steps, loading, dismissed, dismiss } = useFirstSteps()
  const { can } = usePermissions()

  if (loading || dismissed || !steps) return null

  const visibles = FIRST_STEPS.filter(step => can(step.need))
  if (visibles.length === 0) return null
  if (visibles.every(step => steps[step.key])) return null

  const items: SetupChecklistItem[] = visibles.map(s => ({
    id:    s.id,
    label: s.label,
    href:  s.href,
    done:  steps[s.key],
  }))

  return <SetupChecklist items={items} onDismiss={dismiss} />
}
