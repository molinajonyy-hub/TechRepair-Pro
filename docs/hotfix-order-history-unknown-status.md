# Order history hotfix

## Causa y atribución

**PRE-EXISTING BUG**. `OrderDetail` trataba las filas leídas de `status_history`
como el argumento de escritura `StatusHistoryEntry` de `recordStatusChange`.
Ese argumento tiene `from_status`, `to_status`, `notes`; la tabla productiva
almacena `status`, `note`. El hook asigna directamente las filas de PostgREST.

Cadena reproducida:

```text
{ status: "diagnosis", note: "..." }
→ entry.to_status === undefined
→ STATUS_CONFIG[undefined] === undefined
→ .color
→ TypeError y caída de OrderDetail al abrir Historial
```

El lookup de `from_status.label` también era inseguro. No hacía falta un
estado legacy: una fila productiva con un estado actual válido ya disparaba
el crash.

Inspección productiva exclusivamente read-only, sin notas ni datos personales:

- 131 filas; ninguna contiene columnas `from_status` o `to_status`.
- `status`: text NOT NULL; `note` y `created_at` admiten NULL.
- Todos los códigos observados están en el mapa actual; `diagnosis` aparece
  en cuatro filas y se utilizó en la reproducción sintética.
- No se identificó individualmente la orden del reporte humano. Se verificó
  el formato real compartido por las filas, suficiente para reproducir el
  error exacto sin copiar datos privados.

Comparación entre baseline `3f9ac158478069c92f6614798f5d218a6820e6a1` y R1
`1f84b3ac3120f62a137e4c8c167921a0682dfced`: diff vacío en los tres archivos.
Los blobs son idénticos:

| Archivo | Git blob en ambos commits |
| --- | --- |
| `src/pages/OrderDetail.tsx` | `88ed579a5833c302ca494c553fb9a7ca9a553a5e` |
| `src/hooks/useOrderSimple.ts` | `741cd60b41330656691862808f7ba219ffdb3bfe` |
| `src/types/orderStatus.ts` | `0153666c8f74fb649f7ae868d9807ea18e31a6c4` |

Además, los tests nuevos montaron el OrderDetail real antes del arreglo:
10 fallaron y 1 pasó, reproduciendo `Cannot read properties of undefined
(reading 'color')`. Con el arreglo, los mismos 11 casos pasan. La atribución
no se basa en la fecha del reporte.

## Cambio focalizado

- `src/lib/orderHistory.ts`: contrato de lectura y única resolución visual
  del historial. Respeta `status/note` y tolera payloads anteriores con
  `from_status/to_status/notes`. Un snapshot no inventa una transición.
- `src/hooks/useOrderSimple.ts`: corrige sólo el tipo de `history`; conserva
  consultas, rutas de lectura y asignación de filas originales.
- `src/pages/OrderDetail.tsx`: resuelve una vez cada entrada antes de leer
  color/label/nota. Conserva la estructura de la timeline y el icono
  `ArrowRight` existente, también seguro para valores desconocidos.
- Fallback: `Estado desconocido (<valor original>)`, gris neutral `#64748b`;
  null/undefined/vacío se presentan como `Estado desconocido`. Las claves
  heredadas de Object (`constructor`, `__proto__`) no se aceptan como estados.
- El resolver es únicamente visual. No cambia estados, reglas de transición,
  escritores, DB ni el dato recibido. No se parsean notas para inferir estados.

No se modifica el componente alternativo `StatusHistoryCard`, que no es
consumido por OrderDetail, ni se realiza un refactor general del mapa de estados.

## Validación

- Nuevo `orderDetailHistory.test.tsx`: **11 PASS**. Formato productivo conocido,
  estados legacy/eliminados/desconocidos, claves de prototipo, valores ausentes,
  transiciones explícitas, historial mixto, vuelta a General y estado vacío.
- Tests existentes del hook/detalle financiero: **38 PASS** (8 del hook,
  19 del resumen y 11 del badge).
- R1 focalizado: **71 PASS** (contrato/headers, update UX/reload, compatibilidad
  parts pre/post, mobile foundations y portal). Total componentes: **120 PASS**.
- TypeScript `tsc --noEmit`: PASS.
- ESLint focalizado: 0 errores, 13 warnings preexistentes en OrderDetail/hook.
  Helper y tests nuevos: 0 errores y 0 warnings.
- Build de producción: PASS. Advertencias existentes de chunks grandes e
  importación estática/dinámica de subscription.
- E2E local con PostgreSQL/PostgREST real y guard de destino: **8 PASS**:
  2 del historial nuevo a 1440/390 px y 6 existentes de WhatsApp desde la orden.
  Los dos casos nuevos comprueban que los estados permanecen idénticos en DB,
  no hay escrituras browser a status_history y no hay errores de página.
- Capturas del historial inspeccionadas en desktop y mobile, tema claro:
  fallback legible, notas preservadas y detalle utilizable. Tema oscuro no fue
  inspeccionado visualmente; se preservan la estructura y los estilos existentes.
- La página local también abrió correctamente con agent-browser, sin error
  de página ni pantalla vacía.
- CI incluye el nuevo test de render; los dos E2E entran en `m7-local`.

### Deuda de tests fuera de alcance

Se intentaron `orders-minimal.spec.ts` y `orders-status.spec.ts` del proyecto
legacy `chromium`: **2 FAIL** antes de alcanzar el detalle, porque el helper
busca `new-order-customer-search`, ausente en el frontend. `git grep` confirma
que en baseline el selector sólo aparece en el helper; el frontend, helper y
specs comparados no cambiaron entre baseline y R1. No se modificaron estos
tests ni se convirtieron en skips. La validación vigente del detalle se hizo
con los ocho casos `m7-local` indicados arriba.

El primer intento del fixture nuevo falló por omitir `customers.phone`
obligatorio. Se corrigió el fixture sintético local; la ejecución posterior
pasó. Ninguna de estas preparaciones se realizó en producción.

## Integridad y entrega

Base del worktree aislado: `1f84b3ac3120f62a137e4c8c167921a0682dfced`.
Branch: `codex/hotfix-order-history-unknown-status`.

En producción: cero DML, DDL o migraciones. Ledger observado: 263, latest
`20260921120000`; SEC-08E ausente. `SEC-08E migration NOT applied`.
No cambios a client contract, headers, update UX, parts compatibility ni sus
rutas pre/post-schema. No R2/R3, no modificación de #110, no tag.

Se entrega un único commit y PR para revisión. No incluye merge ni deploy del
hotfix; el smoke humano productivo deberá repetirse después de un rollout
posterior autorizado.
