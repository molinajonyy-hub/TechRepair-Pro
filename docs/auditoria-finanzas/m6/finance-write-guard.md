# M6 · Fase 10 — Finance write guard

Script: `scripts/guards/no-direct-finance-writes.mjs`
Comandos: `npm run guard:finance-writes` · `npm run guard:finance-writes:self-test`

## Qué protege

Evita **regresiones en el cliente**: que alguien vuelva a escribir el libro mayor
financiero directamente desde `src/` (frontend / service-layer) en vez de pasar por una
**RPC atómica SECURITY DEFINER**. Es un guard estático (lee `src/` y detecta patrones
`supabase.from('tabla').<op>(...)`), complementario a la RLS.

> ⚠️ Esto **no reemplaza la RLS**. La RLS es la defensa real server-side (Fase 9): aunque
> el guard no existiera, la base rechaza el INSERT/UPDATE/DELETE directo. El guard sólo
> atrapa el error **antes**, en el frontend, con un mensaje accionable, para que no se
> filtre un write nuevo que después falle en runtime o dependa de una excepción no revisada.

## Qué tablas controla

`financial_movements`, `business_finance_entries`, `comprobante_payments`,
`account_movements`, `supplier_account_movements`, `supplier_payments`,
`order_payments`, `expenses`, `cajas`.

## Qué operaciones prohíbe

`insert`, `update`, `delete`, `upsert` — por defecto, en cualquier archivo de `src/`.

Detecta comillas simples/dobles/backtick, `await supabase.from(...)`, y cadenas
**multilínea** (`.from('t')\n.update(...)`). Sólo mira operaciones encadenadas a un
`.from('<tabla crítica>')`, por lo que **no** genera falsos positivos con
`Map/Set/cache.delete()` ni con `SELECT`.

Directorios: escanea **sólo `src/`** (`.ts/.tsx/.js/.jsx/.mjs/.cjs`). No toca
`supabase/migrations`, `supabase/tests`, `docs`, SQL, `node_modules`, `dist`, `coverage`.
No lee ni depende de `supabase/config.toml` ni de rutas/puertos locales → no afecta Vercel.

## Cómo correrlo

```bash
npm run guard:finance-writes            # escanea src/ (exit 1 si hay violación)
npm run guard:finance-writes:self-test  # valida el propio guard (13 casos)
```

Salida OK: cantidad de escrituras detectadas, las permitidas por allowlist, y
`✅ Finance write guard passed`. Salida FALLA: archivo, línea, tabla, operación, snippet
y sugerencia (migrar a RPC o documentar excepción), con exit code 1.

## Allowlist (E1/E2/E3)

Estricta: cada entrada matchea **archivo + tabla + operación exactos**. No hay comodines
(“todo comprobanteService”), ni “expenses insert en cualquier archivo”, ni UPDATE/DELETE
en ninguna excepción.

| Código | Archivo | Tabla | Op | Motivo | Destino |
|---|---|---|:--:|---|---|
| **E1** | `src/services/comprobanteService.ts` | `comprobante_payments` | insert | Cobro inicial (registrarPago). POS/checkout/ARCA sensible; acotado por business; UPDATE/DELETE bloqueados; replace ya va por RPC | Migrar a RPC (Fase 10/11 posterior) |
| **E2** | `src/services/cuentasService.ts` | `account_movements` | insert | CC manual pago/deuda/ajuste. UI activa; ledger CC aislado sin FM/BFE/caja; acotado por business+staff+feature | Migrar a RPC posterior |
| **E3** | `src/pages/Expenses.tsx` | `expenses` | insert | Alta de factura documental legítima; UPDATE/DELETE bloqueados; no es corrección económica | Permitido por contrato actual |

## Cómo agregar una excepción futura

Editar el array `ALLOWLIST` en `scripts/guards/no-direct-finance-writes.mjs`, agregando
una entrada con **`code`, `file`, `table`, `op`, `reason`, `migrateTo`**. Reglas:

1. **Toda excepción futura necesita motivo (`reason`), owner y plan de migración (`migrateTo`).**
2. Nunca allowlistear `update`/`delete`/`upsert` sobre estas tablas: una corrección
   económica va siempre por RPC append-only, no por escritura directa.
3. Preferir **migrar a RPC** antes que sumar excepción. La excepción es deuda temporal.
4. Cada excepción debe quedar reflejada también en
   [`rls-lockdown.md`](./rls-lockdown.md) (matriz de acceso + tabla de excepciones).

## Tests del guard

`--self-test` corre 13 casos in-memory (sin tocar `src/`):

1. detecta `insert` en `financial_movements`; 2. `update` en `business_finance_entries`;
3. `delete` en `order_payments`; 4-6. permite E1/E2/E3; 7. rechaza E1 si pasa de
`insert` a `update`; 8. rechaza misma tabla/op en archivo no allowlisted; 9. comillas
dobles; 10. cadena multilínea; 11-13 (anti-falso-positivo): NO detecta `cache.delete()`,
NO detecta `SELECT`, NO detecta tabla no crítica.

## Integración a gates

Agregado a `package.json` como `guard:finance-writes`. Se corre en los **gates finales**
(local/CI) junto a `tsc`, `lint` y tests. **No** se engancha a `build` para no arriesgar
el deploy de Vercel por un cambio de este guard.
