# HOTFIX CRÍTICO — `get_finance_summary` expuesta sin autenticación

**Estado: BLOQUEADO esperando autorización. No aplicado en producción. No mergeado. Sin tag.**

Rama: `fix/security-revoke-public-finance-summary`, creada desde `origin/main` (`45b38f7`).
**No** parte de `a761792` ni lo incluye: los dos hotfixes están separados a propósito.

> **Evidencia sanitizada.** Ningún UUID ni cifra de este documento es real.
> `11111111-…` = tenant_a. Los importes son sintéticos y preservan
> `net_result = total_income − total_expenses`. Los procedimientos son
> reproducibles sin ningún secreto.

---

## 1. Firma exacta

```
public.get_finance_summary(p_business_id uuid, p_from date, p_to date)
  RETURNS TABLE(total_income numeric, income_today numeric, income_this_week numeric,
                income_this_month numeric, total_expenses numeric, net_result numeric,
                pending_balance numeric)
  LANGUAGE sql  STABLE  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
  OWNER postgres
```

Defaults: `p_from = CURRENT_DATE - 30 days`, `p_to = CURRENT_DATE`.
Lee `business_finance_entries` y `orders`, ambas filtradas **solo** por el
`p_business_id` que recibe.

---

## 2. Causa raíz

Dos cosas que por separado no alcanzan y juntas abren el agujero:

**a) La función no valida identidad.** Es `SECURITY DEFINER` propiedad de `postgres`,
así que el RLS de `business_finance_entries` y `orders` no se aplica. Su único filtro
es el `p_business_id` que le pasa el llamador — que el llamador elige.

**b) El `EXECUTE` a `PUBLIC` nunca se escribió: es el default de PostgreSQL.**
La ACL era:

```
{=X/postgres, postgres=X/postgres, authenticated=X/postgres}
 ^^^ grantee vacío = PUBLIC
```

`anon` **no** tenía grant propio: heredaba `EXECUTE` de `PUBLIC`. Y ese grant a `PUBLIC`
no aparece en ninguna migración porque **PostgreSQL lo otorga solo al crear cualquier
función**. El script original (`supabase/_archive/loose-scripts/…`) solo hizo
`GRANT EXECUTE … TO authenticated`; la exposición a `anon` la puso el motor.

Por eso el guard estático encuentra `authenticated` pero **no** puede ver el grant a
`PUBLIC`: no hay texto que leer. Esa es exactamente la razón por la que el suite
dinámico contra la base viva no es redundante.

**Consecuencia:** un `REVOKE EXECUTE … FROM anon` habría pasado una revisión de
código y no habría cerrado nada.

---

## 3. Evidencia — camino público real

Reproducido con `POST /rest/v1/rpc/get_finance_summary`, header `apikey` con la
**publishable key** y **sin `Authorization`**. Sin `service_role`, sin `postgres`,
sin `supabase_admin`.

| | Antes del fix | Después del fix (local) |
|---|---|---|
| HTTP | **200** | **401** |
| código PG | — | **42501** (`insufficient_privilege`) |
| filas | **1** | **0** |
| campos | los 7 financieros | — |
| valores | **distintos de cero** | — |

La publishable key es pública por diseño: viaja en el bundle del frontend. Cualquiera
que abra la app la tiene. El único dato adicional necesario es el UUID del negocio.

**Superficie de `authenticated`:** también tenía `EXECUTE` (grant propio, confirmado en
la ACL), así que cualquier usuario logueado podía leer cualquier otro negocio. No se
probó por HTTP porque habría requerido credenciales de un usuario real, y el acceso de
`anon` ya lo subsume: si el no autenticado entra, el autenticado también.

---

## 4. Consumidores encontrados: **ninguno**

| Búsqueda | Resultado |
|---|---|
| Funciones de la base que la llaman (barrido de `prosrc`) | 0 |
| Dependencias en `pg_depend` | 0 |
| `src/**` (`.ts`, `.tsx`) | 0 |
| `supabase/functions/**` (Edge Functions) | 0 |
| `scripts/**` | 0 |
| Repo completo | 3 archivos: el baseline remoto (definición), `20260713310000` (le fija el `search_path`) y `supabase/_archive/loose-scripts/` |

No se asumió que "solo aparece en `_archive`" probara nada: se verificó por catálogo
(`pg_proc`, `pg_depend`) **y** por búsqueda estática sobre todo el repo.

Por eso el arreglo es cerrar la superficie, no agregarle un `auth.uid()` a código
muerto y dejarlo publicado.

---

## 5. ACL antes / después

