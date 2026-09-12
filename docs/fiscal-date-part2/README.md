# FISCAL DATE ARGENTINA — Parte 2

Persiste la fecha fiscal **exacta** (`CbteFch`) que ARCA aceptó, en una columna
canónica nueva. La Parte 1 arregló *qué fecha se manda*; la Parte 2 arregla *que
esa fecha quede guardada y se pueda mostrar*.

Hasta acá no existía ningún lugar donde estuviera: `fecha_emision_fiscal` es el
instante de **completado** (`now()`), `fecha` es la **fecha de venta**, y ni
`request_data`, ni `response_data`, ni `electronic_invoice_log` guardaban
`CbteFch`.

## El invariante que manda

> **El CAE vale más que la metadata.**

Ninguna fecha ausente, malformada o imposible (`20260231`), ni un fallo al
escribir la columna, puede impedir que se persista un CAE ya autorizado, ni
crear un `pending_reconciliation` nuevo. La persistencia de la fecha vive en
sub-bloques con `EXCEPTION` propio (savepoints implícitos), **después** del
completado canónico. Probado en `tests/sql/fiscal_date_part2.test.sql` C1–C9.

El invariante hermano:

> **Nunca se inventa una fecha fiscal.**

Si no se conoce, queda `NULL` y la UI dice «No informada». La fecha de venta
**no** es un reemplazo: puede diferir un día, que es exactamente el problema que
originó esta fase.

## Qué cambia

| Pieza | Cambio |
|---|---|
| `comprobantes.fecha_comprobante_fiscal` | columna `date` nueva, aditiva y nullable |
| `arca_parse_cbte_fch(text) → date` | parser defensivo que **nunca** lanza (`make_date`, no `to_date`) |
| `trg_comprobante_fiscal_date_immutable` | `NULL→fecha` sí, `fecha→misma` idempotente, `fecha→otra` bloqueado (`55006`) |
| `complete_arca_attempt` | identidad de 7 → 8 argumentos (`p_fecha_cbte text DEFAULT NULL`), reemplazo **atómico** |
| `afip-cae` | manda el mismo `CbteFch` que puso en `FECAESolicitar`; usa el que ARCA reporta cuando reconcilia un intento anterior |
| UI | «Fecha de emisión» sólo desde la columna nueva; «Fecha de venta» sigue siendo la venta |

`p_fecha_cbte` es **text** a propósito: con `date`, PostgREST podría rechazar o
castear un valor inválido *antes* de entrar a la función, y un CAE ya autorizado
se perdería por metadata.

## Orden de despliegue

1. **DB primero.** Con `p_fecha_cbte DEFAULT NULL`, el `afip-cae` viejo (que
   manda 7 argumentos) sigue resolviendo contra la función de 8. Probado por
   HTTP real contra PostgREST: `scripts/fiscal-date-part2/postgrest-signature-gate.mjs`.
2. **Después el Edge.** A partir de ahí las fechas nuevas se persisten solas.
3. Backfill del histórico: **paso aparte**, con autorización propia.

### Rollback

1. Volver **primero** el Edge a la versión previa (manda 7 argumentos). Ese paso
   no depende del SQL.
2. Sólo si hace falta, correr `docs/fiscal-date-part2/rollback.sql`, que
   restaura la definición de 7 argumentos **exacta** que corría en producción
   (`md5(prosrc) = 3b3b33da91367df6b8726f3160bd82cb`; ojo: **sin** el comentario
   `-- idempotente` que sí está en la fuente del repo y en las DB locales).
3. **La columna no se dropea**, y el trigger tampoco: conservan historia fiscal
   que no se puede reconstruir localmente, y son inertes para un llamador viejo.

## El modelo de prueba

`PROVABLE_LOCAL` significa una sola cosa:

> **Todo algoritmo que realmente pudo haber producido el `CbteFch`, sobre todo
> instante que la evidencia persistida permite, da el MISMO `YYYYMMDD`.**

