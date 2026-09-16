# BETA-GATE-1 — Security & Access Closure · DISCOVERY (read-only)

**Base:** `origin/main` = `a120a1eb979e85ede756ad0bcf055a7bf0edf763` · tag `stable-arca-selfservice-phase2b-v1`
(peeled `a120a1e`) · worktree aislado `.worktrees/beta-gate-1`, árbol limpio, sin diff contra `origin/main`.
**DB:** repo tip `20261002120000` == producción tip `20261002120000` (273 migraciones aplicadas). Coherente.
**Fecha:** 2026-09-15.

Nada de lo de abajo modifica código: es discovery. Las mediciones contra producción fueron **sólo lectura**
y devolvieron agregados o booleanos, nunca datos fiscales crudos.

---

## 1. Tabla de los cuatro lotes

| Tema | Causa raíz | Archivos | Riesgo | Comportamiento actual | Fix mínimo | DB | Edge | Frontend |
|---|---|---|---|---|---|---|---|---|
| **A · CORS renovación ARCA** | Las dos funciones construyen el header con `req.headers.get('Origin') ?? '*'`: reflejan cualquier origen y caen a `*` si no hay `Origin`. Son de la Phase 0, anteriores a `_shared/scopedCors.ts` | `supabase/functions/arca-rotate-prepare/index.ts:37-55`, `supabase/functions/arca-rotate-activate/validate.ts:11-26` + `index.ts:32-39`, `tests/deno/arcaRotateActivate.test.ts:25-34` | **Medio.** No hay caller browser (ningún `functions.invoke('arca-rotate-*')` en `src/`), y la autoridad real (JWT + owner/admin + `settings_sensitive` + RPC) no depende de CORS. Es superficie innecesaria, no un bypass | Origen arbitrario recibe `Access-Control-Allow-Origin: <ese origen>`; sin `Origin`, `*` | Reemplazar el helper local por `_shared/scopedCors.ts` (`createCors(computeAllowedOrigins([APP_URL]))`), + guard estático que impida reintroducir el eco | No | **Sí** (redeploy de 2 funciones) | No |
| **B · Password recovery** | El link de recuperación aterriza en `/auth/callback`, y ese callback **no tiene camino de recovery para el formato implícito**: sin `token_hash` toma la rama A ("PKCE de siempre") y navega a `/dashboard`. Además `ResetPassword` sólo se habilita con una señal que **nadie escribe** (`sessionStorage['is_password_recovery']`) o con una URL que supabase-js ya limpió | `src/pages/Login.tsx:372-392`, `src/pages/AuthCallback.tsx:99-156`, `src/pages/ResetPassword.tsx:17-66`, `src/lib/supabase.ts:14-24`, `src/lib/authRedirect.ts:126-133`, `src/App.tsx:162-164` | **Alto (beta-blocker).** Un usuario que olvidó la contraseña no puede recuperarla por UI | Login → "¿Olvidaste tu contraseña?" → mail → link → `/auth/callback` → **Dashboard**, sesión iniciada y sin formulario. Si el mail usara `token_hash`, iría a `/reset-password` y se quedaría en "Verificando enlace…" para siempre | Capturar la intención de recovery al bootear el cliente + marcar la sesión con el evento `PASSWORD_RECOVERY`; el callback deriva a `/reset-password`; la pantalla habilita el form sólo con sesión + marca, y tiene estados de link vencido / sesión inválida | No | No | **Sí** |
| **C · `afip-wsaa` refresh** | Ventana de 30 min heredada de la primera versión (`index.ts:401-413`) + `force_refresh` aceptado desde el contrato de entrada (`authorizationBoundary.ts:37-41`) | `supabase/functions/afip-wsaa/index.ts:386-491`, `supabase/functions/afip-wsaa/authorizationBoundary.ts:28-41`, `tests/unit/arcaWsaaAuthorization.test.ts` | **Medio sobre emisión.** Toca el camino vivo de facturación de Clic | Con < 30 min de TA restante se pide un LoginCms nuevo. ARCA responde `coe.alreadyAuthenticated` (no emite un segundo TA mientras haya uno válido) → la función marca `estado_conexion='error'` y `afip-cae` devuelve 502 | Reusar el TA vigente salvo margen chico y probado; sacar `force_refresh` (sin callers); ante `alreadyAuthenticated`, releer la caché y usar el TA vigente en vez de marcar error | No | **Sí** (redeploy de `afip-wsaa`) | No |
| **D · Datos reales en tutorial** | `Tutorials.tsx` usa el alias y el CUIT reales del titular como "captura" del paso 5 | `src/pages/Tutorials.tsx:395,397`, `scripts/guards/arca-wsass-alias-contract.mjs:57`, `tests/sql/arca_wsass_homologacion_alias.test.sql:122,155` | **Alto de privacidad** (el repo de GitHub es **PUBLIC** y la página se sirve en el bundle) | El paso 5 muestra `molina.jonyy2` y `20-37629616-5`; ese CUIT está **confirmado** como el `cuit_emisor` configurado de Clic (verificado con un booleano contra prod, sin traer el dato) | Reemplazar por ejemplos ficticios (`techrepairdemo`, `20-12345678-9` sintético) y un guard que impida que las strings reales vuelvan (por digest, no en claro) | No | No | **Sí** |

