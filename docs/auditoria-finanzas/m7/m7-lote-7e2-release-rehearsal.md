# M7 · Lote 7E.2 — Ensayo integral del release

Fecha del ensayo: 2026-07-18 · Base ensayada: `origin/main` = `a1791e1`
Rama: `feat/m7-finance-finalization` · HEAD al cerrar: `89cdf42` · 22 commits M7

> Este documento es la evidencia del ensayo. No contiene credenciales, JWT,
> datos personales ni dumps productivos. Las consultas contra producción fueron
> **exclusivamente de lectura**.

---

## 1. Inventario congelado

| | |
|---|---|
| Archivos vs `origin/main` | **126** (104 nuevos, 22 modificados) |
| Migraciones M7 | **26** |
| Suites SQL | 27 (44 archivos totales en `supabase/tests`) |
| Specs E2E | 21 |
| Tests unitarios | 9 archivos nuevos |
| Scripts | 7 |
| Documentación | 17 |
| Frontend (`src/`) | 15 |

**Orden y unicidad:** los 26 timestamps van de `20260713100000` a `20260714120000`,
estrictamente crecientes, sin duplicados y todos posteriores a la última migración
productiva (`20260706180000_m6_rls_lockdown`). Sin migraciones duplicadas ni
referencias a objetos creados después.

**Drift: cero.** Producción tiene 160 migraciones aplicadas; el repo tiene
exactamente 160 anteriores a la frontera M7. Las 26 restantes son las pendientes.

### DDL con riesgo, y por qué no lo tiene aquí

| Patrón | Dónde | Evaluación |
|---|---|---|
| `CREATE INDEX` no concurrente | 5 migraciones | Producción tiene **270 filas** en `financial_movements` y **246 comprobantes**. A esa escala el lock es de milisegundos. Medido: la migración más lenta del lote entero tardó **697 ms**. |
| `ADD CONSTRAINT` | 4 migraciones | Todas sobre tablas nuevas del propio lote (`*_requests`, audit log), no sobre tablas con historia. |
| `DELETE` de datos | `20260714110000` (dedupe de categorías) | **No-op en producción**: 0 grupos duplicados (medido read-only). |
| `ALTER TABLE ... ADD COLUMN` | `20260713250000` | Sin `NOT NULL` sin default sobre tabla grande; no fuerza reescritura. |
| `GRANT ... CREATE ON SCHEMA public` | `20260714100000` | Falso positivo del scanner: el grant es **a `postgres`**, no a un rol de cliente. El guard `guard:public-create` lo excluye correctamente. |
| Cambios destructivos | — | Ninguno. No hay `DROP TABLE` ni `DROP COLUMN`. |

---

## 2. Instalación limpia vs upgrade incremental

Se ejercitaron **los dos caminos**, porque prueban cosas distintas.

### Instalación limpia
`supabase db reset` → 186 migraciones → **44 s**. Suites SQL **44/44** en 16 s.

### Upgrade incremental (`scripts/finance/upgrade-rehearsal.mjs`)
El camino que realmente va a recorrer producción: base construida **solo** con las
migraciones de `a1791e1`, sembrada con datos pre-M7, y recién ahí las 26 M7 una
por una.

**30/30 verificaciones.** Tiempo total de las 26 migraciones: **~8,8 s**.
Más lenta: `20260713310000_m7_7c1a_pgtemp_barrier_all_secdef` — **697 ms**.
Sin locks en espera, sin warnings de bloqueo.

Fixtures pre-M7 deliberadamente incómodos: categorías duplicadas exactas, por
mayúsculas y por espacios; una categoría referenciada por un gasto; el mismo
nombre de categoría en **dos negocios**; un cobro **mixto** (dos pagos); tres
anulaciones sin registro canónico; cajas abierta y cerrada; compra con pago
parcial; movimientos financieros históricos.

