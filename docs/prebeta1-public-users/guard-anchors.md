# Guard global · qué cuenta como "tenant/self-scoped"

Hardening pedido en la revisión de #152. La primera versión del guard aceptaba como ancla cualquier
combinación "columna clave + función de identidad" (`auth.uid`, `auth.jwt` o **cualquier** función de
`public.*`/`private.*`). Con eso, `id IS NOT NULL AND current_user_role() = 'owner'` o
`business_id IS NOT NULL AND auth.uid() IS NOT NULL` pasaban sin hallazgo
(`evidence/guard_hardening_negative_control.log`).

Ahora una policy sólo pasa si su expresión **relaciona** una columna de la fila con una autoridad del
usuario, a través de un helper de una allowlist **explícita** y revisada. Todo lo demás queda como
`NO_DEMOSTRABLE` y falla: preferimos un falso positivo que se pueda revisar a un falso negativo
cross-tenant.

Código: `scripts/guards/tenant-isolation.mjs` (`HELPERS`, `POLICY_ALLOWLIST`, `DEUDA_PREEXISTENTE`,
`anchoredExpr`) · snapshot: `scripts/guards/tenant-isolation-catalog.sql`.

## 1. Helpers aceptados como ancla (revisados, con huella)

Revisé cada definición sobre el catálogo de producción (idéntico al replay). La huella es el md5 del cuerpo
(sin `\r`) + `SECURITY DEFINER` + `proconfig`. Si un helper cambia, el guard falla hasta que alguien lo
vuelva a revisar y actualice la huella. La lista del snapshot SQL tiene que ser **exactamente** la del
guard; si no, el guard falla.

| Helper | Tipo | Qué representa | Huella |
|---|---|---|---|
| `auth.uid()` | self | `sub` del JWT (Supabase Auth; no se fija) | — |
| `public.current_business_id()` | tenant actual | `business_id` del perfil del usuario (`profiles` con `COALESCE(user_id, id) = auth.uid()`, `LIMIT 1`) | `957edd22…` |
| `public.current_user_business_id()` | tenant actual | `business_id` del perfil **activo** más reciente del usuario | `2be08115…` |
| `public.user_business_ids()` | membership | `SETOF business_id` de los perfiles activos del usuario | `bdde4383…` |
| `public.current_user_can_in_business(uuid,text)` | capability tenant-scoped | true sólo si el usuario es owner del negocio **del argumento** o tiene un perfil activo **en ese negocio** con la capability | `3d920821…` |
| `public.can_view_inventory_cost(uuid)` | capability tenant-scoped | `current_user_can_in_business(arg, 'inventory_view_costs')` | `0fa04ed6…` |
| `public.can_view_supplier_finance(uuid)` | capability tenant-scoped | `current_user_can_in_business(arg, finance \| inventory + inventory_view_costs)` | `21623acc…` |
| `public.can_view_payment_allocations(uuid)` | capability tenant-scoped | `user_can_view_order_amounts(arg, auth.uid())` | `a20216ae…` |
| `public.user_can_view_order_amounts(uuid,uuid)` | dependencia revisada | owner del negocio o perfil activo con rol financiero **en** ese negocio | `927ee9e9…` |

El nombre en el texto no alcanza: vía `pg_depend`, el guard exige que toda función con nombre de helper
que use la policy sea la de `public`; un homónimo en otro schema no ancla.

**Rechazados a propósito** (no relacionan la fila con el usuario, así que nunca anclan):
`current_user_role()`, `current_user_can(text)`, `can_manage()`, `is_owner_or_admin()`, `is_staff()`,
`business_has_feature(text)`, `comprobante_is_order_linked(uuid)`, `auth.role()`, `auth.jwt()` y cualquier
función que no esté en la tabla de arriba. Pueden aparecer en una policy como restricción **adicional**
(`AND`), pero no la vuelven tenant-scoped.

## 2. Formas reconocidas

Se analiza el texto que imprime PostgreSQL (`pg_get_expr`), normalizado:

