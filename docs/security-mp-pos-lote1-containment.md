# Lote 1 — Mercado Pago POS Connect: POST-BETA

## Baseline and classification (before implementation, 2026-08-31)

- `origin/main`: `89d686b44cbca7e7acc67da77ac9335c8703035d` after fetch, as expected.
- Original checkout: `70a2d181384e72d028d8c808f6e99b2061d21438`; its untracked discovery/mobile evidence is preserved.
- Isolated branch: `codex/mp-pos-beta-containment`, worktree `techrepair-mp-pos-beta`.
- Production project: `vrdxxmjzxhfgqlnxmbwx`. Read-only catalog inspection; no credential values selected.

| Surface | Path | Runtime / purpose | Classification | Beta reachable before |
| --- | --- | --- | --- | --- |
| Connect/status/refresh/disconnect/callback | `supabase/functions/mp-oauth/index.ts` | Edge: merchant OAuth and token storage | MP_POS_CONNECT | YES: ACTIVE v4, verify_jwt=false |
| QR/Point/lookup/refund/POS webhook | `supabase/functions/mp-payments/index.ts` | Edge: reads merchant tokens, calls MP and writes payment orders/transactions | MP_POS_CONNECT | YES: ACTIVE v5, verify_jwt=false |
| Legacy create_manual action | Same endpoint | Old payment_transactions writer; no active frontend consumer | MP_POS_CONNECT (legacy transport) | Endpoint reachable; not the current manual POS contract |
| Merchant credentials | `public.mp_accounts`; baseline migration | PostgREST table; encrypted access/refresh tokens and merchant binding | MP_POS_CONNECT | YES: authenticated SELECT USING(true), all table privileges; 1 existing row |
| Direct merchant RPC/view | Production catalog and active migrations | No routines referencing mp_accounts or dependent views found; only updated_at trigger | MP_POS_CONNECT | None found |
| Old payment panel | `src/components/payments/PaymentButtonsPanel.tsx` | Calls status/create_qr/create_point/create_manual; no import/mount anywhere in src | MP_POS_CONNECT | Unmounted, but retained executable source |
| Payment configuration | `src/components/payments/PaymentMethodSettings.tsx`, `/settings` | Manual buttons plus integrated channel/kind selectors | SHARED_INFRASTRUCTURE | YES: integrated controls remain |
| Button CRUD/defaults/calculator | `src/services/paymentButtonService.ts`, `paymentCalculator.ts`; `create_default_payment_buttons` | Manual provider/fees and historical integration metadata | SHARED_INFRASTRUCTURE | YES; production: 20 MP manual/none + 10 manual manual/none |
| Active POS | `ComprobanteProModal.tsx`, `Comprobante.tsx`, `usePaymentCommissions.ts`, `comprobanteService.ts` | Dynamic commissions/manual tender → comprobante_payments → DB Caja/finance synchronization | MP_MANUAL_PAYMENT_METHOD | YES, preserve |
| Financial labels | `src/lib/finance/chartsL1Presentation.ts`; payment normalization migrations/tests | Display/normalize manual payment methods | MP_MANUAL_PAYMENT_METHOD | YES, preserve |
| Sales-point MP metadata | `public.sales_points.mp_*`; `get_active_sales_point`; `salesPointService.ts`, Settings | Historical merchant/terminal flags; active frontend reads ordinary local PV fields | SHARED_INFRASTRUCTURE | Metadata exists, no MP execution; RPC already service-only |
| POS payment records/webhook records | `payment_orders`, `payment_transactions`, `payment_webhook_events`, `v_payment_analytics`; related triggers | Historical records; not merchant OAuth/token access | SHARED_INFRASTRUCTURE | Preserve records/financial behavior; retired Edge is operational consumer |
| Merchant callback/deep links | `/mp/callback` documented by old Edge; App router; `/configuracion/pagos` legacy link | No callback component or route exists | MP_POS_CONNECT | No matching merchant route; now explicit `/mp/*` redirect to landing |
| Legacy tutorial | `_TutorialMercadoPagoLegacy` in `src/pages/Tutorials.tsx` | Unregistered tutorial; registry contains ARCA, no MP entry | MP_POS_CONNECT | Not navigable; historical content retained |
| Subscription API | `supabase/functions/mp-subscription/index.ts` | SaaS checkout, cancellation, status, payment-method link | MP_SAAS_BILLING | YES: ACTIVE v26, verify_jwt=false; preserve source/deployment |
| Subscription webhook | `supabase/functions/mp-webhook/index.ts` | Global MP_ACCESS_TOKEN; payments/subscription events/business plan updates | MP_SAAS_BILLING | YES: ACTIVE v20, verify_jwt=false; preserve source/deployment |
| Billing frontend | `subscriptionService.ts`, `useSubscription.ts`, `Subscription*`, Plans, PaymentPending, AdminSubscriptions, types, `mpStatus.ts` | `/subscription` and child routes, SaaS admin | MP_SAAS_BILLING | YES, preserve |
| Billing tables/RPC/tests | subscription tables, businesses billing columns, payments, process_mp_subscription_payment; billing tests | SaaS plan accounting/entitlements | MP_SAAS_BILLING | YES, outside this lot |
| Portal projection | `portalPublicContract.ts`, `portalService.ts`, portal SQL | Restricts public projection of businesses including billing fields | SHARED_INFRASTRUCTURE | Preserve |
| Shared secrets/infrastructure | MP_WEBHOOK_SECRET (both old POS and billing), SUPABASE_*, APP_URL; auth callbacks | Configuration and application authentication | SHARED_INFRASTRUCTURE | Preserve; no secret changes |
| Historical setup/docs | `supabase/_archive/loose-scripts/{payments,payments_architecture,mp_local_integration}.sql`, legacy migrations, billing/CORS audit docs | Historical contracts, not active deployment entrypoints | Mixed, as described above | Historical only; retain with current scope notice |

