import { supabase } from '../lib/supabase';
import { AppPermissions } from '../config/permissions';

export interface BusinessUser {
  id: string;
  user_id: string;
  business_id: string;
  role: string;
  is_active: boolean;
  full_name?: string;
  email?: string;
  permissions?: Partial<AppPermissions> | null;
  created_at: string;
}

/**
 * P0-P2 — Las invitaciones (crear / aceptar / cancelar / listar) ya NO viven acá.
 * Su única fuente es `src/services/invitationsService.ts`, que habla con las RPC
 * canónicas y traduce los errores del servidor a mensajes semánticos.
 *
 * Lo que había en este archivo estaba roto en producción:
 *   · `createInvitation` llamaba a la firma de 3 argumentos —retirada en la
 *     migración 20260824120000— y mandaba un `business_id` que el servidor puede
 *     derivar solo;
 *   · `revokeInvitation` hacía un `.update({ status: 'revoked' })` DIRECTO sobre
 *     la tabla: `'revoked'` no existe en el CHECK (los estados son pending /
 *     accepted / cancelled / expired) y además `authenticated` sólo tiene SELECT
 *     sobre `business_invitations`, así que la escritura no podía funcionar ni
 *     con el valor correcto.
 */

const getErrorMessage = (fallback: string, error: { message?: string } | null) =>
  error?.message ? error.message : fallback;

export const usersService = {
  async getBusinessUsers(businessId: string): Promise<BusinessUser[]> {
    const { data, error } = await supabase
      .from('business_users_view')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(getErrorMessage('Error al obtener usuarios del negocio', error));
    }

    return data || [];
  },

  async changeUserRole(profileId: string, newRole: string): Promise<void> {
    const { error } = await supabase.rpc('change_user_role', {
      p_profile_id: profileId,
      p_new_role: newRole,
    });

    if (error) {
      throw new Error(getErrorMessage('Error al cambiar rol de usuario', error));
    }
  },

  async setUserActiveStatus(profileId: string, isActive: boolean): Promise<void> {
    const { error } = await supabase.rpc('set_user_active_status', {
      p_profile_id: profileId,
      p_is_active: isActive,
    });

    if (error) {
      throw new Error(getErrorMessage('Error al cambiar estado de usuario', error));
    }
  },

  async updateUserPermissions(
    profileId: string,
    permissions: Partial<AppPermissions> | null
  ): Promise<void> {
    const { error } = await supabase
      .from('profiles')
      .update({ permissions })
      .eq('id', profileId);

    if (error) {
      throw new Error(getErrorMessage('Error al actualizar permisos de usuario', error));
    }
  },

};
