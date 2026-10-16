# Patrón histórico en base 1 — plan seguro (BETA-UX-2)

**Estado: PLAN. No se ejecutó nada contra producción.** No se leyeron, revelaron, sobrescribieron ni migraron
secretos. Todo paso marcado «requiere autorización» necesita una autorización del owner aparte de la de
BETA-UX-2.

## 1. El problema

- La grilla del patrón numera los puntos 1–9. El contrato del servidor
  (`private.mobile2a_legacy_from_access`) y los patrones migrados del frontend anterior usan 0–8.
- Desde el wizard de MOBILE-2A hasta BETA-UX-2, el frontend mandaba la grilla tal cual. Los patrones con
  el punto 9 fallaban (no se guardaban). **Los que no usaban el punto 9 se guardaron en base 1**: son
  patrones correctos en una numeración distinta.
- BETA-UX-2 lee todo en base 0 (`parseRevealedPattern`). Un patrón guardado en base 1 se va a **revelar
  corrido un punto** (lo dibujado como 1-2-3 se mostraría 2-3-4).
- Conteo del 2026-10-15 (sólo lectura, sin descifrar): **1** secreto de patrón con última escritura
  `stored` (2026-09-21); 13 con `migrated` (base 0, correctos).

**El número puede crecer:** el frontend que está hoy en producción sigue guardando así cualquier patrón
nuevo sin el punto 9, desde el «Acceso del equipo» del detalle y desde la recepción, hasta que se despliegue
BETA-UX-2. La identificación tiene que hacerse con el corte en el momento de ese deploy, no con el conteo
de hoy.

## 2. Cómo se identifican sin tocar secretos

Regla: un secreto con `access_mode = 'pattern'` cuya **última escritura** fue por las RPC nuevas (`stored` o
`replaced` en `private.order_device_access_audit`) **antes** del deploy de BETA-UX-2 está en base 1. Los que
quedaron con `migrated` (backfill) o `legacy_secret_write_mirrored` (escritura del frontend anterior, formato
`pattern:0-1-2`) están en base 0.

Consulta de **sólo lectura** (requiere autorización; no lee `vault.decrypted_secrets` ni
`orders.device_password`, devuelve sólo identificadores y fechas):

```sql
-- :corte = timestamp del deploy del frontend BETA-UX-2 (UTC)
WITH ultima AS (
  SELECT DISTINCT ON (a.order_id) a.order_id, a.action, a.created_at
  FROM private.order_device_access_audit a
  WHERE a.action IN ('stored', 'replaced', 'migrated', 'legacy_secret_write_mirrored')
  ORDER BY a.order_id, a.created_at DESC
)
SELECT s.order_id, s.business_id, u.action AS ultima_escritura, u.created_at AS escrito_el
FROM private.order_device_access_secrets s
JOIN ultima u USING (order_id)
WHERE s.access_mode = 'pattern'
  AND u.action IN ('stored', 'replaced')
  AND u.created_at < :corte
ORDER BY u.created_at;
```

> **Actualización (hotfix, `patron-legacy-hotfix.md`):** la interfaz ya no muestra un patrón que no pueda
> leerse con certeza, sin migración. Los patrones nuevos se guardan con una marca de formato (strings) y los
> anteriores se dibujan sólo si un 0 o un 9 fija su numeración; el resto muestra «Patrón guardado con
> formato anterior» y «Reconfigurar patrón». U1 queda como mejora opcional (dibujar exactos los ambiguos sin
> recargarlos); el §4 «A» es el camino para corregirlos.

## 3. Evitar que la interfaz muestre un patrón corrido

| Opción | Qué hace | Toca secretos | Precisión | Costo |
|---|---|---|---|---|
| **U1 · marca de numeración (recomendada)** | RPC de sólo lectura `get_order_device_access_meta(p_order_id)` → `{ numbering: 'grid' \| 'legacy_one_based' }`, calculada con la regla del §2 y un corte guardado al aplicar la migración. `DeviceLockCard` muestra el valor tal cual cuando es `legacy_one_based` y aplica +1 cuando es `grid` | No | Exacta, por orden | Migración chica + deploy DB antes del frontend |
| U2 · secuencia operativa | Antes del deploy, el owner revela el patrón de las órdenes identificadas con la UI actual (que lo muestra crudo, en la numeración correcta para estos casos) y lo vuelve a cargar con «Configurar» **después** del deploy | Lo hace el owner desde la app | Exacta si se completa | Manual; ventana con el patrón corrido entre deploy y recarga |
| U3 · ocultar los números | No mostrar la secuencia de ningún patrón anterior al corte, sólo «Confirmalo con el cliente» | No | Imprecisa: oculta también los 13 correctos | Bajo, pero pierde información buena |
| Heurística en el cliente | Deducir la numeración del valor (un `0` ⇒ base 0) | No | **No sirve**: un patrón sin 0 ni 9 es ambiguo | — |

**No es posible hacerlo sólo en el frontend con precisión**: la única información que distingue un caso del
otro (la acción y la fecha de la última escritura) vive en `private` y no se expone. Sin U1, la ventana se
achica con U2 pero no desaparece.

## 4. Corregir el dato

| Opción | Cómo | Riesgos | Recomendación |
|---|---|---|---|
| **A · recarga desde la app** | Con el patrón a la vista (U1, o anotado antes del deploy en U2), el owner o un técnico con `device_access_secret` lo vuelve a cargar en «Acceso del equipo → Configurar». La RPC lo guarda en el contrato correcto y deja auditoría `replaced` | Ninguno técnico; requiere el paso manual | **Sí, para pocos casos** (hoy: 1) |
| B · corrección server-side | Función `SECURITY DEFINER` de un solo uso, en transacción: para las órdenes del §2, descifra en el servidor, valida que sea un arreglo de puntos distintos entre 1 y 9 sin 0, resta 1, guarda con `private.mobile2a_store_access(…, 'repaired', 'repair')` y actualiza el espejo legacy | `mobile2a_store_access` **borra el secreto viejo de Vault**: es irreversible salvo que la función conserve el id anterior (respaldo) hasta verificar. Descifra secretos (aunque no salgan del servidor) | Sólo si aparecen muchos casos. Requiere: PR propio, test SQL en `tests/sql`, ensayo en stack local, modo «dry-run» que sólo cuente, autorización explícita y respaldo del id anterior |

## 5. Secuencia recomendada

1. Mergear BETA-UX-2 **sin desplegar** el frontend todavía (decisión del owner).
2. PR aparte con **U1** (migración de la RPC de sólo lectura + `DeviceLockCard` que la usa y, si la RPC no
   existe, se comporta como hoy). Aplicar la migración **antes** de desplegar el frontend; el corte queda
   fijado al aplicarla.
3. Desplegar el frontend (BETA-UX-2 + U1) inmediatamente después: desde ese momento todo patrón nuevo se
   guarda en base 0 y los viejos se muestran bien.
4. Con autorización, correr la consulta del §2 (sólo lectura) y recargar con **A** los que aparezcan. Cuando
   no quede ninguno, la RPC de U1 puede quedar (es inocua) o retirarse.

Sin U1, la alternativa es U2 + A con una ventana corta en la que esas órdenes muestran el patrón corrido.
