# TechRepair Pro — P0-MOBILE · implementación MOBILE-0 + MOBILE-1

Estado: **A — MOBILE-0/1 listo para review**. Este lote resuelve foundations y shell; no incluye merge, deploy ni trabajo de MOBILE-2.

## 1. Baseline

- Worktree aislado: `techrepair-vite-mobile-01`.
- Branch: `feat/p0-mobile-foundations-shell`.
- Base: `origin/main` en `c7b3899e867882f6ae044a74863b330f36f20df1` (merge de PR #73).
- Head de migraciones verificado: `20260828120000_order_amounts_canonical_profile_identity.sql`.
- P0–P6 y su documentación estaban presentes en la base.
- No se modificaron `CuentasCorrientes.tsx`, `ModalPagarCC.tsx`, `cuentasService.ts`, `CajaPage.tsx`, migraciones, RPC, RLS ni contratos financieros.

## 2. Findings atacados

- Shell móvil dependiente del hamburger y sin destinos primarios al alcance del pulgar.
- Touch targets, inputs y espaciado sin contrato móvil común.
- Uso de `100vh`, falta de safe-area y ausencia de foundation reutilizable para teclado.
- Modales sin presentación responsive/focus contract común.
- Banner de actualización con riesgo de competir con CTA inferior.
- Navegación duplicable o divergente si Sidebar y bottom nav resolvían permisos por separado.
- POS necesitaba exclusión explícita del bottom nav para conservar su checkout fullscreen.

## 3. Primitives

- `ResponsiveDialog`/`AppModal`: modos `centered`, `sheet` y `fullscreen`, Escape, backdrop configurable, focus trap, restauración de foco, ARIA y footer keyboard-aware.
- `MobileActionBar`: una acción primaria, secundaria opcional, spacer de contenido, safe-area y offset por teclado/nav.
- `CompactList`: fila compacta semántica con principal, secundario, metadata, estado, importe y acción final.
- `OverflowMenu`: target de 44 px, navegación por foco, Escape/click exterior y separación de acciones destructivas.
- `AppInput`: semánticas `email`, `tel`, `search`, `numeric`, `decimal` y `password`, con `inputMode` apropiado sin usar `type=number` para importes.

## 4. Safe-area

- Tokens CSS reutilizables basados en `env(safe-area-inset-*)`.
- Header, bottom nav, drawer, dialog y action bar consumen safe-area.
- El contenido del shell reserva bottom nav más safe-area para evitar solapamientos.

## 5. Keyboard handling

- `useKeyboardAwareBottomOffset` usa `visualViewport`, calcula el offset inicial y limpia listeners.
- `MobileActionBar` y el footer de `ResponsiveDialog` se elevan con `max(nav, keyboard)`.
- Los inputs móviles tienen mínimo 48 px y `font-size: 16px`, incluso frente a estilos inline heredados, para evitar auto-zoom en iOS.

## 6. UpdateBanner

- En mobile se presenta en el rail superior; dentro del app shell queda debajo del header.
- En desktop conserva la presentación inferior.
- Tiene `role=status`, `aria-live`, cierre accesible, targets táctiles y wrapping.
- Gate geométrico negativo verifica en login 320×568 que nunca intersecte el CTA de inicio de sesión.

## 7. Bottom navigation

- `MobileBottomNav` muestra hasta cinco destinos rotulados, con iconos y active state de `NavLink`.
- Resolución canónica por capacidades, features y overrides; no compara roles directamente.
- Owner/Admin/Sales: Inicio, Órdenes, POS, Clientes, Más.
- Cashier: Inicio, POS, Caja, Clientes, Más.
- Tech: Inicio, Órdenes, Tareas, Más.
- Puede degradar a menos ítems en modo fail-closed cuando faltan capacidades.

## 8. Más

- Reutiliza el Sidebar autorizado existente y excluye los destinos ya presentes en bottom nav.
- Drawer con overlay, `100dvh`, safe-area, Escape, focus trap, foco inicial y restauración al disparador.
- Los controles del drawer oculto salen del orden de tabulación.

## 9. RBAC

- `useNavigationAccess` centraliza un único snapshot de permisos, plan, wholesale y System Owner para Sidebar y bottom nav; no agrega una segunda consulta/suscripción.
- `isNavigationItemAuthorized` conserva los gates P0–P6 y evalúa todos en AND/fail-closed.
- SaaS Admin y privilegios de System Owner nunca entran en destinos primarios.
- Los overrides sólo pueden quitar destinos; no conceden capacidad.
- Tasks no posee hoy una permission key propia: el destino primario usa capacidad `orders` más feature `tasks`, consistente con el contrato actual de ruta. Se registra como riesgo a endurecer en Tasks V2.

## 10. Desktop compatibility

- A partir de 1024 px se mantiene el Sidebar, su colapso, TopHeader y layout actuales.
- Bottom nav y header móvil quedan ocultos.
- Gate E2E confirma Sidebar visible y bottom nav no visible a 1440 px.

## 11. POS compatibility

- El modal POS agrega únicamente una clase de ciclo de vida mientras está abierto.
- Esa clase oculta la navegación móvil y mantiene checkout/CTA fullscreen sin cambiar lógica de venta, pagos ni doble-submit.
- La suite responsive POS pasa en 1440 light/dark y 390 light/dark.

## 12. Accessibility

- Targets interactivos móviles de al menos 44 px; CTA e inputs de 48 px.
- Labels visibles en bottom nav y estados activos con texto/color.
- Focus visible global, reduced motion, ARIA de dialog/menu/status y navegación por teclado.
- Drawer y dialogs atrapan/restauran foco; Escape funciona donde corresponde.
- Los rows interactivos de `CompactList` responden a Enter/Espacio.

## 13. Viewports

- Contrato validado: 320×568, 390×844, 430×932 y desktop 1440 px.
- Breakpoints: mobile compacto `<360`, mobile `<768`, tablet `768–1023`, desktop `≥1024`.
- Padding contractual: 12 px bajo 360; 16 px desde 360 en mobile.
- No hay overflow horizontal global en las tres anchuras móviles.

## 14. Screenshots

Evidencia versionada en `docs/p0-mobile-evidence/implementation-mobile-01/`:

- `320x568-shell.png`
- `320x568-more.png`
- `320x568-login-update-banner.png`
- `390x844-shell.png`
- `390x844-more.png`
- `430x932-shell.png`

Incluye shell, drawer Más y la interacción negativa UpdateBanner/CTA.

## 15. Tests

- `npm run typecheck`: pass.
- `npm run lint:errors`: pass.
- `npm run build`: pass, 3.006 módulos transformados.
- `npm run test:unit`: 1.032/1.032 pass.
- `npm run test:components`: 513/513 pass en 34 archivos.
- `mobileFoundations.test.tsx`: 9/9 pass.
- `mobileNavigation.test.tsx`: 4/4 pass.
- E2E shell: 6/6 pass.
- E2E POS responsive: 4/4 pass.
- Build conserva dos warnings preexistentes: import dinámico/estático de subscription y chunk PDF mayor a 600 kB.

## 16. Negative gates

- Overflow horizontal: helper y comprobación real por viewport.
- Elementos interactivos visibles y targets ≥44 px.
- UpdateBanner no intersecta el CTA; el helper tiene self-test negativo.
- Public/auth routes no muestran bottom nav.
- System Admin no se promociona al nav primario.
- Overrides no agregan rutas sin capacidad.
- POS fullscreen oculta bottom nav.
- Back, refresh y active state se conservan.

## 17. Performance

- Sidebar y bottom nav comparten `NavigationAccess`; no duplican fetch ni subscription.
- El resolver de destinos es puro y pequeño.
- No se agregaron dependencias ni listeners persistentes; `visualViewport`, menú, drawer y dialog limpian listeners.
- No se rediseñaron pantallas pesadas ni se amplió el bundle con librerías nuevas.

## 18. Archivos

Nuevos principales:

- `src/hooks/useNavigationAccess.ts`
- `src/config/mobileNavigation.ts`
- `src/components/layout/MobileBottomNav.tsx`
- `src/ui/components/MobileActionBar.tsx`
- `src/ui/components/CompactList.tsx`
- `src/ui/components/OverflowMenu.tsx`
- `tests/components/mobileFoundations.test.tsx`
- `tests/components/mobileNavigation.test.tsx`
- `tests/e2e/m7/mobile-shell.spec.ts`

Modificados principales:

- `src/index.css`, `src/lib/tokens.ts`
- `src/ui/components/AppModal.tsx`, `AppInput.tsx`, `src/ui/index.ts`
- `src/layouts/MainLayout.tsx`, `src/components/layout/Sidebar.tsx`, `Layout.tsx`
- `src/components/UpdateBanner.tsx`, `ThemeToggle.tsx`
- `src/components/comprobantes/ComprobanteProModal.tsx`
- `tests/components/rbacCapabilities.test.tsx`, `tests/e2e/m7/pos-mobile-layout.spec.ts`

## 19. Riesgos

- Tasks debe adquirir una capacidad/permission explícita en Tasks V2; mientras tanto hereda `orders` + feature.
- Las foundations existen, pero los modales/listas legacy todavía deben migrarse por flujo en lotes posteriores.
- La compatibilidad de teclado se validó mediante `visualViewport` y browser responsive; falta una pasada final en hardware iOS/Android antes de beta pública.
- Pantallas internas no incluidas en MOBILE-0/1 pueden conservar overflow propio aunque el shell no lo tenga.
- Los warnings de chunking preexistentes siguen pendientes y no son blocker de este lote.

## 20. Handoffs

### Orders V2 — Nueva Orden mobile-first

Secuencia prioritaria: Cliente → Equipo → IMEI/Serial + scanner → Estado físico + fotos → Checklist opcional → Acceso al equipo → Problema/observaciones → Asignación → Presupuesto ARS/USD → Resumen → Crear orden.

El acceso debe admitir: sin bloqueo, PIN, patrón, contraseña, cliente no proporciona y equipo no enciende/no verificable. Nunca guardar PIN/patrón/contraseña en plaintext. El diseño futuro requiere cifrado/secret storage server-side, acceso restringido, reveal explícito, auditoría y eliminación al cerrar/entregar según política.

### Tasks V2 — Motor operativo del taller

Vistas: Hoy, Mis tareas, Equipo y Sin asignar. Tareas manuales, sugeridas y automáticas, relacionadas con order, customer, product, supplier, warranty o account. Automatizaciones iniciales: orden sin actividad, presupuesto sin respuesta, equipo listo sin retirar y stock bajo.

Contrato conceptual de idempotencia: `source_type + source_id + rule_key`; una situación produce una sola tarea abierta.

## 21. Propuesta MOBILE-2

Prioridad recomendada: **Orders V2 / Nueva Orden mobile-first**, porque es el flujo de captura más crítico en mostrador y ya tiene un handoff funcional y de seguridad definido. Usar las foundations de este PR para wizard, action bar, inputs semánticos, scanner/fotos y dialog responsive. Mantener Tasks V2 como lote inmediatamente posterior, empezando por modelo RBAC explícito e idempotencia antes de promover nuevas automatizaciones.

No iniciar MOBILE-2 desde este PR.
