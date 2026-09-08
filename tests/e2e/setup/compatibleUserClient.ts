import { createClient } from '@supabase/supabase-js'

const E2E_CLIENT_CONTRACT_HEADERS = {
  'x-techrepair-client-contract': '1',
} as const

/** User-scoped E2E clients model the already-certified R1 browser bundle. */
export function createCompatibleUserClient(target: { supabaseUrl: string; anonKey: string }) {
  return createClient(target.supabaseUrl, target.anonKey, {
    global: { headers: E2E_CLIENT_CONTRACT_HEADERS },
  })
}
