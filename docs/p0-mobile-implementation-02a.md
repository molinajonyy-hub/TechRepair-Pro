# TechRepair Pro — P0-MOBILE · MOBILE-2A

## Resultado

**Veredicto A — MOBILE-2A listo para review.** Nueva Orden quedó convertida en una recepción progresiva mobile-first, con creación atómica e idempotente, fotos privadas, checklist opcional, presupuesto ARS/USD y secreto del equipo fuera de las tablas públicas. Este lote no incluye merge, deploy ni MOBILE-2B.

## Baseline e integración

- Baseline real al iniciar: `958e12ca6a0795ddca0e44df2d0b822ec9404102` (`origin/main` en ese momento).
- PRs requeridos presentes: #74 `ffebda0`, #75 `9e9e355`, #76 `2cacbbe`, #77 `958e12c`.
- Durante el trabajo, `origin/main` avanzó a `bdedfcab3554d66b9b218e85f28a5cd741e3d4b9`; la rama fue actualizada sobre ese commit antes de los gates finales.
- Head de migraciones de `origin/main`: `20260902120000_p0_dollar_quote_source_canonical.sql`.
- Head de esta rama: `20260903120000_mobile2a_order_intake.sql`.
- Worktree aislado: `techrepair-vite-mobile-01`; rama: `feat/mobile-2a-order-intake`.

## Bloqueo de versión de migración resuelto

La versión original `20260902120000` colisionaba con P0-DÓLAR, ya aplicado en producción. MOBILE-2A fue renombrada a:

`supabase/migrations/20260903120000_mobile2a_order_intake.sql`

Evidencia obtenida con Supabase CLI contra el proyecto remoto:

- remoto: `20260902120000` presente y `20260903120000` ausente;
- repo actualizado: `20260902120000_p0_dollar_quote_source_canonical.sql` y `20260903120000_mobile2a_order_intake.sql`;
- ninguna referencia restante a `20260902120000_mobile2a_order_intake.sql`;
- `supabase db push --dry-run --skip-vault --project-ref …` informó únicamente `20260903120000_mobile2a_order_intake.sql` como pendiente;
- no se ejecutó `db push`.

## Discovery y reutilización

- Se reutilizaron `orders`, `customers`, `devices`, `device_inspections`, `documents`, el bucket privado `documents`, `profiles`, `business_users_view`, `current_user_can`, MOBILE-0 (`MobileActionBar`, inputs y dialogs responsive) y Supabase Vault.
- `customers.customer_type` ya existía con `minorista`/`mayorista`; sólo se agregaron `business_name` y `contact_person`. No se tocó `wholesale_customers` ni el Portal Mayorista.
- El checklist se guardó como JSONB validado en `device_inspections`, evitando columnas booleanas y conservando el concepto existente de inspección.
- Las fotos reutilizan el bucket privado `documents` y metadata en `documents`; no hay base64 ni URL pública persistente.
- La asignación nueva usa `profiles.id` en `orders.assigned_profile_id`. `technician_id` queda intacto por compatibilidad legacy.

## Flujo mobile-first

El wizard tiene 10 pasos: Cliente, Equipo, Identificación, Estado y fotos, Checklist, Acceso, Problema, Asignación, Presupuesto y Resumen. Expone título, “Paso N de 10”, progreso semántico, Atrás/Continuar, foco al cambiar de paso y CTA final en `MobileActionBar`.

El estado permanece en memoria al volver atrás. Al intentar salir con cambios se solicita confirmación. Archivos y secretos no se persisten en storage del navegador y los object URLs se revocan al quitar fotos o desmontar el flujo.

## Cliente rápido

- Busca por nombre, teléfono, DNI/CUIT o nombre comercial.
- Alta rápida inline, sin abandonar la orden.
- Minorista solicita nombre y teléfono; Mayorista revela progresivamente razón social y contacto.
- Cambiar Mayorista → Minorista limpia campos ocultos para que no se persistan accidentalmente.
- Alta rápida y alta completa reutilizan `customersService`; tenant y usuario se resuelven por el contrato canónico existente y RLS.

## Equipo, IMEI y scanner

- IMEI y serial son campos separados; IMEI se conserva como string y usa `inputMode=numeric`.
- Normalización de espacios/guiones y Luhn en cliente y servidor. IMEI sigue siendo opcional.
- Scanner lazy con `BarcodeDetector` para Code 128, Code 39, QR y EAN-13; no se agregó dependencia ni peso de bundle.
- La cámara sólo se solicita después de “Permitir cámara y escanear”. API ausente o permiso denegado dejan siempre disponible el ingreso manual.

