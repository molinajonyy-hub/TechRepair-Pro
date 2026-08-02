# P0-A.1U2 — UI de imputación y reversa · informe local

**Fecha:** 2026-07-31 · Rama `fix/p0a1-order-completion-payment-status`
Commits nuevos: **`99dea4e`** (cierre SAFEDEV) y **`f6d18fa`** (UI). Los ocho previos, intactos.
**No publicado, sin PR, sin deploy, sin backfills, sin tocar `finance_health_check_v2` ni P0-B.**

---

## 1. Cierre de SAFEDEV (§0) — conceptualmente separado

Vite resuelve las variables **de a una**: un `.env.development.local` con sólo `VITE_SUPABASE_URL` se completaba con la `ANON_KEY` heredada de `.env` (productivo). El preflight ahora lee el archivo local del modo y exige que **ambas** estén declaradas ahí; un archivo ausente también aborta. La validación corre **antes** que la del destino, porque con configuración incompleta el resultado de `loadEnv` es una mezcla sin intención clara.

Verificado a mano: archivo local con sólo la URL → `exit 1` y *«.env.development.local no declara VITE_SUPABASE_ANON_KEY»*, sin arrancar Vite. Con el archivo completo, pasa. **5 tests** nuevos, incluida una clave comentada que no cuenta como declarada. Guía nueva en `docs/desarrollo-local.md`.

## 2. Componentes

| Archivo | Rol |
|---|---|
| `src/lib/allocationMath.ts` | aritmética del reparto **en centavos enteros**, validación y mapeo de errores |
| `src/components/finance/AllocationModal.tsx` | modal **único** de imputación |
| `src/components/finance/AllocationHistory.tsx` | historial + reversa total/parcial |
| `src/hooks/useOrderCanonicalBalance.ts` | saldo canónico server-side para los consumidores que lo derivaban |

## 3. Puntos de entrada — un solo flujo

**A. Cuenta corriente** (`CuentasCorrientes.tsx`): botón «Imputar pago» en el detalle de una cuenta de cliente. **B. Comprobante** (`Comprobante.tsx`): «Aplicar crédito del cliente» cuando hay saldo, más el historial. **C. Orden** (`OrderFinancialSummary.tsx`): «Imputar crédito» cuando hay saldo y el cliente tiene crédito.

Los tres montan **el mismo componente**. No hay tres implementaciones.

## 4. Modal

Muestra cliente, cobro elegido (importe original, ya imputado, disponible), comprobantes abiertos con total y saldo imputable, orden vinculada, e importe a aplicar por documento. Resumen con total asignado, remanente y saldo esperado por documento, más la leyenda *«Esta acción asignará un cobro existente… No registrará un nuevo ingreso.»*

**Sin FIFO, prorrateo ni selección inferida:** el reparto arranca vacío y el botón deshabilitado. Un comprobante preseleccionado se muestra **primero** pero no recibe importe: elegirlo es del operador. Un test lo fija.

## 5. Distribución y validaciones

Todo en **centavos enteros**. Sumar en punto flotante decide mal justo en el borde exacto —`0.1 + 0.2 = 0.30000000000000004`—, que es el caso que más importa en «¿supera el crédito?».

Se bloquea la confirmación sin importes, si el total supera el crédito, si un importe supera el saldo imputable del documento, o si falta permiso. La moneda no se convierte nunca: la tabla tiene `CHECK (currency = 'ARS')`. **La RPC sigue siendo la autoridad**; la UI sólo evita el error obvio.

## 6. Reversas

Historial con importe, comprobante, orden, fecha, **operador**, estado y reversas. Reversa total o parcial: pide importe y motivo, muestra el crédito que volverá a quedar disponible y exige confirmación. Usa la RPC canónica, **nunca `DELETE`**, y el estado técnico de la orden no cambia.

## 7. Permisos — el agujero que se cierra

`allocate_account_payment_atomic` y `reverse_payment_allocation_atomic` validaban **pertenencia** al negocio pero **no el rol**: un `tech` o un `viewer` podían imputar y revertir llamando la RPC directamente. La UI de este lote lo habría vuelto trivialmente alcanzable.

