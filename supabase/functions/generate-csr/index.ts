/**
 * Edge Function: generate-csr
 *
 * Genera un par de claves RSA 2048 y un CSR (Certificate Signing Request)
 * en formato PEM para presentar ante AFIP/ARCA.
 *
 * Flujo:
 *   1. Recibe business_id + datos del titular (razón social, CUIT, etc.)
 *   2. Genera clave privada RSA 2048 con node-forge
 *   3. Genera el CSR firmado con esa clave
 *   4. Guarda la clave privada en arca_config (campo private_key)
 *   5. Devuelve el CSR en PEM para que el usuario lo descargue y suba a AFIP
 *
 * El usuario luego descarga el certificado emitido por AFIP (.crt / .pem)
 * y lo sube desde Configuración → ARCA.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// @ts-ignore
import forge from 'npm:node-forge@1.3.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://tech-repair-pro-molinajonyy-hubs-projects.vercel.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Vary': 'Origin',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, supabaseKey)

  // Verificar JWT del usuario
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ success: false, error: 'No autorizado' }, 401)
  }

  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) {
    return json({ success: false, error: 'Sesión inválida' }, 401)
  }

  try {
    const body = await req.json()
    const {
      business_id,
      razon_social,
      cuit,
      // Opcionales — mejoran la info del CSR pero no son obligatorios para AFIP
      pais = 'AR',
      provincia = 'Buenos Aires',
      localidad = '',
      email = '',
    } = body

    if (!business_id || !razon_social || !cuit) {
      return json({
        success: false,
        error: 'Faltan campos requeridos: business_id, razon_social, cuit',
      }, 400)
    }

    // ── 1. Verificar que el usuario pertenece al negocio ────────────
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .eq('business_id', business_id)
      .eq('is_active', true)
      .maybeSingle()

    if (!profile) {
      return json({ success: false, error: 'No tenés acceso a este negocio' }, 403)
    }

    // ── 2. Generar par de claves RSA 2048 ───────────────────────────
    console.log(`[generate-csr] Generando clave RSA 2048 para business ${business_id}...`)
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
    const privateKeyPem: string = forge.pki.privateKeyToPem(keys.privateKey)

    // ── 3. Construir CSR ────────────────────────────────────────────
    // AFIP requiere que el CN sea la razón social o el alias del certificado
    // El CUIT normalizado (sin guiones) va en el campo serialNumber
    const cuitNormalizado = cuit.replace(/\D/g, '')

    const csr = forge.pki.createCertificationRequest()
    csr.publicKey = keys.publicKey
    csr.setSubject([
      { name: 'countryName',            value: pais },
      { name: 'stateOrProvinceName',    value: provincia },
      { name: 'localityName',           value: localidad || provincia },
      { name: 'organizationName',       value: razon_social },
      { name: 'serialNumber',           value: `CUIT ${cuitNormalizado}` },
      { name: 'commonName',             value: razon_social },
      ...(email ? [{ name: 'emailAddress', value: email }] : []),
    ])

    // Firmar el CSR con la clave privada (SHA-256)
    csr.sign(keys.privateKey, forge.md.sha256.create())
    const csrPem: string = forge.pki.certificationRequestToPem(csr)

    // ── 4. Guardar clave privada en arca_config ─────────────────────
    // Verificar si ya existe un registro para este negocio
    const { data: existing } = await supabase
      .from('arca_config')
      .select('id')
      .eq('business_id', business_id)
      .maybeSingle()

    if (existing) {
      // Actualizar clave privada existente
      const { error: updateErr } = await supabase
        .from('arca_config')
        .update({
          private_key: privateKeyPem,
          // Limpiar certificado anterior (ya no es válido con esta nueva clave)
          cert_file: null,
          pfx_file: null,
          wsaa_token: null,
          wsaa_sign: null,
          wsaa_token_expires: null,
          estado_conexion: 'csr_generado',
          ultimo_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('business_id', business_id)

      if (updateErr) throw updateErr
    } else {
      // Crear nuevo registro
      const { error: insertErr } = await supabase
        .from('arca_config')
        .insert({
          business_id,
          cuit: cuitNormalizado,
          razon_social,
          private_key: privateKeyPem,
          ambiente: 'homologacion',
          punto_venta: 1,
          estado_conexion: 'csr_generado',
        })

      if (insertErr) throw insertErr
    }

    console.log(`[generate-csr] CSR generado exitosamente para business ${business_id}`)

    // ── 5. Devolver CSR al cliente ──────────────────────────────────
    return json({
      success: true,
      csr_pem: csrPem,
      // Info para mostrar al usuario
      info: {
        razon_social,
        cuit: cuitNormalizado,
        algoritmo: 'RSA 2048 bits',
        firma: 'SHA-256',
        generado_en: new Date().toISOString(),
        instrucciones: [
          'Descargá el archivo CSR.',
          'Ingresá a https://auth.afip.gob.ar/contribuyente (con tu clave fiscal nivel 3).',
          'Andá a: Administrador de Relaciones de Clave Fiscal → Crear Alias → Cargar CSR.',
          'AFIP te emitirá un archivo .crt (certificado) — descargalo.',
          'Volvé a Configuración → ARCA y subí el certificado .crt recibido.',
        ],
      },
    })

  } catch (err: any) {
    console.error('[generate-csr] Error:', err)
    return json({ success: false, error: err?.message || 'Error interno al generar CSR' }, 500)
  }
})
