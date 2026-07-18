Cierra M7: auditoría append-only, control de períodos, idempotencia real y ledger devengado, más los controles necesarios para poder desplegarlo con red.

**131 archivos · 26 migraciones · 24 commits.** Producción **todavía no migrada**.

## Qué entra

- **Auditoría append-only** (`finance_audit_log`) y **period locks**: ninguna escritura financiera queda sin registro ni entra en un período cerrado.
- **Idempotencia y concurrencia**: toda escritura pasa por una RPC atómica con key ligada al payload. Los consumidores generan la key por **intención**, no por clic — un retry tras una respuesta perdida ya no duplica la operación.
- **Compensaciones**: reversos y reemplazos append-only, nunca `DELETE`.
- **Accrual ledger histórico** (6F.4): la anulación deja registro canónico en vez de mutar el comprobante, así la historia contable y el estado actual dejan de ser la misma cosa.
- **Health Check v2**: 44 checks, motor read-only.
- **Hardening de `CREATE` sobre `public`** (7E.1).
- **E2E local protegido** (7D.2): la suite ya no puede correr contra producción.

## Seguridad

El ACL de `public` traía `=UC/postgres`: el pseudo-rol PUBLIC con **CREATE**, o sea `anon`, `authenticated` y `service_role` podían crear objetos en el esquema. Verificado en local antes del fix: un `CREATE TABLE` y un `CREATE FUNCTION` como `authenticated` se ejecutaban sin error.

Esa es la precondición que vuelve atacable el `public` del `search_path` de 126 funciones `SECURITY DEFINER`. Se revoca en una sola migración.

**Alcance dicho con precisión:** no se logró reproducir una escalada real (el shadowing por tabla temporal ya estaba cerrado en 7C.1a, y el hijack por overload falla porque las firmas coinciden exacto). Es **defensa en profundidad**: lo que se cierra es la precondición.

Las 126 funciones que conservan `public` en el path quedan como **deuda de defensa en profundidad**: bajo el ACL nuevo **no son alcanzables por shadowing**, porque ningún rol de cliente puede crear ahí. No son "inofensivas" — si alguien re-otorga CREATE vuelven a serlo, y por eso hay un guard que falla si una migración lo re-otorga.

Medido con el propio Health Check, cuyo check ya existía desde 7C: **antes `fail`/128 → después `pass`/0**, sin tocar ninguna de esas funciones.

## Despliegue: DB primero, y está medido

Se extrajeron las **64 RPC** que llama el frontend productivo actual (de su código, no de memoria) y se compararon contra los parámetros sin `DEFAULT` que exige la base M7.

**63 compatibles + 1 exclusión verificable = 64. Cero incompatibles.**

La exclusión es `increment_wholesale_customer_stats`: se llama con `as any`, el resultado se descarta y el propio código dice *"no-op if RPC not deployed yet"*. No existe en producción ni en ninguna migración — ya falla hoy y ya se ignora.

**Consecuencia: el frontend anterior sigue funcionando contra la DB migrada.** El deploy puede ser secuencial, sin ventana de mantenimiento, y volver al bundle anterior es una palanca de recuperación válida.

## Ensayo del upgrade

Un `db reset` prueba la instalación limpia, no el upgrade. Producción parte de datos que ya existen.

`scripts/finance/upgrade-rehearsal.mjs` reconstruye la base **solo** con las migraciones de `a1791e1`, siembra fixtures pre-M7 con los casos incómodos (categorías duplicadas por mayúsculas y espacios, categoría referenciada por un gasto, mismo nombre en dos negocios, cobro mixto, anulaciones sin registro canónico) y recién ahí aplica las 26 una por una.

**30/30 · 8,8 s en total · la más lenta 697 ms · sin locks.** Las sumas económicas quedan idénticas antes y después; lo único que cambia son las categorías duplicadas, que es el objetivo.

## Reconciliación histórica: **pendiente y separada**

Este PR **no reconcilia nada**. Hay 2 comprobantes anulados sin registro canónico, de los cuales **sólo 1 requiere acción** (el otro se revirtió por la vía fiscal legítima y su NC ya compensó: neto 0).

El apply de 7B se ejecuta **después** del deploy, con **aprobación humana explícita sobre el dry-run**. Es idempotente: correrlo dos veces no cambia nada la segunda.

> Después de esa reconciliación el selector "anulado sin registro" seguirá devolviendo **1**, y es correcto: ese 1 es el caso de la nota de crédito, cuya reversa vive en la NC. El indicador que queda en cero es el de blockers 7A.

## Gates

| | |
|---|---|
| Suites SQL | **44/44** |
| Unit | **484/484** |
| E2E M7 (local protegido) | **30/30** |
| Concurrencia (2 sesiones reales) | **17/17** |
| Upgrade incremental | **30/30** |
| Compatibilidad frontend | **64/64** |
| TypeScript · ESLint · build | 0 · 0 · ✅ |

Todo verificado también sobre base reconstruida desde cero.

## Orden previsto

1. Aplicar las 26 migraciones (frontend sigue en `a1791e1`).
2. Smoke con el bundle anterior.
3. Mergear este PR → deploy del frontend M7.
4. Dry-run 7B → aprobación humana → apply.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