## Estado, fotos y checklist

- Estado general, condiciones visibles y encendido se registran por separado.
- Hasta 8 imágenes privadas de 10 MB, con preview y eliminación previa.
- Path canónico: `business/<business_id>/orders/<order_id>/intake/<uuid>.<ext>`.
- Policies validan tenant, orden y capability; el RPC de metadata verifica además que el objeto exista. Inserts directos de metadata intake quedan bloqueados.
- Si falla metadata se elimina el objeto; si hay fallo parcial se conserva la orden y sólo quedan las fotos fallidas para “Reintentar fotos”. La idempotency key impide duplicar la orden.
- Checklist opcional con OK, Falla, No probado y No aplica; ausencia de prueba nunca se transforma en OK.

## Acceso seguro al equipo

- EXPAND mantiene temporalmente `orders.device_password` como shadow legacy escribible y sincronizado con Vault. No se limpia ni se instala el CHECK definitivo en este PR.
- PIN, patrón y contraseña viajan sólo como parámetro separado al RPC; no forman parte del payload idempotente ni del resumen.
- El secreto se guarda en Supabase Vault y el mapping vive en `private.order_device_access_secrets`, sin SELECT para browser, `anon`, `authenticated` ni `service_role`.
- `device_access_secret` es la capability explícita. Defaults: OWNER/ADMIN/MANAGER/TECH autorizados; SALES/CASHIER/VIEWER denegados. La UI usa capabilities, no checks de rol.
- Reveal es explícito, oculto por defecto, se recupera sólo al tocar Mostrar y se vuelve a ocultar a los 30 segundos.
- Store, replace, reveal, delete, backfill y cada escritura legacy reflejada se auditan en una tabla dedicada sin registrar valores.
- Patrón usa grilla 3×3 con alternativa por botones/teclado y representación canónica cifrada.
- Existe eliminación manual autorizada. No se implementó auto-purga porque el modelo no tiene un estado inequívoco de entrega física; `completed` no es suficiente.

## Presupuesto e idempotencia

- `orders.estimated_total_currency` es aditivo, default ARS y admite ARS/USD sin convertir historia ni consultar cotizaciones.
- El monto acepta formatos locales y persiste NUMERIC canónico.
- `create_order_intake(request_id, payload, access_secret)` crea dispositivo, orden, inspección, checklist, metadata de acceso y Vault dentro de una transacción.
- Misma key + mismo payload devuelve la misma orden con `replayed=true`; misma key + payload distinto falla con conflicto. El cliente agrega además lock de submit.

## RBAC y aislamiento

SQL real cubre OWNER, ADMIN, MANAGER, TECH, SALES, CASHIER y VIEWER, capability desconocida fail-closed, `anon` sin EXECUTE, tablas privadas sin SELECT y cross-tenant denegado. SALES y CASHIER pueden crear según el contrato de órdenes, pero no revelar secretos. La lista de responsables toma sólo perfiles activos visibles del mismo tenant y con `orders_create` efectivo.

## No regresión contable

Nueva Orden no escribe `financial_movements`, `business_finance_entries`, `account_movements`, `cajas`, `comprobante_payments` ni `comprobantes`. SQL cuenta movimientos antes/después y el guard estático conserva cero writes nuevos. Crear una orden no inventa estado de pago, cobro, comprobante ni Cuenta Corriente.

## Evidencia visual

Directorio: `docs/p0-mobile-evidence/implementation-mobile-2a/`.

- 390×844: Cliente, Equipo, scanner/fallback, Estado/Fotos, Checklist, Acceso PIN, Acceso patrón y Presupuesto USD.
- 320×568: paso Checklist denso sin overflow y CTA accesible.
- 430×932: Resumen final sin secreto en claro.
- E2E valida tema dark en el flujo completo y light en la recepción mínima.

## Verificación

- DB reset desde cero: P0-DÓLAR `20260902120000` seguido por MOBILE-2A EXPAND `20260903120000`.
- SQL transaccional: atomicidad, Vault, grants, RBAC, cross-tenant, auditoría, delete, idempotencia, storage/metadata y cero writes financieros.
- Componentes específicos: modelo IMEI/monto/secreto, navegación y preservación, alta rápida, fotos, scanner/fallback, patrón, resumen enmascarado, doble submit y retry parcial.
- E2E local OWNER: flujo completo y recepción mínima.
- Gates: TypeScript, ESLint, build, componentes, guards SECURITY DEFINER/exposure, finance direct-write, guard de secretos MOBILE-2A y `git diff --check`.

