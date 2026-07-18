# M7 7D.2 — E2E local: cómo se corre y por qué es imposible tocar producción

## Por qué existe este documento

Hasta el Lote 7D.1, `npm run test:e2e` **escribía en el Supabase productivo**. No por
un descuido puntual: por cómo estaba armada la cadena. Este documento explica el
arreglo para que nadie lo deshaga sin darse cuenta.

## La causa raíz

`playwright.config.ts` levantaba la app con `npx vite build && npx vite preview`.
`vite build` sin `--mode` corre en **modo production**, y en modo production Vite carga
`.env` — donde `VITE_SUPABASE_URL` apunta a producción. El `.env.test` que "configuraba
los tests" **nunca definió `VITE_SUPABASE_URL`**, y aunque lo hubiera hecho, un build en
modo production jamás lo habría leído. La plantilla `.env.test.example` incluso sugiere
un proyecto remoto (`https://YOUR_PROJECT.supabase.co`): apuntar a un backend real era
el diseño, no el accidente.

## Cómo correr los E2E

```bash
npx supabase start        # stack local (Docker)
npm run e2e:prepare       # marker de entorno + datos de negocio (idempotente)
npm run e2e:m7            # suite M7
npm run e2e:m7:ui         # la misma, en modo UI
```

`.env.e2e` (ignorado por Git) se completa desde `npx supabase status`. Plantilla:
`.env.e2e.example`.

## Las cuatro barreras

Son independientes a propósito: cada una tapa lo que las otras no ven.

| # | Barrera | Dónde | Qué tapa |
|---|---------|-------|----------|
| 1 | **Modo `e2e`** | `playwright.config.ts` (`vite build --mode e2e`) | Que el bundle se hornee contra `.env` productivo |
| 2 | **Guard de destino** | `tests/e2e/setup/globalSetup.ts` → `assertLocalTarget.ts` | Que la URL sea remota, o local sin marker |
| 3 | **Verificación del bundle servido** | `globalSetup.ts` | Que el `.env` leído y el `.env` horneado difieran |
| 4 | **Bloqueo de red en el browser** | `tests/e2e/m7/fixtures.ts` | Una URL productiva hardcodeada, un tercero, telemetría |

### Por qué la barrera 3 no es redundante

Las barreras 1 y 2 leen archivos. La 3 abre la app servida y le pregunta al cliente
Supabase **ya construido** contra qué URL apunta (`window.__E2E_SUPABASE_URL__`, que
sólo se publica cuando `import.meta.env.MODE === 'e2e'`; en cualquier otro modo la rama
se elimina del bundle). Es la única que prueba el artefacto real en vez del archivo que
suponemos que lo generó — y el bug original vivía exactamente en esa brecha.

### El marker

Un hostname local **no alcanza** como prueba de destino seguro: se puede tunelizar
producción a `127.0.0.1`. Por eso el guard exige evidencia positiva — la tabla
`public.e2e_environment_marker` con `environment='e2e_local'`. En producción no existe,
así que la suite aborta antes de conectarse.

`tests/e2e/setup/e2eMarker.sql` **no es una migración** y vive fuera de
`supabase/migrations/` a propósito: no debe llegar nunca a producción.

> **Trampa conocida:** el `REVOKE ALL ... FROM PUBLIC` del marker también le quita el
> acceso a `service_role`, que hereda vía `PUBLIC`. Por eso hay un `GRANT SELECT ...
> TO service_role` explícito. Sin él, el guard recibe 403 y aborta contra un backend
> que en realidad era el correcto.

## Reglas que no se negocian

- **No hay escape.** No existe `ALLOW_PRODUCTION_E2E` ni equivalente, y hay un test que
  falla si alguien lo agrega. Que una configuración insegura no arranque es el
  comportamiento correcto.
- **Todo es fail-closed.** Sin URL, sin marker, sin `service_role`, con el backend caído:
  aborta. Nunca asume que "seguro es local".
- **`service_role` jamás como `VITE_*`.** Cualquier `VITE_*` termina en el bundle del
  browser. La service key vive sólo en procesos Node (seed y guard).
- **Puerto 5174, no 5173.** `reuseExistingServer` adoptaría un `npm run dev` corriendo en
  5173, que está construido contra `.env` **productivo**. Con puerto propio, el server de
  E2E siempre es uno que arrancamos nosotros en modo `e2e`.

## El seed

`tests/e2e/setup/seedE2E.ts`, idempotente, con UUIDs determinísticos (`...0000e2e...`).
Siembra usuario de Auth, perfil, negocio, cliente, inventario y caja abierta, más un
**segundo negocio ajeno** que el usuario E2E no debe poder ver. El `globalSetup` verifica
ese aislamiento en cada corrida: si RLS se rompe, la suite no arranca.

