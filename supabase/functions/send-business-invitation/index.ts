/**
 * Edge Function: send-business-invitation  (PRE-BETA-2F — entrega por correo de invitaciones)
 *
 * Acciones (POST, JSON):
 *   · create_and_send { email, role }  → create_business_invitation (autoridad DB) + correo.
 *   · resend          { invitation_id } → reenvía la MISMA invitación pending (mismo token).
 *
 * Cableado únicamente: la lógica vive en `handler.ts` (testeada sin red).
 *   - CORS: _shared/scopedCors.ts, allowlist canónica (www + apex). INVITATION_APP_ORIGIN sólo
 *     suma un origen si es LOOPBACK (dev/E2E); cualquier otro valor se ignora. No hay Clic.
 *   - Autenticación: verify_jwt = false en supabase/config.toml para que el preflight OPTIONS
 *     llegue; el JWT se valida ACÁ (GoTrue) antes de cualquier dato, como mp-subscription.
 *   - Datos: SOLO con el JWT del actor (RLS). Esta función no usa service_role.
 *   - Correo: Resend con RESEND_INVITES_API_KEY (clave propia, separada del SMTP de Auth).
 *     Si falta, el envío falla de forma controlada y la invitación igual queda creada.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { userDataApiHeaders } from '../_shared/clientContract.ts'
import { loopbackOrigin } from '../_shared/invitationLink.ts'
import { computeAllowedOrigins, createCors } from '../_shared/scopedCors.ts'
import { handleInvitationRequest, type ScopedResult, type UserScope } from './handler.ts'

const devOrigin = loopbackOrigin(Deno.env.get('INVITATION_APP_ORIGIN'))
const cors = createCors(computeAllowedOrigins(devOrigin ? [devOrigin] : []))

const INVITATION_COLUMNS = 'id,business_id,email,role,token,status,expires_at'

serve(async (req: Request) => {
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!url || !anonKey) {
    if (req.method === 'OPTIONS') return cors.preflight(req)
    return cors.json(req, { ok: false, error: 'AUTHORIZATION_UNAVAILABLE' }, 503)
  }

  return await handleInvitationRequest(req, {
    cors,
    userScope: (request, jwt): UserScope => {
      const client = createClient(url, anonKey, {
        global: { headers: userDataApiHeaders(request, `Bearer ${jwt}`) },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
      const scoped = async (run: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<ScopedResult> => {
        const { data, error } = await run()
        if (!error) return { data, error: null }
        const e = error as { code?: unknown; message?: unknown }
        return {
          data: null,
          error: {
            code: typeof e.code === 'string' ? e.code : undefined,
            message: typeof e.message === 'string' ? e.message : undefined,
          },
        }
      }
      return {
        userId: async () => {
          const { data, error } = await client.auth.getUser(jwt)
          if (!error && data.user?.id) return data.user.id
          const status = (error as { status?: unknown } | null)?.status
          // 4xx de GoTrue = JWT inválido/vencido. Cualquier otra cosa es indisponibilidad.
          if (typeof status === 'number' && status >= 400 && status < 500) return null
          if (!error) return null
          throw new Error('AUTH_UNAVAILABLE')
        },
        rpc: (name, args = {}) => scoped(() => client.rpc(name, args)),
        invitation: (invitationId, businessId) => scoped(() => client
          .from('business_invitations')
          .select(INVITATION_COLUMNS)
          .eq('id', invitationId)
          .eq('business_id', businessId)
          .maybeSingle()),
        businessName: (businessId) => scoped(() => client
          .from('businesses')
          .select('name')
          .eq('id', businessId)
          .maybeSingle()),
      }
    },
    resendApiKey: () => Deno.env.get('RESEND_INVITES_API_KEY'),
    fetchImpl: (input, init) => fetch(input, init),
    appOrigin: devOrigin,
    now: () => new Date(),
    // Sólo ids, estados y códigos controlados. Nunca correo, token, clave ni body del proveedor.
    log: (event) => console.log(JSON.stringify(event)),
  })
})
