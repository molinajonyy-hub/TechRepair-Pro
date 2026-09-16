# BETA-GATE-1 · Lote A — CORS fail-closed en la renovación ARCA

**Base:** `origin/main` `a120a1e` (tag `stable-arca-selfservice-phase2b-v1`).
**Alcance:** `arca-rotate-prepare` y `arca-rotate-activate`. Nada más.

## 1. Qué estaba mal

Las dos funciones armaban el header así (deuda de ARCA Phase 0, anterior a `_shared/scopedCors.ts`):

```ts
const origin = req.headers.get('Origin') ?? '*'
return { 'Access-Control-Allow-Origin': origin, ... }
```

Es **reflejo ciego** con fallback a wildcard: cualquier origen recibía permiso para leer la respuesta, y un
request sin `Origin` recibía `*`. En un endpoint con credenciales el reflejo es **peor** que el wildcard,
porque el navegador sí expone el cuerpo a ese origen.

No era un bypass: la autoridad real (JWT del usuario, perfil activo, owner/admin, `settings_sensitive`,
`is_business_owner_or_admin` en SQL y las RPC `service_role`) nunca dependió de CORS, y ninguna de las dos
funciones se llama desde el navegador. Era superficie abierta sin necesidad.

## 2. Qué cambia

- Las dos responden CORS por `_shared/scopedCors.ts`: allowlist **exacta**
  (`https://www.techrepairpro.app`, `https://techrepairpro.app`, más lo que agregue `APP_URL`), sin wildcard,
  sin reflejo. Un origen no autorizado **no recibe** `Access-Control-Allow-Origin`.
- `OPTIONS` sigue respondiendo 204 con `Allow-Methods: POST, OPTIONS`, `Max-Age` y `Vary`, y los
  request-headers se devuelven como intersección con la allowlist (nunca `*`).
- Se retira `buildCorsHeaders` de `arca-rotate-activate/validate.ts`; ese módulo vuelve a ser sólo validación
  de entrada.
- **No** se toca: auth, roles, RLS, Vault, lógica de rotación, WSAA, certificados, `validateInput`,
  las RPC ni `ARCA_SETUP_EXTRA_ORIGINS` (sigue reservada a `arca-selfservice-setup`).

## 3. Cobertura nueva

| Gate | Qué prueba |
|---|---|
| `tests/deno/edgeCorsClientContract.test.ts` | Las dos funciones entran a la matriz que corre el **handler real** offline: canónicos permitidos (`www` y apex), origen arbitrario **sin** `Allow-Origin`, sin wildcard de headers, headers desconocidos no reflejados, y `POST` forjado → 401 sin trabajo de backend. |
| `scripts/guards/edge-cors-client-contract.mjs` · **G8** (nuevo) | **Ninguna** Edge Function —browser-called o no— puede emitir `Access-Control-Allow-Origin` sin allowlist exacta o sin delegar en `scopedCors`. Prohíbe el fallback `?? '*'`. Los wildcards que ya existían (endpoints públicos de dólar y stubs deshabilitados) quedan en una lista explícita: agregar uno nuevo obliga a editar la lista. |

Resultados: `deno test tests/deno/` **235/235**; guard `22/22` mutaciones detectadas (4 nuevas de G8);
`tests/components/edgeCorsClientContract.test.ts` 2/2; guards S4A / S4B-2A / S4B-2C / Phase 0 en verde.

**Control negativo (anti-falso-verde):** se agregó `https://evil.example.com` a la allowlist de
`arca-rotate-prepare` y el test falló exactamente donde tiene que fallar
(`arca-rotate-prepare: origins stay an exact allowlist`). Revertido.

## 4. Rollout

1. Mergear el PR. **El merge no despliega Edge Functions.**
2. Deploy manual, una por una, desde un worktree linkeado:

```bash
supabase functions deploy arca-rotate-prepare --use-api
supabase functions deploy arca-rotate-activate --use-api
```

`--use-api` no es opcional: `functions deploy` a secas puede imprimir "No change found" y **no** crear una
versión nueva (medido el 2026-09-15 con `arca-selfservice-setup`). Verificar que la versión suba
(hoy ambas están en **v5**, `verify_jwt: true`) antes de dar el deploy por hecho.

3. Smoke (no requiere tocar ARCA ni ninguna credencial):

```bash
# origen canónico → 204 y Allow-Origin espejado
curl -s -o /dev/null -D - -X OPTIONS \
  -H 'Origin: https://www.techrepairpro.app' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization, content-type' \
  https://<ref>.supabase.co/functions/v1/arca-rotate-prepare

# origen arbitrario → sin Access-Control-Allow-Origin
curl -s -o /dev/null -D - -X OPTIONS \
  -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: POST' \
  https://<ref>.supabase.co/functions/v1/arca-rotate-prepare

# POST sin JWT → sigue 401 (el gateway, no CORS)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -d '{}' \
  https://<ref>.supabase.co/functions/v1/arca-rotate-activate
```

Esperado: `204` + `access-control-allow-origin: https://www.techrepairpro.app` en el primero; `204` **sin** ese
header en el segundo; `401` en el tercero.

## 5. Rollback

Redeploy de la versión anterior (`v5`) desde el commit previo:
`git checkout a120a1e -- supabase/functions/arca-rotate-prepare supabase/functions/arca-rotate-activate` y
`supabase functions deploy <slug> --use-api`. No hay estado que revertir: el cambio no escribe en la base ni
toca secretos.

## 6. Impacto en Clic

**Ninguno esperado.** Clic no ejecuta rotaciones desde el navegador (no existe esa UI) y su emisión
(`afip-cae` → `afip-wsaa`) no pasa por estas funciones. El certificado, el ticket WSAA y la configuración
fiscal quedan intactos.

## 7. Riesgo residual

Si alguna vez se opera la rotación desde un origen no canónico y **con navegador**, el preflight fallaría.
Mitigación ya prevista: `APP_URL` suma su origen a la allowlist, y un cliente sin navegador (curl, script,
otra Edge Function) no manda `Origin` y no se ve afectado.
