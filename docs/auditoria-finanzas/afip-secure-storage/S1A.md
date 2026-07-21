# AFIP-S1A — Fundaciones seguras (implementación)

Rama `feat/afip-s1a-secure-foundations` (desde `origin/main` @ `dbf969b`). **Backward-compatible.**
**No migra la fila productiva, no crea secretos productivos, no revoca el SELECT directo actual
de arca_config (eso es S1B), no toca afip-wsaa/afip-cae/generate-csr/uploadCertificate, no db push.**

## Qué entrega S1A
1. **Schema `private`** (no expuesto por PostgREST): REVOKE de PUBLIC/anon/authenticated, USAGE solo service_role.
2. **`private.arca_private_key_credentials`** (RLS enabled+**forced**, sin policies, sin grants a client/service; trigger de inmutabilidad de business_id/created_*).
3. **`private.arca_credential_audit`** + `private.arca_audit(...)` — eventos sanitizados (fingerprint truncado, nunca secretos).
4. **RPC Vault** SECDEF, `search_path = pg_catalog, pg_temp`, refs calificadas, EXECUTE **solo service_role**:
   `arca_store_private_key_secret`, `arca_get_private_key_for_signing`, `arca_replace_private_key_secret`, `arca_delete_private_key_secret`. Atómicas (rollback deshace el secreto si falla el enlace), delete idempotente.
5. **`public.get_arca_config_safe(uuid)`** SECDEF, EXECUTE **solo authenticated**, fail-closed (anon/negocio ajeno → NULL). Devuelve columnas no secretas + `has_certificate`/`has_private_key_configured`/`wsaa_token_valid`. **Nunca** private_key/PEM/pfx/passwords/wsaa token/sign/secret_id.
6. **`public.arca_store_credential(...)`** wrapper SECDEF EXECUTE **solo service_role** (entrada de la Edge; delega en las RPC privadas; no devuelve el PEM) + **`public.is_business_owner_or_admin(uuid,uuid)`** helper service_role.
7. **Frontend migrado:** `arcaService.getArcaConfig` y las 2 lecturas de `Settings.tsx` (carga + recarga post-guardar) usan `get_arca_config_safe`; los chequeos de presencia usan `has_certificate`; `private_key` eliminado del tipo `ArcaConfig`. El textarea del cert queda como ENTRADA local (no se lee del servidor).
8. **Edge `arca-credentials` DORMIDA** (sin consumidor productivo): JWT → membresía → owner/admin → valida par cert↔clave con node-forge (RSA≥2048, fechas, rechaza passphrase) → fingerprints → guarda la clave en Vault vía `arca_store_credential` → nunca devuelve la clave/secret_id → auditoría/errores sanitizados.
9. **Guard `guard:afip-s1a`** (+ en la cadena `guards`): falla si una RPC sensible recibe EXECUTE a client roles, si el frontend hace `select('*')` sobre arca_config o accede a `.private_key`, o si aparece un header PEM privado en migraciones/src.

## Validación (local, `db reset` reproducible)
- **db reset limpio ×2 (+varios)**: 195 migraciones (192 + 3 S1A), sin P0001, Kong/PostgREST HTTP 200.
- **SQL test 22/22** (`supabase/tests/security_afip_s1a_test.sql`): roundtrip Vault store/get/replace/delete, replace rota y borra el viejo, delete idempotente; authz de catálogo (get/wrapper service_role-only, safe authenticated-only, tabla privada sin SELECT client/service); is_business_owner_or_admin fail-closed; safe no arma private_key ni toca Vault.
- **HTTP anon local**: `get_arca_config_safe` → **401**; `arca_store_credential` → **404** (no expuesto a anon).
- guards 0, tsc 0, ESLint 0, unit 484/484, build 0. Bundle: 0 PEM privado (la única aparición de la cadena `private_key` es el nombre de campo del type de subida legacy, no un valor).
- **Nota de infra local:** WinNAT reservó el rango 54411–54510 (puertos del stack) durante la sesión; se validó remapeando temporalmente los puertos a 5542x en `config.toml` y **se revirtió el cambio** (NO se commitea). No afecta el contrato ni el deploy.

