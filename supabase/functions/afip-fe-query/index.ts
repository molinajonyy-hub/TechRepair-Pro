/**
 * Edge Function: afip-fe-query — WSFEv1 SOLO LECTURA.
 *
 * Existe para reconciliar identidad fiscal contra ARCA sin sacar la clave
 * privada de Vault y sin atravesar el flujo de emision. Soporta exactamente
 * dos operaciones, ambas de lectura:
 *
 *   · ultimo_autorizado  -> FECompUltimoAutorizado
 *   · consultar          -> FECompConsultar
 *
 * NO puede emitir. No importa afip-cae/logic.ts (que contiene
 * buildFECAESolicitarSOAP y solicitarCAEConReconciliacion) sino su propia
 * copia read-only en queryLogic.ts, y no invoca ninguna RPC de escritura
 * fiscal. La garantia es ESTRUCTURAL, no una condicion de runtime:
 * scripts/guards/afip-query-readonly.mjs falla si el grafo de imports de este
 * endpoint vuelve a tocar el camino de emision.
 *
 * Esta funcion NO escribe en la base. Ni una fila.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  consultarComprobante,
  getUltimoComprobante,
  logStructured,
} from './queryLogic.ts'

// ── CORS: allowlist exacta, sin comodin ─────────────────────────────────────
const CANONICAL_ORIGINS = [
  'https://www.techrepairpro.app',
  'https://techrepairpro.app',
]
const stripSlash = (o: string) => o.trim().replace(/\/+$/, '')
const parseOrigins = (raw?: string | null) =>
  (raw || '').split(',').map(stripSlash).filter(Boolean)

function allowedOrigins(): string[] {
  return [...new Set([
    ...CANONICAL_ORIGINS,
    ...parseOrigins(Deno.env.get('MP_CORS_ORIGIN')),
    ...parseOrigins(Deno.env.get('APP_URL')),
  ])]
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = stripSlash(req.headers.get('origin') || '')
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  if (origin && allowedOrigins().includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin
  }
  return h
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  })
}

/**
 * Roles con autoridad sobre la configuracion fiscal del negocio.
 *
 * Se usa el contrato YA existente (src/config/permissions.ts): `settings_
 * sensitive` es la capacidad de tocar integraciones/ARCA, y la tienen owner y
 * admin. NO se abre a los cinco roles que facturan: esto es una herramienta de
 * reconciliacion fiscal, no parte del flujo de venta.
 */
const ROLES_CON_AUTORIDAD_FISCAL = ['owner', 'admin']

