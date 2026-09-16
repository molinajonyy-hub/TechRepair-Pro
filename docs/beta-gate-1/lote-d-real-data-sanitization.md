# BETA-GATE-1 · Lote D — Sanitización de datos reales

**Base:** `origin/main` `c90a4edf875ac3877f33e297543ff49246a869c0` (Lotes A y B en producción).
**Alcance:** sacar de `HEAD` identificadores reales del titular/tenant productivo que habían quedado en
documentación y material de desarrollo, y un guard para que no vuelvan. **Sin reescribir historia, sin
tocar tags, sin cambios productivos.** Este documento no reproduce ningún valor real.

## 1. Hallazgo (registrado en `docs/beta-gate-1/discovery.md` §D)

El repositorio de GitHub es **público**. En `HEAD` había:

| Dato (categoría) | Dónde | Clase | Acción |
|---|---|---|---|
| email personal del titular | `docs/p0-p2-invitations.md` | A · documento activo | **anonimizado** (se omite: no aporta al procedimiento) |
| email personal del titular | `supabase/MIGRATION_BASELINE_PLAN.md` | A · documento activo | **anonimizado** (se omite) |
| alias ARCA real (nombre de equipo WSASS) | `src/pages/Tutorials.tsx` (mock ilustrativo del paso 5) | B · material con dato real | **reemplazado** por `techrepairdemo` |
| CUIT emisor real del tenant | `src/pages/Tutorials.tsx` (mismo mock) | B | **reemplazado** por `20-00000000-0` |
| alias ARCA real usado como caso inválido | `scripts/guards/arca-wsass-alias-contract.mjs`, `tests/sql/arca_wsass_homologacion_alias.test.sql` (×2) | B · fixture | **reemplazado** por `demo.alias2`, que prueba lo mismo (letra inicial, un punto, dígito final: inválido en homologación, válido para la regex de producción) |
| alias, CUIT y email citados en la matriz del discovery | `docs/beta-gate-1/discovery.md` | A · documento activo | **anonimizado** (valores omitidos; la tabla conserva archivo, clasificación y acción) |
| apellido del titular en un comentario | `tests/unit/entitlements.test.ts` | B · comentario | **reemplazado** por "titular" |
| email personal del titular | `supabase/migrations/_legacy/20260626174811_owner_system_owner_activation.sql` | C · migración histórica | **intacta** (decisión de producto) |

Los "2 documentos" de la decisión son `docs/p0-p2-invitations.md` y `supabase/MIGRATION_BASELINE_PLAN.md`.
`docs/beta-gate-1/discovery.md` se escribió después y citaba los mismos valores en su matriz: es un
documento activo de la misma clase y también se anonimizó. `src/pages/Tutorials.tsx` cambia sólo dos
literales de un mock estático (sin lógica, sin estado, sin tests que los fijen).

## 2. Qué queda deliberadamente intacto (clase D, documentado)

- **Migración `_legacy`**: evidencia de lo que corrió en producción. Byte a byte igual (sha256 fijado en el
  guard).
- **Handle de GitHub `molinajonyy-hub`** (15 archivos): es la URL pública del propio repositorio y de sus PRs.
- **Nombre comercial "Clic"** y el **business id** de su tenant en documentos de auditoría: el nombre es
  público (dominio del portal) y el id es interno, no secreto (RLS); son la trazabilidad de las auditorías.
- **Email de soporte corporativo** (`techrepairpro.soporte@…`) y sus alias `+…`: contacto intencional.
- **CUITs sintéticos** de tests/fixtures y los CUIT aleatorios de las capturas E2E.
- **Historial de git**: los valores siguen ahí por decisión explícita (sin `filter-repo`, BFG ni force push).

No se encontró ningún secreto real (claves privadas, `service_role`, tokens, passwords, certificados).

## 3. Guard `guard:no-real-data`

`scripts/guards/no-real-data.mjs`, integrado en el job `quality` del CI existente.