---

## 2. Causa raíz exacta, lote por lote

### A — CORS de renovación

```ts
// arca-rotate-prepare/index.ts (y validate.ts de activate, idéntico)
const origin = req.headers.get('Origin') ?? '*'
return { 'Access-Control-Allow-Origin': origin, ... }
```

Es **blind reflection** con fallback a wildcard. El resto de las superficies ARCA endurecidas usan
`_shared/scopedCors.ts`: allowlist exacta (`https://www.techrepairpro.app`, `https://techrepairpro.app`,
más lo que agregue `APP_URL`), y si el origen no está, **no se emite** `Access-Control-Allow-Origin`.

Callers reales medidos:
- `src/` no invoca ninguna de las dos (`arcaService.ts:463` sólo las nombra en un comentario).
- `scripts/`, tests y docs las tocan de forma estática (guards, fixtures, plan humano de rotación).
- El guard `scripts/guards/edge-cors-client-contract.mjs` **no las cubre**: su `REGISTRY` es de funciones
  *llamadas desde el navegador*, y G3 falla si se lista una que nadie llama desde `src/`. Hace falta una
  regla nueva, no una entrada nueva.
- `verify_jwt = true` en `supabase/config.toml:515-519`; en prod ambas están en v5 con `verify_jwt: true`.

Métodos/headers que necesitan: `POST, OPTIONS` y `authorization, content-type, apikey, x-client-info`
(subconjunto de lo que ya permite `scopedCors`, que además agrega `cache-control`, `pragma` y los
`x-techrepair-client-*`). Reutilizar `scopedCors.ts` **no amplía** el blast radius: es el mismo módulo puro
que ya usan `arca-selfservice-setup`, `whatsapp-send` y `whatsapp-send-message`.

`ARCA_SETUP_EXTRA_ORIGINS` **no se toca** (G7 del guard la reserva a `arca-selfservice-setup`).

### B — Password recovery

Flujo real, medido sobre el código:

1. `Login.tsx` llama `resetPasswordForEmail(email, { redirectTo: getAuthCallbackUrl() })` → el mail apunta a
   `https://www.techrepairpro.app/auth/callback`.
2. El cliente Supabase se crea **sin `flowType`** (`src/lib/supabase.ts:14`), y el default de
   `@supabase/supabase-js` 2.103 es **`implicit`** (`dist/index.mjs:28`), no PKCE. O sea: el link vuelve con
   `#access_token=…&type=recovery`, no con `?code=`.
3. supabase-js detecta el fragmento, guarda la sesión y emite `PASSWORD_RECOVERY` en un `setTimeout(0)`
   (`GoTrueClient.js:296-306`), limpiando el hash.
4. `AuthCallback` mira **sólo `window.location.search`**. Sin `token_hash` toma la rama A y, cuando
   `AuthContext` resuelve, navega a `destinoPostConfirmacion()` → **`/dashboard`**.
5. Nadie escucha `PASSWORD_RECOVERY`, así que la pantalla `/reset-password` nunca se abre.

El segundo camino también está roto: si la plantilla de **GoTrue** usara
`{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`, `AuthCallback:125-127` sí deriva a
`/reset-password`, pero para entonces el evento ya se emitió y la URL ya fue limpiada: `ResetPassword`
se queda en "Verificando enlace…" porque su condición de `ready` depende de la URL o de un
`sessionStorage['is_password_recovery']` **que ningún archivo escribe** (verificado: cero escrituras en el repo).

Errores de link vencido tampoco tienen camino: GoTrue los devuelve en el **fragmento**
(`#error=access_denied&error_code=otp_expired`) y `AuthCallback` sólo lee la query → cae a `/login` sin mensaje.

Otros hallazgos del discovery:
- El `redirectTo` sale del helper canónico con allowlist cerrada (`authRedirect.ts`) y hay guard
  (`guard:auth-redirect`). **No conviene mover el destino a `/reset-password`**: la URL exacta
  `/auth/callback` ya está probada contra la allowlist de Redirect URLs del panel de Supabase, y cambiarla
  exigiría intervención humana en producción, con riesgo de caer al Site URL.
- `src/services/auth.ts` sigue sin consumidores (su `resetPassword` apunta a `/reset-password`): es la
  "doble entrada" que documenta `docs/email-verification-p0.md:154-158`.