Cualquier cosa más débil es `REQUIRES_ARCA_LOOKUP`.

### Por qué `sent_at` no prueba nada por sí solo

El orden real en `afip-cae` es:

```
markAttemptSent(...)  ->  resolveCbteFch(...)  ->  FECAESolicitar
```

así que `sent_at` es una **cota inferior** del cálculo, no el cálculo. La
ventana del cálculo server-side es `[sent_at, completed_at]`, y se ensancha con
`fecha_emision_fiscal`. Tampoco se usa `MAX(sent_at)` sobre todos los intentos:
la evidencia se ata al **único** intento `authorized`/`authorized_reconciled`,
porque el máximo puede pertenecer a un intento que no obtuvo el CAE.

### Los tres algoritmos candidatos

| | Algoritmo | Instante |
|---|---|---|
| **A** | día civil argentino (`resolveCbteFch`, Parte 1+) | `[sent_at, completed_at]` |
| **B** | día UTC (`todayYYYYMMDD()`, previo a la Parte 1) | `[sent_at, completed_at]` |
| **C** | día UTC calculado por el **navegador** (previo a la Parte 1) | `(-∞, started_at]` |

**C es el que arruina la prueba local.** El navegador calculaba `fecha_cbte`
antes de que el request llegara al Edge, así que su instante sólo tiene cota
superior y **ninguna cota inferior** en la evidencia. No se asume latencia
("habrán sido segundos"). Y no se puede descartar C fila por fila:
`request_data` y `response_data` están **NULL en los 178** autorizados, o sea
que no hay registro de si el body traía la fecha.

El corte es el despliegue de `afip-cae` v23 (Parte 1), medido en el proyecto:
**2026-09-11T22:36:02.442Z**. Desde ahí el Edge ignora lo que manda el
navegador, así que sólo aplica A.

## Estado del histórico (producción, sólo lectura, 2026-09-12)

De 178 comprobantes autorizados:

| Clase | N | Por qué |
|---|---:|---|
| `PROVABLE_LOCAL` | **1** | `0010-00000177`: ventana íntegramente post-corte y día civil argentino constante |
| `REQUIRES_ARCA_LOOKUP` | **177** | 129 previos al corte (C sin cota inferior) + 48 sin ningún intento |
| `INCONSISTENT` | **0** | — |

Una versión anterior de este clasificador decía 128 / 50. Era **demasiado
optimista**: tomaba `date(sent_at)` como la fecha del cálculo y pedía sólo que
el día UTC y el día argentino coincidieran en ese instante. No modelaba la
ventana del cálculo ni el algoritmo del navegador. 128 → 1 es el costo de
exigir prueba real, y es el número correcto.

Los dos casos donde el bug pegó de forma visible siguen siendo
`0010-00000087` (UTC 2026-07-18 vs AR 2026-07-17) y `0010-00000138`
(UTC 2026-08-09 vs AR 2026-08-08) — ahora dentro de los 177 a consultar.

La clave de consulta se deriva localmente para los 177: PV y número salen de
`numero_fiscal` (**no** de la columna `punto_venta`, que en parte del histórico
conserva su default `'0001'` mientras el número fiscal dice `0010-…`), y el
`CbteTipo` sale de `tipo` cuando `tipo_comprobante_fiscal` es `NULL`. Sin
`CbteTipo`, `numero_fiscal` es **ambiguo**: hay un `0010-00000001` factura y
otro nota de crédito.

## El lookup contra ARCA

Dos artefactos separados, y ninguno se ejecutó.

`plan-arca-lookup.ts` convierte la clasificación en un **plan inmutable** con su
SHA-256. `execute-arca-lookup.ts` consume ese plan y **verifica el SHA-256 antes
de tocar la red**: un plan modificado no se ejecuta.

