# Handoff — P0-OPS-DOLLAR-FUNCTIONS

**Abierto:** 2026-08-25, durante el precheck de P0-DÓLAR ([PR #78](https://github.com/molinajonyy-hub/TechRepair-Pro/pull/78)).
**Bloquea beta:** sí. **Bloquea PR #78:** no.

---

## El problema

Dos Edge Functions están **desplegadas y sirviendo tráfico productivo**, pero su
código fuente **no está versionado en el repo**:

| Función | Versión desplegada | `verify_jwt` | Fuente en `supabase/functions/` |
|---|---|---|---|
| `fetch-dollar-rate` | v4 | `false` | ❌ **ausente** |
| `infodolar-cordoba` | v3 | `false` | ❌ **ausente** |

Lo que sí está en el repo es `get-dolar-cordoba` (v4, desplegada) — una tercera
función, con nombre parecido y **que ningún código del frontend llama**.

Comprobado el 2026-08-25 con `list_edge_functions` contra el proyecto
`vrdxxmjzxhfgqlnxmbwx` y con un `ls` de `supabase/functions/`.

## Por qué importa

Ambas están en el camino crítico de la cotización del dólar, que gobierna los
precios dolarizados del comercio:

- `infodolar-cordoba` → Blue Córdoba (responde `venta 1576` al 2026-08-25).
- `fetch-dollar-rate` → Blue Nacional (responde `sell 1565`).

Hoy no se puede: auditar su parsing, reproducir un deploy, revertir a una versión
anterior, ni saber qué cambia entre versiones. Si una se rompe o alguien la
redeploya, no hay forma de volver a un estado conocido.

Es el mismo patrón ya visto en [`afip-fe-query`](afip-fe-query-readonly): función
en producción con la fuente viviendo fuera de `main`.

## Objetivo (antes de la beta)

1. **Fuente en Git** — recuperar el código desplegado de ambas y commitearlo en
   `supabase/functions/<slug>/index.ts`.
2. **Deploy reproducible** — que `supabase functions deploy <slug>` produzca lo
   que ya está sirviendo, verificado contra el `ezbr_sha256` actual.
3. **Versión identificable** — que la función exponga su versión/commit.
4. **`verify_jwt` explícito y documentado** — hoy ambas son `false`; dejar
   asentado si eso es intencional (son endpoints de cotización pública, sin datos
   del tenant) o si debe cerrarse.
5. **Secrets documentados por NOMBRE, nunca por valor.**

## Restricciones

- **No redeployar** ninguna de las dos como parte de este handoff sin antes tener
  la fuente verificada: un redeploy sin fuente fiel las rompería sin rollback.
- No cambiar `verify_jwt` como efecto colateral.
- El contrato de respuesta que consume el cliente es:
  - `infodolar-cordoba` → `{ compra, venta, appliedRate, mode, source, strategy, fetchedAt }`
  - `fetch-dollar-rate` → `{ sell, buy, source, province }`
  Cualquier cambio de forma rompe `dollarRateService.fetchViaEdgeFunction`.

## Punto de partida

- El cliente las llama desde `src/services/dollarRateService.ts` (`fetchViaEdgeFunction`)
  y `src/services/exchangeRateService.ts` (`EDGE_FN_URL`).
- Tras PR #78 la URL sale del entorno (`VITE_SUPABASE_URL`), no hardcodeada — así
  que un stack local ya no consulta la función de producción.
- Evaluar si `get-dolar-cordoba` (en el repo, sin consumidores) es una versión
  anterior de `infodolar-cordoba` y sirve como base, o si es código muerto que
  conviene retirar.
