import { createClient } from '@supabase/supabase-js'
import { test, expect } from '../m7/fixtures'
import { localSQL, localTarget } from './local'

const fixture = {
  owner: 'b4200000-0000-0000-0000-000000000001',
  business: 'b4200000-0000-0000-0000-000000000002',
  user: 'b4200000-0000-0000-0000-000000000003',
  customer: 'b4200000-0000-0000-0000-000000000004',
  inventory: 'b4200000-0000-0000-0000-000000000005',
  slug: 'h01-synthetic-portal',
  email: 'h01-portal@example.invalid',
  password: 'H01-local-only-Portal-934!',
  product: 'H01 synthetic product',
}

function finalState() {
  return JSON.parse(localSQL(`SELECT json_build_object(
    'orders', (SELECT count(*) FROM public.wholesale_orders WHERE business_id='${fixture.business}'),
    'events', (SELECT count(*) FROM public.customer_events WHERE business_id='${fixture.business}' AND event_type='whatsapp_order'),
    'linked', (SELECT count(*) FROM public.customer_events e JOIN public.wholesale_orders o ON o.id::text=e.metadata->>'order_id'
      WHERE e.business_id='${fixture.business}' AND e.customer_id='${fixture.customer}' AND o.customer_id=e.customer_id AND o.business_id=e.business_id),
    'total', (SELECT total FROM public.wholesale_orders WHERE business_id='${fixture.business}' LIMIT 1),
    'stock', (SELECT stock_quantity FROM public.inventory WHERE id='${fixture.inventory}'))`)) as {
      orders: number; events: number; linked: number; total: number; stock: number
    }
}

test.beforeAll(async () => {
  const target = localTarget()
  const admin = createClient(target.api, target.service, { auth: { persistSession: false, autoRefreshToken: false } })
  const result = await admin.auth.admin.createUser({ id: fixture.user, email: fixture.email, password: fixture.password, email_confirm: true })
  if (result.error) {
    const existing = await admin.auth.admin.getUserById(fixture.user)
    if (existing.error || existing.data.user?.email !== fixture.email) throw new Error('H01 synthetic local auth user could not be prepared.')
    const updated = await admin.auth.admin.updateUserById(fixture.user, { password: fixture.password, email_confirm: true })
    if (updated.error) throw new Error('H01 synthetic local auth user could not be updated.')
  }
  localSQL(`BEGIN;
    SET LOCAL session_replication_role=replica;
    INSERT INTO auth.users(id,email) VALUES('${fixture.owner}','h01-owner@example.invalid') ON CONFLICT(id) DO NOTHING;
    INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status,wholesale_portal_enabled,wholesale_portal_slug,wholesale_whatsapp)
      VALUES('${fixture.business}','H01 synthetic wholesaler','${fixture.owner}','full','active',true,'${fixture.slug}','5491100000000')
      ON CONFLICT(id) DO UPDATE SET subscription_plan='full',subscription_status='active',wholesale_portal_enabled=true;
    INSERT INTO public.profiles(id,user_id,business_id,role,is_active) VALUES('${fixture.owner}','${fixture.owner}','${fixture.business}','owner',true)
      ON CONFLICT(id) DO UPDATE SET business_id=EXCLUDED.business_id;
    INSERT INTO public.wholesale_customers(id,business_id,auth_user_id,name,email,approved,suspended,whatsapp)
      VALUES('${fixture.customer}','${fixture.business}','${fixture.user}','H01 synthetic customer','${fixture.email}',true,false,'1100000000')
      ON CONFLICT(id) DO UPDATE SET approved=true,suspended=false;
    INSERT INTO public.inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,precio_mayorista,visible_in_wholesale,is_active)
      VALUES('${fixture.inventory}','${fixture.business}','${fixture.product}','H01-SYNTHETIC','H01',10,10,20,100,75,true,true)
      ON CONFLICT(id) DO UPDATE SET stock_quantity=10,stock=10;
    COMMIT;`)
})

