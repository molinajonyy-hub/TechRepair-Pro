# BETA-GATE-1 · Lote C — WSAA: `force_refresh` y ventana de renovación

**Base:** `origin/main` `c828e8e5933b48fcbc06205a263ed8651fcca2bd` (Lotes A, B y D mergeados).
**Alcance:** sólo la Edge Function `afip-wsaa`. Sin migraciones y sin cambios en CAE, `afip-fe-query`, el asistente de
configuración, certificados, Vault, frontend, CORS ni datos de Clic. Decisión del owner: **Opción 1, sin migración**.

## 1. Causa raíz (medida)

Flujo anterior de `afip-wsaa`:

```
caller → authorizeArcaCaller (internal por credencial exacta, o usuario con settings_sensitive en su negocio)
       → arca_config (service_role)
       → reuse sólo si !force_refresh y quedan > 30 min
       → firma (clave Vault) → LoginCms, sin lock, sin reintento
       → persiste token/sign/vencimiento (si faltaba expirationTime: ahora + 12 h)
       → ante cualquier excepción: estado_conexion='error'
```

Problemas:

1. **Ventana de 30 minutos.** Pedía un LoginCms mientras ARCA seguía considerando vigente el TA, y ARCA responde a eso
   con `coe.alreadyAuthenticated`. La función lo trataba como error: `estado_conexion='error'`, visible en la tarjeta
   ARCA (el read model de Phase 1 lo muestra), y `afip-cae` devolvía 502. **Medido en producción:** 1 LoginCms a los
   696 min del anterior, dentro de esa ventana.
2. **`force_refresh` abierto a usuarios.** Cualquier usuario con `settings_sensitive` podía forzar LoginCms desde el
   navegador, sin límite, y dejar su propia conexión en error. Ningún caller productivo lo usa (verificado sobre el
   código **desplegado** de `afip-cae` y `afip-fe-query`).
3. **Sin control de concurrencia.** Dos pedidos concurrentes hacían dos LoginCms. El perdedor marcaba error aunque el
   ganador acabara de guardar un TA válido.
4. **Vencimiento inventado.** Un TA sin `expirationTime` se guardaba con ahora + 12 h.

Sin hallazgos de STOP salvo la carrera entre workers, que el owner decidió aceptar:

- el TA no es legible por `anon`/`authenticated` (sin SELECT/UPDATE sobre `arca_config`, medido en prod);
- un usuario sólo recibe flags, nunca token ni sign;
- `afip-wsaa` desplegado es idéntico a `main`;
- en prod hubo 37 LoginCms desde 2026-07-23, y **ninguno** a menos de 2 minutos del anterior.

## 2. Comportamiento nuevo

| Situación | Resultado |
|---|---|
| TA con **más de 10 min** | **reuse**, 0 LoginCms |
| TA con **10 min o menos** (frontera exacta incluida), vencido o ausente | **refresh**, 1 intento de LoginCms |
| `force_refresh=true` de un caller **internal** | 1 intento aunque el TA sea reutilizable. No promete un TA nuevo |
| `force_refresh=true` de un **usuario**, aun con `settings_sensitive` | **403 `FORCE_REFRESH_FORBIDDEN`** antes de leer `arca_config`, tocar WSAA o escribir estado |
| Pedidos concurrentes del mismo negocio en el **mismo worker** (normales o force) | comparten **un** intento |
| `coe.alreadyAuthenticated` (faultcode SOAP inequívoco) | relee `arca_config`: si hay un TA válido lo reutiliza, **sin** marcar error ni hacer fallar la emisión; si no hay, falla y marca error |
| Falla **ambigua** (timeout, red, 5xx, `wsaa.*`, `wsn.unavailable`, fault desconocido, TA sin vencimiento exacto) | nunca se guarda un TA ni se inventa vencimiento ni se pisan token/sign. Con un TA todavía válido se sirve ése **sin** marcar error; sin TA válido, falla y marca error |
| Falla **definitiva** (certificado o autorización rechazados, firma) | igual, pero **sí** marca error aunque se sirva el TA vigente: es un problema real que va a cortar la emisión cuando ese TA venza |
| Después de servir el TA vigente por una renovación fallida o rechazada | este worker no vuelve a pedir LoginCms por la ventana hasta que **ese** TA venza. `force_refresh` no respeta el backoff |