Searches covered src, functions, active/legacy migrations, tests, docs, scripts, routes/sidebar/settings and all requested token/merchant/terminal names. Generic auth/connect/callback hits also include Supabase login, WhatsApp, ARCA and Realtime: these are unrelated shared infrastructure, not merchant connection. No UNKNOWN surface is being disabled.

## Confirmed original findings

`mp-oauth` builds base64 JSON state from caller business_id; callback skips user auth, decodes state without cryptographic binding, exchanges code and service-role upserts mp_accounts. `mp-payments` authenticates a user but accepts caller business_id to read/decrypt merchant credentials; webhook also discovers accounts. These architectures are retired, not repaired. No real account was exploited.

## Preservation boundaries

Mercado Pago POS / Merchant Connect is POST-BETA. SaaS Billing via mp-subscription and mp-webhook remains in Beta. Manual MP tender records remain in Beta and require no OAuth or MP API.

Billing has no imports from the retired functions, no mp_accounts dependency and no merchant callback dependency. MP_ACCESS_TOKEN and plan secrets are independent from merchant token encryption; the shared webhook secret is unchanged. Existing billing authorization findings (including status/update-payment-method caller business lookup) are **KNOWN — LOTE BILLING**, not fixed here.

No token deletion, credential rotation, secret changes or destructive data migration is authorized by this implementation. The dedicated permissions migration must preserve the existing row and ciphertext byte-for-byte.

## Changes and pre-deploy gate

- Both Edge entrypoints register `_shared/mpPosBetaDisabled.ts`: OPTIONS 204; every operational request 410 with only `{success:false,error:"FEATURE_NOT_AVAILABLE"}`. No request parsing, environment access, authentication calls, DB client, token processing, imports of provider clients, or outbound fetch.
- Explicit verify_jwt=false matches production and lets even anonymous callbacks receive the inert 410. It does not authorize an operation.
- Legacy PaymentButtonsPanel is inert even if imported/mounted later. Current POS does not use it.
- Settings retain manual MP provider/buttons and remove integrated selectors/badges; historical integrated records are not deleted or converted. `/mp/*` redirects to landing for every caller/plan.
- Migration `20260906120000_mp_pos_beta_containment.sql` revokes all table AND column grants from PUBLIC/anon/authenticated, removes the broad select policy and adds restrictive deny-all RLS. Service access and historical data remain. No other tables/RPCs/triggers are changed.
- No frontend/commercial entitlement flag can turn the server operation back on.

## Local validation (2026-08-31)

| Gate | Result |
| --- | --- |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint:errors` | PASS |
| Node tests: containment, billingContracts, mpSubscriptionCors, mpStatus, posSettlement, paymentSurcharge, checkoutIdempotency, replacePaymentIdempotency, orderPaymentMixedIdempotency | 120 PASS, zero skipped |
| Containment entrypoint tests | Both actual entrypoints register the inert handler; 900 combinations of methods/actions/caller headers/state plus malformed bodies; zero fetch calls, zero environment reads, zero body reads |
| Vitest containment + cajaCapabilityGate | 13 PASS; containment rerun after fixture cleanup |
| `node scripts/guards/mp-pos-beta-sql.mjs` | PASS; local Docker only, synthetic non-empty account fixture, SELECT/INSERT/UPDATE/UPSERT/DELETE denial, column grants, restrictive RLS under restored grants, row/ciphertext fingerprint preservation, full rollback |
| Existing SQL billing_grants and billing_security | PASS (7 grant + 14 security checks), full rollback |
| E2E mp-pos-beta | 2 PASS: real local authenticated manual MP sale creates one payment and positive Caja/finance income; no provider/retired endpoint requests; direct callback redirect and Plans UI reachable |
| Existing E2E pos-mobile-layout | 4 PASS: desktop/mobile × light/dark |
| `deno check` both Edge entrypoints | PASS |
| `npm.cmd run build` | PASS; existing chunk-size/mixed-import warnings only |
| `git diff --check` | PASS |

The first new E2E run completed the manual sale but its verification query used an incorrect table name. Corrected the test to the actual ledgers (`financial_movements` for Caja, `business_finance_entries` for Finance); rerun passed. No application financial logic was changed to obtain a pass.

Local E2E used the repository's marker, bundle-target and tenant-isolation guards against `127.0.0.1:54421`, with no managed Supabase requests. Only synthetic local sales were created. Layout screenshots remain local in `playwright-report/mp-pos-visual`; existing versioned evidence was not replaced.

## Deployment status

Pending review/rollout. Source changes alone are not proof of production containment. The deployment must apply only the dedicated permissions migration and two POS Edge stubs, then frontend via its normal pipeline. Do not redeploy mp-subscription/mp-webhook or alter secrets. Production negative smokes and preserved deployment metadata are required before declaring closure.
