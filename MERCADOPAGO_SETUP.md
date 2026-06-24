# TechRepair Pro — Guía de Configuración Mercado Pago

## 1. Crear cuenta en Mercado Pago Developers

1. Ir a https://www.mercadopago.com.ar/developers/es/
2. Ingresar con tu cuenta de MP o crear una
3. Crear una **aplicación** desde el panel de developers

---

## 2. Obtener credenciales

En el panel de tu aplicación → **Credenciales**:

| Variable           | Dónde encontrarla             |
|--------------------|-------------------------------|
| `MP_ACCESS_TOKEN`  | Credenciales → Access Token   |
| `MP_PUBLIC_KEY`    | Credenciales → Public Key (frontend, si necesitás) |

**Importante:** Usá las credenciales de **prueba** (TEST-...) para desarrollo
y las de **producción** (APP_USR-...) solo en producción.

---

## 3. Crear Planes de Suscripción en MP

Ve a **tu panel MP → Suscripciones → Planes de suscripción** → **Nuevo plan**

Crear 9 planes (3 planes × 3 ciclos):

| Plan    | Ciclo       | Precio ARS | Frecuencia |
|---------|-------------|------------|------------|
| Básico  | Mensual     | $15.000    | 1 mes      |
| Básico  | Trimestral  | $39.000    | 3 meses    |
| Básico  | Anual       | $144.000   | 12 meses   |
| Pro     | Mensual     | $25.000    | 1 mes      |
| Pro     | Trimestral  | $64.500    | 3 meses    |
| Pro     | Anual       | $240.000   | 12 meses   |
| Full    | Mensual     | $45.000    | 1 mes      |
| Full    | Trimestral  | $117.000   | 3 meses    |
| Full    | Anual       | $432.000   | 12 meses   |

Cada plan creado tiene un ID que empieza con `2c938084...`

> ⚠️ **Fuente de verdad del importe cobrado.** El monto que realmente se cobra lo
> define el **plan de Mercado Pago** (panel MP), NO el frontend. Los precios de
> arriba DEBEN coincidir exactamente con `src/types/subscription.ts` (`PLANS`),
> que es lo que ve el usuario. Si actualizás precios, hacelo en AMBOS lugares.
> (Corrección 2026-06-23: esta tabla tenía precios viejos $4.900/$9.900/$19.900
> que no coincidían con los $15.000/$25.000/$45.000 mostrados al usuario.)

---

## 4. Variables de entorno — Frontend (.env.local)

Crear archivo `.env.local` en la raíz del proyecto:

```env
VITE_SUPABASE_URL=https://vrdxxmjzxhfgqlnxmbwx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...

# IDs de planes de Mercado Pago (de paso 3)
VITE_MP_PLAN_BASICO_MONTHLY=2c938084xxxxxxxxxx
VITE_MP_PLAN_BASICO_QUARTERLY=2c938084xxxxxxxxxx
VITE_MP_PLAN_BASICO_ANNUAL=2c938084xxxxxxxxxx

VITE_MP_PLAN_PRO_MONTHLY=2c938084xxxxxxxxxx
VITE_MP_PLAN_PRO_QUARTERLY=2c938084xxxxxxxxxx
VITE_MP_PLAN_PRO_ANNUAL=2c938084xxxxxxxxxx

VITE_MP_PLAN_FULL_MONTHLY=2c938084xxxxxxxxxx
VITE_MP_PLAN_FULL_QUARTERLY=2c938084xxxxxxxxxx
VITE_MP_PLAN_FULL_ANNUAL=2c938084xxxxxxxxxx
```

> Los IDs de plan son solo para mostrar precios en frontend. El backend
> los resuelve por sus propios secrets (ver sección 5).

---

## 5. Secrets de Supabase Edge Functions

Instalar Supabase CLI si no lo tenés:
```bash
npm install -g supabase
supabase login
supabase link --project-ref vrdxxmjzxhfgqlnxmbwx
```

Cargar los secrets:
```bash
supabase secrets set \
  MP_ACCESS_TOKEN="APP_USR-XXXX-XXXX-XXXX-XXXX" \
  MP_WEBHOOK_SECRET="tu-webhook-secret-de-mp" \
  APP_URL="https://techrepairpro-nine.vercel.app" \
  MP_PLAN_BASICO_MONTHLY="2c938084xxxxxxxxxx" \
  MP_PLAN_BASICO_QUARTERLY="2c938084xxxxxxxxxx" \
  MP_PLAN_BASICO_ANNUAL="2c938084xxxxxxxxxx" \
  MP_PLAN_PRO_MONTHLY="2c938084xxxxxxxxxx" \
  MP_PLAN_PRO_QUARTERLY="2c938084xxxxxxxxxx" \
  MP_PLAN_PRO_ANNUAL="2c938084xxxxxxxxxx" \
  MP_PLAN_FULL_MONTHLY="2c938084xxxxxxxxxx" \
  MP_PLAN_FULL_QUARTERLY="2c938084xxxxxxxxxx" \
  MP_PLAN_FULL_ANNUAL="2c938084xxxxxxxxxx"
```

> `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` son auto-inyectados
> por Supabase — no hace falta setearlos manualmente.

---

## 6. Deploy de Edge Functions