**Invariante económico:** `fm_suma_ars` = 159.438,00 **antes y después**. Ídem
comprobantes, pagos, BFE, gastos, compras, `paid_amount` y cajas. Lo único que
cambia es lo que debe cambiar: las categorías, 6 → 3.

---

## 3. Compatibilidad de despliegue (`frontend-compat-check.mjs`)

La pregunta que decide el orden: entre migrar la DB y desplegar el frontend hay
una ventana en la que los usuarios siguen con el bundle viejo contra el esquema
nuevo. Si una RPC empieza a exigir un parámetro que ese bundle no manda, es una
caída intermitente.

Se extrajeron las **64 RPC** que llama el frontend de `a1791e1` (de su código, no
de memoria) y se comparó, para cada una, contra los parámetros **sin DEFAULT**
que la función M7 exige hoy.

**Resultado: 63/63 compatibles, 0 incompatibles.** El despliegue DB-primero es
seguro y no requiere ventana de mantenimiento.

> `increment_wholesale_customer_stats` no existe en ninguna migración del repo y
> M7 no la toca: es **drift preexistente** (la llama el frontend, no está
> versionada). No es una regresión de este release, pero conviene registrarla.

---

## 4. Preflight productivo (solo lectura)

| Medición | Valor |
|---|---|
| Última migración aplicada | `20260706180000` |
| Migraciones aplicadas | 160 |
| Migraciones M7 ya aplicadas | **0** |
| Drift repo ↔ producción | **0** |
| Comprobantes | 246 |
| `financial_movements` | 270 |
| Negocios | 20 |
| Cajas abiertas | 4 |
| Transacciones > 60 s | 0 |
| Locks en espera | 0 |
| SECURITY DEFINER en `public` | 126 |
| ACL de `public` | `{postgres=UC/postgres,=UC/postgres}` |
| `anon`/`authenticated`/`service_role` con CREATE | **sí (los tres)** |

**Hallazgo de seguridad:** la vulnerabilidad que cierra 7E.1 **está viva en
producción**. Además, `anon`, `authenticated` y `service_role` **no tienen entrada
propia** en el ACL: reciben USAGE a través de PUBLIC. Por eso el
`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role` de la
migración `20260714100000` **no es decorativo**: sin él, revocar el grant de
PUBLIC les quitaría también el USAGE y rompería la aplicación entera.

### Anomalías 7A — el conjunto NO cambió

| # | Tipo | Importe | Mes | Cobrado | FMs | NC |
|---|---|---|---|---|---|---|
| 1 | `remito` | 1.235.580,00 | 2026-05 | 1.235.580,00 | **0** | 0 |
| 2 | `factura_c` | 13.050,00 | 2026-05 | 13.050,00 | 1 | 1 |

Siguen siendo **exactamente 2**, las mismas, con los mismos importes.

**Aclaración de una cifra que parecía haber cambiado:** el preflight arroja
**1.248.630** y el informe 7A hablaba de **149.438**. No hay contradicción y no
hubo cambio: 1.248.630 es el **Δ ventas bruto** (1.235.580 + 13.050) y 149.438 es
el **Δ resultado neto**, después de restar el Δ COGS de 1.099.192. Son dos
dimensiones del mismo hecho.

### Categorías duplicadas en producción: **0**

`grupos_categoria_duplicados = 0`, `filas_a_borrar = 0` sobre 77 categorías. El
`DELETE` de dedupe de la migración `20260714110000` es un **no-op** en producción.
El riesgo se ensayó igual en local con seis variantes conflictivas.

---

## 5. Reconciliación 7B

**Preflight contra producción (read-only): las 12 precondiciones verificables
siguen dando OK** — importe de ítems 1.235.580, costo 1.097.006, sin registro de
anulación, sin NC, sin FM/BFE/CC, 3 ítems, 3 inventarios, 3 restauraciones de
stock.

El script tiene dos secciones (dry-run y apply), termina en `ROLLBACK` en el
repositorio, y aunque usa un UUID fijo **también valida 25 invariantes** antes de
escribir — que es lo que §6 exige de un script que use IDs.