**Margen único:** `WSAA_REFRESH_SAFETY_WINDOW_MS = 10 * 60 * 1000` en `supabase/functions/afip-wsaa/ticketPolicy.ts`. Un
test falla si se define en otro lugar. El margen tiene que cubrir la duración de una emisión que arranca con ese TA
(firma, LoginCms, WSFE) más la tolerancia de reloj con ARCA, y sigue siendo chico frente a las ~12 h de vida del TA.

**Contrato de respuesta:**
- éxito: el mismo que antes (`success`, `token`, `sign`, `cached`, y `expires_at` sólo al renovar);
- falla: `success:false` con el mismo mensaje genérico, más `error_code` como campo aditivo;
- usuarios: siguen recibiendo sólo flags.

**Observabilidad:** una línea JSON por pedido. Campos: `fn`, `business_id`, `decision`, `reason`, `result`
(`success`, `already_authenticated_recovered`, `cached_after_failure`, `precondition` o `error`), `failure`, `code`,
`shared_attempt` y `remaining_min`. **Nunca** token, sign, clave, certificado, TRA ni texto crudo de ARCA; un test lo
verifica.

## 3. Matriz A–O (conteos del harness)

`tests/deno/afipWsaaTicketRefresh.test.ts`. El harness cuenta cada LoginCms que llegaría a WSAA, cada lectura de
`arca_config`, cada persistencia y cada escritura de error. Reloj fijo. El camino completo pasa por
`authorizeArcaCaller` → `withWsaaAuthorization` → `ticketService`, igual que `index.ts`.

| Caso | Escenario | LoginCms | Persiste TA | Escribe error | Resultado |
|---|---|---|---|---|---|
| A | TA con 11 min, normal | **0** | 0 | 0 | reuse |
| B | TA con 9 min | **1** | 1 | 0 | TA nuevo |
| C | vencido / ausente | **1** | 1 | 0 | TA nuevo |
| D | force internal, TA con 11 h | **1** | 1 | 0 | TA nuevo |
| E | force de usuario owner con `settings_sensitive` | **0** | 0 | 0 | 403 `FORCE_REFRESH_FORBIDDEN`, 0 lecturas de config |
| F | usuario contra otro negocio (con y sin force) | **0** | 0 | 0 | 403 `FORBIDDEN`, 0 lecturas |
| G | 2 normales concurrentes, mismo worker | **1** | 1 | 0 | los dos reciben el mismo TA |
| H | 2 force concurrentes, mismo worker | **1** | 1 | 0 | un intento compartido |
| I | fault definitivo, sin TA vigente | **1** | 0 | 1 | falla, TA previo intacto |
| I2 | fault definitivo, TA vigente | **1** | 0 | 1 | sirve el TA vigente |
| J | 502 HTML / red / fault desconocido, sin TA vigente | **1** | 0 | 1 | falla, sin éxito ni vencimiento inventado |
| J2 | 503 con TA vigente | **1** | 0 | **0** | sirve el TA vigente, estado `conectado` |
| K | TA recién renovado → siguiente normal | **0** extra | — | 0 | reuse |
| L | exactamente 10:00 / 10:00.001 | **1** / **0** | — | 0 | frontera fijada |
| M | `alreadyAuthenticated` + TA vigente | **1**, y la siguiente normal **0** | 0 | **0** | recupera, estado `conectado` |
| M2 | carrera entre 2 workers | **2** (aceptado) | 1 | **0** | el segundo recupera el TA del primero |
| N | `alreadyAuthenticated` sin TA vigente | **1** | 0 | 1 | falla, sin recuperación inventada |
| O | 200 con `expirationTime` vacío, sin offset, pasado, >12h10m o fecha imposible | **1** | **0** | 1 (0 si hay TA vigente) | no se persiste |
| P1 | `wsn.unavailable` + TA vigente | **1**, y la siguiente normal **0** | 0 | **0** | sirve el TA vigente (`cached_after_failure`), estado `conectado` |
| P2 | `wsn.unavailable` sin TA vigente (vencido o inexistente) | **1** | 0 | 1 | falla segura (`WSAA_RESULT_UNKNOWN`), sin TA ni vencimiento inventado |

