// ============================================================================
// M7 7D.2 — Seed E2E local. Idempotente y determinístico.
//
// Corre en NODE con service_role. Esa key JAMÁS se expone como VITE_* (iría al
// bundle del browser).
//
// Sólo se ejecuta después de que assertDestinoLocalSeguro() haya validado
// destino + marker.
// ============================================================================
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { DestinoE2E } from './assertLocalTarget'

// IDs determinísticos: el seed es re-ejecutable sin duplicar.
export const E2E = {
  owner:    '00000000-0000-0000-0000-00000e2e0001',
  business: '00000000-0000-0000-0000-00000e2eb001',
  customer: '00000000-0000-0000-0000-00000e2ec001',
  inventory:'00000000-0000-0000-0000-00000e2ed001',
  caja:     '00000000-0000-0000-0000-00000e2e6001',
  // Control multi-tenant: un segundo negocio que el usuario E2E NO debe ver.
  otroOwner:    '00000000-0000-0000-0000-00000e2e0002',
  otroBusiness: '00000000-0000-0000-0000-00000e2eb002',
} as const

function admin(d: DestinoE2E): SupabaseClient {
  return createClient(d.supabaseUrl, d.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/** Crea (o repone) el usuario E2E en el Auth local. Idempotente. */
async function sembrarUsuario(d: DestinoE2E): Promise<void> {
  const sb = admin(d)
  const { data: existentes } = await sb.auth.admin.listUsers()
  const ya = existentes?.users?.find(u => u.id === E2E.owner || u.email === d.email)

  if (ya) {
    // Repone la contraseña por si el .env.e2e cambió; deja el mismo id.
    await sb.auth.admin.updateUserById(ya.id, { password: d.password, email_confirm: true })
    return
  }
  const { error } = await sb.auth.admin.createUser({
    id: E2E.owner,
    email: d.email,
    password: d.password,
    email_confirm: true,
  })
  if (error && !/already/i.test(error.message)) {
    throw new Error(`No se pudo sembrar el usuario E2E: ${error.message}`)
  }
}

/**
 * Datos de negocio. Se hace por SQL vía RPC de servicio para poder usar
 * session_replication_role y no pelear con los triggers de M7 (que son el
 * objeto bajo prueba, no algo que el seed deba esquivar en los flujos reales).
 */
const SQL_DATOS = `
BEGIN;
SET LOCAL session_replication_role = 'replica';

INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
VALUES ('${E2E.business}', 'E2E Local', '${E2E.owner}', 'full', 'active')
ON CONFLICT (id) DO UPDATE SET subscription_plan='full', subscription_status='active';

INSERT INTO public.profiles (id, business_id, user_id, role, is_active)
VALUES ('${E2E.owner}', '${E2E.business}', '${E2E.owner}', 'owner', true)
ON CONFLICT (id) DO UPDATE SET business_id=EXCLUDED.business_id, role='owner', is_active=true;

INSERT INTO public.customers (id, business_id, name, phone)
VALUES ('${E2E.customer}', '${E2E.business}', 'Cliente E2E', '5550000')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.inventory (id, business_id, name, code, category, stock_quantity, stock,
                              cost_price, sale_price, base_price, base_currency,
                              auto_update_price, exchange_rate_used, is_active)
VALUES ('${E2E.inventory}', '${E2E.business}', 'Producto E2E', 'E2E-1', 'Repuestos',
        100, 100, 600, 1000, 1000, 'ARS', false, 1, true)
ON CONFLICT (id) DO UPDATE SET stock_quantity=100, stock=100;

INSERT INTO public.cajas (id, business_id, opened_by, status)
VALUES ('${E2E.caja}', '${E2E.business}', '${E2E.owner}', 'abierta')
ON CONFLICT (id) DO NOTHING;

-- Control multi-tenant: negocio ajeno que el usuario E2E NO debe poder ver.
INSERT INTO auth.users (id, email) VALUES ('${E2E.otroOwner}', 'ajeno@e2e.local')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
VALUES ('${E2E.otroBusiness}', 'Negocio Ajeno E2E', '${E2E.otroOwner}', 'full', 'active')
ON CONFLICT (id) DO NOTHING;

SET LOCAL session_replication_role = 'origin';
COMMIT;
`

/**
 * Ejecuta el SQL de datos. Se usa el binario de supabase (psql del contenedor)
 * porque el cliente JS no expone SQL arbitrario.
 */
export function sqlDeDatos(): string {
  return SQL_DATOS
}

export async function sembrarE2E(d: DestinoE2E): Promise<void> {
  if (!d.password) {
    throw new Error('E2E_PASSWORD vacía en .env.e2e: el seed no puede crear el usuario.')
  }
  await sembrarUsuario(d)
}

/**
 * Control multi-tenant: el usuario E2E no debe poder leer el negocio ajeno.
 * Se verifica con la ANON key + sesión real (no service role).
 */
export async function verificarAislamiento(d: DestinoE2E): Promise<void> {
  const sb = createClient(d.supabaseUrl, d.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: authErr } = await sb.auth.signInWithPassword({ email: d.email, password: d.password })
  if (authErr) throw new Error(`El usuario E2E no puede loguearse: ${authErr.message}`)

  const { data } = await sb.from('businesses').select('id').eq('id', E2E.otroBusiness)
  if (data && data.length > 0) {
    throw new Error(
      'CONTROL MULTI-TENANT FALLIDO: el usuario E2E puede leer el negocio ajeno. ' +
      'Revisar RLS antes de correr la suite.',
    )
  }
}