- **`OR` de nivel superior:** **todas** las ramas tienen que estar ancladas.
- **`AND`:** alcanza con **una** rama anclada (las demás sólo restringen). Mezclar `AND` y `OR` sin
  paréntesis no se demuestra.
- **Átomos que anclan** (y sólo estos):

| Forma | Ejemplo |
|---|---|
| self | `user_id = auth.uid()` (también `owner_user_id`, `auth_user_id`, `created_by`; en `profiles`, `id` y `COALESCE(user_id, id)`) |
| tenant actual | `business_id = current_business_id()` (en `businesses`: `id = …`) |
| membership | `business_id IN (SELECT user_business_ids())` |
| capability | `current_user_can_in_business(business_id, 'orders')` — el argumento tiene que ser **la columna de la fila** |
| subconsulta | `business_id IN / = (SELECT r.business_id FROM t r WHERE <r anclada>)` · `<fk> IN (SELECT r.id FROM <tabla destino de la fk> r WHERE <r anclada>)` |
| `EXISTS` | `EXISTS (SELECT … FROM t r WHERE <r anclada> AND <r correlacionada con la fila>)`; correlación válida: `r.business_id = business_id`, `businesses.id = business_id`, o `r.id = <fk de la fila hacia t>`. Una sola tabla, sin `JOIN`. |

Dentro de una subconsulta, `created_by = auth.uid()` **no** alcanza: haber creado una fila no prueba que el
usuario pertenezca al negocio.

**Escrituras en tablas con `business_id`.** Un `WITH CHECK` de INSERT/UPDATE (o el `USING` cuando hace de
check) tiene que atar el `business_id` **de la fila escrita**. Sólo sirven tenant actual, membership,
capability sobre `business_id`, subconsulta sobre `business_id` o `EXISTS` correlacionado por `business_id`.
No alcanza con un ancla sólo-self (`user_id`/`created_by = auth.uid()`) ni con un padre por FK: con cualquiera
de las dos, un usuario podría escribir filas propias dentro de otro negocio. En lecturas y `USING` de
DELETE/UPDATE, esas formas siguen valiendo (son filas propias).

Con el catálogo actual se demuestran **346** expresiones (rol × comando).

## 3. Excepciones (todas fail-closed)

| Lista | Entrada | Autoridad / razón | Huella de la policy |
|---|---|---|---|
| `POLICY_ALLOWLIST` | `wholesale_order_items.woi_customer_select` | self del cliente mayorista: la fila pertenece a un pedido (`order_id → wholesale_orders`) cuyo cliente (`o.customer_id → wholesale_customers`) tiene `auth_user_id = auth.uid()`. El reconocedor no acepta el `JOIN` de la subconsulta. | `da826035f86a430a1c7d41e70be9b281` |
| `POLICY_ALLOWLIST` | `wholesale_customers.wc_own_insert` | alta del cliente en el portal de un negocio: `auth_user_id = auth.uid()` y estado administrativo forzado a neutro (las columnas administrativas además no tienen INSERT de API, G2-C.1); la aprobación la decide el negocio vía `update_wholesale_customer_status_atomic`. El `business_id` es el portal elegido: no puede atarse a una pertenencia porque el cliente todavía no pertenece. | `1e635fb144ebfcf07690c0f1759a46ba` |
| `POLICY_ALLOWLIST` | `wholesale_customers.wc_own_update` | self del cliente + privilegio de columna: anon/authenticated **no** pueden `UPDATE(business_id)` (G2-C.1: sólo `last_login`). Es una autoridad **verificada** en cada corrida (`requires`); un `GRANT UPDATE(business_id)` invalida la excepción. | `5ce66cf36dcefd1d70dd389efef38fc8` |
| `DEUDA_PREEXISTENTE` (**no** legítima) | `customer_events.ce_insert` `CHECK_TRUE` `authenticated:I` | INSERT cross-tenant preexistente; P1 aparte | `e44e33e9c1d2965c8a0f815a569dc9c9` |
| `DEUDA_PREEXISTENTE` (**no** legítima) | `personal_accounts`, `personal_categories`, `personal_credit_cards`, `personal_transactions` · `*_own` `NO_DEMOSTRABLE` `authenticated:I/U` | Mi Guita: el CHECK es sólo-self y `authenticated` puede escribir `business_id` (FK a `businesses`, nullable), así que un usuario puede etiquetar sus filas personales con el `business_id` de otro negocio. Hoy nadie las lee por `business_id` (base: 0 vistas/funciones; `src`: 0): no hay fuga, pero la columna no está atada a la pertenencia. P1 aparte. | `32a2cf69e3a79cfe1d650c419b65ada9` |
| `GLOBAL_ALLOWLIST` | (vacía) | — | — |

