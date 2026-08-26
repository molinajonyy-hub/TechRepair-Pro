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

- En `orders` sólo queda `access_mode`; `orders.device_password` se migra a Vault, se limpia y queda protegido por un CHECK que exige siempre NULL.
- PIN, patrón y contraseña viajan sólo como parámetro separado al RPC; no forman parte del payload idempotente ni del resumen.
- El secreto se guarda en Supabase Vault y el mapping vive en `private.order_device_access_secrets`, sin SELECT para browser, `anon`, `authenticated` ni `service_role`.
- `device_access_secret` es la capability explícita. Defaults: OWNER/ADMIN/MANAGER/TECH autorizados; SALES/CASHIER/VIEWER denegados. La UI usa capabilities, no checks de rol.
- Reveal es explícito, oculto por defecto, se recupera sólo al tocar Mostrar y se vuelve a ocultar a los 30 segundos.
- Store, replace, reveal y delete se auditan en una tabla dedicada sin registrar valores.
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

- DB reset desde cero: P0-DÓLAR `20260902120000` seguido por MOBILE-2A `20260903120000`.
- SQL transaccional: atomicidad, Vault, grants, RBAC, cross-tenant, auditoría, delete, idempotencia, storage/metadata y cero writes financieros.
- Componentes específicos: modelo IMEI/monto/secreto, navegación y preservación, alta rápida, fotos, scanner/fallback, patrón, resumen enmascarado, doble submit y retry parcial.
- E2E local OWNER: flujo completo y recepción mínima.
- Gates: TypeScript, ESLint, build, componentes, guards SECURITY DEFINER/exposure, finance direct-write, guard de secretos MOBILE-2A y `git diff --check`.

Los conteos y estados definitivos de CI/Vercel se consignan en el PR una vez abierto. No se silenció ningún finding nuevo con baseline.

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