## Sin impacto fiscal (S1A)
No cambia: afip-wsaa, afip-cae, generate-csr, uploadCertificate, token/sign, el certificado/clave actual, `arca_config` productiva, verify_jwt, secrets de Edge, puntos de venta, numeración, WSAA/WSFE. El comportamiento fiscal productivo permanece idéntico (S1A solo agrega infraestructura dormida + cambia la LECTURA del frontend a un contrato sin secretos).

## Plan de despliegue S1A (diseño, NO ejecutar aún)
1. merge del PR; 2. `supabase db push --linked` de las 3 migraciones S1A (no crea secretos, no toca datos); 3. validar tabla/RPC/grants por catálogo (sin crear secretos); 4. desplegar la Edge `arca-credentials` **dormida** (`supabase functions deploy arca-credentials`, sin conectarla al formulario); 5. desplegar el frontend que usa `get_arca_config_safe`; 6. smoke UI de Settings (config ARCA visible por flags, sin secretos en el payload de red); 7. confirmar que `arcaService` ya no pide private_key; 8. confirmar el flujo fiscal existente intacto; 9. **detenerse antes de S1B**. El SELECT directo legacy sigue existiendo temporalmente (compat), pero el frontend nuevo ya no lo usa.

## Plan S1B (siguiente lote, NO implementar aún)
1. Inventariar consumidores restantes de `SELECT` sobre `arca_config` (grep repo + logs PostgREST): deben ser solo escrituras legacy (upsert de config) y `select('id')`; ninguna lectura de secretos.
2. Demostrar que ningún consumidor necesita `private_key` (el único lector correcto server-side será `arca_get_private_key_for_signing` en S2; el frontend usa `get_arca_config_safe`).
3. Revocar `SELECT` directo de `authenticated`/`anon` sobre `arca_config` (mantener `get_arca_config_safe` como única lectura); conservar solo los grants de ESCRITURA estrictamente necesarios para el flujo legacy hasta S3.
4. Ajustar/retirar las policies `arca_config_plan_read` (lectura) dejando la escritura; validar UI + ARCA.
5. Confirmar por HTTP que **ningún miembro** puede ya `select('*')`/`private_key` sobre `arca_config` vía PostgREST.
S1B se ejecuta **inmediatamente después** de validar S1A.

## Rotación (decisión formal)
**La rotación del par certificado/clave es OBLIGATORIA para cerrar el incidente**, porque la clave
privada estuvo disponible en el navegador de miembros authenticated del mismo negocio (cualquier rol)
vía `select('*')`. **S4** ocurre después de S3 y **no puede eliminarse del alcance final**. No se
generan ni rotan certificados en S1A.

## Riesgos / Rollback
- Riesgo: el frontend nuevo depende de `get_arca_config_safe`; si faltara, `getArcaConfig` lanza error controlado (la UI ya tolera fallos de carga ARCA). Mitigado: la RPC se despliega en el mismo lote.
- **Rollback ANTES del deploy** (migraciones no aplicadas): descartar la rama es un rollback válido.
- **Rollback DESPUÉS del deploy** (migraciones ya aplicadas): NUNCA borrar migraciones aplicadas, NUNCA
  eliminar versiones del historial, NUNCA modificar `supabase_migrations`, NUNCA `migration repair` para
  simular un rollback. El rollback correcto es:
  1. `git revert` del PR para el código (frontend/Edge/guards);
  2. una **migración compensatoria NUEVA** para el DDL/grants (p.ej. `DROP FUNCTION`/`DROP TABLE`/`DROP
     SCHEMA private CASCADE` en una migración posterior, aplicada por `db push`), como cualquier cambio
     de esquema hacia adelante.
  Como S1A no migra la fila ni crea secretos, la compensación es un simple retiro de objetos.
  **Nunca** reintroducir private_key al frontend ni conceder lectura a authenticated/anon sobre la tabla
  privada ni exponer Vault o el schema `private`.

## Recomendación
**GO PR AFIP-S1A.** Fundaciones seguras completas y validadas localmente (Vault roundtrip, authz,
frontend sin secretos, Edge dormida, guards), sin tocar producción ni el flujo fiscal. Al mergear,
seguir el plan de despliegue y **encadenar S1B** para revocar el SELECT directo.
