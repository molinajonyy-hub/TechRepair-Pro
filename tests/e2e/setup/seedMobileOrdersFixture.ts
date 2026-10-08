// ============================================================================
// BETA-UX-1D — fixture de «la orden en el celular».
//
// Órdenes, clientes y un comprobante por estado de cobro para medir el detalle
// de orden y las listas a 320/375 px. Todo con IDs determinísticos y propios:
// no toca ningún fixture compartido y se puede sembrar N veces.
//
// Va por `docker exec` al Postgres LOCAL (ver sqlLocal): estructuralmente no
// puede escribir en un proyecto remoto.
//
// Los comprobantes se insertan en crudo con los triggers apagados. No se prueba
// el cobro —eso lo cubren los specs de checkout—: se necesita que la vista
// canónica `v_order_financial_status` DEVUELVA cada estado, y la vista lee
// `total_bruto` / `total_cobrado` / `saldo_pendiente` del comprobante.
// ============================================================================
import { ejecutarSQL } from './sqlLocal.ts'
import { E2E } from './seedE2E.ts'

const id = (sufijo: string) => `00000000-0000-0000-0000-00000e2e1d${sufijo}`
/** Las órdenes se muestran por sus primeros 8 caracteres: que sean distintos. */
const orden = (n: string) => `e2e1d0${n}-0000-0000-0000-00000e2e1d${n}`

export const MOBILE_ORDERS = {
  clientes: {
    minorista:   id('c1'),
    mayorista:   id('c2'),
    sinContacto: id('c3'),
  },
  equipos: {
    largo:      id('d1'),
    corto:      id('d2'),
    sinEspacio: id('d4'),
  },
  ordenes: {
    /** Parcial, urgente, modelo largo, con ítems y comprobante. */
    parcial:      orden('01'),
    /** Cobrada, mayorista. */
    cobrada:      orden('02'),
    /** Sin dispositivo, sin importes, sin comprobante. */
    sinEquipo:    orden('03'),
    /** Modelo sin ningún espacio: la única forma de envolver es partir la palabra. */
    sinEspacios:  orden('04'),
  },
  comprobantes: {
    parcial: id('f1'),
    cobrada: id('f2'),
  },
  /** Empleado SIN `orders_view_financials` (rol sales + override). */
  empleado: {
    email: 'beta-ux-1d-empleado@e2e.local',
    password: 'e2e-local-Passw0rd',
  },
} as const

/** Textos que los specs buscan en pantalla. */
export const MOBILE_ORDERS_TEXT = {
  minorista: 'Cliente Móvil Uno',
  mayorista: 'Distribuidora Sintética',
  sinContacto: 'Cliente Sin Contacto',
  emailLargo: 'administracion.compras.y.pagos@distribuidora-sintetica-de-ejemplo.test',
  modeloLargo: 'Galaxy S24 Ultra 5G 512GB Titanium Black',
  modeloSinEspacios: 'SM-S928BZKDEUB-INTERNATIONAL-DUALSIM-ENTERPRISE-EDITION',
  totalParcial: '185.000',
  saldoParcial: '100.000',
  totalCobrada: '60.000',
} as const

const { clientes: C, equipos: D, ordenes: O, comprobantes: F } = MOBILE_ORDERS

const ORDENES_SQL = Object.values(O).map(v => `'${v}'`).join(', ')
const CLIENTES_SQL = Object.values(C).map(v => `'${v}'`).join(', ')
const EQUIPOS_SQL = Object.values(D).map(v => `'${v}'`).join(', ')
const COMPROBANTES_SQL = Object.values(F).map(v => `'${v}'`).join(', ')

const LIMPIEZA = `
DELETE FROM public.comprobante_payments WHERE comprobante_id IN (${COMPROBANTES_SQL});
DELETE FROM public.comprobantes         WHERE id IN (${COMPROBANTES_SQL});
DELETE FROM public.whatsapp_logs        WHERE order_id IN (${ORDENES_SQL});
DELETE FROM public.warranties           WHERE order_id IN (${ORDENES_SQL});
DELETE FROM public.status_history       WHERE order_id IN (${ORDENES_SQL});
DELETE FROM public.order_items          WHERE order_id IN (${ORDENES_SQL});
DELETE FROM public.orders               WHERE id IN (${ORDENES_SQL});
DELETE FROM public.devices              WHERE id IN (${EQUIPOS_SQL});
DELETE FROM public.customers            WHERE id IN (${CLIENTES_SQL});
`

/** Borra todo lo del fixture. Idempotente. */
export function limpiarMobileOrders(): void {
  ejecutarSQL(`
BEGIN;
SET LOCAL session_replication_role = 'replica';
${LIMPIEZA}
COMMIT;`)
}

