# P0-OPS-DOLLAR-FUNCTIONS — recuperación, versionado y auditoría

**Fecha:** 2026-08-25 · **Rama:** `chore/p0-ops-dollar-functions` · **Base:** `b1676f5` (= `origin/main`)
**Proyecto Supabase:** `vrdxxmjzxhfgqlnxmbwx` (techrepair-pro, us-east-1)

**VEREDICTO: A** — el source productivo se recuperó con fidelidad **probada
mecánicamente** (hash idéntico), está versionado, auditado, con tests verdes y
PR listo para review.

> **NO se redeployó ninguna función. NO se tocó producción. NO se cambió
> `verify_jwt` en la plataforma. NO se tocaron secrets.**

Hay **un hallazgo de severidad alta** que NO bloquea este lote pero **sí debe
resolverse antes de cualquier redeploy**: ver §13 (cascadeo silencioso) y §21.

---

## 1. Baseline

| Ítem | Valor |
|---|---|
| `origin/main` | `b1676f5fabe40de967cb115c788157eb2a37ff5f` |
| HEAD al empezar | idéntico a `origin/main` |
| Working tree | limpio (salvo untracked de MOBILE-2A, no tocados) |
| Migration head | `20260902120000_p0_dollar_quote_source_canonical.sql` |
| P0-DÓLAR | mergeado (`47bac9c`), cerrado |
| MOBILE-2A | aislado en `C:\...\techrepair-vite-mobile-01`, rama `feat/mobile-2a-order-intake` @ `958e12c` — **no se tocó** |
| Worktree de este lote | `.claude/worktrees/p0-ops-dollar-functions` (nuevo, aislado) |

---

## 2. Inventario de deployment (medido, no asumido)

Las tres funciones de dólar están **ACTIVE** y las tres tienen
**`verify_jwt = false`**.

| Slug | Ver | `verify_jwt` | Status | `ezbr_sha256` | Creada | Última actualización |
|---|---|---|---|---|---|---|
| `fetch-dollar-rate` | 4 | `false` | ACTIVE | `f8ba2cfe…118c80` | 2026-04-30 14:22 UTC | 2026-05-20 13:28 UTC |
| `infodolar-cordoba` | 3 | `false` | ACTIVE | `b10cdf7a…9782e` | 2026-05-20 13:18 UTC | 2026-05-20 13:18 UTC |
| `get-dolar-cordoba` | 4 | `false` | ACTIVE | `e6b8abc7…4fa8c8` | 2026-04-19 23:39 UTC | 2026-04-19 23:39 UTC |

`import_map: false` en las tres. Ninguna declara import map ni config extra.

**Endpoint:** `https://vrdxxmjzxhfgqlnxmbwx.supabase.co/functions/v1/<slug>`

### Cronología (explica el diseño actual)

`infodolar-cordoba` se creó **626 segundos antes** de la última actualización de
`fetch-dollar-rate`. Las dos salieron en la misma sesión del 2026-05-20. Eso
encaja con el comentario que sigue vivo en `dollarRateService.ts:171-176`:
`infodolar-cordoba` se escribió para **reemplazar** el camino Córdoba de
`fetch-dollar-rate`, que confundía compra con venta.

O sea: `infodolar-cordoba` es la versión **corregida y fail-closed**;
`fetch-dollar-rate` quedó como el camino Nacional, pero **conservando** su
lógica vieja de Córdoba y su cascadeo.

### Deuda adyacente detectada (fuera de alcance)

`submit-lead` (v3, `verify_jwt=false`, ACTIVE) **tampoco tiene fuente en el
repo**. No se tocó en este lote. Queda anotada para un lote propio.

---

## 3. Método de recuperación

Se usó la vía **oficial soportada**, no reconstrucción por memoria:

```bash
npx supabase functions download <slug> --project-ref vrdxxmjzxhfgqlnxmbwx --use-api
```

`--use-api` desempaqueta el bundle server-side, sin Docker. Devolvió el source
completo de las tres funciones, incluido el módulo compartido
`_shared/cors.ts` que usa `get-dolar-cordoba`.

Se cotejó además contra la Management API (`get_edge_function`), que devuelve
los mismos bytes.

---

## 4. Fidelidad del source — **PROBADA**

No se afirma por inspección visual. Se probó a nivel de objeto Git:

| Función | Bytes | SHA-256 (contenido, LF) | blob staged == archivo bajado |
|---|---|---|---|
| `fetch-dollar-rate` | 7359 | `146b697b…44f15` | ✅ `d9bc185ccaa0` |
| `infodolar-cordoba` | 7731 | `2bdd6805…d1d4ca` | ✅ `dbfdb153334e` |
| `get-dolar-cordoba` | 4461 | `7a89ec81…843b8` | ✅ ya estaba versionada, **sin drift** |

`git diff --no-index` entre el archivo bajado y el versionado: **IDENTICAL** en
los tres casos. Los blobs commiteados no contienen CR.

**Cambios sobre el código recuperado: CERO.** Ni formato, ni lint-fix, ni
renombres, ni reordenamientos. No hizo falta ningún ajuste para que compile.

### `get-dolar-cordoba` no había derivado

El archivo que ya estaba en Git es **byte a byte** el que está desplegado
(v4). Su `_shared/cors.ts` también coincide.

### ⚠️ `ezbr_sha256` NO es comparable localmente

El `ezbr_sha256` que expone la plataforma hashea el **bundle eszip**, que
incluye metadata del build. No es reproducible desde el repo. Se registra como
identificador del deployment, **no** como algo que este repo pueda recomputar.