- El dominio del portal mayorista (`clicmayorista.com.ar`) monta `/auth/callback` pero **no**
  `/reset-password`; hoy no hay entrada de "olvidé mi contraseña" en el portal, así que queda fuera de alcance
  y anotado.
- `secure_password_change = false`, `minimum_password_length = 6` (config local). La pantalla ya exige 8.

### C — `afip-wsaa`

Callers medidos:

| Caller | Cómo | `force_refresh` |
|---|---|---|
| `afip-cae/index.ts:410` | `functions.invoke('afip-wsaa', { body: { business_id, service: 'wsfe' } })` | no |
| `afip-fe-query/index.ts:168` | idem | no |
| Navegador | **ninguno** desde Phase 2B; el guard `arca-phase2b-wizard-contract.mjs` (B1) prohíbe que vuelva | — |
| Cron / jobs | no existen | — |
| `arca-selfservice-setup` | **no** usa `afip-wsaa`: tiene su propio LoginCms (`wsaa.ts`) con el par pendiente | — |
| Rotación (`S4B-2B`) | la activación invalida la caché WSAA en la RPC, así que el próximo login ya es fresco sin forzar nada | — |

Respuestas a las cinco preguntas:

1. **¿Hay hoy un caller legítimo que necesite `force_refresh`?** No. Cero, en `src/`, en Edge, en scripts y en
   docs operativas. Sólo aparece en tests y en guards que verifican que **no** vuelva.
2. **¿Qué pasa si CAE necesita token con 29 min restantes?** Se ignora la caché y se hace LoginCms. ARCA no
   emite un segundo TA mientras haya uno válido: responde `coe.alreadyAuthenticated`. `callWSAA` lanza,
   `withWsaaAuthorization` marca `arca_config.estado_conexion='error'` y responde `success:false`; `afip-cae`
   libera el claim y devuelve 502. Es decir: **la última media hora de cada ticket es una ventana de fallo**.
3. **¿Por qué existe la ventana de 30 min?** No está documentada. Es la heurística "refrescá antes de que
   venza" de la primera versión de la función, anterior a que se supiera cómo se comporta WSAA.
   Con la semántica real de ARCA es contraproducente.
4. **¿Podemos reusar un TA válido hasta un margen menor?** Sí. El TA se usa en la misma invocación, segundos
   después; el techo de pared de una Edge Function es ≤ 400 s (el mismo número que ya usa el modelo de
   Phase 2A para acotar ventanas).
5. **¿Qué margen es seguro?** Uno que cubra el techo de invocación más la tolerancia de reloj: **10 minutos**
   (600 s) es holgado y consistente con la tolerancia DB↔WSAA de 10 min ya adoptada en Phase 2A. Cualquier
   valor menor debería medirse, no intuirse.

**Evidencia de producción (sólo lectura, agregados):** `arca_emission_attempts` con
`error_mensaje like 'pre-send claim released: wsaa_failed%'` = **0**; 32 intentos tocados en 30 días;
2 `arca_config` con ticket; **0** en `estado_conexion='error'`. O sea: el defecto es real por contrato pero
**todavía no se manifestó** en producción — el volumen es bajo y las emisiones no cayeron en la ventana.
Eso baja la urgencia y sube el valor de un rollout propio y cuidadoso.

### D — Datos reales

Clasificación del barrido (script propio sobre `git ls-files`, con validación mod-11 de CUIT):

| Dato | Dónde | Clasificación | Acción |
|---|---|---|---|
| `molina.jonyy2` | `src/pages/Tutorials.tsx:395` | **real** (alias WSASS de Clic) | reemplazar por `techrepairdemo` |
| `20-37629616-5` | `src/pages/Tutorials.tsx:397` | **real** — confirmado: es el `cuit_emisor` de Clic (booleano contra prod) | reemplazar por un CUIT sintético con mod-11 válido, documentado como fixture |
| `molina.jonyy2` | `scripts/guards/arca-wsass-alias-contract.mjs:57`, `tests/sql/arca_wsass_homologacion_alias.test.sql:122,155` | **real usado como fixture negativo** (alias con punto → inválido) | reemplazar por un valor sintético con punto, que prueba exactamente lo mismo |
| `molina.jonyy@gmail.com` | `docs/p0-p2-invitations.md:292`, `supabase/MIGRATION_BASELINE_PLAN.md:222`, `supabase/migrations/_legacy/20260626174811_*.sql` | **real** (email del titular) | decisión humana: los docs se pueden anonimizar; la migración `_legacy` es historia archivada y tocarla reescribe evidencia. **No se toca sin aprobación** |
| `aa930802-…` (business id de Clic) | 12 docs de auditoría | **real interno**, no secreto (RLS protege) | se mantiene: es la trazabilidad de las auditorías |
| `techrepairpro.soporte@gmail.com`, `+invite01` | `src/config/contacto.ts`, docs | **corporativo intencional** | se mantiene |
| CUITs `2011111111-2`, `20222222223`, `20444444445`, … | tests, fixtures SQL, scripts de seguridad | **sintéticos** | se mantienen |
| CUIT de las capturas `docs/arca-selfservice-phase2b/screenshots/*` (p. ej. `20-93386690-5`) | PNG generados por el spec E2E con `validCuit()` aleatorio | **sintético** (generado, no de prod) | se mantienen; no hace falta regenerar |
| Teléfonos `+5493511234567`, `351…` | mocks y tests | **sintéticos** | se mantienen |
| `eyJhbGciOiJIUzI1NiIs…` | `.env.local.example`, guard de compat | JWT de ejemplo del stack local (clave demo pública de Supabase) | se mantiene |

