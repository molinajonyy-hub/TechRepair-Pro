/**
 * Edge Function: generate-csr  —  RETIRADA (AFIP-S4B-1)
 *
 * Este endpoint generaba un par RSA en el Edge y ESCRIBÍA la clave privada en
 * la configuración fiscal (además de limpiar el certificado y el cache WSAA).
 * Ese patrón es justamente el que la remediación AFIP eliminó: la clave ahora
 * vive en Supabase Vault y nunca toca la tabla de configuración.
 *
 * Reemplazo seguro: `arca-rotate-prepare` (AFIP-S4A) genera la clave server-side,
 * la guarda en Vault como rotación pendiente y devuelve ÚNICAMENTE el CSR público,
 * sin tocar la credencial vigente.
 *
 * Esta función queda como STUB FAIL-CLOSED:
 *   - no genera claves ni CSR;
 *   - no lee ni escribe la configuración fiscal;
 *   - no accede a Vault ni a ninguna RPC;
 *   - no llama a ARCA/AFIP;
 *   - no usa credenciales elevadas;
 *   - responde 410 Gone a cualquier invocación operativa.
 *
 * Se conserva el manejo de CORS previo y `verify_jwt=false`, para que el
 * preflight del navegador siga funcionando y el cliente reciba un mensaje claro
 * en lugar de un error opaco de red.
 *
 * La lógica vive en `handler.ts` para poder testearla sin abrir un puerto.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { handler } from './handler.ts'

serve(handler)
