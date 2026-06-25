# Edge Functions — CORS / `verify_jwt` Audit (remaining functions)

Pre-work classification for the functions **not** touched by `stable-afip-cors-v1`.
Purpose: decide per-flow whether to scope CORS to the allowlist (the
[deployment doc](EDGE_FUNCTIONS_DEPLOYMENT.md) pattern), **before** changing
anything. **No code in these functions has been modified.** Do not apply the
allowlist pattern in bulk — each flow is different.

Project ref: `vrdxxmjzxhfgqlnxmbwx`. `verify_jwt` values below are the live
platform settings (via `list_edge_functions`).

## Classification summary

| Function | Class | CORS today | `verify_jwt` | In-function auth | Needs browser CORS? | Recommended action | Risk |
|----------|-------|-----------|--------------|------------------|---------------------|--------------------|------|
| `mp-payments` | **dual**: authed browser + public MP webhook | `*` | false | `auth.getUser()` for user actions; HMAC `x-signature` for webhook | Yes (browser path) | Scope **origin** to allowlist; **keep** `x-signature`,`x-request-id` in allow-headers (webhook); keep `verify_jwt=false` | **Medium** — shared handler; mis-scoping could break POS QR/Point/refund or the webhook |
| `mp-oauth` | **dual**: authed browser + public OAuth `callback` | `*` | false | `auth.getUser()` except `action=callback` (validates `state`) | Yes (connect/status/disconnect/refresh) | Scope origin to allowlist; keep `verify_jwt=false` (callback has no JWT) | **Medium** — breaking `callback` breaks MP account linking |
| `whatsapp-send` | authed browser | `*` | **true** | `auth.getUser()` + active-profile check | Yes | Scope origin to allowlist; keep `verify_jwt=true` | **Low** — clean single-purpose, mirrors afip-cae |
| `whatsapp-send-message` | authed browser | `*` | **true** | **none** (relies only on gateway `verify_jwt`) | Yes | Scope origin to allowlist; keep `verify_jwt=true`. **Also flag:** add business-membership check (see Risks) | **Low** for CORS; **separate security gap** noted below |
| `whatsapp-embedded-signup` | **disabled / legacy** | `*` | false | none (always returns `503`) | No (cosmetic) | Optional: scope origin for consistency, or leave. Lowest priority | **Very low** — always 503 |
| `mp-webhook` | **server-to-server** (MP only) | none (no CORS) | false | mandatory HMAC signature | **No** | **Do NOT add CORS.** Leave as-is | n/a — adding CORS would be misleading |
| `_shared/cors.ts` | shared module | `*` | n/a | n/a | depends on consumer | Only consumer is `get-dolar-cordoba` (NOT the 5 above). Decide with that function | **Low** — narrow blast radius |

> **Important:** the five `*` functions each declare `corsHeaders` **inline**.
> None import `_shared/cors.ts`. Fixing `_shared/cors.ts` does **not** change any
> of them; it only affects `get-dolar-cordoba`. Conversely, scoping the five
> requires editing each file individually.

## Per-function detail

### `mp-payments` — dual (browser POS + MP webhook)
- **Flows:** `create_qr`, `create_point`, `create_manual`, `lookup`, `refund` are
  called from the authenticated frontend (`src/components/payments/PaymentButtonsPanel.tsx`).
  `action=webhook` / any request with `x-signature` is MP server-to-server.
- **Valid origins (browser path):** `https://www.techrepairpro.app`, `https://techrepairpro.app` (+ `MP_CORS_ORIGIN`/`APP_URL`).
- **Methods/headers:** `POST, OPTIONS`; allow-headers must retain `x-signature`,
  `x-request-id` (MP webhook) plus the standard set incl. `cache-control`,`pragma`.
- **`verify_jwt`:** must stay **false** (webhook carries no Supabase JWT; user
  actions are authed in-function via `auth.getUser()`).
- **Risk:** Medium. One handler serves both browser and MP. CORS only affects the
  browser path (servers ignore it), so scoping origin is safe — but test both.