test.beforeEach(() => {
  localSQL(`BEGIN; DELETE FROM public.customer_events WHERE business_id='${fixture.business}';
    DELETE FROM public.wholesale_order_items WHERE business_id='${fixture.business}';
    DELETE FROM public.wholesale_orders WHERE business_id='${fixture.business}'; COMMIT;`)
})

test.afterAll(async () => {
  localSQL(`BEGIN; SET LOCAL session_replication_role=replica;
    DELETE FROM public.customer_events WHERE business_id='${fixture.business}';
    DELETE FROM public.wholesale_order_items WHERE business_id='${fixture.business}';
    DELETE FROM public.wholesale_orders WHERE business_id='${fixture.business}';
    DELETE FROM public.wholesale_customers WHERE id='${fixture.customer}';
    DELETE FROM public.inventory WHERE id='${fixture.inventory}';
    DELETE FROM public.profiles WHERE id IN('${fixture.owner}','${fixture.user}');
    DELETE FROM public.businesses WHERE id='${fixture.business}';
    DELETE FROM auth.users WHERE id='${fixture.owner}'; COMMIT;`)
  const target = localTarget()
  const admin = createClient(target.api, target.service, { auth: { persistSession: false } })
  const result = await admin.auth.admin.deleteUser(fixture.user)
  if (result.error) throw new Error('H01 synthetic local auth user cleanup failed.')
})

for (const telemetryFails of [false, true]) {
  test(`H01 real portal confirms one order and opens WhatsApp ${telemetryFails ? 'when tracking is denied' : 'with an owned event'}`, async ({ page, context }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    // A real popup still opens; its external destination is intercepted before
    // any network request, so WhatsApp never receives synthetic orders.
    await context.route('https://wa.me/**', route => route.fulfill({ contentType: 'text/html', body: '<p>H01 local WhatsApp destination</p>' }))
    if (telemetryFails) {
      await page.route('**/rest/v1/customer_events*', route => route.request().method() === 'POST'
        ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'H01_RAW_SENSITIVE_ERROR', details: fixture.email }) })
        : route.fallback())
    }
    await page.goto(`/mayorista/${fixture.slug}/login`)
    await page.getByPlaceholder('tu@email.com').fill(fixture.email)
    await page.locator('input[autocomplete="current-password"]').fill(fixture.password)
    await page.getByRole('button', { name: 'Ingresar', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/mayorista/${fixture.slug}/catalogo$`))
    await expect(page.getByText(fixture.product, { exact: true })).toBeVisible()
    await page.getByPlaceholder('Buscar producto...').fill(fixture.product)
    await page.locator('button').filter({ has: page.locator('svg.lucide-plus') }).click()
    await page.getByRole('button', { name: /Ver pedido/ }).click()
    const popupPromise = page.waitForEvent('popup')
    const telemetryResponse = page.waitForResponse(response => response.url().includes('/rest/v1/customer_events') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Enviar pedido por WhatsApp' }).click()
    await expect(page.getByRole('heading', { name: '¡Pedido enviado!' })).toBeVisible()
    expect((await telemetryResponse).status()).toBe(telemetryFails ? 403 : 201)
    const popup = await popupPromise
    await popup.waitForURL('https://wa.me/**')
    const destination = new URL(popup.url())
    expect(destination.hostname).toBe('wa.me')
    expect(destination.pathname).toBe('/5491100000000')
    expect(destination.searchParams.get('text')).toContain(fixture.product)
    await expect.poll(finalState, { message: 'the real backend persists the confirmed order and its owned telemetry' })
      .toEqual({ orders: 1, events: telemetryFails ? 0 : 1, linked: telemetryFails ? 0 : 1, total: 75, stock: 10 })
    await expect(page.getByRole('button', { name: 'Enviar pedido por WhatsApp' })).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath(telemetryFails ? 'confirmed-order-tracking-denied.png' : 'confirmed-order-owned-event.png'), fullPage: true })
    await page.reload()
    await expect(page.getByText('Tu pedido está vacío.')).toBeVisible()
    expect(finalState().orders).toBe(1)
    await expect(page.locator('body')).not.toContainText(/H01_RAW_SENSITIVE_ERROR|42501|row.level security/)
    expect(errors).toEqual([])
  })
}
