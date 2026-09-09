# ORDERS-V2-0.1.1 — el desplegable de Marca/Modelo se cortaba en el iPhone

El human smoke real en iPhone falló: las listas de sugerencias de **Marca** y
**Modelo** se veían cortadas.

## Causa raíz — medida, no supuesta

Diagnóstico con WebKit real (Playwright, iPhone 13, 390×844) sobre el build de
producción, ANTES de tocar nada:

```json
{
  "viewport":              { "w": 390, "h": 664 },
  "input":                 { "top": 289, "bottom": 337, "left": 33, "width": 324 },
  "lista":                 { "top": 341, "bottom": 597, "height": 256,
                             "scrollHeight": 1020, "clientHeight": 254 },
  "seSaleAbajo":           false,
  "espacioDebajoDelInput": 327,
  "pageScrollWidth":       390,
  "ancestrosQueRecortan": [
    { "tag": "section", "clase": "card intake-step-card",
      "overflow": "hidden/hidden", "bottom": 449 },
    { "tag": "div", "overflow": "hidden/auto", "bottom": 664 }
  ]
}
```

La lista medía 256 px de alto y la card la cortaba en `bottom: 449`: **se veían
108 px de 256**.

Lo importante es lo que la medición descarta. **No era falta de espacio en
pantalla**: había 327 px libres debajo del campo, la lista no se salía del
viewport (`seSaleAbajo: false`) y no había desborde horizontal
(`pageScrollWidth == 390`). El recorte lo producía el `overflow: hidden` de
`.intake-step-card`, un ancestro del desplegable.

Esa distinción es la que decide el arreglo, y descarta de entrada los cuatro
parches que se habían prohibido:

| Parche | Por qué no aplica |
|---|---|
| `z-index: 9999` | El apilamiento no era el problema; un ancestro que recorta gana igual sobre cualquier `z-index`. |
| `overflow: visible` global en cards/layouts | Rompería el recorte que esas superficies necesitan para su propio scroll. |
| Subir `max-height` | Agrandaría la lista dentro del mismo recorte: se vería la misma fracción, o menos. |
| `@media` específico de iPhone | El recorte no depende del dispositivo; el ancestro recorta igual en cualquier ancho. |

## Arreglo

La lista sale del formulario: se renderiza con `createPortal` en
`document.body`, en `position: fixed`, y se posiciona contra el viewport.
Ningún ancestro puede recortarla porque ya no cuelga de ninguno.

- **`src/ui/components/anchoredPosition.ts`** (nuevo) — función pura que
  calcula lado (`bottom`/`top`), alto máximo, ancho e izquierda a partir del
  rectángulo del campo y del viewport. Elige el lado con lugar, adapta el alto
  al espacio disponible y mantiene la caja dentro de los márgenes.
- **`src/ui/components/AppCombobox.tsx`** — portal + `position: fixed`, y
  reubicación en `scroll` (con captura), `resize` y los eventos de
  `visualViewport`, que es lo que en iOS refleja el teclado abierto. Los
  listeners se agregan al abrir y se retiran al cerrar.
- **`src/index.css`** — la lista ya no se posiciona en CSS (eso lo decide el
  cálculo); conserva su superficie, el scroll interno y `z-index: 10000`, por
  encima del overlay de `AppModal` (9999).

### Lo que NO cambió

El contrato táctil aprobado en la revisión previa queda intacto: la opción se
elige en `click`, nunca en `pointerdown`, y el `preventDefault` va en
`mousedown`. Desplazar la lista con el dedo sigue sin seleccionar ni cerrar.

El portal sí obligó a corregir un efecto colateral: la lista ya no está dentro
del componente, así que la detección de "click afuera" y el `focusout` ahora
consideran adentro tanto la raíz como la lista portaleada. Sin eso, tocar una
opción se leía como un click afuera y cerraba el desplegable antes de elegir.

## Verificación

| Suite | Resultado |
|---|---|
| `tests/components/anchoredPosition.test.ts` | 10/10 |
| `tests/components/appCombobox.test.tsx` | 25/25 |
| `vitest` completo | 924/924 (69 archivos) |
| `tests/e2e/webkit` (WebKit real, iPhone 13) | 10/10 |
| `playwright --project=m7-local` | 163/163 |
| `tsc --noEmit` · `lint:errors` · `build` | 0 errores |

Evidencia en `docs/orders-v2-0-1-1-evidence/`: Marca y Modelo completos a
390×844, y la lista reubicada al achicarse la pantalla.

### Límite declarado

El **volteo hacia arriba** no se prueba en E2E, y no por olvido: en este layout
el campo de Marca nunca queda a menos de ~200 px del borde inferior —el scroll
del paso se agota antes— y WebKit headless no abre teclado, que es lo que en un
iPhone real achica el viewport visual y provoca el volteo. Forzarlo con
coordenadas o estilos inventados probaría una pantalla que no existe. El
cálculo del lado y del alto está cubierto por los tests unitarios de
`anchoredPosition` (caso B: sin lugar abajo → arriba; caso C: alto adaptado; y
el desplazamiento del viewport visual de iOS).

Por eso esto **no es un PASS de iPhone**: el smoke humano en el dispositivo
real sigue siendo la única prueba que cierra el hallazgo.

## Alcance

Sin migraciones, sin cambios de DB, sin Supabase, sin Edge Functions, sin
SEC-08, sin tocar el scanner, el manejo de moneda ni la autoridad del catálogo.
El diff son tres archivos modificados (`AppCombobox.tsx`, `index.css`,
`appCombobox.test.tsx`) y tres nuevos (`anchoredPosition.ts` y sus dos suites).

### Guards preexistentes en rojo

Tres guards de la batería fallan **en `origin/main` sin ningún cambio de esta
rama** —se verificó corriéndolos sobre un worktree limpio de `origin/main`, con
idéntico resultado—: `guard:secdef` y `guard:secdef-exposure` (por
`20260923120000_sec08e_r2a_client_contract_gate_disabled.sql` y
`20260912120000_sec08a_phase_b_financial_pivots.sql`) y `guard:view-invoker`
(cuatro vistas financieras sin `security_invoker` en la DB local). Son
territorio SEC-08 y quedan sin tocar a propósito. Los 84 guards restantes pasan.
