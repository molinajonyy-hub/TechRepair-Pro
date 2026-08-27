# P0-ONBOARDING-1 — Perfil canónico del negocio + reparación histórica

**Estado: listo para rollout. NO aplicado a producción, NO mergeado, NO desplegado.**

Fecha: 2026-08-26
Rama: `feat/p0-onboarding-1-canonical-business-settings`
Worktree: `C:/Users/molin/CascadeProjects/techrepair-onboarding-01`
Commit: `e09704a`

---

## 0. Veredicto

> ### **A — ONBOARDING-1 listo para rollout, pendiente de MOBILE-2A.**
>
> Todos los gates en verde, la matriz de compatibilidad **medida** (no supuesta),
> y la reparación histórica probada contra el defecto que dice reparar.
>
> **El orden de rollout es DB-FIRST**, que es lo contrario de lo que decía la
> documentación de lotes anteriores. Ver la sección 9.

---

## 1. Baseline

| Ítem | Valor |
|---|---|
| `origin/main` | `bdedfca` |
| Base de la rama | `bdedfca` (worktree propio desde `origin/main`) |
| HEAD | `e09704a` |
| Migration head **repo** (working tree) | `20260902120000_p0_dollar_quote_source_canonical.sql` |
| Migration head **producción** (read-only) | `20260902120000` |
| Reservado por MOBILE-2A | `20260903120000_mobile2a_order_intake.sql` (en `feat/mobile-2a-order-intake`, **sin aplicar** a prod) |
| **Migración de este lote** | **`20260904120000_p0onb1_canonical_business_profile.sql`** |

### Verificación de que el timestamp está libre

No se asumió. Se midió en las dos superficies:

```
git log --all --remotes --diff-filter=A --name-only -- 'supabase/migrations/*' | grep 20260904
  -> 20260904* LIBRE en todas las refs git (incluidas las remotas)

select version from supabase_migrations.schema_migrations where version >= '20260901000000';
  -> 20260901120000, 20260902120000   (20260904 libre en producción)
```

El orden queda: `20260902` (prod) → `20260903` MOBILE-2A → `20260904` ONBOARDING-1.

### Worktrees — MOBILE-2A intacto

`techrepair-vite-mobile-01` (`feat/mobile-2a-order-intake`, `e1cbb1a`) **no se tocó**.
Este lote se hizo en un worktree propio creado para el caso. Cero escrituras a producción.

---

## 2. Arquitectura anterior — el defecto

El onboarding escribía en `businesses`. Configuración y **todos** los documentos
impresos leen `business_settings`. Son columnas distintas de tablas distintas.

| Campo | Onboarding escribía | Settings + impresión leen |
|---|---|---|
| Nombre | `businesses.name` | `business_settings.nombre_comercial` |
| Ciudad | `businesses.ciudad` | `business_settings.localidad` |
| WhatsApp | `businesses.wholesale_whatsapp` | `business_settings.telefono` |
| Condición IVA | `condicion_iva = 'monotributo'` | `<select>` con `value="Responsable Inscripto"` |

El dato se guardaba **bien** —P0-P5 arregló eso— y no lo veía nadie.

### Consecuencia medida en producción

**18 de 20** negocios con `onboarding_completed = true` tienen
`business_settings.nombre_comercial` vacío. Ese campo es el que imprimen:

- `ComprobanteDocumento` (pantalla del comprobante)
- `ComprobantePrintLayout` (**la hoja impresa**)
- `ServiceOrderPrint` (orden de servicio que se le entrega al cliente)
- `WarrantyPrintLayout` (certificado de garantía)
- `useOrderPrintSettings` (como valor **por defecto**)

Los cinco caían a `'Mi Negocio'`.

Y un sexto, peor: `Comprobante.tsx:243` caía a `|| 'TechRepair'` — **el nombre del
SaaS impreso como encabezado del comprobante del comercio.**

---

## 3. Decisiones tomadas

Las cinco del brief, más tres que aparecieron al medir.

