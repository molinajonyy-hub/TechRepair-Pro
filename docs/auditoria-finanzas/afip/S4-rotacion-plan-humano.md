# AFIP-S4 — Plan humano de rotación (S4B / S4C)

> Documento de plan. **No ejecuta nada.** S4A dejó desplegable (dormido) el
> contrato de preparación de rotación. S4B y S4C requieren autorización explícita
> y por lotes, igual que S1B/S2/S3.

## Contexto al cierre de S4A

- `arca-rotate-prepare` (Edge) + `public.arca_prepare_certificate_rotation` /
  `public.arca_cancel_certificate_rotation` (service_role-only) listos y probados
  localmente. **Dormidos**: sin rotación productiva.
- La credencial `active` en `private.arca_private_key_credentials` sigue intacta;
  afip-wsaa firma desde Vault (S3B-2). La clave/certificado vigentes siguen
  históricamente comprometidos → la rotación es el cierre real del incidente.
- La clave plaintext legacy en `arca_config.private_key` se conserva para rollback.

---

## S4B — Rotación productiva (una sola vez, con autorización)

1. **Desplegar S4A**: `db push` de `20260724120000` (200 migraciones) + deploy de
   la Edge `arca-rotate-prepare` con `--no-verify-jwt=false` (exige JWT de usuario;
   valida owner). Preflight read-only + backup PRE, como en S3A/S3B.
2. **Generar la rotación productiva UNA vez**: el owner invoca `arca-rotate-prepare`
   desde la app con `{ business_id, razon_social, cuit }`. Resultado: nueva clave en
   Vault como `pending_rotation` + CSR devuelto. La clave nunca sale de PostgreSQL.
3. **Entregar SOLO el CSR** al owner (descarga). Nunca la clave.
4. **Cargar el CSR en ARCA** (Administrador de Certificados Digitales, clave fiscal
   nivel 3). Fuera de la app.
5. **Descargar el certificado nuevo** (.crt) emitido por ARCA.
6. **Importar SOLO el certificado público** (flujo de import de cert existente, que
   ya no escribe la clave: la clave nueva ya está en Vault).
7. **Validar server-side** que el certificado nuevo corresponde a la credencial
   `pending_rotation`: `fp(SPKI del cert) == private_key_fingerprint` de la pending
   (reutilizar `arca_rsa_pubkey_from_cert` + fingerprint canónico).
8. **Activación atómica** (contrato S4B, aún NO implementado): en una sola
   transacción — promover la credencial `pending_rotation` a `active` (apuntar
   `arca_private_key_credentials` al secreto nuevo vía un contrato tipo
   `arca_activate_certificate_rotation`), escribir el `cert_file` nuevo en
   `arca_config`, marcar la rotación `activated`, conservar el secreto viejo como
   `revoked`/rollback. La credencial vieja NO se borra todavía.
9. **Refresh WSAA controlado** (como S3B-2): confirmar `source=vault` y que el
   `fingerprint` resuelto es el NUEVO. Sin emitir comprobante.
10. **Confirmar** token/sign renovados con la clave nueva, expiración futura,
    comprobantes/CAE sin cambios.
11. **Conservar** la credencial vieja (secreto + fila `revoked`) como rollback hasta
    cerrar S4B con un período de observación.

> S4B introduce un contrato nuevo `arca_activate_certificate_rotation` (atómico,
> service_role-only, idempotente, con readback y validación cert↔pending). No existe
> aún: se diseña e implementa en su propio lote con el mismo rigor que S4A.

---

## S4C — Retiro del legacy y cierre del incidente (con autorización)

1. **Retirar el fallback legacy** del resolver (`keyResolver.ts` en afip-wsaa):
   eliminar la rama `legacy_plaintext`; Vault pasa a ser la ÚNICA fuente.
2. **Impedir toda lectura** de `arca_config.private_key` a nivel contrato (ya está
   cerrada para el cliente desde S1B-B; acá se elimina también el consumo server-side).
3. **Poner la columna en NULL** (`UPDATE arca_config SET private_key = NULL`) tras
   verificar que Vault resuelve en producción y que ningún consumidor la lee.
4. **Verificar producción**: refresh WSAA, `source=vault`, sin fallback; Health Check.
5. **DROP de la columna** `arca_config.private_key` mediante una migración separada
   (una vez estabilizado el NULL).
6. **Retirar la credencial vieja** (`revoked`) y **limpiar el secreto viejo** de Vault.
7. **Eliminar contratos legacy** innecesarios (p.ej. ramas de `decryptField`/legacy).
8. **Health Check** autenticado (critical_count=0) + advisors 0 ERROR + drift 0.
9. **Tag de estabilidad** (p.ej. `stable-afip-vault-rotation-v1`).
10. **Desbloquear M8A** (Analytics): el incidente de la clave en claro queda cerrado
    solo cuando la clave está rotada, el legacy retirado y la columna eliminada.

---

## Incidencia paralela (no bloqueante) — registrar aparte

Durante la verificación owner de S3B-2 se observó, en la consola de la app:

- **403** en `GET /rest/v1/v_finance_position?...business_id=eq...` (dos ocurrencias);
- error de **realtime/useSubscription**: *"Could not set up realtime channel … after subscribe()"*.

Son comportamiento **app-side** (RLS de la vista `v_finance_position` y/o el canal
realtime), **no** causados por la rotación ni por el refresh WSAA. Conviene un lote
separado que: (a) confirme si el owner DEBE tener acceso a `v_finance_position` y
ajuste la policy/GRANT si corresponde; (b) revise la suscripción realtime que falla.
No mezclar con S4B/S4C, pero no ignorar de cara al lanzamiento.
