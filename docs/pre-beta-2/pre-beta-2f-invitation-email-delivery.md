# PRE-BETA-2F — Invitation Email Delivery

**Fecha:** 2026-09-29 · **Estado:** **CERTIFIED / CLOSED** — rollout productivo ejecutado por el owner
y smokes productivos PASS (§15).

«Enviar Invitación» ahora manda un correo. La invitación la sigue creando la **misma** autoridad de
DB de P0-P2; lo nuevo es una capa de entrega (Edge Function `send-business-invitation`) y el
reenvío. El link manual queda como fallback.

| Dato | Valor |
|---|---|
| Base | `origin/main` = `802688019147a2134d689e4529f42b685f6d4c39` (merge de #155, PRE-BETA-2D). Verificado con `git fetch` al inicio. |
| Rama | `claude/pre-beta-2f-invitation-email-delivery` |
| PR | [#156](https://github.com/molinajonyy-hub/TechRepair-Pro/pull/156) — **MERGED** (2026-09-29 21:13:59Z) |
| Head revisado | `79091d2ac7f5bfeeb3123f8a3d553bb6d0e1b199` (el mismo que se revisó antes del rollout) |
| Merge commit | `ba12efcd6e146cc6da1887ab2fb157f493af16fe` |
| Producción | Rollout ejecutado **por el owner** (§15): Edge Function desplegada **antes** del merge, secret configurado, frontend `ba12efc` servido. El agente no tocó producción. |
| Migraciones | **0.** Sin `db push`. La autoridad de invitaciones no cambió (§8). |
| Rollout | §11 (plan) · §15 (evidencia productiva) |

---

## 1. Baseline y handoff histórico

`docs/p0-p2-invitations.md` §12 lo dejó escrito:

> Envío automático de emails de invitación: sigue sin existir. El owner comparte el link a mano.

El smoke humano de PRE-BETA-2E lo confirmó. **No era una regresión.** El código de `8026880`:

- `UsersManagement` llamaba a `create_business_invitation` (vía `invitationsService.createInvitation`);
- armaba `${window.location.origin}/accept-invite?token=…` (sin codificar el token);
- lo copiaba al portapapeles y lo mostraba en «Invitaciones pendientes»;
- no existía ningún transporte de correo.

El `window.location.origin` era además el pendiente **P3-7**: en una Vercel Preview o en el apex el
link salía con ese host. Este lote lo cierra (§3).

Leídos antes de tocar: `docs/p0-p2-invitations.md`, `src/services/invitationsService.ts`,
`src/pages/UsersManagement.tsx`, `src/pages/AcceptInvite.tsx`, `src/lib/pendingInvite.ts`,
`supabase/migrations/20260824120000_p0p2_invitation_lifecycle_hardening.sql`,
`supabase/functions/_shared/scopedCors.ts`, `docs/pre-beta-2/pre-beta-2c-email-hardening.md`, y los
patrones `mp-subscription` (verify_jwt=false + JWT en código) y `arca-selfservice-setup`
(handler puro inyectable + harness E2E).

---

## 2. Arquitectura

```
Owner/Admin ─ «Invitar usuario»
   │  check_user_limit_before_invite (sin cambios, PRIMERO)
   ▼
invitationsService.createAndSendInvitation(email, role)
   │  supabase.functions.invoke('send-business-invitation', { action:'create_and_send', email, role })
   ▼
Edge send-business-invitation            (verify_jwt = false; JWT validado en código)
   1. Bearer → GoTrue (auth.getUser(jwt))            401 si no
   2. get_my_profile con ESE JWT → activo + owner/admin + negocio     403 si no
   3. body acotado, allowlist estricta por acción
   4. create_business_invitation(p_email, p_role)  ← AUTORIDAD DB EXISTENTE, con el JWT del actor
   5. fila devuelta → destinatario, token, rol, negocio
   6. businesses.name bajo RLS (JWT del actor)
   7. correo → Resend (Idempotency-Key)
   ▼
{ ok:true, invitation:{id,email,role,status,expires_at}, delivery:{status:'sent'|'failed', code?} }
```

**Responsabilidad única de la función:** autenticar, delegar en la autoridad de DB, enviar,
reenviar. **Nunca** decide membresías, crea businesses, inserta en `business_invitations` ni usa
`service_role`. Todo acceso a datos corre con el JWT del actor, bajo RLS.

**Acciones**

| Acción | Input | Qué hace |
|---|---|---|
| `create_and_send` | `{ email, role }` | RPC canónica (idempotente: si ya hay una pending viva devuelve **esa**, con el mismo token) y envía |
| `resend` | `{ invitation_id }` | lee la fila bajo RLS; exige mismo negocio del actor, `pending`, `expires_at > now()`; reenvía el **mismo** token. No crea otra invitación |

Destinatario y token salen **siempre de la fila**. `resend` no acepta `email`, `to`, `token` ni
`business_id` (400 `UNEXPECTED_FIELD`).

**Archivos**

| Archivo | Rol |
|---|---|
| `supabase/functions/send-business-invitation/index.ts` | sólo cableado (supabase-js user-scoped, env, CORS) |
| `…/handler.ts` | lógica pura con dependencias inyectadas |
| `…/email.ts` | plantilla versionada (`business-invitation/v1`) |
| `…/delivery.ts` | transporte Resend + Idempotency-Key + clasificación de fallos |
| `supabase/functions/_shared/invitationLink.ts` | **fuente única** del enlace (Edge y web) |
| `src/lib/invitationLink.ts` | wrapper web de la fuente única |
| `src/services/invitationsService.ts` | `createAndSendInvitation`, `resendInvitationEmail` |
| `src/pages/UsersManagement.tsx` | UX de envío y «Reenviar correo» |
| `supabase/config.toml` | `[functions.send-business-invitation] verify_jwt = false` |

**Auth / CORS.** `verify_jwt = false` sólo para que el preflight `OPTIONS` llegue (mismo patrón que
`mp-subscription`); el JWT se valida en código **antes de leer el body**. CORS por
`_shared/scopedCors.ts`: `https://www.techrepairpro.app` y `https://techrepairpro.app`, match exacto,
nunca `*`. Sin Clic Mayorista, sin `APP_URL`. `INVITATION_APP_ORIGIN` sólo suma un origen si es
**loopback** (dev/E2E); cualquier otro valor se ignora. Métodos: POST y OPTIONS; el resto, 405.

**Client contract (SEC-08E).** Las llamadas user-scoped reenvían `x-techrepair-client-contract` con
`userDataApiHeaders`, igual que `arca-selfservice-setup`: sin eso el `db_pre_request` de PostgREST
respondería `CLIENT_UPDATE_REQUIRED`.

---

## 3. URL canónica de invitación (cierra P3-7)

Una sola fuente, `supabase/functions/_shared/invitationLink.ts`, pura (sin imports, env ni globals),
la importan **los dos lados**:

- el correo (Edge);
- «Copiar link» y el texto de «Invitaciones pendientes» (web, vía `src/lib/invitationLink.ts`);
- la ruta interna de redirect (`acceptInviteePath` ahora delega en ella).

```
producción:  https://www.techrepairpro.app/accept-invite?token=<encodeURIComponent(token)>
```

- No se usa: Site URL de Supabase, `Origin` del request, Vercel Preview, clicmayorista, redirects.
- Override **sólo loopback** (`http://localhost|127.0.0.1|[::1]:<puerto>`, sin path, query,
  credenciales). `http://localhost.evil.example`, `https://localhost`, `http://evil@localhost` → canónico.
- Web: el origen de la pestaña se ofrece como candidato **sólo fuera de un build de producción**.
  Verificado en el bundle construido: el chunk de `UsersManagement` compila a
  `{mode:"production",origin:null}` y no contiene ninguna lectura de `window.location`.

---

## 4. Correo

**Plantilla** `business-invitation/v1` (`email.ts`), versionada en el repo.

- From: `TechRepair Pro <no-reply@techrepairpro.app>`. Sin Reply-To.
- Asunto: `Te invitaron a {{ BUSINESS_NAME }} — TechRepair Pro`, saneado como header: controles
  (CR, LF, TAB, NUL, C1, U+2028/9) → espacio, whitespace colapsado, nombre acotado a 80 caracteres.
- Cuerpo: «TechRepair Pro · Te invitaron a unirte a **{negocio}** · Rol: **{rol}** · [Aceptar
  invitación]», el copy de «Usá el mismo correo…» y «Si no esperabas esta invitación, ignorá este correo.».
- Todo texto dinámico se escapa antes del HTML. El token aparece **una vez**, dentro del href.
- Sin imágenes remotas, sin píxeles, sin tracking, sin `CONTACTO_SOPORTE` (la casilla no se
  monitorea; el SaaS Support Inbox sigue siendo P0 pendiente). El correo del destinatario no se
  imprime en el cuerpo.
- Roles server-side: admin→Administrador, manager→Gerente, tech→Técnico, sales→Ventas,
  cashier→Cajero, viewer→Visualizador. `owner` no existe en el mapa (tampoco en la RPC).
- Nombre del negocio: `businesses.name` bajo RLS con el JWT del actor. Si no se puede leer o está
  vacío, «un equipo» (el correo sale igual; el log lo marca `business_name: fallback`).

**Provider.** `POST https://api.resend.com/emails` con exactamente `from/to/subject/html/text`.
Clave `RESEND_INVITES_API_KEY` — **nueva y separada** de la del SMTP de Supabase Auth. Sólo se lee de
`Deno.env`, nunca se imprime, nunca llega al frontend.

---

## 5. Idempotencia de envío (sin migración)

| Acción | `Idempotency-Key` | Efecto (Resend la respeta 24 h) |
|---|---|---|
| `create_and_send` | `invite-create-<invitation_id>` | retry de red o doble submit → **un** correo |
| `resend` | `invite-resend-<invitation_id>-<YYYYMMDDHHmm UTC>` | doble click en el mismo minuto → un correo; un reenvío posterior sí sale |

Consecuencia deliberada: «Invitar» sobre un correo que ya tenía una pending viva devuelve esa misma
invitación (RPC idempotente) y, dentro de 24 h, Resend no la reenvía. La UI lo dice («Ya había una
invitación pendiente… usá «Reenviar correo»») en vez de simular un envío nuevo.

Semántica documentada por Resend (consultada 2026-09-29): misma clave + mismo payload → mismo id,
sin reenviar; misma clave + payload distinto → 409 `invalid_idempotent_request`; concurrente → 409
`concurrent_idempotent_requests`.

---

## 6. Semántica de fallo

Crear y enviar son **dos resultados distintos**. Si la DB creó y el proveedor falla, la invitación
**no** se toca y la respuesta lo dice.

| Caso | HTTP | Respuesta | UI |
|---|---|---|---|
| enviado | 200 | `delivery:{status:'sent'}` | success «Invitación enviada a {email}.» |
| sin `RESEND_INVITES_API_KEY` | 200 | `failed / not_configured` | warning «La invitación quedó creada, pero no pudimos enviar el correo. Podés reenviarlo o copiar el link.» |
| Resend 401/403 | 200 | `failed / provider_unauthorized` | ídem |
| Resend 409 | 200 | `failed / provider_conflict` | ídem |
| Resend 429 | 200 | `failed / rate_limited` | ídem |
| Resend otros 4xx | 200 | `failed / provider_rejected` | ídem |
| Resend 5xx o 2xx sin id | 200 | `failed / provider_error` | ídem |
| red / timeout (10 s) | 200 | `failed / network_error` | ídem |
| fila con destinatario no apto | 200 | `failed / invalid_recipient` | ídem |
| Edge no desplegada / caída / CORS | — | el cliente crea por la **RPC canónica** | ídem (`delivery_unavailable`) |
| actor no owner/admin | 403 | `FORBIDDEN` | error de permisos |
| resend vencida / cancelada / usada / de otro negocio | 409 / 404 | código semántico | error con el motivo; la lista se refresca |

Nunca llega al usuario: body de Resend, status text, errores internos, SQLSTATE, secretos. El parser
del cliente copia sólo campos del contrato.

**Logs** (una línea JSON por envío): `invitation_id`, acción, `delivery`, código controlado,
`provider_status` (HTTP), `business_name: ok|fallback`. **Nunca** correo, token, clave ni body.

**Fallback si la Edge no responde.** Si la capa de entrega no contesta con su contrato (no
desplegada, caída, CORS, red), `createAndSendInvitation` crea la invitación con la **misma** RPC
canónica y la informa como «creada, correo no enviado». No es una segunda autoridad: es la misma
RPC, idempotente, así que un intento que sí llegó a crearla devuelve la misma fila. Hace que el
orden de rollout no pueda romper «Invitar» (§11).

---

## 7. Frontend

- `invitationsService`: `createAndSendInvitation(email, role)` y `resendInvitationEmail(id)`.
  `acceptInvitation`, `cancelInvitation`, `listPendingInvitations` y `createInvitation`: **sin
  cambios de contrato**.
- `UsersManagement`:
  - `check_user_limit_before_invite` sigue corriendo **antes** (verificado por orden en el test).
  - «Enviando invitación...» mientras corre; toasts de éxito / fallo de entrega.
  - «Reenviar correo» por fila, deshabilitado mientras reenvía y protegido contra doble click
    (ref + estado); «Invitación reenviada.» / «No pudimos reenviar el correo. El link sigue disponible.»
  - «Copiar link» y el link visible salen de la fuente única.
  - El correo se **escapa** antes de entrar al toast: `showToast` arma el mensaje con `innerHTML`.
  - `data-testid` nuevos (ninguno existente se tocó): `invite-open`, `invite-email`, `invite-role`,
    `invite-submit`, `invitations-toggle`, `pending-invitation-row`, `invitation-link`,
    `invitation-copy`, `invitation-resend`, `invitation-cancel`.
- Plan / billing: sin cambios. La lógica de plan no se movió a la Edge.

---

## 8. Por qué cero migraciones

| Necesidad | Cómo se cubre sin tocar la DB |
|---|---|
| crear / recuperar la invitación | `create_business_invitation(p_email, p_role)` ya deriva negocio, valida owner/admin, normaliza, valida rol, serializa y es idempotente |
| leer la pending para reenviar | `business_invitations_select` (RLS) ya limita a owner/admin activos del negocio; la función además compara negocio, estado y vigencia |
| nombre del negocio | `businesses_select` (RLS): `id = current_user_business_id()` |
| no duplicar correos | `Idempotency-Key` de Resend |
| no crear negocios | la función no escribe ninguna tabla; `accept_business_invitation` no cambió |

No se modificó `create_business_invitation`, `accept_business_invitation`, RLS ni grants.

---

## 9. Threat model

| Amenaza | Mitigación | Prueba |
|---|---|---|
| Actor sin permisos envía correos en nombre de un negocio | JWT validado + `get_my_profile` activo owner/admin **antes** del body; la RPC revalida | Deno «actor no owner/admin…», «sin JWT» |
| Correo a un destinatario arbitrario (open relay) | `to` sale de la fila; `resend` no acepta destinatario; create sólo pasa `p_email` a la RPC | Deno «allowlist estricta», «destinatario… de la FILA»; guard I4 |
| Reenvío de invitación de otro negocio | lectura RLS acotada al negocio del actor + comparación explícita → 404 no enumerativo | Deno «resend: sólo pending… mismo negocio» |
| Token/URL manipulados o phishing con otro dominio | token de la fila, `encodeURIComponent`, origen canónico; override sólo loopback | vitest A, Deno «Origin nunca decide», guard I3 |
| Header injection en el asunto | saneo de controles y CR/LF, largo acotado | vitest B, Deno «se sanea en el asunto» |
| XSS en el correo / en el toast | `escapeHtml` de todo dinámico; correo escapado antes de `showToast` | vitest B/D, guard I7 |
| Filtración de la clave | sólo `Deno.env`, nunca log ni respuesta; guard contra literales y lectura desde `src/` | Deno «respuestas y logs», guard I1 |
| Filtración de texto del proveedor / SQLSTATE | códigos controlados; body del proveedor descartado | Deno «Resend 4xx/5xx/red…», «errores de la RPC» |
| Escalada vía service_role | la función no usa service_role; guard lo prohíbe en la función y en `src/` | guard I5 |
| CORS abierto | `scopedCors` exacto, sin `*`, sin Clic | Deno CORS, guard edge-cors G3/G8 + guard I6 |
| Doble envío / flood por doble click | Idempotency-Key + botón deshabilitado + ref | Deno idempotencia, vitest D |
| Doble autoridad de invitaciones | la función no inserta; `inviteUserByEmail` no se usa | guard I5, test «create usa la RPC canónica» |

Riesgo residual aceptado: un owner/admin puede disparar reenvíos (uno por minuto por invitación
llega de verdad). La cuota de Resend es de la cuenta (§12).

---

## 10. Tests

| Gate | Resultado |
|---|---|
| `tsc --noEmit` | **0** errores |
| `npm run lint:errors` | **0** |
| `vite build` (producción) | OK |
| `deno check` de `index.ts`, `handler.ts` y el harness | OK |
| Deno `tests/deno/sendBusinessInvitation.test.ts` | **29 / 29** |
| Deno suite completa `tests/deno/` | **293 / 293** |
| vitest `prebeta2fInvitationDelivery.test.tsx` (nuevo) | **28 / 28** |
| vitest `invitationsLifecycle.test.tsx` (P0-P2, existente) | **24 / 24** |
| vitest suite completa | **1383 / 1384** — la única falla fue `orderIntakeMobile › scanner…` por timeout bajo carga (9,5 s); aislada pasa **8 / 8** en 557 ms. Sin relación con invitaciones. |
| unit `node --test` | **1212 / 1212** |
| guard `invitation-email-delivery` + self-test | OK · **27 / 27** mutaciones |
| guard `edge-cors-client-contract` + self-test | OK · 22 / 22 |
| guards `ci-e2e`, `provisioning-authority`, `auth-email-templates`, `auth-redirect`, `no-hardcoded-credentials`, `tenant-isolation:static`, `lote3-authority`, `ui-governance`, `no-real-data` | OK (con self-tests donde existen) |
| E2E `m7-local` | ver §10.1 |

**Cobertura pedida por el brief** — dónde vive cada caso:

- A (pure): escape, asunto, roles, URL canónica, token encoded, producción nunca usa `Origin`,
  localhost sólo dev/test, sin tracking, sin `CONTACTO_SOPORTE`, token sólo en el href → vitest A y B.
- B (handler): sin JWT 401, no owner/admin, RPC canónica, destinatario/token de la fila, resend
  sólo pending/no vencida, otro negocio, Resend 200/4xx/5xx, falta la clave, nunca texto del
  proveedor, Idempotency-Key estable, doble resend mismo minuto → Deno.
- C (component): éxito, fallo de entrega + pendiente visible, reenviar, copiar link, URL canónica,
  cancelar, gate de plan → vitest D.
- D (E2E): `tests/e2e/m7/prebeta2f-invitation-email.spec.ts` con el handler REAL servido por Deno
  (`scripts/e2e/invitation-edge-harness.ts`) contra el stack local y **Resend simulado**. Nunca se
  llama a Resend real desde CI. `ci-local.mjs` levanta el harness junto al de ARCA.

### 10.1 E2E

Corrida **local**, en un stack Supabase **aislado** (`project_id` propio, puertos 554xx, API 55421)
para no tocar los stacks compartidos de otras sesiones: 281 / 281 migraciones (tip
`20261010120000` = `main`), gate SEC-08E R2B `enabled/1`, `prepare-local`, bundle `--mode e2e`
servido en `:5184`, harness de invitaciones en `:5198` con Resend simulado.

| Corrida | Resultado |
|---|---|
| `prebeta2f-invitation-email.spec.ts` | **2 / 2** |
| `p0p2-invitations.spec.ts` (invariante P0-P2) | **6 / 6** |
| suite `m7-local` completa | **182 passed · 10 skipped · 0 failed** (7,9 min) |

Los 10 skipped son exactamente los 10 tests de `arca-selfservice-wizard.spec.ts`: su harness de ARCA
no se levantó en esta corrida y el spec se saltea con motivo, por diseño. En CI (`ci-local.mjs`)
corren los dos harnesses.

Primera corrida del spec nuevo: 2 fallas **del test**, no del producto. Generaba el invitado con una
mayúscula y la DB guarda el correo normalizado (`lower(btrim(email))`), que es exactamente el
destinatario que manda la Edge. Se corrigió el helper del spec para generar correos en minúsculas.

Qué mide el spec 1, de punta a punta: invitar por la UI (con el correo en mayúsculas) → **un** correo
con `to` = el correo normalizado de la fila, From exacto, asunto con el nombre del negocio, payload
exactamente `from/to/subject/html/text`, `Idempotency-Key = invite-create-<id>`, sin `<img>` ni
soporte, href = `<baseURL>/accept-invite?token=<token de la DB>` con el token una sola vez → la
lista de pendientes muestra el **mismo** enlace → el invitado abre el enlace **del correo** en otro
navegador → aceptado → mismo negocio, rol `tech`, **businesses +0, trials +0**, invitación
`accepted`. Spec 2: proveedor caído → la invitación queda (1 pending, 0 correos) → proveedor vuelve →
«Reenviar correo» → 1 correo con el **mismo** token y clave `invite-resend-<id>-…`, sigue habiendo
1 sola pending.

---

## 11. Rollout — plan (EJECUTADO por el owner el 2026-09-29, evidencia en §15)

El plan se conserva tal como se revisó. Se ejecutó en este orden: la función se desplegó **antes**
del merge.

**Orden recomendado: la función ANTES del merge.** El brief lo proponía después del merge; se
invierte a propósito porque es el orden seguro:

- la función desplegada sin callers es inerte;
- el frontend nuevo, si llegara primero, igual funciona gracias al fallback (§6), pero sin correo;
- la inversa de P0-P2 no aplica: acá no se retira ninguna firma de DB.

1. **Resend → API Keys → Create API key**
   - Name: `TechRepair Pro — Invitation Emails`
   - Permission: **Sending access**
   - Domain: **`techrepairpro.app`**
2. Copiar el token **una sola vez**. **No pegarlo en el chat** ni en ningún archivo.
3. Verificar en Resend → Domains → `techrepairpro.app` que **open/click tracking siguen OFF**.
4. **Supabase → Edge Functions → Secrets**: crear `RESEND_INVITES_API_KEY` con ese valor
   (o `supabase secrets set RESEND_INVITES_API_KEY` desde una terminal propia, ingresando el valor
   por prompt). **No** crear `INVITATION_APP_ORIGIN` en producción.
5. Deploy de la función, desde el SHA revisado del PR:
   ```
   supabase functions deploy send-business-invitation --project-ref <ref-productivo> --no-verify-jwt
   ```
   `--no-verify-jwt` es obligatorio: la CLI **setea** el flag en cada deploy y su default es `true`.
6. Smoke server-side (sin correos):
   - `OPTIONS` con `Origin: https://www.techrepairpro.app` → 204 + `Access-Control-Allow-Origin` exacto;
   - `OPTIONS` con un origen ajeno → sin `Access-Control-Allow-Origin`;
   - `POST` sin `Authorization` → 401 `NOT_AUTHENTICATED`;
   - `GET` → 405.
7. Merge del PR → Vercel. Confirmar `/version.json` = SHA del merge y, en el bundle servido, que
   `send-business-invitation` y `https://www.techrepairpro.app` están presentes.
8. **Smoke humano** — owner de Clic invita un **alias Gmail nuevo** (no registrado). Esperado:
   - llega el correo, From `TechRepair Pro`, asunto `Te invitaron a <Clic> — TechRepair Pro`;
   - el botón apunta **directo** a `https://www.techrepairpro.app/accept-invite?token=…`;
   - sin tracking (el href no pasa por un dominio de redirect de Resend);
   - abrirlo sin sesión → login/registro **preservando el token**; confirmar el correo si es nuevo;
   - aceptar → profile en el business de Clic, rol correcto;
   - deltas: **businesses 0**, **trials 0**; invitación `pending → accepted`;
   - logout/login mantiene el business.
9. Probar **«Reenviar correo»** sobre una pending → llega otro correo con el **mismo** token.
10. Resend → Emails → ambos correos `delivered`.

## 12. Rollback

- Frontend: revert del merge si hiciera falta (el link manual queda como antes).
- La Edge Function puede **quedar desplegada** sin callers: es inerte.
- **Revocar** `RESEND_INVITES_API_KEY` en Resend (y borrar el secret).
- **Sin rollback de DB**: no hay migración.

---

## 13. Riesgos y pendientes

- **Cuota compartida.** Resend Free = **100 correos/día duros** por cuenta (medido en 2C). Las
  invitaciones comparten la cuota con los correos de Auth (altas y recovery). Con el uso medido en 2C
  (pico 4/día) sobra para la beta controlada; el criterio de pasar a Pro de 2C sigue valiendo.
- **Deliverability** medida sólo en Gmail (2C). Mismo pendiente, no bloquea.
- `expire_old_invitations()` sigue sin cron (P0-P2 §12). Mitigado: la lista filtra vencidas y
  `resend` rechaza vencidas.
- `PermissionsMatrix` del modal de invitación sigue sin persistir (P0-P2 §12). Fuera de alcance.
- `showToast` (`src/utils/toast.ts`) interpola con `innerHTML` en toda la app. Este lote escapa su
  propio texto dinámico; el arreglo global queda como tarea aparte.
- El E2E de CI cubre el handler con Resend simulado; el envío real lo cubrió el smoke humano
  productivo (§15.3–§15.4, PASS).

---

## 14. Confirmaciones

- **El agente no tocó producción** en ningún momento del lote: el deploy, el secret y los smokes
  productivos los hizo el owner (§15). Ningún `db push`.
- **0 migraciones.**
- `create_business_invitation` y `accept_business_invitation` **sin cambios**. RLS sin cambios.
- Sin `service_role` en el frontend ni en la función. Sin `inviteUserByEmail`.
- El guard de plantillas de Auth (`auth-email-templates`) no se tocó.

---

## 15. Evidencia productiva — CERTIFIED / CLOSED (2026-09-29)

**Etiqueta:** todo lo de esta sección es **REPORTADO POR EL OWNER** (rollout y smokes ejecutados por
él en producción). Sin PII: no se registran direcciones de correo ni tokens. El agente no ejecutó
nada en producción. Lo único verificable desde el repo/GitHub es el merge del PR (§15.1).

### 15.1 Rollout

| Paso (§11) | Resultado | Fuente |
|---|---|---|
| Key de Resend **nueva**, separada del SMTP de Auth, *Sending access* restringida a `techrepairpro.app` | hecho | owner |
| Secret `RESEND_INVITES_API_KEY` en Supabase (producción) | configurado | owner |
| Deploy de `send-business-invitation` | desplegada **ANTES** del merge | owner |
| Merge de #156 | `ba12efcd6e146cc6da1887ab2fb157f493af16fe`, head revisado `79091d2` | GitHub (verificable) |
| `https://www.techrepairpro.app/version.json` | `commit` = `ba12efc` | owner |
| Migraciones / `db push` | ninguna | owner + repo (0 archivos en `supabase/migrations/`) |

### 15.2 Smokes server-side

| # | Request | Esperado (§11 paso 6) | Resultado |
|---|---|---|---|
| 1 | `OPTIONS` con `Origin: https://www.techrepairpro.app` | 204, `Access-Control-Allow-Origin` exacto, `POST, OPTIONS` | **PASS** |
| 2 | `OPTIONS` con `Origin: https://evil.example` | 204 **sin** `Access-Control-Allow-Origin` | **PASS** |
| 3 | `POST` sin JWT | 401 `{"ok":false,"error":"NOT_AUTHENTICATED"}` | **PASS** |
| 4 | `GET` | 405 `{"ok":false,"error":"METHOD_NOT_ALLOWED"}` | **PASS** |

### 15.3 Smoke humano — invitación nueva

| Paso | Resultado |
|---|---|
| el owner crea una invitación desde TechRepair | OK |
| el correo sale automáticamente | OK |
| Resend registra el correo como **Delivered** | OK |
| el enlace lleva a la ruta canónica de TechRepair (`/accept-invite`) | OK |
| usuario sin sesión → login/registro **preservando** el `redirectTo` de la invitación | OK |
| alta de una cuenta con **exactamente** el correo invitado + confirmación del correo | OK |
| aceptar la invitación | OK |
| el invitado queda dentro del **taller existente**, con sus datos y rol correctos | OK |
| **no** se crea un taller manual | OK — invariante P0-P2 sostenida en producción |

### 15.4 Smoke de «Reenviar correo»

| Paso | Resultado |
|---|---|
| otra invitación `pending` | creada |
| «Reenviar correo» | toast de reenvío exitoso |
| segundo correo | recibido / **Delivered** |
| la invitación sigue siendo la misma `pending` | OK |
| limpieza | la invitación QA se **canceló** manualmente después del smoke |

### 15.5 Lo que el reporte no detalla (no se inventa)

Estos checks del plan (§11) no aparecen explícitos en el reporte del owner. No se marcan como
fallidos ni como hechos:

- verificación explícita de open/click tracking OFF en el dominio de Resend (paso 3). Lo observado
  —el enlace llega a la ruta canónica— es consistente con tracking OFF, pero no lo prueba;
- inspección del bundle servido (paso 7), más allá de `version.json`;
- asunto y From del correo recibido (paso 8);
- deltas por SQL (`businesses`, `trials`) y logout/login posterior (paso 8). El reporte sí cubre la
  invariante a nivel de producto: el invitado quedó en el taller existente y no se creó un taller.

Ninguno cambia el resultado: los contratos centrales —correo entregado, enlace canónico, alta con el
correo invitado, membresía en el negocio existente, reenvío con la misma invitación— están PASS.

### 15.6 Veredicto

**PRE-BETA-2F = CERTIFIED / CLOSED.**

Efectos fuera de 2F:
- cierra el **pendiente humano de invitaciones** que había quedado abierto en PRE-BETA-2E
  (ver `pre-beta-2e-auth-production-rollout.md`);
- «envío automático de invitaciones» deja de ser deuda (`docs/p0-p2-invitations.md` §12);
- cierra **P3-7** (links de invitación con `window.location.origin`), listado como pendiente en
  2D §15.1.
