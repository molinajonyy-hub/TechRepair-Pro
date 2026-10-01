# Restauración de gastos recurrentes

## Base y alcance

Base: `29df5312ddbfa5fb73db09b82a7f2261a8d44000`.
Branch: `fix/recurring-expenses-ui`, en worktree aislado.

La gestión de `public.recurring_expenses` vuelve a **Finanzas → Gastos**.
Son plantillas mensuales: guardar una no registra un movimiento ni un pago.
`/expenses` conserva su modelo `public.expenses` y su enlace desde Finanzas.

## Discovery

- El panel histórico tenía creación, edición, desactivación, historial y estado de pagos.
- El 6 de julio, `ec63963d6efb5aaa0745749d65db88bc13dabab0` reemplazó la ruta legacy por el aviso de deprecación.
- `1b23bc25aba62c5979e7af4eefa420bc8d56d1c5` eliminó `Finance.tsx` y su panel de recurrentes.
- El hook `useRecurringExpenses` y el contrato de datos permanecieron sin consumidor frontend.
- El smoke de SEC-08F hizo visible la ausencia de UI; esta restauración no modifica SEC-08F.
- Se usa el historial como referencia funcional. Se reutilizan AppModal, AppMoneyInput, botones, badges y estados actuales; no se restaura el diseño ni los cálculos P&L antiguos.

## Implementación

- Panel con nombre, importe/moneda, día mensual y estado. Filtros Activos/Inactivos/Todos.
- Creación con tipos y categorías del catálogo actual: costos fijos del local o sueldos de empleados.
- Edición de nombre, importe, moneda, día y notas. Conserva tipo, categoría y subcategoría existentes.
- Validación de nombre, importe no negativo y día entero entre 1 y 28, según el contrato existente.
- Desactivar/reactivar actualiza `is_active`; no se ofrece DELETE.
- El hook permite incluir inactivos y omitir la consulta de pagos para esta superficie; sus opciones por defecto y API histórica se conservan.
- Escrituras acotadas al negocio; `.select().single()` confirma una fila y rechaza cero filas afectadas. El éxito requiere respuesta confirmada, seguido de recarga.
- Un fallo de recarga se muestra como error de listado; no se convierte en una lista vacía. Un fallo de escritura conserva el editor abierto.
- Bloqueo de doble submit y cierre mientras se guarda. Cambiar de negocio descarta editor y mensajes anteriores.
- Sin rutas nuevas. Se heredan autenticación, capability `finance` y feature `advancedFinance` de `/finance`, sin bypass adicional por owner.

## Verificación local — 15 de septiembre de 2026

| Control | Resultado |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS: 0 errores, 528 advertencias del repositorio; componentes nuevos y hook con 0 advertencias |
| `npm run build` | PASS; avisos de chunk PDF y de importación mixta de subscription preexistentes |
| `recurringExpenses.test.tsx` | 13/13 PASS, hook y componentes reales con borde Supabase simulado |
| Regresión de componentes Finance, SEC-08C, RBAC, prebeta P1 y controles monetarios | 184/184 PASS en 13 archivos, incluidos los 13 nuevos |
| `node --test tests/unit/expenseFinanceType.test.ts tests/unit/financeIndependence.test.ts` | 13/13 PASS |
| `guard:finance-writes`, `guard:ui-governance`, `guard:charts-l1`, `guard:prebeta-p1` | PASS |
| Diff de `supabase` y del harness SEC-08F contra la base | Vacío |
| `git diff --check` | PASS |

Las pruebas cubren acceso permitido/denegado, advancedFinance, loading, empty, error/reintento, datos, precarga/validación/payload, guardado rechazado o sin filas, actualización/refresco, doble submit, creación, activación y cambio de tenant. La integración monta FinanceDashboard y abre Gastos; verifica que siga existiendo el enlace independiente a `/expenses`.

Verificación visual con Playwright y Edge local, en 1440×1000 y 390×844, claro y oscuro: panel y editor, sin overflow horizontal, controles del panel de al menos 44 px, edición y activación correctas. También se verificaron empty, error de carga y editor abierto ante error de escritura. Sin errores de página/consola en la ejecución final. Datos y Supabase simulados; recursos de fuentes externos sustituidos localmente. Capturas y harness locales en `test-results/recurring-review/` (ignorados por Git).

Limitaciones: no se ejecutó la matriz SQL/PostgREST de SEC-08F ni un smoke autenticado contra producción. El SQL y el harness se compararon sin cambios contra la base certificada. Esta tarea no requiere migración ni acceso a producción.

## Revisión humana

1. Abrir Finanzas → Gastos con acceso autorizado.
2. Revisar las plantillas y los filtros; crear una plantilla de prueba en un entorno de pruebas.
3. Editar nombre, importe, moneda y día; verificar los valores después de recargar.
4. Desactivar, consultar Inactivos, reactivar y volver a Activos.
5. Comprobar que Ver gastos conserva los gastos registrados y que `/finance/reports` sigue mostrando su aviso.

Diff A: panel, formulario, CSS específico, hook e integración en FinanceDashboard.
Diff B: pruebas y este documento.
Diff C: cero cambios ajenos. Sin SQL, ARCA, Vault, Tasks/Mobile, rutas ni restauración de Finance.tsx.