**Ensayo local completo del ciclo**, sobre un fixture idéntico al caso productivo:

| Paso | Resultado |
|---|---|
| Dry-run #1 | 0 precondiciones fallidas |
| Apply #1 | `INSERT 0 1` → 1 registro de anulación |
| Apply #2 | **`INSERT 0 0`** → sigue habiendo 1 |
| Dry-run #2 | 0 pendientes |
| Efecto económico | 0 FM, 0 BFE creados; 3 restauraciones preexistentes intactas |

Idempotente por construcción (`NOT EXISTS ... status='completed'` + key fija).

---

## 6. Gate §7 — NC con reversa financiera fallida

Simulado en local. El estado tras una falla es: NC emitida sin movimiento
compensatorio.

| Requisito | Estado |
|---|---|
| Detección durable (sobrevive refresh) | ✅ `credit_note_cash_not_compensated`, server-side |
| Severidad | ✅ `high` |
| Identifica el negocio | ✅ |
| Identifica el importe | ✅ 10.000 |
| Identifica **qué** comprobante | ✅ **agregado en este lote** (`v_credit_notes_pending_reversal`) |
| Reintento idempotente | ✅ segundo intento → `replay`, 1 solo FM |
| La señal se apaga sola | ✅ vuelve a `pass` / count 0 |
| Aislamiento entre negocios | ✅ 0 filas para otro dueño |

15/15 asserts. **Gate cerrado**, no bloqueante.

---

## 7. Seguridad en ambos caminos

Validado en **instalación limpia** y en **upgrade incremental**:

- PUBLIC, `anon`, `authenticated`, `service_role`, `authenticator`: **sin CREATE**
- `postgres`: conserva CREATE (las migraciones futuras siguen funcionando)
- Health Check `secdef_untrusted_search_path`: **pass / 0**
- Guard estático: verde · Ataque real como `authenticated`: rechazado

Las **126 funciones** que conservan `public` en el `search_path` son **deuda de
defensa en profundidad**. Bajo los ACL posteriores a 7E.1 **no son alcanzables por
shadowing**, porque ningún rol de cliente puede crear objetos en `public`. No son
"inofensivas": si alguien re-otorga CREATE, vuelven a serlo — y por eso hay un
guard que falla si una migración lo re-otorga.

---

## 8. Fases de despliegue

Derivadas de las dependencias reales. La compatibilidad medida en §3 permite que
sean **secuenciales y no simultáneas**.

### Fase 1 — DB (compatible con el frontend anterior)
Las 26 migraciones, en orden, de una sola vez.

- Duración ensayada: **~9 s** (dataset productivo comparable: 270 FM, 246 comprobantes)
- Lock esperado: de milisegundos; sin `CREATE INDEX` sobre tablas grandes
- Validación inmediata: `44/44` suites SQL + ACL de `public` + Health Check
- Abortar si: una migración supera **60 s**, aparece un lock en espera, o el ACL
  no queda como se espera

Al terminar esta fase el sistema queda **funcionando con el frontend viejo**
(63/63 RPC compatibles). No hay urgencia por desplegar el frontend.

### Fase 2 — Frontend
Commit `89cdf42`. Health Check v2 disponible, smoke autenticado, RPC nuevas.

Va **antes** de la reconciliación a propósito: el Health Check v2 es la
herramienta con la que se valida la fase 3, y conviene tenerla puesta antes de
tocar datos históricos.

### Fase 3 — Reconciliación 7B
Preflight → dry-run → **aprobación humana explícita** → apply → validación →
rerun idempotente. Afecta 1 comprobante de 1 negocio.

### Fase 4 — Vistas / accrual
**No requiere fase propia.** Las vistas (`20260713270000`) son deterministas
sobre los datos: no necesitan que la reconciliación haya ocurrido, sólo reflejan
lo que haya. Se despliegan en la fase 1 y el resultado cambia solo cuando la
fase 3 corre. Se verificó que no dependen de datos reconciliados.