/** Siembra (o repone) el fixture completo. Idempotente. */
export function sembrarMobileOrders(): void {
  const T = MOBILE_ORDERS_TEXT
  ejecutarSQL(`
BEGIN;
-- 'replica' apaga los triggers (stock, totales, numeración, sync de cobros): el
-- fixture fija cada importe a mano y tiene que quedar EXACTAMENTE así.
SET LOCAL session_replication_role = 'replica';
${LIMPIEZA}

INSERT INTO public.customers (id, business_id, name, phone, email, customer_type, business_name) VALUES
  ('${C.minorista}',   '${E2E.business}', '${T.minorista}',   '3515550101', 'cliente.movil.uno@example.test', 'minorista', NULL),
  ('${C.mayorista}',   '${E2E.business}', '${T.mayorista}',   '3515550102', '${T.emailLargo}',                'mayorista', 'Distribuidora Sintética SRL'),
  ('${C.sinContacto}', '${E2E.business}', '${T.sinContacto}', '',           NULL,                             'minorista', NULL);

INSERT INTO public.devices (id, business_id, customer_id, type, brand, model, issue) VALUES
  ('${D.largo}',      '${E2E.business}', '${C.minorista}',   'smartphone', 'Samsung', '${T.modeloLargo}',
   'No enciende después de una caída. La pantalla quedó con una línea vertical y el puerto de carga está flojo.'),
  ('${D.corto}',      '${E2E.business}', '${C.mayorista}',   'smartphone', 'Apple',   'iPhone 13', 'Cambio de batería'),
  ('${D.sinEspacio}', '${E2E.business}', '${C.sinContacto}', 'smartphone', 'Samsung', '${T.modeloSinEspacios}', 'Revisión general');

-- Fechas escalonadas y recientes: quedan arriba de la lista, en este orden.
INSERT INTO public.orders (id, business_id, customer_id, device_id, status, priority,
                           estimated_total, labor_cost, access_mode, created_at, updated_at) VALUES
  ('${O.parcial}',     '${E2E.business}', '${C.minorista}',   '${D.largo}',      'repair',         'urgent', 185000, 0,     'pin',  now() - interval '1 minute', now()),
  ('${O.cobrada}',     '${E2E.business}', '${C.mayorista}',   '${D.corto}',      'ready_delivery', 'medium', 0,      60000, 'none', now() - interval '2 minute', now()),
  ('${O.sinEquipo}',   '${E2E.business}', '${C.minorista}',   NULL,              'new',            'low',    0,      0,     NULL,   now() - interval '3 minute', now()),
  ('${O.sinEspacios}', '${E2E.business}', '${C.sinContacto}', '${D.sinEspacio}', 'diagnosis',      'high',   42000,  0,     NULL,   now() - interval '4 minute', now());

INSERT INTO public.order_items (order_id, business_id, tipo, descripcion, cantidad, precio_unitario, costo_unitario, cliente_paga_repuesto) VALUES
  ('${O.parcial}', '${E2E.business}', 'servicio', 'Diagnóstico y mano de obra de reparación de placa', 1, 95000, 0,     true),
  ('${O.parcial}', '${E2E.business}', 'repuesto', 'Módulo de pantalla AMOLED original con marco',      1, 90000, 61000, true);

-- Un comprobante vigente por estado de cobro. La vista canónica deriva:
--   parcial → cobrado 85.000 de 185.000, saldo 100.000
--   cobrada → saldo 0
INSERT INTO public.comprobantes (id, order_id, tipo, numero, estado, estado_fiscal, total, total_bruto,
       total_cobrado, saldo_pendiente, customer_id, business_id, created_by, punto_venta, fecha, date) VALUES
  ('${F.parcial}', '${O.parcial}', 'remito', 'E2E-1D-0001', 'emitido', 'no_fiscal', 185000, 185000,
        85000, 100000, '${C.minorista}', '${E2E.business}', '${E2E.owner}', '0001', now(), now()),
  ('${F.cobrada}', '${O.cobrada}', 'remito', 'E2E-1D-0002', 'emitido', 'no_fiscal', 60000, 60000,
        60000, 0,      '${C.mayorista}', '${E2E.business}', '${E2E.owner}', '0001', now(), now());
COMMIT;`)
}

/**
 * Perfil del empleado restringido. El usuario de Auth lo crea el spec (necesita
 * la API de Auth); esto le da un perfil en el negocio E2E con rol `sales` y la
 * capacidad `orders_view_financials` apagada por override.
 *
 * Por qué un usuario APARTE y no degradar al owner: la autoridad de importes es
 * `current_user_can_in_business`, que le reconoce autoridad de dueño al
 * `businesses.owner_user_id` sin mirar su perfil. Cambiarle el rol al usuario
 * E2E no le saca los importes; habría que reasignar el negocio, que es estado
 * compartido por toda la suite.
 */
export function sembrarPerfilEmpleado(userId: string): void {
  ejecutarSQL(`
BEGIN;
SET LOCAL session_replication_role = 'replica';
INSERT INTO public.profiles (id, business_id, user_id, role, is_active, full_name, email, permissions)
VALUES ('${userId}', '${E2E.business}', '${userId}', 'sales', true, 'Empleado BETA-UX-1D',
        '${MOBILE_ORDERS.empleado.email}', '{"orders_view_financials": false}'::jsonb)
ON CONFLICT (id) DO UPDATE SET business_id = EXCLUDED.business_id, user_id = EXCLUDED.user_id,
       role = 'sales', is_active = true, permissions = EXCLUDED.permissions;
COMMIT;`)
}

export function borrarPerfilEmpleado(userId: string): void {
  ejecutarSQL(`
BEGIN;
SET LOCAL session_replication_role = 'replica';
DELETE FROM public.profiles WHERE id = '${userId}';
COMMIT;`)
}
