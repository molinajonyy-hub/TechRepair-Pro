# HOTFIX BETA-UX-2 — Acceso del equipo: patrones de formato anterior y mini grilla

Rama `claude/beta-ux-2-pattern-legacy`, **apilada sobre #182** (BETA-UX-2): el cambio de contrato del patrón
vive en #182 y este hotfix lo completa. Sin migraciones, sin Edge Functions, sin tocar producción ni Mercado
Pago. Todos los patrones de este documento, de los tests y de las capturas son **sintéticos**.

## Diagnóstico

- **Producción (`main`)** muestra el secreto revelado como texto crudo: «Patrón: 1 → 4 → 7». Feo, y engañoso:
  los 13 patrones migrados del frontend viejo están en el contrato 0–8 y se leen con un «0» que la grilla no
  tiene; los del wizard de MOBILE-2A están en la grilla 1–9 y se leen bien sólo por casualidad.
- **#182** suma 1 a todo (contrato 0–8): arregla los migrados pero corre un punto los de MOBILE-2A (captura
  `before-182`: un `[1,2,5,8]` sintético se ve «2 → 3 → 6 → 9»).
- **Con el valor solo no alcanza.** Los dos formatos anteriores son arreglos de NÚMEROS. Un 0 sólo existe en
  0–8 y un 9 sólo en 1–9 (el servidor rechazaba el 9); sin ninguno de los dos, la misma lista es dos patrones
  distintos. No hay forma de distinguirlos en el cliente sin metadatos del servidor.

## Qué se cambió

**1. Marca de formato, sin migración.** Desde ahora el patrón se guarda como arreglo de **strings** del
contrato 0–8 (`serializePattern`: `["0","4","8"]`). El servidor lo acepta igual que a los números
(`private.mobile2a_legacy_from_access` valida cada punto con `jsonb_array_elements_text(...) !~ '^[0-8]$'`
y el espejo legacy queda `pattern:0-4-8`). El tipo JSON pasa a ser la marca de «formato actual». Lo usan la
recepción y «Configurar» del detalle.

**2. Lectura con certeza** (`readStoredPattern`):

| Valor guardado | Origen | Se muestra |
|---|---|---|
| strings `"0"`–`"8"` | formato actual | grilla exacta |
| números con un `0` | migrado del frontend viejo (0–8) | grilla exacta |
| números con un `9` | grilla 1–9 (no debería existir: el servidor lo rechazaba) | grilla exacta |
| números sin `0` ni `9` | **ambiguo** (MOBILE-2A o migrado) | aviso «Patrón guardado con formato anterior» + «Reconfigurar patrón» |
| cualquier otra cosa (texto legacy, repetidos, mezcla) | ilegible | aviso «No pudimos leer el patrón guardado» + «Reconfigurar patrón» |

En el aviso **no aparece ningún número** que pueda tomarse por el patrón. «Reconfigurar patrón» abre la
edición con «Patrón» elegido; al guardar queda en el formato actual y desde ahí se ve exacto. «Ocultar»,
«Configurar» y «Eliminar» siguen disponibles. Nada bloquea la orden.

**3. Mini grilla 3×3** (`PatternPreview`, SVG): los puntos marcados con su número de orden, unidos por el trazo
en orden, un aro en el punto de inicio y el resto de la grilla atenuada; al lado, «Patrón de N puntos ·
Empieza arriba a la izquierda (aro) y sigue el orden de los números». Para el lector de pantalla,
`role="img"` con la secuencia en palabras. El PIN y la contraseña se muestran como antes, con tipografía
monoespaciada. Sólo tokens de tema; se ve igual en claro y oscuro.

## Despliegue

- **Va junto con #182.** Si #182 se desplegara solo, sus patrones nuevos se guardarían como NÚMEROS 0–8 y
  después este hotfix los leería como «formato anterior» (los que no usen el punto 1 caerían en el aviso).
- Los patrones guardados en producción antes del deploy (13 migrados, el de MOBILE-2A del 21/09 y los que el
  frontend actual siga generando) quedan cubiertos: los legibles con certeza se dibujan bien y los ambiguos
  muestran el aviso. Nada se corre contra producción; la recarga la hace el taller desde la app.
- El plan con metadatos del servidor (`patron-historico-plan.md`, opción U1) deja de ser necesario para no
  mostrar algo incorrecto; sólo serviría para dibujar exactos los ambiguos sin recargarlos.

## Evidencia y pruebas

- Capturas antes/después (sintéticas): `evidence/07-acceso-del-equipo.png` (de `capture-device-access.mjs`).
- Componentes: `tests/components/devicePatternLegacy.test.tsx` (grilla, aviso sin números, reconfigurar
  guarda `["0","4","8"]`, ilegible, PIN) y `orderIntakeModel.test.ts` (tabla de arriba, caso por caso).
- E2E contra la base real (`m7/mobile2a-order-intake.spec.ts`): se crea una orden y se siembra `[1,2,5,8]` por
  la MISMA RPC que usaba el frontend anterior, con la sesión del usuario; la tarjeta avisa, se reconfigura y
  después se ve la grilla. El otro E2E crea una orden con 1-5-9 por la recepción (formato actual) y lo revela
  como grilla: prueba que el servidor acepta el formato de strings.
- Primer CI (run 38807003699, `450b022`): 381/382; el rojo era ese E2E. La siembra por `fetch` no mandaba
  `x-techrepair-client-contract` y el gate SEC-08E respondió 409 `CLIENT_UPDATE_REQUIRED` (el bundle lo manda
  siempre). El helper ahora lo manda, como los otros specs con `fetch` a mano, y el simulador
  (`evidence/e2e-mock/serve.mjs`) exige el encabezado en todo `/rest/v1`: con el spec anterior da el mismo 409;
  con el arreglo, 21/21.
