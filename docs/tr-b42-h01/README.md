# TR-B42 / H01 — hardening de customer_events

Estado: implementación y validación local completas; PR/CI remoto pendientes de registrar. Alcance autorizado: implementación y pruebas locales/QA aislado. Sin merge, deploy, previews automáticas, migraciones ni escrituras en producción.

## Cambio y compatibilidad

`authenticated` conserva INSERT de telemetría, pero cada evento exige un cliente mayorista propio y el mismo negocio. `ce_admin` pasa de ALL a SELECT con su autorización histórica exacta mediante `profiles.user_id = auth.uid()`. La migración elimina todas las políticas INSERT/ALL existentes, incluso con nombres desconocidos, y comprueba el catálogo y los privilegios efectivos al terminar. No modifica filas, columnas, FK, tipos de evento, pedidos ni lógica comercial.

La columna `customer_id` sigue siendo nullable para preservar la FK `ON DELETE SET NULL` y la lectura de eventos históricos. Los nuevos INSERT del portal con cliente NULL se rechazan. No hay una excepción administrativa de INSERT.

El ajuste del portal permite observar fallos por un código seguro sin mostrar PII o mensajes técnicos al usuario; el pedido ya confirmado debe conservarse y WhatsApp debe continuar aunque el seguimiento falle. Metadata, total y order_id del evento son telemetría controlada por el cliente, sin autoridad financiera.

## Discovery realizado

Se buscaron `customer_events`, `trackEvent`, `ce_insert` y `ce_admin` en contenido tracked y en el árbol principal, excluyendo copias ajenas de worktrees. Se revisaron frontend, Edge Functions, migraciones, pruebas, scripts y documentación.

- `src/portal/services/portalService.ts`: único INSERT de ejecución encontrado, dentro de `trackEvent()`; antes descartaba el resultado de Supabase.
- `src/portal/pages/PortalCart.tsx`: único caller encontrado, evento `whatsapp_order` después de que `createOrder()` devuelve el pedido confirmado por el servidor; envía business.id y customer.id.
- `supabase/migrations/20260628190324_remote_baseline.sql`: definición, CHECK de tipos, FK nullable, índices, RLS, ce_insert permisiva, ce_admin ALL y GRANT SELECT+INSERT a authenticated. No se encontraron cambios posteriores de esta tabla en las migraciones vigentes antes de H01.
- `supabase/migrations/20261005120000_g2c1_wholesale_stock_authority.sql`: protege las escrituras administrativas/columnas del cliente mayorista; no escribe eventos.
- `supabase/migrations/20261011120000_prebeta3a2s_wholesale_server_authority.sql`: última política de lectura administrativa de wholesale_customers; no cambia `wc_own_read` ni escribe eventos.
- `scripts/guards/tenant-isolation.mjs`: registraba el hueco ce_insert como deuda previa con huella; esa deuda se retira al resolver H01 y se actualizan sus controles negativos.
- `docs/g2c1-wholesale-stock-discovery.md`, `docs/prebeta1-public-users/README.md`, `docs/prebeta1-public-users/guard-anchors.md`, `docs/prebeta1-public-users/regressions.md` y `docs/prebeta1-public-users/evidence/*`: documentación histórica del caller y del defecto.
- `docs/security-sec08f/production-catalog.json`: snapshot histórico de las políticas ALL/INSERT; se conserva como evidencia histórica.
- `supabase/_archive/loose-scripts/grant_permissions.sql`: contiene un GRANT ALL ON ALL TABLES a anon/authenticated. Es un script archivado, no una migración vigente; no ejecutarlo como reparación de permisos.

No se descubrieron INSERT legítimos de `customer_events` con cliente NULL, writers administrativos, consumidores de Edge Functions, RPC/trigger writers ni lecturas directas en código de aplicación. Las lecturas administrativas existentes en RLS se preservan. No apareció un consumidor incompatible que requiriera una excepción.

Esta conclusión corresponde al checkout revisado. No prueba que no existan consumidores externos no versionados; cualquier integración o política no explicada que aparezca en el preflight debe investigarse antes de aplicar, sin agregar excepciones generales.

## Archivos y operación local

- Migración: `supabase/migrations/20261017142335_tr_b42_h01_customer_events_hardening.sql`, generada mediante `supabase migration new`.
- Matriz SQL: `tests/sql/tr_b42_h01_customer_events.test.sql`.
- Guard específico y runner: `scripts/guards/customer-events-h01.mjs` y `scripts/security/customer-events-h01-local.mjs`.
- Preflight: [preflight-readonly.sql](preflight-readonly.sql).
- Contrato de políticas/permisos: [policies-before-after.md](policies-before-after.md).
- Reversión segura: [rollback.md](rollback.md).

Usar exclusivamente un stack Supabase local desechable y separado de otros trabajos. El runner debe validar el destino antes de ejecutar SQL. La matriz SQL usa los roles reales anon/authenticated, claims sintéticos y BEGIN/ROLLBACK; no necesita pgtap. No correr `supabase db push`, resetear stacks ajenos ni usar credenciales de producción.

Comprobaciones ejecutadas: guard estático y self-test, matriz SQL con control del defecto anterior, reaplicación idempotente de la migración, suites de Portal Mayorista/autenticación/permisos/aislamiento/creación de pedidos, TypeScript, ESLint, build y flujo de navegador local. Los nombres exactos de scripts y su integración CI deben verificarse en `package.json` y `.github/workflows/ci.yml`.

