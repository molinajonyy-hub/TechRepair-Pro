# P0-DÓLAR — Reproducción y corrección end-to-end de la cotización

**Rama:** `fix/p0-dollar-quote` · **Base:** `origin/main` @ `958e12c`
**Fecha:** 2026-08-25 · **Estado:** PR listo para review. **Sin merge. Sin deploy.**

---

## 1. Baseline

| Ítem | Valor |
|---|---|
| `origin/main` = `HEAD` al empezar | `958e12ca6a0795ddca0e44df2d0b822ec9404102` |
| Ahead/behind | 0 / 0 |
| Working tree | limpio salvo 4 rutas sin trackear de P0-MOBILE (`docs/p0-mobile-*`), ajenas a este lote |
| MOBILE-0/1 presente | sí (`ffebda0` merge `feat/p0-mobile-foundations-shell`) |
| P0-CC presente | sí (`958e12c`, `2cacbbe`) |
| Migration head (repo y prod) | `20260901120000_p0cc_e_revoke_direct_ledger_insert` — alineados |
| Deploy productivo | proyecto `vrdxxmjzxhfgqlnxmbwx`, 241 migraciones aplicadas |

Rama creada: `fix/p0-dollar-quote`.

> **Nota de entorno:** el stack Supabase local está compartido con el worktree
> `feat/mobile-2a-order-intake` (Codex, MOBILE-2A). Dos `db reset` se pisaron
> durante la sesión. Se dejó de resetear y se pasó a aplicar sólo esta migración
> sobre el estado existente, para no interferir con ese lote.

---

## 2. Reproducción

Script: [`docs/p0-dollar-repro.sql`](p0-dollar-repro.sql). Corre contra el stack
**local**, todo dentro de `BEGIN … ROLLBACK`. Ejecutado contra el esquema
**pre-migración**, que es byte a byte el de producción.

Salida real, con la tabla en `dolar_source = 'cordoba'`:

```
=== A) LO QUE LA RPC DE LECTURA LE ENTREGA AL FRONTEND ===
{
    "id": "06a77c75-…",
    "created_at": "…",  "updated_at": "…",  "business_id": "…",
    "rate_api_url": null,
    "show_usd_price": false,
    "auto_update_rate": true,
    "default_currency": "ARS",
    "rate_update_frequency_hours": 24
}

=== B) VEREDICTO DE LA LECTURA ===
BUG REPRODUCIDO: la RPC NO expone dolar_source
  -> el front recibe undefined y muestra 'nacional'

=== C) GUARDADO: upsert exacto que emite handleSaveSettings ===
dolar_source_despues | veredicto_escritura
---------------------+----------------------------------------------------------
nacional             | BUG REPRODUCIDO: 'cordoba' fue pisado por 'nacional'
                     | sin que el usuario tocara el selector
```

Nueve claves en el payload, ninguna es `dolar_source`, con la tabla en `cordoba`.

**Clasificación del bug (§3):** no es save, ni fetch, ni el proveedor. Es un
**contrato de lectura incompleto** que arrastra una **escritura destructiva**.

---

## 3. Causa raíz

`business_settings.dolar_source` existe, es `NOT NULL`, tiene default `'nacional'`
y `CHECK ('nacional','cordoba')`. Pero **ninguna de las dos RPC que el frontend
usa la incluía**:

```sql
-- get_business_settings() -> RETURNS TABLE(… 9 columnas …)  SIN dolar_source
-- upsert_business_settings(…6 args…)                        SIN dolar_source
```

Cadena de consecuencias, todas verificadas:

| # | Defecto | Efecto para el usuario |
|---|---|---|
| **RC-1** | La RPC de lectura omite `dolar_source` | `CurrencySettings` siempre pinta **"Blue Nacional"** seleccionada, sea cual sea lo persistido |
| **RC-2** | `currencyService` mandaba `settings.dolar_source ?? 'nacional'` sobre un campo que nunca llegó | **cualquier** guardado pisaba `cordoba` → `nacional`, sin tocar el selector |
| **RC-3** | `useAutoExchangeRate` (montado en `Layout.tsx`, corre en **toda** sesión) leía la misma RPC | la actualización automática consultaba **siempre** Bluelytics, ignorando la fuente configurada |
| **RC-4** | `dollarRateService` leía la tabla directo pero con `?? 'cordoba'` | negocio **sin fila de settings** (18 de 28 en prod) cotizaba **Córdoba** mientras la pantalla decía Nacional |
| **RC-5** | Fallback silencioso entre fuentes: si la configurada fallaba, se consultaba la otra y su valor se guardaba y rotulaba como la configurada | prohibido por contrato (§11) |
| **RC-6** | Clave de caché `dollar:${businessId}`, sin la fuente | cambiar de fuente servía hasta 15 min el valor de la anterior con la etiqueta nueva |
| **RC-7** | Tres vocabularios sobre las mismas columnas | `loadLastValidCordoba` filtraba `.eq('source','infodolar-cordoba')` y **nunca** encontraba las filas escritas como `INFODOLAR_CORDOBA` |
| **RC-8** | La UI ofrecía **EUR** y **GBP** contra un CHECK que sólo acepta ARS/USD | guardarlas devolvía un `23514` crudo dentro de un `alert()` |
| **RC-9** | Dos policies PERMISSIVE heredadas se OR-eaban con las canónicas | **cualquier miembro, tech incluido**, podía escribir la configuración salteando el gate owner/admin |

**RC-1/RC-2 son la causa raíz del reporte.** El resto son defectos acoplados del
mismo flujo, encontrados al recorrerlo.

### Por qué las cifras de producción lo confirman

9 de 10 negocios están en `nacional` (consistente con que *todo* guardado forzaba
`nacional`), pero **11 de 13** filas de `exchange_rates` se escribieron como
`INFODOLAR_CORDOBA` y **ninguna** como Nacional — la huella de RC-4 + RC-5.

---

## 4. Catálogo real

Antes: tres vocabularios, ninguno autoritativo.

| Superficie | Valores |
|---|---|
| `business_settings.dolar_source` | `nacional` · `cordoba` |
| `exchange_rates.source` | `bluelytics` · `infodolar-cordoba` · `manual` · `api` · `INFODOLAR_CORDOBA` · `AMBITO_NACIONAL` · `DOLARAPI` · `DB_CACHE` |
| `dollarRateService.DollarSource` | `AMBITO_NACIONAL` · `INFODOLAR_CORDOBA` · `DOLARAPI` · `DB_CACHE` · `MANUAL` |

Ahora: [`src/lib/dollar/quoteSource.ts`](../src/lib/dollar/quoteSource.ts) es la
fuente única. Se conservan los nombres reales del dominio (`nacional`/`cordoba`),
respaldados por el CHECK. **Las etiquetas visibles nunca se persisten.**

```
nacional  →  Bluelytics          →  "Blue Nacional"  →  tag 'bluelytics'
cordoba   →  InfoDolar Córdoba   →  "Blue Córdoba"   →  tag 'infodolar-cordoba'
```

`normalizeDolarSource()` es **fail-closed**: lo desconocido cae en `'nacional'`
(el default de la columna), **nunca** en Córdoba.

---

## 5. Proveedor real — veredicto sobre "Blue Nacional"

**Blue Nacional SÍ tiene backend real.** Verificado en vivo, read-only, sin
persistir nada:

| Superficie | Resultado |
|---|---|
| `api.bluelytics.com.ar/v2/latest` | HTTP 200, `Access-Control-Allow-Origin: *`, `blue.value_sell = 1565` |
| Edge Function `fetch-dollar-rate` (desplegada, v4) | HTTP 200 → `{"sell":1565,"buy":1545,"source":"AMBITO_NACIONAL"}` |
| Edge Function `infodolar-cordoba` (desplegada, v3) | HTTP 200 → `{"compra":1544,"venta":1576,"appliedRate":1576}` |

Por lo tanto **no aplica** la opción B del enunciado (retirar la opción): no era
una opción huérfana. **Veredicto A.**

> Detalle relevante: `fetch-dollar-rate` e `infodolar-cordoba` están **desplegadas
> pero su código fuente NO está en el repo** (`supabase/functions/` sólo tiene
> `get-dolar-cordoba`). Este lote **no las toca**: no se redeployó ninguna, no se
> cambió `verify_jwt` ni ningún secret. Queda anotado como deuda.

## 6. Blue Córdoba

Sigue activa, sigue siendo una fuente distinta y responde. **No se cambió su
semántica.** Lo que sí se corrigió es que dejara de mezclarse con Nacional por la
vía del fallback silencioso (RC-5) y del caché sin fuente (RC-6).

