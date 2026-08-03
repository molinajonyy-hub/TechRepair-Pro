# P0 — `businesses_portal_public_read`: liberación en dos fases

**Fecha:** 2026-08-03
**Origen:** anexo final de `docs/p0-realtime-406/informe.md` (rama `fix/p0-realtime-subscription-and-406`, commit `e6d772b`).
**Estado:** FASE 1 en curso. FASE 2 (lockdown) **no** incluida en esta rama.

> No se toca Realtime. No se agrega `businesses` a `supabase_realtime`.
> No se toca P0-A.1, Health Check, backfills ni P0-B. No se crea tag.

---

## 1. Hallazgo confirmado

La policy se creó en el baseline `20260628190324_remote_baseline.sql` sin cláusula `TO`:

```sql
CREATE POLICY "businesses_portal_public_read" ON "public"."businesses"
  FOR SELECT USING (("wholesale_portal_enabled" = true));
```

Sin `TO`, `polroles` queda vacío ⇒ la policy aplica a **PUBLIC** (`anon` + `authenticated`). Una policy RLS filtra **filas**, nunca **columnas**, y `anon` tiene `GRANT SELECT` sobre la tabla completa ⇒ quedan expuestas las 34 columnas de todo negocio con `wholesale_portal_enabled = true`.

Tres vectores, verificados empíricamente:

| # | Vector | Evidencia |
|---|--------|-----------|
| 1 | `anon` lee columnas sensibles | Local + PostgREST: `GET /rest/v1/businesses?select=…,mp_payer_email` → `200` con dato |
| 2 | `anon` **enumera** todos los portales habilitados | Plan `Seq Scan` + `Filter: wholesale_portal_enabled`; no hace falta ningún slug |
| 3 | `authenticated` de **otro tenant** lee lo mismo | Local + JWT real de otro negocio → `200` con `mp_payer_email` y `mp_preapproval_id` |

El vector 3 es el más grave y no requiere ser cliente del portal: las policies permisivas se combinan con `OR`, así que `businesses_select` da lo propio y `businesses_portal_public_read` agrega lo ajeno.

---

## 2. Medición productiva (sanitizada)

Sólo `SELECT`. **Ningún valor real fue impreso ni transcrito.**

- `businesses` totales: **20**
- Con `wholesale_portal_enabled = true`: **1** (con slug)
- Última migración aplicada en prod al momento de medir: `20260802120000`

### Columnas expuestas, por clasificación

Conteo de **no nulos** sobre el negocio afectado (universo = 1 fila).

| Clasificación | Columnas | No nulos |
|---|---|---|
| **Pública** (allowlist prevista) | `id`, `name`, `logo_url`, `wholesale_portal_enabled`, `wholesale_portal_slug` | 1 c/u |
| **Pública** (sin dato cargado) | `wholesale_whatsapp`, `wholesale_portal_theme` | 0 |
| **PII** | `mp_payer_email` | **1** |
| **Identificador interno** | `mp_preapproval_plan_id`, `last_payment_id`, `owner_user_id`, `override_created_by` | **1** c/u |
| **Identificador interno** (sin dato) | `mp_preapproval_id`, `mp_last_modified` | 0 |
| **Configuración administrativa** | `subscription_status`, `subscription_plan`, `subscription_provider`, `access_source`, `current_period_start`, `current_period_end`, `onboarding_completed`, `onboarding_completed_at`, `override_created_at`, `override_reason`, `rubro`, `created_at`, `updated_at` | 1 c/u |
| **Configuración administrativa** (sin dato) | `grace_until`, `trial_ends_at`, `last_payment_status`, `last_webhook_at`, `override_expires_at`, `ciudad`, `whatsapp_negocio` | 0 |
| **Credencial o secreto** | — | **ninguna** |

Total: 7 públicas + 27 no públicas = 34.

### Credenciales reutilizables: no hay

`businesses` no tiene ninguna columna de token, secreto, clave ni contraseña. Los identificadores de Mercado Pago expuestos **no son credenciales**:

- `mp_preapproval_plan_id` ya es semi-público — `mp-subscription` lo pone en la query string del checkout al que se redirige el navegador.
- `last_payment_id` y `mp_preapproval_id` son identificadores de objetos MP: sin el access token de la cuenta no habilitan ninguna operación.
- El access token de MP vive en secretos de edge function; las credenciales AFIP viven en Vault (ver `afip-rotation-activated-s4b2b`). Ninguno pasa por esta tabla.

**Conclusión: no corresponde rotación derivada de este hallazgo.** El impacto es exposición de PII (un email de facturación) e identificadores internos de un negocio.

⚠️ **No se afirma ausencia de acceso histórico.** No hay evidencia de logs que cubra la ventana de exposición (la policy existe desde el baseline del 2026-06-28; la retención de logs del plan es muy inferior). Queda como riesgo vivo, no como hecho descartado.

### Grants y policies en producción (antes de la FASE 2)

```
GRANT_TABLA   anon            SELECT          -- las 34 columnas
GRANT_TABLA   authenticated   SELECT
PUBLIC        (sin GRANT de tabla)
GRANT_COLUMNA service_role    UPDATE          -- 15 columnas de facturación
POLICY  PUBLIC          businesses_portal_public_read [r]  USING (wholesale_portal_enabled = true)
POLICY  PUBLIC          businesses_insert            [a]
POLICY  authenticated   businesses_select            [r]  USING (id = current_user_business_id())
POLICY  authenticated   businesses_update            [w]
POLICY  authenticated   businesses_delete            [d]
RLS: relrowsecurity=true · relforcerowsecurity=false
```

`PUBLIC` no tiene `GRANT` de tabla: el acceso anónimo entra por el grant del rol `anon`. Idéntico al estado local, así que el diagnóstico local tiene paridad con producción.

---

## 3. Arquitectura aprobada

RPC `SECURITY DEFINER` `public.get_wholesale_portal_public(p_slug text)`: 7 columnas, igualdad exacta por slug, máximo una fila, sólo portal habilitado.

Se descartaron las dos alternativas:

- **`TO anon` + GRANT por columna** rompe el portal: `getPortalBusiness` corre en cada mount de `PortalContext`, también con sesión iniciada, así que el lector puede ser `authenticated`.
- **Vista `security_invoker`** no cierra el agujero: los GRANT de columna son **por rol, no por fila**, y `authenticated` necesita `mp_*` de su propio negocio (`subscriptionService`). Como `registerCustomer` es público, cualquiera se auto-registra y lee `mp_payer_email` salteando la vista.
- **Vista `security_definer`** sí cerraría, pero la rechaza `scripts/finance/guard-view-security-invoker.mjs` en CI — guard nacido de un leak real en producción. No se debilita.

La RPC además cierra el vector 2: al exigir el slug, elimina la enumeración del directorio de portales, que ninguna de las vistas impedía.

---

## 4. FASE 1 — superficie pública segura (esta rama)

Rama: `fix/security-wholesale-portal-public-rpc`

| Archivo | Qué hace |
|---|---|
| `supabase/migrations/20260803120000_wholesale_portal_public_rpc.sql` | Crea la RPC + grants. **Aditiva**: no revoca nada, no dropea policies. |
| `src/portal/portalPublicContract.ts` | Módulo puro: nombre de la RPC, allowlist de 7 columnas, `isMissingObject`. |
| `src/portal/services/portalService.ts` | `getPortalBusiness` pasa a la RPC, con fallback transitorio. |
| `tests/sql/wholesale_portal_public_rpc.test.sql` | 8 casos de contrato, agnósticos al lockdown. |
| `tests/unit/portalPublicContract.test.ts` | Allowlist, prohibición de `select('*')`, fallback acotado. |

### El fallback

- Se activa **sólo** si el objeto no existe: `PGRST202`, `42883`, `PGRST205`, `42P01`.
- **No** se activa para `42501`, `PGRST301`, `PGRST116` ni 5xx. Decide por **código**, nunca por el texto del mensaje.
- Usa la allowlist explícita de 7 columnas. **Nunca `*`.**
- Es transitorio: se elimina en un lote posterior, una vez estabilizado el lockdown.

