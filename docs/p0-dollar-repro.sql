-- ============================================================================
-- P0-DÓLAR — Reproducción del bug contra el esquema PRE-migración.
--
-- Se ejecuta en el stack LOCAL. Todo ocurre dentro de una transacción que
-- termina en ROLLBACK: no persiste ninguna fila.
--
-- Demuestra tres cosas:
--   A. get_business_settings() no devuelve `dolar_source`.
--   B. Con la fuente en 'cordoba', el frontend recibe undefined y renderiza
--      'nacional' (fallback de CurrencySettings.tsx:210).
--   C. El upsert que emite "Guardar Configuración" PISA 'cordoba' con
--      'nacional' aunque el usuario nunca tocó el selector.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- Owner real del stack local
CREATE TEMP TABLE _actor ON COMMIT DROP AS
SELECT COALESCE(p.user_id, p.id) AS auth_uid, p.business_id, p.role
FROM public.profiles p
WHERE p.role = 'owner' AND p.business_id IS NOT NULL
LIMIT 1;

-- Configuración de partida: el negocio eligió Córdoba.
INSERT INTO public.business_settings (business_id, default_currency, auto_update_rate, dolar_source)
SELECT business_id, 'ARS', true, 'cordoba' FROM _actor
ON CONFLICT (business_id) DO UPDATE SET dolar_source = 'cordoba';

SELECT '=== ESTADO INICIAL EN LA TABLA ===' AS paso;
SELECT bs.dolar_source AS dolar_source_en_tabla
FROM public.business_settings bs JOIN _actor a ON a.business_id = bs.business_id;

-- La temp table es sólo andamiaje del script; el rol impersonado necesita leerla.
GRANT SELECT ON _actor TO authenticated;

-- Impersonar al owner tal como llega desde PostgREST
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', (SELECT auth_uid FROM _actor), 'role', 'authenticated')::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT '=== A) LO QUE LA RPC DE LECTURA LE ENTREGA AL FRONTEND ===' AS paso;
SELECT jsonb_pretty(to_jsonb(g)) AS payload_get_business_settings
FROM public.get_business_settings() g;

SELECT '=== B) VEREDICTO DE LA LECTURA ===' AS paso;
SELECT
  CASE WHEN to_jsonb(g) ? 'dolar_source'
       THEN 'OK: la RPC expone dolar_source'
       ELSE 'BUG REPRODUCIDO: la RPC NO expone dolar_source -> el front recibe undefined y muestra ''nacional'''
  END AS veredicto_lectura
FROM public.get_business_settings() g;

SELECT '=== C) GUARDADO: upsert exacto que emite handleSaveSettings ===' AS paso;
-- El payload lleva dolar_source='nacional' porque currencyService hace
-- `settings.dolar_source ?? 'nacional'` sobre un campo que la RPC nunca trajo.
INSERT INTO public.business_settings AS bs
  (business_id, default_currency, show_usd_price, auto_update_rate,
   rate_api_url, rate_update_frequency_hours, dolar_source)
SELECT a.business_id, 'ARS', false, false, NULL, 24, 'nacional' FROM _actor a
ON CONFLICT (business_id) DO UPDATE SET
  default_currency            = excluded.default_currency,
  show_usd_price              = excluded.show_usd_price,
  auto_update_rate            = excluded.auto_update_rate,
  rate_api_url                = excluded.rate_api_url,
  rate_update_frequency_hours = excluded.rate_update_frequency_hours,
  dolar_source                = excluded.dolar_source;

SELECT
  bs.dolar_source AS dolar_source_despues,
  CASE WHEN bs.dolar_source = 'nacional'
       THEN 'BUG REPRODUCIDO: ''cordoba'' fue pisado por ''nacional'' sin que el usuario tocara el selector'
       ELSE 'OK: la fuente se conservo'
  END AS veredicto_escritura
FROM public.business_settings bs JOIN _actor a ON a.business_id = bs.business_id;

RESET ROLE;
ROLLBACK;