> ⚠️ **`mp-webhook` DEBE deployarse con `verify_jwt = false`.** Mercado Pago llama
> al webhook SIN un JWT de Supabase; su seguridad es la **firma HMAC** (`x-signature`),
> no el JWT. Si se deploya con `verify_jwt = true`, el gateway de Supabase rechaza
> (401) las llamadas de MP **antes** de llegar a la función → el webhook nunca procesa
> (esto pasó en producción: `subscription_events`/`payments` quedaron vacíos hasta el
> 2026-06-23, cuando se corrigió a `verify_jwt=false` en la versión 18).
> `mp-subscription` también va con `verify_jwt = false` (hace su propio `getAuthUser`).

Para que el flag sea **reproducible** en `supabase functions deploy`, declararlo en
`supabase/config.toml`:

```toml
[functions.mp-webhook]
verify_jwt = false

[functions.mp-subscription]
verify_jwt = false
```

```bash
supabase functions deploy mp-subscription   # verify_jwt=false
supabase functions deploy mp-webhook         # verify_jwt=false (NUNCA true)
```

Si se deploya desde el dashboard, dejar **"Verify JWT" apagado** en ambas funciones.

Las URLs resultantes son:
- `https://vrdxxmjzxhfgqlnxmbwx.supabase.co/functions/v1/mp-subscription`
- `https://vrdxxmjzxhfgqlnxmbwx.supabase.co/functions/v1/mp-webhook`

---

## 7. Correr la migración SQL

En el panel Supabase → **SQL Editor**, pegar y ejecutar el contenido de:
```
supabase/migrations/20260416_mercadopago_subscriptions.sql
```

O con CLI:
```bash
supabase db push
```

---

## 8. Configurar Webhook en Mercado Pago

1. Panel MP → **Tu aplicación** → **Webhooks** → **Agregar webhook**
2. URL: `https://vrdxxmjzxhfgqlnxmbwx.supabase.co/functions/v1/mp-webhook`
3. Eventos a suscribir:
   - ✅ `payment`
   - ✅ `subscription_preapproval`
   - ✅ `subscription_authorized_payment`
4. Copiar el **Webhook secret** que genera MP y setearlo como `MP_WEBHOOK_SECRET` en el paso 5

---

## 9. Flujo completo de suscripción

```
Usuario elige plan
    ↓
Frontend llama mp-subscription (action: create)
    ↓
Edge Function crea preapproval en MP con el plan ID
    ↓
MP devuelve init_point (URL de checkout)
    ↓
Frontend redirige usuario a init_point
    ↓
Usuario ingresa tarjeta en checkout de MP
    ↓
MP redirige a /subscription/pending (back_url)
    ↓
[Pantalla de espera — polling cada 5 segundos]
    ↓
MP llama nuestro webhook (subscription_preapproval, status=authorized)
    ↓
Webhook verifica firma, consulta MP, actualiza businesses.subscription_status = 'active'
    ↓
Supabase realtime notifica al frontend
    ↓
PaymentPending detecta que isActive=true → redirige a /subscription
```

---

## 10. Flujo de cobro recurrente (cada período)

```
MP procesa cobro automático (fin del período)
    ↓
MP llama webhook (subscription_authorized_payment)
    ↓
Webhook busca authorized_payment (status: processed/scheduled/recycling/cancelled)
    ↓
Webhook busca /v1/payments/{payment_id} para status real (approved/rejected)
    ↓
Si approved → subscription_status = active, actualiza current_period_end
Si rejected → subscription_status = past_due, grace_until = now + 3 días
    ↓
Si vence grace_until sin pago → subscription_status = suspended
(Ejecutar expire_trials() y enforce_grace_period() via cron o pg_cron)
```

---

## 11. Cron job para expirar pruebas y gracia

Agregar en Supabase → **Database → Extensions**: habilitar `pg_cron`

```sql
-- Ejecutar cada día a las 3 AM
SELECT cron.schedule('expire-trials', '0 3 * * *', $$SELECT public.expire_trials();$$);
SELECT cron.schedule('enforce-grace', '0 3 * * *', $$SELECT public.enforce_grace_period();$$);
```

---

## 12. Testing con credenciales de prueba

MP provee tarjetas de prueba para Argentina:

| Tarjeta     | Número               | CVV  | Vencimiento |
|-------------|----------------------|------|-------------|
| Visa (éxito) | 4509 9535 6623 3704 | 123  | 11/25       |
| Mastercard   | 5031 7557 3453 0604 | 123  | 11/25       |
| Rechazo      | 4000 0000 0000 0002 | 123  | 11/25       |

Email del pagador de prueba: `test_user_XXXXXXXX@testuser.com`
(MP te da estos emails al crear usuarios de prueba en el panel)

---

## 13. Verificar integración

Checklist:
- [ ] Migración SQL ejecutada correctamente
- [ ] Edge functions deployadas y accesibles
- [ ] Webhook configurado en panel MP con los 3 eventos
- [ ] `MP_WEBHOOK_SECRET` seteado en secrets y en panel MP
- [ ] Probar flujo completo con tarjeta de prueba
- [ ] Verificar que `businesses.subscription_status` cambia a `active` post-pago
- [ ] Verificar que el webhook llega y se procesa en `subscription_events`
- [ ] Verificar que el banner de suscripción aparece en la UI correctamente
