// ============================================================================
// BETA-UX-1F — fixture de «Inicio como centro operativo».
//
// Órdenes en los estados que los indicadores de «Hoy» cuentan, tareas del dueño
// (vencidas, de hoy, próximas, sin fecha y una completada) y dos empleados: un
// técnico (sin `finance` ni `comprobantes`) y un vendedor (`comprobantes` sin
// `finance`). Todo con IDs determinísticos y propios: no toca ningún fixture
// compartido y se puede sembrar N veces.
//
// Va por `docker exec` al Postgres LOCAL (ver sqlLocal): estructuralmente no
// puede escribir en un proyecto remoto.
//
// FECHAS. Las órdenes del fixture se fechan unos minutos en el FUTURO: el
// negocio E2E es compartido y otros specs crean órdenes durante la corrida; así
// las cinco «recientes» son siempre éstas, en este orden. Los vencimientos de
// las tareas se calculan sobre la fecha civil ARGENTINA, no sobre `current_date`
// (que en la sesión de la base es UTC y de noche ya es mañana).
// ============================================================================
import { ejecutarSQL } from './sqlLocal.ts'
import { E2E } from './seedE2E.ts'

const id = (sufijo: string) => `00000000-0000-0000-0000-00000e2e1f${sufijo}`
/** Las órdenes se muestran por sus primeros 8 caracteres: que sean distintos. */
const orden = (n: string) => `e2e1f0${n}-0000-0000-0000-00000e2e1f${n}`

export const DASHBOARD_1F = {
  clientes: { uno: id('c1'), dos: id('c2') },
  equipos: { uno: id('d1'), dos: id('d2') },
  ordenes: {
    /** La más nueva. En reparación. */
    reparacion: orden('01'),
    lista: orden('02'),
    aprobacion: orden('03'),
    /** Sin cliente ni equipo. */
    sinDatos: orden('04'),
    diagnostico: orden('05'),
    /** Completada hace días: cuenta para el total, no entra en las recientes. */
    cerrada: orden('06'),
  },
  tareas: {
    vencidaAlta: id('a1'),
    vencidaMedia: id('a2'),
    hoy: id('a3'),
    proxima: id('a4'),
    sinFecha: id('a5'),
    completada: id('a6'),
    /** Asignada al técnico: el dueño no la ve en «Mis tareas». */
    delTecnico: id('a7'),
  },
  tecnico: { email: 'beta-ux-1f-tecnico@e2e.local', password: 'e2e-local-Passw0rd', rol: 'tech', nombre: 'Técnico BETA-UX-1F' },
  vendedor: { email: 'beta-ux-1f-vendedor@e2e.local', password: 'e2e-local-Passw0rd', rol: 'sales', nombre: 'Vendedor BETA-UX-1F' },
} as const

export const DASHBOARD_1F_TEXT = {
  clienteUno: 'Cliente Inicio Uno',
  clienteLargo: 'Distribuidora Sintética del Centro Sociedad Anónima',
  modeloLargo: 'Galaxy S24 Ultra 5G 512GB Titanium Black',
  tareaVencidaAlta: 'Llamar por el presupuesto pendiente',
  tareaVencidaMedia: 'Pedir el módulo de pantalla al proveedor',
  tareaHoy: 'Entregar el equipo reparado',
  tareaProxima: 'Actualizar la lista de precios de repuestos y avisarle al mostrador',
  tareaSinFecha: 'Ordenar el depósito',
  tareaCompletada: 'Tarea ya completada',
  tareaDelTecnico: 'Revisar la placa del equipo en banco',
} as const

const { clientes: C, equipos: D, ordenes: O, tareas: T } = DASHBOARD_1F
const lista = (valores: Record<string, string>) => Object.values(valores).map(v => `'${v}'`).join(', ')

const ORDENES_SQL = lista(O)
const TAREAS_SQL = lista(T)

const LIMPIEZA = `
DELETE FROM public.task_history  WHERE task_id IN (${TAREAS_SQL});
DELETE FROM public.task_comments WHERE task_id IN (${TAREAS_SQL});
DELETE FROM public.task_items    WHERE task_id IN (${TAREAS_SQL});
DELETE FROM public.tasks         WHERE id IN (${TAREAS_SQL});
DELETE FROM public.status_history WHERE order_id IN (${ORDENES_SQL});
DELETE FROM public.order_items    WHERE order_id IN (${ORDENES_SQL});
DELETE FROM public.orders         WHERE id IN (${ORDENES_SQL});
DELETE FROM public.devices        WHERE id IN (${lista(D)});
DELETE FROM public.customers      WHERE id IN (${lista(C)});
`

/** Fecha civil de hoy en Argentina, como expresión SQL. */
const HOY_AR = `(now() AT TIME ZONE 'America/Argentina/Cordoba')::date`

/** Borra todo lo del fixture. Idempotente. */
export function limpiarDashboard(): void {
  ejecutarSQL(`
BEGIN;
SET LOCAL session_replication_role = 'replica';
${LIMPIEZA}
COMMIT;`)
}

/**
 * Siembra (o repone) órdenes y tareas. Idempotente.
 *
 * `tecnicoId` es el usuario del técnico, si ya existe: su tarea se siembra
 * asignada a él.
 */
