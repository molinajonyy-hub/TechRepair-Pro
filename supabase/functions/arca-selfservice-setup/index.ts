/**
 * Edge Function: arca-selfservice-setup  (ARCA Self-Service Phase 2A — configuración INICIAL)
 *
 * Acciones (POST, JSON): prepare · csr · certificate · verify · cancel.
 * Sólo negocios SIN credencial ARCA: la base rechaza cualquier negocio configurado
 * (ARCA_ALREADY_CONFIGURED). No es renovación y nunca toca una credencial activa.
 *
 * Cableado únicamente: la lógica vive en `handler.ts` (testeada sin red).
 *   - CORS: _shared/scopedCors.ts (allowlist canónica; APP_URL puede sumar un origen propio).
 *   - Autoridad: authorizeArcaManager + resolveManagedBusiness (handler) +
 *     is_business_owner_or_admin (defensa en profundidad SQL) + business_has_feature('arca')
 *     con el JWT del usuario.
 *   - Datos: RPC service_role `arca_selfservice_*`.
 *   - WSAA: LoginCms con el par pendiente (wsaa.ts). Nunca WSFE ni FECAESolicitar.
 *
 * verify_jwt = true (supabase/config.toml).
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { authorizeArcaManager } from '../_shared/arcaManagementAuthority.ts'
import { userDataApiHeaders } from '../_shared/clientContract.ts'
import { computeAllowedOrigins, createCors } from '../_shared/scopedCors.ts'
import { generateSetupKeyAndCsr } from './crypto.ts'
import { handleSetupRequest } from './handler.ts'
import { wsaaLoginWithPendingPair } from './wsaa.ts'

const cors = createCors(computeAllowedOrigins([Deno.env.get('APP_URL')]))

serve(async (req: Request) => {
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) {
    if (req.method === 'OPTIONS') return cors.preflight(req)
    return cors.json(req, { ok: false, error: 'AUTHORIZATION_UNAVAILABLE' }, 503)
  }

  const userClient = (authorization: string) => createClient(url, anonKey, {
    global: { headers: userDataApiHeaders(req, authorization) },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  return await handleSetupRequest(req, {
    cors,
    authorize: (request) => authorizeArcaManager(request.headers.get('Authorization'), { createUserClient: userClient }),
    hasArcaFeature: async (request) => {
      const authorization = request.headers.get('Authorization') ?? ''
      const { data, error } = await userClient(authorization).rpc('business_has_feature', { p_feature: 'arca' })
      if (error) throw new Error('FEATURE_CHECK_FAILED')
      return data === true
    },
    rpc: async (name, args) => {
      const { data, error } = await admin.rpc(name, args)
      return { data, error }
    },
    generateKeyAndCsr: generateSetupKeyAndCsr,
    wsaaLogin: wsaaLoginWithPendingPair,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  })
})