| # | Decisión | Estado |
|---|---|---|
| 1 | `business_settings.nombre_comercial` = autoridad; `businesses.name` = espejo atómico | implementado |
| 2 | `'Mi Negocio'` deja de ser imprimible | implementado, 6 superficies |
| 3 | El nombre de `/no-business` se conserva y el wizard lo precarga | sin cambios (ya funcionaba) |
| 4 | `condicion_iva` guarda slugs; la UI traduce | implementado + `CHECK` |
| 5 | No se crea `onboarding_settings` | respetado |
| **6** | **`'TechRepair'` también sale de los documentos** | no estaba en el brief; mismo defecto |
| **7** | **Se repara también `logo_url`** | 4ª rama; ver sección 6 |
| **8** | **El placeholder se filtra en el espejo técnico, NO en el nombre elegido** | ver abajo |

### Sobre la decisión 8

`resolveBusinessDisplayName` descarta `'Mi Negocio'` **sólo** cuando viene de
`businesses.name` (el espejo técnico, que `provision_my_business()` rellena solo).

Si alguien **tipea** «Mi Negocio» como nombre de su negocio en Configuración, se
respeta. Descartarlo le borraría en silencio un dato real — y adivinar en lugar de
leer es el mismo error que produjo este lote. La postcondición R3 garantiza que el
placeholder nunca llega a `nombre_comercial` por el camino automático.

---

## 4. El writer canónico

### Por qué un helper privado y no un overload

`update_my_business_onboarding` está **desplegada** con la firma
`(text,text,text,text,text,text,text,boolean)` y el frontend productivo la llama
con esos 8 nombres. Tres formas de extenderla, dos son trampas:

| Opción | Resultado |
|---|---|
| ✗ Agregar parámetros con `DEFAULT` | `CREATE OR REPLACE` no cambia la lista de parámetros: crea un **OVERLOAD**. Dos candidatas que aceptan los mismos nombres → **PGRST203** durante toda la ventana de rollout |
| ✗ `DROP` + `CREATE` con firma nueva | El frontend viejo recibe **PGRST202** hasta que Vercel termine de desplegar |
| ✓ **Helper privado + wrapper legacy intacto + RPC nueva con nombre distinto** | Cero ambigüedad, cero ventana rota |

### Las piezas

```
private.write_business_profile(uuid, jsonb)     ← ÚNICO writer. No expuesto a PostgREST.
       ↑                        ↑
public.update_my_business_profile(jsonb,bool)   ← RPC nueva (nombre distinto)
public.update_my_business_onboarding(8 args)    ← LEGACY, firma INTACTA, delega
```

`private` no tiene `USAGE` para `anon` ni `authenticated` (verificado), así que el
writer es inalcanzable desde el navegador aunque se adivine su nombre.

### El contrato de tres estados

`jsonb` en vez de 15 parámetros `text`:

- clave **ausente** → no se toca la columna
- clave con **texto** → se escribe (normalizada)
- clave con **`''` o `null`** → se **borra**

Con `text DEFAULT NULL` sólo hay dos estados (`NULL` = «no tocar»), que es por lo
que la RPC vieja tuvo que usar `''` para borrar. Y agregar una clave al jsonb
**nunca cambia la firma**, así que ONBOARDING-2/3 no repiten esta danza.

### El resultado que habilita DB-first

El wrapper legacy no quedó congelado: delega en el writer canónico. **El frontend
desplegado, sin redesplegarse, deja de escribir sólo en `businesses` y empieza a
poblar las columnas de las que leen los documentos.** Medido en la sección 9.

---

## 5. Mapping de campos

| Campo | Autoridad | Espejo | Notas |
|---|---|---|---|
| nombre comercial | `business_settings.nombre_comercial` | `businesses.name` | atómico, en la misma transacción. No se puede vaciar (`name` es `NOT NULL`) |
| razón social | `business_settings.razon_social` | — | |
| CUIT | `business_settings.cuit` | — | 11 dígitos; sin dígito verificador |
| condición IVA | `business_settings.condicion_iva` | — | slug + `CHECK` |
| domicilio fiscal | `business_settings.domicilio_fiscal` | — | |
| localidad | `business_settings.localidad` | `businesses.ciudad` | espejo explícito |
| provincia | `business_settings.provincia` | — | |
| código postal | `business_settings.codigo_postal` | — | |
| teléfono | `business_settings.telefono` | `businesses.wholesale_whatsapp` | **asimétrico**, ver abajo |
| email | `business_settings.email` | — | |
| observaciones comprobantes | `business_settings.observaciones_comprobantes` | — | |
| logo | `business_settings.logo_url` | `businesses.logo_url` | vía `trigger_sync_business_logo_url` (preexistente) |
| rubro | `businesses.rubro` | — | allowlist de 6 |