- **Sin texto plano:** cada regla es un SHA-256 con separación de dominio del valor normalizado. Guardar los
  valores en claro los volvería a publicar. Un digest de un dato de baja entropía (un DNI) es atacable por
  fuerza bruta; se acepta porque el valor ya está en el historial público y el digest no agrega exposición.
- **Categorías y variantes:**
  - `email`: dirección exacta, sin distinguir mayúsculas y sin `+tag`.
  - `email-gmail-canonical`: la misma casilla de gmail sin puntos.
  - `email-local-part`: el usuario del email con cualquier separador (`.`, `_`, `-`) y en cualquier casing.
  - `alias-arca`: el alias con o sin separadores y en cualquier casing, también dentro de rutas o hostnames.
  - `cuit`: 11 dígitos con o sin `-`, `.` o espacio entre los grupos.
  - `dni`: los 8 dígitos del CUIT, con o sin puntos de miles.
- **No es un detector genérico de PII.** Sólo conoce estos identificadores, así que no tiene falsos
  positivos. El handle de GitHub, "Molina" como apellido común y los datos sintéticos no se marcan.
- **Una sola excepción**, fijada por:
  1. ruta exacta: `supabase/migrations/_legacy/20260626174811_owner_system_owner_activation.sql`;
  2. sha256 del contenido: `6cae5c33…0f9905`;
  3. categorías permitidas: sólo las de email.

  Si el archivo cambia, la excepción deja de aplicar y el guard falla. Esa ruta con otras categorías, u
  otra ruta en `_legacy`, también fallan.
- **Salida:** `archivo:línea [categoría] descripción (valor oculto)`. Nunca imprime el valor.
- **Modos:**
  - `npm run guard:no-real-data`: escanea los archivos de texto versionados (`git ls-files`).
  - `npm run guard:no-real-data:self-test`: 28 casos. Usa datos sintéticos con la misma normalización; los
    casos REAL usan el email de la `_legacy`, la única fuente real dentro del árbol. Incluye cero falsos
    positivos sobre el `HEAD` saneado.
  - `npm run guard:no-real-data:verify-removed`: lee los valores removidos del commit base
    (`c90a4ed`, objeto de git, en memoria) y prueba que las reglas REALES bloquean cada uno con sus
    variantes. En CI el commit se trae por SHA (el checkout es shallow).

## 4. Validación

| Gate | Resultado |
|---|---|
| Control negativo: guard sobre `c90a4ed` sin sanear | **FAIL** con 22 hallazgos en exactamente los 7 archivos de la matriz; `_legacy` no marcada; sin valores en la salida |
| `guard:no-real-data` sobre `HEAD` saneado | OK — 0 coincidencias |
| `guard:no-real-data:self-test` | **28/28** |
| `guard:no-real-data:verify-removed` | **5/5** (alias, CUIT, DNI, email, usuario del email) |
| Mutaciones del guard (excepción sin hash, sin normalizar casing, sin quitar `+tag`) | 3/3 detectadas por el self-test |
| `guard:arca-wsass-alias` + self-test | OK (corpus 523, igual que antes) |
| `tests/sql/arca_wsass_homologacion_alias.test.sql` en un stack local aislado (DB tip `20261002120000`) | W01–W08 OK, `ROLLBACK` |
| `guard:ci-e2e` + self-test (cambió `ci.yml`) | OK |
| `tests/unit/entitlements.test.ts` | 11/11 |
| `tsc --noEmit` · ESLint `--quiet` | 0 · 0 |

## 5. Riesgos y rollback

- **Riesgo residual:** los valores siguen en el historial público de git y en forks o clones previos, por
  decisión explícita. El guard sólo protege `HEAD` hacia adelante.
- **Falsos negativos posibles:** una variante que no está prevista (por ejemplo, el CUIT partido en otra
  forma, o el valor dentro de un binario o PNG) no se detecta. Es intencional: no es un escáner genérico.
- **Dependencia de CI:** `verify-removed` necesita traer `c90a4ed` por SHA. Si GitHub no lo sirve, el paso
  falla cerrado.
- **Rollback:** revertir el merge commit. No hay estado, migraciones ni despliegues que deshacer. Revertir
  vuelve a publicar los valores en `HEAD`.