**No se encontraron** en el árbol: claves privadas, PEM reales, `secret_id` de Vault, fingerprints de
certificados productivos, tokens de MP/Meta ni `sb_secret_*`.

⚠️ **El repositorio es PUBLIC** (`molinajonyy-hub/TechRepair-Pro`). Sacar los valores de `HEAD` **no los borra
del historial de git**. Purgar historia es una decisión humana aparte (reescribe SHAs y rompe forks); acá se
propone sólo dejar de publicarlos de ahora en más.

---

## 3. Riesgos

- **A:** riesgo de romper una renovación futura si el operador la ejecuta desde un origen no canónico
  (hoy no hay UI; se ejecuta server-side). Mitigación: `APP_URL` sigue sumando su origen, y CORS no es la
  autoridad: un `curl` sin `Origin` no se ve afectado.
- **B:** toca `supabase.ts` (cliente global) y el callback de auth, que también sirve signup, OAuth e
  invitaciones. Mitigación: el cambio en `supabase.ts` es un listener aditivo; el callback conserva intactas
  sus ramas A/B/C y agrega una anterior sólo para recovery. Tests de componentes + E2E local con Inbucket.
- **C:** único lote que toca la emisión fiscal viva. Mitigación: lógica pura y testeada aparte, sin tocar
  firma, TRA, Vault ni parser; rollout propio; rollback = redeploy de la versión anterior.
- **D:** riesgo bajo (texto de una página de ayuda). El riesgo real es no cerrar el historial: se declara.

## 4. Orden recomendado

`A → B → D → C`, con **C separado**: es el único con superficie sobre facturación viva y, medido, todavía no
produjo una sola falla en producción. B no queda bloqueado por C. D puede ir en paralelo (no comparte archivos
con nadie).

## 5. Preguntas cerradas del brief

| Pregunta | Respuesta |
|---|---|
| ¿Alguno se resuelve sólo con frontend? | **B y D**: sí, sólo frontend (más tests/guards). |
| ¿Alguno requiere migración? | **Ninguno.** |
| ¿Alguno necesita intervención humana? | **A y C**: deploy de Edge Functions (`supabase functions deploy`, nunca automático). **D**: decidir qué hacer con el email del titular en docs y con el historial público. **B**: ninguna (no cambia la config de Auth ni las plantillas de correo). |
| ¿Se pueden juntar lotes? | No hace falta: los cuatro tocan archivos disjuntos. Cuatro PRs. |

## 6. Plan de PRs

| PR | Alcance | Archivos | Gates |
|---|---|---|---|
| A | `scopedCors` en las dos funciones de rotación + guard nuevo (ninguna Edge Function refleja un origen arbitrario) | 2 Edge + 1 guard + 2 tests | `test:deno`, guard + self-test, `tsc`, build |
| B | Recovery end-to-end (captura de intención, marca por evento, ruteo, estados de error, copy anti-enumeración) | `supabase.ts`, `authRedirect`/nuevo `passwordRecovery.ts`, `AuthCallback`, `ResetPassword`, `Login` | unit + components + E2E local con Inbucket |
| D | Sanitizar tutorial y fixtures + guard por digest | `Tutorials.tsx`, guard alias, test SQL, guard nuevo | guards + `test:arca-wsass-alias` + components |
| C | Reuso de TA + retiro de `force_refresh` + manejo de `alreadyAuthenticated` | `afip-wsaa/*` + tests | unit + deno, simulaciones (fresco, >30 min, 29 min, 5 min, vencido, force_refresh, concurrencia, alreadyAuthenticated) |

## 7. Recomendación

**GO** con el plan de arriba. No apareció ningún blocker conceptual: ningún lote necesita migración, ninguno
toca RLS/RBAC/Vault/WSAA/certificados, y el único con riesgo sobre emisión (C) queda aislado con su propio
rollout.