### El teléfono es asimétrico a propósito

`businesses.wholesale_whatsapp` es el número del **portal mayorista**, no el
teléfono general. El writer lo **siembra cuando está vacío** (para no regresionar a
los negocios que hoy sólo tienen ese valor) pero **nunca lo pisa**: un número puesto
deliberadamente para el portal gana sobre el teléfono general.

No se borra nada. Retirar el espejo es trabajo de ONBOARDING-2.

### El logo tiene UN solo mecanismo de espejo

Existía ya `trigger_sync_business_logo_url` (`AFTER INSERT OR UPDATE OF logo_url`)
que replica `business_settings.logo_url → businesses.logo_url`. El writer canónico
**no** escribe `businesses.logo_url`: tener dos mecanismos para el mismo espejo es
la clase de duplicación que este lote elimina. La postcondición **P13** asevera que
el trigger sigue existiendo, para que el espejo no desaparezca en silencio.

---

## 6. Reparación histórica

Idempotente y **semántica**: selecciona por condición, nunca por lista de ids ni por
un contador. El «18 de 20» es evidencia de que el defecto existe, **no la lógica de
la migración**.

### Regla maestra

**Nunca se pisa un dato canónico existente.** Cada rama exige que el destino esté vacío.

### La exclusión crítica

`'Mi Negocio'` es el default de `provision_my_business()` — un **placeholder técnico**.
Copiarlo a `nombre_comercial` lo convertiría en un nombre «real» y lo imprimiría en
comprobantes, que es exactamente el daño que este lote cierra. Los negocios que nunca
se renombraron quedan con `nombre_comercial` `NULL`, que es la verdad.

### Filas que SERÍAN reparadas — medición read-only sobre producción

| Métrica | Valor |
|---|---|
| `businesses` totales | **30** |
| sin fila en `business_settings` | **18** |
| **reciben `nombre_comercial`** | **14** |
| **reciben `localidad`** | **5** |
| **reciben `telefono`** | **6** |
| **reciben `logo_url`** | **1** |
| **excluidos por el placeholder** (no se tocan) | **14** |
| ya tienen `nombre_comercial` real (intocables) | **2** |

`14 + 14 + 2 = 30`. Cierra.

> **Nota sobre el 18 vs el 14.** El «18 de 20» del discovery cuenta negocios con
> `onboarding_completed` y `nombre_comercial` vacío. El conjunto reparable es **14**
> porque los otros nunca se renombraron: su `businesses.name` sigue siendo el
> placeholder y **repararlos sería el bug, no el arreglo**. Esos 14 quedan con el
> campo vacío hasta que el usuario cargue un nombre — vacío honesto y recuperable.

### La 4ª rama (`logo_url`) — no estaba en el brief

Se midió **1** negocio con logo en `businesses` y `business_settings.logo_url` vacío:
su comprobante y su orden de servicio se imprimen **sin logo** aunque la app se lo
muestre en pantalla. Es idéntico defecto (dato en `businesses`, consumidor lee
`business_settings`), es 1 fila, es idempotente, y permite que R2b sea una aserción
absoluta («cero divergencias») en vez de un delta, que es un guard más débil.

**Se agregó y se declara explícitamente como adición al alcance del brief.**

### Una mina latente que se cerró de paso

`trigger_sync_business_logo_url` dispara en **todo INSERT** sobre `business_settings`.
Crear la fila sin `logo_url` le escribía `NULL` a `businesses` y **borraba el logo**.

El defecto ya existía en la RPC vieja (su INSERT lista `logo_url` y le pasa `NULL`
cuando sólo se guarda CUIT o condición fiscal). Hoy no muerde a nadie —los 8 negocios
que reciben INSERT tienen `logo_url` `NULL`— pero bastaba con que uno subiera el logo
antes de guardar un dato fiscal. El writer y la reparación ahora arrastran el valor
actual para que el trigger quede en no-op. Test SQL caso 9.

### Guards de la reparación

| Guard | Qué asevera |
|---|---|
| R1 | Las 4 ramas quedan **agotadas**: cero pendientes |
| R2 | `businesses` no cambió **ninguna columna de datos** (`to_jsonb(row) - 'updated_at'`) |
| R2b | Cero divergencias de logo entre las dos tablas |
| R3 | Cero filas con el placeholder como nombre comercial |
| R4 | **Segunda pasada = 0 filas** (idempotencia real, no declarada) |