**Divergencia deliberada con Phase 2A:** `afip-wsaa` excluye `wsn.unavailable` de `WSAA_DEFINITIVE_FAULTS`. La
especificación de ARCA lo define como servicio momentáneamente fuera de servicio, dentro del grupo transitorio junto
con `wsaa.*`. El resto de la allowlist (faultcode y código) mantiene paridad exacta con `arca-selfservice-setup`, que
no se toca en este lote. El test de paridad fija esa única excepción y falla si alguien vuelve a agregarla.

Además:
- precondición (certificado vencido o sin clave): 422, 0 LoginCms, sin escribir estado (contrato previo);
- clasificación estricta: un `Error` cualquiera, un faultstring que menciona el código, faultcodes duplicados o
  truncados, o una falla fuera de la etapa HTTP **no** habilitan la recuperación;
- logs sin secretos;
- **paridad con Phase 2A**: `wsaaFaultCode`, `parseWsaaInstant`, la allowlist definitiva (salvo `wsn.unavailable`) y
  `validateIssuedTicket` contra `validateWsaaTicket`;
- tests de fuente: `index.ts` usa `ticketService` y no tiene ventana de 30 min ni vencimiento inventado; el rechazo
  de force está antes de fijar contexto y antes de `deps.run`.

### Controles negativos

Cada mutación se aplicó al código productivo, se corrió la suite y se restauró el archivo (sha256 verificado).

| Mutación | Tests que fallan |
|---|---|
| ventana vuelve a 30 min | ventana, decisión, A |
| frontera `<=` → `<` | decisión, L |
| sin dedupe en el worker | G, H |
| `force_refresh` abierto a usuarios | E, fuente |
| alreadyAuthenticated sin recuperación | M, M2 |
| cualquier fault HTTP = alreadyAuthenticated | I, I2, J, clasificación |
| TA sin vencimiento → ahora+12h | O, paridad |
| falla ambigua con TA vigente marca error | J2, M, M2, O |
| `wsn.unavailable` vuelve a la allowlist definitiva | P1, P2, clasificación, paridad |

**9/9 detectadas por comportamiento.**

## 4. Concurrencia y errores ambiguos

- **Mismo worker:** exactamente 1 LoginCms por negocio (G, H).
- **Entre workers:** puede haber hasta 2 intentos concurrentes, y se acepta. El perdedor recibe
  `coe.alreadyAuthenticated`, relee y reutiliza el TA del ganador, sin falso error, sin perder el TA y sin hacer fallar
  la emisión (M2).
- **Ambiguos:** nunca se inventa éxito, TA ni vencimiento, y nunca se pisan token/sign. Si todavía hay un TA válido,
  un fallo transitorio no cambia `estado_conexion`.

### Riesgo residual — `persistTicket()` falla

Si WSAA emite un TA válido pero el `update` de `arca_config` falla, la respuesta devuelve ese TA a la invocación actual
y el log registra `code:"PERSIST_FAILED"`, pero el TA no queda guardado para las siguientes. La versión anterior
también ignoraba el error del `update`, sin dejar rastro; este lote lo hace observable. No se resuelve acá: no hay
almacenamiento alternativo ni arquitectura distribuida en este alcance.

## 5. Archivos