Lo que sí es comparable y lo que el guard verifica es el **hash del texto
fuente normalizado a LF** (columna 3 de la tabla).

---

## 5. `verify_jwt = false` — auditoría

Antes de este lote, `supabase/config.toml` **no declaraba `[functions.*]` para
ninguna** de las 18 funciones del proyecto. El valor lo fijaba el deploy por CLI.

Se agregaron las tres declaraciones de dólar con el valor **real medido**.

### ¿Es defendible que sean públicas?

| Pregunta | `fetch-dollar-rate` | `infodolar-cordoba` |
|---|---|---|
| A. ¿Sólo devuelve cotización pública? | **Sí** | **Sí** |
| B. ¿Consulta datos tenant-specific? | **No** | **No** |
| C. ¿Lee `business_id`? | **No** | **No** |
| D. ¿Usa `service_role`? | **No** | **No** |
| E. ¿Lee secrets? | **No — no lee NINGUNA env var** | **No** |
| F. ¿Permite mutaciones? | **No** | **No** |
| G. ¿Permite elegir URL/provider desde input? | **No** (ver §8) | **No** |

Ninguna de las dos instancia un cliente Supabase ni importa
`@supabase/supabase-js`. No tocan la base. **`verify_jwt = false` es una
decisión válida y se documenta como intencional.**

### 🔴 Por qué la declaración importa para el próximo deploy

El **default de `supabase functions deploy` es `verify_jwt = TRUE`**. Sin la
declaración en `config.toml`, el próximo deploy cerraría las tres funciones.

Y `dollarRateService.ts:204-208` llama a `fetch-dollar-rate` **sin ningún
header de `Authorization` ni `apikey`**:

```ts
const resp = await fetch(`${getSupabaseUrl()}/functions/v1/fetch-dollar-rate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },   // ← sin auth
  body: JSON.stringify({ source, lastKnown }),
})
```

Serían **401 silenciosos**: `!resp.ok → return null`, y el usuario vería la
cotización degradada a caché sin ningún error visible. La declaración explícita
cierra ese riesgo.

---

## 6. Secrets

**Ninguna de las dos funciones usa secrets ni variables de entorno.** Se
verificó por búsqueda directa: no hay `Deno.env`, ni `SUPABASE_*`, ni
`createClient`, ni tokens.

Nombres de env usados: **ninguno**. No hay valores que proteger porque no hay
valores.

El scan de credenciales sobre los archivos del PR sólo devuelve los **patrones
detectores del propio guard** y sus fixtures de self-test (un JWT fabricado sin
firma, con payload `{"role":"anon"}`). No hay credenciales reales.

---

## 7. Proveedores reales — **la premisa del handoff estaba invertida**

El handoff (`docs/handoff-p0-ops-dollar-functions.md:29-30`) decía:

> - `infodolar-cordoba` → Blue Córdoba
> - `fetch-dollar-rate` → Blue Nacional

**La segunda mitad es falsa a nivel de función.** El código desplegado dice otra
cosa.

### `fetch-dollar-rate` v4 — cascada de 3 proveedores, default Córdoba

```
body.source !== 'nacional'  →  preferCordoba = true   ← DEFAULT
   1. InfoDolar Córdoba   www.infodolar.com/...cordoba.aspx   (HTML scraping, timeout 15s)
   2. Ámbito Nacional     mercados.ambito.com/dolar/informal/variacion   (JSON, SIN timeout)
   3. DolarAPI            dolarapi.com/v1/dolares/blue                   (JSON, SIN timeout)
```

- Precio usado: `sell = max(par)`, `buy = min(par)`.
- Rango de validez: `> 500 && < 10000`. Fuera de rango → cascadea.
- Retries: ninguno. Fallback: **sí, cruzado entre provincias** (ver §13).
- Proxy intermediario: no.

Es **"Nacional" sólo porque el frontend le manda `source: 'nacional'`**. Un
caller anónimo que pegue sin body recibe **Córdoba** etiquetada
`INFODOLAR_CORDOBA`. Esto está cubierto por un test.

### `infodolar-cordoba` v3 — un solo proveedor, fail-closed

```
target = 'https://www.infodolar.com/cotizacion-dolar-provincia-cordoba.aspx'   (CONSTANTE)
   timeout 15s · sin retries · SIN fallback
```

Cuatro estrategias de parsing en orden: `json-embedded` → `html-table-row` →
`html-compra-venta-labels` → `text-explicit-labels` / `text-min-max`. La
estrategia que ganó se reporta en el campo `strategy`.

Invariante: `appliedRate === venta`, **siempre**. Y sólo acepta el par si
`venta > compra`; nunca invierte en silencio.

**No se cambió ningún proveedor.**

### Probe read-only de los proveedores (2026-08-25T19:11:25-03:00)

Sin persistir nada. Valores **volátiles**, no convertidos en fixtures.

| Proveedor | HTTP | Tamaño | Latencia | Muestra |
|---|---|---|---|---|
| infodolar.com Córdoba | 200 | 82 846 B | 651 ms | `text/html; charset=utf-8` |
| Ámbito informal | 200 | 144 B | 111 ms | `{"compra":"1545,00","venta":"1565,00"}` |
| DolarAPI blue | 200 | 146 B | 147 ms | `{"compra":1540,"venta":1560}` |

Confirma que Ámbito devuelve **strings con formato argentino** (por eso el
`parseARSNumber`) y DolarAPI **números**.

---

## 8. SSRF — sin hallazgos

Ninguna de las dos deriva el destino del request.

- `infodolar-cordoba`: `target` es una **constante del módulo**.
- `fetch-dollar-rate`: las tres URLs son **literales**. Del body sólo lee
  `source` (comparado contra `'nacional'`) y `lastKnown` (numérico).

Verificado con tests que mandan `url`, `provider`, `endpoint`,
`?url=http://169.254.169.254/`, `file:///etc/passwd` y aseveran que el único
egress fue al host esperado. El guard además falla si aparece un `fetch` cuyo
primer argumento menciona `req`/`body`/`searchParams`.

