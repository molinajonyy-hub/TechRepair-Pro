# G2-A · POS / Nota de Pedido — entrega

**Base:** `origin/main` = `f97f573efdfcf16afb6ea993b7faaade1e309d9b` (verificado con `git fetch` + `rev-parse`)
**Worktree:** `.worktrees/g2-a-pos` · branch `claude/g2-a-pos-nota-de-pedido`
**Estado:** implementado y verificado. **Sin PR, sin merge, sin deploy, sin producción.**

Cierra la combinación peligrosa `factura_c + emitir_en_arca=false` del camino normal del POS y el
hallazgo G2-P1-A. **No** cierra la inmutabilidad económica: eso es G2-B.

---

## 1. Contrato — antes y después

| | Antes | Después |
|---|---|---|
| Tipo por defecto del POS | `factura_c` | **`remito`**, rotulado «Nota de Pedido» |
| Selector | Factura A · Factura C · Remito | **Nota de Pedido · Factura C** |
| `emitir_en_arca` | estado con checkbox, default `false` | **derivado del tipo** (`esTipoFiscal(tipo)`) |
| `factura_c + emitir_en_arca=false` | alcanzable, y era **el default** | **inexpresable desde la UI** |
| Intención fiscal | checkbox opt-in | elegir Factura C ⇒ «Se emitirá electrónicamente en ARCA» |
| Estado de una Nota de Pedido | «Emitido y válido / **Autorizado por ARCA**» + escudo verde | **«Documento interno»** · sin mención de ARCA |
| Evidencia de autorización fiscal | `cae` **o** `estado_fiscal='emitido'` **o `estado='emitido'`** | **sólo** `cae` o `estado_fiscal='emitido'` |

Lo que **no** cambió, a propósito: el dominio de DB (`remito` sigue siendo `remito`), `esTipoFiscal`,
el payload del checkout, el fail-closed `ARCA_NOT_CONFIGURED`, y el soporte de Factura A en backend.

---

## 2. Diff clasificado — 18 archivos, 241 inserciones / 94 borrados

`git diff --stat --ignore-all-space` da 240/93: **sin ruido CRLF**.

**Contrato del POS (CAMBIOS 1, 3, 4)**
- `src/components/comprobantes/ComprobanteProModal.tsx` (+78/-…) — `TIPO_POS_DEFAULT='remito'`;
  selector reducido a `['remito','factura_c']`; `emitirEnArca` pasa de `useState` a derivado;
  checkbox reemplazado por el aviso `pos-arca-aviso`; reset a Nota de Pedido; el draft sólo
  restaura un tipo que el selector siga ofreciendo; `data-testid` por tipo.

**Autoridad de estado fiscal (CAMBIO 5)**
- `src/utils/comprobanteStatus.ts` (+60/-…) — nueva clave `no_fiscal`; `esComprobanteNoFiscal()`;
  **se elimina `c.estado === 'emitido'`** de la rama `emitido_arca`; `no_fiscal` excluido de
  `permiteAccionesDeEmision`.
- `src/components/comprobantes/ComprobanteActions.tsx` (+32/-…) — separa `esEmitido` (¿ARCA
  autorizó?) de `esDocumentoVigente` (¿el documento opera?), para no perder PDF/anulación en una
  Nota de Pedido; branch propio de copy/color/icono para `no_fiscal`.
- `ComprobanteDocumento.tsx`, `ComprobantePrintLayout.tsx` — entrada `no_fiscal` en sus `Record`
  exhaustivos. El sello impreso dice **«● Documento no fiscal»**.

**Rótulo, fuente única (CAMBIO 2)**
- **nuevo** `src/lib/comprobanteTipoLabel.ts` — `COMPROBANTE_TIPO_LABEL` / `_SHORT` / `_DOC_LABEL`
  + helpers tolerantes a nulo. Reemplaza ~12 mapas duplicados.
- Consumidores actualizados: `ComprobantesTable`, `ComprobanteHeader`, `ComprobanteDocumento`,
  `ComprobantePrintLayout`, `ComprobanteTotales`, `ProductMovementsModal`, `GlobalSearch`,
  `printFilename`, `Comprobante`, `CustomerDetail` (+ pestaña «Notas de Pedido»), `Dashboard`,
  `OrderDetail`.

**Tests y tooling**
- **nuevos** `tests/unit/g2aFiscalStatusAuthority.test.ts`, `tests/unit/g2aComprobanteTipoLabel.test.ts`,
  `scripts/guards/g2a-pos-contract.mjs`.
- **actualizados** `tests/unit/arcaEmission.test.ts`, `tests/unit/fiscalIdentityTuple.test.ts` (ver §4).
- `package.json` — `guard:g2a-pos`, `guard:g2a-pos:self-test`, `test:g2a`.

---