| Rol | Antes | Después | Vía |
|---|---|---|---|
| `PUBLIC` | **EXECUTE** (default de PG) | — | `REVOKE … FROM PUBLIC` |
| `anon` | **EXECUTE** (heredado de PUBLIC) | — | cae con PUBLIC + revoke explícito |
| `authenticated` | **EXECUTE** (grant propio) | — | `REVOKE … FROM authenticated` |
| `service_role` | **EXECUTE** (heredado de PUBLIC) | — | `REVOKE … FROM service_role` |
| `postgres` (owner) | EXECUTE | **EXECUTE** | sin cambios |

**Decisión sobre `service_role`:** se revoca. Tenía `EXECUTE` solo por herencia de
`PUBLIC`, no por un grant deliberado, y no se encontró ningún consumidor server-side
(Edge Functions, scripts, webhooks). No se demostró necesidad activa, así que se cierra.
Si mañana aparece un consumidor legítimo, el grant se agrega explícito y documentado —
que es justamente la diferencia con heredarlo sin que nadie lo haya decidido.

---

## 6. La migración

`supabase/migrations/20260719130000_security_revoke_public_finance_summary.sql`

```sql
REVOKE ALL ON FUNCTION public.get_finance_summary(uuid, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_finance_summary(uuid, date, date) FROM anon;
REVOKE ALL ON FUNCTION public.get_finance_summary(uuid, date, date) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_finance_summary(uuid, date, date) FROM service_role;
```

Más un `COMMENT` que explica por qué queda retirada, y una **post-condición dura**: si
algún rol de cliente conserva `EXECUTE`, la migración lanza excepción y **no** se marca
como aplicada.

La post-condición usa `has_function_privilege`, que resuelve la herencia — es la
pregunta correcta ("¿puede ejecutarla?") en vez de "¿tiene un grant propio?". Con la
segunda, este bug no se habría detectado nunca.

**No hace `DROP`** (irreversible, y sin `EXECUTE` la función ya es inalcanzable vía
PostgREST). **No cambia el cuerpo, ni tablas, ni RLS, ni amplía ningún grant.**

---

## 7. Guard y verificación

Dos redes, porque ninguna sola alcanza:

| | Qué mira | Qué atrapa | Qué NO puede ver |
|---|---|---|---|
| `npm run guard:finance-summary-private` | texto de las migraciones, **ordenado** | un `GRANT` futuro que reabra el permiso | el grant por default de PG a `PUBLIC` — no hay texto |
| `npm run verify:finance-summary-private` | HTTP contra PostgREST como `anon` | el estado real, incluido el default | — |

El guard es **deliberadamente angosto**: mira una función. No marca `SECURITY DEFINER`
en general por no contener el literal `auth.uid()`, porque los helpers legítimos
(`current_platform_admin_role()`, checks de membresía, funciones intermedias) lo usan
por dentro y ese criterio daría una avalancha de falsos positivos. Ese triage más amplio
es trabajo aparte (Parte 8).

Ambos son **order-aware**: gana la última sentencia. Un `REVOKE` viejo no protege de un
`GRANT` nuevo, y así es como reaparecen estos agujeros.

---

## 8. Archivos

| Archivo | |
|---|---|
| `supabase/migrations/20260719130000_security_revoke_public_finance_summary.sql` | nuevo — el fix |
| `supabase/tests/security_get_finance_summary_revoked_test.sql` | nuevo — 13 asserts |
| `scripts/finance/guard-finance-summary-not-public.mjs` | nuevo — guard + 11 fixtures |
| `scripts/finance/verify-finance-summary-private.mjs` | nuevo — verificación HTTP |
| `package.json` | +3 scripts, guard integrado a `guards` |
| `docs/auditoria-finanzas/m7-hotfix-finance-summary/rollback.sql` | nuevo |
| `docs/auditoria-finanzas/m7-hotfix-finance-summary/README.md` | este documento |

**Cero cambios en `src/`.** `secdef-baseline.json` no cambia: la migración no define
funciones nuevas.

---

## 9. Pruebas ejecutadas

### `supabase db reset --local` desde cero — **VERDE**

189 migraciones aplicadas en orden, incluida la nueva, con su `NOTICE` de
post-condición. `supabase db diff --local` → **`No schema changes found`** (drift 0).

| Verificación | Resultado |
|---|---|
| `supabase db reset --local` | **OK**, 189 migraciones |
| `supabase db diff --local` | **drift 0** |
| Suite nueva (`security_get_finance_summary_revoked_test.sql`) | **13/13 PASS** |
| `etapa7_7e1_public_create_lockdown_test.sql` | **16/16 PASS** |
| `etapa7_7c1_security_definer_hardening_test.sql` | **57/57 PASS** |
| `etapa6_rls_lockdown_test.sql` | **39/39 PASS** |
| `verify:finance-summary-private` (HTTP, local) | **CERRADO** — 401 / 42501 |
| Falsificación HTTP (re-grant local) | **FUGA detectada** — 200 + 1 fila, exit 1 |
| `npx tsc --noEmit` | **0 errores** |
| `npm run lint:errors` | **0 errores** |
| `npm run guards` | **PASS** (incluye 11 fixtures nuevas) |
| `npm run test:unit` | **484/484** |
| `npm run build` | **OK** |

