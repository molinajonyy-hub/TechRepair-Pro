/**
 * Edge Function: arca-credentials  —  RETIRADA (ARCA Self-Service Phase 0)
 *
 * AFIP-S1A la creó (dormida) para recibir `cert_pem` + `private_key_pem` desde el
 * llamador, validar el par con node-forge y guardar la clave en Vault vía
 * `arca_store_credential`. Nunca tuvo consumidor productivo, pero seguía
 * desplegada y aceptaba una clave privada originada en el navegador, que es
 * justo lo que la arquitectura Vault/rotación prohíbe: la clave se genera
 * server-side (`arca-rotate-prepare`) y nunca viaja desde el cliente.
 *
 * Esta función queda como STUB FAIL-CLOSED (mismo patrón que generate-csr):
 *   - no lee el body (un `private_key_pem` enviado nunca se parsea);
 *   - no valida pares, no genera ni procesa material criptográfico;
 *   - no crea cliente Supabase, no accede a Vault ni a ninguna RPC;
 *   - no usa credenciales elevadas;
 *   - responde 410 Gone a cualquier invocación operativa.
 *
 * El código anterior queda en el historial de git (AFIP-S1A, 20260721150000) y en
 * docs/auditoria-finanzas/afip-secure-storage/S1A.md.
 *
 * La lógica vive en `handler.ts` para poder testearla sin abrir un puerto.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { handler } from './handler.ts'

serve(handler)