La huella de una policy es el md5 de comando + roles + permissive + USING + WITH CHECK normalizados. Si la
policy desaparece o cambia, la entrada queda vieja y el guard falla. `public.users` no puede entrar en
ninguna lista, y el pin de PRE-BETA-1 no admite excepciones.

## 4. Self-tests

**Catálogo: 53 casos.** Las mutaciones corren reales dentro de `BEGIN/ROLLBACK`; algunos casos son puros
sobre el snapshot.

- **Pin PRE-BETA-1:** reabrir por policy, por GRANT, para `service_role` y con una policy "anclada"; `users`
  en la allowlist de tablas y en la de policies.
- **Reglas básicas:** `USING (true)`, `WITH CHECK (true)`, RLS off, SELECT/UPDATE/DELETE sólo por rol,
  tabla global insegura nueva (con y sin RLS).
- **Coexistencia sin relación:**
  - **Caso A** `id IS NOT NULL AND current_user_role() = 'owner'`, en una tabla global y en una tabla de tenant.
  - **Caso B** `business_id IS NOT NULL AND auth.uid() IS NOT NULL`, en SELECT y en UPDATE.
  - `OR` con una rama sin ancla, tautología `business_id = business_id`.
  - Función arbitraria de `public` que "devuelve un tenant", función arbitraria de `private` con la columna
    como argumento.
  - Helper de la allowlist aplicado a algo que no es la columna.
  - `EXISTS` sin correlación, `EXISTS` correlacionado sin ancla, `IN` sin `WHERE`, `NOT (…)`.
  - `created_by` como prueba de pertenencia, `business_id = auth.uid()`.
  - Helper homónimo en otro schema; un literal en la lista del SELECT de un `EXISTS` que imita una
    subconsulta anclada.
- **Escrituras que no atan `business_id`:** INSERT con CHECK sólo-self, UPDATE que puede mudar la fila de
  negocio, INSERT anclado sólo por el padre vía FK (el mismo `EXISTS` en SELECT sí ancla).
- **Huellas:**
  - Helper que cambia de cuerpo; el catálogo deja de informar un helper.
  - Policy de la allowlist que pierde su filtro o desaparece; sin la allowlist, `woi_customer_select` es
    violación; allowlist sin autoridad.
  - Deuda arreglada o cambiada (incluida una deuda por acceso de `personal_*`).
  - La autoridad declarada de una excepción deja de cumplirse (`GRANT UPDATE(business_id)` en
    `wholesale_customers`).
- **Controles sin falso positivo:**
  - Tabla por usuario, policy sólo `service_role`.
  - Tenant/capability/membership/`AND` extra.
  - Hija por FK anclada vía `EXISTS`; membership por `EXISTS` en `profiles` + `OR` de dos ramas ancladas.
  - Tabla global legítima en la allowlist (y un acceso fuera de lo declarado sí se detecta).

**Estático: 10 casos.**

**Control negativo:** el guard anterior no detectaba A, B, `OR` con rama sin ancla ni la función arbitraria
(`evidence/guard_hardening_negative_control.log`); el endurecido detecta los cuatro.

## 5. Límite declarado

El reconocedor demuestra la **forma** de la relación, no la corrección de cada helper: por eso los helpers
están fijados por huella y revisados a mano. Una policy legítima con una forma nueva va a fallar como
`NO_DEMOSTRABLE`. Para resolverlo hay dos caminos: ampliar el reconocedor con la forma nueva, junto con su
self-test, o agregar una entrada a `POLICY_ALLOWLIST` con autoridad y huella.
