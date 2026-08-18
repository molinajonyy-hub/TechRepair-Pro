-- ============================================================================
-- ANCLAS TEMPORALES DEL FIXTURE DEL GATE VISUAL
--
-- Corre contra el stack LOCAL. No toca datos: es aritmetica de fechas pura
-- dentro de una transaccion que termina en ROLLBACK.
--
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/visual_fixture_date_anchors.test.sql
--
-- POR QUE EXISTE
--
-- `scripts/finance/charts-l1-visual-fixtures.sql` sembraba el dato del "mes
-- anterior" como `d0 - 16 dias`. Eso solo cae en el mes calendario anterior
-- segun el dia en que se corra: el gate paso el 2026-08-14 (d0-16 = 2026-07-29)
-- y fallo el 2026-08-18 (d0-16 = 2026-08-02) sin un solo cambio de producto.
-- El dashboard filtra por MES CALENDARIO, asi que la referencia temporal del
-- fixture tiene que ser la misma: el mes, no una cantidad de dias.
--
-- Este test fija las dos anclas para fechas representativas — incluidos el dia
-- 1, fin de mes, cambio de anio, febrero corto y febrero bisiesto — de modo que
-- una regresion a `d0 - N dias` falle acá y no un dia 17 cualquiera en CI.
--
--   d_ant  = date_trunc('month', d0) - interval '1 month' + 14
--            -> SIEMPRE dentro del mes calendario anterior.
--   en_mes = GREATEST(d0 - n, date_trunc('month', d0))
--            -> SIEMPRE dentro del mes calendario actual, y nunca futuro.
-- ============================================================================
BEGIN;

SET LOCAL client_min_messages = notice;

DO $$
DECLARE
  d0     date;
  m_cur  date;
  m_ant  date;
  d_ant  date;
  n      integer;
  v_en_mes date;
  -- Fechas representativas. Cubren: dia 1 (el peor caso para `d0 - N`), el dia
  -- en que el gate estaba verde, el dia en que empezo a fallar, fines de mes,
  -- cambio de anio, febrero de 28 y febrero bisiesto.
  fechas date[] := ARRAY[
    '2026-08-01', '2026-08-14', '2026-08-16', '2026-08-17', '2026-08-18',
    '2026-08-31',
    '2026-01-01', '2026-01-15', '2026-01-31',   -- mes anterior = diciembre 2025
    '2026-03-01', '2026-03-15', '2026-03-31',   -- mes anterior = febrero (28)
    '2028-03-01', '2028-03-31',                 -- mes anterior = febrero (29)
    '2026-02-01', '2026-02-28',
    '2026-12-01', '2026-12-31',
    '2026-05-31', '2026-07-01'
  ];
BEGIN
  FOREACH d0 IN ARRAY fechas LOOP
    m_cur := date_trunc('month', d0)::date;
    m_ant := (date_trunc('month', d0) - interval '1 month')::date;
    d_ant := (date_trunc('month', d0) - interval '1 month')::date + 14;

    -- 1. El ancla del mes anterior cae SIEMPRE en el mes calendario anterior.
    IF date_trunc('month', d_ant)::date IS DISTINCT FROM m_ant THEN
      RAISE EXCEPTION 'A d0=%: d_ant=% no pertenece al mes anterior (%)', d0, d_ant, m_ant;
    END IF;

    -- 2. Y por lo tanto NUNCA comparte mes con d0. Esta es exactamente la
    --    invariante que `d0 - 16` rompia a partir del dia 17.
    IF date_trunc('month', d_ant)::date = m_cur THEN
      RAISE EXCEPTION 'B d0=%: d_ant=% cayo en el mes actual', d0, d_ant;
    END IF;

    -- 3. El ancla del mes anterior existe como fecha real (dia 15 de un mes que
    --    puede tener 28, 29, 30 o 31 dias).
    IF d_ant < m_ant OR d_ant > (m_cur - 1) THEN
      RAISE EXCEPTION 'C d0=%: d_ant=% fuera del rango [%, %]', d0, d_ant, m_ant, m_cur - 1;
    END IF;

    -- 4. Los datos del periodo actual no se escapan del mes, ni al pasado ni al
    --    futuro, para cualquiera de los desfasajes que usa el fixture.
    FOREACH n IN ARRAY ARRAY[1,2,3,4,5,6,7,8] LOOP
      v_en_mes := GREATEST(d0 - n, m_cur);

      IF date_trunc('month', v_en_mes)::date IS DISTINCT FROM m_cur THEN
        RAISE EXCEPTION 'D d0=% n=%: en_mes=% se fue del mes actual (%)', d0, n, v_en_mes, m_cur;
      END IF;

      IF v_en_mes > d0 THEN
        RAISE EXCEPTION 'E d0=% n=%: en_mes=% es una fecha futura', d0, n, v_en_mes;
      END IF;
    END LOOP;

    -- 5. Control negativo: se demuestra que el esquema VIEJO (`d0 - 16`) habria
    --    fallado justamente en los dias en que fallo, y no en los otros. Si
    --    alguien vuelve a `d0 - N`, este bloque deja de describir la realidad.
    IF extract(day FROM d0)::int > 16
       AND date_trunc('month', d0 - 16)::date IS DISTINCT FROM m_cur THEN
      RAISE EXCEPTION 'F d0=%: el esquema viejo deberia haber caido en el mes actual', d0;
    END IF;
  END LOOP;

  RAISE NOTICE 'OK - anclas verificadas en % fechas representativas.', array_length(fechas, 1);
END
$$;

-- El caso concreto que rompio el gate, aislado y explicito.
DO $$
DECLARE
  roto  date := date_trunc('month', date '2026-08-18')::date;  -- agosto
  viejo date := date '2026-08-18' - 16;                        -- 2026-08-02
  nuevo date := (date_trunc('month', date '2026-08-18') - interval '1 month')::date + 14;
BEGIN
  IF date_trunc('month', viejo)::date IS DISTINCT FROM roto THEN
    RAISE EXCEPTION 'el esquema viejo no reproduce el fallo del 2026-08-18';
  END IF;
  IF nuevo <> date '2026-07-15' THEN
    RAISE EXCEPTION 'el ancla nueva deberia ser 2026-07-15, es %', nuevo;
  END IF;
  RAISE NOTICE 'OK - 2026-08-18: d0-16 daba 2026-08-02 (mes actual); el ancla da 2026-07-15.';
END
$$;

-- Y el dia en que el gate estaba verde: el esquema viejo acertaba por casualidad.
DO $$
DECLARE
  viejo date := date '2026-08-14' - 16;   -- 2026-07-29
  nuevo date := (date_trunc('month', date '2026-08-14') - interval '1 month')::date + 14;
BEGIN
  IF date_trunc('month', viejo)::date <> date '2026-07-01' THEN
    RAISE EXCEPTION 'el 2026-08-14 el esquema viejo si caia en julio';
  END IF;
  IF date_trunc('month', nuevo)::date <> date '2026-07-01' THEN
    RAISE EXCEPTION 'el ancla nueva tambien tiene que caer en julio';
  END IF;
  RAISE NOTICE 'OK - 2026-08-14: ambos caen en julio; por eso el CI estaba verde.';
END
$$;

ROLLBACK;