> **Trampa de RLS:** `current_business_id()` resuelve por `profiles.id = auth.uid()`,
> **no** por `profiles.user_id`. Un seed que sólo setea `user_id` hace que RLS descarte
> los UPDATE en silencio (0 filas, sin error). Si el login termina en `/no-business`,
> es esto.

## La sesión

`globalSetup` hace **login real** por formulario y guarda `storageState` en
`tests/e2e/.auth/` (ignorado por Git). No se simula sesión ni se inyectan tokens: si el
login no funciona, los E2E no prueban nada. Se regenera en cada corrida — un
`storageState` viejo contra una DB reseteada falla de formas confusas.

## Suites

- `chromium` — suites legacy. Conservan sus ~136 fallas históricas (ver
  [[e2e-smoke-preexisting-failures]]); 7D.2 **no** las arregla, sólo garantiza que ya no
  corran contra producción.
- `m7-local` — suite M7, autenticada, aislada del ruido del baseline.

El guard vive en `globalSetup`, así que aplica a **las dos**. Está probado: apuntar
`.env.e2e` a producción hace abortar incluso un spec legacy.

## Lote 7D.3 — E2E transaccionales (idempotencia, errores, refresh)

26 tests en `m7-local`. Comandos: `npm run e2e:prepare` → `npm run e2e:m7`.

**Cobertura por sección:**

| Spec | Cubre | Cómo |
|------|-------|------|
| `defensa-red` | §1 | Bloqueo HTTP + WebSocket + service worker a destinos prohibidos |
| `replace-normal` | §4 | Reemplazo exitoso, verificación completa en base |
| `replace-lost-response` | §5 | Respuesta perdida (`route.fetch` + abort tras commit) → retry mismo key → replay |
| `replace-payment-set-changed` | §6 | Reemplazo canónico REAL de otro actor + contrato PAYMENT_SET_CHANGED (controlado) |
| `replace-idempotency-conflict` | §7 | Key reusada con payload distinto → IDEMPOTENCY_CONFLICT (RPC real) |
| `replace-key-rotation` | §8 | Rotación por medio/monto/notas (UI) + los 9 campos (unit) |
| `error-codes` | §11/§12/§14 | PERIOD_CLOSED, CASH_REGISTER_NOT_OPEN, ALREADY_ANNULLED — errores REALES |
| `double-click` | §17 | Doble confirmación → una sola operación, una sola key |
| unit `orderPaymentMixedIdempotency` | §9/§10 | `Map<índice,key>` + rotación por hash del conjunto |
| unit `replacePaymentIdempotency` | §8 | Los 9 campos del hash de intención |

**Helpers nuevos:**
- `tests/e2e/m7/observability.ts` — `GrabadorRPC`: captura por RPC la key, el payload
  económico (sin secretos), el código de respuesta, si es replay. Distingue doble-clic /
  retry / replay / nueva-intención / error terminal.
- `tests/e2e/setup/sqlLocal.ts` — ejecutor SQL local por `docker exec` (no puede tocar prod).
- `tests/e2e/setup/fixturesM7.ts` — seed reproducible de comprobante+pago+FM+BFE, fixtures
  de período cerrado / caja cerrada / anulación, y verificadores en base.

**Sobre §6 (PAYMENT_SET_CHANGED):** la carrera de locks pura resultó no-determinista a
través de PostgREST (ventana de microsegundos entre leer el conjunto y tomar el lock). Se
reproduce de forma controlada: otro actor hace un reemplazo canónico REAL (base en estado
B, verificado), y la confirmación de la UI recibe el contrato EXACTO de snapshot obsoleto
que devuelve la RPC. Valida el lifecycle de la UI sobre una base realmente cambiada.

**Hallazgo (riesgo, no bloqueante):** la anulación canónica M7 no setea `estado='anulado'`
(usa `comprobante_annulments` / `is_comprobante_annulled`). El widget de cobro se oculta
según el `estado` legacy, así que la afordancia "Editar cobro" sigue visible sobre un
comprobante anulado. El backend es fail-safe (devuelve ALREADY_ANNULLED, sin éxito falso),
pero la UI no refleja la anulación. Reportado como tarea de fondo.

**Deferido (superficies no construidas):** cobro mixto por UI real (POS ModalCobro con
orden de 3 líneas), ALREADY_REVERSED (reversa de gasto / pago de orden), AUDIT_FAILED, y
el refresh de esas superficies. La lógica de idempotencia del mixto está cubierta a nivel
mecanismo (unit).