---

## 9. Contratos de respuesta (verificados contra el código desplegado)

### `fetch-dollar-rate`

**Éxito — 200**
```jsonc
{ "sell": 1576, "buy": 1544, "source": "INFODOLAR_CORDOBA", "province": "CORDOBA" }
```
`sell: number` · `buy: number` (**0** si sólo se pudo parsear un precio) ·
`source: 'INFODOLAR_CORDOBA' | 'AMBITO_NACIONAL' | 'DOLARAPI'` ·
`province: 'CORDOBA' | null`.

**⚠️ Variación sospechosa — 200 (shape COMPLETAMENTE distinto)**
```jsonc
{ "warning": "variation_suspicious", "message": "…", "newRate": 1576,
  "lastKnown": 1000, "source": "INFODOLAR_CORDOBA" }
```
**Sin `sell`. Sin `error`. Status 200.** El handoff no lo listaba. Ver §13.

**Sin cotización — 404** → `{ error, lastKnown }`
**Excepción — 500** → `{ error: String(err) }`

### `infodolar-cordoba`

**Éxito — 200**
```jsonc
{ "compra": 1544, "venta": 1576, "appliedRate": 1576, "mode": "venta",
  "source": "infodolar_cordoba", "strategy": "html-table-row",
  "fetchedAt": "2026-08-25T22:11:25.000Z" }
```

| Status | Body | Cuándo |
|---|---|---|
| 422 | `{ error, code: 'parse' }` | HTML no parseable |
| 502 | `{ error, code: 'http' }` | InfoDolar respondió non-2xx |
| 503 | `{ error, code: 'timeout' }` | >15 s |
| 503 | `{ error, code: 'network' }` | error de red |

Los mensajes de 422 y 503-timeout dicen explícitamente **"No se actualizaron
precios"**. `exchangeRateService.ts:285-287` consume el campo `code`.

---

## 10. CORS y headers

Las dos declaran **exactamente lo mismo** y es lo mínimo:

```
Access-Control-Allow-Origin:  *
Access-Control-Allow-Headers: authorization, x-client-info, apikey, content-type
Content-Type: application/json      (sólo en respuestas con body JSON)
```

- **No** declaran `Access-Control-Allow-Methods`.
- **No** declaran `Access-Control-Max-Age` → el browser repite el preflight.
- **No** declaran `Vary`.
- **No** emiten `Cache-Control` de salida (el único `Cache-Control: no-cache`
  que aparece es un header **saliente** hacia infodolar.com).

`get-dolar-cordoba` es la única que usa `_shared/cors.ts`, que **sí** agrega
`Allow-Methods: GET, POST, OPTIONS`.

**Riesgo del `*`:** aceptable. No hay credenciales, ni cookies, ni datos de
tenant. `Allow-Origin: *` sobre información pública no filtra nada. **No es
P0.** El audit previo (`docs/EDGE_FUNCTIONS_CORS_AUDIT.md`) ya clasificaba
`_shared/cors.ts` como *Low — blast radius angosto*.

**No se modificó el CORS**, porque hacerlo exige redeploy.

---

## 11. Consumidores reales

Barrido de todo el repo. Se distingue call site HTTP real de mención en prosa.

| Función | Estado | Call sites HTTP |
|---|---|---|
| `infodolar-cordoba` | **ACTIVO** (2) | `src/services/dollarRateService.ts:184`<br>`src/services/exchangeRateService.ts:177` (usada en :273) |
| `fetch-dollar-rate` | **ACTIVO** (1) | `src/services/dollarRateService.ts:204` |
| `get-dolar-cordoba` | **MUERTO** (0) | ninguno |

Menciones en `docs/**` y en `src/lib/dollar/quoteSource.ts` son **strings de
etiqueta** (`'infodolar-cordoba'` como tag de `exchange_rates.source`), **no**
invocaciones. No cuentan como consumidores.

No hay consumidores en `_archive`, scripts, tests ni otras Edge Functions.

### Detalle: cómo llama cada consumidor

| | Método | Auth |
|---|---|---|
| `dollarRateService` → `infodolar-cordoba` | GET | `apikey` + `Bearer <anon>` |
| `exchangeRateService` → `infodolar-cordoba` | GET | `apikey` + `Bearer <anon>` |
| `dollarRateService` → `fetch-dollar-rate` | POST | **ninguna** ← ver §5 |

---

## 12. `get-dolar-cordoba` — clasificación

