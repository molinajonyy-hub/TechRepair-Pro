# P0-A.1U1V — Gate visual y permisos financieros · informe local

**Fecha:** 2026-07-31 · Rama `fix/p0a1-order-completion-payment-status` · commit nuevo **`86661aa`**
Los seis commits previos quedaron intactos. **No publicado, sin PR, sin deploy, sin backfills, sin tocar el Health Check.**

---

## 1. Evidencia visual — **gate cumplido**

Recorrido real sobre el **stack local de Docker**, nunca producción. Los cuatro estados en una sola pantalla, con importes deliberadamente distintos:

```
badges  : ["Sin facturar", "Pendiente", "Parcial", "Cobrado"]
celdas  : ["Sin facturar",
           "Pendiente | Saldo $111.111",
           "Parcial   | Saldo $200.000",
           "Cobrado"]
overflow horizontal (1280px): false
```

**Filtro financiero server-side**, ejercido con una interacción real sobre el `<select>` (evento `change`, no llamada directa al hook):

```
filtro = 'partial'  ->  filas = 1  ·  badges = ["Parcial"]
```

**Mobile 375×812:** `document.scrollWidth = 375` = viewport ⇒ **sin overflow horizontal del documento**. La tabla mide 1042 px y scrollea dentro de su contenedor, que es el comportamiento existente de la página, no una regresión introducida por la columna nueva. Los cuatro badges siguen presentes.

**Limitación honesta:** no hay capturas de pantalla. El `screenshot` del navegador embebido falla con *«the Browser pane is not displayed, so the page is not compositing frames»* — el panel no está visible en esta sesión. La evidencia es **medición del DOM real** (texto renderizado, anchos calculados, `scrollWidth`, estilos computados), que para lo que había que verificar —estados correctos, saldos correctos, sin overflow, filtro funcionando— es más precisa que una imagen. Lo que **no** puedo afirmar es el juicio estético ni el contraste percibido.

**Dark mode:** al forzar `colorScheme: dark` el documento siguió reportando tema `light`. No es un fallo del badge: la app usa su propio `ThemeContext` y —según la arquitectura del proyecto— la lista de órdenes es light por diseño, con islas dark en POS y Mi Guita. El badge usa variables CSS de tema, así que sigue el tema que la app aplique; **el modo oscuro de esta pantalla no quedó verificado visualmente**.

## 2. Problemas encontrados durante el recorrido

Ninguno en la UI. Cuatro en el camino, todos de entorno o de seed, y todos vale la pena registrarlos:

1. **`.env` apunta a producción.** El `npm run dev` por defecto levanta la app contra el Supabase productivo. Lo detecté antes de autenticarme y **detuve el servidor de inmediato**; no hubo login ni escritura. El recorrido se hizo con `dev:e2e`, el mecanismo local aprobado en 7D.2. **Es un riesgo latente para cualquiera que corra `npm run dev`.**
2. **Kong local expone 55421, pero `.env.e2e` apunta a 54421.** `supabase status` reporta 54421 y el contenedor mapea 55421: el desajuste produce «Failed to fetch» en el login. Se resolvió pasando `VITE_SUPABASE_URL` por entorno, sin tocar el archivo compartido.
3. **`devices_type_check`** sólo admite `smartphone|tablet|laptop|smartwatch|other`; el seed usaba `celular`/`notebook` y las filas se rechazaban en silencio (el script no usaba `ON_ERROR_STOP`).
4. **GoTrue rechaza un usuario insertado a mano** con «Database error querying schema» si las columnas de token quedan en NULL: hay que setearlas en `''`.

## 3. Ajustes realizados

Ninguno visual: el recorrido no encontró defectos de layout, truncamiento ni contraste estructural que corregir. Los cambios de este lote son de **permisos** (§4-§5) y de la UI que los refleja.

## 4. Contrato de permisos

Inventario real: **no hay tabla de permisos**. La autoridad es `profiles.role` (CHECK con `owner, admin, manager, tech, sales, cashier, viewer`) más un `profiles.permissions jsonb` que hoy no se usa para finanzas. El patrón canónico del proyecto son funciones `user_can_*(business, user)` — `user_can_override_price`, `user_can_sell_below_cost`.

Capacidad nueva, siguiendo ese patrón exacto:

| Rol | ¿Ve importes? |
|---|---|
| owner · admin · manager · cashier · sales | **sí** |
| tech · viewer | **no** |
| cualquier rol futuro | **no**, hasta agregarlo explícitamente (fail-closed) |

Sin permiso se ve: el badge (Sin facturar / Pendiente / Parcial / Cobrado) y la referencia del comprobante. No se ve: total, cobrado, saldo, crédito del cliente ni fechas financieras. **Nunca importes en cero** — se muestra «Importes restringidos».

## 5. Autoridad server-side: opción C + B

Se combinó el mecanismo canónico de capacidades con la separación de superficies:

- **`v_order_payment_state`** — estado **sin ninguna columna de importe**. `GRANT` a authenticated. Alimenta badge y filtro para todos los roles.
- **`v_order_financial_status`** y **`v_customer_unallocated_credit`** — **`REVOKE SELECT ... FROM authenticated`**. Ya no son legibles desde el browser.
- **`get_order_financial_amounts(business, order_ids[])`** y **`get_customer_unallocated_credit(business, customer)`** — SECURITY DEFINER con `search_path = pg_catalog, pg_temp`, referencias calificadas, `REVOKE` de PUBLIC y de anon. Validan pertenencia **y** capacidad; sin permiso devuelven `authorized:false` y **cero filas**.

