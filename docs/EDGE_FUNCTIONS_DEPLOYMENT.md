# Edge Functions — Deployment & CORS

Reproducible deployment notes for the AFIP / CSR edge functions and the CORS
contract they must satisfy. Supabase project ref: `vrdxxmjzxhfgqlnxmbwx`.

> `supabase/config.toml` explicitly sets `verify_jwt = true` for `afip-wsaa`
> and `afip-cae`. Deploy from the repository root, never pass `--no-verify-jwt`
> for these two functions, and confirm the deployed metadata after every release.
> Gateway JWT verification supplements the in-function authorization; it does
> not establish business membership or fiscal authority.

## verify_jwt per function

| Function       | `verify_jwt` | Why |
|----------------|--------------|-----|
| `afip-cae`     | **true**     | Verifies the user, active canonical membership and `comprobantes`; scopes the emission attempt to that business before its internal WSAA call. |
| `afip-wsaa`    | **true**     | Direct users need active canonical membership, matching business and `settings_sensitive`; they receive presence flags only. Trusted internal callers authenticate with the exact configured service credential and retain the token/sign contract. |
| `generate-csr` | **false**    | **RETIRED (AFIP-S4B-1).** Fail-closed stub: every operational call returns `410 LEGACY_CSR_FLOW_RETIRED`. It generates no key, writes nothing, and touches no fiscal data. `verify_jwt` stays `false` so the browser preflight still reaches the function and the client gets a clear message instead of an opaque gateway error. Replaced by `arca-rotate-prepare`. |
| `arca-rotate-prepare` | **true** | Secure certificate-rotation preparation (AFIP-S4A). Generates the new RSA key server-side, stores it in Vault as `pending_rotation`, and returns only the public CSR. Also does in-function JWT auth + owner/admin membership check; the gateway flag is an extra layer. |

OPTIONS preflight is exempt from gateway JWT verification regardless of the flag,
so CORS works with both `true` and `false`.

## Exact deploy commands

Run from the repo root with the Supabase CLI authenticated (`supabase login`).

```bash
# afip-cae — keep verify_jwt=true → NO --no-verify-jwt flag
supabase functions deploy afip-cae --project-ref vrdxxmjzxhfgqlnxmbwx

# afip-wsaa — keep verify_jwt=true → NO --no-verify-jwt flag
supabase functions deploy afip-wsaa --project-ref vrdxxmjzxhfgqlnxmbwx

# generate-csr — RETIRED stub, keep verify_jwt=false
supabase functions deploy generate-csr --no-verify-jwt --project-ref vrdxxmjzxhfgqlnxmbwx

# arca-rotate-prepare — keep verify_jwt=true → NO --no-verify-jwt flag
supabase functions deploy arca-rotate-prepare --project-ref vrdxxmjzxhfgqlnxmbwx
```

After deploying, confirm the flags stuck:

```bash
supabase functions list --project-ref vrdxxmjzxhfgqlnxmbwx -o json
# or, with the Supabase MCP, list_edge_functions → check each "verify_jwt"
```

## CORS contract

These functions centralize CORS through `buildCorsHeaders(req)` + `jsonResponse(req, body, status)`
(reference implementation: `supabase/functions/mp-subscription/index.ts`).

**Allowed origins** — exact allowlist, echo only the matched `Origin`:

- `https://www.techrepairpro.app`
- `https://techrepairpro.app` (apex; 307-redirects to `www` on Vercel)
- plus any value in the `MP_CORS_ORIGIN` / `APP_URL` secrets (comma-separated supported)

Rules:

- **NEVER** use `Access-Control-Allow-Origin: '*'` in these functions — they are
  authenticated / handle fiscal data.
- **NEVER** reintroduce the old preview origin
  `https://tech-repair-pro-molinajonyy-hubs-projects.vercel.app` (this was the bug:
  a stale Vercel domain that failed the preflight for real users).
- No canonical fallback: a non-allowlisted origin gets **no** `Access-Control-Allow-Origin`
  header at all (the browser then blocks the read — fail closed).
- Reflect only the intersection of `Access-Control-Request-Headers` against the
  explicit header allowlist, which **must** include `cache-control` and `pragma`
  (Chrome adds them on a hard reload / Ctrl+Shift+R; omitting them breaks the preflight).
- Always send `Access-Control-Allow-Methods: POST, OPTIONS`,
  `Access-Control-Max-Age`, and `Vary: Origin, Access-Control-Request-Headers`.

## Smoke test (production OPTIONS preflight)

```bash
BASE=https://vrdxxmjzxhfgqlnxmbwx.supabase.co/functions/v1

# 1) Allowed origin (www) → expect 204 + ACAO echoes www, allow-headers includes cache-control
curl -s -i -X OPTIONS "$BASE/afip-cae" \
  -H "Origin: https://www.techrepairpro.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization, content-type, cache-control, pragma"

# 2) Allowed origin (apex) → expect 204 + ACAO echoes apex
curl -s -i -X OPTIONS "$BASE/afip-cae" \
  -H "Origin: https://techrepairpro.app" \
  -H "Access-Control-Request-Method: POST"

# 3) Disallowed origin → expect 204 with NO access-control-allow-origin header
curl -s -i -X OPTIONS "$BASE/afip-cae" \
  -H "Origin: https://evil.example.com" \
  -H "Access-Control-Request-Method: POST"
```

Repeat (1) and (3) for `afip-wsaa` and `generate-csr`.

## Verifying deployed source matches the repo

```bash
# Download the live source into a temp dir and diff against the working tree
supabase functions download afip-cae --project-ref vrdxxmjzxhfgqlnxmbwx   # writes ./supabase/functions/afip-cae/index.ts
# compare with git diff --no-index (normalize CRLF/LF first on Windows)
```

The Supabase MCP `get_edge_function` also returns the deployed file contents for
a direct comparison. Note `ezbr_sha256` from `list_edge_functions` is the bundle
hash, not a raw-source hash — compare file contents, not that value.
