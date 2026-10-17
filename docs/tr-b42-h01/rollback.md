# TR-B42 / H01 — reversión segura

No ejecutar en producción durante este trabajo. Una aplicación posterior requiere revisión humana y autorización expresa. No revertir automáticamente el archivo histórico ni recuperar `ce_insert WITH CHECK (true)` o `ce_admin FOR ALL`: eso reabriría el defecto.

## Antes de cualquier aplicación autorizada

1. Guardar el preflight de sólo lectura y revisar todos sus gates, políticas, permisos heredados/de columna, triggers y conteos.
2. Confirmar que el único writer compatible continúa siendo el portal autenticado con cliente propio. Investigar integraciones externas por separado; el discovery del repositorio no demuestra su ausencia en producción.
3. Conservar el frontend compatible que no bloquea el pedido confirmado si falla la telemetría.
4. Tener una sesión operativa con capacidad de cambiar políticas de esta tabla y una ventana de verificación. No ejecutar comandos de producción desde este PR.

## Si sólo falla la telemetría

El pedido confirmado y su envío a WhatsApp deben continuar. Conservar la política segura, investigar el código de error sin PII y corregir hacia adelante. No recrear el pedido para recuperar un evento y no usar metadata como registro de venta.

## Si hace falta detener todas las nuevas escrituras de eventos

La alternativa segura es cerrar INSERT temporalmente, conservando la lectura administrativa SELECT. Este SQL es un plan para revisión, no un paso ejecutado ni automático:

```sql
BEGIN;

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.customer_events'::regclass
      AND polname = 'ce_admin' AND polcmd = 'r'
  ) THEN
    RAISE EXCEPTION 'No se verificó ce_admin SELECT: detener y revisar';
  END IF;
END;
$check$;

DO $close_insert$
DECLARE v_policy record; v_column record;
BEGIN
  FOR v_policy IN SELECT polname FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.customer_events'::regclass AND polcmd IN ('a', '*')
  LOOP
    EXECUTE format('DROP POLICY %I ON public.customer_events', v_policy.polname);
  END LOOP;
  FOR v_column IN SELECT attname FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.customer_events'::regclass
      AND attnum > 0 AND NOT attisdropped
  LOOP
    EXECUTE format(
      'REVOKE INSERT (%I) ON TABLE public.customer_events FROM PUBLIC, anon, authenticated',
      v_column.attname
    );
  END LOOP;
END;
$close_insert$;

REVOKE INSERT ON TABLE public.customer_events FROM PUBLIC, anon, authenticated;
ALTER TABLE public.customer_events ENABLE ROW LEVEL SECURITY;

DO $verify$
BEGIN
  IF has_table_privilege('anon', 'public.customer_events', 'INSERT')
    OR has_table_privilege('authenticated', 'public.customer_events', 'INSERT')
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.customer_events'::regclass
        AND attnum > 0 AND NOT attisdropped
        AND (has_column_privilege('anon', 'public.customer_events', attname, 'INSERT')
          OR has_column_privilege('authenticated', 'public.customer_events', attname, 'INSERT'))
    ) THEN
    RAISE EXCEPTION 'INSERT heredado sigue disponible: la transacción se aborta';
  END IF;
END;
$verify$;

COMMIT;
```

No elimina ni modifica eventos, pedidos, precios, stock o contabilidad. Durante el cierre no se aceptan nuevos eventos de clientes. Las lecturas conservan `ce_admin SELECT`. Los guards y la suite H01 deben marcar ese estado como degradado porque falta el INSERT válido: no silenciar esas comprobaciones.

Para reabrir telemetría, revisar y reaplicar únicamente la migración segura H01 y repetir las pruebas positivas/negativas en QA antes de un nuevo cambio autorizado. Nunca restaurar las políticas vulnerables.
