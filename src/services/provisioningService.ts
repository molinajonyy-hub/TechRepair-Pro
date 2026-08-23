import { supabase } from '../lib/supabase'

/**
 * P0-P1 — Único punto del frontend que puede provocar la creación de un tenant.
 *
 * La autoridad vive en la DB (`public.provision_my_business`, migración
 * 20260823150000): deriva identidad y correo de `auth.uid()` server-side, exige
 * el correo confirmado y es idempotente. Acá NO se decide nada — no se manda
 * user_id, ni business_id, ni role, ni el email. El único dato que viaja es el
 * nombre a mostrar, que no es privilegiado.
 *
 * Google y email+password entran por el MISMO camino: la señal es
 * `email_confirmed_at`, que el servidor lee por su cuenta. No hay ninguna rama
 * por proveedor, ni acá ni en la DB, y no debe haberla.
 *
 * El portal mayorista NO llama a esta función: sus clientes son usuarios de
 * auth que no deben tener un tenant SaaS propio.
 */

/** SQLSTATE propio que usa la RPC para la invitación pendiente. */
const CODIGO_INVITACION_PENDIENTE = 'TRINV'

export type ProvisionResult =
  /** Tenant disponible. `created` distingue alta nueva de idempotencia. */
  | { status: 'ok'; businessId: string; created: boolean }
  /**
   * Hay una invitación vigente para este correo: el usuario no es un owner
   * nuevo, lo invitaron. Crear un tenant propio acá es justamente lo que
   * produce negocios huérfanos, así que el servidor lo rechaza.
   */
  | { status: 'invitation_pending' }
  /** El correo todavía no está confirmado. El servidor falla cerrado. */
  | { status: 'email_not_confirmed' }

/**
 * Detección del rechazo semántico. Se mira el `code` (SQLSTATE que PostgREST
 * propaga) Y el mensaje: distintas versiones de PostgREST los reportan
 * distinto, y una detección por un solo campo se rompe en silencio.
 */
const esInvitacionPendiente = (error: { code?: string; message?: string }): boolean =>
  error.code === CODIGO_INVITACION_PENDIENTE ||
  (error.message ?? '').includes('INVITATION_PENDING')

const esCorreoSinConfirmar = (error: { message?: string }): boolean =>
  (error.message ?? '').includes('EMAIL_NOT_CONFIRMED')

/**
 * Crea —o recupera— el negocio del usuario autenticado.
 *
 * Idempotente: si el tenant ya existe (porque lo creó otra pestaña, o porque
 * todavía está activo el provisioning automático durante el rollout), devuelve
 * el existente con `created: false` en vez de fabricar un segundo.
 *
 * Cualquier fallo que NO sea uno de los dos rechazos semánticos se propaga como
 * excepción: un error real de provisioning no se traga.
 */
export async function provisionMyBusiness(
  businessName?: string | null,
): Promise<ProvisionResult> {
  const { data, error } = await supabase.rpc('provision_my_business', {
    p_business_name: businessName?.trim() || null,
  })

  if (error) {
    if (esInvitacionPendiente(error)) return { status: 'invitation_pending' }
    if (esCorreoSinConfirmar(error)) return { status: 'email_not_confirmed' }
    throw new Error(error.message || 'No se pudo crear el negocio')
  }

  // La RPC devuelve jsonb. Si no vino con forma, es un contrato roto y no algo
  // que el usuario pueda resolver reintentando: se falla fuerte.
  const fila = (Array.isArray(data) ? data[0] : data) as
    | { business_id?: string; created?: boolean }
    | null

  if (!fila?.business_id) {
    throw new Error('El servidor no devolvió el negocio creado')
  }

  return { status: 'ok', businessId: fila.business_id, created: !!fila.created }
}
