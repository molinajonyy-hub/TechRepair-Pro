/**
 * Edge Function: mp-oauth
 * Maneja el flujo OAuth 2.0 de Mercado Pago por negocio.
 *
 * Rutas (acción en body/query):
 *   action=connect  → retorna la URL de autorización de MP
 *   action=callback → intercambia code por access_token y lo guarda cifrado
 *   action=refresh  → renueva el access_token usando el refresh_token
 *   action=status   → retorna si el negocio tiene MP conectado y activo
 *   action=disconnect → desactiva la cuenta MP del negocio
 *
 * Secrets requeridos (Supabase Dashboard > Edge Functions > Secrets):
 *   MP_APP_ID        — App ID de la aplicación MP
 *   MP_CLIENT_ID     — Client ID de la app MP
 *   MP_CLIENT_SECRET — Client Secret de la app MP
 *   MP_REDIRECT_URI  — URL de callback (ej. https://app.techrepair.com/mp/callback)
 *   MP_ENCRYPT_KEY   — Clave AES-256 para cifrar tokens (32 chars)
 *   SUPABASE_URL     — auto-inyectado
 *   SUPABASE_SERVICE_ROLE_KEY — auto-inyectado
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MP_API = 'https://api.mercadopago.com';

// ─── Cifrado simple con SubtleCrypto (AES-GCM) ───────────────────────────────

async function encryptToken(plaintext: string, key: string): Promise<string> {
  const enc     = new TextEncoder();
  const keyBuf  = await crypto.subtle.importKey(
    'raw', enc.encode(key.padEnd(32, '0').slice(0, 32)),
    { name: 'AES-GCM' }, false, ['encrypt']
  );
  const iv      = crypto.getRandomValues(new Uint8Array(12));
  const cipher  = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, keyBuf, enc.encode(plaintext)
  );
  const combined = new Uint8Array(iv.byteLength + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

async function decryptToken(ciphertext: string, key: string): Promise<string> {
  const enc     = new TextEncoder();
  const data    = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const iv      = data.slice(0, 12);
  const cipher  = data.slice(12);
  const keyBuf  = await crypto.subtle.importKey(
    'raw', enc.encode(key.padEnd(32, '0').slice(0, 32)),
    { name: 'AES-GCM' }, false, ['decrypt']
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyBuf, cipher);
  return new TextDecoder().decode(plain);
}

// ─── Handler principal ────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const appId       = Deno.env.get('MP_APP_ID') ?? '';
  const clientId    = Deno.env.get('MP_CLIENT_ID') ?? '';
  const clientSecret= Deno.env.get('MP_CLIENT_SECRET') ?? '';
  const redirectUri = Deno.env.get('MP_REDIRECT_URI') ?? '';
  const encryptKey  = Deno.env.get('MP_ENCRYPT_KEY') ?? 'changeme32charskeyforproduction!';

  try {
    const body: Record<string, string> = req.method === 'GET'
      ? Object.fromEntries(new URL(req.url).searchParams)
      : await req.json();

    const action     = body.action ?? '';
    const businessId = body.business_id ?? '';

    // Autenticar usuario (salvo callback que viene de MP sin auth)
    if (action !== 'callback') {
      const authHeader = req.headers.get('authorization') ?? '';
      const { data: { user }, error: authError } = await supabase.auth.getUser(
        authHeader.replace('Bearer ', '')
      );
      if (authError || !user) {
        return jsonError(401, 'No autorizado');
      }
    }

    // ── connect ──────────────────────────────────────────────────────────────
    if (action === 'connect') {
      if (!businessId) return jsonError(400, 'Falta business_id');

      // state = business_id cifrado para validar en callback
      const state   = btoa(JSON.stringify({ business_id: businessId, ts: Date.now() }));
      const authUrl = [
        'https://auth.mercadopago.com/authorization',
        `?client_id=${encodeURIComponent(clientId)}`,
        `&response_type=code`,
        `&platform_id=mp`,
        `&state=${encodeURIComponent(state)}`,
        `&redirect_uri=${encodeURIComponent(redirectUri)}`,
      ].join('');

      return jsonOk({ auth_url: authUrl });
    }

    // ── callback ─────────────────────────────────────────────────────────────
    if (action === 'callback') {
      const code  = body.code ?? '';
      const state = body.state ?? '';

      if (!code || !state) return jsonError(400, 'Faltan parámetros code/state');

      // Decodificar state para obtener business_id
      let bizId: string;
      try {
        const decoded = JSON.parse(atob(state));
        bizId = decoded.business_id;
        if (!bizId) throw new Error('Sin business_id en state');
      } catch {
        return jsonError(400, 'State inválido');
      }

      // Intercambiar code → tokens
      const tokenRes = await fetch(`${MP_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:     clientId,
          client_secret: clientSecret,
          grant_type:    'authorization_code',
          code,
          redirect_uri:  redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        return jsonError(400, `Error en MP OAuth: ${err}`);
      }

      const tokens: {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        scope: string;
        user_id: number;
      } = await tokenRes.json();

      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      // Cifrar tokens
      const accessEnc  = await encryptToken(tokens.access_token,  encryptKey);
      const refreshEnc = await encryptToken(tokens.refresh_token, encryptKey);

      // Guardar en mp_accounts
      const { error: upsertErr } = await supabase
        .from('mp_accounts')
        .upsert({
          business_id:             bizId,
          mp_user_id:              String(tokens.user_id),
          app_id:                  appId,
          client_id:               clientId,
          access_token_encrypted:  accessEnc,
          refresh_token_encrypted: refreshEnc,
          token_expires_at:        expiresAt,
          scope:                   tokens.scope,
          is_active:               true,
          updated_at:              new Date().toISOString(),
        }, { onConflict: 'business_id' });

      if (upsertErr) return jsonError(500, upsertErr.message);

      return jsonOk({ connected: true, mp_user_id: tokens.user_id });
    }

    // ── refresh ───────────────────────────────────────────────────────────────
    if (action === 'refresh') {
      if (!businessId) return jsonError(400, 'Falta business_id');

      const { data: account, error: fetchErr } = await supabase
        .from('mp_accounts')
        .select('refresh_token_encrypted')
        .eq('business_id', businessId)
        .single();

      if (fetchErr || !account) return jsonError(404, 'Cuenta MP no encontrada');

      const refreshToken = await decryptToken(account.refresh_token_encrypted, encryptKey);

      const tokenRes = await fetch(`${MP_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:     clientId,
          client_secret: clientSecret,
          grant_type:    'refresh_token',
          refresh_token: refreshToken,
        }),
      });

      if (!tokenRes.ok) return jsonError(400, 'Error al renovar token');

      const tokens: {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      } = await tokenRes.json();

      const accessEnc  = await encryptToken(tokens.access_token,  encryptKey);
      const refreshEnc = await encryptToken(tokens.refresh_token, encryptKey);
      const expiresAt  = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      await supabase
        .from('mp_accounts')
        .update({
          access_token_encrypted:  accessEnc,
          refresh_token_encrypted: refreshEnc,
          token_expires_at:        expiresAt,
          updated_at:              new Date().toISOString(),
        })
        .eq('business_id', businessId);

      return jsonOk({ refreshed: true, expires_at: expiresAt });
    }

    // ── status ────────────────────────────────────────────────────────────────
    if (action === 'status') {
      if (!businessId) return jsonError(400, 'Falta business_id');

      const { data: account } = await supabase
        .from('mp_accounts')
        .select('mp_user_id, is_active, token_expires_at, scope')
        .eq('business_id', businessId)
        .maybeSingle();

      if (!account) return jsonOk({ connected: false });

      const expired = account.token_expires_at
        ? new Date(account.token_expires_at) < new Date()
        : false;

      return jsonOk({
        connected:    true,
        is_active:    account.is_active,
        mp_user_id:   account.mp_user_id,
        token_expired: expired,
        scope:        account.scope,
      });
    }

    // ── disconnect ────────────────────────────────────────────────────────────
    if (action === 'disconnect') {
      if (!businessId) return jsonError(400, 'Falta business_id');

      await supabase
        .from('mp_accounts')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('business_id', businessId);

      return jsonOk({ disconnected: true });
    }

    return jsonError(400, `Acción desconocida: ${action}`);

  } catch (err: any) {
    console.error('mp-oauth error:', err);
    return jsonError(500, err?.message ?? 'Error interno');
  }
});

// ─── Utilidades ───────────────────────────────────────────────────────────────

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
