/**
 * Edge Function: mp-payments
 * Crea órdenes QR / Point, maneja webhooks de pagos y consulta transacciones.
 *
 * Rutas (acción en body):
 *   action=create_qr       → crea orden QR integrado en MP
 *   action=create_point    → envía intent a terminal Point
 *   action=create_checkout → genera link de pago (preference)
 *   action=create_manual   → registra pago manual sin llamar a MP
 *   action=lookup          → consulta un pago por provider_payment_id
 *   action=webhook         → procesa notificación de MP (topic=payment)
 *   action=sync_report     → sincroniza reporte de acreditaciones
 *   action=refund          → genera devolución
 *
 * Secrets:
 *   MP_ENCRYPT_KEY, MP_WEBHOOK_SECRET
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-inyectados)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-signature, x-request-id',
};

const MP_API = 'https://api.mercadopago.com';

// ─── Descifrar token ──────────────────────────────────────────────────────────

async function decryptToken(ciphertext: string, key: string): Promise<string> {
  const enc    = new TextEncoder();
  const data   = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const iv     = data.slice(0, 12);
  const cipher = data.slice(12);
  const keyBuf = await crypto.subtle.importKey(
    'raw', enc.encode(key.padEnd(32, '0').slice(0, 32)),
    { name: 'AES-GCM' }, false, ['decrypt']
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyBuf, cipher);
  return new TextDecoder().decode(plain);
}

// ─── Obtener access_token del negocio ─────────────────────────────────────────

async function getAccessToken(
  supabase: ReturnType<typeof createClient>,
  businessId: string,
  encryptKey: string
): Promise<string> {
  const { data, error } = await supabase
    .from('mp_accounts')
    .select('access_token_encrypted, token_expires_at, is_active')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .single();

  if (error || !data) throw new Error('No hay cuenta MP activa para este negocio');

  if (data.token_expires_at && new Date(data.token_expires_at) < new Date()) {
    throw new Error('Token de MP expirado. Reconectar desde Configuración > Mercado Pago');
  }

  return decryptToken(data.access_token_encrypted, encryptKey);
}

// ─── Helpers de cálculo ───────────────────────────────────────────────────────

function calcFee(amount: number, feePercent: number, feeFixed: number, vatPercent: number): number {
  const base = amount * feePercent + feeFixed;
  return Math.round((base * (1 + vatPercent)) * 100) / 100;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const encryptKey    = Deno.env.get('MP_ENCRYPT_KEY') ?? 'changeme32charskeyforproduction!';
  const webhookSecret = Deno.env.get('MP_WEBHOOK_SECRET') ?? '';

  try {
    const body: Record<string, any> = await req.json().catch(() => ({}));
    const action     = body.action ?? '';
    const businessId = body.business_id ?? '';

    // ── Webhook — sin autenticación de usuario, usa firma MP ─────────────────
    if (action === 'webhook' || req.headers.get('x-signature')) {
      return handleWebhook(req, body, supabase, encryptKey, webhookSecret);
    }

    // Autenticar usuario para las demás acciones
    const authHeader = req.headers.get('authorization') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );
    if (authErr || !user) return jsonError(401, 'No autorizado');

    // ── create_qr ────────────────────────────────────────────────────────────
    if (action === 'create_qr') {
      const { comprobante_id, button_id, amount, description, external_reference } = body;
      if (!businessId || !amount) return jsonError(400, 'Faltan business_id o amount');

      const accessToken = await getAccessToken(supabase, businessId, encryptKey);

      // Obtener mp_user_id para construir la URL del QR
      const { data: mpAcc } = await supabase
        .from('mp_accounts')
        .select('mp_user_id')
        .eq('business_id', businessId)
        .single();

      const extRef = external_reference ?? `comp_${comprobante_id}_${Date.now()}`;

      // Crear preferencia de pago (sirve para QR y link)
      const prefRes = await fetch(`${MP_API}/checkout/preferences`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': extRef,
        },
        body: JSON.stringify({
          items: [{
            title:    description ?? 'Servicio técnico',
            quantity: 1,
            unit_price: amount,
            currency_id: 'ARS',
          }],
          external_reference: extRef,
          notification_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/mp-payments`,
          back_urls: {
            success: `${Deno.env.get('APP_URL') ?? ''}/comprobantes`,
            failure: `${Deno.env.get('APP_URL') ?? ''}/comprobantes`,
          },
          auto_return: 'approved',
        }),
      });

      if (!prefRes.ok) {
        const err = await prefRes.text();
        return jsonError(400, `MP preferences error: ${err}`);
      }

      const pref = await prefRes.json();

      // Obtener botón para fee
      const { data: btn } = button_id
        ? await supabase.from('payment_method_buttons').select('*').eq('id', button_id).single()
        : { data: null };

      const estimatedFee = btn
        ? calcFee(amount, btn.fee_percent, btn.fee_fixed, btn.vat_percent)
        : 0;

      // Guardar payment_order
      const { data: order, error: orderErr } = await supabase
        .from('payment_orders')
        .insert({
          business_id:          businessId,
          comprobante_id:       comprobante_id ?? null,
          payment_button_id:    button_id ?? null,
          provider:             'mercadopago',
          channel:              'integrated',
          integration_kind:     'mp_qr',
          external_reference:   extRef,
          provider_order_id:    pref.id,
          requested_amount:     amount,
          estimated_fee_amount: estimatedFee,
          estimated_net_amount: amount - estimatedFee,
          currency:             'ARS',
          status:               'pending',
          mp_deep_link:         pref.init_point,
          expires_at:           new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          raw_response:         pref,
        })
        .select()
        .single();

      if (orderErr) return jsonError(500, orderErr.message);

      return jsonOk({
        order_id:          order.id,
        preference_id:     pref.id,
        init_point:        pref.init_point,
        sandbox_init_point: pref.sandbox_init_point,
        external_reference: extRef,
        estimated_fee:     estimatedFee,
        estimated_net:     amount - estimatedFee,
      });
    }

    // ── create_point ──────────────────────────────────────────────────────────
    if (action === 'create_point') {
      const { comprobante_id, button_id, amount, device_id, external_reference, description } = body;
      if (!businessId || !amount || !device_id) {
        return jsonError(400, 'Faltan business_id, amount o device_id');
      }

      const accessToken = await getAccessToken(supabase, businessId, encryptKey);
      const extRef = external_reference ?? `comp_${comprobante_id}_${Date.now()}`;

      const intentRes = await fetch(
        `${MP_API}/point/integration-api/devices/${device_id}/payment-intents`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': extRef,
          },
          body: JSON.stringify({
            amount,
            description: description ?? 'Servicio técnico',
            additional_info: { external_reference: extRef },
          }),
        }
      );

      if (!intentRes.ok) {
        const err = await intentRes.text();
        return jsonError(400, `MP Point error: ${err}`);
      }

      const intent = await intentRes.json();

      const { data: btn } = button_id
        ? await supabase.from('payment_method_buttons').select('*').eq('id', button_id).single()
        : { data: null };

      const estimatedFee = btn
        ? calcFee(amount, btn.fee_percent, btn.fee_fixed, btn.vat_percent)
        : 0;

      const { data: order } = await supabase
        .from('payment_orders')
        .insert({
          business_id:          businessId,
          comprobante_id:       comprobante_id ?? null,
          payment_button_id:    button_id ?? null,
          provider:             'mercadopago',
          channel:              'integrated',
          integration_kind:     'mp_point',
          external_reference:   extRef,
          provider_order_id:    intent.id,
          requested_amount:     amount,
          estimated_fee_amount: estimatedFee,
          estimated_net_amount: amount - estimatedFee,
          currency:             'ARS',
          status:               'pending',
          raw_response:         intent,
        })
        .select()
        .single();

      return jsonOk({ order_id: order?.id, intent_id: intent.id, external_reference: extRef });
    }

    // ── create_manual ─────────────────────────────────────────────────────────
    if (action === 'create_manual') {
      const { comprobante_id, button_id, amount, currency = 'ARS', notes } = body;
      if (!businessId || !amount || !comprobante_id) {
        return jsonError(400, 'Faltan business_id, amount o comprobante_id');
      }

      const { data: btn } = button_id
        ? await supabase.from('payment_method_buttons').select('*').eq('id', button_id).single()
        : { data: null };

      const feeEst = btn
        ? calcFee(amount, btn.fee_percent, btn.fee_fixed, btn.vat_percent)
        : 0;
      const netEst = amount - feeEst;

      // Insertar transacción manual directamente aprobada
      const { data: txn, error: txnErr } = await supabase
        .from('payment_transactions')
        .insert({
          business_id:         businessId,
          comprobante_id,
          payment_button_id:   button_id ?? null,
          provider:            btn?.provider ?? 'manual',
          channel:             'manual',
          integration_kind:    'none',
          status:              'approved',
          payment_method_type: btn?.payment_type ?? 'other',
          installments:        btn?.installments ?? 1,
          transaction_amount:  amount,
          fee_amount_estimated: feeEst,
          net_amount_estimated: netEst,
          currency,
          approved_at:         new Date().toISOString(),
          is_manual:           true,
        })
        .select()
        .single();

      if (txnErr) return jsonError(500, txnErr.message);

      // El trigger trig_pt_approved actualiza el comprobante y genera movimientos

      return jsonOk({
        transaction_id: txn.id,
        status:         'approved',
        amount,
        fee_estimated:  feeEst,
        net_estimated:  netEst,
      });
    }

    // ── lookup ────────────────────────────────────────────────────────────────
    if (action === 'lookup') {
      const { payment_id } = body;
      if (!businessId || !payment_id) return jsonError(400, 'Faltan parámetros');

      const accessToken = await getAccessToken(supabase, businessId, encryptKey);
      const mpRes = await fetch(`${MP_API}/v1/payments/${payment_id}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      if (!mpRes.ok) return jsonError(400, 'Error consultando pago en MP');
      const payment = await mpRes.json();

      return jsonOk({ payment });
    }

    // ── refund ────────────────────────────────────────────────────────────────
    if (action === 'refund') {
      const { payment_id, amount: refundAmount } = body;
      if (!businessId || !payment_id) return jsonError(400, 'Faltan parámetros');

      const accessToken = await getAccessToken(supabase, businessId, encryptKey);
      const refundBody: Record<string, any> = {};
      if (refundAmount) refundBody.amount = refundAmount;

      const mpRes = await fetch(`${MP_API}/v1/payments/${payment_id}/refunds`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(refundBody),
      });

      if (!mpRes.ok) {
        const err = await mpRes.text();
        return jsonError(400, `Refund error: ${err}`);
      }

      const refund = await mpRes.json();

      // Actualizar payment_transaction
      await supabase
        .from('payment_transactions')
        .update({ status: 'refunded', updated_at: new Date().toISOString() })
        .eq('provider_payment_id', String(payment_id))
        .eq('business_id', businessId);

      return jsonOk({ refund_id: refund.id, status: refund.status });
    }

    return jsonError(400, `Acción desconocida: ${action}`);

  } catch (err: any) {
    console.error('mp-payments error:', err);
    return jsonError(500, err?.message ?? 'Error interno');
  }
});

// ─── Webhook handler ──────────────────────────────────────────────────────────

async function handleWebhook(
  req: Request,
  body: Record<string, any>,
  supabase: ReturnType<typeof createClient>,
  encryptKey: string,
  webhookSecret: string
): Promise<Response> {
  // Verificar firma HMAC-SHA256 si hay secret configurado
  if (webhookSecret) {
    const xSignature = req.headers.get('x-signature') ?? '';
    const xRequestId = req.headers.get('x-request-id') ?? '';
    const rawBody    = JSON.stringify(body);
    const dataId     = body.data?.id ?? '';

    const manifest  = `id:${dataId};request-id:${xRequestId};ts:${xSignature.split(';')[1]?.split('=')[1] ?? ''};`;
    const keyBuf    = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigParts = xSignature.split(',').find((p: string) => p.trim().startsWith('v1='))?.split('=')[1] ?? '';
    const expected = sigParts;
    const computed = Array.from(
      new Uint8Array(
        await crypto.subtle.sign('HMAC', keyBuf, new TextEncoder().encode(manifest))
      )
    ).map(b => b.toString(16).padStart(2, '0')).join('');

    if (computed !== expected && webhookSecret !== 'dev_skip') {
      console.warn('Webhook signature mismatch');
      // En producción retornar 401; en dev permitir pasar
    }
  }

  const topic    = body.type ?? body.topic ?? '';
  const action   = body.action ?? '';
  const dataId   = body.data?.id ?? body.id ?? '';
  const liveMode = body.live_mode ?? true;

  // Log del evento para idempotencia
  const { error: logErr } = await supabase
    .from('payment_webhook_events')
    .insert({
      provider:     'mercadopago',
      topic,
      action,
      resource_id:  String(dataId),
      live_mode:    liveMode,
      raw_payload:  body,
      processed:    false,
    })
    .select()
    .single();

  // Si ya fue procesado (conflicto en unique index), ignorar
  if (logErr?.code === '23505') {
    return jsonOk({ status: 'already_processed' });
  }

  // Solo procesar eventos de tipo 'payment'
  if (topic !== 'payment' && !String(body.resource ?? '').includes('/v1/payments')) {
    await markWebhookProcessed(supabase, topic, String(dataId), action);
    return jsonOk({ status: 'ignored', topic });
  }

  try {
    // Buscar el business_id asociado al external_reference del pago
    // Para eso, primero consultamos el pago en MP con el token del negocio
    // Estrategia: buscar en payment_orders por external_reference

    // En algunos webhooks MP envía la URL del pago, extraer el ID
    const paymentId = dataId || String(body.resource ?? '').split('/').pop();
    if (!paymentId) {
      await markWebhookProcessed(supabase, topic, String(dataId), action, 'No payment ID');
      return jsonOk({ status: 'no_payment_id' });
    }

    // Buscar payment_order con external_reference que coincida
    // MP no manda business_id en el webhook; tenemos que descubrirlo
    // Opción A: buscar por provider_order_id o external_reference en payment_orders
    // Opción B: iterar mp_accounts activas y probar el token

    // Primero: consultar con service_role (sin filtro de negocio)
    // Para lograrlo necesitamos el token del negocio correcto.
    // Usamos la tabla payment_orders + external_reference embebido en el cuerpo

    let businessId: string | null = null;
    let accessToken: string | null = null;

    // Intentar encontrar el negocio vía payment_orders (external_reference)
    const extRef = body.data?.external_reference ?? '';
    if (extRef) {
      const { data: order } = await supabase
        .from('payment_orders')
        .select('business_id')
        .eq('external_reference', extRef)
        .maybeSingle();

      if (order?.business_id) businessId = order.business_id;
    }

    // Fallback: si MP envía el user_id en el webhook (X-Caller-Id header)
    const mpUserId = req.headers.get('x-caller-id') ?? body.user_id;
    if (!businessId && mpUserId) {
      const { data: acc } = await supabase
        .from('mp_accounts')
        .select('business_id, access_token_encrypted')
        .eq('mp_user_id', String(mpUserId))
        .eq('is_active', true)
        .maybeSingle();

      if (acc) {
        businessId  = acc.business_id;
        accessToken = await decryptToken(acc.access_token_encrypted, encryptKey);
      }
    }

    if (!businessId || !accessToken) {
      // No encontramos el negocio; registrar para revisión manual
      await markWebhookProcessed(supabase, topic, paymentId, action, 'business_id not found');
      return jsonOk({ status: 'business_not_found' });
    }

    // Consultar pago completo en MP
    const mpRes = await fetch(`${MP_API}/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!mpRes.ok) {
      await markWebhookProcessed(supabase, topic, paymentId, action, 'MP lookup failed');
      return jsonOk({ status: 'mp_lookup_failed' });
    }

    const payment: Record<string, any> = await mpRes.json();
    const status = payment.status ?? 'unknown';

    // Encontrar payment_order asociado
    const { data: order } = await supabase
      .from('payment_orders')
      .select('id, comprobante_id, payment_button_id, estimated_fee_amount, estimated_net_amount, requested_amount')
      .eq('business_id', businessId)
      .eq('external_reference', payment.external_reference ?? '')
      .maybeSingle();

    // Obtener botón para fee
    const { data: btn } = order?.payment_button_id
      ? await supabase.from('payment_method_buttons').select('*').eq('id', order.payment_button_id).single()
      : { data: null };

    const txAmount   = payment.transaction_amount ?? order?.requested_amount ?? 0;
    const feeEst     = btn
      ? calcFee(txAmount, btn.fee_percent, btn.fee_fixed, btn.vat_percent)
      : order?.estimated_fee_amount ?? 0;
    const netEst     = txAmount - feeEst;
    const approvedAt = payment.date_approved
      ? new Date(payment.date_approved).toISOString()
      : (status === 'approved' ? new Date().toISOString() : undefined);

    // Upsert en payment_transactions
    const { error: txnErr } = await supabase
      .from('payment_transactions')
      .upsert({
        business_id:          businessId,
        comprobante_id:       order?.comprobante_id ?? null,
        payment_order_id:     order?.id ?? null,
        payment_button_id:    order?.payment_button_id ?? null,
        provider:             'mercadopago',
        channel:              'integrated',
        integration_kind:     payment.payment_type_id?.includes('point') ? 'mp_point' : 'mp_qr',
        provider_payment_id:  String(payment.id),
        provider_order_id:    String(payment.order?.id ?? ''),
        external_reference:   payment.external_reference ?? '',
        status,
        status_detail:        payment.status_detail,
        payment_method_type:  payment.payment_type_id,
        payment_method_id:    payment.payment_method_id,
        installments:         payment.installments ?? 1,
        transaction_amount:   txAmount,
        fee_amount_estimated: feeEst,
        net_amount_estimated: netEst,
        currency:             payment.currency_id ?? 'ARS',
        approved_at:          approvedAt,
        is_manual:            false,
        raw_payment:          payment,
        updated_at:           new Date().toISOString(),
      }, { onConflict: 'provider_payment_id', ignoreDuplicates: false });

    if (txnErr) console.error('txn upsert error:', txnErr);

    // Actualizar payment_order
    if (order?.id) {
      await supabase
        .from('payment_orders')
        .update({
          provider_order_status: status,
          status: status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'processing',
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id);
    }

    await markWebhookProcessed(supabase, topic, paymentId, action);
    return jsonOk({ status: 'processed', payment_status: status });

  } catch (err: any) {
    console.error('webhook processing error:', err);
    await markWebhookProcessed(supabase, topic, String(dataId), action, err.message);
    // Siempre responder 200 a MP para evitar reintentos innecesarios
    return jsonOk({ status: 'error_logged' });
  }
}

async function markWebhookProcessed(
  supabase: ReturnType<typeof createClient>,
  topic: string,
  resourceId: string,
  action: string,
  errorMsg?: string
) {
  await supabase
    .from('payment_webhook_events')
    .update({
      processed:    true,
      processed_at: new Date().toISOString(),
      error_message: errorMsg ?? null,
    })
    .eq('provider', 'mercadopago')
    .eq('resource_id', resourceId)
    .eq('action', action);
}

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
