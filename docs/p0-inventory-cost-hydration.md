# P0: costos de Inventario después de SEC-08B

## Causa raíz y auditoría

SEC-08B conserva los datos y revoca correctamente su lectura directa. `useInventory`
leía exclusivamente `INVENTORY_OPERATIONAL_COLUMNS`, sin reponer costos desde
`v_inventory_costs`. Inventario entregaba esas filas al motor de precios, que
normaliza campos numéricos ausentes a cero. La tabla terminaba publicando costo
cero y ganancia igual al precio de venta.

Consumidores revisados antes del cambio:

| Consumidor | Hallazgo y decisión |
| --- | --- |
| `useInventory` → `Inventory` | Único consumidor en runtime del hook. Hidratar todas las filas operativas, incluidos hijos legacy y V2, por ID de inventario. |
| Tabla: costo ARS/USD, rango del padre, ganancia y porcentaje | No publicar cálculos si falta el costo efectivo de alguna variante activa. Mostrar carga, restricción o falta de disponibilidad. USD conocido puede mostrarse aunque falte ARS. Cero real se conserva; porcentaje sobre costo cero queda indefinido. |
| `resolveProductPricing` compartido con POS/búsqueda | Mantener motor y precios de venta existentes. La pantalla comprueba disponibilidad antes de publicar el costo/margen. |
| `ProductFormModal` (edición simple, hijo y padre) | Reconsultaba la vista, pero autorización global no aseguraba una fila cargada. La edición ahora exige respuesta de esa fila y contexto vigente. Omitir costos no modificados evita recálculo/redondeo involuntario de originales USD. |
| `productService.updateProduct` | Conserva campos omitidos y propaga solamente actualizaciones presentes a metadata V2. Sin cambios en servicio de escritura. |
| Exportación → importación | Exportación usaba `?? 0`; ahora exporta valores originales y vacíos para ausentes. Importación ya omite celdas vacías; verificado con round-trip integrado. Sin autorización se omiten las columnas. Error de consulta cancela exportación. |
| Duplicación y alta legacy de variantes | Crean filas nuevas sin stock; su fallback cero no actualiza el producto original. Se conserva el contrato existente y sus pruebas. |
| `attachInventoryCosts`, servicios de producto, reportes y búsqueda | Usan la frontera compartida de costos; no consumen `useInventory`. Se conserva el comportamiento de llamadas sin negocio explícito. Los cambios del helper son aditivos. No se amplía este hotfix a las fórmulas de otras pantallas. |

## Corrección y límites

- Lectura operativa intacta; costos exclusivamente desde la vista existente.
- Filtro explícito de negocio. Para resolver autoridad sin filas se reutiliza
  `can_view_inventory_cost` cuando hay negocio; ninguna matriz de roles nueva.
- Invalidación por usuario, negocio, rol y permisos del perfil; nueva lectura al
  despertar. Número de solicitud y contexto impiden publicar respuestas antiguas
  o actualizar después de desmontar. Se borran costos durante revalidación.
- Error de costos conserva productos operativos y permite reintentar. Se descarta
  un mapa parcialmente leído si falla un lote. Exportación verifica contexto al
  terminar su consulta.
- Formulario distingue desconocido, cero explícito y valor original. Antes de
  cargar o si la fila no está autorizada, no envía columnas de costo. Una edición
  de nombre omite ambos costos aunque exista una nueva cotización del dólar.
- No se cambian migraciones, RLS, GRANT, RPC, stock, precios de venta ni datos de
  producción. No se hace merge ni despliegue.

## Validación

Pruebas de componentes, sin acceso a producción:

```
npx vitest run --config vitest.config.ts tests/components/inventoryCostHydration.test.tsx tests/components/g2c3a2InventoryPage.test.tsx tests/components/g2c3a2ProductFormModal.test.tsx tests/components/productVariantsV2.test.tsx --maxWorkers=1 --minWorkers=1
```

Cubren respuestas autorizadas/restringidas para owner, admin, manager, sales y
permisos modificados; costos ARS/USD y cero real; hijos; rangos incompletos;
errores/recuperación; wake-up; cambio de negocio con respuesta pendiente; logout;
preservación al guardar antes de cargar y al editar nombre; cero explícito;
exportación/reimportación sin convertir ausentes en cero. Se incorpora el gate de
regresión a CI.

También se ejecutan TypeScript, ESLint (gate de errores), build, 19 pruebas unitarias
de `productPricing`, guard SEC-08B con self-test y guard de gobernanza UI.
Resultado final: 71 pruebas de componentes y 19 unitarias aprobadas; TypeScript,
ESLint, build y guards aprobados (self-test SEC-08B: 47 mutaciones detectadas).

`vercel.json` excluye únicamente `codex/p0-inventory-cost-hydration` de despliegues
automáticos, usando el mecanismo ya presente en el repositorio. El PR puede
ejecutar CI sin publicar una preview ni desplegar producción.

La matriz existente `tests/sql/sec08b_inventory_cost_visibility.test.sql` se
ejecutó satisfactoriamente en `supabase_db_techrepair-vite`, dentro de una
transacción terminada en `ROLLBACK`. Verificó roles, overrides verdaderos/falsos,
variantes, aislamiento entre negocios, columnas restringidas y preservación de
escritura. Sin migraciones ni relajación de privilegios. No se ejecuta la matriz
de compatibilidad que restaura GRANT o el harness de preservación que deshabilita
triggers: no cumplen las restricciones de este trabajo.

## Riesgos residuales y verificación manual

- Pendiente smoke visual en navegador autenticado, escritorio/móvil y temas.
  Componentes se verifican en jsdom; no se afirma evidencia visual de navegador.
- Una revocación remota se refleja al recibir el perfil actualizado o revalidar
  la lectura (wake-up/refresh). No se agrega un sistema nuevo de permisos en vivo;
  toda nueva consulta sigue pasando por la autorización del servidor.
- Sigue vigente el límite operativo existente de 5000 filas. No se introduce
  paginación en este hotfix.
- Build advierte tamaño de bundles y ausencia de canal de ayuda en configuración
  local. Las suites existentes emiten advertencias React `act`; no son fallos.
- Antes de autorizar despliegue: smoke con usuarios reales autorizados y sales,
  edición de nombre sin tocar costos, variantes y round-trip Excel en ambiente de
  prueba. No se necesita migración.