**El monto no sale del servidor**, así que no hay nada que ocultar en React.

**Hallazgo de diseño, probado y no supuesto:** la primera versión de `v_order_payment_state` derivaba de `v_order_financial_status`. Con `security_invoker`, una vista derivada hereda los privilegios del invocador, así que un `tech` recibía `permission denied` al pedir el estado. Se reconstruyó desde las tablas base: duplica el predicado de vigencia y el CASE, pero **nunca proyecta un importe**. El test `F3` fija exactamente ese comportamiento.

## 6. Consultas de UI

Sin N+1: **dos consultas por página**, sin importar cuántas órdenes haya —`v_order_payment_state` con `.in('order_id', [...])` y una llamada a la RPC de importes por lote. El filtro financiero sigue resolviéndose server-side **contra la vista sin importes**, así que un rol restringido puede filtrar por «Pendientes» o «Cobradas` sin que ningún monto viaje al browser.

## 7. Tests SQL — 26 asserts, todos verdes

Capacidad por rol (owner, cashier ✓ / tech, viewer ✗ / owner de otro negocio ✗ / sin actor ✗) · owner autorizado con importes correctos · **tech y viewer reciben cero filas y la respuesta no contiene ningún importe** (se verifica el texto completo del JSON) · cross-business devuelve `FORBIDDEN` antes que «sin permiso` · anon sin EXECUTE ni SELECT · **`authenticated` ya no puede leer la vista con importes** · un tech que la consulta directamente recibe `permission denied` · el estado de cobro **sí** le llega (badge y filtro funcionan) · la vista de estado **no tiene ninguna columna de importe** · el crédito del cliente tampoco llega, ni como campo.

## 8. Tests de componentes — 18, todos verdes

Los 8 del badge más 10 del resumen, ahora sobre el contrato de permisos: rol autorizado ve badge e importes · **tech/viewer ven el badge y «Importes restringidos»** · sin permiso no aparece ningún `$0` · **error muestra «No disponible», que es un estado distinto de «restringido»** y el test lo separa explícitamente · error en la RPC tampoco inventa ceros · loading sin estado ni importe · el crédito no imputado sólo con permiso y no cambia el badge · sin acciones de escritura.

## 9. Guards

Sin reglas nuevas: las de U1 siguen pasando (15 fixtures de self-test, `npm run guards` OK). La regla «React oculta importes que la DB igualmente entregó» **no se implementó como guard de texto**: es un invariante de datos, no de código, y está cubierto por los tests SQL `C3`/`C4`, que verifican que la respuesta del servidor a un rol no autorizado no contiene ningún monto. Un guard de texto ahí sería teatro.

## 10. Migraciones

Una: **`20260801120000_p0a1u1v_order_amounts_permission.sql`** (209). Agrega una capacidad, una vista sin importes y dos RPCs; revoca dos vistas. Rollback documentado. `db reset` ×2 limpios.

## 11. Deuda registrada — P1 de portabilidad de instalación

`@rollup/rollup-linux-x64-gnu` está en `dependencies` para el build de Vercel (Linux) y provoca **`EBADPLATFORM` en Windows**, obligando a `npm install --force`. **No se resolvió acá**: la corrección natural es moverlo a `optionalDependencies` o a `overrides`, pero eso toca el build productivo y necesita verificarse en CI Linux antes. **`--force` no debe normalizarse como procedimiento.** Queda como P1 separado.

## 12. Validación

`db reset` ×2 (**209** migraciones) · **26** asserts SQL de permisos · `tsc` 0 · `lint:errors` 0 · **572/572** unit · **18/18** componentes · `build` OK · `guards` OK.

Confirmado: **ningún acceso a producción** (el único intento se abortó antes de autenticar), ningún dato productivo, ningún backfill, ningún cambio en el Health Check.

## 13. Riesgos

- **`npm run dev` apunta a producción.** Es el riesgo más serio que encontré hoy, y es previo a este lote. Un desarrollador que levante la app por el camino obvio opera contra datos reales. Merece su propio arreglo.
- **Dark mode de la lista sin verificar visualmente** (§1).
- **Sin capturas de imagen**: la evidencia es medición del DOM. Suficiente para lo estructural, insuficiente para juicio estético.
- **Medio — el `REVOKE` sobre `v_order_financial_status` es un cambio de superficie.** Cualquier consumidor futuro que la lea directamente desde el cliente va a fallar. Es deliberado y está documentado en el `COMMENT`, pero hay que saberlo.
- Bajo: la capacidad usa `role`, no el `permissions jsonb`. Si el producto adopta permisos granulares, hay que extender una sola función.

## 14. Recomendación

**GO a U2.**

Los dos gates quedaron cerrados: el recorrido visual muestra los cuatro estados correctos con sus saldos y sin overflow, y los importes ahora están restringidos por una capacidad evaluada en la base, no por un `if`. Lo que queda pendiente es acotado y está declarado: el dark mode de esta pantalla y las capturas de imagen.

Antes de U2 conviene resolver el P1 de `npm run dev` → producción, porque U2 sí escribe (imputaciones y reversas) y ese apuntado equivocado dejaría de ser un susto para pasar a ser un incidente.

P0-B sigue **bloqueado y sin cambios**.