| Pregunta | Respuesta |
|---|---|
| ¿Qué hace? | Scrapea infodolar.com Córdoba y devuelve **sólo** el valor de venta |
| ¿Proveedor? | `www.infodolar.com/...cordoba.aspx` — el **mismo** que `infodolar-cordoba` |
| ¿Response shape? | `{ rate, source: 'infodolar-cordoba', timestamp }` |
| ¿Diferencias con `infodolar-cordoba`? | **Incompatible.** No devuelve `compra`, ni `venta`, ni `appliedRate`, ni `mode`, ni `strategy`. Un solo número. Errores: **todo 500**, sin campo `code` |
| ¿Es una versión anterior? | **Sí.** Desplegada 2026-04-19, un mes antes que `infodolar-cordoba` (2026-05-20) |
| ¿Consumidores? | **Cero** |
| ¿Está desplegada? | **Sí — v4, ACTIVE, `verify_jwt=false`, sirviendo** |
| ¿Confusión operacional? | **Sí, alta.** Nombre casi idéntico y `source: 'infodolar-cordoba'` en su body — el mismo string que el slug de la otra función |

**Veredicto: código muerto desplegado.** No se elimina en este lote (fuera de
alcance). El guard falla si alguien la vuelve a cablear sin reclasificarla.

**Fuga menor de información:** ante fallo de parseo devuelve **800 caracteres
del HTML de infodolar** en el body del error, a un caller anónimo. Es HTML
público de terceros, no datos del tenant. Severidad **baja**; anotado para el
lote de retiro/deploy.

---

## 13. 🔴 Riesgos de comportamiento (marcados, NO corregidos)

### R1 — `fetch-dollar-rate` cascadea entre provincias EN SILENCIO · **ALTA**

Es exactamente el antipatrón que §20 del encargo nombraba. **Está en
producción hoy.**

```
Córdoba falla → Ámbito Nacional → DolarAPI      todo en el mismo 200
```

El body **no trae ninguna marca** de que la fuente pedida no fue la que
respondió. Sólo cambia `source`.

