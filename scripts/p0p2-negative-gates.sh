#!/bin/sh
# ============================================================================
# P0-P2 - Pruebas NEGATIVAS de los gates (brief seccion 21).
#
# Un test verde no prueba nada si nunca puede ponerse en rojo. Este script
# rompe A PROPOSITO cada invariante y verifica que el gate correspondiente
# falle de verdad. Todas las mutaciones son temporales y viven solo dentro del
# contenedor de Postgres LOCAL: nunca se commitean ni tocan produccion.
#
# Uso (desde la raiz del repo):
#   docker cp scripts/p0p2-negative-gates.sh supabase_db_techrepair-vite:/tmp/
#   docker cp supabase/migrations/20260824120000_p0p2_invitation_lifecycle_hardening.sql \
#             supabase_db_techrepair-vite:/tmp/p0p2.sql
#   docker cp tests/sql/p0p2_business_invitations.test.sql supabase_db_techrepair-vite:/tmp/t.sql
#   docker exec supabase_db_techrepair-vite sh /tmp/p0p2-negative-gates.sh
#
# Gates ejercitados:
#   A  comparacion de email    -> el caso 17 (email mismatch) debe fallar
#   B  no-creacion de business -> el caso 15 y la postcondicion P12 deben fallar
#   C  gen_random_bytes        -> el caso del P0 y la postcondicion P3 deben fallar
# ============================================================================
set -u

MIG=/tmp/p0p2.sql
TEST=/tmp/t.sql
PSQL="psql -U postgres -d postgres -q -v ON_ERROR_STOP=1"
FALLAS=0

# Quita el bloque de postcondiciones para poder instalar una version mutada y
# medir el gate del TEST por separado del gate de la MIGRACION.
sin_postcond() {
  sed '/^DO \$post\$/,/^\$post\$;/d' "$1" > "$2"
}

esperar_fallo() {   # $1 = etiqueta   $2 = archivo sql   $3 = patron esperado
  etiqueta="$1"; archivo="$2"; patron="$3"
  salida=$($PSQL -f "$archivo" 2>&1)
  if echo "$salida" | grep -q "$patron"; then
    echo "  OK   $etiqueta -> el gate fallo como se esperaba"
    echo "       $(echo "$salida" | grep -m1 "$patron" | cut -c1-140)"
  else
    echo "  FALLA $etiqueta -> el gate NO detecto la mutacion"
    FALLAS=$((FALLAS + 1))
  fi
}

restaurar() {
  $PSQL -f "$MIG" >/dev/null 2>&1
  echo "  ...migracion canonica restaurada"
}

echo "=============================================================="
echo "A. Romper la comparacion de email en accept_business_invitation"
echo "=============================================================="
sed 's/IF v_email IS DISTINCT FROM lower(btrim(v_inv.email)) THEN/IF false THEN/' \
  "$MIG" > /tmp/mutA_full.sql
if cmp -s "$MIG" /tmp/mutA_full.sql; then
  echo "  FALLA A -> la mutacion no se aplico (cambio el texto fuente?)"
  FALLAS=$((FALLAS + 1))
else
  sin_postcond /tmp/mutA_full.sql /tmp/mutA.sql
  $PSQL -f /tmp/mutA.sql >/dev/null 2>&1
  esperar_fallo "A/test 17 (email mismatch)" "$TEST" "17 FAIL"
  restaurar
fi

echo ""
echo "=============================================================="
echo "B. Hacer que accept cree un business"
echo "=============================================================="
sed 's|^  INSERT INTO public.profiles (id, business_id, role, is_active, full_name, email)$|  INSERT INTO public.businesses (name, owner_user_id) VALUES (:mutante, v_uid);\n  INSERT INTO public.profiles (id, business_id, role, is_active, full_name, email)|' \
  "$MIG" | sed "s/:mutante/'MUTANTE'/" > /tmp/mutB_full.sql
if cmp -s "$MIG" /tmp/mutB_full.sql; then
  echo "  FALLA B -> la mutacion no se aplico"
  FALLAS=$((FALLAS + 1))
else
  # B1: la postcondicion P12 de la propia migracion tiene que rechazarla.
  esperar_fallo "B1/postcondicion P12 (migracion)" /tmp/mutB_full.sql "POSTCOND P12"
  # B2: y si alguien saltea las postcondiciones, el test tiene que verlo.
  sin_postcond /tmp/mutB_full.sql /tmp/mutB.sql
  $PSQL -f /tmp/mutB.sql >/dev/null 2>&1
  esperar_fallo "B2/test 15 (no se crea business)" "$TEST" "15 FAIL"
  restaurar
fi

echo ""
echo "=============================================================="
echo "C. Quitarle el schema a gen_random_bytes (reproduce el P0 real)"
echo "=============================================================="
sed 's/extensions\.gen_random_bytes(32)/gen_random_bytes(32)/' "$MIG" > /tmp/mutC_full.sql
if cmp -s "$MIG" /tmp/mutC_full.sql; then
  echo "  FALLA C -> la mutacion no se aplico"
  FALLAS=$((FALLAS + 1))
else
  # C1: la postcondicion P3 tiene que rechazarla.
  esperar_fallo "C1/postcondicion P3 (migracion)" /tmp/mutC_full.sql "POSTCOND P3"
  # C2: y el test tiene que reproducir el error productivo exacto.
  sin_postcond /tmp/mutC_full.sql /tmp/mutC.sql
  $PSQL -f /tmp/mutC.sql >/dev/null 2>&1
  esperar_fallo "C2/test (P0 gen_random_bytes)" "$TEST" "gen_random_bytes"
  restaurar
fi

echo ""
echo "=============================================================="
if [ "$FALLAS" -eq 0 ]; then
  echo "PRUEBAS NEGATIVAS: 5/5 gates demostrados (fallan cuando deben)"
  exit 0
fi
echo "PRUEBAS NEGATIVAS: $FALLAS gate(s) NO detectaron su mutacion"
exit 1