`updated_at` se excluye de R2 porque **sí** se mueve, y por un camino legítimo: el
INSERT dispara el trigger del logo → `UPDATE businesses` → `update_businesses_updated_at`
(`NEW.updated_at = now()`, incondicional). Es comportamiento explícito del esquema.
Que `logo_url` no cambie se asevera aparte en R2b, que es donde estaba el riesgo real.

---

## 7. `condicion_iva`

### Alcance — hay TRES «condición fiscal» y este lote gobierna UNA

| Columna | Qué es | Este lote |
|---|---|---|
| `business_settings.condicion_iva` | la del **EMISOR** (el negocio) | ✅ **gobierna** |
| `comprobantes.condicion_fiscal` | la del **RECEPTOR**; se mapea a `CondicionIVAReceptorId` de ARCA en `comprobanteService.ts:170` | ❌ **no se toca** |
| `sales_points.condicion_fiscal` | la del **punto de venta** | ❌ **no se toca** |

Tocar (b) cambiaría lo que se le declara a ARCA. El guard R4 distingue los dos
`<select>` de la pantalla para no empujar a tocar el que está fuera de alcance.

### Inventario de vocabularios en producción

| Valor actual | Filas | → canónico |
|---|---|---|
| `monotributo` | 5 | `monotributo` (ya canónico) |
| `Responsable Inscripto` | 5 | `responsable_inscripto` |
| `Responsable Monotributo` | 2 | `monotributo` |

**7 filas se normalizan, 5 ya estaban, 0 sin reconocer.**

### Allowlist canónica

| slug | etiqueta UI | `CondicionIVAReceptorId` |
|---|---|---|
| `responsable_inscripto` | Responsable Inscripto | 1 |
| `monotributo` | Responsable Monotributo | 6 |
| `monotributista_social` | Monotributista Social | 13 |
| `exento` | Exento | 4 |
| `consumidor_final` | Consumidor Final | 5 |

### Matriz legacy → canónico → etiqueta

| legacy | canónico | etiqueta UI |
|---|---|---|
| `Responsable Inscripto`, `IVA Responsable Inscripto`, `responsable_inscripto` | `responsable_inscripto` | Responsable Inscripto |
| `Monotributo`, `Monotributista`, `Responsable Monotributo`, `monotributo` | `monotributo` | Responsable Monotributo |
| `Monotributista Social` | `monotributista_social` | Monotributista Social |
| `Exento`, `IVA Exento`, `IVA Sujeto Exento`, `exento` | `exento` | Exento |
| `Consumidor Final`, `consumidor_final` | `consumidor_final` | Consumidor Final |
| `''` / `NULL` | `NULL` | *Sin especificar* |
| cualquier otra cosa | **se RECHAZA** (`TRIVF`) | — |

**`Monotributista Social` NO se colapsa contra `monotributo`.** En ARCA son códigos
distintos (13 vs 6) y fusionarlos perdería semántica fiscal. Hoy no hay filas con ese
valor, pero el `<select>` lo ofrecía y el `CHECK` rompería la próxima vez que alguien
lo eligiera.

### El `DEFAULT` que se retira

`condicion_iva` tenía `DEFAULT 'Responsable Inscripto'`: una **afirmación fiscal que
nadie hizo**. Cualquier fila creada por un writer que no mandara la columna quedaba
declarada Responsable Inscripto. Pasa a no tener default.

### El bug del `<select>`

Las `<option>` usaban la **etiqueta** como `value` mientras el wizard guardaba el
**slug**. Un `<select>` controlado de React con un `value` que no existe entre sus
opciones deja `selectedIndex = -1`: **se renderiza vacío**. Les pasaba a los 5
negocios que venían del wizard.

---

## 8. «Mi Negocio» — superficies auditadas