PR #80 (`e1cbb1a48dbb4ba700daba651b3694fbcafcd896`) quedó verde en TypeScript, ESLint, guard MOBILE-2A, provisioning, build y E2E local. La verificación local del mismo código registró 1032 unit tests, 575 component tests y 11 tests específicos MOBILE-2A. El SQL MOBILE-2A pasó también sobre el stack de compatibilidad aislado. El agregado histórico `npm run guards` conserva un único fallo preexistente del self-test PRE-BETA P6 sobre normalización de fin de línea, reproducido sin este PR en `origin/main`; los guards relevantes de secretos, finanzas, exposición, SECURITY DEFINER, provisioning y MOBILE-2A pasan. No se silenció ningún finding nuevo con baseline.

## EXPAND/CONTRACT rollout — 2026-08-26

### Breaking original y alcance de PR #80

El diseño inicial limpiaba `orders.device_password` e instalaba `orders_device_password_retired_check`. Eso hacía fallar al frontend productivo viejo, cuyo `DeviceLockCard` todavía ejecuta `UPDATE orders SET device_password=...`. PR #80 ahora contiene sólo EXPAND: mantiene el filename `20260903120000_mobile2a_order_intake.sql`, conserva todos los cambios aditivos y no incluye ninguna migración CONTRACT reconocida por `supabase db push`.

Producción continúa en `20260902120000_p0_dollar_quote_source_canonical.sql`; MOBILE-2A no fue aplicada. El frontend MOBILE-2A no tiene obligación de funcionar contra DB vieja: el rollout es DB EXPAND first.

### DML de EXPAND y dual-write temporal

- El backfill copia cada secreto legacy existente a Vault/private mapping, deriva `access_mode` con el codec legacy canónico y registra `migrated/backfill`.
- El backfill no borra ni modifica `device_password`; el plaintext histórico permanece disponible sólo durante la ventana de compatibilidad.
- El trigger temporal `mobile2a_mirror_legacy_device_password` refleja cada cambio legacy a Vault, incluido delete, después de revalidar actor autenticado, mismo tenant e `is_staff`, que es el contrato RLS histórico de `orders_update`.
- Cada write viejo genera metadata server-side `legacy_secret_write_mirrored` con `order_id`, `business_id`, `actor_id`, `created_at` y `operation=set|delete`. La tabla de audit no tiene columna para secreto.
- `create_order_intake` y `set_order_device_access_secret` escriben primero Vault y luego actualizan el shadow legacy con `private.mobile2a_write_legacy_shadow`.
- `delete_order_device_access_secret` borra mapping/Vault y pone el shadow en NULL.
- Un setting transaction-local distingue Vault → legacy de un write legacy real. El trigger retorna sin volver a escribir Vault, evitando loop, doble secreto y falso telemetry legacy.
- Patrón se traduce entre `pattern:0-4-8` legacy y `[0,4,8]` en Vault; PIN conserva `pin:` en legacy y password conserva `text:`.

Este dual-write es una excepción temporal y deliberada: no es la arquitectura final. EXPAND no agrega el CHECK de retiro y deja un comentario explícito sobre la columna.

### Contrato de seguridad

Las RPC nuevas siguen exigiendo `device_access_secret` y tenant. El bridge legacy no amplía permisos: una operación debe superar primero la RLS `orders_update` y además el trigger vuelve a exigir mismo tenant e `is_staff`. `anon`, `authenticated` y `service_role` no tienen acceso directo a las tablas/helpers privados. Audit, errores, payload idempotente, documentos y notas no reciben el valor; las pruebas comparan hashes cuando verifican persistencia.

### Matriz aislada

Stack descartable: `project_id=techrepair-mobile2a-expand`, API `56421`, DB `56422`; el stack compartido `techrepair-vite` no se tocó. Se arrancó exactamente desde `origin/main` (`bdedfcab3554d66b9b218e85f28a5cd741e3d4b9`), se sembró una orden legacy antes de EXPAND y luego se aplicó sólo `20260903120000_mobile2a_order_intake.sql`.