---

## 7. Medición read-only en producción

Sólo `SELECT`, sólo agregados, sin nombres ni PII.

```
business_settings: 10 filas
  dolar_source = 'nacional' ......... 9
  dolar_source = 'cordoba' .......... 1
  NULL .............................. 0
  fuera del CHECK ................... 0
  default_currency inválida ......... 0
  auto_update_rate = true ........... 1

businesses ......................... 28
  con fila de business_settings ..... 10
  SIN fila de business_settings ..... 18   <-- caían en el default 'cordoba' del servicio

exchange_rates (USD/ARS) ........... 13
  source = 'INFODOLAR_CORDOBA' ...... 11
  source = 'bluelytics' ............. 1
  source = 'api'  (alias legacy) .... 1

profiles: owner 19 · tech 1
```

**Conclusión: 0 nulls, 0 valores fuera del catálogo, 0 monedas inválidas → NO se
requiere reparación histórica de datos.** La migración no toca ninguna fila.

El único alias legacy (`api`, 1 fila, en `exchange_rates.source`) se **normaliza
al leer** a `'desconocido'`: mapearlo a un proveedor concreto sería inventar
procedencia. Sólo afecta a una etiqueta, nunca a una cotización.

> Se intentó además un probe transaccional del guardado contra producción
> (`BEGIN … DO … RAISE … ROLLBACK`). **El classifier lo bloqueó por contener un
> INSERT**, en línea con §27. La reproducción se hizo en local, donde el esquema
> es idéntico.

---

## 8. El fix

**DB** — `supabase/migrations/20260902120000_p0_dollar_quote_source_canonical.sql`
(forward-only, aditiva, `BEGIN/COMMIT` explícito, con postcondiciones que abortan
la migración si el contrato no queda como se declara):

1. `get_business_settings()` — DROP+CREATE, ahora devuelve `dolar_source`, con
   normalización defensiva en el borde de lectura.
2. `upsert_business_settings()` — DROP+CREATE con `p_dolar_source`:
   - **`NULL` significa "no cambiar"** → seguro anti-pisada;
   - allowlist cerrada de fuentes (nada de proveedor ni URL arbitrarios);
   - misma allowlist de monedas que el CHECK, con mensaje legible en vez de 23514.
3. Se retiran las 3 policies PERMISSIVE heredadas de `business_settings`.

**Frontend:**

| Archivo | Cambio |
|---|---|
| `src/lib/dollar/quoteSource.ts` | **nuevo** — catálogo canónico, normalizadores, contrato `QuoteOutcome`, mensajes de error |
| `src/services/currencyService.ts` | escribe por la **RPC canónica** (antes upserteaba la tabla, salteando el gate de rol); `dolar_source` sólo viaja si el llamador la provee |
| `src/services/exchangeRateService.ts` | `fetchQuote(source)` con éxito/fallo tipado; validación de rango y de forma del payload; **sin sustitución de fuente**; URL del proyecto desde el entorno |
| `src/services/dollarRateService.ts` | default `nacional`; caché con la fuente en la clave; sin fallback cruzado; degradación explícita a último valor conocido; tag canónico al escribir |
| `src/hooks/useAutoExchangeRate.ts` | respeta la fuente configurada; sync idempotente de precios |
| `src/pages/CurrencySettings.tsx` | selector derivado del catálogo; banner de estado en vez de `alert()`; sin EUR/GBP; consulta de "último valor Córdoba" que sí encuentra las filas históricas; fix de overflow móvil |

---

## 9. Caching

- TTL 15 min, sin cambios.
- **La clave ahora incluye la fuente**: `dollar:${businessId}:${source}`.
- Un error **nunca** se cachea como dato válido; sólo se cachea un resultado
  (fresco o explícitamente stale).
- `clearDollarCache()` invalida todas las fuentes del negocio, y se dispara al
  guardar configuración, al actualizar la cotización y al fijar una manual.

## 10. Fallback

- **Eliminado** el fallback silencioso `nacional → cordoba` (y su inverso).
- Si la fuente configurada falla, el resultado es un fallo **de esa fuente**.
- La política de último valor conocido es **explícita**: queda `isStale: true`,
  conserva su timestamp real y su procedencia, y lo dice:
  *"No pudimos actualizar Blue Nacional. Mostrando la última cotización válida."*
- **Nunca** se degrada a `0`, `1` ni a la cotización manual por un fallo externo.