La falsificación se corrió en los dos planos: en SQL (GFS8–GFS11, re-grant y revoke
dentro de la transacción) y por HTTP (re-grant local → el verificador devuelve
`FUGA ABIERTA` y exit 1; revoke → `CERRADO` y exit 0). El estado local quedó restaurado
y verificado.

---

## 10. Rollback

`docs/auditoria-finanzas/m7-hotfix-finance-summary/rollback.sql` — restaura la ACL
exacta previa. **Reabre la fuga a propósito**; documenta que la respuesta correcta ante
un consumidor legítimo no es restaurar el grant sino reescribir la función con
`auth.uid()`, como `finance_dashboard_summary`.

---

## 11. Riesgo residual

| Riesgo | Severidad | Estado |
|---|---|---|
| Un consumidor no detectado se rompe | **Muy baja** | Catálogo + `pg_depend` + búsqueda en todo el repo: 0 referencias activas |
| El grant vuelve por default de PG en una recreación | **Media** | Si alguien hace `CREATE OR REPLACE` de la función, PG **vuelve a otorgar `EXECUTE` a `PUBLIC`**. El `verify:` lo detecta; el guard estático no. Documentado en el `COMMENT`. |
| Se re-otorga explícitamente | **Baja** | Guard estático en `npm run guards` |
| `service_role` lo necesitaba | **Baja** | Sin consumidores server-side. Reversible con un grant explícito. |
| Datos o métricas cambian | **Nula** | No se toca cuerpo, tablas ni RLS |
| Ventana de exposición histórica | **No evaluada** | Ver abajo |

**Lo que este hotfix no responde:** cuánto tiempo estuvo expuesta y si alguien la
explotó. Los logs de PostgREST dirían si hubo llamadas a este endpoint. No lo
investigué — excede el alcance que fijaste, pero para un dato financiero accesible sin
autenticación es una pregunta que probablemente quieras responder antes de cerrar el
incidente.

---

## 12. Hallazgo separado — SIGSEGV en PostgreSQL 17.6.1.104

Encontrado al escribir el suite. **No lo causa este hotfix.**

Este patrón **crashea el backend con SIGSEGV** (signal 11), tumbando todas las
conexiones y forzando recuperación automática:

```sql
DO $$ DECLARE e text; BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM * FROM public.<funcion_sin_permiso>(...);
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  RESET ROLE;
END $$;
```

Aislado por descarte: el cambio de rol solo **no** crashea; la llamada sin cambio de rol
**no** crashea; hace falta la combinación con el error de permisos capturado dentro de
plpgsql. Reproducido con `get_finance_summary` **y** con `finance_dashboard_summary`, o
sea no es propio de una función. Reproducido 2 de 2 veces.

Entorno: `public.ecr.aws/supabase/postgres:17.6.1.104` — **el mismo build que
producción**.

**No se probó contra producción**, deliberadamente: sería provocar una caída de un
sistema en uso.

**Explotabilidad: baja.** Requiere ejecutar un bloque `DO`, y `anon` no puede hacerlo vía
PostgREST. No es alcanzable desde la API pública. Pero sí tumba la instancia entera para
un operador que corra scripts de mantenimiento o suites de test — que es exactamente
cómo apareció.

Por eso el suite prueba el rechazo dinámico por HTTP y no con cambio de rol en SQL.
Vale reportarlo aguas arriba a Supabase/PostgreSQL.

---

## 13. Recomendación

**GO.**

El defecto es crítico y está probado por el camino público real. El fix es mínimo
(cuatro `REVOKE`), no toca datos ni lógica, es reversible, no tiene consumidores que
romper, y quedó validado con `db reset` local completo, drift 0, 125 asserts SQL entre
la suite nueva y las de seguridad existentes, y falsificación en los dos planos.

El bloque de verificación que faltaba en el hotfix anterior —`db reset` local— acá se
ejecutó entero y quedó verde.

Condición previa al deploy: **backup lógico manual** (el plan es free, sin backups
automáticos).

Sugerencia de orden: desplegar **este** primero y solo. Es el más grave —el único
alcanzable sin autenticarse— y es el cambio más chico y aislado de los dos. El de las
tres vistas se reintegra después sobre el nuevo `origin/main` (Parte 6).