El runner no habla con ARCA directamente: llama a la Edge ya desplegada
`afip-fe-query`, que soporta exactamente dos operaciones, las dos de lectura, y
no importa `afip-cae/logic.ts`. De ahí salen varias garantías gratis:

- **nunca ve el token/sign de WSAA** — los resuelve la Edge desde Vault;
- **no puede construir `FECAESolicitar`**: no está en su grafo de imports;
- **el negocio lo resuelve la Edge desde el perfil** del usuario autenticado, así
  que no hay `business_id` que falsificar;
- proyecto y negocio están **fijados en el código**; un plan con otro negocio se
  rechaza entero.

Además: tope duro de 200 requests, ejecución secuencial con 1200 ms de
espaciado, sin paralelismo, **sin reintento ciego** ante timeout o red ambigua
(se registra como ambiguo), salida sanitizada, y credenciales sólo por prompt
con eco apagado o `FDP2_OWNER_ACCESS_TOKEN` — nunca por argv, código o log.

`scripts/guards/fiscal-date-part2-runner-readonly.mjs` recorre el grafo de
imports locales y falla si aparece emisión, reserva de numeración, completado de
intento, escritura a la base, `service_role`, o una operación distinta de
`consultar`. Su self-test planta cada violación primero, así que un guard que
dejó de detectar **falla** en vez de pasar. Corre en CI.

### Identidad fiscal antes de cualquier backfill

Un `CbteFch` sólo sirve si el resultado **es** del comprobante que se pidió. El
backfill exige, por fila: `verdict` `BACKFILLABLE`, `cae_match = match`, y
`PV + CbteTipo + número` idénticos entre el resultado y el manifiesto. Un mapa
pelado `{ comprobante_id: YYYYMMDD }` se **rechaza**: no prueba identidad.

## Herramientas

Se versionan las herramientas; **sus salidas no** (llevan datos fiscales reales,
ver `.gitignore`).

| Script | Qué hace | Ejecuta algo? |
|---|---|---|
| `run-sql-tests.mjs` | regresión SQL en una transacción que termina en `ROLLBACK` | sí, sólo local |
| `postgrest-signature-gate.mjs` | hard gate de resolución de firma por HTTP; restaura la base local y lo verifica por `md5` | sí, sólo local |
| `classify-historical.sql` / `.mjs` | clasifica el histórico; un único `SELECT`, con guardia que aborta si aparece una sentencia de escritura | sólo lectura |
| `plan-arca-lookup.ts` | clasificación → plan inmutable + SHA-256 | **no** — no abre red |
| `execute-arca-lookup.ts` | plan verificado → resultados de `FECompConsultar` | **no ejecutado** — sin `--execute` no toca la red |
| `arcaLookupIdentity.ts` | módulo puro: valida la identidad fiscal de un resultado | no, no tiene efectos |
| `generate-backfill.mjs` | genera el `.sql` de backfill y su SHA-256 | **no** — no abre base |

`plan-arca-lookup.ts` reusa `buildFECompConsultarSOAP` y
`parseFECompConsultarResponse` de `afip-cae`: el mismo builder y parser
certificados que corren en producción, para que el plan no sea una segunda
implementación que pueda divergir. La única operación WSFEv1 que arma es
`FECompConsultar`; el builder de `FECAESolicitar` no se importa siquiera.

El backfill generado es idempotente y no puede pisar historia: cada `UPDATE` es
por `id` y exige `cae IS NOT NULL AND fecha_comprobante_fiscal IS NULL`. Cada
fila lleva su **procedencia** en un comentario. Una fecha de ARCA que no tenga
forma `YYYYMMDD` se **descarta con aviso**, nunca se corrige.

## Deuda separada, no de esta fase

La suite de componentes (`npm run test:components`) está en **264 rojos sobre 35
archivos**, idénticos en el commit base `205db2a2` — medido, no supuesto. Es
deuda de la suite de pre-beta y **no** se arregla dentro de Fiscal Date Parte 2.
Los archivos fiscales de esta fase sí pasan.