| Combinación | Resultado | Evidencia |
|---|---|---|
| DB EXPAND + frontend productivo viejo (`origin/main`) | **PASS** | UI real creó dispositivo/orden, cambió estado y guardó PIN legacy; SQL real cubrió create/update de cliente. El plaintext siguió legible por el cliente viejo; Vault y audit coincidieron por hash. |
| DB EXPAND + frontend MOBILE-2A de PR #80 | **PASS** | UI real recorrió intake, checklist, acceso, USD y double-click; creó exactamente una orden. Vault, shadow legacy e idempotency coincidieron. |
| Coexistencia viejo → nuevo | **PASS** | El frontend nuevo mostró `PIN configurado` y reveal disponible para un write originado por el frontend viejo, sin mostrar plaintext. |
| Coexistencia nuevo → viejo | **PASS** | El frontend viejo leyó el shadow generado por la RPC nueva como PIN configurado y enmascarado. |

Los viewports UI 320, 390, 430 y sanity desktop 1440 no presentaron overflow horizontal. La suite SQL cubrió también fotos/metadata privadas, checklist, ARS/USD, reveal/delete, RBAC, cross-tenant, grants, request idempotente y cero writes financieros.

### Negative gates

| Gate | Resultado |
|---|---|
| A · quitar legacy → Vault | Guard mutado falla por trigger/audit ausente. |
| B · quitar nuevo → legacy | Guard mutado falla si create/set/delete dejan de llamar al shadow helper; SQL/UI comprueban coexistencia. |
| C · reintroducir CHECK NULL | Guard mutado falla; prueba legacy escribe y lee un valor no nulo. |
| D · agregar secreto al audit | Guard mutado falla por columna sensible; SQL comprueba esquema sin columnas secret/plaintext. |
| E · quitar barrera de recursión | Guard mutado falla; SQL exige un solo secreto Vault y cero eventos legacy durante RPC nueva. |
| F · legacy cross-tenant | UPDATE afecta cero filas y no genera mapping ni audit. |
| G · actor sin capability | SALES no puede invocar `set_order_device_access_secret`. |

Las mutaciones A–E ocurren sólo sobre strings en memoria del self-test; no cambian archivos. F–G se ejecutan dentro de una transacción SQL con rollback.

### Rollout futuro

1. DB EXPAND production, con autorización separada.
2. Verificar postconditions agregadas y coverage Vault.
3. Smoke del frontend productivo viejo.
4. Smoke completo del Preview PR #80 con OWNER QA.
5. Merge PR #80.
6. Vercel Production.
7. Smoke MOBILE-2A productivo.
8. Ventana de drenaje y observación de `legacy_secret_write_mirrored`.
9. PR MOBILE-2A-CONTRACT separado.
10. DB CONTRACT sólo con autorización separada.

No alcanza con que Vercel termine: pestañas y bundles viejos pueden seguir activos. CONTRACT requiere medir última actividad legacy, writes posteriores al deploy y sesiones de prueba relevantes.

### MOBILE-2A-CONTRACT handoff — diseño, no migración pendiente

El PR futuro deberá: tomar snapshot agregado; ejecutar un mirror final legacy → Vault; validar coverage; limpiar `orders.device_password`; retirar trigger, codecs, shadow helper y dual-write de las RPC; instalar `orders_device_password_retired_check`; verificar plaintext count cero; conservar Vault y auditoría. No existe hoy un archivo CONTRACT dentro de `supabase/migrations/`, por lo que un `db push` de EXPAND no puede aplicar ambas fases accidentalmente.

No se ejecutó `db push`, merge ni deploy.

## Riesgos y decisiones diferidas

- La política de retención automática necesita un evento inequívoco de entrega física.
- `assigned_profile_id` convive temporalmente con `technician_id` legacy.
- No hay lectura de barcode desde imagen importada ni compresión client-side; se priorizó API nativa lazy, fallback manual y límite estricto.
- La integración completa de fotos/checklist/reveal dentro del rediseño de OrderDetail queda para MOBILE-2B; sólo se remedia ahora la tarjeta de acceso insegura.
- El warning histórico de chunks grandes del build sigue presente y no fue causado por el scanner, que no agrega librería.

## MOBILE-2B handoff

- Orders list en compact cards.
- OrderDetail mobile: Resumen, Trabajo, Cobro e Historial; acción primaria por etapa.
- Customers list en cards y CustomerDetail con header/tabs.
- Tablas internas a cards/master-detail.
- Integrar fotos, checklist y reveal del intake en el detalle rediseñado.
- No reescribir accounting, Cuenta Corriente ni POS.
