// ============================================================================
// BETA-UX-1E — fixture de los CTAs de acento.
//
// Lo mínimo para que las superficies de este lote muestren sus CTAs:
//   · dos productos, uno con stock bajo y otro agotado: sin ellos Inventario no
//     ofrece «Ver stock bajo» ni «Ver agotados»;
//   · un segundo usuario del negocio: el dueño y el propio usuario son filas
//     protegidas, y «Guardar permisos» sólo se abre desde una fila editable.
//
// Las órdenes (detalle, notas, ítems, acceso del equipo) son las del fixture de
// BETA-UX-1D: no se duplican.
//
// IDs determinísticos y propios; se puede sembrar N veces. Va por `docker exec`
// al Postgres LOCAL (ver sqlLocal): no puede escribir en un proyecto remoto.
// ============================================================================
import { ejecutarSQL } from './sqlLocal.ts'
import { E2E } from './seedE2E.ts'

const id = (sufijo: string) => `00000000-0000-0000-0000-00000e2e1e${sufijo}`

export const CTA_CONTRAST = {
  productos: {
    stockBajo: id('d1'),
    agotado:   id('d2'),
  },
  /** Usuario editable del negocio (ni dueño ni el usuario E2E). */
  tecnico: id('a1'),
} as const

export const CTA_CONTRAST_TEXT = {
  stockBajo: 'Flex de carga 1E',
  agotado: 'Batería agotada 1E',
  tecnico: 'Técnico BETA-UX-1E',
  tecnicoEmail: 'beta-ux-1e-tecnico@e2e.local',
} as const

const { productos: P, tecnico: TECNICO } = CTA_CONTRAST
const T = CTA_CONTRAST_TEXT

const LIMPIEZA = `
DELETE FROM public.inventory_movements WHERE product_id IN ('${P.stockBajo}', '${P.agotado}')
                                          OR inventory_item_id IN ('${P.stockBajo}', '${P.agotado}');
DELETE FROM public.inventory           WHERE id IN ('${P.stockBajo}', '${P.agotado}');
DELETE FROM public.profiles            WHERE id = '${TECNICO}';
DELETE FROM auth.users                 WHERE id = '${TECNICO}';
`

/** Borra todo lo del fixture. Idempotente. */
export function limpiarCtaContrast(): void {
  ejecutarSQL(`
BEGIN;
SET LOCAL session_replication_role = 'replica';
${LIMPIEZA}
COMMIT;`)
}

/** Siembra (o repone) el fixture completo. Idempotente. */
export function sembrarCtaContrast(): void {
  ejecutarSQL(`
BEGIN;
-- 'replica' apaga los triggers: el fixture fija el stock a mano y no registra
-- movimientos. Acá no se prueba el stock, se necesita que la pantalla lo MUESTRE.
SET LOCAL session_replication_role = 'replica';
${LIMPIEZA}

INSERT INTO public.inventory (id, business_id, name, code, category, stock_quantity, stock, min_stock,
                              cost_price, sale_price, base_price, base_currency,
                              auto_update_price, exchange_rate_used, is_active) VALUES
  ('${P.stockBajo}', '${E2E.business}', '${T.stockBajo}', 'E2E-1E-LOW', 'Repuestos', 1, 1, 1, 600, 1000, 1000, 'ARS', false, 1, true),
  ('${P.agotado}',   '${E2E.business}', '${T.agotado}',   'E2E-1E-OUT', 'Repuestos', 0, 0, 1, 600, 1000, 1000, 'ARS', false, 1, true);

INSERT INTO auth.users (id, email) VALUES ('${TECNICO}', '${T.tecnicoEmail}')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, business_id, user_id, role, is_active, full_name, email)
VALUES ('${TECNICO}', '${E2E.business}', '${TECNICO}', 'tech', true, '${T.tecnico}', '${T.tecnicoEmail}');
COMMIT;`)
}
