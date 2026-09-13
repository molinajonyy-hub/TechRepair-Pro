/**
 * Edge Function: arca-rotate-activate  (AFIP-S4B-2A — DORMIDA: sin uso productivo)
 *
 * Activa de forma ATÓMICA una rotación previamente preparada:
 *   1. valida la autoridad canónica de gestión ARCA (JWT real, perfil activo,
 *      owner/admin + settings_sensitive); el business_id del body solo confirma
 *      el tenant del actor;
 *   2. acepta ÚNICAMENTE el certificado PÚBLICO nuevo emitido por ARCA;
 *   3. delega en la RPC service_role `arca_activate_certificate_rotation`, que
 *      valida SPKI y subject ANTES de escribir, guarda el checkpoint del par
 *      anterior, promueve la credencial, escribe el certificado, invalida el
 *      cache WSAA y hace readback — todo en una sola transacción;
 *   4. devuelve únicamente metadata sanitizada.
 *
 * NUNCA acepta una clave privada. NUNCA devuelve el certificado completo, el
 * secret_id, el token ni el sign. NO invoca WSAA (esa verificación es de
 * S4B-2B). NO escribe la configuración fiscal directamente: todo pasa por la RPC.
 *
 * También expone el rollback (`action: "rollback"`), que restaura atómicamente
 * el par anterior desde el checkpoint sin borrar ningún secreto.
 *
 * La validación de entrada y el armado de la respuesta viven en `validate.ts`
 * para poder testearlos sin red.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildCorsHeaders, validateInput, buildActivationResponse, buildFinalizeResponse } from './validate.ts'
import { ArcaAuthorizationError } from '../_shared/arcaAuthorization.ts'
import { authorizeArcaManager, resolveManagedBusiness, type ArcaManager } from '../_shared/arcaManagementAuthority.ts'
import { userDataApiHeaders } from '../_shared/clientContract.ts'

function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...buildCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: buildCorsHeaders(req) })
  if (req.method !== 'POST') return jsonResponse(req, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // 1. Autoridad canónica de gestión ARCA (ARCA Phase 0): JWT del usuario, perfil
  //    activo, rol owner/admin Y settings_sensitive. El tenant sale de la identidad.
  let manager: ArcaManager
  try {
    manager = await authorizeArcaManager(req.headers.get('Authorization'), {
      createUserClient: (authorization) => createClient(url, anonKey, {
        global: { headers: userDataApiHeaders(req, authorization) },
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    })
  } catch (err) {
    if (err instanceof ArcaAuthorizationError) return jsonResponse(req, { ok: false, error: err.code }, err.status)
    return jsonResponse(req, { ok: false, error: 'AUTHORIZATION_UNAVAILABLE' }, 503)
  }
  const actor = manager.userId

  let body: any
  try { body = await req.json() } catch { return jsonResponse(req, { ok: false, error: 'BAD_REQUEST' }, 400) }

  const v = validateInput(body)
  if (!v.ok) return jsonResponse(req, v.body, v.status)
  // El business_id del body sólo puede CONFIRMAR el tenant del actor.
  try { resolveManagedBusiness(v.businessId, manager) } catch {
    return jsonResponse(req, { ok: false, error: 'FORBIDDEN' }, 403)
  }

  const admin = createClient(url, serviceKey)

  // 2. Defensa en profundidad: la misma autoridad canónica en SQL (la RPC vuelve a validarla).
  const { data: isAdmin } = await admin.rpc('is_business_owner_or_admin', {
    p_business_id: v.businessId, p_user_id: actor,
  })
  if (isAdmin !== true) return jsonResponse(req, { ok: false, error: 'FORBIDDEN' }, 403)

  // ── Rollback ───────────────────────────────────────────────────────────────
  if (v.action === 'rollback') {
    const { data, error } = await admin.rpc('arca_rollback_certificate_rotation', {
      p_business_id: v.businessId, p_rotation_ref: v.rotationRef,
      p_idempotency_key: v.idempotencyKey, p_actor: actor,
    })
    if (error) return jsonResponse(req, { ok: false, error: 'ROLLBACK_RPC_FAILED' }, 500)
    const state = (data && data.state) || null
    const ok = state === 'ROTATION_ROLLED_BACK' || state === 'ROLLBACK_ALREADY_APPLIED'
    return jsonResponse(req, {
      ok, state,
      rotation_ref: data && data.rotation_ref,
      restored_fingerprint_trunc: data && data.restored_fingerprint_trunc,
      wsaa_cache_invalidated: data && data.wsaa_cache_invalidated,
    }, ok ? 200 : 409)
  }

  // ── Finalización (AFIP-S4B-2C) ─────────────────────────────────────────────
  if (v.action === 'finalize') {
    const { data, error } = await admin.rpc('arca_finalize_certificate_rotation', {
      p_business_id: v.businessId, p_rotation_ref: v.rotationRef,
      p_expected_fingerprint: v.expectedFp, p_idempotency_key: v.idempotencyKey, p_actor: actor,
    })
    if (error) return jsonResponse(req, { ok: false, error: 'FINALIZATION_RPC_FAILED' }, 500)
    const st = (data && data.state) || null
    if (st !== 'ROTATION_COMPLETED' && st !== 'ROTATION_ALREADY_COMPLETED') {
      return jsonResponse(req, { ok: false, state: st }, 409)
    }
    return jsonResponse(req, buildFinalizeResponse(st, data), 200)
  }

  // ── Activación ─────────────────────────────────────────────────────────────
  const { data, error } = await admin.rpc('arca_activate_certificate_rotation', {
    p_business_id: v.businessId,
    p_rotation_ref: v.rotationRef,
    p_certificate_pem: v.certPem,
    p_expected_fingerprint: v.expectedFp,
    p_idempotency_key: v.idempotencyKey,
    p_actor: actor,
  })
  if (error) return jsonResponse(req, { ok: false, error: 'ACTIVATION_RPC_FAILED' }, 500)

  const state = (data && data.state) || null
  if (state !== 'ROTATION_ACTIVATED' && state !== 'ACTIVATION_ALREADY_APPLIED') {
    // estados de negocio/validación → 409 sanitizado, sin certificado ni claves
    return jsonResponse(req, { ok: false, state }, 409)
  }
  return jsonResponse(req, buildActivationResponse(state, data), 200)
})