- **Tests:** OPTIONS preflight (www/apex/denied); POST `create_qr` from browser
  with JWT; simulated MP webhook POST with valid `x-signature` still processed.

### `mp-oauth` — dual (browser + OAuth callback)
- **Flows:** `connect`, `status`, `disconnect`, `refresh` are authed browser calls;
  `action=callback` is reached after MP redirects to `MP_REDIRECT_URI` and has **no**
  JWT (it validates the `state` param instead).
- **Valid origins:** same allowlist. The `callback` is typically a same-origin
  frontend route that then calls the function, so the allowlist covers it.
- **`verify_jwt`:** must stay **false** (callback is unauthenticated).
- **Risk:** Medium — breaking `callback` breaks MP account connection.
- **Tests:** OPTIONS preflight; `connect` with JWT returns `auth_url`; `callback`
  with a forged/short `state` still returns 400 (no regression); end-to-end connect.

### `whatsapp-send` — authed browser (clean)
- **Flow:** `src/services/whatsappService.ts` → free-text send. Does `auth.getUser()`
  + active-profile membership check. Credentials resolved server-side from Vault.
- **`verify_jwt`:** **true** (gateway + in-function defense in depth). Keep it.
- **Risk:** Low. Best candidate to migrate first — structurally identical to `afip-cae`.
- **Tests:** OPTIONS preflight (www/apex/denied); authed POST happy path; 401 without JWT.

### `whatsapp-send-message` — authed browser (template send)
- **Flow:** `src/services/whatsappCloudService.ts` → `test` / `template` actions.
- **`verify_jwt`:** **true** — and this is the **only** authorization. Unlike
  `whatsapp-send`, it does **not** verify the caller belongs to `business_id`; it
  loads the connection by `business_id` with the service role and sends.
- **Risk:** Low for CORS. **Separate security gap (out of scope here):** any
  authenticated user could trigger a send for an arbitrary `business_id`. Recommend
  adding the same profile-membership check as `whatsapp-send`. Track separately.
- **Tests:** OPTIONS preflight; authed `test` send; (after the auth fix) cross-business
  `business_id` is rejected 403.

### `whatsapp-embedded-signup` — disabled / legacy
- **Flow:** always returns `503 META_EMBEDDED_SIGNUP_NOT_CONFIGURED`. Invoked from
  `whatsappCloudService.ts` but intentionally inert pending the v4 rewrite.
- **`verify_jwt`:** false. **Action:** lowest priority; scoping origin is cosmetic
  while it only emits 503. Revisit when the v4 flow lands.

### `mp-webhook` — server-to-server (leave alone)
- **Flow:** MP → webhook only. No `corsHeaders` in the file (correct). Mandatory
  HMAC signature; missing secret → 500, bad signature → 401.
- **Action:** **Do NOT add CORS.** Browsers never call it; adding ACAO would imply
  a browser contract that does not exist.

### `_shared/cors.ts`
- **Consumers:** only `get-dolar-cordoba` (confirmed by grep). Currently `*`.
- **Action:** evaluate together with `get-dolar-cordoba` (is it browser-facing?
  public? cacheable?). Not a dependency of the five functions above.

## Suggested rollout order (when approved)

1. `whatsapp-send` (lowest risk, clean single-purpose) — prove the pattern.
2. `mp-oauth`, then `mp-payments` (dual flows — test browser **and** callback/webhook each).
3. `whatsapp-send-message` (bundle with the missing membership-check fix).
4. `_shared/cors.ts` + `get-dolar-cordoba` (separate evaluation).
5. `whatsapp-embedded-signup` — optional/cosmetic until the v4 rewrite.

Deploy each preserving its `verify_jwt` flag exactly (see
[EDGE_FUNCTIONS_DEPLOYMENT.md](EDGE_FUNCTIONS_DEPLOYMENT.md)); never deploy the
five as a single batch without per-flow smoke tests.