export function sembrarDashboard(tecnicoId: string | null = null): void {
  const X = DASHBOARD_1F_TEXT
  ejecutarSQL(`
BEGIN;
-- 'replica' apaga los triggers (totales, historial, notificaciones): el fixture
-- fija cada fila a mano y tiene que quedar EXACTAMENTE así.
SET LOCAL session_replication_role = 'replica';
${LIMPIEZA}

INSERT INTO public.customers (id, business_id, name, phone, customer_type) VALUES
  ('${C.uno}', '${E2E.business}', '${X.clienteUno}',   '3515550201', 'minorista'),
  ('${C.dos}', '${E2E.business}', '${X.clienteLargo}', '3515550202', 'minorista');

INSERT INTO public.devices (id, business_id, customer_id, type, brand, model, issue) VALUES
  ('${D.uno}', '${E2E.business}', '${C.uno}', 'smartphone', 'Samsung', '${X.modeloLargo}', 'No enciende'),
  ('${D.dos}', '${E2E.business}', '${C.dos}', 'smartphone', 'Apple',   'iPhone 13',        'Cambio de batería');

INSERT INTO public.orders (id, business_id, customer_id, device_id, status, priority, created_at, updated_at) VALUES
  ('${O.reparacion}',  '${E2E.business}', '${C.uno}', '${D.uno}', 'repair',           'high',   now() + interval '9 minutes', now()),
  ('${O.lista}',       '${E2E.business}', '${C.dos}', '${D.dos}', 'ready_delivery',   'medium', now() + interval '8 minutes', now()),
  ('${O.aprobacion}',  '${E2E.business}', '${C.dos}', '${D.dos}', 'waiting_approval', 'medium', now() + interval '7 minutes', now()),
  ('${O.sinDatos}',    '${E2E.business}', NULL,       NULL,       'new',              'low',    now() + interval '6 minutes', now()),
  ('${O.diagnostico}', '${E2E.business}', '${C.uno}', '${D.uno}', 'diagnosis',        'low',    now() + interval '5 minutes', now()),
  ('${O.cerrada}',     '${E2E.business}', '${C.uno}', '${D.uno}', 'completed',        'low',    now() - interval '6 days',    now() - interval '5 days');

INSERT INTO public.tasks (id, business_id, user_id, assigned_to, created_by, title, priority, status, due_date, completed_at) VALUES
  ('${T.vencidaAlta}',  '${E2E.business}', '${E2E.owner}', '${E2E.owner}', '${E2E.owner}', '${X.tareaVencidaAlta}',  'high',   'pending',   ${HOY_AR} - 3, NULL),
  ('${T.vencidaMedia}', '${E2E.business}', '${E2E.owner}', '${E2E.owner}', '${E2E.owner}', '${X.tareaVencidaMedia}', 'medium', 'pending',   ${HOY_AR} - 2, NULL),
  ('${T.hoy}',          '${E2E.business}', '${E2E.owner}', '${E2E.owner}', '${E2E.owner}', '${X.tareaHoy}',          'medium', 'pending',   ${HOY_AR},     NULL),
  ('${T.proxima}',      '${E2E.business}', '${E2E.owner}', '${E2E.owner}', '${E2E.owner}', '${X.tareaProxima}',      'low',    'pending',   ${HOY_AR} + 5, NULL),
  ('${T.sinFecha}',     '${E2E.business}', '${E2E.owner}', '${E2E.owner}', '${E2E.owner}', '${X.tareaSinFecha}',     'low',    'pending',   NULL,          NULL),
  ('${T.completada}',   '${E2E.business}', '${E2E.owner}', '${E2E.owner}', '${E2E.owner}', '${X.tareaCompletada}',   'medium', 'completed', ${HOY_AR},     now())${tecnicoId ? `,
  ('${T.delTecnico}',   '${E2E.business}', '${tecnicoId}', '${tecnicoId}', '${E2E.owner}', '${X.tareaDelTecnico}',   'high',   'pending',   ${HOY_AR},     NULL)` : ''};
COMMIT;`)
}

/**
 * Perfil de un empleado en el negocio E2E, con los permisos por defecto de su
 * rol (sin overrides). El usuario de Auth lo crea el spec (necesita la API de
 * Auth).
 *
 * Por qué usuarios APARTE y no degradar al dueño: la autoridad del servidor
 * (`current_user_can_in_business`) le reconoce todo al `businesses.owner_user_id`
 * sin mirar su perfil. Cambiarle el rol al usuario E2E no le saca nada.
 */
export function sembrarPerfilActor(userId: string, actor: { email: string; rol: string; nombre: string }): void {
  ejecutarSQL(`
BEGIN;
SET LOCAL session_replication_role = 'replica';
INSERT INTO public.profiles (id, business_id, user_id, role, is_active, full_name, email, permissions)
VALUES ('${userId}', '${E2E.business}', '${userId}', '${actor.rol}', true, '${actor.nombre}', '${actor.email}', NULL)
ON CONFLICT (id) DO UPDATE SET business_id = EXCLUDED.business_id, user_id = EXCLUDED.user_id,
       role = EXCLUDED.role, is_active = true, permissions = NULL;
COMMIT;`)
}

export function borrarPerfilActor(userId: string): void {
  ejecutarSQL(`
BEGIN;
SET LOCAL session_replication_role = 'replica';
DELETE FROM public.profiles WHERE id = '${userId}';
COMMIT;`)
}