Dos capacidades nuevas, con el patrón canónico de `user_can_override_price`:

| Acción | Roles |
|---|---|
| imputar | owner · admin · manager · cashier · sales |
| revertir | owner · admin · manager |

Revertir es más restrictivo porque deshace un hecho ya asentado. Fail-closed: un rol nuevo queda fuera hasta agregarlo. Probado: `tech` recibe `FORBIDDEN` por RPC directa y no deja asignación; `cashier` imputa pero **no** revierte.

## 8. Conflictos concurrentes

`EXCEEDS_PAYMENT`, `EXCEEDS_BALANCE`, `ALREADY_REVERSED`, `ON_ANNULLED` e idempotencia se mapean al mensaje *«El saldo cambió mientras realizabas la operación…»*. **No se reintenta solo**: se descarta la key, se limpia el reparto, se refrescan los importes y se exige confirmar de nuevo. Nunca se muestra SQL crudo — hay un test con un mensaje de constraint real que verifica que no se filtra.

**Bug propio que encontró el test:** `cargar()` limpiaba el aviso al empezar, así que el mensaje de conflicto se seteaba y desaparecía en el mismo tick. Ahora se setea después de recargar.

## 9. Fuentes server-side

`get_allocation_workspace` (créditos, documentos y ambas capacidades), `get_payment_allocations` (historial), `get_order_financial_amounts` y `v_order_payment_state`. `v_customer_open_documents` deja de ser legible directamente: expone saldos, igual que las que se cerraron en U1V.

## 10. Deuda de React corregida (§10)

`OrderCostManagement` y `PaymentCard` derivaban el saldo restando en local. Esa resta **ignora las imputaciones de cuenta corriente**, así que después de imputar mostraban un saldo que ya no era real. Ahora usan `useOrderCanonicalBalance`; la resta local queda sólo como respaldo para órdenes **sin comprobante**, donde no hay saldo canónico. `useDashboardStats` y `Customers.tsx` siguen como **P1 explícito**.

## 11. Tests

**Componentes: 37** (22 previos + 15 nuevos del modal). Cubren crédito disponible · sin crédito no ofrece imputar · asignar habilita · distribuir entre dos · remanente · exceder crédito · exceder saldo · **doble submit = una sola mutación** · éxito refresca · idempotency key e importes en el payload · conflicto refresca sin reintentar · sin SQL crudo · sin permiso de escritura · rol sin importes · error no es cero · sin FIFO · portal · tokens de tema.

**SQL: 40 nuevos**, 648 en total en 14 suites. Workspace, permisos por rol, el agujero de `tech` cerrado, readback a Cobrado, saldo 0, crédito consumido, replay idempotente, historial con operador, `cashier` no revierte, reversa parcial con remanente y crédito devuelto, bordes de exceso, comprobante anulado y moneda.

Pendientes de §11: **3, 4, 5** (abrir el modal desde cada punto de entrada montando la página completa) — el modal se prueba montado directo; los tres puntos se verificaron en el recorrido real.

## 12. Guards

Sin reglas nuevas: las existentes ya cubren FIFO, saldo en React, fuentes prohibidas y `DELETE`. Pasan las **15 fixtures** de self-test y `npm run guards` en verde. El baseline de `BASELINE_SALDO_EN_REACT` quedó obsoleto en la práctica —los dos archivos ya no derivan saldo— pero se conserva porque la resta sigue presente como respaldo para órdenes sin facturar.

## 13. Recorrido visual — **hecho, y encontró un defecto**

Contra el stack local de Docker, con `npm run dev` ya protegido y usuario local. Flujo completo de §14, medido en el DOM real:

```
1-5. orden 100.000 · cobrado directo 40.000 · saldo 60.000 · badge "Parcial"
     crédito sin imputar 60.000 informado, con botón "Imputar crédito"
6.   modal abierto: disponible $60.000 · total $0 · confirmar deshabilitado
7.   imputados 60.000 -> badge "Cobrado" · saldo $0 ·
     "Imputado desde cuenta corriente $60.000" · Cobro completo 31/7 03:19:48
8-9. reversa de 10.000 -> badge "Parcial" · saldo $10.000 ·
     imputado 50.000 · Cobro completo vuelve a "—"
10.  crédito sin imputar: $10.000 · historial: Activa + 2 Revertida
```

**Defecto encontrado y corregido:** el modal quedaba dentro del layout del caller y un ancestro con `transform` rompía el `position: fixed`. En mobile el overlay medía **95 px** en vez de 375 y el panel **63 px**: inusable. Se resolvió montándolo en un **portal a `document.body`**. Verificado después del fix: overlay 375, modal 343, padre `document.body`, sin overflow. Tiene test de regresión.

**Limitaciones declaradas:** sin capturas de imagen —el `screenshot` del panel embebido falla porque no está visible— así que la evidencia es medición del DOM. Y el **dark mode no se verificó**: la app usa su propio `ThemeContext` y forzar `prefers-color-scheme` no lo cambia; el modal usa variables de tema, con test, pero eso no sustituye mirarlo.

**Cuatro tropiezos de entorno**, todos resueltos y ninguno del código de aplicación: Kong quedó sin publicar puerto tras un reset (se resolvió con `supabase stop`+`start`); el puerto real es **54421**, no 55421 —corregí el comentario que había escrito mal en el guard—; el browser embebido sólo alcanza puertos de servers registrados por el harness; y GoTrue rechaza un usuario insertado a mano si las columnas de token quedan en NULL, ahora arreglado **dentro del seed** para que no se repita.

## 14. Archivos y migraciones

Una migración: **`20260802120000`** (210) — 2 capacidades, 2 RPC de lectura, `CREATE OR REPLACE` de las dos RPC de escritura para sumar el check de rol, y un `REVOKE`. Rollback documentado. `db reset` ×2 limpios.

## 15. Validación

`db reset` ×2 (**210** migraciones) · **648** asserts SQL en 14 suites · `tsc` 0 · `lint:errors` 0 · **592/592** unit · **37/37** componentes · `build` OK · `guards` OK · sin accesos a producción, sin backfills, Health Check y P0-B intactos.

## 16. Riesgos

- **Medio — se tocaron dos RPC financieras en producción-futuro.** El cambio es acotado (un check de capacidad al principio) y el resto del cuerpo es idéntico, pero endurece el permiso: si algún rol operaba fuera del contrato, va a empezar a recibir `FORBIDDEN`. Es lo correcto y hay que comunicarlo.
- **Medio — `cashier` no puede revertir.** Es la lectura del contrato («reversa según permiso canónico»); si el negocio quiere lo contrario, es una línea.
- **Bajo — el `REVOKE` de `v_customer_open_documents`** rompería a cualquier consumidor que la lea directo desde el cliente. Hoy no hay ninguno.
- **Dark mode sin verificar** y sin capturas de imagen (§13).
- Los tres tests de §11 que faltan montan páginas completas, no el modal.

## 17. Recomendación

**GO al release de P0-A.1.**

El circuito está completo de punta a punta: el COGS se reconoce, la orden se cierra sola al facturar, el estado financiero es server-side, los importes están restringidos por capacidad, la imputación es explícita y auditada, la reversa no borra nada, y ahora **todo eso se puede operar desde la interfaz** — verificado en el navegador, no sólo en tests.

Antes de publicar sugiero: mirar el dark mode de las dos pantallas nuevas, y avisar al equipo que `tech` y `viewer` pierden acciones financieras que antes la RPC les permitía por omisión.

Después, en lotes separados: **P0-A.1H** (Health Check semántico), el **backfill de estados** (4 órdenes), **P0-B** —que sigue bloqueado y sin cambios— y los P1 registrados (`amount_paid` con cuatro consumidores, `orders.total_cost` como monto cobrable en `ModalCobro`, y la portabilidad de instalación en Windows).