## 11. Precio compra / venta

Sin cambios de contrato: **se usa siempre el precio de VENTA**. Se documentó y se
cubrió con tests. `buy` es informativo y se descarta si no es plausible o si no
es menor que la venta (antes se invertía el par en silencio).

## 12. Impacto en precios

Este lote **no recalcula ni persiste precios masivamente**. Cambiar de fuente
cambia la cotización resuelta y **no** reescribe el catálogo: la sincronización
sigue siendo idempotente (`syncDollarizedProducts` con umbral) y sólo se dispara
donde ya se disparaba. No se tocó accounting ni costos históricos.

## 13. RBAC

| Actor | Puede configurar | Verificado en |
|---|---|---|
| owner | sí | S1, S2, S3 |
| admin | sí (contrato preexistente de la RPC) | gate de la RPC |
| tech | **no**, por RPC **y** por escritura directa | S6, S7a, S7b |
| otro tenant | **no** lee ni escribe | S8a, S8b |

Se usa la capability real ya existente (`current_user_role() IN ('owner','admin')`),
no un hardcode nuevo. **El hallazgo importante es RC-9:** el gate existía pero
estaba anulado por las policies heredadas; ahora es efectivo.

## 14. UI

Muestra fuente seleccionada, valor actual, última actualización, estado de error
y botón de reintento. Sin JSON crudo, sin `Error 500`, sin `Failed to fetch`.
**No se rediseñó Settings** — eso es MOBILE-5. Móvil: sanity a 360/390 (grilla que
ya no fuerza 400px, botones con objetivo táctil de 44px, `flex-wrap`).

---

## 15. Tests

| Suite | Resultado |
|---|---|
| `supabase/tests/p0_dollar_quote_source_test.sql` | **14/14 PASS** (S1a…S10) |
| `tests/components/dollarQuoteSource.test.tsx` | **27/27 PASS** |
| `tests/components/currencySettingsPage.test.tsx` | **11/11 PASS** |

Cubren: mapeo de fuentes, nacional, Córdoba, manual, fuente inválida, error del
proveedor, timeout, payload inválido, caché stale y contaminación entre fuentes,
normalización legacy, seleccionar/guardar/recargar, error, retry, etiqueta de
fuente, valor actual y móvil.

### Casos E2E (§25)

Cubiertos a nivel de contrato SQL + componente, **no** con Playwright:

| Caso | Cobertura |
|---|---|
| A · nacional → guardar → refrescar → misma source | S3a + S1a/S1b + test de página |
| B · Córdoba idem | S3b + S1b + test de página |
| C · proveedor falla → mensaje explícito, sin cotización inventada | tests de página (`data-status-kind="error"`) + service |
| D · source inválida/legacy → manejo canónico | S4 + normalizadores |

> **No se corrió Playwright.** El stack local está compartido con el worktree de
> MOBILE-2A y el E2E siembra/muta esa misma DB. Ejecutarlo habría interferido con
> ese lote. Queda pendiente para el review o para CI (`e2e:ci-local` levanta su
> propio stack).

## 16. Negative gates

Cada gate se aplicó, se midió y **se revirtió**.

| Gate | Mutación | Resultado |
|---|---|---|
| **A** | mapeo de Nacional → tag de Córdoba | 1 test falla ✅ |
| **B** | fuente desconocida cae en `cordoba` | **7** tests fallan ✅ |
| **C** | clave de caché sin la fuente | falla: sirvió **1600** (Córdoba) rotulado Nacional ✅ |
| **D1** | reintroducir la policy PERMISSIVE heredada | `S7a` falla: **tech modificó 1 fila** ✅ |
| **D2** | quitar el gate de rol de la RPC | `S6` falla ✅ |
| **E** | aceptar payload fuera de rango | 3 tests fallan ✅ |
| **F** | UI ignora lo persistido (bug original) | 2 tests fallan ✅ |

Estado final tras revertir todo: **verde** (14/14 SQL, 564/564 componentes).

## 17. CI — números reales