Con el fallback, los tres órdenes de despliegue posibles son seguros. Hace falta porque mergear no aplica migraciones (el `db push` es a mano) pero Vercel sí despliega el frontend al mergear.

### Higiene de la RPC (verificada en test, CASO 7)

- `SECURITY DEFINER` — necesario: la proyección por fila no se puede resolver con privilegios del invocador.
- `SET search_path = pg_catalog, pg_temp` — sin `public`, todas las referencias calificadas, `pg_temp` explícito y **último**.
- `REVOKE ALL … FROM PUBLIC` — `EXECUTE` a PUBLIC es el default de PostgreSQL.
- `EXECUTE` sólo para `anon` y `authenticated`.
- `RETURNS TABLE` fijo de 7 columnas, igualdad exacta por slug, cero SQL dinámico.

---

## 5. FASE 2 — lockdown (rama aparte, todavía no publicada)

`fix/security-wholesale-portal-read-lockdown`, a crear desde `main` actualizado y **sólo después** del smoke productivo de FASE 1. Dropea `businesses_portal_public_read`, revoca el `SELECT` de `anon`, y conserva `businesses_select`.

---

## 6. Verificación local

Stack local con las 210 migraciones + FASE 1 + FASE 2, negocio `smoke-on` (habilitado) y `smoke-off` (deshabilitado), columnas sensibles con valores falsos, un usuario miembro y uno de otro tenant.

### PostgREST — antes y después del lockdown

| Chequeo | Pre-lockdown | Post-lockdown |
|---|---|---|
| A1 · RPC anon, slug habilitado | 7 columnas | 7 columnas |
| A2 · RPC anon, slug deshabilitado | `[]` | `[]` |
| A3 · RPC anon, slug inexistente | `[]` | `[]` |
| B1 · RPC con sesión del miembro | 200 | 200 |
| B2 · miembro lee `mp_*` de **su** negocio | 200 | 200 (preservado) |
| C1 · RPC cross-tenant | allowlist, sin `mp_*` | allowlist, sin `mp_*` |
| C2 · `SELECT` directo cross-tenant | **filtra `mp_payer_email` + `mp_preapproval_id`** | **`[]`** |
| D1 · `anon` lista la tabla | **filtra** | **`42501 permission denied`** |
| D2/D3/D4 · slug parcial / `%` / vacío | `[]` | `[]` |

### Navegador (Vite dev contra Supabase local)

- Preflight fail-closed verificó destino local antes de levantar.
- `/mayorista/smoke-on` → portal carga (redirige a `/login`, correcto para anónimo), tanto con sesión como sin ella.
- `/mayorista/smoke-off` y slug inexistente → «Portal no disponible».
- Red: `POST /rest/v1/rpc/get_wholesale_portal_public → 200`. **Cero** requests a `/rest/v1/businesses` ⇒ el fallback no se disparó y el portal nunca toca la tabla.
- Consola sin errores.

### Suites

- `tests/sql/wholesale_portal_public_rpc.test.sql` — 8/8, **con y sin** lockdown aplicado.
- `tests/sql/wholesale_portal_public_read.test.sql` — 12/12 (estado final, viaja en FASE 2).
- `npm run test:unit` — 600/600.
- `npx tsc --noEmit` — 0 errores · `npm run lint:errors` — 0 errores.
- `npm run guards` — exit 0, incluidos `guard:view-invoker` y `guard:secdef`.

---

## 7. Riesgos vivos

1. **Acceso histórico desconocido.** Sin logs que cubran la ventana, no se puede afirmar que nadie haya leído los datos expuestos. El dato en juego es PII (un email de facturación) e identificadores internos de un negocio.
2. **Ventana abierta hasta la FASE 2.** La FASE 1 no cierra nada por sí sola: es aditiva. Los tres vectores siguen abiertos hasta aplicar el lockdown.
3. `businesses_insert` también quedó sin cláusula `TO` (aplica a PUBLIC). Hoy es inocua — `anon` no tiene `GRANT INSERT` y el `WITH CHECK` exige `owner_user_id = auth.uid()` — pero debería ser `TO authenticated`. Fuera de alcance, anotada.
