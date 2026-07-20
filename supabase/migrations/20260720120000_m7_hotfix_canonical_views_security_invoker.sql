-- ============================================================================
-- M7 HOTFIX — Aislamiento cross-tenant en las 3 vistas canónicas de finanzas.
--
-- POSTERIOR al tag stable-finance-m7-audit-accrual-v1. No mueve el tag.
--
-- ── El defecto ──────────────────────────────────────────────────────────────
-- Estas tres vistas se crearon SIN `security_invoker`. Una vista sin esa
-- opción se ejecuta con los privilegios de su OWNER (aquí `postgres`), no con
-- los del que consulta. Como postgres no está sujeto a RLS, las políticas de
-- `comprobantes`, `comprobante_items`, `business_finance_entries`, etc. se
-- evalúan como si no existieran, y la vista devuelve filas de TODOS los
-- negocios a cualquier rol que tenga SELECT sobre ella.
--
-- Las tres tienen GRANT SELECT a `authenticated`. El filtro por negocio vivía
-- únicamente en el `.eq('business_id', …)` del frontend, que es una comodidad
-- de la UI, no un límite de seguridad: el cliente elige el business_id.
--
-- ── Evidencia (prod, JWT authenticated real, no service_role) ───────────────
-- Usuario A = user_a (negocio tenant_a) leyendo con su propio JWT:
--     comprobantes            → 1 negocio   (RLS OK, control del test)
--     comprobante_items       → 1 negocio   (RLS OK, control del test)
--     v_finance_pnl           → 3 negocios  ← LEAK
--     v_finance_sales_ledger  → 3 negocios  ← LEAK
--     v_finance_product_margin→ 2 negocios  ← LEAK
--     net_sales del negocio B visible para A: 400.000,00
-- Dirección inversa (B lee A): 9.015.000,00 y N_A filas de ledger ajenas.
-- El control es lo que hace concluyente la prueba: en la MISMA sesión y con el
-- MISMO JWT, las tablas base aíslan y las vistas no. El defecto es de la vista.
--
-- ── Efecto secundario: además del leak, los números eran incorrectos ────────
-- `v_finance_pnl` compone `v_finance_effective_comprobantes`, que SÍ tiene
-- security_invoker. Al leer una vista ajena se mezclan dos contextos: el CTE
-- `sales` corre con privilegios de postgres (ve todo) y el CTE `returns` corre
-- con los del lector (no ve nada del negocio ajeno). Resultado: las notas de
-- crédito del negocio observado se computan como 0 y net_sales queda inflado.
-- Medido: A leído por B daba 9.015.000,00 con returns=0; A leído por A da
-- 9.000.000,00 con returns=15.000,00. La cifra filtrada no sólo era privada:
-- era falsa. Nadie la consumía, porque ningún consumidor legítimo lee un
-- negocio ajeno — por eso el fix NO altera ninguna métrica en uso.
--
-- ── El fix ──────────────────────────────────────────────────────────────────
-- ALTER VIEW … SET (security_invoker = true). No se recrean las vistas: ALTER
-- conserva definición, columnas, tipos, dependencias y grants. Verificado:
-- 43 columnas antes y después, 0 diferencias de firma.
--
-- ── Alcance ─────────────────────────────────────────────────────────────────
-- EXCLUSIVAMENTE estas tres vistas. Un barrido del catálogo confirmó que son
-- las únicas relaciones de `public` alcanzables por anon/authenticated a las
-- que les falta security_invoker. No toca ledger, checkout, caja, ARCA, POS,
-- ni ninguna otra vista, función o tabla.
--
-- ── Requisito de motor ──────────────────────────────────────────────────────
-- security_invoker existe desde PostgreSQL 15. Producción corre 17.6.
-- La migración verifica la versión y aborta con un mensaje claro si es menor,
-- en vez de fallar con un error de sintaxis opaco.
-- ============================================================================

-- ── Guard de motor ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'security_invoker requiere PostgreSQL 15+; este servidor es %. '
      'Abortando: sin esta opción no hay forma de cerrar el leak vía ALTER VIEW.',
      current_setting('server_version');
  END IF;
END $$;

-- ── El fix ──────────────────────────────────────────────────────────────────
-- Tres sentencias LITERALES, a proposito. La primera version de esta migracion
-- las aplicaba en un bucle con format()/EXECUTE, que es mas compacto pero deja
-- el cambio invisible para cualquier herramienta que lea SQL: el guard estatico
-- no puede ver un ALTER que se arma en runtime. SQL de seguridad tiene que ser
-- greppable y revisable a ojo.
--
-- `ALTER VIEW ... SET` es idempotente por naturaleza: correr la migracion dos
-- veces (reset local, re-push) no rompe nada.
ALTER VIEW public.v_finance_sales_ledger   SET (security_invoker = true);
ALTER VIEW public.v_finance_pnl            SET (security_invoker = true);
ALTER VIEW public.v_finance_product_margin SET (security_invoker = true);

-- ── Post-condición dura ─────────────────────────────────────────────────────
-- Si por cualquier motivo alguna vista quedó sin la opción, la migración falla
-- acá y no se marca como aplicada. Una migración de seguridad que se aplica a
-- medias y reporta éxito es peor que una que no corre.
DO $$
DECLARE v_faltan text[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_faltan
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'v'
     AND c.relname IN ('v_finance_pnl','v_finance_sales_ledger','v_finance_product_margin')
     AND NOT COALESCE(c.reloptions::text[] @> ARRAY['security_invoker=true'], false);

  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION 'HOTFIX incompleto: sin security_invoker → %', array_to_string(v_faltan, ', ');
  END IF;
END $$;