| Archivo | Cambio |
|---|---|
| `supabase/functions/afip-wsaa/ticketPolicy.ts` | **nuevo**, puro: margen, decisión, validación del TA, clasificación de fallas |
| `supabase/functions/afip-wsaa/ticketService.ts` | **nuevo**: reuse/refresh, dedupe por worker, recuperación, backoff, log sin secretos |
| `supabase/functions/afip-wsaa/authorizationBoundary.ts` | `force_refresh` sólo internal (403 antes de `run`) |
| `supabase/functions/afip-wsaa/index.ts` | el `run` delega en `ticketService`. Las funciones WSAA fijadas por el guard W1 (`toAfipDate`, `buildTRA`, `verifyCertKeyMatch`, `signTRAWithPEM`, `callWSAA`, `parseWSAAResponse`) quedan **idénticas** |
| `tests/deno/afipWsaaTicketRefresh.test.ts` | **nuevo**, 29 tests (corre en CI dentro de `npm run test:deno`) |

**Migraciones:** ninguna. **Edge Functions a desplegar:** sólo `afip-wsaa`.

## 6. Rollout

1. Mergear. **El merge no despliega Edge Functions.**
2. Confirmar que `afip-wsaa` desplegado sigue siendo `c828e8e` (hoy v18, idéntico a `main`).
3. Desde un worktree de `main` linkeado (copiar `supabase/.temp`):

   ```
   supabase functions deploy afip-wsaa --use-api
   ```

   Verificar que la versión suba (v18 → v19) y que `verify_jwt` siga en `false` (lo fija `supabase/config.toml`).
4. Smokes, **sin acciones fiscales**:
   - un usuario owner/admin llama `afip-wsaa` con su JWT y `force_refresh:true` → **403 `FORCE_REFRESH_FORBIDDEN`**, sin
     una nueva fila `wsaa_private_key_resolved_vault` en `private.arca_credential_audit`;
   - en la próxima emisión natural (o del tenant QA en homologación), los logs de `afip-wsaa` muestran
     `decision:"reuse"` cuando el TA tiene más de 10 min;
   - durante 24–48 h: `estado_conexion='error'` sigue en 0 y la cadencia de `wsaa_private_key_resolved_vault` se
     mantiene en uno por ciclo de TA por negocio.

## 7. Rollback

Redeploy de la versión anterior desde `c828e8e`:

```
git checkout c828e8e -- supabase/functions/afip-wsaa
supabase functions deploy afip-wsaa --use-api
```

No hay estado nuevo: mismas columnas de `arca_config`, mismo formato de TA y mismo contrato para `afip-cae`, así que
la versión anterior lee lo que haya escrito la nueva.

## 8. Impacto esperado sobre Clic

| Momento del ticket | Antes | Después |
|---|---|---|
| Más de 30 min restantes | reuse | reuse (igual) |
| Entre 10 y 30 min | LoginCms, probable `alreadyAuthenticated`, error visible y emisión 502 | **reuse**, 0 LoginCms |
| 10 min o menos | igual que arriba | 1 intento. Si ARCA emite, TA nuevo; si responde `alreadyAuthenticated`, sigue con el TA vigente, sin error y sin reintentar en ese worker |
| Vencido | LoginCms | LoginCms (igual) |
| Fallo transitorio con TA vigente | error visible, emisión fallida | emite con el TA vigente, estado sin cambios |

No toca certificado, clave, Vault, numeración, CAE ni comprobantes.

## 9. Deuda posterior registrada — `WSAA distributed refresh lease`

No se implementa ahora (decisión del owner). Consistiría en un lease en la base (tabla `private` + RPCs
`service_role`) para que un único worker haga LoginCms por negocio, con migración y rollout primero de DB y después de
Edge.

**Reabrir si aparece cualquiera de estos disparadores:**
- evidencia de LoginCms concurrentes entre workers (filas `wsaa_private_key_resolved_vault` del mismo negocio con
  segundos de diferencia);
- errores `alreadyAuthenticated` por concurrencia recurrentes en los logs (`failure:"already_authenticated"` sin
  recuperación);
- un aumento de volumen de emisión que haga probable la carrera.