/** Codigos de comprobante permitidos: los que el sistema realmente emite. */
const TIPOS_PERMITIDOS = new Set([1, 3, 6, 8, 11, 12, 13])

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, { success: false, error: 'Metodo no permitido' }, 405)

  const correlationId = crypto.randomUUID()

  try {
    const supabaseUrl  = Deno.env.get('SUPABASE_URL')!
    const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey      = Deno.env.get('SUPABASE_ANON_KEY')!

    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) {
      return json(req, { success: false, error: 'Falta Authorization' }, 401)
    }
    const jwt = authHeader.slice('Bearer '.length)

    const body = await req.json().catch(() => ({}))
    const { operacion, tipo_comprobante, punto_venta, numero } = body as {
      operacion?: string; tipo_comprobante?: number; punto_venta?: number; numero?: number
    }

    // ── Identidad y autorizacion — UN SOLO camino ───────────────────────────
    // Usuario autenticado, negocio resuelto desde su PERFIL, rol con autoridad
    // fiscal. No hay camino de service_role: una clave de servicio no tiene
    // perfil ni negocio, asi que aca no puede pasar de este punto. Tampoco se
    // acepta business_id del body — no hay nada que spoofear.
    // `admin` se usa SOLO para lecturas internas ya acotadas por el JWT que se
    // acaba de verificar (el perfil de ESE uid, y la config de ESE negocio).
    // El llamador no puede influir en que fila se lee: el uid sale del token y
    // el negocio del perfil. No es un camino de autorizacion alternativo.
    const admin = createClient(supabaseUrl, serviceKey)

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userRes } = await userClient.auth.getUser()
    const uid = userRes?.user?.id
    if (!uid) return json(req, { success: false, error: 'No autenticado' }, 401)

    const { data: perfil } = await admin
      .from('profiles').select('business_id, role, is_active')
      .eq('user_id', uid).maybeSingle()

    if (!perfil?.business_id || perfil.is_active === false) {
      return json(req, { success: false, error: 'Sin negocio activo' }, 403)
    }
    // Si el body trae un business_id distinto al del perfil, se rechaza en vez
    // de ignorarlo en silencio: un intento de cross-business tiene que verse.
    const pedido = (body as { business_id?: string }).business_id
    if (pedido && pedido !== perfil.business_id) {
      return json(req, { success: false, error: 'No autorizado para ese negocio' }, 403)
    }
    if (!ROLES_CON_AUTORIDAD_FISCAL.includes(String(perfil.role))) {
      return json(req, { success: false, error: 'Rol sin autoridad fiscal para consultar ARCA' }, 403)
    }
    const businessId: string = perfil.business_id

    // ── Configuracion ARCA — fail-closed ────────────────────────────────────
    const { data: cfg } = await admin
      .from('arca_config')
      .select('cuit_emisor, ambiente')
      .eq('business_id', businessId)
      .maybeSingle()

    if (!cfg?.cuit_emisor || !cfg?.ambiente) {
      return json(req, {
        success: false,
        error: 'El negocio no tiene configuracion ARCA completa: no se puede consultar',
        error_code: 'ARCA_NOT_CONFIGURED',
      }, 409)
    }
    const cuit     = String(cfg.cuit_emisor).replace(/\D/g, '')
    const ambiente = String(cfg.ambiente)
    // Sin fallback a homologacion: se consulta el ambiente configurado o nada.

    const logCtx = { correlationId, businessId, ambiente, stage: 'query' }
    logStructured({ ...logCtx, operacion })

    // ── Validacion de inputs ────────────────────────────────────────────────
    const tipo = Number(tipo_comprobante)
    const pv   = Number(punto_venta)
    if (!TIPOS_PERMITIDOS.has(tipo)) {
      return json(req, { success: false, error: `tipo_comprobante no permitido: ${tipo_comprobante}` }, 400)
    }
    if (!Number.isInteger(pv) || pv <= 0) {
      return json(req, { success: false, error: 'punto_venta invalido' }, 400)
    }

    // ── WSAA: el token se obtiene server-side y NUNCA sale de aca ───────────
    const wsaa = await admin.functions.invoke('afip-wsaa', {
      body: { business_id: businessId, service: 'wsfe' },
    })
    if (wsaa.error || !wsaa.data?.success) {
      const msg = wsaa.data?.error || wsaa.error?.message || 'Error al autenticar con WSAA'
      logStructured({ ...logCtx, classification: 'fatal', error: 'wsaa_failed' })
      return json(req, { success: false, error: `WSAA: ${msg}`, correlation_id: correlationId }, 502)
    }
    const { token, sign } = wsaa.data as { token: string; sign: string }

    // ── Operaciones ─────────────────────────────────────────────────────────
    if (operacion === 'ultimo_autorizado') {
      const ultimo = await getUltimoComprobante(token, sign, cuit, pv, tipo, ambiente, logCtx)
      return json(req, {
        success: ultimo !== null,
        operacion: 'ultimo_autorizado',
        punto_venta: pv,
        tipo_comprobante: tipo,
        ultimo_autorizado: ultimo,
        ambiente,
        correlation_id: correlationId,
      }, ultimo === null ? 502 : 200)
    }

    if (operacion === 'consultar') {
      const nro = Number(numero)
      if (!Number.isInteger(nro) || nro <= 0) {
        return json(req, { success: false, error: 'numero invalido' }, 400)
      }
      const r = await consultarComprobante(token, sign, cuit, pv, tipo, nro, ambiente, logCtx)
      // Se devuelve SOLO lo util para reconciliar. Nunca token, sign, ni el
      // sobre SOAP completo.
      return json(req, {
        success: true,
        operacion: 'consultar',
        consulta: {
          status:            r.status,
          // Lo consultado…
          punto_venta:       pv,
          tipo_comprobante:  tipo,
          numero:            nro,
          // …y lo que ARCA respondio, para poder comparar identidad y no
          // aceptar un match solo porque coincide el numero.
          punto_venta_arca:      r.punto_venta_arca ?? null,
          tipo_comprobante_arca: r.tipo_comprobante_arca ?? null,
          numero_desde:      r.numero_cbte ?? null,
          numero_hasta:      r.numero_hasta ?? null,
          cae:               r.cae ?? null,
          cae_vencimiento:   r.cae_vencimiento ?? null,
          fecha_comprobante: r.fecha_comprobante ?? null,
          importe_total:     r.importe_total ?? null,
          doc_tipo:          r.doc_tipo ?? null,
          doc_numero:        r.doc_numero ?? null,
          resultado:         r.resultado ?? null,
          observaciones:     r.observaciones ?? null,
          motivo:            r.motivo ?? null,
        },
        ambiente,
        correlation_id: correlationId,
      })
    }

    return json(req, {
      success: false,
      error: "operacion debe ser 'consultar' o 'ultimo_autorizado'",
    }, 400)

  } catch (err) {
    // Nunca se filtra el detalle crudo: podria arrastrar fragmentos del SOAP.
    logStructured({ correlationId, stage: 'error', classification: 'fatal' })
    return json(req, {
      success: false,
      error: 'Error interno en la consulta fiscal',
      correlation_id: correlationId,
    }, 500)
  }
})