**Por qué hoy no causa daño visible:** `dollarRateService.ts:373-388` fue
endurecido durante P0-DÓLAR y ahora **sólo consulta la fuente configurada**; su
comentario documenta el bug histórico (*"un negocio en Nacional terminaba con
precios de Córdoba sin que nada lo dijera"*). Además el frontend siempre manda
`source: 'nacional'`, lo que saltea el paso 1.

**Pero el cascadeo sigue vivo dentro de la función**: con `source:'nacional'`,
si Ámbito cae, **responde DolarAPI** sin avisar. La mitigación es del lado del
cliente, no de la función. Y la función es **pública**.

### R2 — La rama `variation_suspicious` es inalcanzable en la práctica · MEDIA

Devuelve 200 sin `sell` y sin `error`. El consumidor mapea `sell: data.sell` →
`undefined`, y `isValidRate(raw.sell)` lo convierte en degradación a caché.

**Resultado: el warning de variación >15% nunca llega al usuario.** Se comporta
como "no pude actualizar". La guarda existe pero no informa. Fail-closed —
correcto en seguridad, pero la intención del código no se cumple.

### R3 — `buy: 0` cuando sólo se parsea un precio · BAJA

`assignSellBuy` devuelve `buy: 0` si sólo obtuvo un precio válido. No es un
"return 0" ante fallo total (eso da 404), pero **sí** publica un `buy` de 0 que
parece un dato. `dollarRateService` lo tolera con `Math.min/max`.

### R4 — Sin `Access-Control-Max-Age` · BAJA
Preflight repetido en cada llamada.

### Los tres primeros están **congelados por tests**

Los tests aseveran el comportamiento **actual**. Si un lote futuro los corrige,
**los tests deben fallar** — esa es la señal de que el contrato desplegado
cambió, y hay que actualizarlos en el mismo commit que redeploya.

---

## 14. Abuso y rate limit — **MEDIA**

| Pregunta | Respuesta |
|---|---|
| ¿Cada request pega al proveedor? | **Sí, 1:1.** Sin excepción |
| ¿Hay cache? | **No.** Ni en la función, ni headers de respuesta |
| ¿Hay rate limit? | **No** a nivel función. Sólo lo que imponga el gateway |
| ¿Puede usarse como proxy? | **Parcialmente.** No devuelve el HTML crudo, sólo dos números parseados. `get-dolar-cordoba` **sí** devuelve 800 chars de HTML en error |
| ¿Costo externo? | **No.** Los tres proveedores son gratuitos y sin API key |
| ¿DoS al upstream? | **Sí, plausible.** Endpoint anónimo, sin cache, sin rate limit, que dispara un GET de ~83 KB a infodolar.com. Un atacante puede usar el proyecto como amplificador contra un tercero |
| ¿Acepta POST arbitrario? | Sí, pero el body se ignora salvo `source` y `lastKnown` |

**Clasificación: MEDIUM.** No compromete al tenant ni a la base. El riesgo real
es reputacional/hacia el upstream y consumo de cuota de invocaciones.
Mitigación natural (cache de ~60 s en la función) **requiere redeploy** → lote
siguiente.

---

## 15. Observabilidad / logging

| Función | Qué loguea | ¿Fuga? |
|---|---|---|
| `fetch-dollar-rate` | **nada** | — |
| `infodolar-cordoba` | `console.log` OK con `strategy`, `compra`, `venta`, ms; `console.warn` en parse fail con **300 chars de HTML**; `console.error` en red/timeout | **No.** Cotizaciones públicas y HTML de terceros |
| `get-dolar-cordoba` | `console.error` con el mensaje, que **incluye 800 chars de HTML** | Baja (§12) |

**Ninguna loguea** secrets, headers de auth, datos de tenant ni PII — no tiene
acceso a nada de eso. Un test asevera que un `Authorization` entrante **no**
aparece en la respuesta.

**No se cambió el logging.**

---

## 16. Reproducción local

Las funciones **no se sirvieron contra producción** ni se apuntó ningún stack
local a la base viva.

Se ejecutan bajo `deno test` con un harness que:

1. Intercepta `Deno.serve` **antes** de importar el módulo y captura el handler
   → sin puertos, sin servidor, y **sin refactorizar el source recuperado**.
2. Mockea `globalThis.fetch` con respuestas canned por host, y **falla el test**
   si se intenta salir a un host no declarado.

Se validaron shape, status, CORS y errores. El upstream real nunca se llama
desde los tests; el probe en vivo de §7 se hizo aparte, read-only y sin
persistir.

---

## 17. Tests

`tests/deno/dollarFunctionsContract.test.ts` — **25 tests**. Van en `tests/deno/`,
que el paso `npm run test:deno` de CI **ya ejecuta**: no hizo falta tocar
`ci.yml`.

Cubren, por función: shape de éxito, tipos, nullability, CORS/preflight,
payload de proveedor inválido, upstream non-200, timeout, error de red, rangos
de validez, invariantes (`appliedRate === venta`), SSRF y no-fuga de auth.

---

## 18. Negative gates — ejecutados de verdad

Cada mutación se aplicó al repo real, se corrió la suite, y se revirtió
verificando hash byte a byte.

| # | Mutación | Resultado |
|---|---|---|
| **A** | `fetch-dollar-rate`: `sell` → `rate` | ❌ **5 tests fallan** |
| **B** | Córdoba: `appliedRate` → `applied` | ❌ **2 tests fallan** |
| **C** | Córdoba: destino desde el caller | ❌ **1 test falla** |
| **D** | Secreto literal (JWT) en la función | ❌ guard exit 1 |
| **E** | `verify_jwt` flipeado a `true` | ❌ guard exit 1 |
| **E2** | Declaración de `verify_jwt` borrada | ❌ guard exit 1 |
| **F** | `get-dolar-cordoba` cableada como consumidor | ❌ guard exit 1 |
| **G** | Un byte cambiado sin redeploy | ❌ guard exit 1 (fidelidad) |
| **H** | Upstream fuera de allowlist | ❌ guard exit 1 |

**Rigor extra:** en D, C y H la comprobación de **fidelidad** disparaba primero
y **tapaba** al detector específico. Se repitieron neutralizando el hash
esperado, para probar que cada detector funciona **por mérito propio**:

```
D → "secreto literal en codigo (JWT literal (eyJ...)). Es una funcion PUBLICA."
C → "SSRF — fetch con destino derivado del request: `new URL(req.url`"
H → "upstream no declarado en la allowlist: evil.example.com"
```

Todas las mutaciones revertidas; árbol limpio y hashes idénticos después.

El guard trae además `--self-test` con **21 casos verificados en ambos
sentidos** (que detecte lo que debe **y** que no marque falsos positivos:
secretos mencionados en comentarios, `Bearer` interpolado, `fetch` a constante,
slug que contiene a otro).

---

## 19. Números reales de CI

| Gate | Resultado |
|---|---|
| `npm run typecheck` | ✅ **0 errores** |
| `npm run lint:errors` | ✅ **0 errores** |
| `npm run build` | ✅ built in 18.46 s |
| `npm run test:deno` | ✅ **87 passed / 0 failed** (62 previos + 25 nuevos) |
| `npm run test:components` | ✅ **564 passed / 564** (37 archivos) |
| `npm run test:unit` | ✅ **1013 / 1013** (ver nota) |
| `npm run guards` (cadena completa) | ✅ **exit 0** (ver nota) |
| `git diff --check` | ✅ limpio |

### Dos fallos que NO son de esta rama

Ambos son artefactos de **worktree recién creado**, verificados contra
`origin/main`:

1. **`tests/unit/safeDevPreflight.test.ts`** — fallaba con *"Falta
   `.env.development.local`"*. Ese archivo está **gitignoreado**, así que un
   worktree nuevo no lo tiene y el preflight fail-closed aborta **por diseño**.
   Copiándolo: **20/20 pass**. Total real **1013/1013**.

2. **`guard:prebeta-p1:self-test`** — fallaba 1 caso (*"el sello es insensible
   al fin de línea"*). Causa: `core.autocrlf=true` + ausencia de
   `.gitattributes` para migraciones → el worktree nuevo las bajó en **CRLF**,
   y ese self-test convierte `\n`→`\r\n` sobre un archivo que **ya** tiene CRLF,
   produciendo `\r\r\n`. En `origin/main` (donde están en LF): **41 ok / 0
   fallas**. Normalizando a LF en este worktree: **41 ok / 0 fallas**.

   > **Bug latente real, ajeno a este lote:** `npm run guards` falla en
   > cualquier clon fresco de Windows. CI corre en Ubuntu (LF), por eso está
   > verde. Arreglarlo pide extender `.gitattributes` a `supabase/migrations/**`,
   > lo que renormalizaría ~274 archivos de Finanzas — **fuera de alcance** por
   > §25/§27. Queda anotado.

Con esos dos artefactos neutralizados, la cadena completa `guards` da **exit 0**,
incluido el guard nuevo.

---

## 20. Qué cambió en el repo

```
 .gitattributes                                |  11 +      (nuevo)
 package.json                                  |   6 +-
 scripts/guards/dollar-functions-contract.mjs  | 319 +      (nuevo)
 supabase/config.toml                          |  21 +      (sólo adiciones)
 supabase/functions/fetch-dollar-rate/index.ts | 181 +      (RECUPERADO, sin tocar)
 supabase/functions/infodolar-cordoba/index.ts | 216 +      (RECUPERADO, sin tocar)
 tests/deno/dollarFunctionsContract.test.ts    | 448 +      (nuevo)
 7 files changed, 1200 insertions(+), 2 deletions(-)
```

Tres commits, sin mezclar refactor:

| Commit | Qué |
|---|---|
| `d5129e2` | `chore(edge): recover deployed dollar function sources` — **sólo** los dos archivos recuperados |
| `d34e3bf` | `test(edge): add dollar function contract coverage` |
| `5a1b1c0` | `chore(edge): declare verify_jwt and guard the recovered dollar sources` |

`.gitattributes` fija `eol=lf` para `supabase/functions/**`: el repo se clona
con `core.autocrlf=true` y `functions deploy` sube el archivo del **working
tree**, así que sin el pin un deploy desde Windows publicaría un bundle
distinto al del mismo commit en CI. Ámbito limitado a `supabase/functions/**`
a propósito.

**No se tocó:** P0-DÓLAR (`CurrencySettings`, `quoteSource`, `currencyService`,
`exchangeRateService`, `dollarRateService`, migraciones), MOBILE-2A, P0-CC,
Caja, Finance, POS, Inventory, Garantías, QR, Tasks, ARCA.

---

## 21. Plan para el próximo lote — `P0-OPS-DOLLAR-FUNCTIONS-DEPLOY`

Sólo cuando este PR esté mergeado. En este orden:

1. **Marcador de versión.** No existe forma de saber qué commit corre en
   producción. Proponer header `X-TechRepair-Version: <short-sha>` o campo
   `version` en el body. **Requiere redeploy** → por eso no se hizo acá.
2. **Cerrar R1** (§13): quitar el cascadeo cruzado o etiquetar la respuesta con
   `requestedSource` vs `actualSource`. Los tests actuales fallarán: es la señal.
3. **Cache de ~60 s** para cerrar el MEDIUM de §14.
4. **`Access-Control-Max-Age`**.
5. **Retirar `get-dolar-cordoba`** — muerta y desplegada. Junto con su fuga de
   HTML de 800 chars.
6. **Versionar `submit-lead`**, que está en la misma situación.
7. Comparar responses pre/post con el probe de §7 y validar rollback.

**Precondición de todo redeploy:** confirmar que `config.toml` sigue declarando
`verify_jwt = false`, o los consumidores anónimos se rompen (§5).

---

## 22. Veredicto

**A.** Source productivo recuperado por vía oficial, con fidelidad **probada a
nivel de objeto Git** (no por inspección), versionado sin un solo cambio,
auditado en las 12 dimensiones pedidas, con 25 tests de contrato, un guard con
self-test de 21 casos, y 9 negative gates ejecutados y revertidos.

No aplica veredicto **C**: no se encontró exposición de secrets, ni acceso a
datos de tenant, ni SSRF, ni mutación pública. El hallazgo más serio (R1,
cascadeo silencioso) es un **riesgo de comportamiento preexistente y ya
mitigado del lado del cliente**, no una vulnerabilidad — y corregirlo exige
redeploy, que este lote tiene prohibido.

---

# MERGE / CLOSURE — 2026-08-25

> **PR #79 MERGEADO. CERO redeploys de Edge Functions.**
> Git ahora describe fielmente las funciones productivas.

## C.1 Baseline final

| Ítem | Valor |
|---|---|
| `origin/main` pre-merge | `b1676f5fabe40de967cb115c788157eb2a37ff5f` — **no avanzó** desde el informe |
| PR head (`headRefOid`) | `9ae130be8333242ac851679029d5f72a91f981e3` |
| Estado | `OPEN` · `MERGEABLE` · `mergeStateStatus: CLEAN` · `isDraft: false` |
| Diff | 8 archivos · +1828 / −2 |
| Working tree | limpio |

El HEAD **no cambió** desde el informe, así que los números del lote siguen
siendo los reales; se re-corrieron igual (C.5).

## C.2 Alcance del diff — sin contaminación

Ninguno de los 8 archivos cae en dominio prohibido. Verificado por patrón sobre
`CurrencySettings`, `dollarRateService`, `quoteSource`, `currencyService`,
`exchangeRateService`, `Orders`, `Customers`, `NewOrder`, Caja, comprobantes,
Inventory, Garantías, ARCA/AFIP, WhatsApp, Finance y `migrations`:
**0 coincidencias**.

`supabase/config.toml`: **21 líneas agregadas, 0 borradas**, todas al final del
archivo (después de la línea 447). No se tocó `api`, `db`, `storage`, `auth`,
`realtime`, `edge_runtime` ni ningún puerto.

## C.3 Auditoría de auto-deploy — **el merge NO despliega Edge Functions**

Búsqueda exhaustiva repo-wide (`*.yml`, `*.yaml`, `*.json`, `*.mjs`, `*.js`,
`*.ts`, `*.sh`, `*.ps1`, `*.toml`, `Makefile`, excluyendo `node_modules`/`dist`)
de `functions deploy`, `functions:deploy`, `deploy_edge_function`,
`supabase deploy`:

**Las únicas dos coincidencias son comentarios escritos en este mismo lote** —
`scripts/guards/dollar-functions-contract.mjs:19` y `supabase/config.toml:456`.
**Cero invocaciones reales.**

| Superficie | Qué hace | ¿Despliega Edge Functions? |
|---|---|---|
| `.github/workflows/ci.yml` (único workflow) | `supabase/setup-cli@v1`, `supabase start`, `supabase stop --no-backup` — stack **local y descartable** | **NO** |
| `vercel.json` | `buildCommand: npm run build` → `vite build` | **NO** |
| `package.json` | sin `postinstall`, `predeploy`, `deploy`, `postbuild` | **NO** |

Además, el workflow **no tiene credenciales** para tocar el proyecto remoto: no
hay `SUPABASE_ACCESS_TOKEN`, ni `--project-ref`, ni `supabase link`, ni un solo
`secrets.*` en uso (lo documenta su propio comentario en la línea 65-70, herencia
de M7 7D.2).

**Conclusión: seguro para mergear.** Vercel sí redeploya el frontend porque
`main` cambió — eso es esperado y no equivale a un deploy de Supabase.

## C.4 Auditoría de `config.toml` — hacer explícito, no cambiar

Antes de este PR, `config.toml` **no declaraba `[functions.*]` para ninguna de
las 18 funciones**. Por eso la columna "repo antes" es `(sin declarar)` en todos
los casos, y **ninguna otra función pudo verse afectada**: el PR sólo agrega
tres bloques nuevos.

| Función | prod `verify_jwt` | repo antes | repo después | ¿coincide? |
|---|---|---|---|---|
| `fetch-dollar-rate` | `false` | *(sin declarar)* | `false` | ✅ |
| `infodolar-cordoba` | `false` | *(sin declarar)* | `false` | ✅ |
| `get-dolar-cordoba` | `false` | *(sin declarar)* | `false` | ✅ |
| las otras 15 | *(varía)* | *(sin declarar)* | *(sin declarar)* | ✅ sin cambio |

No hubo ningún `true → false` ni `false → true`. No se alteraron entrypoints,
puertos ni configuración de `auth`/`db`/`storage`. Sin secrets.

## C.5 Gates re-ejecutados en el head exacto del PR (`9ae130b`)

| Gate | Resultado |
|---|---|
| `npm run test:deno` | ✅ **87 passed / 0 failed** |
| contract tests del lote | ✅ **25 passed / 0 failed** |
| `guard:dollar-functions --self-test` | ✅ **21 comprobaciones**, ambos sentidos |
| `guard:dollar-functions` | ✅ fuente fiel · sin secretos · verify_jwt declarado · sin SSRF · inventario estable |

### Checks remotos — los 4 en verde

| Check | Estado | Duración |
|---|---|---|
| TypeScript + Lint + Build | **pass** | 1 m 18 s |
| E2E Smoke Tests | **pass** | 6 m 27 s |
| Vercel | **pass** | — |
| Vercel Preview Comments | **pass** | — |

## C.6 Fidelidad final pre-merge

Descarga fresca con el mismo comando oficial, comparada contra el **blob
commiteado** (`git rev-parse HEAD:<path>`):

| Función | bajado | commit | |
|---|---|---|---|
| `fetch-dollar-rate` | `d9bc185ccaa0` | `d9bc185ccaa0` | ✅ **IDÉNTICOS** |
| `infodolar-cordoba` | `dbfdb153334e` | `dbfdb153334e` | ✅ **IDÉNTICOS** |

No se modificó ningún archivo recuperado para forzar la coincidencia.

### Line endings — el PR no introduce CRLF

Los 8 blobs commiteados son **LF puro**, verificado a nivel de bytes crudos:

```
.gitattributes                                CR: false    742 bytes
docs/p0-ops-dollar-functions.md               CR: false  26383 bytes
package.json                                  CR: false  14140 bytes
scripts/guards/dollar-functions-contract.mjs  CR: false  15603 bytes
supabase/config.toml                          CR: false  18729 bytes
supabase/functions/fetch-dollar-rate/index.ts CR: false   7359 bytes   ← == descarga
supabase/functions/infodolar-cordoba/index.ts CR: false   7731 bytes   ← == descarga
tests/deno/dollarFunctionsContract.test.ts    CR: false  19504 bytes
```

> ⚠️ **Trampa de medición:** un primer chequeo con
> `git cat-file blob … | Out-String` reportó CR en **los 8** archivos. Era falso:
> PowerShell parte la salida en líneas y `Out-String` las vuelve a unir **con
> CRLF**. Hay que mirar los bytes crudos (`execSync` + `Buffer.includes(13)`).

## C.7 Merge

```
gh pr merge 79 --merge --delete-branch
```

| | |
|---|---|
| PR head | `9ae130be8333242ac851679029d5f72a91f981e3` |
| Merge commit | `71a418181d921334ac045cd7ff41a547c87bb2e2` (`71a4181`) |
| Padres | `b1676f5` (main) + `9ae130b` (PR) |
| Método | **merge commit** (igual que el PR #78) |
| `mergedAt` | 2026-08-25T23:21:59Z |
| Estado | `MERGED` |

Commits contenidos: `d5129e2` · `d34e3bf` · `5a1b1c0` · `9ae130b`.

> **Nota de tooling:** `gh pr merge` devolvió exit 1 con
> *"fatal: 'main' is already used by worktree at …"*. **El merge remoto sí se
> hizo**; lo que falló fue el paso local de `gh` que intenta pasar el checkout a
> `main`, imposible porque `main` está tomado por el worktree principal. Se
> verificó contra `origin/main` y contra la API antes de dar el merge por bueno.
> Efecto colateral: `--delete-branch` no llegó a correr, así que la rama remota
> se borró aparte.

## C.8 🔒 Integridad de producción — PRE vs POST

Snapshot completo de las **18** Edge Functions antes y después del merge,
comparado **mecánicamente** sobre `version` + `verify_jwt` + `status` +
`updated_at` + `ezbr_sha256`:

```
funciones PRE: 18   POST: 18

  fetch-dollar-rate    v4 verify_jwt=false ezbr=f8ba2cfec690…  IDENTICO
  infodolar-cordoba    v3 verify_jwt=false ezbr=b10cdf7a4368…  IDENTICO
  get-dolar-cordoba    v4 verify_jwt=false ezbr=e6b8abc73be1…  IDENTICO

RESULTADO: 0 cambios en las 18 Edge Functions. CERO redeploys.
```

**Ninguna función cambió de versión, hash, `verify_jwt`, status ni
`updated_at`.** Ni las tres de dólar ni las otras quince. La prueba de que el
merge no desplegó nada no es una afirmación: es un diff de metadata.

## C.9 Sanity de proveedores — post-merge

Probe read-only contra los endpoints productivos, sin persistir nada
(2026-08-25T20:23:29-03:00):

| Función | HTTP | Latencia | ACAO | Body |
|---|---|---|---|---|
| `infodolar-cordoba` | 200 | 456 ms | `*` | `{"compra":1544,"venta":1576,"appliedRate":1576,"mode":"venta","source":"infodolar_cordoba","strategy":"html-table-row","fetchedAt":"…"}` |
| `fetch-dollar-rate` (`source:'nacional'`) | 200 | 559 ms | `*` | `{"sell":1565,"buy":1545,"source":"AMBITO_NACIONAL","province":null}` |

Coinciden **exactamente** con los contratos de §9, incluida la invariante
`appliedRate === venta`. La `strategy` devuelta (`html-table-row`) es la misma
que ejercita el fixture de los tests. Los valores (1576 Córdoba / 1565 Nacional)
son los mismos que registró P0-DÓLAR: las dos fuentes siguen divergiendo, como
debe ser.

## C.10 Vercel — frontend sí, Edge Functions no

```
GET https://techrepairpro.app/version.json  →  200
{"buildTime":"2026-08-25T23:22:14.354Z","commit":"71a4181"}
```

Vercel sirve el **merge commit** `71a4181`, construido 15 s después del merge.

**Los dos estados, por separado y confirmados:**

| Superficie | ¿Cambió? |
|---|---|
| Frontend (Vercel) | ✅ **SÍ** — redeploy automático al avanzar `main`. Esperado |
| Supabase Edge Functions | ❌ **NO** — 0/18 cambiaron (C.8) |

## C.11 Handoffs formalizados — **ninguno se inició**

### A. `P0-OPS-DOLLAR-FUNCTIONS-DEPLOY`
Único lote autorizado a redeployar. Alcance: cerrar el cascadeo silencioso de
`fetch-dollar-rate` (R1), la rama >15% que responde 200 sin `sell`/`error` (R2),
marcador de versión (`X-TechRepair-Version`), observabilidad, cache de ~60 s
(§14), `Access-Control-Max-Age`, retiro de `get-dolar-cordoba`, comparación de
contratos pre/post y validación de rollback.
**Precondición:** que `config.toml` siga declarando `verify_jwt = false`.

### B. `P0-OPS-SUBMIT-LEAD-SOURCE`
`submit-lead` — v3, **ACTIVE**, `verify_jwt=false`, `ezbr_sha256`
`6dbcbed51b79…`. **Source ausente del repo.** Misma deuda que las dos
recuperadas acá. Requiere recuperación fiel por la vía oficial **antes de la
beta**. No se tocó en este lote.

### C. `P0-OPS-GUARDS-CRLF`
`npm run guards` falla en **cualquier clon fresco de Windows**: sin
`.gitattributes` para `supabase/migrations/**`, `core.autocrlf=true` baja las
migraciones en CRLF y un caso del self-test de `guard:prebeta-p1` las
re-convierte produciendo `\r\r\n`. CI corre en Ubuntu (LF), por eso está verde.
Arreglarlo renormalizaría ~274 archivos de Finanzas → **lote propio**.
Este PR **no** ejecutó renormalización masiva ni tocó migraciones.

## C.12 `get-dolar-cordoba` — clasificación preservada

Sin cambios: **desplegada** (v4, ACTIVE, `verify_jwt=false`), con código en el
repo byte a byte idéntico al deployment, **sin consumidores activos**, contrato
`{rate, source, timestamp}` **incompatible** con las otras dos. Candidata a
retiro en el handoff A. **No se eliminó ni se redeployó.** El guard falla si
alguien la vuelve a cablear sin reclasificarla.

## C.13 Veredicto de cierre

**A — P0-OPS-DOLLAR-FUNCTIONS: SOURCE RECOVERY CERRADO Y ESTABLE.**

Git ahora describe fielmente las Edge Functions productivas. Se cumplen las seis
condiciones: PR mergeado (`71a4181`); source fiel probado contra descarga fresca;
`config.toml` explícito y aditivo; las 18 funciones productivas **exactamente**
con las mismas versiones, hashes y `verify_jwt`; proveedores respondiendo con el
contrato documentado; tests verdes local y remotamente.

**No se realizó ningún redeploy de Edge Functions.**

> **NO se inicia `P0-OPS-DOLLAR-FUNCTIONS-DEPLOY` ni ningún otro lote.**
