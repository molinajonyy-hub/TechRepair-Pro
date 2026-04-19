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

export interface PendingInvitation {
  id: string;
  business_id: string;
  email: string;
  role: string;
  token: string;
  status: string;
  expires_at: string;
  created_at: string;
}

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

  async createInvitation(email: string, role: string, businessId: string): Promise<string> {
    const { data, error } = await supabase.rpc('create_business_invitation', {
      p_email: email,
      p_role: role,
      p_business_id: businessId,
    });

    if (error) {
      throw new Error(getErrorMessage('Error al crear invitacion', error));
    }

    if (!data) {
      throw new Error('No se recibio el token de invitacion');
    }

    return data;
  },

  async acceptInvitation(token: string): Promise<void> {
    const { error } = await supabase.rpc('accept_business_invitation', {
      p_token: token,
    });

    if (error) {
      throw new Error(getErrorMessage('Error al aceptar invitacion', error));
    }
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

  async getPendingInvitations(businessId: string): Promise<PendingInvitation[]> {
    const { data, error } = await supabase
      .from('business_invitations')
      .select('*')
      .eq('business_id', businessId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(getErrorMessage('Error al obtener invitaciones', error));
    }

    return data || [];
  },

  async revokeInvitation(invitationId: string): Promise<void> {
    const { error } = await supabase
      .from('business_invitations')
      .update({ status: 'revoked' })
      .eq('id', invitationId);

    if (error) {
      throw new Error(getErrorMessage('Error al revocar invitacion', error));
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

  async createInvitationWithPermissions(
    email: string,
    role: string,
    businessId: string,
    customPermissions?: Partial<AppPermissions> | null
  ): Promise<string> {
    // First create the invitation token
    const token = await usersService.createInvitation(email, role, businessId);

    // If custom permissions provided, store them in the invitation for later use
    if (customPermissions && Object.keys(customPermissions).length > 0) {
      await supabase
        .from('business_invitations')
        .update({ metadata: { permissions: customPermissions } } as any)
        .eq('token', token);
    }

    return token;
  },
};