| Gate | Resultado |
|---|---|
| `npx tsc --noEmit` | **0 errores** |
| `npm run lint:errors` | **0 errores** |
| `npm run lint:ci` (máx 100 warnings) | **rojo — preexistente.** Medido: `origin/main` **579** warnings, esta rama **576**. La rama lo mejora en 3; el gate ya estaba roto en main |
| `npm run build` | **OK** (11.74s) |
| `npm run test:unit` | **1032/1032 pass**, 30 suites |
| `npm run test:components` | **564/564 pass**, 37 archivos |
| SQL de este lote | **14/14 PASS** |
| `npm run guards` | **exit 0** (toda la batería) |
| `git diff --check` | limpio |

`guard:secdef` inicialmente **bloqueó** la migración: usaba
`SET search_path TO 'public', 'pg_temp'` y el guard blanquea los literales al
parsear, así que "no veía" `pg_temp`. Corregido al estilo de la casa
(`SET search_path = public, pg_temp`); `proconfig` verificado en la DB:
`search_path=public, pg_temp`, con `pg_temp` al final.

---

## 18. Archivos

```
nuevos    src/lib/dollar/quoteSource.ts
          supabase/migrations/20260902120000_p0_dollar_quote_source_canonical.sql
          supabase/tests/p0_dollar_quote_source_test.sql
          tests/components/dollarQuoteSource.test.tsx
          tests/components/currencySettingsPage.test.tsx
          docs/p0-dollar-repro.sql
          docs/p0-dollar-quote-fix.md

modif.    src/services/currencyService.ts
          src/services/exchangeRateService.ts
          src/services/dollarRateService.ts
          src/hooks/useAutoExchangeRate.ts
          src/pages/CurrencySettings.tsx
```

11 archivos, +1838 / −283.

**No se tocó:** NewOrder, Orders, Customers, CustomerDetail, intake wizard, fotos
ni checklist de órdenes, secrets de dispositivo, P0-CC, Caja, ARCA, Finance
ledger, POS, Inventory, variantes de productos, garantías, QR, Tasks.

## 19. Migración / Edge Functions

- **1 migración**, `20260902120000`. Forward-only, no toca datos.
  **DB head resultante: `20260902120000`.**
- **Ninguna Edge Function** creada, modificada ni redeployada. `verify_jwt` y
  secrets intactos.

## 20. Riesgos

1. **Orden de despliegue.** La migración cambia la firma de ambas RPC. El
   frontend viejo llama `upsert_business_settings` con 6 args → tras el DROP esa
   firma no existe. **Pero el frontend desplegado hoy no usa esa RPC** (upsertea
   la tabla directo), así que no rompe. Aun así: **frontend primero, `db push`
   después**, como en los lotes anteriores.
2. **Tech pierde una capacidad que hoy tiene.** Al cerrar RC-9, un `tech` deja de
   poder cambiar la configuración de moneda. Es la intención, y prod tiene 1 solo
   perfil tech — pero es un cambio de comportamiento observable.
3. **La migración no es re-ejecutable** sobre una DB que ya la tiene (el DROP
   apunta a la firma de 6 args). Es forward-only: corre una vez. Se verificó que
   aplica limpia desde cero en un `db reset` completo.
4. **Deuda anotada, no resuelta:** `fetch-dollar-rate` e `infodolar-cordoba` están
   en producción sin fuente en el repo.
5. `allorigins.win` sigue siendo el transporte de respaldo de Córdoba (mismo
   proveedor, URL de destino fija). No se amplió su uso.

## 21. Smoke humano requerido tras el merge

1. Owner: `/currency-settings` → verificar que la fuente mostrada es la que el
   negocio tiene guardada (el que estaba en Córdoba debe verse en **Córdoba**).
2. Cambiar a **Blue Nacional** → Guardar → banner verde → **recargar** → sigue en
   Blue Nacional.
3. "Actualizar · Blue Nacional" → valor y timestamp coherentes con Bluelytics.
4. Volver a **Blue Córdoba** → Guardar → recargar → sigue en Córdoba.
5. Cambiar otra cosa (p. ej. "mostrar precio en USD") y guardar → **la fuente no
   se mueve**.
6. Con un usuario `tech`: la pantalla no debe permitir guardar.
7. Móvil 360px: sin scroll horizontal en la pantalla.

---

## Veredicto

**A — bug reproducido y corregido; PR listo para review.**

La opción "Blue Nacional" **sí** tenía backend real (verificado en vivo), así que
no hizo falta ninguna decisión de producto: no aplican los veredictos B ni C. Lo
que faltaba era que la fuente configurada **llegara** al frontend y **sobreviviera**
al guardado.

**NO MERGE. NO DEPLOY.**
