-- ============================================================================
-- M7 (Bloque 6D.2b) — Helper CENTRAL de normalizacion/validacion de metodos de
-- pago de PROVEEDORES. Fuente unica del catalogo, usado por las tres RPC:
--   create_supplier_purchase_atomic, pay_supplier_purchase_atomic, pay_supplier_free_atomic
-- Ninguna de ellas vuelve a comparar el parametro crudo.
--
-- Timestamp anterior a 6D.1 (170000) / 6D.2 (180000) A PROPOSITO: en un db push
-- desde cero el helper debe existir antes de que esas RPC lo referencien.
--
-- Contrato:
--   normaliza con lower(btrim(...));
--   devuelve el valor CANONICO del catalogo;
--   devuelve NULL si viene vacio/nulo (el CALLER decide si exige pago);
--   RAISE estable 'INVALID_PAYMENT_METHOD' (ERRCODE 22023) si no pertenece al catalogo.
-- Las RPC mapean ese RAISE a {ok:false, error_code:'VALIDATION_ERROR',
-- error:'Método de pago inválido'} — nunca exponen SQLERRM.
-- Catalogo actual (= frontend PROV_METHODS): efectivo, transferencia, tarjeta,
-- cheque, dolares, otro.
-- ============================================================================
CREATE OR REPLACE FUNCTION "public"."normalize_supplier_payment_method"(p_method text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $function$
DECLARE
  v text := lower(NULLIF(btrim(COALESCE(p_method, '')), ''));
BEGIN
  -- vacio/nulo: valido cuando NO hay pago (compra a deuda). El caller exige metodo si hay pago.
  IF v IS NULL THEN RETURN NULL; END IF;
  IF v <> ALL (ARRAY['efectivo','transferencia','tarjeta','cheque','dolares','otro']) THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_METHOD' USING ERRCODE = '22023';
  END IF;
  RETURN v;
END;
$function$;
ALTER FUNCTION "public"."normalize_supplier_payment_method"(text) OWNER TO "postgres";
-- Interno: solo lo invocan las RPC SECURITY DEFINER (owner postgres). Revocado a anon/authenticated.
REVOKE ALL ON FUNCTION "public"."normalize_supplier_payment_method"(text) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."normalize_supplier_payment_method"(text) TO "service_role";

-- ============================================================================
-- ROLLBACK (documentado): DROP FUNCTION public.normalize_supplier_payment_method(text);
-- y revertir las tres RPC a la validacion inline previa (6D.2/6D.2a).
-- ============================================================================