## 3. Tests — los 12 pedidos

| # | Requisito | Cubierto por | Resultado |
|---|---|---|---|
| 1 | POS abre con `remito` | guard + captura (`aria-pressed=true`) | ✅ |
| 2 | UI dice «Nota de Pedido» | `g2aComprobanteTipoLabel` + captura | ✅ |
| 3 | el reset vuelve a Nota de Pedido | guard (`tipoInicial ?? TIPO_POS_DEFAULT` en apertura y reset) | ✅ |
| 4 | Nota de Pedido ⇒ `emitir_en_arca=false` | `emitirEnArca = esTipoFiscal('remito') === false` (guard + unit) | ✅ |
| 5 | Factura C ⇒ `emitir_en_arca=true` | ídem con `factura_c` | ✅ |
| 6 | no se puede construir `factura_c + false` | guard (sin setter, sin checkbox) + captura (`checkbox = 0`) | ✅ |
| 7 | sin ARCA configurado, Factura C falla cerrada | **servidor, no tocado** — medido en el discovery (`ARCA_NOT_CONFIGURED`, sin comprobante creado) | ⚠️ ver §7 |
| 8 | Nota de Pedido no requiere ARCA | `remito` no entra a la rama fiscal; captura con «PV fiscal sin configurar» y venta posible | ✅ |
| 9 | Nota de Pedido no muestra status ARCA | `g2aFiscalStatusAuthority` CASO 1 + captura del detalle | ✅ |
| 10 | Factura C con CAE sí lo muestra | `g2aFiscalStatusAuthority` CASO 2 | ✅ |
| 11 | Factura A no aparece en el selector | guard + captura (`Factura A visible = false`) | ✅ |
| 12 | sin cambios en pagos/Caja/inventario del remito | **payload y RPC intactos**; ver §7 | ⚠️ ver §7 |

**Suites:** `tsc` 0 · `lint:errors` 0 · `test:unit` **1172/1172** · componentes **1238/1238** ·
`test:g2a` 16/16 · guards `arca-phase0/1/2a/2b`, `arca-wsass-alias`, `customer-core`, `mobile2a` todos exit 0.

### Tests existentes actualizados — y por qué no es debilitarlos

Tres tests afirmaban la **forma vieja del código** y fallaron porque G2-A la cambió a propósito.
Ninguno señalaba una rotura; los tres quedaron **más fuertes**:

1. `arcaEmission` «el botón Anular se oculta con CAE» — afirmaba el literal
   `esEmitido && !comprobante.cae`. La regla que protege (con CAE no se anula) **no cambió**: sigue
   el `!comprobante.cae`. Se actualizó el otro término y **se agregó** que no exista una segunda vía
   de anulación fuera del guard, más un test nuevo de que la Nota de Pedido conserva PDF y anulación.
2. `fiscalIdentityTuple` «checkout genérico deriva fiscalidad del tipo» — exigía `factura_a` en el
   selector (ahora fuera de beta, por contrato) y el literal `if (k === 'remito') setEmitirEnArca(false)`.
   Ese limpiado ya no hace falta: **no hay flag que limpiar**. Se reemplazó por la garantía más
   fuerte — el flag se deriva y **ningún setter puede desacoplarlo**.
3. `fiscalIdentityTuple` «sin_autorizacion_fiscal antes que emitido» — protegía el *orden* porque
   `c.estado === 'emitido'` contaba como evidencia de ARCA. Ahora **esa inferencia no existe**, así
   que el test pasó a afirmar su ausencia (más fuerte que un orden) y además que `no_fiscal` y
   `sin_autorizacion_fiscal` se resuelven antes que la rama de ARCA.

---

## 4. Negative controls — `npm run guard:g2a-pos:self-test`

8 mutaciones aplicadas en memoria; **las 8 detectadas**. Incluye las 4 pedidas:

| Mutación | Detectada |
|---|---|
| default vuelve a `factura_c` | ✔ |
| default viejo por la puerta de atrás (`tipoInicial ?? 'factura_c'`) | ✔ |
| **Factura A vuelve al selector** | ✔ |
| `emitirEnArca` deja de derivarse | ✔ |
| **vuelve el checkbox de ARCA** (permite `factura_c + false`) | ✔ |
| **`estado=emitido` vuelve a probar ARCA** | ✔ |
| `no_fiscal` vuelve a permitir emisión | ✔ |
| el rótulo vuelve a «Remito» | ✔ |

El self-test también aborta si una mutación **no aplica** (patrón cambiado), para que no pueda dar
verde sin haber mutado nada. Los archivos se mutan en memoria: el árbol nunca se toca.

---

## 5. Evidencia visual — `docs/g2-a-evidencia/`

Medido en desktop (1440) y mobile (390), contra el stack local:

```
[desktop] default remito aria-pressed=true
[desktop] selector = "Nota de Pedido\nFactura C"
[desktop] Factura A visible = false
[desktop] aviso ARCA visible con Nota de Pedido = false
[desktop] aviso ARCA con Factura C = true · texto="Se emitirá electrónicamente en ARCA"
[desktop] checkbox "Emitir en ARCA" = 0
[mobile]  … idéntico …
detalle · dice "Autorizado por ARCA" = false
detalle · dice "Emitido y válido"    = false
detalle · dice "Documento interno"   = true
detalle · dice "Nota de Pedido"      = true
```

---

## 6. Cero cambios de base de datos · cero deploy

- `git status -- supabase` → **vacío**. Ninguna migración, ningún `config.toml`, ninguna RPC.
- El stack local usado para capturas se levantó con **3 archivos locales descartables**, ya
  borrados, y **sin modificar ninguna migración del repo**. (Dato para G2-F: el replay limpio
  funciona sólo con neutralizar las default privileges de `anon`/`service_role` y re-conceder los
  6 helpers de RLS.)
- Sin push, sin PR, sin deploy, sin tocar producción.

---

## 7. Riesgos residuales

1. **G2-P0-1 sigue abierto.** Este lote saca del camino por defecto la combinación que lo
   alimentaba, pero una Factura C legítima sigue naciendo `borrador` y **sigue siendo editable**
   hasta el CAE. La autoridad de DB sobre `comprobante_items` es **G2-B** y es la que cierra el P0.
2. **Tests 7 y 12 no son de este lote.** El fail-closed de ARCA y la neutralidad económica del
   remito viven en el servidor, que **no se tocó**; están medidos en el discovery, no re-ejecutados
   acá. Un E2E contra stack local los cubriría de punta a punta.
3. **El documento impreso ahora dice «NOTA DE PEDIDO»** (antes «REMITO»). Es coherente con el
   contrato y el pie «autorizado por ARCA» ya estaba correctamente condicionado a `cae`, pero es un
   cambio visible para el cliente final: conviene una mirada humana.
4. **`ModalCrearComprobante.tsx` sigue con default `factura_c`.** Es código muerto (cero
   importadores, confirmado en el discovery) y por eso no se tocó — pero es una mina si alguien lo
   recablea. Su eliminación está en el backlog P2 del discovery.
5. **Comprobantes históricos.** Un `remito` viejo pasa a mostrarse «Documento interno» en vez de
   «Emitido». Es la corrección buscada, no una regresión, pero cambia lo que ve el usuario sobre
   datos ya existentes.
6. **Flake observado, no atribuible.** En una corrida de la suite completa falló
   `orderIntakeMobile.test.tsx > scanner cross-browser`. Pasó aislado, pasó en la re-corrida
   completa (1238/1238) y el baseline `f97f573` también pasa. Es un flake de timing sobre
   `mediaDevices`, ajeno a G2-A; se deja registrado en vez de barrerlo.

---

## 8. Propuesta de PR

**Título:** `feat(pos): Nota de Pedido como comprobante predeterminado y estado fiscal honesto (G2-A)`

**Cuerpo:**

> Primer lote de BETA-GATE-2. Saca del camino normal del POS la combinación
> `factura_c + emitir_en_arca=false`, que hasta ahora era **el default de toda venta** y dejaba cada
> comprobante en `borrador` esperando un CAE que nadie iba a pedir.
>
> - **Nota de Pedido** (`tipo='remito'`, sin cambios de dominio en DB) pasa a ser el tipo
>   predeterminado. Registra venta, pagos, Caja, stock, COGS y ledger; nunca toca ARCA.
> - **Factura C** implica intención fiscal: `emitir_en_arca` se deriva del tipo y desaparece el
>   checkbox que permitía emitir "a medias". Se informa «Se emitirá electrónicamente en ARCA».
> - **Factura A** sale del selector de beta (soporte backend intacto).
> - **Se corrige G2-P1-A**: `estado === 'emitido'` dejó de contar como autorización fiscal, así que
>   una Nota de Pedido ya no se presenta como «Autorizado por ARCA».
> - Rótulo unificado en una fuente única (`comprobanteTipoLabel`), reemplazando ~12 mapas duplicados.
>
> Cero cambios de base de datos. `tsc` 0 · `lint:errors` 0 · unit 1172/1172 · componentes 1238/1238 ·
> `test:g2a` con guard y 8 negative controls.
>
> **No cierra G2-P0-1**: la autoridad de DB sobre `comprobante_items` es G2-B.

**Checks sugeridos para CI:** `npm run test:g2a` sumado a la batería existente.

**Revisión humana pedida antes de mergear:** el rótulo del documento impreso (§7.3) y el cambio de
presentación sobre comprobantes históricos (§7.5).
