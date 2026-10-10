/**
 * CajaStatusChip — estado de la caja, compacto, en la barra superior.
 *
 * BETA-UX-1F: reemplaza la franja «Caja abierta / Gestionar →» que ocupaba el
 * ancho de Inicio. Dice una sola cosa —si hay una caja abierta— y nunca un
 * importe: ni saldo, ni caja neta, ni ventas. El dinero vive en Caja y Finanzas.
 *
 * AUTORIDAD. Las dos preguntas salen de `CajaContext`, no de un rol:
 *   · `canSeeCajaStatus` — puede conocer el estado (opera caja o cobra);
 *   · `canUseCaja`       — puede gestionarla (capacidad `finance`).
 * Quien conoce pero no gestiona ve el estado y nada para tocar: el enlace a
 * `/caja` rebotaría. Quien no necesita conocerla no ve el chip.
 *
 * El estado no depende sólo del color: punto lleno / aro vacío y texto.
 */
import { Link } from 'react-router-dom'
import { useCaja } from '../../contexts/CajaContext'
import { TZ_AR } from '../../utils/dateUtils'

/** «09:20», en 24 h y en hora del negocio: en un chip no entra «09:20 a. m.». */
const horaDeApertura = (instant: string) =>
  new Date(instant).toLocaleTimeString('es-AR', {
    timeZone: TZ_AR, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })

export function CajaStatusChip() {
  const { isOpen, activeCaja, loading, canUseCaja, canSeeCajaStatus } = useCaja()

  // Mientras la primera lectura no vuelve no se afirma nada: «Caja cerrada»
  // antes de saberlo sería un estado falso.
  if (!canSeeCajaStatus || loading) return null

  const estado = isOpen ? 'Caja abierta' : 'Caja cerrada'
  const desde = isOpen && activeCaja?.opened_at ? horaDeApertura(activeCaja.opened_at) : null

  const contenido = (
    <>
      <span className="shell-chip__dot" aria-hidden="true" />
      <span className="shell-chip__label">{estado}</span>
      {desde && <span className="shell-chip__meta">desde {desde}</span>}
    </>
  )

  if (canUseCaja) {
    return (
      <Link
        to="/caja"
        className="shell-chip shell-chip--caja is-interactive"
        data-testid="shell-caja-chip"
        data-state={isOpen ? 'open' : 'closed'}
        aria-label={`${estado}${desde ? ` desde las ${desde}` : ''}. Gestionar caja`}
        title="Gestionar caja"
      >
        {contenido}
      </Link>
    )
  }

  // Sólo informa: el texto visible ya dice todo, no hay nada que activar.
  return (
    <span
      className="shell-chip shell-chip--caja"
      data-testid="shell-caja-chip"
      data-state={isOpen ? 'open' : 'closed'}
    >
      {contenido}
    </span>
  )
}