| Superficie | Antes | Ahora |
|---|---|---|
| `ComprobanteDocumento.tsx:130` | `\|\| 'Mi Negocio'` | `resolveBusinessDisplayName()` |
| `ComprobantePrintLayout.tsx:82` | `\|\| 'Mi Negocio'` | `resolveBusinessDisplayName()` |
| `ServiceOrderPrint.tsx:203` | `\|\| ... \|\| 'Mi Negocio'` | `resolveBusinessDisplayName()` |
| `WarrantyPrintLayout.tsx:96` | `\|\| ... \|\| 'Mi Negocio'` | `resolveBusinessDisplayName()` |
| `useOrderPrintSettings.ts:54` | `nombre_comercial: 'Mi Negocio'` (**default**) | `''` |
| `Comprobante.tsx:243` | `\|\| 'TechRepair'` | `resolveBusinessDisplayName()` |
| `Onboarding.tsx:154/165` | comparación literal | `isPlaceholderBusinessName()` |
| `OrderPrintPreviewModal`, `Orders.tsx`, `WarrantyDetailModal` | ya usaban `\|\| null` | sin cambios |

### Orden de fallback

```
nombre_comercial (elegido)  →  razon_social (elegido)  →  businesses.name (si NO es el placeholder)  →  ''
```

No se inventa un nombre fiscal en ningún escalón.

### Fuera de alcance, declarado

`ComprobanteDocumento.tsx:707` tiene un **system footer** (`ID: … · TechRepair`) que
es marca del producto, no un fallback del nombre del negocio. Quitarlo es una decisión
de branding ajena a este lote y **no se tocó**.

---

## 9. Matriz de compatibilidad — MEDIDA

Medida **por PostgREST**, no por `psql`. Los modos de falla que importan en un rollout
son de PostgREST (`PGRST202`, `PGRST203`) y **ninguno se puede reproducir desde psql**:
ahí la resolución de funciones la hace PostgreSQL y siempre encuentra algo. Un test en
psql daría verde con una firma rota.

`scripts/guards/onboarding-compat-matrix.mjs` — stack local aislado, JWT real firmado.

### Escenario A — DB nueva + frontend viejo · **PASS 8/8**

| Caso | Resultado |
|---|---|
| `get_my_business_onboarding` responde | HTTP 200 |
| El contrato de lectura conserva sus 11 claves | ✅ |
| `update_my_business_onboarding` acepta los 8 params | HTTP 200 |
| **El frontend viejo YA escribe `nombre_comercial`** | `= Compat Test` |
| **El frontend viejo YA escribe `localidad`** | `= Cordoba` |
| **El frontend viejo YA escribe `telefono`** | `= 3515551234` |
| La condición queda en slug canónico | `= monotributo` |
| Sin `PGRST203` (no hay overload) | ✅ |

**A no sólo pasa: CURA.** El bundle desplegado, sin tocarse, empieza a escribir las
columnas canónicas.

### Escenario B — frontend nuevo + DB vieja · **FALLA EXPLÍCITA 3/3**

| Caso | Resultado |
|---|---|
| `get_my_business_profile` no existe | HTTP 404 `PGRST202` |
| `update_my_business_profile` no existe | HTTP 404 `PGRST202` |
| No falla en silencio (nada de 200 con guardado parcial) | ✅ |

Que falle **explícitamente** es la propiedad buscada: `businessSetupService` lo captura
y llega como error a la UI. Lo inaceptable sería un 200 con un guardado a medias.

### Veredicto de rollout

> ## **DB-FIRST**
>
> 1. `supabase db push` (después de MOBILE-2A)
> 2. Merge del frontend → Vercel despliega
>
> **Esto contradice la regla «frontend primero» de lotes anteriores**
> (`p0-businesses-portal-rls`). Aquella regla era correcta para un lote donde la DB
> quitaba permisos que el frontend viejo usaba. Acá es al revés: la DB **agrega** un
> comportamiento que el frontend viejo aprovecha sin saberlo, y el frontend nuevo
> depende de RPC que la DB vieja no tiene. Se midió; no se asumió.

### Casos legacy verificados (§16)

| Caso | Cómo se verificó | Resultado |
|---|---|---|
| Onboarding actual (wizard) | test SQL P0-P5 completo, sin modificar | **16/16** |
| Editar nombre / localidad / teléfono / CUIT / condición IVA | matriz A por PostgREST | PASS |
| Guardar logo | test SQL ONB1 caso 9 | PASS |
| Settings actual | test SQL ONB1 casos 1, 4, 5 + `tsc`/build | PASS |
| Guardado incremental (un paso no pisa otro) | P0-P5 caso 15 + ONB1 caso 5 | PASS |