La prueba SQL falla si reaparece una política INSERT/ALL alternativa, incluso bajo otro nombre, un privilegio INSERT de anon/PUBLIC/de columna, mutaciones extra o RLS desactivado. Incluye pruebas negativas que demuestran la detección de esas regresiones. También verifica la lectura de NULL históricos y que no se amplíe ce_admin a `profiles.id`.

## PR y protección de previews

Rama prevista: `codex/tr-b42-h01-customer-events`. Antes de publicar la rama o abrir el PR, comprobar `vercel.json`: `git.deploymentEnabled["codex/tr-b42-h01-customer-events"]` debe ser false. No se encontró otro workflow de despliegue. La configuración de rama está fijada por el guard; la documentación oficial de Vercel confirma que false deshabilita despliegues automáticos: https://vercel.com/docs/project-configuration/git-configuration. La inspección remota del proyecto Vercel devolvió 403 y no se cambiaron sus ajustes; no se infiere su configuración global. No activar previews ni hacer deploy manual. Si esa inhibición no puede comprobarse, dejar los cambios locales y explicar el bloqueo del PR.

El PR es independiente y queda para revisión humana. CI aprobado no autoriza merge ni aplicación en producción. H01 sólo queda listo para certificar después de las pruebas completas y la revisión/autorización expresa del usuario para el siguiente paso.

## Resultados de validación

Validado el 17/10/2026 en Windows/Node 24 y PostgreSQL 17.6, con un Supabase aislado llamado `techrepair-h01` (API 55421, DB 55422). Se reprodujeron las 289 migraciones anteriores sin modificar el stack habitual; después se aplicó H01 dos veces. La rama independiente parte de `origin/main` 033be94.

| Comprobación | Resultado/evidencia |
|---|---|
| Migración y reaplicación idempotente | PASS, dos aplicaciones en stack aislado; cero DML de migración |
| Preflight/catálogo | PASS, 9/9 gates; tabla sin filas al medir; grants de tabla/columna y herencia verificados |
| Matriz SQL real-role | PASS, toda la matriz solicitada, 7 tipos válidos y tipo inválido; defecto anterior A→B reproducido y bloqueado después |
| Controles negativos | PASS: guard estático 23 regresiones + control seguro; 7 mutaciones externas hacen fallar la suite SQL; 5 controles internos de catálogo |
| Aislamiento global | PASS: catálogo 0 violaciones; self-test 54 casos; 8 accesos de deuda personal preexistente fuera de H01 continúan visibles |
| Componentes portal/auth/RBAC/pedidos | PASS: 12 archivos, 175/175 pruebas mediante `npm run test:h01` |
| SQL relacionado | PASS: 8 suites de pedido mayorista, autoridad mayorista/Portal Clic, aislamiento PRE-BETA-1, portal público, perfil y permisos |
| Navegador, rama final | PASS: 2/2 con Auth, catálogo, carrito y RPC reales; evento propio HTTP 201 persistido y enlazado |
| Fallo de seguimiento | PASS: HTTP 403 inyectado, pedido único confirmado, carrito vacío tras recarga, WhatsApp abre y no se muestran errores/PII; componente también cubre rechazo y promesa pendiente |
| TypeScript / ESLint / build | PASS los tres; build conserva advertencia de chunks grandes y canal de soporte sin configurar fuera de producción |
| CI remoto y URL de PR | Pendiente de ejecutar/publicar |
| Producción / merge / despliegues | No ejecutados |

El navegador intercepta el destino externo de WhatsApp antes de salir a la red: comprueba popup, número y contenido reales generados por el portal, sin enviar pedidos sintéticos a terceros. Los fixtures de navegador se eliminan al terminar; las matrices SQL terminan en ROLLBACK. Las capturas de éxito están en `test-results/h01/` y los logs SQL en `.h01-local/sql-results/` (artefactos CI; no contienen credenciales).

Para repetir sobre el stack H01 preparado: exportar `H01_DB_CONTAINER=supabase_db_techrepair-h01`, `H01_SUPABASE_URL=http://127.0.0.1:55421` y las claves locales `H01_SUPABASE_ANON_KEY`/`H01_SUPABASE_SERVICE_ROLE_KEY` desde `supabase status`; luego ejecutar `npm run validate:h01:local`. Las claves no se registran ni se guardan en el repositorio. CI prepara su propio stack descartable desde cero y usa el puerto 54421. Los matchers de pantalla de las suites relacionadas se registran explícitamente en `vitest.h01.config.ts`, conservando el setup y bloqueo de red originales.

El guard estático fija por SHA-256 la migración revisada, rechaza cambios posteriores de customer_events, GRANT amplios, herencia/bypass y SQL dinámico opaco, y comprueba el encadenamiento scripts→CI y el bloqueo de previews. Esa restricción es deliberadamente conservadora: una evolución legítima exige revisar el guard y repetir la matriz de catálogo, sin agregar excepciones generales.

## Riesgos residuales

El cliente puede fabricar metadata, total, order_id y tipos de evento válidos para su propio cliente/negocio. H01 no convierte telemetría en venta confiable, no agrega rate limiting ni cambia las reglas de aprobación/suspensión del cliente. El pedido y sus importes siguen sujetos a la autoridad del servidor existente.

La lectura administrativa conserva deliberadamente su autoridad histórica, incluido cualquier alcance derivado de perfiles existentes; no se rediseña RBAC en este cambio. No se cambian H02/H03, Mercado Pago, ARCA, inventario ni contabilidad. Si un consumidor externo necesita eventos sin cliente o INSERT administrativo, detener su incorporación y evaluar un diseño acotado aparte.