---

## 9. Plan de recuperación

No se usa la palabra "rollback" donde no aplica.

| Clase | Objetos | Vuelta atrás |
|---|---|---|
| **Reversible** | Vistas, funciones (`CREATE OR REPLACE`) | Reaplicar la definición anterior desde `a1791e1` |
| **Reversible con cuidado** | Índices, grants | `DROP INDEX` / re-`GRANT`; el de `public` **no debe revertirse** |
| **Forward-only** | Tablas nuevas, audit log, tombstones | No se borran: son append-only por diseño |
| **Forward-only (datos)** | Reconciliación 7B | **No se revierte borrando movimientos.** Se corrige con otro asiento |
| **Frontend** | Bundle | Redeploy de `a1791e1`; **compatible con la DB M7** (medido) |

- **Volver al frontend anterior es seguro** y no exige tocar la base. Es la
  palanca de recuperación más rápida.
- **Backup:** Supabase mantiene backups automáticos diarios del proyecto (plan
  actual) y permite snapshot bajo demanda desde el panel antes del release. **No
  se ejecutó ninguno en este lote**; hay que confirmarlo como paso 0 de la fase 1.
- **Aprobación de la reconciliación:** el dueño del proyecto, por escrito, sobre
  la salida del dry-run.

---

## 10. Condiciones de aborto

1. `origin/main` ≠ `a1791e1` sin re-ensayar.
2. Drift de migraciones ≠ 0.
3. Anomalías 7A ≠ 2, o cambian importes/invariantes.
4. Duplicados de categorías > 0 sin analizar el dedupe.
5. Una migración supera 60 s o aparece un lock en espera.
6. Una constraint no valida contra datos históricos.
7. Health Check arroja un `critical` nuevo tras la fase 1.
8. PUBLIC recupera CREATE sobre `public`.
9. Aparece una NC sin reversa que la vista no lista.
10. El frontend anterior falla contra la DB migrada.
11. Diferencias en caja, cuenta corriente, pagos o ledger tras la fase 1.
12. E2E local no reproducible dos corridas seguidas.
13. Backup/snapshot no confirmado antes de empezar.

---

## 11. Gates

| Gate | Resultado | Tiempo |
|---|---|---|
| `db reset` (186 migraciones) | ✅ | 44 s |
| Suites SQL | ✅ **44/44** | 16 s |
| Upgrade incremental | ✅ **30/30** | ~9 s (26 migr.) |
| Compatibilidad frontend | ✅ **63/63** | — |
| Concurrencia | ✅ **17/17** | 18 s |
| Unit | ✅ **484/484** | 26 s |
| E2E M7 | ✅ **30/30** | 86 s |
| TypeScript | ✅ 0 | 34 s |
| ESLint errors | ✅ 0 | — |
| Build | ✅ | 9 s |
| Guards | ✅ | — |
| `git diff --check` | ✅ 0 | — |
| Working tree post-tests | ✅ limpio | — |

### Infraestructura local vs producto

Dos fallas **de entorno**, no del producto, reproducibles y con procedimiento:

1. **Kong 502** en `/auth/v1/*` después de `supabase db reset`. Síntoma engañoso:
   `No se pudo sembrar el usuario E2E: {}` (cuerpo vacío del 502).
   → `npx supabase stop && npx supabase start`
2. **Marker E2E borrado** por el reset; el guard aborta fail-closed (correcto).
   → `npm run e2e:prepare`

Procedimiento tras cualquier `db reset`: `stop` → `start` → `e2e:prepare` → E2E.
No se ocultó ninguna flakiness con reintentos.

---

## 12. Deuda registrada (no bloqueante)

- `ModalCrearComprobante.tsx`: código muerto. **No se elimina en este lote.**
- Mojibake en `tests/e2e/setup/sqlLocal.ts`. **Sin barrido general.**
- 126 funciones SECURITY DEFINER con `public` en el path.
- `increment_wholesale_customer_stats`: drift preexistente, sin migración.