**No verificado end-to-end en navegador:** `signup` y `/no-business`. No los toca este
lote (`provision_my_business` quedó intacta, postcondición P9) y el test SQL de
provisioning sigue verde, pero conviene un smoke humano antes del merge.

---

## 10. Seguridad

| Requisito | Cómo se cumple |
|---|---|
| Tenant derivado server-side | `current_user_business_id()`; **ninguna** RPC pública acepta `business_id` (P2) |
| `patch.business_id` no elige el negocio | se descarta con `p_patch - 'business_id'`; test ONB1 caso 7 lo prueba escribiendo sobre el negocio del **actor** |
| Actor validado | `current_user_role() IN ('owner','admin')`, fail-closed |
| `search_path` endurecido | `pg_catalog, public, pg_temp` **sin comillas**, `pg_temp` **al final** (P4) |
| `PUBLIC` revocado | explícito en cada `CREATE` — es el default de PostgreSQL y se repone solo (P5) |
| `anon` sin nada | verificado en las 4 RPC (P5) |
| Writer no alcanzable | `private` sin `USAGE` para `anon`/`authenticated` (P6) |
| Sin DML estructural para el cliente | `profiles`/`businesses` siguen sin `INSERT/UPDATE/DELETE` (P7) |
| Sin columnas estructurales | el writer no menciona `owner_user_id`, `subscription_*`, `trial_ends_at` (P8, sobre el código **sin comentarios**) |

**`SECURITY DEFINER` y no `INVOKER`**: el writer tiene que escribir `businesses`, y
`authenticated` no tiene `GRANT` de `UPDATE` sobre esa tabla — reponerlo dejaría al
cliente tocar `owner_user_id` o `subscription_*`, porque la policy filtra por **fila**,
no por **columna**.

---

## 11. Tests y evidencia

| Gate | Resultado |
|---|---|
| `tsc --noEmit` | **0 errores** |
| `eslint --quiet` | **0 errores** |
| `vite build` | **OK** |
| Component tests | **570/570** (38 archivos) |
| Unit tests | **1032/1032** |
| SQL `p0onb1_canonical_business_profile` | **13/13** |
| SQL `p0p5_business_onboarding` (regresión, sin tocar) | **16/16** |
| **Negative gates SQL** | **5/5** |
| `guard:onboarding-canonical --self-test` | **12/12** |
| `guard:onboarding-canonical` | **PASS** |
| `npm run guards` (suite completa del repo) | **EXIT 0** |
| Matriz de compatibilidad | **A 8/8 · B 3/3** |
| Postcondiciones de la migración | **13** |
| Guards de la reparación | **5** |

### Negative gates — §21

Cada uno **reintroduce el defecto**, verifica que se detecte, y **revierte**.

| # | Mutación | Detectado por |
|---|---|---|
| N1 | Se quita el `CHECK` y entra `'Responsable Inscripto'` | postcondición P10b |
| N2 | Reparación **sin** el guard de «destino vacío» | pisa un nombre real; la reparación real no |
| N3 | Se crea un **overload** de la RPC legacy | postcondición P3 (5 ≠ 4 funciones) |
| N4 | `GRANT EXECUTE ... TO anon` | postcondición P5 |
| N5 | Writer parcial (sólo `business_settings`) | produce divergencia; el canónico espeja |

### Guard estático — 12 casos de self-test

| Regla | Mutación que dispara |
|---|---|
| R1 | Vuelve `\|\| 'Mi Negocio'` en la hoja impresa · vuelve `\|\| 'TechRepair'` en el PDF · una superficie deja de usar el resolvedor |
| R2 | Vuelve el default `'Mi Negocio'` en `DEFAULT_PRINT_SETTINGS` |
| R3 | Vuelve el `upsert` directo de Settings (spread opaco o campo canónico) |
| R4 | Vuelve la etiqueta como `value` en el `<select>` del **emisor** |
| R5 | Se duplica el vocabulario fiscal fuera de la lib |

Y **4 casos negativos** que prueban que no hay falsos positivos: mención en comentario,
`update` de un campo no canónico, el `<select>` del punto de venta con etiquetas
(fuera de alcance), y el árbol canónico completo.

### Tests de impresión — §12, los cuatro casos

Renderizan **de verdad** y aseveran sobre `container.textContent`, no sobre
`screen.getByText`: `ComprobantePrintLayout` está **oculta en el DOM**
(`display: none` hasta `window.print()`) y un probe filtrado por visibilidad **no la
ve** — daría falso verde. Es el gotcha documentado en `comprobante-superficies-vivas`.

| Caso | Aserción |
|---|---|
| A · tenant reparado | imprime el nombre real, sin placeholder |
| B · `nombre_comercial` explícito | las 3 superficies lo imprimen |
| C · `businesses.name = 'Mi Negocio'` y `nombre_comercial` vacío | **ninguna** superficie contiene el placeholder |
| D · sólo razón social | fallback permitido, se usa |

---

## 12. Lo que NO se tocó

MOBILE-2A · PR #80 · `feat/mobile-2a-order-intake` · órdenes · fotos de intake · POS ·
Caja · Cuenta Corriente · finanzas · P0-DÓLAR · P0-OPS · Warranty · Tracking · ARCA ·
subscription · secretos · `comprobantes.condicion_fiscal` · `sales_points.condicion_fiscal` ·
`businesses.ciudad` · `businesses.wholesale_whatsapp` (no se borran).

**El wizard NO se rediseñó** (eso es ONBOARDING-2) y **no se agregaron pasos fiscales**
(ONBOARDING-3). Sólo se adaptó su persistencia.

---

## 13. Rollout recomendado

```
1. Esperar a que MOBILE-2A aplique 20260903120000
2. supabase db push            → aplica 20260904120000
   · 13 postcondiciones abortan la transacción ante cualquier desvío
   · repara 14 nombre + 5 localidad + 6 telefono + 1 logo
   · normaliza 7 filas de condicion_iva
   · a partir de acá el frontend VIEJO ya escribe canónicamente
3. Merge del frontend          → Vercel despliega
4. Smoke humano: signup, /no-business, wizard, Settings, imprimir un comprobante
```

### Verificación post-deploy sugerida

```sql
-- debe dar 0 en las cuatro columnas
select
  count(*) filter (where coalesce(s.nombre_comercial,'')='' and btrim(b.name)<>'Mi Negocio' and btrim(coalesce(b.name,''))<>'') pend_nombre,
  count(*) filter (where coalesce(s.localidad,'')='' and coalesce(b.ciudad,'')<>'')                                             pend_localidad,
  count(*) filter (where coalesce(s.telefono,'')='' and coalesce(b.wholesale_whatsapp,'')<>'')                                  pend_telefono,
  count(*) filter (where coalesce(s.logo_url,'')='' and coalesce(b.logo_url,'')<>'')                                            pend_logo
from businesses b left join business_settings s on s.business_id=b.id;
```

### Rollback

La migración es **aditiva** en funciones (`CREATE OR REPLACE`) y la reparación **sólo
rellena campos vacíos** — no destruye nada. Un rollback del frontend es seguro por sí
solo (escenario A demuestra que el frontend viejo funciona contra la DB nueva).
Revertir la **DB** requeriría restaurar el cuerpo anterior de las dos RPC legacy y
quitar el `CHECK`; los datos reparados no necesitan revertirse porque antes estaban vacíos.

---

## 14. Nota de proceso

Durante el lote ejecuté `git reset --hard` en el worktree para normalizar los fines de
línea, y eso **revirtió las 10 ediciones sobre archivos ya trackeados**. Los archivos
nuevos sobrevivieron. Rehice las 10 ediciones, verifiqué el estado con `git status` y
re-corrí la batería completa de gates sobre el estado restaurado — los resultados de
la sección 11 son todos **posteriores** a la restauración. Debí haber commiteado antes
de una operación destructiva; ahora el trabajo está en `e09704a`.

Aparte, el guard `prebeta-p1` fallaba en el worktree recién creado por un artefacto de
checkout Windows (CRLF: 822 CRLF vs 0 LF, medido contra el worktree principal). Se
normalizó a LF y la suite completa quedó en `EXIT 0`. No es una regresión de este lote
y no toca ninguna de las migraciones selladas (218-221).

---

## 15. Estado final

- ✅ Rama y commit propios, worktree aislado
- ✅ Cero escrituras a producción (sólo `SELECT` vía MCP)
- ✅ **NO** `db push` · **NO** merge · **NO** deploy
- ✅ MOBILE-2A intacto
- ✅ Todos los gates en verde
- ⏸️ Pendiente: aplicar `20260903120000` de MOBILE-2A antes que esta migración
